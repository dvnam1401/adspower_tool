/**
 * Account Hub — Google Sheets Client (Phase 3)
 *
 * Wraps googleapis Sheets v4.
 * Credentials loaded from ACCOUNT_HUB_GOOGLE_CREDENTIALS_PATH (service account JSON).
 * Never commits or logs the private key.
 */

import { google, sheets_v4 } from 'googleapis';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../utils/logger.js';
import { toRgb, type RgbColor } from '../domain/die-color.js';
import {
  RateLimiter,
  withBackoff,
  isRetryableSheetsError,
  systemClock,
  type Clock,
} from './gateway.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CellValue {
  formatted: string;
  formula?: string;
}

export interface MergeRegion {
  startRowIndex: number;
  endRowIndex:   number;
  startColIndex: number;
  endColIndex:   number;
}

export interface SheetRow {
  rowIndex: number; // 0-based
  cells:    CellValue[];
  /** Inherited values from a merge (key = col index) */
  mergeInherited: Record<number, string>;
}

export interface SheetSchema {
  spreadsheetId: string;
  tabTitle:      string;
  sheetId:       number;
  headers:       string[];        // row at headerRow
  merges:        MergeRegion[];
  totalRows:     number;
}

export interface WriteRequest {
  range: string;  // A1 notation e.g. "Sheet1!B5"
  value: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Default per-spreadsheet pacing. Sheets quota is per-user-per-project; a
 *  per-spreadsheet bucket (spec §"Sheets Gateway") keeps any single sheet's
 *  bursts well under quota while staying responsive. Overridable for tuning/tests. */
const DEFAULT_RATE_PER_SEC = 2;
const DEFAULT_BURST = 8;

export interface SheetsClientDeps {
  /** Injected transport for offline tests; falls back to lazy real init. */
  sheetsApi?: sheets_v4.Sheets;
  limiter?: RateLimiter;
  clock?: Clock;
}

export class GoogleSheetsClient {
  private sheets: sheets_v4.Sheets | null = null;
  private credPath: string;
  private readonly limiter: RateLimiter;
  private readonly clock: Clock;

  constructor(credPath: string, deps: SheetsClientDeps = {}) {
    this.credPath = credPath;
    this.clock = deps.clock ?? systemClock;
    this.limiter =
      deps.limiter ??
      new RateLimiter({ ratePerSec: DEFAULT_RATE_PER_SEC, burst: DEFAULT_BURST, clock: this.clock });
    if (deps.sheetsApi) this.sheets = deps.sheetsApi;
  }

  private async getSheets(): Promise<sheets_v4.Sheets> {
    if (this.sheets) return this.sheets;

    const resolved = path.resolve(this.credPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(
        `[AccountHub] Google credentials file not found at: ${resolved}. ` +
        `Set ACCOUNT_HUB_GOOGLE_CREDENTIALS_PATH in your .env.`,
      );
    }

    const keyFile = JSON.parse(fs.readFileSync(resolved, 'utf-8')) as {
      client_email: string;
      private_key:  string;
    };

    const auth = new google.auth.JWT({
      email: keyFile.client_email,
      key:   keyFile.private_key,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive.readonly',
      ],
    });

    this.sheets = google.sheets({ version: 'v4', auth });
    logger.info('[AccountHub] Google Sheets client initialised.');
    return this.sheets;
  }

  /**
   * Rate-limit (per spreadsheet) then run an API call under transient-error
   * backoff. All Sheets I/O in this client routes through here so quota
   * pacing and 429/5xx recovery are uniform and un-bypassable.
   */
  private async call<T>(spreadsheetId: string, fn: () => Promise<T>): Promise<T> {
    await this.limiter.acquire(spreadsheetId);
    return withBackoff(fn, { clock: this.clock, isRetryable: isRetryableSheetsError });
  }

  // ---- Schema ----

  async readSchema(spreadsheetId: string, tabTitle: string, headerRow = 1): Promise<SheetSchema> {
    const api = await this.getSheets();

    const meta = await this.call(spreadsheetId, () => api.spreadsheets.get({ spreadsheetId }));
    const sheet = meta.data.sheets?.find(
      (s) => s.properties?.title === tabTitle,
    );
    if (!sheet) throw new Error(`Tab "${tabTitle}" not found in spreadsheet ${spreadsheetId}`);

    const sheetId   = sheet.properties?.sheetId ?? 0;
    const merges    = (sheet.merges ?? []).map((m) => ({
      startRowIndex: m.startRowIndex ?? 0,
      endRowIndex:   m.endRowIndex   ?? 0,
      startColIndex: m.startColumnIndex ?? 0,
      endColIndex:   m.endColumnIndex   ?? 0,
    }));

    // Read header row
    const headerRange = `${tabTitle}!${headerRow}:${headerRow}`;
    const headerRes   = await this.call(spreadsheetId, () =>
      api.spreadsheets.values.get({ spreadsheetId, range: headerRange }),
    );
    const headers = (headerRes.data.values?.[0] ?? []).map(String);
    const totalRows = sheet.properties?.gridProperties?.rowCount ?? 0;

    return { spreadsheetId, tabTitle, sheetId, headers, merges, totalRows };
  }

  // ---- Read rows ----

  async readRows(
    spreadsheetId: string,
    tabTitle: string,
    firstDataRow: number,
    lastRow?: number,
    schema?: SheetSchema,
  ): Promise<SheetRow[]> {
    const api    = await this.getSheets();
    const range  = lastRow
      ? `${tabTitle}!${firstDataRow}:${lastRow}`
      : `${tabTitle}!${firstDataRow}:10000`;

    // Get values AND formulas simultaneously
    const [valRes, fmtRes] = await Promise.all([
      this.call(spreadsheetId, () =>
        api.spreadsheets.values.get({ spreadsheetId, range, valueRenderOption: 'FORMATTED_VALUE' }),
      ),
      this.call(spreadsheetId, () =>
        api.spreadsheets.values.get({ spreadsheetId, range, valueRenderOption: 'FORMULA' }),
      ),
    ]);

    const values   = valRes.data.values  ?? [];
    const formulas = fmtRes.data.values  ?? [];
    const merges   = schema?.merges ?? [];

    // Build a map of merge top-left values for inheritance
    // Each merge region: rows [startRow..endRow), cols [startCol..endCol)
    // The top-left cell (0-based relative to sheet) holds the value.
    // For data rows (1-based, starting at firstDataRow), we convert indices.

    const mergeTopLeft: Map<string, string> = new Map();

    const rows: SheetRow[] = values.map((rowCells, rowRelIdx) => {
      const rowSheetIdx = firstDataRow - 1 + rowRelIdx; // 0-based sheet row
      const fmtRow      = formulas[rowRelIdx] ?? [];

      const cells: CellValue[] = rowCells.map((cell, colIdx) => ({
        formatted: String(cell ?? ''),
        formula:   typeof fmtRow[colIdx] === 'string' && String(fmtRow[colIdx]).startsWith('=')
          ? String(fmtRow[colIdx])
          : undefined,
      }));

      // Record top-left values of merges that start at this row
      merges.forEach((m) => {
        if (m.startRowIndex === rowSheetIdx) {
          const key = `${m.startRowIndex}:${m.startColIndex}`;
          mergeTopLeft.set(key, cells[m.startColIndex]?.formatted ?? '');
        }
      });

      // Inherit merge values for cells that are not top-left
      const mergeInherited: Record<number, string> = {};
      merges.forEach((m) => {
        if (
          rowSheetIdx > m.startRowIndex &&
          rowSheetIdx < m.endRowIndex
        ) {
          for (let c = m.startColIndex; c < m.endColIndex; c++) {
            const key = `${m.startRowIndex}:${m.startColIndex}`;
            mergeInherited[c] = mergeTopLeft.get(key) ?? '';
          }
        }
      });

      return { rowIndex: rowRelIdx + firstDataRow - 1, cells, mergeInherited };
    });

    return rows;
  }

  // ---- Read cell background colours (DIE detection, spec §4) ----

  /**
   * Read the effective background colour of each cell in the data range.
   * Returns one entry per row (aligned to readRows by rowIndex); `colors[c]`
   * is null when the cell has no explicit fill.
   */
  async readRowColors(
    spreadsheetId: string,
    tabTitle: string,
    firstDataRow: number,
    lastRow?: number,
  ): Promise<Array<{ rowIndex: number; colors: Array<RgbColor | null> }>> {
    const api   = await this.getSheets();
    const range = lastRow
      ? `${tabTitle}!${firstDataRow}:${lastRow}`
      : `${tabTitle}!${firstDataRow}:10000`;

    const res = await this.call(spreadsheetId, () =>
      api.spreadsheets.get({
        spreadsheetId,
        ranges: [range],
        includeGridData: true,
        fields: 'sheets(data(rowData(values(effectiveFormat(backgroundColor)))))',
      }),
    );

    const rowData = res.data.sheets?.[0]?.data?.[0]?.rowData ?? [];
    return rowData.map((rd, i) => ({
      rowIndex: firstDataRow - 1 + i,
      colors: (rd.values ?? []).map((v) => toRgb(v.effectiveFormat?.backgroundColor)),
    }));
  }

  // ---- Batch write ----

  async batchWrite(
    spreadsheetId: string,
    requests: WriteRequest[],
    dryRun: boolean,
  ): Promise<{ written: number; dryRun: boolean }> {
    if (dryRun) {
      logger.info(`[AccountHub][DryRun] Would write ${requests.length} cells to ${spreadsheetId}`);
      return { written: 0, dryRun: true };
    }

    const api = await this.getSheets();
    const data = requests.map((r) => ({
      range:          r.range,
      majorDimension: 'ROWS' as const,
      values:         [[r.value]],
    }));

    await this.call(spreadsheetId, () =>
      api.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data,
        },
      }),
    );

    logger.info(`[AccountHub] Wrote ${requests.length} cells to ${spreadsheetId}`);
    return { written: requests.length, dryRun: false };
  }

  // ---- Read-back verify ----

  async readCell(spreadsheetId: string, range: string): Promise<string> {
    const api = await this.getSheets();
    const res = await this.call(spreadsheetId, () =>
      api.spreadsheets.values.get({ spreadsheetId, range }),
    );
    return String(res.data.values?.[0]?.[0] ?? '');
  }


  // ---- DIE colour write-back (spec §4) ----

  /**
   * Read the background colours of one row's [colStart, colEnd) region.
   * `rowIndex` is 0-based. Returns one entry per column; null = no fill.
   * Used to capture the pre-DIE colour backup before painting (spec §4 undo).
   */
  async readRowBackground(
    spreadsheetId: string,
    tabTitle: string,
    rowIndex: number,
    colStart: number,
    colEnd: number,
  ): Promise<Array<RgbColor | null>> {
    const rows = await this.readRowColors(spreadsheetId, tabTitle, rowIndex + 1, rowIndex + 1);
    const colors = rows[0]?.colors ?? [];
    const out: Array<RgbColor | null> = [];
    for (let c = colStart; c < colEnd; c++) out.push(colors[c] ?? null);
    return out;
  }

  /**
   * Paint a single background colour across a row's [colStart, colEnd) region.
   * Touches ONLY backgroundColor (spec §0.3: never alter other formatting).
   */
  async paintRowBackground(
    spreadsheetId: string,
    sheetId: number,
    rowIndex: number,
    colStart: number,
    colEnd: number,
    color: RgbColor,
    dryRun: boolean,
  ): Promise<void> {
    if (dryRun || colEnd <= colStart) return;
    const api = await this.getSheets();
    const requests: sheets_v4.Schema$Request[] = [
      {
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: rowIndex,
            endRowIndex: rowIndex + 1,
            startColumnIndex: colStart,
            endColumnIndex: colEnd,
          },
          cell: { userEnteredFormat: { backgroundColor: { ...color, alpha: 1 } } },
          fields: 'userEnteredFormat.backgroundColor',
        },
      },
    ];
    await this.call(spreadsheetId, () =>
      api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }),
    );
  }

  /**
   * Restore per-cell background colours over a row's region, starting at
   * colStart. A null entry clears the cell's fill (spec §4: undo restores the
   * ORIGINAL colour, which may be no-fill — not forced white). Touches ONLY
   * backgroundColor.
   */
  async restoreRowBackground(
    spreadsheetId: string,
    sheetId: number,
    rowIndex: number,
    colStart: number,
    colors: Array<RgbColor | null>,
    dryRun: boolean,
  ): Promise<void> {
    if (dryRun || colors.length === 0) return;
    const api = await this.getSheets();
    const values: sheets_v4.Schema$CellData[] = colors.map((c) =>
      c
        ? { userEnteredFormat: { backgroundColor: { ...c, alpha: 1 } } }
        : { userEnteredFormat: {} },
    );
    const requests: sheets_v4.Schema$Request[] = [
      {
        updateCells: {
          range: {
            sheetId,
            startRowIndex: rowIndex,
            endRowIndex: rowIndex + 1,
            startColumnIndex: colStart,
            endColumnIndex: colStart + colors.length,
          },
          rows: [{ values }],
          fields: 'userEnteredFormat.backgroundColor',
        },
      },
    ];
    await this.call(spreadsheetId, () =>
      api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }),
    );
  }

  // ---- List all tabs ----

  async listTabs(spreadsheetId: string): Promise<Array<{ sheetId: number; title: string }>> {
    const api  = await this.getSheets();
    const meta = await this.call(spreadsheetId, () => api.spreadsheets.get({ spreadsheetId }));
    return (meta.data.sheets ?? []).map((s) => ({
      sheetId: s.properties?.sheetId ?? 0,
      title:   s.properties?.title ?? '',
    }));
  }
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

let _client: GoogleSheetsClient | null = null;

export function getSheetsClient(): GoogleSheetsClient {
  const credPath = process.env.ACCOUNT_HUB_GOOGLE_CREDENTIALS_PATH;
  if (!credPath) {
    throw new Error(
      '[AccountHub] ACCOUNT_HUB_GOOGLE_CREDENTIALS_PATH is not set. ' +
      'Configure the path to your service account JSON file.',
    );
  }
  if (!_client) _client = new GoogleSheetsClient(credPath);
  return _client;
}
