import { Page } from 'playwright-core';
import { logger } from '../utils/logger.js';

export class PopupKiller {
  /**
   * Inject script to block native dialogs
   */
  public async injectInitScript(page: Page) {
    await page.addInitScript(() => {
      const win = globalThis as any;
      // Block native popups
      win.alert = () => {};
      win.confirm = () => true;
      win.prompt = () => null;
      
      // Block notifications and geolocations early
      if (win.Notification && win.Notification.requestPermission) {
        win.Notification.requestPermission = () => Promise.resolve('denied');
      }
    }).catch(() => {});
  }

  /**
   * Smash escape to close modals
   */
  public async smashEscape(page: Page) {
    logger.info('[PopupKiller] Smashing Escape key to dismiss active modals...');
    await page.keyboard.press('Escape').catch(() => {});
    await new Promise(r => setTimeout(r, 500));
    await page.keyboard.press('Escape').catch(() => {});
  }

  /**
   * Dismiss NATIVE browser-chrome popups that overlay the page and are INVISIBLE
   * to Playwright DOM locators — e.g. Chrome's credential/account picker, the
   * FedCM "Sign in with …" bubble, or the password-manager save/select prompt.
   *
   * Strategy (locale-independent, no text matching): bring the tab to front and
   * focus the document so the key event is delivered to the browser view, then
   * press Escape (twice, with a small settle) which closes these native bubbles.
   * Fully idempotent and harmless when no popup is present.
   */
  public async dismissNativePopup(page: Page): Promise<void> {
    if (!page || page.isClosed()) return;
    try {
      await page.bringToFront().catch(() => {});
      // Focus the page/body so Escape reaches the browser view instead of being
      // swallowed by a focused native widget or an unfocused tab.
      await page.evaluate(() => {
        try {
          (window as any).focus?.();
          (document.body as any)?.focus?.();
        } catch { /* noop */ }
      }).catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
      await new Promise(r => setTimeout(r, 400));
      await page.keyboard.press('Escape').catch(() => {});
      await new Promise(r => setTimeout(r, 300));
    } catch {
      /* harmless: nothing to dismiss */
    }
  }
}

export const popupKiller = new PopupKiller();
