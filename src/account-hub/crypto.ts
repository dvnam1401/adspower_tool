/**
 * Account Hub — Secret encryption (AES-256-GCM)
 *
 * Single chokepoint for at-rest encryption of the `*_enc` columns.
 * The key comes from ACCOUNT_HUB_ENCRYPTION_KEY (32 bytes, hex or base64)
 * and is NEVER persisted. Encryption is MANDATORY when the subsystem is
 * enabled — see assertEncryptionKey(), called from initDb().
 *
 * Storage format:  "enc:v1:" + base64(iv[12] ‖ authTag[16] ‖ ciphertext)
 *
 * Legacy plaintext (rows written before encryption existed) is tolerated on
 * read: decryptSecret() returns non-prefixed values unchanged. Migration v7
 * upgrades them in place.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { accountHubConfig } from './config.js';

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;

function parseKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  const b64 = Buffer.from(trimmed, 'base64');
  if (b64.length === 32) return b64;
  throw new Error(
    '[AccountHub] ACCOUNT_HUB_ENCRYPTION_KEY must be a 32-byte key ' +
      '(64 hex chars or base64-encoded 32 bytes).',
  );
}

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = accountHubConfig.encryptionKey;
  if (!raw || !raw.trim()) {
    throw new Error(
      '[AccountHub] Encryption is mandatory. Set ACCOUNT_HUB_ENCRYPTION_KEY ' +
        '(32-byte key as 64 hex chars or base64).',
    );
  }
  cachedKey = parseKey(raw);
  return cachedKey;
}

/** True when a valid encryption key is configured (does not throw). */
export function isEncryptionConfigured(): boolean {
  return Boolean(accountHubConfig.encryptionKey && accountHubConfig.encryptionKey.trim());
}

/**
 * Fail-fast guard. MUST be called during initDb() so the subsystem refuses to
 * start with plaintext secrets. Validates the key can actually be parsed.
 */
export function assertEncryptionKey(): void {
  getKey();
}

/** True if the stored value is already in the enc:v1 envelope. */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * Encrypt a secret for storage. Idempotent: already-encrypted values pass
 * through unchanged. null / undefined / '' are preserved as-is (no envelope).
 */
export function encryptSecret(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === '') {
    return (plain ?? null) as string | null;
  }
  if (isEncrypted(plain)) return plain;

  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/**
 * Decrypt a stored secret. Non-enveloped (legacy plaintext) values are
 * returned unchanged. null / undefined / '' pass through.
 */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined || stored === '') {
    return (stored ?? null) as string | null;
  }
  if (!isEncrypted(stored)) return stored;

  const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
