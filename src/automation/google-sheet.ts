import { logger } from '../utils/logger.js';
import { AccountStatus } from '../types/index.js';

export interface BackupCredentials {
  cookie?: string;
  token?: string;
}

export class GoogleSheetService {
  /**
   * Mock method to get fallback cookie/token from Google Sheet
   */
  public async getBackupData(profileId: string): Promise<BackupCredentials | null> {
    logger.info(`[GoogleSheet] Fetching backup credentials for profile ${profileId}...`);
    return {
      cookie: 'c_user=12345; xs=abcde; datr=foo;',
      token: 'EAAGm0PX4ZCpwBA...'
    };
  }

  public async updateStatus(profileId: string, status: AccountStatus): Promise<void> {
    logger.info(`[GoogleSheet] Đã cập nhật trạng thái của ${profileId} thành ${status} trên Sheet.`);
  }
}

export const googleSheetService = new GoogleSheetService();
