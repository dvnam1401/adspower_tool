/**
 * Account Hub — AdsPower Adapter (Phase 5)
 *
 * Wraps the existing adsPowerClient (read-only in Phase 5).
 * No modifications to src/adspower/client.ts.
 */

import { adsPowerClient } from '../../adspower/client.js';
import { logger } from '../../utils/logger.js';

export interface AdspowerProfileSummary {
  userId:          string;
  name:            string;
  groupId:         string;
  serialNumber:    string;
  lastOpenedTabs?: string[];
}

export class AdspowerAdapter {
  /** List all profiles page by page — read only */
  async listAllProfiles(): Promise<AdspowerProfileSummary[]> {
    const profiles: AdspowerProfileSummary[] = [];
    let page = 1;
    const pageSize = 100;

    while (true) {
      try {
        const result = await adsPowerClient.listProfiles({
          page,
          pageSize,
          groupId: '',
        });

        if (!result || !result.list || result.list.length === 0) break;

        for (const p of result.list) {
          profiles.push({
            userId:          p.user_id,
            name:            p.name || '',
            groupId:         p.group_id || '',
            serialNumber:    p.serial_number || '',
            lastOpenedTabs:  p.last_opened_tabs,
          });
        }

        if (result.list.length < pageSize) break;
        page++;
      } catch (err) {
        logger.error(`[AccountHub][AdspowerAdapter] Error listing profiles page ${page}: ${err}`);
        throw err;
      }
    }

    return profiles;
  }

  /** Find a single profile by user_id — read only */
  async findByUserId(userId: string): Promise<AdspowerProfileSummary | null> {
    try {
      const result = await adsPowerClient.listProfiles({ page: 1, pageSize: 1, userId });
      if (!result?.list?.[0]) return null;
      const p = result.list[0];
      return {
        userId: p.user_id,
        name: p.name || '',
        groupId: p.group_id || '',
        serialNumber: p.serial_number || '',
      };
    } catch {
      return null;
    }
  }
}
