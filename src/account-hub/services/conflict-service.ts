/**
 * Account Hub — Controlled Inbound Sync & Conflict Resolution Service (Phase 7)
 *
 * Implements:
 * 1. Whitelisted inbound column reading (strictly forbids password/cookie/token/2FA)
 * 2. Version & hash protection
 * 3. Conflict resolution API logic
 */

import type Database from 'better-sqlite3';
import type { AccountRepository } from '../db/repositories/account-repository.js';
import type { AuditLogRepository } from '../db/repositories/audit-log-repository.js';
import type { Conflict, ConflictStatus } from '../domain/types.js';
import { generateId } from '../domain/utils.js';
import { logger } from '../../utils/logger.js';

/** Whitelisted fields allowed for inbound / two-way sync */
export const INBOUND_WHITELIST = new Set([
  'accountStatus',
  'adspowerStatus',
  'assignedTo',
  'linkedContent',
  'youtubeChannelUrl',
  'hotmail',
  'recoveryMail',
]);

/** Forbidden fields — NEVER allowed for automatic two-way sync */
export const INBOUND_FORBIDDEN = new Set([
  'password',
  'passwordEnc',
  'twoFactorSecret',
  'twoFactorSecretEnc',
  'cookie',
  'cookieEnc',
  'token',
  'tokenEnc',
  'hotmailPassword',
  'hotmailPasswordEnc',
]);

/**
 * Per-column inbound conflict policy (`field_mappings.conflict_policy`).
 * `ask` (the default) never overwrites silently — it raises a conflict row.
 */
export type InboundConflictPolicy = 'ask' | 'sheet_wins' | 'db_wins';

export interface InboundRowApplyResult {
  /** Fields written to the warehouse account. */
  applied: string[];
  /** Fields that raised a pending conflict for a human to resolve. */
  conflicted: string[];
  /** Fields deliberately not considered (forbidden, not whitelisted, empty, db_wins). */
  ignored: string[];
}

export class ConflictService {
  constructor(
    private db:          Database.Database,
    private accountRepo: AccountRepository,
    private auditRepo:   AuditLogRepository,
  ) {}

  /** List unresolved or resolved conflicts */
  listConflicts(status?: ConflictStatus): Conflict[] {
    const where = status ? 'WHERE status = ?' : '';
    const params = status ? [status] : [];
    const rows = this.db.prepare(`SELECT * FROM conflicts ${where} ORDER BY created_at DESC`).all(...params) as Record<string, unknown>[];
    return rows.map(r => ({
      id:          r.id as string,
      accountId:   r.account_id as string | null,
      sourceId:    r.source_id as string | null,
      fieldName:   r.field_name as string,
      dbValue:     r.db_value as string | null,
      sheetValue:  r.sheet_value as string | null,
      rowIndex:    r.row_index as number | null,
      status:      r.status as ConflictStatus,
      resolvedBy:  r.resolved_by as string | null,
      resolvedAt:  r.resolved_at as string | null,
      resolution:  r.resolution as string | null,
      createdAt:   r.created_at as string,
    }));
  }

  /** Create a conflict entry */
  createConflict(data: {
    accountId:  string;
    sourceId:   string;
    fieldName:  string;
    dbValue:    string;
    sheetValue: string;
    rowIndex?:  number;
  }): Conflict {
    // Safety check: Never log sensitive fields into conflict table
    if (INBOUND_FORBIDDEN.has(data.fieldName)) {
      throw new Error(`Field ${data.fieldName} is forbidden from two-way sync and conflict resolution.`);
    }

    const id = generateId();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO conflicts
        (id, account_id, source_id, field_name, db_value, sheet_value, row_index, status, created_at)
      VALUES
        (@id, @accountId, @sourceId, @fieldName, @dbValue, @sheetValue, @rowIndex, 'pending', @now)
    `).run({ id, ...data, rowIndex: data.rowIndex ?? null, now });

    logger.warn(`[AccountHub][Conflict] Conflict detected on account ${data.accountId}, field "${data.fieldName}"`);
    return this.listConflicts().find(c => c.id === id)!;
  }

  /** A pending conflict already parked for this account + field, if any. */
  private findPending(accountId: string, fieldName: string): Conflict | undefined {
    return this.listConflicts('pending')
      .find(c => c.accountId === accountId && c.fieldName === fieldName);
  }

  /**
   * Apply one inbound sheet row onto an existing warehouse account (spec §7.2).
   *
   * Only whitelisted columns are considered; secret columns are refused outright
   * and never appear in a conflict row or a log line. An empty sheet cell never
   * blanks warehouse data. `ask` parks a conflict instead of overwriting.
   */
  applyInboundRow(opts: {
    accountId: string;
    sourceId:  string;
    rowIndex:  number;
    /** System field -> value read from the sheet. */
    values:    Record<string, string>;
    /** System field -> that column's conflict policy. Missing entries default to `ask`. */
    policyByField?: Record<string, string>;
    actor?:    string;
  }): InboundRowApplyResult {
    const result: InboundRowApplyResult = { applied: [], conflicted: [], ignored: [] };

    const account = this.accountRepo.findById(opts.accountId);
    if (!account) return result;

    // Snapshot of the row is applied field by field; each write re-reads the
    // account so `version` stays the value the optimistic lock expects.
    let current = account;

    for (const [field, rawValue] of Object.entries(opts.values)) {
      if (INBOUND_FORBIDDEN.has(field) || !INBOUND_WHITELIST.has(field)) {
        result.ignored.push(field);
        continue;
      }

      const sheetValue = rawValue.trim();
      if (!sheetValue) { result.ignored.push(field); continue; }

      const dbValue = String((current as unknown as Record<string, unknown>)[field] ?? '');
      if (dbValue === sheetValue) continue;

      const policy = (opts.policyByField?.[field] ?? 'ask') as InboundConflictPolicy;

      if (policy === 'db_wins') { result.ignored.push(field); continue; }

      if (policy === 'sheet_wins') {
        this.accountRepo.update(current.id, {
          [field]: sheetValue,
          version: current.version,
          updatedBy: opts.actor ?? 'system:sheet-poll',
        } as never);
        current = this.accountRepo.findById(current.id) ?? current;
        result.applied.push(field);
        continue;
      }

      // policy === 'ask' — park it once; a second poll must not pile up rows.
      if (!this.findPending(current.id, field)) {
        this.createConflict({
          accountId: current.id,
          sourceId:  opts.sourceId,
          fieldName: field,
          dbValue,
          sheetValue,
          rowIndex:  opts.rowIndex,
        });
      }
      result.conflicted.push(field);
    }

    return result;
  }

  /** Resolve conflict — accept DB value ('use_db') or Sheet value ('use_sheet') */
  resolveConflict(
    conflictId: string,
    resolution: 'use_db' | 'use_sheet',
    actor?: string,
  ): Conflict {
    const conflicts = this.listConflicts();
    const c = conflicts.find(x => x.id === conflictId);
    if (!c) throw new Error(`Conflict ${conflictId} not found`);

    const now = new Date().toISOString();

    if (resolution === 'use_sheet' && c.accountId && c.fieldName) {
      if (!INBOUND_WHITELIST.has(c.fieldName)) {
        throw new Error(`Field "${c.fieldName}" is not in the inbound whitelist for two-way sync.`);
      }

      const acc = this.accountRepo.findById(c.accountId);
      if (acc) {
        this.accountRepo.update(acc.id, {
          [c.fieldName]: c.sheetValue,
          version: acc.version,
          updatedBy: actor,
        });
      }
    }

    this.db.prepare(`
      UPDATE conflicts SET
        status = 'resolved',
        resolution = @resolution,
        resolved_by = @actor,
        resolved_at = @now
      WHERE id = @id
    `).run({ id: conflictId, resolution, actor: actor ?? null, now });

    this.auditRepo.append({
      actor: actor ?? null,
      action: 'resolve_conflict',
      entityType: 'conflict',
      entityId: conflictId,
      beforeJson: JSON.stringify({ status: 'pending' }),
      afterJson: JSON.stringify({ status: 'resolved', resolution }),
      source: 'conflict_service',
    });

    return this.listConflicts().find(x => x.id === conflictId)!;
  }
}
