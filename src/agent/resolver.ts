/**
 * LLM Agent Resolver — Self-Healing Brain
 *
 * Khi bộ phân loại phát hiện lỗi Tầng 2 (Structural), Agent này:
 * 1. Tra cứu Skill Library trước (tiết kiệm token).
 * 2. Nếu không có → gọi LLM với DOM snapshot / A11y tree.
 * 3. Vision fallback → chụp screenshot nếu DOM không đủ thông tin.
 * 4. Lưu candidate skill vào Skill Library.
 * 5. Ghi HealingEvent vào healing log.
 */

import crypto from 'crypto';
import { getEffectiveLLMConfig } from '../config/index.js';
import { skillRepository } from '../skills/repository.js';
import { healingLog } from '../recovery/healing-log.js';
import {
  LLMResolverRequest,
  LLMResolverResponse,
  HealingEvent,
  SelectorItem,
  Skill,
} from '../types/index.js';
import { logger } from '../utils/logger.js';

// ─── LLM Prompt Builder ────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are a web automation self-healing agent. Your job is to find correct CSS/XPath selectors for a UI element that has changed.

RULES:
- Return ONLY valid JSON with this exact schema: {"selectors": [{"type": "css"|"xpath"|"text"|"aria-label"|"role", "value": "...", "priority": 1}], "reasoning": "..."}
- Provide 3-5 selectors ordered by reliability (most robust first).
- Prefer: data-testid > aria-label > CSS class > text content > XPath.
- Never use auto-generated class names (e.g., classes with random hashes like "sc-abc123").
- reasoning field is a brief explanation in Vietnamese.`;
}

function buildUserPrompt(req: LLMResolverRequest): string {
  let prompt = `TÌM SELECTOR CHO: "${req.targetDescription}"
Site: ${req.site}
Action: ${req.actionType}
URL: ${req.currentUrl || 'unknown'}`;

  if (req.failedSelectors && req.failedSelectors.length > 0) {
    prompt += `\n\nSELECTOR CŨ (ĐÃ THẤT BẠI):
${JSON.stringify(req.failedSelectors, null, 2)}`;
  }

  if (req.domSnapshot) {
    const trimmed = req.domSnapshot.substring(0, 6000); // Giới hạn 6000 chars
    prompt += `\n\nDOM SNAPSHOT (A11Y TREE):
${trimmed}${req.domSnapshot.length > 6000 ? '\n...[truncated]' : ''}`;
  }

  prompt += `\n\nHãy phân tích và trả về JSON với các selector mới phù hợp.`;
  return prompt;
}

// ─── Main Resolver ─────────────────────────────────────────────────────────────

export class LLMAgentResolver {
  private readonly ESTIMATED_TOKENS_SAVED_FROM_SKILL_HIT = 500;

  /**
   * Điểm vào chính: Cố gắng tự sửa lỗi structural
   */
  public async resolve(
    req: LLMResolverRequest,
    options: { visionFallback?: boolean; screenshotBase64?: string } = {}
  ): Promise<LLMResolverResponse & { healingEventId?: string }> {
    const startTime = Date.now();

    // ── Bước 1: Tra cứu Skill Library ──────────────────────────────────────
    const existingSkill = skillRepository.find(req.site, req.actionType);
    if (existingSkill && existingSkill.status !== 'rollback') {
      logger.info(
        `[LLMAgent] Skill Library HIT: ${existingSkill.skillId} (${existingSkill.status})`
      );

      const event = this.recordHealingEvent({
        site: req.site,
        actionType: req.actionType,
        errorTier: 'structural',
        errorMessage: `Structural error — resolved from Skill Library`,
        oldSelectors: req.failedSelectors,
        newSelectors: existingSkill.selectorChain,
        skillId: existingSkill.skillId,
        resolution: 'skill_library_hit',
        tokensUsed: 0,
        tokensSaved: this.ESTIMATED_TOKENS_SAVED_FROM_SKILL_HIT,
        durationMs: Date.now() - startTime,
        visionFallbackUsed: false,
      });

      return {
        success: true,
        selectors: existingSkill.selectorChain,
        reasoning: `Lấy từ Skill Library: ${existingSkill.skillId} (${existingSkill.status})`,
        tokensUsed: 0,
        visionUsed: false,
        healingEventId: event.eventId,
      };
    }

    // ── Bước 2: Gọi LLM ────────────────────────────────────────────────────
    logger.info(`[LLMAgent] Skill Library MISS — Gọi LLM để tự sửa: ${req.site}/${req.actionType}`);

    let visionUsed = false;
    let screenshotBase64 = options.screenshotBase64;

    // Nếu DOM snapshot trống → kích hoạt vision fallback
    if (!req.domSnapshot || req.domSnapshot.trim().length < 50) {
      if (options.visionFallback && screenshotBase64) {
        visionUsed = true;
        logger.info('[LLMAgent] DOM snapshot trống → Kích hoạt Vision Fallback (screenshot).');
      }
    }

    const llmResult = await this.callLLM(req, visionUsed ? screenshotBase64 : undefined);

    if (!llmResult.success || llmResult.selectors.length === 0) {
      const event = this.recordHealingEvent({
        site: req.site,
        actionType: req.actionType,
        errorTier: 'structural',
        errorMessage: llmResult.error || 'LLM could not produce selectors',
        oldSelectors: req.failedSelectors,
        resolution: 'escalated',
        tokensUsed: llmResult.tokensUsed || 0,
        durationMs: Date.now() - startTime,
        visionFallbackUsed: visionUsed,
      });

      logger.warn(`[LLMAgent] Không thể tự sửa — Escalating to user. EventId: ${event.eventId}`);
      return { ...llmResult, healingEventId: event.eventId };
    }

    // ── Bước 3: Lưu candidate skill vào Skill Library ───────────────────────
    const skillId = `agent_${req.site.replace(/[^a-z0-9]/gi, '_')}_${req.actionType}_${Date.now()}`;
    const newSkill: Skill = {
      skillId,
      site: req.site,
      actionType: req.actionType,
      status: 'candidate',
      selectorChain: llmResult.selectors,
      createdBy: 'agent',
      createdAt: new Date().toISOString(),
      successCount: 0,
      failCount: 0,
      version: 1,
      notes: `LLM Agent tự tạo. Reasoning: ${llmResult.reasoning || 'N/A'}`,
      previousVersions: req.failedSelectors
        ? [JSON.stringify(req.failedSelectors)]
        : [],
    };

    skillRepository.saveSkill(newSkill);
    logger.info(`[LLMAgent] Đã lưu candidate skill: ${skillId}`);

    const event = this.recordHealingEvent({
      site: req.site,
      actionType: req.actionType,
      errorTier: 'structural',
      errorMessage: `Structural error — healed by LLM Agent`,
      oldSelectors: req.failedSelectors,
      newSelectors: llmResult.selectors,
      skillId,
      resolution: 'llm_healed',
      tokensUsed: llmResult.tokensUsed || 0,
      durationMs: Date.now() - startTime,
      visionFallbackUsed: visionUsed,
    });

    return { ...llmResult, visionUsed, healingEventId: event.eventId };
  }

  /** Gọi LLM API (OpenAI-compatible endpoint) */
  private async callLLM(
    req: LLMResolverRequest,
    screenshotBase64?: string
  ): Promise<LLMResolverResponse> {
    const llmCfg = getEffectiveLLMConfig();

    if (!llmCfg.apiKey) {
      logger.warn('[LLMAgent] Chưa cấu hình API Key LLM — không thể gọi Agent.');
      return {
        success: false,
        selectors: [],
        error: 'LLM API Key chưa được cấu hình trong Settings.',
      };
    }

    const messages: any[] = [
      { role: 'system', content: buildSystemPrompt() },
    ];

    // Build user message (text + optional image)
    if (screenshotBase64) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: buildUserPrompt(req) },
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` },
          },
        ],
      });
    } else {
      messages.push({ role: 'user', content: buildUserPrompt(req) });
    }

    try {
      const apiUrl = `${llmCfg.baseUrl}/chat/completions`;
      const body = {
        model: llmCfg.model,
        messages,
        temperature: 0.2,
        max_tokens: 1024,
        response_format: { type: 'json_object' },
      };

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${llmCfg.apiKey}`,
      };

      // 9router group header
      if (llmCfg.provider === '9router' && llmCfg.group) {
        headers['X-Group'] = llmCfg.group;
      }

      logger.info(`[LLMAgent] Gọi LLM: ${llmCfg.provider}/${llmCfg.model} @ ${apiUrl}`);

      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`LLM API Error ${resp.status}: ${errText.substring(0, 200)}`);
      }

      const data = await resp.json() as any;
      const content = data.choices?.[0]?.message?.content || '';
      const tokensUsed = data.usage?.total_tokens || 0;

      let parsed: any;
      try {
        parsed = JSON.parse(content);
      } catch {
        // Thử extract JSON từ markdown
        const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (match) {
          parsed = JSON.parse(match[1]);
        } else {
          throw new Error(`LLM không trả về JSON hợp lệ: ${content.substring(0, 100)}`);
        }
      }

      const selectors: SelectorItem[] = (parsed.selectors || []).map((s: any, i: number) => ({
        type: s.type || 'css',
        value: String(s.value || ''),
        priority: s.priority || i + 1,
      })).filter((s: SelectorItem) => s.value.trim().length > 0);

      if (selectors.length === 0) {
        throw new Error('LLM trả về selectors rỗng.');
      }

      logger.info(`[LLMAgent] LLM thành công: ${selectors.length} selectors, ${tokensUsed} tokens.`);

      return {
        success: true,
        selectors,
        reasoning: parsed.reasoning || '',
        tokensUsed,
        visionUsed: !!screenshotBase64,
      };
    } catch (err: any) {
      logger.error(`[LLMAgent] Gọi LLM thất bại: ${err.message}`);
      return {
        success: false,
        selectors: [],
        error: err.message,
      };
    }
  }

  /** Tạo và lưu HealingEvent vào log */
  private recordHealingEvent(params: Omit<HealingEvent, 'eventId' | 'timestamp'>): HealingEvent {
    const event: HealingEvent = {
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...params,
    };
    healingLog.addEvent(event);
    return event;
  }
}

export const llmAgentResolver = new LLMAgentResolver();
