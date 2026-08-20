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
import { SheetSourceRepository } from '../db/repositories/sheet-source-repository.js';
import type { SheetImportService } from '../services/sheet-import-service.js';
import type { SheetSyncService } from '../services/sheet-sync-service.js';
import type { AdspowerAdapter } from '../adspower/adapter.js';
import type { BulkCreateAndLoginQueue } from '../adspower/import-queue.js';
import type { ConflictService } from '../services/conflict-service.js';
import type { PaginationParams, UpdateAccountDto } from '../domain/types.js';

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
): Router {
  const router = Router();

  function emit(event: string, data: unknown) {
    broadcast?.(event, data);
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
      const src = sourceRepo.create({
        name, spreadsheetId,
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

  router.post('/sheet-sources/:id/inspect', async (_req: Request, res: Response) => {
    if (!sourceRepo) return json400(res, 'Sheet sources not configured');
    try {
      const { getSheetsClient } = await import('../google-sheets/client.js');
      const client = getSheetsClient();
      const src    = sourceRepo.findById(String(_req.params.id));
      if (!src) return json404(res, 'Source not found');
      const tabs = await client.listTabs(src.spreadsheetId);
      json200(res, { tabs });
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

  router.post('/reconcile/adspower', async (_req: Request, res: Response) => {
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
      const { accountIds } = req.body as { accountIds?: string[] };
      if (!accountIds || !Array.isArray(accountIds)) return json400(res, 'accountIds array required');
      const items = bulkQueue.addAccounts(accountIds);
      json200(res, { added: items.length, summary: bulkQueue.getStatusSummary() });
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
  // POST /accounts/:id/request-delete  (stub — Phase 8)
  // ------------------------------------------------------------------
  router.post('/accounts/:id/request-delete', (_req: Request, res: Response) => {
    res.status(503).json({
      success: false,
      error:   'Controlled deletion is not enabled in this build (Phase 8, requires separate approval).',
    });
  });

  return router;
}
