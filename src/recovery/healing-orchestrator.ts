import { Page } from 'playwright-core';
import { cdpManager } from '../dom/cdp.js';
import { errorClassifier } from './classifier.js';
import { llmAgentResolver } from '../agent/resolver.js';
import { skillRepository } from '../skills/repository.js';
import { logger } from '../utils/logger.js';
import { DOMAction, DOMActionResult, WorkflowStep, SelectorItem } from '../types/index.js';

export interface HealingContext {
  profileId: string;
  site: string;
  step?: WorkflowStep;
  wsEndpoint?: string;
}

export class SelfHealingOrchestrator {
  /**
   * Execute a DOM Action with full self-healing lifecycle.
   */
  public async executeWithHealing(
    action: DOMAction,
    page: Page,
    context: HealingContext
  ): Promise<DOMActionResult> {
    const startTime = Date.now();
    let currentAction = { ...action };

    // 1. Kiểm tra Skill Library (Phase: Fast path - no LLM)
    const existingSkill = skillRepository.find(context.site, currentAction.actionType);
    let usedSkillId = '';

    if (existingSkill && existingSkill.status !== 'rollback') {
      logger.info(`[Healer] ⚡ Skill Library HIT: "${existingSkill.skillId}" (status: ${existingSkill.status})`);
      // Ghi đè selectorChain bằng skill đã học
      currentAction.selectorChain = existingSkill.selectorChain;
      currentAction.skillId = existingSkill.skillId;
      usedSkillId = existingSkill.skillId;
    } else {
      logger.debug(`[Healer] 🔍 Skill Library MISS for ${context.site}/${currentAction.actionType}`);
    }

    // 2. Thực thi Action lần 1
    let result = await cdpManager.executeAction(context.profileId, currentAction);

    // Thành công ngay từ lần đầu (hoặc nhờ Skill Library)
    if (result.success) {
      if (usedSkillId) {
        skillRepository.recordSuccess(usedSkillId);
      }
      return result;
    }

    // Thất bại -> Báo lỗi cho Skill nếu dùng
    if (usedSkillId) {
      logger.warn(`[Healer] ⚠️ Skill "${usedSkillId}" thất bại trong thực tế -> Ghi nhận failure.`);
      skillRepository.recordFailure(usedSkillId);
    }

    // 3. Phân loại lỗi
    const errorMsg = result.error || 'Unknown DOM execution error';
    const classified = errorClassifier.classify(errorMsg, context.site, currentAction);

    logger.warn(`[Healer] 🚨 Lỗi phân loại: [Tier: ${classified.tier.toUpperCase()}] - ${classified.message}`);

    // Tier 1: Transient (Vấn đề mạng / Load chậm)
    if (classified.tier === 'transient') {
      logger.info(`[Healer] 🔄 Lỗi mạng/load, thử lại tối đa 3 lần...`);
      try {
        result = await errorClassifier.withRetry(
          async () => {
            const retryRes = await cdpManager.executeAction(context.profileId, currentAction);
            if (!retryRes.success) throw new Error(retryRes.error);
            return retryRes;
          },
          { maxRetries: 3, site: context.site, action: currentAction }
        );
        return result;
      } catch (err: any) {
        return { ...result, success: false, error: err.message };
      }
    }

    // Tier 3: Blocked / Data (Vấn đề nghiệp vụ / CAPTCHA)
    if (classified.tier === 'blocked' || classified.tier === 'data') {
      logger.error(`[Healer] 🛑 Escalate lỗi nghiệp vụ / Blocked tới người dùng.`);
      return { ...result, success: false, error: classified.message };
    }

    // Tier 2: Structural (Lỗi DOM/Selector) -> Gọi LLM Agent
    if (classified.tier === 'structural') {
      logger.info(`[Healer] 🤖 Gọi LLM Agent để sửa selector cho ${currentAction.targetDescription}...`);
      
      const domSnapshot = await cdpManager.getDOMSnapshot(page);
      
      const llmResult = await llmAgentResolver.resolve({
        site: context.site,
        actionType: currentAction.actionType,
        targetDescription: currentAction.targetDescription,
        domSnapshot: domSnapshot,
        currentUrl: page.url(),
        failedSelectors: currentAction.selectorChain,
      });

      if (llmResult.success && llmResult.selectors.length > 0) {
        logger.info(`[Healer] 💡 LLM Agent tìm được ${llmResult.selectors.length} selectors mới. Reasoning: ${llmResult.reasoning}`);
        
        // Cập nhật lại action với selector mới
        const healedAction = { ...currentAction, selectorChain: llmResult.selectors };
        
        // Thử chạy lại với selector mới
        const retryResult = await cdpManager.executeAction(context.profileId, healedAction);
        
        if (retryResult.success) {
          logger.info(`[Healer] ✅ Đã sửa lỗi thành công với selector mới từ Agent!`);
          
          // Cập nhật ngược lại WorkflowStep nếu có (để context được persist)
          if (context.step) {
            context.step.action.selectorChain = llmResult.selectors;
            context.step.healingMetadata = {
              healed: true,
              resolution: 'llm_healed',
              tokensUsed: llmResult.tokensUsed,
              durationMs: Date.now() - startTime
            };
          }
          
          // Lưu Skill mới vào thư viện (candidate)
          const skillId = `agent_${context.site.replace(/[^a-z0-9]/gi, '_')}_${currentAction.actionType}_${Date.now()}`;
          skillRepository.saveSkill({
            skillId,
            site: context.site,
            actionType: currentAction.actionType,
            status: 'candidate',
            selectorChain: llmResult.selectors,
            createdBy: 'agent',
            createdAt: new Date().toISOString(),
            successCount: 1, // Đã chạy thành công 1 lần
            failCount: 0,
            version: 1,
            notes: `Tạo tự động bởi SelfHealingOrchestrator. Lý do: ${llmResult.reasoning}`,
            previousVersions: currentAction.selectorChain ? [JSON.stringify(currentAction.selectorChain)] : []
          });

          return retryResult;
        } else {
          logger.error(`[Healer] ❌ LLM Agent selector thất bại khi chạy thử.`);
          return { ...retryResult, success: false, error: 'Healed selector also failed: ' + retryResult.error };
        }
      } else {
        logger.warn(`[Healer] ⚠️ LLM Agent không tìm ra cách giải quyết: ${llmResult.error}`);
        return { ...result, success: false, error: 'LLM Agent failed to heal: ' + llmResult.error };
      }
    }

    return result;
  }
}

export const healingOrchestrator = new SelfHealingOrchestrator();
