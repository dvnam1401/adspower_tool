const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
import { Page, Locator } from 'playwright-core';
import { adsPowerClient } from '../adspower/client.js';
import { cdpManager } from '../dom/cdp.js';
import { generateTOTP } from '../utils/totp.js';
import { logger } from '../utils/logger.js';
import { broadcastEvent } from '../server/app.js';
import { AdsPowerProfileInfo, DOMAction } from '../types/index.js';
import { aiPageAnalyzer } from '../utils/ai-analyzer.js';
import { notifySingleProfileResult } from '../utils/telegram.js';
import { healingOrchestrator } from '../recovery/healing-orchestrator.js';
import { googleSheetService } from './google-sheet.js';

export interface FacebookLoginResult {
  success: boolean;
  status: 'logged_in' | 'already_logged_in' | 'two_factor_completed' | 'checkpoint_human_verification' | 'recapcha_detected' | 'failed' | 'needs_human_review';
  message: string;
  currentUrl: string;
  profileId: string;
  profileName: string;
  twoFactorCodeUsed?: string;
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
  public async execute(profileIdentifier: string, customTargetUrl?: string): Promise<FacebookLoginResult> {
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
    logger.info(`[Step 1/5] Khởi động trình duyệt AdsPower (với cờ tắt popup thông báo)...`);
    const connData = await adsPowerClient.startBrowser({ 
      profileId,
      launchArgs: [
        '--disable-notifications',
        '--deny-permission-prompts',
        '--disable-infobars',
        '--disable-save-password-bubble',
        '--disable-features=FedCm,CredentialManagement,PasswordManagerOnboarding',
        '--password-store=basic',
      ]
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
    await page.keyboard.press('Escape').catch(() => {});

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
      const curUrl = page.isClosed() ? '' : page.url();
      if (curUrl.includes('checkpoint_src') || (deploymentUrl && curUrl !== deploymentUrl)) {
        const dest = deploymentUrl || 'https://www.facebook.com/';
        logger.info(`🔄 Làm sạch thanh địa chỉ URL trình duyệt: Chuyển hướng từ [${curUrl}] về [${dest}]...`);
        await page.goto(dest, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await sleep(1500);
      }

      const finalSuccessUrl = page.isClosed() ? '' : page.url();

      broadcastEvent('system_alert', {
        type: 'login_success',
        profileId,
        profileName,
        url: finalSuccessUrl,
        message: 'Tài khoản đã đăng nhập hợp lệ và sẵn sàng.',
        time: new Date().toLocaleTimeString(),
      });

      const finalRes: FacebookLoginResult = {
        success: true,
        status: 'already_logged_in',
        message: 'Tài khoản đã đăng nhập thành công và sẵn sàng.',
        currentUrl: finalSuccessUrl,
        profileId,
        profileName,
      };

      await notifySingleProfileResult(finalRes).catch(() => {});
      await this.handleAutoCloseIfSuccess(finalRes);
      return finalRes;
    }

    // 5. KHỞI ĐỘNG CƠ CHẾ AUTONOMOUS STATE MACHINE (CÓ RETRY GOOGLE SHEET)
    logger.info(`[Step 4/4] Kích hoạt Autonomous State Engine...`);
    let result: FacebookLoginResult = { success: false, status: 'failed', message: 'Unknown', profileId, profileName, currentUrl: '' };
    
    for (let retry = 0; retry < 6; retry++) {
      if (retry > 0) {
        logger.info(`🔄 [Retry ${retry}/5] Gọi Google Sheet để lấy Cookie dự phòng...`);
        const backup = await googleSheetService.getBackupData(profileId);
        if (backup && backup.cookie) {
          logger.info(`🍪 Bơm Cookie mới từ Google Sheet vào Browser Context...`);
          // Xóa cookie cũ và bơm cookie mới (Playwright cách)
          const context = page.context();
          await context.clearCookies();
          
          // Parse string cookie đơn giản 'c_user=123; xs=456;' -> Playwright format
          const cookieArray = backup.cookie.split(';').map(c => c.trim()).filter(c => c).map(c => {
            const [name, ...rest] = c.split('=');
            return {
              name,
              value: rest.join('='),
              domain: '.facebook.com',
              path: '/'
            };
          });
          
          if (cookieArray.length > 0) {
            await context.addCookies(cookieArray);
            await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      }

      result = await this.runAutonomousLoginEngine(page, username, password, fakey, profileId, profileName);
      
      // Nếu thành công, hoặc lỗi không thuộc nhóm sai pass / recaptcha -> thoát vòng lặp
      if (result.success || 
         (result.status !== 'failed' && result.status !== 'recapcha_detected' && !result.message.includes('Wrong Password') && !result.message.includes('Mật khẩu bạn đã nhập không chính xác'))) {
        break;
      }
      
      logger.warn(`⚠️ Đăng nhập thất bại (Lý do: ${result.status}). Chuẩn bị retry với Cookie Google Sheet...`);
    }

    if (!result.success && (result.status === 'failed' || result.status === 'recapcha_detected' || result.message.includes('Wrong Password'))) {
      result.status = 'needs_human_review';
      result.message += ' (Đã thử Fallback Google Sheet 6 lần nhưng vẫn thất bại)';
      await googleSheetService.updateStatus(profileId, 'NEEDS_HUMAN_REVIEW');
    }

    logger.info('===============================================================');
    logger.info(`🏁 KẾT QUẢ AUTOMATION: [${result.status.toUpperCase()}] ${result.message}`);
    
    await notifySingleProfileResult(result).catch(() => {});
    await this.handleAutoCloseIfSuccess(result);
    return result;
  }

  /**
   * Helper to auto-close browser window if login succeeds to free up RAM
   */
  private async handleAutoCloseIfSuccess(result: FacebookLoginResult): Promise<void> {
    if (!result.success || !result.profileId) return;

    try {
      logger.info(`🚪 [Auto-Close] Đã đăng nhập THÀNH CÔNG -> Tự động đóng cửa sổ profile ${result.profileName || result.profileId} (Giữ lại các cửa sổ bị lỗi/checkpoint)...`);
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
   * Check STRICTLY if account is GENUINELY logged in (has user avatar, search bar, feeds, and NO login buttons)
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

    // 1. DẤU HIỆU RÕ RÀNG CỦA TRẠNG THÁI ĐÃ ĐĂNG NHẬP THỰC SỰ (ƯU TIÊN KIỂM TRA TRƯỚC):
    const loggedInIndicators = [
      '[aria-label*="Your profile" i]',
      '[aria-label*="Trang cá nhân của bạn" i]',
      '[aria-label*="Trang cá nhân" i]',
      '[aria-label*="Sua conta" i]',
      '[aria-label*="Tài khoản" i]',
      '[aria-label*="Account" i]',
      'input[placeholder*="Tìm kiếm trên Facebook" i]',
      'input[placeholder*="Search Facebook" i]',
      'input[placeholder*="Pesquisar no Facebook" i]',
      '[aria-label*="Search Facebook" i]',
      '[aria-label*="Tìm kiếm trên Facebook" i]',
      '[aria-label*="Messenger" i]',
      '[aria-label*="Thông báo" i]',
      '[aria-label*="Notifications" i]',
      '[role="feed"]',
      '[aria-label*="Bạn đang nghĩ gì" i]',
      '[aria-label*="What\'s on your mind" i]',
      'a[href*="/me/"]',
    ];

    for (const sel of loggedInIndicators) {
      if (page.isClosed()) return false;
      if (await this.safeIsVisible(page.locator(sel).first(), 300)) {
        return true; // Đã đăng nhập hợp lệ!
      }
    }

    // Kiểm tra thêm văn bản Feed tiêu chuẩn trên DOM (đặc biệt khi URL là ?checkpoint_src=any)
    try {
      const bodySnippet = (await page.evaluate('document.body ? document.body.innerText.substring(0, 2000) : ""').catch(() => '')) as string;
      const isFeedText =
        bodySnippet.includes("What's on your mind") ||
        bodySnippet.includes("Bạn đang nghĩ gì") ||
        bodySnippet.includes("Create story") ||
        bodySnippet.includes("Tạo tin") ||
        (bodySnippet.includes("Meta AI") && bodySnippet.includes("Contacts"));

      if (isFeedText) {
        return true;
      }
    } catch {}

    // 2. DẤU HIỆU RÕ RÀNG CỦA FORM DĂNG NHẬP (STRICT LOGOUT FORM ONLY):
    const loggedOutIndicators = [
      'text="Hãy đăng nhập hoặc đăng ký Facebook"',
      'text="Log in or sign up for Facebook"',
      'text="Entrar ou cadastrar-se no Facebook"',
      'input#email',
      'input#pass',
      'button[name="login"]',
      '#loginbutton',
    ];

    for (const sel of loggedOutIndicators) {
      if (page.isClosed()) return false;
      const el = page.locator(sel).first();
      if (await this.safeIsVisible(el, 300)) {
        return false; // Chắc chắn đang bị LOGOUT!
      }
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
      var buttons = Array.from(document.querySelectorAll('button, div[role="button"], a, span'));
      var dismissTexts = [
        'dismiss', 'bỏ qua', 'huỷ', 'hủy', 'cancel', 'chặn', 'block', 
        'không cho phép', 'lúc khác', 'not now', 'agora não', 'close', 'đóng', 'fechar',
        'cho phép tất cả cookie', 'allow all cookies', 'aceitar todos os cookies'
      ];
      
      for (var i = 0; i < buttons.length; i++) {
        var b = buttons[i];
        var text = (b.innerText || b.textContent || b.getAttribute('aria-label') || '').toLowerCase().trim();
        if (dismissTexts.indexOf(text) !== -1) {
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
   */
  private async handleRememberBrowser(page: Page, profileId?: string): Promise<void> {
    if (!page || page.isClosed()) return;
    logger.info('🎯 Đang xử lý trang "Trust this device? / Lưu trình duyệt này?"...');
    await this.dismissAllKnownPopups(page, profileId);

    const trustButtons = [
      'button:has-text("Trust this device")',
      'div[role="button"]:has-text("Trust this device")',
      'span:has-text("Trust this device")',
      'button:has-text("Lưu trình duyệt")',
      'div[role="button"]:has-text("Lưu trình duyệt")',
      'span:has-text("Lưu trình duyệt")',
      'button:has-text("Salvar navegador")',
      'div[role="button"]:has-text("Salvar navegador")',
      'button:has-text("Continue")',
      'button:has-text("Tiếp tục")',
      'button:has-text("Continuar")',
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
      const dismissBtn = page.locator('button:has-text("Dismiss"), div[role="button"]:has-text("Dismiss"), button:has-text("Bỏ qua")').first();
      if (await this.safeIsVisible(dismissBtn, 1000)) {
        logger.info('🎯 Phát hiện cảnh báo "We suspect automated behavior" -> Bấm nút [Dismiss]...');
        await this.safeClick(dismissBtn, 3000);
        await sleep(3000);
      }

      if (url.includes('save_device') || url.includes('login_save')) {
        logger.info('Phát hiện trang Save Login Info -> Bấm Save/Continue...');
        const saveButtons = [
          'button:has-text("Save")',
          'button:has-text("Lưu")',
          'button:has-text("Salvar")',
          'button:has-text("Continue")',
          'button:has-text("Tiếp tục")',
        ];
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

    // 1. Kiểm tra xem ô Email & Password đã được trình duyệt tự động điền (Autofill) chưa
    let currentEmailVal = (await emailInput.inputValue().catch(() => '')).trim();
    let currentPassVal = (await passInput.inputValue().catch(() => '')).trim();

    // Nếu ô Email hoặc Pass rỗng, chờ 1s để trình duyệt tự điền theo đúng cơ chế Autofill
    if (!currentEmailVal || !currentPassVal) {
      await sleep(1000);
      currentEmailVal = (await emailInput.inputValue().catch(() => '')).trim();
      currentPassVal = (await passInput.inputValue().catch(() => '')).trim();
    }

    // Kiểm tra xem dữ liệu trong ô có sạch và hợp lệ không
    const isCleanAutofill =
      currentEmailVal.length > 0 &&
      currentPassVal.length > 0 &&
      (currentEmailVal === username || !currentEmailVal.includes(currentEmailVal.slice(0, 6) + currentEmailVal.slice(0, 6)));

    if (isCleanAutofill) {
      logger.info(`✨ Trình duyệt đã tự động điền sẵn Email (${currentEmailVal.slice(0, 6)}...) & Password -> Bấm [Đăng nhập] ngay!`);
    } else {
      // 2. Nếu ô bị thiếu, bị lặp nối chuỗi cũ -> Làm sạch triệt để và gán đúng giá trị bằng React prototype setter
      logger.info(`Điền thông tin đăng nhập chuẩn: Username=${username}...`);
      await page.evaluate(`(function(cred) {
        function setNativeValue(element, value) {
          if (!element) return;
          var prototype = Object.getPrototypeOf(element);
          var descriptor = Object.getOwnPropertyDescriptor(prototype, 'value') || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
          if (descriptor && descriptor.set) {
            descriptor.set.call(element, value);
          } else {
            element.value = value;
          }
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }

        var emailEl = document.querySelector('input#email, input[name="email"], input[type="text"]');
        var passEl = document.querySelector('input#pass, input[name="pass"], input[type="password"]');
        setNativeValue(emailEl, cred.u);
        if (cred.p) setNativeValue(passEl, cred.p);
      })(${JSON.stringify({ u: username, p: password })})`).catch(() => {});

      await emailInput.fill(username).catch(() => {});
      await sleep(150);
      if (password) {
        await passInput.fill(password).catch(() => {});
        await sleep(150);
      }
    }

    logger.info('Bấm nút [Đăng nhập] qua SelfHealingOrchestrator...');
    await healingOrchestrator.executeWithHealing(
      {
        actionType: 'click',
        targetDescription: 'Nút Đăng nhập Facebook',
        selectorChain: [
          { type: 'css', value: 'button[name="login"]', priority: 1 },
          { type: 'css', value: 'button[type="submit"]', priority: 2 },
          { type: 'text', value: 'Đăng nhập', priority: 3 },
          { type: 'text', value: 'Log In', priority: 4 }
        ],
        timeoutMs: 3000
      },
      page,
      {
        profileId: profileId || 'unknown',
        site: 'facebook.com',
      }
    ).catch(() => {});

    await passInput.focus().catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    return true;
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
    let twoFactorCodeUsed: string | undefined;

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
          twoFactorCodeUsed,
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
        const reloadBtn = page.locator('button:has-text("Tải lại trang"), button:has-text("Reload Page"), button:has-text("Recarregar")').first();
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
        return this.reportCheckpointResult(page, profileId, profileName, checkpointInfo);
      }

      // =======================================================================
      // 4. TRẠNG THÁI: SAI MẬT KHẨU (WRONG PASSWORD)
      // =======================================================================
      const wrongPassKeywords = [
        'mật khẩu bạn đã nhập không chính xác',
        'mật khẩu không chính xác',
        'sai mật khẩu',
        'the password that you\'ve entered is incorrect',
        'the password you entered is incorrect',
        'incorrect password',
        'a senha inserida está incorreta',
        'senha incorreta',
        'contraseña incorrecta',
      ];
      if (wrongPassKeywords.some(kw => bodyText.toLowerCase().includes(kw))) {
        logger.error(`❌ Facebook báo sai mật khẩu (Wrong Password) cho profile "${profileName}"!`);
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
      const notFoundAccountKeywords = [
        'email hoặc số di động bạn nhập không kết nối với tài khoản nào',
        'the email or mobile number you entered isn’t connected to an account',
        'the email address or mobile number you entered isn\'t connected to an account',
        'the email you’ve entered doesn’t match any account',
        'tài khoản không tồn tại',
      ];
      if (notFoundAccountKeywords.some(kw => bodyText.toLowerCase().includes(kw))) {
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
      const hasInteractiveCaptcha = await this.safeIsVisible(
        page.locator('iframe[src*="arkoselabs"], iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[title*="challenge" i], #captcha').first(),
        500
      );
      if (hasInteractiveCaptcha && (bodyText.includes('Select') || bodyText.includes('Chọn') || bodyText.includes('puzzle') || bodyText.includes('audio'))) {
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
      // 6. TRẠNG THÁI: SILENT CHECKING / ARKOSE MATCHKEY
      // =======================================================================
      if (currentUrl.includes('/two_step_verification/authentication')) {
        logger.info('⏳ Phát hiện trang Silent Authentication Check -> Chờ Facebook xác minh 3s...');
        await sleep(3000);
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
        if (res2fa.success) {
          twoFactorCodeUsed = res2fa.twoFactorCodeUsed;
          await sleep(3000);
          continue; // Vòng lặp tiếp tục để xử lý tiếp trang Remember Browser / Save Device
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
      const oneTapCloseBtn = page.locator('div[role="dialog"] button:has-text("Huỷ"), div[role="dialog"] button:has-text("Cancel"), div[role="dialog"] [aria-label*="Đóng" i]').first();
      if (await this.safeIsVisible(oneTapCloseBtn, 800)) {
        logger.info('🎯 Phát hiện Popup One-Tap -> Bấm [Huỷ]...');
        await this.safeClick(oneTapCloseBtn, 1000);
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(1000);
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
        const topLoginBtn = page.locator('a[href*="/login/"], a:has-text("Đăng nhập"), a:has-text("Log In"), button:has-text("Đăng nhập")').first();
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
            twoFactorCodeUsed,
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

      if (aiAnalysis.classification === 'LOGGED_IN' || (await this.isRealLoggedIn(page, profileId))) {
        logger.info('🎉 [AI Confirmed] AI xác nhận tài khoản ĐÃ ĐĂNG NHẬP THÀNH CÔNG!');
        return {
          success: true,
          status: 'logged_in',
          message: `AI đã xác nhận tài khoản Facebook đăng nhập thành công. (${aiAnalysis.reason})`,
          currentUrl,
          profileId,
          profileName,
          twoFactorCodeUsed,
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
        twoFactorCodeUsed,
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
   * Handle login dialog popup or main login form
   */
  private async handleLoginInterface(page: Page, username: string, password: string, profileId?: string): Promise<void> {
    let retries = 0;
    const maxRetries = 3;

    while (retries < maxRetries) {
      if (!page || page.isClosed()) return;
      await this.handleNotFoundPage(page, profileId);
      logger.info(`Kiểm tra giao diện đăng nhập (Lần thử ${retries + 1}/${maxRetries})...`);

      // -----------------------------------------------------------------------
      // ƯU TIÊN 1: XỬ LÝ POPUP ONE-TAP "Đăng nhập bằng <Account>" (Ảnh 1, 6, 7 & 8)
      // -----------------------------------------------------------------------
      await page.keyboard.press('Escape').catch(() => {});

      // Bước A: Thử tìm và click [Huỷ] bằng JavaScript (kể cả trong Shadow DOM)
      const oneTapDismissed = await page.evaluate(`(function() {
        function findInTree(root) {
          if (!root) return null;
          var els = Array.from(root.querySelectorAll('button, div[role="button"], span, a'));
          for (var i = 0; i < els.length; i++) {
            var t = (els[i].innerText || els[i].textContent || '').trim().toLowerCase();
            if (t === 'huỷ' || t === 'hủy' || t === 'cancel' || t === 'cancelar') {
              return els[i];
            }
          }
          var all = Array.from(root.querySelectorAll('*'));
          for (var j = 0; j < all.length; j++) {
            if (all[j].shadowRoot) {
              var found = findInTree(all[j].shadowRoot);
              if (found) return found;
            }
          }
          return null;
        }

        var btn = findInTree(document);
        if (btn) {
          btn.click();
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return true;
        }
        return false;
      })()`).catch(() => false);

      if (oneTapDismissed) {
        logger.info('🎯 Đã bấm nút [Huỷ] trên Popup One-Tap qua DOM!');
        await sleep(1000);
      }

      // Bước B: Bấm [Huỷ] bằng Playwright Locator trên mọi frame
      const cancelLocators = [
        'div[role="dialog"] button:has-text("Huỷ")',
        'div[role="dialog"] button:has-text("Hủy")',
        'div[role="dialog"] div[role="button"]:has-text("Huỷ")',
        'div[role="dialog"] div[role="button"]:has-text("Hủy")',
        'button:has-text("Huỷ")',
        'div[role="button"]:has-text("Huỷ")',
        'button:has-text("Cancel")',
      ];
      for (const sel of cancelLocators) {
        const btn = page.locator(sel).first();
        if (await this.safeIsVisible(btn, 300)) {
          logger.info(`Bấm nút [${sel}] để đóng popup...`);
          await this.safeClick(btn, 1000);
          await sleep(500);
          break;
        }
      }

      // Bước C: Quét iframe con tìm nút Huỷ
      for (const frame of page.frames()) {
        if (frame !== page.mainFrame()) {
          try {
            await frame.evaluate(`(function() {
              var btns = Array.from(document.querySelectorAll('button, div[role="button"], span, a'));
              for (var i = 0; i < btns.length; i++) {
                var t = (btns[i].innerText || btns[i].textContent || '').trim().toLowerCase();
                if (t === 'huỷ' || t === 'hủy' || t === 'cancel') {
                  btns[i].click();
                }
              }
            })()`).catch(() => {});
          } catch {}
        }
      }

      // Bước D: Gỡ bỏ triệt để Backdrop Overlay nếu còn cản trở
      await page.evaluate(`(function() {
        var overlays = Array.from(document.querySelectorAll('div[data-testid*="backdrop"], div[class*="backdrop"], div[style*="rgba(0, 0, 0"]'));
        overlays.forEach(function(el) {
          el.style.display = 'none';
          el.style.pointerEvents = 'none';
        });
      })()`).catch(() => {});

      // -----------------------------------------------------------------------
      // ƯU TIÊN 2: Form Đăng Nhập Chính (Email/Phone + Mật Khẩu)
      // -----------------------------------------------------------------------
      await this.dismissAllKnownPopups(page, profileId);

      const emailInput = page.locator('input#email, input[name="email"], input[aria-label*="Email" i], input[type="text"]').first();
      const passInput = page.locator('input#pass, input[name="pass"], input[type="password"]').first();

      const emailVisible = await this.safeIsVisible(emailInput, 2000);
      const passVisible = await this.safeIsVisible(passInput, 2000);

      if (!emailVisible || !passVisible) {
        // Kiểm tra xem trang có đang chuyển sang 2FA hoặc Checkpoint thực sự không trước khi reload!
        const curUrl = page.isClosed() ? '' : page.url();
        let isActual2FAOrCheckpoint = false;
        try {
          const p = new URL(curUrl).pathname;
          isActual2FAOrCheckpoint = p.includes('/checkpoint') || p.includes('/two_step') || p.includes('/two_factor');
        } catch {
          isActual2FAOrCheckpoint = curUrl.includes('/checkpoint/') || curUrl.includes('/two_factor');
        }

        if (isActual2FAOrCheckpoint) {
          logger.info(`Trang đã tự động chuyển sang luồng xác thực: ${curUrl}`);
          return;
        }

        logger.warn('⚠️ Giao diện chưa hiển thị form Email/Pass -> Đang điều hướng trực tiếp đến trang đăng nhập chuẩn...');
        await page.goto('https://www.facebook.com/login.php', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await sleep(3000);
        retries++;
        continue;
      }

      // 1. Gán giá trị chính xác và kích hoạt React synthetic events
      logger.info(`Điền thông tin đăng nhập: Username=${username}...`);
      await page.evaluate(`(function(cred) {
        var emailEl = document.querySelector('input#email, input[name="email"], input[type="text"]');
        var passEl = document.querySelector('input#pass, input[name="pass"], input[type="password"]');
        if (emailEl) {
          emailEl.value = cred.u;
          emailEl.dispatchEvent(new Event('input', { bubbles: true }));
          emailEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (passEl && cred.p) {
          passEl.value = cred.p;
          passEl.dispatchEvent(new Event('input', { bubbles: true }));
          passEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })(${JSON.stringify({ u: username, p: password })})`).catch(() => {});

      // 2. Đồng thời dùng Playwright fill để đồng bộ internal state
      await emailInput.fill(username).catch(() => {});
      await sleep(200);

      if (password) {
        logger.info(`Điền Mật khẩu vào form...`);
        await passInput.fill(password).catch(() => {});
        await sleep(200);
      }

      // Bấm nút Đăng nhập chính bằng tọa độ chuột thật để kích hoạt trọn vẹn React event
      logger.info('Bấm nút [Đăng nhập] chính bằng tọa độ chuột thật...');

      const mainLoginLocators = [
        page.locator('button[name="login"]'),
        page.locator('button[type="submit"]'),
        page.locator('#loginbutton'),
        page.locator('[data-testid="royal_login_button"]'),
        page.locator('button:has-text("Đăng nhập")'),
        page.locator('div[role="button"]:has-text("Đăng nhập")'),
        page.locator('button:has-text("Log In")'),
        page.locator('div[role="button"]:has-text("Log In")'),
      ];

      let clickedMain = false;
      for (const loc of mainLoginLocators) {
        try {
          const el = loc.first();
          if (await this.safeIsVisible(el, 500)) {
            const box = await el.boundingBox().catch(() => null);
            if (box && box.width > 20 && box.height > 10) {
              const cx = Math.round(box.x + box.width / 2);
              const cy = Math.round(box.y + box.height / 2);
              logger.info(`🎯 Click chuột vật lý tại tọa độ nút [${cx}, ${cy}]...`);
              await page.mouse.click(cx, cy).catch(() => {});
              clickedMain = true;
              break;
            }
          }
        } catch {}
      }

      if (!clickedMain) {
        await this.safeClick(page.locator('div[role="button"]:has-text("Đăng nhập"), button:has-text("Đăng nhập")').first());
      }

      // Thao tác bổ trợ nhấn Enter trực tiếp trên bàn phím
      await passInput.focus().catch(() => {});
      await page.keyboard.press('Enter').catch(() => {});

      // Chờ chuyển hướng thực tế sau khi submit (tối đa 8s, kiểm tra mỗi giây)
      logger.info('Đang chờ phản hồi chuyển hướng từ Facebook sau khi click Đăng nhập...');
      for (let w = 0; w < 8; w++) {
        await sleep(1000);
        if (page.isClosed()) return;
        const curUrl = page.url();
        if (
          curUrl.includes('two_factor') ||
          curUrl.includes('two_step') ||
          curUrl.includes('authentication') ||
          curUrl.includes('checkpoint') ||
          (await this.isRealLoggedIn(page, profileId))
        ) {
          logger.info(`Đã nhận diện chuyển hướng thành công sang: ${curUrl}`);
          return; // Thoát ngay, không chạy tiếp retry loop!
        }
      }

      return;
    }
  }

  /**
   * Handle the resulting page after clicking Login
   */
  private async handlePostLoginState(
    page: Page,
    profileId: string,
    profileName: string,
    fakey?: string
  ): Promise<FacebookLoginResult> {
    if (!page || page.isClosed()) {
      return {
        success: false,
        status: 'needs_human_review',
        message: 'Trình duyệt đã bị đóng sau khi đăng nhập.',
        currentUrl: '',
        profileId,
        profileName,
      };
    }

    await this.dismissAllKnownPopups(page, profileId);
    let currentUrl = page.isClosed() ? '' : page.url();

    // Chờ phản hồi điều hướng thực tế từ Facebook (tối đa 25s cho các mạng/proxy chậm hoặc nút đang xoay loading)
    logger.info('Đang theo dõi phản hồi điều hướng từ Facebook (tối đa 25s)...');
    for (let waitSec = 0; waitSec < 25; waitSec++) {
      if (page.isClosed()) break;
      await this.dismissAllKnownPopups(page, profileId);
      currentUrl = page.url();

      if (
        currentUrl.includes('two_factor') ||
        currentUrl.includes('two_step') ||
        currentUrl.includes('authentication') ||
        currentUrl.includes('checkpoint') ||
        currentUrl.includes('remember_browser') ||
        (await this.isRealLoggedIn(page, profileId))
      ) {
        logger.info(`🎯 Nhận diện trạng thái đích sau ${waitSec + 1}s: ${currentUrl}`);
        break;
      }

      await sleep(1000);
    }

    logger.info(`URL hiện tại sau đăng nhập: ${currentUrl}`);

    // =========================================================================
    // CASE 1: Trang kiểm tra bảo mật ngầm / Arkose MatchKey / ReCAPTCHA (Ảnh 2)
    // URL: facebook.com/two_step_verification/authentication/?encrypted_context=...
    // =========================================================================
    if (currentUrl.includes('/two_step_verification/authentication')) {
      logger.info('⏳ Phát hiện trang "Đang tiến hành kiểm tra bảo mật" (Arkose MatchKey / Silent Check)...');
      logger.info('Đang chờ Facebook tự động xác minh và chuyển hướng sang trang 2FA/Feed (tối đa 15 giây)...');

      // Chờ Facebook tự động chuyển hướng sau vài giây (như ghi chú: "Hệ thống sẽ tự động chuyển hướng bạn sau vài giây nữa")
      for (let sec = 0; sec < 15; sec++) {
        await sleep(1000);
        if (page.isClosed()) break;
        currentUrl = page.url();

        // 1. Nếu đã tự động chuyển sang trang 2FA hoặc Feed hoặc Checkpoint khác
        if (
          currentUrl.includes('/two_step_verification/two_factor') ||
          currentUrl.includes('/two_factor') ||
          currentUrl.includes('two-factor') ||
          currentUrl.includes('checkpoint') ||
          (await this.isRealLoggedIn(page, profileId))
        ) {
          logger.info(`✨ Facebook đã tự động vượt qua kiểm tra bảo mật và chuyển hướng đến: ${currentUrl}`);
          break;
        }

        // 2. Kiểm tra nếu có interactive CAPTCHA puzzle xuất hiện bắt người giải
        const hasInteractiveCaptcha = await this.safeIsVisible(
          page.locator('iframe[src*="arkoselabs"], iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[title*="challenge" i], #captcha').first(),
          500
        );

        if (hasInteractiveCaptcha) {
          const bodyText = (await page.evaluate('document.body ? document.body.innerText : ""').catch(() => '')) as string;
          // Nếu không phải chỉ là dòng thông báo chờ "Đang tiến hành kiểm tra bảo mật"
          if (bodyText.includes('Select') || bodyText.includes('Chọn') || bodyText.includes('puzzle') || bodyText.includes('audio')) {
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
        }
      }
    }

    currentUrl = page.isClosed() ? '' : page.url();

    // =========================================================================
    // CASE 1.8: Kiểm tra SAI MẬT KHẨU (Wrong Password / Invalid Credentials)
    // =========================================================================
    const postBodyText = (await page.evaluate('document.body ? document.body.innerText : ""').catch(() => '')) as string;
    const wrongPassKeywords = [
      'mật khẩu bạn đã nhập không chính xác',
      'mật khẩu không chính xác',
      'sai mật khẩu',
      'the password that you\'ve entered is incorrect',
      'the password you entered is incorrect',
      'incorrect password',
      'a senha inserida está incorreta',
      'senha incorreta',
      'contraseña incorrecta',
    ];

    if (wrongPassKeywords.some(kw => postBodyText.toLowerCase().includes(kw))) {
      logger.error(`❌ Facebook báo sai mật khẩu (Wrong Password) cho profile "${profileName}"!`);
      return {
        success: false,
        status: 'failed',
        message: '❌ Đăng nhập thất bại: Mật khẩu bạn đã nhập không chính xác (Wrong Password). Vui lòng cập nhật mật khẩu mới trên AdsPower.',
        currentUrl,
        profileId,
        profileName,
      };
    }

    // =========================================================================
    // CASE 2: Kiểm tra CHECKPOINT KHÓA TÀI KHOẢN / BẮT XÁC THỰC CON NGƯỜI
    // =========================================================================
    const checkpointInfo = await this.detectCheckpoint(page, profileId);
    if (checkpointInfo.isCheckpoint) {
      return this.reportCheckpointResult(page, profileId, profileName, checkpointInfo);
    }

    // =========================================================================
    // CASE 3: Trang xác thực 2FA (Ảnh 1: Go to your authentication app)
    // =========================================================================
    const is2FAPage =
      (currentUrl.includes('/two_step_verification/two_factor') ||
       currentUrl.includes('/two_factor') ||
       currentUrl.includes('two-factor') ||
       currentUrl.includes('two_step')) &&
      !currentUrl.includes('remember_browser');

    if (is2FAPage) {
      logger.info('🔐 Phát hiện trang xác thực 2FA (Two-Factor Authentication)!');

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

      return await this.handleTwoFactorPage(page, profileId, profileName, fakey);
    }

    // =========================================================================
    // CASE 4: Đã vào trang chính Facebook
    // =========================================================================
    if (await this.isRealLoggedIn(page, profileId)) {
      logger.info('🎉 Đăng nhập thành công vào trang chính Facebook!');
      return {
        success: true,
        status: 'logged_in',
        message: 'Đăng nhập Facebook thành công.',
        currentUrl,
        profileId,
        profileName,
      };
    }

    return {
      success: false,
      status: 'needs_human_review',
      message: `Đang ở trang: ${currentUrl}. Cần kiểm tra thêm.`,
      currentUrl,
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
    const humanCheckKeywords = [
      'confirm that you\'re human',
      'confirm that you are human',
      'xác nhận bạn là người thật',
      'xác minh bạn là con người',
      'confirme que você é humano',
      'confirm that you’re human to use your profile',
    ];

    for (const kw of humanCheckKeywords) {
      if (bodyText.toLowerCase().includes(kw)) {
        return {
          isCheckpoint: true,
          type: 'HUMAN_VERIFICATION_REQUIRED',
          detail: `Facebook yêu cầu xác minh con người: "${kw}"`,
        };
      }
    }

    // 2. Checkpoint Két Sắt / Khóa tài khoản (Account Locked / Suspended)
    const lockedKeywords = [
      'Tài khoản của bạn đã bị khóa',
      'Tài khoản của bạn đã bị tạm ngưng',
      'Tài khoản của bạn đã bị vô hiệu hóa',
      'Your account has been locked',
      'Your account has been disabled',
      'We suspended your account',
      'Sua conta foi bloqueada',
      'Sua conta foi desativada',
      'Suspenderemos sua conta',
    ];

    for (const kw of lockedKeywords) {
      if (bodyText.includes(kw)) {
        return {
          isCheckpoint: true,
          type: 'ACCOUNT_LOCKED',
          detail: `Tài khoản bị khóa/tạm ngưng: "${kw}"`,
        };
      }
    }

    // 3. Checkpoint Bắt Xác Minh Danh Tính (Upload ID / Selfie / Phone SMS)
    const idKeywords = [
      'Tải lên giấy tờ tùy thân',
      'Xác nhận danh tính',
      'Upload your ID',
      'Confirm your identity',
      'Help us confirm it\'s you',
      'Carregar documento de identidade',
      'Confirme sua identidade',
      'Gửi mã qua SMS',
      'Send code via SMS',
    ];

    for (const kw of idKeywords) {
      if (bodyText.includes(kw)) {
        return {
          isCheckpoint: true,
          type: 'IDENTITY_VERIFICATION',
          detail: `Facebook yêu cầu tải giấy tờ/SMS: "${kw}"`,
        };
      }
    }

    // 4. URL Checkpoint thực sự (Path là /checkpoint chứ không phải query param ?checkpoint_src=...)
    let isActualCheckpointPath = false;
    try {
      const parsedUrl = new URL(url);
      isActualCheckpointPath = parsedUrl.pathname.includes('/checkpoint');
    } catch {
      isActualCheckpointPath = url.includes('/checkpoint/') || url.includes('/checkpoint?');
    }

    // Ngoại lệ: 1501092823525282 là flow ID của luồng 2FA sau khi nộp OTP thành công, đang điều hướng về next=...
    if (url.includes('1501092823525282') || url.includes('flow=two_factor_login') || url.includes('next=https%3A%2F%2Fwww.facebook.com%2F')) {
      return { isCheckpoint: false };
    }

    if (isActualCheckpointPath && !url.includes('two_factor') && !url.includes('remember_browser')) {
      if (bodyText.includes('We suspect automated behavior') || bodyText.includes('Dismiss')) {
        return { isCheckpoint: false };
      }

      // Nếu có top navigation hoặc user profile avatar, không phải checkpoint
      const hasTopNav = await this.safeIsVisible(page.locator('div[role="navigation"], [aria-label*="Facebook" i], [aria-label*="Trang chủ" i], [aria-label*="Home" i]').first(), 300);
      if (hasTopNav) {
        return { isCheckpoint: false };
      }

      return {
        isCheckpoint: true,
        type: 'GENERIC_CHECKPOINT',
        detail: `Đang ở URL checkpoint: ${url}`,
      };
    }

    return { isCheckpoint: false };
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

    // =========================================================================
    // XỬ LÝ CASE: "Check your notifications on another device"
    // =========================================================================
    const isDeviceNotificationScreen = await page.evaluate(`(function() {
      var text = (document.body ? document.body.innerText : '').toLowerCase();
      return text.indexOf('check your notifications on another device') !== -1 ||
             text.indexOf('waiting for approval') !== -1 ||
             text.indexOf('kiểm tra thông báo trên thiết bị khác') !== -1;
    })()`).catch(() => false);

    if (isDeviceNotificationScreen) {
      logger.info('🎯 Phát hiện màn hình chờ phê duyệt từ thiết bị khác -> Bấm "Try another way"...');
      
      const tryAnotherWaySelectors = [
        'button:has-text("Try another way")',
        'a:has-text("Try another way")',
        'div[role="button"]:has-text("Try another way")',
        'button:has-text("Thử cách khác")',
        'a:has-text("Thử cách khác")',
        'button:has-text("Tente de outra forma")',
      ];

      for (const sel of tryAnotherWaySelectors) {
        if (page.isClosed()) break;
        const btn = page.locator(sel).first();
        if (await this.safeIsVisible(btn, 1500)) {
          logger.info(`Bấm: [${sel}] để mở danh sách tùy chọn 2FA...`);
          await this.safeClick(btn, 3000);
          await sleep(2000);
          break;
        }
      }
    }

    // =========================================================================
    // XỬ LÝ CASE: "Choose a way to confirm that it's you" -> Chọn "Authentication app"
    // =========================================================================
    const isOptionModalOpen = await page.evaluate(`(function() {
      var text = (document.body ? document.body.innerText : '').toLowerCase();
      return text.indexOf('choose a way to confirm') !== -1 ||
             text.indexOf('chọn cách xác nhận') !== -1 ||
             text.indexOf('escolha uma forma') !== -1;
    })()`).catch(() => false);

    if (isOptionModalOpen) {
      logger.info('🎯 Phát hiện Modal "Choose a way to confirm that it\'s you" -> Chọn Authentication app...');

      await page.evaluate(`(function() {
        var options = Array.from(document.querySelectorAll('div, label, span, input[type="radio"]'));
        for (var i = 0; i < options.length; i++) {
          var el = options[i];
          var t = (el.innerText || el.textContent || '').toLowerCase();
          if (t.indexOf('authentication app') !== -1 || t.indexOf('ứng dụng xác thực') !== -1 || t.indexOf('app de autenticação') !== -1) {
            el.click();
            break;
          }
        }
      })()`).catch(() => {});

      await sleep(1000);

      const modalContinueBtn = page.locator('div[role="dialog"] button:has-text("Continue"), div[role="dialog"] button:has-text("Tiếp tục"), button:has-text("Continue"), div[role="button"]:has-text("Continue")').first();
      if (await this.safeIsVisible(modalContinueBtn, 2000)) {
        logger.info('Bấm nút [Continue] trên Modal chọn 2FA...');
        await this.safeClick(modalContinueBtn, 3000);
        await sleep(3000);
      }
    }

    // =========================================================================
    // ĐIỀN MÃ TOTP VÀO Ô NHẬP 2FA (Ảnh 1: Go to your authentication app)
    // =========================================================================
    const code = generateTOTP(fakey);
    logger.info(`🔢 Tạo mã 2FA TOTP thành công từ Secret Key: [${code}]`);

    await sleep(2000);

    const injectResult = (await page.evaluate(`(function(totpCode) {
      function isElementVisible(el) {
        if (!el) return false;
        var style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        var rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      function findOTPInput() {
        var input = document.querySelector('input[autocomplete="one-time-code"]');
        if (input && isElementVisible(input)) return input;

        input = document.querySelector('input[name="approvals_code"]');
        if (input && isElementVisible(input)) return input;

        var inputs = Array.from(document.querySelectorAll('input'));
        var otpKeywords = [
          'approvals_code', 'code', 'otp', '2fa', 'twofactor', 'two-factor',
          'verification', 'security_code', 'authcode', 'passcode',
          'verification_code', 'one-time', 'security', 'login_code',
          'mã', 'xác thực', 'xác minh', 'bảo mật', 'mã xác nhận',
          'código', 'codigo', 'verificación', 'verificação', 'seguridad', 'segurança'
        ];

        for (var i = 0; i < inputs.length; i++) {
          var inp = inputs[i];
          var type = (inp.getAttribute('type') || 'text').toLowerCase();
          if (['text', 'number', 'tel', 'password'].indexOf(type) === -1) continue;
          if (!isElementVisible(inp)) continue;

          var name = (inp.name || '').toLowerCase();
          var id = (inp.id || '').toLowerCase();
          var placeholder = (inp.placeholder || '').toLowerCase();
          var label = (inp.getAttribute('aria-label') || '').toLowerCase();

          for (var k = 0; k < otpKeywords.length; k++) {
            var kw = otpKeywords[k];
            if (name.indexOf(kw) !== -1 || id.indexOf(kw) !== -1 || placeholder.indexOf(kw) !== -1 || label.indexOf(kw) !== -1) {
              return inp;
            }
          }
        }

        var visibleInputs = inputs.filter(function(i) {
          var t = (i.type || 'text').toLowerCase();
          return isElementVisible(i) && (t === 'text' || t === 'number' || t === 'tel');
        });
        if (visibleInputs.length === 1) return visibleInputs[0];

        return null;
      }

      var targetInput = findOTPInput();
      if (targetInput) {
        targetInput.focus();
        targetInput.value = totpCode;
        
        targetInput.dispatchEvent(new Event('input', { bubbles: true }));
        targetInput.dispatchEvent(new Event('change', { bubbles: true }));
        targetInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: '1' }));
        targetInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: '1' }));

        return {
          found: true,
          id: targetInput.id,
          name: targetInput.name,
          placeholder: targetInput.placeholder
        };
      }

      return { found: false };
    })(${JSON.stringify(code)})`).catch(() => ({ found: false }))) as { found: boolean; id?: string; name?: string; placeholder?: string };

    logger.info(`Kết quả dò và điền OTP trực tiếp: ${JSON.stringify(injectResult)}`);

    try {
      const codeInput = page.locator('input[placeholder*="Code" i], input[placeholder*="code" i], input[type="text"], input[type="number"]').first();
      if (await this.safeIsVisible(codeInput, 2000)) {
        logger.info('Nhập mã 2FA bằng Playwright pressSequentially...');
        await codeInput.click({ force: true }).catch(() => {});
        await codeInput.fill('').catch(() => {});
        await codeInput.pressSequentially(code, { delay: 100 }).catch(() => {});
        await sleep(1000);
      }
    } catch {}

    logger.info('Đang tìm và bấm nút [Continue] / [Tiếp tục]...');
    const continueBtnSelectors = [
      'button:has-text("Continue")',
      'div[role="button"]:has-text("Continue")',
      'button:has-text("Tiếp tục")',
      'button:has-text("Continuar")',
      'button:has-text("Avançar")',
      'button#checkpointSubmitButton',
      'button[type="submit"]',
      'input[type="submit"]',
    ];

    let clicked = false;
    for (const sel of continueBtnSelectors) {
      if (page.isClosed()) break;
      const btn = page.locator(sel).first();
      if (await this.safeIsVisible(btn, 1500)) {
        logger.info(`Bấm nút [${sel}]...`);
        await this.safeClick(btn, 4000);
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      logger.info('Nhấn Enter trên ô 2FA...');
      await page.keyboard.press('Enter').catch(() => {});
    }

    logger.info('Đang chờ phản hồi sau khi nộp 2FA...');
    await sleep(6000);

    await this.handleIntermediatePages(page, profileId);

    const finalUrl = page.isClosed() ? '' : page.url();
    logger.info(`URL sau khi nộp 2FA và dọn dẹp trang trung gian: ${finalUrl}`);

    const loggedIn = await this.isRealLoggedIn(page, profileId);

    return {
      success: true,
      status: loggedIn ? 'logged_in' : 'two_factor_completed',
      message: `Đã tự động điền mã 2FA (${code}), bấm Continue và tự động xử lý các trang trung gian thành công!`,
      currentUrl: finalUrl,
      profileId,
      profileName,
      twoFactorCodeUsed: code,
    };
  }
}

export const facebookLoginAutomation = new FacebookLoginAutomation();
