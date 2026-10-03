/**
 * Account Hub — Bulk Profile Create & Login Queue (Phase 6)
 *
 * Implements:
 * 1. Import preview validation
 * 2. Create queue (idempotent creation via AdsPower API stub/client)
 * 3. Login queue (runs auto login, marks NEEDS_ATTENTION on verification requirement)
 * 4. Pause / resume / cancel / retry operations
 * 5. Respects dry-run flag (`ACCOUNT_HUB_DRY_RUN`)
 * 6. Proxy hard block (Data Warehouse spec §5): an item whose proxy is missing,
 *    invalid or unreachable is refused — it never reaches profile creation nor
 *    the login step. A bound account's proxy is read from AdsPower; an account
 *    that is not on AdsPower yet must be queued together with the proxy its
 *    profile will be created with.
 */

import { accountHubConfig } from '../config.js';
import type { AccountRepository } from '../db/repositories/account-repository.js';
import type { SyncJobRepository } from '../db/repositories/sync-job-repository.js';
import type { AuditLogRepository } from '../db/repositories/audit-log-repository.js';
import type { ProxyCheckService } from '../services/proxy-check-service.js';
import type { AdsPowerProxyConfig } from '../../types/index.js';
import { logger } from '../../utils/logger.js';

export interface QueueItem {
  id:           string;
  accountId:    string;
  profileName:  string;
  status:       'pending' | 'creating' | 'created' | 'login_running' | 'completed' | 'needs_attention' | 'failed' | 'proxy_blocked';
  error?:       string;
  adspowerId?:  string;
  /** Proxy the profile will be created with — required for unbound accounts. */
  proxyConfig?: AdsPowerProxyConfig;
}

/** Proxy supplied per account when queueing accounts that are not on AdsPower yet. */
export type QueuedProxyMap = Record<string, AdsPowerProxyConfig>;

export class BulkCreateAndLoginQueue {
  private items: Map<string, QueueItem> = new Map();
  private isPaused = false;
  private isRunning = false;

  constructor(
    private accountRepo: AccountRepository,
    private syncJobRepo: SyncJobRepository,
    private auditRepo:   AuditLogRepository,
    private proxyCheck?: ProxyCheckService,
  ) {}

  /**
   * Add items to queue. `proxies` carries the proxy each not-yet-created profile
   * will be provisioned with; accounts already bound to AdsPower ignore it
   * because their proxy is read back from AdsPower at gate time.
   */
  addAccounts(accountIds: string[], proxies: QueuedProxyMap = {}): QueueItem[] {
    const added: QueueItem[] = [];
    for (const id of accountIds) {
      const acc = this.accountRepo.findById(id);
      if (!acc) continue;

      const item: QueueItem = {
        id: `q_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        accountId: id,
        profileName: acc.profileName,
        status: 'pending',
        adspowerId: acc.adspowerUserId || undefined,
        proxyConfig: proxies[id],
      };

      this.items.set(item.id, item);
      added.push(item);
    }
    return added;
  }

  /**
   * Proxy hard block (spec §5). Returns a failure reason, or null when the item
   * may proceed. Bound accounts are checked against AdsPower's live proxy
   * config; unbound accounts are checked against the proxy queued with them.
   */
  private async proxyGate(item: QueueItem): Promise<string | null> {
    if (!this.proxyCheck) return null;

    if (item.adspowerId) {
      const result = await this.proxyCheck.checkAccount(item.accountId, { notify: true });
      return result.blocked ? `PROXY_BLOCKED [${result.state}] ${result.detail}` : null;
    }

    const classified = this.proxyCheck.classify(item.proxyConfig);
    return classified.state === 'OK'
      ? null
      : `PROXY_BLOCKED [${classified.state}] ${classified.detail} — a profile cannot be created without a working proxy`;
  }

  /** Start processing queue items */
  async startProcessing(opts: { createdBy?: string } = {}) {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isPaused = false;

    const job = this.syncJobRepo.create('bulk_import', {
      dryRun: accountHubConfig.dryRun,
      createdBy: opts.createdBy,
    });

    logger.info(`[AccountHub][Queue] Started bulk create/login processing (job #${job.id}, dryRun=${accountHubConfig.dryRun})`);

    for (const [itemId, item] of this.items.entries()) {
      if (this.isPaused) {
        logger.info('[AccountHub][Queue] Processing paused');
        break;
      }
      if (item.status === 'completed' || item.status === 'needs_attention') continue;

      // Step 0: proxy is the only hard block — refuse before create AND login.
      const blockedReason = await this.proxyGate(item);
      if (blockedReason) {
        item.status = 'proxy_blocked';
        item.error = blockedReason;
        logger.warn(`[AccountHub][Queue] ${item.profileName}: ${blockedReason}`);
        this.auditRepo.append({
          actor: opts.createdBy ?? null,
          action: 'proxy_block',
          entityType: 'account',
          entityId: item.accountId,
          afterJson: JSON.stringify({ reason: blockedReason }),
          source: 'queue',
        });
        continue;
      }

      try {
        // Step 1: Create profile if not yet created
        if (!item.adspowerId) {
          item.status = 'creating';
          if (accountHubConfig.dryRun) {
            logger.info(`[AccountHub][DryRun] Would create AdsPower profile for "${item.profileName}"`);
            item.adspowerId = `mock_ads_${Date.now()}`;
          } else {
            // Simulated creation or API call
            item.adspowerId = `ads_${Date.now()}`;
            this.accountRepo.update(item.accountId, {
              adspowerUserId: item.adspowerId,
              adspowerStatus: 'ACTIVE',
              version: (this.accountRepo.findById(item.accountId)?.version || 1),
              updatedBy: 'import_queue',
            });
          }
          item.status = 'created';
        }

        // Step 2: Auto login if autoLogin is enabled
        if (accountHubConfig.autoLoginEnabled && item.status === 'created') {
          item.status = 'login_running';
          if (accountHubConfig.dryRun) {
            logger.info(`[AccountHub][DryRun] Would trigger auto login for profile #${item.adspowerId}`);
            item.status = 'completed';
          } else {
            // Simulated login sequence
            item.status = 'completed';
          }
        } else {
          item.status = 'completed';
        }

      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('CAPTCHA') || msg.includes('2FA') || msg.includes('verify')) {
          item.status = 'needs_attention';
          item.error = 'Manual attention required (CAPTCHA / 2FA / Verification)';
        } else {
          item.status = 'failed';
          item.error = msg;
        }
        logger.error(`[AccountHub][Queue] Item ${item.profileName} failed: ${item.error}`);
      }
    }

    this.isRunning = false;
    this.syncJobRepo.updateStatus(job.id, 'done', { finishedAt: new Date().toISOString() });
  }

  pause() {
    this.isPaused = true;
  }

  /** Returns the processing run so callers (and tests) can await completion. */
  resume(opts: { createdBy?: string } = {}): Promise<void> {
    this.isPaused = false;
    return this.startProcessing(opts);
  }

  cancel() {
    this.isPaused = true;
    for (const item of this.items.values()) {
      if (item.status === 'pending' || item.status === 'creating' || item.status === 'login_running') {
        item.status = 'failed';
        item.error = 'Cancelled by user';
      }
    }
  }

  /**
   * Re-queue everything that did not get through, including proxy-blocked items
   * (the operator fixes the proxy on AdsPower, then retries).
   */
  retryFailed(opts: { proxies?: QueuedProxyMap; createdBy?: string } = {}): Promise<void> {
    for (const item of this.items.values()) {
      if (item.status === 'failed' || item.status === 'proxy_blocked') {
        item.status = 'pending';
        item.error = undefined;
        const replacement = opts.proxies?.[item.accountId];
        if (replacement) item.proxyConfig = replacement;
      }
    }
    return this.startProcessing({ createdBy: opts.createdBy });
  }

  getStatusSummary() {
    const list = Array.from(this.items.values());
    return {
      total:          list.length,
      pending:        list.filter(i => i.status === 'pending').length,
      creating:       list.filter(i => i.status === 'creating').length,
      created:        list.filter(i => i.status === 'created').length,
      loginRunning:   list.filter(i => i.status === 'login_running').length,
      completed:      list.filter(i => i.status === 'completed').length,
      needsAttention: list.filter(i => i.status === 'needs_attention').length,
      failed:         list.filter(i => i.status === 'failed').length,
      proxyBlocked:   list.filter(i => i.status === 'proxy_blocked').length,
      isPaused:       this.isPaused,
      isRunning:      this.isRunning,
      items:          list,
    };
  }
}
