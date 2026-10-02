/**
 * Kho Channel ID BỀN (đĩa) cho từng profile.
 *
 * Vì sao cần: đọc Channel ID là bước DUY NHẤT phải mở trình duyệt trong workflow
 * "YouTube: Tổng Hợp Video Theo Profile". Channel của một profile hầu như không đổi,
 * nên đọc một lần rồi lưu lại: những lần dán lại danh sách profile sau đó chỉ còn gọi
 * Data API v3 — không mở profile, không tốn thời gian, không rủi ro tab/đăng nhập.
 *
 * Khác `youtubeRunStore` (RAM, dữ liệu video của MỘT lượt chạy, xoá đầu mỗi batch):
 * file này chỉ giữ ánh xạ profile -> kênh và sống qua nhiều lần chạy / khởi động lại.
 *
 * KHÓA gồm cả provider: id profile của AdsPower và taothaoAIClaw là hai không gian
 * định danh khác nhau, không được phục vụ chéo (RULES §29, §30).
 * KHÔNG chứa email, credential hay đường dẫn máy — an toàn để hiện lên UI.
 */

import fs from 'fs';
import path from 'path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { isBrowserProviderId, type BrowserProviderId } from '../providers/types.js';
import {
  isYoutubeChannelSource,
  type YoutubeChannelSource,
} from '../automation/youtube-channel.js';

export interface CachedYoutubeChannel {
  provider: BrowserProviderId;
  profileId: string;
  profileName: string;
  channelId: string;
  /** Link kênh chuẩn `/channel/UC…` — dùng lại làm tham chiếu gọi API. */
  channelUrl: string;
  channelTitle?: string;
  channelHandle?: string | null;
  /** Tầng đã đọc ra Channel ID ở lần chạy thật (không phải `cache`). */
  channelSource?: YoutubeChannelSource;
  /** Số video công khai đọc được ở lần chạy gần nhất — chỉ để hiển thị. */
  videoCount?: number;
  firstSeenAt: string;
  updatedAt: string;
}

/**
 * Bản ghi đọc từ đĩa là dữ liệu NGOÀI tầm kiểm soát (người dùng có thể sửa tay file JSON).
 * Chỉ nhận bản ghi đủ khoá hợp lệ; các trường phụ sai kiểu bị bỏ chứ không làm hỏng cả kho.
 */
function toCachedChannel(raw: unknown): CachedYoutubeChannel | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const provider = item.provider;
  const profileId = item.profileId;
  const channelId = item.channelId;
  if (!isBrowserProviderId(provider)) return null;
  if (typeof profileId !== 'string' || !profileId) return null;
  if (typeof channelId !== 'string' || !channelId) return null;

  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value ? value : undefined;
  const now = new Date().toISOString();

  return {
    provider,
    profileId,
    profileName: text(item.profileName) ?? profileId,
    channelId,
    channelUrl: text(item.channelUrl) ?? `https://www.youtube.com/channel/${channelId}`,
    channelTitle: text(item.channelTitle),
    channelHandle: text(item.channelHandle) ?? null,
    channelSource: isYoutubeChannelSource(item.channelSource) ? item.channelSource : undefined,
    videoCount: typeof item.videoCount === 'number' && item.videoCount >= 0 ? item.videoCount : undefined,
    firstSeenAt: text(item.firstSeenAt) ?? now,
    updatedAt: text(item.updatedAt) ?? now,
  };
}

export class YoutubeChannelCache {
  private filePath: string;
  private entries = new Map<string, CachedYoutubeChannel>();

  constructor(filePath?: string) {
    this.filePath =
      filePath || path.resolve(path.dirname(config.storage.databasePath), 'youtube-channels.json');
    this.load();
  }

  private load(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.filePath)) return;

    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('nội dung không phải danh sách');
      let skipped = 0;
      for (const raw of parsed) {
        const entry = toCachedChannel(raw);
        // Bản ghi thiếu khoá hoặc thiếu id kênh là rác -> bỏ, không để làm sai lượt chạy sau.
        if (!entry) {
          skipped += 1;
          continue;
        }
        this.entries.set(`${entry.provider}:${entry.profileId}`, entry);
      }
      logger.info(
        `[YouTubeCache] Đã tải ${this.entries.size} Channel ID đã lưu` +
          (skipped > 0 ? ` (bỏ qua ${skipped} bản ghi không hợp lệ).` : '.')
      );
    } catch (err) {
      logger.error(
        `[YouTubeCache] Không đọc được ${path.basename(this.filePath)}: ` +
          (err instanceof Error ? err.message : String(err))
      );
    }
  }

  private save(): void {
    try {
      const list = Array.from(this.entries.values());
      fs.writeFileSync(this.filePath, JSON.stringify(list, null, 2), 'utf8');
    } catch (err) {
      logger.error(
        `[YouTubeCache] Lưu kho Channel ID thất bại: ` +
          (err instanceof Error ? err.message : String(err))
      );
    }
  }

  public get(provider: BrowserProviderId, profileId: string): CachedYoutubeChannel | undefined {
    return this.entries.get(`${provider}:${profileId}`);
  }

  /** Ghi nhận kênh đọc được từ trình duyệt. Giữ `firstSeenAt` và các dữ kiện API đã có. */
  public remember(input: {
    provider: BrowserProviderId;
    profileId: string;
    profileName: string;
    channelId: string;
    channelUrl: string;
    channelSource?: YoutubeChannelSource;
  }): CachedYoutubeChannel {
    const key = `${input.provider}:${input.profileId}`;
    const now = new Date().toISOString();
    const previous = this.entries.get(key);
    // Đổi kênh (đăng nhập tài khoản khác) -> dữ kiện API của kênh cũ không còn đúng.
    const sameChannel = previous?.channelId === input.channelId;

    const entry: CachedYoutubeChannel = {
      provider: input.provider,
      profileId: input.profileId,
      profileName: input.profileName || previous?.profileName || input.profileId,
      channelId: input.channelId,
      channelUrl: input.channelUrl,
      channelTitle: sameChannel ? previous?.channelTitle : undefined,
      channelHandle: sameChannel ? previous?.channelHandle : undefined,
      channelSource: input.channelSource ?? previous?.channelSource,
      videoCount: sameChannel ? previous?.videoCount : undefined,
      firstSeenAt: sameChannel ? previous!.firstSeenAt : now,
      updatedAt: now,
    };
    this.entries.set(key, entry);
    this.save();
    return entry;
  }

  /**
   * Bổ sung dữ kiện lấy từ Data API (tên kênh, handle, số video) cho bản ghi đã có.
   * Không tạo bản ghi mới: chỉ bước đọc từ trình duyệt mới được quyền tạo ánh xạ.
   */
  public enrich(
    provider: BrowserProviderId,
    profileId: string,
    facts: { channelTitle?: string; channelHandle?: string | null; videoCount?: number }
  ): void {
    const key = `${provider}:${profileId}`;
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.channelTitle = facts.channelTitle ?? entry.channelTitle;
    entry.channelHandle = facts.channelHandle ?? entry.channelHandle;
    entry.videoCount = facts.videoCount ?? entry.videoCount;
    entry.updatedAt = new Date().toISOString();
    this.save();
  }

  /** Mới nhất lên đầu — người dùng thường xoá thứ vừa chạy sai. */
  public list(): CachedYoutubeChannel[] {
    return Array.from(this.entries.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  public forget(provider: BrowserProviderId, profileId: string): boolean {
    const removed = this.entries.delete(`${provider}:${profileId}`);
    if (removed) this.save();
    return removed;
  }

  public clear(): number {
    const removed = this.entries.size;
    this.entries.clear();
    this.save();
    return removed;
  }

  public size(): number {
    return this.entries.size;
  }
}

/** Singleton — cùng vòng đời với `workflowEngine`. */
export const youtubeChannelCache = new YoutubeChannelCache();
