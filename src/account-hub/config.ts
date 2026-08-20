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
  };
}

export const accountHubConfig: AccountHubConfig = parseAccountHubConfig();
