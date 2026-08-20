import crypto from 'crypto';

/**
 * Generate standard 6-digit Time-based One-Time Password (TOTP) from Base32 secret key.
 * Compatible with Google Authenticator, Authy, Quick2FA.
 */
export function generateTOTP(secretBase32: string): string {
  if (!secretBase32) {
    throw new Error('Secret key không được để trống.');
  }

  const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  const cleanSecret = secretBase32.replace(/\s+/g, '').replace(/=/g, '').toUpperCase();

  for (let i = 0; i < cleanSecret.length; i++) {
    const val = base32chars.indexOf(cleanSecret.charAt(i));
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }

  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  const key = Buffer.from(bytes);

  const epoch = Math.floor(Date.now() / 1000);
  const time = Math.floor(epoch / 30);
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeBigInt64BE(BigInt(time));

  const hmac = crypto.createHmac('sha1', key);
  hmac.update(timeBuffer);
  const digest = hmac.digest();

  const offset = digest[digest.length - 1] & 0xf;
  const code = (
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  ) % 1000000;

  return code.toString().padStart(6, '0');
}
