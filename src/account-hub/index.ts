/**
 * Account Hub — Entry Point
 *
 * Exports `createAccountHubRouter()` which is the only surface this module
 * exposes to the rest of the application.
 *
 * When ACCOUNT_HUB_ENABLED=false this function returns null and nothing
 * in this subsystem (no DB connection, no scheduler, no Google requests)
 * is initialised.
 */

import { Router, Request, Response } from 'express';
import { accountHubConfig } from './config.js';
import { initDb } from './db/connection.js';
import { runMigrations } from './db/migrations.js';
import { AccountRepository } from './db/repositories/account-repository.js';
import { AuditLogRepository } from './db/repositories/audit-log-repository.js';
import { SyncJobRepository } from './db/repositories/sync-job-repository.js';
import { AccountService } from './services/account-service.js';
import { buildAccountHubApiRouter } from './api/router.js';
import { logger } from '../utils/logger.js';

/**
 * Build and return an Express Router for the Account Hub subsystem.
 * Returns `null` when the master feature flag is disabled.
 */
export function createAccountHubRouter(): Router | null {
  if (!accountHubConfig.enabled) {
    return null;
  }

  logger.info('[AccountHub] Initialising subsystem...');

  // ---- DB setup ----
  const db = initDb();
  runMigrations(db);

  // ---- Dependency wiring ----
  const accountRepo  = new AccountRepository(db);
  const auditRepo    = new AuditLogRepository(db);
  const syncJobRepo  = new SyncJobRepository(db);
  const accountSvc   = new AccountService(accountRepo, auditRepo);

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
      },
    });
  });

  // ---- Mount API sub-router ----
  const apiRouter = buildAccountHubApiRouter(accountSvc, syncJobRepo, auditRepo);
  router.use('/', apiRouter);

  logger.info('[AccountHub] Subsystem ready.');
  return router;
}
