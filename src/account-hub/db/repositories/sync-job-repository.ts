/**
 * Account Hub — Sync Job Repository
 */

import type Database from 'better-sqlite3';
import type { SyncJob, SyncJobStatus, SyncJobType } from '../../domain/types.js';
import { generateId } from '../../domain/utils.js';

interface SyncJobItemRow {
  id: string;
  job_id: string;
  account_id: string | null;
  source_id: string | null;
  row_index: number | null;
  status: string;
  retry_count: number;
  error: string | null;
  before_json: string | null;
  after_json: string | null;
  created_at: string;
  updated_at: string;
}

function rowToJob(r: Record<string, unknown>): SyncJob {
  return {
    id:             r.id as string,
    jobType:        r.job_type as SyncJobType,
    status:         r.status as SyncJobStatus,
    totalItems:     r.total_items as number,
    doneItems:      r.done_items as number,
    failedItems:    r.failed_items as number,
    errorMessage:   r.error_message as string | null,
    dryRun:         Boolean(r.dry_run),
    idempotencyKey: r.idempotency_key as string | null,
    startedAt:      r.started_at as string | null,
    finishedAt:     r.finished_at as string | null,
    createdAt:      r.created_at as string,
    createdBy:      r.created_by as string | null,
  };
}

export class SyncJobRepository {
  constructor(private db: Database.Database) {}

  create(jobType: SyncJobType, opts: {
    dryRun?: boolean;
    idempotencyKey?: string;
    createdBy?: string;
  } = {}): SyncJob {
    const id = generateId();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO sync_jobs
        (id, job_type, status, dry_run, idempotency_key, created_at, created_by)
      VALUES
        (@id, @jobType, 'pending', @dryRun, @idempotencyKey, @now, @createdBy)
    `).run({
      id,
      jobType,
      dryRun:         opts.dryRun !== false ? 1 : 0,
      idempotencyKey: opts.idempotencyKey ?? null,
      createdBy:      opts.createdBy ?? null,
      now,
    });
    return this.findById(id)!;
  }

  findById(id: string): SyncJob | null {
    const r = this.db.prepare('SELECT * FROM sync_jobs WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    return r ? rowToJob(r) : null;
  }

  findByIdempotencyKey(key: string): SyncJob | null {
    const r = this.db
      .prepare('SELECT * FROM sync_jobs WHERE idempotency_key = ?')
      .get(key) as Record<string, unknown> | undefined;
    return r ? rowToJob(r) : null;
  }

  list(limit = 50, offset = 0): SyncJob[] {
    return (
      this.db
        .prepare('SELECT * FROM sync_jobs ORDER BY created_at DESC LIMIT ? OFFSET ?')
        .all(limit, offset) as Record<string, unknown>[]
    ).map(rowToJob);
  }

  updateStatus(
    id: string,
    status: SyncJobStatus,
    extra: { errorMessage?: string; startedAt?: string; finishedAt?: string } = {},
  ): void {
    this.db
      .prepare(`
        UPDATE sync_jobs SET
          status = @status,
          error_message = COALESCE(@errorMessage, error_message),
          started_at    = COALESCE(@startedAt, started_at),
          finished_at   = COALESCE(@finishedAt, finished_at)
        WHERE id = @id
      `)
      .run({
        id, status,
        errorMessage: extra.errorMessage ?? null,
        startedAt:    extra.startedAt ?? null,
        finishedAt:   extra.finishedAt ?? null,
      });
  }

  incrementDone(id: string): void {
    this.db.prepare('UPDATE sync_jobs SET done_items = done_items + 1 WHERE id = ?').run(id);
  }

  incrementFailed(id: string): void {
    this.db.prepare('UPDATE sync_jobs SET failed_items = failed_items + 1 WHERE id = ?').run(id);
  }

  setTotalItems(id: string, total: number): void {
    this.db.prepare('UPDATE sync_jobs SET total_items = ? WHERE id = ?').run(total, id);
  }

  // ---- Items ----

  createItem(jobId: string, opts: {
    accountId?: string;
    sourceId?: string;
    rowIndex?: number;
    beforeJson?: string;
  }): string {
    const id = generateId();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO sync_job_items
        (id, job_id, account_id, source_id, row_index, status, before_json, created_at, updated_at)
      VALUES
        (@id, @jobId, @accountId, @sourceId, @rowIndex, 'pending', @beforeJson, @now, @now)
    `).run({
      id,
      jobId,
      accountId:  opts.accountId ?? null,
      sourceId:   opts.sourceId ?? null,
      rowIndex:   opts.rowIndex ?? null,
      beforeJson: opts.beforeJson ?? null,
      now,
    });
    return id;
  }

  updateItemStatus(
    itemId: string,
    status: 'pending' | 'done' | 'failed' | 'skipped',
    opts: { error?: string; afterJson?: string } = {},
  ): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE sync_job_items SET
        status = @status,
        error = COALESCE(@error, error),
        after_json = COALESCE(@afterJson, after_json),
        updated_at = @now
      WHERE id = @id
    `).run({
      id: itemId, status,
      error:     opts.error ?? null,
      afterJson: opts.afterJson ?? null,
      now,
    });
  }

  getFailedItems(jobId: string): SyncJobItemRow[] {
    return this.db
      .prepare(
        `SELECT * FROM sync_job_items WHERE job_id = ? AND status = 'failed' ORDER BY created_at`,
      )
      .all(jobId) as SyncJobItemRow[];
  }
}
