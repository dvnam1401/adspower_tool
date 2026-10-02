const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
import { Page, Locator } from 'playwright-core';
import { adsPowerClient } from '../adspower/client.js';
import { config } from '../config/index.js';
import { cdpManager } from '../dom/cdp.js';
import { popupKiller } from '../dom/popup-killer.js';
import { generateTOTP } from '../utils/totp.js';
import { logger } from '../utils/logger.js';
import { broadcastEvent } from '../server/app.js';
import { AdsPowerProfileInfo, DOMAction } from '../types/index.js';
import { aiPageAnalyzer } from '../utils/ai-analyzer.js';
import { notifySingleProfileResult } from '../utils/telegram.js';
import { googleSheetService } from './google-sheet.js';
import {
  matchesAnyToken, hasTextSelector, attrContainsSelector,
  WRONG_PASSWORD_TOKENS, ACCOUNT_NOT_FOUND_TOKENS, HUMAN_VERIFICATION_TOKENS,
  ACCOUNT_LOCKED_TOKENS, IDENTITY_VERIFICATION_TOKENS, CAPTCHA_HINT_TOKENS,
  RECAPTCHA_TEXT_TOKENS, LOGGED_OUT_TOKENS, LOGGED_IN_ARIA_TOKENS,
  SEARCH_PLACEHOLDER_TOKENS, ACCOUNT_ARIA_TOKENS, CLOSE_ARIA_TOKENS,
  DISMISS_POPUP_TOKENS, SUSPECT_DISMISS_TOKENS, TRUST_DEVICE_TOKENS,
  SAVE_LOGIN_TOKENS, CONTINUE_TOKENS, TRY_ANOTHER_WAY_TOKENS, AUTH_APP_TOKENS,
  CHOOSE_METHOD_TOKENS, DEVICE_NOTIFICATION_TOKENS, GO_TO_AUTH_APP_TOKENS,
  TWO_FA_REJECTED_TOKENS, RELOAD_PAGE_TOKENS, ONE_TAP_CANCEL_TOKENS, LOGIN_BUTTON_TOKENS,
  SESSION_TIMEOUT_TOKENS, RESTART_OK_TOKENS,
} from './facebook-i18n.js';

export interface FacebookLoginResult {
  success: boolean;
  status: 'logged_in' | 'already_logged_in' | 'two_factor_in_progress' | 'checkpoint_human_verification' | 'recapcha_detected' | 'failed' | 'needs_human_review';
  message: string;
  currentUrl: string;
  profileId: string;
  profileName: string;
  details?: Record<string, any>;
}

export class FacebookLoginAutomation {
  /**
   * Safe helper to check visibility without throwing when target page/context closes
   */
  private async safeIsVisible(locator: Locator, timeoutMs: number = 1000): Promise<boolean> {
    try {
      return await locator.isVisible({ timeout: timeoutMs }).catch(() => false);
    } catch {
      return false;
    }
  }

  /**
   * Safe helper to click without throwing
   */
  private async safeClick(locator: Locator, timeoutMs: number = 3000): Promise<boolean> {
    try {
      await locator.click({ force: true, timeout: timeoutMs }).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }
  /**
   * Escape user text for a case-insensitive alternation RegExp.
   */
  private tokensToRegExp(tokens: string[]): RegExp {
    return new RegExp(tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
  }

  /**
   * Click a control by localized text tokens using a REAL TRUSTED pointer click
   * (hover + mousedown/up dispatched via CDP).
   *
   * WHY (verified live 2026-08): Facebook's `div[role="button"]` controls on the 2FA
   * screens (Try another way / OK on the session-timeout dialog / Continue) IGNORE
   * programmatic `element.click()` — their React handlers only fire on trusted pointer
   * events. A non-force Playwright click lands on the real target and fires the handler;
   * force is only a last resort (skips actionability, may click a wrong overlay).
   * Prefers role=button by accessible name, then role=button/button/a by text.
   */
  private async trustedClickByTokens(
    page: Page,
    tokens: string[],
    opts?: { scope?: Locator; timeout?: number }
  ): Promise<boolean> {
    if (!page || page.isClosed()) return false;
    const timeout = opts?.timeout ?? 4000;
    const re = this.tokensToRegExp(tokens);
    const root = opts?.scope;
    const candidates: Locator[] = root
      ? [root.getByRole('button', { name: re }), root.locator('div[role="button"]', { hasText: re }), root.locator('button', { hasText: re }), root.locator('a', { hasText: re })]
      : [page.getByRole('button', { name: re }), page.locator('div[role="button"]', { hasText: re }), page.locator('button', { hasText: re }), page.locator('a', { hasText: re })];
    for (const cand of candidates) {
      const el = cand.first();
      try {
        if (!(await el.isVisible({ timeout: 700 }).catch(() => false))) continue;
        await el.scrollIntoViewIfNeeded().catch(() => {});
        try {
          await el.click({ timeout });
        } catch {
          await el.click({ force: true, timeout }).catch(() => {});
        }
        return true;
      } catch { /* try next candidate */ }
    }
    return false;
  }

  /**
   * Safe helper to retrieve active alive page
   */
  private getAlivePage(profileId: string, fallback: Page): Page {
    if (fallback && !fallback.isClosed()) return fallback;
    const active = cdpManager.getActivePage(profileId);
    if (active && !active.isClosed()) return active;
    return fallback;
  }

  /**
   * Run Facebook login automation for a given profile name or ID
   */
  public async execute(profileIdentifier: string, customTargetUrl?: string, options?: { keepBrowserOpenOnSuccess?: boolean }): Promise<FacebookLoginResult> {
    logger.info('===============================================================');
    logger.info(`🚀 BẮT ĐẦU AUTOMATION FACEBOOK LOGIN CHO: ${profileIdentifier}`);
    logger.info('===============================================================');

    // 1. Tìm thông tin profile từ AdsPower
    const profile = await this.resolveProfile(profileIdentifier);
    if (!profile) {
      throw new Error(`Không tìm thấy profile "${profileIdentifier}" trên AdsPower.`);
    }

    const profileId = profile.user_id;
    const profileName = profile.name || profileIdentifier;
    const username = profile.username || profile.platform_account?.[0]?.login_user || '61589806613997';
    const password = profile.password || profile.platform_account?.[0]?.password || '';
    const fakey = profile.fakey || profile.platform_account?.[0]?.fakey || '';
    const deploymentUrl = customTargetUrl || (profile as any).domain_name || (profile as any).url || 'https://www.facebook.com/';

    logger.info(`Profile: ${profileName} (#${profile.serial_number || 'N/A'}) - User ID: ${profileId}`);
    logger.info(`Username: ${username}`);
    logger.info(`2FA Key: ${fakey ? fakey.substring(0, 4) + '****' : 'Chưa thiết lập'}`);

    // 2. Khởi động hoặc lấy WebSocket của profile AdsPower
    logger.info(`[Step 1/5] Khởi động trình duyệt AdsPower (tái dùng cửa sổ hiện tại nếu đang mở)...`);
    const connData = await adsPowerClient.startBrowser({ 
      profileId,
      // Không truyền launchArgs → AdsPower tái dùng cửa sổ đang mở
      // giống như bấm nút Open trên UI AdsPower, không mở cửa sổ Chrome mới
    });
    if (!connData?.ws?.puppeteer) {
      throw new Error('Không lấy được WebSocket endpoint từ AdsPower.');
    }

    // 3. Kết nối Playwright CDP vào chính cửa sổ / tab AdsPower đang mở
    logger.info(`[Step 2/5] Kết nối Playwright CDP vào cửa sổ hiện tại của AdsPower...`);
    let page = await cdpManager.connect(profileId, connData.ws.puppeteer);

    // Chèn Script chặn triệt để Web Credential Manager / FedCM
    await page.addInitScript(() => {
      try {
        const nav = navigator as any;
        if (nav && nav.credentials) {
          nav.credentials.get = () => Promise.resolve(null);
          nav.credentials.create = () => Promise.resolve(null);
          nav.credentials.store = () => Promise.resolve(null);
          nav.credentials.preventSilentAccess = () => Promise.resolve();
        }
      } catch (e) {}
    }).catch(() => {});

    // Xử lý tự động native dialogs (alert, confirm, prompt)
    page.on('dialog', async dialog => {
      logger.info(`[Auto-Dismiss] Tự động đóng browser dialog: "${dialog.message()}"`);
      await dialog.dismiss().catch(() => {});
    });

    await sleep(1000);
    // [Native popup] Chrome credential/account-picker ("Sign in with …") is browser
    // chrome, invisible to Playwright DOM locators, and blocks login. Dismiss it via
    // ESC BEFORE the detector / any field interaction. Locale-independent, idempotent.
    await popupKiller.dismissNativePopup(page);

    page = this.getAlivePage(profileId, page);

    // Xử lý trang lỗi 404 "Not Found" nếu có
    await this.handleNotFoundPage(page, profileId);

    // Tự động dẹp bỏ popup và cảnh báo
    await this.dismissAllKnownPopups(page, profileId);

    // 4. KIỂM TRA CHÍNH XÁC: Tài khoản đang ĐÃ ĐĂNG NHẬP THỰC SỰ hay ĐANG BỊ LOGOUT?
    logger.info(`[Step 3/4] Phân tích trạng thái đăng nhập thực tế của tài khoản...`);
    page = this.getAlivePage(profileId, page);
    const isGenuinelyLoggedIn = await this.isRealLoggedIn(page, profileId);

    if (isGenuinelyLoggedIn) {
      logger.info(`🎉 TÀI KHOẢN ĐANG ĐĂNG NHẬP HỢP LỆ VÀ SẴN SÀNG! (Trạng thái: already_logged_in)`);
      // [P1a điểm 3 - D14] KHÔNG điều hướng rời khỏi một bề mặt Facebook đã đăng nhập hợp lệ chỉ vì
      // URL != deploymentUrl. Chỉ chuẩn hóa URL khi trang chưa "sạch"; và [P1a điểm 4] sau khi chuẩn
      // hóa phải TÁI XÁC NHẬN bằng detector — success KHÔNG được suy ra từ việc URL thay đổi.
      const normalized = await this.resolveAlreadyLoggedIn(page, deploymentUrl, profileId);
      if (normalized.confirmed) {
        broadcastEvent('system_alert', {
          type: 'login_success',
          profileId,
          profileName,
          url: normalized.url,
          message: 'Tài khoản đã đăng nhập hợp lệ và sẵn sàng.',
          time: new Date().toLocaleTimeString(),
        });

        const finalRes: FacebookLoginResult = {
          success: true,
          status: 'already_logged_in',
          message: 'Tài khoản đã đăng nhập thành công và sẵn sàng.',
          currentUrl: normalized.url,
          profileId,
          profileName,
        };

        await notifySingleProfileResult(finalRes).catch(() => {});
        await this.handleAutoCloseIfSuccess(finalRes, options?.keepBrowserOpenOnSuccess);
        return finalRes;
      }
      logger.warn('⚠️ Sau khi chuẩn hóa URL, phiên KHÔNG còn được detector xác nhận -> chuyển sang Autonomous State Engine.');
    }

    // 5. KHỞI ĐỘNG CƠ CHẾ AUTONOMOUS STATE MACHINE
    // KHÔNG bơm cookie giả từ Google Sheet vào trình duyệt thật (mock trả cookie rác
    // 'c_user=12345;...' gây false-positive) -> chạy MỘT lần duy nhất, không retry
    // vô nghĩa cho sai mật khẩu / recaptcha (các trạng thái này không tự khỏi khi thử lại).
    logger.info(`[Step 4/4] Kích hoạt Autonomous State Engine...`);
    const result = await this.runAutonomousLoginEngine(page, username, password, fakey, profileId, profileName);

    // [P1a điểm 5] GIỮ NGUYÊN các trạng thái CHẶN thật sự (recapcha_detected / checkpoint_human_verification):
    // trả đúng terminal status, KHÔNG remap sang needs_human_review và KHÔNG tự đóng trình duyệt.
    // Chỉ sai mật khẩu / thất bại chung mới cần con người cập nhật credential.
    if (!result.success && (result.status === 'failed' || result.message.includes('Wrong Password'))) {
      result.status = 'needs_human_review';
      await googleSheetService.updateStatus(profileId, 'NEEDS_HUMAN_REVIEW');
    }

    logger.info('===============================================================');
    logger.info(`🏁 KẾT QUẢ AUTOMATION: [${result.status.toUpperCase()}] ${result.message}`);
    
    await notifySingleProfileResult(result).catch(() => {});
    await this.handleAutoCloseIfSuccess(result, options?.keepBrowserOpenOnSuccess);
    return result;
  }

  /**
   * [P1a điểm 3+4] Chuẩn hóa URL cho phiên ĐÃ đăng nhập mà KHÔNG rời khỏi một bề mặt hợp lệ.
   * - Trang đã là bề mặt Facebook đăng nhập "sạch" -> giữ nguyên, không điều hướng.
   * - Chưa sạch (còn ?checkpoint_src / URL rác) -> về deploymentUrl rồi TÁI XÁC NHẬN bằng detector.
   *   Success KHÔNG bao giờ suy ra chỉ từ việc URL thay đổi.
   */
  private async resolveAlreadyLoggedIn(
    page: Page,
    deploymentUrl?: string,
    profileId?: string
  ): Promise<{ confirmed: boolean; url: string }> {
    let curUrl = page.isClosed() ? '' : page.url();
    if (this.isCleanLoggedInSurface(curUrl)) {
      return { confirmed: true, url: curUrl };
    }
    const dest = deploymentUrl || 'https://www.facebook.com/';
    logger.info(`🔄 Làm sạch thanh địa chỉ URL trình duyệt: Chuyển hướng từ [${curUrl}] về [${dest}]...`);
    await page.goto(dest, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await sleep(1500);
    curUrl = page.isClosed() ? '' : page.url();
    const confirmed = await this.isRealLoggedIn(page, profileId);
    return { confirmed, url: curUrl };
  }

  /**
   * [P1a điểm 3] Trang hiện tại có phải bề mặt Facebook ĐÃ đăng nhập "sạch"? Chỉ dựa vào CẤU TRÚC
   * URL (không phụ thuộc ngôn ngữ): host facebook.com, KHÔNG nằm trong luồng auth/checkpoint và
   * không dính query checkpoint_src.
   */
  private isCleanLoggedInSurface(url: string): boolean {
    if (!url) return false;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (!(host === 'facebook.com' || host.endsWith('.facebook.com'))) return false;
    const path = parsed.pathname.toLowerCase();
    if (/\/login|login\.php|\/checkpoint|two_factor|two_step|\/recover|\/authentication|\/confirmemail/.test(path)) {
      return false;
    }
    if (parsed.search.toLowerCase().includes('checkpoint_src')) return false;
    return true;
  }

  /**
   * Helper to auto-close browser window if login succeeds to free up RAM
   */
  private async handleAutoCloseIfSuccess(result: FacebookLoginResult, keepBrowserOpenOnSuccess: boolean = false): Promise<void> {
    if (!result.success || !result.profileId) return;

    // [P1b điểm 5] Có bước kế tiếp trong workflow (inventory/share...) -> GIỮ mở trình duyệt trên success.
    if (keepBrowserOpenOnSuccess) {
      logger.info(`ℹ️ [Auto-Close] Có bước kế tiếp trong workflow -> GIỮ mở cửa sổ profile ${result.profileName || result.profileId} để chạy tiếp.`);
      return;
    }

    if (config.automation?.closeSuccessBrowsers === false) {
      logger.info(`ℹ️ [Auto-Close] Cấu hình closeSuccessBrowsers=false -> Giữ nguyên cửa sổ trình duyệt cho profile ${result.profileName || result.profileId}.`);
      return;
    }

    try {
      logger.info(`🚪 [Auto-Close] Đã đăng nhập THÀNH CÔNG -> Tự động đóng cửa sổ profile ${result.profileName || result.profileId}...`);
      await cdpManager.disconnect(result.profileId).catch(() => {});
      await adsPowerClient.stopBrowser({ profileId: result.profileId }).catch(() => {});
    } catch (closeErr: any) {
      logger.warn(`[Auto-Close Note] Không thể đóng cửa sổ profile ${result.profileId}: ${closeErr.message}`);
    }
  }

  /**
   * Resolve profile from AdsPower list by ID, Serial or Name
   */
  private async resolveProfile(identifier: string): Promise<AdsPowerProfileInfo | null> {
    if (!identifier) return null;
    const cleanId = identifier.trim();

    // 1. Kiểm tra cache hoặc query trực tiếp qua getProfile (0ms latency nếu đã có cache)
    try {
      const profile = await adsPowerClient.getProfile(cleanId);
      if (profile) return profile;
    } catch {}

    // 2. Tìm trực tiếp theo serial_number nếu identifier là số hoặc có tiền tố '#'
    const isSerial = /^\d+$/.test(cleanId) || cleanId.startsWith('#');
    if (isSerial) {
      const serial = cleanId.replace(/^#/, '');
      try {
        const resBySerial = await adsPowerClient.listProfiles({ serialNumber: serial, pageSize: 1 });
        if (resBySerial.list && resBySerial.list.length > 0) {
          return resBySerial.list[0];
        }
      } catch {}
    }

    // 3. Tìm theo Name hoặc quét toàn bộ profiles (fetchAll)
    try {
      const resAll = await adsPowerClient.listProfiles({ fetchAll: true, pageSize: 100 });
      const found = (resAll.list || []).find(
        p =>
          p.user_id === cleanId ||
          p.serial_number === cleanId ||
          p.name?.toLowerCase().trim() === cleanId.toLowerCase()
      );
      if (found) return found;
    } catch {}

    return null;
  }

  /**
   * Handle Case 1: Page returns plain text "Not Found" / 404 (Image 1)
   */
  private async handleNotFoundPage(page: Page, profileId?: string): Promise<void> {
    if (!page || page.isClosed()) return;
    try {
      const bodyText = (await page.evaluate('document.body ? document.body.innerText.trim() : ""').catch(() => '')) as string;
      if (bodyText === 'Not Found' || bodyText.startsWith('Not Found') || bodyText.length === 0) {
        logger.warn('⚠️ Phát hiện trang "Not Found" (404) -> Đang tự động chuyển hướng về https://www.facebook.com/...');
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await sleep(3000);
      }
    } catch {}
  }

  /**
   * Đọc cookie `c_user` — bằng chứng NHANH và ĐÁNG TIN NHẤT rằng phiên đã xác thực.
   * Facebook chỉ set c_user (là user id numeric) sau khi đăng nhập thành công.
   * Trả về giá trị c_user (string) nếu tồn tại & hợp lệ, ngược lại null.
   */
  private async getCUserCookie(page: Page): Promise<string | null> {
    if (!page || page.isClosed()) return null;
    try {
      const cookies = await page.context().cookies(['https://www.facebook.com', 'https://facebook.com']);
      // c_user hợp lệ phải là uid Facebook thật: TỐI THIỂU 9 chữ số (thực tế thường ≥15).
      // Ngưỡng \d{9,} loại bỏ cookie rác / giá trị test ngắn (vd '12345') gây false-positive.
      const cUser = cookies.find(c => c.name === 'c_user' && c.value && /^\d{9,}$/.test(c.value));
      return cUser ? cUser.value : null;
    } catch {
      return null;
    }
  }

  /**
   * Xác minh chắc chắn bằng cách điều hướng tới facebook.com/me/.
   * Nếu đã đăng nhập, /me redirect sang trang cá nhân thật (profile.php / username).
   * Nếu chưa, /me sẽ nhảy về login/checkpoint. Dùng khi độ tin cậy thấp.
   */
  private async verifyViaMe(page: Page, profileId?: string): Promise<boolean> {
    if (!page || page.isClosed()) return false;
    try {
      logger.info('[LoginDetector] Độ tin cậy chưa chắc chắn -> Điều hướng facebook.com/me/ để xác minh phiên...');
      await page.goto('https://www.facebook.com/me/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await sleep(1500);
      if (page.isClosed()) return false;
      const finalUrl = page.url();

      // /me nhảy về login/checkpoint/2fa => CHƯA đăng nhập
      if (/\/login|login\.php|\/checkpoint|two_factor|two_step|\/recover|\/authentication/i.test(finalUrl)) {
        return false;
      }
      // Còn thấy form đăng nhập => CHƯA đăng nhập
      const loginForm = page.locator('input#email, input#pass, input[name="pass"], button[name="login"]').first();
      if (await this.safeIsVisible(loginForm, 800)) return false;

      // /me chỉ được coi là ĐÃ đăng nhập khi có TÍN HIỆU DƯƠNG rõ ràng, KHÔNG chỉ vì
      // "URL khác trang chủ" (tránh false-positive khi bị cookie rác đẩy sang trang lạ):
      //   (a) URL là trang cá nhân thật (profile.php hoặc /<username>), KHÔNG phải root, VÀ
      //   (b) có cookie c_user hợp lệ HOẶC ít nhất một dấu hiệu DOM đã đăng nhập.
      const isRealProfileUrl =
        finalUrl.includes('facebook.com') &&
        !finalUrl.endsWith('facebook.com/') &&
        !finalUrl.endsWith('facebook.com') &&
        (finalUrl.includes('profile.php') || /facebook\.com\/[^/?#]+/.test(finalUrl));
      if (!isRealProfileUrl) return false;

      if (await this.getCUserCookie(page)) return true;

      const meLoggedInIndicators = [
        attrContainsSelector('aria-label', LOGGED_IN_ARIA_TOKENS),
        attrContainsSelector('placeholder', SEARCH_PLACEHOLDER_TOKENS),
        '[role="feed"]',
      ];
      for (const sel of meLoggedInIndicators) {
        if (page.isClosed()) return false;
        if (await this.safeIsVisible(page.locator(sel).first(), 1000)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * LoginStateDetector — nguồn phán quyết DUY NHẤT việc đã đăng nhập hay chưa.
   *
   * Chiến lược "kết hợp cả hai" (theo quyết định của người dùng):
   *   1. Nếu thấy FORM đăng nhập  -> chắc chắn CHƯA (phủ định tuyệt đối, thoát nhanh).
   *   2. Cookie `c_user`          -> bằng chứng chính, nhanh.
   *   3. Dấu hiệu DOM đã đăng nhập -> bằng chứng phụ (timeout dài hơn để tránh false-negative).
   *   4. Khi mâu thuẫn/độ tin cậy thấp -> xác minh bằng /me.
   *
   * KHÔNG dùng heuristic văn bản yếu (vd "Meta AI") để tránh báo thành công sai.
   */
  public async isRealLoggedIn(page: Page, profileId?: string): Promise<boolean> {
    if (!page || page.isClosed()) return false;
    let url = '';
    try {
      url = page.url();
    } catch {
      return false;
    }
    if (!url.includes('facebook.com')) return false;

    // ── 1. PHỦ ĐỊNH TUYỆT ĐỐI: Form đăng nhập / màn hình logout hiển thị ──
    const loggedOutIndicators = [
      'input#email',
      'input#pass',
      'button[name="login"]',
      '#loginbutton',
      hasTextSelector(['div', 'span', 'h2', 'a'], LOGGED_OUT_TOKENS),
    ];
    for (const sel of loggedOutIndicators) {
      if (page.isClosed()) return false;
      if (await this.safeIsVisible(page.locator(sel).first(), 800)) {
        return false; // Đang ở màn hình đăng nhập -> chắc chắn CHƯA đăng nhập!
      }
    }

    // Nếu đang ở giữa luồng xác thực (2FA/checkpoint) thì CHƯA thể coi là đã đăng nhập.
    const inAuthFlow = /two_factor|two_step|\/checkpoint|\/authentication|\/recover/i.test(url);

    // ── 2. BẰNG CHỨNG CHÍNH: cookie c_user ──
    const cUser = await this.getCUserCookie(page);

    // ── 3. BẰNG CHỨNG PHỤ: dấu hiệu DOM (timeout dài hơn -> giảm false-negative) ──
    const loggedInIndicators = [
      attrContainsSelector('aria-label', LOGGED_IN_ARIA_TOKENS),
      attrContainsSelector('placeholder', SEARCH_PLACEHOLDER_TOKENS),
      '[role="feed"]',
    ];
    let domPositive = false;
    for (const sel of loggedInIndicators) {
      if (page.isClosed()) return false;
      if (await this.safeIsVisible(page.locator(sel).first(), 1200)) {
        domPositive = true;
        break;
      }
    }

    // ── 4. TỔNG HỢP PHÁN QUYẾT ──
    // Cookie + DOM đồng thuận, và không ở giữa luồng auth => chắc chắn đã đăng nhập.
    if (cUser && domPositive && !inAuthFlow) return true;

    // Có cookie nhưng DOM chưa rõ (trang đang tải / URL trung gian) => xác minh /me.
    if (cUser && !inAuthFlow) {
      return await this.verifyViaMe(page, profileId);
    }

    // DOM nói đã đăng nhập nhưng KHÔNG có cookie => nghi ngờ, xác minh /me.
    if (domPositive && !cUser && !inAuthFlow) {
      return await this.verifyViaMe(page, profileId);
    }

    return false;
  }

  /**
   * Prepare Facebook login page: Always navigate directly to clean https://www.facebook.com/
   */
  private async prepareLoginPage(page: Page, targetUrl?: string, profileId?: string): Promise<void> {
    if (!page || page.isClosed()) return;
    try {
      const url = page.url();
      const isAlreadyLogged = await this.isRealLoggedIn(page, profileId);

      // Nếu tài khoản đã đăng nhập chuẩn, KHÔNG bao giờ reload lại trang chủ
      if (isAlreadyLogged) return;

      const isDirtyUrl =
        url.includes('login_attempt') ||
        url.includes('device-based') ||
        url.includes('people/') ||
        !url.includes('facebook.com');

      if (isDirtyUrl) {
        logger.info('🔄 Đưa trình duyệt về trang chủ chuẩn https://www.facebook.com/...');
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await sleep(2500);
      }
    } catch {}
  }

  /**
   * Universal Popup & Overlay Auto-Dismiss Sentinel (Handles Case 2: Dismiss warning / Cookie banners / Modal popups)
   */
  public async dismissAllKnownPopups(page: Page, profileId?: string): Promise<void> {
    if (!page || page.isClosed()) return;

    // 1. Nhấn phím Escape để dẹp ngay các popup/bubble nổi của Chrome
    await page.keyboard.press('Escape').catch(() => {});

    // 2. Dùng evaluate script click trực tiếp các nút Dismiss / Huỷ / Cancel / Chặn / Đóng trên DOM chính
    const dismissScript = `(function() {
      var TOK = ${JSON.stringify(DISMISS_POPUP_TOKENS)};
      var buttons = Array.from(document.querySelectorAll('button, div[role="button"], a, span'));
      for (var i = 0; i < buttons.length; i++) {
        var b = buttons[i];
        var text = (b.innerText || b.textContent || b.getAttribute('aria-label') || '').toLowerCase().trim();
        if (TOK.some(function(t){ return text.indexOf(t) !== -1; })) {
          try {
            b.click();
            b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          } catch(e) {}
        }
      }
    })()`;

    await page.evaluate(dismissScript).catch(() => {});

    // 3. Quét qua tất cả các frames (nếu popup nằm trong iframe như Google/Facebook One-Tap)
    try {
      for (const frame of page.frames()) {
        if (frame !== page.mainFrame()) {
          await frame.evaluate(dismissScript).catch(() => {});
        }
      }
    } catch {}

    await sleep(300);
  }

  /**
   * Handle Remember Browser / "Trust this device?" page
   * URL: https://www.facebook.com/two_factor/remember_browser
   * Giao diện: //span[text()="You're logged in. Trust this device?"]
   * Selector nút chính: //span[text()="Trust this device"]/ancestor::div[@role="none"][1]
   */
  private async handleRememberBrowser(page: Page, profileId?: string): Promise<void> {
    if (!page || page.isClosed()) return;
    logger.info('🎯 Đang xử lý trang "Trust this device? / Lưu trình duyệt này?"...');
    await this.dismissAllKnownPopups(page, profileId);

    const trustButtons = [
      // XPath chính xác theo đặc tả mới (ancestor div[role="none"])
      'xpath=//span[text()="Trust this device"]/ancestor::div[@role="none"][1]',
      // Fallback Playwright locators (đa ngôn ngữ qua dictionary i18n)
      hasTextSelector(['button', 'div[role="button"]', 'span'], [...TRUST_DEVICE_TOKENS, ...CONTINUE_TOKENS]),
      'button#checkpointSubmitButton',
      'button[type="submit"]',
    ];

    for (const sel of trustButtons) {
      if (page.isClosed()) return;
      const btn = page.locator(sel).first();
      if (await this.safeIsVisible(btn, 1500)) {
        logger.info(`Bấm nút [${sel}] để xác nhận Trust this device...`);
        await this.safeClick(btn, 3000);
        await sleep(4000);
        return;
      }
    }
  }

  /**
   * Handle Intermediate pages after 2FA (Remember Browser / Save Login Info / Dismiss automated behavior warning)
   */
  private async handleIntermediatePages(page: Page, profileId?: string): Promise<void> {
    for (let loop = 0; loop < 4; loop++) {
      if (!page || page.isClosed()) return;
      await this.dismissAllKnownPopups(page, profileId);
      const url = page.isClosed() ? '' : page.url();

      if (url.includes('remember_browser')) {
        await this.handleRememberBrowser(page, profileId);
      }

      // Xử lý thông báo "We suspect automated behavior on your account"
      const dismissBtn = page.locator(hasTextSelector(['button', 'div[role="button"]'], SUSPECT_DISMISS_TOKENS)).first();
      if (await this.safeIsVisible(dismissBtn, 1000)) {
        logger.info('🎯 Phát hiện cảnh báo "We suspect automated behavior" -> Bấm nút [Dismiss]...');
        await this.safeClick(dismissBtn, 3000);
        await sleep(3000);
      }

      if (url.includes('save_device') || url.includes('login_save')) {
        logger.info('Phát hiện trang Save Login Info -> Bấm Save/Continue...');
        const saveButtons = [hasTextSelector(['button'], [...SAVE_LOGIN_TOKENS, ...CONTINUE_TOKENS])];
        for (const sel of saveButtons) {
          const btn = page.locator(sel).first();
          if (await this.safeIsVisible(btn, 1500)) {
            await this.safeClick(btn, 3000);
            await sleep(3000);
            break;
          }
        }
      }

      if (await this.isRealLoggedIn(page, profileId)) {
        logger.info('🎉 Đã xác nhận đăng nhập thành công vào trang chính Facebook!');
        break;
      }

      await sleep(2000);
    }
  }

  /**
   * Directly fill and submit Facebook login form with physical mouse coordinates & synthetic events
   */
  private async fillAndSubmitLoginFormDirect(
    page: Page,
    username: string,
    password: string,
    profileId?: string
  ): Promise<boolean> {
    if (!page || page.isClosed()) return false;
    const emailInput = page.locator('input#email, input[name="email"], input[aria-label*="Email" i], input[type="text"]').first();
    const passInput = page.locator('input#pass, input[name="pass"], input[type="password"]').first();

    const emailVisible = await this.safeIsVisible(emailInput, 1500);
    const passVisible = await this.safeIsVisible(passInput, 1500);

    if (!emailVisible || !passVisible) return false;

    logger.info(`📝 Điền thông tin đăng nhập: Username=${username.slice(0, 6)}...`);

    // [P1b điểm 1 - D5] XÓA SẠCH từng ô trước khi gõ để không còn giá trị prefill/bị nối thêm.
    // Dùng MỘT đường tin cậy: clear -> fill -> submit (KHÔNG trộn native-set + fill + form.submit + Enter).
    await emailInput.click({ force: true }).catch(() => {});
    await emailInput.fill('').catch(() => {});
    if (password) await passInput.fill('').catch(() => {});

    // Xác minh ô đã trống; nếu chưa, xóa cứng qua DOM native setter rồi phát input event cho React.
    let emailVal = await emailInput.inputValue().catch(() => '');
    let passVal = password ? await passInput.inputValue().catch(() => '') : '';
    if (emailVal !== '' || passVal !== '') {
      await page.evaluate(`(function() {
        function clearNative(el) {
          if (!el) return;
          var proto = Object.getPrototypeOf(el);
          var desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
          if (desc && desc.set) { desc.set.call(el, ''); } else { el.value = ''; }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        clearNative(document.querySelector('input#email, input[name="email"], input[type="text"]'));
        clearNative(document.querySelector('input#pass, input[name="pass"], input[type="password"]'));
      })()`).catch(() => {});
      emailVal = await emailInput.inputValue().catch(() => '');
      passVal = password ? await passInput.inputValue().catch(() => '') : '';
    }
    if (emailVal !== '') {
      logger.warn('⚠️ Ô email chưa trống sau khi xóa -> vẫn tiếp tục điền đè một lần.');
    }

    // Điền MỘT lần bằng Playwright fill (tự phát input/change cho React) — email rồi password.
    await emailInput.fill(username).catch(() => {});
    if (password) await passInput.fill(password).catch(() => {});

    // [POPUP] Popup native của trình duyệt (gợi ý đăng nhập / lưu mật khẩu / xin quyền
    // thông báo) có thể tái xuất và CHE nút submit ngay lúc tương tác. ESC dọn popup
    // native TRƯỚC khi bấm submit. ESC chỉ đóng bong bóng/dropdown chứ không xoá ô đã
    // điền; vẫn xác minh lại giá trị và điền đè nếu bị xoá để KHÔNG mất credential đã gõ.
    await popupKiller.dismissNativePopup(page);
    if ((await emailInput.inputValue().catch(() => '')) !== username) {
      await emailInput.fill(username).catch(() => {});
    }
    if (password && (await passInput.inputValue().catch(() => '')) !== password) {
      await passInput.fill(password).catch(() => {});
    }

    logger.info('🚀 Bấm nút [Đăng nhập]...');
    await this.submitLoginForm(page, passInput);
    return true;
  }

  /**
   * Gửi (submit) form đăng nhập Facebook một cách tin cậy.
   *
   * UI đăng nhập hiện tại của Facebook (cả login.php lẫn trang chủ
   * www.facebook.com/) KHÔNG còn <button name="login"> thật; nút "Đăng nhập"
   * nhìn thấy là <div role="button"> và một synthetic click (kể cả chuột thật)
   * KHÔNG kích hoạt submit. Nút submit thật là <input type="submit"> ẩn bên trong
   * form. Vì vậy ta submit NATIVE ngay trên form chứa ô mật khẩu: bấm phần tử
   * submit gốc (dùng .value đã fill trong DOM), fallback requestSubmit()/submit().
   * Chỉ khi không tìm thấy form mới bấm nút hiển thị / nhấn Enter.
   */
  private async submitLoginForm(page: Page, passInput: Locator): Promise<boolean> {
    if (page.isClosed()) return false;
    const submitted = (await page.evaluate(`(function() {
      var pass = document.querySelector('input#pass, input[name="pass"], input[type="password"]');
      var form = pass ? pass.closest('form') : null;
      if (!form) return false;
      var submitEl = form.querySelector('input[type="submit"], button[type="submit"], button[name="login"]');
      try {
        if (submitEl && typeof submitEl.click === 'function') { submitEl.click(); return true; }
        if (typeof form.requestSubmit === 'function') { form.requestSubmit(); return true; }
        form.submit();
        return true;
      } catch (e) { return false; }
    })()`).catch(() => false)) as boolean;
    if (submitted) return true;

    // Không tìm thấy form (biến thể hiếm) -> bấm nút hiển thị thật, cuối cùng nhấn Enter.
    const btn = page.locator('button[name="login"], button[data-testid="royal_login_button"], #loginbutton, [role="button"][aria-label*="Đăng nhập" i], [role="button"][aria-label*="Log in" i]').first();
    if (await this.safeIsVisible(btn, 800)) {
      await this.safeClick(btn, 3000);
      return true;
    }
    await passInput.focus().catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    return true;
  }


  /**
   * [P1a điểm 2] Phân loại trạng thái theo CẤU TRÚC URL (không phụ thuộc ngôn ngữ).
   */
  private classifyUrlState(url: string): 'CHECKPOINT' | 'TWO_FACTOR' | 'LOGIN' | 'UNKNOWN' {
    if (!url) return 'UNKNOWN';
    let path = url.toLowerCase();
    let search = '';
    try {
      const parsed = new URL(url);
      path = parsed.pathname.toLowerCase();
      search = parsed.search.toLowerCase();
    } catch {}
    // Luồng 2FA sau khi nộp OTP đang redirect -> UNKNOWN để KHÔNG reload phá luồng tốt.
    if (url.includes('1501092823525282') || search.includes('flow=two_factor_login')) return 'UNKNOWN';
    if (path.includes('/two_factor') || path.includes('/two_step_verification')) return 'TWO_FACTOR';
    if (path.includes('/checkpoint')) return 'CHECKPOINT';
    if (path.includes('/login') || path.includes('login.php') || path.includes('/recover') || path.includes('/authentication')) return 'LOGIN';
    return 'UNKNOWN';
  }

  /**
   * [P1a điểm 2] Nhận diện trạng thái giao diện thực tế theo CẤU TRÚC DOM (không theo văn bản dịch).
   */
  private async detectUiState(page: Page): Promise<'CHECKPOINT' | 'TWO_FACTOR' | 'LOGIN' | 'LOGGED_IN' | 'NONE'> {
    if (!page || page.isClosed()) return 'NONE';
    if (await this.safeIsVisible(page.locator('div[role="feed"], div[role="navigation"], ' + attrContainsSelector('aria-label', ACCOUNT_ARIA_TOKENS)).first(), 300)) {
      return 'LOGGED_IN';
    }
    if (await this.safeIsVisible(page.locator('input[autocomplete="one-time-code"], input[name="approvals_code"], input[inputmode="numeric"]').first(), 300)) {
      return 'TWO_FACTOR';
    }
    if (await this.safeIsVisible(page.locator('#checkpointSubmitButton, form[action*="checkpoint"], input[type="file"], iframe[src*="captcha"], iframe[src*="arkoselabs"]').first(), 300)) {
      return 'CHECKPOINT';
    }
    if (await this.safeIsVisible(page.locator('input[name="pass"], input#pass, input[type="password"]').first(), 300)) {
      return 'LOGIN';
    }
    return 'NONE';
  }

  /**
   * Phát hiện reCAPTCHA/Arkose ĐANG THẬT SỰ HIỂN THỊ (không phải chỉ tồn tại trong DOM).
   *
   * LÝ DO: Facebook nhúng reCAPTCHA Enterprise chạy NGẦM (badge/aframe hoặc anchor 0-size) để chấm
   * điểm rủi ro trên NHIỀU trang 2FA hợp lệ. Dò theo "có anchor trong DOM" (cách cũ) cho FALSE POSITIVE
   * -> engine dừng nhầm với recapcha_detected dù màn hình thật là 2FA (TH1/TH2). Chỉ coi là chướng
   * ngại khi khung thử thách TƯƠNG TÁC (anchor checkbox / bframe / Arkose) render với KÍCH THƯỚC THẬT.
   *
   * Quy tắc: quét mọi frame; chỉ xét frame reCAPTCHA tương tác (url .../recaptcha/...anchor|bframe)
   * hoặc Arkose/FunCaptcha; với reCAPTCHA yêu cầu có phần tử thử thách (hoặc nhãn "I'm not a robot");
   * và phần tử <iframe> nhúng phải có boundingBox hiển thị thật (>60x40). Badge aframe/anchor ẩn -> bỏ.
   */
  private async detectVisibleRecaptcha(page: Page): Promise<boolean> {
    if (!page || page.isClosed()) return false;
    for (const frame of page.frames()) {
      let u = '';
      try { u = frame.url(); } catch { continue; }
      const isArkose = /arkoselabs|funcaptcha/i.test(u);
      const isRecaptchaInteractive = /\/recaptcha\/.*(anchor|bframe)/i.test(u);
      if (!isArkose && !isRecaptchaInteractive) continue;

      if (!isArkose) {
        // reCAPTCHA: xác nhận khung có phần tử thử thách hoặc nhãn "I'm not a robot" (đa ngôn ngữ).
        const hasChallenge = (await frame.evaluate(`(function(){
          try {
            if (document.querySelector('#recaptcha-anchor, .recaptcha-checkbox, .rc-imageselect, .rc-anchor-content, #rc-imageselect')) return true;
            var TOK = ${JSON.stringify(RECAPTCHA_TEXT_TOKENS)};
            var t = (document.body ? document.body.innerText : '').toLowerCase();
            return TOK.some(function(k){ return t.indexOf(k) !== -1; });
          } catch (e) { return false; }
        })()`).catch(() => false)) as boolean;
        if (!hasChallenge) continue;
      }

      // Khung nhúng phải HIỂN THỊ THẬT (boundingBox tính qua toàn chuỗi frame; ẩn -> null).
      try {
        const el = await frame.frameElement();
        const box = await el.boundingBox();
        if (box && box.width > 60 && box.height > 40) return true;
      } catch { /* frame đã detach */ }
    }
    return false;
  }

  /**
   * [P1a điểm 2 - UI ↔ URL RECONCILIATION] Khi URL đã chốt một trạng thái nhưng giao diện render
   * còn kẹt màn hình khác / chưa sẵn sàng, reload HỮU HẠN (≤2) để UI phản ánh đúng URL rồi re-detect.
   * Luôn hữu hạn — không bao giờ reload vô hạn.
   */
  private async reconcileUrlAndUi(page: Page): Promise<void> {
    const maxReloads = 2;
    for (let attempt = 0; attempt <= maxReloads; attempt++) {
      if (!page || page.isClosed()) return;
      const urlState = this.classifyUrlState(page.url());
      const uiState = await this.detectUiState(page);
      // Nhất quán khi: UI khớp URL, URL chưa xác định (để lớp khác/AI xử lý), hoặc UI đã đăng nhập.
      const consistent = uiState === urlState || urlState === 'UNKNOWN' || uiState === 'LOGGED_IN';
      if (consistent) return;
      // Reload khi: UI đang là MỘT trạng thái đã-biết KHÁC (mismatch thật), hoặc URL là trạng thái
      // luôn phải render nhanh (checkpoint/login) mà UI vẫn trống. (2FA có màn "chờ duyệt" hợp lệ
      // không có input -> KHÔNG reload để tránh phá luồng chờ phê duyệt thiết bị.)
      const knownMismatch = uiState !== 'NONE';
      const settledButBlank = uiState === 'NONE' && (urlState === 'CHECKPOINT' || urlState === 'LOGIN');
      if (!knownMismatch && !settledButBlank) return;
      if (attempt === maxReloads) return;
      logger.info(`🔁 [Reconcile] URL=${urlState} nhưng UI=${uiState} (chưa khớp/chưa sẵn sàng) -> reload ${attempt + 1}/${maxReloads} để UI phản ánh đúng URL...`);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await sleep(2000);
    }
  }
  /**
   * Autonomous State Machine Login Engine: Self-healing adaptive loop that evaluates the current page state,
   * handles every encountered obstacle (one-tap popup, guest page, credentials form, 2FA prompt,
   * remember device, save login info) and transitions smoothly until Feed/Terminal state.
   */
  private async runAutonomousLoginEngine(
    page: Page,
    username: string,
    password: string,
    fakey?: string,
    profileId: string = '',
    profileName: string = ''
  ): Promise<FacebookLoginResult> {
    const maxCycles = 12;
    // [Checkpoint MỀM] Interstitial "nghi ngờ hành vi tự động" (dismissible) chỉ bấm bỏ qua tối đa
    // maxSoftDismiss lần; nếu vẫn tái xuất thì coi như checkpoint cần người (tránh lặp vô hạn).
    let softCheckpointDismissCount = 0;
    const maxSoftDismiss = 3;

    for (let cycle = 1; cycle <= maxCycles; cycle++) {
      page = this.getAlivePage(profileId, page);
      if (!page || page.isClosed()) {
        return {
          success: false,
          status: 'needs_human_review',
          message: 'Trình duyệt đã bị đóng.',
          currentUrl: '',
          profileId,
          profileName,
        };
      }


      // [P1a điểm 2] Điều hòa URL ↔ giao diện trước khi phán quyết: reload hữu hạn nếu UI chưa
      // phản ánh đúng URL (URL đã chốt trạng thái nhưng màn hình còn kẹt / chưa render).
      await this.reconcileUrlAndUi(page);
      page = this.getAlivePage(profileId, page);
      await this.dismissAllKnownPopups(page, profileId);
      const currentUrl = page.url();
      const bodyText = (await page.evaluate('document.body ? document.body.innerText : ""').catch(() => '')) as string;
      logger.info(`[State Machine Chu kỳ ${cycle}/${maxCycles}] Trạng thái trang: ${currentUrl}`);

      // =======================================================================
      // 1. TRẠNG THÁI: ĐÃ ĐĂNG NHẬP THỰC SỰ (SUCCESS TERMINATION)
      // =======================================================================
      if (await this.isRealLoggedIn(page, profileId)) {
        logger.info('🎉 [STATE ENGINE] ĐÃ XÁC NHẬN ĐĂNG NHẬP THÀNH CÔNG VÀO FACEBOOK!');
        return {
          success: true,
          status: 'logged_in',
          message: 'Đã tự động đăng nhập và xác thực tài khoản Facebook thành công.',
          currentUrl,
          profileId,
          profileName,
        };
      }

      // =======================================================================
      // 1.5. TRẠNG THÁI: URL ĐĂNG NHẬP LỖI / CHỨA LOGIN_ATTEMPT -> ĐƯA VỀ FACEBOOK.COM
      // =======================================================================
      if (
        (currentUrl.includes('login_attempt') || currentUrl.includes('/login/device-based/')) &&
        (bodyText.includes('không kết nối với tài khoản') || bodyText.includes('isn’t connected to an account'))
      ) {
        logger.warn('⚠️ Phát hiện form lưu lỗi cũ (login_attempt) -> Đang chuyển hướng về https://www.facebook.com/ để tải lại form sạch...');
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await sleep(3000);
        continue;
      }

      // =======================================================================
      // 2. TRẠNG THÁI: TRANG LỖI KỸ THUẬT FACEBOOK ("Trang này hiện không hiển thị" - Ảnh 2)
      // =======================================================================
      const isTechErrorPage =
        bodyText.includes('Trang này hiện không hiển thị') ||
        bodyText.includes('This page isn\'t available right now') ||
        bodyText.includes('This page isn\'t available') ||
        bodyText.includes('Esta página não está disponível') ||
        bodyText.includes('lỗi kỹ thuật mà chúng tôi đang nỗ lực khắc phục') ||
        bodyText.includes('technical error');

      if (isTechErrorPage) {
        logger.warn('⚠️ Phát hiện trang lỗi kỹ thuật Facebook ("Trang này hiện không hiển thị") -> Tự động chuyển hướng về trang chủ https://www.facebook.com/...');
        const reloadBtn = page.locator(hasTextSelector(['button'], RELOAD_PAGE_TOKENS)).first();
        if (await this.safeIsVisible(reloadBtn, 500)) {
          await this.safeClick(reloadBtn, 1000);
        }
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await sleep(3000);
        continue;
      }

      // =======================================================================
      // 3. TRẠNG THÁI: CHECKPOINT KHÓA TÀI KHOẢN / BẮT XÁC MINH CON NGƯỜI
      // =======================================================================
      const checkpointInfo = await this.detectCheckpoint(page, profileId);
      if (checkpointInfo.isCheckpoint) {
        // Checkpoint MỀM (dismissible): /checkpoint + next=facebook.com + KHÔNG có input thu thập
        // dữ liệu + đúng MỘT nút hành động chính. Bấm nút (KHÔNG theo chữ) rồi để engine tái phán
        // quyết chu kỳ sau (isRealLoggedIn xác nhận). Bounded để không lặp vô hạn.
        if (checkpointInfo.type === 'SOFT_DISMISSIBLE' && softCheckpointDismissCount < maxSoftDismiss) {
          softCheckpointDismissCount++;
          logger.info(`ℹ️ [Checkpoint MỀM] Phát hiện interstitial có thể bỏ qua (lần ${softCheckpointDismissCount}/${maxSoftDismiss}) -> bấm nút bỏ qua theo HÌNH HỌC (không theo chữ)...`);
          const dismissed = await this.clickSoftCheckpointDismiss(page);
          logger.info(`ℹ️ [Checkpoint MỀM] Kết quả bấm bỏ qua: ${dismissed ? 'đã rời trang checkpoint' : 'chưa rời -> để engine kiểm tra lại chu kỳ sau'}.`);
          await sleep(1500);
          continue;
        }
        return this.reportCheckpointResult(page, profileId, profileName, checkpointInfo);
      }

      // =======================================================================
      // 4. TRẠNG THÁI: SAI MẬT KHẨU (WRONG PASSWORD)
      // =======================================================================
      if (matchesAnyToken(bodyText, WRONG_PASSWORD_TOKENS)) {
        return {
          success: false,
          status: 'failed',
          message: '❌ Đăng nhập thất bại: Mật khẩu bạn đã nhập không chính xác (Wrong Password). Vui lòng cập nhật mật khẩu mới trên AdsPower.',
          currentUrl,
          profileId,
          profileName,
        };
      }

      // =======================================================================
      // 4.5. TRẠNG THÁI: EMAIL / UID KHÔNG KẾT NỐI VỚI TÀI KHOẢN NÀO
      // =======================================================================
      if (matchesAnyToken(bodyText, ACCOUNT_NOT_FOUND_TOKENS)) {
        logger.error(`❌ Facebook báo tài khoản không tồn tại / UID không khớp cho profile "${profileName}"!`);
        return {
          success: false,
          status: 'failed',
          message: '❌ Đăng nhập thất bại: Email hoặc UID bạn nhập không kết nối với tài khoản nào trên Facebook. Vui lòng kiểm tra lại UID.',
          currentUrl,
          profileId,
          profileName,
        };
      }

      // =======================================================================
      // 5. TRẠNG THÁI: INTERACTIVE CAPTCHA PUZZLE (CHALLENGE)
      // =======================================================================
      // [P1a điểm 1] iframe Arkose/FunCaptcha/challenge là tín hiệu CẤU TRÚC đủ mạnh, KHÔNG phụ
      // thuộc ngôn ngữ. iframe captcha/recaptcha chung mới cần thêm gợi ý thao tác (đa ngôn ngữ).
      const hasArkoseChallenge = await this.safeIsVisible(
        page.locator('iframe[src*="arkoselabs"], iframe[src*="funcaptcha"], iframe[title*="challenge" i]').first(),
        500
      );
      const hasGenericCaptcha = await this.safeIsVisible(
        page.locator('iframe[src*="captcha"], iframe[src*="recaptcha"], #captcha').first(),
        500
      );
      const genericCaptchaHint = matchesAnyToken(bodyText, CAPTCHA_HINT_TOKENS);
      if (hasArkoseChallenge || (hasGenericCaptcha && genericCaptchaHint)) {
        logger.warn(`⚠️ Phát hiện Interactive CAPTCHA Challenge bắt giải đố tại: ${currentUrl}`);
        broadcastEvent('system_alert', {
          type: 'recapcha_detected',
          profileId,
          profileName,
          url: currentUrl,
          message: 'Facebook yêu cầu giải CAPTCHA / Puzzle thủ công.',
          time: new Date().toLocaleTimeString(),
        });
        return {
          success: false,
          status: 'recapcha_detected',
          message: `Facebook yêu cầu giải CAPTCHA / Puzzle xác thực: ${currentUrl}`,
          currentUrl,
          profileId,
          profileName,
        };
      }

      // =======================================================================
      // 6. TRẠNG THÁI: URL /two_step_verification/authentication/ (Trường hợp 3 theo đặc tả)
      // Trang này có thể chứa giao diện TH1 (Check notifications) hoặc TH2 (Go to auth app)
      // hoặc là silent check thực sự. Cần kiểm tra giao diện trước khi quyết định.
      // =======================================================================
      if (currentUrl.includes('/two_step_verification/authentication')) {
        logger.info('⏳ [2FA TH3] URL /authentication/ (mơ hồ) -> phân giải theo GIAO DIỆN đã render (reCAPTCHA vs 2FA)...');

        // [Resolver theo đặc tả — TH3] URL /authentication/ mơ hồ: giao diện có thể là 2FA (TH1/TH2)
        // đang render dở, đã redirect sang two_factor, HOẶC reCAPTCHA tương tác. Settle tối đa 5 lần.
        // THỨ TỰ ƯU TIÊN (đã sửa): giao diện 2FA TRƯỚC, reCAPTCHA chỉ khi THẬT SỰ HIỂN THỊ.
        //  (A) URL đã redirect sang two_factor -> để nhánh 2FA (mục 7) xử lý.
        //  (B) UI 2FA (TH1 "Check notifications" / TH2 "Go to auth app" / ô nhập mã) -> xử lý 2FA ngay.
        //  (C) reCAPTCHA/Arkose ĐANG HIỂN THỊ THẬT (detectVisibleRecaptcha) và dai dẳng sau ngân sách
        //      reload -> recapcha_detected (GIỮ MỞ). Anchor NGẦM/0-size KHÔNG còn khiến dừng nhầm.
        //  (D) chưa xác định -> reload settle rồi thử lại.
        const maxSettle = 5;
        for (let attempt = 1; attempt <= maxSettle; attempt++) {
          page = this.getAlivePage(profileId, page);
          if (!page || page.isClosed()) break;
          await sleep(2000); // chờ UI render đầy đủ trước khi phân loại
          await this.dismissAllKnownPopups(page, profileId);
          const urlNow = page.isClosed() ? '' : page.url();

          // (A) Đã redirect sang two_factor -> thoát resolver, để mục 7 (nhánh 2FA) xử lý.
          if (urlNow.includes('/two_step_verification/two_factor') || urlNow.includes('/two_factor')) {
            logger.info('[2FA TH3] URL đã chuyển sang two_factor -> chuyển sang xử lý 2FA (mục 7).');
            break;
          }

          // (B) UI 2FA hiện trực tiếp: TH1 "Check notifications" / TH2 "Go to auth app" / đã có ô nhập mã.
          //     ƯU TIÊN CAO HƠN reCAPTCHA: khi màn hình thật là 2FA, thao tác như TH1/TH2 (đặc tả).
          const bodyNow = ((await page.evaluate('document.body ? document.body.innerText : ""').catch(() => '')) as string);
          const th = matchesAnyToken(bodyNow, [...DEVICE_NOTIFICATION_TOKENS, ...GO_TO_AUTH_APP_TOKENS]);
          const hasCode = await page.evaluate(`(function() {
            return !!document.querySelector('input[type="text"][autocomplete="off"], input[name="approvals_code"], input[autocomplete="one-time-code"]');
          })()`).catch(() => false);
          const twoFAUiPresent = th || hasCode;
          if (twoFAUiPresent) {
            logger.info('[2FA TH3] Giao diện 2FA (TH1/TH2/ô nhập mã) đã render -> xử lý như 2FA.');
            if (!fakey) {
              return {
                success: false, status: 'needs_human_review',
                message: 'Trang yêu cầu 2FA nhưng profile không có 2FA Secret Key.',
                currentUrl: urlNow, profileId, profileName,
              };
            }
            const res2faFromTH3 = await this.handleTwoFactorPage(page, profileId, profileName, fakey);
            if (res2faFromTH3.success || res2faFromTH3.status === 'two_factor_in_progress') {
              await sleep(3000);
              break; // chưa xác nhận đăng nhập -> để engine tái phán quyết chu kỳ sau
            }
            return res2faFromTH3;
          }

          // (C) CAPTCHA cần người: CHỈ khi reCAPTCHA/Arkose ĐANG HIỂN THỊ THẬT (khung tương tác có
          //     kích thước thật). Reload trong ngân sách; dai dẳng đến hết -> STOP giữ browser MỞ.
          const hasVisibleCaptcha = await this.detectVisibleRecaptcha(page);
          if (hasVisibleCaptcha) {
            logger.warn(`⚠️ [2FA TH3] reCAPTCHA/Arkose ĐANG HIỂN THỊ THẬT (lần ${attempt}/${maxSettle}) tại: ${urlNow}`);
            if (attempt < maxSettle) {
              await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
              continue;
            }
            broadcastEvent('system_alert', {
              type: 'recapcha_detected', profileId, profileName, url: urlNow,
              message: 'reCAPTCHA cần người dùng vào xử lý.',
              time: new Date().toLocaleTimeString(),
            });
            return {
              success: false, status: 'recapcha_detected',
              message: `reCAPTCHA cần người dùng vào xử lý: ${urlNow}`,
              currentUrl: urlNow, profileId, profileName,
            };
          }

          // (D) Chưa xác định (UI chưa render xong / trang trung gian) -> reload settle rồi thử lại.
          logger.info(`[2FA TH3] Giao diện chưa xác định (lần ${attempt}/${maxSettle}) -> reload settle...`);
          if (attempt < maxSettle) {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          }
        }
        continue;
      }

      // =======================================================================
      // 7. TRẠNG THÁI: TRANG XÁC THỰC 2FA (Two-Factor Authentication)
      // =======================================================================
      const is2FA =
        (currentUrl.includes('/two_step_verification/two_factor') ||
         currentUrl.includes('/two_factor') ||
         currentUrl.includes('two-factor') ||
         currentUrl.includes('two_step')) &&
        !currentUrl.includes('remember_browser');

      if (is2FA) {
        logger.info('🔐 Phát hiện trang xác thực 2FA -> Đang tự động tạo OTP và điền mã...');
        if (!fakey) {
          logger.error('❌ Profile không có 2FA Secret Key (fakey) để tạo mã OTP!');
          return {
            success: false,
            status: 'needs_human_review',
            message: 'Trang yêu cầu 2FA nhưng profile không có 2FA Secret Key.',
            currentUrl,
            profileId,
            profileName,
          };
        }
        const res2fa = await this.handleTwoFactorPage(page, profileId, profileName, fakey);
        if (res2fa.success || res2fa.status === 'two_factor_in_progress') {
          await sleep(3000);
          continue; // Vòng lặp tiếp tục: xử lý Remember Browser / xác nhận đăng nhập thật
        } else {
          return res2fa;
        }
      }

      // =======================================================================
      // 8. TRẠNG THÁI: REMEMBER BROWSER / SAVE LOGIN INFO / TRUST THIS DEVICE
      // =======================================================================
      if (
        currentUrl.includes('remember_browser') ||
        currentUrl.includes('save_device') ||
        currentUrl.includes('login_save') ||
        bodyText.includes('Nhớ trình duyệt') ||
        bodyText.includes('Remember browser') ||
        bodyText.includes('Lưu thông tin đăng nhập')
      ) {
        logger.info('🎯 Phát hiện trang "Remember Browser / Save Info" -> Tự động bấm Lưu/Tiếp tục...');
        await this.handleRememberBrowser(page, profileId);
        await sleep(2500);
        continue;
      }

      // =======================================================================
      // 9. TRẠNG THÁI: POPUP ONE-TAP "Đăng nhập bằng <Account>"
      // =======================================================================
      const closeAria = CLOSE_ARIA_TOKENS.map(t => `div[role="dialog"] [aria-label*="${t}" i]`).join(', ');
      const oneTapCloseBtn = page.locator(hasTextSelector(['div[role="dialog"] button'], ONE_TAP_CANCEL_TOKENS) + ', ' + closeAria).first();
      if (await this.safeIsVisible(oneTapCloseBtn, 800)) {
        logger.info('🎯 Phát hiện Popup One-Tap -> Bấm [Huỷ] để đóng popup...');
        await this.safeClick(oneTapCloseBtn, 1000);
        // Gửi Escape để đảm bảo đóng hoàn toàn (theo đặc tả)
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(500);
        // Xóa backdrop overlay (phông nền mờ) nếu còn cản trở giao diện
        await page.evaluate(`(function() {
          var overlays = Array.from(document.querySelectorAll(
            'div[data-testid*="backdrop"], div[class*="backdrop"], div[style*="rgba(0, 0, 0"],' +
            'div[style*="background-color: rgba"], div[role="presentation"][style*="opacity"]'
          ));
          overlays.forEach(function(el) {
            el.style.display = 'none';
            el.style.pointerEvents = 'none';
            el.style.opacity = '0';
          });
        })()`).catch(() => {});
        await sleep(800);
        continue;
      }

      // =======================================================================
      // 10. TRẠNG THÁI: FORM ĐĂNG NHẬP HIỆN HỮU (Email/Username + Password)
      // =======================================================================
      const emailInput = page.locator('input#email, input[name="email"], input[aria-label*="Email" i], input[type="text"]').first();
      const passInput = page.locator('input#pass, input[name="pass"], input[type="password"]').first();
      const emailVisible = await this.safeIsVisible(emailInput, 1000);
      const passVisible = await this.safeIsVisible(passInput, 1000);

      if (emailVisible && passVisible) {
        logger.info(`📝 Phát hiện Form Đăng Nhập -> Kiểm tra Autofill & Xử lý...`);
        const submitted = await this.fillAndSubmitLoginFormDirect(page, username, password, profileId);
        if (submitted) {
          await sleep(3500);
          continue;
        }
      }

      // =======================================================================
      // 11. TRẠNG THÁI: TRANG CÁ NHÂN KHÁCH (PEOPLE / PROFILE.PHP / GUEST PAGE)
      // =======================================================================
      if (currentUrl.includes('/people/') || currentUrl.includes('profile.php') || !currentUrl.includes('facebook.com')) {
        const topLoginBtn = page.locator('a[href*="/login/"], ' + hasTextSelector(['a', 'button'], LOGIN_BUTTON_TOKENS)).first();
        if (await this.safeIsVisible(topLoginBtn, 1000)) {
          logger.info('👤 Đang ở trang khách -> Bấm nút [Đăng nhập] trên giao diện...');
          await this.safeClick(topLoginBtn, 3000);
          await sleep(3000);
          continue;
        } else {
          logger.info('👤 Đang ở trang khách -> Điều hướng trực tiếp sang https://www.facebook.com/login.php...');
          await page.goto('https://www.facebook.com/login.php', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await sleep(3000);
          continue;
        }
      }

      // =======================================================================
      // 12. TRẠNG THÁI: LOGIN.PHP?NEXT=... NHƯNG CHƯA TẢI XONG FORM
      // =======================================================================
      if (currentUrl.includes('login.php')) {
        logger.info('🔄 Đang ở trang login.php -> Chờ form đăng nhập hoặc tải lại trang...');
        await page.goto('https://www.facebook.com/login.php', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await sleep(3000);
        continue;
      }

      // =======================================================================
      // 13. TRẠNG THÁI: CHUYỂN TIẾP SAU 2FA (1501092823525282 HOẶC CHECKPOINT REDIRECT)
      // =======================================================================
      if (currentUrl.includes('1501092823525282') || (currentUrl.includes('checkpoint') && currentUrl.includes('next='))) {
        logger.info('✨ Đang ở trang chuyển tiếp sau 2FA -> Chờ 2s hoặc chuyển thẳng vào Feed Facebook...');
        await sleep(2000);
        if (await this.isRealLoggedIn(page, profileId)) {
          return {
            success: true,
            status: 'logged_in',
            message: 'Đã tự động đăng nhập và xác thực Facebook thành công.',
            currentUrl,
            profileId,
            profileName,
          };
        }
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await sleep(3000);
        continue;
      }

      // =======================================================================
      // 14. TRẠNG THÁI: TRANG TRUNG GIAN KHÔNG XÁC ĐỊNH -> AI HEURISTIC / VISION ANALYSIS
      // =======================================================================
      logger.info('🤖 Kích hoạt AI Page Analyzer để phân tích và tự giải quyết trang chưa xác định...');
      const aiAnalysis = await aiPageAnalyzer.analyzeAndResolve(page, currentUrl, profileId);

      // ⚠️ AI KHÔNG có quyền tuyên bố ĐÃ ĐĂNG NHẬP. Chỉ LoginStateDetector
      // (cookie c_user / /me) mới được phán quyết success. AI chỉ hỗ trợ thao tác.
      if (await this.isRealLoggedIn(page, profileId)) {
        logger.info('🎉 [LoginDetector] Xác nhận tài khoản ĐÃ ĐĂNG NHẬP THÀNH CÔNG!');
        return {
          success: true,
          status: 'logged_in',
          message: 'Đã xác nhận tài khoản Facebook đăng nhập thành công (cookie c_user / /me).',
          currentUrl,
          profileId,
          profileName,
        };
      }

      if (aiAnalysis.classification === 'SOLVABLE_INTERACTION' && aiAnalysis.recommendedSelector) {
        logger.info(`🎯 [AI Action] AI phát hiện thao tác có thể tự xử lý: Bấm [${aiAnalysis.recommendedSelector}]`);
        const targetBtn = page.locator(aiAnalysis.recommendedSelector).first();
        if (await this.safeIsVisible(targetBtn, 1500)) {
          await this.safeClick(targetBtn, 3000);
          await sleep(2500);
          continue;
        }
      }

      if (aiAnalysis.classification === 'UNSOLVABLE_OBSTACLE') {
        logger.error(`🚨 [AI Obstacle] AI xác định chướng ngại không thể tự giải quyết: ${aiAnalysis.reason}`);
        broadcastEvent('system_alert', {
          type: 'ai_unsolvable_obstacle',
          profileId,
          profileName,
          reason: aiAnalysis.reason,
          url: currentUrl,
          time: new Date().toLocaleTimeString(),
        });
        return {
          success: false,
          status: 'needs_human_review',
          message: `🚨 AI xác định vấn đề cần con người xử lý: ${aiAnalysis.reason}`,
          currentUrl,
          profileId,
          profileName,
        };
      }

      // Nếu AI chưa thể phân loại chắc chắn, thực hiện đưa về facebook.com để làm sạch
      logger.info('🔄 Đang điều hướng về https://www.facebook.com/ để làm sạch trang...');
      await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(3000);
      continue;
    }

    page = this.getAlivePage(profileId, page);
    const finalUrl = page.isClosed() ? '' : page.url();
    const isFinalLogged = await this.isRealLoggedIn(page, profileId);

    if (isFinalLogged) {
      return {
        success: true,
        status: 'logged_in',
        message: 'Đã tự động đăng nhập và xác thực Facebook thành công.',
        currentUrl: finalUrl,
        profileId,
        profileName,
      };
    }

    return {
      success: false,
      status: 'needs_human_review',
      message: `Đang ở trang: ${finalUrl}. Cần kiểm tra thêm.`,
      currentUrl: finalUrl,
      profileId,
      profileName,
    };
  }


  /**
   * Helper to report Checkpoint Result
   */
  private reportCheckpointResult(
    page: Page,
    profileId: string,
    profileName: string,
    checkpointInfo: { isCheckpoint: boolean; type?: string; detail?: string }
  ): FacebookLoginResult {
    const currentUrl = page.isClosed() ? '' : page.url();
    logger.error(`🚨 PHÁT HIỆN CHECKPOINT: [${checkpointInfo.type}] - ${checkpointInfo.detail}`);

    broadcastEvent('system_alert', {
      type: 'checkpoint_detected',
      profileId,
      profileName,
      checkpointType: checkpointInfo.type,
      detail: checkpointInfo.detail,
      url: currentUrl,
      time: new Date().toLocaleTimeString(),
    });

    return {
      success: false,
      status: 'checkpoint_human_verification',
      message: `🚨 Tài khoản gặp CHECKPOINT (${checkpointInfo.type}): ${checkpointInfo.detail}`,
      currentUrl,
      profileId,
      profileName,
      details: checkpointInfo,
    };
  }

  /**
   * Detect Facebook Checkpoint / Account Lock / Identity Verification
   */
  private async detectCheckpoint(page: Page, profileId?: string): Promise<{ isCheckpoint: boolean; type?: string; detail?: string }> {
    if (!page || page.isClosed()) return { isCheckpoint: false };
    let url = '';
    let bodyText = '';
    try {
      url = page.url();
      bodyText = (await page.evaluate('document.body ? document.body.innerText : ""').catch(() => '')) as string;
    } catch {
      return { isCheckpoint: false };
    }

    // 1. Checkpoint Bắt Xác Minh Con Người (Confirm you are human)
    if (matchesAnyToken(bodyText, HUMAN_VERIFICATION_TOKENS)) {
      return {
        isCheckpoint: true,
        type: 'HUMAN_VERIFICATION_REQUIRED',
        detail: 'Facebook yêu cầu xác minh con người',
      };
    }

    // 2. Checkpoint Két Sắt / Khóa tài khoản (Account Locked / Suspended)
    if (matchesAnyToken(bodyText, ACCOUNT_LOCKED_TOKENS)) {
      return {
        isCheckpoint: true,
        type: 'ACCOUNT_LOCKED',
        detail: 'Tài khoản bị khóa/tạm ngưng',
      };
    }

    // 3. Checkpoint Bắt Xác Minh Danh Tính (Upload ID / Selfie / Phone SMS)
    if (matchesAnyToken(bodyText, IDENTITY_VERIFICATION_TOKENS)) {
      return {
        isCheckpoint: true,
        type: 'IDENTITY_VERIFICATION',
        detail: 'Facebook yêu cầu tải giấy tờ/SMS',
      };
    }

    // 4. URL Checkpoint thực sự (Path là /checkpoint chứ không phải query param ?checkpoint_src=...)
    let isActualCheckpointPath = false;
    try {
      const parsedUrl = new URL(url);
      isActualCheckpointPath = parsedUrl.pathname.includes('/checkpoint');
    } catch {
      isActualCheckpointPath = url.includes('/checkpoint/') || url.includes('/checkpoint?');
    }

    // Ngoại lệ: 1501092823525282 và flow=two_factor_login là tín hiệu ĐẶC THÙ của luồng 2FA sau
    // khi nộp OTP (đang điều hướng về next=...). KHÔNG loại theo tham số next= chung chung: trang
    // /checkpoint THẬT cũng mang ?next=https://www.facebook.com/ nên loại theo next= sẽ nuốt checkpoint.
    if (url.includes('1501092823525282') || url.includes('flow=two_factor_login')) {
      return { isCheckpoint: false };
    }

    if (isActualCheckpointPath && !url.includes('two_factor') && !url.includes('remember_browser')) {
      // [P1a điểm 1] BỎ suppression theo chữ "Dismiss"/"We suspect automated behavior" (phụ thuộc
      // ngôn ngữ và che lấp checkpoint thật). Chỉ bỏ qua khi CHẮC CHẮN đã đăng nhập theo bằng chứng
      // cookie-authoritative (isRealLoggedIn). KHÔNG dùng div[role="navigation"] làm tín hiệu: trang
      // /checkpoint của Facebook CŨNG render thanh điều hướng này (bằng chứng DOM thực tế ở profile 5),
      // nên nav đơn thuần sẽ nuốt checkpoint thật. isRealLoggedIn=false trong MỌI luồng auth (gồm
      // /checkpoint) -> checkpoint thật KHÔNG bao giờ bị bỏ qua nhầm.
      const stronglyLoggedIn = await this.isRealLoggedIn(page, profileId);
      if (stronglyLoggedIn) {
        return { isCheckpoint: false };
      }

      // Phân loại kiểu checkpoint theo CẤU TRÚC (không theo văn bản dịch).
      // (a) Có ô upload giấy tờ / ảnh danh tính => IDENTITY_VERIFICATION (checkpoint CỨNG).
      const hasIdentityUpload = await this.safeIsVisible(
        page.locator('input[type="file"], input[accept*="image" i]').first(),
        300
      );
      if (hasIdentityUpload) {
        return { isCheckpoint: true, type: 'IDENTITY_VERIFICATION', detail: `Đang ở URL checkpoint (yêu cầu giấy tờ/danh tính): ${url}` };
      }

      // (b) Checkpoint MỀM (dismissible): interstitial "nghi ngờ hành vi tự động".
      //     Cấu trúc (locale-independent, KHÔNG theo chữ "Dismiss"/"Ignorer"): URL /checkpoint có
      //     next= trỏ về facebook.com, KHÔNG có input thu thập dữ liệu (file/password/OTP/tel/radio),
      //     và ĐÚNG MỘT nút hành động chính (nút rộng dạng chữ, không phải icon chrome nhỏ). Bấm nút
      //     này sẽ xóa màn hình và cho phiên tiếp tục. Đây KHÔNG phải suppression theo chữ như P1a đã bỏ.
      const lowerUrl = url.toLowerCase();
      const hasNextToFacebook =
        lowerUrl.includes('next=https%3a%2f%2fwww.facebook.com') ||
        lowerUrl.includes('next=https%3a%2f%2ffacebook.com') ||
        lowerUrl.includes('next=https://www.facebook.com') ||
        lowerUrl.includes('next=https://facebook.com');
      if (hasNextToFacebook) {
        const dataInputCount = (await page.evaluate(
          `document.querySelectorAll('input[type="file"], input[type="password"], input[type="tel"], input[autocomplete="one-time-code"], input[name="approvals_code"], input[type="radio"]').length`
        ).catch(() => 1)) as number; // lỗi -> coi như CÓ input (an toàn: KHÔNG auto-dismiss)
        if (dataInputCount === 0) {
          const primaryButtons = await this.countPrimaryActionButtons(page);
          if (primaryButtons === 1) {
            return { isCheckpoint: true, type: 'SOFT_DISMISSIBLE', detail: `Interstitial checkpoint MỀM (dismissible) tại: ${url}` };
          }
        }
      }

      // (c) Còn lại: checkpoint CỨNG chung -> terminal keep-open.
      return {
        isCheckpoint: true,
        type: 'GENERIC_CHECKPOINT',
        detail: `Đang ở URL checkpoint: ${url}`,
      };
    }

    return { isCheckpoint: false };
  }

  /**
   * Đếm số nút HÀNH ĐỘNG CHÍNH trên trang theo HÌNH HỌC (không theo chữ, locale-independent).
   * Nút hành động chính = nút [role=button]/button rộng dạng chữ (>= 120px); loại nút icon vuông
   * nhỏ (back/settings ~40px) và phần tử ẩn. Dùng để phát hiện interstitial "một nút bỏ qua".
   */
  private async countPrimaryActionButtons(page: Page): Promise<number> {
    if (!page || page.isClosed()) return 0;
    return (await page.evaluate(`(function(){
      var els = Array.prototype.slice.call(document.querySelectorAll('div[role="button"], button, a[role="button"]'));
      var n = 0;
      for (var i = 0; i < els.length; i++) {
        var r = els[i].getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue; // ẩn
        if (r.width < 120) continue;                  // nút icon nhỏ (chrome điều hướng) -> bỏ
        n++;
      }
      return n;
    })()`).catch(() => 0)) as number;
  }

  /** Còn đang ở URL /checkpoint hay không (dùng để xác minh bấm bỏ qua đã thành công). */
  private isStillOnCheckpointUrl(page: Page): boolean {
    if (!page || page.isClosed()) return false;
    const u = page.url();
    try { return new URL(u).pathname.includes('/checkpoint'); } catch { return u.includes('/checkpoint'); }
  }

  /**
   * Bấm nút bỏ qua của checkpoint MỀM theo HÌNH HỌC (KHÔNG theo chữ) -> locale-independent.
   * Thứ tự thử (leo thang khi chưa rời trang checkpoint):
   *   1. Bấm trực tiếp nút hành động chính RỘNG nhất ([role=button]/button, force).
   *   2. Bấm lớp phủ inset chặn-click nằm ĐÈ lên nút (div[data-visualcompletion="ignore"][style*="inset"]).
   *   3. Focus nút + Enter.
   * Dọn popup native (ESC) trước để không bị popup che nút. Trả về true nếu đã rời trang checkpoint.
   */
  private async clickSoftCheckpointDismiss(page: Page): Promise<boolean> {
    if (!page || page.isClosed()) return false;
    // Dọn popup native che nút trước khi bấm (tái dùng ESC đã có, không xoá dữ liệu).
    await popupKiller.dismissNativePopup(page).catch(() => {});

    // Tìm nút hành động CHÍNH theo HÌNH HỌC: nút RỘNG nhất (>= 120px), bỏ nút icon vuông nhỏ.
    const candidates = page.locator('div[role="button"], button, a[role="button"]');
    const total = await candidates.count().catch(() => 0);
    let best: Locator | null = null;
    let bestW = 0;
    for (let i = 0; i < total; i++) {
      const el = candidates.nth(i);
      if (!(await this.safeIsVisible(el, 150))) continue;
      const bb = await el.boundingBox().catch(() => null);
      if (!bb || bb.width < 120) continue;
      if (bb.width > bestW) { bestW = bb.width; best = el; }
    }

    // Chiến lược 1: bấm trực tiếp nút chính (force).
    if (best) {
      await best.scrollIntoViewIfNeeded().catch(() => {});
      await this.safeClick(best, 2500);
      await sleep(1200);
      if (!this.isStillOnCheckpointUrl(page)) return true;
    }

    // Chiến lược 2: bấm lớp phủ inset chặn-click nằm đè trên nút.
    const inset = page.locator('div[data-visualcompletion="ignore"][style*="inset"]').first();
    if (await this.safeIsVisible(inset, 300)) {
      await this.safeClick(inset, 1500);
      await sleep(1200);
      if (!this.isStillOnCheckpointUrl(page)) return true;
    }

    // Chiến lược 3: focus nút + Enter.
    if (best && !page.isClosed()) {
      await best.focus().catch(() => {});
      await page.keyboard.press('Enter').catch(() => {});
      await sleep(1200);
      if (!this.isStillOnCheckpointUrl(page)) return true;
    }

    return false;
  }

  /**
   * [P1b điểm 3] Điền mã 2FA đúng MỘT lần: xóa sạch ô -> fill -> xác minh giá trị == mã.
   * Chỉ dùng DOM native setter làm FALLBACK khi fill chưa ăn (tránh nhân đôi/ba mã).
   */
  private async fillCodeInputOnce(page: Page, codeInput: Locator, code: string): Promise<boolean> {
    await codeInput.click({ force: true }).catch(() => {});
    await codeInput.fill('').catch(() => {});
    await codeInput.fill(code).catch(() => {});
    await sleep(150);
    let val = await codeInput.inputValue().catch(() => '');
    if (val !== code) {
      await page.evaluate(`(function(totpCode) {
        var inputs = Array.from(document.querySelectorAll('input[type="text"][autocomplete="off"], input[autocomplete="one-time-code"], input[name="approvals_code"], input[type="text"], input[type="number"]'));
        var input = inputs.find(function(i) { return i.offsetWidth > 0 && i.offsetHeight > 0; }) || inputs[0];
        if (input) {
          var proto = Object.getPrototypeOf(input);
          var desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
          input.focus();
          if (desc && desc.set) { desc.set.call(input, ''); desc.set.call(input, totpCode); } else { input.value = totpCode; }
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })(${JSON.stringify(code)})`).catch(() => {});
      val = await codeInput.inputValue().catch(() => '');
    }
    return val === code;
  }

  /**
   * [P1b điểm 3 - D10] Phát hiện mã 2FA bị TỪ CHỐI (sai/hết hạn) khác với "đang xử lý":
   * vẫn ở trạng thái 2FA (URL/UI) VÀ có tín hiệu lỗi CẤU TRÚC (ô aria-invalid) hoặc vùng alert
   * kèm gợi ý đa ngôn ngữ. Không dựa riêng vào một cụm tiếng Anh.
   */
  private async detect2FACodeRejected(page: Page): Promise<boolean> {
    if (!page || page.isClosed()) return false;
    const inTwoFactor = this.classifyUrlState(page.url()) === 'TWO_FACTOR' || (await this.detectUiState(page)) === 'TWO_FACTOR';
    if (!inTwoFactor) return false;
    const hasInvalidInput = await this.safeIsVisible(page.locator('input[aria-invalid="true"]').first(), 300);
    if (hasInvalidInput) return true;
    const hasAlert = await this.safeIsVisible(page.locator('div[role="alert"], [aria-live="assertive"]').first(), 300);
    if (!hasAlert) return false;
    const alertText = (await page.evaluate(`(function(){
      var els = Array.from(document.querySelectorAll('div[role="alert"], [aria-live="assertive"]'));
      return els.map(function(e){ return (e.innerText || e.textContent || ''); }).join(' ').toLowerCase();
    })()`).catch(() => '')) as string;
    return matchesAnyToken(alertText, TWO_FA_REJECTED_TOKENS);
  }

  /**
   * On the "Choose a way to confirm that it's you" modal (Ảnh 2), select the
   * "Authentication app" option and click Continue — TRUSTED clicks only, because
   * programmatic clicks do not fire FB's React handlers (verified live).
   * B3 spec: //div[text()="Authentication app"]/ancestor::div[.//input[@type="radio"]][1]//input[@type="radio"]
   */
  private async selectAuthAppAndContinue(page: Page): Promise<void> {
    if (!page || page.isClosed()) return;
    const dialog = page.locator('div[role="dialog"]').first();
    const scope = (await dialog.isVisible({ timeout: 1000 }).catch(() => false)) ? dialog : undefined;
    const root = scope ?? page.locator('body');
    const authRe = this.tokensToRegExp(AUTH_APP_TOKENS);

    // B3: prefer the clickable row/label carrying the "Authentication app" token.
    let picked = false;
    const rowByText = root.locator('label, div[role="radio"], div[role="button"], div[role="none"]', { hasText: authRe }).first();
    if (await rowByText.isVisible({ timeout: 1500 }).catch(() => false)) {
      await rowByText.scrollIntoViewIfNeeded().catch(() => {});
      try { await rowByText.click({ timeout: 3000 }); picked = true; }
      catch { await rowByText.click({ force: true, timeout: 3000 }).catch(() => {}); picked = true; }
    }

    // Fallback: exact XPath radio per spec, else the 2nd radio in the dialog.
    if (!picked) {
      const authAppRadioByXPath = page
        .locator('xpath=//div[contains(normalize-space(.),"Authentication app") or contains(normalize-space(.),"xác thực")]/ancestor::div[.//input[@type="radio"] or .//*[@role="radio"]][1]//*[self::input[@type="radio"] or @role="radio"]')
        .first();
      const secondRadio = (scope ?? page).locator('div[role="radio"], input[type="radio"]').nth(1);
      const target = (await authAppRadioByXPath.isVisible({ timeout: 1000 }).catch(() => false)) ? authAppRadioByXPath : secondRadio;
      await target.scrollIntoViewIfNeeded().catch(() => {});
      try { await target.click({ timeout: 2500 }); }
      catch { await target.click({ force: true, timeout: 2500 }).catch(() => {}); }
    }

    await sleep(1000);

    // Click the green [Continue] — trusted click inside the dialog first, then whole page.
    logger.info('🚀 [2FA] Bấm [Continue] trên modal chọn phương thức 2FA...');
    const clickedContinue = await this.trustedClickByTokens(page, CONTINUE_TOKENS, { scope, timeout: 4000 });
    if (!clickedContinue) {
      await this.trustedClickByTokens(page, CONTINUE_TOKENS, { timeout: 4000 });
    }
  }

  /**
   * Handle Two-Factor Authentication OTP input & Device Notification Flow (Ảnh 1)
   */
  private async handleTwoFactorPage(
    page: Page,
    profileId: string,
    profileName: string,
    fakey: string
  ): Promise<FacebookLoginResult> {
    if (!page || page.isClosed()) {
      return {
        success: false,
        status: 'needs_human_review',
        message: 'Trình duyệt bị đóng trước khi nhập 2FA.',
        currentUrl: '',
        profileId,
        profileName,
      };
    }

    logger.info('🔑 Bắt đầu quy trình tự động xử lý 2FA (chuẩn quick_2fa & option switcher)...');
    await this.dismissAllKnownPopups(page, profileId);
    // [POPUP] Dọn popup native (ESC) ngay khi vào màn hình 2FA để không che ô/nút.
    await popupKiller.dismissNativePopup(page);

    // Log DOM clickables & body snippet for debug
    const domInfo = (await page.evaluate(`(function() {
      var text = document.body ? document.body.innerText.substring(0, 500) : '';
      var clickables = Array.from(document.querySelectorAll('button, div[role="button"], a, span')).map(function(b) {
        return {
          text: (b.innerText || b.textContent || b.getAttribute('aria-label') || '').trim().toLowerCase(),
          tag: b.tagName,
          role: b.getAttribute('role') || '',
          cls: (b.className || '').slice(0, 30)
        };
      }).filter(function(x) { return x.text.indexOf('try another') !== -1 || x.text.indexOf('thử cách') !== -1 || x.text.indexOf('auth') !== -1 || x.text.indexOf('continue') !== -1 || x.text.indexOf('tiếp tục') !== -1; });
      return { text: text, clickables: clickables };
    })()`).catch(() => ({ text: '', clickables: [] }))) as { text: string; clickables: any[] };

    logger.info(`[2FA Debug] Text snippet: "${domInfo.text.replace(/\s+/g, ' ')}" | Clickables: ${JSON.stringify(domInfo.clickables)}`);

    // Selector 2FA input: ưu tiên input[type="text"][autocomplete="off"] theo đặc tả
    // [POPUP] ESC dọn popup native có thể che ô nhập mã 2FA trước khi dò tìm.
    await popupKiller.dismissNativePopup(page);
    const codeInput = page.locator('input[type="text"][autocomplete="off"], input[autocomplete="one-time-code"], input[name="approvals_code"], input[placeholder*="Code" i], input[aria-label*="Code" i], input[type="text"], input[type="number"], input[inputmode="numeric"]').first();
    let isInputVisible = await this.safeIsVisible(codeInput, 2000);
    if (!isInputVisible) {
      // Ô chưa hiện: rất có thể popup native vừa che -> ESC rồi thử locate lại.
      await popupKiller.dismissNativePopup(page);
      isInputVisible = await this.safeIsVisible(codeInput, 2000);
    }

    // =========================================================================
    // 2. Nếu chưa có ô nhập mã 2FA, mới xử lý màn hình chọn phương thức 2FA
    // =========================================================================
    if (!isInputVisible) {
      // Drive the notification → choose-method → authentication-app → code sub-flow WITHIN
      // this single call. FB advances ONE screen per TRUSTED click; splitting across engine
      // cycles fails because cycle-top Escape/dismiss reverts the modal back to the
      // notification screen (verified live: 12 cycles looped on "Check notifications").
      const maxSteps = 8;
      for (let step = 1; step <= maxSteps; step++) {
        if (page.isClosed()) break;

        isInputVisible = await this.safeIsVisible(codeInput, 1200);
        if (isInputVisible) break;

        const bodyLower = ((await page.evaluate('document.body ? document.body.innerText : ""').catch(() => '')) as string).toLowerCase();

        // (1) SESSION-TIMEOUT dialog ("Phiên đã hết thời gian chờ / Vui lòng bắt đầu lại"):
        // the encrypted_context is dead — clicking OK cannot revive it. Real-click OK, then
        // re-navigate to Facebook so the engine re-logins and obtains a FRESH 2FA context.
        if (matchesAnyToken(bodyLower, SESSION_TIMEOUT_TOKENS)) {
          logger.warn('⚠️ [2FA] Phát hiện "Phiên đã hết thời gian chờ" -> bấm OK và tải lại để lấy context 2FA mới.');
          const dialog = page.locator('div[role="dialog"]').first();
          const scope = (await dialog.isVisible({ timeout: 800 }).catch(() => false)) ? dialog : undefined;
          await this.trustedClickByTokens(page, RESTART_OK_TOKENS, { scope, timeout: 4000 });
          await sleep(1500);
          await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
          await sleep(2500);
          return {
            success: false,
            status: 'two_factor_in_progress',
            message: 'Phiên 2FA hết hạn -> đã tải lại để đăng nhập lại với context mới.',
            currentUrl: page.isClosed() ? '' : page.url(),
            profileId,
            profileName,
          };
        }

        // (2) CHOOSE-METHOD modal (Ảnh 2: "Choose a way to confirm that it's you") -> Authentication app.
        if (matchesAnyToken(bodyLower, CHOOSE_METHOD_TOKENS)) {
          logger.info('🎯 [2FA B2] Modal "Choose a way to confirm" -> chọn "Authentication app" + Continue...');
          await this.selectAuthAppAndContinue(page);
          await sleep(2500);
          continue;
        }

        // (3) NOTIFICATION screen (Ảnh 1: "Check your notifications on another device") -> Try another way.
        if (matchesAnyToken(bodyLower, DEVICE_NOTIFICATION_TOKENS)) {
          logger.info('🎯 [2FA TH1] Màn "Check notifications" -> B1: bấm "Try another way" (trusted click)...');
          const clicked = await this.trustedClickByTokens(page, TRY_ANOTHER_WAY_TOKENS, { timeout: 5000 });
          if (!clicked) logger.warn('[2FA B1] Không tìm thấy nút "Try another way" khả kiến.');
          await sleep(3000);
          continue;
        }

        // (4) "Go to your authentication app" (Ảnh 3) but input chưa render -> settle rồi vòng lại.
        if (matchesAnyToken(bodyLower, GO_TO_AUTH_APP_TOKENS)) {
          await sleep(1500);
          continue;
        }

        // (5) Trạng thái trung gian chưa xác định -> settle ngắn.
        await sleep(1500);
      }

      // Kiểm tra lại sau khi xử lý các màn hình chuyển tiếp
      await popupKiller.dismissNativePopup(page);
      isInputVisible = await this.safeIsVisible(codeInput, 4000);
      if (!isInputVisible) {
        // ⚠️ KHÔNG tuyên bố thành công ở đây. Ô nhập mã chưa hiện =>
        // luồng 2FA còn dang dở. Trả trạng thái "đang xử lý" để engine lặp lại,
        // để LoginStateDetector (cookie/ /me) mới là nơi phán quyết success.
        logger.info('⏳ Chưa thấy ô nhập mã OTP sau khi xử lý màn hình chọn 2FA -> để engine thử lại chu kỳ sau.');
        await sleep(1500);
        return {
          success: false,
          status: 'two_factor_in_progress',
          message: 'Luồng 2FA đang chuyển tiếp, chưa hiển thị ô nhập mã OTP.',
          currentUrl: page.isClosed() ? '' : page.url(),
          profileId,
          profileName,
        };
      }
    }

    // =========================================================================
    // 3. ĐIỀN MÃ TOTP VÀO Ô NHẬP 2FA
    // B4: Xác nhận màn hình "Go to your authentication app"
    // B5: Nhập mã — ưu tiên input[type="text"][autocomplete="off"]
    // =========================================================================

    // B4: Xác nhận giao diện "Go to your authentication app"
    const bodyLowerNow = ((await page.evaluate('document.body ? document.body.innerText : ""').catch(() => '')) as string).toLowerCase();
    const isGoToAuthApp = matchesAnyToken(bodyLowerNow, GO_TO_AUTH_APP_TOKENS);

    if (isGoToAuthApp) {
      logger.info('[2FA B4] Xác nhận màn hình: "Go to your authentication app" ✅');
    } else {
      logger.info('[2FA B4] Không thấy text "Go to your authentication app" nhưng vẫn tiến hành nhập mã...');
    }

    // B5: Tạo và điền mã TOTP
    const code = generateTOTP(fakey);
    logger.info(`[2FA B5] 🔢 Đã tạo mã 2FA TOTP (6 chữ số, đã ẩn để bảo mật) -> Đang điền vào ô input...`);

    // [P1b điểm 3 - D5/D10] Xóa sạch ô rồi điền MỘT lần (không native-set + fill + pressSequentially
    // cùng lúc gây mã bị nhân đôi/ba). Xác minh giá trị ô == mã trước khi submit.
    const codeVerified = await this.fillCodeInputOnce(page, codeInput, code);
    if (!codeVerified) {
      logger.warn('⚠️ [2FA B5] Giá trị ô nhập mã KHÔNG khớp mã đã tạo sau khi điền -> vẫn thử submit, engine sẽ tái phán quyết.');
    }
    await sleep(300);

    // [POPUP] ESC dọn popup native có thể che nút Continue/Submit 2FA trước khi bấm.
    // Điền lại mã nếu ESC làm mất giá trị ô (guard chống xoá mã đã nhập).
    await popupKiller.dismissNativePopup(page);
    if ((await codeInput.inputValue().catch(() => '')) !== code) {
      await this.fillCodeInputOnce(page, codeInput, code);
    }
    logger.info('🚀 Bấm nút [Continue] / Submit 2FA...');
    const submitClicked = await page.evaluate(`(function() {
      var TOK = ${JSON.stringify(CONTINUE_TOKENS)};
      var btns = Array.from(document.querySelectorAll('button, div[role="button"], input[type="submit"]'));
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        var text = (b.innerText || b.textContent || b.value || b.getAttribute('aria-label') || '').toLowerCase().trim();
        if (TOK.some(function(t){ return text.indexOf(t) !== -1; }) || b.id === 'checkpointSubmitButton') {
          b.click();
          return true;
        }
      }
      return false;
    })()`).catch(() => false);

    if (!submitClicked) {
      const continueBtnSelectors = [
        hasTextSelector(['button', 'div[role="button"]'], CONTINUE_TOKENS),
        'button#checkpointSubmitButton',
        'button[type="submit"]',
      ];
      for (const sel of continueBtnSelectors) {
        if (page.isClosed()) break;
        const btn = page.locator(sel).first();
        if (await this.safeIsVisible(btn, 1000)) {
          await this.safeClick(btn, 2000);
          break;
        }
      }
      await codeInput.focus().catch(() => {});
      await page.keyboard.press('Enter').catch(() => {});
    }

    logger.info('Đang chờ phản hồi từ Facebook sau khi nộp 2FA...');
    await sleep(3000);
    await this.handleIntermediatePages(page, profileId);

    // [P1b điểm 4] POLL HỮU HẠN cho tới khi detector xác nhận đăng nhập; phát hiện mã SAI/HẾT HẠN
    // (D10) để không đốt chu kỳ vô nghĩa; reconcile UI↔URL khi màn hình còn kẹt (P1a).
    const maxPolls = 5;
    for (let poll = 1; poll <= maxPolls; poll++) {
      if (page.isClosed()) break;
      await this.reconcileUrlAndUi(page);

      if (await this.isRealLoggedIn(page, profileId)) {
        // ✅ Chỉ tuyên bố thành công khi LoginStateDetector (cookie c_user / /me) xác nhận.
        return {
          success: true,
          status: 'logged_in',
          message: 'Đã nhập mã 2FA và xác thực đăng nhập Facebook thành công.',
          currentUrl: page.isClosed() ? '' : page.url(),
          profileId,
          profileName,
        };
      }

      if (await this.detect2FACodeRejected(page)) {
        logger.warn('⚠️ [2FA] Mã 2FA bị Facebook TỪ CHỐI (sai/hết hạn) -> cần con người kiểm tra khóa 2FA, không đốt thêm chu kỳ.');
        return {
          success: false,
          status: 'needs_human_review',
          message: 'Mã 2FA bị từ chối (sai hoặc hết hạn). Cần kiểm tra 2FA Secret Key (fakey) của profile.',
          currentUrl: page.isClosed() ? '' : page.url(),
          profileId,
          profileName,
        };
      }

      // Đã rời luồng 2FA sang trạng thái khác -> thoát poll, để nhánh dưới trả trạng thái đúng.
      const stateNow = this.classifyUrlState(page.url());
      const uiNow = await this.detectUiState(page);
      if (stateNow !== 'TWO_FACTOR' && uiNow !== 'TWO_FACTOR') break;

      await sleep(2000);
    }

    const finalUrl = page.isClosed() ? '' : page.url();
    logger.info(`URL sau khi nộp 2FA và poll hữu hạn: ${finalUrl}`);

    // [P1b điểm 4] Nếu đã rời 2FA sang một CHECKPOINT rõ ràng -> trả đúng terminal đó (không giả vờ 2FA).
    const stillTwoFactor =
      this.classifyUrlState(finalUrl) === 'TWO_FACTOR' || (await this.detectUiState(page)) === 'TWO_FACTOR';
    if (!stillTwoFactor) {
      const checkpointInfo = await this.detectCheckpoint(page, profileId);
      if (checkpointInfo.isCheckpoint) {
        return this.reportCheckpointResult(page, profileId, profileName, checkpointInfo);
      }
    }

    // ⚠️ Chỉ trả two_factor_in_progress khi THỰC SỰ còn ở luồng 2FA, hoặc trạng thái còn mơ hồ
    // (chưa checkpoint/chưa đăng nhập) -> để engine lặp thêm và tự phán quyết ở chu kỳ sau.
    logger.warn('⚠️ Đã nộp mã 2FA nhưng detector chưa xác nhận đăng nhập -> two_factor_in_progress để engine kiểm tra tiếp.');
    return {
      success: false,
      status: 'two_factor_in_progress',
      message: stillTwoFactor
        ? 'Đã nộp mã 2FA, vẫn đang ở luồng xác thực 2FA. Chờ trang xác thực hoàn tất.'
        : 'Đã nộp mã 2FA; trang đã rời luồng 2FA, chờ engine tái phán quyết trạng thái.',
      currentUrl: finalUrl,
      profileId,
      profileName,
    };
  }
}

export const facebookLoginAutomation = new FacebookLoginAutomation();
