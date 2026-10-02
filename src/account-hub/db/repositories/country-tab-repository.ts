/**
 * Account Hub — Country → Reup Tab mapping repository (Phase 1)
 *
 * Backs the config-driven country→tab table (decision #2: no hard-coded tab names).
 * One row per (source, country); `tab_id` references a persisted sheet_tab and is
 * set NULL if that tab is later removed. `tab_title` is kept as a display fallback.
 */

import type Database from 'better-sqlite3';
import { generateId } from '../../domain/utils.js';

export interface CountryTabMapping {
  id:        string;
  sourceId:  string;
  country:   string;
  tabId:     string | null;
  tabTitle:  string | null;
  createdAt: string;
}

function rowToMapping(r: Record<string, unknown>): CountryTabMapping {
  return {
    id:        r.id as string,
    sourceId:  r.source_id as string,
    country:   r.country as string,
    tabId:     (r.tab_id as string | null) ?? null,
    tabTitle:  (r.tab_title as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

export class CountryTabMappingRepository {
  constructor(private db: Database.Database) {}

  list(sourceId: string): CountryTabMapping[] {
    return (this.db
      .prepare('SELECT * FROM country_tab_mappings WHERE source_id = ? ORDER BY country ASC')
      .all(sourceId) as Record<string, unknown>[]).map(rowToMapping);
  }

  findById(id: string): CountryTabMapping | null {
    const r = this.db.prepare('SELECT * FROM country_tab_mappings WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    return r ? rowToMapping(r) : null;
  }

  /** Insert or update the row for (sourceId, country). */
  upsert(data: { sourceId: string; country: string; tabId: string | null; tabTitle: string | null }): CountryTabMapping {
    const country = data.country.trim();
    if (!country) throw new Error('country is required');

    const existing = this.db
      .prepare('SELECT id FROM country_tab_mappings WHERE source_id = ? AND country = ?')
      .get(data.sourceId, country) as { id: string } | undefined;

    if (existing) {
      this.db
        .prepare('UPDATE country_tab_mappings SET tab_id = @tabId, tab_title = @tabTitle WHERE id = @id')
        .run({ id: existing.id, tabId: data.tabId, tabTitle: data.tabTitle });
      return this.findById(existing.id)!;
    }

    const id  = generateId();
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO country_tab_mappings (id, source_id, country, tab_id, tab_title, created_at)
        VALUES (@id, @sourceId, @country, @tabId, @tabTitle, @now)
      `)
      .run({ id, sourceId: data.sourceId, country, tabId: data.tabId, tabTitle: data.tabTitle, now });
    return this.findById(id)!;
  }

  delete(id: string): boolean {
    const info = this.db.prepare('DELETE FROM country_tab_mappings WHERE id = ?').run(id);
    return info.changes > 0;
  }
}
