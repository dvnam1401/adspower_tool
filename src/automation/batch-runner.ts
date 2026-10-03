import { facebookLoginAutomation, FacebookLoginResult } from './facebook-login.js';
import { adsPowerClient } from '../adspower/client.js';
import { logger } from '../utils/logger.js';
import { broadcastEvent } from '../server/app.js';
import { config } from '../config/index.js';
import { synthesizeBatchReportAndNotify } from '../utils/telegram.js';

export interface BatchRunOptions {
  profileIdentifiers?: string[];
  groupId?: string;
  concurrency?: number;
  targetUrl?: string;
  staggerDelayMs?: number;
  autoCloseSuccess?: boolean;
}

export interface ProfileBatchResult {
  identifier: string;
  profileId?: string;
  profileName?: string;
  result?: FacebookLoginResult;
  error?: string;
  /** Trạng thái chuẩn hóa: status của result, hoặc 'error' khi execute ném lỗi. */
  status?: FacebookLoginResult['status'] | 'error';
  /** URL cuối cùng của phiên (result.currentUrl), '' nếu không có. */
  finalUrl?: string;
  /** Lý do thất bại: result.message khi !success, hoặc error.message khi ném; undefined khi thành công. */
  failureReason?: string;
  startTime: string;
  endTime?: string;
  durationMs?: number;
}

export interface BatchRunSummary {
  total: number;
  completed: number;
  successCount: number;
  alreadyLoggedInCount: number;
  checkpointCount: number;
  failedCount: number;
  startTime: string;
  endTime: string;
  totalDurationMs: number;
  /** Google Account Login: đếm theo loginState (chỉ có khi batch là google_account_login). */
  loginStateCounts?: Record<string, number>;
  results: ProfileBatchResult[];
}

export class BatchFacebookLoginRunner {
  private isAborted = false;

  public stopBatch(): void {
    this.isAborted = true;
    logger.warn('🛑 [Batch Runner] Đã nhận lệnh DỪNG khẩn cấp. Hủy toàn bộ hàng đợi automation còn lại.');
    broadcastEvent('batch_stopped', { message: 'Tiến trình Batch Automation đã bị dừng theo yêu cầu người dùng.' });
  }

  /**
   * Execute Facebook Login Automation across multiple independent profiles in parallel threads
   */
  public async runBatch(options: BatchRunOptions = {}): Promise<BatchRunSummary> {
    this.isAborted = false;
    const startTime = new Date();
    const concurrency = options.concurrency || config.concurrency.maxProfiles || 3;
    const staggerDelayMs = options.staggerDelayMs || 2000; // 2 seconds delay between launching profiles

    logger.info('========================================================================');
    logger.info(`🚀 BẮT ĐẦU CHẠY FACEBOOK AUTO-LOGIN ĐA LUỒNG (Concurrency = ${concurrency})`);
    logger.info('========================================================================');

    // 1. Xác định danh sách profiles cần chạy
    let targetProfiles: string[] = options.profileIdentifiers || [];

    if (targetProfiles.length === 0) {
      logger.info('Đang tải danh sách profile từ AdsPower API...');
      const listRes = await adsPowerClient.listProfiles({
        groupId: options.groupId,
        fetchAll: true,
      });

      targetProfiles = (listRes.list || []).map(p => p.user_id);
    }

    if (targetProfiles.length === 0) {
      throw new Error('Không tìm thấy profile nào để chạy automation.');
    }

    logger.info(`Tổng số profiles sẽ thực thi: ${targetProfiles.length} profiles.`);
    
    broadcastEvent('batch_started', {
      total: targetProfiles.length,
      concurrency,
      profiles: targetProfiles,
      time: startTime.toLocaleTimeString(),
    });

    const resultsMap = new Map<string, ProfileBatchResult>();
    const queue = [...targetProfiles];
    let completedCount = 0;
    let successCount = 0;
    let alreadyLoggedInCount = 0;
    let checkpointCount = 0;
    let failedCount = 0;

    // Worker execution wrapper for a single profile
    const runWorker = async (profileIdOrName: string) => {
      if (this.isAborted) {
        logger.warn(`[Worker Skipped] Profile: ${profileIdOrName} -> Bị bỏ qua do Batch đã DỪNG.`);
        return;
      }

      const pStart = new Date();
      const batchResultItem: ProfileBatchResult = {
        identifier: profileIdOrName,
        startTime: pStart.toISOString(),
      };

      logger.info(`[Worker Thread] Khởi chạy Profile: ${profileIdOrName}...`);
      broadcastEvent('profile_login_started', {
        identifier: profileIdOrName,
        time: pStart.toLocaleTimeString(),
      });

      // [P1b→Batch] Quyết định đóng MỘT lần và ủy quyền toàn bộ việc đóng cho execute()
      // (một nơi đóng duy nhất). autoCloseSuccess của batch được tôn trọng: nếu false
      // -> keepBrowserOpenOnSuccess=true để execute() KHÔNG đóng.
      const shouldClose = options.autoCloseSuccess ?? config.automation?.closeSuccessBrowsers ?? true;

      try {
        const res = await facebookLoginAutomation.execute(profileIdOrName, options.targetUrl, {
          keepBrowserOpenOnSuccess: !shouldClose,
        });
        const pEnd = new Date();

        batchResultItem.profileId = res.profileId;
        batchResultItem.profileName = res.profileName;
        batchResultItem.result = res;
        batchResultItem.endTime = pEnd.toISOString();
        batchResultItem.durationMs = pEnd.getTime() - pStart.getTime();

        // Bản ghi chuẩn hóa cấp cao (point 9): consumer không cần đào vào result.
        batchResultItem.status = res.status;
        batchResultItem.finalUrl = res.currentUrl || '';
        batchResultItem.failureReason = res.success ? undefined : res.message;

        if (res.success) {
          if (res.status === 'already_logged_in') {
            alreadyLoggedInCount++;
          } else {
            successCount++;
          }
          // execute() đã tự đóng cửa sổ trên success (khi shouldClose) — batch KHÔNG đóng lần hai.
        } else if (res.status === 'checkpoint_human_verification' || res.status === 'recapcha_detected') {
          checkpointCount++;
          logger.info(`📌 [Keep-Open] Profile ${res.profileName || profileIdOrName} BỊ CHECKPOINT/RECAPTCHA -> Giữ cửa sổ trình duyệt mở để bạn thao tác thủ công.`);
        } else {
          failedCount++;
          logger.info(`📌 [Keep-Open] Profile ${res.profileName || profileIdOrName} GẶP SỰ CỐ -> Giữ cửa sổ trình duyệt mở để bạn kiểm tra.`);
        }

        logger.info(`[Worker Thread Finished] Profile: ${profileIdOrName} -> ${res.status.toUpperCase()} (${batchResultItem.durationMs}ms)`);
      } catch (err: any) {
        const pEnd = new Date();
        batchResultItem.error = err.message;
        batchResultItem.endTime = pEnd.toISOString();
        batchResultItem.durationMs = pEnd.getTime() - pStart.getTime();
        batchResultItem.status = 'error';
        batchResultItem.finalUrl = '';
        batchResultItem.failureReason = err.message;
        failedCount++;

        logger.error(`[Worker Thread Error] Profile: ${profileIdOrName} -> Lỗi: ${err.message}`);
      } finally {
        completedCount++;
        resultsMap.set(profileIdOrName, batchResultItem);

        broadcastEvent('profile_login_finished', {
          identifier: profileIdOrName,
          completed: completedCount,
          total: targetProfiles.length,
          result: batchResultItem,
        });
      }
    };

    // Pool dispatcher loop with concurrency limits and launch staggering
    const activeWorkers: Promise<void>[] = [];

    for (let i = 0; i < queue.length; i++) {
      if (this.isAborted) {
        logger.warn('🛑 [Batch Runner Aborted] Đã dừng hàng đợi dispatcher. Hủy các profile còn lại trong danh sách.');
        break;
      }

      const profileItem = queue[i];

      // Nếu đã đạt giới hạn concurrency, chờ ít nhất 1 worker hoàn thành
      if (activeWorkers.length >= concurrency) {
        await Promise.race(activeWorkers);
      }

      // Tạo worker promise mới
      const workerPromise = runWorker(profileItem).then(() => {
        // Tự gỡ khỏi danh sách activeWorkers khi hoàn thành
        const idx = activeWorkers.indexOf(workerPromise);
        if (idx !== -1) {
          activeWorkers.splice(idx, 1);
        }
      });

      activeWorkers.push(workerPromise);

      // Staggering delay giữa các lần mở browser AdsPower để tránh rate limit Local API
      if (i < queue.length - 1 && staggerDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, staggerDelayMs));
      }
    }

    // Chờ toàn bộ workers còn lại kết thúc
    await Promise.all(activeWorkers);

    const endTime = new Date();
    const totalDurationMs = endTime.getTime() - startTime.getTime();
    const finalResults = Array.from(resultsMap.values());

    const summary: BatchRunSummary = {
      total: targetProfiles.length,
      completed: completedCount,
      successCount,
      alreadyLoggedInCount,
      checkpointCount,
      failedCount,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      totalDurationMs,
      results: finalResults,
    };

    logger.info('========================================================================');
    logger.info(`🏁 HOÀN THÀNH CHẠY BATCH FACEBOOK LOGIN ĐA LUỒNG!`);
    logger.info(`Tổng: ${summary.total} | Thành công: ${summary.successCount} | Đã login sẵn: ${summary.alreadyLoggedInCount} | Checkpoint: ${summary.checkpointCount} | Thất bại: ${summary.failedCount}`);
    logger.info(`Tổng thời gian thực thi: ${Math.round(totalDurationMs / 1000)}s`);
    logger.info('========================================================================');

    broadcastEvent('batch_completed', summary);

    // AI Synthesis & Telegram Notification Trigger (Runs once after batch completes)
    synthesizeBatchReportAndNotify(summary).catch(err => {
      logger.error(`[Telegram Task Error] ${err.message}`);
    });

    return summary;
  }
}

export const batchFacebookLoginRunner = new BatchFacebookLoginRunner();
