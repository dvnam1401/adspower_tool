/**
 * Google identity verification — xác nhận tài khoản ĐANG đăng nhập ĐÚNG là tài
 * khoản đã được gán cho profile đó.
 *
 * TẠI SAO BẮT BUỘC: `isRealLoggedIn()` chỉ chứng minh "có ai đó đang đăng nhập"
 * (cookie `__Secure-1PSID`/`SID`/`SAPISID`). Nếu profile đã sẵn đăng nhập một
 * Gmail KHÁC, luồng login sẽ đi nhánh "already logged in" và báo SUCCESS mà
 * KHÔNG hề nhập email của ta -> sai tài khoản nhưng vẫn xanh. Gmail là khoá
 * nhận dạng cứng, nên bước này chặn đúng lỗ đó.
 *
 * Thiết kế: phần so sánh là PURE (unit-test được). Phần đọc DOM/HTTP là
 * best-effort nhiều tầng và KHÔNG BAO GIỜ tự tuyên bố thành công — nó chỉ trả
 * dữ liệu; `google-login.ts` mới quyết định trạng thái cuối.
 *
 * SECURITY: module này KHÔNG log. Email chỉ được log ở phía caller sau `maskEmail`.
 */

import { Page } from 'playwright-core';

export type IdentitySource = 'aria_label' | 'list_accounts' | 'page_html' | 'none';

export interface SignedInIdentity {
  /** Email đọc được, đã lowercase. null = không xác định được. */
  email: string | null;
  source: IdentitySource;
  /** Mọi email ứng viên đọc được (đã chuẩn hoá) — phục vụ chẩn đoán đa tài khoản. */
  candidates: string[];
}

export type IdentityVerdict =
  | { verdict: 'match'; actual: string; source: IdentitySource }
  | { verdict: 'mismatch'; actual: string; source: IdentitySource }
  | { verdict: 'undetermined'; actual: null; source: IdentitySource };

const EMAIL_RE = /[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9.-]{2,}/gi;

/** Domain kỹ thuật của Google xuất hiện trong HTML nhưng không phải tài khoản người dùng. */
const NON_ACCOUNT_DOMAINS = [
  'gstatic.com',
  'googleusercontent.com',
  'googleapis.com',
  'google-analytics.com',
  'doubleclick.net',
  'sentry.io',
  'example.com',
  'gmail.example',
];

/** Gmail bỏ qua dấu chấm và phần `+tag`; `googlemail.com` là alias của `gmail.com`. */
export function normalizeGoogleEmail(raw: string | null | undefined): string | null {
  const value = (raw || '').trim().toLowerCase();
  if (!value) return null;
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return null;

  let local = value.slice(0, at);
  const domain = value.slice(at + 1) === 'googlemail.com' ? 'gmail.com' : value.slice(at + 1);

  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  if (!local) return null;

  return `${local}@${domain}`;
}

/** So sánh danh tính theo quy tắc Gmail. */
export function isSameGoogleAccount(expected: string, actual: string): boolean {
  const a = normalizeGoogleEmail(expected);
  const b = normalizeGoogleEmail(actual);
  return Boolean(a && b && a === b);
}

/** Lọc email "thật" khỏi rác kỹ thuật trong HTML. */
export function extractAccountEmails(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(EMAIL_RE)) {
    const email = match[0].toLowerCase().replace(/\.$/, '');
    const domain = email.slice(email.lastIndexOf('@') + 1);
    if (NON_ACCOUNT_DOMAINS.some(d => domain === d || domain.endsWith(`.${d}`))) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

/**
 * Parse `https://accounts.google.com/ListAccounts?json=standard`.
 * Shape thực tế: `["gaia.l.a.r",[["gaia.l.a",1,"Name","email@x",...], ...]]`.
 * Trả về theo đúng thứ tự Google liệt kê (index 0 = tài khoản mặc định).
 */
export function parseListAccountsResponse(body: string): string[] {
  const cleaned = (body || '').replace(/^\)\]\}'\s*/, '').trim();
  if (!cleaned) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return extractAccountEmails(cleaned);
  }

  const emails: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      const trimmed = node.trim().toLowerCase();
      if (trimmed.includes('@')) {
        const found = extractAccountEmails(trimmed);
        // Chỉ nhận field mà TOÀN BỘ giá trị là một email (field email của ListAccounts).
        if (found.length === 1 && found[0] === trimmed) emails.push(found[0]);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
    }
  };
  walk(parsed);

  const seen = new Set<string>();
  return emails.filter(e => (seen.has(e) ? false : (seen.add(e), true)));
}

/**
 * Chọn email khớp mong đợi nếu có (trường hợp profile đăng nhập nhiều tài khoản
 * và tài khoản của ta là một trong số đó -> KHÔNG coi là mismatch), ngược lại
 * lấy ứng viên đầu tiên (tài khoản mặc định của phiên).
 */
export function pickIdentity(candidates: string[], expectedEmail: string): string | null {
  if (candidates.length === 0) return null;
  const matched = candidates.find(c => isSameGoogleAccount(expectedEmail, c));
  return matched ?? candidates[0];
}

/**
 * Đọc email đang đăng nhập từ trang hiện tại. Best-effort 3 tầng, dừng ở tầng
 * đầu tiên có kết quả. KHÔNG điều hướng, KHÔNG click — caller phải đưa page về
 * một origin Google (thường là `myaccount.google.com` sau `verifyViaMyAccount`).
 */
export async function readSignedInIdentity(page: Page, expectedEmail: string): Promise<SignedInIdentity> {
  if (!page || page.isClosed()) return { email: null, source: 'none', candidates: [] };

  // Tầng 1: aria-label / data-email của nút chuyển tài khoản.
  try {
    const labels = await page.evaluate<string[]>(() => {
      const values: string[] = [];
      const nodes = document.querySelectorAll('[aria-label],[data-email],[data-identifier],[title]');
      for (const node of Array.from(nodes)) {
        for (const attr of ['aria-label', 'data-email', 'data-identifier', 'title']) {
          const value = node.getAttribute(attr);
          if (value && value.includes('@')) values.push(value);
        }
      }
      return values;
    });
    const candidates = extractAccountEmails(labels.join('\n'));
    const picked = pickIdentity(candidates, expectedEmail);
    if (picked) return { email: picked, source: 'aria_label', candidates };
  } catch {
    /* trang có thể đang điều hướng — rơi xuống tầng sau */
  }

  // Tầng 2: endpoint ListAccounts (dùng cookie của chính context).
  try {
    const response = await page
      .context()
      .request.get('https://accounts.google.com/ListAccounts?listPages=0&json=standard', {
        timeout: 8000,
        failOnStatusCode: false,
      });
    if (response.ok()) {
      const candidates = parseListAccountsResponse(await response.text());
      const picked = pickIdentity(candidates, expectedEmail);
      if (picked) return { email: picked, source: 'list_accounts', candidates };
    }
  } catch {
    /* offline / bị chặn — rơi xuống tầng sau */
  }

  // Tầng 3: quét HTML trang (myaccount nhúng email trong dữ liệu khởi tạo).
  try {
    const html = await page.content();
    const candidates = extractAccountEmails(html);
    const picked = pickIdentity(candidates, expectedEmail);
    if (picked) return { email: picked, source: 'page_html', candidates };
  } catch {
    /* bỏ qua */
  }

  return { email: null, source: 'none', candidates: [] };
}

/** Kết luận danh tính. `undetermined` KHÔNG được coi là thành công. */
export async function verifySignedInIdentity(page: Page, expectedEmail: string): Promise<IdentityVerdict> {
  const identity = await readSignedInIdentity(page, expectedEmail);
  if (!identity.email) return { verdict: 'undetermined', actual: null, source: identity.source };
  return isSameGoogleAccount(expectedEmail, identity.email)
    ? { verdict: 'match', actual: identity.email, source: identity.source }
    : { verdict: 'mismatch', actual: identity.email, source: identity.source };
}
