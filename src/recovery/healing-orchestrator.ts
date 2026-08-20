import { Page } from 'playwright-core';
import { cdpManager } from '../dom/cdp.js';
import { errorClassifier } from './classifier.js';
import { llmAgentResolver } from '../agent/resolver.js';
import { skillRepository } from '../skills/repository.js';
import { healingLog } from './healing-log.js';
import { broadcastEvent } from '../server/app.js';
import { logger } from '../utils/logger.js';
import { DOMAction, DOMActionResult, WorkflowStep, HealingEvent } from '../types/index.js';

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

    // 1. Kiểm tra Skill Library (Fast path)
    const existingSkill = skillRepository.find(context.site, currentAction.actionType);
    let usedSkillId = '';

    if (existingSkill && existingSkill.status !== 'rollback') {
      logger.info(`[Healer] ⚡ Skill Library HIT: "${existingSkill.skillId}" (status: ${existingSkill.status})`);
      currentAction.selectorChain = existingSkill.selectorChain;
      currentAction.skillId = existingSkill.skillId;
      usedSkillId = existingSkill.skillId;
    }

    // 2. Thực thi Action lần 1
    let result = await cdpManager.executeAction(context.profileId, currentAction);

    // Thành công ngay từ lần đầu
    if (result.success) {
      if (usedSkillId) {
        skillRepository.recordSuccess(usedSkillId);
        healingLog.addEvent({
          eventId: `evt_${Date.now()}`,
          timestamp: new Date().toISOString(),
          site: context.site,
          actionType: currentAction.actionType,
          errorTier: 'transient',
          errorMessage: 'Success via Skill Library',
          skillId: usedSkillId,
          resolution: 'skill_library_hit',
          tokensSaved: 1200,
          durationMs: Date.now() - startTime
        });
      }
      return result;
    }

    // Thất bại -> Báo lỗi cho Skill nếu dùng
    if (usedSkillId) {
      logger.warn(`[Healer] ⚠️ Skill "${usedSkillId}" thất bại trong thực tế -> Ghi nhận failure.`);
      skillRepository.recordFailure(usedSkillId);
    }

    // 3. Kiểm tra thông tin trực tiếp trên Trang (URL & Body Text) để phát hiện Checkpoint/Security
    let currentUrl = '';
    let bodyText = '';
    if (page && !page.isClosed()) {
      try {
        currentUrl = page.url() || '';
        bodyText = (await page.evaluate('document.body ? document.body.innerText : ""').catch(() => '')) as string;
      } catch {}
    }

    const isCheckpointScreen = currentUrl.includes('/checkpoint/') || 
      bodyText.includes("confirm that you're human") || 
      bodyText.includes("security check") || 
      bodyText.includes("confirm your identity");

    let errorMsg = result.error || 'Unknown DOM execution error';
    if (isCheckpointScreen) {
      errorMsg = `[Checkpoint Detected] Facebook Security Checkpoint: ${currentUrl}`;
    }

    // 4. Phân loại lỗi
    const classified = errorClassifier.classify(errorMsg, context.site, currentAction);
    logger.warn(`[Healer] 🚨 Lỗi phân loại: [Tier: ${classified.tier.toUpperCase()}] - ${classified.message}`);

    // Tier 1: Transient (Vấn đề mạng / Load chậm - chỉ khi không phải Checkpoint)
    if (classified.tier === 'transient' && !isCheckpointScreen) {
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

    // NẾU LÀ CHECKPOINT HOẶC STRUCTURAL -> Thử kích hoạt LLM Agent để bấm nút Continue / Xác thực
    logger.info(`[Healer] 🤖 Gọi LLM Agent để phân tích trang & sửa lỗi cho "${currentAction.targetDescription}"...`);
    const domSnapshot = await cdpManager.getDOMSnapshot(page);
    
    const llmResult = await llmAgentResolver.resolve({
      site: context.site,
      actionType: isCheckpointScreen ? 'checkpoint_resolve' : currentAction.actionType,
      targetDescription: isCheckpointScreen ? 'Nút Continue/Xác minh con người trên Checkpoint' : currentAction.targetDescription,
      domSnapshot: domSnapshot,
      currentUrl: currentUrl || page.url(),
      failedSelectors: currentAction.selectorChain,
    });

    if (llmResult.success && llmResult.selectors.length > 0) {
      logger.info(`[Healer] 💡 LLM Agent tìm được ${llmResult.selectors.length} selectors mới. Reasoning: ${llmResult.reasoning}`);
      
      const healedAction = { ...currentAction, selectorChain: llmResult.selectors };
      const retryResult = await cdpManager.executeAction(context.profileId, healedAction);
      
      if (retryResult.success) {
        logger.info(`[Healer] ✅ Đã xử lý thành công với selector mới từ LLM Agent!`);
        
        if (context.step) {
          context.step.action.selectorChain = llmResult.selectors;
          context.step.healingMetadata = {
            healed: true,
            resolution: 'llm_healed',
            tokensUsed: llmResult.tokensUsed,
            durationMs: Date.now() - startTime
          };
        }
        
        const skillId = `agent_${context.site.replace(/[^a-z0-9]/gi, '_')}_${currentAction.actionType}_${Date.now()}`;
        skillRepository.saveSkill({
          skillId,
          site: context.site,
          actionType: currentAction.actionType,
          status: 'candidate',
          selectorChain: llmResult.selectors,
          createdBy: 'agent',
          createdAt: new Date().toISOString(),
          successCount: 1,
          failCount: 0,
          version: 1,
          notes: `Tạo tự động bởi SelfHealingOrchestrator. Lý do: ${llmResult.reasoning}`,
          previousVersions: currentAction.selectorChain ? [JSON.stringify(currentAction.selectorChain)] : []
        });

        healingLog.addEvent({
          eventId: `evt_${Date.now()}`,
          timestamp: new Date().toISOString(),
          site: context.site,
          actionType: currentAction.actionType,
          errorTier: classified.tier,
          errorMessage: errorMsg,
          newSelectors: llmResult.selectors,
          skillId,
          resolution: 'llm_healed',
          tokensUsed: llmResult.tokensUsed,
          durationMs: Date.now() - startTime
        });

        broadcastEvent('healing_event', {
          site: context.site,
          actionType: currentAction.actionType,
          resolution: 'llm_healed',
          tokensUsed: llmResult.tokensUsed
        });

        return retryResult;
      }
    }

    // Nếu Agent không giải quyết được hoặc bị Checkpoint cứng -> Escalate người dùng
    logger.error(`[Healer] 🛑 Không thể tự giải quyết: Escalate tới người dùng.`);
    
    healingLog.addEvent({
      eventId: `evt_${Date.now()}`,
      timestamp: new Date().toISOString(),
      site: context.site,
      actionType: currentAction.actionType,
      errorTier: classified.tier,
      errorMessage: errorMsg,
      resolution: 'escalated',
      tokensUsed: llmResult?.tokensUsed || 0,
      durationMs: Date.now() - startTime
    });

    broadcastEvent('healing_event', {
      site: context.site,
      actionType: currentAction.actionType,
      resolution: 'escalated',
      error: errorMsg
    });

    return { 
      ...result, 
      success: false, 
      error: errorMsg
    };
  }
}

export const healingOrchestrator = new SelfHealingOrchestrator();
