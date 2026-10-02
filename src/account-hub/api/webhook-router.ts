/**
 * Account Hub — Public webhook router (spec §7.1)
 *
 * Mounted OUTSIDE the dashboard's `authMiddleware` because Google Apps Script
 * has no session token; HMAC (see `webhook-auth.ts`) is the only credential.
 * The router is therefore deliberately tiny: it authenticates, resolves the
 * spreadsheet to a configured inbound source, and asks the poller to run that
 * source now. It never trusts row contents from the request body — the poller
 * still re-reads the sheet through the Sheets API.
 *
 * Disabled by default (`ACCOUNT_HUB_WEBHOOK_ENABLED`); when disabled the route
 * answers 404 so the endpoint's existence is not advertised.
 */

import { Router, type Request, type Response } from 'express';
import express from 'express';
import { accountHubConfig } from '../config.js';
import { WebhookVerifier } from './webhook-auth.js';
import { isInboundSource, type SheetPollService } from '../services/sheet-poll-service.js';
import type { SheetSourceRepository } from '../db/repositories/sheet-source-repository.js';
import { logger } from '../../utils/logger.js';

export function buildAccountHubWebhookRouter(
  sourceRepo: SheetSourceRepository,
  pollSvc: SheetPollService,
): Router {
  const router = Router();
  const verifier = new WebhookVerifier(
    accountHubConfig.webhookSecret,
    accountHubConfig.webhookMaxSkewSec,
  );

  // Raw body — HMAC must cover the exact bytes Apps Script signed.
  router.post(
    '/sheets',
    express.raw({ type: () => true, limit: '64kb' }),
    (req: Request, res: Response) => {
      if (!accountHubConfig.webhookEnabled) return res.status(404).end();

      const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      const verdict = verifier.verify(rawBody, {
        timestamp: req.headers['x-ah-timestamp'],
        signature: req.headers['x-ah-signature'],
      });

      if (verdict !== 'ok') {
        // Log the verdict only — never the body, headers or secret.
        logger.warn(`[AccountHub][Webhook] rejected: ${verdict}`);
        const status = verdict === 'no_secret' ? 503 : 401;
        return res.status(status).json({ success: false, error: `webhook rejected: ${verdict}` });
      }

      let payload: { spreadsheetId?: string; tabTitle?: string };
      try {
        payload = JSON.parse(rawBody) as { spreadsheetId?: string; tabTitle?: string };
      } catch {
        return res.status(400).json({ success: false, error: 'body must be JSON' });
      }

      const spreadsheetId = payload.spreadsheetId?.trim();
      if (!spreadsheetId) {
        return res.status(400).json({ success: false, error: 'spreadsheetId is required' });
      }

      const source = sourceRepo.list()
        .find(s => s.spreadsheetId === spreadsheetId && isInboundSource(s));

      if (!source) {
        return res.status(404).json({
          success: false,
          error: 'no enabled inbound source is configured for that spreadsheet',
        });
      }

      // Fire and forget: Apps Script must not block on a Sheets round trip.
      void pollSvc.requestPoll(source.id, 'webhook', 'system:webhook');

      return res.status(202).json({
        success: true,
        data: { sourceId: source.id, queued: true },
      });
    },
  );

  return router;
}
