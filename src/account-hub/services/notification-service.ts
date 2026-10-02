/**
 * Account Hub — Notification Service
 *
 * Thin orchestration layer over NotificationRepository that also pushes live
 * updates to the dashboard over SSE. Notifications surface warehouse conditions
 * that need a human's eye: duplicate rows (spec §1) and DIE profiles that still
 * exist on AdsPower (spec §4.1). Emitting is idempotent per `dedupeKey`.
 */

import type {
  NotificationRepository,
  CreateNotificationDto,
} from '../db/repositories/notification-repository.js';
import type { Notification, NotificationStatus } from '../domain/types.js';

export type NotificationBroadcaster = (event: string, data: unknown) => void;

export class NotificationService {
  constructor(
    private repo: NotificationRepository,
    private broadcast?: NotificationBroadcaster,
  ) {}

  /**
   * Create (or re-open) a notification and push it to SSE clients when OPEN.
   * De-duplicated by `dedupeKey` at the repository layer.
   */
  emit(dto: CreateNotificationDto): Notification {
    const prev = dto.dedupeKey ? this.repo.findByDedupe(dto.dedupeKey) : null;
    const n = this.repo.create(dto);
    // Broadcast only when the notification is newly OPEN (created or re-opened),
    // so a periodic re-scan of an unchanged condition does not spam SSE clients.
    if (n.status === 'OPEN' && prev?.status !== 'OPEN') {
      this.push('notification', n);
      this.pushCount();
    }
    return n;
  }

  list(status?: NotificationStatus): Notification[] {
    return this.repo.list(status);
  }

  countOpen(): number {
    return this.repo.countOpen();
  }

  resolve(id: string, by?: string): boolean {
    const ok = this.repo.resolve(id, by);
    if (ok) this.pushCount();
    return ok;
  }

  dismiss(id: string, by?: string): boolean {
    const ok = this.repo.dismiss(id, by);
    if (ok) this.pushCount();
    return ok;
  }

  /** Auto-close a notification once its underlying condition clears. */
  resolveByDedupe(dedupeKey: string, by?: string): boolean {
    const ok = this.repo.resolveByDedupe(dedupeKey, by);
    if (ok) this.pushCount();
    return ok;
  }

  private pushCount(): void {
    this.push('notification_count', { open: this.repo.countOpen() });
  }

  private push(event: string, data: unknown): void {
    try {
      this.broadcast?.(event, data);
    } catch {
      /* SSE push is best-effort; never let a dead client break a write. */
    }
  }
}
