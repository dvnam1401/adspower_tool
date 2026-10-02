/**
 * taothaoAIClaw (GoAnidetectAI) Local API client — CHỈ ĐỌC + launch/close.
 *
 * Base URL mặc định: http://127.0.0.1:19995
 * API chỉ tồn tại khi ứng dụng Electron "TaoThao Claw" đang chạy; không có auth token.
 *
 * Đã verify trên máy thật (v2.0.0):
 *   GET  /health                          -> { status:'ok', message, port }      (LƯU Ý: KHÔNG có prefix /api)
 *   GET  /api/info                        -> { name, version, endpoints[] }
 *   GET  /api/profiles?page&limit&...     -> { success, profiles[], pagination:{total,page,limit,totalPages} }
 *   GET  /api/profiles/running            -> { success, data:[{folder,pid,port}] }
 *   GET  /api/profiles/:id                -> { success, data:{...} }
 *   GET  /api/profiles/:id/status         -> { success, data:{profileId,isRunning,folder} }
 *   POST /api/profiles/:id/launch         -> { success, data:{profileId,pid,port,debugUrl,ws,wsEndpoint,webSocketDebuggerUrl} }
 *   POST /api/profiles/:id/close          -> { success, message }
 *
 * Ràng buộc quan trọng:
 *   - `GET /api/profiles` PHÂN TRANG, `limit` mặc định 20 -> phải fetchAll khi cần toàn bộ.
 *   - `launch` là IDEMPOTENT: profile đang chạy -> trả về pid/port của Chrome hiện có
 *     (KHÔNG mở cửa sổ thứ hai).
 *   - Field websocket có thể null (server chỉ poll /json/version tối đa 10s) -> client
 *     tự poll bù bằng `resolveWsEndpoint`.
 *
 * SECURITY: response profile của taothao chứa `proxy.password` dạng plaintext.
 * `mapProfile` WHITELIST field an toàn; KHÔNG BAO GIỜ log/trả raw response ra ngoài,
 * và không đưa nội dung body vào message lỗi.
 */

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

/** Profile taothao đã được whitelist — an toàn để log / gửi ra UI. */
export interface TaothaoProfile {
  profileId: string;
  name: string;
  groupId: string | null;
  /** Thư mục user-data; taothao dùng chính field này làm khoá kill. */
  folder: string | null;
  isRunning: boolean;
  stt: number | null;
  /** Chỉ cho biết CÓ cấu hình proxy hay không — không bao giờ kèm credential proxy. */
  hasProxy: boolean;
}

export interface TaothaoProfileListResult {
  list: TaothaoProfile[];
  page: number;
  limit: number;
  total: number;
}

export interface TaothaoLaunchResult {
  profileId: string;
  pid: number | null;
  port: number | null;
  wsEndpoint: string;
}

export interface TaothaoRunningProfile {
  folder: string;
  pid: number | null;
  port: number | null;
}

/** Mã lỗi ổn định để engine/UI phân loại, không gộp mọi thứ thành FAILED. */
export type TaothaoErrorCode =
  | 'TAOTHAO_UNAVAILABLE'
  | 'TAOTHAO_TIMEOUT'
  | 'TAOTHAO_HTTP_ERROR'
  | 'TAOTHAO_INVALID_RESPONSE'
  | 'TAOTHAO_API_ERROR'
  | 'TAOTHAO_PROFILE_NOT_FOUND'
  | 'TAOTHAO_WS_UNAVAILABLE';

export class TaothaoApiError extends Error {
  public readonly code: TaothaoErrorCode;
  public readonly httpStatus?: number;

  constructor(code: TaothaoErrorCode, message: string, httpStatus?: number) {
    super(message);
    this.name = 'TaothaoApiError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/**
 * Map raw profile -> `TaothaoProfile` bằng WHITELIST.
 * Chặn `proxy.password`, `config`, `winPreferences`... rò rỉ sang log/UI/SSE.
 * Trả null nếu thiếu id (bản ghi không dùng được).
 */
export function mapTaothaoProfile(raw: unknown): TaothaoProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;

  const profileId = readString(rec, 'profileId') || readString(rec, 'id');
  if (!profileId) return null;

  const proxy = rec.proxy;
  const proxyMode =
    proxy && typeof proxy === 'object' ? readString(proxy as Record<string, unknown>, 'mode') : null;

  return {
    profileId,
    name: readString(rec, 'name') || profileId,
    groupId: readString(rec, 'groupId'),
    folder: readString(rec, 'folder'),
    isRunning: rec.isRunning === true,
    stt: readNumber(rec, 'stt'),
    hasProxy: !!proxyMode && proxyMode !== 'none',
  };
}

/**
 * Lấy websocket endpoint từ payload launch. taothao trả 3 field khả dĩ
 * (`ws`, `wsEndpoint`, `webSocketDebuggerUrl`) và cả ba đều có thể null.
 */
export function pickWsEndpoint(data: Record<string, unknown>): string | null {
  for (const key of ['ws', 'wsEndpoint', 'webSocketDebuggerUrl']) {
    const value = readString(data, key);
    if (value && value.startsWith('ws')) return value;
  }
  return null;
}

export class TaothaoClient {
  private readonly apiUrlOverride?: string;
  private readonly timeoutOverride?: number;

  constructor(apiUrl?: string, timeoutMs?: number) {
    this.apiUrlOverride = apiUrl ? apiUrl.replace(/\/+$/, '') : undefined;
    this.timeoutOverride = timeoutMs;
  }

  /**
   * Base URL đang dùng. Đọc `config` mỗi lần gọi để `updateSystemConfig()` lúc
   * runtime có hiệu lực ngay (singleton được tạo ở thời điểm load module).
   */
  public get baseUrl(): string {
    return this.apiUrlOverride ?? config.taothao.apiUrl.replace(/\/+$/, '');
  }

  private get timeoutMs(): number {
    return this.timeoutOverride ?? config.taothao.defaultTimeoutMs;
  }

  /**
   * HTTP helper: KHÔNG retry (API local, lỗi thật cần lộ ra ngay để engine phân loại).
   * Mọi lỗi được chuẩn hoá thành `TaothaoApiError` với code ổn định.
   */
  private async request<T>(
    endpoint: string,
    options: { method?: 'GET' | 'POST'; params?: Record<string, string | number | undefined>; body?: unknown } = {}
  ): Promise<T> {
    const { method = 'GET', params, body } = options;
    const url = new URL(`${this.baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.append(key, String(value));
        }
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      logger.debug(`taothao API ${method} ${url.pathname}${url.search}`);
      const res = await fetch(url.toString(), {
        method,
        headers: body ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      // 404 trên /api/profiles/:id = profile không tồn tại -> state riêng, không gộp FAILED.
      if (res.status === 404) {
        throw new TaothaoApiError(
          'TAOTHAO_PROFILE_NOT_FOUND',
          `taothaoAIClaw không tìm thấy endpoint/profile: ${url.pathname}`,
          404
        );
      }
      // 400 là lỗi nghiệp vụ có body JSON -> đọc `error` bên dưới thay vì chặn ở đây.
      if (!res.ok && res.status !== 400) {
        throw new TaothaoApiError(
          'TAOTHAO_HTTP_ERROR',
          `taothaoAIClaw API trả HTTP ${res.status} ${res.statusText} tại ${url.pathname}`,
          res.status
        );
      }

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new TaothaoApiError(
          'TAOTHAO_INVALID_RESPONSE',
          `taothaoAIClaw API trả về dữ liệu không phải JSON tại ${url.pathname}`,
          res.status
        );
      }
      if (!json || typeof json !== 'object') {
        throw new TaothaoApiError(
          'TAOTHAO_INVALID_RESPONSE',
          `taothaoAIClaw API trả về payload không hợp lệ tại ${url.pathname}`,
          res.status
        );
      }
      return json as T;
    } catch (err) {
      if (err instanceof TaothaoApiError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new TaothaoApiError(
          'TAOTHAO_TIMEOUT',
          `taothaoAIClaw API quá thời gian ${this.timeoutMs}ms tại ${url.pathname}`
        );
      }
      throw new TaothaoApiError(
        'TAOTHAO_UNAVAILABLE',
        `Không thể kết nối taothaoAIClaw Local API tại ${this.baseUrl}. ` +
          `Vui lòng kiểm tra: 1. Ứng dụng TaoThao Claw đã mở chưa? 2. Local API có đang bật ở cổng này không?`
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Đọc `error` từ envelope `{success:false,error}` (nếu có) và ném đúng code. */
  private assertSuccess(payload: Record<string, unknown>, context: string): void {
    if (payload.success === true) return;
    const reason = readString(payload, 'error') || readString(payload, 'message') || 'không rõ nguyên nhân';
    throw new TaothaoApiError('TAOTHAO_API_ERROR', `taothaoAIClaw ${context} thất bại: ${reason}`);
  }

  /** Health check — route là `/health` ở ROOT (không phải `/api/health`, cái đó trả 404). */
  public async checkHealth(): Promise<{ ok: boolean; message: string; port?: number; version?: string }> {
    try {
      const health = await this.request<Record<string, unknown>>('/health');
      const ok = health.status === 'ok';
      let version: string | undefined;
      try {
        const info = await this.request<Record<string, unknown>>('/api/info');
        version = readString(info, 'version') || undefined;
      } catch {
        // /api/info không bắt buộc cho health.
      }
      return {
        ok,
        message: readString(health, 'message') || (ok ? 'taothaoAIClaw Local API đang hoạt động.' : 'Trạng thái không xác định.'),
        port: readNumber(health, 'port') ?? undefined,
        version,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message };
    }
  }

  /**
   * Danh sách profile. `fetchAll` lặp qua toàn bộ trang (API mặc định limit=20).
   * Thứ tự do API trả về (mặc định `stt ASC`) được GIỮ NGUYÊN.
   */
  public async listProfiles(
    params: { page?: number; limit?: number; groupId?: string; search?: string; sort?: string; fetchAll?: boolean } = {}
  ): Promise<TaothaoProfileListResult> {
    const limit = Math.min(Math.max(params.limit || 100, 1), 500);
    const firstPage = params.page || 1;

    const fetchPage = async (page: number): Promise<{ list: TaothaoProfile[]; total: number; totalPages: number }> => {
      const payload = await this.request<Record<string, unknown>>('/api/profiles', {
        params: { page, limit, groupId: params.groupId, search: params.search, sort: params.sort },
      });
      this.assertSuccess(payload, 'lấy danh sách profile');

      const rawList = Array.isArray(payload.profiles)
        ? payload.profiles
        : Array.isArray(payload.data)
          ? payload.data
          : null;
      if (!rawList) {
        throw new TaothaoApiError('TAOTHAO_INVALID_RESPONSE', 'taothaoAIClaw trả về danh sách profile không hợp lệ.');
      }

      const pagination =
        payload.pagination && typeof payload.pagination === 'object'
          ? (payload.pagination as Record<string, unknown>)
          : {};

      const mapped: TaothaoProfile[] = [];
      for (const raw of rawList) {
        const profile = mapTaothaoProfile(raw);
        if (profile) mapped.push(profile);
      }
      return {
        list: mapped,
        total: readNumber(pagination, 'total') ?? mapped.length,
        totalPages: readNumber(pagination, 'totalPages') ?? 1,
      };
    };

    const first = await fetchPage(firstPage);
    if (!params.fetchAll || first.totalPages <= 1) {
      return { list: first.list, page: firstPage, limit, total: first.total };
    }

    const all = [...first.list];
    for (let page = firstPage + 1; page <= first.totalPages; page++) {
      const next = await fetchPage(page);
      all.push(...next.list);
      if (next.list.length === 0) break;
    }
    return { list: all, page: firstPage, limit, total: first.total };
  }

  public async getProfile(profileId: string): Promise<TaothaoProfile | null> {
    const payload = await this.request<Record<string, unknown>>(`/api/profiles/${encodeURIComponent(profileId)}`);
    this.assertSuccess(payload, `lấy profile ${profileId}`);
    return mapTaothaoProfile(payload.data);
  }

  public async getStatus(profileId: string): Promise<{ profileId: string; isRunning: boolean; folder: string | null }> {
    const payload = await this.request<Record<string, unknown>>(
      `/api/profiles/${encodeURIComponent(profileId)}/status`
    );
    this.assertSuccess(payload, `lấy trạng thái profile ${profileId}`);
    const data = (payload.data && typeof payload.data === 'object' ? payload.data : {}) as Record<string, unknown>;
    return {
      profileId: readString(data, 'profileId') || profileId,
      isRunning: data.isRunning === true,
      folder: readString(data, 'folder'),
    };
  }

  public async listRunning(): Promise<TaothaoRunningProfile[]> {
    const payload = await this.request<Record<string, unknown>>('/api/profiles/running');
    this.assertSuccess(payload, 'lấy danh sách profile đang chạy');
    if (!Array.isArray(payload.data)) return [];
    const out: TaothaoRunningProfile[] = [];
    for (const raw of payload.data) {
      if (!raw || typeof raw !== 'object') continue;
      const rec = raw as Record<string, unknown>;
      const folder = readString(rec, 'folder');
      if (!folder) continue;
      out.push({ folder, pid: readNumber(rec, 'pid'), port: readNumber(rec, 'port') });
    }
    return out;
  }

  /** Đưa cửa sổ Chrome đang chạy của profile lên trước/phóng to, không tạo phiên mới. */
  public async maximizeProfile(profileId: string): Promise<boolean> {
    const payload = await this.request<Record<string, unknown>>(
      `/api/profiles/${encodeURIComponent(profileId)}/maximize`,
      { method: 'POST', body: {} }
    );
    this.assertSuccess(payload, `đưa cửa sổ profile ${profileId} lên trước`);
    return true;
  }

  /**
   * Poll `/json/version` của Chrome để lấy websocket khi launch không trả về ws.
   * Đây là ĐÚNG cơ chế server dùng nội bộ (`_resolveWsUrl`), chỉ chạy bù khi nó timeout.
   */
  public async resolveWsEndpoint(port: number, maxWaitMs = 15000): Promise<string | null> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
          if (res.ok) {
            const json = (await res.json()) as Record<string, unknown>;
            const ws = readString(json, 'webSocketDebuggerUrl');
            if (ws) return ws;
          }
        } finally {
          clearTimeout(timeoutId);
        }
      } catch {
        // Chrome chưa mở port debug -> thử lại tới deadline.
      }
      await sleep(600);
    }
    return null;
  }

  /**
   * Mở browser của profile và trả websocket CDP.
   * IDEMPOTENT theo thiết kế của taothao: profile đang chạy -> tái dùng Chrome hiện có,
   * KHÔNG mở cửa sổ mới.
   */
  public async launchProfile(profileId: string): Promise<TaothaoLaunchResult> {
    if (typeof profileId !== 'string' || !profileId.trim()) {
      throw new TaothaoApiError('TAOTHAO_PROFILE_NOT_FOUND', 'Không thể mở taothaoAIClaw khi thiếu profileId hợp lệ.');
    }
    const payload = await this.request<Record<string, unknown>>(
      `/api/profiles/${encodeURIComponent(profileId)}/launch`,
      { method: 'POST', body: {} }
    );
    this.assertSuccess(payload, `khởi động profile ${profileId}`);

    const data = (payload.data && typeof payload.data === 'object' ? payload.data : {}) as Record<string, unknown>;
    const port = readNumber(data, 'port');
    let wsEndpoint = pickWsEndpoint(data);

    if (!wsEndpoint && port) {
      logger.warn(
        `[taothao] Profile ${profileId} chưa trả websocket -> tự poll /json/version trên cổng ${port}...`
      );
      wsEndpoint = await this.resolveWsEndpoint(port);
    }
    if (!wsEndpoint) {
      throw new TaothaoApiError(
        'TAOTHAO_WS_UNAVAILABLE',
        `Không lấy được websocket CDP của profile taothao ${profileId}` +
          (port ? ` (cổng debug ${port} chưa phản hồi /json/version).` : ' (API không trả về cổng debug).')
      );
    }

    return {
      profileId: readString(data, 'profileId') || profileId,
      pid: readNumber(data, 'pid'),
      port,
      wsEndpoint,
    };
  }

  /**
   * Đóng browser của profile. Trả `false` (KHÔNG throw) khi backend báo không đóng được,
   * để engine ghi `CLOSE_FAILED` mà không hạ cấp kết quả login.
   */
  public async closeProfile(profileId: string): Promise<boolean> {
    try {
      const payload = await this.request<Record<string, unknown>>(
        `/api/profiles/${encodeURIComponent(profileId)}/close`,
        { method: 'POST', body: {} }
      );
      if (payload.success === true) return true;
      const reason = readString(payload, 'error') || readString(payload, 'message') || 'không rõ nguyên nhân';
      logger.warn(`[taothao] Đóng profile ${profileId} thất bại: ${reason}`);
      return false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[taothao] Đóng profile ${profileId} thất bại: ${message}`);
      return false;
    }
  }
}

export const taothaoClient = new TaothaoClient();
