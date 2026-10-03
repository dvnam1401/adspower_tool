/**
 * Xuất báo cáo Excel (.xlsx) tổng hợp video YouTube theo profile.
 *
 * Cấu trúc file:
 *  - Sheet "Video": Tên Profile | Link Video | Tên Video | Thời Gian Đăng | Lượt View
 *  - Sheet "Tổng Hợp": mỗi profile 1 dòng (kênh, số video, tổng view, trạng thái, ghi chú)
 */

import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { config } from '../config/index.js';
import type { YoutubeVideoRecord } from './data-api.js';

/** Một profile trong báo cáo. `status` là NHÃN tiếng Việt suy ra từ `TaskStatus`, không phải enum mới. */
export interface YoutubeReportProfile {
  profileName: string;
  profileId: string;
  provider: string;
  channelId?: string;
  /** Link kênh click được; thiếu thì cột "Link Kênh" để trống. */
  channelUrl?: string;
  /** `@handle` — dùng làm chữ hiển thị cho link kênh khi có. */
  channelHandle?: string | null;
  channelTitle?: string;
  status: string;
  note?: string;
  videos: readonly YoutubeVideoRecord[];
  unavailableCount: number;
}

export interface YoutubeVideoRow {
  profileName: string;
  url: string;
  title: string;
  publishedAt: string;
  viewCount: number | null;
}

export interface YoutubeReportResult {
  fileName: string;
  filePath: string;
  generatedAt: string;
  profileCount: number;
  videoCount: number;
}

const viCollator = new Intl.Collator('vi', { sensitivity: 'base', numeric: true });

/**
 * Gộp mọi profile thành một bảng: sắp theo tên profile, trong mỗi profile thì
 * video mới đăng nhất lên trước. Thuần (pure) -> unit-test được, không cần ghi file.
 */
export function buildVideoRows(profiles: readonly YoutubeReportProfile[]): YoutubeVideoRow[] {
  const rows: YoutubeVideoRow[] = [];
  for (const profile of profiles) {
    for (const video of profile.videos) {
      rows.push({
        profileName: profile.profileName,
        url: video.url,
        title: video.title,
        publishedAt: video.publishedAt,
        viewCount: video.viewCount,
      });
    }
  }

  rows.sort((a, b) => {
    const byProfile = viCollator.compare(a.profileName, b.profileName);
    if (byProfile !== 0) return byProfile;
    // Chuỗi ISO 8601 so sánh trực tiếp = so sánh thời gian; rỗng đẩy xuống cuối.
    if (a.publishedAt === b.publishedAt) return 0;
    if (!a.publishedAt) return 1;
    if (!b.publishedAt) return -1;
    return a.publishedAt < b.publishedAt ? 1 : -1;
  });

  return rows;
}

/** `youtube-videos-YYYYMMDD-HHmmss.xlsx` theo giờ máy — mỗi lần chạy một file riêng. */
export function buildReportFileName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `youtube-videos-${stamp}.xlsx`;
}

/**
 * ExcelJS ghi Date theo các trường UTC. API trả `publishedAt` là UTC, nên nếu ghi
 * thẳng thì Excel hiện giờ UTC (lệch 7 tiếng so với người dùng). Dịch đúng offset
 * máy để các trường UTC của Date bằng GIỜ ĐỊA PHƯƠNG -> Excel hiện đúng giờ VN.
 */
export function toExcelLocalDate(iso: string): Date | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  const time = parsed.getTime();
  if (!Number.isFinite(time)) return null;
  return new Date(time - parsed.getTimezoneOffset() * 60000);
}

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF1F2937' },
};

function styleHeader(sheet: ExcelJS.Worksheet): void {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = HEADER_FILL;
  header.alignment = { vertical: 'middle' };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

/** Ghi file .xlsx và trả về vị trí đã ghi. Thư mục đích được tạo nếu chưa có. */
export async function writeYoutubeReport(
  profiles: readonly YoutubeReportProfile[],
  opts: { dir?: string; now?: Date } = {}
): Promise<YoutubeReportResult> {
  const now = opts.now ?? new Date();
  const dir = opts.dir ?? path.resolve(path.dirname(config.storage.databasePath), 'reports');
  fs.mkdirSync(dir, { recursive: true });

  const fileName = buildReportFileName(now);
  const filePath = path.join(dir, fileName);
  const rows = buildVideoRows(profiles);

  const workbook = new ExcelJS.Workbook();
  workbook.created = now;

  const videoSheet = workbook.addWorksheet('Video');
  videoSheet.columns = [
    { header: 'Tên Profile', key: 'profileName', width: 28 },
    { header: 'Link Video', key: 'url', width: 46 },
    { header: 'Tên Video', key: 'title', width: 60 },
    { header: 'Thời Gian Đăng', key: 'publishedAt', width: 20 },
    { header: 'Lượt View', key: 'viewCount', width: 14 },
  ];

  for (const row of rows) {
    const added = videoSheet.addRow({
      profileName: row.profileName,
      title: row.title,
      viewCount: row.viewCount,
    });
    // Link click được ngay trong Excel.
    added.getCell('url').value = { text: row.url, hyperlink: row.url };
    added.getCell('url').font = { color: { argb: 'FF2563EB' }, underline: true };

    const published = toExcelLocalDate(row.publishedAt);
    const publishedCell = added.getCell('publishedAt');
    if (published) {
      publishedCell.value = published;
      publishedCell.numFmt = 'dd/mm/yyyy hh:mm';
    } else {
      publishedCell.value = row.publishedAt;
    }
    added.getCell('viewCount').numFmt = '#,##0';
  }
  styleHeader(videoSheet);

  const summarySheet = workbook.addWorksheet('Tổng Hợp');
  summarySheet.columns = [
    { header: 'Tên Profile', key: 'profileName', width: 28 },
    { header: 'Nguồn Profile', key: 'provider', width: 16 },
    { header: 'Channel ID', key: 'channelId', width: 28 },
    { header: 'Link Kênh', key: 'channelUrl', width: 42 },
    { header: 'Tên Kênh', key: 'channelTitle', width: 32 },
    { header: 'Số Video', key: 'videoCount', width: 12 },
    { header: 'Tổng View', key: 'totalViews', width: 16 },
    { header: 'Trạng Thái', key: 'status', width: 22 },
    { header: 'Ghi Chú', key: 'note', width: 60 },
  ];

  let totalVideos = 0;
  let grandTotalViews = 0;
  for (const profile of profiles) {
    const totalViews = profile.videos.reduce((sum, video) => sum + (video.viewCount ?? 0), 0);
    totalVideos += profile.videos.length;
    grandTotalViews += totalViews;
    const notes: string[] = [];
    if (profile.note) notes.push(profile.note);
    if (profile.unavailableCount > 0) {
      notes.push(`${profile.unavailableCount} video không lấy được chi tiết (đã xoá/private).`);
    }
    const added = summarySheet.addRow({
      profileName: profile.profileName,
      provider: profile.provider,
      channelId: profile.channelId ?? '',
      channelTitle: profile.channelTitle ?? '',
      videoCount: profile.videos.length,
      totalViews,
      status: profile.status,
      note: notes.join(' '),
    });
    // Link kênh: chữ hiển thị là `@handle` cho dễ đọc, còn địa chỉ mở là link `/channel/UC…`.
    if (profile.channelUrl) {
      const channelCell = added.getCell('channelUrl');
      channelCell.value = { text: profile.channelHandle || profile.channelUrl, hyperlink: profile.channelUrl };
      channelCell.font = { color: { argb: 'FF2563EB' }, underline: true };
    }
    added.getCell('videoCount').numFmt = '#,##0';
    added.getCell('totalViews').numFmt = '#,##0';
  }

  const totalRow = summarySheet.addRow({
    profileName: 'TỔNG CỘNG',
    videoCount: totalVideos,
    totalViews: grandTotalViews,
  });
  totalRow.font = { bold: true };
  totalRow.getCell('videoCount').numFmt = '#,##0';
  totalRow.getCell('totalViews').numFmt = '#,##0';
  styleHeader(summarySheet);

  await workbook.xlsx.writeFile(filePath);

  return {
    fileName,
    filePath,
    generatedAt: now.toISOString(),
    profileCount: profiles.length,
    videoCount: rows.length,
  };
}
