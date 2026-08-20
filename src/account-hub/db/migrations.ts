/**
 * Account Hub — Database migrations
 *
 * Forward-only, numbered migrations. Each migration is idempotent
 * (uses CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).
 * A `schema_migrations` table tracks which migrations have been applied.
 *
 * Call `runMigrations(db)` at startup when ACCOUNT_HUB_ENABLED=true.
 */

import type Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Migration definitions
// ---------------------------------------------------------------------------

interface Migration {
  version: number;
  description: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Create schema_migrations tracking table',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     INTEGER PRIMARY KEY,
        description TEXT    NOT NULL,
        applied_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `,
  },
  {
    version: 2,
    description: 'Create accounts table',
    sql: `
      CREATE TABLE IF NOT EXISTS accounts (
        id                         TEXT PRIMARY KEY,
        profile_name               TEXT NOT NULL,
        normalized_profile_name    TEXT NOT NULL,
        adspower_user_id           TEXT UNIQUE,
        adspower_serial_number     TEXT,
        adspower_group_id          TEXT,
        linked_content             TEXT,
        login_id                   TEXT,
        password_enc               TEXT,
        two_factor_secret_enc      TEXT,
        hotmail                    TEXT,
        hotmail_password_enc       TEXT,
        recovery_mail              TEXT,
        cookie_enc                 TEXT,
        token_enc                  TEXT,
        youtube_channel_url        TEXT,
        account_status             TEXT NOT NULL DEFAULT 'LIVE',
        adspower_status            TEXT NOT NULL DEFAULT 'NOT_IMPORTED',
        assigned_to                TEXT,
        last_seen_adspower_at      TEXT,
        die_marked_at              TEXT,
        deleted_from_adspower_at   TEXT,
        version                    INTEGER NOT NULL DEFAULT 1,
        created_at                 TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at                 TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        created_by                 TEXT,
        updated_by                 TEXT,
        archived_at                TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_accounts_normalized_name
        ON accounts(normalized_profile_name);
      CREATE INDEX IF NOT EXISTS idx_accounts_account_status
        ON accounts(account_status);
      CREATE INDEX IF NOT EXISTS idx_accounts_adspower_status
        ON accounts(adspower_status);
      CREATE INDEX IF NOT EXISTS idx_accounts_assigned_to
        ON accounts(assigned_to);
    `,
  },
  {
    version: 3,
    description: 'Create custom field tables',
    sql: `
      CREATE TABLE IF NOT EXISTS custom_field_definitions (
        id              TEXT    PRIMARY KEY,
        technical_name  TEXT    NOT NULL UNIQUE,
        display_name    TEXT    NOT NULL,
        data_type       TEXT    NOT NULL DEFAULT 'text',
        is_sensitive    INTEGER NOT NULL DEFAULT 0,
        is_copyable     INTEGER NOT NULL DEFAULT 1,
        is_searchable   INTEGER NOT NULL DEFAULT 1,
        is_filterable   INTEGER NOT NULL DEFAULT 0,
        is_list_visible INTEGER NOT NULL DEFAULT 1,
        validation_json TEXT,
        display_order   INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS custom_field_values (
        id                    TEXT    PRIMARY KEY,
        account_id            TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        field_definition_id   TEXT    NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
        value_text            TEXT,
        created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE(account_id, field_definition_id)
      );
      CREATE INDEX IF NOT EXISTS idx_cfv_account_id
        ON custom_field_values(account_id);
    `,
  },
  {
    version: 4,
    description: 'Create Google Sheets source and mapping tables',
    sql: `
      CREATE TABLE IF NOT EXISTS sheet_sources (
        id                  TEXT    PRIMARY KEY,
        name                TEXT    NOT NULL,
        spreadsheet_id      TEXT    NOT NULL,
        credential_ref      TEXT,
        sync_direction      TEXT    NOT NULL DEFAULT 'outbound',
        is_enabled          INTEGER NOT NULL DEFAULT 0,
        priority            INTEGER NOT NULL DEFAULT 0,
        header_row          INTEGER NOT NULL DEFAULT 1,
        first_data_row      INTEGER NOT NULL DEFAULT 2,
        poll_interval_sec   INTEGER NOT NULL DEFAULT 300,
        created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS sheet_tabs (
        id              TEXT    PRIMARY KEY,
        source_id       TEXT    NOT NULL REFERENCES sheet_sources(id) ON DELETE CASCADE,
        sheet_id        INTEGER NOT NULL,
        title           TEXT    NOT NULL,
        data_range      TEXT,
        merge_range     TEXT,
        row_rules_json  TEXT,
        created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS field_mappings (
        id                  TEXT    PRIMARY KEY,
        source_id           TEXT    NOT NULL REFERENCES sheet_sources(id) ON DELETE CASCADE,
        tab_id              TEXT    REFERENCES sheet_tabs(id) ON DELETE CASCADE,
        system_field        TEXT,
        custom_field_id     TEXT    REFERENCES custom_field_definitions(id),
        column_letter       TEXT    NOT NULL,
        column_index        INTEGER NOT NULL,
        sync_direction      TEXT    NOT NULL DEFAULT 'outbound',
        transform_rule      TEXT,
        normalization_rule  TEXT,
        conflict_policy     TEXT    NOT NULL DEFAULT 'ask',
        is_key_candidate    INTEGER NOT NULL DEFAULT 0,
        created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS sheet_row_bindings (
        id                  TEXT    PRIMARY KEY,
        account_id          TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        source_id           TEXT    NOT NULL REFERENCES sheet_sources(id) ON DELETE CASCADE,
        tab_id              TEXT    REFERENCES sheet_tabs(id),
        row_index           INTEGER NOT NULL,
        row_fingerprint     TEXT,
        last_read_hash      TEXT,
        last_written_hash   TEXT,
        last_sync_at        TEXT,
        UNIQUE(account_id, source_id, tab_id)
      );
      CREATE INDEX IF NOT EXISTS idx_srb_account ON sheet_row_bindings(account_id);
      CREATE INDEX IF NOT EXISTS idx_srb_source  ON sheet_row_bindings(source_id);
    `,
  },
  {
    version: 5,
    description: 'Create sync job, audit log and conflict tables',
    sql: `
      CREATE TABLE IF NOT EXISTS sync_jobs (
        id              TEXT    PRIMARY KEY,
        job_type        TEXT    NOT NULL,
        status          TEXT    NOT NULL DEFAULT 'pending',
        total_items     INTEGER NOT NULL DEFAULT 0,
        done_items      INTEGER NOT NULL DEFAULT 0,
        failed_items    INTEGER NOT NULL DEFAULT 0,
        error_message   TEXT,
        dry_run         INTEGER NOT NULL DEFAULT 1,
        idempotency_key TEXT    UNIQUE,
        started_at      TEXT,
        finished_at     TEXT,
        created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        created_by      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sync_jobs_status ON sync_jobs(status);

      CREATE TABLE IF NOT EXISTS sync_job_items (
        id          TEXT    PRIMARY KEY,
        job_id      TEXT    NOT NULL REFERENCES sync_jobs(id) ON DELETE CASCADE,
        account_id  TEXT    REFERENCES accounts(id),
        source_id   TEXT    REFERENCES sheet_sources(id),
        row_index   INTEGER,
        status      TEXT    NOT NULL DEFAULT 'pending',
        retry_count INTEGER NOT NULL DEFAULT 0,
        error       TEXT,
        before_json TEXT,
        after_json  TEXT,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX IF NOT EXISTS idx_sji_job_id ON sync_job_items(job_id);
      CREATE INDEX IF NOT EXISTS idx_sji_status ON sync_job_items(status);

      CREATE TABLE IF NOT EXISTS audit_logs (
        id          TEXT    PRIMARY KEY,
        actor       TEXT,
        action      TEXT    NOT NULL,
        entity_type TEXT    NOT NULL,
        entity_id   TEXT,
        before_json TEXT,
        after_json  TEXT,
        source      TEXT,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

      CREATE TABLE IF NOT EXISTS conflicts (
        id              TEXT    PRIMARY KEY,
        account_id      TEXT    REFERENCES accounts(id),
        source_id       TEXT    REFERENCES sheet_sources(id),
        field_name      TEXT    NOT NULL,
        db_value        TEXT,
        sheet_value     TEXT,
        row_index       INTEGER,
        status          TEXT    NOT NULL DEFAULT 'pending',
        resolved_by     TEXT,
        resolved_at     TEXT,
        resolution      TEXT,
        created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX IF NOT EXISTS idx_conflicts_status ON conflicts(status);
    `,
  },
];

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

export function runMigrations(db: Database.Database): void {
  // Ensure the tracking table exists first (migration 1 is always idempotent)
  db.exec(MIGRATIONS[0].sql);

  const getApplied = db.prepare<[], { version: number }>(
    'SELECT version FROM schema_migrations ORDER BY version',
  );
  const applied = new Set(getApplied.all().map((r) => r.version));

  const insertMigration = db.prepare(
    `INSERT OR IGNORE INTO schema_migrations (version, description)
     VALUES (@version, @description)`,
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    logger.info(
      `[AccountHub] Applying migration ${migration.version}: ${migration.description}`,
    );

    const applyMigration = db.transaction(() => {
      db.exec(migration.sql);
      insertMigration.run({
        version: migration.version,
        description: migration.description,
      });
    });

    applyMigration();
    logger.info(`[AccountHub] Migration ${migration.version} applied.`);
  }
}
