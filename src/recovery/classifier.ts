/**
 * Error Classifier — 3-Tier Error Classification System
 *
 * Tầng 1 TRANSIENT: Mạng lag, timeout → Auto retry với exponential backoff
 * Tầng 2 STRUCTURAL: DOM thay đổi, selector không tìm thấy → Skill Library / LLM Agent
 * Tầng 3 BLOCKED/DATA: CAPTCHA, ban, sai mật khẩu → Escalate người dùng
 */

import { ClassifiedError, ErrorTier, DOMAction, AccountStatus } from '../types/index.js';
import { logger } from '../utils/logger.js';

// ==========================================
// Fingerprint patterns cho từng tầng lỗi
// ==========================================

const TRANSIENT_PATTERNS: RegExp[] = [
  /timeout/i,
  /timed out/i,
  /net::ERR_/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /socket hang up/i,
  /network error/i,
  /ERR_INTERNET_DISCONNECTED/i,
  /ERR_NAME_NOT_RESOLVED/i,
  /ERR_CONNECTION_REFUSED/i,
  /page crashed/i,
  /Target closed/i,
  /Navigation failed/i,
  /ERR_ABORTED/i,
  /Protocol error/i,
];

const STRUCTURAL_PATTERNS: RegExp[] = [
  /waiting for selector/i,
  /element not found/i,
  /locator.*not found/i,
  /No element found/i,
  /failed to find element/i,
  /strict mode violation/i,
  /Element is not attached/i,
  /Element is outside of the viewport/i,
  /not in the DOM/i,
  /invisible/i,
  /detached/i,
  /selector.*did not match/i,
  /click target/i,
  /Unable to find/i,
  /Cannot find/i,
];

const BLOCKED_PATTERNS: RegExp[] = [
  /captcha/i,
  /robot/i,
  /automated/i,
  /suspicious/i,
  /unusual activity/i,
  /403/i,
  /access denied/i,
  /blocked/i,
  /rate limit/i,
  /too many requests/i,
  /ip.*ban/i,
  /banned/i,
  /account.*disabled/i,
  /account.*suspended/i,
  /verify.*human/i,
  /security check/i,
  /checkpoint/i,
  /temporarily locked/i,
  /proxy/i,
];

const DATA_PATTERNS: RegExp[] = [
  /wrong password/i,
  /incorrect password/i,
  /invalid credentials/i,
  /account.*not found/i,
  /user.*not found/i,
  /login.*failed/i,
  /authentication failed/i,
  /2fa/i,
  /two.?factor/i,
  /otp/i,
  /phone.*verify/i,
  /email.*verify/i,
];

// ==========================================
// Core Classifier
// ==========================================

export class ErrorClassifier {
  /**
   * Phân loại lỗi vào 1 trong 3 tầng
   */
  public classify(
    error: Error | string,
    site?: string,
    action?: DOMAction
  ): ClassifiedError {
    const message = typeof error === 'string' ? error : error.message;
    const originalError = typeof error === 'string' ? new Error(error) : error;

    const tier = this.detectTier(message);
    const classified = this.buildClassified(tier, originalError, message, site, action);

    logger.debug(
      `[ErrorClassifier] Tier ${tier.toUpperCase()} | ${message.substring(0, 80)}`
    );

    return classified;
  }

  /** Phát hiện tầng lỗi dựa trên pattern matching */
  private detectTier(message: string): ErrorTier {
    // Ưu tiên blocked/data (tầng 3) — không muốn retry vô ích
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(message)) return 'blocked';
    }
    for (const pattern of DATA_PATTERNS) {
      if (pattern.test(message)) return 'data';
    }

    // Tầng 2: cấu trúc DOM thay đổi
    for (const pattern of STRUCTURAL_PATTERNS) {
      if (pattern.test(message)) return 'structural';
    }

    // Tầng 1: vấn đề mạng/timeout
    for (const pattern of TRANSIENT_PATTERNS) {
      if (pattern.test(message)) return 'transient';
    }

    return 'unknown';
  }

  /** Xây dựng ClassifiedError với flags xử lý */
  private buildClassified(
    tier: ErrorTier,
    originalError: Error,
    message: string,
    site?: string,
    action?: DOMAction
  ): ClassifiedError {
    
    let accountStatus: AccountStatus = 'UNKNOWN';
    const msg = message.toLowerCase();
    
    if (tier === 'transient') accountStatus = 'PROXY_ERROR';
    else if (/disabled|locked|suspended|banned/i.test(msg)) accountStatus = 'DEAD_DISABLED';
    else if (/checkpoint|security check/i.test(msg)) accountStatus = 'CHECKPOINT_956';
    else if (/verify.*human|upload|face/i.test(msg)) accountStatus = 'CHECKPOINT_282';
    else if (/password|credentials/i.test(msg)) accountStatus = 'WRONG_PASS';
    else if (/captcha|robot/i.test(msg)) accountStatus = 'RECAPTCHA_OBSTACLE';
    else if (tier === 'blocked' || tier === 'data') accountStatus = 'NEEDS_HUMAN_REVIEW';
    switch (tier) {
      case 'transient':
        return {
          tier,
          originalError,
          message,
          site,
          action,
          canAutoRetry: true,
          requiresAgent: false,
          requiresHumanEscalation: false, accountStatus,
        };

      case 'structural':
        return {
          tier,
          originalError,
          message,
          site,
          action,
          canAutoRetry: false,
          requiresAgent: true,
          requiresHumanEscalation: false, accountStatus,
        };

      case 'blocked':
      case 'data':
        return {
          tier,
          originalError,
          message,
          site,
          action,
          canAutoRetry: false,
          requiresAgent: false,
          requiresHumanEscalation: true, accountStatus,
        };

      default:
        return {
          tier: 'unknown',
          originalError,
          message,
          site,
          action,
          canAutoRetry: true, // Thử retry an toàn cho unknown
          requiresAgent: false,
          requiresHumanEscalation: false, accountStatus,
        };
    }
  }

  /**
   * Tính thời gian chờ exponential backoff
   * attempt: 1 → 1s, 2 → 2s, 3 → 4s, 4 → 8s, max 30s
   */
  public getRetryDelayMs(attempt: number, baseMs: number = 1000): number {
    const delay = Math.min(baseMs * Math.pow(2, attempt - 1), 30000);
    // Thêm jitter ±20% để tránh thundering herd
    const jitter = delay * 0.2 * (Math.random() * 2 - 1);
    return Math.round(delay + jitter);
  }

  /**
   * Wrapper tiện lợi: thực thi một async fn với retry tự động (tầng 1)
   */
  public async withRetry<T>(
    fn: () => Promise<T>,
    options: {
      maxRetries?: number;
      site?: string;
      action?: DOMAction;
      onRetry?: (attempt: number, error: ClassifiedError, delayMs: number) => void;
    } = {}
  ): Promise<T> {
    const maxRetries = options.maxRetries ?? 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        lastError = err;
        const classified = this.classify(err, options.site, options.action);

        if (!classified.canAutoRetry || attempt > maxRetries) {
          throw err;
        }

        const delayMs = this.getRetryDelayMs(attempt);
        logger.warn(
          `[ErrorClassifier] Tầng ${classified.tier.toUpperCase()} — Retry ${attempt}/${maxRetries} sau ${delayMs}ms. Lỗi: ${err.message?.substring(0, 60)}`
        );

        if (options.onRetry) {
          options.onRetry(attempt, classified, delayMs);
        }

        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    throw lastError;
  }
}

export const errorClassifier = new ErrorClassifier();
