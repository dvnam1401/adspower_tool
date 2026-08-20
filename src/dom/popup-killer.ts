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
}

export const popupKiller = new PopupKiller();
