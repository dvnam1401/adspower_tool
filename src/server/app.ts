import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { adsPowerClient } from '../adspower/client.js';
import { skillRepository } from '../skills/repository.js';
import { cdpManager } from '../dom/cdp.js';
import { facebookLoginAutomation } from '../automation/facebook-login.js';
import { batchFacebookLoginRunner } from '../automation/batch-runner.js';
import { facebookPageInventoryService, validatePageInventoryScanInput } from '../automation/facebook-page-inventory.js';
import { config, updateSystemConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { sendTelegramMessage } from '../utils/telegram.js';
import { normalizeProxyHost, readProxyConfig } from '../utils/proxy.js';
import { authRepository } from '../auth/repository.js';
import { authMiddleware, AuthenticatedRequest } from '../auth/middleware.js';
import { Skill, DOMAction } from '../types/index.js';
// Phase 6: Self-Healing Agent
import { healingLog } from '../recovery/healing-log.js';
import { errorClassifier } from '../recovery/classifier.js';
import { llmAgentResolver } from '../agent/resolver.js';
// Phase 7: Workflow Engine
import {
  workflowEngine,
  WORKFLOW_PRESETS,
  isWorkflowValidationError,
  isWorkflowConflictError,
} from '../workflow/engine.js';
import { listProviders, taothaoProvider } from '../providers/index.js';
import { DEFAULT_BROWSER_PROVIDER, isBrowserProviderId } from '../providers/types.js';
import { taothaoClient, TaothaoApiError } from '../taothao/client.js';
import { youtubeRunStore } from '../youtube/report-store.js';
import { youtubeChannelCache } from '../youtube/channel-cache.js';
// Account Hub subsystem (feature-flagged — see ACCOUNT_HUB_ENABLED)
import { createAccountHubRouter, createAccountHubWebhookRouter } from '../account-hub/index.js';



const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../../public');

export const app = express();

app.use(cors());

// Account Hub Apps Script webhook (spec §7.1). Mounted before express.json() so
// the HMAC can be computed over the exact request bytes, and before
// authMiddleware because Apps Script carries no session token — the shared-secret
// HMAC is its only credential. Answers 404 unless ACCOUNT_HUB_WEBHOOK_ENABLED=true.
const accountHubWebhookRouter = createAccountHubWebhookRouter();
if (accountHubWebhookRouter) app.use('/hooks/account-hub', accountHubWebhookRouter);
app.use(express.json());
app.use(express.static(publicDir));

// ==========================================
// AUTHENTICATION APIS
// ==========================================
app.post('/api/auth/login', (req: Request, res: Response) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Vui lòng nhập tên đăng nhập và mật khẩu!' });
  }

  const result = authRepository.authenticate(username, password);
  if (result.error) {
    return res.status(401).json({ success: false, error: result.error });
  }

  res.json({
    success: true,
    message: 'Đăng nhập thành công!',
    token: result.token,
    user: {
      userId: result.user?.userId,
      username: result.user?.username,
      role: result.user?.role,
    },
  });
});

app.post('/api/auth/logout', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : String(req.headers['x-auth-token'] || '');
  if (token) {
    authRepository.invalidateSession(token);
  }
  res.json({ success: true, message: 'Đã đăng xuất thành công.' });
});

app.get('/api/auth/me', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : String(req.headers['x-auth-token'] || '');
  const session = authRepository.validateSession(token);
  if (!session) {
    return res.status(401).json({ success: false, authenticated: false });
  }
  res.json({
    success: true,
    authenticated: true,
    user: {
      userId: session.userId,
      username: session.username,
    },
  });
});

app.post('/api/auth/change-password', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const { oldPassword, newPassword } = req.body;
  const username = req.userSession?.username;
  if (!username || !oldPassword || !newPassword) {
    return res.status(400).json({ success: false, error: 'Vui lòng nhập đầy đủ mật khẩu cũ và mới!' });
  }

  const result = authRepository.changePassword(username, oldPassword, newPassword);
  if (!result.success) {
    return res.status(400).json({ success: false, error: result.error });
  }

  res.json({ success: true, message: 'Đổi mật khẩu thành công!' });
});

// Protect all remaining /api/* routes with Auth Middleware
app.use('/api/*', authMiddleware);

// Store active CDP connections in memory
const activeConnections = new Map<string, { debugPort: string; wsUrl: string }>();

// SSE Clients for real-time events & logs
const sseClients: Response[] = [];

export function broadcastEvent(event: string, data: any) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (let i = sseClients.length - 1; i >= 0; i--) {
    const client = sseClients[i];
    try {
      client.write(payload);
    } catch {
      sseClients.splice(i, 1);
    }
  }
}

// Inject broadcast function into Workflow Engine (Phase 7).
// Deferred to a microtask so it is robust to module-graph entry order: when the
// engine module is imported first, this file evaluates mid-cycle (engine ->
// healing-orchestrator -> app -> engine) while `workflowEngine` is still in TDZ.
// The broadcast fn is only needed at request time, so a microtask is harmless.
queueMicrotask(() => workflowEngine.setBroadcast(broadcastEvent));


const originalInfo = logger.info.bind(logger);
const originalWarn = logger.warn.bind(logger);
const originalError = logger.error.bind(logger);

logger.info = (msg: any, ...meta: any[]) => {
  originalInfo(msg, ...meta);
  broadcastEvent('log', { level: 'info', message: String(msg), time: new Date().toLocaleTimeString() });
  return logger;
};
logger.warn = (msg: any, ...meta: any[]) => {
  originalWarn(msg, ...meta);
  broadcastEvent('log', { level: 'warn', message: String(msg), time: new Date().toLocaleTimeString() });
  return logger;
};
logger.error = (msg: any, ...meta: any[]) => {
  originalError(msg, ...meta);
  broadcastEvent('log', { level: 'error', message: String(msg), time: new Date().toLocaleTimeString() });
  return logger;
};

// ==========================================
// 1. SYSTEM & ADSPOWER STATUS
// ==========================================
app.get('/api/status', async (req: Request, res: Response) => {
  try {
    const adsStatus = await adsPowerClient.checkStatus();
    res.json({
      system: {
        uptime: process.uptime(),
        nodeVersion: process.version,
        platform: process.platform,
        concurrencyLimit: config.concurrency.maxProfiles,
        llmProvider: config.llm.provider,
        llmModel: config.llm.model,
      },
      adspower: {
        apiUrl: config.adspower.apiUrl,
        online: adsStatus.ok,
        message: adsStatus.message,
        data: adsStatus.data,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// System Config Management APIs
app.get('/api/config', (req: Request, res: Response) => {
  res.json({
    concurrency: config.concurrency,
    logging: config.logging,
    adspower: {
      apiUrl: config.adspower.apiUrl,
    },
    llm: config.llm,
    telegram: config.telegram,
    automation: config.automation,
    youtube: {
      // CHỈ cho biết đã cấu hình hay chưa — KHÔNG bao giờ trả API Key ra UI/log/SSE.
      apiKeyConfigured: Boolean(config.youtube.apiKey?.trim()),
    },
    windowLayout: config.windowLayout,
  });
});

app.post('/api/config', (req: Request, res: Response) => {
  try {
    const { maxProfiles, profileStartTimeoutMs, domActionTimeoutMs, adspowerUrl, llm, telegram, automation, windowLayout, youtube } = req.body;
    
    const partialToUpdate: any = {};

    if (maxProfiles !== undefined) {
      partialToUpdate.concurrency = {
        maxProfiles: Number(maxProfiles),
        profileStartTimeoutMs: profileStartTimeoutMs !== undefined ? Number(profileStartTimeoutMs) : config.concurrency.profileStartTimeoutMs,
        domActionTimeoutMs: domActionTimeoutMs !== undefined ? Number(domActionTimeoutMs) : config.concurrency.domActionTimeoutMs,
      };
    }

    if (adspowerUrl) {
      partialToUpdate.adspower = {
        apiUrl: String(adspowerUrl),
      };
    }

    if (llm && typeof llm === 'object') {
      partialToUpdate.llm = {
        provider: llm.provider !== undefined ? String(llm.provider) : config.llm.provider,
        model: llm.model !== undefined ? String(llm.model) : config.llm.model,
        baseUrl: llm.baseUrl !== undefined ? String(llm.baseUrl) : config.llm.baseUrl,
        apiKey: llm.apiKey !== undefined ? String(llm.apiKey) : config.llm.apiKey,
        group: llm.group !== undefined ? String(llm.group) : config.llm.group,
      };
    }

    if (telegram && typeof telegram === 'object') {
      partialToUpdate.telegram = {
        enabled: Boolean(telegram.enabled),
        botToken: String(telegram.botToken || ''),
        chatId: String(telegram.chatId || ''),
      };
    }

    if (automation && typeof automation === 'object') {
      partialToUpdate.automation = {
        closeSuccessBrowsers: Boolean(automation.closeSuccessBrowsers),
      };
    }

    if (youtube && typeof youtube === 'object' && youtube.apiKey !== undefined) {
      partialToUpdate.youtube = { apiKey: String(youtube.apiKey).trim() };
    }

    if (windowLayout && typeof windowLayout === 'object') {
      partialToUpdate.windowLayout = {
        enabled: Boolean(windowLayout.enabled),
        autoScale: Boolean(windowLayout.autoScale !== undefined ? windowLayout.autoScale : true),
        columns: Math.max(1, Number(windowLayout.columns || 4)),
        maxRows: Math.max(1, Number(windowLayout.maxRows || 1)),
        width: Math.max(200, Number(windowLayout.width || 450)),
        height: Math.max(200, Number(windowLayout.height || 700)),
        gapX: Number(windowLayout.gapX ?? 4),
        gapY: Number(windowLayout.gapY ?? 4),
      };
    }

    const updated = updateSystemConfig(partialToUpdate);

    logger.info(`[System Config Updated] Settings persisted. Concurrency: ${updated.concurrency.maxProfiles}, Telegram Enabled: ${updated.telegram.enabled}`);

    // API Key YouTube KHÔNG được lọt ra SSE/response — SSE phát tới mọi client đang mở.
    const safeConfig = {
      ...updated,
      youtube: { apiKeyConfigured: Boolean(updated.youtube.apiKey?.trim()) },
    };

    broadcastEvent('config_updated', {
      concurrencyLimit: updated.concurrency.maxProfiles,
      config: safeConfig,
    });

    res.json({
      success: true,
      message: 'Cập nhật cấu hình hệ thống thành công!',
      config: safeConfig,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Telegram Connection Test Endpoint
app.post('/api/telegram/test', async (req: Request, res: Response) => {
  try {
    const { botToken, chatId } = req.body;
    const token = botToken || config.telegram.botToken;
    const id = chatId || config.telegram.chatId;

    if (!token || !id) {
      return res.status(400).json({ success: false, error: 'Vui lòng nhập Telegram Bot Token và Chat ID!' });
    }

    const testMsg = `🤖 *ADSPOWER HYBRID AUTOMATION STUDIO*\n\n✅ *Kết nối Telegram thành công!*\nHệ thống tự động hóa đã liên kết thành công với Bot Telegram của bạn.\nKhi chạy xong các kịch bản đa luồng, AI sẽ tổng hợp phân loại lỗi cụ thể và báo cáo về đây.`;
    const sent = await sendTelegramMessage(token, id, testMsg);

    if (sent) {
      res.json({ success: true, message: 'Đã gửi tin nhắn thử nghiệm tới Telegram thành công!' });
    } else {
      res.status(400).json({ success: false, error: 'Không thể gửi tin nhắn Telegram. Vui lòng kiểm tra lại Bot Token và Chat ID.' });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 2. PROFILES & GROUPS MANAGEMENT
// ==========================================
app.get('/api/groups', async (req: Request, res: Response) => {
  try {
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 100;
    const data = await adsPowerClient.listGroups({ page, pageSize });
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/profiles', async (req: Request, res: Response) => {
  try {
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 100;
    const groupId = req.query.groupId as string | undefined;
    const serialNumber = req.query.serialNumber as string | undefined;
    const userId = req.query.userId as string | undefined;
    const fetchAll = req.query.fetchAll === 'true';

    const data = await adsPowerClient.listProfiles({
      page,
      pageSize,
      groupId,
      serialNumber,
      userId,
      fetchAll,
    });
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// PROXY CHECKER — Kiểm tra proxy đã sử dụng
// ==========================================

// `normalizeProxyHost` + config reading now live in `src/utils/proxy.ts` so the
// Account Hub proxy gate (spec §5) shares one implementation.

/**
 * POST /api/proxy/check
 * Body: { proxies: string[], proxyFormat?: "host:port" | "host:port:user:pass" | "auto" }
 * Response: { total, used[], unused[], totalProfilesScanned }
 */
app.post('/api/proxy/check', async (req: Request, res: Response) => {
  try {
    const { proxies } = req.body as { proxies: string[]; proxyFormat?: string };

    if (!Array.isArray(proxies) || proxies.length === 0) {
      return res.status(400).json({ success: false, error: 'Vui lòng cung cấp danh sách proxy (mảng strings).' });
    }

    logger.info(`[Proxy Checker] Bắt đầu kiểm tra ${proxies.length} proxies trong AdsPower...`);

    // Fetch toàn bộ profiles từ AdsPower
    const profilesResult = await adsPowerClient.listProfiles({ fetchAll: true });
    const allProfiles = profilesResult.list || [];

    logger.info(`[Proxy Checker] Đã fetch ${allProfiles.length} profiles từ AdsPower. Đang phân tích...`);

    // Xây dựng bản đồ: normalizedHostPort → danh sách profile
    const proxyMap = new Map<string, Array<{ user_id: string; name: string; serial_number: string; group_name: string }>>();

    for (const profile of allProfiles) {
      const cfg = readProxyConfig(profile);
      const host = String(cfg.proxy_host || '').trim();
      const port = String(cfg.proxy_port || '').trim();

      if (!host || !port || host === '' || port === '0') continue;

      const normalized = `${host.toLowerCase()}:${port}`;

      if (!proxyMap.has(normalized)) {
        proxyMap.set(normalized, []);
      }
      proxyMap.get(normalized)!.push({
        user_id: profile.user_id,
        name: profile.name || '',
        serial_number: profile.serial_number || '',
        group_name: profile.group_name || '',
      });
    }

    // So sánh từng proxy đầu vào
    const usedProxies: Array<{
      proxy: string;
      normalized: string;
      profiles: Array<{ user_id: string; name: string; serial_number: string; group_name: string }>;
    }> = [];
    const unusedProxies: string[] = [];

    for (const rawProxy of proxies) {
      if (!rawProxy || !rawProxy.trim()) continue;
      const normalized = normalizeProxyHost(rawProxy);
      if (proxyMap.has(normalized)) {
        usedProxies.push({
          proxy: rawProxy.trim(),
          normalized,
          profiles: proxyMap.get(normalized)!,
        });
      } else {
        unusedProxies.push(rawProxy.trim());
      }
    }

    logger.info(`[Proxy Checker] Kết quả: ${usedProxies.length} đã dùng, ${unusedProxies.length} chưa dùng / ${proxies.length} tổng proxy.`);

    res.json({
      success: true,
      total: proxies.filter(p => p && p.trim()).length,
      used: usedProxies,
      unused: unusedProxies,
      totalProfilesScanned: allProfiles.length,
    });
  } catch (err: any) {
    logger.error(`[Proxy Checker] Lỗi: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

let cachedScreenRes: { width: number; height: number } | null = null;

function getPrimaryScreenResolution(): Promise<{ width: number; height: number }> {
  if (cachedScreenRes) return Promise.resolve(cachedScreenRes);
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      cachedScreenRes = { width: 1920, height: 1080 };
      return resolve(cachedScreenRes);
    }
    exec('powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds | ConvertTo-Json"', { timeout: 2000 }, (err, stdout) => {
      if (err || !stdout) {
        cachedScreenRes = { width: 1920, height: 1080 };
        return resolve(cachedScreenRes);
      }
      try {
        const bounds = JSON.parse(stdout);
        cachedScreenRes = {
          width: Number(bounds.Width) || 1920,
          height: Number(bounds.Height) || 1080,
        };
        resolve(cachedScreenRes);
      } catch (e) {
        cachedScreenRes = { width: 1920, height: 1080 };
        resolve(cachedScreenRes);
      }
    });
  });
}

// Prefetch screen resolution
getPrimaryScreenResolution().catch(() => {});

function getWindowPositionLaunchArgs(index: number): string[] {
  if (!config.windowLayout?.enabled) return [];
  const cols = Math.max(1, config.windowLayout.columns || 4);
  const rows = Math.max(1, config.windowLayout.maxRows || 1);
  const gapX = config.windowLayout.gapX ?? 4;
  const gapY = config.windowLayout.gapY ?? 4;

  let width = Math.max(200, config.windowLayout.width || 450);
  let height = Math.max(200, config.windowLayout.height || 700);

  if (config.windowLayout.autoScale) {
    const screenWidth = cachedScreenRes?.width || 1920;
    const screenHeight = cachedScreenRes?.height || 1080;

    const usableWidth = screenWidth - (cols - 1) * gapX;
    const usableHeight = screenHeight - (rows - 1) * gapY - 40;

    width = Math.floor(usableWidth / cols);
    height = Math.floor(usableHeight / rows);
  }

  const col = index % cols;
  const row = Math.floor(index / cols) % rows;

  const posX = col * (width + gapX);
  const posY = row * (height + gapY);

  return [`--window-position=${posX},${posY}`, `--window-size=${width},${height}`];
}

// Single start
app.post('/api/browser/start', async (req: Request, res: Response) => {
  try {
    const { profileId, profileNo, headless, deleteCache } = req.body;
    if (!profileId && !profileNo) {
      return res.status(400).json({ error: 'Cần profileId hoặc profileNo' });
    }

    const id = profileId || profileNo;
    logger.info(`[UI Request] Đang khởi động profile ${id}...`);

    const connData = await adsPowerClient.startBrowser({
      profileId,
      profileNo,
      headless: !!headless,
      deleteCache: !!deleteCache,
      // Không truyền launchArgs → AdsPower sẽ mở giống như bấm nút Open trên UI
    });

    if (connData?.ws?.puppeteer) {
      activeConnections.set(id, {
        debugPort: connData.debug_port,
        wsUrl: connData.ws.puppeteer,
      });

      // Auto connect Playwright CDP in background
      cdpManager.connect(id, connData.ws.puppeteer).catch((e) => {
        logger.debug(`Playwright background connect note: ${e.message}`);
      });
    }

    broadcastEvent('profile_status_change', {
      profileId: id,
      status: 'active',
      debugPort: connData.debug_port,
      wsUrl: connData.ws?.puppeteer,
    });

    res.json({ success: true, data: connData });
  } catch (err: any) {
    logger.error(`Khởi động browser lỗi: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Single stop
app.post('/api/browser/stop', async (req: Request, res: Response) => {
  try {
    const { profileId, profileNo } = req.body;
    const id = profileId || profileNo;
    if (!id) {
      return res.status(400).json({ error: 'Cần profileId hoặc profileNo' });
    }

    logger.info(`[UI Request] Đang dừng profile ${id}...`);
    await cdpManager.disconnect(id);
    activeConnections.delete(id);

    const stopped = await adsPowerClient.stopBrowser({ profileId, profileNo });

    broadcastEvent('profile_status_change', {
      profileId: id,
      status: 'inactive',
    });

    res.json({ success: stopped });
  } catch (err: any) {
    logger.error(`Dừng browser lỗi: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Batch start
app.post('/api/browser/batch-start', async (req: Request, res: Response) => {
  try {
    const { profileIds } = req.body;
    if (!Array.isArray(profileIds) || profileIds.length === 0) {
      return res.status(400).json({ error: 'Cần danh sách profileIds' });
    }

    logger.info(`[Batch Action] Bắt đầu mở đồng loạt ${profileIds.length} profiles...`);
    const results: any[] = [];

    for (let i = 0; i < profileIds.length; i++) {
      const id = profileIds[i];
      try {
        const connData = await adsPowerClient.startBrowser({
          profileId: id,
          // Không truyền launchArgs → AdsPower sẽ mở giống như bấm nút Open trên UI
        });
        if (connData?.ws?.puppeteer) {
          activeConnections.set(id, { debugPort: connData.debug_port, wsUrl: connData.ws.puppeteer });
          cdpManager.connect(id, connData.ws.puppeteer).catch(() => {});
        }
        results.push({ profileId: id, success: true, debugPort: connData.debug_port });
        broadcastEvent('profile_status_change', { profileId: id, status: 'active' });
      } catch (err: any) {
        results.push({ profileId: id, success: false, error: err.message });
      }
    }

    res.json({ results });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Batch stop
app.post('/api/browser/batch-stop', async (req: Request, res: Response) => {
  try {
    const { profileIds } = req.body;
    if (!Array.isArray(profileIds) || profileIds.length === 0) {
      return res.status(400).json({ error: 'Cần danh sách profileIds' });
    }

    logger.info(`[Batch Action] Bắt đầu đóng đồng loạt ${profileIds.length} profiles...`);
    const results: any[] = [];

    for (const id of profileIds) {
      try {
        await cdpManager.disconnect(id);
        activeConnections.delete(id);
        await adsPowerClient.stopBrowser({ profileId: id });
        results.push({ profileId: id, success: true });
        broadcastEvent('profile_status_change', { profileId: id, status: 'inactive' });
      } catch (err: any) {
        results.push({ profileId: id, success: false, error: err.message });
      }
    }

    res.json({ results });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Check active
app.get('/api/browser/active', async (req: Request, res: Response) => {
  try {
    const profileId = req.query.profileId as string | undefined;
    const profileNo = req.query.profileNo as string | undefined;
    const isActive = await adsPowerClient.isBrowserActive({ profileId, profileNo });
    res.json({ active: isActive });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

function getActiveProfilesFromProcesses(): Promise<string[]> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      return resolve([]);
    }
    exec('powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -like \'*sunbrowser*\' -or $_.Name -like \'*chrome*\' } | Select-Object CommandLine | ConvertTo-Json"', { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      try {
        const procs = JSON.parse(stdout);
        const list = Array.isArray(procs) ? procs : [procs];
        const activeUserIds = new Set<string>();

        list.forEach((p: any) => {
          if (!p.CommandLine) return;
          const match = p.CommandLine.match(/user-data-dir=.*?[\\\/]cache[\\\/]([a-zA-Z0-9]+)_/i);
          if (match && match[1]) {
            activeUserIds.add(match[1]);
          }
        });

        resolve(Array.from(activeUserIds));
      } catch (e) {
        resolve([]);
      }
    });
  });
}

// Get all currently active profile IDs from active connection registry and running processes
app.get('/api/browser/active-list', async (req: Request, res: Response) => {
  const activeIds = new Set<string>(Array.from(activeConnections.keys()));

  try {
    const processActiveIds = await getActiveProfilesFromProcesses();
    processActiveIds.forEach(id => activeIds.add(id));
  } catch (err: any) {
    logger.debug(`Error scanning active processes: ${err.message}`);
  }

  res.json({ activeIds: Array.from(activeIds) });
});

// ==========================================
// 3. CDP INTERACTION & PLAYGROUND
// ==========================================
app.post('/api/cdp/navigate', async (req: Request, res: Response) => {
  try {
    const { profileId, url } = req.body;
    if (!profileId || !url) {
      return res.status(400).json({ error: 'Cần profileId và url' });
    }

    let conn = activeConnections.get(profileId);
    let wsUrl = conn?.wsUrl;

    if (!wsUrl) {
      // Try to start or get connection
      const startRes = await adsPowerClient.startBrowser({ profileId });
      wsUrl = startRes.ws?.puppeteer;
      if (wsUrl) {
        activeConnections.set(profileId, { debugPort: startRes.debug_port, wsUrl });
      }
    }

    const result = await cdpManager.navigate(profileId, url, wsUrl);
    res.json({ success: true, result });
  } catch (err: any) {
    logger.error(`CDP Navigate error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/cdp/screenshot', async (req: Request, res: Response) => {
  try {
    const { profileId } = req.body;
    if (!profileId) {
      return res.status(400).json({ error: 'Cần profileId' });
    }

    const base64 = await cdpManager.takeScreenshot(profileId);
    res.json({ success: true, imageBase64: `data:image/jpeg;base64,${base64}` });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/cdp/action', async (req: Request, res: Response) => {
  try {
    const { profileId, action } = req.body as { profileId: string; action: DOMAction };
    if (!profileId || !action) {
      return res.status(400).json({ error: 'Cần profileId và action' });
    }

    const result = await cdpManager.executeAction(profileId, action);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Facebook Login Automation Trigger
app.post('/api/automation/facebook-login', async (req: Request, res: Response) => {
  try {
    const { profileId, profileName, targetUrl } = req.body;
    const target = profileId || profileName || 'FB REUP BR 17/8 9';
    logger.info(`[API Trigger] Khởi chạy Facebook Login cho: ${target}${targetUrl ? ` (URL: ${targetUrl})` : ''}`);
    
    // Execute automation in background / async
    facebookLoginAutomation.execute(target, targetUrl).then(result => {
      broadcastEvent('automation_completed', result);
    }).catch(err => {
      logger.error(`Lỗi background Facebook Login: ${err.message}`);
    });

    res.json({ success: true, message: `Đã khởi chạy Facebook Login cho ${target}` });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Facebook Login Automation Batch (Multi-threaded Concurrent Execution)
app.post('/api/automation/facebook-login/batch', async (req: Request, res: Response) => {
  try {
    const { profileIds, groupId, concurrency, targetUrl, autoCloseSuccess } = req.body;
    logger.info(`[API Trigger Batch] Khởi chạy Facebook Login Đa luồng cho ${profileIds ? `${profileIds.length} profiles` : groupId ? `Group ${groupId}` : 'tất cả profiles'}...`);

    // Execute batch runner in background
    batchFacebookLoginRunner.runBatch({
      profileIdentifiers: profileIds,
      groupId,
      concurrency,
      targetUrl,
      autoCloseSuccess: autoCloseSuccess !== undefined ? Boolean(autoCloseSuccess) : config.automation.closeSuccessBrowsers,
    }).catch(err => {
      logger.error(`Lỗi background Facebook Login Batch: ${err.message}`);
    });

    res.json({
      success: true,
      message: 'Đã phát động tiến trình Facebook Auto-Login Đa luồng chạy ngầm thành công.',
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Stop Facebook Login Automation Batch
app.post('/api/automation/facebook-login/batch-stop', async (req: Request, res: Response) => {
  try {
    logger.warn('[API Request] Đang phát lệnh DỪNG TOÀN BỘ tiến trình Batch Automation...');
    batchFacebookLoginRunner.stopBatch();
    res.json({ success: true, message: 'Đã dừng toàn bộ tiến trình Batch Automation ngầm.' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// FACEBOOK PAGE INVENTORY API (FEAT-007 Step 1)
// ==========================================

/** Start Page inventory scan job for an AdsPower profile */
app.post('/api/page-inventory/scan', async (req: Request, res: Response) => {
  try {
    // Step 1: Validate input payload strictly BEFORE profile resolution and BEFORE job creation
    const validation = validatePageInventoryScanInput(req.body);
    if (!validation.valid || !validation.data) {
      return res.status(400).json({
        success: false,
        error: validation.error || 'Dữ liệu đầu vào không hợp lệ.',
      });
    }

    const { profileId, maxExpansions, timeoutMs, keepBrowserOpen, showUnresolved } = validation.data;

    // Step 2: Resolve profile info if profileId is serial or name
    let targetProfileId = profileId;
    try {
      const resolved = await adsPowerClient.getProfile(profileId);
      if (resolved && resolved.user_id) {
        targetProfileId = resolved.user_id;
      }
    } catch {}

    // Step 3: Start scan job with strictly validated values
    const job = facebookPageInventoryService.startScanJob(targetProfileId, {
      maxExpansions,
      timeoutMs,
      keepBrowserOpen,
      showUnresolved,
    });

    res.json({
      success: true,
      message: `Đã khởi tạo tiến trình quét Page cho profile ${targetProfileId}.`,
      jobId: job.jobId,
      job,
    });
  } catch (err: any) {
    if (err.statusCode === 400) {
      return res.status(400).json({ success: false, error: err.message });
    }
    if (err.statusCode === 409) {
      return res.status(409).json({ success: false, error: err.message });
    }
    logger.error(`Lỗi khi khởi chạy Page inventory scan: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Get status and results of a scan job */
app.get('/api/page-inventory/jobs/:jobId', (req: Request, res: Response) => {
  const jobId = String(req.params.jobId || '');
  if (!jobId) {
    return res.status(400).json({ success: false, error: 'Thiếu jobId.' });
  }

  const job = facebookPageInventoryService.getJob(jobId);
  if (!job) {
    return res.status(404).json({ success: false, error: `Không tìm thấy job với ID: ${jobId}` });
  }

  res.json({ success: true, job });
});

/** Cancel running scan job */
app.post('/api/page-inventory/jobs/:jobId/cancel', (req: Request, res: Response) => {
  const jobId = String(req.params.jobId || '');
  if (!jobId) {
    return res.status(400).json({ success: false, error: 'Thiếu jobId.' });
  }

  const job = facebookPageInventoryService.getJob(jobId);
  if (!job) {
    return res.status(404).json({ success: false, error: `Không tìm thấy job với ID: ${jobId}` });
  }

  facebookPageInventoryService.cancelJob(jobId);
  res.json({ success: true, message: `Đã gửi yêu cầu hủy job ${jobId}.`, job: facebookPageInventoryService.getJob(jobId) });
});

app.delete('/api/page-inventory/jobs/:jobId', (req: Request, res: Response) => {
  const jobId = String(req.params.jobId || '');
  if (!jobId) {
    return res.status(400).json({ success: false, error: 'Thiếu jobId.' });
  }

  const job = facebookPageInventoryService.getJob(jobId);
  if (!job) {
    return res.status(404).json({ success: false, error: `Không tìm thấy job với ID: ${jobId}` });
  }

  facebookPageInventoryService.cancelJob(jobId);
  res.json({ success: true, message: `Đã hủy job ${jobId}.` });
});
app.get('/api/skills', (req: Request, res: Response) => {
  res.json({ skills: skillRepository.getAll() });
});

app.post('/api/skills', (req: Request, res: Response) => {
  try {
    const skillData = req.body as Skill;
    if (!skillData.skillId || !skillData.site || !skillData.actionType) {
      return res.status(400).json({ error: 'Thiếu thông tin bắt buộc cho skill' });
    }

    const saved = skillRepository.saveSkill({
      ...skillData,
      createdAt: skillData.createdAt || new Date().toISOString(),
      status: skillData.status || 'candidate',
      successCount: skillData.successCount || 0,
      failCount: skillData.failCount || 0,
      version: skillData.version || 1,
    });

    res.json({ success: true, skill: saved });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/skills/:id/status', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const { status } = req.body;
  const updated = skillRepository.updateStatus(id, status);
  res.json({ success: updated });
});

app.delete('/api/skills/:id', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const deleted = skillRepository.delete(id);
  res.json({ success: deleted });
});

// ==========================================
// 5. REALTIME SSE STREAM
// ==========================================
app.get('/api/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.push(res);
  logger.info(`[App SSE] Client connected (${sseClients.length} active clients).`);

  res.write(`event: connected\ndata: ${JSON.stringify({ status: 'connected', time: new Date() })}\n\n`);

  req.on('close', () => {
    const index = sseClients.indexOf(res);
    if (index !== -1) {
      sseClients.splice(index, 1);
    }
  });
});

// ==========================================
// 6. SELF-HEALING MONITOR (Phase 6)
// ==========================================

/** Lấy danh sách healing events (mới nhất trước) */
app.get('/api/healing/events', (req: Request, res: Response) => {
  const limit = req.query.limit ? Number(req.query.limit) : 100;
  res.json({
    events: healingLog.getAll(limit),
    stats: healingLog.getStats(),
  });
});

/** Xóa toàn bộ healing log */
app.delete('/api/healing/events', (req: Request, res: Response) => {
  healingLog.clear();
  res.json({ success: true, message: 'Đã xóa toàn bộ healing log.' });
});

/** Phân loại thủ công một error message */
app.post('/api/healing/classify', (req: Request, res: Response) => {
  try {
    const { errorMessage, site, action } = req.body;
    if (!errorMessage) {
      return res.status(400).json({ error: 'Vui lòng cung cấp errorMessage' });
    }

    const classified = errorClassifier.classify(errorMessage, site, action);
    res.json({ success: true, classified });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Trigger LLM Agent resolver thủ công */
app.post('/api/healing/resolve', async (req: Request, res: Response) => {
  try {
    const { site, actionType, targetDescription, domSnapshot, currentUrl, failedSelectors } = req.body;

    if (!site || !actionType || !targetDescription) {
      return res.status(400).json({ error: 'Cần site, actionType, targetDescription' });
    }

    logger.info(`[API] Trigger LLM Resolver: ${site}/${actionType}`);

    const result = await llmAgentResolver.resolve({
      site,
      actionType,
      targetDescription,
      domSnapshot,
      currentUrl,
      failedSelectors,
    });

    broadcastEvent('healing_event', {
      site,
      actionType,
      resolution: result.success ? 'llm_healed' : 'escalated',
      tokensUsed: result.tokensUsed,
      selectorsCount: result.selectors.length,
    });

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 6b. BROWSER PROVIDERS (AdsPower / taothaoAIClaw)
// ==========================================

/** Danh sách backend profile khả dụng cho UI (không kèm credential/proxy). */
app.get('/api/providers', (req: Request, res: Response) => {
  res.json({ success: true, providers: listProviders(), default: DEFAULT_BROWSER_PROVIDER });
});

/** Health check Local API của taothaoAIClaw (route ROOT `/health`). */
app.get('/api/taothao/health', async (req: Request, res: Response) => {
  const health = await taothaoClient.checkHealth();
  res.status(health.ok ? 200 : 503).json({ success: health.ok, ...health, apiUrl: taothaoClient.baseUrl });
});

/**
 * Danh sách profile taothao (CHỈ ĐỌC). `fetchAll=true` gom hết các trang.
 * Payload đã whitelist trong client -> không có proxy.password/config.
 */
app.get('/api/taothao/profiles', async (req: Request, res: Response) => {
  try {
    const result = await taothaoClient.listProfiles({
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 100,
      groupId: typeof req.query.groupId === 'string' ? req.query.groupId : undefined,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      fetchAll: req.query.fetchAll === 'true',
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    const code = err instanceof TaothaoApiError ? err.code : 'TAOTHAO_UNKNOWN';
    const status = err instanceof TaothaoApiError && err.code === 'TAOTHAO_UNAVAILABLE' ? 503 : 502;
    logger.error(`[taothao API] Lấy danh sách profile thất bại (${code}): ${err.message}`);
    res.status(status).json({ success: false, code, error: err.message });
  }
});

async function openOrFocusTaothaoProfile(
  profileId: string,
  knownRunningFolders?: Set<string>
): Promise<{ reused: boolean }> {
  const status = await taothaoClient.getStatus(profileId);
  let isRunning = status.isRunning;

  // Một số phiên bản API cập nhật `status` chậm hơn danh sách process đang chạy.
  if (!isRunning && status.folder) {
    const runningFolders = knownRunningFolders ?? new Set(
      (await taothaoClient.listRunning()).map(item => item.folder)
    );
    isRunning = runningFolders.has(status.folder);
  }

  if (isRunning) {
    await taothaoClient.maximizeProfile(profileId);
    logger.info(`[taothao] Tái sử dụng và đưa cửa sổ đang chạy lên trước: ${profileId}`);
    return { reused: true };
  }

  await taothaoProvider.startBrowser(profileId);
  return { reused: false };
}

/** Mở một profile taothaoAIClaw, không chạy workflow hay automation. */
app.post('/api/taothao/browser/start', async (req: Request, res: Response) => {
  const profileId = typeof req.body?.profileId === 'string' ? req.body.profileId.trim() : '';
  if (!profileId) {
    return res.status(400).json({ success: false, error: 'Thiếu profileId taothaoAIClaw.' });
  }

  try {
    const opened = await openOrFocusTaothaoProfile(profileId);
    res.json({ success: true, profileId, reused: opened.reused });
  } catch (err: any) {
    const code = err instanceof TaothaoApiError ? err.code : 'TAOTHAO_UNKNOWN';
    logger.error(`[taothao API] Mở profile ${profileId} thất bại (${code}): ${err.message}`);
    res.status(502).json({ success: false, code, error: err.message });
  }
});

/** Đóng một profile taothaoAIClaw, không ảnh hưởng workflow. */
app.post('/api/taothao/browser/stop', async (req: Request, res: Response) => {
  const profileId = typeof req.body?.profileId === 'string' ? req.body.profileId.trim() : '';
  if (!profileId) {
    return res.status(400).json({ success: false, error: 'Thiếu profileId taothaoAIClaw.' });
  }

  try {
    const stopped = await taothaoProvider.stopBrowser(profileId);
    res.json({ success: stopped, profileId });
  } catch (err: any) {
    const code = err instanceof TaothaoApiError ? err.code : 'TAOTHAO_UNKNOWN';
    logger.error(`[taothao API] Đóng profile ${profileId} thất bại (${code}): ${err.message}`);
    res.status(502).json({ success: false, code, error: err.message });
  }
});

/**
 * Dán danh sách ID hoặc tên profile và chỉ mở cửa sổ taothaoAIClaw.
 * Tên trùng nhiều profile bị từ chối; khi đó người dùng phải dùng profileId.
 */
app.post('/api/taothao/browser/batch-start', async (req: Request, res: Response) => {
  const rawIdentifiers: unknown[] = Array.isArray(req.body?.identifiers) ? req.body.identifiers : [];
  const identifiers: string[] = [...new Set<string>(
    rawIdentifiers
      .filter((value: unknown): value is string => typeof value === 'string')
      .map((value: string) => value.trim())
      .filter(Boolean)
  )];

  if (identifiers.length === 0) {
    return res.status(400).json({ success: false, error: 'Hãy nhập ít nhất một ID hoặc tên profile.' });
  }
  if (identifiers.length > 500) {
    return res.status(400).json({ success: false, error: 'Mỗi lượt chỉ mở tối đa 500 profile.' });
  }

  const concurrency = Math.min(20, Math.max(1, Number(req.body?.concurrency) || 5));

  try {
    const resolved = await taothaoProvider.resolveProfiles(identifiers);
    const runningFolders = new Set((await taothaoClient.listRunning()).map(item => item.folder));
    const uniqueProfiles = [...new Map(
      resolved.resolved.map(item => [item.profile.user_id, item])
    ).values()];
    const results: Array<{
      identifier: string;
      profileId: string;
      name: string;
      success: boolean;
      reused?: boolean;
      error?: string;
    }> = new Array(uniqueProfiles.length);

    let cursor = 0;
    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= uniqueProfiles.length) return;
        const item = uniqueProfiles[index];
        try {
          const opened = await openOrFocusTaothaoProfile(item.profile.user_id, runningFolders);
          results[index] = {
            identifier: item.identifier,
            profileId: item.profile.user_id,
            name: item.profile.name || item.profile.user_id,
            success: true,
            reused: opened.reused,
          };
        } catch (err: any) {
          results[index] = {
            identifier: item.identifier,
            profileId: item.profile.user_id,
            name: item.profile.name || item.profile.user_id,
            success: false,
            error: err.message,
          };
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, Math.max(1, uniqueProfiles.length)) }, () => worker())
    );

    const openedCount = results.filter(item => item.success).length;
    const reusedCount = results.filter(item => item.success && item.reused).length;
    const launchedCount = openedCount - reusedCount;
    const failedCount = results.length - openedCount;
    res.json({
      success: true,
      requestedCount: identifiers.length,
      resolvedCount: uniqueProfiles.length,
      openedCount,
      reusedCount,
      launchedCount,
      failedCount,
      notFound: resolved.notFound,
      results,
    });
  } catch (err: any) {
    const code = err instanceof TaothaoApiError ? err.code : 'TAOTHAO_UNKNOWN';
    logger.error(`[taothao API] Mở batch profile thất bại (${code}): ${err.message}`);
    res.status(502).json({ success: false, code, error: err.message });
  }
});

// ==========================================
// 7. WORKFLOW ENGINE (Phase 7)
// ==========================================

/** Lấy trạng thái batch hiện tại */
app.get('/api/workflow/status', (req: Request, res: Response) => {
  res.json(workflowEngine.getBatchStatus());
});

/** Lấy danh sách workflow presets */
app.get('/api/workflow/presets', (req: Request, res: Response) => {
  const presets = Object.entries(WORKFLOW_PRESETS).map(([key, val]) => ({
    key,
    name: val.name,
    stepCount: val.steps.length,
  }));
  res.json({ presets });
});

/** Khởi chạy batch workflow */
app.post('/api/workflow/run', async (req: Request, res: Response) => {
  try {
    const {
      profileIds,
      profileIdentifiers,
      workflowName,
      steps,
      concurrency,
      credentials,
      provider,
      googleAccounts,
      autoCloseSuccess,
      refreshChannels,
    } = req.body;

    const targetList = profileIdentifiers || profileIds;
    if (!Array.isArray(targetList) || targetList.length === 0) {
      return res.status(400).json({ error: 'Cần danh sách profileIds hoặc profileIdentifiers' });
    }
    if (!workflowName) {
      return res.status(400).json({ error: 'Cần workflowName' });
    }
    if (provider !== undefined && !isBrowserProviderId(provider)) {
      return res.status(400).json({ success: false, error: `Provider không hợp lệ: "${provider}".` });
    }
    if (googleAccounts !== undefined && typeof googleAccounts !== 'string') {
      return res
        .status(400)
        .json({ success: false, error: 'googleAccounts phải là text "gmail,password,2fa" mỗi dòng một tài khoản.' });
    }
    // Engine là singleton: một batch mới sẽ xoá state của batch đang chạy -> chặn.
    if (workflowEngine.getBatchStatus().engineState === 'running') {
      return res.status(409).json({
        success: false,
        error: 'Đang có batch chạy. Hãy chờ hoàn thành hoặc bấm Cancel trước khi chạy batch mới.',
      });
    }

    // Google Account Login lấy credential PER-PROFILE từ chính profile AdsPower tương ứng.
    // Không còn yêu cầu credentials chung ở cấp batch (tránh nhiễm chéo credential giữa các profile).
    // Với taothaoAIClaw, credential đến từ danh sách người dùng dán (googleAccounts) —
    // KHÔNG log nội dung này ở bất kỳ đâu.

    logger.info(
      `[Workflow API] Khởi chạy batch: ${targetList.length} profiles, provider="${provider ?? DEFAULT_BROWSER_PROVIDER}", workflow="${workflowName}", concurrency=${concurrency || 5}`
    );

    const result = await workflowEngine.runBatch({
      profileIdentifiers: targetList,
      workflowName,
      steps,
      concurrency: concurrency || config.concurrency.maxProfiles,
      credentials,
      provider,
      googleAccounts,
      autoCloseSuccess: typeof autoCloseSuccess === 'boolean' ? autoCloseSuccess : undefined,
      refreshChannels: refreshChannels === true,
    });

    res.json({ success: true, ...result });
  } catch (err: any) {
    if (isWorkflowValidationError(err)) {
      // Lỗi đầu vào của người dùng: KHÔNG có profile nào được mở.
      logger.warn(`[Workflow API] Từ chối batch (đầu vào không hợp lệ): ${err.message}`);
      return res.status(400).json({ success: false, error: err.message });
    }
    if (isWorkflowConflictError(err)) {
      logger.warn(`[Workflow API] Từ chối batch (engine đang chạy): ${err.message}`);
      return res.status(409).json({ success: false, error: err.message });
    }
    logger.error(`[Workflow API] Lỗi khởi chạy batch: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Tạm dừng workflow batch */
app.post('/api/workflow/pause', (req: Request, res: Response) => {
  workflowEngine.pause();
  res.json({ success: true, message: 'Đã tạm dừng workflow batch.' });
});

/** Tiếp tục workflow batch */
app.post('/api/workflow/resume', (req: Request, res: Response) => {
  workflowEngine.resume();
  res.json({ success: true, message: 'Đã tiếp tục workflow batch.' });
});

/** Hủy workflow batch */
app.post('/api/workflow/cancel', (req: Request, res: Response) => {
  workflowEngine.cancel();
  res.json({ success: true, message: 'Đã hủy toàn bộ workflow batch.' });
});

/** Xóa lịch sử task */
app.delete('/api/workflow/history', (req: Request, res: Response) => {
  try {
    workflowEngine.clearHistory();
    res.json({ success: true, message: 'Đã xóa lịch sử workflow.' });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/** Chạy lại các task bị failed trong batch hiện tại */
app.post('/api/workflow/retry-failed', (req: Request, res: Response) => {
  try {
    const { concurrency } = req.body;
    const result = workflowEngine.retryFailed(concurrency);
    res.json({
      success: true,
      ...result,
      message: `Đã đưa ${result.retriedCount} task(s) vào queue retry. Bỏ qua ${result.skippedCount} task(s) not-found.`,
    });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/** Metadata báo cáo YouTube của lần chạy gần nhất (UI dùng để hiện nút tải file). */
app.get('/api/workflow/youtube-report', (req: Request, res: Response) => {
  const report = youtubeRunStore.getLastReport();
  if (!report) {
    res.json({ success: true, report: null });
    return;
  }
  // KHÔNG trả `filePath` (đường dẫn tuyệt đối trên máy) ra ngoài.
  const { filePath, ...safe } = report;
  res.json({ success: true, report: safe });
});

/** Tải file .xlsx của lần chạy gần nhất. Đường dẫn do server giữ, client KHÔNG truyền path. */
app.get('/api/workflow/youtube-report/download', (req: Request, res: Response) => {
  const report = youtubeRunStore.getLastReport();
  if (!report) {
    res.status(404).json({ success: false, error: 'Chưa có báo cáo YouTube nào trong phiên này.' });
    return;
  }
  if (!fs.existsSync(report.filePath)) {
    res.status(404).json({ success: false, error: `Không tìm thấy file báo cáo ${report.fileName} trên máy.` });
    return;
  }
  res.download(report.filePath, report.fileName);
});

/**
 * Kho Channel ID đã lưu theo từng profile. Đây là dữ liệu duy nhất khiến lượt chạy sau
 * KHÔNG phải mở trình duyệt, nên UI cần xem/xoá được từng dòng.
 */
app.get('/api/youtube/channels', (req: Request, res: Response) => {
  res.json({ success: true, total: youtubeChannelCache.size(), channels: youtubeChannelCache.list() });
});

/** Xoá một ánh xạ (profile đổi kênh / đọc sai) -> lượt sau đọc lại từ trình duyệt. */
app.delete('/api/youtube/channels/:provider/:profileId', (req: Request, res: Response) => {
  const provider = String(req.params.provider || '');
  const profileId = String(req.params.profileId || '');
  if (!isBrowserProviderId(provider)) {
    res.status(400).json({ success: false, error: `Provider không hợp lệ: "${provider}".` });
    return;
  }
  const removed = youtubeChannelCache.forget(provider, profileId);
  if (!removed) {
    res.status(404).json({ success: false, error: 'Không có Channel ID đã lưu cho profile này.' });
    return;
  }
  res.json({ success: true, message: 'Đã xoá Channel ID đã lưu của profile.' });
});

/** Xoá toàn bộ kho. Thao tác không thể hoàn tác -> UI phải hỏi xác nhận trước khi gọi. */
app.delete('/api/youtube/channels', (req: Request, res: Response) => {
  const removed = youtubeChannelCache.clear();
  logger.warn(`[YouTube API] Đã xoá toàn bộ kho Channel ID (${removed} bản ghi).`);
  res.json({ success: true, removed, message: `Đã xoá ${removed} Channel ID đã lưu.` });
});


// ==========================================
// ACCOUNT HUB (feature-flagged subsystem)
// Router is null when ACCOUNT_HUB_ENABLED=false — nothing is registered.
// ==========================================
const accountHubRouter = createAccountHubRouter();
if (accountHubRouter) app.use('/api/account-hub', accountHubRouter);

// Fallback 404 JSON handler for all /api/* routes to prevent serving HTML 404 pages

app.use('/api/*', (req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: `API route [${req.method} ${req.originalUrl}] không tồn tại. Nếu bạn vừa cập nhật tính năng mới, vui lòng khởi động lại server (npm start).`,
  });
});

