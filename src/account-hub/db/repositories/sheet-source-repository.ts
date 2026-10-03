/**
 * Account Hub — Sheet Source Repository
 *
 * CRUD for sheet_sources, sheet_tabs and field_mappings tables.
 */

import type Database from 'better-sqlite3';
import { generateId } from '../../domain/utils.js';
import { healMappings, type MappingHealReport } from '../../domain/mapping-heal.js';

export interface SheetSource {
  id:               string;
  name:             string;
  spreadsheetId:    string;
  credentialRef:    string | null;
  syncDirection:    string;
  isEnabled:        boolean;
  priority:         number;
  headerRow:        number;
  firstDataRow:     number;
  pollIntervalSec:  number;
  /** How this source encodes DIE via cell background colour (spec §0.3). */
  dieReadMode?:     string;
  /** A1 column spec for cell_range DIE mode, e.g. "F:G". Null for full_row/none. */
  dieColorColumns?: string | null;
  /** Exact red the writer paints for DIE, e.g. "#FF0000" (spec §4 decision #3). Null -> canonical red. */
  dieWriteColor?:   string | null;
  createdAt:        string;
  updatedAt:        string;
}

export interface SheetTab {
  id:        string;
  sourceId:  string;
  sheetId:   number;
  title:     string;
  dataRange: string | null;
  createdAt: string;
}

export interface FieldMapping {
  id:               string;
  sourceId:         string;
  tabId:            string | null;
  systemField:      string | null;
  customFieldId:    string | null;
  columnLetter:     string;
  columnIndex:      number;
  /** Header text this column carried when the mapping was created — used for self-heal. */
  mappedHeader:     string | null;
  syncDirection:    string;
  transformRule:    string | null;
  conflictPolicy:   string;
  isKeyCandidate:   boolean;
  /** Set when the mapped column drifted and could not be auto-healed. */
  needsAttention:   boolean;
  createdAt:        string;
}

function rowToTab(r: Record<string, unknown>): SheetTab {
  return {
    id:        r.id as string,
    sourceId:  r.source_id as string,
    sheetId:   r.sheet_id as number,
    title:     r.title as string,
    dataRange: (r.data_range as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

function rowToMapping(r: Record<string, unknown>): FieldMapping {
  return {
    id:             r.id as string,
    sourceId:       r.source_id as string,
    tabId:          (r.tab_id as string | null) ?? null,
    systemField:    (r.system_field as string | null) ?? null,
    customFieldId:  (r.custom_field_id as string | null) ?? null,
    columnLetter:   r.column_letter as string,
    columnIndex:    r.column_index as number,
    mappedHeader:   (r.mapped_header as string | null) ?? null,
    syncDirection:  r.sync_direction as string,
    transformRule:  (r.transform_rule as string | null) ?? null,
    conflictPolicy: r.conflict_policy as string,
    isKeyCandidate: Boolean(r.is_key_candidate),
    needsAttention: Boolean(r.needs_attention),
    createdAt:      r.created_at as string,
  };
}

function rowToSource(r: Record<string, unknown>): SheetSource {
  return {
    id:              r.id as string,
    name:            r.name as string,
    spreadsheetId:   r.spreadsheet_id as string,
    credentialRef:   r.credential_ref as string | null,
    syncDirection:   r.sync_direction as string,
    isEnabled:       Boolean(r.is_enabled),
    priority:        r.priority as number,
    headerRow:       r.header_row as number,
    firstDataRow:    r.first_data_row as number,
    pollIntervalSec: r.poll_interval_sec as number,
    dieReadMode:     (r.die_read_mode as string | null) ?? 'none',
    dieColorColumns: (r.die_color_columns as string | null) ?? null,
    dieWriteColor:   (r.die_write_color as string | null) ?? null,
    createdAt:       r.created_at as string,
    updatedAt:       r.updated_at as string,
  };
}

export class SheetSourceRepository {
  constructor(private db: Database.Database) {}

  create(data: Omit<SheetSource, 'id' | 'createdAt' | 'updatedAt'>): SheetSource {
    const id  = generateId();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO sheet_sources
        (id, name, spreadsheet_id, credential_ref, sync_direction,
         is_enabled, priority, header_row, first_data_row, poll_interval_sec,
         die_read_mode, die_color_columns, die_write_color,
         created_at, updated_at)
      VALUES
        (@id, @name, @spreadsheetId, @credentialRef, @syncDirection,
         @isEnabled, @priority, @headerRow, @firstDataRow, @pollIntervalSec,
         @dieReadMode, @dieColorColumns, @dieWriteColor,
         @now, @now)
    `).run({
      id, ...data,
      isEnabled: data.isEnabled ? 1 : 0,
      dieReadMode: data.dieReadMode ?? 'none',
      dieColorColumns: data.dieColorColumns ?? null,
      dieWriteColor: data.dieWriteColor ?? null,
      now,
    });
    return this.findById(id)!;
  }

  findById(id: string): SheetSource | null {
    const r = this.db.prepare('SELECT * FROM sheet_sources WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    return r ? rowToSource(r) : null;
  }

  list(): SheetSource[] {
    return (this.db.prepare('SELECT * FROM sheet_sources ORDER BY priority ASC, name ASC').all() as
      Record<string, unknown>[]).map(rowToSource);
  }

  update(id: string, data: Partial<Omit<SheetSource, 'id' | 'createdAt'>>): SheetSource {
    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = @now'];
    const params: Record<string, unknown> = { id, now };
    const col: Record<string, string> = {
      name: 'name', spreadsheetId: 'spreadsheet_id', syncDirection: 'sync_direction',
      isEnabled: 'is_enabled', priority: 'priority', headerRow: 'header_row',
      firstDataRow: 'first_data_row', pollIntervalSec: 'poll_interval_sec',
      dieReadMode: 'die_read_mode', dieColorColumns: 'die_color_columns',
      dieWriteColor: 'die_write_color',
    };
    for (const [k, c] of Object.entries(col)) {
      const v = (data as Record<string, unknown>)[k];
      if (v !== undefined) { sets.push(`${c} = @${k}`); params[k] = v; }
    }
    this.db.prepare(`UPDATE sheet_sources SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return this.findById(id)!;
  }

  // ---- Tabs ----

  upsertTab(sourceId: string, sheetId: number, title: string, dataRange: string | null = null): SheetTab {
    const existing = this.db.prepare(
      'SELECT * FROM sheet_tabs WHERE source_id = ? AND sheet_id = ?',
    ).get(sourceId, sheetId) as Record<string, unknown> | undefined;

    if (existing) {
      // Keep the title/range fresh — a tab may have been renamed on the sheet.
      this.db.prepare(
        'UPDATE sheet_tabs SET title = @title, data_range = COALESCE(@dataRange, data_range) WHERE id = @id',
      ).run({ id: existing.id as string, title, dataRange });
      return rowToTab(
        this.db.prepare('SELECT * FROM sheet_tabs WHERE id = ?').get(existing.id) as Record<string, unknown>,
      );
    }

    const id  = generateId();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO sheet_tabs (id, source_id, sheet_id, title, data_range, created_at)
      VALUES (@id, @sourceId, @sheetId, @title, @dataRange, @now)
    `).run({ id, sourceId, sheetId, title, dataRange, now });
    return rowToTab(this.db.prepare('SELECT * FROM sheet_tabs WHERE id = ?').get(id) as Record<string, unknown>);
  }

  listTabs(sourceId: string): SheetTab[] {
    return (this.db.prepare('SELECT * FROM sheet_tabs WHERE source_id = ?').all(sourceId) as
      Record<string, unknown>[]).map(rowToTab);
  }

  findTabById(id: string): SheetTab | null {
    const r = this.db.prepare('SELECT * FROM sheet_tabs WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    return r ? rowToTab(r) : null;
  }

  // ---- Mappings ----

  listMappings(sourceId: string): FieldMapping[] {
    return (this.db.prepare('SELECT * FROM field_mappings WHERE source_id = ?').all(sourceId) as
      Record<string, unknown>[]).map(rowToMapping);
  }

  findMappingById(id: string): FieldMapping | null {
    const r = this.db.prepare('SELECT * FROM field_mappings WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    return r ? rowToMapping(r) : null;
  }

  upsertMapping(data: Omit<FieldMapping, 'id' | 'createdAt'>): FieldMapping {
    const existing = this.db.prepare(
      'SELECT id FROM field_mappings WHERE source_id = @sourceId AND column_index = @columnIndex AND (tab_id = @tabId OR (tab_id IS NULL AND @tabId IS NULL))',
    ).get({ sourceId: data.sourceId, columnIndex: data.columnIndex, tabId: data.tabId ?? null }) as
      { id: string } | undefined;

    const params = {
      ...data,
      tabId:          data.tabId ?? null,
      systemField:    data.systemField ?? null,
      customFieldId:  data.customFieldId ?? null,
      mappedHeader:   data.mappedHeader ?? null,
      transformRule:  data.transformRule ?? null,
      isKeyCandidate: data.isKeyCandidate ? 1 : 0,
      needsAttention: data.needsAttention ? 1 : 0,
    };

    if (existing) {
      this.db.prepare(`
        UPDATE field_mappings SET
          system_field = @systemField, custom_field_id = @customFieldId,
          column_letter = @columnLetter, sync_direction = @syncDirection,
          transform_rule = @transformRule, mapped_header = @mappedHeader,
          conflict_policy = @conflictPolicy, is_key_candidate = @isKeyCandidate,
          needs_attention = @needsAttention
        WHERE id = @id
      `).run({ ...params, id: existing.id });
      return this.findMappingById(existing.id)!;
    }

    const id  = generateId();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO field_mappings
        (id, source_id, tab_id, system_field, custom_field_id, column_letter, column_index,
         mapped_header, sync_direction, transform_rule, conflict_policy, is_key_candidate,
         needs_attention, created_at)
      VALUES
        (@id, @sourceId, @tabId, @systemField, @customFieldId, @columnLetter, @columnIndex,
         @mappedHeader, @syncDirection, @transformRule, @conflictPolicy, @isKeyCandidate,
         @needsAttention, @now)
    `).run({ id, ...params, now });
    return this.findMappingById(id)!;
  }

  deleteMapping(id: string): boolean {
    const info = this.db.prepare('DELETE FROM field_mappings WHERE id = ?').run(id);
    return info.changes > 0;
  }

  /**
   * Self-heal: compare stored mappings against the sheet's current headers and
   * re-point drifted columns (or flag them). Returns the report of what changed.
   */
  reconcileMappings(sourceId: string, headers: string[]): MappingHealReport {
    const report = healMappings(this.listMappings(sourceId), headers);
    const stmt = this.db.prepare(
      `UPDATE field_mappings
         SET column_index = @columnIndex,
             column_letter = COALESCE(@columnLetter, column_letter),
             needs_attention = @needsAttention
       WHERE id = @id`,
    );
    const apply = this.db.transaction(() => {
      for (const c of report.changes) {
        stmt.run({
          id:             c.mappingId,
          columnIndex:    c.toIndex ?? c.fromIndex,
          columnLetter:   c.toLetter,
          needsAttention: c.needsAttention ? 1 : 0,
        });
      }
    });
    apply();
    return report;
  }
}
