/**
 * Provider seam — trừu tượng hoá backend quản lý browser-profile.
 *
 * Mục tiêu: WorkflowEngine chỉ cần 3 khả năng từ một backend profile
 * (resolve danh sách → mở browser lấy websocket CDP → đóng browser).
 * `cdpManager` và toàn bộ máy trạng thái đăng nhập (`google-login.ts`) đã
 * provider-neutral nên KHÔNG nằm trong seam này.
 *
 * Backend hiện có:
 *   - `adspower`  : AdsPower Local API (mặc định, hành vi KHÔNG được thay đổi)
 *   - `taothao`   : taothaoAIClaw / GoAnidetectAI Local API
 *
 * SECURITY: `ProviderProfile` chỉ chứa metadata an toàn để log. KHÔNG bao giờ
 * mang proxy password / cookie / token của backend vào đây.
 */

import { AdsPowerProfileInfo, BrowserProviderId } from '../types/index.js';

export type { BrowserProviderId };

/** Provider mặc định — giữ nguyên hành vi cũ khi caller không chỉ định gì. */
export const DEFAULT_BROWSER_PROVIDER: BrowserProviderId = 'adspower';

export function isBrowserProviderId(value: unknown): value is BrowserProviderId {
  return value === 'adspower' || value === 'taothao';
}

/**
 * Bản ghi profile mà engine dùng nội bộ.
 *
 * Tên field (`user_id`, `name`, `serial_number`, `group_id`) là HỢP ĐỒNG ĐANG BỊ
 * KHOÁ bởi `tests/workflow-engine.test.ts` (stub `resolveProfileList` trả đúng
 * shape này, và `runBatch` đọc `profile.user_id` / `profile.name`). Vì vậy
 * provider mới phải MAP sang đúng các field này thay vì đổi shape của engine.
 *
 * Kế thừa trực tiếp `AdsPowerProfileInfo` để (a) không nhân bản index signature
 * và (b) đảm bảo gán được cả hai chiều với `selectProfileCredentials`.
 * Provider không mang credential (taothao) chỉ đơn giản bỏ trống
 * `username`/`password`/`fakey`.
 */
export interface ProviderProfile extends AdsPowerProfileInfo {
  /** taothao only: thư mục user-data — khoá kill thật của backend. */
  folder?: string;
  /** Backend báo profile đang mở hay không (nếu biết). */
  isRunning?: boolean;
}

export interface ResolveProfilesResult {
  resolved: Array<{ identifier: string; profile: ProviderProfile }>;
  notFound: string[];
}

export interface BrowserProfileProvider {
  readonly id: BrowserProviderId;
  /** Tên hiển thị cho log / UI / thông báo lỗi. */
  readonly label: string;
  /**
   * `true` khi chính bản ghi profile của backend mang credential đăng nhập
   * (AdsPower). `false` khi credential phải đến từ input của người dùng
   * (taothaoAIClaw) — engine dùng cờ này để chọn thông báo lỗi đúng.
   */
  readonly providesCredentials: boolean;

  /**
   * Chính sách đóng browser khi SUCCESS khi request không chỉ định:
   *   `null`  -> theo `config.automation.closeSuccessBrowsers` (AdsPower, giữ nguyên hành vi cũ)
   *   `true`  -> luôn đóng (taothao: browser do ta mở nên ta dọn)
   * Thất bại / NEEDS_HUMAN_REVIEW LUÔN giữ browser mở, không phụ thuộc cờ này.
   */
  readonly autoCloseSuccessDefault: boolean | null;

  /** Map identifier (id / serial / tên) sang profile, GIỮ NGUYÊN thứ tự input. */
  resolveProfiles(identifiers: string[]): Promise<ResolveProfilesResult>;

  /** Mở (hoặc tái dùng) browser của profile và trả về websocket endpoint CDP. */
  startBrowser(profileId: string): Promise<{ wsEndpoint: string }>;

  /** Đóng browser của profile. `false` = không đóng được (engine ghi CLOSE_FAILED). */
  stopBrowser(profileId: string): Promise<boolean>;
}
