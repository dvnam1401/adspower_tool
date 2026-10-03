import { cdpManager } from '../dom/cdp.js';
import { logger } from '../utils/logger.js';

/**
 * Reads the current 2FA code from the AdsPower start page tab.
 *
 * SECURITY:
 * - Reuses the profile's EXISTING start.adspower.net tab. NEVER opens a new
 *   tab / URL / browser and NEVER navigates the AdsPower tab.
 * - The extracted 2FA code is treated as a secret: it is NEVER logged.
 */

export type Read2FAResult = { code: string } | { failed: true; reason: string };

/**
 * Pure, side-effect-free extractor of a 6-digit 2FA code from a text blob.
 *
 * Mirrors the code-extraction rule used against the live DOM: it returns the
 * first standalone 6-digit run found in the text, or null when absent. Numbers
 * that are not exactly 6 digits long are ignored.
 *
 * Deterministic and browser-free so it can be unit tested in isolation.
 */
export function extract2FA(domText: string): string | null {
  if (!domText) return null;
  const match = domText.match(/\b\d{6}\b/);
  return match ? match[0] : null;
}

export class AdsPower2FAProvider {
  /**
   * Read the freshest 2FA code from the profile's existing AdsPower start tab.
   * Does NOT open a new tab/URL/browser and does NOT navigate the tab.
   */
  public async readCurrentProfile2FA(
    profileId: string,
    opts?: { timeoutMs?: number }
  ): Promise<Read2FAResult> {
    const timeoutMs = opts?.timeoutMs ?? 5000;
    const intervalMs = 500;

    const pages = cdpManager.getPages(profileId);
    const twoFaPage = pages.find(p => p.url().includes('start.adspower.net'));

    if (!twoFaPage) {
      logger.info(`[AdsPower 2FA] Không tìm thấy tab start.adspower.net cho profile ${profileId}`);
      return { failed: true, reason: 'no_adspower_2fa_tab' };
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const code = await twoFaPage
        .evaluate(() => {
          // Method 1: Find by matching label "2FA Code"
          const divs = Array.from(document.querySelectorAll('div'));
          for (const div of divs) {
            const className = (div.className as string) || '';
            const innerText = (div as HTMLElement).innerText || '';
            if (className.includes('_cell__label') && innerText.includes('2FA Code')) {
              const cell = div.closest('[class*="_cell__"]');
              if (cell) {
                const codeEl = cell.querySelector('[class*="_totp__code"]');
                if (codeEl) {
                  const rawText = codeEl.textContent || '';
                  const m = rawText.trim().match(/^\d{6}/);
                  if (m) return m[0];
                }
              }
            }
          }

          // Method 2: Direct class fallback
          const directCodeEl = document.querySelector('[class*="_totp__code"]');
          if (directCodeEl) {
            const rawText = directCodeEl.textContent || '';
            const m = rawText.trim().match(/^\d{6}/);
            if (m) return m[0];
          }

          return null;
        })
        .catch(() => null);

      if (code) {
        logger.info(`[AdsPower 2FA] Đã lấy được mã 2FA cho profile ${profileId}`);
        return { code };
      }

      if (Date.now() + intervalMs > deadline) break;
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    logger.info(`[AdsPower 2FA] Không lấy được mã 2FA cho profile ${profileId} trong ${timeoutMs}ms`);
    return { failed: true, reason: '2fa_code_not_found' };
  }
}

export const adsPower2FAProvider = new AdsPower2FAProvider();
