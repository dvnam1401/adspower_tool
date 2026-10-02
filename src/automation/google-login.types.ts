/**
 * Types for the Google Account Login automation.
 *
 * SECURITY: Every field in this module is intended to hold ALREADY-SANITIZED,
 * safe-to-log data. Emails are masked upstream before being placed here.
 * NO raw credentials, passwords, or 2FA/TOTP codes belong in these types.
 */

/** Terminal / intermediate state of a Google login attempt. */
export type GoogleLoginState =
  | 'SUCCESS'
  | 'FAILED'
  | 'TIMEOUT'
  | 'VERIFICATION_REQUIRED'
  | 'NEEDS_HUMAN_REVIEW'
  | 'QUEUED'
  | 'RUNNING'
  | 'BROWSER_WINDOW_MISMATCH'
  | 'CREDENTIAL_UNAVAILABLE'
  /**
   * Đăng nhập thành công NHƯNG tài khoản đang đăng nhập KHÁC tài khoản được gán
   * cho profile (Gmail là khoá nhận dạng cứng). KHÔNG phải success.
   */
  | 'IDENTITY_MISMATCH';

/**
 * Credential cho một lần đăng nhập Google.
 *
 * SECURITY: đây là kiểu DUY NHẤT trong module này được mang secret thô. Giá trị
 * chỉ tồn tại trong RAM, KHÔNG được log / broadcast / ghi checkpoint.
 *
 * `twoFactorSecret` chỉ dùng cho provider KHÔNG có nguồn 2FA trong profile
 * (taothaoAIClaw). Khi trống, luồng AdsPower vẫn đọc mã từ tab start.adspower.net
 * như cũ — hành vi AdsPower không đổi.
 */
export interface GoogleLoginCredentials {
  username: string;
  password: string;
  /** Secret TOTP base32 / `otpauth://` / envelope `enc:v1:` / mã 6 số. */
  twoFactorSecret?: string;
  /**
   * Bắt buộc đối chiếu Gmail đang đăng nhập với `username` sau khi cookie xác
   * nhận đã đăng nhập. Chỉ provider có credential do người dùng cung cấp bật cờ
   * này; luồng AdsPower để mặc định (undefined) nên hành vi không đổi.
   */
  verifyIdentity?: boolean;
}

/**
 * Result of a Google login attempt.
 * All fields are sanitized and safe to log (email masked upstream).
 * NEVER store raw credentials or 2FA codes here.
 */
export interface GoogleLoginResult {
  success: boolean;
  status: string;
  state: GoogleLoginState;
  message: string;
  currentUrl: string;
  profileId: string;
  profileName?: string;
  twoFactorUsed?: boolean;
  details?: Record<string, unknown>;
}
