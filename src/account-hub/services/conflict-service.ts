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
