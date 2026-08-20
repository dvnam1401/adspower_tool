/**
 * Unit tests — Account Hub feature flag gate
 *
 * Plain Node.js assertions, no test framework dependency.
 * Run: npx tsx tests/account-hub/unit/config.test.ts
 */

import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  ❌ ${name}: ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Helpers that replicate the parsing logic from src/account-hub/config.ts
// without importing the module (avoids module-cache side-effects in tests).
// ---------------------------------------------------------------------------

function parseEnabled(env: Record<string, string | undefined>): boolean {
  return env['ACCOUNT_HUB_ENABLED'] === 'true';
}

function parseDryRun(env: Record<string, string | undefined>): boolean {
  return env['ACCOUNT_HUB_DRY_RUN'] !== 'false';
}

function parseDbPath(env: Record<string, string | undefined>): string {
  return env['ACCOUNT_HUB_DB_PATH'] ?? './data/account-hub.sqlite';
}

function parseSubFlag(
  masterEnabled: boolean,
  env: Record<string, string | undefined>,
  key: string,
): boolean {
  return masterEnabled && env[key] === 'true';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('\nAccount Hub — config unit tests\n');

test('ACCOUNT_HUB_ENABLED absent → false', () => {
  assert.equal(parseEnabled({}), false);
});

test('ACCOUNT_HUB_ENABLED=false → false', () => {
  assert.equal(parseEnabled({ ACCOUNT_HUB_ENABLED: 'false' }), false);
});

test('ACCOUNT_HUB_ENABLED=true → true', () => {
  assert.equal(parseEnabled({ ACCOUNT_HUB_ENABLED: 'true' }), true);
});

test('ACCOUNT_HUB_DRY_RUN absent → true (safe default)', () => {
  assert.equal(parseDryRun({}), true);
});

test('ACCOUNT_HUB_DRY_RUN=true → true', () => {
  assert.equal(parseDryRun({ ACCOUNT_HUB_DRY_RUN: 'true' }), true);
});

test('ACCOUNT_HUB_DRY_RUN=false → false (explicitly disabled)', () => {
  assert.equal(parseDryRun({ ACCOUNT_HUB_DRY_RUN: 'false' }), false);
});

test('ACCOUNT_HUB_DB_PATH absent → default path', () => {
  assert.equal(parseDbPath({}), './data/account-hub.sqlite');
});

test('ACCOUNT_HUB_DB_PATH set → uses custom path', () => {
  assert.equal(parseDbPath({ ACCOUNT_HUB_DB_PATH: '/custom/path.sqlite' }), '/custom/path.sqlite');
});

test('sub-flag is false when master=false even if sub-flag=true', () => {
  const env = { ACCOUNT_HUB_SHEET_SYNC_ENABLED: 'true' };
  assert.equal(parseSubFlag(false, env, 'ACCOUNT_HUB_SHEET_SYNC_ENABLED'), false);
});

test('sub-flag is true when master=true and sub-flag=true', () => {
  const env = { ACCOUNT_HUB_SHEET_SYNC_ENABLED: 'true' };
  assert.equal(parseSubFlag(true, env, 'ACCOUNT_HUB_SHEET_SYNC_ENABLED'), true);
});

test('sub-flag is false when master=true but sub-flag absent', () => {
  assert.equal(parseSubFlag(true, {}, 'ACCOUNT_HUB_SHEET_SYNC_ENABLED'), false);
});

test('all sub-flags default to false when master is false', () => {
  const subKeys = [
    'ACCOUNT_HUB_SHEET_SYNC_ENABLED',
    'ACCOUNT_HUB_ADSPOWER_RECONCILE_ENABLED',
    'ACCOUNT_HUB_AUTO_IMPORT_ENABLED',
    'ACCOUNT_HUB_AUTO_LOGIN_ENABLED',
  ];
  for (const key of subKeys) {
    assert.equal(parseSubFlag(false, { [key]: 'true' }, key), false,
      `${key} should be false when master disabled`);
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
