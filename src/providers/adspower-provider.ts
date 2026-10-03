/**
 * AdsPower provider — wrapper MỎNG quanh `adsPowerClient`.
 *
 * Toàn bộ logic bên dưới được DI CHUYỂN NGUYÊN VĂN từ
 * `WorkflowEngine.resolveProfileList` / `executeStep` / `runTask` để hành vi
 * AdsPower KHÔNG thay đổi một byte: cùng thứ tự match identifier, cùng chuỗi
 * log/lỗi tiếng Việt, cùng hợp đồng `stopped !== false`.
 */

import { adsPowerClient } from '../adspower/client.js';
import { logger } from '../utils/logger.js';
import { AdsPowerProfileInfo } from '../types/index.js';
import { BrowserProfileProvider, ResolveProfilesResult } from './types.js';

export class AdsPowerProvider implements BrowserProfileProvider {
  public readonly id = 'adspower' as const;
  public readonly label = 'AdsPower';
  public readonly providesCredentials = true;
  /** Giữ nguyên: AdsPower tuân theo cờ toàn cục `closeSuccessBrowsers`. */
  public readonly autoCloseSuccessDefault = null;

  /** Giải quyết identifier (user_id, serial_number có/không `#`, tên profile). */
  public async resolveProfiles(identifiers: string[]): Promise<ResolveProfilesResult> {
    let allProfiles: AdsPowerProfileInfo[] = [];
    try {
      const resAll = await adsPowerClient.listProfiles({ fetchAll: true, pageSize: 100 });
      allProfiles = resAll.list || [];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[WorkflowEngine] Không thể tải danh sách profiles từ AdsPower: ${msg}`);
    }

    const resolved: ResolveProfilesResult['resolved'] = [];
    const notFound: string[] = [];

    for (const rawId of identifiers) {
      const cleanId = rawId.trim();
      if (!cleanId) continue;

      const cleanLower = cleanId.toLowerCase().replace(/\s+/g, ' ').trim();
      const serialNum = cleanId.replace(/^#/, '').trim();

      const found = allProfiles.find(p => {
        const pName = (p.name || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const pUser = String(p.user_id || '').trim();
        const pSerial = String(p.serial_number || '').trim();

        return (
          pUser === cleanId ||
          pSerial === cleanId ||
          pSerial === serialNum ||
          pName === cleanLower
        );
      });

      if (found) {
        resolved.push({ identifier: cleanId, profile: found });
      } else {
        notFound.push(cleanId);
      }
    }

    return { resolved, notFound };
  }

  public async startBrowser(profileId: string): Promise<{ wsEndpoint: string }> {
    const connData = await adsPowerClient.startBrowser({ profileId });
    if (!connData || !connData.ws || !connData.ws.puppeteer) {
      throw new Error(
        `Không thể khởi động AdsPower Profile ${profileId}. Cổng kết nối websocket không khả dụng.`
      );
    }
    return { wsEndpoint: connData.ws.puppeteer };
  }

  public async stopBrowser(profileId: string): Promise<boolean> {
    const stopped = await adsPowerClient.stopBrowser({ profileId });
    return stopped !== false;
  }
}

export const adsPowerProvider = new AdsPowerProvider();
