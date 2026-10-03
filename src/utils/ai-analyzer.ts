import { Page } from 'playwright-core';
import crypto from 'crypto';
import { config, getEffectiveLLMConfig } from '../config/index.js';
import { logger } from './logger.js';
import { skillRepository, SkillRepository } from '../skills/repository.js';
import { healingLog } from '../recovery/healing-log.js';
import { errorClassifier } from '../recovery/classifier.js';
import { broadcastEvent } from '../server/app.js';
import { SelectorType } from '../types/index.js';

// ============================================================================
// Phân cấp ưu tiên selector theo đặc tả PHẦN 3:
// data-testid > aria-label > CSS > text > XPath
// ============================================================================
export interface SelectorCandidate {
  type: SelectorType;   // Dùng SelectorType từ types/index.ts (data-testid > aria-label > css > text > xpath)
  value: string;
  priority: number;      // 1 = cao nhất, 5 = thấp nhất
  reasoning: string;     // Lý do chọn selector này (tiếng Việt) — dùng cho Self-Healing Monitor
}

export interface AIPageAnalysisResult {
  classification: 'LOGGED_IN' | 'SOLVABLE_INTERACTION' | 'UNSOLVABLE_OBSTACLE' | 'UNKNOWN';
  reason: string;                      // Giải thích bằng tiếng Việt
  selectors?: SelectorCandidate[];     // Multi-selector có phân cấp ưu tiên
  recommendedSelector?: string;        // Backward compat — lấy từ selectors[0].value
  recommendedAction?: 'click' | 'fill' | 'dismiss' | 'wait' | 'none';
  skillName?: string;
  visionUsed?: boolean;                // true nếu fallback sang Vision (screenshot)
}

export class AIPageAnalyzer {
  /**
   * Ghi một HealingEvent vào healing-log DÙNG CHUNG để quan sát (observability §8)
   * bao phủ cả luồng đăng nhập Facebook — trước đây luồng này bị "mù" vì dùng
   * AI path riêng, không ghi log healing.
   */
  private logHealing(params: {
    site: string;
    actionType: string;
    errorTier: 'transient' | 'structural' | 'blocked' | 'data' | 'unknown';
    errorMessage: string;
    resolution: 'skill_library_hit' | 'llm_healed' | 'escalated';
    skillId?: string;
    tokensUsed?: number;
    tokensSaved?: number;
    startTime: number;
  }) {
    try {
      healingLog.addEvent({
        eventId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        site: params.site,
        actionType: params.actionType,
        errorTier: params.errorTier,
        errorMessage: params.errorMessage,
        skillId: params.skillId,
        resolution: params.resolution,
        tokensUsed: params.tokensUsed,
        tokensSaved: params.tokensSaved,
        durationMs: Date.now() - params.startTime,
      });
    } catch (e: any) {
      logger.warn(`[AI HealingLog] Không ghi được healing event: ${e.message}`);
    }
  }

  /**
   * Analyze active browser page using configured LLM (9router / Gemini API)
   * to determine current state, resolve obstacles, and auto-learn skills.
   *
   * Theo đặc tả PHẦN 3:
   * - Kiểm tra Skill Library TRƯỚC, chỉ gọi AI khi không có skill sẵn
   * - Không xử lý lỗi Tier 1 (network/timeout) — để retry tự động
   * - Không giải CAPTCHA / tài khoản bị chặn → escalate người dùng
   * - Trả kết quả JSON với selectors[] phân cấp ưu tiên
   * - Kết quả AI phải qua canary testing trước khi thành skill chính thức
   */
  public async analyzeAndResolve(page: Page, currentUrl: string, profileId?: string): Promise<AIPageAnalysisResult> {
    if (!page || page.isClosed()) {
      return { classification: 'UNKNOWN', reason: 'Page closed' };
    }

    const startTime = Date.now();

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
              dataTestId: el.getAttribute('data-testid') || '',
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

      logger.info(`[AI Page Analyzer] Đang phân tích trang (${currentUrl}). Title: "${pageInfo.title}"...`);

      // 2. AI KHÔNG có quyền tuyên bố ĐÃ ĐĂNG NHẬP (theo đặc tả PHẦN 3).
      //    Quyền phán quyết success thuộc LoginStateDetector (cookie c_user / /me)
      //    trong facebook-login.ts. Bỏ heuristic "Meta AI"/"Group chats" yếu vốn
      //    gây báo nhầm LOGGED_IN. Ở đây chỉ ghi nhận dấu hiệu bảng tin để log tham khảo.
      const strongFeedSignal = pageInfo.bodySnippet.includes("What's on your mind") ||
                               pageInfo.bodySnippet.includes("Bạn đang nghĩ gì") ||
                               pageInfo.bodySnippet.includes("Create story") ||
                               pageInfo.bodySnippet.includes("Tạo tin");
      if (strongFeedSignal) {
        logger.info('[AI Heuristic] Thấy dấu hiệu bảng tin, nhưng AI không tự kết luận đăng nhập — nhường LoginStateDetector xác nhận.');
      }

      // ======================================================================
      // 3. KIỂM TRA SKILL LIBRARY TRƯỚC KHI GỌI AI (theo đặc tả PHẦN 3)
      // Nếu đã có skill sẵn cho tình huống này → dùng ngay, KHÔNG gọi AI
      // ======================================================================
      const hostname = new URL(currentUrl).hostname;
      // Tìm skill theo URL pattern + các action type phổ biến
      const commonActionTypes = ['click_dismiss_popup', 'click_trust_device', 'click_continue', 'fill_2fa_code'];
      for (const actionType of commonActionTypes) {
        const existingSkill = skillRepository.find(hostname, actionType);
        if (existingSkill && existingSkill.status !== 'rollback' && existingSkill.selectorChain?.length > 0) {
          logger.info(`[AI Skip] Tìm thấy Skill Library "${existingSkill.skillId}" (status: ${existingSkill.status}) -> Bỏ qua AI, dùng skill sẵn.`);
          const topSelector = existingSkill.selectorChain[0];
          // Observability: skill hit tiết kiệm token gọi LLM
          this.logHealing({
            site: hostname,
            actionType,
            errorTier: 'structural',
            errorMessage: `Dùng skill sẵn từ Skill Library (${existingSkill.skillId})`,
            resolution: 'skill_library_hit',
            skillId: existingSkill.skillId,
            tokensSaved: 1200,
            startTime,
          });
          return {
            classification: 'SOLVABLE_INTERACTION',
            reason: `Dùng skill sẵn có từ Skill Library: "${existingSkill.skillId}". Không gọi AI.`,
            selectors: existingSkill.selectorChain.map((s, idx) => ({
              type: (s.type || 'css') as SelectorCandidate['type'],
              value: s.value,
              priority: idx + 1,
              reasoning: `Từ Skill Library (${existingSkill.skillId})`,
            })),
            recommendedSelector: topSelector?.value,
            recommendedAction: 'click',
            skillName: existingSkill.skillId,
          };
        }
      }

      // 4. Query LLM API (9router / Gemini Direct / OpenAI format)
      const llm = getEffectiveLLMConfig();
      const baseUrl = llm.baseUrl.replace(/\/+$/, '');
      const model = llm.model;
      const apiKey = llm.apiKey || 'sk-dummy';

      const prompt = `Bạn là hệ thống AI phân tích tự động hóa trình duyệt web (Self-Healing Monitor).
Hãy phân tích thông tin trang web bên dưới và trả về duy nhất 1 JSON object hợp lệ theo format:
{
  "classification": "LOGGED_IN" | "SOLVABLE_INTERACTION" | "UNSOLVABLE_OBSTACLE" | "UNKNOWN",
  "reason": "Giải thích ngắn gọn lý do bằng tiếng Việt (hiển thị trên Self-Healing Monitor)",
  "selectors": [
    {
      "type": "data-testid" | "aria-label" | "css" | "text" | "xpath",
      "value": "Selector cụ thể",
      "priority": 1,
      "reasoning": "Lý do chọn selector này bằng tiếng Việt"
    }
  ],
  "recommendedAction": "click" | "fill" | "dismiss" | "wait" | "none",
  "skillName": "Tên skill để lưu (ví dụ: click_dismiss_popup)"
}

QUAN TRỌNG — Phân cấp ưu tiên selector (từ cao xuống thấp):
1. data-testid (ổn định nhất, ít thay đổi)
2. aria-label (phù hợp với accessibility)
3. CSS selector (class/id)
4. text selector (nội dung văn bản)
5. XPath (cuối cùng, khi các cách trên đều thất bại)

Trả về TỐI THIỂU 2 selectors khác loại để hệ thống có fallback khi trang thay đổi nhỏ.

Quy tắc phân loại (NGHIÊM NGẶT):
1. "LOGGED_IN": Thấy giao diện bảng tin (Feed), trang cá nhân, thông báo, messenger, ô tìm kiếm Facebook.
2. "SOLVABLE_INTERACTION": Có nút Lưu trình duyệt, Trust this device, Dismiss, Skip, Bỏ qua, Lưu, Tiếp tục, OK, Đóng.
3. "UNSOLVABLE_OBSTACLE": Trang bị khóa/Suspended, reCAPTCHA/Puzzle giải đố, Sai mật khẩu, Bắt tải CMND/Selfie.
   ⚠️ KHÔNG được xử lý UNSOLVABLE_OBSTACLE — phải trả về để escalate cho người dùng.
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

        // ⚠️ AI KHÔNG được tự tuyên bố LOGGED_IN. Nếu AI trả LOGGED_IN, hạ xuống
        // UNKNOWN để LoginStateDetector (cookie c_user / /me) là nơi xác nhận cuối.
        if (parsed.classification === 'LOGGED_IN') {
          logger.info('[AI Guard] AI trả LOGGED_IN -> hạ xuống UNKNOWN, nhường LoginStateDetector phán quyết.');
          parsed.classification = 'UNKNOWN';
          parsed.reason = `(AI nghĩ đã đăng nhập nhưng cần LoginStateDetector xác nhận) ${parsed.reason || ''}`.trim();
        }

        // Normalize: đảm bảo recommendedSelector luôn có giá trị (backward compat)
        if (parsed.selectors && parsed.selectors.length > 0) {
          const sorted = [...parsed.selectors].sort((a, b) => a.priority - b.priority);
          parsed.selectors = sorted;
          parsed.recommendedSelector = parsed.recommendedSelector || sorted[0]?.value;
        }

        // Broadcast lên Self-Healing Monitor tab
        broadcastEvent('ai_analysis_result', {
          classification: parsed.classification,
          reason: parsed.reason,
          selectors: parsed.selectors,
          url: currentUrl,
          time: new Date().toLocaleTimeString(),
        });

        // ====================================================================
        // CANARY LEARNING: skill mới từ AI bắt đầu với status='candidate'
        // Vòng đời & ngưỡng promote dùng CHUNG SkillRepository (§5), không còn
        // ngưỡng riêng lệch nhau.
        // ====================================================================
        if (parsed.classification === 'SOLVABLE_INTERACTION' && parsed.selectors && parsed.selectors.length > 0) {
          this.learnAndPersistSkill(
            parsed.skillName || 'ai_resolved_interaction',
            currentUrl,
            parsed.selectors,
            parsed.reason
          );
          // Observability: AI Agent tìm được selector để xử lý bất thường
          this.logHealing({
            site: hostname,
            actionType: parsed.skillName || 'ai_resolved_interaction',
            errorTier: 'structural',
            errorMessage: parsed.reason || 'Trang bất thường — AI Agent xử lý',
            resolution: 'llm_healed',
            tokensUsed: (data?.usage?.total_tokens as number) || 0,
            startTime,
          });
        } else if (parsed.classification === 'UNSOLVABLE_OBSTACLE') {
          // Escalate người dùng — phân tầng lỗi qua bộ classifier DÙNG CHUNG
          const classified = errorClassifier.classify(parsed.reason || 'Chướng ngại không thể tự xử lý', hostname);
          this.logHealing({
            site: hostname,
            actionType: parsed.skillName || 'unsolvable_obstacle',
            errorTier: classified.tier,
            errorMessage: parsed.reason || 'UNSOLVABLE_OBSTACLE',
            resolution: 'escalated',
            tokensUsed: (data?.usage?.total_tokens as number) || 0,
            startTime,
          });
        }

        return parsed;
      }

      // ======================================================================
      // 5. VISION FALLBACK: DOM không đủ thông tin (trang canvas/ẩn HTML)
      // Chỉ dùng khi bước DOM/text thất bại để tránh tốn token
      // ======================================================================
      const isDomTooShort = pageInfo.bodySnippet.length < 100 || pageInfo.interactiveElements.length === 0;
      if (isDomTooShort) {
        logger.info('[AI Vision Fallback] DOM quá ít thông tin -> Thử phân tích qua screenshot...');
        const visionResult = await this.analyzeViaVision(page, currentUrl, apiKey, baseUrl, model);
        if (visionResult) {
          return { ...visionResult, visionUsed: true };
        }
      }

    } catch (err: any) {
      logger.warn(`[AI Page Analyzer Note] Lỗi khi gọi AI phân tích: ${err.message}`);
    }

    return { classification: 'UNKNOWN', reason: 'Fallback do không gọi được AI phân tích' };
  }

  /**
   * Vision Fallback: phân tích qua screenshot khi DOM không đủ thông tin.
   * Chỉ được gọi khi bước DOM/text thất bại (tốn token hơn).
   */
  private async analyzeViaVision(
    page: Page,
    currentUrl: string,
    apiKey: string,
    baseUrl: string,
    model: string
  ): Promise<AIPageAnalysisResult | null> {
    try {
      const screenshotBuffer = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => null);
      if (!screenshotBuffer) return null;

      const base64Image = screenshotBuffer.toString('base64');

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Phân tích ảnh chụp màn hình trang Facebook này (URL: ${currentUrl}) và xác định trạng thái.
Trả về JSON: {"classification": "LOGGED_IN"|"SOLVABLE_INTERACTION"|"UNSOLVABLE_OBSTACLE"|"UNKNOWN", "reason": "...(tiếng Việt)", "selectors": [], "recommendedAction": "click"|"fill"|"dismiss"|"wait"|"none"}`
                },
                {
                  type: 'image_url',
                  image_url: { url: `data:image/jpeg;base64,${base64Image}` }
                }
              ]
            }
          ],
          temperature: 0.1,
        }),
      }).catch(() => null);

      if (response && response.ok) {
        const data: any = await response.json();
        const rawContent = data?.choices?.[0]?.message?.content || '';
        const cleanedJson = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleanedJson) as AIPageAnalysisResult;
        logger.info(`[AI Vision Result] Phân loại: ${parsed.classification} | Lý do: ${parsed.reason}`);
        return parsed;
      }
    } catch (e: any) {
      logger.warn(`[AI Vision Fallback Error] ${e.message}`);
    }
    return null;
  }

  /**
   * Persist dynamically learned skill dùng CHUNG vòng đời của SkillRepository (§5):
   * saveSkill() tạo/ghép selector, recordSuccess() lo việc thăng hạng
   * candidate -> testing -> verified theo NGƯỠNG DUY NHẤT (SkillRepository.PROMOTE_THRESHOLD).
   * Không còn tự ghi trực tiếp status 'verified' với ngưỡng riêng.
   */
  private learnAndPersistSkill(
    skillName: string,
    siteUrl: string,
    selectors: SelectorCandidate[],
    reasoning: string
  ) {
    try {
      const hostname = new URL(siteUrl).hostname;
      const existingSkill = skillRepository.find(hostname, skillName);

      // Skill đã verified thì không cần học lại
      if (existingSkill && existingSkill.status === 'verified') {
        logger.info(`[Skill Canary] Skill "${existingSkill.skillId}" đã VERIFIED — chỉ ghi nhận thành công.`);
        skillRepository.recordSuccess(existingSkill.skillId);
        return;
      }

      const selectorChain = selectors.map(s => ({
        type: s.type,
        value: s.value,
        priority: s.priority,
      }));

      // saveSkill: nếu đã tồn tại -> ghép selector + đưa về 'testing' + bump version;
      // nếu chưa -> tạo mới 'candidate'.
      const skillId = existingSkill?.skillId || `${hostname}_${skillName.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
      skillRepository.saveSkill({
        skillId,
        site: hostname,
        actionType: skillName,
        status: 'candidate',
        selectorChain,
        createdBy: 'agent',
        createdAt: existingSkill?.createdAt || new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        successCount: existingSkill?.successCount || 0,
        failCount: 0,
        version: existingSkill ? existingSkill.version + 1 : 1,
        notes: `[Canary] Tự động học bởi AI. Reasoning: ${reasoning}. Cần ${SkillRepository.PROMOTE_THRESHOLD} lần thành công để lên verified.`,
        previousVersions: existingSkill?.selectorChain ? [JSON.stringify(existingSkill.selectorChain)] : [],
      });

      // Ghi nhận 1 lần thành công -> repository quyết định thăng hạng theo ngưỡng chung
      skillRepository.recordSuccess(skillId);
      const saved = skillRepository.getById(skillId);
      logger.info(`🧠 [Skill Canary] "${skillId}" -> status: ${saved?.status} (${saved?.successCount}/${SkillRepository.PROMOTE_THRESHOLD}).`);

      broadcastEvent('skill_learned', {
        skillId,
        site: hostname,
        selectors: selectorChain,
        status: saved?.status || 'candidate',
        reasoning,
      });
    } catch (e: any) {
      logger.warn(`[Skill Learn Error] ${e.message}`);
    }
  }
}

export const aiPageAnalyzer = new AIPageAnalyzer();
