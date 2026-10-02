/**
 * Google 2FA — sinh mã TOTP từ secret do NGƯỜI DÙNG cung cấp.
 *
 * Dùng cho provider KHÔNG có nguồn 2FA trong profile (taothaoAIClaw).
 * Provider AdsPower vẫn đọc mã từ tab `start.adspower.net` như cũ
 * (`adspower-2fa.ts`) — module này KHÔNG thay thế đường đó.
 *
 * TÁI DÙNG hoàn toàn tiện ích sẵn có, KHÔNG tạo cơ chế giải mã thứ hai:
 *   - `generateTOTP` (`src/utils/totp.ts`)   — RFC-6238 SHA1/30s/6 số
 *   - `decryptSecret` (`src/account-hub/crypto.ts`) — envelope AES-256-GCM `enc:v1:`
 *
 * SECURITY: KHÔNG BAO GIỜ log secret, mã OTP, hay bất kỳ phần nào của chúng.
 * Kết quả trả về chỉ chứa mã (để fill vào input) hoặc lý do thất bại.
 */

import { generateTOTP } from '../utils/totp.js';
import { decryptSecret, isEncrypted } from '../account-hub/crypto.js';

export type TwoFactorFailureReason =
  | '2fa_secret_missing'
  | '2fa_secret_undecryptable'
  | '2fa_secret_invalid';

export type TwoFactorResolution = { code: string } | { failed: true; reason: TwoFactorFailureReason };

/** Mã OTP 6 số người dùng dán trực tiếp (dùng ngay, không sinh lại). */
const LITERAL_CODE = /^\d{6}$/;

/**
 * Rút secret base32 từ input thô của người dùng. Hỗ trợ 3 dạng (quyết định E4):
 *   1. base32 secret        -> dùng trực tiếp (bỏ space/dấu `=`)
 *   2. `enc:v1:...`         -> giải mã bằng crypto sẵn có của project
 *   3. `otpauth://...?secret=XXX` -> trích query `secret`
 * Trả null khi không rút được secret nào.
 */
export function extractTotpSecret(raw: string | null | undefined): string | null {
  const value = (raw || '').trim();
  if (!value) return null;

  if (isEncrypted(value)) {
    let decrypted: string | null = null;
    try {
      decrypted = decryptSecret(value);
    } catch {
      return null;
    }
    // Đệ quy 1 cấp: bản giải mã có thể là base32 hoặc otpauth://
    return decrypted && !isEncrypted(decrypted) ? extractTotpSecret(decrypted) : null;
  }

  if (/^otpauth:\/\//i.test(value)) {
    try {
      const secret = new URL(value).searchParams.get('secret');
      return secret && secret.trim() ? secret.trim() : null;
    } catch {
      const match = /[?&]secret=([^&\s]+)/i.exec(value);
      return match ? decodeURIComponent(match[1]) : null;
    }
  }

  return value;
}

/**
 * Sinh mã 2FA để nhập vào Google.
 * Người dùng để trống 2FA -> `2fa_secret_missing` (caller sẽ báo NEEDS_HUMAN_REVIEW
 * và GIỮ browser mở, theo quyết định E4).
 */
export function resolveTwoFactorCode(raw: string | null | undefined): TwoFactorResolution {
  const value = (raw || '').trim();
  if (!value) return { failed: true, reason: '2fa_secret_missing' };

  if (LITERAL_CODE.test(value)) return { code: value };

  if (isEncrypted(value)) {
    const secret = extractTotpSecret(value);
    if (!secret) return { failed: true, reason: '2fa_secret_undecryptable' };
    return generateFrom(secret);
  }

  const secret = extractTotpSecret(value);
  if (!secret) return { failed: true, reason: '2fa_secret_invalid' };
  if (LITERAL_CODE.test(secret)) return { code: secret };
  return generateFrom(secret);
}

function generateFrom(secret: string): TwoFactorResolution {
  try {
    const code = generateTOTP(secret);
    if (!/^\d{6}$/.test(code)) return { failed: true, reason: '2fa_secret_invalid' };
    return { code };
  } catch {
    // Secret không phải base32 hợp lệ. KHÔNG log giá trị.
    return { failed: true, reason: '2fa_secret_invalid' };
  }
}
