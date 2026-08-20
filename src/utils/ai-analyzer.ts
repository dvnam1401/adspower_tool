import { Page } from 'playwright-core';
import { config, getEffectiveLLMConfig } from '../config/index.js';
import { logger } from './logger.js';
import { skillRepository } from '../skills/repository.js';
import { broadcastEvent } from '../server/app.js';

export interface AIPageAnalysisResult {
  classification: 'LOGGED_IN' | 'SOLVABLE_INTERACTION' | 'UNSOLVABLE_OBSTACLE' | 'UNKNOWN';
  reason: string;
  recommendedSelector?: string;
  recommendedAction?: 'click' | 'fill' | 'dismiss' | 'wait' | 'none';
  skillName?: string;
}

export class AIPageAnalyzer {
  /**
   * Analyze active browser page using configured LLM (9router / Gemini API)
   * to determine current state, resolve obstacles, and auto-learn skills.
   */
  public async analyzeAndResolve(page: Page, currentUrl: string, profileId?: string): Promise<AIPageAnalysisResult> {
    if (!page || page.isClosed()) {
      return { classification: 'UNKNOWN', reason: 'Page closed' };
    }

    try {
      // 1. Extract DOM snapshot text and interactive buttons
      const pageInfo = (await page.evaluate(`(function() {
        var bodyText = document.body ? document.body.innerText.substring(0, 3000) : '';
        var buttons = Array.from(document.querySelectorAll('button, div[role="button"], a, input[type="submit"], input[type="button"]'))
          .slice(0, 30)
          .map(function(el) {
            return {
              text: (el.innerText || el.textContent || el.getAttribute('aria-label') || el.value || '').trim(),
              tag: el.tagName.toLowerCase(),
              role: el.getAttribute('role') || '',
              id: el.id || '',
              name: el.getAttribute('name') || '',
              ariaLabel: el.getAttribute('aria-label') || '',
            };
          })
          .filter(function(b) { return b.text.length > 0 && b.text.length < 100; });

        return {
          title: document.title,
          url: window.location.href,
          bodySnippet: bodyText,
          interactiveElements: buttons
        };
      })()`).catch(() => null)) as { title: string; url: string; bodySnippet: string; interactiveElements: any[] } | null;

      if (!pageInfo) {
        return { classification: 'UNKNOWN', reason: 'Could not extract DOM snapshot' };
      }

      logger.info(`[AI Page Analyzer] Đang phân tích trang qua AI (${currentUrl}). Title: "${pageInfo.title}"...`);

      // 2. Fast heuristic pre-check to prevent unnecessary API latency if obvious logged in elements exist
      const isFeedPresent = pageInfo.bodySnippet.includes("What's on your mind") ||
                            pageInfo.bodySnippet.includes("Bạn đang nghĩ gì") ||
                            pageInfo.bodySnippet.includes("Create story") ||
                            pageInfo.bodySnippet.includes("Tạo tin") ||
                            pageInfo.bodySnippet.includes("Group chats") ||
                            pageInfo.bodySnippet.includes("Meta AI");

      if (isFeedPresent) {
        logger.info('[AI Heuristic Match] Phát hiện các thành phần Trang chủ / Bảng tin Facebook -> Đã ĐĂNG NHẬP!');
        return {
          classification: 'LOGGED_IN',
          reason: 'Dấu hiệu bảng tin/giao diện cá nhân Facebook hiển thị rõ ràng.',
        };
      }

      // 3. Query LLM API (9router / Gemini Direct / OpenAI format)
      const llm = getEffectiveLLMConfig();
      const baseUrl = llm.baseUrl.replace(/\/+$/, '');
      const model = llm.model;
      const apiKey = llm.apiKey || 'sk-dummy';

      const prompt = `Bạn là hệ thống AI phân tích tự động hóa trình duyệt web.
Hãy phân tích thông tin trang web bên dưới và trả về duy nhất 1 JSON object hợp lệ theo format:
{
  "classification": "LOGGED_IN" | "SOLVABLE_INTERACTION" | "UNSOLVABLE_OBSTACLE" | "UNKNOWN",
  "reason": "Giải thích ngắn gọn lý do bằng tiếng Việt",
  "recommendedSelector": "Selector CSS hoặc text button để bấm nếu có",
  "recommendedAction": "click" | "fill" | "dismiss" | "wait" | "none",
  "skillName": "Tên skill nếu cần lưu lại (ví dụ: click_dismiss_popup)"
}

Quy tắc phân loại:
1. "LOGGED_IN": Nếu thấy giao diện bảng tin (Feed), trang cá nhân, thông báo, messenger, ô tìm kiếm Facebook.
2. "SOLVABLE_INTERACTION": Nếu có nút Lưu trình duyệt, Trust this device, Dismiss, Skip, Bỏ qua, Lưu, Tiếp tục, OK, Đóng.
3. "UNSOLVABLE_OBSTACLE": Nếu là trang bị khóa (Locked/Suspended), reCAPTCHA/Puzzle giải đố con người, Sai mật khẩu, Bắt tải ID.
4. "UNKNOWN": Các trường hợp khác.

THÔNG TIN TRANG WEB:
URL: ${pageInfo.url}
Title: ${pageInfo.title}
Nội dung văn bản: ${pageInfo.bodySnippet}
Danh sách nút tương tác: ${JSON.stringify(pageInfo.interactiveElements)}
`;

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'Trả về duy nhất định dạng JSON thuần túy, không dùng markdown ```json block.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.1,
        }),
      }).catch(() => null);

      if (response && response.ok) {
        const data: any = await response.json();
        const rawContent = data?.choices?.[0]?.message?.content || '';
        const cleanedJson = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleanedJson) as AIPageAnalysisResult;

        logger.info(`[AI Page Analyzer Result] Phân loại: ${parsed.classification} | Lý do: ${parsed.reason}`);

        // If AI identified a solvable interaction with recommended selector, auto-learn skill
        if (parsed.classification === 'SOLVABLE_INTERACTION' && parsed.recommendedSelector) {
          this.learnAndPersistSkill(parsed.skillName || 'ai_resolved_interaction', currentUrl, parsed.recommendedSelector);
        }

        return parsed;
      }
    } catch (err: any) {
      logger.warn(`[AI Page Analyzer Note] Lỗi khi gọi AI phân tích: ${err.message}`);
    }

    return { classification: 'UNKNOWN', reason: 'Fallback do không gọi được AI phân tích' };
  }

  /**
   * Persist dynamically learned skill to skills.json
   */
  private learnAndPersistSkill(skillName: string, siteUrl: string, selector: string) {
    try {
      const hostname = new URL(siteUrl).hostname;
      const skillId = `${hostname}_${skillName.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;

      skillRepository.saveSkill({
        skillId,
        site: hostname,
        actionType: skillName,
        status: 'verified',
        selectorChain: [
          { type: 'css', value: selector, priority: 1 },
          { type: 'text', value: selector, priority: 2 },
        ],
        createdBy: 'agent',
        createdAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        successCount: 1,
        failCount: 0,
        version: 1,
        notes: `Tự động học và cập nhật bởi AI khi xử lý trang: ${siteUrl}`,
      });

      logger.info(`🧠 [Skill Auto-Learned] Đã học và cập nhật skill mới vào kho kiến thức: "${skillId}" (Selector: ${selector})`);
      broadcastEvent('skill_learned', { skillId, site: hostname, selector });
    } catch (e: any) {
      logger.warn(`[Skill Learn Error] ${e.message}`);
    }
  }
}

export const aiPageAnalyzer = new AIPageAnalyzer();
