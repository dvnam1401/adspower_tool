import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { adsPowerClient } from '../adspower/client.js';
import { skillRepository } from '../skills/repository.js';
import { cdpManager } from '../dom/cdp.js';
import { facebookLoginAutomation } from '../automation/facebook-login.js';
import { batchFacebookLoginRunner } from '../automation/batch-runner.js';
import { config, updateSystemConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { sendTelegramMessage } from '../utils/telegram.js';
import { authRepository } from '../auth/repository.js';
import { authMiddleware, AuthenticatedRequest } from '../auth/middleware.js';
import { Skill, DOMAction } from '../types/index.js';
// Phase 6: Self-Healing Agent
import { healingLog } from '../recovery/healing-log.js';
import { errorClassifier } from '../recovery/classifier.js';
import { llmAgentResolver } from '../agent/resolver.js';
// Phase 7: Workflow Engine
import { workflowEngine, WORKFLOW_PRESETS } from '../workflow/engine.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../../public');

export const app = express();

app.use(cors());
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

// Inject broadcast function into Workflow Engine (Phase 7)
workflowEngine.setBroadcast(broadcastEvent);


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
    windowLayout: config.windowLayout,
  });
});

app.post('/api/config', (req: Request, res: Response) => {
  try {
    const { maxProfiles, profileStartTimeoutMs, domActionTimeoutMs, adspowerUrl, llm, telegram, automation, windowLayout } = req.body;
    
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

    broadcastEvent('config_updated', {
      concurrencyLimit: updated.concurrency.maxProfiles,
      config: updated,
    });

    res.json({
      success: true,
      message: 'Cập nhật cấu hình hệ thống thành công!',
      config: updated,
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

    const launchArgs = getWindowPositionLaunchArgs(activeConnections.size);

    const connData = await adsPowerClient.startBrowser({
      profileId,
      profileNo,
      headless: !!headless,
      deleteCache: !!deleteCache,
      launchArgs,
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
      const launchArgs = getWindowPositionLaunchArgs(i);
      try {
        const connData = await adsPowerClient.startBrowser({ profileId: id, launchArgs });
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
// 4. SKILL LIBRARY ENDPOINTS
// ==========================================
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
    const { profileIds, profileIdentifiers, workflowName, steps, concurrency } = req.body;

    const targetList = profileIdentifiers || profileIds;
    if (!Array.isArray(targetList) || targetList.length === 0) {
      return res.status(400).json({ error: 'Cần danh sách profileIds hoặc profileIdentifiers' });
    }
    if (!workflowName) {
      return res.status(400).json({ error: 'Cần workflowName' });
    }

    logger.info(`[Workflow API] Khởi chạy batch: ${targetList.length} profiles, workflow="${workflowName}", concurrency=${concurrency || 5}`);

    const result = await workflowEngine.runBatch({
      profileIdentifiers: targetList,
      workflowName,
      steps,
      concurrency: concurrency || config.concurrency.maxProfiles,
    });

    res.json({ success: true, ...result });
  } catch (err: any) {

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

// ==========================================
// YOUTUBE CHANNEL CHECKER APIS
// ==========================================

function parseYouTubeChannelInput(input: string): { type: 'id' | 'handle' | 'username'; value: string } | null {
  let trimmed = input.trim();
  if (!trimmed) return null;

  // URL-decode percent-encoded characters (e.g. Thai, Arabic, CJK handles like %E0%B8%98...)
  try {
    trimmed = decodeURIComponent(trimmed);
  } catch {
    // If decoding fails (malformed %), use original string
  }

  // Remove trailing ? or # query/fragment if any
  trimmed = trimmed.split('?')[0].split('#')[0].trim();

  // Bare channel ID: starts with UC and is 24 chars
  if (/^UC[\w-]{22}$/.test(trimmed)) {
    return { type: 'id', value: trimmed };
  }

  // Bare @handle (including Unicode/non-ASCII handles)
  if (trimmed.startsWith('@')) {
    return { type: 'handle', value: trimmed.slice(1) };
  }

  // YouTube URL patterns — use [^/?&#]+ to support Unicode handles (Thai, Arabic, CJK, etc.)
  const urlMatch = trimmed.match(/(?:youtube\.com)\/(channel\/(UC[\w-]{22})|@([^/?&#\s]+)|user\/([^/?&#\s]+)|c\/([^/?&#\s]+))/i);
  if (urlMatch) {
    if (urlMatch[2]) return { type: 'id', value: urlMatch[2] };
    if (urlMatch[3]) return { type: 'handle', value: urlMatch[3] };
    if (urlMatch[4]) return { type: 'username', value: urlMatch[4] };
    if (urlMatch[5]) return { type: 'handle', value: urlMatch[5] };
  }

  // Bare text without URL markers — assume handle (allow Unicode, no / or :)
  if (!trimmed.includes('/') && !trimmed.includes(':') && trimmed.length > 0) {
    return { type: 'handle', value: trimmed };
  }

  return null;
}

function formatChannelResult(item: any, originalInput: string) {
  const stats = item.statistics || {};
  const snippet = item.snippet || {};
  const thumbnail =
    snippet.thumbnails?.medium?.url ||
    snippet.thumbnails?.default?.url ||
    '';
  const hiddenSubscribers = Boolean(stats.hiddenSubscriberCount);
  return {
    id: item.id,
    originalInput,
    title: snippet.title || '',
    handle: snippet.customUrl || '',
    description: (snippet.description || '').substring(0, 200),
    thumbnail,
    publishedAt: snippet.publishedAt || '',
    country: snippet.country || '',
    subscribers: hiddenSubscribers ? null : parseInt(stats.subscriberCount || '0', 10),
    hiddenSubscribers,
    totalViews: parseInt(stats.viewCount || '0', 10),
    videoCount: parseInt(stats.videoCount || '0', 10),
    url: snippet.customUrl
      ? `https://www.youtube.com/${snippet.customUrl}`
      : `https://www.youtube.com/channel/${item.id}`,
  };
}

async function fetchYouTubeChannel(
  type: 'id' | 'handle' | 'username',
  value: string,
  apiKey: string,
  originalInput: string
): Promise<{ result?: any; error?: string }> {
  const base = 'https://www.googleapis.com/youtube/v3/channels';
  const parts = 'snippet,statistics';

  const paramMap: Record<string, string> = {
    id: 'id',
    handle: 'forHandle',
    username: 'forUsername',
  };
  const param = paramMap[type];

  const url = `${base}?part=${parts}&${param}=${encodeURIComponent(value)}&key=${encodeURIComponent(apiKey)}`;

  try {
    const res = await fetch(url);
    const data: any = await res.json();

    if (data.error) {
      return { error: `YouTube API: ${data.error.message}` };
    }

    if (data.items && data.items.length > 0) {
      return { result: formatChannelResult(data.items[0], originalInput) };
    }

    // Fallback: if handle failed, try username
    if (type === 'handle') {
      const url2 = `${base}?part=${parts}&forUsername=${encodeURIComponent(value)}&key=${encodeURIComponent(apiKey)}`;
      const res2 = await fetch(url2);
      const data2: any = await res2.json();
      if (data2.items && data2.items.length > 0) {
        return { result: formatChannelResult(data2.items[0], originalInput) };
      }
    }

    return { error: 'Không tìm thấy kênh.' };
  } catch (err: any) {
    return { error: err.message };
  }
}

async function fetchChannelVideos(
  channelId: string,
  apiKey: string,
  maxResults: number
): Promise<any[]> {
  const playlistId = 'UU' + channelId.slice(2);
  const videoIds: string[] = [];
  let pageToken: string | undefined;

  while (videoIds.length < maxResults) {
    const batchSize = Math.min(50, maxResults - videoIds.length);
    let piUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&playlistId=${encodeURIComponent(playlistId)}&maxResults=${batchSize}&key=${encodeURIComponent(apiKey)}`;
    if (pageToken) piUrl += `&pageToken=${encodeURIComponent(pageToken)}`;
    try {
      const piRes = await fetch(piUrl);
      const piData: any = await piRes.json();
      if (piData.error || !piData.items) break;
      for (const item of piData.items) {
        const vid = item.contentDetails?.videoId;
        if (vid) videoIds.push(vid);
      }
      if (!piData.nextPageToken) break;
      pageToken = piData.nextPageToken;
    } catch { break; }
  }

  if (videoIds.length === 0) return [];

  const videos: any[] = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const vUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${encodeURIComponent(batch.join(','))}&key=${encodeURIComponent(apiKey)}`;
    try {
      const vRes = await fetch(vUrl);
      const vData: any = await vRes.json();
      if (vData.error || !vData.items) break;
      for (const item of vData.items) {
        const s = item.snippet || {};
        const stats = item.statistics || {};
        videos.push({
          id: item.id,
          title: s.title || '',
          url: `https://www.youtube.com/watch?v=${item.id}`,
          thumbnail: s.thumbnails?.medium?.url || s.thumbnails?.default?.url || '',
          publishedAt: s.publishedAt || '',
          viewCount: parseInt(stats.viewCount || '0', 10),
          likeCount: parseInt(stats.likeCount || '0', 10),
          commentCount: parseInt(stats.commentCount || '0', 10),
        });
      }
    } catch { break; }
  }
  return videos;
}

app.get('/api/youtube/config', (req: Request, res: Response) => {
  res.json({ success: true, hasKey: Boolean(config.youtube?.apiKey) });
});

app.post('/api/youtube/save-key', (req: Request, res: Response) => {
  const { apiKey } = req.body;
  if (!apiKey || typeof apiKey !== 'string') {
    return res.status(400).json({ success: false, error: 'Vui lòng nhập YouTube API Key.' });
  }
  updateSystemConfig({ youtube: { apiKey: apiKey.trim() } });
  res.json({ success: true, message: 'Đã lưu YouTube API Key.' });
});

app.post('/api/youtube/check-channels', async (req: Request, res: Response) => {
  const { channels, youtubeApiKey, maxVideos } = req.body;
  const apiKey = (youtubeApiKey || '').trim() || (config.youtube?.apiKey || '');
  const videosPerChannel = Math.min(50, Math.max(0, parseInt(String(maxVideos ?? '10'), 10)));

  if (!apiKey) {
    return res.status(400).json({
      success: false,
      error: 'Chưa có YouTube API Key. Vui lòng nhập và lưu API Key trong tab YouTube.',
    });
  }

  if (!Array.isArray(channels) || channels.length === 0) {
    return res.status(400).json({ success: false, error: 'Danh sách kênh không được rỗng.' });
  }

  if (channels.length > 50) {
    return res.status(400).json({ success: false, error: 'Tối đa 50 kênh mỗi lần kiểm tra.' });
  }

  const results: any[] = [];
  const errors: { input: string; error: string }[] = [];

  for (const rawInput of channels) {
    const input = String(rawInput).trim();
    if (!input) continue;

    const parsed = parseYouTubeChannelInput(input);
    if (!parsed) {
      errors.push({ input, error: 'Không thể nhận dạng định dạng kênh.' });
      continue;
    }

    const { result, error } = await fetchYouTubeChannel(parsed.type, parsed.value, apiKey, input);
    if (error) {
      errors.push({ input, error });
    } else if (result) {
      if (videosPerChannel > 0) {
        result.videos = await fetchChannelVideos(result.id, apiKey, videosPerChannel);
      } else {
        result.videos = [];
      }
      results.push(result);
    }
  }

  res.json({ success: true, results, errors, total: results.length, errorCount: errors.length });
});

// Fallback 404 JSON handler for all /api/* routes to prevent serving HTML 404 pages
app.use('/api/*', (req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: `API route [${req.method} ${req.originalUrl}] không tồn tại. Nếu bạn vừa cập nhật tính năng mới, vui lòng khởi động lại server (npm start).`,
  });
});

