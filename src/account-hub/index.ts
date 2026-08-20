/**
 * Account Hub — Entry Point (Phases 1–7)
 *
 * Exports `createAccountHubRouter()` — the only surface exposed to server/app.ts.
 * Returns null when ACCOUNT_HUB_ENABLED=false (nothing initialises).
 */

import { Router, Request, Response } from 'express';
import { accountHubConfig } from './config.js';
import { initDb } from './db/connection.js';
import { runMigrations } from './db/migrations.js';
import { AccountRepository } from './db/repositories/account-repository.js';
import { AuditLogRepository } from './db/repositories/audit-log-repository.js';
import { SyncJobRepository } from './db/repositories/sync-job-repository.js';
import { SheetSourceRepository } from './db/repositories/sheet-source-repository.js';
import { RowBindingRepository } from './db/repositories/row-binding-repository.js';
import { AccountService } from './services/account-service.js';
import { SheetImportService } from './services/sheet-import-service.js';
import { SheetSyncService } from './services/sheet-sync-service.js';
import { ConflictService } from './services/conflict-service.js';
import { GoogleSheetsClient } from './google-sheets/client.js';
import { AdspowerAdapter } from './adspower/adapter.js';
import { AdspowerReconcileService } from './adspower/reconcile-service.js';
import { BulkCreateAndLoginQueue } from './adspower/import-queue.js';
import { buildAccountHubApiRouter } from './api/router.js';
import { logger } from '../utils/logger.js';

export function createAccountHubRouter(): Router | null {
  if (!accountHubConfig.enabled) {
    return null;
  }

  logger.info('[AccountHub] Initialising subsystem…');

  // ---- DB setup ----
  const db = initDb();
  runMigrations(db);

  // ---- Repositories ----
  const accountRepo  = new AccountRepository(db);
  const auditRepo    = new AuditLogRepository(db);
  const syncJobRepo  = new SyncJobRepository(db);
  const sourceRepo   = new SheetSourceRepository(db);
  const bindingRepo  = new RowBindingRepository(db);

  // ---- Services ----
  const accountSvc      = new AccountService(accountRepo, auditRepo);
  const adspowerAdapter = new AdspowerAdapter();
  const reconcileSvc    = new AdspowerReconcileService(adspowerAdapter, accountRepo, syncJobRepo, auditRepo);
  const bulkQueue       = new BulkCreateAndLoginQueue(accountRepo, syncJobRepo, auditRepo);
  const conflictSvc     = new ConflictService(db, accountRepo, auditRepo);

  // Start background reconcile scheduler if enabled
  if (accountHubConfig.adspowerReconcileEnabled) {
    reconcileSvc.startScheduler();
  }

  // Google Sheets services (only if credentials are configured)
  let importService: SheetImportService | undefined;
  let syncService:   SheetSyncService   | undefined;

  const credPath = process.env.ACCOUNT_HUB_GOOGLE_CREDENTIALS_PATH;
  if (credPath) {
    const sheetsClient = new GoogleSheetsClient(credPath);
    importService = new SheetImportService(
      sheetsClient, accountRepo, sourceRepo, bindingRepo, auditRepo,
    );
    syncService = new SheetSyncService(
      sheetsClient, accountRepo, sourceRepo, bindingRepo, syncJobRepo, auditRepo,
    );
  }

  const router = Router();

  // ---- SSE clients ----
  const sseClients: Response[] = [];

  function broadcastAccountHub(eventName: string, data: unknown) {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (let i = sseClients.length - 1; i >= 0; i--) {
      try { sseClients[i].write(payload); } catch { sseClients.splice(i, 1); }
    }
  }

  // ---- Health endpoint ----
  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      status:    'ok',
      subsystem: 'account-hub',
      dryRun:    accountHubConfig.dryRun,
      flags: {
        sheetSyncEnabled:           accountHubConfig.sheetSyncEnabled,
        adspowerReconcileEnabled:   accountHubConfig.adspowerReconcileEnabled,
        autoImportEnabled:          accountHubConfig.autoImportEnabled,
        autoLoginEnabled:           accountHubConfig.autoLoginEnabled,
      },
    });
  });

  // ---- SSE endpoint ----
  router.get('/events', (req: Request, res: Response) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();
    res.write('event: connected\ndata: {}\n\n');

    sseClients.push(res);
    req.on('close', () => {
      const idx = sseClients.indexOf(res);
      if (idx !== -1) sseClients.splice(idx, 1);
    });
  });

  // ---- Mount API router ----
  const apiRouter = buildAccountHubApiRouter(
    accountSvc, syncJobRepo, auditRepo,
    broadcastAccountHub,
    sourceRepo,
    importService,
    syncService,
    adspowerAdapter,
    bulkQueue,
    conflictSvc,
  );
  router.use('/', apiRouter);

  logger.info('[AccountHub] Subsystem ready.');
  return router;
}
