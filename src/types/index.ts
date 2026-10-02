/**
 * Core Type Definitions for AdsPower Hybrid Agentic Automation
 */

import type { GoogleLoginState } from '../automation/google-login.types.js';

// ==========================================
// 1. AdsPower API Types
// ==========================================

export interface AdsPowerConfig {
  apiUrl: string;
  apiKey?: string;
  defaultTimeoutMs?: number;
}

export interface AdsPowerApiResponse<T = any> {
  code: number;
  msg: string;
  data: T;
}

export interface AdsPowerStatusData {
  status: string;
  version?: string;
  [key: string]: any;
}

export interface AdsPowerStartBrowserParams {
  profileId?: string;
  profileNo?: string | number;
  ipTab?: boolean;
  launchArgs?: string[];
  headless?: boolean;
  lastOpenedTabs?: boolean;
  proxyDetection?: boolean;
  passwordFilling?: boolean;
  passwordSaving?: boolean;
  cdpMask?: boolean;
  deleteCache?: boolean;
  deviceScale?: number;
  openTabs?: string[];
}

export interface AdsPowerBrowserConnectionData {
  ws: {
    puppeteer: string;
    selenium: string;
  };
  debug_port: string;
  webdriver: string;
}

/**
 * Proxy block returned by AdsPower Local API. Verified against a live
 * `/api/v1/user/list` response: `proxy_soft` is always present; a profile with
 * no proxy carries ONLY `proxy_soft: 'no_proxy'` (host/port/type absent).
 */
export interface AdsPowerProxyConfig {
  proxy_soft?: string;
  proxy_type?: string;
  proxy_host?: string;
  proxy_port?: string | number;
  proxy_user?: string;
  proxy_password?: string;
  proxy_url?: string;
  [key: string]: any;
}

export interface AdsPowerProfileInfo {
  user_id: string;
  serial_number?: string;
  name?: string;
  group_id?: string;
  group_name?: string;
  domain_name?: string;
  username?: string;
  password?: string;
  fakey?: string;
  cookie?: string;
  remark?: string;
  ip?: string;
  country?: string;
  created_time?: number | string;
  /** Legacy/aliased shape kept for callers that already read it. */
  proxy_config?: AdsPowerProxyConfig;
  /** Actual field name used by AdsPower Local API v1 `/api/v1/user/list`. */
  user_proxy_config?: AdsPowerProxyConfig;
  fingerprint_config?: Record<string, any>;
  [key: string]: any;
}

export interface AdsPowerGroupInfo {
  group_id: string;
  group_name: string;
  remark?: string;
  [key: string]: any;
}

export interface AdsPowerProfileListParams {
  groupId?: string;
  userId?: string;
  serialNumber?: string;
  page?: number;
  pageSize?: number;
  fetchAll?: boolean;
}

export interface AdsPowerProfileListResult {
  list: AdsPowerProfileInfo[];
  page: number;
  page_size: number;
  total?: number;
}

// ==========================================
// 2. Skill Library & Self-Healing Types
// ==========================================

export type SkillStatus = 'candidate' | 'testing' | 'verified' | 'rollback';

export type SelectorType =
  | 'css'
  | 'xpath'
  | 'text'
  | 'aria-label'
  | 'placeholder'
  | 'role'
  | 'id'
  | 'test-id'
  | 'data-testid';

export interface SelectorItem {
  type: SelectorType;
  value: string;
  priority: number;
  extra?: Record<string, any>;
}

export interface Skill {
  skillId: string;
  site: string;
  actionType: string;
  status: SkillStatus;
  selectorChain: SelectorItem[];
  createdBy: 'agent' | 'human' | 'seed';
  createdAt: string;
  lastVerifiedAt?: string;
  successCount: number;
  failCount: number;
  version: number;
  previousVersions?: string[]; // JSON string array of past selector chains
  notes?: string;
}

// ==========================================
// 3. DOM & Action Types
// ==========================================

export type DOMActionType =
  | 'click'
  | 'fill'
  | 'type'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'hover'
  | 'wait_for_selector'
  | 'wait_for_navigation'
  | 'extract_text'
  | 'extract_attribute'
  | 'navigate'
  | 'scroll'
  | 'screenshot'
  | 'google_login'
  | 'facebook_login'
  // Đọc Channel ID của kênh đang đăng nhập trong profile (không đăng nhập, không click).
  | 'youtube_channel_collect'
  // Gọi YouTube Data API v3 để lấy toàn bộ video + lượt xem của Channel ID vừa đọc.
  | 'youtube_videos_fetch';

export interface DOMAction {
  actionType: DOMActionType;
  targetDescription: string;
  selectorChain?: SelectorItem[];
  value?: string; // For fill, type, select, navigate
  attributeName?: string; // For extract_attribute
  timeoutMs?: number;
  optional?: boolean;
  skillId?: string; // Liên kết với skill đã học
}

export interface DOMActionResult {
  success: boolean;
  action: DOMAction;
  usedSelector?: SelectorItem;
  extractedValue?: string;
  durationMs: number;
  error?: string;
}

// ==========================================
// 4. 3-Tier Error Handling Types & Account Status
// ==========================================

export type AccountStatus = 
  | 'LIVE' 
  | 'DEAD_DISABLED' 
  | 'CHECKPOINT_956' 
  | 'CHECKPOINT_282' 
  | 'WRONG_PASS' 
  | 'RECAPTCHA_OBSTACLE' 
  | 'PROXY_ERROR'
  | 'NEEDS_HUMAN_REVIEW'
  | 'UNKNOWN';

export type ErrorTier =
  | 'transient'   // Network timeout, page loading slow -> Auto Retry
  | 'structural'  // Selector not found, DOM change -> Skill Library / Agent
  | 'blocked'     // CAPTCHA, IP ban, Rate limit -> Escalate to human
  | 'data'        // Wrong password, banned account -> Escalate to human
  | 'unknown';

export interface ClassifiedError {
  tier: ErrorTier;
  originalError: Error;
  message: string;
  site?: string;
  action?: DOMAction;
  canAutoRetry: boolean;
  requiresAgent: boolean;
  requiresHumanEscalation: boolean;
  accountStatus?: AccountStatus;
}

// ==========================================
// 5. Workflow & Concurrency Types
// ==========================================

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'paused' | 'escalated';

export interface WorkflowStep {
  stepId: string;
  name: string;
  action: DOMAction;
  healingMetadata?: {
    healed: boolean;
    skillId?: string;
    resolution?: HealingResolution;
    tokensUsed?: number;
    tokensSaved?: number;
    durationMs?: number;
  };
}

/**
 * Backend cung cấp profile trình duyệt. `adspower` là mặc định lịch sử;
 * `taothao` = taothaoAIClaw (GoAnidetectAI) Local API.
 * Khai báo tại đây (không phải trong `src/providers/`) để `WorkflowTask` không
 * phải import ngược vào layer provider.
 */
export type BrowserProviderId = 'adspower' | 'taothao';

export interface WorkflowTask {
  taskId: string;
  profileId: string;
  profileName?: string;
  identifier?: string;
  /** Backend của profile này. Thiếu = 'adspower' (tương thích ngược). */
  provider?: BrowserProviderId;
  workflowName: string;
  steps: WorkflowStep[];
  currentStepIndex: number;
  status: TaskStatus;
  retryCount: number;
  maxRetries: number;
  resultData?: Record<string, any>;
  errorMessage?: string;
  /** Cleanup outcome after a task reaches a terminal state (Phase 12). */
  cleanupState?: 'CLOSED' | 'CLOSE_FAILED' | 'KEPT_OPEN';
  /** Whether the AdsPower browser window is still open after the task settled. */
  browserOpen?: boolean;
  startedAt?: string;
  finishedAt?: string;
}


export interface WorkflowCheckpoint {
  taskId: string;
  profileId: string;
  workflowName: string;
  currentStepIndex: number;
  status: TaskStatus;
  stateJson: string;
  updatedAt: string;
}

// ==========================================
// 6. Self-Healing & LLM Agent Types
// ==========================================

export type HealingResolution =
  | 'skill_library_hit'   // Tìm thấy trong Skill Library
  | 'llm_healed'          // LLM Agent tự sửa được
  | 'escalated';          // Phải báo cho người dùng

export interface HealingEvent {
  eventId: string;
  timestamp: string;
  site: string;
  actionType: string;
  errorTier: ErrorTier;
  errorMessage: string;
  oldSelectors?: SelectorItem[];
  newSelectors?: SelectorItem[];
  skillId?: string;
  resolution: HealingResolution;
  tokensUsed?: number;
  tokensSaved?: number;  // Tokens tiết kiệm được so với gọi LLM từ đầu
  durationMs: number;
  visionFallbackUsed?: boolean;
}

export interface LLMResolverRequest {
  site: string;
  actionType: string;
  targetDescription: string;
  domSnapshot?: string;     // A11y tree hoặc DOM text
  screenshotBase64?: string; // Vision fallback
  currentUrl?: string;
  failedSelectors?: SelectorItem[];
}

export interface LLMResolverResponse {
  success: boolean;
  selectors: SelectorItem[];
  reasoning?: string;
  tokensUsed?: number;
  visionUsed?: boolean;
  error?: string;
}

// ==========================================
// 7. Workflow Engine State Types
// ==========================================

export type WorkflowEngineState = 'idle' | 'running' | 'paused' | 'cancelling';

export interface WorkflowTaskProgress {
  taskId: string;
  profileId: string;
  profileName?: string;
  /** Backend của profile (UI hiển thị). Thiếu = 'adspower'. */
  provider?: BrowserProviderId;
  /** Thứ tự gốc người dùng nhập — kết quả PHẢI được hiển thị theo thứ tự này. */
  mappingIndex?: number;
  /**
   * Email của tài khoản được gán cho profile, ĐÃ CHE (`ab***@domain`).
   * An toàn để log / SSE / checkpoint. KHÔNG BAO GIỜ chứa email đầy đủ.
   */
  accountEmailMasked?: string;
  workflowName: string;
  status: TaskStatus;
  currentStepIndex: number;
  totalSteps: number;
  progressPercent: number;
  currentStepName?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  errorMessage?: string;
  loginState?: GoogleLoginState;
  cleanupState?: 'CLOSED' | 'CLOSE_FAILED' | 'KEPT_OPEN';
  browserOpen?: boolean;
}

export interface WorkflowBatchStatus {
  engineState: WorkflowEngineState;
  totalTasks: number;
  pendingCount: number;
  runningCount: number;
  completedCount: number;
  failedCount: number;
  tasks: WorkflowTaskProgress[];
}

