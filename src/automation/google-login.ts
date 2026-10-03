import { Page, Locator } from 'playwright-core';
import { cdpManager } from '../dom/cdp.js';
import { logger } from '../utils/logger.js';
import { adsPower2FAProvider } from './adspower-2fa.js';
import { resolveTwoFactorCode } from './google-2fa.js';
import { verifySignedInIdentity } from './google-identity.js';
import { GoogleLoginCredentials, GoogleLoginResult, GoogleLoginState } from './google-login.types.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const ADSPOWER_HOST = 'start.adspower.net';

/**
 * Mask an email address so it is safe to log (local part reduced to its first
 * two characters). Pure and deterministic. NEVER emits the full address.
 */
export function maskEmail(email: string): string {
  if (!email) return '';
  const at = email.indexOf('@');
  if (at <= 0) {
    return email.length <= 1 ? '*' : `${email[0]}***`;
  }
  const local = email.slice(0, at);
  const domain = email.slice(at); // keeps leading '@'
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***${domain}`;
}

/**
 * Pure, browser-free classifier for Google anti-automation / security
 * interstitials. Maps a page URL + visible text blob to the login state that
 * should be reported, or null when no security challenge is detected.
 *
 * NEVER attempts to bypass or auto-solve anything; it only labels the state.
 */
export function classifyGoogleChallenge(currentUrl: string, domText: string): GoogleLoginState | null {
  const url = (currentUrl || '').toLowerCase();
  const text = (domText || '').toLowerCase();

  // Hard security blocks a human must inspect — never automatable.
  if (
    text.includes('this browser or app may not be secure') ||
    text.includes('couldn’t sign you in') ||
    text.includes("couldn't sign you in") ||
    url.includes('signin/rejected')
  ) {
    return 'NEEDS_HUMAN_REVIEW';
  }

  // CAPTCHA / reCAPTCHA gate.
  if (url.includes('challenge/recaptcha') || text.includes('recaptcha') || text.includes('captcha')) {
    return 'VERIFICATION_REQUIRED';
  }

  // Normal login sub-steps that also live under /signin/challenge/ but are
  // NOT security interstitials: password entry (`pwd`) and authenticator TOTP
  // (`totp`). Google routes these through /v3/signin/challenge/<step>, so a
  // blunt `/challenge/` URL match misclassifies the ordinary password/2FA
  // screens as a human-review challenge. They have dedicated states, so they
  // must fall through to those handlers instead of triggering a STOP.
  const isNormalLoginStep = /\/(?:signin\/)?challenge\/(?:pwd|totp)\b/.test(url);

  // "Verify it's you" / device / phone / recovery challenges.
  if (
    (!isNormalLoginStep && (url.includes('/challenge/') || url.includes('/signin/challenge'))) ||
    text.includes("verify it's you") ||
    text.includes('verify it’s you') ||
    text.includes('confirm your recovery') ||
    text.includes('confirm the phone number') ||
    text.includes('enter a phone number') ||
    text.includes('get a verification code at')
  ) {
    return 'VERIFICATION_REQUIRED';
  }

  return null;
}

/** Google account/login hosts that a work tab is allowed to be reused for. */
export function isGoogleAccountUrl(url: string): boolean {
  const u = (url || '').toLowerCase();
  return u.includes('accounts.google.com') || u.includes('myaccount.google.com');
}

/** Blank / new-tab pages that are safe to repurpose as a work tab. */
export function isBlankUrl(url: string): boolean {
  const u = (url || '').trim().toLowerCase();
  return (
    u === '' ||
    u === 'about:blank' ||
    u === 'about:newtab' ||
    u.startsWith('chrome://newtab')
  );
}

/** Redact any email-like substring so URLs/titles are safe to log. */
export function redactEmails(text: string): string {
  return (text || '').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, m => maskEmail(m));
}

/**
 * Rank a Google URL so that, given several open Google tabs, we reuse the one
 * closest to an active sign-in flow (accounts.google.com/v3/signin) rather than
 * an arbitrary account page. Non-Google URLs score -1.
 */
export function scoreGoogleUrl(url: string): number {
  const u = (url || '').toLowerCase();
  if (!isGoogleAccountUrl(u)) return -1;
  let score = 0;
  if (u.includes('accounts.google.com')) score += 100;
  else if (u.includes('myaccount.google.com')) score += 40;
  if (u.includes('/v3/signin') || u.includes('/signin')) score += 20;
  if (u.includes('/challenge/')) score += 5;
  return score;
}

/** A page's URL paired with the browser windowId that owns it. */
export interface PageWindowInfo {
  url: string;
  windowId: number;
}

/** Decision produced by {@link selectReusableGooglePage}. */
export type GooglePageSelection =
  | { action: 'reuse'; index: number; reason: 'google' | 'blank' }
  | { action: 'create' }
  | { action: 'mismatch' };

/** Outcome of resolving the Google work tab inside the session window. */
export type ReusableGooglePage =
  | { ok: true; page: Page; created: boolean; windowId: number; pageId: string }
  | { ok: false; reason: 'no_pages' | 'mismatch' };

/**
 * Pure, deterministic tab picker enforcing SINGLE-WINDOW + REUSE-FIRST.
 *
 * Only pages living in `sessionWindowId` are considered; the AdsPower start tab
 * is never reusable. Priority:
 *   1. an existing Google tab (best sign-in match wins) → reuse,
 *   2. else a blank/new-tab page → reuse,
 *   3. else signal to create exactly one new tab in the same window.
 * If NO page lives in the session window, returns `mismatch` (never opens a new
 * window to "fix" it). Returned `index` refers to the original `pages` array.
 */
export function selectReusableGooglePage(
  pages: PageWindowInfo[],
  sessionWindowId: number
): GooglePageSelection {
  const sameWindow = pages
    .map((p, index) => ({ p, index }))
    .filter(({ p }) => p.windowId === sessionWindowId);

  if (sameWindow.length === 0) {
    return { action: 'mismatch' };
  }

  const usable = sameWindow.filter(({ p }) => !(p.url || '').includes(ADSPOWER_HOST));

  // Priority 1: reuse the best-matching existing Google tab.
  let bestGoogle: { index: number; score: number } | null = null;
  for (const { p, index } of usable) {
    if (!isGoogleAccountUrl(p.url)) continue;
    const score = scoreGoogleUrl(p.url);
    if (!bestGoogle || score > bestGoogle.score) {
      bestGoogle = { index, score };
    }
  }
  if (bestGoogle) return { action: 'reuse', index: bestGoogle.index, reason: 'google' };

  // Priority 2: reuse a blank / new-tab page.
  const blank = usable.find(({ p }) => isBlankUrl(p.url));
  if (blank) return { action: 'reuse', index: blank.index, reason: 'blank' };

  // Priority 3: no reusable tab — create exactly one in the same window.
  return { action: 'create' };
}

export class GoogleLoginAutomation {
  /**
   * Safe visibility probe that never throws when the page/context closes.
   */
  private async safeIsVisible(locator: Locator, timeoutMs: number = 1000): Promise<boolean> {
    try {
      return await locator.isVisible({ timeout: timeoutMs }).catch(() => false);
    } catch {
      return false;
    }
  }

  /**
   * Safe click that never throws.
   */
  private async safeClick(locator: Locator, timeoutMs: number = 3000): Promise<boolean> {
    try {
      await locator.click({ force: true, timeout: timeoutMs }).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  private isAdsPowerUrl(url: string): boolean {
    return (url || '').includes(ADSPOWER_HOST);
  }

  private buildResult(
    success: boolean,
    status: string,
    state: GoogleLoginState,
    message: string,
    currentUrl: string,
    profileId: string,
    profileName?: string,
    twoFactorUsed?: boolean
  ): GoogleLoginResult {
    return { success, status, state, message, currentUrl, profileId, profileName, twoFactorUsed };
  }

  /**
   * Universal popup / overlay dismiss sentinel (cookie banners, one-tap, etc.).
   */
  public async dismissAllKnownPopups(page: Page): Promise<void> {
    if (!page || page.isClosed()) return;

    await page.keyboard.press('Escape').catch(() => {});

    const dismissScript = `(function() {
      var buttons = Array.from(document.querySelectorAll('button, div[role="button"], a, span'));
      var dismissTexts = [
        'dismiss', 'bỏ qua', 'cancel', 'huỷ', 'hủy', 'close', 'đóng',
        'not now', 'no thanks', 'không phải bây giờ', 'lúc khác',
        'i agree', 'accept all', 'reject all', 'got it', 'ok'
      ];
      for (var i = 0; i < buttons.length; i++) {
        var b = buttons[i];
        var t = (b.innerText || b.textContent || b.getAttribute('aria-label') || '').toLowerCase().trim();
        if (dismissTexts.indexOf(t) !== -1) {
          try {
            b.click();
            b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          } catch (e) {}
        }
      }
    })()`;

    await page.evaluate(dismissScript).catch(() => {});
    await sleep(200);
  }

  /**
   * Click the appropriate "Next" / "Continue" control, falling back to Enter.
   */
  private async clickNext(page: Page): Promise<void> {
    if (!page || page.isClosed()) return;
    const nextSelectors = [
      '#identifierNext',
      '#passwordNext',
      '#totpNext',
      'button:has-text("Next")',
      'button:has-text("Tiếp theo")',
      'button:has-text("Continue")',
    ];
    for (const sel of nextSelectors) {
      const btn = page.locator(sel).first();
      if (await this.safeIsVisible(btn, 500)) {
        await this.safeClick(btn, 2000);
        return;
      }
    }
    await page.keyboard.press('Enter').catch(() => {});
  }

  /**
   * Return the name of a present Google session cookie, or null. NEVER returns
   * the cookie value (it is session-sensitive).
   */
  private async getSessionCookie(page: Page): Promise<string | null> {
    if (!page || page.isClosed()) return null;
    try {
      const cookies = await page.context().cookies([
        'https://myaccount.google.com',
        'https://accounts.google.com',
        'https://www.google.com',
      ]);
      const sessionNames = ['__Secure-1PSID', 'SID', 'SAPISID'];
      const found = cookies.find(c => sessionNames.includes(c.name) && !!c.value);
      return found ? found.name : null;
    } catch {
      return null;
    }
  }

  /**
   * Authoritative verification: land on myaccount.google.com without being
   * bounced back to a sign-in / challenge screen.
   */
  private async verifyViaMyAccount(page: Page): Promise<boolean> {
    if (!page || page.isClosed()) return false;
    try {
      logger.info('[GoogleLoginDetector] Điều hướng myaccount.google.com để xác minh phiên...');
      await page
        .goto('https://myaccount.google.com/', { waitUntil: 'domcontentloaded', timeout: 20000 })
        .catch(() => {});
      await sleep(1500);
      if (page.isClosed()) return false;
      const finalUrl = page.url();

      // Bounced back to sign-in / challenge => NOT logged in.
      if (/accounts\.google\.com\/(v3\/)?signin|servicelogin|\/signin\/|\/challenge\//i.test(finalUrl)) {
        return false;
      }
      // A sign-in form still visible => NOT logged in.
      const loginForm = page.locator('input[type="email"], input[type="password"], #identifierId').first();
      if (await this.safeIsVisible(loginForm, 800)) return false;

      return finalUrl.includes('myaccount.google.com');
    } catch {
      return false;
    }
  }

  /**
   * Sole source of truth for "is this Google account genuinely logged in".
   * Requires BOTH a Google session cookie AND a confirmed myaccount landing.
   * Accepts any Page-like object so it can be unit tested with a mock.
   */
  public async isRealLoggedIn(page: Page): Promise<boolean> {
    if (!page || page.isClosed()) return false;
    let url = '';
    try {
      url = page.url();
    } catch {
      return false;
    }

    // Absolute negative: a sign-in form is on screen.
    const signInIndicators = [
      'input[type="email"]#identifierId',
      '#identifierId',
      'input[type="password"][name="Passwd"]',
    ];
    for (const sel of signInIndicators) {
      if (page.isClosed()) return false;
      if (await this.safeIsVisible(page.locator(sel).first(), 600)) {
        return false;
      }
    }

    // Mid sign-in (no session cookie yet) => not logged in; do NOT navigate away.
    const cookie = await this.getSessionCookie(page);
    if (!cookie) return false;

    // Avoid re-verifying if we are already sitting on a confirmed account page.
    if (url.includes('myaccount.google.com') && !/\/signin|\/challenge\//i.test(url)) {
      return true;
    }

    return await this.verifyViaMyAccount(page);
  }

  /**
   * Resolve the session window: the browser windowId that owns the AdsPower
   * start tab, or — if that tab is absent — the first existing page. All Google
   * work is pinned to this windowId. Read-only; never creates windows/tabs.
   */
  private async resolveSessionWindow(
    profileId: string
  ): Promise<{ windowId: number; targetId: string } | null> {
    const pages = cdpManager.getPages(profileId);
    if (!pages.length) return null;
    const anchor =
      pages.find(p => !p.isClosed() && this.isAdsPowerUrl(p.url())) ||
      pages.find(p => !p.isClosed()) ||
      pages[0];
    try {
      return await cdpManager.getPageWindow(anchor);
    } catch {
      return null;
    }
  }

  /**
   * Count distinct browser windows and live pages for the profile, plus a
   * per-page (windowId, targetId, url, title) breakdown. Used for the
   * WINDOWS/PAGES BEFORE-vs-AFTER invariant. Read-only.
   */
  private async captureWindowSnapshot(profileId: string): Promise<{
    windowCount: number;
    pageCount: number;
    pages: Array<{ windowId: number; targetId: string; url: string; title: string }>;
  }> {
    const pages = cdpManager.getPages(profileId);
    const windowIds = new Set<number>();
    const details: Array<{ windowId: number; targetId: string; url: string; title: string }> = [];
    for (const p of pages) {
      if (p.isClosed()) continue;
      let windowId = -1;
      let targetId = '';
      try {
        const w = await cdpManager.getPageWindow(p);
        windowId = w.windowId;
        targetId = w.targetId;
      } catch {}
      let url = '';
      try {
        url = p.url();
      } catch {}
      let title = '';
      try {
        title = await p.title();
      } catch {}
      windowIds.add(windowId);
      details.push({ windowId, targetId, url: redactEmails(url), title: redactEmails(title) });
    }
    return { windowCount: windowIds.size, pageCount: details.length, pages: details };
  }

  /**
   * True when `page` still lives in the session window. Read-only; on any CDP
   * error returns false so the caller STOPs rather than guessing.
   */
  private async assertSameBrowserWindow(page: Page, sessionWindowId: number): Promise<boolean> {
    if (!page || page.isClosed()) return false;
    try {
      const w = await cdpManager.getPageWindow(page);
      return w.windowId === sessionWindowId;
    } catch {
      return false;
    }
  }

  /**
   * Reuse-first work-tab picker, strictly inside the session window:
   *   1. an existing Google tab → reuse,
   *   2. else a blank/new-tab page → reuse,
   *   3. else create exactly ONE new tab in the same context and verify it
   *      landed in the session window (else STOP — never open a new window).
   * Never reuses an unrelated app tab and never touches start.adspower.net.
   */
  private async findReusableGooglePage(
    profileId: string,
    sessionWindowId: number
  ): Promise<ReusableGooglePage> {
    const pages = cdpManager.getPages(profileId);
    if (!pages.length) return { ok: false, reason: 'no_pages' };

    const infos: PageWindowInfo[] = [];
    for (const p of pages) {
      let windowId = -1;
      try {
        windowId = (await cdpManager.getPageWindow(p)).windowId;
      } catch {}
      infos.push({ url: p.isClosed() ? '' : p.url(), windowId });
    }

    const selection = selectReusableGooglePage(infos, sessionWindowId);

    if (selection.action === 'mismatch') {
      return { ok: false, reason: 'mismatch' };
    }

    if (selection.action === 'reuse') {
      const page = pages[selection.index];
      const w = await cdpManager.getPageWindow(page);
      logger.info(`[Google] Tái sử dụng tab ${selection.reason} sẵn có (windowId=${w.windowId}).`);
      return { ok: true, page, created: false, windowId: w.windowId, pageId: w.targetId };
    }

    // action === 'create': mở đúng MỘT tab mới TRONG CÙNG cửa sổ phiên.
    // Dùng window.open từ một tab opener đang sống trong cửa sổ phiên — Chromium
    // mở tab mới ngay trong cửa sổ của opener, KHÁC với context.newPage() vốn có
    // thể bung ra một cửa sổ MỚI. Đây là bất biến "1 cửa sổ duy nhất".
    const openerIndex = infos.findIndex(
      (info, i) => info.windowId === sessionWindowId && !pages[i].isClosed()
    );
    if (openerIndex < 0) {
      logger.warn(
        `[Google] Không có tab opener trong cửa sổ phiên (${sessionWindowId}); dừng, không mở thêm cửa sổ.`
      );
      return { ok: false, reason: 'mismatch' };
    }
    const opener = pages[openerIndex];
    const context = opener.context();
    const known = new Set(context.pages());
    try {
      await opener.evaluate(() => {
        window.open('about:blank', '_blank');
      });
    } catch (err) {
      logger.warn(`[Google] window.open thất bại: ${(err as Error)?.message || 'unknown'}; dừng.`);
      return { ok: false, reason: 'mismatch' };
    }

    let fresh: Page | null = null;
    for (let attempt = 0; attempt < 25 && !fresh; attempt++) {
      fresh = context.pages().find(p => !known.has(p) && !p.isClosed()) ?? null;
      if (!fresh) await sleep(200);
    }
    if (!fresh) {
      logger.warn('[Google] Không thấy tab mới sau window.open; dừng, không mở thêm cửa sổ.');
      return { ok: false, reason: 'mismatch' };
    }

    const w = await cdpManager.getPageWindow(fresh);
    if (w.windowId !== sessionWindowId) {
      logger.warn(
        `[Google] Tab mới rơi vào windowId=${w.windowId} khác cửa sổ phiên (${sessionWindowId}); dừng, không mở thêm.`
      );
      return { ok: false, reason: 'mismatch' };
    }
    logger.info(
      `[Google] Đã tạo 1 tab mới trong cùng cửa sổ phiên (windowId=${w.windowId}) qua opener.`
    );
    return { ok: true, page: fresh, created: true, windowId: w.windowId, pageId: w.targetId };
  }

  /**
   * Attach WINDOWS/PAGES BEFORE-vs-AFTER diagnostics to a result and enforce the
   * invariant flags (window count unchanged; pages grow by at most +1). All
   * fields are secret-free.
   */
  private async finalize(
    result: GoogleLoginResult,
    profileId: string,
    before: { windowCount: number; pageCount: number },
    sessionWindowId: number,
    work: { mode: 'reused' | 'created' | 'none'; windowId: number | null; pageId: string | null }
  ): Promise<GoogleLoginResult> {
    let after = before;
    try {
      after = await this.captureWindowSnapshot(profileId);
    } catch {}
    const windowCountPass = after.windowCount === before.windowCount;
    const pagesDelta = after.pageCount - before.pageCount;
    const pagesPass = pagesDelta >= 0 && pagesDelta <= 1;
    result.details = {
      ...(result.details || {}),
      windowsBefore: before.windowCount,
      windowsAfter: after.windowCount,
      windowCountPass,
      pagesBefore: before.pageCount,
      pagesAfter: after.pageCount,
      pagesDelta,
      pagesPass,
      sessionWindowId,
      googlePage: work.mode,
      workWindowId: work.windowId,
      workPageId: work.pageId,
    };
    logger.info(
      `[Google Diag] WINDOWS_AFTER=${after.windowCount} PAGES_AFTER=${after.pageCount} ` +
        `WINDOW_COUNT=${windowCountPass ? 'PASS' : 'FAIL'} PAGES=${pagesPass ? 'PASS' : 'FAIL'}`
    );
    return result;
  }

  /**
   * Run Google account login for a profile using its already-connected browser,
   * enforcing SINGLE-WINDOW + TAB-REUSE. Never launches/creates a browser,
   * context, or second window.
   *
   * `creds.twoFactorSecret` (tuỳ chọn) là nguồn 2FA cho provider không có tab
   * start.adspower.net. Khi không có, luồng AdsPower giữ nguyên 100%.
   */
  public async execute(
    profileId: string,
    profileName: string,
    creds: GoogleLoginCredentials
  ): Promise<GoogleLoginResult> {
    const maskedEmail = maskEmail(creds.username);
    logger.info('===============================================================');
    logger.info(`🚀 GOOGLE LOGIN cho profile "${profileName}" (${profileId}) — email ${maskedEmail}`);
    logger.info('===============================================================');

    const initialPages = cdpManager.getPages(profileId);
    if (!initialPages.length) {
      return this.buildResult(
        false,
        'no_pages',
        'FAILED',
        'Không có tab nào đang mở trong trình duyệt của profile (engine phải kết nối trước).',
        '',
        profileId,
        profileName
      );
    }

    const sessionWin = await this.resolveSessionWindow(profileId);
    if (!sessionWin) {
      return this.buildResult(
        false,
        'no_window',
        'FAILED',
        'Không xác định được cửa sổ trình duyệt của phiên qua CDP.',
        '',
        profileId,
        profileName
      );
    }
    const sessionWindowId = sessionWin.windowId;

    const before = await this.captureWindowSnapshot(profileId);
    logger.info(
      `[Google Diag] PROFILE=${profileName} SESSION_WINDOW_ID=${sessionWindowId} ` +
        `WINDOWS_BEFORE=${before.windowCount} PAGES_BEFORE=${before.pageCount}`
    );

    const noWork = { mode: 'none' as const, windowId: null, pageId: null };

    let found: ReusableGooglePage;
    try {
      found = await this.findReusableGooglePage(profileId, sessionWindowId);
    } catch (err) {
      return this.finalize(
        this.buildResult(
          false,
          'workpage_error',
          'FAILED',
          `Không mở được tab làm việc trong trình duyệt profile: ${(err as Error)?.message || 'unknown'}`,
          '',
          profileId,
          profileName
        ),
        profileId,
        before,
        sessionWindowId,
        noWork
      );
    }

    if (!found.ok) {
      if (found.reason === 'mismatch') {
        return this.finalize(
          this.buildResult(
            false,
            'browser_window_mismatch',
            'BROWSER_WINDOW_MISMATCH',
            'Không có tab làm việc hợp lệ trong cửa sổ trình duyệt của phiên; không mở cửa sổ mới.',
            '',
            profileId,
            profileName
          ),
          profileId,
          before,
          sessionWindowId,
          noWork
        );
      }
      return this.finalize(
        this.buildResult(
          false,
          'no_workpage',
          'FAILED',
          'Không tìm được tab làm việc phù hợp (không được đụng tab start.adspower.net).',
          '',
          profileId,
          profileName
        ),
        profileId,
        before,
        sessionWindowId,
        noWork
      );
    }

    const workPage: Page = found.page;
    const work = {
      mode: found.created ? ('created' as const) : ('reused' as const),
      windowId: found.windowId,
      pageId: found.pageId,
    };
    logger.info(`[Google Diag] GOOGLE_PAGE=${work.mode} WINDOW_ID=${work.windowId} PAGE_ID=${work.pageId}`);

    await workPage
      .goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
      .catch(() => {});
    await sleep(1500);

    const startTime = Date.now();
    const totalTimeoutMs = 120000;
    const maxCycles = 15;
    let twoFactorUsed = false;

    for (let cycle = 1; cycle <= maxCycles; cycle++) {
      if (Date.now() - startTime > totalTimeoutMs) {
        const url = workPage.isClosed() ? '' : workPage.url();
        return this.finalize(
          this.buildResult(
            false,
            'timeout',
            'TIMEOUT',
            `Quá thời gian ${totalTimeoutMs}ms khi đăng nhập Google.`,
            url,
            profileId,
            profileName,
            twoFactorUsed
          ),
          profileId,
          before,
          sessionWindowId,
          work
        );
      }

      if (!workPage || workPage.isClosed()) {
        return this.finalize(
          this.buildResult(
            false,
            'browser_closed',
            'NEEDS_HUMAN_REVIEW',
            'Tab làm việc đã bị đóng trong lúc đăng nhập.',
            '',
            profileId,
            profileName,
            twoFactorUsed
          ),
          profileId,
          before,
          sessionWindowId,
          work
        );
      }

      // Window-isolation guard before each Google state.
      if (!(await this.assertSameBrowserWindow(workPage, sessionWindowId))) {
        return this.finalize(
          this.buildResult(
            false,
            'browser_window_mismatch',
            'BROWSER_WINDOW_MISMATCH',
            'Tab làm việc rời khỏi cửa sổ trình duyệt của phiên; dừng lại, không mở cửa sổ mới.',
            workPage.isClosed() ? '' : workPage.url(),
            profileId,
            profileName,
            twoFactorUsed
          ),
          profileId,
          before,
          sessionWindowId,
          work
        );
      }

      await this.dismissAllKnownPopups(workPage);
      const currentUrl = workPage.url();
      const bodyText = (await workPage
        .evaluate('document.body ? document.body.innerText : ""')
        .catch(() => '')) as string;
      const stateWin = await cdpManager
        .getPageWindow(workPage)
        .catch(() => ({ windowId: -1, targetId: '' }));
      const stateTitle = await workPage.title().catch(() => '');
      logger.info(
        `[Google State ${cycle}/${maxCycles}] PROFILE=${profileName} WINDOW_ID=${stateWin.windowId} ` +
          `PAGE_ID=${stateWin.targetId} URL=${redactEmails(currentUrl)} TITLE=${redactEmails(stateTitle)} EMAIL=${maskedEmail}`
      );

      // 1. SUCCESS termination.
      //    Cookie chứng minh "CÓ đăng nhập". Với provider mà credential đến từ
      //    người dùng (taothao), Gmail là khoá nhận dạng cứng nên phải chứng minh
      //    thêm "ĐÚNG tài khoản" — profile có thể đã sẵn đăng nhập Gmail khác.
      //    AdsPower KHÔNG bật cờ này -> hành vi cũ giữ nguyên 100%.
      if (await this.isRealLoggedIn(workPage)) {
        const finalUrl = workPage.isClosed() ? currentUrl : workPage.url();

        if (creds.verifyIdentity === true) {
          const identity = await verifySignedInIdentity(workPage, creds.username);

          if (identity.verdict === 'mismatch') {
            logger.error(
              `🛑 [Google] SAI TÀI KHOẢN: profile "${profileName}" đang đăng nhập ` +
                `${maskEmail(identity.actual)} nhưng được gán ${maskedEmail} -> KHÔNG tính thành công.`
            );
            const mismatch = this.buildResult(
              false,
              'identity_mismatch',
              'IDENTITY_MISMATCH',
              `Trình duyệt đang đăng nhập tài khoản ${maskEmail(identity.actual)}, khác tài khoản được gán ` +
                `${maskedEmail}. Không tính là đăng nhập thành công.`,
              finalUrl,
              profileId,
              profileName,
              twoFactorUsed
            );
            mismatch.details = { identityVerdict: identity.verdict, identitySource: identity.source };
            return this.finalize(mismatch, profileId, before, sessionWindowId, work);
          }

          if (identity.verdict === 'undetermined') {
            logger.warn(
              `⚠️ [Google] Không đọc được tài khoản đang đăng nhập của profile "${profileName}" ` +
                `-> chưa thể đối chiếu với ${maskedEmail}, cần con người xác nhận.`
            );
            const unverified = this.buildResult(
              false,
              'identity_unverified',
              'NEEDS_HUMAN_REVIEW',
              'Đã đăng nhập nhưng không xác định được tài khoản đang đăng nhập để đối chiếu Gmail đã gán.',
              finalUrl,
              profileId,
              profileName,
              twoFactorUsed
            );
            unverified.details = { identityVerdict: identity.verdict, identitySource: identity.source };
            return this.finalize(unverified, profileId, before, sessionWindowId, work);
          }

          logger.info(
            `✅ [Google] Đúng tài khoản được gán (${maskedEmail}) — nguồn đối chiếu: ${identity.source}.`
          );
        }

        logger.info('🎉 [GOOGLE STATE ENGINE] ĐÃ XÁC NHẬN ĐĂNG NHẬP GOOGLE THÀNH CÔNG!');
        return this.finalize(
          this.buildResult(
            true,
            'logged_in',
            'SUCCESS',
            'Đã đăng nhập và xác thực tài khoản Google thành công.',
            finalUrl,
            profileId,
            profileName,
            twoFactorUsed
          ),
          profileId,
          before,
          sessionWindowId,
          work
        );
      }

      // 2. TOTP / 2FA challenge.
      //    Nguồn mã: secret do người dùng cung cấp (taothao) NẾU có; ngược lại
      //    đọc từ tab start.adspower.net như cũ (AdsPower). Không có nguồn thứ ba.
      const totpInput = workPage
        .locator('#totpPin, input[name="totpPin"], input[type="tel"][aria-label*="code" i], input[aria-label*="code" i]')
        .first();
      if (await this.safeIsVisible(totpInput, 800)) {
        const providedSecret = (creds.twoFactorSecret || '').trim();
        logger.info(
          providedSecret
            ? '🔑 [Google] Trang yêu cầu mã xác thực 2 bước -> sinh mã TOTP từ secret của tài khoản...'
            : '🔑 [Google] Trang yêu cầu mã xác thực 2 bước -> đọc mã từ tab AdsPower...'
        );
        // NEVER log the secret or the code.
        const twofa = providedSecret
          ? resolveTwoFactorCode(providedSecret)
          : await adsPower2FAProvider.readCurrentProfile2FA(profileId);
        if ('failed' in twofa) {
          logger.warn(`⚠️ [Google] Không lấy được mã 2FA (${twofa.reason}) -> cần con người xử lý.`);
          return this.finalize(
            this.buildResult(
              false,
              'two_factor_unavailable',
              'NEEDS_HUMAN_REVIEW',
              providedSecret
                ? `Trang yêu cầu mã 2FA nhưng không tạo được mã từ secret đã cung cấp (${twofa.reason}).`
                : 'Trang yêu cầu mã 2FA nhưng không đọc được mã từ tab AdsPower.',
              currentUrl,
              profileId,
              profileName,
              twoFactorUsed
            ),
            profileId,
            before,
            sessionWindowId,
            work
          );
        }
        // NEVER log the code.
        await totpInput.fill(twofa.code).catch(() => {});
        twoFactorUsed = true;
        await this.clickNext(workPage);
        await sleep(3000);
        continue;
      }

      // 3. Anti-automation / security interstitial — never bypass.
      const challenge = classifyGoogleChallenge(currentUrl, bodyText);
      if (challenge) {
        logger.warn(`🚨 [Google] Phát hiện thử thách bảo mật -> ${challenge} (không tự vượt qua).`);
        return this.finalize(
          this.buildResult(
            false,
            challenge === 'VERIFICATION_REQUIRED' ? 'verification_required' : 'needs_human_review',
            challenge,
            challenge === 'VERIFICATION_REQUIRED'
              ? 'Google yêu cầu bước xác minh bổ sung (CAPTCHA / xác minh danh tính). Cần con người xử lý.'
              : 'Google chặn phiên (trình duyệt không an toàn / không thể đăng nhập). Cần con người xử lý.',
            currentUrl,
            profileId,
            profileName,
            twoFactorUsed
          ),
          profileId,
          before,
          sessionWindowId,
          work
        );
      }

      // 4. Account not found.
      if (/couldn't find your google account|couldn’t find your google account|không tìm thấy tài khoản google/i.test(bodyText)) {
        return this.finalize(
          this.buildResult(
            false,
            'account_not_found',
            'FAILED',
            'Không tìm thấy tài khoản Google với email đã nhập.',
            currentUrl,
            profileId,
            profileName,
            twoFactorUsed
          ),
          profileId,
          before,
          sessionWindowId,
          work
        );
      }

      // 5. Wrong password.
      if (/wrong password|incorrect password|mật khẩu.*(không (chính xác|đúng))|sai mật khẩu/i.test(bodyText)) {
        return this.finalize(
          this.buildResult(
            false,
            'wrong_password',
            'FAILED',
            'Mật khẩu không chính xác. Vui lòng cập nhật mật khẩu mới trên AdsPower.',
            currentUrl,
            profileId,
            profileName,
            twoFactorUsed
          ),
          profileId,
          before,
          sessionWindowId,
          work
        );
      }

      // 6. Email step.
      const emailInput = workPage.locator('input[type="email"], #identifierId').first();
      if (await this.safeIsVisible(emailInput, 800)) {
        logger.info('[Google] Nhập email và tiếp tục...');
        await emailInput.fill(creds.username).catch(() => {});
        await this.clickNext(workPage);
        await sleep(3000);
        continue;
      }

      // 7. Password step. NEVER log the password.
      const passInput = workPage.locator('input[type="password"], input[name="Passwd"]').first();
      if (await this.safeIsVisible(passInput, 800)) {
        logger.info('[Google] Nhập mật khẩu và tiếp tục...');
        await passInput.fill(creds.password).catch(() => {});
        await this.clickNext(workPage);
        await sleep(3500);
        continue;
      }

      // Nothing recognised this cycle — wait and re-evaluate.
      await sleep(2000);
    }

    // Cycles exhausted.
    const finalUrl = workPage.isClosed() ? '' : workPage.url();
    if (await this.isRealLoggedIn(workPage)) {
      return this.finalize(
        this.buildResult(
          true,
          'logged_in',
          'SUCCESS',
          'Đã đăng nhập và xác thực tài khoản Google thành công.',
          finalUrl,
          profileId,
          profileName,
          twoFactorUsed
        ),
        profileId,
        before,
        sessionWindowId,
        work
      );
    }

    return this.finalize(
      this.buildResult(
        false,
        'undetermined',
        'NEEDS_HUMAN_REVIEW',
        `Kết thúc chu kỳ nhưng chưa xác nhận đăng nhập. Đang ở: ${finalUrl}`,
        finalUrl,
        profileId,
        profileName,
        twoFactorUsed
      ),
      profileId,
      before,
      sessionWindowId,
      work
    );
  }
}

export const googleLoginAutomation = new GoogleLoginAutomation();
