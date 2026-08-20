/**
 * Core Type Definitions for AdsPower Hybrid Agentic Automation
 */

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
  proxy_config?: {
    proxy_type?: string;
    proxy_host?: string;
    proxy_port?: string | number;
    proxy_user?: string;
    proxy_password?: string;
    [key: string]: any;
  };
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
  | 'test-id';

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
  | 'screenshot';

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
// 4. 3-Tier Error Handling Types
// ==========================================

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

export interface WorkflowTask {
  taskId: string;
  profileId: string;
  profileName?: string;
  identifier?: string;
  workflowName: string;
  steps: WorkflowStep[];
  currentStepIndex: number;
  status: TaskStatus;
  retryCount: number;
  maxRetries: number;
  resultData?: Record<string, any>;
  errorMessage?: string;
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

