/**
 * Workflow Engine — Batch Concurrency Limiter với Checkpoint
 *
 * Tính năng:
 * - Queue điều phối batch với giới hạn concurrency (ví dụ: tối đa 5 profile cùng lúc).
 * - Checkpoint lưu trạng thái từng bước để phục hồi nếu dừng đột ngột.
 * - Điều khiển: pause / resume / cancel.
 * - SSE broadcast: workflow_task_update cho UI real-time.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  WorkflowTask,
  WorkflowStep,
  WorkflowCheckpoint,
  WorkflowEngineState,
  WorkflowTaskProgress,
  WorkflowBatchStatus,
  TaskStatus,
  AdsPowerProfileInfo,
  BrowserProviderId,
} from '../types/index.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import { adsPowerClient } from '../adspower/client.js';
import { cdpManager } from '../dom/cdp.js';
import { healingOrchestrator } from '../recovery/healing-orchestrator.js';
import { popupKiller } from '../dom/popup-killer.js';
import { synthesizeBatchReportAndNotify } from '../utils/telegram.js';
import { facebookLoginAutomation, type FacebookLoginResult } from '../automation/facebook-login.js';
import { getProvider } from '../providers/index.js';
import { DEFAULT_BROWSER_PROVIDER, type BrowserProfileProvider } from '../providers/types.js';
import type { Page } from 'playwright-core';
import {
  buildExecutionMapping,
  formatCountMismatch,
  parseGoogleAccountLines,
  type ExecutionMappingEntry,
  type GoogleAccountInput,
  type MappingProfileInput,
  type ProfileAccountSecret,
} from '../automation/google-account-input.js';
import { googleLoginAutomation, maskEmail } from '../automation/google-login.js';
import type { GoogleLoginCredentials } from '../automation/google-login.types.js';
import { collectYoutubeChannelId } from '../automation/youtube-channel.js';
import { channelUrlFor, getYoutubeDataApiClient } from '../youtube/data-api.js';
import { youtubeRunStore } from '../youtube/report-store.js';
import { youtubeChannelCache } from '../youtube/channel-cache.js';
import { writeYoutubeReport, type YoutubeReportProfile } from '../youtube/xlsx-report.js';


// Broadcast function will be injected from app.ts
type BroadcastFn = (event: string, data: any) => void;

/**
 * Lỗi ĐẦU VÀO (người dùng sửa được): lệch số lượng, sai định dạng dòng tài khoản,
 * trùng profile, thiếu tài khoản... Được đánh dấu để API trả 400 thay vì 500.
 * KHÔNG mở bất kỳ profile nào khi lỗi loại này xảy ra.
 */
export interface WorkflowValidationError extends Error {
  validation: true;
}

export function isWorkflowValidationError(err: unknown): err is WorkflowValidationError {
  return err instanceof Error && (err as Partial<WorkflowValidationError>).validation === true;
}

function validationError(message: string): WorkflowValidationError {
  const err = new Error(message) as WorkflowValidationError;
  err.validation = true;
  return err;
}

/**
 * Xung đột trạng thái: engine là singleton, `runBatch` xoá state batch trước đó.
 * Nếu đang có batch chạy (kể cả provider khác) thì TỪ CHỐI thay vì cướp state.
 * API trả 409.
 */
export interface WorkflowConflictError extends Error {
  conflict: true;
}

export function isWorkflowConflictError(err: unknown): err is WorkflowConflictError {
  return err instanceof Error && (err as Partial<WorkflowConflictError>).conflict === true;
}

function conflictError(message: string): WorkflowConflictError {
  const err = new Error(message) as WorkflowConflictError;
  err.conflict = true;
  return err;
}

// ─── Workflow Presets ───────────────────────────────────────────────────────────

export const WORKFLOW_PRESETS: Record<string, { name: string; steps: WorkflowStep[] }> = {
  facebook_login: {
    name: 'Facebook Auto Login',
    steps: [
      {
        stepId: 'facebook_login',
        name: 'Đăng nhập Facebook',
        action: {
          actionType: 'facebook_login',
          targetDescription: 'Đăng nhập tài khoản Facebook',
          timeoutMs: 120000,
        },
      },
      {
        stepId: 'screenshot',
        name: 'Chụp màn hình xác nhận',
        action: {
          actionType: 'screenshot',
          targetDescription: 'Current page state',
          optional: true,
        },
      },
    ],
  },
  google_account_login: {
    name: 'Google Account Login Test',
    steps: [
      {
        stepId: 'google_login',
        name: 'Đăng nhập Google',
        action: {
          actionType: 'google_login',
          targetDescription: 'Đăng nhập tài khoản Google',
          timeoutMs: 120000,
        },
      },
    ],
  },
  get_token_cookie: {
    name: 'Get Token Cookie Extension',
    steps: [
      {
        stepId: 'open_extension',
        name: 'Mở trang extension Get Token Cookie',
        action: {
          actionType: 'navigate',
          targetDescription: 'Extension Popup',
          // Mở trực tiếp giao diện popup của extension thông qua ID của nó
          value: 'chrome-extension://naciaagbkifhpnoodlkhbejjldaiffcm/popup.html',
          timeoutMs: 15000
        },
      },
      {
        stepId: 'screenshot',
        name: 'Chụp màn hình extension',
        action: { actionType: 'screenshot', targetDescription: 'Extension state', optional: true },
      },
    ],
  },
  youtube_channel_videos: {
    name: 'YouTube: Tổng Hợp Video Theo Profile',
    steps: [
      {
        stepId: 'youtube_channel_collect',
        name: 'Đọc Channel ID từ profile',
        action: {
          actionType: 'youtube_channel_collect',
          targetDescription: 'Channel ID của kênh đang đăng nhập',
          timeoutMs: 60000,
        },
      },
      {
        stepId: 'youtube_videos_fetch',
        name: 'Lấy video + lượt xem qua YouTube Data API',
        action: {
          actionType: 'youtube_videos_fetch',
          targetDescription: 'Toàn bộ video đã đăng của kênh',
          timeoutMs: 300000,
        },
      },
    ],
  },
};

/** Nhãn tiếng Việt cho báo cáo Excel, map từ `TaskStatus` canon — KHÔNG tạo enum mới. */
const YOUTUBE_STATUS_LABEL: Record<TaskStatus, string> = {
  pending: 'CHƯA CHẠY',
  running: 'ĐANG CHẠY',
  completed: 'THÀNH CÔNG',
  failed: 'THẤT BẠI',
  paused: 'TẠM DỪNG',
  escalated: 'CẦN NGƯỜI XỬ LÝ',
};

/**
 * Kênh tồn tại nhưng chưa có video công khai KHÔNG phải thất bại: task vẫn `completed`
 * (browser auto-close như mọi profile thành công), chỉ nhãn hiển thị trong Excel khác đi.
 * Đây là NHÃN hiển thị, KHÔNG phải `TaskStatus` mới (RULES §28).
 */
const YOUTUBE_EMPTY_CHANNEL_LABEL = 'CHƯA CÓ VIDEO';

/**
 * Chọn credential PER-PROFILE từ chính profile AdsPower tương ứng.
 * Dùng CÙNG thứ tự ưu tiên như luồng Facebook:
 *   username: profile.username || platform_account[0].login_user
 *   password: profile.password || platform_account[0].password
 * KHÔNG có fallback sang credential của profile khác — thiếu thì trả null (profile đó sẽ FAIL riêng).
 * Thuần (pure), không side-effect → dễ unit-test.
 */
export type ProfileCredentials = { username: string; password: string };

export function selectProfileCredentials(
  profile: AdsPowerProfileInfo
): ProfileCredentials | null {
  const username = profile.username || profile.platform_account?.[0]?.login_user || '';
  const password = profile.password || profile.platform_account?.[0]?.password || '';
  if (!username || !password) return null;
  return { username, password };
}

// ─── Workflow Engine ────────────────────────────────────────────────────────────

export class WorkflowEngine {
  private engineState: WorkflowEngineState = 'idle';
  private tasks: Map<string, WorkflowTask> = new Map();
  private taskProgress: Map<string, WorkflowTaskProgress> = new Map();
  private checkpointPath: string;
  private broadcastFn: BroadcastFn | null = null;

  // Queue control
  private runningCount = 0;
  private concurrencyLimit = 5;
  private queue: string[] = []; // taskIds waiting to run
  private pausePromiseResolve: (() => void) | null = null;
  private isPaused = false;
  private isCancelled = false;
  // Per-profile credentials keyed by AdsPower user_id; in-memory ONLY, never persisted.
  private batchProfileCredentials: Map<string, ProfileCredentials> = new Map();
  /**
   * Tài khoản Google do NGƯỜI DÙNG cung cấp, keyed theo profileId thật.
   * RAM-only, KHÔNG BAO GIỜ ghi log / checkpoint / SSE.
   *
   * Khác `batchProfileCredentials` (xoá ngay sau mỗi task vì có thể lấy lại từ
   * AdsPower): nguồn này KHÔNG thể lấy lại được, nên phải giữ đến hết batch để
   * `retryFailed()` còn chạy được. Xoá khi bắt đầu batch mới hoặc khi cancel.
   */
  private batchGoogleAccounts: Map<string, ProfileAccountSecret> = new Map();
  /** Mapping vị trí (bất biến) của batch hiện tại — thứ tự hiển thị kết quả. */
  private batchMapping: readonly ExecutionMappingEntry[] = [];
  /** Tra cứu O(1) thứ tự gốc theo profileId (hoặc identifier với profile not-found). */
  private batchMappingIndex: Map<string, number> = new Map();
  /** Override đóng-khi-thành-công của batch; `null` = theo provider/config. */
  private batchAutoCloseSuccess: boolean | null = null;
  /**
   * `true` = bỏ qua kho Channel ID đã lưu, mở profile đọc lại từ đầu.
   * Mặc định `false`: profile đã có Channel ID thì KHÔNG mở trình duyệt nữa.
   */
  private batchRefreshChannels = false;

  constructor() {
    this.checkpointPath = path.resolve(
      path.dirname(config.storage.databasePath),
      'workflow-checkpoints.json'
    );
    this.loadCheckpoints();
  }

  /** Inject broadcast function từ server */
  public setBroadcast(fn: BroadcastFn) {
    this.broadcastFn = fn;
  }

  // ─── Checkpoint Persistence ─────────────────────────────────────────────────

  private loadCheckpoints() {
    if (!fs.existsSync(this.checkpointPath)) return;
    try {
      const raw = fs.readFileSync(this.checkpointPath, 'utf8');
      const checkpoints: WorkflowCheckpoint[] = JSON.parse(raw);
      logger.info(`[WorkflowEngine] Tải ${checkpoints.length} checkpoints từ đĩa.`);
      // Restore paused/interrupted tasks
      for (const cp of checkpoints) {
        if (cp.status === 'running' || cp.status === 'paused') {
          logger.warn(`[WorkflowEngine] Task ${cp.taskId} bị gián đoạn tại step ${cp.currentStepIndex} — có thể resume.`);
        }
      }
    } catch (err: any) {
      logger.error(`[WorkflowEngine] Lỗi đọc checkpoint: ${err.message}`);
    }
  }

  private saveCheckpoint(task: WorkflowTask) {
    try {
      const dir = path.dirname(this.checkpointPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // Load existing checkpoints
      let checkpoints: WorkflowCheckpoint[] = [];
      if (fs.existsSync(this.checkpointPath)) {
        try {
          checkpoints = JSON.parse(fs.readFileSync(this.checkpointPath, 'utf8'));
        } catch {}
      }

      const cp: WorkflowCheckpoint = {
        taskId: task.taskId,
        profileId: task.profileId,
        workflowName: task.workflowName,
        currentStepIndex: task.currentStepIndex,
        status: task.status,
        stateJson: JSON.stringify(task.resultData || {}),
        updatedAt: new Date().toISOString(),
      };

      const idx = checkpoints.findIndex(c => c.taskId === task.taskId);
      if (idx >= 0) {
        checkpoints[idx] = cp;
      } else {
        checkpoints.push(cp);
      }

      // Giữ tối đa 200 checkpoints
      if (checkpoints.length > 200) {
        checkpoints = checkpoints.slice(checkpoints.length - 200);
      }

      fs.writeFileSync(this.checkpointPath, JSON.stringify(checkpoints, null, 2), 'utf8');
    } catch (err: any) {
      logger.error(`[WorkflowEngine] Lưu checkpoint thất bại: ${err.message}`);
    }
  }

  // ─── Progress Tracking & Broadcast ─────────────────────────────────────────

  private updateProgress(task: WorkflowTask, message?: string) {
    const totalSteps = task.steps.length;
    const progressPercent = totalSteps > 0
      ? Math.round((task.currentStepIndex / totalSteps) * 100)
      : 0;

    const progress: WorkflowTaskProgress = {
      taskId: task.taskId,
      profileId: task.profileId,
      profileName: task.profileName || task.profileId,
      provider: task.provider ?? DEFAULT_BROWSER_PROVIDER,
      mappingIndex: this.batchMappingIndex.get(task.profileId),
      // Email ĐÃ CHE — an toàn cho SSE/log. KHÔNG BAO GIỜ đưa email đầy đủ vào đây.
      accountEmailMasked: this.batchGoogleAccounts.has(task.profileId)
        ? maskEmail(this.batchGoogleAccounts.get(task.profileId)!.email)
        : undefined,
      workflowName: task.workflowName,
      status: task.status,
      currentStepIndex: task.currentStepIndex,
      totalSteps,
      progressPercent,
      currentStepName: task.steps[task.currentStepIndex]?.name,
      message,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      errorMessage: task.errorMessage,
      cleanupState: task.cleanupState,
      browserOpen: task.browserOpen,
    };

    // Chỉ gắn loginState cho workflow Google Account Login (không ảnh hưởng Facebook).
    const isGoogleWorkflow = task.steps.some(s => s.action.actionType === 'google_login');
    if (isGoogleWorkflow || task.resultData?.loginState !== undefined) {
      if (task.status === 'pending') {
        progress.loginState = 'QUEUED';
      } else if (task.status === 'running') {
        progress.loginState = 'RUNNING';
      } else if (task.resultData?.loginState) {
        progress.loginState = task.resultData.loginState;
      }
    }

    this.taskProgress.set(task.taskId, progress);

    if (this.broadcastFn) {
      this.broadcastFn('workflow_task_update', progress);
    }
  }


  // ─── Pause / Resume / Cancel ────────────────────────────────────────────────

  public pause() {
    if (this.engineState !== 'running') return;
    this.isPaused = true;
    this.engineState = 'paused';
    logger.warn('[WorkflowEngine] ⏸ Tạm dừng tất cả tasks trong queue.');
    if (this.broadcastFn) {
      this.broadcastFn('workflow_engine_state', { state: 'paused' });
    }
  }

  public resume() {
    if (this.engineState !== 'paused') return;
    this.isPaused = false;
    this.engineState = 'running';
    logger.info('[WorkflowEngine] ▶ Tiếp tục workflow engine.');
    if (this.pausePromiseResolve) {
      this.pausePromiseResolve();
      this.pausePromiseResolve = null;
    }
    if (this.broadcastFn) {
      this.broadcastFn('workflow_engine_state', { state: 'running' });
    }
    // Kick off queue processing
    this.drainQueue();
  }

  public cancel() {
    this.isCancelled = true;
    this.isPaused = false;
    this.queue = [];
    this.batchProfileCredentials.clear(); // Không giữ credentials sau khi hủy (bảo mật)
    this.batchGoogleAccounts.clear(); // Tài khoản người dùng dán cũng bị xoá khỏi RAM
    this.engineState = 'cancelling';
    logger.warn('[WorkflowEngine] ❌ Hủy toàn bộ workflow batch.');

    // Mark pending tasks as failed
    for (const [, task] of this.tasks) {
      if (task.status === 'pending' || task.status === 'paused') {
        task.status = 'failed';
        task.errorMessage = 'Hủy bởi người dùng';
        task.finishedAt = new Date().toISOString();
        this.updateProgress(task, 'Đã hủy');
      }
    }

    if (this.pausePromiseResolve) {
      this.pausePromiseResolve();
    }

    if (this.broadcastFn) {
      this.broadcastFn('workflow_engine_state', { state: 'cancelled' });
    }
  }

  // ─── Wait for pause/resume ──────────────────────────────────────────────────

  private async waitIfPaused(): Promise<void> {
    if (!this.isPaused) return;
    logger.info('[WorkflowEngine] Task đang chờ resume...');
    await new Promise<void>(resolve => {
      this.pausePromiseResolve = resolve;
    });
  }

  // ─── Queue Management ───────────────────────────────────────────────────────

  private async drainQueue() {
    while (this.queue.length > 0 && this.runningCount < this.concurrencyLimit) {
      if (this.isCancelled) break;
      if (this.isPaused) break;

      const taskId = this.queue.shift()!;
      const task = this.tasks.get(taskId);
      if (!task) continue;

      this.runningCount++;
      this.runTask(task).finally(() => {
        this.runningCount--;
        // Try to run next task from queue
        this.drainQueue();
        // Check if all done
        this.checkBatchCompletion();
      });
    }
  }

  private checkBatchCompletion() {
    if (this.queue.length === 0 && this.runningCount === 0 && !this.isCancelled) {
      const allDone = Array.from(this.tasks.values()).every(
        t => t.status === 'completed' || t.status === 'failed' || t.status === 'escalated'
      );
      if (allDone && this.engineState === 'running') {
        this.engineState = 'idle';
        logger.info('[WorkflowEngine] ✅ Toàn bộ batch hoàn thành.');
        if (this.broadcastFn) {
          this.broadcastFn('workflow_batch_completed', this.getBatchStatus());
        }

        // Batch YouTube xuất file Excel; batch khác giữ nguyên báo cáo AI + Telegram.
        if (this.isYoutubeReportBatch()) {
          this.finalizeYoutubeReport().catch(err => {
            logger.error(`[WorkflowEngine YouTube Report Error] ${err.message}`);
          });
        } else {
          this.synthesizeWorkflowReportAndNotify().catch(err => {
            logger.error(`[WorkflowEngine Telegram Error] ${err.message}`);
          });
        }
      }
    }
  }

  /**
   * Tổng hợp báo cáo kết quả của toàn bộ Workflow Batch và gửi tin nhắn Telegram
   */
  private async synthesizeWorkflowReportAndNotify(): Promise<void> {
    try {
      const tasksList = Array.from(this.tasks.values());
      if (tasksList.length === 0) return;

      let startTimeMs = Date.now();
      let endTimeMs = Date.now();

      tasksList.forEach(t => {
        if (t.startedAt) {
          const s = new Date(t.startedAt).getTime();
          if (s < startTimeMs) startTimeMs = s;
        }
        if (t.finishedAt) {
          const f = new Date(t.finishedAt).getTime();
          if (f > endTimeMs) endTimeMs = f;
        }
      });

      let successCount = 0;
      let checkpointCount = 0;
      let failedCount = 0;
      // Google Account Login: đếm theo loginState (chỉ tính khi task có loginState).
      let googleLoginTaskCount = 0;
      const loginStateCounts: Record<string, number> = { SUCCESS: 0, FAILED: 0, TIMEOUT: 0, VERIFICATION_REQUIRED: 0, NEEDS_HUMAN_REVIEW: 0 };

      const results = tasksList.map(t => {
        const errText = (t.errorMessage || '').toLowerCase();
        const loginState = t.resultData?.loginState as string | undefined;
        // Chỉ dùng dữ liệu đã làm sạch (loginState + message đã che) — không chứa credentials/2FA.
        const sanitizedMessage = t.resultData?.google_login?.message || t.errorMessage || 'Thực hiện workflow hoàn tất';
        let statusStr = 'failed';

        if (loginState) {
          // Google Account Login — phân loại theo loginState; chỉ SUCCESS mới tính là thành công.
          googleLoginTaskCount++;
          if (loginState in loginStateCounts) loginStateCounts[loginState]++;
          switch (loginState) {
            case 'SUCCESS':
              statusStr = 'logged_in';
              successCount++;
              break;
            case 'VERIFICATION_REQUIRED':
              statusStr = 'verification_required';
              checkpointCount++;
              break;
            case 'NEEDS_HUMAN_REVIEW':
              statusStr = 'needs_human_review';
              checkpointCount++;
              break;
            case 'TIMEOUT':
              statusStr = 'timeout';
              failedCount++;
              break;
            default:
              statusStr = 'failed';
              failedCount++;
          }
        } else if (t.status === 'completed') {
          statusStr = 'logged_in';
          successCount++;
        } else if (errText.includes('checkpoint') || errText.includes('xác thực') || errText.includes('confirm')) {
          statusStr = 'checkpoint_human_verification';
          checkpointCount++;
        } else {
          failedCount++;
        }

        return {
          identifier: t.identifier || t.profileId,
          profileId: t.profileId,
          profileName: t.profileName || t.profileId,
          error: t.errorMessage,
          result: {
            success: loginState ? loginState === 'SUCCESS' : t.status === 'completed',
            // Báo cáo tái dùng shape FacebookLoginResult; trạng thái Google được so sánh dạng chuỗi ở downstream.
            status: statusStr as unknown as FacebookLoginResult['status'],
            message: sanitizedMessage,
            profileId: t.profileId,
            profileName: t.profileName || t.profileId,
            currentUrl: ''
          },
          startTime: t.startedAt || new Date().toISOString(),
          endTime: t.finishedAt,
          durationMs: t.startedAt && t.finishedAt ? new Date(t.finishedAt).getTime() - new Date(t.startedAt).getTime() : 0
        };
      });

      const summary = {
        total: tasksList.length,
        completed: tasksList.filter(t => t.status === 'completed' || t.status === 'failed' || t.status === 'escalated').length,
        successCount,
        alreadyLoggedInCount: 0,
        checkpointCount,
        failedCount,
        ...(googleLoginTaskCount > 0 ? { loginStateCounts } : {}),
        startTime: new Date(startTimeMs).toISOString(),
        endTime: new Date(endTimeMs).toISOString(),
        totalDurationMs: Math.max(1000, endTimeMs - startTimeMs),
        results
      };

      logger.info(`[WorkflowEngine Telegram] Bắt đầu tổng hợp báo cáo AI cho đợt chạy ${tasksList.length} profiles...`);
      await synthesizeBatchReportAndNotify(summary);
    } catch (err: any) {
      logger.error(`[WorkflowEngine Telegram Report Fail] ${err.message}`);
    }
  }

  /** Batch có bước thu Channel ID -> kết quả phải xuất Excel, không phải báo cáo đăng nhập. */
  private isYoutubeReportBatch(): boolean {
    for (const task of this.tasks.values()) {
      if (task.steps.some(s => s.action.actionType === 'youtube_channel_collect')) return true;
    }
    return false;
  }

  /**
   * Gom dữ liệu cả batch -> ghi MỘT file .xlsx -> phát sự kiện cho UI.
   * Thứ tự dòng theo ĐÚNG thứ tự người dùng nhập (mappingIndex), không theo thứ tự chạy xong.
   */
  private async finalizeYoutubeReport(): Promise<void> {
    const tasksList = Array.from(this.tasks.values()).sort(
      (a, b) =>
        (this.batchMappingIndex.get(a.profileId) ?? Number.MAX_SAFE_INTEGER) -
        (this.batchMappingIndex.get(b.profileId) ?? Number.MAX_SAFE_INTEGER)
    );
    if (tasksList.length === 0) return;

    const profiles: YoutubeReportProfile[] = tasksList.map(task => {
      const entry = youtubeRunStore.get(task.profileId);
      const emptyChannel = task.status === 'completed' && entry?.uploadsMissing === true;
      return {
        profileName: task.profileName ?? task.profileId,
        profileId: task.profileId,
        provider: task.provider ?? DEFAULT_BROWSER_PROVIDER,
        channelId: entry?.channelId,
        channelUrl: entry?.channelUrl,
        channelHandle: entry?.channelHandle,
        channelTitle: entry?.channelTitle,
        status: emptyChannel ? YOUTUBE_EMPTY_CHANNEL_LABEL : YOUTUBE_STATUS_LABEL[task.status],
        note: task.errorMessage ?? entry?.note,
        videos: entry?.videos ?? [],
        unavailableCount: entry?.unavailableCount ?? 0,
      };
    });

    const report = await writeYoutubeReport(profiles);
    const summary = profiles.map(p => ({
      profileName: p.profileName,
      channelId: p.channelId,
      channelUrl: p.channelUrl,
      channelTitle: p.channelTitle,
      videoCount: p.videos.length,
      totalViews: p.videos.reduce((sum, video) => sum + (video.viewCount ?? 0), 0),
      status: p.status,
      note: p.note,
    }));
    youtubeRunStore.setLastReport({ ...report, summary });

    logger.info(
      `[WorkflowEngine] 📊 Đã xuất báo cáo YouTube "${report.fileName}": ${report.profileCount} profile, ${report.videoCount} video.`
    );

    if (this.broadcastFn) {
      // KHÔNG gửi đường dẫn tuyệt đối ra UI/SSE — UI tải file qua REST theo tên file.
      this.broadcastFn('youtube_report_ready', {
        fileName: report.fileName,
        generatedAt: report.generatedAt,
        profileCount: report.profileCount,
        videoCount: report.videoCount,
        summary,
      });
    }
  }

  // ─── Task Execution ─────────────────────────────────────────────────────────

  private async runTask(task: WorkflowTask) {
    task.status = 'running';
    task.startedAt = new Date().toISOString();
    this.updateProgress(task, `Bắt đầu: ${task.workflowName}`);
    this.saveCheckpoint(task);

    logger.info(`[WorkflowEngine] Bắt đầu task ${task.taskId} (Profile: ${task.profileId})`);

    try {
      for (let i = task.currentStepIndex; i < task.steps.length; i++) {
        // Check cancel
        if (this.isCancelled) {
          task.status = 'failed';
          task.errorMessage = 'Hủy bởi người dùng';
          break;
        }

        // Wait if paused
        await this.waitIfPaused();
        if (this.isCancelled) {
          task.status = 'failed';
          task.errorMessage = 'Hủy bởi người dùng';
          break;
        }

        const step = task.steps[i];
        task.currentStepIndex = i;
        this.updateProgress(task, `Đang thực hiện: ${step.name}`);
        this.saveCheckpoint(task);

        logger.info(
          `[WorkflowEngine] [${task.profileId}] Step ${i + 1}/${task.steps.length}: ${step.name}`
        );

        // Simulate step execution (hoặc gọi cdpManager trong thực tế)
        await this.executeStep(task, step);

        // Small delay giữa các steps để tránh bị rate limit
        await new Promise(r => setTimeout(r, 300));
      }

      if (task.status === 'running') {
        task.status = 'completed';
        task.currentStepIndex = task.steps.length;
        task.finishedAt = new Date().toISOString();
        logger.info(`[WorkflowEngine] ✅ Task ${task.taskId} COMPLETED (Profile: ${task.profileId})`);

        const provider = getProvider(task.provider ?? DEFAULT_BROWSER_PROVIDER);
        // Ưu tiên: override của batch -> chính sách của provider -> cờ toàn cục (AdsPower).
        const shouldClose =
          this.batchAutoCloseSuccess ?? provider.autoCloseSuccessDefault ?? config.automation.closeSuccessBrowsers;

        // Task không mở trình duyệt (trúng kho Channel ID) -> không có cửa sổ nào để đóng/giữ:
        // gọi stopBrowser lúc này chỉ nhận "User_id is not open" rồi báo CLOSE_FAILED sai sự thật.
        if (task.browserOpen && shouldClose) {
          logger.info(`[WorkflowEngine] 🚪 [Auto-Close] Tự động đóng cửa sổ profile ${task.profileId} sau khi hoàn thành...`);
          // CLOSE-state vs LOGIN-state are independent: a failed close NEVER downgrades a SUCCESS login.
          let closed = false;
          try {
            await cdpManager.disconnect(task.profileId).catch(() => {});
            closed = await provider.stopBrowser(task.profileId);
          } catch (closeErr) {
            const msg = closeErr instanceof Error ? closeErr.message : String(closeErr);
            logger.warn(`[WorkflowEngine] ⚠️ Đóng cửa sổ profile ${task.profileId} thất bại: ${msg}`);
            closed = false;
          }
          if (closed) {
            task.cleanupState = 'CLOSED';
            task.browserOpen = false;
            if (this.broadcastFn) {
              this.broadcastFn('profile_status_change', { profileId: task.profileId, status: 'inactive' });
            }
          } else {
            task.cleanupState = 'CLOSE_FAILED';
            task.browserOpen = true;
            logger.warn(`[WorkflowEngine] ⚠️ Profile ${task.profileId} đăng nhập THÀNH CÔNG nhưng KHÔNG đóng được cửa sổ (CLOSE_FAILED) — giữ mở.`);
          }
        } else if (task.browserOpen) {
          task.cleanupState = 'KEPT_OPEN';
        }

        this.updateProgress(task, 'Hoàn thành thành công ✅');
        this.saveCheckpoint(task);
      }
    } catch (err: any) {
      task.status = 'failed';
      task.errorMessage = err.message;
      task.finishedAt = new Date().toISOString();
      // Thất bại thì luôn giữ cửa sổ cho người thật xem — nhưng chỉ khi task này có mở cửa sổ.
      if (task.browserOpen) task.cleanupState = 'KEPT_OPEN';
      this.updateProgress(task, `Lỗi: ${err.message}`);
      this.saveCheckpoint(task);
      logger.error(`[WorkflowEngine] ❌ Task ${task.taskId} FAILED: ${err.message}`);
    } finally {
      // Clear the in-memory credential reference for this profile promptly (security).
      // Retries re-resolve fresh creds from AdsPower via resolveProfileCredentials().
      this.batchProfileCredentials.delete(task.profileId);
    }
  }

  /**
   * Trả về một tab CÒN SỐNG của profile, kết nối lại nếu cần.
   *
   * Tab có thể chết giữa các step (người dùng đóng, tab crash, provider tắt profile). Dùng lại
   * handle `Page` đã chết khiến mọi phép đọc trả rỗng rồi bị kết luận sai là "không đọc được".
   * `getActivePage` tự chuyển sang tab sống khác; hết tab -> khởi động lại qua provider seam
   * (attach vào cửa sổ có sẵn, KHÔNG mở cửa sổ mới — RULES §29).
   */
  private async ensureLivePage(task: WorkflowTask, provider: BrowserProfileProvider): Promise<Page> {
    const alive = cdpManager.getActivePage(task.profileId);
    // Task này CÓ cửa sổ -> bước kết thúc mới có thứ để dọn (lượt dùng kho Channel ID thì không).
    if (alive) {
      task.browserOpen = true;
      return alive;
    }

    logger.info(`[WorkflowEngine] 🚀 Profile ${task.profileId} chưa kết nối CDP -> Tự động khởi động trình duyệt ${provider.label}...`);
    const { wsEndpoint } = await provider.startBrowser(task.profileId);
    const page = await cdpManager.connect(task.profileId, wsEndpoint);
    await popupKiller.injectInitScript(page);
    task.browserOpen = true;
    if (this.broadcastFn) {
      this.broadcastFn('profile_status_change', { profileId: task.profileId, status: 'active' });
    }
    return page;
  }

  /**
   * Thực thi một step với CDP thực tế và tích hợp Self-Healing
   */
  private async executeStep(task: WorkflowTask, step: WorkflowStep): Promise<void> {
    const action = step.action;
    const providerId = task.provider ?? DEFAULT_BROWSER_PROVIDER;
    const provider = getProvider(providerId);

    // Hai bước YouTube đứng TRƯỚC chỗ mở trình duyệt: bước đọc Channel ID có thể trúng kho đã
    // lưu, bước gọi Data API không cần trình duyệt — mở profile ở đây sẽ vô hiệu hoá cả cái kho.
    if (action.actionType === 'youtube_channel_collect') {
      const collectLabel = task.profileName ?? task.profileId;

      // 1) Kho Channel ID: đã đọc được ở lượt trước -> KHÔNG mở trình duyệt nữa.
      const cached = this.batchRefreshChannels
        ? undefined
        : youtubeChannelCache.get(providerId, task.profileId);
      if (cached) {
        logger.info(`[WorkflowEngine] [${task.profileId}] YouTube: dùng Channel ID đã lưu (${cached.channelId}) — không mở trình duyệt.`);
        this.updateProgress(task, 'Dùng Channel ID đã lưu — không mở trình duyệt');
        task.resultData = {
          ...(task.resultData || {}),
          youtube_channel: {
            ok: true,
            channelId: cached.channelId,
            channelUrl: cached.channelUrl,
            source: 'cache',
          },
        };
        youtubeRunStore.setChannel(task.profileId, {
          profileName: collectLabel,
          channelId: cached.channelId,
          channelUrl: cached.channelUrl,
          channelSource: 'cache',
        });
        return;
      }

      // 2) Chưa có trong kho -> lấy tab sống rồi đọc thật.
      let collectPage = await this.ensureLivePage(task, provider);
      let result = await collectYoutubeChannelId(collectPage, {
        label: collectLabel,
        timeoutMs: action.timeoutMs,
      });
      // `LOAD_FAILED` = trang chưa tải xong (mạng chậm); `TAB_CLOSED` = tab bị đóng giữa lúc đọc.
      // Cả hai CHƯA kết luận gì về kênh -> đọc lại MỘT lần với tab LẤY LẠI (handle cũ có thể đã
      // chết — dùng lại nó chính là lỗi cũ). Hành động chỉ ĐỌC nên retry an toàn (RULES §27).
      if (!result.ok && (result.reason === 'LOAD_FAILED' || result.reason === 'TAB_CLOSED')) {
        logger.warn(`[WorkflowEngine] [${task.profileId}] ${result.message} Đọc lại lần 2...`);
        this.updateProgress(
          task,
          result.reason === 'TAB_CLOSED'
            ? 'Tab bị đóng — mở lại tab và đọc Channel ID (lần 2)'
            : 'Trang tải chậm — đọc lại Channel ID (lần 2)'
        );
        collectPage = await this.ensureLivePage(task, provider);
        result = await collectYoutubeChannelId(collectPage, {
          label: collectLabel,
          timeoutMs: action.timeoutMs,
        });
      }
      // Whitelist: chỉ id/link kênh + nguồn đọc. KHÔNG có email/credential trong resultData.
      task.resultData = {
        ...(task.resultData || {}),
        youtube_channel: {
          ok: result.ok,
          channelId: result.channelId,
          channelUrl: result.channelId ? channelUrlFor(result.channelId) : undefined,
          source: result.source,
          reason: result.reason,
        },
      };
      if (!result.ok || !result.channelId) {
        task.errorMessage = result.message ?? 'Không đọc được Channel ID YouTube.';
        throw new Error(task.errorMessage);
      }
      youtubeRunStore.setChannel(task.profileId, {
        profileName: collectLabel,
        channelId: result.channelId,
        channelUrl: channelUrlFor(result.channelId),
        channelSource: result.source,
      });
      // 3) Đọc thật thành công -> ghi vào kho: lượt sau chỉ cần gọi API.
      youtubeChannelCache.remember({
        provider: providerId,
        profileId: task.profileId,
        profileName: collectLabel,
        channelId: result.channelId,
        channelUrl: channelUrlFor(result.channelId),
        channelSource: result.source,
      });
      return;
    }

    if (action.actionType === 'youtube_videos_fetch') {
      const entry = youtubeRunStore.get(task.profileId);
      // Ưu tiên LINK kênh: client tự bóc id/handle từ URL nên tầng trên không phải xử lý thêm.
      const channelRef =
        task.resultData?.youtube_channel?.channelUrl ??
        entry?.channelUrl ??
        task.resultData?.youtube_channel?.channelId ??
        entry?.channelId;
      if (!channelRef) {
        task.errorMessage = 'Chưa có link/Channel ID cho profile này — bước đọc Channel ID phải chạy trước.';
        throw new Error(task.errorMessage);
      }
      const apiKey = config.youtube.apiKey?.trim();
      if (!apiKey) {
        task.errorMessage = 'Chưa cấu hình YouTube Data API Key trong Cài đặt hệ thống.';
        throw new Error(task.errorMessage);
      }
      const data = await getYoutubeDataApiClient(apiKey).fetchChannelVideos(channelRef);
      youtubeRunStore.setVideos(task.profileId, task.profileName ?? task.profileId, data);
      // Bổ sung dữ kiện API vào kho (tên kênh/handle/số video) — chỉ cập nhật, không tạo mới.
      youtubeChannelCache.enrich(providerId, task.profileId, {
        channelTitle: data.channelTitle,
        channelHandle: data.channelHandle,
        videoCount: data.videos.length,
      });
      task.resultData = {
        ...(task.resultData || {}),
        youtube_videos: {
          channelTitle: data.channelTitle,
          channelUrl: data.channelUrl,
          channelHandle: data.channelHandle,
          videoCount: data.videos.length,
          unavailableCount: data.unavailableCount,
          uploadsMissing: data.uploadsMissing,
        },
      };
      logger.info(
        data.uploadsMissing
          ? `[WorkflowEngine] [${task.profileId}] YouTube: kênh "${data.channelTitle}" chưa có video công khai (0 video).`
          : `[WorkflowEngine] [${task.profileId}] YouTube: ${data.videos.length} video từ kênh "${data.channelTitle}".`
      );
      return;
    }

    // Các bước còn lại đều tác động lên trang -> phải có tab sống.
    const page = await this.ensureLivePage(task, provider);

    if (action.actionType === 'google_login') {
      // Nguồn credential 1 (ưu tiên): tài khoản NGƯỜI DÙNG dán, đã ghép CỐ ĐỊNH theo
      // vị trí cho ĐÚNG profileId này. Có nguồn này -> bắt buộc đối chiếu Gmail sau login.
      const assigned = this.batchGoogleAccounts.get(task.profileId);
      let creds: GoogleLoginCredentials | undefined;

      if (assigned) {
        creds = {
          username: assigned.email,
          password: assigned.password,
          twoFactorSecret: assigned.twoFactor || undefined,
          verifyIdentity: true,
        };
      } else if (provider.providesCredentials) {
        // Nguồn 2 (AdsPower, hành vi cũ): credential nằm trong chính profile.
        // Ưu tiên bản đã nạp sẵn trong batch; thiếu thì resolve lại tươi theo user_id.
        let fromProfile = this.batchProfileCredentials.get(task.profileId);
        if (!fromProfile || !fromProfile.username || !fromProfile.password) {
          fromProfile = (await this.resolveProfileCredentials(task.profileId)) ?? undefined;
        }
        if (fromProfile && fromProfile.username && fromProfile.password) creds = fromProfile;
      }

      if (!creds) {
        // Không có credential cho ĐÚNG profile này -> CREDENTIAL_UNAVAILABLE,
        // FAIL riêng nó và GIỮ cửa sổ mở (KHÔNG dùng credential của profile khác).
        task.resultData = { ...(task.resultData || {}), loginState: 'CREDENTIAL_UNAVAILABLE' };
        task.errorMessage = provider.providesCredentials
          ? 'AdsPower integration hiện tại không cung cấp password cho profile này.'
          : `${provider.label} không lưu credential trong profile — cần dán tài khoản "gmail,password,2fa" cho profile này.`;
        throw new Error(task.errorMessage);
      }
      const result = await googleLoginAutomation.execute(
        task.profileId,
        task.profileName ?? task.profileId,
        creds
      );
      // Kết quả đã được làm sạch (không mật khẩu, không mã 2FA, email đã che) -> an toàn cho checkpoint.
      task.resultData = { ...(task.resultData || {}), loginState: result.state, google_login: result };
      if (result.state !== 'SUCCESS') {
        task.errorMessage = result.message;
        throw new Error(result.message);
      }
      return;
    }

    if (action.actionType === 'facebook_login') {
      // Uỷ quyền toàn bộ máy trạng thái đăng nhập cho FacebookLoginAutomation (static import ở đầu file).
      const targetUrl = action.value || undefined;
      // [P1b điểm 5] Nếu FB login KHÔNG phải bước cuối (còn inventory/share...) -> GIỮ mở trình duyệt trên success.
      const isLastStep = task.currentStepIndex >= task.steps.length - 1;
      const result = await facebookLoginAutomation.execute(task.profileId, targetUrl, {
        keepBrowserOpenOnSuccess: !isLastStep,
      });
      // Whitelist các trường an toàn (KHÔNG lưu password / mã 2FA / details thô).
      task.resultData = {
        ...(task.resultData || {}),
        loginState: result.status,
        facebook_login: {
          success: result.success,
          status: result.status,
          message: result.message,
          currentUrl: result.currentUrl,
          profileId: result.profileId,
          profileName: result.profileName,
        },
      };
      if (!result.success) {
        task.errorMessage = result.message;
        throw new Error(result.message);
      }
      return;
    }

    if (action.actionType === 'navigate') {
      await cdpManager.navigate(task.profileId, action.value!);
      if (!task.resultData) task.resultData = {};
      task.resultData[step.stepId] = { success: true };
      return;
    }
    
    if (action.actionType === 'screenshot') {
      const b64 = await cdpManager.takeScreenshot(task.profileId);
      if (!task.resultData) task.resultData = {};
      task.resultData[step.stepId] = { screenshot: b64, success: true };
      return;
    }

    // Các DOM action khác (click, fill, type, wait_for_selector,...) -> Qua Healing Orchestrator
    let siteDomain = 'facebook.com';
    try {
      siteDomain = new URL(page.url()).hostname || 'facebook.com';
    } catch {}

    const result = await healingOrchestrator.executeWithHealing(action, page, {
      profileId: task.profileId,
      site: siteDomain,
      step: step
    });

    if (!task.resultData) task.resultData = {};
    task.resultData[step.stepId] = result;

    if (!result.success && !action.optional) {
      throw new Error(result.error || `Failed to execute action ${action.actionType}`);
    }
  }

  /**
   * Helper giải quyết danh sách identifier (ID, Serial, Tên Profile) sang bản ghi profile.
   *
   * Logic match ĐÃ ĐƯỢC DI CHUYỂN NGUYÊN VĂN sang `providers/adspower-provider.ts`;
   * method này giữ lại làm seam (test hiện tại stub chính nó) và chỉ chọn provider.
   */
  private async resolveProfileList(
    identifiers: string[],
    providerId: BrowserProviderId = DEFAULT_BROWSER_PROVIDER
  ): Promise<{
    resolved: Array<{ identifier: string; profile: AdsPowerProfileInfo }>;
    notFound: string[];
  }> {
    return await getProvider(providerId).resolveProfiles(identifiers);
  }

  /**
   * Resolve credential PER-PROFILE trực tiếp từ AdsPower theo user_id/tên/serial.
   * Nguồn credential DUY NHẤT là chính profile AdsPower (KHÔNG hardcode, KHÔNG scrape DOM,
   * KHÔNG gọi start.adspower.net để lấy password). Tái dùng resolveProfileList rồi delegate
   * sang selectProfileCredentials. Trả null nếu profile không tồn tại hoặc thiếu username/password.
   * Dùng cho luồng đơn lẻ / fallback khi bộ nhớ credential của batch đã bị xoá (vd. retry).
   */
  public async resolveProfileCredentials(profileId: string): Promise<ProfileCredentials | null> {
    const { resolved } = await this.resolveProfileList([profileId]);
    const match = resolved.find(r => r.profile.user_id === profileId) ?? resolved[0];
    if (!match) return null;
    return selectProfileCredentials(match.profile);
  }

  /**
   * Khởi chạy một batch workflow cho nhiều profiles (hỗ trợ cả profileIds và profileIdentifiers dạng tên)
   */
  public async runBatch(params: {
    profileIds?: string[];
    profileIdentifiers?: string[];
    profileNames?: Record<string, string>;
    workflowName: string;
    steps?: WorkflowStep[];
    concurrency?: number;
    credentials?: { username: string; password: string };
    /** Backend cung cấp profile; thiếu = 'adspower' (tương thích ngược). */
    provider?: BrowserProviderId;
    /**
     * Tài khoản Google do NGƯỜI DÙNG dán: raw text "gmail,password,2fa" mỗi dòng,
     * hoặc danh sách đã parse. Ghép theo VỊ TRÍ với danh sách profile.
     */
    googleAccounts?: string | readonly GoogleAccountInput[];
    /** Override đóng-khi-SUCCESS; thiếu = theo provider / config toàn cục. */
    autoCloseSuccess?: boolean;
    /**
     * `true` = bỏ qua kho Channel ID đã lưu và mở profile đọc lại.
     * Thiếu/`false` = profile nào đã có Channel ID thì KHÔNG mở trình duyệt nữa.
     */
    refreshChannels?: boolean;
  }): Promise<{
    batchId: string;
    provider: BrowserProviderId;
    tasks: WorkflowTaskProgress[];
    resolvedCount: number;
    notFoundCount: number;
    notFoundList: string[];
    /** Mapping vị trí đã chốt (email ĐÃ CHE) — đúng thứ tự người dùng nhập. */
    mapping: Array<{
      index: number;
      identifier: string;
      profileId: string;
      profileName: string;
      emailMasked?: string;
    }>;
  }> {
    // Credential được lấy PER-PROFILE từ chính profile AdsPower (xem vòng lặp resolved bên dưới),
    // KHÔNG dùng params.credentials chung cho cả batch (tránh nhiễm chéo credential giữa các profile).
    // params.credentials giữ lại chỉ để tương thích chữ ký API cho workflow khác; google_login KHÔNG dùng nó.

    // Engine là singleton: runBatch xoá state batch cũ -> KHÔNG cho cướp batch đang chạy.
    if (this.engineState === 'running') {
      throw conflictError('Đang có batch workflow chạy. Hãy chờ hoàn thành hoặc Cancel trước khi chạy batch mới.');
    }

    const providerId = params.provider ?? DEFAULT_BROWSER_PROVIDER;
    const provider = getProvider(providerId);

    const rawIdentifiers = (params.profileIdentifiers || params.profileIds || [])
      .map(s => String(s).trim())
      .filter(Boolean);
    if (rawIdentifiers.length === 0) {
      throw validationError('Vui lòng cung cấp danh sách profileIds hoặc profileIdentifiers.');
    }

    const batchId = crypto.randomUUID();
    const concurrency = Math.min(Math.max(params.concurrency || 5, 1), 20);

    // Get steps from preset or provided steps
    const preset = WORKFLOW_PRESETS[params.workflowName];
    const steps = params.steps || preset?.steps;

    if (!steps || steps.length === 0) {
      throw validationError(`Workflow "${params.workflowName}" không tồn tại hoặc không có steps.`);
    }

    // ── Tài khoản Google do người dùng dán (tuỳ chọn) ─────────────────────────
    // Kiểm tra XONG ở đây: lệch số lượng / sai định dạng / trùng tài khoản đều
    // bị từ chối TRƯỚC KHI reset state và TRƯỚC KHI mở bất kỳ profile nào.
    let accounts: readonly GoogleAccountInput[] = [];
    if (params.googleAccounts !== undefined) {
      if (typeof params.googleAccounts === 'string') {
        const parsed = parseGoogleAccountLines(params.googleAccounts);
        if (!parsed.ok) throw validationError(parsed.message);
        accounts = parsed.accounts;
      } else {
        accounts = params.googleAccounts;
      }
      if (accounts.length !== rawIdentifiers.length) {
        throw validationError(formatCountMismatch(rawIdentifiers.length, accounts.length));
      }
    }

    // Provider không mang credential (taothaoAIClaw) + workflow google_login
    // -> không có nguồn nào khác ngoài danh sách người dùng dán.
    if (
      accounts.length === 0 &&
      !provider.providesCredentials &&
      steps.some(s => s.action.actionType === 'google_login')
    ) {
      throw validationError(
        `${provider.label} không lưu credential trong profile — hãy dán danh sách tài khoản "gmail,password,2fa" (mỗi dòng một tài khoản, đúng thứ tự với danh sách profile).`
      );
    }

    // Workflow YouTube gọi Data API v3 -> thiếu API Key thì CHẶN NGAY, không mở profile nào.
    if (steps.some(s => s.action.actionType === 'youtube_videos_fetch') && !config.youtube.apiKey?.trim()) {
      throw validationError(
        'Chưa cấu hình YouTube Data API Key. Vào Cài đặt hệ thống -> "YouTube Data API v3" để nhập API Key trước khi chạy workflow này.'
      );
    }

    // Reset engine state
    this.isCancelled = false;
    this.isPaused = false;
    this.concurrencyLimit = concurrency;
    this.engineState = 'running';
    this.tasks.clear();
    this.taskProgress.clear();
    this.queue = [];
    this.batchProfileCredentials.clear();
    this.batchGoogleAccounts.clear();
    this.batchMapping = [];
    this.batchMappingIndex = new Map();
    this.batchAutoCloseSuccess = params.autoCloseSuccess ?? null;
    this.batchRefreshChannels = params.refreshChannels === true;
    // Dữ liệu video của batch trước KHÔNG được lẫn vào báo cáo của batch này.
    youtubeRunStore.reset();

    // Giải quyết danh sách profile (hỗ trợ tên, serial, user_id)
    const { resolved, notFound } = await this.resolveProfileList(rawIdentifiers, providerId);

    logger.info(
      `[WorkflowEngine] Khởi động batch ${batchId}: Tổng ${rawIdentifiers.length} items (${resolved.length} hợp lệ, ${notFound.length} không tìm thấy), concurrency=${concurrency}, workflow="${params.workflowName}"`
    );

    // ── Chốt MAPPING VỊ TRÍ trước khi chạy ───────────────────────────────────
    // profile[i] <-> account[i] theo ĐÚNG thứ tự người dùng nhập. Mapping BẤT BIẾN:
    // concurrency chỉ đổi thời điểm chạy, KHÔNG BAO GIỜ đổi cặp ghép.
    const resolvedByIdentifier = new Map(resolved.map(r => [r.identifier, r]));
    const mappingProfiles: MappingProfileInput[] = rawIdentifiers.map(identifier => {
      const match = resolvedByIdentifier.get(identifier);
      return {
        profileId: match ? match.profile.user_id : identifier,
        identifier,
        profileName: match?.profile.name || identifier,
      };
    });

    if (accounts.length > 0) {
      const built = buildExecutionMapping(mappingProfiles, accounts);
      if (!built.ok) {
        this.engineState = 'idle';
        throw validationError(built.message);
      }
      this.batchMapping = built.mapping;
      // Secret TÁCH RIÊNG khỏi mapping, chỉ trong RAM, keyed theo profileId THẬT.
      for (const [profileId, secret] of built.secrets) {
        this.batchGoogleAccounts.set(profileId, secret);
      }
    } else {
      this.batchMapping = Object.freeze(
        mappingProfiles.map((p, index) =>
          Object.freeze({
            index,
            profileId: p.profileId,
            identifier: p.identifier ?? p.profileId,
            profileName: p.profileName ?? p.profileId,
            email: '',
          })
        )
      );
    }
    for (const entry of this.batchMapping) {
      this.batchMappingIndex.set(entry.profileId, entry.index);
      if (entry.identifier !== entry.profileId) {
        this.batchMappingIndex.set(entry.identifier, entry.index);
      }
    }

    // 1. Tạo tasks cho các profile không tìm thấy (đánh dấu Failed / Not Found ngay lập tức)
    for (const notFoundName of notFound) {
      const taskId = `${batchId}_nf_${encodeURIComponent(notFoundName).substring(0, 30)}_${Date.now()}`;
      const task: WorkflowTask = {
        taskId,
        profileId: notFoundName,
        profileName: notFoundName,
        identifier: notFoundName,
        provider: providerId,
        workflowName: preset?.name || params.workflowName,
        steps: steps.map(s => ({ ...s })),
        currentStepIndex: 0,
        status: 'failed',
        retryCount: 0,
        maxRetries: 0,
        errorMessage: `Không tìm thấy profile "${notFoundName}" trên ${provider.label} (Vui lòng kiểm tra lại tên/ID).`,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };

      this.tasks.set(taskId, task);
      this.updateProgress(task, 'Không tìm thấy profile trên AdsPower ❌');
    }

    // 2. Tạo tasks cho các profile hợp lệ và đưa vào Queue
    for (const item of resolved) {
      const taskId = `${batchId}_${item.profile.user_id}`;
      const task: WorkflowTask = {
        taskId,
        profileId: item.profile.user_id,
        profileName: item.profile.name || item.identifier,
        identifier: item.identifier,
        provider: providerId,
        workflowName: preset?.name || params.workflowName,
        steps: steps.map(s => ({ ...s })), // Clone steps
        currentStepIndex: 0,
        status: 'pending',
        retryCount: 0,
        maxRetries: 2,
      };

      this.tasks.set(taskId, task);

      // Nguồn credential PER-PROFILE (giống cơ chế Facebook): lấy từ chính profile
      // AdsPower tương ứng. Chỉ giữ trong bộ nhớ; KHÔNG BAO GIỜ ghi vào
      // task/resultData/checkpoint/log. Provider không mang credential (taothao)
      // -> bỏ qua, credential đến từ this.batchGoogleAccounts đã ghép theo vị trí.
      if (provider.providesCredentials) {
        const creds = selectProfileCredentials(item.profile);
        if (creds) {
          this.batchProfileCredentials.set(item.profile.user_id, creds);
        }
      }
      this.queue.push(taskId);
      this.updateProgress(task, 'Đang chờ trong queue...');
    }

    // Broadcast initial state
    if (this.broadcastFn) {
      this.broadcastFn('workflow_batch_started', {
        batchId,
        totalTasks: rawIdentifiers.length,
        resolvedCount: resolved.length,
        notFoundCount: notFound.length,
        notFoundList: notFound,
        concurrency,
        workflowName: preset?.name || params.workflowName,
      });
    }

    // Start draining queue (non-blocking)
    if (this.queue.length > 0) {
      this.drainQueue();
    } else {
      this.engineState = 'idle';
      if (this.broadcastFn) {
        this.broadcastFn('workflow_batch_completed', this.getBatchStatus());
      }
    }

    return {
      batchId,
      provider: providerId,
      tasks: Array.from(this.taskProgress.values()),
      resolvedCount: resolved.length,
      notFoundCount: notFound.length,
      notFoundList: notFound,
      // Email ĐÃ CHE — response này đi ra UI/log, KHÔNG BAO GIỜ chứa email đầy đủ.
      mapping: this.batchMapping.map(m => ({
        index: m.index,
        identifier: m.identifier,
        profileId: m.profileId,
        profileName: m.profileName,
        emailMasked: m.email ? maskEmail(m.email) : undefined,
      })),
    };
  }


  /** Trả về trạng thái hiện tại của batch */
  public getBatchStatus(): WorkflowBatchStatus {
    const tasks = Array.from(this.taskProgress.values());
    return {
      engineState: this.engineState,
      totalTasks: tasks.length,
      pendingCount: tasks.filter(t => t.status === 'pending').length,
      runningCount: tasks.filter(t => t.status === 'running').length,
      completedCount: tasks.filter(t => t.status === 'completed').length,
      failedCount: tasks.filter(t => t.status === 'failed').length,
      tasks,
    };
  }

  /** Xóa toàn bộ task history */
  public clearHistory() {
    if (this.engineState === 'running') {
      throw new Error('Không thể xóa lịch sử khi batch đang chạy. Hủy trước.');
    }
    this.tasks.clear();
    this.taskProgress.clear();
    this.batchProfileCredentials.clear(); // Không giữ credentials sau khi xóa lịch sử (bảo mật)
    logger.info('[WorkflowEngine] Đã xóa toàn bộ task history.');
  }

  /**
   * Chạy lại tất cả task bị failed trong batch hiện tại.
   * Không tạo batch mới, không resolve lại profile — chỉ reset và đẩy vào queue.
   */
  public retryFailed(concurrency?: number): { retriedCount: number; skippedCount: number } {
    if (this.engineState === 'running') {
      throw new Error('Batch đang chạy. Hãy chờ hoàn thành hoặc cancel trước khi retry.');
    }

    const failedTasks = Array.from(this.tasks.values()).filter(t => t.status === 'failed');

    if (failedTasks.length === 0) {
      return { retriedCount: 0, skippedCount: 0 };
    }

    // Reset engine state
    this.isCancelled = false;
    this.isPaused = false;
    this.engineState = 'running';
    if (concurrency) this.concurrencyLimit = Math.min(Math.max(concurrency, 1), 20);

    let retriedCount = 0;

    for (const task of failedTasks) {
      // Skip "not found" tasks — không có profile để retry
      if (task.errorMessage?.includes('Không tìm thấy profile')) continue;

      // Không tự động retry các case cần con người xử lý (đã che/không thể vượt qua).
      const loginState = task.resultData?.loginState;
      if (loginState === 'VERIFICATION_REQUIRED' || loginState === 'NEEDS_HUMAN_REVIEW') continue;

      // Reset task về trạng thái ban đầu
      task.status = 'pending';
      task.currentStepIndex = 0;
      task.errorMessage = undefined;
      task.startedAt = undefined;
      task.finishedAt = undefined;
      task.retryCount = (task.retryCount || 0) + 1;
      // Reset steps state
      task.steps = task.steps.map(s => ({ ...s }));

      this.updateProgress(task, 'Đang chờ retry...');
      this.queue.push(task.taskId);
      retriedCount++;
    }

    const skippedCount = failedTasks.length - retriedCount;

    logger.info(`[WorkflowEngine] 🔄 Retry ${retriedCount} task(s) failed (bỏ qua ${skippedCount} not-found tasks).`);

    if (this.broadcastFn) {
      this.broadcastFn('workflow_engine_state', { state: 'running' });
    }

    if (this.queue.length > 0) {
      this.drainQueue();
    } else {
      this.engineState = 'idle';
    }

    return { retriedCount, skippedCount };
  }

}

export const workflowEngine = new WorkflowEngine();
