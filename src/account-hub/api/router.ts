/**
 * Account Hub — API Router (Phases 1–7)
 *
 * All routes under /api/account-hub
 * Auth is enforced by the parent middleware in server/app.ts.
 */

import { Router, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../../auth/middleware.js';
import { AccountService } from '../services/account-service.js';
import { AuditLogRepository } from '../db/repositories/audit-log-repository.js';
import { SyncJobRepository } from '../db/repositories/sync-job-repository.js';
import { SheetSourceRepository, type FieldMapping } from '../db/repositories/sheet-source-repository.js';
import type { CountryTabMappingRepository } from '../db/repositories/country-tab-repository.js';
import type { SheetImportService } from '../services/sheet-import-service.js';
import type { SheetSyncService } from '../services/sheet-sync-service.js';
import type { AdspowerAdapter } from '../adspower/adapter.js';
import type { BulkCreateAndLoginQueue, QueuedProxyMap } from '../adspower/import-queue.js';
import type { ConflictService } from '../services/conflict-service.js';
import type { PaginationParams, UpdateAccountDto } from '../domain/types.js';
import type { NotificationService } from '../services/notification-service.js';
import type { DuplicateService } from '../services/duplicate-service.js';
import type { ChannelMatchService } from '../services/channel-match-service.js';
import type { AdspowerReconcileService } from '../adspower/reconcile-service.js';
import type { DieWritebackService } from '../services/die-writeback-service.js';
import type { SheetPollService } from '../services/sheet-poll-service.js';
import type { ProxyCheckService } from '../services/proxy-check-service.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function actor(req: Request): string | undefined {
  return (req as AuthenticatedRequest).userSession?.username;
}

function json200(res: Response, data: unknown) {
  res.json({ success: true, data });
}

function json400(res: Response, error: string) {
  res.status(400).json({ success: false, error });
}

function json404(res: Response, msg = 'Not found') {
  res.status(404).json({ success: false, error: msg });
}

function json409(res: Response, msg: string) {
  res.status(409).json({ success: false, error: msg });
}

function json500(res: Response, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ success: false, error: message });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function buildAccountHubApiRouter(
  accountService: AccountService,
  syncJobRepo: SyncJobRepository,
  auditRepo: AuditLogRepository,
  broadcast?: (event: string, data: unknown) => void,
  sourceRepo?: SheetSourceRepository,
  importService?: SheetImportService,
  syncService?: SheetSyncService,
  adspowerAdapter?: AdspowerAdapter,
  bulkQueue?: BulkCreateAndLoginQueue,
  conflictService?: ConflictService,
  countryRepo?: CountryTabMappingRepository,
  notificationSvc?: NotificationService,
  duplicateSvc?: DuplicateService,
  channelMatchSvc?: ChannelMatchService,
  reconcileSvc?: AdspowerReconcileService,
  dieWritebackSvc?: DieWritebackService,
  proxyCheckSvc?: ProxyCheckService,
  pollSvc?: SheetPollService,
): Router {
  const router = Router();

  function emit(event: string, data: unknown) {
    broadcast?.(event, data);
  }

  /**
   * spec §4.1 — a status edit may create or clear the "DIE but the AdsPower
   * profile still exists" condition. Checked out-of-band so the HTTP response
   * never waits on the AdsPower Local API (fire-and-forget, project convention).
   */
  function afterStatusChange(accountId: string) {
    if (!reconcileSvc) return;
    reconcileSvc
      .checkDieAlive(accountId)
      .catch(() => { /* notification is best-effort; the sweep re-checks later */ });
  }

  // ------------------------------------------------------------------
  // GET /accounts
  // ------------------------------------------------------------------
  router.get('/accounts', (req: Request, res: Response) => {
    try {
      const params: PaginationParams = {
        page:            Number(req.query.page)  || 1,
        limit:           Number(req.query.limit) || 50,
        search:          req.query.search as string | undefined,
        accountStatus:   req.query.accountStatus as PaginationParams['accountStatus'],
        adspowerStatus:  req.query.adspowerStatus as PaginationParams['adspowerStatus'],
        sortBy:          req.query.sortBy as string | undefined,
        sortDir:         req.query.sortDir as 'asc' | 'desc' | undefined,
      };
      json200(res, accountService.list(params));
    } catch (err) {
      json500(res, err);
    }
  });

  // ------------------------------------------------------------------
  // GET /accounts/:id
  // ------------------------------------------------------------------
  router.get('/accounts/:id', (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const account = accountService.getById(id);
      if (!account) return json404(res, `Account ${id} not found`);
      json200(res, account);
    } catch (err) {
      json500(res, err);
    }
  });

  // ------------------------------------------------------------------
  // POST /accounts
  // ------------------------------------------------------------------
  router.post('/accounts', (req: Request, res: Response) => {
    try {
      const { profileName } = req.body as { profileName?: string };
      if (!profileName?.trim()) {
        return json400(res, 'profileName is required');
      }
      const account = accountService.create({ ...req.body, createdBy: actor(req) });
      res.status(201).json({ success: true, data: account });
    } catch (err) {
      json500(res, err);
    }
  });

  // ------------------------------------------------------------------
  // PATCH /accounts/:id
  // ------------------------------------------------------------------
  router.patch('/accounts/:id', (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const dto = req.body as UpdateAccountDto;
      if (dto.version === undefined || typeof dto.version !== 'number') {
        return json400(res, '`version` (number) is required for optimistic locking');
      }
      const account = accountService.update(id, dto, actor(req));
      emit('account_updated', { id: account.id });
      if (dto.accountStatus) afterStatusChange(account.id);
      json200(res, account);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) return json404(res, msg);
      if (msg.includes('lock conflict') || msg.includes('Optimistic')) return json409(res, msg);
      json500(res, err);
    }
  });

  // ------------------------------------------------------------------
  // POST /accounts/:id/mark-die
  // ------------------------------------------------------------------
  router.post('/accounts/:id/mark-die', (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const { version } = req.body as { version?: number };
      if (version === undefined) return json400(res, '`version` is required');
      const account = accountService.markDie(id, version, actor(req));
      emit('account_updated', { id: account.id });
      afterStatusChange(account.id);
      json200(res, account);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) return json404(res, msg);
      json500(res, err);
    }
  });

  // ------------------------------------------------------------------
  // GET /accounts/:id/history
  // ------------------------------------------------------------------
  router.get('/accounts/:id/history', (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const logs = auditRepo.listByEntity('account', id);
      json200(res, logs);
    } catch (err) {
      json500(res, err);
    }
  });

  // ------------------------------------------------------------------
  // GET /sync-jobs
  // ------------------------------------------------------------------
  router.get('/sync-jobs', (_req: Request, res: Response) => {
    try {
      const jobs = syncJobRepo.list();
      json200(res, jobs);
    } catch (err) {
      json500(res, err);
    }
  });

  // ------------------------------------------------------------------
  // GET /sync-jobs/:id
  // ------------------------------------------------------------------
  router.get('/sync-jobs/:id', (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const job = syncJobRepo.findById(id);
      if (!job) return json404(res, `Sync job ${id} not found`);
      json200(res, job);
    } catch (err) {
      json500(res, err);
    }
  });

  // ------------------------------------------------------------------
  // POST /sync-jobs/:id/retry
  // ------------------------------------------------------------------
  router.post('/sync-jobs/:id/retry', async (req: Request, res: Response) => {
    if (!syncService) return json400(res, 'Sync service not available');
    try {
      const result = await syncService.retryJob(String(req.params.id));
      json200(res, result);
    } catch (err) { json500(res, err); }
  });

  // ------------------------------------------------------------------
  // Phase 3 — Google Sheets source management
  // ------------------------------------------------------------------

  router.get('/sheet-sources', (_req: Request, res: Response) => {
    if (!sourceRepo) return json200(res, []);
    try { json200(res, sourceRepo.list()); } catch (err) { json500(res, err); }
  });

  router.post('/sheet-sources', (req: Request, res: Response) => {
    if (!sourceRepo) return json400(res, 'Sheet sources not configured');
    try {
      const { name, spreadsheetId } = req.body as { name?: string; spreadsheetId?: string };
      if (!name || !spreadsheetId) return json400(res, 'name and spreadsheetId are required');
      // Accept a full Sheets URL or a bare ID.
      const sid = /\/d\/([a-zA-Z0-9-_]+)/.exec(spreadsheetId)?.[1] ?? spreadsheetId.trim();
      const src = sourceRepo.create({
        name, spreadsheetId: sid,
        credentialRef: null, syncDirection: 'outbound',
        isEnabled: false, priority: 0,
        headerRow: 1, firstDataRow: 2, pollIntervalSec: 300,
      });
      res.status(201).json({ success: true, data: src });
    } catch (err) { json500(res, err); }
  });

  router.patch('/sheet-sources/:id', (req: Request, res: Response) => {
    if (!sourceRepo) return json400(res, 'Sheet sources not configured');
    try {
      const src = sourceRepo.update(String(req.params.id), req.body);
      json200(res, src);
    } catch (err) { json500(res, err); }
  });

  router.post('/sheet-sources/:id/inspect', async (req: Request, res: Response) => {
    if (!sourceRepo) return json400(res, 'Sheet sources not configured');
    try {
      const { getSheetsClient } = await import('../google-sheets/client.js');
      const client = getSheetsClient();
      const id  = String(req.params.id);
      const src = sourceRepo.findById(id);
      if (!src) return json404(res, 'Source not found');
      const liveTabs = await client.listTabs(src.spreadsheetId);
      // Persist each tab so mappings and country rows can reference a stable tab id.
      const tabs = liveTabs.map((t) => sourceRepo.upsertTab(id, t.sheetId, t.title));
      json200(res, { tabs });
    } catch (err) { json500(res, err); }
  });

  // Persisted tabs (no live Google call) — used to populate mapping/country UI.
  router.get('/sheet-sources/:id/tabs', (req: Request, res: Response) => {
    if (!sourceRepo) return json200(res, []);
    try { json200(res, sourceRepo.listTabs(String(req.params.id))); } catch (err) { json500(res, err); }
  });

  // Header + sample rows for a tab — powers the mapping-column dropdown and preview grid.
  router.post('/sheet-sources/:id/schema', async (req: Request, res: Response) => {
    if (!sourceRepo) return json400(res, 'Sheet sources not configured');
    try {
      const { tabTitle } = req.body as { tabTitle?: string };
      if (!tabTitle) return json400(res, 'tabTitle is required');
      const src = sourceRepo.findById(String(req.params.id));
      if (!src) return json404(res, 'Source not found');
      const { getSheetsClient } = await import('../google-sheets/client.js');
      const client = getSheetsClient();
      const schema = await client.readSchema(src.spreadsheetId, tabTitle, src.headerRow);
      const rows = await client.readRows(
        src.spreadsheetId, tabTitle, src.firstDataRow, src.firstDataRow + 9, schema,
      );
      json200(res, {
        headers: schema.headers,
        rows: rows.map((r) => r.cells.map((c) => c.formatted)),
      });
    } catch (err) { json500(res, err); }
  });

  // ---- Field mappings (self-service) ----
  router.get('/sheet-sources/:id/mappings', (req: Request, res: Response) => {
    if (!sourceRepo) return json200(res, []);
    try { json200(res, sourceRepo.listMappings(String(req.params.id))); } catch (err) { json500(res, err); }
  });

  router.post('/sheet-sources/:id/mappings', (req: Request, res: Response) => {
    if (!sourceRepo) return json400(res, 'Sheet sources not configured');
    try {
      const b = req.body as Partial<FieldMapping>;
      if (b.columnIndex === undefined || typeof b.columnIndex !== 'number') {
        return json400(res, 'columnIndex (number) is required');
      }
      if (!b.systemField && !b.customFieldId) {
        return json400(res, 'either systemField or customFieldId is required');
      }
      const mapping = sourceRepo.upsertMapping({
        sourceId:       String(req.params.id),
        tabId:          b.tabId ?? null,
        systemField:    b.systemField ?? null,
        customFieldId:  b.customFieldId ?? null,
        columnLetter:   b.columnLetter ?? '',
        columnIndex:    b.columnIndex,
        mappedHeader:   b.mappedHeader ?? null,
        syncDirection:  b.syncDirection ?? 'outbound',
        transformRule:  b.transformRule ?? null,
        conflictPolicy: b.conflictPolicy ?? 'ask',
        isKeyCandidate: Boolean(b.isKeyCandidate),
        needsAttention: false,
      });
      res.status(201).json({ success: true, data: mapping });
    } catch (err) { json500(res, err); }
  });

  router.delete('/sheet-sources/:id/mappings/:mappingId', (req: Request, res: Response) => {
    if (!sourceRepo) return json400(res, 'Sheet sources not configured');
    try {
      const ok = sourceRepo.deleteMapping(String(req.params.mappingId));
      if (!ok) return json404(res, 'Mapping not found');
      json200(res, { deleted: true });
    } catch (err) { json500(res, err); }
  });

  // Self-heal: re-point drifted mappings against the current sheet headers.
  router.post('/sheet-sources/:id/reconcile-mappings', async (req: Request, res: Response) => {
    if (!sourceRepo) return json400(res, 'Sheet sources not configured');
    try {
      const id = String(req.params.id);
      const body = req.body as { headers?: string[]; tabTitle?: string };
      let headers = body.headers;
      if (!headers) {
        if (!body.tabTitle) return json400(res, 'headers[] or tabTitle is required');
        const src = sourceRepo.findById(id);
        if (!src) return json404(res, 'Source not found');
        const { getSheetsClient } = await import('../google-sheets/client.js');
        const schema = await getSheetsClient().readSchema(src.spreadsheetId, body.tabTitle, src.headerRow);
        headers = schema.headers;
      }
      const report = sourceRepo.reconcileMappings(id, headers);
      json200(res, report);
    } catch (err) { json500(res, err); }
  });

  // ---- Country → Reup tab mappings (config-driven, no hard-coded tab names) ----
  router.get('/sheet-sources/:id/country-tabs', (req: Request, res: Response) => {
    if (!countryRepo) return json200(res, []);
    try { json200(res, countryRepo.list(String(req.params.id))); } catch (err) { json500(res, err); }
  });

  router.post('/sheet-sources/:id/country-tabs', (req: Request, res: Response) => {
    if (!countryRepo) return json400(res, 'Country mapping not configured');
    try {
      const b = req.body as { country?: string; tabId?: string | null; tabTitle?: string | null };
      if (!b.country?.trim()) return json400(res, 'country is required');
      const mapping = countryRepo.upsert({
        sourceId: String(req.params.id),
        country:  b.country,
        tabId:    b.tabId ?? null,
        tabTitle: b.tabTitle ?? null,
      });
      res.status(201).json({ success: true, data: mapping });
    } catch (err) { json500(res, err); }
  });

  router.delete('/sheet-sources/:id/country-tabs/:cid', (req: Request, res: Response) => {
    if (!countryRepo) return json400(res, 'Country mapping not configured');
    try {
      const ok = countryRepo.delete(String(req.params.cid));
      if (!ok) return json404(res, 'Country mapping not found');
      json200(res, { deleted: true });
    } catch (err) { json500(res, err); }
  });

  router.post('/sheet-sources/:id/import-preview', async (req: Request, res: Response) => {
    if (!importService) return json400(res, 'Import service not configured');
    try {
      const { tabId } = req.body as { tabId?: string };
      if (!tabId) return json400(res, 'tabId is required');
      const preview = await importService.preview(String(req.params.id), tabId);
      json200(res, preview);
    } catch (err) { json500(res, err); }
  });

  router.post('/sheet-sources/:id/import', async (req: Request, res: Response) => {
    if (!importService) return json400(res, 'Import service not configured');
    try {
      const { preview } = req.body as { preview?: unknown };
      if (!preview) return json400(res, 'preview object is required');
      const result = await importService.confirmImport(
        preview as Parameters<typeof importService.confirmImport>[0],
        actor(req),
      );
      json200(res, result);
    } catch (err) { json500(res, err); }
  });

  // ------------------------------------------------------------------
  // Phase 4 — Outbound sync (Save & Sync)
  // ------------------------------------------------------------------

  router.post('/accounts/:id/sync', async (req: Request, res: Response) => {
    if (!syncService) return json400(res, 'Sync service not available');
    try {
      const result = await syncService.syncAccounts([String(req.params.id)], { createdBy: actor(req) });
      emit('sync_job_done', { jobId: result.jobId });
      json200(res, result);
    } catch (err) { json500(res, err); }
  });

  router.post('/accounts/bulk-sync', async (req: Request, res: Response) => {
    if (!syncService) return json400(res, 'Sync service not available');
    try {
      const { accountIds } = req.body as { accountIds?: string[] };
      const result = await syncService.syncAccounts(accountIds ?? [], { createdBy: actor(req) });
      emit('sync_job_done', { jobId: result.jobId });
      json200(res, result);
    } catch (err) { json500(res, err); }
  });

  // ------------------------------------------------------------------
  // Phase 5 — AdsPower reconcile
  // ------------------------------------------------------------------

  router.post('/reconcile/adspower', async (req: Request, res: Response) => {
    if (reconcileSvc) {
      try {
        const result = await reconcileSvc.reconcile({ createdBy: actor(req) });
        emit('reconcile_done', result);
        return json200(res, result);
      } catch (err) { return json500(res, err); }
    }
    if (!adspowerAdapter) return json400(res, 'AdsPower adapter not configured');
    try {
      const profiles = await adspowerAdapter.listAllProfiles();
      json200(res, { profileCount: profiles.length, message: 'Reconcile triggered — see sync jobs.' });
    } catch (err) { json500(res, err); }
  });

  router.get('/reconcile/summary', (_req: Request, res: Response) => {
    try {
      const jobs = syncJobRepo.list(10).filter(j => j.jobType === 'adspower_reconcile');
      json200(res, jobs);
    } catch (err) { json500(res, err); }
  });

  // ------------------------------------------------------------------
  // Phase 6 — Bulk create & auto login queue
  // ------------------------------------------------------------------

  router.get('/queue/status', (_req: Request, res: Response) => {
    if (!bulkQueue) return json400(res, 'Queue not configured');
    json200(res, bulkQueue.getStatusSummary());
  });

  router.post('/queue/add', (req: Request, res: Response) => {
    if (!bulkQueue) return json400(res, 'Queue not configured');
    try {
      const { accountIds, proxies } = req.body as { accountIds?: string[]; proxies?: QueuedProxyMap };
      if (!accountIds || !Array.isArray(accountIds)) return json400(res, 'accountIds array required');
      const items = bulkQueue.addAccounts(accountIds, proxies ?? {});
      json200(res, { added: items.length, summary: bulkQueue.getStatusSummary() });
    } catch (err) { json500(res, err); }
  });

  /** Re-queue failed + proxy-blocked items; `proxies` replaces a rejected proxy. */
  router.post('/queue/retry', (req: Request, res: Response) => {
    if (!bulkQueue) return json400(res, 'Queue not configured');
    try {
      const { proxies } = req.body as { proxies?: QueuedProxyMap };
      bulkQueue.retryFailed({ proxies });
      json200(res, { message: 'Failed and proxy-blocked items re-queued', summary: bulkQueue.getStatusSummary() });
    } catch (err) { json500(res, err); }
  });

  // ------------------------------------------------------------------
  // Proxy gate (spec §5) — missing/faulty proxy is the only hard block
  // ------------------------------------------------------------------

  /** Check one account's proxy. `?probe=1` also TCP-connects to the endpoint. */
  router.get('/accounts/:id/proxy-check', async (req: Request, res: Response) => {
    if (!proxyCheckSvc) return json400(res, 'Proxy check not configured');
    try {
      const result = await proxyCheckSvc.checkAccount(String(req.params.id), {
        probe: req.query.probe === '1' || req.query.probe === 'true',
      });
      json200(res, result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) return json404(res, msg);
      json500(res, err);
    }
  });

  /** Batch gate: returns per-account results plus the ids allowed to proceed. */
  router.post('/proxy-check', async (req: Request, res: Response) => {
    if (!proxyCheckSvc) return json400(res, 'Proxy check not configured');
    try {
      const { accountIds, probe, notify } = req.body as {
        accountIds?: string[]; probe?: boolean; notify?: boolean;
      };
      if (!accountIds || !Array.isArray(accountIds)) return json400(res, 'accountIds array required');
      json200(res, await proxyCheckSvc.checkAccounts(accountIds, { probe, notify }));
    } catch (err) { json500(res, err); }
  });

  router.post('/queue/start', async (req: Request, res: Response) => {
    if (!bulkQueue) return json400(res, 'Queue not configured');
    try {
      bulkQueue.startProcessing({ createdBy: actor(req) });
      json200(res, { message: 'Queue processing started', summary: bulkQueue.getStatusSummary() });
    } catch (err) { json500(res, err); }
  });

  router.post('/queue/pause', (_req: Request, res: Response) => {
    if (!bulkQueue) return json400(res, 'Queue not configured');
    bulkQueue.pause();
    json200(res, { message: 'Queue paused', summary: bulkQueue.getStatusSummary() });
  });

  router.post('/queue/resume', (req: Request, res: Response) => {
    if (!bulkQueue) return json400(res, 'Queue not configured');
    bulkQueue.resume({ createdBy: actor(req) });
    json200(res, { message: 'Queue resumed', summary: bulkQueue.getStatusSummary() });
  });

  router.post('/queue/cancel', (_req: Request, res: Response) => {
    if (!bulkQueue) return json400(res, 'Queue not configured');
    bulkQueue.cancel();
    json200(res, { message: 'Queue cancelled', summary: bulkQueue.getStatusSummary() });
  });

  // ------------------------------------------------------------------
  // Phase 7 — Controlled inbound & Conflict resolution
  // ------------------------------------------------------------------

  router.get('/conflicts', (req: Request, res: Response) => {
    if (!conflictService) return json200(res, []);
    try {
      const status = req.query.status as any;
      json200(res, conflictService.listConflicts(status));
    } catch (err) { json500(res, err); }
  });

  router.post('/conflicts/:id/resolve', (req: Request, res: Response) => {
    if (!conflictService) return json400(res, 'Conflict service not configured');
    try {
      const { resolution } = req.body as { resolution?: 'use_db' | 'use_sheet' };
      if (!resolution || !['use_db', 'use_sheet'].includes(resolution)) {
        return json400(res, 'resolution must be "use_db" or "use_sheet"');
      }
      const resolved = conflictService.resolveConflict(String(req.params.id), resolution, actor(req));
      json200(res, resolved);
    } catch (err) { json500(res, err); }
  });

  // ------------------------------------------------------------------
  // Inbound Sheets poll (spec §7.2) — manual trigger for the scheduler
  // ------------------------------------------------------------------

  router.post('/sheet-poll/run', async (req: Request, res: Response) => {
    if (!pollSvc) return json400(res, 'Sheet poll not configured (Google credentials required)');
    try {
      const { sourceId } = req.body as { sourceId?: string };
      if (sourceId) {
        const results = await pollSvc.requestPoll(String(sourceId), 'manual', actor(req));
        return json200(res, { results });
      }
      json200(res, await pollSvc.pollAll('manual', actor(req)));
    } catch (err) { json500(res, err); }
  });

  // ------------------------------------------------------------------
  // POST /accounts/:id/request-delete  (stub — Phase 8)
  // ------------------------------------------------------------------
  router.post('/accounts/:id/request-delete', (_req: Request, res: Response) => {
    res.status(503).json({
      success: false,
      error:   'Controlled deletion is not enabled in this build (Phase 8, requires separate approval).',
    });
  });

  // ------------------------------------------------------------------
  // Notifications (spec §1, §4.1) — duplicate + DIE-still-alive warnings
  // ------------------------------------------------------------------

  router.get('/notifications', (req: Request, res: Response) => {
    if (!notificationSvc) return json200(res, []);
    try {
      const status = req.query.status as any;
      json200(res, notificationSvc.list(status));
    } catch (err) { json500(res, err); }
  });

  router.get('/notifications/count', (_req: Request, res: Response) => {
    if (!notificationSvc) return json200(res, { open: 0 });
    try { json200(res, { open: notificationSvc.countOpen() }); } catch (err) { json500(res, err); }
  });

  router.post('/notifications/:id/resolve', (req: Request, res: Response) => {
    if (!notificationSvc) return json400(res, 'Notifications not configured');
    try {
      const ok = notificationSvc.resolve(String(req.params.id), actor(req));
      if (!ok) return json404(res, 'Notification not found');
      json200(res, { resolved: true });
    } catch (err) { json500(res, err); }
  });

  router.post('/notifications/:id/dismiss', (req: Request, res: Response) => {
    if (!notificationSvc) return json400(res, 'Notifications not configured');
    try {
      const ok = notificationSvc.dismiss(String(req.params.id), actor(req));
      if (!ok) return json404(res, 'Notification not found');
      json200(res, { dismissed: true });
    } catch (err) { json500(res, err); }
  });

  // ------------------------------------------------------------------
  // Duplicate detection (spec §1) — warn only, never auto-merge
  // ------------------------------------------------------------------

  router.post('/duplicates/scan', (_req: Request, res: Response) => {
    if (!duplicateSvc) return json400(res, 'Duplicate service not configured');
    try { json200(res, duplicateSvc.scanAndFlag()); } catch (err) { json500(res, err); }
  });

  // ------------------------------------------------------------------
  // Channel match (spec §0.4, §4) — BC ↔ Reup, warehouse write only
  // ------------------------------------------------------------------

  router.post('/channel-match/run', async (req: Request, res: Response) => {
    if (!channelMatchSvc) return json400(res, 'Channel match service not configured (Google credentials required)');
    try {
      const { bcSourceId, reupSourceId } = req.body as { bcSourceId?: string; reupSourceId?: string };
      if (!bcSourceId || !reupSourceId) return json400(res, 'bcSourceId and reupSourceId are required');
      const report = await channelMatchSvc.matchSource(bcSourceId, reupSourceId, actor(req));
      json200(res, report);
    } catch (err) { json500(res, err); }
  });

  // ------------------------------------------------------------------
  // DIE colour write-back (spec §4, decision #3) — preview then apply.
  // Paints the exact configured red at the exact region; restores the
  // original colour (undo) when an account leaves DIE. Never writes Reup.
  // ------------------------------------------------------------------

  router.post('/die-writeback/preview', async (req: Request, res: Response) => {
    if (!dieWritebackSvc) return json400(res, 'DIE write-back not configured (Google credentials required)');
    try {
      const { accountIds } = req.body as { accountIds?: string[] };
      json200(res, await dieWritebackSvc.preview(Array.isArray(accountIds) ? accountIds : []));
    } catch (err) { json500(res, err); }
  });

  router.post('/die-writeback/apply', async (req: Request, res: Response) => {
    if (!dieWritebackSvc) return json400(res, 'DIE write-back not configured (Google credentials required)');
    try {
      const { accountIds, dryRun } = req.body as { accountIds?: string[]; dryRun?: boolean };
      const result = await dieWritebackSvc.apply(
        Array.isArray(accountIds) ? accountIds : [],
        { dryRun, createdBy: actor(req) },
      );
      emit('die-writeback-complete', result);
      json200(res, result);
    } catch (err) { json500(res, err); }
  });

  return router;
}
