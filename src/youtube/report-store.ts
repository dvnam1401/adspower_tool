/**
 * Bộ nhớ tạm (RAM) cho một lượt chạy workflow YouTube.
 *
 * Vì sao cần: dữ liệu video được thu theo TỪNG profile chạy song song, nhưng file
 * Excel là MỘT file duy nhất cho cả batch -> phải gom lại rồi mới xuất ở cuối batch.
 * KHÔNG ghi xuống checkpoint (`data/workflow-checkpoints.json`) vì payload video lớn
 * và checkpoint chỉ dùng cho trạng thái điều khiển.
 */

import type { YoutubeChannelVideos, YoutubeVideoRecord } from './data-api.js';

export interface YoutubeProfileEntry {
  profileId: string;
  profileName: string;
  channelId?: string;
  channelTitle?: string;
  /** Link kênh chuẩn (`/channel/UC…`) — dùng lại làm tham chiếu gọi API và để mở kênh. */
  channelUrl?: string;
  /** `@handle` do API trả về; `null`/thiếu khi kênh chưa đặt handle. */
  channelHandle?: string | null;
  /** Tầng đã đọc được Channel ID (studio_url / account_advanced / account_page). */
  channelSource?: string;
  videos: YoutubeVideoRecord[];
  /** Video có trong playlist uploads nhưng API không trả chi tiết (đã xoá/private). */
  unavailableCount: number;
  /** Kênh tồn tại nhưng chưa có video công khai — task vẫn THÀNH CÔNG với 0 video. */
  uploadsMissing?: boolean;
  /** Ghi chú giải thích cho báo cáo khi task không thất bại (vd. kênh chưa có video). */
  note?: string;
}

/** Một dòng tóm tắt cho UI — KHÔNG chứa email, credential hay đường dẫn máy. */
export interface YoutubeReportSummaryRow {
  profileName: string;
  channelId?: string;
  channelUrl?: string;
  channelTitle?: string;
  videoCount: number;
  totalViews: number;
  status: string;
  note?: string;
}

export interface YoutubeLastReport {
  fileName: string;
  /** Đường dẫn tuyệt đối — CHỈ dùng nội bộ để trả file; KHÔNG gửi ra UI/SSE. */
  filePath: string;
  generatedAt: string;
  profileCount: number;
  videoCount: number;
  summary: YoutubeReportSummaryRow[];
}

class YoutubeRunStore {
  private entries = new Map<string, YoutubeProfileEntry>();
  private lastReport: YoutubeLastReport | null = null;

  /** Gọi ở đầu mỗi batch. KHÔNG xoá `lastReport` để link tải file cũ còn dùng được. */
  public reset(): void {
    this.entries.clear();
  }

  private ensure(profileId: string, profileName: string): YoutubeProfileEntry {
    let entry = this.entries.get(profileId);
    if (!entry) {
      entry = { profileId, profileName, videos: [], unavailableCount: 0 };
      this.entries.set(profileId, entry);
    }
    entry.profileName = profileName || entry.profileName;
    return entry;
  }

  public setChannel(
    profileId: string,
    data: { profileName: string; channelId: string; channelUrl?: string; channelSource?: string }
  ): void {
    const entry = this.ensure(profileId, data.profileName);
    entry.channelId = data.channelId;
    entry.channelUrl = data.channelUrl;
    entry.channelSource = data.channelSource;
  }

  public setVideos(profileId: string, profileName: string, data: YoutubeChannelVideos): void {
    const entry = this.ensure(profileId, profileName);
    entry.channelId = data.channelId;
    entry.channelTitle = data.channelTitle;
    entry.channelUrl = data.channelUrl;
    entry.channelHandle = data.channelHandle;
    entry.videos = data.videos;
    entry.unavailableCount = data.unavailableCount;
    entry.uploadsMissing = data.uploadsMissing;
    entry.note = data.uploadsMissing
      ? 'Kênh chưa có video công khai (playlist uploads chưa tồn tại). Video private không đọc được bằng API Key.'
      : undefined;
  }

  public get(profileId: string): YoutubeProfileEntry | undefined {
    return this.entries.get(profileId);
  }

  public size(): number {
    return this.entries.size;
  }

  public setLastReport(report: YoutubeLastReport): void {
    this.lastReport = report;
  }

  public getLastReport(): YoutubeLastReport | null {
    return this.lastReport;
  }
}

/** Singleton — cùng vòng đời với `workflowEngine`. */
export const youtubeRunStore = new YoutubeRunStore();
