/**
 * Account Hub — Notification Repository
 *
 * Backs the `notifications` table (migration 6). Notifications surface warehouse
 * conditions that need a human's eye: duplicate rows (spec §1) and DIE profiles
 * that still exist on AdsPower (spec §4.1).
 *
 * `dedupe_key` is UNIQUE: the same condition never stacks duplicate OPEN rows.
 */

import type Database from 'better-sqlite3';
import { generateId } from '../../domain/utils.js';
import type {
  Notification,
  NotificationStatus,
  NotificationType,
} from '../../domain/types.js';

function rowToNotification(r: Record<string, unknown>): Notification {
  return {
    id:             r.id as string,
    type:           r.type as NotificationType,
    status:         r.status as NotificationStatus,
    accountId:      (r.account_id as string | null) ?? null,
    adspowerUserId: (r.adspower_user_id as string | null) ?? null,
    title:          r.title as string,
    detail:         (r.detail as string | null) ?? null,
    dedupeKey:      (r.dedupe_key as string | null) ?? null,
    createdAt:      r.created_at as string,
    resolvedAt:     (r.resolved_at as string | null) ?? null,
    resolvedBy:     (r.resolved_by as string | null) ?? null,
  };
}

export interface CreateNotificationDto {
  type: NotificationType;
  title: string;
  detail?: string | null;
  accountId?: string | null;
  adspowerUserId?: string | null;
  dedupeKey?: string | null;
}

export class NotificationRepository {
  constructor(private db: Database.Database) {}

  /**
   * Create a notification. If `dedupeKey` is supplied and an OPEN row already
   * exists for it, that existing row is returned unchanged (no duplicate).
   * A previously RESOLVED/DISMISSED dedupe row is re-opened.
   */
  create(dto: CreateNotificationDto): Notification {
    if (dto.dedupeKey) {
      const existing = this.findByDedupe(dto.dedupeKey);
      if (existing) {
        if (existing.status !== 'OPEN') {
          this.db
            .prepare(
              `UPDATE notifications
                 SET status = 'OPEN', title = @title, detail = @detail,
                     resolved_at = NULL, resolved_by = NULL
               WHERE id = @id`,
            )
            .run({ id: existing.id, title: dto.title, detail: dto.detail ?? null });
          return this.findById(existing.id)!;
        }
        return existing;
      }
    }

    const id = generateId();
    this.db
      .prepare(
        `INSERT INTO notifications
           (id, type, status, account_id, adspower_user_id, title, detail, dedupe_key)
         VALUES (@id, @type, 'OPEN', @accountId, @adspowerUserId, @title, @detail, @dedupeKey)`,
      )
      .run({
        id,
        type:           dto.type,
        accountId:      dto.accountId ?? null,
        adspowerUserId: dto.adspowerUserId ?? null,
        title:          dto.title,
        detail:         dto.detail ?? null,
        dedupeKey:      dto.dedupeKey ?? null,
      });
    return this.findById(id)!;
  }

  findById(id: string): Notification | null {
    const r = this.db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToNotification(r) : null;
  }

  findByDedupe(dedupeKey: string): Notification | null {
    const r = this.db
      .prepare('SELECT * FROM notifications WHERE dedupe_key = ?')
      .get(dedupeKey) as Record<string, unknown> | undefined;
    return r ? rowToNotification(r) : null;
  }

  list(status?: NotificationStatus): Notification[] {
    const rows = status
      ? (this.db
          .prepare('SELECT * FROM notifications WHERE status = ? ORDER BY created_at DESC')
          .all(status) as Record<string, unknown>[])
      : (this.db
          .prepare('SELECT * FROM notifications ORDER BY created_at DESC')
          .all() as Record<string, unknown>[]);
    return rows.map(rowToNotification);
  }

  countOpen(): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM notifications WHERE status = 'OPEN'`)
        .get() as { c: number }
    ).c;
  }

  resolve(id: string, by?: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE notifications
           SET status = 'RESOLVED', resolved_at = @now, resolved_by = @by
         WHERE id = @id AND status = 'OPEN'`,
      )
      .run({ id, now: new Date().toISOString(), by: by ?? null });
    return info.changes > 0;
  }

  dismiss(id: string, by?: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE notifications
           SET status = 'DISMISSED', resolved_at = @now, resolved_by = @by
         WHERE id = @id AND status = 'OPEN'`,
      )
      .run({ id, now: new Date().toISOString(), by: by ?? null });
    return info.changes > 0;
  }

  /** Auto-close an OPEN notification once its underlying condition clears. */
  resolveByDedupe(dedupeKey: string, by?: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE notifications
           SET status = 'RESOLVED', resolved_at = @now, resolved_by = @by
         WHERE dedupe_key = @dedupeKey AND status = 'OPEN'`,
      )
      .run({ dedupeKey, now: new Date().toISOString(), by: by ?? null });
    return info.changes > 0;
  }
}
