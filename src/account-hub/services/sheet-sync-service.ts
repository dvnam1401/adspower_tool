/**
 * Account Hub — Sheet Sync Service (Phase 4)
 *
 * Writes account data to mapped Google Sheet columns.
 * Implements: read-before-write, hash check, conflict detection,
 * batch update, verify-after-write, retry failed items.
 */

import crypto from 'node:crypto';
import { accountHubConfig } from '../config.js';
import type { GoogleSheetsClient, WriteRequest } from '../google-sheets/client.js';
import type { AccountRepository } from '../db/repositories/account-repository.js';
import type { SheetSourceRepository } from '../db/repositories/sheet-source-repository.js';
import type { RowBindingRepository } from '../db/repositories/row-binding-repository.js';
import type { SyncJobRepository } from '../db/repositories/sync-job-repository.js';
import type { AuditLogRepository } from '../db/repositories/audit-log-repository.js';
import { logger } from '../../utils/logger.js';

function hashValue(v: string): string {
  return crypto.createHash('sha256').update(v).digest('hex').slice(0, 16);
}

/** Column index (0-based) → A1 letter */
function colToLetter(n: number): string {
  let result = '';
  for (let idx = n; idx >= 0; idx = Math.floor(idx / 26) - 1) {
    result = String.fromCharCode(65 + (idx % 26)) + result;
  }
  return result;
}

export interface SyncWriteResult {
  jobId:       string;
  written:     number;
  failed:      number;
  conflicts:   number;
  dryRun:      boolean;
}

export class SheetSyncService {
  constructor(
    private sheetsClient:  GoogleSheetsClient,
    private accountRepo:   AccountRepository,
    private sourceRepo:    SheetSourceRepository,
    private bindingRepo:   RowBindingRepository,
    private syncJobRepo:   SyncJobRepository,
    private auditRepo:     AuditLogRepository,
  ) {}

  /**
   * Sync a list of account IDs to all their bound sheet sources.
   * If accountIds is empty, syncs all accounts with bindings.
   */
  async syncAccounts(
    accountIds: string[],
    opts: { dryRun?: boolean; createdBy?: string } = {},
  ): Promise<SyncWriteResult> {
    const dryRun = opts.dryRun ?? accountHubConfig.dryRun;
    const job    = this.syncJobRepo.create('sheet_outbound', {
      dryRun,
      createdBy: opts.createdBy,
    });

    let written = 0, failed = 0, conflicts = 0;

    const sources = this.sourceRepo.list().filter(s => s.isEnabled && s.syncDirection !== 'inbound');

    for (const source of sources) {
      const mappings = this.sourceRepo.listMappings(source.id)
        .filter(m => m.syncDirection !== 'inbound' && m.systemField);

      if (!mappings.length) continue;

      const accounts = accountIds.length
        ? accountIds.map(id => this.accountRepo.findById(id)).filter(Boolean)
        : [];

      const writeRequests: WriteRequest[] = [];
      const itemIds: string[] = [];

      for (const account of accounts) {
        if (!account) continue;
        const bindings = this.bindingRepo.findByAccount(account.id)
          .filter(b => b.sourceId === source.id);

        for (const binding of bindings) {
          const tabMeta = this.sourceRepo.listTabs(source.id)
            .find(t => t.id === binding.tabId);
          if (!tabMeta) continue;

          // Read-before-write: verify sheet hasn't changed
          for (const mapping of mappings) {
            const range    = `${tabMeta.title}!${mapping.columnLetter}${binding.rowIndex + 1}`;
            const current  = await this.sheetsClient.readCell(source.spreadsheetId, range);
            const curHash  = hashValue(current);

            if (binding.lastReadHash && binding.lastReadHash !== curHash) {
              conflicts++;
              logger.warn(`[AccountHub][Sync] Conflict on ${range}: sheet changed since last read`);
              this.auditRepo.append({
                actor:      opts.createdBy ?? null,
                action:     'sync_conflict',
                entityType: 'account',
                entityId:   account.id,
                beforeJson: JSON.stringify({ range, currentValue: current }),
                afterJson:  null,
                source:     'sheet_sync',
              });
              continue;
            }

            // Get the value to write
            const accAny = account as unknown as Record<string, unknown>;
            const newValue = String(accAny[mapping.systemField!] ?? '');

            if (current === newValue) continue; // No change needed

            const itemId = this.syncJobRepo.createItem(job.id, {
              accountId: account.id,
              sourceId:  source.id,
              rowIndex:  binding.rowIndex,
              beforeJson: JSON.stringify({ range, value: current }),
            });
            itemIds.push(itemId);
            writeRequests.push({ range, value: newValue });
          }
        }
      }

      this.syncJobRepo.setTotalItems(job.id, writeRequests.length);
      // Batch write
      if (writeRequests.length > 0) {
        try {
          const result = await this.sheetsClient.batchWrite(
            source.spreadsheetId, writeRequests, dryRun,
          );
          written += result.written;

          // Verify each write
          for (let i = 0; i < writeRequests.length; i++) {
            const req     = writeRequests[i];
            const itemId  = itemIds[i];
            if (!dryRun) {
              const verified = await this.sheetsClient.readCell(source.spreadsheetId, req.range);
              if (verified !== req.value) {
                this.syncJobRepo.updateItemStatus(itemId, 'failed', { error: 'Verify mismatch' });
                this.syncJobRepo.incrementFailed(job.id);
                failed++;
              } else {
                this.syncJobRepo.updateItemStatus(itemId, 'done', { afterJson: JSON.stringify({ value: verified }) });
                this.syncJobRepo.incrementDone(job.id);
              }
            } else {
              this.syncJobRepo.updateItemStatus(itemId, 'done');
              this.syncJobRepo.incrementDone(job.id);
            }
          }
        } catch (err) {
          failed += writeRequests.length;
          logger.error(`[AccountHub][Sync] Write failed for source ${source.id}: ${err}`);
          itemIds.forEach(id => {
            this.syncJobRepo.updateItemStatus(id, 'failed', { error: String(err) });
            this.syncJobRepo.incrementFailed(job.id);
          });
        }
      }
    }

    const finalStatus = failed === 0 ? 'done' : written > 0 ? 'partial' : 'failed';
    this.syncJobRepo.updateStatus(job.id, finalStatus, { finishedAt: new Date().toISOString() });

    return { jobId: job.id, written, failed, conflicts, dryRun };
  }

  /** Retry failed items of an existing job */
  async retryJob(jobId: string): Promise<SyncWriteResult> {
    const job = this.syncJobRepo.findById(jobId);
    if (!job) throw new Error(`Sync job ${jobId} not found`);
    const failedItems = this.syncJobRepo.getFailedItems(jobId);
    if (!failedItems.length) return { jobId, written: 0, failed: 0, conflicts: 0, dryRun: job.dryRun };

    const accountIds = [...new Set(failedItems.map(i => i.account_id).filter(Boolean) as string[])];
    return this.syncAccounts(accountIds, { dryRun: job.dryRun });
  }
}
