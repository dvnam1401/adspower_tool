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
import fs from 'node:fs';
import { logger } from '../../utils/logger.js';
import { encryptSecret } from '../crypto.js';

// ---------------------------------------------------------------------------
// Migration definitions
// ---------------------------------------------------------------------------

interface Migration {
  version: number;
  description: string;
  /** DDL executed verbatim. Optional when `apply` handles the work. */
  sql?: string;
  /** Imperative migration (data backfill etc.); runs inside the same tx as `sql`. */
  apply?: (db: Database.Database) => void;
  /**
   * When true the runner does NOT wrap `apply` in its own transaction — the
   * migration manages pragmas/transaction itself (needed for FK-sensitive
   * table rebuilds where `PRAGMA foreign_keys` must toggle outside a tx).
   */
  manualTransaction?: boolean;
  /** Copy the DB file to `<path>.bak-<ts>` before applying (destructive rebuilds). */
  backupBeforeApply?: boolean;
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
  {
    version: 6,
    description:
      'Data-warehouse delta: lock/dup/channel/color columns + notifications, country-tab, write-lock tables',
    sql: `
      ALTER TABLE accounts ADD COLUMN locked_by            TEXT;
      ALTER TABLE accounts ADD COLUMN locked_at            TEXT;
      ALTER TABLE accounts ADD COLUMN channel_match_status TEXT;
      ALTER TABLE accounts ADD COLUMN duplicate_profile    INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE accounts ADD COLUMN duplicate_id         INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE accounts ADD COLUMN duplicate_hotmail    INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE accounts ADD COLUMN color_backup_json    TEXT;
      CREATE INDEX IF NOT EXISTS idx_accounts_channel_match
        ON accounts(channel_match_status);

      CREATE TABLE IF NOT EXISTS notifications (
        id               TEXT    PRIMARY KEY,
        type             TEXT    NOT NULL,
        status           TEXT    NOT NULL DEFAULT 'OPEN',
        account_id       TEXT    REFERENCES accounts(id) ON DELETE CASCADE,
        adspower_user_id TEXT,
        title            TEXT    NOT NULL,
        detail           TEXT,
        dedupe_key       TEXT    UNIQUE,
        created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        resolved_at      TEXT,
        resolved_by      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status);

      CREATE TABLE IF NOT EXISTS country_tab_mappings (
        id          TEXT    PRIMARY KEY,
        source_id   TEXT    NOT NULL REFERENCES sheet_sources(id) ON DELETE CASCADE,
        country     TEXT    NOT NULL,
        tab_id      TEXT    REFERENCES sheet_tabs(id) ON DELETE SET NULL,
        tab_title   TEXT,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE(source_id, country)
      );

      CREATE TABLE IF NOT EXISTS sheet_write_locks (
        lock_key    TEXT    PRIMARY KEY,
        locked_by   TEXT    NOT NULL,
        acquired_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        expires_at  TEXT    NOT NULL
      );
    `,
  },
  {
    version: 7,
    description: 'Encrypt any pre-existing plaintext secret columns in place',
    apply: (db) => {
      const rows = db
        .prepare(
          `SELECT id, password_enc, two_factor_secret_enc, hotmail_password_enc,
                  cookie_enc, token_enc
           FROM accounts`,
        )
        .all() as Array<Record<string, string | null>>;
      const upd = db.prepare(
        `UPDATE accounts SET
           password_enc          = @password,
           two_factor_secret_enc = @twoFactor,
           hotmail_password_enc  = @hotmailPassword,
           cookie_enc            = @cookie,
           token_enc             = @token
         WHERE id = @id`,
      );
      for (const r of rows) {
        upd.run({
          id: r.id,
          password: encryptSecret(r.password_enc),
          twoFactor: encryptSecret(r.two_factor_secret_enc),
          hotmailPassword: encryptSecret(r.hotmail_password_enc),
          cookie: encryptSecret(r.cookie_enc),
          token: encryptSecret(r.token_enc),
        });
      }
    },
  },
  {
    version: 8,
    description:
      'Rebuild accounts to DROP UNIQUE on adspower_user_id (duplicates warned, not blocked); keep a non-unique index',
    manualTransaction: true,
    backupBeforeApply: true,
    apply: (db) => {
      // FK-sensitive rebuild: children reference accounts(id). foreign_keys must
      // be OFF around the DROP/RENAME, and PRAGMA cannot toggle inside a tx.
      db.pragma('foreign_keys = OFF');
      try {
        const cols = [
          'id', 'profile_name', 'normalized_profile_name', 'adspower_user_id',
          'adspower_serial_number', 'adspower_group_id', 'linked_content', 'login_id',
          'password_enc', 'two_factor_secret_enc', 'hotmail', 'hotmail_password_enc',
          'recovery_mail', 'cookie_enc', 'token_enc', 'youtube_channel_url',
          'account_status', 'adspower_status', 'assigned_to', 'last_seen_adspower_at',
          'die_marked_at', 'deleted_from_adspower_at', 'version', 'created_at',
          'updated_at', 'created_by', 'updated_by', 'archived_at', 'locked_by',
          'locked_at', 'channel_match_status', 'duplicate_profile', 'duplicate_id',
          'duplicate_hotmail', 'color_backup_json',
        ].join(', ');

        const rebuild = db.transaction(() => {
          const before = db
            .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM accounts')
            .get()!.c;

          db.exec(`
            CREATE TABLE accounts_rebuild (
              id                         TEXT PRIMARY KEY,
              profile_name               TEXT NOT NULL,
              normalized_profile_name    TEXT NOT NULL,
              adspower_user_id           TEXT,
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
              archived_at                TEXT,
              locked_by                  TEXT,
              locked_at                  TEXT,
              channel_match_status       TEXT,
              duplicate_profile          INTEGER NOT NULL DEFAULT 0,
              duplicate_id               INTEGER NOT NULL DEFAULT 0,
              duplicate_hotmail          INTEGER NOT NULL DEFAULT 0,
              color_backup_json          TEXT
            );
          `);

          db.exec(`INSERT INTO accounts_rebuild (${cols}) SELECT ${cols} FROM accounts;`);

          const after = db
            .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM accounts_rebuild')
            .get()!.c;
          if (before !== after) {
            throw new Error(
              `[AccountHub] Migration 8 aborted: row count mismatch before=${before} after=${after}`,
            );
          }

          db.exec('DROP TABLE accounts;');
          db.exec('ALTER TABLE accounts_rebuild RENAME TO accounts;');

          // Recreate all former indexes; the implicit UNIQUE index on
          // adspower_user_id is intentionally replaced by a plain index.
          db.exec(`
            CREATE INDEX IF NOT EXISTS idx_accounts_normalized_name  ON accounts(normalized_profile_name);
            CREATE INDEX IF NOT EXISTS idx_accounts_account_status   ON accounts(account_status);
            CREATE INDEX IF NOT EXISTS idx_accounts_adspower_status  ON accounts(adspower_status);
            CREATE INDEX IF NOT EXISTS idx_accounts_assigned_to      ON accounts(assigned_to);
            CREATE INDEX IF NOT EXISTS idx_accounts_channel_match    ON accounts(channel_match_status);
            CREATE INDEX IF NOT EXISTS idx_accounts_adspower_user_id ON accounts(adspower_user_id);
          `);

          // better-sqlite3 pragma() returns the table-valued result as an array of rows.
          const fkViolations = db.pragma('foreign_key_check') as unknown[];
          if (fkViolations.length > 0) {
            throw new Error(
              `[AccountHub] Migration 8 aborted: FK check failed ${JSON.stringify(fkViolations)}`,
            );
          }
        });
        rebuild();
      } finally {
        db.pragma('foreign_keys = ON');
      }
    },
  },
  {
    version: 9,
    description:
      'Self-heal support: field_mappings.mapped_header + needs_attention for column-drift detection',
    sql: `
      ALTER TABLE field_mappings ADD COLUMN mapped_header   TEXT;
      ALTER TABLE field_mappings ADD COLUMN needs_attention INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 10,
    description:
      'Warehouse Phase-1: per-source DIE colour read config + accounts.channel_link (BC→Reup match link)',
    sql: `
      ALTER TABLE sheet_sources ADD COLUMN die_read_mode     TEXT NOT NULL DEFAULT 'none';
      ALTER TABLE sheet_sources ADD COLUMN die_color_columns TEXT;
      ALTER TABLE accounts      ADD COLUMN channel_link       TEXT;
    `,
  },
  {
    version: 11,
    description:
      'Warehouse Phase-4: per-source DIE write colour (exact red code, spec §4 decision #3)',
    sql: `
      ALTER TABLE sheet_sources ADD COLUMN die_write_color TEXT;
    `,
  },
];

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

export function runMigrations(db: Database.Database): void {
  // Ensure the tracking table exists first (migration 1 is always idempotent)
  if (MIGRATIONS[0].sql) db.exec(MIGRATIONS[0].sql);

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

    // Optional file backup before a destructive/rebuild migration.
    if (migration.backupBeforeApply && db.name && db.name !== ':memory:' && fs.existsSync(db.name)) {
      db.pragma('wal_checkpoint(TRUNCATE)');
      const backupPath = `${db.name}.bak-${Date.now()}`;
      fs.copyFileSync(db.name, backupPath);
      logger.info(`[AccountHub] Backed up DB to ${backupPath} before migration ${migration.version}`);
    }

    if (migration.manualTransaction) {
      // Migration manages its own pragmas/transaction (e.g. FK-sensitive rebuild).
      if (migration.sql) db.exec(migration.sql);
      if (migration.apply) migration.apply(db);
      insertMigration.run({ version: migration.version, description: migration.description });
    } else {
      const applyMigration = db.transaction(() => {
        if (migration.sql) db.exec(migration.sql);
        if (migration.apply) migration.apply(db);
        insertMigration.run({
          version: migration.version,
          description: migration.description,
        });
      });
      applyMigration();
    }

    logger.info(`[AccountHub] Migration ${migration.version} applied.`);
  }
}
