import fs from 'fs';
import path from 'path';
import { HealingEvent, HealingResolution, ErrorTier } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';

export class HealingLog {
  private filePath: string;
  private events: HealingEvent[] = [];
  private readonly maxEvents = 500; // Giữ tối đa 500 events

  constructor(filePath?: string) {
    this.filePath = filePath || path.resolve(
      path.dirname(config.storage.databasePath),
      'healing-log.json'
    );
    this.load();
  }

  private load() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        this.events = JSON.parse(raw);
        logger.info(`[HealingLog] Tải ${this.events.length} healing events từ log.`);
      } catch (err: any) {
        logger.error(`[HealingLog] Không thể đọc healing-log.json: ${err.message}`);
        this.events = [];
      }
    }
  }

  private save() {
    try {
      // Giữ tối đa maxEvents events (xóa cũ nhất)
      if (this.events.length > this.maxEvents) {
        this.events = this.events.slice(this.events.length - this.maxEvents);
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.events, null, 2), 'utf8');
    } catch (err: any) {
      logger.error(`[HealingLog] Lưu healing log thất bại: ${err.message}`);
    }
  }

  /** Thêm một healing event mới */
  public addEvent(event: HealingEvent): HealingEvent {
    this.events.push(event);
    this.save();
    logger.info(
      `[HealingLog] Ghi event: ${event.resolution} | ${event.site} | ${event.actionType} | Tier: ${event.errorTier}`
    );
    return event;
  }

  /** Lấy tất cả events (mới nhất trước) */
  public getAll(limit?: number): HealingEvent[] {
    const sorted = [...this.events].reverse();
    return limit ? sorted.slice(0, limit) : sorted;
  }

  /** Lấy stats tổng hợp */
  public getStats() {
    const total = this.events.length;
    const byResolution: Record<HealingResolution, number> = {
      skill_library_hit: 0,
      llm_healed: 0,
      escalated: 0,
    };
    const byTier: Record<ErrorTier, number> = {
      transient: 0,
      structural: 0,
      blocked: 0,
      data: 0,
      unknown: 0,
    };

    let totalTokensUsed = 0;
    let totalTokensSaved = 0;

    for (const ev of this.events) {
      byResolution[ev.resolution] = (byResolution[ev.resolution] || 0) + 1;
      byTier[ev.errorTier] = (byTier[ev.errorTier] || 0) + 1;
      totalTokensUsed += ev.tokensUsed || 0;
      totalTokensSaved += ev.tokensSaved || 0;
    }

    // Tỷ lệ tự phục hồi = (skill_hit + llm_healed) / total
    const autoHealRate = total > 0
      ? Math.round(((byResolution.skill_library_hit + byResolution.llm_healed) / total) * 100)
      : 0;

    return {
      total,
      byResolution,
      byTier,
      totalTokensUsed,
      totalTokensSaved,
      autoHealRate,
    };
  }

  /** Xóa toàn bộ log */
  public clear() {
    this.events = [];
    this.save();
    logger.warn('[HealingLog] Đã xóa toàn bộ healing log.');
  }
}

export const healingLog = new HealingLog();
