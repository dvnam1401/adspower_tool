/**
 * Account Hub — DIE colour write-back service (spec §4, decision #3)
 *
 * Reads/writes the DIE red colour ONLY at the exact region a source declares
 * (cell_range → die_color_columns, e.g. BC "F:G"; full_row → the whole TK row).
 * Before painting it captures the ORIGINAL cell colours into the account's
 * `color_backup_json`; when an account leaves DIE the original colours are
 * restored from that backup (undo may be a no-fill, never forced white).
 *
 * It never touches any formatting other than backgroundColor, never paints a
 * source that has no DIE mode (so Reup is never written), and is idempotent:
 * an account already painted (backup present) is not repainted, and an account
 * with no backup is not restored.
 *
 * `preview()` reports the intended actions without writing; `apply()` performs
 * them behind a sync job with per-row audit + dry-run support.
 */

import type { GoogleSheetsClient } from '../google-sheets/client.js';
import type { AccountRepository } from '../db/repositories/account-repository.js';
import type { SheetSourceRepository, SheetSource, SheetTab } from '../db/repositories/sheet-source-repository.js';
import type { RowBindingRepository, RowBinding } from '../db/repositories/row-binding-repository.js';
import type { SyncJobRepository } from '../db/repositories/sync-job-repository.js';
import type { AuditLogRepository } from '../db/repositories/audit-log-repository.js';
import type { Account, DieReadMode } from '../domain/types.js';
import { computeDieWriteRegion, resolveDieWriteColor, type RgbColor } from '../domain/die-color.js';
import { accountHubConfig } from '../config.js';
import { logger } from '../../utils/logger.js';

type Action = 'paint' | 'restore' | 'skip';

export interface DieWritebackPreviewItem {
  accountId:   string;
  profileName: string;
  sourceId:    string;
  tabTitle:    string;
  rowIndex:    number; // 0-based
  colStart:    number;
  colEnd:      number;
  action:      Action;
  reason?:     string;
}

export interface DieWritebackPreview {
  items:     DieWritebackPreviewItem[];
  toPaint:   number;
  toRestore: number;
  skipped:   number;
}

export interface DieWritebackResult {
  jobId:    string;
  painted:  number;
  restored: number;
  failed:   number;
  dryRun:   boolean;
}

/** Backup snapshot persisted in accounts.color_backup_json. */
interface ColorBackup {
  sheetId:  number;
  rowIndex: number;
  colStart: number;
  colors:   Array<RgbColor | null>;
}

interface Target {
  account:  Account;
  source:   SheetSource;
  tab:      SheetTab;
  rowIndex: number;
  colStart: number;
  colEnd:   number;
  action:   Action;
  reason?:  string;
}

function isDieSource(s: SheetSource): boolean {
  const mode = (s.dieReadMode ?? 'none') as DieReadMode;
  return mode !== 'none' && s.syncDirection !== 'inbound';
}

export class DieWritebackService {
  constructor(
    private sheetsClient: GoogleSheetsClient,
    private accountRepo:  AccountRepository,
    private sourceRepo:   SheetSourceRepository,
    private bindingRepo:  RowBindingRepository,
    private syncJobRepo:  SyncJobRepository,
    private auditRepo:    AuditLogRepository,
  ) {}

  // -------------------------------------------------------------------------
  // Target resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve the set of (account, bound row) pairs and the action each needs.
   * When `accountIds` is empty, sweeps every row bound to a DIE-mode source.
   * `full_row` width is read once per (source, tab) from the sheet schema.
   */
  private async resolveTargets(accountIds: string[]): Promise<Target[]> {
    const dieSources = this.sourceRepo.list().filter(isDieSource);
    const bySourceId = new Map(dieSources.map((s) => [s.id, s]));

    // Gather candidate bindings limited to DIE sources.
    let bindings: RowBinding[];
    if (accountIds.length) {
      bindings = accountIds
        .flatMap((id) => this.bindingRepo.findByAccount(id))
        .filter((b) => bySourceId.has(b.sourceId));
    } else {
      bindings = dieSources.flatMap((s) => this.bindingRepo.listBySource(s.id));
    }

    const widthCache = new Map<string, number>(); // key: sourceId|tabId
    const tabCache   = new Map<string, SheetTab[]>();
    const targets: Target[] = [];

    for (const binding of bindings) {
      const source = bySourceId.get(binding.sourceId);
      if (!source) continue;

      const account = this.accountRepo.findById(binding.accountId);
      if (!account || account.archivedAt) continue;

      let tabs = tabCache.get(source.id);
      if (!tabs) { tabs = this.sourceRepo.listTabs(source.id); tabCache.set(source.id, tabs); }
      const tab = binding.tabId
        ? tabs.find((t) => t.id === binding.tabId)
        : tabs[0];
      if (!tab) continue;

      const mode = (source.dieReadMode ?? 'none') as DieReadMode;

      let rowWidth = 0;
      if (mode === 'full_row') {
        const wKey = `${source.id}|${tab.id}`;
        let w = widthCache.get(wKey);
        if (w === undefined) {
          try {
            const schema = await this.sheetsClient.readSchema(
              source.spreadsheetId, tab.title, source.headerRow,
            );
            w = schema.headers.length;
          } catch (err) {
            logger.warn(`[AccountHub][DieWriteback] schema read failed for ${source.id}/${tab.title}: ${err}`);
            w = 0;
          }
          widthCache.set(wKey, w);
        }
        rowWidth = w;
      }

      const { colStart, colEnd } = computeDieWriteRegion(mode, source.dieColorColumns, rowWidth);
      if (colEnd <= colStart) continue; // nothing to write for this source

      const desiredDie = account.accountStatus === 'DIE';
      const hasBackup  = !!account.colorBackupJson;
      let action: Action;
      let reason: string | undefined;
      if (desiredDie && !hasBackup) { action = 'paint'; }
      else if (!desiredDie && hasBackup) { action = 'restore'; }
      else { action = 'skip'; reason = desiredDie ? 'already painted' : 'not DIE, no backup'; }

      targets.push({
        account, source, tab,
        rowIndex: binding.rowIndex,
        colStart, colEnd, action, reason,
      });
    }

    return targets;
  }

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  async preview(accountIds: string[] = []): Promise<DieWritebackPreview> {
    const targets = await this.resolveTargets(accountIds);
    const items: DieWritebackPreviewItem[] = targets.map((t) => ({
      accountId:   t.account.id,
      profileName: t.account.profileName,
      sourceId:    t.source.id,
      tabTitle:    t.tab.title,
      rowIndex:    t.rowIndex,
      colStart:    t.colStart,
      colEnd:      t.colEnd,
      action:      t.action,
      reason:      t.reason,
    }));
    return {
      items,
      toPaint:   items.filter((i) => i.action === 'paint').length,
      toRestore: items.filter((i) => i.action === 'restore').length,
      skipped:   items.filter((i) => i.action === 'skip').length,
    };
  }

  // -------------------------------------------------------------------------
  // Apply
  // -------------------------------------------------------------------------

  async apply(
    accountIds: string[] = [],
    opts: { dryRun?: boolean; createdBy?: string } = {},
  ): Promise<DieWritebackResult> {
    const dryRun = opts.dryRun ?? accountHubConfig.dryRun;
    const job = this.syncJobRepo.create('die_writeback', { dryRun, createdBy: opts.createdBy });

    const targets = (await this.resolveTargets(accountIds)).filter((t) => t.action !== 'skip');
    this.syncJobRepo.setTotalItems(job.id, targets.length);

    let painted = 0, restored = 0, failed = 0;

    for (const t of targets) {
      const itemId = this.syncJobRepo.createItem(job.id, {
        accountId: t.account.id,
        sourceId:  t.source.id,
        rowIndex:  t.rowIndex,
      });
      try {
        if (t.action === 'paint') {
          await this.paint(t, dryRun);
          painted++;
        } else {
          await this.restore(t, dryRun);
          restored++;
        }
        this.syncJobRepo.updateItemStatus(itemId, 'done');
        this.syncJobRepo.incrementDone(job.id);
      } catch (err) {
        failed++;
        this.syncJobRepo.updateItemStatus(itemId, 'failed', { error: String(err) });
        this.syncJobRepo.incrementFailed(job.id);
        logger.error(`[AccountHub][DieWriteback] ${t.action} failed for ${t.account.id}: ${err}`);
      }
    }

    const finalStatus = failed === 0 ? 'done' : painted + restored > 0 ? 'partial' : 'failed';
    this.syncJobRepo.updateStatus(job.id, finalStatus, { finishedAt: new Date().toISOString() });

    return { jobId: job.id, painted, restored, failed, dryRun };
  }

  private async paint(t: Target, dryRun: boolean): Promise<void> {
    const before = await this.sheetsClient.readRowBackground(
      t.source.spreadsheetId, t.tab.title, t.rowIndex, t.colStart, t.colEnd,
    );
    const color = resolveDieWriteColor(t.source.dieWriteColor);

    await this.sheetsClient.paintRowBackground(
      t.source.spreadsheetId, t.tab.sheetId, t.rowIndex, t.colStart, t.colEnd, color, dryRun,
    );

    if (!dryRun) {
      const backup: ColorBackup = {
        sheetId: t.tab.sheetId,
        rowIndex: t.rowIndex,
        colStart: t.colStart,
        colors: before,
      };
      this.accountRepo.setColorBackup(t.account.id, JSON.stringify(backup));
    }

    this.auditRepo.append({
      actor:      null,
      action:     'die_paint',
      entityType: 'account',
      entityId:   t.account.id,
      beforeJson: JSON.stringify({ colors: before }),
      afterJson:  JSON.stringify({ sourceId: t.source.id, rowIndex: t.rowIndex, region: [t.colStart, t.colEnd], color, dryRun }),
      source:     'die_writeback',
    });
  }

  private async restore(t: Target, dryRun: boolean): Promise<void> {
    const backup = JSON.parse(t.account.colorBackupJson as string) as ColorBackup;

    await this.sheetsClient.restoreRowBackground(
      t.source.spreadsheetId, backup.sheetId, backup.rowIndex, backup.colStart, backup.colors, dryRun,
    );

    if (!dryRun) {
      this.accountRepo.setColorBackup(t.account.id, null);
    }

    this.auditRepo.append({
      actor:      null,
      action:     'die_restore',
      entityType: 'account',
      entityId:   t.account.id,
      beforeJson: t.account.colorBackupJson ?? null,
      afterJson:  JSON.stringify({ sourceId: t.source.id, rowIndex: backup.rowIndex, dryRun }),
      source:     'die_writeback',
    });
  }
}
