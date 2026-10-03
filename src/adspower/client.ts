import {
  AdsPowerApiResponse,
  AdsPowerBrowserConnectionData,
  AdsPowerGroupInfo,
  AdsPowerProfileInfo,
  AdsPowerProfileListParams,
  AdsPowerProfileListResult,
  AdsPowerStartBrowserParams,
  AdsPowerStatusData,
} from '../types/index.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

export class AdsPowerClient {
  private apiUrl: string;
  private apiKey?: string;
  private timeoutMs: number;
  
  // Rate-limiting Request Queue (Tuân thủ nghiêm ngặt 1 request/s theo đặc tả AdsPower)
  private requestQueue: Promise<void> = Promise.resolve();
  private lastRequestTime = 0;
  private minRequestIntervalMs = 1100; // Tối thiểu 1100ms (1.1s) giữa 2 requests đến AdsPower API

  // In-Memory Profile Cache
  private profileCache: AdsPowerProfileInfo[] = [];
  private cacheTimestamp = 0;
  private cacheTTL = 60000; // 60 giây TTL

  constructor(apiUrl?: string, apiKey?: string, timeoutMs?: number) {
    this.apiUrl = (apiUrl || config.adspower.apiUrl).replace(/\/+$/, '');
    this.apiKey = apiKey || config.adspower.apiKey;
    this.timeoutMs = timeoutMs || config.adspower.defaultTimeoutMs;
  }

  /**
   * Enqueue a request to AdsPower API ensuring minimum interval between calls
   */
  private async executeThrottled<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      const now = Date.now();
      const elapsed = now - this.lastRequestTime;
      if (elapsed < this.minRequestIntervalMs) {
        await new Promise(r => setTimeout(r, this.minRequestIntervalMs - elapsed));
      }
      this.lastRequestTime = Date.now();
      return await fn();
    };

    const nextPromise = this.requestQueue.then(run, run);
    this.requestQueue = nextPromise.then(() => {}, () => {});
    return nextPromise;
  }

  /**
   * Internal generic request helper with automatic rate-limit retry (exponential backoff)
   */
  private async request<T = any>(
    endpoint: string,
    options: {
      method?: 'GET' | 'POST';
      params?: Record<string, string | number | boolean | undefined>;
      body?: any;
    } = {},
    maxRetries = 5
  ): Promise<AdsPowerApiResponse<T>> {
    return this.executeThrottled(async () => {
      const { method = 'GET', params, body } = options;
      const url = new URL(`${this.apiUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`);

      if (params) {
        Object.entries(params).forEach(([key, val]) => {
          if (val !== undefined && val !== null) {
            url.searchParams.append(key, String(val));
          }
        });
      }

      if (this.apiKey) {
        url.searchParams.append('api_key', this.apiKey);
      }

      const headers: Record<string, string> = {
        'Accept': 'application/json',
      };

      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      if (body && method === 'POST') {
        headers['Content-Type'] = 'application/json';
      }

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
          logger.debug(`AdsPower API ${method} ${url.pathname}${url.search}`);
          const res = await fetch(url.toString(), {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (!res.ok) {
            throw new Error(`AdsPower API HTTP error: ${res.status} ${res.statusText}`);
          }

          const json = (await res.json()) as AdsPowerApiResponse<T>;

          // Handle AdsPower Rate Limit: "Too many request per second, please check"
          if (json.code === -1 && (json.msg?.toLowerCase().includes('too many request') || json.msg?.toLowerCase().includes('rate limit') || json.msg?.toLowerCase().includes('frequency'))) {
            logger.warn(`[AdsPower RateLimit] Đạt giới hạn request/s tại ${endpoint}. Đang thử lại sau ${1200 * (attempt + 1)}ms (lần ${attempt + 1}/${maxRetries})...`);
            await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
            continue;
          }

          return json;
        } catch (err: any) {
          clearTimeout(timeoutId);
          if (attempt === maxRetries - 1) {
            if (err.name === 'AbortError') {
              throw new Error(`AdsPower API request timeout after ${this.timeoutMs}ms: ${url.pathname}`);
            }
            if (err.code === 'ECONNREFUSED' || err.message?.includes('fetch failed')) {
              throw new Error(
                `Không thể kết nối đến AdsPower Local API tại ${this.apiUrl}. ` +
                `Vui lòng kiểm tra: 1. Ứng dụng AdsPower đã khởi động chưa? 2. Cài đặt Local API đã bật chưa (Settings -> Local API)?`
              );
            }
            throw err;
          }
          await new Promise(r => setTimeout(r, 1200));
        }
      }

      throw new Error(`AdsPower API ${endpoint} thất bại sau ${maxRetries} lần thử.`);
    });
  }

  /**
   * Check if AdsPower Local API is active and responsive
   */
  public async checkStatus(): Promise<{ ok: boolean; message: string; data?: AdsPowerStatusData }> {
    try {
      const res = await this.request<AdsPowerStatusData>('/status');
      if (res.code === 0) {
        return { ok: true, message: res.msg || 'AdsPower Local API is healthy', data: res.data };
      }
      return { ok: false, message: `AdsPower status code ${res.code}: ${res.msg}` };
    } catch (err: any) {
      return { ok: false, message: err.message };
    }
  }

  /**
   * Start a browser profile and get WebSocket / CDP connection endpoint
   */
  public async startBrowser(
    params: AdsPowerStartBrowserParams
  ): Promise<AdsPowerBrowserConnectionData> {
    const queryParams: Record<string, string | number | boolean | undefined> = {};

    if (params.profileId) {
      queryParams['user_id'] = params.profileId;
    } else if (params.profileNo) {
      queryParams['serial_number'] = params.profileNo;
    } else {
      throw new Error('Cần cung cấp ít nhất profileId (user_id) hoặc profileNo (serial_number) để mở browser.');
    }

    if (params.headless !== undefined) queryParams['headless'] = params.headless ? '1' : '0';
    if (params.lastOpenedTabs !== undefined) queryParams['last_opened_tabs'] = params.lastOpenedTabs ? '1' : '0';
    if (params.deleteCache !== undefined) queryParams['delete_cache'] = params.deleteCache ? '1' : '0';

    // Chỉ truyền launch_args khi caller chủ động yêu cầu.
    // Nếu truyền launch_args (dù rỗng), AdsPower sẽ MỞ CỬA SỔ MỚI thay vì
    // tái sử dụng cửa sổ hiện tại (giống như bấm nút Open trên UI AdsPower).
    if (params.launchArgs && params.launchArgs.length > 0) {
      queryParams['launch_args'] = JSON.stringify(params.launchArgs);
    }
    if (params.openTabs && params.openTabs.length > 0) {
      queryParams['open_tabs'] = JSON.stringify(params.openTabs);
    }

    logger.info(`Đang khởi động profile AdsPower: ${params.profileId || params.profileNo}...`);
    const res = await this.request<AdsPowerBrowserConnectionData>('/api/v1/browser/start', {
      params: queryParams,
    });

    if (res.code !== 0 || !res.data) {
      throw new Error(`Khởi động browser thất bại [code ${res.code}]: ${res.msg}`);
    }

    logger.info(
      `Khởi động profile thành công. Debug Port: ${res.data.debug_port}, WS: ${res.data.ws?.puppeteer}`
    );
    return res.data;
  }

  /**
   * Stop a running browser profile
   */
  public async stopBrowser(params: AdsPowerStartBrowserParams): Promise<boolean> {
    const queryParams: Record<string, string | undefined> = {};

    if (params.profileId) {
      queryParams['user_id'] = params.profileId;
    } else if (params.profileNo) {
      queryParams['serial_number'] = String(params.profileNo);
    } else {
      throw new Error('Cần cung cấp ít nhất profileId hoặc profileNo để đóng browser.');
    }

    logger.info(`Đang đóng profile AdsPower: ${params.profileId || params.profileNo}...`);
    const res = await this.request('/api/v1/browser/stop', {
      params: queryParams,
    });

    if (res.code !== 0) {
      logger.warn(`Đóng browser trả về mã [${res.code}]: ${res.msg}`);
      return false;
    }

    logger.info(`Đã đóng profile thành công.`);
    return true;
  }

  /**
   * Check if a specific browser profile is currently active/running
   */
  public async isBrowserActive(
    params: { profileId?: string; profileNo?: string | number } | string
  ): Promise<boolean> {
    try {
      const queryParams: Record<string, string | undefined> = {};
      if (typeof params === 'string') {
        queryParams['user_id'] = params;
      } else {
        if (params.profileId) queryParams['user_id'] = params.profileId;
        if (params.profileNo) queryParams['serial_number'] = String(params.profileNo);
      }

      const res = await this.request<{ status: string }>('/api/v1/browser/active', {
        params: queryParams,
      });

      return res.code === 0 && res.data?.status === 'Active';
    } catch {
      return false;
    }
  }

  /**
   * Get list of groups from AdsPower Local API
   */
  public async listGroups(
    params: { page?: number; pageSize?: number } = {}
  ): Promise<{ list: AdsPowerGroupInfo[]; page: number; page_size: number }> {
    const queryParams: Record<string, string | number | undefined> = {
      page: params.page || 1,
      page_size: params.pageSize || 100,
    };

    const res = await this.request<{ list: AdsPowerGroupInfo[]; page: number; page_size: number }>(
      '/api/v1/group/list',
      {
        params: queryParams,
      }
    );

    if (res.code !== 0 || !res.data) {
      throw new Error(`Lấy danh sách nhóm thất bại [code ${res.code}]: ${res.msg}`);
    }

    return res.data;
  }

  /**
   * Get list of profiles from AdsPower Local API with caching
   */
  public async listProfiles(
    params: AdsPowerProfileListParams = {}
  ): Promise<AdsPowerProfileListResult> {
    const pageSize = params.pageSize || 100;
    const page = params.page || 1;
    const now = Date.now();

    // Nếu yêu cầu fetchAll và không lọc theo group/id/serial, kiểm tra Cache
    if (params.fetchAll && !params.groupId && !params.userId && !params.serialNumber) {
      if (this.profileCache.length > 0 && now - this.cacheTimestamp < this.cacheTTL) {
        logger.debug(`[Profile Cache] Sử dụng cache ${this.profileCache.length} profiles.`);
        return {
          list: this.profileCache,
          page: 1,
          page_size: this.profileCache.length,
          total: this.profileCache.length,
        };
      }
    }

    if (params.fetchAll) {
      const allList: AdsPowerProfileInfo[] = [];
      let currentPage = 1;
      let hasMore = true;

      while (hasMore) {
        const queryParams: Record<string, string | number | undefined> = {
          page: currentPage,
          page_size: pageSize,
        };

        if (params.groupId) queryParams['group_id'] = params.groupId;
        if (params.userId) queryParams['user_id'] = params.userId;
        if (params.serialNumber) queryParams['serial_number'] = params.serialNumber;

        const res = await this.request<AdsPowerProfileListResult>('/api/v1/user/list', {
          params: queryParams,
        });

        if (res.code !== 0 || !res.data) {
          throw new Error(`Lấy danh sách profiles thất bại [code ${res.code}]: ${res.msg}`);
        }

        const items = res.data.list || [];
        allList.push(...items);

        if (items.length < pageSize || items.length === 0) {
          hasMore = false;
        } else {
          currentPage++;
        }
      }

      if (!params.groupId && !params.userId && !params.serialNumber) {
        this.profileCache = allList;
        this.cacheTimestamp = Date.now();
      }

      return {
        list: allList,
        page: 1,
        page_size: allList.length,
        total: allList.length,
      };
    }

    const queryParams: Record<string, string | number | undefined> = {
      page,
      page_size: pageSize,
    };

    if (params.groupId) queryParams['group_id'] = params.groupId;
    if (params.userId) queryParams['user_id'] = params.userId;
    if (params.serialNumber) queryParams['serial_number'] = params.serialNumber;

    const res = await this.request<AdsPowerProfileListResult>('/api/v1/user/list', {
      params: queryParams,
    });

    if (res.code !== 0 || !res.data) {
      throw new Error(`Lấy danh sách profiles thất bại [code ${res.code}]: ${res.msg}`);
    }

    return res.data;
  }

  /**
   * Get cached profiles list
   */
  public getCachedProfiles(): AdsPowerProfileInfo[] {
    return this.profileCache;
  }

  /**
   * Get detail of a specific profile by user_id, serial_number or name
   */
  public async getProfile(identifier: string): Promise<AdsPowerProfileInfo | null> {
    if (!identifier) return null;
    const cleanId = identifier.trim();

    // 1. Kiểm tra cache trước (0ms latency, không tốn request API)
    if (this.profileCache.length > 0) {
      const found = this.profileCache.find(
        p => p.user_id === cleanId ||
             p.serial_number === cleanId ||
             p.name?.toLowerCase().trim() === cleanId.toLowerCase()
      );
      if (found) return found;
    }

    // 2. Query trực tiếp theo user_id
    try {
      const listRes = await this.listProfiles({ userId: cleanId, pageSize: 1 });
      if (listRes.list && listRes.list.length > 0) {
        return listRes.list[0];
      }
    } catch {}

    // 3. Nếu là số, query theo serial_number
    if (/^\d+$/.test(cleanId) || cleanId.startsWith('#')) {
      const serial = cleanId.replace(/^#/, '');
      try {
        const serialRes = await this.listProfiles({ serialNumber: serial, pageSize: 1 });
        if (serialRes.list && serialRes.list.length > 0) {
          return serialRes.list[0];
        }
      } catch {}
    }

    // 4. Nếu là Name (hoặc chưa tìm thấy), gọi fetchAll để nạp toàn bộ danh sách vào cache
    try {
      const allRes = await this.listProfiles({ fetchAll: true });
      const found = (allRes.list || []).find(
        p => p.user_id === cleanId ||
             p.serial_number === cleanId ||
             p.name?.toLowerCase().trim() === cleanId.toLowerCase()
      );
      if (found) return found;
    } catch {}

    return null;
  }
}

export const adsPowerClient = new AdsPowerClient();
