/**
 * Account Hub — API Router (Phase 1)
 *
 * All routes under /api/account-hub
 * Auth is enforced by the parent middleware in server/app.ts.
 * This router adds its own validation and audit trail.
 */

import { Router, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../../auth/middleware.js';
import { AccountService } from '../services/account-service.js';
import { AccountRepository } from '../db/repositories/account-repository.js';
import { AuditLogRepository } from '../db/repositories/audit-log-repository.js';
import { SyncJobRepository } from '../db/repositories/sync-job-repository.js';
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
// Factory — receives pre-built service instances
// ---------------------------------------------------------------------------

export function buildAccountHubApiRouter(
  accountService: AccountService,
  syncJobRepo: SyncJobRepository,
  auditRepo: AuditLogRepository,
  broadcast?: (event: string, data: unknown) => void,
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
