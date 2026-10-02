/**
 * Thu thập Channel ID YouTube của tài khoản ĐANG ĐĂNG NHẬP trong một profile.
 *
 * Nguyên tắc (giống `google-identity.ts`):
 *  - Đọc trạng thái THỰC của phiên đăng nhập, KHÔNG đăng nhập, KHÔNG click, KHÔNG mở cửa sổ mới.
 *  - Tín hiệu quyết định là CẤU TRÚC (URL `/channel/UC…`, khoá JSON `externalId`/`CHANNEL_ID`),
 *    KHÔNG phụ thuộc ngôn ngữ giao diện (profile có thể đang ở en/vi/zh-CN).
 *  - Không xác định được -> trả `ok:false` kèm lý do; KHÔNG BAO GIỜ đoán, KHÔNG BAO GIỜ giả thành công.
 *
 * Ít bước nhất trước: nếu tab đang ở `www.youtube.com` thì đọc link kênh bằng MỘT request
 * `/account` ngay trong trang (same-origin, cookie sẵn có) — không điều hướng, không click,
 * không đổi trạng thái tab người dùng đang xem. Chỉ khi cách đó không ra mới đi tiếp các tầng
 * điều hướng bên dưới.
 *
 * Chống báo lỗi oan khi mạng chậm (đo thực trên profile taothao 05/09):
 *  - Studio trả HTML sau ~0.7s và ĐÃ có `CHANNEL_ID` trong `ytcfg`, nhưng URL chỉ đổi thành
 *    `/channel/<id>` ở ~14s. Đọc một lần rồi kết luận => sai. Vì vậy mỗi tầng ĐỌC LẶP LẠI cho
 *    đến hết ngân sách thời gian, và tín hiệu HTML được ưu tiên ngang URL.
 *  - Điều hướng thất bại (timeout/mất mạng) KHÔNG kết luận ngay: trang vẫn được đọc tiếp vì
 *    nó có thể tải xong muộn.
 *  - Trang đăng nhập / tạo kênh chỉ được coi là kết luận khi TỒN TẠI LIÊN TỤC đủ lâu, tránh bắt
 *    nhầm một bước redirect trung gian.
 */

import type { Page } from 'playwright-core';
import { logger } from '../utils/logger.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Channel ID YouTube luôn là `UC` + 22 ký tự base64url. */
const CHANNEL_ID_BODY = '[0-9A-Za-z_-]{22}';
const CHANNEL_ID_IN_URL = new RegExp(`/channel/(UC${CHANNEL_ID_BODY})`);
const CHANNEL_ID_ANY = new RegExp(`UC${CHANNEL_ID_BODY}`);
/**
 * Khoá JSON mô tả CHÍNH kênh của phiên đang đăng nhập (không phải kênh gợi ý/đề xuất).
 * `CHANNEL_ID` là khoá trong `ytcfg` của YouTube Studio — có mặt NGAY khi HTML về, sớm hơn
 * nhiều so với lúc URL đổi thành `/channel/<id>`. Đây là tín hiệu chính khi mạng chậm.
 * Dùng CHUNG cho cả bản đọc HTML thuần (unit-test) và bản đọc trang thật (`page.evaluate`).
 */
export const SELF_CHANNEL_ID_PATTERN =
  `"(?:externalId|CHANNEL_ID|channelId)"\\s*:\\s*"(UC${CHANNEL_ID_BODY})"`;

const STUDIO_HOST = 'studio.youtube.com';
const STUDIO_URL = 'https://studio.youtube.com/';
const ACCOUNT_ADVANCED_URL = 'https://www.youtube.com/account_advanced';
const ACCOUNT_URL = 'https://www.youtube.com/account';

/**
 * Host cho phép fetch tương đối `/account`: `studio.youtube.com` là ORIGIN KHÁC nên
 * request từ đó sẽ bị CORS chặn -> chỉ đọc nền khi tab đang ở `www.youtube.com`.
 */
const WWW_YOUTUBE_HOSTS: Record<string, true> = {
  'www.youtube.com': true,
  'youtube.com': true,
  'm.youtube.com': true,
};
/** Link kênh trong HTML — chuỗi để truyền vào `page.evaluate` (regex chạy TRONG trang). */
const CHANNEL_URL_PATTERN = `youtube\\.com/channel/(UC${CHANNEL_ID_BODY})`;
/** Trần cho một lần đọc nền; hết hạn thì rơi xuống các tầng điều hướng như trước. */
const ACCOUNT_FETCH_TIMEOUT_MS = 12_000;

/** Ngân sách cho CẢ quá trình đọc (không phải cho một lần điều hướng). */
const DEFAULT_BUDGET_MS = 60_000;
const MIN_BUDGET_MS = 20_000;
const MAX_BUDGET_MS = 180_000;
/** Nhịp đọc lại trạng thái trang: đủ dày để bắt redirect, đủ thưa để không quấy trang. */
const POLL_INTERVAL_MS = 1_000;
/** Trang đăng nhập / tạo kênh phải tồn tại liên tục bấy lâu mới được coi là kết luận. */
const SIGNED_OUT_CONFIRM_MS = 8_000;
const NO_CHANNEL_CONFIRM_MS = 5_000;

/**
 * Nguồn đọc được Channel ID — ghi vào báo cáo để truy vết về sau.
 * `cache` = lấy từ kho `data/youtube-channels.json` của lần chạy trước, KHÔNG mở trình duyệt.
 */
export type YoutubeChannelSource =
  | 'open_tab'
  | 'account_fetch'
  | 'studio_url'
  | 'studio_config'
  | 'account_advanced'
  | 'account_page'
  | 'cache';

const SOURCE_LABEL: Record<YoutubeChannelSource, string> = {
  open_tab: 'tab Studio đang mở',
  account_fetch: 'link kênh trong trang account (đọc nền)',
  studio_url: 'URL Studio',
  studio_config: 'cấu hình trang Studio',
  account_advanced: 'trang cài đặt nâng cao',
  account_page: 'trang account',
  cache: 'kho Channel ID đã lưu',
};

/** Guard cho dữ liệu đọc từ đĩa/HTTP: chuỗi lạ KHÔNG được nhận là nguồn đọc hợp lệ. */
export function isYoutubeChannelSource(value: unknown): value is YoutubeChannelSource {
  return typeof value === 'string' && value in SOURCE_LABEL;
}

/**
 * Lý do KHÔNG lấy được Channel ID. Tách rõ từng trường hợp để người dùng biết phải xử lý gì.
 * `LOAD_FAILED` = trang chưa tải xong trong ngân sách (mạng chậm/bị chặn) -> CHƯA kết luận được
 * gì về kênh, chạy lại là hợp lý. `TAB_CLOSED` = tab/cửa sổ bị đóng giữa lúc đọc (người dùng đóng,
 * tab crash, provider tắt profile) -> cũng CHƯA kết luận gì, phải lấy lại tab sống rồi đọc lại.
 * `UNDETERMINED` = trang tải xong nhưng không thấy tín hiệu nào.
 */
export type YoutubeChannelFailure =
  | 'NOT_SIGNED_IN'
  | 'NO_CHANNEL'
  | 'LOAD_FAILED'
  | 'TAB_CLOSED'
  | 'UNDETERMINED';

export interface YoutubeChannelResult {
  ok: boolean;
  channelId?: string;
  source?: YoutubeChannelSource;
  reason?: YoutubeChannelFailure;
  message?: string;
}

export interface CollectYoutubeChannelOptions {
  /** Nhãn cho log (tên profile). KHÔNG dùng cho logic. */
  label?: string;
  /** Ngân sách thời gian cho TOÀN BỘ quá trình đọc, chia cho các tầng. */
  timeoutMs?: number;
}

/** Lấy Channel ID từ URL dạng `.../channel/UC…`. Thuần, dễ test. */
export function extractChannelIdFromUrl(url: string): string | null {
  const matched = CHANNEL_ID_IN_URL.exec(url || '');
  return matched ? matched[1] : null;
}

/**
 * Lấy Channel ID của CHÍNH phiên đăng nhập từ HTML, chỉ nhận khi id gắn với khoá JSON
 * `externalId` / `CHANNEL_ID` / `channelId` -> tránh bắt nhầm id của kênh đề xuất trong trang.
 */
export function extractSelfChannelIdFromHtml(html: string): string | null {
  if (!html) return null;
  const matched = new RegExp(SELF_CHANNEL_ID_PATTERN).exec(html);
  return matched ? matched[1] : null;
}

/** Đã bị đẩy về trang đăng nhập -> profile chưa có phiên Google hợp lệ. */
export function isSignedOutUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'accounts.google.com') return true;
    return parsed.pathname.startsWith('/signin');
  } catch {
    return false;
  }
}

/** Đã đăng nhập Google nhưng tài khoản chưa có kênh YouTube nào. */
export function isCreateChannelUrl(url: string): boolean {
  return /\/(create_channel|channel_switcher)/.test(url || '');
}

/** Chỉ Studio mới luôn hiển thị kênh CỦA CHÍNH phiên đăng nhập. */
export function isStudioChannelUrl(url: string): boolean {
  try {
    return new URL(url).hostname === STUDIO_HOST && CHANNEL_ID_IN_URL.test(url);
  } catch {
    return false;
  }
}

/**
 * Chọn Channel ID từ URL các tab ĐANG MỞ của chính profile — không điều hướng, không tốn mạng.
 * Chỉ nhận tab Studio (`www.youtube.com/channel/...` có thể là kênh người khác đang xem).
 * Nhiều id Studio khác nhau (tài khoản nhiều kênh) -> KHÔNG đoán, trả null để đi tầng sau.
 */
export function pickStudioChannelIdFromTabs(urls: readonly string[]): string | null {
  const ids = new Set<string>();
  for (const url of urls) {
    if (!isStudioChannelUrl(url)) continue;
    const id = extractChannelIdFromUrl(url);
    if (id) ids.add(id);
  }
  return ids.size === 1 ? [...ids][0] : null;
}

/** Những gì đã QUAN SÁT được trong lúc đọc — dữ liệu duy nhất dùng để phân loại thất bại. */
export interface ChannelFailureObservations {
  /** Đã thấy trang đăng nhập tồn tại liên tục đủ lâu. */
  signedOutConfirmed: boolean;
  /** Đã thấy trang tạo kênh tồn tại liên tục đủ lâu. */
  noChannelConfirmed: boolean;
  /** Có ít nhất một lần điều hướng không hoàn tất. */
  navFailed: boolean;
  /** Đã đọc được một DOM có nội dung (chứng tỏ trang thật sự tải). */
  documentSeen: boolean;
  /** Tab/cửa sổ đã bị đóng giữa lúc đọc -> mọi quan sát khác không còn giá trị kết luận. */
  tabClosed: boolean;
  /** Ngân sách đã dùng, chỉ để viết thông báo. */
  budgetMs: number;
}

/**
 * Quy tín hiệu quan sát -> lý do thất bại. Thuần (pure) để unit-test được: đây chính là chỗ
 * trước đây kết luận sai — mạng chậm bị gán `UNDETERMINED` như thể giao diện lạ.
 */
export function classifyChannelFailure(
  obs: ChannelFailureObservations
): { reason: YoutubeChannelFailure; message: string } {
  if (obs.signedOutConfirmed) {
    return {
      reason: 'NOT_SIGNED_IN',
      message:
        'Profile chưa đăng nhập Google/YouTube (bị chuyển về trang đăng nhập) - cần đăng nhập thủ công rồi chạy lại.',
    };
  }
  if (obs.noChannelConfirmed) {
    return {
      reason: 'NO_CHANNEL',
      message: 'Tài khoản đã đăng nhập nhưng chưa tạo kênh YouTube nào.',
    };
  }
  // Tab chết là lý do CƠ HỌC, phải xét trước mạng chậm: quan sát dở dang không kết luận được gì.
  if (obs.tabClosed) {
    return {
      reason: 'TAB_CLOSED',
      message:
        'Tab/cửa sổ của profile bị đóng giữa lúc đọc Channel ID - CHƯA kết luận được trạng thái ' +
        'kênh; hệ thống sẽ mở lại tab và đọc lại.',
    };
  }
  const seconds = Math.round(obs.budgetMs / 1000);
  if (obs.navFailed || !obs.documentSeen) {
    return {
      reason: 'LOAD_FAILED',
      message:
        `Trang YouTube không tải xong trong ${seconds}s (mạng chậm hoặc bị chặn) - CHƯA kết luận ` +
        'được trạng thái kênh, cửa sổ được giữ mở; hãy chạy lại riêng profile này.',
    };
  }
  return {
    reason: 'UNDETERMINED',
    message:
      `Trang đã tải nhưng không thấy Channel ID trong ${seconds}s (giao diện lạ hoặc bị chặn xác ` +
      'minh) - cửa sổ được giữ mở để kiểm tra thủ công.',
  };
}

/** Một lần đọc trạng thái trang. Regex chạy TRONG trang -> không chuyển 5MB HTML về Node. */
interface LivePageProbe {
  url: string;
  selfId: string | null;
  docLength: number;
}

/** Quan sát tích luỹ + cờ dừng sớm khi đã có kết luận chắc chắn. */
interface CollectObservations extends ChannelFailureObservations {
  terminal: boolean;
}

async function probeLivePage(page: Page): Promise<LivePageProbe | null> {
  if (page.isClosed()) return null;
  const url = page.url();
  const read = await page
    .evaluate((pattern: string) => {
      const html = document.documentElement?.innerHTML ?? '';
      const matched = new RegExp(pattern).exec(html);
      return { selfId: matched ? matched[1] : null, docLength: html.length };
    }, SELF_CHANNEL_ID_PATTERN)
    .catch(() => null);
  return { url, selfId: read?.selfId ?? null, docLength: read?.docLength ?? 0 };
}

/**
 * Lấy link kênh của CHÍNH phiên đăng nhập bằng MỘT request `/account` ngay trong tab
 * (same-origin, dùng cookie sẵn có): KHÔNG điều hướng, KHÔNG click, không đổi trạng thái
 * tab người dùng đang xem — ít bước nhất trong tất cả các tầng.
 *
 * Đo thực 05/09 trên profile AdsPower `k1glrh54`: `/account` trả đúng MỘT link
 * `youtube.com/channel/UC…` và trùng id đọc từ `ytcfg` của Studio; lần gọi nguội mất 23s
 * (trang chủ đang tải), lần nóng 0.7s. Nhiều id khác nhau -> KHÔNG đoán, trả `null`.
 */
export async function readSelfChannelViaAccountFetch(
  page: Page,
  timeoutMs: number = ACCOUNT_FETCH_TIMEOUT_MS
): Promise<string | null> {
  if (page.isClosed()) return null;
  let host = '';
  try {
    host = new URL(page.url()).hostname;
  } catch {
    return null; // about:blank / URL rỗng -> chưa ở YouTube.
  }
  if (!WWW_YOUTUBE_HOSTS[host]) return null;

  return page
    .evaluate(
      async (arg: { keyedPattern: string; hrefPattern: string; budgetMs: number }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), arg.budgetMs);
        try {
          const res = await fetch('/account', { credentials: 'include', signal: controller.signal });
          if (!res.ok) return null;
          const html = await res.text();
          const keyed = new RegExp(arg.keyedPattern).exec(html);
          if (keyed) return keyed[1];
          const hrefRe = new RegExp(arg.hrefPattern, 'g');
          const ids = new Set<string>();
          for (let m = hrefRe.exec(html); m; m = hrefRe.exec(html)) ids.add(m[1]);
          return ids.size === 1 ? Array.from(ids)[0] : null;
        } finally {
          clearTimeout(timer);
        }
      },
      {
        keyedPattern: SELF_CHANNEL_ID_PATTERN,
        hrefPattern: CHANNEL_URL_PATTERN,
        budgetMs: timeoutMs,
      }
    )
    .catch(() => null); // Bị chặn / mất mạng / trang chuyển hướng -> để tầng sau lo.
}

/**
 * Điều hướng tới `target` NẾU chưa ở đó. Đang ở đúng trang (dù còn đang tải) thì KHÔNG goto lại
 * để không reset một trang sắp xong. `commit` = trả về ngay khi điều hướng được chấp nhận; phần
 * tải chậm để vòng đọc lo, nên mạng chậm không còn biến thành lỗi.
 */
async function navigateIfNeeded(
  page: Page,
  target: string,
  alreadyThere: (url: string) => boolean,
  until: number,
  obs: CollectObservations,
  label: string
): Promise<void> {
  if (page.isClosed()) {
    obs.tabClosed = true;
    return;
  }
  if (alreadyThere(page.url())) return;
  const timeout = Math.max(5_000, until - Date.now());
  try {
    await page.goto(target, { waitUntil: 'commit', timeout });
  } catch (err) {
    obs.navFailed = true;
    const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
    logger.warn(`${label}[YouTube] Điều hướng ${target} chưa hoàn tất (${detail}) - vẫn đọc tiếp trang.`);
  }
}

/**
 * Đọc lặp lại một tầng cho tới `until`. Tín hiệu kết luận (đăng nhập / tạo kênh) phải TỒN TẠI
 * LIÊN TỤC đủ lâu mới bật `terminal`, nhờ vậy một bước redirect trung gian không bị hiểu sai.
 */
async function pollTier(
  page: Page,
  until: number,
  obs: CollectObservations,
  read: (probe: LivePageProbe) => Promise<YoutubeChannelResult | null> | YoutubeChannelResult | null
): Promise<YoutubeChannelResult | null> {
  let signedOutSince: number | null = null;
  let noChannelSince: number | null = null;

  for (;;) {
    const probe = await probeLivePage(page);
    if (!probe) {
      // Tab đã đóng giữa lúc đọc: dừng tầng này và ghi nhận lý do CƠ HỌC, không phải "mạng chậm".
      obs.tabClosed = true;
      obs.terminal = true;
      return null;
    }
    if (probe.docLength > 0) obs.documentSeen = true;

    const hit = await read(probe);
    if (hit) return hit;

    if (isSignedOutUrl(probe.url)) {
      signedOutSince ??= Date.now();
      if (Date.now() - signedOutSince >= SIGNED_OUT_CONFIRM_MS) {
        obs.signedOutConfirmed = true;
        obs.terminal = true;
        return null;
      }
    } else {
      signedOutSince = null;
    }

    if (isCreateChannelUrl(probe.url)) {
      noChannelSince ??= Date.now();
      if (Date.now() - noChannelSince >= NO_CHANNEL_CONFIRM_MS) {
        obs.noChannelConfirmed = true;
        obs.terminal = true;
        return null;
      }
    } else {
      noChannelSince = null;
    }

    if (Date.now() + POLL_INTERVAL_MS >= until) return null;
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Đọc Channel ID của kênh đang đăng nhập trong `page`. Dừng ngay khi có kết quả.
 *   0. Tab Studio ĐANG MỞ của chính profile (không điều hướng, không tốn mạng)
 *   0.5 `/account` đọc NGAY TRONG tab bằng fetch same-origin (không điều hướng, không click)
 *   1. `studio.youtube.com` — `ytcfg.CHANNEL_ID` trong HTML hoặc URL `/channel/<id>` (ngân sách lớn nhất)
 *   2. `/account_advanced` — trang in Channel ID của chính tài khoản
 *   3. `/account` — điều hướng thật rồi đọc thẻ liên kết trỏ tới `/channel/<id>`
 * Không thấy gì -> `classifyChannelFailure` phân biệt mạng chậm với giao diện lạ.
 */
export async function collectYoutubeChannelId(
  page: Page,
  opts: CollectYoutubeChannelOptions = {}
): Promise<YoutubeChannelResult> {
  const label = opts.label ? `[${opts.label}] ` : '';
  const budgetMs = Math.max(MIN_BUDGET_MS, Math.min(opts.timeoutMs ?? DEFAULT_BUDGET_MS, MAX_BUDGET_MS));
  const deadline = Date.now() + budgetMs;

  if (!page || page.isClosed()) {
    return {
      ok: false,
      reason: 'TAB_CLOSED',
      message:
        'Tab của profile đã bị đóng trước khi đọc Channel ID - CHƯA kết luận được trạng thái kênh; ' +
        'hệ thống sẽ mở lại tab và đọc lại.',
    };
  }

  const obs: CollectObservations = {
    signedOutConfirmed: false,
    noChannelConfirmed: false,
    navFailed: false,
    documentSeen: false,
    tabClosed: false,
    budgetMs,
    terminal: false,
  };

  const found = (channelId: string, source: YoutubeChannelSource): YoutubeChannelResult => {
    logger.info(`${label}[YouTube] Channel ID = ${channelId} (nguồn: ${SOURCE_LABEL[source]}).`);
    return { ok: true, channelId, source };
  };

  // ── Tầng 0: tab Studio đang mở ─────────────────────────────────────────────
  const openTabUrls = [page.url()];
  try {
    for (const sibling of page.context().pages()) {
      if (!sibling.isClosed()) openTabUrls.push(sibling.url());
    }
  } catch {
    // Context chưa sẵn sàng -> chỉ dùng tab hiện tại.
  }
  const fromTabs = pickStudioChannelIdFromTabs(openTabUrls);
  if (fromTabs) return found(fromTabs, 'open_tab');

  // ── Tầng 0.5: đọc nền trong tab hiện tại — không điều hướng, không click ────
  const fromAccountFetch = await readSelfChannelViaAccountFetch(
    page,
    Math.max(3_000, Math.min(ACCOUNT_FETCH_TIMEOUT_MS, deadline - Date.now()))
  );
  if (fromAccountFetch) return found(fromAccountFetch, 'account_fetch');

  // ── Tầng 1: YouTube Studio (nguồn duy nhất chắc chắn là kênh của CHÍNH phiên) ──
  const studioUntil = Math.min(deadline, Date.now() + Math.floor(budgetMs * 0.6));
  await navigateIfNeeded(page, STUDIO_URL, url => url.startsWith(STUDIO_URL), studioUntil, obs, label);
  const studioHit = await pollTier(page, studioUntil, obs, probe => {
    const fromUrl = extractChannelIdFromUrl(probe.url);
    if (fromUrl) return found(fromUrl, 'studio_url');
    // HTML có `CHANNEL_ID` sớm hơn URL rất nhiều -> đây là tín hiệu cứu mạng khi mạng chậm.
    if (probe.selfId) return found(probe.selfId, 'studio_config');
    return null;
  });
  if (studioHit) return studioHit;
  if (obs.terminal) return { ok: false, ...classifyChannelFailure(obs) };

  // ── Tầng 2: trang cài đặt nâng cao của tài khoản ───────────────────────────
  const advUntil = Math.min(deadline, Date.now() + Math.max(8_000, Math.floor((deadline - Date.now()) * 0.5)));
  await navigateIfNeeded(page, ACCOUNT_ADVANCED_URL, url => url.startsWith(ACCOUNT_ADVANCED_URL), advUntil, obs, label);
  const advHit = await pollTier(page, advUntil, obs, async probe => {
    if (probe.selfId) return found(probe.selfId, 'account_advanced');
    // Trang này chỉ in DUY NHẤT Channel ID của tài khoản đang đăng nhập -> quét text an toàn.
    const bodyText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    const fromText = CHANNEL_ID_ANY.exec(bodyText)?.[0] ?? null;
    return fromText ? found(fromText, 'account_advanced') : null;
  });
  if (advHit) return advHit;
  if (obs.terminal) return { ok: false, ...classifyChannelFailure(obs) };

  // ── Tầng 3: liên kết kênh trong trang tài khoản ────────────────────────────
  await navigateIfNeeded(page, ACCOUNT_URL, url => url.startsWith(ACCOUNT_URL), deadline, obs, label);
  const accountHit = await pollTier(page, deadline, obs, async probe => {
    const href = await page
      .evaluate(() => {
        const anchor = document.querySelector('a[href*="/channel/UC"]') as HTMLAnchorElement | null;
        return anchor?.href ?? '';
      })
      .catch(() => '');
    const fromHref = extractChannelIdFromUrl(href);
    if (fromHref) return found(fromHref, 'account_page');
    return probe.selfId ? found(probe.selfId, 'account_page') : null;
  });
  if (accountHit) return accountHit;

  return { ok: false, ...classifyChannelFailure(obs) };
}
