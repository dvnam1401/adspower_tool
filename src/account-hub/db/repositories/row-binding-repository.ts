/**
 * Account Hub — Sheet Row Bindings Repository
 *
 * Tracks account ↔ sheet row relationships including fingerprints and hashes.
 */

import type Database from 'better-sqlite3';
import { generateId } from '../../domain/utils.js';

export interface RowBinding {
  id:              string;
  accountId:       string;
  sourceId:        string;
  tabId:           string | null;
  rowIndex:        number;
  rowFingerprint:  string | null;
  lastReadHash:    string | null;
  lastWrittenHash: string | null;
  lastSyncAt:      string | null;
}

export class RowBindingRepository {
  constructor(private db: Database.Database) {}

  upsert(
    accountId: string,
    sourceId:  string,
    tabId:     string | null,
    rowIndex:  number,
    fingerprint?: string,
  ): RowBinding {
    const existing = this.db.prepare(
      'SELECT * FROM sheet_row_bindings WHERE account_id = ? AND source_id = ? AND (tab_id = ? OR (tab_id IS NULL AND ? IS NULL))',
    ).get(accountId, sourceId, tabId, tabId) as Record<string, unknown> | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE sheet_row_bindings
        SET row_index = @rowIndex, row_fingerprint = COALESCE(@fingerprint, row_fingerprint)
        WHERE id = @id
      `).run({ id: existing.id, rowIndex, fingerprint: fingerprint ?? null });
      return this.findById(String(existing.id))!;
    }

    const id  = generateId();
    this.db.prepare(`
      INSERT INTO sheet_row_bindings
        (id, account_id, source_id, tab_id, row_index, row_fingerprint)
      VALUES
        (@id, @accountId, @sourceId, @tabId, @rowIndex, @fingerprint)
    `).run({ id, accountId, sourceId, tabId: tabId ?? null, rowIndex, fingerprint: fingerprint ?? null });
    return this.findById(id)!;
  }

  findById(id: string): RowBinding | null {
    const r = this.db.prepare('SELECT * FROM sheet_row_bindings WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    return r ? this.map(r) : null;
  }

  findByAccount(accountId: string): RowBinding[] {
    return (this.db.prepare('SELECT * FROM sheet_row_bindings WHERE account_id = ?').all(accountId) as
      Record<string, unknown>[]).map(r => this.map(r));
  }

  findBySourceRow(sourceId: string, tabId: string | null, rowIndex: number): RowBinding | null {
    const r = this.db.prepare(
      'SELECT * FROM sheet_row_bindings WHERE source_id = ? AND row_index = ? AND (tab_id = ? OR (tab_id IS NULL AND ? IS NULL))',
    ).get(sourceId, rowIndex, tabId, tabId) as Record<string, unknown> | undefined;
    return r ? this.map(r) : null;
  }

  updateHashes(id: string, lastReadHash: string, lastWrittenHash?: string, lastSyncAt?: string): void {
    this.db.prepare(`
      UPDATE sheet_row_bindings SET
        last_read_hash    = @lastReadHash,
        last_written_hash = COALESCE(@lastWrittenHash, last_written_hash),
        last_sync_at      = COALESCE(@lastSyncAt, last_sync_at)
      WHERE id = @id
    `).run({
      id,
      lastReadHash,
      lastWrittenHash: lastWrittenHash ?? null,
      lastSyncAt:      lastSyncAt ?? null,
    });
  }

  private map(r: Record<string, unknown>): RowBinding {
    return {
      id:              r.id as string,
      accountId:       r.account_id as string,
      sourceId:        r.source_id as string,
      tabId:           r.tab_id as string | null,
      rowIndex:        r.row_index as number,
      rowFingerprint:  r.row_fingerprint as string | null,
      lastReadHash:    r.last_read_hash as string | null,
      lastWrittenHash: r.last_written_hash as string | null,
      lastSyncAt:      r.last_sync_at as string | null,
    };
  }
}
