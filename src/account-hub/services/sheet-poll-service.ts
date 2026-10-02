/**
 * Account Hub — Inbound Sheets Change Poller (spec §7.2, §11 P5)
 *
 * Near-real-time ingest of Google Sheets edits into the warehouse. This is the
 * *compensating* channel: the Apps Script webhook (§7.1) only asks the poller to
 * run a source earlier than its own schedule, so a dead/failed Apps Script
 * deployment degrades latency, never correctness.
 *
 * Change detection reuses `sheet_row_bindings.last_read_hash`: a row whose
 * mapped values and DIE flag hash to the stored value is skipped without any
 * further work. Only changed rows reach the ingest path.
 *
 * Everything it does is a reuse of existing services:
 *   - reading / matching / DIE detection  -> SheetImportService.preview()
 *   - creating + binding new rows         -> SheetImportService.confirmImport()
 *   - applying edits to bound accounts    -> ConflictService.applyInboundRow()
 *   - duplicate warnings                  -> DuplicateService.scanAndFlag()
 *   - job telemetry                       -> SyncJobRepository ('sheet_inbound')
 */

import crypto from 'node:crypto';
import type { SheetSourceRepository } from '../db/repositories/sheet-source-repository.js';
import type { RowBindingRepository } from '../db/repositories/row-binding-repository.js';
import type { SyncJobRepository } from '../db/repositories/sync-job-repository.js';
import type { AuditLogRepository } from '../db/repositories/audit-log-repository.js';
import type { SheetImportService, ImportPreview, ImportPreviewItem } from './sheet-import-service.js';
import type { ConflictService } from './conflict-service.js';
import type { DuplicateService } from './duplicate-service.js';
import type { NotificationService } from './notification-service.js';
import { accountHubConfig } from '../config.js';
import { logger } from '../../utils/logger.js';

export interface TabPollResult {
  sourceId:    string;
  sourceName:  string;
  tabId:       string;
  tabTitle:    string;
  /** Non-empty data rows seen in the tab. */
  totalRows:   number;
  /** Rows whose hash differed from `last_read_hash`. */
  changedRows: number;
  unchanged:   number;
  created:     number;
  bound:       number;
  /** Rows the ingest path refused (missing key / ambiguous match). */
  skipped:     number;
  /** Fields written onto already-bound accounts. */
  fieldsApplied: number;
  /** Fields parked as conflicts for a human. */
  fieldsConflicted: number;
  error?:      string;
}

export interface PollRunResult {
  jobId:      string | null;
  reason:     string;
  results:    TabPollResult[];
  durationMs: number;
}

/** A source only participates in inbound polling when it is not write-only. */
export function isInboundSource(s: { isEnabled: boolean; syncDirection: string }): boolean {
  return s.isEnabled && s.syncDirection !== 'outbound';
}

/** Stable hash over a row's mapped values + DIE flag. */
export function rowHash(item: Pick<ImportPreviewItem, 'rowData' | 'die'>): string {
  const keys = Object.keys(item.rowData).sort();
  const payload = keys.map(k => `${k}=${item.rowData[k] ?? ''}`).join('\u0001');
  return crypto
    .createHash('sha256')
    .update(`${payload}\u0002die=${item.die ? 1 : 0}`)
    .digest('hex')
    .slice(0, 32);
}

export interface SheetPollDeps {
  sourceRepo:   SheetSourceRepository;
  bindingRepo:  RowBindingRepository;
  syncJobRepo:  SyncJobRepository;
  importService: SheetImportService;
  auditRepo?:   AuditLogRepository;
  conflictSvc?: ConflictService;
  duplicateSvc?: DuplicateService;
  notifications?: NotificationService;
  broadcast?:   (event: string, data: unknown) => void;
  /** Injectable for tests; defaults to `setTimeout`. */
  scheduleFn?: (fn: () => void, ms: number) => NodeJS.Timeout | number;
  clearFn?:    (handle: NodeJS.Timeout | number) => void;
}

export class SheetPollService {
  private timers = new Map<string, NodeJS.Timeout | number>();
  private inFlight = new Map<string, Promise<TabPollResult[]>>();
  /** Sources asked to poll again while their current run was still going. */
  private requeued = new Set<string>();
  private started = false;

  constructor(private deps: SheetPollDeps) {}

  // -------------------------------------------------------------------------
  // Scheduler
  // -------------------------------------------------------------------------

  /** Arm a self-rescheduling timer per inbound source. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const source of this.deps.sourceRepo.list().filter(isInboundSource)) {
      this.arm(source.id);
    }
    logger.info(`[AccountHub][Poll] Scheduler started for ${this.timers.size} inbound source(s)`);
  }

  stop(): void {
    const clear = this.deps.clearFn ?? ((h: NodeJS.Timeout | number) => clearTimeout(h as NodeJS.Timeout));
    for (const handle of this.timers.values()) clear(handle);
    this.timers.clear();
    this.started = false;
  }

  /** Effective delay for a source: its interval, floored by config, ±10% jitter. */
  private delayFor(pollIntervalSec: number): number {
    const floor = accountHubConfig.sheetPollMinIntervalSec;
    const base = Math.max(pollIntervalSec, floor) * 1000;
    return Math.round(base * (0.9 + Math.random() * 0.2));
  }

  private arm(sourceId: string): void {
    const source = this.deps.sourceRepo.findById(sourceId);
    if (!source || !isInboundSource(source)) { this.timers.delete(sourceId); return; }

    const schedule = this.deps.scheduleFn ?? ((fn, ms) => setTimeout(fn, ms));
    const handle = schedule(() => {
      void this.requestPoll(sourceId, 'schedule').finally(() => {
        // Re-read the source on every tick so a UI config change (interval,
        // direction, enabled) takes effect without a restart.
        if (this.started) this.arm(sourceId);
      });
    }, this.delayFor(source.pollIntervalSec));

    this.timers.set(sourceId, handle);
  }

  // -------------------------------------------------------------------------
  // Poll entry points
  // -------------------------------------------------------------------------

  /**
   * Poll one source, collapsing bursts: a request arriving while the same
   * source is already polling schedules exactly one follow-up run.
   */
  async requestPoll(sourceId: string, reason: string, actor?: string): Promise<TabPollResult[]> {
    const running = this.inFlight.get(sourceId);
    if (running) {
      this.requeued.add(sourceId);
      return running;
    }

    const run = this.pollSource(sourceId, reason, actor)
      .finally(() => {
        this.inFlight.delete(sourceId);
        if (this.requeued.delete(sourceId)) {
          void this.requestPoll(sourceId, `${reason}:coalesced`, actor);
        }
      });

    this.inFlight.set(sourceId, run);
    return run;
  }

  /** Poll every inbound source once (manual trigger / smoke test). */
  async pollAll(reason = 'manual', actor?: string): Promise<PollRunResult> {
    const startedAt = Date.now();
    const sources = this.deps.sourceRepo.list().filter(isInboundSource);
    const results: TabPollResult[] = [];
    for (const source of sources) {
      results.push(...await this.requestPoll(source.id, reason, actor));
    }
    return { jobId: null, reason, results, durationMs: Date.now() - startedAt };
  }

  // -------------------------------------------------------------------------
  // Core: one source, all of its tabs
  // -------------------------------------------------------------------------

  private async pollSource(sourceId: string, reason: string, actor?: string): Promise<TabPollResult[]> {
    const source = this.deps.sourceRepo.findById(sourceId);
    if (!source || !isInboundSource(source)) return [];

    const tabs = this.deps.sourceRepo.listTabs(sourceId);
    if (!tabs.length) return [];

    const job = this.deps.syncJobRepo.create('sheet_inbound', {
      dryRun: false,
      createdBy: actor ?? `system:poll:${reason}`,
    });
    this.deps.syncJobRepo.updateStatus(job.id, 'running', { startedAt: new Date().toISOString() });
    this.deps.syncJobRepo.setTotalItems(job.id, tabs.length);

    const results: TabPollResult[] = [];
    let failed = 0;

    for (const tab of tabs) {
      try {
        const result = await this.pollTab(source.id, source.name, tab.id, tab.title, actor);
        results.push(result);
        this.deps.syncJobRepo.incrementDone(job.id);
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          sourceId: source.id, sourceName: source.name, tabId: tab.id, tabTitle: tab.title,
          totalRows: 0, changedRows: 0, unchanged: 0, created: 0, bound: 0, skipped: 0,
          fieldsApplied: 0, fieldsConflicted: 0, error: message,
        });
        this.deps.syncJobRepo.incrementFailed(job.id);
        logger.error(`[AccountHub][Poll] ${source.name}/${tab.title} failed: ${message}`);
        this.deps.notifications?.emit({
          type: 'SHEET_POLL_FAILED',
          title: `Không đọc được sheet "${source.name}" / tab "${tab.title}"`,
          detail: message,
          dedupeKey: `poll_failed:${source.id}:${tab.id}`,
        });
      }
    }

    if (!failed) {
      // The read path recovered — retire the open alert for every tab.
      for (const tab of tabs) {
        this.deps.notifications?.resolveByDedupe(`poll_failed:${source.id}:${tab.id}`, 'system:poll');
      }
    }

    this.deps.syncJobRepo.updateStatus(
      job.id,
      failed === 0 ? 'done' : failed < tabs.length ? 'partial' : 'failed',
      { finishedAt: new Date().toISOString() },
    );

    const ingested = results.reduce((n, r) => n + r.created + r.bound, 0);
    if (ingested > 0) {
      // A new/changed row can introduce a duplicate — spec §3 wants the warning
      // in the same cycle, not on a separate manual scan.
      try { this.deps.duplicateSvc?.scanAndFlag(); }
      catch (err) { logger.warn(`[AccountHub][Poll] duplicate scan skipped: ${String(err)}`); }
    }

    this.deps.broadcast?.('sheet_poll_done', {
      sourceId: source.id, sourceName: source.name, reason, jobId: job.id, results,
    });

    return results;
  }

  // -------------------------------------------------------------------------
  // Core: one tab
  // -------------------------------------------------------------------------

  private async pollTab(
    sourceId: string,
    sourceName: string,
    tabId: string,
    tabTitle: string,
    actor?: string,
  ): Promise<TabPollResult> {
    const preview = await this.deps.importService.preview(sourceId, tabId);

    const policyByField: Record<string, string> = {};
    for (const m of this.deps.sourceRepo.listMappings(sourceId)) {
      if (m.systemField && m.syncDirection !== 'outbound') {
        policyByField[m.systemField] = m.conflictPolicy;
      }
    }

    const changed: ImportPreviewItem[] = [];
    const hashes = new Map<number, string>();
    let unchanged = 0;
    let skipped = 0;

    for (const item of preview.items) {
      if (item.status === 'missing_key' || item.status === 'conflict') { skipped++; continue; }

      const hash = rowHash(item);
      hashes.set(item.rowIndex, hash);

      const binding = this.deps.bindingRepo.findBySourceRow(sourceId, tabId, item.rowIndex);
      if (binding && binding.lastReadHash === hash) { unchanged++; continue; }

      changed.push(item);
    }

    let created = 0, bound = 0;
    let fieldsApplied = 0, fieldsConflicted = 0;

    if (changed.length) {
      const delta: ImportPreview = { ...preview, items: changed };
      const ingest = await this.deps.importService.confirmImport(delta, actor ?? 'system:sheet-poll');
      created = ingest.created;
      bound = ingest.bound;

      // Field-level inbound apply for rows already in the warehouse. New rows
      // were just created from the same values, so they need no second write.
      if (this.deps.conflictSvc) {
        for (const item of changed) {
          if (!item.matchedId) continue;
          const outcome = this.deps.conflictSvc.applyInboundRow({
            accountId: item.matchedId,
            sourceId,
            rowIndex: item.rowIndex,
            values: item.rowData,
            policyByField,
            actor: actor ?? 'system:sheet-poll',
          });
          fieldsApplied += outcome.applied.length;
          fieldsConflicted += outcome.conflicted.length;
        }
      }

      // Stamp the hash only after the row's data actually landed, so a crash
      // mid-run re-processes the row instead of silently dropping the edit.
      const now = new Date().toISOString();
      for (const item of changed) {
        const binding = this.deps.bindingRepo.findBySourceRow(sourceId, tabId, item.rowIndex);
        const hash = hashes.get(item.rowIndex);
        if (binding && hash) this.deps.bindingRepo.updateHashes(binding.id, hash, undefined, now);
      }

      this.deps.auditRepo?.append({
        actor: actor ?? null,
        action: 'sheet_poll_ingest',
        entityType: 'sheet_source',
        entityId: sourceId,
        beforeJson: null,
        afterJson: JSON.stringify({
          tabTitle, changed: changed.length, created, bound, fieldsApplied, fieldsConflicted,
        }),
        source: 'sheet_poll',
      });
    }

    return {
      sourceId, sourceName, tabId, tabTitle,
      totalRows: preview.items.length,
      changedRows: changed.length,
      unchanged, created, bound, skipped,
      fieldsApplied, fieldsConflicted,
    };
  }
}
