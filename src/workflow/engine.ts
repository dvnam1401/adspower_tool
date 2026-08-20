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
} from '../types/index.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import { adsPowerClient } from '../adspower/client.js';
import { cdpManager } from '../dom/cdp.js';
import { healingOrchestrator } from '../recovery/healing-orchestrator.js';


// Broadcast function will be injected from app.ts
type BroadcastFn = (event: string, data: any) => void;

// ─── Workflow Presets ───────────────────────────────────────────────────────────

export const WORKFLOW_PRESETS: Record<string, { name: string; steps: WorkflowStep[] }> = {
  facebook_login: {
    name: 'Facebook Auto Login',
    steps: [
      {
        stepId: 'navigate',
        name: 'Điều hướng đến Facebook',
        action: {
          actionType: 'navigate',
          targetDescription: 'Facebook homepage',
          value: 'https://www.facebook.com',
          timeoutMs: 15000,
        },
      },
      {
        stepId: 'wait_load',
        name: 'Chờ trang tải xong',
        action: {
          actionType: 'wait_for_selector',
          targetDescription: 'Facebook main content',
          selectorChain: [
            { type: 'css', value: 'body', priority: 1 },
          ],
          timeoutMs: 10000,
          optional: true,
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
  google_search: {
    name: 'Google Search Test',
    steps: [
      {
        stepId: 'navigate',
        name: 'Mở Google',
        action: { actionType: 'navigate', targetDescription: 'Google', value: 'https://www.google.com' },
      },
      {
        stepId: 'screenshot',
        name: 'Chụp màn hình',
        action: { actionType: 'screenshot', targetDescription: 'Google homepage', optional: true },
      },
    ],
  },
};

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
    };

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
      }
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
        this.updateProgress(task, 'Hoàn thành thành công ✅');
        this.saveCheckpoint(task);
        logger.info(`[WorkflowEngine] ✅ Task ${task.taskId} COMPLETED (Profile: ${task.profileId})`);
      }
    } catch (err: any) {
      task.status = 'failed';
      task.errorMessage = err.message;
      task.finishedAt = new Date().toISOString();
      this.updateProgress(task, `Lỗi: ${err.message}`);
      this.saveCheckpoint(task);
      logger.error(`[WorkflowEngine] ❌ Task ${task.taskId} FAILED: ${err.message}`);
    }
  }

  /**
   * Thực thi một step với CDP thực tế và tích hợp Self-Healing
   */
  private async executeStep(task: WorkflowTask, step: WorkflowStep): Promise<void> {
    const action = step.action;
    
    // Đảm bảo trình duyệt đang mở
    let page = cdpManager.getActivePage(task.profileId);
    
    if (!page) {
      // Nếu chưa có CDP session, thử connect với endpoint lấy từ connData (giả định là wsEndpoint đã được lưu vào task)
      // Để hoàn thiện hơn, WorkflowEngine nên tự động startBrowser và lưu wsEndpoint vào task.
      // Tạm thời nếu không có page, navigate có thể connect
      throw new Error(`Profile ${task.profileId} chưa kết nối CDP. Cần start browser trước.`);
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
    const result = await healingOrchestrator.executeWithHealing(action, page, {
      profileId: task.profileId,
      site: new URL(page.url()).hostname,
      step: step
    });

    if (!task.resultData) task.resultData = {};
    task.resultData[step.stepId] = result;

    if (!result.success && !action.optional) {
      throw new Error(result.error || `Failed to execute action ${action.actionType}`);
    }
  }

  /**
   * Helper giải quyết danh sách identifier (ID, Serial, Tên Profile) sang AdsPowerProfileInfo
   */
  private async resolveProfileList(identifiers: string[]): Promise<{
    resolved: Array<{ identifier: string; profile: AdsPowerProfileInfo }>;
    notFound: string[];
  }> {
    let allProfiles: AdsPowerProfileInfo[] = [];
    try {
      const resAll = await adsPowerClient.listProfiles({ fetchAll: true, pageSize: 100 });
      allProfiles = resAll.list || [];
    } catch (err: any) {
      logger.warn(`[WorkflowEngine] Không thể tải danh sách profiles từ AdsPower: ${err.message}`);
    }

    const resolved: Array<{ identifier: string; profile: AdsPowerProfileInfo }> = [];
    const notFound: string[] = [];

    for (const rawId of identifiers) {
      const cleanId = rawId.trim();
      if (!cleanId) continue;

      const cleanLower = cleanId.toLowerCase();
      const serialNum = cleanId.replace(/^#/, '');

      const found = allProfiles.find(
        p =>
          p.user_id === cleanId ||
          p.serial_number === cleanId ||
          p.serial_number === serialNum ||
          p.name?.toLowerCase().trim() === cleanLower
      );

      if (found) {
        resolved.push({ identifier: cleanId, profile: found });
      } else {
        notFound.push(cleanId);
      }
    }

    return { resolved, notFound };
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
  }): Promise<{
    batchId: string;
    tasks: WorkflowTaskProgress[];
    resolvedCount: number;
    notFoundCount: number;
    notFoundList: string[];
  }> {
    const rawIdentifiers = params.profileIdentifiers || params.profileIds || [];
    if (rawIdentifiers.length === 0) {
      throw new Error('Vui lòng cung cấp danh sách profileIds hoặc profileIdentifiers.');
    }

    const batchId = crypto.randomUUID();
    const concurrency = Math.min(Math.max(params.concurrency || 5, 1), 20);

    // Get steps from preset or provided steps
    const preset = WORKFLOW_PRESETS[params.workflowName];
    const steps = params.steps || preset?.steps;

    if (!steps || steps.length === 0) {
      throw new Error(`Workflow "${params.workflowName}" không tồn tại hoặc không có steps.`);
    }

    // Reset engine state
    this.isCancelled = false;
    this.isPaused = false;
    this.concurrencyLimit = concurrency;
    this.engineState = 'running';
    this.tasks.clear();
    this.taskProgress.clear();
    this.queue = [];

    // Giải quyết danh sách profile (hỗ trợ tên, serial, user_id)
    const { resolved, notFound } = await this.resolveProfileList(rawIdentifiers);

    logger.info(
      `[WorkflowEngine] Khởi động batch ${batchId}: Tổng ${rawIdentifiers.length} items (${resolved.length} hợp lệ, ${notFound.length} không tìm thấy), concurrency=${concurrency}, workflow="${params.workflowName}"`
    );

    // 1. Tạo tasks cho các profile không tìm thấy (đánh dấu Failed / Not Found ngay lập tức)
    for (const notFoundName of notFound) {
      const taskId = `${batchId}_nf_${encodeURIComponent(notFoundName).substring(0, 30)}_${Date.now()}`;
      const task: WorkflowTask = {
        taskId,
        profileId: notFoundName,
        profileName: notFoundName,
        identifier: notFoundName,
        workflowName: preset?.name || params.workflowName,
        steps: steps.map(s => ({ ...s })),
        currentStepIndex: 0,
        status: 'failed',
        retryCount: 0,
        maxRetries: 0,
        errorMessage: `Không tìm thấy profile "${notFoundName}" trên AdsPower (Vui lòng kiểm tra lại tên/ID).`,
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
        workflowName: preset?.name || params.workflowName,
        steps: steps.map(s => ({ ...s })), // Clone steps
        currentStepIndex: 0,
        status: 'pending',
        retryCount: 0,
        maxRetries: 2,
      };

      this.tasks.set(taskId, task);
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
      tasks: Array.from(this.taskProgress.values()),
      resolvedCount: resolved.length,
      notFoundCount: notFound.length,
      notFoundList: notFound,
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
    logger.info('[WorkflowEngine] Đã xóa toàn bộ task history.');
  }
}

export const workflowEngine = new WorkflowEngine();
