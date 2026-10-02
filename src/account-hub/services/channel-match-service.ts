/**
 * Account Hub — Channel Match Service (spec §0.4, §4)
 *
 * Matches BC rows against the Reup source per country and copies the Reup channel
 * link into the warehouse account's `channelLink` ("Link kênh kết nối").
 *
 *   found (1)  → MATCHED, link copied to the bound account
 *   found (0)  → PENDING  (goes on the "needs handling" list — never blocks)
 *   found (>1) → AMBIGUOUS (never blocks)
 *
 * Fully config-driven (decision #2 — no hard-coded tab/column names):
 *   - Reup tabs per country come from `country_tab_mappings` on the Reup source.
 *   - Reup channel-name / link columns come from that source's field mappings
 *     (systemField 'channelName' + 'channelLink'|'youtubeChannelUrl', or the
 *     key-candidate column as a fallback name key).
 *   - BC country / channel columns come from the BC source's field mappings
 *     (systemField 'country' + 'channelName').
 *
 * This is a warehouse-side operation: it writes channel_match_status + channelLink
 * to bound accounts but NEVER writes back to any Google Sheet.
 */

import type { GoogleSheetsClient } from '../google-sheets/client.js';
import type { AccountRepository } from '../db/repositories/account-repository.js';
import type {
  SheetSourceRepository,
  FieldMapping,
} from '../db/repositories/sheet-source-repository.js';
import type { RowBindingRepository } from '../db/repositories/row-binding-repository.js';
import type { CountryTabMappingRepository } from '../db/repositories/country-tab-repository.js';
import type { AuditLogRepository } from '../db/repositories/audit-log-repository.js';
import {
  extractChannelKey,
  matchChannel,
  normalizeChannelName,
  type ReupChannel,
  type ChannelMatchOutcome,
} from '../domain/channel-match.js';
import type { ChannelMatchStatus } from '../domain/types.js';

export interface ChannelMatchRowResult {
  country: string;
  bcTabId: string;
  bcRowIndex: number;
  bcKey: string;
  outcome: ChannelMatchOutcome | 'NO_COUNTRY_TAB';
  link: string | null;
  candidates: string[];
  accountId: string | null;
  persisted: boolean;
}

export interface ChannelMatchReport {
  bcSourceId: string;
  reupSourceId: string;
  matched: number;
  pending: number;
  ambiguous: number;
  noCountryTab: number;
  persisted: number;
  results: ChannelMatchRowResult[];
}

const OUTCOME_TO_STATUS: Record<ChannelMatchOutcome, ChannelMatchStatus> = {
  MATCHED: 'MATCHED',
  PENDING: 'PENDING',
  AMBIGUOUS: 'AMBIGUOUS',
};

export class ChannelMatchService {
  constructor(
    private sheetsClient: GoogleSheetsClient,
    private sourceRepo: SheetSourceRepository,
    private accountRepo: AccountRepository,
    private bindingRepo: RowBindingRepository,
    private countryRepo: CountryTabMappingRepository,
    private auditRepo: AuditLogRepository,
  ) {}

  /**
   * Match every BC row against the Reup source and persist channel_match_status
   * (+ channelLink when MATCHED) to the bound warehouse account.
   */
  async matchSource(
    bcSourceId: string,
    reupSourceId: string,
    actor?: string,
  ): Promise<ChannelMatchReport> {
    const bcSource = this.sourceRepo.findById(bcSourceId);
    if (!bcSource) throw new Error(`BC source ${bcSourceId} not found`);
    const reupSource = this.sourceRepo.findById(reupSourceId);
    if (!reupSource) throw new Error(`Reup source ${reupSourceId} not found`);

    // Reup channel index, keyed by normalised country → channels for that tab.
    const reupIndex = await this.buildReupIndex(reupSourceId);

    const bcMappings = this.sourceRepo.listMappings(bcSourceId);
    const bcCol = this.systemFieldColumns(bcMappings);
    const countryColIdx = bcCol.get('country') ?? -1;
    const channelColIdx = bcCol.get('channelName') ?? -1;
    if (countryColIdx < 0 || channelColIdx < 0) {
      throw new Error(
        "BC source must map both a 'country' and a 'channelName' column before channel matching",
      );
    }

    const report: ChannelMatchReport = {
      bcSourceId, reupSourceId,
      matched: 0, pending: 0, ambiguous: 0, noCountryTab: 0, persisted: 0,
      results: [],
    };

    for (const tab of this.sourceRepo.listTabs(bcSourceId)) {
      const schema = await this.sheetsClient.readSchema(
        bcSource.spreadsheetId, tab.title, bcSource.headerRow,
      );
      const rows = await this.sheetsClient.readRows(
        bcSource.spreadsheetId, tab.title, bcSource.firstDataRow, undefined, schema,
      );

      for (const row of rows) {
        const country = cell(row, countryColIdx);
        const rawChannel = cell(row, channelColIdx);
        if (!country.trim() && !rawChannel.trim()) continue; // blank row

        const countryKey = normalizeChannelName(country);
        const reup = reupIndex.get(countryKey);
        const bcKey = extractChannelKey(rawChannel);

        const binding = this.bindingRepo.findBySourceRow(bcSourceId, tab.id, row.rowIndex);
        const accountId = binding?.accountId ?? null;

        let result: ChannelMatchRowResult;
        if (!reup) {
          report.noCountryTab++;
          result = {
            country, bcTabId: tab.id, bcRowIndex: row.rowIndex, bcKey,
            outcome: 'NO_COUNTRY_TAB', link: null, candidates: [], accountId, persisted: false,
          };
        } else {
          const m = matchChannel(bcKey, reup);
          if (m.outcome === 'MATCHED') report.matched++;
          else if (m.outcome === 'AMBIGUOUS') report.ambiguous++;
          else report.pending++;

          const persisted = this.persist(accountId, m.outcome, m.link, actor);
          if (persisted) report.persisted++;
          result = {
            country, bcTabId: tab.id, bcRowIndex: row.rowIndex, bcKey,
            outcome: m.outcome, link: m.link, candidates: m.candidates, accountId, persisted,
          };
        }
        report.results.push(result);
      }
    }

    return report;
  }

  /** Build country(normalised) → Reup channels index from country_tab_mappings. */
  private async buildReupIndex(reupSourceId: string): Promise<Map<string, ReupChannel[]>> {
    const reupSource = this.sourceRepo.findById(reupSourceId)!;
    const mappings = this.sourceRepo.listMappings(reupSourceId);
    const col = this.systemFieldColumns(mappings);

    const nameColIdx =
      col.get('channelName') ??
      mappings.find((m) => m.isKeyCandidate)?.columnIndex ??
      -1;
    const linkColIdx = col.get('channelLink') ?? col.get('youtubeChannelUrl') ?? nameColIdx;
    if (nameColIdx < 0) {
      throw new Error(
        "Reup source must map a 'channelName' (or key-candidate) column before channel matching",
      );
    }

    const index = new Map<string, ReupChannel[]>();
    for (const mapping of this.countryRepo.list(reupSourceId)) {
      const tabTitle = mapping.tabTitle;
      if (!tabTitle) continue;
      const schema = await this.sheetsClient.readSchema(
        reupSource.spreadsheetId, tabTitle, reupSource.headerRow,
      );
      const rows = await this.sheetsClient.readRows(
        reupSource.spreadsheetId, tabTitle, reupSource.firstDataRow, undefined, schema,
      );
      const channels: ReupChannel[] = [];
      for (const row of rows) {
        const nameOrLink = cell(row, nameColIdx);
        const link = linkColIdx >= 0 ? cell(row, linkColIdx) : nameOrLink;
        const key = extractChannelKey(nameOrLink);
        if (key) channels.push({ key, link: link || nameOrLink });
      }
      index.set(normalizeChannelName(mapping.country), channels);
    }
    return index;
  }

  private persist(
    accountId: string | null,
    outcome: ChannelMatchOutcome,
    link: string | null,
    actor?: string,
  ): boolean {
    if (!accountId) return false;
    const acc = this.accountRepo.findById(accountId);
    if (!acc) return false;

    const status = OUTCOME_TO_STATUS[outcome];
    const dto: Parameters<AccountRepository['update']>[1] = {
      channelMatchStatus: status,
      version: acc.version,
      updatedBy: actor ?? 'system:channel-match',
    };
    if (outcome === 'MATCHED' && link) dto.channelLink = link;

    // No-op guard: skip a write when nothing changes.
    if (acc.channelMatchStatus === status && (outcome !== 'MATCHED' || acc.channelLink === link)) {
      return false;
    }

    this.accountRepo.update(accountId, dto);
    this.auditRepo.append({
      actor:      actor ?? null,
      action:     'channel_match',
      entityType: 'account',
      entityId:   accountId,
      beforeJson: JSON.stringify({ channelMatchStatus: acc.channelMatchStatus, channelLink: acc.channelLink }),
      afterJson:  JSON.stringify({ channelMatchStatus: status, channelLink: dto.channelLink ?? acc.channelLink }),
      source:     'channel_match',
    });
    return true;
  }

  private systemFieldColumns(mappings: FieldMapping[]): Map<string, number> {
    const m = new Map<string, number>();
    for (const map of mappings) {
      if (map.systemField) m.set(map.systemField, map.columnIndex);
    }
    return m;
  }
}

function cell(
  row: { cells: Array<{ formatted: string }>; mergeInherited: Record<number, string> },
  colIndex: number,
): string {
  if (colIndex < 0) return '';
  return row.cells[colIndex]?.formatted ?? row.mergeInherited[colIndex] ?? '';
}
