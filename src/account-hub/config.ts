/**
 * Account Hub — Feature Flag & Configuration
 *
 * Reads ACCOUNT_HUB_* environment variables.
 * All flags default to false (or dry-run=true) so a fresh build
 * behaves identically to the previous version unless explicitly enabled.
 *
 * Do NOT import this module inside workflow/recovery/dom modules.
 * Only account-hub submodules and the router mount point should import it.
 */

export interface AccountHubConfig {
  /** Master switch — if false, nothing in this subsystem starts up. */
  enabled: boolean;
  /** Path to the dedicated SQLite file for Account Hub data. */
  dbPath: string;
  /** Enable outbound Google Sheets sync jobs. */
  sheetSyncEnabled: boolean;
  /** Enable AdsPower reconciliation scheduler. */
  adspowerReconcileEnabled: boolean;
  /** Enable bulk AdsPower profile import queue. */
  autoImportEnabled: boolean;
  /** Enable auto-login queue after import. */
  autoLoginEnabled: boolean;
  /**
   * Dry-run mode — when true:
   *   - No AdsPower profiles are created/deleted.
   *   - No Google Sheets cells are written.
   *   - Preview, validate, matching and reports still work normally.
   */
  dryRun: boolean;
  /**
   * AES-256-GCM key for at-rest encryption of secret columns.
   * 32 bytes as 64 hex chars or base64. Mandatory when enabled=true
   * (enforced in initDb via assertEncryptionKey). Never persisted.
   */
  encryptionKey: string;
  /** Enable the inbound Sheets change poller (near-real-time ingest, spec §7.2). */
  sheetPollEnabled: boolean;
  /** Floor for a source's `poll_interval_sec`, in seconds — protects Sheets quota. */
  sheetPollMinIntervalSec: number;
  /** Enable the HMAC-authenticated Apps Script webhook ingest endpoint (spec §7.1). */
  webhookEnabled: boolean;
  /** Shared HMAC secret for the webhook. Never logged, never echoed by any route. */
  webhookSecret: string;
  /** Reject a webhook whose timestamp is older than this (replay window, seconds). */
  webhookMaxSkewSec: number;
}

/** Parse a positive integer env var, falling back to `fallback` when unset/invalid. */
function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function parseAccountHubConfig(): AccountHubConfig {
  const enabled = process.env.ACCOUNT_HUB_ENABLED === 'true';

  return {
    enabled,
    dbPath: process.env.ACCOUNT_HUB_DB_PATH ?? './data/account-hub.sqlite',
    // Sub-flags are only meaningful when the master flag is enabled.
    sheetSyncEnabled: enabled && process.env.ACCOUNT_HUB_SHEET_SYNC_ENABLED === 'true',
    adspowerReconcileEnabled:
      enabled && process.env.ACCOUNT_HUB_ADSPOWER_RECONCILE_ENABLED === 'true',
    autoImportEnabled: enabled && process.env.ACCOUNT_HUB_AUTO_IMPORT_ENABLED === 'true',
    autoLoginEnabled: enabled && process.env.ACCOUNT_HUB_AUTO_LOGIN_ENABLED === 'true',
    // Dry-run defaults to true — must be explicitly disabled.
    dryRun: process.env.ACCOUNT_HUB_DRY_RUN !== 'false',
    encryptionKey: process.env.ACCOUNT_HUB_ENCRYPTION_KEY ?? '',
    sheetPollEnabled: enabled && process.env.ACCOUNT_HUB_SHEET_POLL_ENABLED === 'true',
    sheetPollMinIntervalSec: positiveInt(process.env.ACCOUNT_HUB_SHEET_POLL_MIN_INTERVAL_SEC, 30),
    webhookEnabled: enabled && process.env.ACCOUNT_HUB_WEBHOOK_ENABLED === 'true',
    webhookSecret: process.env.ACCOUNT_HUB_WEBHOOK_SECRET ?? '',
    webhookMaxSkewSec: positiveInt(process.env.ACCOUNT_HUB_WEBHOOK_MAX_SKEW_SEC, 300),
  };
}

export const accountHubConfig: AccountHubConfig = parseAccountHubConfig();
