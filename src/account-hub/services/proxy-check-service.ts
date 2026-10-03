/**
 * Account Hub — Proxy Check Service (Data Warehouse spec §5, §11 Giai đoạn 4).
 *
 * Proxy is the ONLY hard block in the warehouse: a missing or faulty proxy
 * refuses AdsPower profile provisioning and refuses enqueueing an automation
 * login. Everything else (channel match PENDING/AMBIGUOUS, duplicate flags,
 * DIE-still-alive warnings) is advisory and must NOT block — see spec §0.4 and
 * §12 acceptance criteria.
 *
 * The proxy config itself is read FROM AdsPower (spec §11 "Đọc Profile/proxy từ
 * AdsPower"), never invented here. Classification is pure; reachability is an
 * optional TCP probe.
 */

import type { AdspowerAdapter } from '../adspower/adapter.js';
import type { AccountRepository } from '../db/repositories/account-repository.js';
import type { NotificationService } from './notification-service.js';
import type { AdsPowerProxyConfig } from '../../types/index.js';
import {
  classifyProxyConfig,
  probeProxyEndpoint,
  type ProxyEndpoint,
  type ProxyState,
} from '../../utils/proxy.js';
import { logger } from '../../utils/logger.js';

/** `UNBOUND` = the account has no AdsPower profile yet, so there is nothing to read. */
export type ProxyGateState = ProxyState | 'UNBOUND';

export interface ProxyCheckResult {
  accountId:       string;
  profileName:     string;
  adspowerUserId:  string | null;
  state:           ProxyGateState;
  /** True when this account must NOT be provisioned / automated (spec §5). */
  blocked:         boolean;
  endpoint:        ProxyEndpoint | null;
  detail:          string;
}

export interface ProxyCheckOptions {
  /** Also TCP-connect to the endpoint; a refused/timed-out proxy is "faulty". */
  probe?:      boolean;
  probeMs?:    number;
  /** Raise a `PROXY_BLOCKED` notification for every blocked account. */
  notify?:     boolean;
}

export class ProxyCheckService {
  constructor(
    private adapter:       AdspowerAdapter,
    private accountRepo:   AccountRepository,
    private notifications?: NotificationService,
  ) {}

  /**
   * Classify a raw proxy block (no AdsPower call) — used when provisioning a
   * profile from a payload that is not on AdsPower yet.
   */
  classify(cfg: AdsPowerProxyConfig | null | undefined): { state: ProxyState; endpoint: ProxyEndpoint | null; detail: string } {
    return classifyProxyConfig(cfg);
  }

  /** Check one warehouse account against the proxy of its bound AdsPower profile. */
  async checkAccount(accountId: string, opts: ProxyCheckOptions = {}): Promise<ProxyCheckResult> {
    const account = this.accountRepo.findById(accountId);
    if (!account) throw new Error(`Account ${accountId} not found`);

    const base = {
      accountId,
      profileName: account.profileName,
      adspowerUserId: account.adspowerUserId ?? null,
    };

    if (!account.adspowerUserId) {
      return {
        ...base,
        state: 'UNBOUND',
        blocked: true,
        endpoint: null,
        detail: 'Account is not bound to an AdsPower profile yet',
      };
    }

    const profile = await this.adapter.findByUserId(account.adspowerUserId);
    if (!profile) {
      return {
        ...base,
        state: 'MISSING',
        blocked: true,
        endpoint: null,
        detail: `AdsPower profile #${account.adspowerUserId} not found`,
      };
    }

    const result = await this.evaluate(profile.proxyConfig, opts);
    const out: ProxyCheckResult = { ...base, ...result };
    if (opts.notify) this.syncNotification(out);
    return out;
  }

  /**
   * Batch gate. Returns every result plus the subset that is allowed through,
   * so callers never have to re-derive the block rule.
   */
  async checkAccounts(
    accountIds: string[],
    opts: ProxyCheckOptions = {},
  ): Promise<{ results: ProxyCheckResult[]; allowed: string[]; blocked: ProxyCheckResult[] }> {
    const results: ProxyCheckResult[] = [];
    for (const id of accountIds) {
      try {
        results.push(await this.checkAccount(id, opts));
      } catch (err) {
        logger.warn(`[AccountHub][ProxyCheck] ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return {
      results,
      allowed: results.filter((r) => !r.blocked).map((r) => r.accountId),
      blocked: results.filter((r) => r.blocked),
    };
  }

  /**
   * Hard gate used by profile provisioning and the login queue. Throws with a
   * caller-actionable message so the queue can record a per-item failure rather
   * than aborting the whole batch.
   */
  async assertProxyReady(accountId: string, opts: ProxyCheckOptions = {}): Promise<ProxyCheckResult> {
    const result = await this.checkAccount(accountId, opts);
    if (result.blocked) {
      throw new Error(`PROXY_BLOCKED [${result.state}] ${result.profileName}: ${result.detail}`);
    }
    return result;
  }

  /** Classify + optionally probe a proxy block. */
  private async evaluate(
    cfg: AdsPowerProxyConfig | null | undefined,
    opts: ProxyCheckOptions,
  ): Promise<{ state: ProxyGateState; blocked: boolean; endpoint: ProxyEndpoint | null; detail: string }> {
    const classified = classifyProxyConfig(cfg);
    if (classified.state !== 'OK') {
      return { state: classified.state, blocked: true, endpoint: null, detail: classified.detail };
    }

    const endpoint = classified.endpoint!;
    if (!opts.probe) {
      return { state: 'OK', blocked: false, endpoint, detail: classified.detail };
    }

    const reachable = await probeProxyEndpoint(endpoint, opts.probeMs);
    return reachable
      ? { state: 'OK', blocked: false, endpoint, detail: `${classified.detail} (reachable)` }
      : {
          state: 'UNREACHABLE',
          blocked: true,
          endpoint,
          detail: `${classified.detail} did not accept a TCP connection`,
        };
  }

  /** Keep one PROXY_BLOCKED notification per account, auto-closing when fixed. */
  private syncNotification(result: ProxyCheckResult): void {
    if (!this.notifications) return;
    const dedupeKey = `proxy-blocked:${result.accountId}`;
    if (!result.blocked) {
      this.notifications.resolveByDedupe(dedupeKey, 'system:proxy_check');
      return;
    }
    this.notifications.emit({
      type: 'PROXY_BLOCKED',
      title: `Proxy blocked: ${result.profileName}`,
      detail: `${result.state} — ${result.detail}. AdsPower provisioning and automation are refused until a working proxy is configured.`,
      accountId: result.accountId,
      adspowerUserId: result.adspowerUserId ?? undefined,
      dedupeKey,
    });
  }
}
