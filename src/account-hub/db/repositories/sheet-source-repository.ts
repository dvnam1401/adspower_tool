/**
 * Account Hub — Sheet Source Repository
 *
 * CRUD for sheet_sources, sheet_tabs and field_mappings tables.
 */

import type Database from 'better-sqlite3';
import { generateId } from '../../domain/utils.js';

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
  syncDirection:    string;
  transformRule:    string | null;
  conflictPolicy:   string;
  isKeyCandidate:   boolean;
  createdAt:        string;
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
         created_at, updated_at)
      VALUES
        (@id, @name, @spreadsheetId, @credentialRef, @syncDirection,
         @isEnabled, @priority, @headerRow, @firstDataRow, @pollIntervalSec,
         @now, @now)
    `).run({ id, ...data, isEnabled: data.isEnabled ? 1 : 0, now });
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
    };
    for (const [k, c] of Object.entries(col)) {
      const v = (data as Record<string, unknown>)[k];
      if (v !== undefined) { sets.push(`${c} = @${k}`); params[k] = v; }
    }
    this.db.prepare(`UPDATE sheet_sources SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return this.findById(id)!;
  }

  // ---- Tabs ----

  upsertTab(sourceId: string, sheetId: number, title: string): SheetTab {
    const existing = this.db.prepare(
      'SELECT * FROM sheet_tabs WHERE source_id = ? AND sheet_id = ?',
    ).get(sourceId, sheetId) as Record<string, unknown> | undefined;

    if (existing) return existing as unknown as SheetTab;

    const id  = generateId();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO sheet_tabs (id, source_id, sheet_id, title, created_at)
      VALUES (@id, @sourceId, @sheetId, @title, @now)
    `).run({ id, sourceId, sheetId, title, now });
    return this.db.prepare('SELECT * FROM sheet_tabs WHERE id = ?').get(id) as unknown as SheetTab;
  }

  listTabs(sourceId: string): SheetTab[] {
    return this.db.prepare('SELECT * FROM sheet_tabs WHERE source_id = ?').all(sourceId) as
      unknown as SheetTab[];
  }

  // ---- Mappings ----

  listMappings(sourceId: string): FieldMapping[] {
    return this.db.prepare('SELECT * FROM field_mappings WHERE source_id = ?').all(sourceId) as
      unknown as FieldMapping[];
  }

  upsertMapping(data: Omit<FieldMapping, 'id' | 'createdAt'>): FieldMapping {
    const existing = this.db.prepare(
      'SELECT id FROM field_mappings WHERE source_id = @sourceId AND column_index = @columnIndex AND (tab_id = @tabId OR (tab_id IS NULL AND @tabId IS NULL))',
    ).get({ sourceId: data.sourceId, columnIndex: data.columnIndex, tabId: data.tabId ?? null }) as
      { id: string } | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE field_mappings SET
          system_field = @systemField, custom_field_id = @customFieldId,
          column_letter = @columnLetter, sync_direction = @syncDirection,
          conflict_policy = @conflictPolicy, is_key_candidate = @isKeyCandidate
        WHERE id = @id
      `).run({ ...data, id: existing.id, isKeyCandidate: data.isKeyCandidate ? 1 : 0 });
      return this.db.prepare('SELECT * FROM field_mappings WHERE id = ?').get(existing.id) as
        unknown as FieldMapping;
    }

    const id  = generateId();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO field_mappings
        (id, source_id, tab_id, system_field, custom_field_id, column_letter, column_index,
         sync_direction, conflict_policy, is_key_candidate, created_at)
      VALUES
        (@id, @sourceId, @tabId, @systemField, @customFieldId, @columnLetter, @columnIndex,
         @syncDirection, @conflictPolicy, @isKeyCandidate, @now)
    `).run({ id, ...data, tabId: data.tabId ?? null, isKeyCandidate: data.isKeyCandidate ? 1 : 0, now });
    return this.db.prepare('SELECT * FROM field_mappings WHERE id = ?').get(id) as
      unknown as FieldMapping;
  }
}
