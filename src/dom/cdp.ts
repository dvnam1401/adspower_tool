import { chromium, Browser, BrowserContext, Page } from 'playwright-core';
import { logger } from '../utils/logger.js';
import { DOMAction, DOMActionResult, SelectorItem } from '../types/index.js';

interface ActiveSession {
  profileId: string;
  wsEndpoint: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  connectedAt: Date;
}

export class PlaywrightCDPManager {
  private sessions: Map<string, ActiveSession> = new Map();

  /**
   * Connect to an AdsPower browser instance via WebSocket DevTools Protocol
   * Attach directly to existing window/tabs without opening new windows
   */
  public async connect(profileId: string, wsEndpoint: string): Promise<Page> {
    const existing = this.sessions.get(profileId);
    if (existing && existing.browser.isConnected()) {
      // Re-verify if existing page is still open
      try {
        if (!existing.page.isClosed()) {
          return existing.page;
        }
      } catch {}
    }

    logger.info(`[CDP] Đang kết nối Playwright tới AdsPower profile ${profileId}...`);
    try {
      const browser = await chromium.connectOverCDP(wsEndpoint, {
        timeout: 25000,
      });

      const contexts = browser.contexts();
      const context = contexts.length > 0 ? contexts[0] : await browser.newContext();

      const pages: Page[] = context.pages();
      logger.info(`[CDP] Profile ${profileId} có ${pages.length} tab(s) đang mở.`);

      // Lọc các trang còn sống, ưu tiên tab Facebook hoặc tab có nội dung
      const alivePages: Page[] = pages.filter((p: Page) => !p.isClosed());
      let page: Page = alivePages.find((p: Page) => p.url().includes('facebook.com') || p.url().includes('fb.com')) 
        || alivePages.find((p: Page) => !p.url().includes('about:blank')) 
        || alivePages[0] 
        || await context.newPage();

      await page.bringToFront().catch(() => {});

      const session: ActiveSession = {
        profileId,
        wsEndpoint,
        browser,
        context,
        page,
        connectedAt: new Date(),
      };

      // Tự động theo dõi khi có tab mới mở
      context.on('page', (newPage) => {
        logger.debug(`[CDP] Tab mới được mở: ${newPage.url()}`);
        if (session.page.isClosed()) {
          session.page = newPage;
        }
      });

      this.sessions.set(profileId, session);

      browser.on('disconnected', () => {
        logger.info(`[CDP] Browser ${profileId} đã ngắt kết nối.`);
        this.sessions.delete(profileId);
      });

      logger.info(`[CDP] Đang sử dụng tab: "${await page.title().catch(() => 'Untitled')}" [${page.url()}]`);
      return page;
    } catch (err: any) {
      logger.error(`[CDP] Kết nối Playwright thất bại: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get active page for a profile with auto-healing if current tab was closed
   */
  public getActivePage(profileId: string): Page | null {
    const session = this.sessions.get(profileId);
    if (!session || !session.browser.isConnected()) return null;

    if (!session.page.isClosed()) {
      return session.page;
    }

    // Nếu page hiện tại đã bị đóng, tìm trong context xem còn tab nào sống không
    const alivePages = session.context.pages().filter(p => !p.isClosed());
    if (alivePages.length > 0) {
      const fbPage = alivePages.find(p => p.url().includes('facebook.com')) || alivePages[0];
      session.page = fbPage;
      logger.info(`[CDP Auto-Healing] Tự động chuyển sang tab sống: "${fbPage.url()}"`);
      return fbPage;
    }

    return null;
  }

  /**
   * Get active page for a profile (alias)
   */
  public getPage(profileId: string): Page | undefined {
    return this.getActivePage(profileId) || undefined;
  }

  /**
   * Get all open pages in the profile's browser
   */
  public getPages(profileId: string): Page[] {
    const session = this.sessions.get(profileId);
    return session?.context?.pages().filter(p => !p.isClosed()) || [];
  }

  /**
   * READ-ONLY: resolve the browser windowId and DevTools targetId that own a
   * given page, via a short-lived CDP session. Never creates windows/tabs and
   * never mutates page state — safe for both Google and Facebook workflows.
   */
  public async getPageWindow(page: Page): Promise<{ windowId: number; targetId: string }> {
    const cdp = await page.context().newCDPSession(page);
    try {
      const win = (await cdp.send('Browser.getWindowForTarget')) as { windowId: number };
      const info = (await cdp.send('Target.getTargetInfo')) as {
        targetInfo?: { targetId?: string };
      };
      return { windowId: win.windowId, targetId: info?.targetInfo?.targetId ?? '' };
    } finally {
      await cdp.detach().catch(() => {});
    }
  }

  /**
   * Disconnect CDP session
   */
  public async disconnect(profileId: string): Promise<void> {
    const session = this.sessions.get(profileId);
    if (session) {
      try {
        await session.browser.close();
      } catch {}
      this.sessions.delete(profileId);
    }
  }

  /**
   * Navigate existing page to URL với retry tự động.
   * Nếu tải quá 30s hoặc giao diện không đầy đủ → stop tải + reload, thử lại tối đa maxRetries lần.
   */
  public async navigate(
    profileId: string,
    url: string,
    wsEndpoint?: string,
    maxRetries = 3,
  ): Promise<{ url: string; title: string }> {
    let page = this.getPage(profileId);
    if (!page && wsEndpoint) {
      page = await this.connect(profileId, wsEndpoint);
    }
    if (!page) {
      throw new Error(`Profile ${profileId} chưa được kết nối CDP.`);
    }

    const NAV_TIMEOUT_MS = 30000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      logger.info(`[CDP] Profile ${profileId} điều hướng tới: ${url} (lần ${attempt}/${maxRetries})`);

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      } catch (navErr: any) {
        // Timeout hoặc lỗi mạng → dừng tải trang ngay lập tức
        logger.warn(`[CDP] Profile ${profileId} tải trang thất bại (lần ${attempt}): ${navErr.message}`);
        logger.info(`[CDP] Profile ${profileId} đang dừng tải trang và chuẩn bị refresh...`);
        try {
          await page.evaluate(() => window.stop());
        } catch {}

        if (attempt >= maxRetries) {
          throw new Error(`Không thể tải trang ${url} sau ${maxRetries} lần thử: ${navErr.message}`);
        }

        // Chờ 1.5s rồi reload
        await new Promise(r => setTimeout(r, 1500));
        logger.info(`[CDP] Profile ${profileId} đang reload trang (lần ${attempt + 1}/${maxRetries})...`);
        try {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        } catch {}
        continue;
      }

      // ── Kiểm tra giao diện có đầy đủ không ──
      const pageState = await this._checkPageIntegrity(page, url);

      if (pageState.ok) {
        const title = await page.title().catch(() => '');
        logger.info(`[CDP] Profile ${profileId} tải trang thành công (lần ${attempt}): "${title}" [${page.url()}]`);
        return { url: page.url(), title };
      }

      logger.warn(`[CDP] Profile ${profileId} giao diện chưa đầy đủ (lần ${attempt}): ${pageState.reason}`);

      if (attempt >= maxRetries) {
        // Lần cuối: trả về kết quả dù không đầy đủ (không throw, tránh fail task hoàn toàn)
        const title = await page.title().catch(() => '');
        logger.warn(`[CDP] Profile ${profileId} hết lần thử — chấp nhận trạng thái trang hiện tại.`);
        return { url: page.url(), title };
      }

      // Giao diện chưa đủ → stop + reload
      logger.info(`[CDP] Profile ${profileId} đang dừng tải và refresh để tải lại đầy đủ (lần ${attempt + 1}/${maxRetries})...`);
      try {
        await page.evaluate(() => window.stop());
      } catch {}
      await new Promise(r => setTimeout(r, 1500));
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      } catch {}
    }

    const title = await page.title().catch(() => '');
    return { url: page.url(), title };
  }

  /**
   * Kiểm tra xem trang đã tải đầy đủ nội dung chưa.
   * Trả về { ok: true } nếu trang ổn, { ok: false, reason } nếu chưa đủ.
   */
  private async _checkPageIntegrity(page: Page, expectedUrl: string): Promise<{ ok: boolean; reason?: string }> {
    try {
      const currentUrl = page.url();

      // 1. Kiểm tra URL không phải about:blank hoặc chrome:// đột ngột
      if (currentUrl === 'about:blank' || currentUrl.startsWith('chrome-error://')) {
        return { ok: false, reason: `URL không hợp lệ: ${currentUrl}` };
      }

      // 2. Kiểm tra nội dung body có thực sự tải được không
      const bodyCheck = await page.evaluate(() => {
        const body = document.body;
        if (!body) return { hasBody: false, childCount: 0, textLength: 0 };
        return {
          hasBody: true,
          childCount: body.children.length,
          textLength: (body.innerText || body.textContent || '').trim().length,
        };
      }).catch(() => ({ hasBody: false, childCount: 0, textLength: 0 }));

      if (!bodyCheck.hasBody) {
        return { ok: false, reason: 'body không tồn tại trong DOM' };
      }

      if (bodyCheck.childCount === 0 && bodyCheck.textLength < 10) {
        return { ok: false, reason: `body rỗng (${bodyCheck.childCount} children, ${bodyCheck.textLength} chars)` };
      }

      // 3. Kiểm tra lỗi ERR_INTERNET_DISCONNECTED / ERR_NAME_NOT_RESOLVED (Chrome error page)
      const isErrorPage = await page.evaluate(() => {
        const text = document.body?.innerText || '';
        return text.includes('ERR_') || text.includes('NET::ERR') || text.includes('This site can\'t be reached');
      }).catch(() => false);

      if (isErrorPage) {
        return { ok: false, reason: 'trang hiển thị lỗi kết nối Chrome (ERR_*)' };
      }

      return { ok: true };
    } catch (e: any) {
      return { ok: false, reason: `Kiểm tra integrity thất bại: ${e.message}` };
    }
  }



  /**
   * Capture screenshot as base64 string với retry khi trang đang tải fonts/resources.
   */
  public async takeScreenshot(profileId: string, maxRetries = 3): Promise<string> {
    const page = this.getPage(profileId);
    if (!page) {
      throw new Error(`Profile ${profileId} chưa được kết nối CDP.`);
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const buffer = await page.screenshot({ type: 'jpeg', quality: 75, timeout: 20000 });
        return buffer.toString('base64');
      } catch (err: any) {
        logger.warn(`[CDP] Screenshot thất bại (lần ${attempt}/${maxRetries}): ${err.message}`);
        if (attempt >= maxRetries) {
          // Lần cuối: thử force-stop trang rồi screenshot lại
          try {
            await page.evaluate(() => window.stop());
            await new Promise(r => setTimeout(r, 1000));
            const buffer = await page.screenshot({ type: 'jpeg', quality: 75, timeout: 10000 });
            return buffer.toString('base64');
          } catch (finalErr: any) {
            throw new Error(`Screenshot thất bại sau ${maxRetries} lần thử: ${finalErr.message}`);
          }
        }
        // Chờ trang ổn định rồi thử lại
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    throw new Error(`Screenshot thất bại sau ${maxRetries} lần thử.`);
  }


  /**
   * Get a simplified DOM snapshot for LLM context
   */
  public async getDOMSnapshot(page: Page): Promise<string> {
    try {
      const snapshot = await page.evaluate(`(function() {
        // Collect interactable elements (buttons, links, inputs)
        const elements = Array.from(document.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="link"]'))
          .filter(el => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
          });
        
        return elements.map(el => {
          const tag = el.tagName.toLowerCase();
          const type = el.getAttribute('type') || '';
          const id = el.id ? '#' + el.id : '';
          const name = el.getAttribute('name') ? '[name="' + el.getAttribute('name') + '"]' : '';
          const ariaLabel = el.getAttribute('aria-label') ? '[aria-label="' + el.getAttribute('aria-label') + '"]' : '';
          const text = (el.innerText || el.textContent || '').trim().substring(0, 50).replace(/\n/g, ' ');
          const placeholder = el.getAttribute('placeholder') || '';
          const value = el.getAttribute('value') || '';
          
          let info = tag + id + name + ariaLabel;
          if (type) info += '[type="' + type + '"]';
          if (placeholder) info += ' placeholder: "' + placeholder + '"';
          if (value && (tag === 'input' || tag === 'textarea')) info += ' value: "' + value + '"';
          if (text) info += ' text: "' + text + '"';
          
          return info;
        }).join('\\n');
      })()`);
      
      return (snapshot as string) || 'DOM is empty or could not be parsed.';
    } catch (e: any) {
      return `Failed to get DOM snapshot: ${e.message}`;
    }
  }

  /**
   * Execute deterministic DOM action with selector chain fallback
   */
  public async executeAction(profileId: string, action: DOMAction): Promise<DOMActionResult> {
    const page = this.getPage(profileId);
    if (!page) {
      throw new Error(`Profile ${profileId} chưa kết nối CDP.`);
    }

    const startTime = Date.now();
    const selectors = action.selectorChain || [];

    if (selectors.length === 0) {
      throw new Error('Action không có selector chain để thực thi.');
    }

    const sorted = [...selectors].sort((a, b) => a.priority - b.priority);

    let lastError: Error | null = null;
    for (const sel of sorted) {
      try {
        let locator;
        if (sel.type === 'text') {
          locator = page.getByText(sel.value).first();
        } else if (sel.type === 'aria-label') {
          locator = page.getByLabel(sel.value).first();
        } else if (sel.type === 'placeholder') {
          locator = page.getByPlaceholder(sel.value).first();
        } else if (sel.type === 'role') {
          locator = page.getByRole(sel.value as any).first();
        } else {
          locator = page.locator(sel.value).first();
        }

        await locator.waitFor({ state: 'visible', timeout: action.timeoutMs || 4000 });

        if (action.actionType === 'click') {
          await locator.click({ timeout: 4000 });
        } else if (action.actionType === 'fill') {
          await locator.fill(action.value || '', { timeout: 4000 });
        } else if (action.actionType === 'type') {
          await locator.pressSequentially(action.value || '', { delay: 50 });
        } else if (action.actionType === 'hover') {
          await locator.hover({ timeout: 4000 });
        } else if (action.actionType === 'extract_text') {
          const text = await locator.innerText();
          return {
            success: true,
            action,
            usedSelector: sel,
            extractedValue: text,
            durationMs: Date.now() - startTime,
          };
        }

        return {
          success: true,
          action,
          usedSelector: sel,
          durationMs: Date.now() - startTime,
        };
      } catch (err: any) {
        lastError = err;
      }
    }

    return {
      success: false,
      action,
      durationMs: Date.now() - startTime,
      error: lastError?.message || 'Không tìm thấy element với bất kỳ selector nào.',
    };
  }
}

export const cdpManager = new PlaywrightCDPManager();
