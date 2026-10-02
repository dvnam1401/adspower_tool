/**
 * YouTube Data API v3 — đọc toàn bộ video đã đăng của một kênh.
 *
 * Chỉ dùng API Key (dữ liệu công khai của kênh), KHÔNG OAuth.
 * Hạ tầng chống lỗi/nhịp gọi TÁI DÙNG `account-hub/google-sheets/gateway.ts`
 * (`RateLimiter` + `withBackoff`) — không dựng cơ chế retry thứ hai.
 *
 * Giới hạn của API (KHÔNG phải lỗi công cụ): playlist "uploads" chỉ chứa video
 * public + unlisted; video private không xuất hiện.
 */

import { google, youtube_v3 } from 'googleapis';
import { RateLimiter, withBackoff } from '../account-hub/google-sheets/gateway.js';
import { logger } from '../utils/logger.js';

/** API trả tối đa 50 item / trang cho cả playlistItems và videos. */
const PAGE_SIZE = 50;
/** Chặn vòng lặp phân trang vô hạn: 400 trang × 50 = 20.000 video / kênh. */
const MAX_PAGES = 400;

export interface YoutubeVideoRecord {
  videoId: string;
  title: string;
  /** Link đầy đủ, click được. */
  url: string;
  /** ISO 8601 do API trả về; định dạng lại ở tầng xuất báo cáo. */
  publishedAt: string;
  /** `null` khi kênh ẩn số liệu xem — KHÔNG quy về 0 để tránh báo cáo sai. */
  viewCount: number | null;
}

export interface YoutubeChannelVideos {
  channelId: string;
  channelTitle: string;
  /** Link kênh chuẩn, click được — dùng cho báo cáo và để tra lại bằng API. */
  channelUrl: string;
  /** `@handle` do API trả (`snippet.customUrl`); `null` khi kênh chưa đặt handle. */
  channelHandle: string | null;
  uploadsPlaylistId: string;
  videos: YoutubeVideoRecord[];
  /** Có trong playlist uploads nhưng videos.list không trả về (đã xoá / chuyển private). */
  unavailableCount: number;
  /**
   * `true` khi kênh TỒN TẠI nhưng chưa từng đăng video công khai/unlisted:
   * playlist uploads chưa được tạo nên `playlistItems.list` trả 404 `playlistNotFound`.
   * Đây là TÌNH TRẠNG DỮ LIỆU, không phải lỗi kỹ thuật — caller báo "chưa có video",
   * KHÔNG báo thất bại. Video ở chế độ private vốn không đọc được bằng API Key.
   */
  uploadsMissing: boolean;
}

export class YoutubeChannelNotFoundError extends Error {}
export class YoutubeQuotaExceededError extends Error {}
/** Playlist uploads không tồn tại -> kênh chưa có video công khai (không phải lỗi hạ tầng). */
export class YoutubeUploadsMissingError extends Error {}

/**
 * Bề mặt tối thiểu của client googleapis mà module này dùng.
 * Là seam để unit-test không cần mạng; `youtube_v3.Youtube` thoả interface này.
 */
export interface YoutubeApiTransport {
  channels: {
    list(params: YoutubeListParams): Promise<{ data: youtube_v3.Schema$ChannelListResponse }>;
  };
  playlistItems: {
    list(params: YoutubeListParams): Promise<{ data: youtube_v3.Schema$PlaylistItemListResponse }>;
  };
  videos: {
    list(params: YoutubeListParams): Promise<{ data: youtube_v3.Schema$VideoListResponse }>;
  };
}

export interface YoutubeListParams {
  part: string[];
  id?: string[];
  /** Tra kênh theo `@handle` khi không có Channel ID. */
  forHandle?: string;
  playlistId?: string;
  maxResults?: number;
  pageToken?: string;
}

/** `statistics.viewCount` là chuỗi; kênh ẩn số liệu thì thiếu hẳn trường này. */
export function parseViewCount(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Cách duy nhất API tra một kênh: theo id hoặc theo handle. */
export interface ChannelRef {
  kind: 'id' | 'handle';
  value: string;
}

const CHANNEL_ID_RE = /^UC[\w-]{22}$/;

/** Link kênh chuẩn từ Channel ID — dạng luôn mở được, không phụ thuộc handle. */
export function channelUrlFor(channelId: string): string {
  return `https://www.youtube.com/channel/${channelId}`;
}

/** `@handle` sạch (bỏ path/query dính kèm). Rỗng -> `null` để người gọi báo lỗi rõ. */
function handleRef(raw: string): ChannelRef | null {
  const clean = raw.replace(/^@+/, '').split(/[/?#]/)[0].trim();
  return clean ? { kind: 'handle', value: `@${clean}` } : null;
}

/**
 * Chuẩn hoá mọi cách chỉ tới một kênh về `ChannelRef`: `UCxxxx…`, `@handle`,
 * `youtube.com/channel/UC…`, `youtube.com/@handle` (kể cả URL đã encode `%40`,
 * có `?query`/`#hash`, thiếu scheme, hay kèm `/videos`).
 * Nhờ vậy chỉ cần "URL kênh" là gọi được API — không phải tự bóc id.
 * KHÔNG nhận diện được -> `null`: người gọi báo lỗi, KHÔNG đoán.
 */
export function parseChannelRef(raw: string): ChannelRef | null {
  let text = (raw ?? '').trim();
  if (!text) return null;
  try {
    text = decodeURIComponent(text).trim();
  } catch {
    // URL encode sai -> dùng nguyên văn.
  }

  if (CHANNEL_ID_RE.test(text)) return { kind: 'id', value: text };
  if (text.startsWith('@')) return handleRef(text);

  const fromChannelPath = /youtube\.com\/channel\/(UC[\w-]{22})/.exec(text);
  if (fromChannelPath) return { kind: 'id', value: fromChannelPath[1] };

  const fromHandlePath = /youtube\.com\/(@[^/?#\s]+)/.exec(text);
  if (fromHandlePath) return handleRef(fromHandlePath[1]);

  return null;
}

/**
 * Đọc một đường dẫn khoá trên giá trị chưa kiểm chứng (lỗi từ mạng/thư viện).
 * Cast về `Record` chỉ để index object có shape chưa biết — không dùng `any`.
 */
function readPath(root: unknown, path: readonly (string | number)[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

/** Rút `reason` của Google API error để thông báo cho người dùng biết phải làm gì. */
export function readApiErrorReason(err: unknown): string {
  const candidates = [
    readPath(err, ['errors', 0, 'reason']),
    readPath(err, ['response', 'data', 'error', 'errors', 0, 'reason']),
    readPath(err, ['response', 'data', 'error', 'status']),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return '';
}

const QUOTA_REASONS: Record<string, true> = {
  quotaExceeded: true,
  dailyLimitExceeded: true,
  RESOURCE_EXHAUSTED: true,
};

export interface YoutubeDataApiOptions {
  apiKey?: string;
  /** Thay transport khi test. */
  client?: YoutubeApiTransport;
  /** Dùng chung 1 limiter cho cả tiến trình (quota tính theo project, không theo profile). */
  limiter?: RateLimiter;
}

/**
 * Quota YouTube tính theo NGÀY cho cả project -> mọi profile chạy song song phải
 * dùng CHUNG một nhịp gọi. 8 request/giây là mức an toàn dưới hạn mức 100 giây.
 */
const sharedLimiter = new RateLimiter({ ratePerSec: 8, burst: 8 });
const LIMITER_KEY = 'youtube-data-api';

export class YoutubeDataApiClient {
  private readonly api: YoutubeApiTransport;
  private readonly limiter: RateLimiter;

  constructor(opts: YoutubeDataApiOptions) {
    if (!opts.client && !opts.apiKey) {
      throw new Error('Thiếu YouTube Data API Key — hãy nhập trong Cài đặt hệ thống.');
    }
    this.api = opts.client ?? google.youtube({ version: 'v3', auth: opts.apiKey });
    this.limiter = opts.limiter ?? sharedLimiter;
  }

  /**
   * Toàn bộ video đã đăng của một kênh, kèm lượt xem. `channelRef` nhận Channel ID,
   * `@handle` hoặc link kênh -> tầng trên chỉ cần "URL kênh" là chạy được.
   */
  public async fetchChannelVideos(channelRef: string): Promise<YoutubeChannelVideos> {
    const ref = parseChannelRef(channelRef);
    if (!ref) {
      throw new YoutubeChannelNotFoundError(
        `Không nhận diện được kênh từ "${channelRef}" — cần Channel ID (UC…), @handle, ` +
          'hoặc link kênh (youtube.com/channel/UC… | youtube.com/@handle).'
      );
    }

    const channel = await this.call('channels.list', () =>
      this.api.channels.list({
        part: ['snippet', 'contentDetails'],
        ...(ref.kind === 'id' ? { id: [ref.value] } : { forHandle: ref.value }),
        maxResults: 1,
      })
    );

    const item = channel.data.items?.[0];
    if (!item) {
      throw new YoutubeChannelNotFoundError(
        `YouTube API không tìm thấy kênh "${ref.value}" (kênh bị xoá/khoá, hoặc link/handle sai).`
      );
    }

    // Tra theo handle thì phản hồi API là nguồn DUY NHẤT có Channel ID chuẩn.
    const channelId = item.id ?? (ref.kind === 'id' ? ref.value : '');
    if (!channelId) {
      throw new YoutubeChannelNotFoundError(
        `YouTube API trả về kênh "${ref.value}" nhưng thiếu Channel ID — không thể đối chiếu.`
      );
    }

    const uploadsPlaylistId = item.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) {
      throw new YoutubeChannelNotFoundError(
        `Kênh "${channelId}" không có playlist "uploads" — không thể liệt kê video.`
      );
    }

    const base = {
      channelId,
      channelTitle: item.snippet?.title ?? '',
      channelUrl: channelUrlFor(channelId),
      channelHandle: item.snippet?.customUrl ?? null,
      uploadsPlaylistId,
    };

    let videoIds: string[];
    try {
      videoIds = await this.listUploadedVideoIds(uploadsPlaylistId);
    } catch (err) {
      if (err instanceof YoutubeUploadsMissingError) {
        return { ...base, videos: [], unavailableCount: 0, uploadsMissing: true };
      }
      throw err;
    }
    const videos = await this.fetchVideoDetails(videoIds);

    return {
      ...base,
      videos,
      unavailableCount: videoIds.length - videos.length,
      uploadsMissing: false,
    };
  }

  /** Duyệt HẾT các trang của playlist uploads — không bỏ sót video nào. */
  private async listUploadedVideoIds(playlistId: string): Promise<string[]> {
    const ids: string[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;
    let pages = 0;

    do {
      const res = await this.call('playlistItems.list', () =>
        this.api.playlistItems.list({
          part: ['contentDetails'],
          playlistId,
          maxResults: PAGE_SIZE,
          pageToken,
        })
      );
      for (const entry of res.data.items ?? []) {
        const videoId = entry.contentDetails?.videoId;
        if (videoId && !seen.has(videoId)) {
          seen.add(videoId);
          ids.push(videoId);
        }
      }
      pageToken = res.data.nextPageToken ?? undefined;
      pages++;
      if (pages >= MAX_PAGES && pageToken) {
        logger.warn(
          `[YouTube API] Playlist ${playlistId} vượt ${MAX_PAGES * PAGE_SIZE} video — dừng phân trang để tránh vòng lặp vô hạn.`
        );
        break;
      }
    } while (pageToken);

    return ids;
  }

  /** Gộp 50 videoId mỗi lần gọi để tiết kiệm quota. */
  private async fetchVideoDetails(videoIds: readonly string[]): Promise<YoutubeVideoRecord[]> {
    const records: YoutubeVideoRecord[] = [];

    for (let offset = 0; offset < videoIds.length; offset += PAGE_SIZE) {
      const chunk = videoIds.slice(offset, offset + PAGE_SIZE);
      const res = await this.call('videos.list', () =>
        this.api.videos.list({
          part: ['snippet', 'statistics'],
          id: chunk as string[],
          maxResults: PAGE_SIZE,
        })
      );
      for (const video of res.data.items ?? []) {
        if (!video.id) continue;
        records.push({
          videoId: video.id,
          title: video.snippet?.title ?? '',
          url: `https://www.youtube.com/watch?v=${video.id}`,
          publishedAt: video.snippet?.publishedAt ?? '',
          viewCount: parseViewCount(video.statistics?.viewCount),
        });
      }
    }

    return records;
  }

  /** Nhịp gọi + retry dùng chung; lỗi hết quota được nâng cấp thành lỗi có nghĩa. */
  private async call<T>(label: string, fn: () => Promise<T>): Promise<T> {
    await this.limiter.acquire(LIMITER_KEY);
    try {
      return await withBackoff(fn, { retries: 4, baseMs: 800 });
    } catch (err) {
      const reason = readApiErrorReason(err);
      if (QUOTA_REASONS[reason]) {
        throw new YoutubeQuotaExceededError(
          'YouTube Data API đã hết quota trong ngày (10.000 units/ngày). Hãy chạy lại vào ngày hôm sau hoặc dùng API Key của project khác.'
        );
      }
      if (reason === 'playlistNotFound') {
        throw new YoutubeUploadsMissingError(
          'Kênh chưa có video công khai (playlist uploads chưa tồn tại). Video ở chế độ private không đọc được bằng API Key.'
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`YouTube API ${label} lỗi${reason ? ` (${reason})` : ''}: ${message}`);
    }
  }
}

/**
 * Client dùng chung theo API Key: nhiều profile chạy song song phải chia sẻ
 * cùng một limiter, nếu tạo client mới mỗi task thì nhịp gọi mất tác dụng.
 */
const clientCache = new Map<string, YoutubeDataApiClient>();

export function getYoutubeDataApiClient(apiKey: string): YoutubeDataApiClient {
  const key = apiKey.trim();
  if (!key) throw new Error('Thiếu YouTube Data API Key — hãy nhập trong Cài đặt hệ thống.');
  let client = clientCache.get(key);
  if (!client) {
    client = new YoutubeDataApiClient({ apiKey: key });
    clientCache.set(key, client);
  }
  return client;
}
