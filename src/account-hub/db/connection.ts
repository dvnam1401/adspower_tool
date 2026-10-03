/**
 * Account Hub — SQLite connection
 *
 * Opens a single WAL-mode database at the configured path.
 * Only initialised when ACCOUNT_HUB_ENABLED=true.
 * Foreign-key enforcement is always on.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { accountHubConfig } from '../config.js';
import { assertEncryptionKey } from '../crypto.js';
import { logger } from '../../utils/logger.js';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    throw new Error('[AccountHub] Database not initialised. Call initDb() first.');
  }
  return _db;
}

export function initDb(): Database.Database {
  if (_db) return _db;

  const dbPath = path.resolve(accountHubConfig.dbPath);
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  logger.info(`[AccountHub] Opening database at ${dbPath}`);
  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  // Enforce foreign key constraints
  db.pragma('foreign_keys = ON');
  // Reasonable busy timeout (5 s) to handle write contention
  db.pragma('busy_timeout = 5000');

  // Encryption is mandatory when the subsystem runs — fail fast on a bad/missing key.
  assertEncryptionKey();

  _db = db;
  return db;
}

/** Close DB (used in tests and graceful shutdown). */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
