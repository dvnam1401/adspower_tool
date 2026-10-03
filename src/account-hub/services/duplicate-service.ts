/**
 * Account Hub — Duplicate Detection Service (spec §1)
 *
 * Data in TK/BC is assumed business-unique, but the system MUST detect and warn
 * immediately when a duplicate slips through. This service is a full reconcile of
 * the three duplicate flags on `accounts` (never auto-merges — warn only):
 *   - duplicate_profile : same normalised profile name
 *   - duplicate_id      : same adspower_user_id
 *   - duplicate_hotmail : same hotmail (case/space-insensitive)
 *
 * Flags are non-secret booleans, so this writes them directly (same pattern as
 * ConflictService) rather than through the encrypting AccountRepository.update
 * chokepoint, and deliberately does NOT bump `version` so it never races an
 * in-flight optimistic-locked user edit.
 *
 * Each duplicate group raises a de-duplicated notification; groups that clear on
 * a later scan auto-close their notification.
 */

import type Database from 'better-sqlite3';
import type { NotificationService } from './notification-service.js';
import type { NotificationType } from '../domain/types.js';

export interface DuplicateGroup {
  /** The shared key (normalised name / user id / hotmail). */
  key: string;
  /** Account ids sharing the key. */
  accountIds: string[];
  /** Human-readable profile names for the group. */
  profileNames: string[];
}

export interface DuplicateReport {
  profile: DuplicateGroup[];
  id: DuplicateGroup[];
  hotmail: DuplicateGroup[];
  /** Distinct accounts carrying at least one duplicate flag after the scan. */
  flagged: number;
}

interface DimensionSpec {
  flagColumn: 'duplicate_profile' | 'duplicate_id' | 'duplicate_hotmail';
  keyExpr: string;
  notificationType: NotificationType;
  dedupePrefix: string;
  label: string;
}

const DIMENSIONS: DimensionSpec[] = [
  {
    flagColumn: 'duplicate_profile',
    keyExpr: "normalized_profile_name",
    notificationType: 'DUPLICATE_PROFILE',
    dedupePrefix: 'dup:profile:',
    label: 'profile name',
  },
  {
    flagColumn: 'duplicate_id',
    keyExpr: "adspower_user_id",
    notificationType: 'DUPLICATE_ID',
    dedupePrefix: 'dup:id:',
    label: 'AdsPower user id',
  },
  {
    flagColumn: 'duplicate_hotmail',
    keyExpr: "LOWER(TRIM(hotmail))",
    notificationType: 'DUPLICATE_HOTMAIL',
    dedupePrefix: 'dup:hotmail:',
    label: 'hotmail',
  },
];

export class DuplicateService {
  constructor(
    private db: Database.Database,
    private notifications?: NotificationService,
  ) {}

  /**
   * Recompute all three duplicate flags across non-archived accounts, emit /
   * auto-close notifications, and return the duplicate groups found.
   */
  scanAndFlag(): DuplicateReport {
    const report: DuplicateReport = { profile: [], id: [], hotmail: [], flagged: 0 };
    const liveDedupeKeys = new Set<string>();

    const tx = this.db.transaction(() => {
      for (const dim of DIMENSIONS) {
        const groups = this.findGroups(dim.keyExpr);
        report[this.reportKey(dim.flagColumn)] = groups;

        // Reset then set the flag for the current duplicate set.
        this.db
          .prepare(`UPDATE accounts SET ${dim.flagColumn} = 0 WHERE archived_at IS NULL`)
          .run();
        for (const g of groups) {
          const placeholders = g.accountIds.map(() => '?').join(',');
          this.db
            .prepare(`UPDATE accounts SET ${dim.flagColumn} = 1 WHERE id IN (${placeholders})`)
            .run(...g.accountIds);
        }
      }
    });
    tx();

    // Notifications are side effects — emit outside the DB transaction.
    for (const dim of DIMENSIONS) {
      for (const g of report[this.reportKey(dim.flagColumn)]) {
        const dedupeKey = dim.dedupePrefix + g.key;
        liveDedupeKeys.add(dedupeKey);
        this.notifications?.emit({
          type: dim.notificationType,
          title: `Duplicate ${dim.label}: ${g.key}`,
          detail: `${g.accountIds.length} accounts share this ${dim.label}: ${g.profileNames.join(', ')}`,
          accountId: g.accountIds[0] ?? null,
          dedupeKey,
        });
      }
    }

    // Auto-close notifications for duplicate groups that no longer exist.
    if (this.notifications) {
      const prefixes = DIMENSIONS.map((d) => d.dedupePrefix);
      for (const n of this.notifications.list('OPEN')) {
        if (!n.dedupeKey) continue;
        if (!prefixes.some((p) => n.dedupeKey!.startsWith(p))) continue;
        if (!liveDedupeKeys.has(n.dedupeKey)) {
          this.notifications.resolveByDedupe(n.dedupeKey, 'system:duplicate-scan');
        }
      }
    }

    report.flagged = this.countFlagged();
    return report;
  }

  private findGroups(keyExpr: string): DuplicateGroup[] {
    const rows = this.db
      .prepare(
        `SELECT ${keyExpr} AS k,
                GROUP_CONCAT(id, '\u0001')            AS ids,
                GROUP_CONCAT(profile_name, '\u0001')  AS names,
                COUNT(*)                              AS n
           FROM accounts
          WHERE archived_at IS NULL
            AND ${keyExpr} IS NOT NULL
            AND TRIM(${keyExpr}) != ''
          GROUP BY ${keyExpr}
         HAVING n > 1`,
      )
      .all() as Array<{ k: string; ids: string; names: string; n: number }>;

    return rows.map((r) => ({
      key: r.k,
      accountIds: r.ids.split('\u0001'),
      profileNames: r.names.split('\u0001'),
    }));
  }

  private countFlagged(): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM accounts
          WHERE archived_at IS NULL
            AND (duplicate_profile = 1 OR duplicate_id = 1 OR duplicate_hotmail = 1)`,
      )
      .get() as { c: number };
    return r.c;
  }

  private reportKey(flagColumn: DimensionSpec['flagColumn']): 'profile' | 'id' | 'hotmail' {
    if (flagColumn === 'duplicate_profile') return 'profile';
    if (flagColumn === 'duplicate_id') return 'id';
    return 'hotmail';
  }
}
