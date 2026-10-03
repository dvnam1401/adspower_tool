/**
 * Google Account Login — nhận input tài khoản và GHÉP CỐ ĐỊNH theo vị trí với profile.
 *
 * Đây là nơi DUY NHẤT quyết định "tài khoản nào vào profile nào".
 * Toàn bộ module là PURE (không I/O, không log) để unit-test được và để mapping
 * được chốt XONG TRƯỚC KHI bất kỳ profile nào được mở.
 *
 * QUY TẮC BẤT BIẾN (không được nới lỏng):
 *   1. Ghép theo VỊ TRÍ: dòng tài khoản thứ N vào profile thứ N của danh sách
 *      người dùng chọn. KHÔNG sort, KHÔNG random, KHÔNG match theo tên,
 *      KHÔNG match theo thứ tự API trả về.
 *   2. Số lượng phải BẰNG NHAU. Lệch -> từ chối TRƯỚC KHI mở profile nào.
 *   3. Mapping được `Object.freeze` -> worker nhận đúng MỘT cặp, không tự bốc cặp.
 *   4. Trùng `profileId` bị TỪ CHỐI: store credential keyed theo profileId nên
 *      trùng khoá sẽ ghi đè và làm RÒ RỈ credential chéo giữa các tài khoản.
 *   5. Gmail là KHOÁ NHẬN DẠNG CỨNG: được mang theo mapping để verify sau login.
 *
 * SECURITY: mapping (thứ được log/broadcast/checkpoint) chỉ chứa `email`.
 * Password và secret 2FA nằm trong `secrets` — chỉ giữ trong RAM, không log,
 * không persist, không đưa vào SSE/checkpoint.
 */

/** Một dòng tài khoản người dùng dán: `gmail,password,2fa`. */
export interface GoogleAccountInput {
  /** Gmail (đã trim + lowercase) — dùng để nhập vào Google và để verify danh tính. */
  email: string;
  password: string;
  /** Secret/mã 2FA thô; rỗng nghĩa là tài khoản không có 2FA. */
  twoFactor: string;
  /** Số dòng gốc (1-based) trong ô nhập — dùng để báo lỗi chính xác. */
  line: number;
}

export type ParseAccountsError =
  | { code: 'EMPTY_INPUT'; message: string }
  | { code: 'MALFORMED_LINE'; message: string; line: number }
  | { code: 'DUPLICATE_ACCOUNT'; message: string; line: number; email: string };

export type ParseAccountsResult =
  | { ok: true; accounts: GoogleAccountInput[] }
  | ({ ok: false } & ParseAccountsError);

/** Một cặp (profile, tài khoản) BẤT BIẾN mà worker sẽ thực thi. */
export interface ExecutionMappingEntry {
  /** Thứ tự gốc do người dùng nhập (0-based). Kết quả PHẢI trả về theo thứ tự này. */
  readonly index: number;
  readonly profileId: string;
  /** Identifier gốc người dùng nhập (id hoặc tên) — để đối chiếu trên UI. */
  readonly identifier: string;
  readonly profileName: string;
  /** Gmail được gán cho profile này — khoá nhận dạng cứng. */
  readonly email: string;
}

/** Credential per-profile: RAM-only, KHÔNG BAO GIỜ log/persist. */
export interface ProfileAccountSecret {
  email: string;
  password: string;
  twoFactor: string;
}

export type BuildMappingError =
  | {
      code: 'COUNT_MISMATCH';
      message: string;
      profileCount: number;
      accountCount: number;
      expected: 'equal-counts';
    }
  | { code: 'NO_PROFILE' | 'NO_ACCOUNT'; message: string; profileCount: number; accountCount: number }
  | { code: 'DUPLICATE_PROFILE'; message: string; profileId: string; positions: number[] };

export type BuildMappingResult =
  | {
      ok: true;
      mapping: readonly ExecutionMappingEntry[];
      secrets: Map<string, ProfileAccountSecret>;
    }
  | ({ ok: false } & BuildMappingError);

/** Profile đã chọn, theo ĐÚNG thứ tự người dùng chọn/dán. */
export interface MappingProfileInput {
  profileId: string;
  identifier?: string;
  profileName?: string;
}

const EMAIL_SHAPE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
/** Tách field: ưu tiên dấu phẩy, nhưng chấp nhận tab/`|`/`;` khi dán từ bảng tính. */
const FIELD_SEPARATOR = /[,\t|;]/;

/**
 * Parse ô nhập `gmail,password,2fa` (mỗi dòng một tài khoản).
 * Dòng trống và dòng bắt đầu bằng `#` được bỏ qua (comment).
 * Dòng sai định dạng -> TỪ CHỐI cả lô (không im lặng bỏ dòng, vì bỏ dòng sẽ
 * làm lệch số lượng và phá mapping theo vị trí).
 */
export function parseGoogleAccountLines(raw: string): ParseAccountsResult {
  const text = (raw || '').replace(/\uFEFF/g, '');
  const lines = text.split(/\r?\n/);

  const accounts: GoogleAccountInput[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    const parts = line.split(FIELD_SEPARATOR).map(p => p.trim());
    if (parts.length < 2) {
      return {
        ok: false,
        code: 'MALFORMED_LINE',
        line: lineNo,
        message: `Dòng ${lineNo} sai định dạng. Cần "gmail,password" hoặc "gmail,password,2fa".`,
      };
    }
    if (parts.length > 3) {
      return {
        ok: false,
        code: 'MALFORMED_LINE',
        line: lineNo,
        message:
          `Dòng ${lineNo} có ${parts.length} trường (tối đa 3). ` +
          `Mật khẩu KHÔNG được chứa dấu phẩy / tab / "|" / ";".`,
      };
    }

    const email = parts[0].toLowerCase();
    const password = parts[1];
    const twoFactor = parts[2] || '';

    if (!EMAIL_SHAPE.test(email)) {
      return {
        ok: false,
        code: 'MALFORMED_LINE',
        line: lineNo,
        message: `Dòng ${lineNo}: email không hợp lệ.`,
      };
    }
    if (!password) {
      return {
        ok: false,
        code: 'MALFORMED_LINE',
        line: lineNo,
        message: `Dòng ${lineNo}: thiếu mật khẩu.`,
      };
    }
    if (seen.has(email)) {
      return {
        ok: false,
        code: 'DUPLICATE_ACCOUNT',
        line: lineNo,
        email,
        message:
          `Dòng ${lineNo}: tài khoản bị lặp trong danh sách. ` +
          `Mỗi tài khoản chỉ được đăng nhập vào một profile.`,
      };
    }
    seen.add(email);

    accounts.push({ email, password, twoFactor, line: lineNo });
  }

  if (accounts.length === 0) {
    return { ok: false, code: 'EMPTY_INPUT', message: 'Chưa có dòng tài khoản nào hợp lệ.' };
  }

  return { ok: true, accounts };
}

/**
 * Thông báo lệch số lượng — ĐỊNH DẠNG DO NGƯỜI DÙNG CHỈ ĐỊNH, giữ NGUYÊN VĂN.
 * Dùng ở cả `buildExecutionMapping` và lớp kiểm tra sớm của engine để chỉ có
 * MỘT nguồn sự thật cho chuỗi này.
 */
export function formatCountMismatch(profileCount: number, accountCount: number): string {
  return (
    `Số lượng profile và tài khoản không khớp.\n` +
    `Profiles: ${profileCount}\n` +
    `Accounts: ${accountCount}\n` +
    `Vui lòng kiểm tra lại.`
  );
}

/**
 * Chốt mapping VỊ TRÍ (profile[i] <-> account[i]) và tách secret ra khỏi mapping.
 * Trả lỗi (không throw) để caller báo cho người dùng mà KHÔNG mở profile nào.
 */
export function buildExecutionMapping(
  profiles: readonly MappingProfileInput[],
  accounts: readonly GoogleAccountInput[]
): BuildMappingResult {
  const profileCount = profiles.length;
  const accountCount = accounts.length;

  if (profileCount === 0) {
    return {
      ok: false,
      code: 'NO_PROFILE',
      message: 'Chưa chọn profile nào.',
      profileCount,
      accountCount,
    };
  }
  if (accountCount === 0) {
    return {
      ok: false,
      code: 'NO_ACCOUNT',
      message: 'Chưa nhập tài khoản nào.',
      profileCount,
      accountCount,
    };
  }
  if (profileCount !== accountCount) {
    return {
      ok: false,
      code: 'COUNT_MISMATCH',
      message: formatCountMismatch(profileCount, accountCount),
      profileCount,
      accountCount,
      expected: 'equal-counts',
    };
  }

  const positionsById = new Map<string, number[]>();
  for (let i = 0; i < profiles.length; i++) {
    const id = (profiles[i].profileId || '').trim();
    const bucket = positionsById.get(id);
    if (bucket) bucket.push(i + 1);
    else positionsById.set(id, [i + 1]);
  }
  for (const [profileId, positions] of positionsById) {
    if (positions.length > 1) {
      return {
        ok: false,
        code: 'DUPLICATE_PROFILE',
        profileId,
        positions,
        message:
          `Profile "${profileId}" xuất hiện ${positions.length} lần (vị trí ${positions.join(', ')}). ` +
          `Mỗi profile chỉ được ghép với đúng một tài khoản.`,
      };
    }
  }

  const mapping: ExecutionMappingEntry[] = [];
  const secrets = new Map<string, ProfileAccountSecret>();

  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i];
    const account = accounts[i];
    const profileId = profile.profileId.trim();

    mapping.push(
      Object.freeze({
        index: i,
        profileId,
        identifier: (profile.identifier || profileId).trim(),
        profileName: (profile.profileName || profileId).trim(),
        email: account.email,
      })
    );
    secrets.set(profileId, {
      email: account.email,
      password: account.password,
      twoFactor: account.twoFactor,
    });
  }

  return { ok: true, mapping: Object.freeze(mapping), secrets };
}
