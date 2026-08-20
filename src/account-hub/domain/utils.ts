/**
 * Account Hub — Name normalization utilities
 *
 * Used for bootstrap matching only (spec §7.1).
 * After adspower_user_id is set, matching uses ID only.
 */

/**
 * Normalize a profile name for comparison:
 * - Trim whitespace
 * - Collapse multiple spaces into one
 * - Lowercase
 * - Normalize separator characters (/, -, |) with consistent spacing
 * - Do NOT remove numbers or dates
 */
export function normalizeName(name: string): string {
  if (!name) return '';

  return name
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    // Normalize separators: remove spaces around / - | then add single space each side
    .replace(/\s*([/|])\s*/g, ' $1 ')
    .replace(/\s*-\s*/g, '-')
    .trim();
}

/**
 * Redact sensitive fields from an object before logging/auditing.
 * Replaces the value with '[REDACTED]'.
 */
const SENSITIVE_KEYS = new Set([
  'password',
  'passwordEnc',
  'password_enc',
  'twoFactorSecret',
  'twoFactorSecretEnc',
  'two_factor_secret_enc',
  'hotmailPassword',
  'hotmailPasswordEnc',
  'hotmail_password_enc',
  'cookie',
  'cookieEnc',
  'cookie_enc',
  'token',
  'tokenEnc',
  'token_enc',
  'private_key',
  'privateKey',
]);

export function redactSensitive(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key)) {
      result[key] = '[REDACTED]';
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = redactSensitive(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Generate a v4-like UUID using Node.js crypto */
export function generateId(): string {
  return crypto.randomUUID();
}
