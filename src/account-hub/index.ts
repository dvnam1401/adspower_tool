/**
 * Account Hub — Entry Point
 *
 * Exports `createAccountHubRouter()` which is the only surface this module
 * exposes to the rest of the application.
 *
 * Usage in server/app.ts (the ONLY place this should be imported):
 *
 *   import { createAccountHubRouter } from '../account-hub/index.js';
 *   const accountHubRouter = createAccountHubRouter();
 *   if (accountHubRouter) app.use('/api/account-hub', accountHubRouter);
 *
 * When ACCOUNT_HUB_ENABLED=false this function returns null and nothing
 * in this subsystem (no DB connection, no scheduler, no Google requests)
 * is initialised.
 */

import { Router, Request, Response } from 'express';
import { accountHubConfig } from './config.js';

/**
 * Build and return an Express Router for the Account Hub subsystem.
 *
 * Returns `null` when the master feature flag is disabled so the caller
 * can skip mounting entirely.
 */
export function createAccountHubRouter(): Router | null {
  if (!accountHubConfig.enabled) {
    return null;
  }

  const router = Router();

  /**
   * GET /api/account-hub/health
   *
   * Lightweight liveness probe. Confirms the subsystem is mounted and
   * surfaces the current flag state. No database or external calls.
   */
  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      subsystem: 'account-hub',
      dryRun: accountHubConfig.dryRun,
      flags: {
        sheetSyncEnabled: accountHubConfig.sheetSyncEnabled,
        adspowerReconcileEnabled: accountHubConfig.adspowerReconcileEnabled,
        autoImportEnabled: accountHubConfig.autoImportEnabled,
        autoLoginEnabled: accountHubConfig.autoLoginEnabled,
      },
    });
  });

  return router;
}
