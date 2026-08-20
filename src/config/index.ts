import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Load .env file from root directory
dotenv.config();

export interface AppConfig {
  adspower: {
    apiUrl: string;
    apiKey?: string;
    defaultTimeoutMs: number;
  };
  llm: {
    provider: string;
    model: string;
    baseUrl?: string;
    apiKey?: string;
    group?: string;
    geminiApiKey?: string;
    anthropicApiKey?: string;
    openaiApiKey?: string;
  };
  telegram: {
    enabled: boolean;
    botToken: string;
    chatId: string;
  };
  automation: {
    closeSuccessBrowsers: boolean;
  };
  windowLayout: {
    enabled: boolean;
    autoScale: boolean;
    columns: number;
    maxRows: number;
    width: number;
    height: number;
    gapX: number;
    gapY: number;
  };
  concurrency: {
    maxProfiles: number;
    profileStartTimeoutMs: number;
    domActionTimeoutMs: number;
  };
  storage: {
    databasePath: string;
  };
  logging: {
    level: string;
  };
  // Account Hub subsystem — all fields optional; defaults keep legacy behaviour.
  accountHub?: {
    enabled: boolean;
    dbPath: string;
    sheetSyncEnabled: boolean;
    adspowerReconcileEnabled: boolean;
    autoImportEnabled: boolean;
    autoLoginEnabled: boolean;
    dryRun: boolean;
  };
}

const dbPath = process.env.DATABASE_PATH || './data/adspower_automation.sqlite';
const dbDir = path.dirname(path.resolve(dbPath));
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const configFile = path.resolve(dbDir, 'system_config.json');

const initialConfig: AppConfig = {
  adspower: {
    apiUrl: (process.env.ADSPOWER_API_URL || 'http://127.0.0.1:50325').replace(/\/+$/, ''),
    apiKey: process.env.ADSPOWER_API_KEY || undefined,
    defaultTimeoutMs: Number(process.env.ADSPOWER_TIMEOUT_MS) || 30000,
  },
  llm: {
    provider: process.env.LLM_PROVIDER || '9router',
    model: process.env.LLM_MODEL || 'gemini-2.5-flash',
    baseUrl: process.env.NINEROUTER_BASE_URL || 'http://localhost:2080/v1',
    apiKey: process.env.NINEROUTER_API_KEY || '',
    group: process.env.NINEROUTER_GROUP || 'default',
    geminiApiKey: process.env.GEMINI_API_KEY || undefined,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
    openaiApiKey: process.env.OPENAI_API_KEY || undefined,
  },
  telegram: {
    enabled: process.env.TELEGRAM_ENABLED === 'true',
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },
  automation: {
    closeSuccessBrowsers: process.env.CLOSE_SUCCESS_BROWSERS !== 'false',
  },
  windowLayout: {
    enabled: true,
    autoScale: true,
    columns: 4,
    maxRows: 1,
    width: 450,
    height: 700,
    gapX: 10,
    gapY: 10,
  },
  concurrency: {
    maxProfiles: Number(process.env.MAX_CONCURRENT_PROFILES) || 5,
    profileStartTimeoutMs: Number(process.env.PROFILE_START_TIMEOUT_MS) || 30000,
    domActionTimeoutMs: Number(process.env.DOM_ACTION_TIMEOUT_MS) || 15000,
  },
  storage: {
    databasePath: dbPath,
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
};

// Load saved config if exists
if (fs.existsSync(configFile)) {
  try {
    const savedData = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (savedData.adspower?.apiUrl) {
      initialConfig.adspower.apiUrl = savedData.adspower.apiUrl;
    }
    if (savedData.llm) {
      if (savedData.llm.provider) initialConfig.llm.provider = savedData.llm.provider;
      if (savedData.llm.model) initialConfig.llm.model = savedData.llm.model;
      if (savedData.llm.baseUrl !== undefined) initialConfig.llm.baseUrl = savedData.llm.baseUrl;
      if (savedData.llm.apiKey !== undefined) initialConfig.llm.apiKey = savedData.llm.apiKey;
      if (savedData.llm.group !== undefined) initialConfig.llm.group = savedData.llm.group;
    }
    if (savedData.telegram) {
      if (savedData.telegram.enabled !== undefined) initialConfig.telegram.enabled = Boolean(savedData.telegram.enabled);
      if (savedData.telegram.botToken !== undefined) initialConfig.telegram.botToken = String(savedData.telegram.botToken);
      if (savedData.telegram.chatId !== undefined) initialConfig.telegram.chatId = String(savedData.telegram.chatId);
    }
    if (savedData.automation) {
      if (savedData.automation.closeSuccessBrowsers !== undefined) {
        initialConfig.automation.closeSuccessBrowsers = Boolean(savedData.automation.closeSuccessBrowsers);
      }
    }
    if (savedData.windowLayout) {
      if (savedData.windowLayout.enabled !== undefined) initialConfig.windowLayout.enabled = Boolean(savedData.windowLayout.enabled);
      if (savedData.windowLayout.autoScale !== undefined) initialConfig.windowLayout.autoScale = Boolean(savedData.windowLayout.autoScale);
      if (savedData.windowLayout.columns) initialConfig.windowLayout.columns = Math.max(1, Number(savedData.windowLayout.columns));
      if (savedData.windowLayout.maxRows) initialConfig.windowLayout.maxRows = Math.max(1, Number(savedData.windowLayout.maxRows));
      if (savedData.windowLayout.width) initialConfig.windowLayout.width = Math.max(200, Number(savedData.windowLayout.width));
      if (savedData.windowLayout.height) initialConfig.windowLayout.height = Math.max(200, Number(savedData.windowLayout.height));
      if (savedData.windowLayout.gapX !== undefined) initialConfig.windowLayout.gapX = Number(savedData.windowLayout.gapX);
      if (savedData.windowLayout.gapY !== undefined) initialConfig.windowLayout.gapY = Number(savedData.windowLayout.gapY);
    }
    if (savedData.concurrency?.maxProfiles) {
      initialConfig.concurrency.maxProfiles = Number(savedData.concurrency.maxProfiles);
    }
    if (savedData.concurrency?.profileStartTimeoutMs) {
      initialConfig.concurrency.profileStartTimeoutMs = Number(savedData.concurrency.profileStartTimeoutMs);
    }
    if (savedData.concurrency?.domActionTimeoutMs) {
      initialConfig.concurrency.domActionTimeoutMs = Number(savedData.concurrency.domActionTimeoutMs);
    }
  } catch (err) {
    console.error('Lỗi khi đọc system_config.json:', err);
  }
}

export const config: AppConfig = initialConfig;

/**
 * Update system config at runtime and persist to file
 */
export function updateSystemConfig(partial: Partial<AppConfig>): AppConfig {
  if (partial.adspower) {
    if (partial.adspower.apiUrl) {
      config.adspower.apiUrl = partial.adspower.apiUrl.replace(/\/+$/, '');
    }
  }

  if (partial.llm) {
    if (partial.llm.provider !== undefined) config.llm.provider = partial.llm.provider;
    if (partial.llm.model !== undefined) config.llm.model = partial.llm.model;
    if (partial.llm.baseUrl !== undefined) config.llm.baseUrl = partial.llm.baseUrl;
    if (partial.llm.apiKey !== undefined) config.llm.apiKey = partial.llm.apiKey;
    if (partial.llm.group !== undefined) config.llm.group = partial.llm.group;
  }

  if (partial.telegram) {
    if (partial.telegram.enabled !== undefined) config.telegram.enabled = Boolean(partial.telegram.enabled);
    if (partial.telegram.botToken !== undefined) config.telegram.botToken = String(partial.telegram.botToken);
    if (partial.telegram.chatId !== undefined) config.telegram.chatId = String(partial.telegram.chatId);
  }

  if (partial.automation) {
    if (partial.automation.closeSuccessBrowsers !== undefined) {
      config.automation.closeSuccessBrowsers = Boolean(partial.automation.closeSuccessBrowsers);
    }
  }

  if (partial.windowLayout) {
    if (partial.windowLayout.enabled !== undefined) config.windowLayout.enabled = Boolean(partial.windowLayout.enabled);
    if (partial.windowLayout.autoScale !== undefined) config.windowLayout.autoScale = Boolean(partial.windowLayout.autoScale);
    if (partial.windowLayout.columns) config.windowLayout.columns = Math.max(1, Number(partial.windowLayout.columns));
    if (partial.windowLayout.maxRows) config.windowLayout.maxRows = Math.max(1, Number(partial.windowLayout.maxRows));
    if (partial.windowLayout.width) config.windowLayout.width = Math.max(200, Number(partial.windowLayout.width));
    if (partial.windowLayout.height) config.windowLayout.height = Math.max(200, Number(partial.windowLayout.height));
    if (partial.windowLayout.gapX !== undefined) config.windowLayout.gapX = Number(partial.windowLayout.gapX);
    if (partial.windowLayout.gapY !== undefined) config.windowLayout.gapY = Number(partial.windowLayout.gapY);
  }

  if (partial.concurrency) {
    if (partial.concurrency.maxProfiles !== undefined) {
      config.concurrency.maxProfiles = Math.max(1, Number(partial.concurrency.maxProfiles));
    }
    if (partial.concurrency.profileStartTimeoutMs !== undefined) {
      config.concurrency.profileStartTimeoutMs = Number(partial.concurrency.profileStartTimeoutMs);
    }
    if (partial.concurrency.domActionTimeoutMs !== undefined) {
      config.concurrency.domActionTimeoutMs = Number(partial.concurrency.domActionTimeoutMs);
    }
  }

  if (partial.logging?.level) {
    config.logging.level = partial.logging.level;
  }

  try {
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('Lỗi khi ghi system_config.json:', err);
  }

  return config;
}

export interface EffectiveLLMConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  group: string;
}

export function getEffectiveLLMConfig(): EffectiveLLMConfig {
  const llm = config.llm;
  const provider = (llm.provider || '9router').toLowerCase().trim();

  let baseUrl = (llm.baseUrl || '').replace(/\/+$/, '');
  let apiKey = llm.apiKey || llm.geminiApiKey || process.env.GEMINI_API_KEY || process.env.NINEROUTER_API_KEY || '';
  let model = llm.model || 'gemini-2.5-flash';

  if (provider === 'gemini' || provider === 'gemini direct' || provider === 'gemini-direct') {
    // Nếu chuyển sang Gemini Direct mà Base URL vẫn là localhost/2080 của 9router thì tự động dùng Gemini OpenAI-compatible API endpoint
    if (!baseUrl || baseUrl.includes(':2080') || baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1')) {
      baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai';
    }
  } else if (provider === '9router') {
    if (!baseUrl) {
      baseUrl = 'http://localhost:2080/v1';
    }
  }

  return {
    provider,
    model,
    baseUrl,
    apiKey,
    group: llm.group || 'default',
  };
}

