/**
 * Account Hub — Entry Point (Phases 1–9)
 *
 * Exports the two surfaces server/app.ts mounts:
 *   - `createAccountHubRouter()`         -> /api/account-hub  (behind authMiddleware)
 *   - `createAccountHubWebhookRouter()`  -> public HMAC webhook (spec §7.1)
 *
 * Both return null when ACCOUNT_HUB_ENABLED=false (nothing initialises). The
 * subsystem is built at most once, no matter which factory is called first.
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
import { CountryTabMappingRepository } from './db/repositories/country-tab-repository.js';
import { AccountService } from './services/account-service.js';
import { SheetImportService } from './services/sheet-import-service.js';
import { SheetSyncService } from './services/sheet-sync-service.js';
import { ConflictService } from './services/conflict-service.js';
import { GoogleSheetsClient } from './google-sheets/client.js';
import { AdspowerAdapter } from './adspower/adapter.js';
import { AdspowerReconcileService } from './adspower/reconcile-service.js';
import { BulkCreateAndLoginQueue } from './adspower/import-queue.js';
import { buildAccountHubApiRouter } from './api/router.js';
import { NotificationRepository } from './db/repositories/notification-repository.js';
import { NotificationService } from './services/notification-service.js';
import { DuplicateService } from './services/duplicate-service.js';
import { ChannelMatchService } from './services/channel-match-service.js';
import { DieWritebackService } from './services/die-writeback-service.js';
import { ProxyCheckService } from './services/proxy-check-service.js';
import { SheetPollService } from './services/sheet-poll-service.js';
import { buildAccountHubWebhookRouter } from './api/webhook-router.js';
import { logger } from '../utils/logger.js';

interface AccountHubRuntime {
  apiRouter:     Router;
  webhookRouter: Router | null;
}

/** Built once; both factories share it. */
let runtime: AccountHubRuntime | null = null;

function getRuntime(): AccountHubRuntime | null {
  if (!accountHubConfig.enabled) return null;
  if (!runtime) runtime = buildRuntime();
  return runtime;
}

/** The dashboard API router, mounted at /api/account-hub behind authMiddleware. */
export function createAccountHubRouter(): Router | null {
  return getRuntime()?.apiRouter ?? null;
}

/**
 * The public Apps Script webhook router (spec §7.1). Null when the subsystem is
 * off or no Google credentials are configured (nothing to poll).
 * MUST be mounted outside authMiddleware — HMAC is its credential.
 */
export function createAccountHubWebhookRouter(): Router | null {
  return getRuntime()?.webhookRouter ?? null;
}

function buildRuntime(): AccountHubRuntime {

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
  const countryRepo  = new CountryTabMappingRepository(db);
  const notificationRepo = new NotificationRepository(db);

  // ---- SSE clients + broadcast (declared here; used by services below) ----
  const sseClients: Response[] = [];
  function broadcastAccountHub(eventName: string, data: unknown) {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (let i = sseClients.length - 1; i >= 0; i--) {
      try { sseClients[i].write(payload); } catch { sseClients.splice(i, 1); }
    }
  }

  // ---- Services ----
  const accountSvc      = new AccountService(accountRepo, auditRepo);
  const notificationSvc = new NotificationService(notificationRepo, broadcastAccountHub);
  const duplicateSvc    = new DuplicateService(db, notificationSvc);
  const adspowerAdapter = new AdspowerAdapter();
  const reconcileSvc    = new AdspowerReconcileService(adspowerAdapter, accountRepo, syncJobRepo, auditRepo, notificationSvc);
  const proxyCheckSvc   = new ProxyCheckService(adspowerAdapter, accountRepo, notificationSvc);
  const bulkQueue       = new BulkCreateAndLoginQueue(accountRepo, syncJobRepo, auditRepo, proxyCheckSvc);
  const conflictSvc     = new ConflictService(db, accountRepo, auditRepo);

  // Start background reconcile scheduler if enabled
  if (accountHubConfig.adspowerReconcileEnabled) {
    reconcileSvc.startScheduler();
  }

  // Google Sheets services (only if credentials are configured)
  let importService:     SheetImportService  | undefined;
  let syncService:       SheetSyncService    | undefined;
  let channelMatchSvc:   ChannelMatchService | undefined;
  let dieWritebackSvc:   DieWritebackService | undefined;
  let pollSvc:           SheetPollService    | undefined;

  const credPath = process.env.ACCOUNT_HUB_GOOGLE_CREDENTIALS_PATH;
  if (credPath) {
    const sheetsClient = new GoogleSheetsClient(credPath);
    importService = new SheetImportService(
      sheetsClient, accountRepo, sourceRepo, bindingRepo, auditRepo,
    );
    syncService = new SheetSyncService(
      sheetsClient, accountRepo, sourceRepo, bindingRepo, syncJobRepo, auditRepo,
    );
    channelMatchSvc = new ChannelMatchService(
      sheetsClient, sourceRepo, accountRepo, bindingRepo, countryRepo, auditRepo,
    );
    dieWritebackSvc = new DieWritebackService(
      sheetsClient, accountRepo, sourceRepo, bindingRepo, syncJobRepo, auditRepo,
    );
    pollSvc = new SheetPollService({
      sourceRepo, bindingRepo, syncJobRepo, importService,
      auditRepo,
      conflictSvc,
      duplicateSvc,
      notifications: notificationSvc,
      broadcast: broadcastAccountHub,
    });
  }

  // Inbound near-real-time ingest (spec §7.2). The webhook only ever asks this
  // scheduler to run early, so the poller alone is enough for correctness.
  if (pollSvc && accountHubConfig.sheetPollEnabled) {
    pollSvc.start();
  }

  const router = Router();


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
        sheetPollEnabled:           accountHubConfig.sheetPollEnabled,
        webhookEnabled:             accountHubConfig.webhookEnabled,
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
    countryRepo,
    notificationSvc,
    duplicateSvc,
    channelMatchSvc,
    reconcileSvc,
    dieWritebackSvc,
    proxyCheckSvc,
    pollSvc,
  );
  router.use('/', apiRouter);

  const webhookRouter = pollSvc
    ? buildAccountHubWebhookRouter(sourceRepo, pollSvc)
    : null;

  logger.info('[AccountHub] Subsystem ready.');
  return { apiRouter: router, webhookRouter };
}
