/**
 * Account Hub — AdsPower Reconciliation Service (Phase 5)
 *
 * Implements:
 * 1. Binding by profile name on first match (only single exact match -> saves adspower_user_id)
 * 2. Polling / full reconciliation jobs
 * 3. Tracking MISSING / DELETED status safely:
 *    - Profile not seen in 1 polling run is NOT marked DELETED immediately.
 *    - Requires >= 2 consecutive misses AND a full reconciliation to transition to MISSING/DELETED.
 * 4. NEVER automatically deletes profiles from AdsPower.
 */

import type { AdspowerAdapter } from './adapter.js';
import type { AccountRepository } from '../db/repositories/account-repository.js';
import type { SyncJobRepository } from '../db/repositories/sync-job-repository.js';
import type { AuditLogRepository } from '../db/repositories/audit-log-repository.js';
import type { NotificationService } from '../services/notification-service.js';
import { normalizeName } from '../domain/utils.js';
import { accountHubConfig } from '../config.js';
import { logger } from '../../utils/logger.js';

export interface ReconcileResult {
  totalAdsPowerProfiles: number;
  boundNew:              number;
  updatedLastSeen:       number;
  markedMissing:         number;
  markedDeleted:         number;
  conflicts:             number;
  dieStillExists:        number;
}

export class AdspowerReconcileService {
  private missingCounts: Map<string, number> = new Map(); // adspowerUserId -> miss count
  private intervalTimer: NodeJS.Timeout | null = null;

  constructor(
    private adapter:     AdspowerAdapter,
    private accountRepo: AccountRepository,
    private syncJobRepo: SyncJobRepository,
    private auditRepo:   AuditLogRepository,
    private notifications?: NotificationService,
  ) {}

  /** Run full reconciliation between AdsPower and local database */
  async reconcile(opts: { createdBy?: string } = {}): Promise<ReconcileResult> {
    const job = this.syncJobRepo.create('adspower_reconcile', {
      dryRun: accountHubConfig.dryRun,
      createdBy: opts.createdBy,
    });
    this.syncJobRepo.updateStatus(job.id, 'running', { startedAt: new Date().toISOString() });

    let boundNew = 0, markedMissing = 0, markedDeleted = 0, conflicts = 0;
    let dieStillExists = 0;
    // Bound accounts confirmed present on AdsPower in this run (spec §4.1 last_seen).
    const seenBoundUserIds: string[] = [];
    // adspowerUserId -> profileName for DIE accounts still present on AdsPower this run.
    const aliveDie = new Map<string, string>();

    try {
      const adsProfiles = await this.adapter.listAllProfiles();
      const now = new Date().toISOString();
      const seenAdspowerUserIds = new Set<string>();

      for (const p of adsProfiles) {
        seenAdspowerUserIds.add(p.userId);

        // 1. Try match by adspower_user_id
        let account = this.accountRepo.findByAdspowerUserId(p.userId);

        // 2. If not bound yet, try match by name (first time binding)
        if (!account) {
          const normalized = normalizeName(p.name);
          const nameMatches = this.accountRepo.findByNormalizedName(normalized);

          if (nameMatches.length === 1) {
            const match = nameMatches[0];
            if (!match.adspowerUserId) {
              account = this.accountRepo.update(match.id, {
                adspowerUserId: p.userId,
                adspowerSerialNumber: p.serialNumber,
                adspowerGroupId: p.groupId,
                adspowerStatus: 'ACTIVE',
                version: match.version,
                updatedBy: 'reconcile_service',
              });
              boundNew++;
              this.auditRepo.append({
                actor: 'reconcile_service',
                action: 'bind_adspower_user_id',
                entityType: 'account',
                entityId: match.id,
                beforeJson: JSON.stringify({ adspowerUserId: null }),
                afterJson: JSON.stringify({ adspowerUserId: p.userId }),
                source: 'adspower_reconcile',
              });
            }
          } else if (nameMatches.length > 1) {
            conflicts++;
            logger.warn(`[AccountHub][Reconcile] Ambiguous match for AdsPower profile "${p.name}" (#${p.userId})`);
          }
        }

        // 3. If bound account exists, update last seen and status
        if (account) {
          // Reset miss count if previously missed
          this.missingCounts.delete(p.userId);

          const updates: Parameters<typeof this.accountRepo.update>[1] = {
            version: account.version,
            updatedBy: 'reconcile_service',
          };
          let needsUpdate = false;

          if (account.adspowerStatus !== 'ACTIVE') {
            updates.adspowerStatus = 'ACTIVE';
            needsUpdate = true;
          }

          if (needsUpdate) {
            this.accountRepo.update(account.id, updates);
          }
          seenBoundUserIds.push(p.userId);

          // spec §4.1: DIE account whose AdsPower profile still exists → notify.
          if (account.accountStatus === 'DIE') {
            aliveDie.set(p.userId, account.profileName);
          }
        }
      }

      // spec §4.1: stamp last_seen for every bound profile AdsPower confirmed.
      const updatedLastSeen = this.accountRepo.touchLastSeenAdspower(seenBoundUserIds, now);

      // 4. Check for accounts that were previously bound to AdsPower but not seen in this run
      const paginated = this.accountRepo.list({ limit: 500 });
      for (const accountPublic of paginated.items) {
        if (!accountPublic.adspowerUserId) continue;

        if (!seenAdspowerUserIds.has(accountPublic.adspowerUserId)) {
          const misses = (this.missingCounts.get(accountPublic.adspowerUserId) || 0) + 1;
          this.missingCounts.set(accountPublic.adspowerUserId, misses);

          // Require >= 2 consecutive misses in full reconciliation runs before transitioning
          if (misses >= 2) {
            const rawAccount = this.accountRepo.findById(accountPublic.id);
            if (rawAccount && rawAccount.adspowerStatus !== 'DELETED' && rawAccount.adspowerStatus !== 'MISSING') {
              const newStatus = rawAccount.accountStatus === 'DIE' ? 'DELETED' : 'MISSING';
              this.accountRepo.update(rawAccount.id, {
                adspowerStatus: newStatus,
                version: rawAccount.version,
                updatedBy: 'reconcile_service',
              });

              if (newStatus === 'DELETED') markedDeleted++;
              else markedMissing++;

              this.auditRepo.append({
                actor: 'reconcile_service',
                action: 'mark_adspower_missing_or_deleted',
                entityType: 'account',
                entityId: rawAccount.id,
                beforeJson: JSON.stringify({ adspowerStatus: rawAccount.adspowerStatus }),
                afterJson: JSON.stringify({ adspowerStatus: newStatus }),
                source: 'adspower_reconcile',
              });
            }
          }
        }
      }

      // spec §4.1: emit DIE-still-alive notifications and auto-close cleared ones.
      if (this.notifications) {
        for (const [userId, profileName] of aliveDie) {
          dieStillExists++;
          this.notifications.emit({
            type: 'DIE_ADSPOWER_STILL_EXISTS',
            title: `DIE profile still on AdsPower: ${profileName}`,
            detail: `Account "${profileName}" is DIE but its AdsPower profile (#${userId}) still exists. Delete it on AdsPower to clear this notice.`,
            adspowerUserId: userId,
            dedupeKey: `die-alive:${userId}`,
          });
        }
        for (const n of this.notifications.list('OPEN')) {
          if (n.type !== 'DIE_ADSPOWER_STILL_EXISTS' || !n.dedupeKey) continue;
          const uid = n.dedupeKey.startsWith('die-alive:') ? n.dedupeKey.slice('die-alive:'.length) : '';
          if (uid && !aliveDie.has(uid)) {
            this.notifications.resolveByDedupe(n.dedupeKey, 'system:reconcile');
          }
        }
      }

      this.syncJobRepo.updateStatus(job.id, 'done', { finishedAt: new Date().toISOString() });
      return {
        totalAdsPowerProfiles: adsProfiles.length,
        boundNew,
        updatedLastSeen,
        markedMissing,
        markedDeleted,
        conflicts,
        dieStillExists,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.syncJobRepo.updateStatus(job.id, 'failed', { errorMessage: msg, finishedAt: new Date().toISOString() });
      throw err;
    }
  }

  /**
   * Event-driven counterpart of the periodic sweep (spec §4.1): called the moment
   * an account transitions to/away from DIE so the operator sees the warning
   * without waiting for the next sweep. A single-profile AdsPower lookup.
   *
   * Returns true when the DIE-but-still-alive condition holds after the check.
   */
  async checkDieAlive(accountId: string): Promise<boolean> {
    if (!this.notifications) return false;
    const account = this.accountRepo.findById(accountId);
    if (!account?.adspowerUserId) return false;

    const dedupeKey = `die-alive:${account.adspowerUserId}`;

    if (account.accountStatus !== 'DIE') {
      // No longer DIE → the condition cleared; close any standing warning.
      this.notifications.resolveByDedupe(dedupeKey, 'system:die_event');
      return false;
    }

    const profile = await this.adapter.findByUserId(account.adspowerUserId);
    if (!profile) {
      this.notifications.resolveByDedupe(dedupeKey, 'system:die_event');
      return false;
    }

    this.accountRepo.touchLastSeenAdspower([account.adspowerUserId], new Date().toISOString());
    this.notifications.emit({
      type: 'DIE_ADSPOWER_STILL_EXISTS',
      title: `DIE profile still on AdsPower: ${account.profileName}`,
      detail: `Account "${account.profileName}" is DIE but its AdsPower profile (#${account.adspowerUserId}) still exists. Delete it on AdsPower to clear this notice.`,
      adspowerUserId: account.adspowerUserId,
      dedupeKey,
    });
    return true;
  }

  /** Start background scheduler (if enabled) */
  startScheduler(intervalSec = 300) {
    if (this.intervalTimer) return;
    logger.info(`[AccountHub] Starting AdsPower reconcile background worker (${intervalSec}s interval)`);
    this.intervalTimer = setInterval(() => {
      this.reconcile().catch(err => logger.error(`[AccountHub] Reconcile background run failed: ${err}`));
    }, intervalSec * 1000);
  }

  stopScheduler() {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
      logger.info('[AccountHub] Stopped AdsPower reconcile background worker');
    }
  }
}
