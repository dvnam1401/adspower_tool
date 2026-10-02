/**
 * taothaoAIClaw provider — map Local API của taothao vào seam `BrowserProfileProvider`.
 *
 * Khác biệt so với AdsPower mà provider này chịu trách nhiệm che đi:
 *   - profile taothao KHÔNG mang credential -> `providesCredentials = false`
 *     (credential phải đến từ input của người dùng, xem `google-account-input.ts`).
 *   - `GET /api/profiles` phân trang (limit mặc định 20) -> luôn `fetchAll`.
 *   - `launch` idempotent: profile đang chạy thì TÁI DÙNG Chrome hiện có,
 *     không bao giờ mở cửa sổ thứ hai.
 *   - Khoá đóng thật của backend là `folder`, nhưng API tự resolve từ `profileId`
 *     nên seam vẫn chỉ cần `profileId`.
 *
 * Trùng ID profile: nếu API trả về nhiều bản ghi cùng `profileId` thì đây là dữ liệu
 * hỏng — provider CHỌN bản ghi đầu tiên nhưng cảnh báo, còn việc từ chối batch khi
 * người dùng dán trùng ID do `buildExecutionMapping` xử lý (tránh rò rỉ credential
 * chéo vì store credential keyed theo profileId).
 */

import { logger } from '../utils/logger.js';
import { taothaoClient, TaothaoClient, TaothaoProfile } from '../taothao/client.js';
import { BrowserProfileProvider, ProviderProfile, ResolveProfilesResult } from './types.js';

/** Chuẩn hoá tên profile để so khớp (giống cơ chế AdsPower: lowercase + gộp space). */
function normalizeName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function toProviderProfile(profile: TaothaoProfile): ProviderProfile {
  return {
    user_id: profile.profileId,
    name: profile.name,
    group_id: profile.groupId ?? undefined,
    folder: profile.folder ?? undefined,
    isRunning: profile.isRunning,
  };
}

export class TaothaoProvider implements BrowserProfileProvider {
  public readonly id = 'taothao' as const;
  public readonly label = 'taothaoAIClaw';
  public readonly providesCredentials = false;
  /**
   * Browser taothao do CHÍNH TA mở qua `launch` nên khi SUCCESS ta tự dọn,
   * không phụ thuộc cờ toàn cục của AdsPower. Thất bại vẫn GIỮ MỞ.
   */
  public readonly autoCloseSuccessDefault = true;

  constructor(private readonly client: TaothaoClient = taothaoClient) {}

  /**
   * Map identifier -> profile. Ưu tiên `profileId` khớp CHÍNH XÁC, sau đó tên
   * (chuẩn hoá). Tên bị trùng giữa nhiều profile -> coi là KHÔNG xác định được và
   * đưa vào `notFound` (không đoán bừa, vì chọn sai profile = đăng nhập sai máy).
   * Thứ tự input được GIỮ NGUYÊN.
   */
  public async resolveProfiles(identifiers: string[]): Promise<ResolveProfilesResult> {
    const all = await this.client.listProfiles({ fetchAll: true, limit: 200 });

    const byId = new Map<string, TaothaoProfile>();
    const byName = new Map<string, TaothaoProfile[]>();
    for (const profile of all.list) {
      if (byId.has(profile.profileId)) {
        logger.warn(
          `[taothao] Trùng profileId "${profile.profileId}" trong dữ liệu API -> dùng bản ghi đầu tiên.`
        );
      } else {
        byId.set(profile.profileId, profile);
      }
      const key = normalizeName(profile.name);
      const bucket = byName.get(key);
      if (bucket) bucket.push(profile);
      else byName.set(key, [profile]);
    }

    const resolved: ResolveProfilesResult['resolved'] = [];
    const notFound: string[] = [];

    for (const rawId of identifiers) {
      const cleanId = rawId.trim();
      if (!cleanId) continue;

      const direct = byId.get(cleanId);
      if (direct) {
        resolved.push({ identifier: cleanId, profile: toProviderProfile(direct) });
        continue;
      }

      const named = byName.get(normalizeName(cleanId));
      if (named && named.length === 1) {
        resolved.push({ identifier: cleanId, profile: toProviderProfile(named[0]) });
        continue;
      }
      if (named && named.length > 1) {
        logger.warn(
          `[taothao] Tên profile "${cleanId}" khớp ${named.length} profile khác nhau -> từ chối đoán, cần dùng profileId.`
        );
      }
      notFound.push(cleanId);
    }

    return { resolved, notFound };
  }

  public async startBrowser(profileId: string): Promise<{ wsEndpoint: string }> {
    const launched = await this.client.launchProfile(profileId);
    logger.info(
      `[taothao] Profile ${profileId} đã sẵn sàng CDP (pid=${launched.pid ?? 'n/a'}, port=${launched.port ?? 'n/a'}).`
    );
    return { wsEndpoint: launched.wsEndpoint };
  }

  public async stopBrowser(profileId: string): Promise<boolean> {
    return await this.client.closeProfile(profileId);
  }
}

export const taothaoProvider = new TaothaoProvider();
