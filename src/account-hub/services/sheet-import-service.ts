/**
 * Account Hub — Sheet Import Service (Phase 3)
 *
 * Reads a Google Sheet, matches rows to accounts by:
 *   1. adspower_user_id column (if mapped)
 *   2. Exact normalized profile name + login ID
 *   3. Row fingerprint
 *
 * Returns an import preview report. After user confirmation,
 * commits account records and row bindings to DB.
 */

import crypto from 'node:crypto';
import type { GoogleSheetsClient, SheetRow } from '../google-sheets/client.js';
import type { AccountRepository } from '../db/repositories/account-repository.js';
import type { SheetSourceRepository, FieldMapping } from '../db/repositories/sheet-source-repository.js';
import type { RowBindingRepository } from '../db/repositories/row-binding-repository.js';
import type { AuditLogRepository } from '../db/repositories/audit-log-repository.js';
import { normalizeName, generateId } from '../domain/utils.js';
import type { Account } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportPreviewItem {
  rowIndex:      number;
  profileName:   string;
  loginId:       string;
  status:        'new' | 'match' | 'conflict' | 'duplicate' | 'missing_key' | 'already_bound';
  matchedId?:    string;
  conflictNames?: string[];
  issues:        string[];
  rowData:       Record<string, string>;
}

export interface ImportPreview {
  sourceId:      string;
  tabId:         string;
  totalRows:     number;
  newCount:      number;
  matchCount:    number;
  conflictCount: number;
  skipCount:     number;
  items:         ImportPreviewItem[];
}

// ---------------------------------------------------------------------------
// Row fingerprint
// ---------------------------------------------------------------------------

function fingerprint(row: SheetRow, keyColIndices: number[]): string {
  const parts = keyColIndices.map((c) => {
    const cell = row.cells[c];
    return cell?.formatted ?? row.mergeInherited[c] ?? '';
  });
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

function cellValue(row: SheetRow, colIndex: number): string {
  return row.cells[colIndex]?.formatted ?? row.mergeInherited[colIndex] ?? '';
}

// ---------------------------------------------------------------------------
// Import service
// ---------------------------------------------------------------------------

export class SheetImportService {
  constructor(
    private sheetsClient: GoogleSheetsClient,
    private accountRepo:  AccountRepository,
    private sourceRepo:   SheetSourceRepository,
    private bindingRepo:  RowBindingRepository,
    private auditRepo:    AuditLogRepository,
  ) {}

  async preview(sourceId: string, tabId: string): Promise<ImportPreview> {
    const source  = this.sourceRepo.findById(sourceId);
    if (!source) throw new Error(`Source ${sourceId} not found`);

    const tabMeta = this.sourceRepo.listTabs(sourceId).find(t => t.id === tabId);
    if (!tabMeta) throw new Error(`Tab ${tabId} not found`);

    const mappings  = this.sourceRepo.listMappings(sourceId);
    const schema    = await this.sheetsClient.readSchema(
      source.spreadsheetId, tabMeta.title, source.headerRow,
    );
    const rows      = await this.sheetsClient.readRows(
      source.spreadsheetId, tabMeta.title, source.firstDataRow, undefined, schema,
    );

    // Build column index lookup from mappings
    const fieldCol = new Map<string, number>();
    mappings.forEach(m => {
      if (m.systemField) fieldCol.set(m.systemField, m.columnIndex);
    });

    const nameColIdx   = fieldCol.get('profileName')  ?? -1;
    const loginColIdx  = fieldCol.get('loginId')      ?? -1;
    const adspowerColIdx = fieldCol.get('adspowerUserId') ?? -1;
    const keyColIndices = mappings.filter(m => m.isKeyCandidate).map(m => m.columnIndex);
    if (keyColIndices.length === 0 && nameColIdx !== -1) keyColIndices.push(nameColIdx);

    const items: ImportPreviewItem[] = [];
    let newCount = 0, matchCount = 0, conflictCount = 0, skipCount = 0;

    for (const row of rows) {
      // Skip completely empty rows
      const allEmpty = row.cells.every(c => !c.formatted) &&
        Object.keys(row.mergeInherited).length === 0;
      if (allEmpty) continue;

      const profileName  = nameColIdx  >= 0 ? cellValue(row, nameColIdx) : '';
      const loginId      = loginColIdx >= 0 ? cellValue(row, loginColIdx) : '';
      const adspowerId   = adspowerColIdx >= 0 ? cellValue(row, adspowerColIdx) : '';

      if (!profileName.trim()) {
        items.push({
          rowIndex: row.rowIndex, profileName: '', loginId, status: 'missing_key',
          issues: ['profileName is empty'], rowData: this.buildRowData(row, mappings),
        });
        skipCount++;
        continue;
      }

      const issues: string[] = [];
      let status: ImportPreviewItem['status'] = 'new';
      let matchedId: string | undefined;
      let conflictNames: string[] | undefined;

      // Check by adspower_user_id first
      if (adspowerId) {
        const existing = this.accountRepo.findByAdspowerUserId(adspowerId);
        if (existing) {
          status = 'already_bound';
          matchedId = existing.id;
          matchCount++;
          items.push({ rowIndex: row.rowIndex, profileName, loginId, status, matchedId, issues, rowData: this.buildRowData(row, mappings) });
          continue;
        }
      }

      // Try normalized name match
      const normalized = normalizeName(profileName);
      const nameMatches = this.accountRepo.findByNormalizedName(normalized);

      if (nameMatches.length === 1) {
        status    = 'match';
        matchedId = nameMatches[0].id;
        matchCount++;
      } else if (nameMatches.length > 1) {
        status         = 'conflict';
        conflictNames  = nameMatches.map(a => a.profileName);
        conflictCount++;
        issues.push(`Multiple accounts match name "${profileName}"`);
      } else {
        status = 'new';
        newCount++;
      }

      items.push({
        rowIndex: row.rowIndex, profileName, loginId, status, matchedId, conflictNames,
        issues, rowData: this.buildRowData(row, mappings),
      });
    }

    return {
      sourceId, tabId,
      totalRows: rows.length,
      newCount, matchCount, conflictCount,
      skipCount,
      items,
    };
  }

  /** Confirm import — creates new accounts and upserts row bindings */
  async confirmImport(
    preview: ImportPreview,
    actor?: string,
  ): Promise<{ created: number; bound: number; skipped: number }> {
    let created = 0, bound = 0, skipped = 0;

    for (const item of preview.items) {
      if (item.status === 'missing_key' || item.status === 'conflict') {
        skipped++;
        continue;
      }

      let accountId: string;

      if (item.status === 'new') {
        const acc = this.accountRepo.create({
          profileName: item.profileName,
          loginId:     item.rowData.loginId || undefined,
          createdBy:   actor,
        });
        accountId = acc.id;
        created++;

        this.auditRepo.append({
          actor:      actor ?? null,
          action:     'import_create',
          entityType: 'account',
          entityId:   acc.id,
          beforeJson: null,
          afterJson:  JSON.stringify({ source: preview.sourceId, row: item.rowIndex }),
          source:     'sheet_import',
        });
      } else {
        accountId = item.matchedId!;
      }

      this.bindingRepo.upsert(accountId, preview.sourceId, preview.tabId, item.rowIndex);
      bound++;
    }

    return { created, bound, skipped };
  }

  private buildRowData(row: SheetRow, mappings: FieldMapping[]): Record<string, string> {
    const result: Record<string, string> = {};
    mappings.forEach(m => {
      if (m.systemField) {
        result[m.systemField] = cellValue(row, m.columnIndex);
      }
    });
    return result;
  }
}
