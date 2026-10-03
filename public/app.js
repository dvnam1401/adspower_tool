/**
 * AdsPower Hybrid Automation Studio - Frontend Engine
 */

let allProfiles = [];
let allGroups = [];
let activeProfileIds = new Set();
let selectedProfileIds = new Set();
let allSkills = [];
let logEntries = [];
let currentPage = 1;
let currentPageSize = 50;
let profileSourceStatus = { adspower: true, taothao: true };

let authToken = localStorage.getItem('adspower_auth_token') || '';

// Global fetch wrapper to attach Auth Bearer Token
const originalFetch = window.fetch;
window.fetch = async function (url, options = {}) {
  options.headers = options.headers || {};
  if (authToken) {
    if (options.headers instanceof Headers) {
      options.headers.set('Authorization', `Bearer ${authToken}`);
    } else if (Array.isArray(options.headers)) {
      options.headers.push(['Authorization', `Bearer ${authToken}`]);
    } else {
      options.headers['Authorization'] = `Bearer ${authToken}`;
    }
  }

  const res = await originalFetch(url, options);

  // If 401 Unauthorized, prompt login screen
  if (res.status === 401 && typeof url === 'string' && !url.includes('/api/auth/login')) {
    showLoginScreen();
  }

  return res;
};

function showLoginScreen() {
  const loginScreen = document.getElementById('screen-login');
  if (loginScreen) loginScreen.classList.remove('hidden');
}

function hideLoginScreen() {
  const loginScreen = document.getElementById('screen-login');
  if (loginScreen) loginScreen.classList.add('hidden');
}

async function checkAuthStatus() {
  if (!authToken) {
    showLoginScreen();
    return false;
  }

  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();

    if (data.authenticated && data.user) {
      hideLoginScreen();
      const userEl = document.getElementById('sidebar-username');
      const avatarEl = document.getElementById('sidebar-user-avatar');
      if (userEl) userEl.textContent = data.user.username;
      if (avatarEl) avatarEl.textContent = data.user.username.charAt(0).toUpperCase();
      return true;
    } else {
      showLoginScreen();
      return false;
    }
  } catch {
    showLoginScreen();
    return false;
  }
}

function initAuth() {
  const formLogin = document.getElementById('form-login');
  const btnLogout = document.getElementById('btn-logout');
  const loginError = document.getElementById('login-error');

  if (formLogin) {
    formLogin.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('login-username')?.value?.trim();
      const password = document.getElementById('login-password')?.value;

      if (loginError) loginError.classList.add('hidden');

      try {
        const res = await originalFetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });

        const data = await res.json();
        if (data.success && data.token) {
          authToken = data.token;
          localStorage.setItem('adspower_auth_token', authToken);
          hideLoginScreen();
          showToast(`🎉 Xin chào, ${data.user.username}! Đăng nhập thành công.`, 'success');

          const userEl = document.getElementById('sidebar-username');
          const avatarEl = document.getElementById('sidebar-user-avatar');
          if (userEl) userEl.textContent = data.user.username;
          if (avatarEl) avatarEl.textContent = data.user.username.charAt(0).toUpperCase();

          fetchStatus();
          fetchGroups().then(() => fetchProfiles(1));
          fetchSkills();
        } else {
          if (loginError) {
            loginError.textContent = data.error || 'Đăng nhập thất bại!';
            loginError.classList.remove('hidden');
          }
        }
      } catch (err) {
        if (loginError) {
          loginError.textContent = `Lỗi kết nối server: ${err.message}`;
          loginError.classList.remove('hidden');
        }
      }
    });
  }

  if (btnLogout) {
    btnLogout.addEventListener('click', async () => {
      try {
        await fetch('/api/auth/logout', { method: 'POST' });
      } catch {}
      authToken = '';
      localStorage.removeItem('adspower_auth_token');
      showLoginScreen();
      showToast('Đã đăng xuất khỏi hệ thống thành công.', 'info');
    });
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  initAuth();
  initNavigation();
  initMobileSidebar();
  initSSE();
  initFiltersAndActions();
  initSettingsTab();
  initSkillModal();
  initHealingMonitor();
  initWorkflowRunner();
  initYoutubeChecker();
  initPageInventory();
  initYoutubeChannels();

  const isAuthenticated = await checkAuthStatus();
  if (isAuthenticated) {
    fetchStatus();
    fetchGroups().then(() => fetchProfiles(1));
    fetchSkills();
    fetchHealingEvents();
    fetchWorkflowStatus();
    loadYoutubeChannels();

    // Auto sync active browser profile status every 10s
    setInterval(() => {
      checkActiveProfiles();
    }, 10000);
  }
});


// =========================================================================
// 1. Navigation & Mobile Sidebar
// =========================================================================
function initNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  const tabPanes = document.querySelectorAll('.tab-pane');
  const headerTitle = document.getElementById('header-page-title');
  const headerDesc = document.getElementById('header-page-desc');

  const pageMeta = {
    'tab-profiles': {
      title: 'Quản Lý AdsPower Profiles',
      desc: 'Điều khiển và tự động hóa đa profile qua Playwright CDP & Self-Healing Agent'
    },
    'tab-skills': {
      title: 'Self-Healing Skill Library',
      desc: 'Quản lý kho kỹ năng, chuỗi selector thích ứng và vòng đời tự phục hồi (candidate ➔ verified)'
    },
    'tab-healing': {
      title: 'Self-Healing Monitor',
      desc: 'Theo dõi bộ phân loại lỗi 3 tầng và LLM Agent Brain — so sánh selector cũ/mới, token tiết kiệm'
    },
    'tab-workflow': {
      title: 'Workflow Runner',
      desc: 'Điều phối batch workflow đa profile với concurrency limiter, checkpoint và điều khiển real-time'
    },
    'tab-youtube': {
      title: 'Kho Channel ID YouTube',
      desc: 'Ánh xạ profile → Channel ID đã đọc được; còn bản ghi thì lượt chạy sau không phải mở trình duyệt'
    },
    'tab-logs': {
      title: 'Live Logs & Telemetry Console',
      desc: 'Theo dõi luồng log, sự kiện mạng và quyết định của Agent theo thời gian thực'
    },
    'tab-settings': {
      title: 'Cấu Hình Hệ Thống & AI (Settings)',
      desc: 'Tùy chỉnh AdsPower API, giới hạn luồng tự động hóa và kết nối 9router / Gemini AI'
    },
    'tab-youtube-checker': {
      title: 'YouTube Channel Checker',
      desc: 'Kiểm tra thống kê kênh YouTube hàng loạt — subscribers, views, video count và export Excel'
    },
    'tab-account-hub': {
      title: 'Account Data Hub',
      desc: 'Quản lý tài khoản tập trung — đồng bộ Google Sheets, trạng thái AdsPower và đối soát tự động'
    },
    'tab-page-inventory': {
      title: 'Quản Lý Quyền Page (Step 1 Inventory)',
      desc: 'Tự động quét và lập danh sách Facebook Pages do AdsPower profile quản lý với minh chứng URL & GraphQL'
    }
  };


  navItems.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');

      navItems.forEach(b => b.classList.remove('active'));
      tabPanes.forEach(p => {
        p.classList.add('hidden');
        p.classList.remove('block');
      });

      btn.classList.add('active');
      const activePane = document.getElementById(targetTab);
      if (activePane) {
        activePane.classList.remove('hidden');
        activePane.classList.add('block');
      }

      if (pageMeta[targetTab]) {
        headerTitle.textContent = pageMeta[targetTab].title;
        headerDesc.textContent  = pageMeta[targetTab].desc;
      }

      // Lazy-init Account Hub on first visit
      if (targetTab === 'tab-account-hub') {
        AccountHub.lazyInit();
      }

      // Close mobile sidebar if open
      closeMobileSidebar();
    });
  });
}

function initMobileSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('mobile-overlay');
  const toggleBtn = document.getElementById('btn-toggle-sidebar');
  const closeBtn = document.getElementById('btn-close-sidebar');

  toggleBtn.addEventListener('click', () => {
    sidebar.classList.remove('-translate-x-full');
    overlay.classList.remove('hidden');
  });

  const close = () => {
    sidebar.classList.add('-translate-x-full');
    overlay.classList.add('hidden');
  };

  if (closeBtn) closeBtn.addEventListener('click', close);
  if (overlay) overlay.addEventListener('click', close);
}

function closeMobileSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('mobile-overlay');
  if (sidebar && window.innerWidth < 768) {
    sidebar.classList.add('-translate-x-full');
    overlay?.classList.add('hidden');
  }
}

// Switch to tab programmatically
function switchTab(tabId) {
  const targetNav = document.querySelector(`.nav-item[data-tab="${tabId}"]`);
  if (targetNav) targetNav.click();
}

// =========================================================================
// 2. System & AdsPower Status & Settings Modal
// =========================================================================
async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    const dot = document.getElementById('sidebar-api-dot');
    const text = document.getElementById('sidebar-api-status');
    const settingsDot = document.getElementById('settings-api-dot');
    const settingsStatus = document.getElementById('settings-api-status');
    const llmModel = document.getElementById('header-llm-model');

    if (data.adspower?.online) {
      if (dot) dot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 pulse-emerald';
      if (text) {
        text.textContent = 'API Online (Port 50325)';
        text.className = 'font-semibold text-emerald-400 text-xs';
      }
      if (settingsDot) settingsDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 pulse-emerald';
      if (settingsStatus) {
        settingsStatus.textContent = 'Online';
        settingsStatus.className = 'font-semibold text-emerald-400 text-xs';
      }
    } else {
      if (dot) dot.className = 'w-2.5 h-2.5 rounded-full bg-rose-400';
      if (text) {
        text.textContent = 'API Offline';
        text.className = 'font-semibold text-rose-400 text-xs';
      }
      if (settingsDot) settingsDot.className = 'w-2.5 h-2.5 rounded-full bg-rose-400';
      if (settingsStatus) {
        settingsStatus.textContent = 'Offline';
        settingsStatus.className = 'font-semibold text-rose-400 text-xs';
      }
    }

    if (data.system?.llmModel && llmModel) {
      llmModel.textContent = data.system.llmModel;
    }
  } catch (err) {
    console.error('Fetch status error:', err);
  }
}

function initSettingsTab() {
  const btnOpenHeader = document.getElementById('btn-header-settings');
  const btnSave = document.getElementById('btn-save-settings');
  const btnTestTelegram = document.getElementById('btn-test-telegram');

  if (btnOpenHeader) {
    btnOpenHeader.addEventListener('click', () => {
      switchTab('tab-settings');
    });
  }

  // Auto load when navigating to settings tab
  const settingsNavBtn = document.querySelector('.nav-item[data-tab="tab-settings"]');
  if (settingsNavBtn) {
    settingsNavBtn.addEventListener('click', () => {
      loadSettingsToModal();
    });
  }

  if (btnSave) {
    btnSave.addEventListener('click', async () => {
      await saveSettingsFromModal();
    });
  }

  if (btnTestTelegram) {
    btnTestTelegram.addEventListener('click', async () => {
      const token = document.getElementById('setting-telegram-token')?.value?.trim();
      const chatId = document.getElementById('setting-telegram-chatid')?.value?.trim();

      if (!token || !chatId) {
        showToast('Vui lòng nhập Telegram Bot Token và Chat ID trước khi test!', 'warn');
        return;
      }

      showToast('🚀 Đang gửi tin nhắn thử nghiệm tới Telegram...', 'info');
      try {
        const res = await fetch('/api/telegram/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ botToken: token, chatId }),
        });
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          showToast('Vui lòng khởi động lại server (`npm start`) để nhận diện API Telegram mới vừa cập nhật!', 'warn');
          return;
        }
        const data = await res.json();
        if (data.success) {
          showToast(`🎉 ${data.message}`, 'success');
        } else {
          showToast(`❌ ${data.error}`, 'error');
        }
      } catch (err) {
        showToast(`Lỗi gửi Telegram: ${err.message}`, 'error');
      }
    });
  }

  const elAiProvider = document.getElementById('setting-ai-provider');
  const elAiBaseUrl = document.getElementById('setting-ai-baseurl');
  if (elAiProvider && elAiBaseUrl) {
    elAiProvider.addEventListener('change', () => {
      const val = elAiProvider.value;
      if (val === 'gemini') {
        if (!elAiBaseUrl.value || elAiBaseUrl.value.includes('localhost') || elAiBaseUrl.value.includes('2080')) {
          elAiBaseUrl.value = 'https://generativelanguage.googleapis.com/v1beta/openai';
        }
      } else if (val === '9router') {
        if (!elAiBaseUrl.value || elAiBaseUrl.value.includes('generativelanguage')) {
          elAiBaseUrl.value = 'http://localhost:2080/v1';
        }
      }
    });
  }

  // Pre-load settings
  loadSettingsToModal();
}

async function loadSettingsToModal() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return;
    const data = await res.json();

    const elAdsUrl = document.getElementById('setting-adspower-url');
    const elConcurrency = document.getElementById('setting-concurrency');
    const elAiProvider = document.getElementById('setting-ai-provider');
    const elAiModel = document.getElementById('setting-ai-model');
    const elAiBaseUrl = document.getElementById('setting-ai-baseurl');
    const elAiKey = document.getElementById('setting-ai-key');
    const elAiGroup = document.getElementById('setting-ai-group');
    const elTgEnabled = document.getElementById('setting-telegram-enabled');
    const elTgToken = document.getElementById('setting-telegram-token');
    const elTgChatId = document.getElementById('setting-telegram-chatid');

    if (elAdsUrl && data.adspower?.apiUrl) elAdsUrl.value = data.adspower.apiUrl;
    if (elConcurrency && data.concurrency?.maxProfiles) elConcurrency.value = data.concurrency.maxProfiles;

    if (data.llm) {
      if (elAiProvider && data.llm.provider) elAiProvider.value = data.llm.provider;
      if (elAiModel && data.llm.model) elAiModel.value = data.llm.model;
      if (elAiBaseUrl && data.llm.baseUrl) elAiBaseUrl.value = data.llm.baseUrl;
      if (elAiKey && data.llm.apiKey !== undefined) elAiKey.value = data.llm.apiKey;
      if (elAiGroup && data.llm.group !== undefined) elAiGroup.value = data.llm.group;
    }

    if (data.telegram) {
      if (elTgEnabled) elTgEnabled.checked = Boolean(data.telegram.enabled);
      if (elTgToken && data.telegram.botToken !== undefined) elTgToken.value = data.telegram.botToken;
      if (elTgChatId && data.telegram.chatId !== undefined) elTgChatId.value = data.telegram.chatId;
    }

    const elAutoClose = document.getElementById('setting-autoclose-success');
    if (elAutoClose && data.automation?.closeSuccessBrowsers !== undefined) {
      elAutoClose.checked = Boolean(data.automation.closeSuccessBrowsers);
    }

    // API Key YouTube KHÔNG được server trả về -> chỉ hiện trạng thái, ô nhập luôn để trống.
    const elYtKey = document.getElementById('setting-youtube-key');
    const elYtState = document.getElementById('setting-youtube-key-state');
    if (elYtKey) elYtKey.value = '';
    if (elYtState) {
      const ytConfigured = Boolean(data.youtube?.apiKeyConfigured);
      elYtState.textContent = ytConfigured ? 'Đã cấu hình' : 'Chưa cấu hình';
      elYtState.className = ytConfigured
        ? 'text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-semibold'
        : 'text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700 font-semibold';
    }

    const elWinTiling = document.getElementById('setting-window-tiling');
    const elWinAutoScale = document.getElementById('setting-window-autoscale');
    const elWinCols = document.getElementById('setting-window-cols');
    const elWinRows = document.getElementById('setting-window-rows');
    const elWinWidth = document.getElementById('setting-window-width');
    const elWinHeight = document.getElementById('setting-window-height');

    if (data.windowLayout) {
      if (elWinTiling && data.windowLayout.enabled !== undefined) elWinTiling.checked = Boolean(data.windowLayout.enabled);
      if (elWinAutoScale && data.windowLayout.autoScale !== undefined) elWinAutoScale.checked = Boolean(data.windowLayout.autoScale);
      if (elWinCols && data.windowLayout.columns) elWinCols.value = data.windowLayout.columns;
      if (elWinRows && data.windowLayout.maxRows) elWinRows.value = data.windowLayout.maxRows;
      if (elWinWidth && data.windowLayout.width) elWinWidth.value = data.windowLayout.width;
      if (elWinHeight && data.windowLayout.height) elWinHeight.value = data.windowLayout.height;
    }
  } catch (err) {
    console.error('Không thể đọc cấu hình:', err);
  }
}

async function saveSettingsFromModal() {
  const elAdsUrl = document.getElementById('setting-adspower-url');
  const elConcurrency = document.getElementById('setting-concurrency');
  const elAiProvider = document.getElementById('setting-ai-provider');
  const elAiModel = document.getElementById('setting-ai-model');
  const elAiBaseUrl = document.getElementById('setting-ai-baseurl');
  const elAiKey = document.getElementById('setting-ai-key');
  const elAiGroup = document.getElementById('setting-ai-group');
  const elTgEnabled = document.getElementById('setting-telegram-enabled');
  const elTgToken = document.getElementById('setting-telegram-token');
  const elTgChatId = document.getElementById('setting-telegram-chatid');
  const elAutoClose = document.getElementById('setting-autoclose-success');

  const elWinTiling = document.getElementById('setting-window-tiling');
  const elWinAutoScale = document.getElementById('setting-window-autoscale');
  const elWinCols = document.getElementById('setting-window-cols');
  const elWinRows = document.getElementById('setting-window-rows');
  const elWinWidth = document.getElementById('setting-window-width');
  const elWinHeight = document.getElementById('setting-window-height');

  const concurrencyVal = Number(elConcurrency?.value || 5);
  if (isNaN(concurrencyVal) || concurrencyVal < 1) {
    showToast('Số luồng song song phải >= 1', 'error');
    return;
  }

  const payload = {
    maxProfiles: concurrencyVal,
    adspowerUrl: elAdsUrl?.value?.trim() || 'http://127.0.0.1:50325',
    llm: {
      provider: elAiProvider?.value || '9router',
      model: elAiModel?.value?.trim() || 'gemini-2.5-flash',
      baseUrl: elAiBaseUrl?.value?.trim() || 'http://localhost:2080/v1',
      apiKey: elAiKey?.value || '',
      group: elAiGroup?.value?.trim() || 'default',
    },
    telegram: {
      enabled: Boolean(elTgEnabled?.checked),
      botToken: elTgToken?.value?.trim() || '',
      chatId: elTgChatId?.value?.trim() || '',
    },
    automation: {
      closeSuccessBrowsers: Boolean(elAutoClose?.checked),
    },
    windowLayout: {
      enabled: Boolean(elWinTiling?.checked),
      autoScale: Boolean(elWinAutoScale?.checked),
      columns: Number(elWinCols?.value || 4),
      maxRows: Number(elWinRows?.value || 1),
      width: Number(elWinWidth?.value || 450),
      height: Number(elWinHeight?.value || 700),
    },
  };

  // Chỉ gửi khi người dùng thực sự nhập key mới — để trống = giữ nguyên key đã lưu.
  const ytKeyVal = document.getElementById('setting-youtube-key')?.value?.trim();
  if (ytKeyVal) payload.youtube = { apiKey: ytKeyVal };

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (data.success) {
      showToast('🎉 Đã lưu cấu hình hệ thống, AI & Telegram thành công!', 'success');
      const headerModel = document.getElementById('header-llm-model');
      if (headerModel) {
        headerModel.textContent = `${payload.llm.provider === '9router' ? '9router' : 'AI'}: ${payload.llm.model}`;
      }
      fetchStatus();
      // Đọc lại cấu hình: xoá ô key vừa nhập và cập nhật badge trạng thái.
      loadSettingsToModal();
    } else {
      showToast(`Lỗi khi lưu cấu hình: ${data.error}`, 'error');
    }
  } catch (err) {
    showToast(`Không thể kết nối server: ${err.message}`, 'error');
  }
}

// =========================================================================
// 3. Profiles & Groups Management & Batch Actions
// =========================================================================
async function fetchGroups() {
  try {
    const res = await fetch('/api/groups?pageSize=100');
    const data = await res.json();
    allGroups = data.list || [];

    document.getElementById('stat-total-groups').textContent = allGroups.length;
    populateGroupFilter(allGroups);
  } catch (err) {
    console.error('Fetch groups error:', err);
  }
}

function populateGroupFilter(groups) {
  const select = document.getElementById('select-group');
  const currentValue = select.value;

  select.innerHTML = '<option value="">Tất cả nhóm</option>';
  groups.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g.group_id;
    opt.textContent = `Nhóm: ${g.group_name}`;
    if (g.group_id === currentValue) opt.selected = true;
    select.appendChild(opt);
  });
}

async function fetchProfiles(page = 1) {
  const tbody = document.getElementById('profiles-tbody');
  const loadingIndicator = document.getElementById('pagination-loading');

  currentPage = page;
  if (loadingIndicator) loadingIndicator.classList.remove('hidden');

  if (allProfiles.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="px-5 py-12 text-center text-slate-500">
          <div class="flex flex-col items-center justify-center space-y-2">
            <i class="ph-bold ph-spinner animate-spin text-2xl text-brand-400"></i>
            <p class="text-sm font-sans">Đang đồng bộ profiles từ AdsPower và taothaoAIClaw...</p>
          </div>
        </td>
      </tr>
    `;
  }

  try {
    // Hai nguồn độc lập: một nguồn lỗi không được làm mất danh sách của nguồn còn lại.
    const [adsResult, taothaoResult] = await Promise.allSettled([
      fetch('/api/profiles?fetchAll=true'),
      fetch('/api/taothao/profiles?fetchAll=true'),
    ]);

    const readJsonResponse = async (result, providerLabel) => {
      if (result.status === 'rejected') throw result.reason;
      const data = await result.value.json();
      if (!result.value.ok || data.success === false) {
        throw new Error(data.error || `Không thể tải profile ${providerLabel}`);
      }
      return data;
    };

    let adsProfiles = [];
    let taothaoProfiles = [];
    const sourceErrors = [];

    try {
      const data = await readJsonResponse(adsResult, 'AdsPower');
      adsProfiles = (data.list || []).map(p => ({
        ...p,
        provider: 'adspower',
        provider_label: 'AdsPower',
      }));
      profileSourceStatus.adspower = true;
    } catch (err) {
      profileSourceStatus.adspower = false;
      sourceErrors.push(`AdsPower: ${err.message}`);
    }

    try {
      const data = await readJsonResponse(taothaoResult, 'taothaoAIClaw');
      taothaoProfiles = (data.list || []).map((p, index) => ({
        user_id: p.profileId,
        name: p.name || p.profileId,
        serial_number: p.stt ?? index + 1,
        group_id: `taothao:${p.groupId || 'ungrouped'}`,
        group_name: p.groupId ? `Nhóm ${p.groupId.slice(0, 8)}…` : 'Chưa phân nhóm',
        ip: '',
        ip_country: '',
        provider: 'taothao',
        provider_label: 'taothaoAIClaw',
        isRunning: Boolean(p.isRunning),
        hasProxy: Boolean(p.hasProxy),
        folder: p.folder || null,
      }));
      profileSourceStatus.taothao = true;
    } catch (err) {
      profileSourceStatus.taothao = false;
      sourceErrors.push(`taothaoAIClaw: ${err.message}`);
    }

    if (adsProfiles.length === 0 && taothaoProfiles.length === 0 && sourceErrors.length === 2) {
      throw new Error(sourceErrors.join(' | '));
    }

    allProfiles = [...adsProfiles, ...taothaoProfiles];
    selectedProfileIds = new Set(
      [...selectedProfileIds].filter(id => adsProfiles.some(p => p.user_id === id))
    );

    if (sourceErrors.length > 0) {
      showToast(`Một nguồn profile chưa kết nối: ${sourceErrors.join(' | ')}`, 'warn');
    }

    // Update stats
    const totalCount = allProfiles.length;
    document.getElementById('stat-total-profiles').textContent = totalCount;
    document.getElementById('badge-nav-profiles').textContent = totalCount;

    const adsPowerProfiles = allProfiles.filter(p => p.provider === 'adspower');
    populateCDPProfileSelector(adsPowerProfiles);
    populatePageInventoryProfileSelector(adsPowerProfiles);

    // ⚡ Render table IMMEDIATELY (under 100ms) with client-side pagination
    renderProfiles();

    // Check active status in background without blocking UI
    checkActiveProfiles();
  } catch (err) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="px-5 py-8 text-center text-rose-400">
          ❌ Không thể tải danh sách profiles: ${err.message}
        </td>
      </tr>
    `;
  } finally {
    if (loadingIndicator) loadingIndicator.classList.add('hidden');
  }
}

function populateCDPProfileSelector(profiles) {
  const select = document.getElementById('cdp-select-profile');
  if (!select) return;
  const currentValue = select.value;

  select.innerHTML = '<option value="">-- Chọn profile để điều khiển --</option>';
  profiles.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.user_id;
    opt.textContent = `#${p.serial_number || 'N/A'} - ${p.name || 'Unnamed'} (${p.user_id})`;
    if (p.user_id === currentValue) opt.selected = true;
    select.appendChild(opt);
  });
}

async function checkActiveProfiles() {
  try {
    const res = await fetch('/api/browser/active-list');
    if (!res.ok) return;
    const data = await res.json();
    if (data.activeIds && Array.isArray(data.activeIds)) {
      activeProfileIds = new Set(data.activeIds);
      document.getElementById('stat-active-profiles').textContent = activeProfileIds.size;
      renderProfiles();
    }
  } catch (err) {
    console.debug('Check active list error:', err);
  }
}

function getFilteredProfiles() {
  const search = (document.getElementById('input-search')?.value || '').toLowerCase().trim();
  const selectedGroupId = document.getElementById('select-group')?.value;
  const selectedStatus = document.getElementById('select-status')?.value || 'all';
  const selectedSource = document.getElementById('select-profile-source')?.value || 'all';

  return allProfiles.filter(p => {
    const matchSearch =
      !search ||
      p.user_id?.toLowerCase().includes(search) ||
      p.serial_number?.toLowerCase().includes(search) ||
      p.name?.toLowerCase().includes(search) ||
      p.ip?.toLowerCase().includes(search) ||
      p.group_name?.toLowerCase().includes(search) ||
      p.provider_label?.toLowerCase().includes(search) ||
      (p.username && p.username.toLowerCase().includes(search));

    const matchGroup = !selectedGroupId || (p.provider === 'adspower' && p.group_id === selectedGroupId);
    const matchSource = selectedSource === 'all' || p.provider === selectedSource;

    const isActive = p.provider === 'taothao' ? Boolean(p.isRunning) : activeProfileIds.has(p.user_id);
    const matchStatus =
      selectedStatus === 'all' ||
      (selectedStatus === 'active' && isActive) ||
      (selectedStatus === 'inactive' && !isActive);

    return matchSearch && matchGroup && matchSource && matchStatus;
  });
}

function getCurrentPageProfiles() {
  const filtered = getFilteredProfiles();
  const totalFiltered = filtered.length;
  const pageSizeVal = document.getElementById('select-page-size')?.value || '50';
  const effectivePageSize = pageSizeVal === 'all' ? (totalFiltered || 50) : Number(pageSizeVal);

  const totalPages = effectivePageSize > 0 ? Math.max(1, Math.ceil(totalFiltered / effectivePageSize)) : 1;
  let page = currentPage;
  if (page > totalPages) page = totalPages;
  if (page < 1) page = 1;

  const startIndex = (page - 1) * effectivePageSize;
  const endIndex = pageSizeVal === 'all' ? totalFiltered : Math.min(startIndex + effectivePageSize, totalFiltered);
  return pageSizeVal === 'all' ? filtered : filtered.slice(startIndex, endIndex);
}

function renderProfiles() {
  const tbody = document.getElementById('profiles-tbody');
  const filtered = getFilteredProfiles();

  const totalFiltered = filtered.length;
  const pageSizeVal = document.getElementById('select-page-size')?.value || '50';
  const effectivePageSize = pageSizeVal === 'all' ? (totalFiltered || 50) : Number(pageSizeVal);

  const totalPages = effectivePageSize > 0 ? Math.max(1, Math.ceil(totalFiltered / effectivePageSize)) : 1;
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;

  const startIndex = (currentPage - 1) * effectivePageSize;
  const endIndex = pageSizeVal === 'all' ? totalFiltered : Math.min(startIndex + effectivePageSize, totalFiltered);
  const pageItems = pageSizeVal === 'all' ? filtered : filtered.slice(startIndex, endIndex);

  // Sync header 'Select All' checkbox (#chk-select-all) to ONLY current page items
  const selectAll = document.getElementById('chk-select-all');
  if (selectAll) {
    const selectableItems = pageItems.filter(p => p.provider === 'adspower');
    if (selectableItems.length > 0) {
      selectAll.checked = selectableItems.every(p => selectedProfileIds.has(p.user_id));
      selectAll.disabled = false;
    } else {
      selectAll.checked = false;
      selectAll.disabled = true;
    }
  }

  // Update pagination UI controls
  const pageLabel = document.getElementById('pagination-page-label');
  const infoLabel = document.getElementById('pagination-info');
  const btnPrev = document.getElementById('btn-page-prev');
  const btnNext = document.getElementById('btn-page-next');

  if (pageLabel) pageLabel.textContent = `${currentPage} / ${totalPages}`;
  if (infoLabel) {
    if (totalFiltered === 0) {
      infoLabel.textContent = '0 profiles';
    } else {
      infoLabel.textContent = `Hiển thị ${startIndex + 1} - ${endIndex} trên ${totalFiltered} profiles (Tổng: ${allProfiles.length})`;
    }
  }
  if (btnPrev) btnPrev.disabled = currentPage <= 1;
  if (btnNext) btnNext.disabled = currentPage >= totalPages;

  if (pageItems.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="px-5 py-12 text-center text-slate-500 font-sans">
          <div class="flex flex-col items-center justify-center space-y-2">
            <i class="ph-duotone ph-magnifying-glass text-3xl text-slate-600"></i>
            <p>Không tìm thấy profile nào phù hợp với bộ lọc hiện tại.</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = pageItems.map(p => {
    const isTaothao = p.provider === 'taothao';
    const isActive = isTaothao ? Boolean(p.isRunning) : activeProfileIds.has(p.user_id);
    const isSelected = !isTaothao && selectedProfileIds.has(p.user_id);
    const proxyInfo = isTaothao
      ? (p.hasProxy ? 'Đã cấu hình proxy' : 'Không dùng proxy')
      : (p.ip ? `${p.ip} (${(p.ip_country || 'N/A').toUpperCase()})` : 'Mặc định');

    return `
      <tr class="hover:bg-surface-850/60 transition group ${isSelected ? 'bg-brand-950/30' : ''}">
        <td class="px-4 py-3.5 text-center">
          ${isTaothao
            ? '<i class="ph-bold ph-eye text-sky-400" title="Profile taothaoAIClaw đang ở chế độ hiển thị"></i>'
            : `<input type="checkbox" data-profile-id="${p.user_id}" ${isSelected ? 'checked' : ''} onchange="toggleSelectProfile('${p.user_id}', this.checked)" class="profile-chk rounded bg-slate-800 border-slate-700 text-brand-500 focus:ring-0 cursor-pointer">`
          }
        </td>
        <td class="px-4 py-3.5">
          <span class="inline-flex items-center px-2 py-0.5 rounded-lg text-xs font-mono font-bold bg-slate-800 text-brand-300 border border-slate-700">
            #${p.serial_number || 'N/A'}
          </span>
        </td>
        <td class="px-4 py-3.5">
          <div class="flex flex-col">
            <span class="font-medium text-white group-hover:text-brand-300 transition">${escapeHtml(p.name || 'Unnamed')}</span>
            <span class="inline-flex self-start mt-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide ${isTaothao ? 'bg-sky-500/10 text-sky-300 border border-sky-500/20' : 'bg-violet-500/10 text-violet-300 border border-violet-500/20'}">
              ${isTaothao ? 'taothaoAIClaw' : 'AdsPower'}
            </span>
            <div class="flex items-center space-x-1.5 mt-0.5 text-slate-500 font-mono text-[11px]">
              <span class="select-all">${p.user_id}</span>
              <button onclick="copyToClipboard('${p.user_id}', this)" class="hover:text-slate-300 p-0.5" title="Copy ID">
                <i class="ph ph-copy"></i>
              </button>
            </div>
          </div>
        </td>
        <td class="px-4 py-3.5">
          <span class="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium bg-slate-800/80 text-slate-300 border border-slate-700/80">
            ${escapeHtml(p.group_name || 'Mặc định')}
          </span>
        </td>
        <td class="px-4 py-3.5">
          <div class="flex items-center space-x-1.5 text-slate-300 text-xs font-mono">
            <i class="ph ph-globe text-slate-500"></i>
            <span>${escapeHtml(proxyInfo)}</span>
          </div>
        </td>
        <td class="px-4 py-3.5 text-center">
          ${
            isActive
              ? `<span class="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                   <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1.5 pulse-emerald"></span> Đang Mở
                 </span>`
              : `<span class="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-semibold bg-slate-800 text-slate-400 border border-slate-700">
                   Đã Đóng
                 </span>`
          }
        </td>
        <td class="px-4 py-3.5 text-right font-sans">
          <div class="flex items-center justify-end space-x-1.5">
            ${
              isTaothao
                ? `${isActive
                    ? `<button id="btn-taothao-toggle-${p.user_id}" onclick="stopTaothaoBrowser('${p.user_id}')" class="px-2.5 py-1.5 rounded-lg bg-rose-600/20 hover:bg-rose-600/40 text-rose-300 border border-rose-500/30 text-xs font-semibold transition inline-flex items-center gap-1">
                         <i class="ph-bold ph-stop"></i> Đóng
                       </button>`
                    : `<button id="btn-taothao-toggle-${p.user_id}" onclick="startTaothaoBrowser('${p.user_id}')" class="px-2.5 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold shadow-md shadow-sky-500/20 transition inline-flex items-center gap-1">
                         <i class="ph-bold ph-play"></i> Mở
                       </button>`}
                  `
                : `<button onclick="triggerFBLogin('${p.user_id}', '${escapeHtml(p.name || '')}')" class="px-2.5 py-1.5 rounded-lg bg-indigo-600/30 hover:bg-indigo-600/60 text-indigo-300 border border-indigo-500/40 text-xs font-semibold transition inline-flex items-center gap-1" title="Tự động đăng nhập Facebook + 2FA">
                     <i class="ph-bold ph-lightning"></i> Auto Login
                   </button>
                   ${isActive
                     ? `<button id="btn-toggle-${p.user_id}" onclick="stopBrowser('${p.user_id}')" class="px-2.5 py-1.5 rounded-lg bg-rose-600/20 hover:bg-rose-600/40 text-rose-300 border border-rose-500/30 text-xs font-semibold transition inline-flex items-center gap-1">
                          <i class="ph-bold ph-stop"></i> Đóng
                        </button>`
                     : `<button id="btn-toggle-${p.user_id}" onclick="startBrowser('${p.user_id}')" class="px-2.5 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-xs font-semibold shadow-md shadow-brand-500/20 transition inline-flex items-center gap-1">
                          <i class="ph-bold ph-play"></i> Mở
                        </button>`}
                  `
            }
            <button onclick="openProfileDrawer('${p.user_id}')" class="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition" title="Xem chi tiết">
              <i class="ph-bold ph-dots-three-vertical text-base"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  updateBatchActionBar();
}

function initFiltersAndActions() {
  document.getElementById('input-search').addEventListener('input', () => {
    currentPage = 1;
    renderProfiles();
  });

  document.getElementById('select-group')?.addEventListener('change', () => {
    currentPage = 1;
    renderProfiles();
  });

  document.getElementById('select-profile-source')?.addEventListener('change', () => {
    currentPage = 1;
    renderProfiles();
  });

  document.getElementById('select-status')?.addEventListener('change', () => {
    currentPage = 1;
    checkActiveProfiles();
  });

  const selectPageSize = document.getElementById('select-page-size');
  if (selectPageSize) {
    const savedPageSize = localStorage.getItem('adspower_pageSize');
    if (savedPageSize) {
      selectPageSize.value = savedPageSize;
    }
    selectPageSize.addEventListener('change', (e) => {
      localStorage.setItem('adspower_pageSize', e.target.value);
      currentPage = 1;
      renderProfiles();
    });
  }

  document.getElementById('btn-page-prev')?.addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      renderProfiles();
    }
  });

  document.getElementById('btn-page-next')?.addEventListener('click', () => {
    currentPage++;
    renderProfiles();
  });

  document.getElementById('btn-fetch-all-profiles')?.addEventListener('click', () => {
    showToast('Đang làm mới dữ liệu từ AdsPower và taothaoAIClaw...', 'info');
    fetchProfiles(1);
  });

  document.getElementById('btn-refresh').addEventListener('click', () => {
    fetchStatus();
    fetchGroups();
    fetchProfiles(1);
    fetchSkills();
  });

  initTaothaoListLauncher();

  // Concurrency System Config Save Handler
  const btnSaveConcurrency = document.getElementById('btn-save-concurrency');
  const inputConcurrency = document.getElementById('input-concurrency');

  const saveConcurrencyHandler = async () => {
    const val = Number(inputConcurrency?.value || 5);
    if (isNaN(val) || val < 1) {
      showToast('Số luồng song song phải là số nguyên >= 1', 'error');
      return;
    }

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxProfiles: val }),
      });

      const contentType = res.headers.get('content-type') || '';
      if (!res.ok || !contentType.includes('application/json')) {
        showToast('Vui lòng khởi động lại server (`npm start`) để nhận diện API cấu hình mới.', 'warn');
        return;
      }

      const json = await res.json();
      if (json.success) {
        showToast(`Đã cập nhật số luồng song song tối đa thành ${val}!`, 'success');
      } else {
        showToast(`Lỗi cập nhật cấu hình: ${json.error}`, 'error');
      }
    } catch (err) {
      showToast(`Không thể kết nối API cấu hình: ${err.message}`, 'error');
    }
  };

  btnSaveConcurrency?.addEventListener('click', saveConcurrencyHandler);
  inputConcurrency?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveConcurrencyHandler();
  });

  // Select all checkbox (selects ONLY profiles on the CURRENT VISIBLE PAGE)
  const selectAll = document.getElementById('chk-select-all');
  selectAll?.addEventListener('change', (e) => {
    const pageItems = getCurrentPageProfiles().filter(p => p.provider === 'adspower');
    if (e.target.checked) {
      pageItems.forEach(p => selectedProfileIds.add(p.user_id));
    } else {
      pageItems.forEach(p => selectedProfileIds.delete(p.user_id));
    }
    renderProfiles();
  });

  // Batch actions
  document.getElementById('btn-batch-deselect').addEventListener('click', () => {
    selectedProfileIds.clear();
    selectAll.checked = false;
    renderProfiles();
  });

  // Auto Login Facebook Batch Action
  document.getElementById('btn-batch-fb-login')?.addEventListener('click', async () => {
    const ids = Array.from(selectedProfileIds);
    if (ids.length === 0) {
      showToast('Vui lòng chọn ít nhất 1 profile để chạy Auto Login!', 'warn');
      return;
    }

    const concurrencyVal = Number(document.getElementById('input-concurrency')?.value || 5);
    const autoCloseSuccess = document.getElementById('chk-auto-close-success')?.checked;
    showToast(`🚀 Đang phát động Auto Login Facebook Đa luồng cho ${ids.length} profiles (${concurrencyVal} luồng song song)...`, 'info');

    try {
      const res = await fetch('/api/automation/facebook-login/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileIds: ids,
          concurrency: concurrencyVal,
          autoCloseSuccess: Boolean(autoCloseSuccess),
        }),
      });

      const contentType = res.headers.get('content-type') || '';
      if (!res.ok || !contentType.includes('application/json')) {
        showToast('Vui lòng khởi động lại server (`npm start`) để nhận diện endpoint batch đa luồng.', 'warn');
        return;
      }

      const data = await res.json();
      if (data.success) {
        showToast(`🎉 Đã khởi chạy Auto Login đa luồng cho ${ids.length} profiles thành công! Xem tiến độ tại Live Logs.`, 'success');
        switchTab('tab-logs');
      } else {
        showToast(`Lỗi khởi chạy batch: ${data.error}`, 'error');
      }
    } catch (err) {
      showToast(`Lỗi kết nối API: ${err.message}`, 'error');
    }
  });

  document.getElementById('btn-batch-start').addEventListener('click', async () => {
    const ids = Array.from(selectedProfileIds);
    if (ids.length === 0) return;
    showToast(`Đang mở đồng loạt ${ids.length} profiles...`, 'info');
    try {
      const res = await fetch('/api/browser/batch-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileIds: ids }),
      });
      const data = await res.json();
      showToast(`Hoàn tất mở batch ${ids.length} profiles`, 'success');
      fetchProfiles(currentPage);
    } catch (err) {
      showToast(`Lỗi: ${err.message}`, 'error');
    }
  });

  document.getElementById('btn-batch-stop').addEventListener('click', async () => {
    const ids = Array.from(selectedProfileIds);
    showToast('🛑 Đang hủy hàng đợi automation và đóng đồng loạt các profiles...', 'info');

    // 1. Hủy tiến trình Batch Automation ngầm ngay lập tức
    try {
      await fetch('/api/automation/facebook-login/batch-stop', { method: 'POST' });
    } catch {}

    // 2. Đóng các cửa sổ trình duyệt AdsPower đang mở
    if (ids.length > 0) {
      try {
        const res = await fetch('/api/browser/batch-stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileIds: ids }),
        });
        const data = await res.json();
        showToast('🛑 Đã hủy hoàn toàn kịch bản chạy ngầm và đóng các cửa sổ!', 'success');
        fetchProfiles(currentPage);
      } catch (err) {
        showToast(`Lỗi: ${err.message}`, 'error');
      }
    } else {
      showToast('🛑 Đã phát lệnh dừng tiến trình chạy ngầm!', 'info');
    }
  });
}

function setTaothaoRunningState(profileId, isRunning) {
  const profile = allProfiles.find(p => p.provider === 'taothao' && p.user_id === profileId);
  if (profile) profile.isRunning = isRunning;
  renderProfiles();
}

async function startTaothaoBrowser(profileId) {
  const btn = document.getElementById(`btn-taothao-toggle-${profileId}`);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="ph-bold ph-spinner animate-spin"></i> Mở...';
  }
  try {
    const res = await fetch('/api/taothao/browser/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Không thể mở profile');
    setTaothaoRunningState(profileId, true);
    showToast(
      data.reused
        ? `Đã đưa cửa sổ đang làm việc lên trước: ${profileId}`
        : `Đã mở profile taothaoAIClaw: ${profileId}`,
      'success'
    );
  } catch (err) {
    showToast(`Mở profile taothaoAIClaw thất bại: ${err.message}`, 'error');
    renderProfiles();
  }
}

async function stopTaothaoBrowser(profileId) {
  const btn = document.getElementById(`btn-taothao-toggle-${profileId}`);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="ph-bold ph-spinner animate-spin"></i> Đóng...';
  }
  try {
    const res = await fetch('/api/taothao/browser/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Không thể đóng profile');
    setTaothaoRunningState(profileId, false);
    showToast(`Đã đóng profile taothaoAIClaw: ${profileId}`, 'success');
  } catch (err) {
    showToast(`Đóng profile taothaoAIClaw thất bại: ${err.message}`, 'error');
    renderProfiles();
  }
}

function initTaothaoListLauncher() {
  const modal = document.getElementById('modal-open-taothao-list');
  const input = document.getElementById('taothao-profile-list-input');
  const count = document.getElementById('taothao-list-count');
  const resultBox = document.getElementById('taothao-open-result');
  const submit = document.getElementById('btn-submit-taothao-list');
  if (!modal || !input || !submit) return;

  const parseIdentifiers = () => [...new Set(
    input.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
  )];
  const updateCount = () => {
    const total = parseIdentifiers().length;
    if (count) count.textContent = `${total} dòng hợp lệ`;
  };
  const openModal = () => {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    resultBox?.classList.add('hidden');
    updateCount();
    input.focus();
  };
  const closeModal = () => {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  };

  document.getElementById('btn-open-taothao-list')?.addEventListener('click', openModal);
  document.getElementById('btn-close-taothao-list')?.addEventListener('click', closeModal);
  document.getElementById('btn-cancel-taothao-list')?.addEventListener('click', closeModal);
  modal.addEventListener('click', event => {
    if (event.target === modal) closeModal();
  });
  input.addEventListener('input', updateCount);

  submit.addEventListener('click', async () => {
    const identifiers = parseIdentifiers();
    if (identifiers.length === 0) {
      showToast('Hãy dán ít nhất một ID hoặc tên profile taothaoAIClaw.', 'warn');
      input.focus();
      return;
    }

    const concurrencyInput = document.getElementById('taothao-open-concurrency');
    const concurrency = Math.min(20, Math.max(1, Number(concurrencyInput?.value) || 5));
    submit.disabled = true;
    submit.innerHTML = '<i class="ph-bold ph-spinner animate-spin"></i> Đang mở...';
    resultBox?.classList.add('hidden');

    try {
      const res = await fetch('/api/taothao/browser/batch-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifiers, concurrency }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Không thể mở danh sách profile');

      if (resultBox) {
        const notFound = data.notFound || [];
        const failed = (data.results || []).filter(item => !item.success);
        resultBox.innerHTML = `
          <div class="font-semibold text-emerald-300">Đã xử lý ${data.openedCount}/${data.resolvedCount} profile.</div>
          <div class="mt-1 text-slate-400">Dùng lại cửa sổ cũ: ${data.reusedCount || 0} · Mở cửa sổ mới: ${data.launchedCount || 0}</div>
          ${notFound.length ? `<div class="mt-2 text-amber-300">Không tìm thấy (${notFound.length}): ${notFound.map(escapeHtml).join(', ')}</div>` : ''}
          ${failed.length ? `<div class="mt-2 text-rose-300">Mở thất bại (${failed.length}): ${failed.map(item => escapeHtml(item.name || item.profileId)).join(', ')}</div>` : ''}
        `;
        resultBox.classList.remove('hidden');
      }

      (data.results || []).filter(item => item.success).forEach(item => {
        const profile = allProfiles.find(p => p.provider === 'taothao' && p.user_id === item.profileId);
        if (profile) profile.isRunning = true;
      });
      renderProfiles();
      showToast(
        `Đã xử lý ${data.openedCount} profile: dùng lại ${data.reusedCount || 0}, mở mới ${data.launchedCount || 0}.`,
        data.failedCount || data.notFound?.length ? 'warn' : 'success'
      );
    } catch (err) {
      showToast(`Mở danh sách taothaoAIClaw thất bại: ${err.message}`, 'error');
      if (resultBox) {
        resultBox.textContent = err.message;
        resultBox.classList.remove('hidden');
      }
    } finally {
      submit.disabled = false;
      submit.innerHTML = '<i class="ph-bold ph-play"></i> Mở các cửa sổ';
    }
  });
}

function toggleSelectProfile(profileId, isChecked) {
  if (isChecked) {
    selectedProfileIds.add(profileId);
  } else {
    selectedProfileIds.delete(profileId);
  }
  const pageItems = getCurrentPageProfiles();
  const selectAll = document.getElementById('chk-select-all');
  if (selectAll && pageItems.length > 0) {
    selectAll.checked = pageItems.every(p => selectedProfileIds.has(p.user_id));
  }
  updateBatchActionBar();
}

function updateBatchActionBar() {
  const bar = document.getElementById('batch-action-bar');
  const countEl = document.getElementById('selected-count');
  countEl.textContent = selectedProfileIds.size;

  if (selectedProfileIds.size > 0) {
    bar.classList.remove('hidden');
  } else {
    bar.classList.add('hidden');
  }
}

// =========================================================================
// 4. Browser Start / Stop Operations
// =========================================================================
async function startBrowser(profileId) {
  const btn = document.getElementById(`btn-toggle-${profileId}`);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class="ph-bold ph-spinner animate-spin"></i> Mở...`;
  }

  showToast(`Đang khởi động profile ${profileId}...`, 'info');
  try {
    const res = await fetch('/api/browser/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId }),
    });
    const data = await res.json();
    if (data.success) {
      activeProfileIds.add(profileId);
      document.getElementById('stat-active-profiles').textContent = activeProfileIds.size;
      renderProfiles();
      showToast(`Đã mở profile ${profileId} (Debug Port: ${data.data.debug_port})`, 'success');
    } else {
      showToast(`Lỗi: ${data.error}`, 'error');
      renderProfiles();
    }
  } catch (err) {
    showToast(`Lỗi: ${err.message}`, 'error');
    renderProfiles();
  }
}

async function stopBrowser(profileId) {
  const btn = document.getElementById(`btn-toggle-${profileId}`);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class="ph-bold ph-spinner animate-spin"></i> Đóng...`;
  }

  showToast(`Đang đóng profile ${profileId}...`, 'info');
  try {
    const res = await fetch('/api/browser/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId }),
    });
    const data = await res.json();
    if (data.success) {
      activeProfileIds.delete(profileId);
      document.getElementById('stat-active-profiles').textContent = activeProfileIds.size;
      renderProfiles();
      showToast(`Đã đóng profile ${profileId}`, 'success');
    } else {
      showToast(`Không thể đóng profile ${profileId}`, 'error');
      renderProfiles();
    }
  } catch (err) {
    showToast(`Lỗi: ${err.message}`, 'error');
    renderProfiles();
  }
}

async function triggerFBLogin(profileId, profileName) {
  showToast(`🚀 Bắt đầu Auto Facebook Login cho ${profileName || profileId}...`, 'info');
  switchTab('tab-logs');
  try {
    const res = await fetch('/api/automation/facebook-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId, profileName }),
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message, 'success');
    } else {
      showToast(`Lỗi: ${data.error}`, 'error');
    }
  } catch (err) {
    showToast(`Lỗi: ${err.message}`, 'error');
  }
}

// =========================================================================
// 5. Self-Healing Skill Library UI & Modal
// =========================================================================
async function fetchSkills() {
  try {
    const res = await fetch('/api/skills');
    const data = await res.json();
    allSkills = data.skills || [];

    document.getElementById('stat-skills-count').textContent = allSkills.length;
    document.getElementById('badge-nav-skills').textContent = allSkills.length;

    renderSkillsGrid();
  } catch (err) {
    console.error('Fetch skills error:', err);
  }
}

function renderSkillsGrid() {
  const container = document.getElementById('skills-grid');
  const search = (document.getElementById('input-skill-search')?.value || '').toLowerCase().trim();
  const selectedStatus = document.getElementById('select-skill-status')?.value || 'all';

  const filtered = allSkills.filter(skill => {
    const matchSearch =
      !search ||
      skill.skillId?.toLowerCase().includes(search) ||
      skill.site?.toLowerCase().includes(search) ||
      skill.actionType?.toLowerCase().includes(search) ||
      (skill.notes && skill.notes.toLowerCase().includes(search)) ||
      (skill.selectorChain && skill.selectorChain.some(s => s.value?.toLowerCase().includes(search)));

    const matchStatus = selectedStatus === 'all' || skill.status === selectedStatus;

    return matchSearch && matchStatus;
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="col-span-3 p-8 text-center border border-dashed border-slate-800 rounded-2xl text-slate-500 font-sans">
        <i class="ph-duotone ph-brain text-3xl text-slate-600 mb-2"></i>
        <p>Không tìm thấy skill nào phù hợp với điều kiện lọc.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered.map(skill => {
    let statusBadge = '';
    if (skill.status === 'verified') {
      statusBadge = '<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">VERIFIED (Chính thức)</span>';
    } else if (skill.status === 'testing') {
      statusBadge = '<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">TESTING (Thử nghiệm)</span>';
    } else if (skill.status === 'candidate') {
      statusBadge = '<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">CANDIDATE (Đang chờ)</span>';
    } else {
      statusBadge = '<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-rose-500/10 text-rose-400 border border-rose-500/20">ROLLBACK</span>';
    }

    const selectorsHtml = (skill.selectorChain || []).map(s => `
      <div class="flex items-center justify-between py-1 px-2 rounded bg-surface-950/80 border border-slate-800 text-[11px] font-mono">
        <div class="flex items-center space-x-1.5 truncate mr-2">
          <span class="text-brand-400 uppercase font-bold text-[9px] px-1 rounded bg-brand-500/10">#${s.priority} ${s.type}</span>
          <span class="text-slate-300 truncate" title="${escapeHtml(s.value)}">${escapeHtml(s.value)}</span>
        </div>
        <button onclick="copyToClipboard('${escapeHtml(s.value)}', this)" class="text-slate-500 hover:text-white p-0.5 shrink-0" title="Copy">
          <i class="ph ph-copy"></i>
        </button>
      </div>
    `).join('');

    return `
      <div class="p-4 rounded-2xl bg-surface-900 border border-slate-800 flex flex-col justify-between hover:border-slate-700 transition shadow-lg">
        <div>
          <div class="flex items-start justify-between gap-2 mb-2">
            <div>
              <span class="text-[11px] font-mono text-slate-400">${escapeHtml(skill.site)}</span>
              <h4 class="text-sm font-bold text-white leading-tight">${escapeHtml(skill.actionType)}</h4>
            </div>
            ${statusBadge}
          </div>

          <div class="space-y-1.5 my-3">
            <span class="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Chuỗi Selector Tự Sửa (${skill.selectorChain?.length || 0})</span>
            ${selectorsHtml}
          </div>
        </div>

        <div class="border-t border-slate-800 pt-3 flex items-center justify-between text-xs text-slate-400">
          <div class="flex items-center space-x-3 font-mono text-[11px]">
            <span class="text-emerald-400" title="Số lần chạy thành công">✓ ${skill.successCount || 0}</span>
            <span class="text-rose-400" title="Số lần chạy thất bại">✗ ${skill.failCount || 0}</span>
            <span class="text-slate-500">v${skill.version || 1}</span>
          </div>
          <div class="flex items-center space-x-1">
            ${
              skill.status !== 'verified'
                ? `<button onclick="promoteSkill('${skill.skillId}')" class="p-1 rounded hover:bg-emerald-500/20 text-emerald-400 transition" title="Thăng hạng lên Verified">
                     <i class="ph-bold ph-check text-sm"></i>
                   </button>`
                : `<button onclick="rollbackSkill('${skill.skillId}')" class="p-1 rounded hover:bg-amber-500/20 text-amber-400 transition" title="Hạ cấp về Candidate">
                     <i class="ph-bold ph-arrow-u-up-left text-sm"></i>
                   </button>`
            }
            <button onclick="deleteSkill('${skill.skillId}')" class="p-1 rounded hover:bg-rose-500/20 text-rose-400 transition" title="Xóa Skill">
              <i class="ph-bold ph-trash text-sm"></i>
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

async function promoteSkill(skillId) {
  try {
    await fetch(`/api/skills/${skillId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'verified' }),
    });
    showToast(`🎉 Đã thăng cấp skill [${skillId}] lên VERIFIED!`, 'success');
    fetchSkills();
  } catch (err) {
    showToast(`Lỗi: ${err.message}`, 'error');
  }
}

async function rollbackSkill(skillId) {
  try {
    await fetch(`/api/skills/${skillId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'candidate' }),
    });
    showToast(`⚠️ Đã hạ cấp skill [${skillId}] về CANDIDATE để xem xét lại.`, 'info');
    fetchSkills();
  } catch (err) {
    showToast(`Lỗi: ${err.message}`, 'error');
  }
}

async function deleteSkill(skillId) {
  if (!confirm(`Bạn có chắc muốn xóa skill [${skillId}] khỏi kho lưu trữ?`)) return;
  try {
    await fetch(`/api/skills/${skillId}`, { method: 'DELETE' });
    showToast(`Đã xóa skill [${skillId}]`, 'info');
    fetchSkills();
  } catch (err) {
    showToast(`Lỗi: ${err.message}`, 'error');
  }
}

function initSkillModal() {
  const modal = document.getElementById('modal-add-skill');
  const btnOpen = document.getElementById('btn-add-skill-modal');
  const btnClose = document.getElementById('btn-close-skill-modal');
  const btnCancel = document.getElementById('btn-cancel-add-skill');
  const form = document.getElementById('form-add-skill');
  const btnAddSelector = document.getElementById('btn-add-selector-row');
  const selectorContainer = document.getElementById('selector-chain-container');

  const inputSearch = document.getElementById('input-skill-search');
  const selectStatus = document.getElementById('select-skill-status');

  if (inputSearch) inputSearch.addEventListener('input', renderSkillsGrid);
  if (selectStatus) selectStatus.addEventListener('change', renderSkillsGrid);

  const openModal = () => modal?.classList.remove('hidden');
  const closeModal = () => modal?.classList.add('hidden');

  if (btnOpen) btnOpen.addEventListener('click', openModal);
  if (btnClose) btnClose.addEventListener('click', closeModal);
  if (btnCancel) btnCancel.addEventListener('click', closeModal);

  if (btnAddSelector && selectorContainer) {
    btnAddSelector.addEventListener('click', () => {
      const row = document.createElement('div');
      row.className = 'flex items-center space-x-2 selector-row';
      row.innerHTML = `
        <select class="sel-type px-2 py-1.5 bg-surface-950 border border-slate-800 rounded-lg text-xs text-slate-300">
          <option value="css">CSS</option>
          <option value="xpath">XPath</option>
          <option value="text">Text</option>
          <option value="aria-label">ARIA</option>
        </select>
        <input type="text" required placeholder="Giá trị selector (e.g. input[name='email'])" class="sel-value flex-1 px-2.5 py-1.5 bg-surface-950 border border-slate-800 rounded-lg text-xs text-white font-mono focus:outline-none focus:border-brand-500">
        <button type="button" onclick="this.parentElement.remove()" class="p-1 text-slate-500 hover:text-rose-400">
          <i class="ph-bold ph-trash"></i>
        </button>
      `;
      selectorContainer.appendChild(row);
    });
  }

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const skillId = document.getElementById('skill-input-id')?.value?.trim();
      const site = document.getElementById('skill-input-site')?.value?.trim();
      const actionType = document.getElementById('skill-input-action')?.value?.trim();
      const notes = document.getElementById('skill-input-notes')?.value?.trim();

      const rows = selectorContainer.querySelectorAll('.selector-row');
      const selectorChain = [];

      rows.forEach((row, idx) => {
        const type = row.querySelector('.sel-type')?.value || 'css';
        const value = row.querySelector('.sel-value')?.value?.trim();
        if (value) {
          selectorChain.push({
            type,
            value,
            priority: idx + 1,
          });
        }
      });

      if (selectorChain.length === 0) {
        showToast('Vui lòng thêm ít nhất 1 selector vào chuỗi ưu tiên!', 'warn');
        return;
      }

      const payload = {
        skillId,
        site,
        actionType,
        status: 'candidate',
        selectorChain,
        createdBy: 'human',
        createdAt: new Date().toISOString(),
        successCount: 0,
        failCount: 0,
        version: 1,
        notes,
      };

      try {
        const res = await fetch('/api/skills', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        const data = await res.json();
        if (data.success) {
          showToast(`🎉 Thêm skill mới [${skillId}] thành công!`, 'success');
          closeModal();
          form.reset();
          fetchSkills();
        } else {
          showToast(`Lỗi thêm skill: ${data.error}`, 'error');
        }
      } catch (err) {
        showToast(`Không thể kết nối API: ${err.message}`, 'error');
      }
    });
  }
}

// =========================================================================
// 7. Profile Detail Slide-Over Drawer
// =========================================================================
function openProfileDrawer(profileId) {
  const profile = allProfiles.find(p => p.user_id === profileId);
  if (!profile) return;

  const drawer = document.getElementById('profile-drawer');
  const content = document.getElementById('drawer-content');

  const proxy = profile.user_proxy_config || {};
  const tags = profile.fbcc_user_tag || [];

  content.innerHTML = `
    <div class="space-y-3">
      <div class="p-3 rounded-xl bg-surface-950 border border-slate-800">
        <span class="text-[10px] text-slate-500 uppercase font-bold">Tên Profile & ID</span>
        <h4 class="text-sm font-bold text-white mt-0.5">${escapeHtml(profile.name || 'Unnamed')}</h4>
        <p class="font-mono text-slate-400 text-xs mt-0.5 select-all">${profile.user_id}</p>
        <span class="inline-flex mt-2 px-2 py-0.5 rounded-md text-[10px] font-bold ${profile.provider === 'taothao' ? 'bg-sky-500/10 text-sky-300 border border-sky-500/20' : 'bg-violet-500/10 text-violet-300 border border-violet-500/20'}">
          ${profile.provider_label || 'AdsPower'}
        </span>
      </div>

      <div class="p-3 rounded-xl bg-surface-950 border border-slate-800 space-y-2">
        <span class="text-[10px] text-slate-500 uppercase font-bold">Cấu Hình Proxy</span>
        <div class="grid grid-cols-2 gap-2 text-xs">
          <div>
            <span class="text-slate-500">Loại:</span>
            <span class="font-mono text-slate-200 uppercase">${proxy.proxy_type || 'Direct / SOCKS5'}</span>
          </div>
          <div>
            <span class="text-slate-500">Quốc Gia:</span>
            <span class="font-mono text-slate-200 uppercase">${profile.ip_country || 'N/A'}</span>
          </div>
          <div class="col-span-2">
            <span class="text-slate-500">Host/IP:</span>
            <span class="font-mono text-slate-200 select-all">${profile.ip || proxy.proxy_host || 'N/A'}</span>
          </div>
        </div>
      </div>

      <div class="p-3 rounded-xl bg-surface-950 border border-slate-800 space-y-2">
        <span class="text-[10px] text-slate-500 uppercase font-bold">Tài Khoản Gắn Kèm (Platform Account)</span>
        <div class="text-xs text-slate-300">
          <div><span class="text-slate-500">Username:</span> <strong class="select-all font-mono">${profile.username || 'N/A'}</strong></div>
          <div><span class="text-slate-500">Domain:</span> <span class="font-mono text-slate-400">${profile.domain_name || 'N/A'}</span></div>
          <div><span class="text-slate-500">2FA Key:</span> <span class="font-mono text-slate-400 select-all">${profile.fakey || 'N/A'}</span></div>
        </div>
      </div>
    </div>
  `;

  drawer.classList.remove('translate-x-full');
}

document.getElementById('btn-close-drawer')?.addEventListener('click', () => {
  document.getElementById('profile-drawer')?.classList.add('translate-x-full');
});

// =========================================================================
// 8. Realtime SSE Stream & Live Console
// =========================================================================
function initSSE() {
  const sseUrl = `/api/events${authToken ? `?token=${encodeURIComponent(authToken)}` : ''}`;
  const eventSource = new EventSource(sseUrl);

  eventSource.addEventListener('connected', () => {
    appendLog(new Date().toLocaleTimeString(), 'info', 'Đã kết nối Server-Sent Events stream.');
  });

  eventSource.addEventListener('log', (e) => {
    try {
      const data = JSON.parse(e.data);
      appendLog(data.time, data.level, data.message);
    } catch {}
  });

  eventSource.addEventListener('profile_status_change', (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.status === 'active') {
        activeProfileIds.add(data.profileId);
      } else {
        activeProfileIds.delete(data.profileId);
      }
      document.getElementById('stat-active-profiles').textContent = activeProfileIds.size;
      renderProfiles();
    } catch {}
  });

  // Phase 6: Healing event via SSE
  eventSource.addEventListener('healing_event', (e) => {
    try {
      const data = JSON.parse(e.data);
      // Reload healing events table
      fetchHealingEvents();
      showToast(`🩺 Self-Healing: ${data.resolution} for ${data.site}`, 'info');
    } catch {}
  });

  // Phase 7: Workflow task update via SSE
  eventSource.addEventListener('workflow_task_update', (e) => {
    try {
      const task = JSON.parse(e.data);
      updateWorkflowTaskRow(task);
      updateWorkflowCounts();
    } catch {}
  });

  eventSource.addEventListener('workflow_engine_state', (e) => {
    try {
      const data = JSON.parse(e.data);
      updateWorkflowEngineBadge(data.state);
    } catch {}
  });

  eventSource.addEventListener('workflow_batch_completed', (e) => {
    try {
      const data = JSON.parse(e.data);
      const failedCount = data.failedCount || 0;
      const toastMsg = failedCount > 0
        ? `⚠️ Batch hoàn thành: ${failedCount} task(s) thất bại. Nhấn "Retry Failed" để chạy lại.`
        : '✅ Batch workflow hoàn thành!';
      showToast(toastMsg, failedCount > 0 ? 'warn' : 'success');
      updateWorkflowEngineBadge('idle');
      setWorkflowControlState('idle', failedCount);
      fetchWorkflowStatus();
      stopWorkflowPolling();
    } catch {}
  });

  // Báo cáo YouTube đã xuất xong -> hiện thẻ tải file trong tab Workflow Runner
  eventSource.addEventListener('youtube_report_ready', (e) => {
    try {
      const report = JSON.parse(e.data);
      renderYoutubeReport(report);
      showToast(`📊 Đã xuất báo cáo YouTube: ${report.videoCount} video / ${report.profileCount} profile.`, 'success');
    } catch {}
  });

  // Log filter listener
  document.getElementById('select-log-level').addEventListener('change', renderLogs);
  document.getElementById('btn-clear-logs').addEventListener('click', () => {
    logEntries = [];
    renderLogs();
  });
  document.getElementById('btn-copy-logs').addEventListener('click', () => {
    const raw = logEntries.map(l => `[${l.time}] [${l.level.toUpperCase()}] ${l.message}`).join('\n');
    navigator.clipboard.writeText(raw);
    showToast('Đã copy toàn bộ logs vào clipboard', 'success');
  });
}

function appendLog(time, level, message) {
  logEntries.push({ time, level, message });
  if (logEntries.length > 500) logEntries.shift();

  const terminal = document.getElementById('log-terminal');
  if (!terminal) return;

  const levelFilter = document.getElementById('select-log-level')?.value || 'all';
  if (levelFilter !== 'all' && levelFilter !== level) return;

  let colorClass = 'text-slate-300';
  let badgeColor = 'bg-brand-500/10 text-brand-400 border border-brand-500/20';

  if (level === 'warn') {
    colorClass = 'text-amber-300';
    badgeColor = 'bg-amber-500/10 text-amber-400 border border-amber-500/20';
  } else if (level === 'error') {
    colorClass = 'text-rose-400 font-semibold';
    badgeColor = 'bg-rose-500/10 text-rose-400 border border-rose-500/20';
  }

  const logRow = document.createElement('div');
  logRow.className = `flex items-start space-x-2 py-0.5 leading-relaxed hover:bg-surface-900/60 px-1 rounded ${colorClass}`;
  logRow.innerHTML = `
    <span class="text-slate-500 shrink-0 select-none">[${time}]</span>
    <span class="px-1.5 py-0.2 rounded text-[10px] uppercase font-bold shrink-0 ${badgeColor}">${level}</span>
    <span class="break-all flex-1">${escapeHtml(message)}</span>
  `;

  terminal.appendChild(logRow);

  // Keep DOM lightweight: cap at 250 max child nodes
  while (terminal.children.length > 250) {
    terminal.removeChild(terminal.firstChild);
  }


  const autoscroll = document.getElementById('chk-autoscroll')?.checked;
  if (autoscroll) {
    terminal.scrollTop = terminal.scrollHeight;
  }
}

function renderLogs() {
  const terminal = document.getElementById('log-terminal');
  if (!terminal) return;
  const levelFilter = document.getElementById('select-log-level').value;
  const autoscroll = document.getElementById('chk-autoscroll').checked;

  const filtered = logEntries.filter(entry => {
    if (levelFilter === 'all') return true;
    return entry.level === levelFilter;
  });

  terminal.innerHTML = filtered.slice(-250).map(item => {
    let colorClass = 'text-slate-300';
    let badgeColor = 'bg-brand-500/10 text-brand-400 border border-brand-500/20';

    if (item.level === 'warn') {
      colorClass = 'text-amber-300';
      badgeColor = 'bg-amber-500/10 text-amber-400 border border-amber-500/20';
    } else if (item.level === 'error') {
      colorClass = 'text-rose-400 font-semibold';
      badgeColor = 'bg-rose-500/10 text-rose-400 border border-rose-500/20';
    }

    return `
      <div class="flex items-start space-x-2 py-0.5 leading-relaxed hover:bg-surface-900/60 px-1 rounded ${colorClass}">
        <span class="text-slate-500 shrink-0 select-none">[${item.time}]</span>
        <span class="px-1.5 py-0.2 rounded text-[10px] uppercase font-bold shrink-0 ${badgeColor}">${item.level}</span>
        <span class="break-all flex-1">${escapeHtml(item.message)}</span>
      </div>
    `;
  }).join('');

  if (autoscroll) {
    terminal.scrollTop = terminal.scrollHeight;
  }
}

// =========================================================================
// 9. Toast Notifications & Helpers
// =========================================================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');

  let bg = 'bg-surface-900 border-slate-700 text-slate-200';
  let icon = 'ph-info';

  if (type === 'success') {
    bg = 'bg-emerald-950/95 border-emerald-600 text-emerald-200';
    icon = 'ph-check-circle';
  } else if (type === 'error') {
    bg = 'bg-rose-950/95 border-rose-600 text-rose-200';
    icon = 'ph-x-circle';
  }

  toast.className = `pointer-events-auto flex items-center space-x-3 px-4 py-3 rounded-xl border shadow-2xl backdrop-blur-md text-xs font-sans font-medium transform transition-all duration-300 translate-y-2 opacity-0 ${bg}`;
  toast.innerHTML = `
    <i class="ph-bold ${icon} text-lg shrink-0"></i>
    <span class="flex-1">${escapeHtml(message)}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  }, 10);

  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function copyToClipboard(text, btnElement) {
  navigator.clipboard.writeText(text);
  showToast(`Đã copy: ${text}`, 'info');
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text).replace(/[&<>"']/g, function(m) {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    }[m];
  });
}

// =========================================================================
// 6. SELF-HEALING MONITOR (Phase 6)
// =========================================================================

function initHealingMonitor() {
  const btnRefresh = document.getElementById('btn-refresh-healing');
  const btnClear = document.getElementById('btn-clear-healing');
  const btnTestClassify = document.getElementById('btn-test-classify');
  const btnTrigger = document.getElementById('btn-trigger-resolver');
  const btnDoClassify = document.getElementById('btn-do-classify');
  const panelClassify = document.getElementById('panel-test-classify');

  if (btnRefresh) btnRefresh.addEventListener('click', fetchHealingEvents);

  if (btnClear) {
    btnClear.addEventListener('click', async () => {
      if (!confirm('Xóa toàn bộ healing log? Không thể khôi phục.')) return;
      try {
        await fetch('/api/healing/events', { method: 'DELETE' });
        showToast('Đã xóa healing log.', 'success');
        fetchHealingEvents();
      } catch (err) {
        showToast('Lỗi xóa log: ' + err.message, 'error');
      }
    });
  }

  if (btnTestClassify) {
    btnTestClassify.addEventListener('click', () => {
      if (panelClassify) panelClassify.classList.toggle('hidden');
    });
  }

  if (btnTrigger) {
    btnTrigger.addEventListener('click', async () => {
      const site = prompt('Site (e.g. facebook.com):');
      if (!site) return;
      const actionType = prompt('Action Type (e.g. click_login_button):');
      if (!actionType) return;
      const targetDescription = prompt('Target Description:');
      if (!targetDescription) return;

      showToast('🤖 Đang gọi LLM Agent...', 'info');
      try {
        const res = await fetch('/api/healing/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ site, actionType, targetDescription }),
        });
        const data = await res.json();
        if (data.success) {
          showToast(`✅ LLM Agent thành công! ${data.selectors?.length || 0} selectors. Tokens: ${data.tokensUsed || 0}`, 'success');
          fetchHealingEvents();
        } else {
          showToast(`⚠️ ${data.error || 'LLM Agent thất bại'}`, 'warn');
        }
      } catch (err) {
        showToast('Lỗi kết nối: ' + err.message, 'error');
      }
    });
  }

  if (btnDoClassify) {
    btnDoClassify.addEventListener('click', async () => {
      const msg = document.getElementById('classify-error-msg')?.value?.trim();
      const site = document.getElementById('classify-site')?.value?.trim();
      const resultEl = document.getElementById('classify-result');

      if (!msg) { showToast('Vui lòng nhập error message', 'warn'); return; }

      try {
        const res = await fetch('/api/healing/classify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ errorMessage: msg, site }),
        });
        const data = await res.json();
        if (resultEl) {
          const tierColors = { transient: '#f59e0b', structural: '#f97316', blocked: '#ef4444', data: '#ef4444', unknown: '#6b7280' };
          const c = data.classified;
          resultEl.classList.remove('hidden');
          resultEl.innerHTML = `
<span style="color:${tierColors[c?.tier] || '#6b7280'}">● TIER: ${(c?.tier || '?').toUpperCase()}</span>
canAutoRetry: ${c?.canAutoRetry} | requiresAgent: ${c?.requiresAgent} | requiresHumanEscalation: ${c?.requiresHumanEscalation}
message: ${escapeHtml(c?.message || '')}`;
        }
      } catch (err) {
        showToast('Lỗi classify: ' + err.message, 'error');
      }
    });
  }

  // Load when switching to healing tab
  const healingNavBtn = document.querySelector('.nav-item[data-tab="tab-healing"]');
  if (healingNavBtn) {
    healingNavBtn.addEventListener('click', fetchHealingEvents);
  }
}

async function fetchHealingEvents() {
  try {
    const res = await fetch('/api/healing/events?limit=100');
    if (!res.ok) return;
    const data = await res.json();
    renderHealingStats(data.stats);
    renderHealingEvents(data.events);
    const badge = document.getElementById('badge-nav-healing');
    if (badge) badge.textContent = data.stats?.total || 0;
  } catch (err) {
    console.error('fetchHealingEvents error:', err);
  }
}

function renderHealingStats(stats) {
  if (!stats) return;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('heal-stat-total', stats.total || 0);
  set('heal-stat-skill-hit', stats.byResolution?.skill_library_hit || 0);
  set('heal-stat-llm', stats.byResolution?.llm_healed || 0);
  set('heal-stat-escalated', stats.byResolution?.escalated || 0);
  set('heal-stat-saved', stats.totalTokensSaved || 0);
}

function renderHealingEvents(events) {
  const tbody = document.getElementById('healing-events-tbody');
  if (!tbody) return;

  if (!events || events.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="6" class="px-4 py-10 text-center text-slate-500">
        <i class="ph-bold ph-heartbeat text-3xl block mx-auto mb-2 text-slate-600"></i>
        Chưa có healing events nào.
      </td></tr>`;
    return;
  }

  const tierBadge = {
    transient: 'bg-amber-500/15 text-amber-400 border border-amber-500/30',
    structural: 'bg-orange-500/15 text-orange-400 border border-orange-500/30',
    blocked: 'bg-rose-500/15 text-rose-400 border border-rose-500/30',
    data: 'bg-rose-500/15 text-rose-400 border border-rose-500/30',
    unknown: 'bg-slate-700 text-slate-400',
  };
  const resBadge = {
    skill_library_hit: 'bg-brand-500/15 text-brand-400 border border-brand-500/30',
    llm_healed: 'bg-violet-500/15 text-violet-400 border border-violet-500/30',
    escalated: 'bg-rose-500/15 text-rose-400 border border-rose-500/30',
  };
  const resLabel = {
    skill_library_hit: '📚 Skill Hit',
    llm_healed: '🤖 LLM Healed',
    escalated: '🚨 Escalated',
  };

  tbody.innerHTML = events.map(ev => {
    const time = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : '--';
    const oldSel = ev.oldSelectors?.map(s => `<code class="text-rose-300">${escapeHtml(s.value)}</code>`).join(', ') || '<span class="text-slate-600">—</span>';
    const newSel = ev.newSelectors?.map(s => `<code class="text-emerald-300">${escapeHtml(s.value)}</code>`).join(', ') || '<span class="text-slate-600">—</span>';
    const visionBadge = ev.visionFallbackUsed ? '<span class="ml-1 text-[9px] px-1 py-0.5 rounded bg-violet-500/20 text-violet-400">👁 Vision</span>' : '';

    return `
    <tr class="hover:bg-surface-900/40 transition-colors">
      <td class="px-4 py-2.5 text-slate-400 font-mono whitespace-nowrap">${escapeHtml(time)}</td>
      <td class="px-4 py-2.5">
        <div class="font-semibold text-slate-200">${escapeHtml(ev.site)}</div>
        <div class="text-slate-500 text-[10px] font-mono">${escapeHtml(ev.actionType)}</div>
      </td>
      <td class="px-4 py-2.5">
        <span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${tierBadge[ev.errorTier] || tierBadge.unknown}">
          ${ev.errorTier}
        </span>
      </td>
      <td class="px-4 py-2.5">
        <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${resBadge[ev.resolution] || ''}">
          ${resLabel[ev.resolution] || ev.resolution}
        </span>${visionBadge}
      </td>
      <td class="px-4 py-2.5 max-w-xs">
        <div class="text-[10px] space-y-0.5">
          <div>${oldSel} <span class="text-slate-600">→</span></div>
          <div>${newSel}</div>
        </div>
      </td>
      <td class="px-4 py-2.5 text-right font-mono">
        <span class="text-emerald-400 text-xs">+${ev.tokensSaved || 0}</span>
        <span class="text-slate-500 text-[10px] ml-1">saved</span>
        <div class="text-slate-600 text-[9px]">${ev.tokensUsed || 0} used</div>
      </td>
    </tr>`;
  }).join('');
}

// =========================================================================
// 7. WORKFLOW RUNNER (Phase 7)
// =========================================================================

let workflowSelectedProfiles = new Set();
let wfSelectionMode = 'checkbox'; // 'checkbox' | 'text'

// Provider profile trình duyệt đang chọn cho workflow: 'adspower' | 'taothao'.
let wfProvider = 'adspower';
// Profile taothao đã chuẩn hoá về shape {user_id,name,serial_number} để tái dùng UI hiện có.
let wfTaothaoProfiles = [];
let wfTaothaoLoaded = false;

const WF_PROVIDER_LABEL = { adspower: 'AdsPower', taothao: 'taothaoAIClaw' };

function wfProviderLabel() {
  return WF_PROVIDER_LABEL[wfProvider] || wfProvider;
}

/** Pool profile của provider đang chọn. */
function wfProfilePool() {
  return wfProvider === 'taothao'
    ? wfTaothaoProfiles
    : (allProfiles || []).filter(p => p.provider !== 'taothao');
}

/** Provider không lưu credential trong profile -> người dùng phải dán tài khoản. */
function wfProviderNeedsAccounts() {
  return wfProvider === 'taothao';
}

function wfAccountLines() {
  const raw = document.getElementById('wf-google-accounts')?.value || '';
  return raw.split(/\r?\n/).filter(l => l.trim().length > 0);
}

/** Chỉ lấy cột email để preview. KHÔNG BAO GIỜ hiển thị cột password / 2FA. */
function wfAccountEmails() {
  return wfAccountLines().map(l => (l.split(',')[0] || '').trim());
}

function maskEmailClient(email) {
  if (!email) return '(thiếu email)';
  const at = email.indexOf('@');
  if (at <= 0) return email.length <= 2 ? '***' : `${email.slice(0, 2)}***`;
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}

function wfSelectedIdentifiers() {
  if (wfSelectionMode === 'checkbox') return Array.from(workflowSelectedProfiles);
  const rawText = document.getElementById('wf-profile-text-input')?.value || '';
  return rawText
    .split(/\r?\n/)
    .map(l => l.trim().replace(/^\t+|\t+$/g, ''))
    .filter(l => l.length > 0);
}

function wfFindInPool(identifier) {
  const lower = identifier.toLowerCase();
  const serial = identifier.replace(/^#/, '');
  return wfProfilePool().find(
    p =>
      p.user_id === identifier ||
      p.serial_number === identifier ||
      p.serial_number === serial ||
      p.name?.toLowerCase().trim() === lower
  );
}

/** Tải danh sách profile taothaoAIClaw (CHỈ ĐỌC) từ Local API qua backend. */
async function loadTaothaoProfiles(force = false) {
  if (wfTaothaoLoaded && !force) return;
  const container = document.getElementById('wf-profile-list');
  if (container) {
    container.innerHTML = `<div class="text-xs text-slate-500 text-center py-6">
      <i class="ph-bold ph-spinner-gap animate-spin block text-2xl mx-auto mb-2"></i>
      Đang tải profiles từ taothaoAIClaw...</div>`;
  }
  try {
    const res = await fetch('/api/taothao/profiles?fetchAll=true');
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    wfTaothaoProfiles = (data.list || []).map(p => ({
      user_id: p.profileId,
      name: p.name,
      serial_number: p.stt != null ? String(p.stt) : '',
      __isRunning: !!p.isRunning,
    }));
    wfTaothaoLoaded = true;
    showToast(`✅ taothaoAIClaw: ${wfTaothaoProfiles.length} profiles`, 'success');
  } catch (err) {
    wfTaothaoProfiles = [];
    wfTaothaoLoaded = false;
    showToast('❌ Không tải được profiles taothaoAIClaw: ' + err.message, 'error');
  }
  renderWorkflowProfileList(document.getElementById('wf-profile-search')?.value?.trim()?.toLowerCase() || '');
  if (wfSelectionMode === 'text') parseAndValidateTextInput();
}

/** Đồng bộ UI theo provider đang chọn (hint, khối credential, nhãn not-found). */
function applyWfProviderUi() {
  const needsAccounts = wfProviderNeedsAccounts();
  const hint = document.getElementById('wf-provider-hint');
  if (hint) {
    hint.textContent = needsAccounts
      ? 'taothaoAIClaw Local API — credential do bạn dán ở khung Tài Khoản Google.'
      : 'Credential lấy tự động từ chính profile AdsPower.';
  }
  document.getElementById('wf-google-creds-adspower')?.classList.toggle('hidden', needsAccounts);
  document.getElementById('wf-google-creds-taothao')?.classList.toggle('hidden', !needsAccounts);
  const notFoundLabel = document.getElementById('wf-text-notfound-label');
  if (notFoundLabel) {
    notFoundLabel.textContent = `⚠️ Các profile KHÔNG TỒN TẠI trong ${wfProviderLabel()} (sẽ báo lỗi và tổng hợp khi chạy):`;
  }
  updateWfAccountsUi();
}

/**
 * Hiện/ẩn khung tài khoản + kiểm tra số lượng NGAY TRÊN UI trước khi gửi request.
 * Preview chỉ hiển thị email ĐÃ CHE; password/2FA không bao giờ được render.
 */
function updateWfAccountsUi() {
  const card = document.getElementById('wf-accounts-card');
  if (!card) return;
  const preset = document.getElementById('wf-preset-select')?.value || 'facebook_login';
  const show = wfProviderNeedsAccounts() && preset === 'google_account_login';
  card.classList.toggle('hidden', !show);
  if (!show) return;

  const emails = wfAccountEmails();
  const identifiers = wfSelectedIdentifiers();
  const accountCount = emails.length;
  const profileCount = identifiers.length;

  const countEl = document.getElementById('wf-accounts-count');
  if (countEl) countEl.textContent = `${accountCount} tài khoản`;

  const status = document.getElementById('wf-accounts-status');
  const preview = document.getElementById('wf-mapping-preview');
  if (!status || !preview) return;

  const showStatus = (cls, text) => {
    status.className = `px-3 py-2 rounded-xl border text-xs whitespace-pre-line ${cls}`;
    status.textContent = text;
    status.classList.remove('hidden');
  };

  if (accountCount === 0 || profileCount === 0) {
    showStatus(
      'bg-slate-800/40 border-slate-700 text-slate-300',
      `Profiles: ${profileCount}\nAccounts: ${accountCount}\nCần: hai số này bằng nhau.`
    );
    preview.classList.add('hidden');
    preview.innerHTML = '';
    return;
  }

  if (accountCount !== profileCount) {
    showStatus(
      'bg-rose-500/10 border-rose-500/30 text-rose-300',
      `Số lượng profile và tài khoản không khớp.\nProfiles: ${profileCount}\nAccounts: ${accountCount}\nVui lòng kiểm tra lại.`
    );
    preview.classList.add('hidden');
    preview.innerHTML = '';
    return;
  }

  showStatus(
    'bg-emerald-500/10 border-emerald-500/30 text-emerald-300',
    `Khớp ${profileCount} profile ↔ ${accountCount} tài khoản. Ghép CỐ ĐỊNH theo vị trí như bảng dưới.`
  );

  preview.innerHTML = identifiers
    .map((identifier, i) => {
      const found = wfFindInPool(identifier);
      const label = found ? found.name || found.user_id : identifier;
      return `<div class="px-3 py-2 flex items-center gap-3 text-xs">
        <span class="w-6 shrink-0 text-slate-500 font-mono">${i + 1}</span>
        <span class="flex-1 min-w-0 truncate ${found ? 'text-slate-200' : 'text-rose-400'}">${escapeHtml(label)}${
        found ? '' : ' (không tìm thấy)'
      }</span>
        <i class="ph-bold ph-arrow-right text-slate-600 shrink-0"></i>
        <span class="flex-1 min-w-0 truncate font-mono text-brand-300">${escapeHtml(maskEmailClient(emails[i]))}</span>
      </div>`;
    })
    .join('');
  preview.classList.remove('hidden');
}

// ─── Báo cáo YouTube (workflow youtube_channel_videos) ──────────────────────
let youtubeReportFileName = null;

/** Hiện/ẩn thẻ báo cáo. `report` rỗng -> ẩn thẻ. */
function renderYoutubeReport(report) {
  const box = document.getElementById('wf-youtube-report');
  const summary = document.getElementById('wf-youtube-report-summary');
  if (!box || !summary) return;
  if (!report || !report.fileName) {
    youtubeReportFileName = null;
    box.classList.add('hidden');
    return;
  }
  youtubeReportFileName = report.fileName;
  const totalViews = (report.summary || []).reduce((sum, row) => sum + (row.totalViews || 0), 0);
  summary.innerHTML = `Đã xuất <span class="font-mono text-emerald-300">${escapeHtml(report.fileName)}</span> — `
    + `${report.profileCount} profile, ${report.videoCount} video, tổng ${totalViews.toLocaleString('vi-VN')} view.`;
  box.classList.remove('hidden');
}

/** Lấy báo cáo gần nhất (batch có thể đã xong trước khi bạn mở tab). */
async function fetchYoutubeReport() {
  try {
    const res = await fetch('/api/workflow/youtube-report');
    if (!res.ok) return;
    const data = await res.json();
    renderYoutubeReport(data.report);
  } catch {}
}

/**
 * Tải file .xlsx. PHẢI đi qua `fetch` (wrapper tự gắn Bearer token) rồi tạo blob —
 * mở thẳng href sẽ bị 401 vì thẻ <a> không mang token.
 */
async function downloadYoutubeReport() {
  const btn = document.getElementById('btn-wf-youtube-download');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/workflow/youtube-report/download');
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || `Không tải được file báo cáo (HTTP ${res.status}).`, 'error');
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = youtubeReportFileName || 'youtube-videos.xlsx';
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast(`Không tải được file báo cáo: ${err.message}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ─── Kho Channel ID theo profile (tab "Kênh YouTube") ───────────────────────
let youtubeChannelRows = [];

const YT_SOURCE_LABEL = {
  open_tab: 'tab Studio đang mở',
  account_fetch: 'link kênh trong trang account',
  studio_url: 'URL Studio',
  studio_config: 'cấu hình trang Studio',
  account_advanced: 'trang cài đặt nâng cao',
  account_page: 'trang account',
  cache: 'kho đã lưu',
};

/** Hiện khối tuỳ chọn YouTube chỉ khi đang chọn preset YouTube; đồng thời cập nhật số bản ghi. */
function applyWfYoutubeUi() {
  const box = document.getElementById('wf-youtube-options');
  const preset = document.getElementById('wf-preset-select')?.value || 'facebook_login';
  if (box) box.classList.toggle('hidden', preset !== 'youtube_channel_videos');
  if (preset === 'youtube_channel_videos') loadYoutubeChannels();
}

function renderYoutubeChannels() {
  const tbody = document.getElementById('yt-cache-tbody');
  const badge = document.getElementById('badge-nav-youtube');
  const countLine = document.getElementById('wf-youtube-cache-count');
  if (badge) badge.textContent = String(youtubeChannelRows.length);
  if (countLine) {
    countLine.textContent = youtubeChannelRows.length
      ? `Kho Channel ID: ${youtubeChannelRows.length} profile đã lưu`
      : 'Kho Channel ID: chưa có bản ghi nào';
  }
  if (!tbody) return;

  if (youtubeChannelRows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="px-3 py-10 text-center text-slate-500">
      <i class="ph-bold ph-youtube-logo text-3xl block mx-auto mb-2 text-slate-700"></i>
      Chưa có Channel ID nào được lưu. Chạy workflow "YouTube: Tổng Hợp Video Theo Profile" để tạo kho.
    </td></tr>`;
    return;
  }

  tbody.innerHTML = youtubeChannelRows
    .map((row) => {
      const title = row.channelTitle || row.channelHandle || row.channelId;
      const updated = row.updatedAt ? new Date(row.updatedAt).toLocaleString('vi-VN') : '—';
      const source = YT_SOURCE_LABEL[row.channelSource] || row.channelSource || '—';
      return `<tr class="hover:bg-surface-950/40">
        <td class="px-3 py-2.5 font-semibold text-slate-200">${escapeHtml(row.profileName || row.profileId)}
          <span class="block text-[10px] font-mono text-slate-500">${escapeHtml(row.profileId)}</span></td>
        <td class="px-3 py-2.5"><span class="px-1.5 py-0.5 rounded-md bg-slate-800 text-slate-300 text-[10px] font-mono">${escapeHtml(row.provider)}</span></td>
        <td class="px-3 py-2.5">
          <a href="${escapeHtml(row.channelUrl)}" target="_blank" rel="noopener" class="text-rose-400 hover:text-rose-300 font-semibold">${escapeHtml(title)}</a>
          <span class="block text-[10px] font-mono text-slate-500">${escapeHtml(row.channelId)}</span></td>
        <td class="px-3 py-2.5 text-slate-400">${escapeHtml(source)}</td>
        <td class="px-3 py-2.5 text-right font-mono text-slate-300">${row.videoCount ?? '—'}</td>
        <td class="px-3 py-2.5 text-slate-500 text-[11px]">${escapeHtml(updated)}</td>
        <td class="px-3 py-2.5 text-right">
          <button type="button" data-yt-forget="${escapeHtml(row.provider)}|${escapeHtml(row.profileId)}"
            class="px-2 py-1 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/20 text-rose-400 text-[10px] font-bold transition">Xoá</button>
        </td>
      </tr>`;
    })
    .join('');
}

async function loadYoutubeChannels() {
  try {
    const res = await fetch('/api/youtube/channels');
    if (!res.ok) return;
    const data = await res.json();
    youtubeChannelRows = Array.isArray(data.channels) ? data.channels : [];
    renderYoutubeChannels();
  } catch (err) {
    console.error('Load youtube channels error:', err);
  }
}

async function forgetYoutubeChannel(provider, profileId) {
  try {
    const res = await fetch(`/api/youtube/channels/${encodeURIComponent(provider)}/${encodeURIComponent(profileId)}`, {
      method: 'DELETE',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      showToast(data.error || `Không xoá được (HTTP ${res.status}).`, 'error');
      return;
    }
    showToast('✅ Đã xoá Channel ID đã lưu — lượt sau sẽ mở trình duyệt đọc lại profile này.', 'success');
    await loadYoutubeChannels();
  } catch (err) {
    showToast(`Không xoá được: ${err.message}`, 'error');
  }
}

function initYoutubeChannels() {
  document.querySelector('.nav-item[data-tab="tab-youtube"]')?.addEventListener('click', loadYoutubeChannels);
  document.getElementById('btn-yt-cache-reload')?.addEventListener('click', loadYoutubeChannels);

  document.getElementById('btn-yt-cache-clear')?.addEventListener('click', async () => {
    if (youtubeChannelRows.length === 0) {
      showToast('Kho đang trống.', 'info');
      return;
    }
    // Xoá toàn bộ là không thể hoàn tác -> phải xác nhận.
    if (!window.confirm(`Xoá toàn bộ ${youtubeChannelRows.length} Channel ID đã lưu? Lượt chạy sau sẽ phải mở lại từng trình duyệt để đọc.`)) return;
    try {
      const res = await fetch('/api/youtube/channels', { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        showToast(data.error || `Không xoá được kho (HTTP ${res.status}).`, 'error');
        return;
      }
      showToast(data.message || 'Đã xoá kho Channel ID.', 'success');
      await loadYoutubeChannels();
    } catch (err) {
      showToast(`Không xoá được kho: ${err.message}`, 'error');
    }
  });

  // Nút "Xoá" từng dòng: bảng render lại liên tục -> bắt sự kiện ở tbody.
  document.getElementById('yt-cache-tbody')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-yt-forget]');
    if (!btn) return;
    const [provider, profileId] = btn.getAttribute('data-yt-forget').split('|');
    if (provider && profileId) forgetYoutubeChannel(provider, profileId);
  });
}

function initWorkflowRunner() {
  // Mode switchers (Checkbox vs Textarea)
  const btnModeCheckbox = document.getElementById('btn-wf-mode-checkbox');
  const btnModeText = document.getElementById('btn-wf-mode-text');
  const containerCheckbox = document.getElementById('wf-mode-checkbox-container');
  const containerText = document.getElementById('wf-mode-text-container');

  const setWfMode = (mode) => {
    wfSelectionMode = mode;
    if (mode === 'checkbox') {
      btnModeCheckbox?.classList.add('active', 'bg-brand-600', 'text-white', 'shadow-sm');
      btnModeCheckbox?.classList.remove('text-slate-400');
      btnModeText?.classList.remove('active', 'bg-brand-600', 'text-white', 'shadow-sm');
      btnModeText?.classList.add('text-slate-400');

      containerCheckbox?.classList.remove('hidden');
      containerText?.classList.add('hidden');
      updateWfSelectedCount();
    } else {
      btnModeText?.classList.add('active', 'bg-brand-600', 'text-white', 'shadow-sm');
      btnModeText?.classList.remove('text-slate-400');
      btnModeCheckbox?.classList.remove('active', 'bg-brand-600', 'text-white', 'shadow-sm');
      btnModeCheckbox?.classList.add('text-slate-400');

      containerText?.classList.remove('hidden');
      containerCheckbox?.classList.add('hidden');
      parseAndValidateTextInput();
    }
  };

  btnModeCheckbox?.addEventListener('click', () => setWfMode('checkbox'));
  btnModeText?.addEventListener('click', () => setWfMode('text'));

  // Browser provider switch: AdsPower <-> taothaoAIClaw.
  // ID profile của 2 backend KHÔNG dùng lẫn nhau -> xoá lựa chọn khi đổi provider.
  document.getElementById('wf-provider-select')?.addEventListener('change', async (e) => {
    wfProvider = e.target.value === 'taothao' ? 'taothao' : 'adspower';
    workflowSelectedProfiles.clear();
    applyWfProviderUi();
    if (wfProvider === 'taothao') {
      await loadTaothaoProfiles();
    } else {
      renderWorkflowProfileList(document.getElementById('wf-profile-search')?.value?.trim()?.toLowerCase() || '');
    }
    updateWfSelectedCount();
  });

  // Tải lại danh sách profile của provider đang chọn
  document.getElementById('btn-wf-reload-profiles')?.addEventListener('click', async () => {
    if (wfProvider === 'taothao') {
      await loadTaothaoProfiles(true);
    } else {
      await fetchProfiles();
      renderWorkflowProfileList(document.getElementById('wf-profile-search')?.value?.trim()?.toLowerCase() || '');
    }
  });

  // Danh sách tài khoản Google (chỉ dùng cho provider không mang credential)
  document.getElementById('wf-google-accounts')?.addEventListener('input', updateWfAccountsUi);
  document.getElementById('btn-wf-clear-accounts')?.addEventListener('click', () => {
    const ta = document.getElementById('wf-google-accounts');
    if (ta) ta.value = '';
    updateWfAccountsUi();
  });

  // Search filter for checkbox mode
  const searchInput = document.getElementById('wf-profile-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      renderWorkflowProfileList(searchInput.value.trim().toLowerCase());
    });
  }

  // Textarea input event for live validation & matching
  const textInput = document.getElementById('wf-profile-text-input');
  if (textInput) {
    textInput.addEventListener('input', parseAndValidateTextInput);
  }

  // Clear text button
  document.getElementById('btn-wf-clear-text')?.addEventListener('click', () => {
    if (textInput) textInput.value = '';
    parseAndValidateTextInput();
  });

  // Concurrency slider
  const slider = document.getElementById('wf-concurrency');
  const sliderVal = document.getElementById('wf-concurrency-val');
  if (slider && sliderVal) {
    slider.addEventListener('input', () => { sliderVal.textContent = slider.value; });
  }

  // Select all / deselect all
  document.getElementById('btn-wf-select-all')?.addEventListener('click', () => {
    wfProfilePool().forEach(p => workflowSelectedProfiles.add(p.user_id));
    const searchVal = document.getElementById('wf-profile-search')?.value?.trim()?.toLowerCase() || '';
    renderWorkflowProfileList(searchVal);
  });
  document.getElementById('btn-wf-deselect-all')?.addEventListener('click', () => {
    workflowSelectedProfiles.clear();
    const searchVal = document.getElementById('wf-profile-search')?.value?.trim()?.toLowerCase() || '';
    renderWorkflowProfileList(searchVal);
  });

  // Toggle các khối phụ thuộc preset: credential Google, tuỳ chọn YouTube
  document.getElementById('wf-preset-select')?.addEventListener('change', (e) => {
    const credsBlock = document.getElementById('wf-google-credentials');
    if (credsBlock) credsBlock.classList.toggle('hidden', e.target.value !== 'google_account_login');
    applyWfYoutubeUi();
    updateWfAccountsUi();
  });

  // Nút tải file Excel + khôi phục thẻ báo cáo của lần chạy gần nhất
  document.getElementById('btn-wf-youtube-download')?.addEventListener('click', downloadYoutubeReport);
  fetchYoutubeReport();

  // Tuỳ chọn YouTube + số bản ghi trong kho Channel ID (hiển thị ngay khi mở tab)
  document.getElementById('btn-wf-youtube-cache')?.addEventListener('click', () => switchTab('tab-youtube'));
  applyWfYoutubeUi();

  // Run Batch Workflow
  document.getElementById('btn-wf-run')?.addEventListener('click', async () => {
    let profileIdentifiers = [];

    if (wfSelectionMode === 'checkbox') {
      profileIdentifiers = Array.from(workflowSelectedProfiles);
      if (profileIdentifiers.length === 0) {
        showToast('Vui lòng tích chọn ít nhất 1 profile trong danh sách!', 'warn');
        return;
      }
    } else {
      // Text mode
      const rawText = document.getElementById('wf-profile-text-input')?.value || '';
      profileIdentifiers = rawText
        .split(/\r?\n/)
        .map(line => line.trim().replace(/^\t+|\t+$/g, ''))
        .filter(line => line.length > 0);

      if (profileIdentifiers.length === 0) {
        showToast('Vui lòng dán ít nhất 1 tên hoặc ID profile vào ô text!', 'warn');
        return;
      }
    }

    const workflowName = document.getElementById('wf-preset-select')?.value || 'facebook_login';
    const concurrency = Number(document.getElementById('wf-concurrency')?.value || 5);

    const body = { profileIdentifiers, workflowName, concurrency, provider: wfProvider };

    // Workflow YouTube: tích ô này = bỏ qua kho Channel ID, mở profile đọc lại từ đầu.
    if (workflowName === 'youtube_channel_videos') {
      body.refreshChannels = Boolean(document.getElementById('wf-youtube-refresh')?.checked);
    }

    // Provider không mang credential: bắt buộc dán tài khoản và số lượng phải khớp TRƯỚC khi gọi API.
    if (wfProviderNeedsAccounts() && workflowName === 'google_account_login') {
      const rawAccounts = document.getElementById('wf-google-accounts')?.value || '';
      const accountCount = wfAccountLines().length;
      if (accountCount === 0) {
        showToast('Vui lòng dán danh sách tài khoản "gmail,password,2fa" (mỗi dòng một tài khoản).', 'warn');
        return;
      }
      if (accountCount !== profileIdentifiers.length) {
        showToast(
          `❌ Số lượng profile và tài khoản không khớp. Profiles: ${profileIdentifiers.length} / Accounts: ${accountCount}`,
          'error'
        );
        updateWfAccountsUi();
        return;
      }
      body.googleAccounts = rawAccounts;
    }

    showToast(`🚀 Đang chuẩn bị và khởi chạy ${profileIdentifiers.length} profiles...`, 'info');
    try {
      const res = await fetch('/api/workflow/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        setWorkflowControlState('running');
        renderWorkflowTasks(data.tasks || []);
        startWorkflowPolling();

        if (data.notFoundCount > 0) {
          showToast(`⚠️ Đã chạy ${data.resolvedCount} profile hợp lệ. Lưu ý có ${data.notFoundCount} profile không tìm thấy trên ${wfProviderLabel()}!`, 'warn');
        } else {
          showToast(`✅ Đã khởi chạy batch: ${data.tasks?.length || profileIdentifiers.length} tasks`, 'success');
        }
      } else {
        showToast('❌ ' + (data.error || 'Lỗi khởi chạy'), 'error');
      }
    } catch (err) {
      showToast('Lỗi: ' + err.message, 'error');
    }
  });

  // Pause
  document.getElementById('btn-wf-pause')?.addEventListener('click', async () => {
    await fetch('/api/workflow/pause', { method: 'POST' });
    setWorkflowControlState('paused');
    showToast('⏸ Đã tạm dừng workflow batch.', 'warn');
  });

  // Resume
  document.getElementById('btn-wf-resume')?.addEventListener('click', async () => {
    await fetch('/api/workflow/resume', { method: 'POST' });
    setWorkflowControlState('running');
    showToast('▶ Đã tiếp tục workflow batch.', 'success');
  });

  // Cancel
  document.getElementById('btn-wf-cancel')?.addEventListener('click', async () => {
    if (!confirm('Hủy toàn bộ batch workflow?')) return;
    await fetch('/api/workflow/cancel', { method: 'POST' });
    setWorkflowControlState('idle');
    showToast('❌ Đã hủy batch workflow.', 'error');
  });

  // Retry Failed
  document.getElementById('btn-wf-retry')?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/workflow/retry-failed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setWorkflowControlState('running');
      showToast(`🔄 ${data.message}`, 'success');
    } catch (err) {
      showToast('Lỗi retry: ' + err.message, 'error');
    }
  });

  // Clear history
  document.getElementById('btn-wf-clear')?.addEventListener('click', async () => {
    try {
      await fetch('/api/workflow/history', { method: 'DELETE' });
      document.getElementById('wf-tasks-container').innerHTML = `
        <div class="px-4 py-10 text-center text-slate-500 text-xs">
          <i class="ph-bold ph-flow-arrow text-3xl block mx-auto mb-2 text-slate-700"></i>
          Chưa có task nào. Chọn profiles và bấm "Run Batch Workflow" để bắt đầu.
        </div>`;
      updateWorkflowCounts();
      showToast('Đã xóa lịch sử workflow.', 'info');
    } catch (err) {
      showToast('Lỗi: ' + err.message, 'error');
    }
  });

  // Load profile list when switching to workflow tab
  const wfNavBtn = document.querySelector('.nav-item[data-tab="tab-workflow"]');
  if (wfNavBtn) {
    wfNavBtn.addEventListener('click', () => {
      applyWfProviderUi();
      if (wfProvider === 'taothao') loadTaothaoProfiles();
      else renderWorkflowProfileList();
      fetchWorkflowStatus();
      // Báo cáo/kho Channel ID của phiên trước: lần fetch lúc khởi động chạy trước khi đăng nhập
      // nên trả 401 — mở lại tab phải lấy lại, không đợi tới khi có batch mới xong.
      applyWfYoutubeUi();
      fetchYoutubeReport();
    });
  }
}

/**
 * Phân tích và so khớp danh sách tên profile nhập trong Textarea
 */
function parseAndValidateTextInput() {
  const textInput = document.getElementById('wf-profile-text-input');
  const summaryBox = document.getElementById('wf-text-preview-summary');
  const matchedBadge = document.getElementById('wf-text-matched-badge');
  const notfoundBadge = document.getElementById('wf-text-notfound-badge');
  const notfoundContainer = document.getElementById('wf-text-notfound-list');
  const notfoundPills = document.getElementById('wf-text-notfound-pills');
  const selectedCountEl = document.getElementById('wf-selected-count');

  if (!textInput) return;

  const rawText = textInput.value || '';
  const lines = rawText
    .split(/\r?\n/)
    .map(l => l.trim().replace(/^\t+|\t+$/g, ''))
    .filter(l => l.length > 0);

  if (lines.length === 0) {
    if (summaryBox) summaryBox.classList.add('hidden');
    if (selectedCountEl && wfSelectionMode === 'text') selectedCountEl.textContent = '0 đã nhập';
    updateWfAccountsUi();
    return;
  }

  const matched = [];
  const notFound = [];

  lines.forEach(line => {
    const cleanLower = line.toLowerCase();
    const serial = line.replace(/^#/, '');

    const found = wfProfilePool().find(
      p =>
        p.user_id === line ||
        p.serial_number === line ||
        p.serial_number === serial ||
        p.name?.toLowerCase().trim() === cleanLower
    );

    if (found) {
      matched.push({ input: line, profile: found });
    } else {
      notFound.push(line);
    }
  });

  if (summaryBox) {
    summaryBox.classList.remove('hidden');
    if (notFound.length > 0) {
      summaryBox.className = 'p-3 rounded-xl border border-rose-500/30 bg-rose-500/5 space-y-2 text-xs';
    } else {
      summaryBox.className = 'p-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 space-y-2 text-xs';
    }
  }

  if (matchedBadge) matchedBadge.textContent = `${matched.length} hợp lệ`;
  if (notfoundBadge) notfoundBadge.textContent = `${notFound.length} không tìm thấy`;

  if (notfoundContainer && notfoundPills) {
    if (notFound.length > 0) {
      notfoundContainer.classList.remove('hidden');
      notfoundPills.innerHTML = notFound
        .map(
          nf =>
            `<span class="px-2 py-0.5 rounded-lg bg-rose-500/20 text-rose-300 border border-rose-500/30 font-mono text-[11px]">${escapeHtml(
              nf
            )}</span>`
        )
        .join('');
    } else {
      notfoundContainer.classList.add('hidden');
      notfoundPills.innerHTML = '';
    }
  }

  if (selectedCountEl && wfSelectionMode === 'text') {
    selectedCountEl.textContent = `${lines.length} profile (${matched.length} hợp lệ)`;
  }

  updateWfAccountsUi();
}

let wfPollInterval = null;
/** Poll trước đó thấy engine đang chạy -> dùng để nhận biết batch vừa kết thúc. */
let wfWasRunning = false;

function startWorkflowPolling() {
  stopWorkflowPolling();
  fetchWorkflowStatus();
  wfPollInterval = setInterval(async () => {
    const isRunning = await fetchWorkflowStatus();
    if (!isRunning) {
      stopWorkflowPolling();
    }
  }, 1000);
}

function stopWorkflowPolling() {
  if (wfPollInterval) {
    clearInterval(wfPollInterval);
    wfPollInterval = null;
  }
}

async function fetchWorkflowStatus() {
  try {
    const res = await fetch('/api/workflow/status');
    if (!res.ok) return false;
    const data = await res.json();
    setWorkflowControlState(data.engineState || 'idle');
    renderWorkflowTasks(data.tasks || []);
    updateWorkflowCounts();

    const badge = document.getElementById('badge-nav-workflow');
    if (badge) badge.textContent = data.engineState || 'idle';

    const isRunning = data.engineState === 'running';
    // Batch vừa chạy xong -> lấy metadata báo cáo YouTube qua REST.
    // KHÔNG dựa vào SSE: stream có thể chưa kết nối (đăng nhập giữa phiên) và
    // khi đó thẻ tải file .xlsx sẽ không bao giờ hiện.
    if (wfWasRunning && !isRunning) {
      fetchYoutubeReport();
      // Batch YouTube vừa xong -> kho Channel ID đã có thêm bản ghi, cập nhật lại bảng/badge.
      loadYoutubeChannels();
    }
    wfWasRunning = isRunning;
    return isRunning;
  } catch {
    return false;
  }
}

function renderWorkflowProfileList(filterQuery = '') {
  const container = document.getElementById('wf-profile-list');
  if (!container) return;

  const pool = wfProfilePool();
  if (pool.length === 0) {
    container.innerHTML =
      wfProvider === 'taothao'
        ? `<div class="text-xs text-slate-500 text-center py-6">Chưa có profiles taothaoAIClaw. Bấm "Tải lại" để lấy danh sách.</div>`
        : `<div class="text-xs text-slate-500 text-center py-6">Chưa có profiles. Hãy tải danh sách ở tab Profiles trước.</div>`;
    return;
  }

  const filtered = filterQuery
    ? pool.filter(
        p =>
          p.name?.toLowerCase().includes(filterQuery) ||
          p.user_id?.toLowerCase().includes(filterQuery) ||
          String(p.serial_number || '').includes(filterQuery)
      )
    : pool;

  if (filtered.length === 0) {
    container.innerHTML = `<div class="text-xs text-slate-500 text-center py-6">Không tìm thấy profile khớp với "${escapeHtml(
      filterQuery
    )}"</div>`;
    return;
  }

  container.innerHTML = filtered
    .map(p => {
      const isSelected = workflowSelectedProfiles.has(p.user_id);
      const isActive = wfProvider === 'taothao' ? !!p.__isRunning : activeProfileIds.has(p.user_id);
      return `
    <label class="flex items-center gap-2.5 px-3 py-2 rounded-xl cursor-pointer hover:bg-slate-800/50 transition ${
      isSelected ? 'bg-brand-500/5 border border-brand-500/20' : 'border border-transparent'
    }">
      <input type="checkbox" ${isSelected ? 'checked' : ''} onchange="toggleWorkflowProfile('${p.user_id}', this.checked)"
        class="rounded bg-slate-800 border-slate-700 text-brand-500 focus:ring-0 focus:ring-offset-0 accent-brand-500">
      <div class="flex-1 min-w-0">
        <div class="text-xs font-semibold text-slate-200 truncate">${escapeHtml(p.name || p.user_id)}</div>
        <div class="text-[10px] text-slate-500 font-mono">#${p.serial_number || p.user_id}</div>
      </div>
      ${
        isActive
          ? '<span class="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 font-bold shrink-0">LIVE</span>'
          : ''
      }
    </label>`;
    })
    .join('');

  updateWfSelectedCount();
}

function toggleWorkflowProfile(profileId, checked) {
  if (checked) {
    workflowSelectedProfiles.add(profileId);
  } else {
    workflowSelectedProfiles.delete(profileId);
  }
  updateWfSelectedCount();
}

function updateWfSelectedCount() {
  const el = document.getElementById('wf-selected-count');
  if (el) {
    if (wfSelectionMode === 'checkbox') {
      el.textContent = `${workflowSelectedProfiles.size} đã chọn`;
    } else {
      const rawText = document.getElementById('wf-profile-text-input')?.value || '';
      const lines = rawText
        .split(/\r?\n/)
        .map(l => l.trim().replace(/^\t+|\t+$/g, ''))
        .filter(l => l.length > 0);
      el.textContent = `${lines.length} đã nhập`;
    }
  }
  updateWfAccountsUi();
}

function renderWorkflowTasks(tasks) {
  const container = document.getElementById('wf-tasks-container');
  if (!container) return;

  if (!tasks || tasks.length === 0) {
    container.innerHTML = `
      <div class="px-4 py-10 text-center text-slate-500 text-xs">
        <i class="ph-bold ph-flow-arrow text-3xl block mx-auto mb-2 text-slate-700"></i>
        Chưa có task nào.
      </div>`;
    return;
  }

  container.innerHTML = '';
  tasks.forEach(task => {
    const row = buildWorkflowTaskRow(task);
    container.appendChild(row);
  });
}

function buildWorkflowTaskRow(task) {
  const div = document.createElement('div');
  div.id = `wf-task-${task.taskId}`;
  div.className = 'px-4 py-3 flex items-center gap-4';
  div.innerHTML = getWorkflowTaskRowHTML(task);
  return div;
}

function updateWorkflowTaskRow(task) {
  let row = document.getElementById(`wf-task-${task.taskId}`);
  const container = document.getElementById('wf-tasks-container');
  if (!container) return;

  // Remove empty state if present
  const emptyState = container.querySelector('div:not([id])');
  if (emptyState) emptyState.remove();

  if (!row) {
    row = buildWorkflowTaskRow(task);
    container.appendChild(row);
  } else {
    row.innerHTML = getWorkflowTaskRowHTML(task);
  }
}

function getWorkflowTaskRowHTML(task) {
  const statusConfig = {
    pending:   { color: 'text-slate-400', dot: 'bg-slate-500', label: 'Chờ' },
    running:   { color: 'text-brand-300', dot: 'bg-brand-500 animate-pulse', label: 'Đang chạy' },
    completed: { color: 'text-emerald-400', dot: 'bg-emerald-500', label: 'Hoàn thành' },
    failed:    { color: 'text-rose-400', dot: 'bg-rose-500', label: 'Thất bại' },
    paused:    { color: 'text-amber-400', dot: 'bg-amber-500', label: 'Tạm dừng' },
    escalated: { color: 'text-orange-400', dot: 'bg-orange-500', label: 'Escalated' },
  };
  const cfg = statusConfig[task.status] || statusConfig.pending;
  const pct = task.progressPercent || 0;
  const displayName = task.profileName || task.profileId;
  const stepInfo = task.currentStepName ? `Step ${task.currentStepIndex + 1}/${task.totalSteps}: ${escapeHtml(task.currentStepName)}` : '';
  const errInfo = task.errorMessage ? `<div class="text-rose-400 text-[11px] font-medium mt-1 truncate flex items-center gap-1"><i class="ph-bold ph-warning-circle shrink-0"></i> ${escapeHtml(task.errorMessage)}</div>` : '';

  const loginStateConfig = {
    SUCCESS:               { color: 'text-emerald-400', label: 'Login: Thành công' },
    FAILED:                { color: 'text-rose-400', label: 'Login: Thất bại' },
    TIMEOUT:               { color: 'text-amber-400', label: 'Login: Timeout' },
    VERIFICATION_REQUIRED: { color: 'text-yellow-400', label: 'Login: Cần xác minh' },
    NEEDS_HUMAN_REVIEW:    { color: 'text-orange-400', label: 'Login: Cần review thủ công' },
    QUEUED:                { color: 'text-slate-400', label: 'Login: Trong hàng đợi' },
    RUNNING:               { color: 'text-brand-300', label: 'Login: Đang chạy' },
    CREDENTIAL_UNAVAILABLE:  { color: 'text-rose-400', label: 'Login: Thiếu credential AdsPower' },
    BROWSER_WINDOW_MISMATCH: { color: 'text-orange-400', label: 'Login: Sai cửa sổ trình duyệt' },
  };
  const loginCfg = task.loginState ? loginStateConfig[task.loginState] : null;
  const loginBadge = loginCfg
    ? `<span class="text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-slate-800 ${loginCfg.color}">${loginCfg.label}</span>`
    : '';

  // Browser Status (degrade gracefully on older payloads without these fields)
  let browserBadge = '';
  if (task.cleanupState === 'CLOSE_FAILED') {
    browserBadge = `<span class="text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-slate-800 text-rose-400">Browser: Open (close failed)</span>`;
  } else if (task.browserOpen === true) {
    browserBadge = `<span class="text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-slate-800 text-amber-400">Browser: Open</span>`;
  } else if (task.browserOpen === false) {
    browserBadge = `<span class="text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-slate-800 text-emerald-400">Browser: Closed</span>`;
  }

  return `
    <div class="w-2.5 h-2.5 rounded-full shrink-0 ${cfg.dot}"></div>
    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-2 mb-1 flex-wrap">
        <span class="text-xs font-bold text-slate-200 truncate">${escapeHtml(displayName)}</span>
        ${task.profileId && task.profileId !== displayName ? `<span class="text-[10px] text-slate-500 font-mono">(${escapeHtml(String(task.profileId))})</span>` : ''}
        <span class="text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-slate-800 ${cfg.color}">${cfg.label}</span>
        ${task.status === 'running' ? `<span class="text-[10px] text-slate-500 truncate">${escapeHtml(stepInfo)}</span>` : ''}
        ${loginBadge}
        ${browserBadge}
      </div>
      <!-- Progress Bar -->
      <div class="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
        <div class="h-full rounded-full transition-all duration-500 ${task.status === 'completed' ? 'bg-emerald-500' : task.status === 'failed' ? 'bg-rose-500' : 'bg-brand-500'}"
          style="width: ${pct}%"></div>
      </div>
      ${errInfo}
    </div>
    <div class="text-right shrink-0">
      <div class="text-xs font-mono font-bold ${cfg.color}">${pct}%</div>
      <div class="text-[10px] text-slate-600">${task.currentStepIndex}/${task.totalSteps} steps</div>
    </div>`;
}

function updateWorkflowCounts() {
  const container = document.getElementById('wf-tasks-container');
  if (!container) return;


  const rows = Array.from(container.querySelectorAll('[id^="wf-task-"]'));
  let running = 0, done = 0, failed = 0, pending = 0;

  rows.forEach(row => {
    if (row.querySelector('.bg-brand-500.animate-pulse')) running++;
    else if (row.querySelector('.bg-emerald-500:not(.animate-pulse)')) done++;
    else if (row.querySelector('.bg-rose-500')) failed++;
    else if (row.querySelector('.bg-slate-500')) pending++;
  });

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('wf-count-running', running);
  set('wf-count-done', done);
  set('wf-count-failed', failed);
  set('wf-count-pending', pending);
}

function updateWorkflowEngineBadge(state) {
  const badge = document.getElementById('wf-engine-state-badge');
  const dot = document.getElementById('wf-engine-dot');
  const navBadge = document.getElementById('badge-nav-workflow');

  const stateConfig = {
    idle:       { label: 'IDLE',       dot: 'bg-slate-600',              badge: 'bg-slate-700 text-slate-300' },
    running:    { label: 'RUNNING',    dot: 'bg-brand-500 animate-pulse', badge: 'bg-brand-500/20 text-brand-300' },
    paused:     { label: 'PAUSED',     dot: 'bg-amber-500',              badge: 'bg-amber-500/20 text-amber-300' },
    cancelling: { label: 'CANCELLING', dot: 'bg-rose-500',               badge: 'bg-rose-500/20 text-rose-300' },
    cancelled:  { label: 'CANCELLED',  dot: 'bg-slate-600',              badge: 'bg-slate-700 text-slate-300' },
  };
  const cfg = stateConfig[state] || stateConfig.idle;

  if (badge) badge.className = `text-xs px-2.5 py-0.5 rounded-full font-semibold ${cfg.badge}`;
  if (badge) badge.textContent = cfg.label;
  if (dot) dot.className = `w-3 h-3 rounded-full ${cfg.dot}`;
  if (navBadge) navBadge.textContent = state || 'idle';
}

function setWorkflowControlState(state, failedCount = 0) {
  updateWorkflowEngineBadge(state);
  const btnRun = document.getElementById('btn-wf-run');
  const btnPause = document.getElementById('btn-wf-pause');
  const btnResume = document.getElementById('btn-wf-resume');
  const btnCancel = document.getElementById('btn-wf-cancel');
  const btnRetry = document.getElementById('btn-wf-retry');

  if (state === 'running') {
    if (btnRun) btnRun.disabled = true;
    if (btnPause) btnPause.disabled = false;
    if (btnResume) btnResume.disabled = true;
    if (btnCancel) btnCancel.disabled = false;
    if (btnRetry) btnRetry.disabled = true;
  } else if (state === 'paused') {
    if (btnRun) btnRun.disabled = true;
    if (btnPause) btnPause.disabled = true;
    if (btnResume) btnResume.disabled = false;
    if (btnCancel) btnCancel.disabled = false;
    if (btnRetry) btnRetry.disabled = true;
  } else {
    // idle / cancelled
    if (btnRun) btnRun.disabled = false;
    if (btnPause) btnPause.disabled = true;
    if (btnResume) btnResume.disabled = true;
    if (btnCancel) btnCancel.disabled = true;
    // Retry chỉ active khi có failed tasks
    if (btnRetry) btnRetry.disabled = failedCount === 0;
  }
}


// =========================================================================
// YOUTUBE CHANNEL CHECKER
// =========================================================================

let youtubeResults = [];

function initYoutubeChecker() {
  const apiKeyInput = document.getElementById('ytc-api-key');
  const btnSaveKey = document.getElementById('btn-ytc-save-key');
  const textarea = document.getElementById('ytc-channel-list');
  const inputCount = document.getElementById('ytc-input-count');
  const btnClear = document.getElementById('btn-ytc-clear');
  const btnCheck = document.getElementById('btn-ytc-check');
  const btnExport = document.getElementById('btn-ytc-export');

  // Load saved API key status
  fetch('/api/youtube/config')
    .then(r => r.json())
    .then(data => {
      if (data.hasKey && apiKeyInput) {
        apiKeyInput.placeholder = 'API Key đã được lưu — nhập mới để thay đổi';
      }
    })
    .catch(() => {});

  // Update live input count
  if (textarea) {
    textarea.addEventListener('input', () => {
      const lines = textarea.value.split('\n').filter(l => l.trim());
      if (inputCount) inputCount.textContent = `${lines.length} kênh được nhập`;
    });
  }

  // Save API key
  if (btnSaveKey) {
    btnSaveKey.addEventListener('click', async () => {
      const key = apiKeyInput?.value?.trim();
      if (!key) {
        showToast('Vui lòng nhập YouTube API Key!', 'error');
        return;
      }
      try {
        const res = await fetch('/api/youtube/save-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: key }),
        });
        const data = await res.json();
        if (data.success) {
          showToast('Đã lưu YouTube API Key thành công!', 'success');
          if (apiKeyInput) {
            apiKeyInput.value = '';
            apiKeyInput.placeholder = 'API Key đã được lưu — nhập mới để thay đổi';
          }
        } else {
          showToast(data.error || 'Lỗi lưu API Key!', 'error');
        }
      } catch (err) {
        showToast(`Lỗi kết nối server: ${err.message}`, 'error');
      }
    });
  }

  // Clear textarea
  if (btnClear) {
    btnClear.addEventListener('click', () => {
      if (textarea) textarea.value = '';
      if (inputCount) inputCount.textContent = '0 kênh được nhập';
    });
  }

  // Check channels
  if (btnCheck) {
    btnCheck.addEventListener('click', async () => {
      const channels = textarea?.value?.split('\n').map(l => l.trim()).filter(Boolean) || [];
      if (channels.length === 0) {
        showToast('Vui lòng nhập ít nhất 1 kênh YouTube!', 'error');
        return;
      }

      const apiKey = apiKeyInput?.value?.trim() || '';
      const maxVideosEl = document.getElementById('ytc-max-videos');
      const maxVideos = parseInt(maxVideosEl?.value || '10', 10) || 0;

      document.getElementById('ytc-progress')?.classList.remove('hidden');
      document.getElementById('ytc-results-section')?.classList.add('hidden');
      document.getElementById('ytc-errors')?.classList.add('hidden');
      document.getElementById('ytc-stats-row')?.classList.add('hidden');
      if (btnCheck) btnCheck.disabled = true;

      const progressText = document.getElementById('ytc-progress-text');
      if (progressText) progressText.textContent = `Đang kiểm tra ${channels.length} kênh...`;

      try {
        const res = await fetch('/api/youtube/check-channels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channels, youtubeApiKey: apiKey, maxVideos }),
        });
        const data = await res.json();

        if (!data.success) {
          showToast(data.error || 'Lỗi kiểm tra kênh!', 'error');
          return;
        }

        youtubeResults = data.results || [];
        renderYoutubeResults(youtubeResults, data.errors || []);

        // Update nav badge
        const navBadge = document.getElementById('badge-nav-youtube-checker');
        if (navBadge && youtubeResults.length > 0) {
          navBadge.textContent = String(youtubeResults.length);
          navBadge.classList.remove('hidden');
        }
      } catch (err) {
        showToast(`Lỗi kết nối: ${err.message}`, 'error');
      } finally {
        document.getElementById('ytc-progress')?.classList.add('hidden');
        if (btnCheck) btnCheck.disabled = false;
      }
    });
  }

  // Export Excel
  if (btnExport) {
    btnExport.addEventListener('click', () => exportYoutubeExcel(youtubeResults));
  }
}

function ytFormatNumber(n) {
  if (n === null || n === undefined) return 'Ẩn';
  const num = Number(n);
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(2) + 'B';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return num.toLocaleString('vi-VN');
}

function renderYoutubeResults(results, errors) {
  // Render error list
  const errorsDiv = document.getElementById('ytc-errors');
  const errorsList = document.getElementById('ytc-errors-list');
  if (errors.length > 0 && errorsList && errorsDiv) {
    errorsList.innerHTML = errors.map(e =>
      `<div class="flex items-start gap-2 text-xs">
        <i class="ph-bold ph-x-circle text-rose-400 mt-0.5 shrink-0"></i>
        <span class="text-rose-300 font-mono truncate max-w-xs">${e.input}</span>
        <span class="text-slate-400">— ${e.error}</span>
      </div>`
    ).join('');
    errorsDiv.classList.remove('hidden');
  } else if (errorsDiv) {
    errorsDiv.classList.add('hidden');
  }

  if (results.length === 0) {
    showToast('Không tìm thấy kênh nào! Kiểm tra API Key và định dạng kênh.', 'warn');
    return;
  }

  // Aggregate stats
  const totalSubs = results.reduce((s, r) => s + (r.subscribers || 0), 0);
  const totalViews = results.reduce((s, r) => s + (r.totalViews || 0), 0);
  const totalVideos = results.reduce((s, r) => s + (r.videoCount || 0), 0);

  const statsRow = document.getElementById('ytc-stats-row');
  if (statsRow) {
    statsRow.innerHTML = `
      <div class="stat-card p-4 rounded-2xl bg-surface-900/70 border border-slate-800/80 backdrop-blur shadow-sm">
        <div class="flex items-center justify-between text-xs font-semibold text-slate-400 uppercase tracking-wider">
          <span>Kênh Tìm Thấy</span>
          <div class="w-8 h-8 rounded-lg bg-red-500/10 text-red-400 flex items-center justify-center"><i class="ph-bold ph-youtube-logo text-lg"></i></div>
        </div>
        <div class="mt-2 flex items-baseline space-x-2">
          <span class="text-2xl sm:text-3xl font-black text-red-400 font-mono">${results.length}</span>
          <span class="text-xs text-slate-500">kênh</span>
        </div>
      </div>
      <div class="stat-card p-4 rounded-2xl bg-surface-900/70 border border-slate-800/80 backdrop-blur shadow-sm">
        <div class="flex items-center justify-between text-xs font-semibold text-slate-400 uppercase tracking-wider">
          <span>Tổng Subscribers</span>
          <div class="w-8 h-8 rounded-lg bg-brand-500/10 text-brand-400 flex items-center justify-center"><i class="ph-bold ph-users text-lg"></i></div>
        </div>
        <div class="mt-2 flex items-baseline space-x-2">
          <span class="text-2xl sm:text-3xl font-black text-brand-400 font-mono">${ytFormatNumber(totalSubs)}</span>
        </div>
      </div>
      <div class="stat-card p-4 rounded-2xl bg-surface-900/70 border border-slate-800/80 backdrop-blur shadow-sm">
        <div class="flex items-center justify-between text-xs font-semibold text-slate-400 uppercase tracking-wider">
          <span>Tổng Views</span>
          <div class="w-8 h-8 rounded-lg bg-violet-500/10 text-violet-400 flex items-center justify-center"><i class="ph-bold ph-eye text-lg"></i></div>
        </div>
        <div class="mt-2 flex items-baseline space-x-2">
          <span class="text-2xl sm:text-3xl font-black text-violet-400 font-mono">${ytFormatNumber(totalViews)}</span>
        </div>
      </div>
      <div class="stat-card p-4 rounded-2xl bg-surface-900/70 border border-slate-800/80 backdrop-blur shadow-sm">
        <div class="flex items-center justify-between text-xs font-semibold text-slate-400 uppercase tracking-wider">
          <span>Tổng Video</span>
          <div class="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center"><i class="ph-bold ph-video text-lg"></i></div>
        </div>
        <div class="mt-2 flex items-baseline space-x-2">
          <span class="text-2xl sm:text-3xl font-black text-emerald-400 font-mono">${ytFormatNumber(totalVideos)}</span>
        </div>
      </div>
    `;
    statsRow.classList.remove('hidden');
  }

  // Render table rows
  const tbody = document.getElementById('ytc-results-tbody');
  const resultCount = document.getElementById('ytc-result-count');
  if (resultCount) resultCount.textContent = `(${results.length} kênh)`;

  if (tbody) {
    tbody.innerHTML = results.map((r, i) => {
      const thumbHtml = r.thumbnail
        ? `<img src="${r.thumbnail}" alt="" class="w-10 h-10 rounded-full object-cover border border-slate-700 shrink-0" onerror="this.style.display='none'">`
        : `<div class="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center shrink-0"><i class="ph-bold ph-youtube-logo text-red-400"></i></div>`;

      const subsHtml = r.hiddenSubscribers
        ? `<span class="text-slate-500 text-xs italic">Ẩn</span>`
        : `<span class="text-brand-400 font-bold font-mono">${ytFormatNumber(r.subscribers)}</span>`;

      const createdDate = r.publishedAt
        ? new Date(r.publishedAt).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })
        : '—';

      const hasVideos = r.videos && r.videos.length > 0;
      const videosBtnHtml = hasVideos
        ? `<button onclick="ytToggleVideos(${i},this)" class="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 hover:text-red-300 transition">
            <i class="ph-bold ph-caret-down text-xs"></i> ${r.videos.length}
          </button>`
        : `<span class="text-slate-600 text-xs">—</span>`;

      const videoRowsHtml = hasVideos
        ? r.videos.map((v, vi) => {
            const vDate = v.publishedAt ? new Date(v.publishedAt).toLocaleDateString('vi-VN') : '—';
            return `<tr class="bg-slate-900/50 hover:bg-slate-900/80 transition-colors">
              <td class="pl-10 pr-3 py-2 text-xs text-slate-600 font-mono">${vi + 1}</td>
              <td class="px-3 py-2 max-w-xs">
                <a href="${v.url}" target="_blank" rel="noopener noreferrer" class="text-xs text-brand-400 hover:text-brand-300 hover:underline line-clamp-1" title="${v.title.replace(/"/g, '&quot;')}">${v.title || 'N/A'}</a>
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs text-violet-400">${ytFormatNumber(v.viewCount)}</td>
              <td class="px-3 py-2 text-right font-mono text-xs text-emerald-400">${ytFormatNumber(v.likeCount)}</td>
              <td class="px-3 py-2 text-right font-mono text-xs text-slate-400">${ytFormatNumber(v.commentCount)}</td>
              <td class="px-3 py-2 text-xs text-slate-500">${vDate}</td>
            </tr>`;
          }).join('')
        : '';

      const subTableHtml = hasVideos
        ? `<tr id="ytc-sub-${i}" class="hidden">
            <td colspan="9" class="p-0 bg-slate-950/60 border-b border-slate-800">
              <div class="overflow-x-auto">
                <table class="w-full text-left text-xs">
                  <thead class="bg-slate-900/80 text-slate-500 uppercase tracking-wider">
                    <tr>
                      <th class="pl-10 pr-3 py-2 w-10">#</th>
                      <th class="px-3 py-2">Tiêu Đề Video</th>
                      <th class="px-3 py-2 text-right">Views</th>
                      <th class="px-3 py-2 text-right">Likes</th>
                      <th class="px-3 py-2 text-right">Comments</th>
                      <th class="px-3 py-2">Ngày Đăng</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-slate-800/40">
                    ${videoRowsHtml}
                  </tbody>
                </table>
              </div>
            </td>
          </tr>`
        : '';

      return `<tr class="hover:bg-surface-900/50 transition-colors" id="ytc-row-${i}">
        <td class="px-3 py-3 text-center text-xs text-slate-500 font-mono">${i + 1}</td>
        <td class="px-4 py-3">
          <div class="flex items-center gap-3">
            ${thumbHtml}
            <div class="min-w-0">
              <div class="text-sm font-semibold text-white truncate max-w-xs" title="${r.title}">${r.title || 'N/A'}</div>
              <div class="text-xs text-slate-500 font-mono">${r.handle || r.id || ''}</div>
            </div>
          </div>
        </td>
        <td class="px-4 py-3 text-right">${subsHtml}</td>
        <td class="px-4 py-3 text-right font-mono text-violet-400 font-bold">${ytFormatNumber(r.totalViews)}</td>
        <td class="px-4 py-3 text-right font-mono text-slate-300">${(r.videoCount || 0).toLocaleString('vi-VN')}</td>
        <td class="px-4 py-3 text-center text-xs text-slate-400">${r.country || '—'}</td>
        <td class="px-4 py-3 text-xs text-slate-400">${createdDate}</td>
        <td class="px-4 py-3 text-center">
          <a href="${r.url}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-xs text-brand-400 hover:text-brand-300 px-2 py-1 rounded-lg bg-brand-500/10 hover:bg-brand-500/20 border border-brand-500/20 transition">
            <i class="ph-bold ph-arrow-square-out"></i> Mở
          </a>
        </td>
        <td class="px-3 py-3 text-center">${videosBtnHtml}</td>
      </tr>${subTableHtml}`;
    }).join('');
  }

  document.getElementById('ytc-results-section')?.classList.remove('hidden');
  showToast(`Đã kiểm tra xong ${results.length} kênh!`, 'success');
}

function ytToggleVideos(idx, btn) {
  const sub = document.getElementById(`ytc-sub-${idx}`);
  if (!sub) return;
  const isOpen = !sub.classList.contains('hidden');
  sub.classList.toggle('hidden', isOpen);
  const icon = btn?.querySelector('i');
  if (icon) {
    icon.classList.toggle('ph-caret-down', isOpen);
    icon.classList.toggle('ph-caret-up', !isOpen);
  }
}

function exportYoutubeExcel(results) {
  if (!results || results.length === 0) {
    showToast('Không có dữ liệu để export!', 'error');
    return;
  }

  if (typeof XLSX === 'undefined') {
    showToast('Thư viện XLSX chưa sẵn sàng. Vui lòng thử lại!', 'error');
    return;
  }

  const rows = results.map((r, i) => ({
    '#': i + 1,
    'Tên Kênh': r.title || '',
    'Handle': r.handle || '',
    'Channel ID': r.id || '',
    'URL': r.url || '',
    'Subscribers': r.hiddenSubscribers ? 'Ẩn' : (r.subscribers || 0),
    'Tổng Views': r.totalViews || 0,
    'Số Video': r.videoCount || 0,
    'Quốc Gia': r.country || '',
    'Ngày Tạo': r.publishedAt ? new Date(r.publishedAt).toLocaleDateString('vi-VN') : '',
    'Mô Tả': (r.description || '').substring(0, 200),
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    { wch: 5 }, { wch: 35 }, { wch: 25 }, { wch: 28 }, { wch: 50 },
    { wch: 15 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 15 }, { wch: 60 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'YouTube Channels');

  // Sheet 2: all videos
  const videoRows = [];
  results.forEach(r => {
    const channelName = r.title || '';
    const channelUrl = r.url || '';
    (r.videos || []).forEach((v, vi) => {
      videoRows.push({
        'Kênh': channelName,
        'Link Kênh': channelUrl,
        '#': vi + 1,
        'Tiêu Đề Video': v.title || '',
        'Link Video': v.url || '',
        'Views': v.viewCount || 0,
        'Likes': v.likeCount || 0,
        'Comments': v.commentCount || 0,
        'Ngày Đăng': v.publishedAt ? new Date(v.publishedAt).toLocaleDateString('vi-VN') : '',
      });
    });
  });

  if (videoRows.length > 0) {
    const ws2 = XLSX.utils.json_to_sheet(videoRows);
    ws2['!cols'] = [
      { wch: 35 }, { wch: 45 }, { wch: 5 }, { wch: 80 }, { wch: 45 },
      { wch: 15 }, { wch: 12 }, { wch: 12 }, { wch: 14 },
    ];
    XLSX.utils.book_append_sheet(wb, ws2, 'Videos');
  }

  const today = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `youtube_channels_${today}.xlsx`);
  const videoCount = videoRows.length;
  showToast(`Đã export ${results.length} kênh${videoCount > 0 ? ` & ${videoCount} video` : ''} ra Excel!`, 'success');
}


// ============================================================
// PROXY CHECKER MODULE
// Kiểm tra proxy nào đã được sử dụng trong AdsPower profiles
// ============================================================

const ProxyCheckerModule = (() => {
  /** Kết quả lần check gần nhất để dùng cho copy/export */
  let _lastUnused = [];
  /** Toàn bộ used proxies để filter */
  let _lastUsed = [];

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Đọc proxy list từ textarea, trả về mảng string đã lọc */
  function readProxyList() {
    const raw = document.getElementById('proxy-checker-input')?.value || '';
    return raw
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);
  }

  /** Đọc format proxy đang chọn */
  function readFormat() {
    const checked = document.querySelector('input[name="proxy-format"]:checked');
    return checked ? checked.value : 'auto';
  }

  /** Gọi API /api/proxy/check */
  async function runCheck() {
    const proxies = readProxyList();
    if (proxies.length === 0) {
      alert('Vui lòng nhập ít nhất một proxy!');
      return;
    }

    const proxyFormat = readFormat();
    const btnCheck = document.getElementById('btn-proxy-check');
    const statusEl = document.getElementById('proxy-checker-status');
    const resultsEl = document.getElementById('proxy-checker-results');

    // Show loading state
    if (btnCheck) { btnCheck.disabled = true; btnCheck.innerHTML = '<i class="ph-bold ph-spinner-gap animate-spin"></i> Đang quét...'; }
    if (statusEl) statusEl.classList.remove('hidden');
    if (resultsEl) resultsEl.classList.add('hidden');

    try {
      const token = localStorage.getItem('auth_token') || '';
      const res = await fetch('/api/proxy/check', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ proxies, proxyFormat }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      renderResults(data);
    } catch (err) {
      alert(`Lỗi kiểm tra proxy: ${err.message}`);
    } finally {
      if (btnCheck) { btnCheck.disabled = false; btnCheck.innerHTML = '<i class="ph-bold ph-magnifying-glass"></i> <span>Kiểm Tra Proxy</span>'; }
      if (statusEl) statusEl.classList.add('hidden');
    }
  }

  /** Render kết quả vào DOM */
  function renderResults(data) {
    const { total, used, unused, totalProfilesScanned } = data;
    _lastUnused = unused || [];

    // Stats
    setText('pc-stat-total', total);
    setText('pc-stat-used', used.length);
    setText('pc-stat-unused', unused.length);
    setText('pc-stat-profiles', totalProfilesScanned);
    setText('pc-badge-used', used.length);
    setText('pc-badge-unused', unused.length);

    // Save for filtering
    _lastUsed = used;

    // Used proxies table
    renderUsedRows(used);

    // Reset search box
    const searchEl = document.getElementById('pc-used-search');
    if (searchEl) searchEl.value = '';

    // Unused proxies textarea
    const unusedTextarea = document.getElementById('pc-unused-textarea');
    if (unusedTextarea) {
      unusedTextarea.value = unused.join('\n');
    }

    // Show results
    const resultsEl = document.getElementById('proxy-checker-results');
    if (resultsEl) resultsEl.classList.remove('hidden');

    // Scroll to results
    resultsEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  /** Render hàng bảng used proxies từ mảng items */
  function renderUsedRows(items) {
    const tbody = document.getElementById('pc-used-tbody');
    const emptyEl = document.getElementById('pc-used-empty');
    if (!tbody) return;
    if (items.length === 0) {
      tbody.innerHTML = '';
      if (emptyEl) emptyEl.classList.remove('hidden');
    } else {
      if (emptyEl) emptyEl.classList.add('hidden');
      tbody.innerHTML = items.map(item => {
        const profileList = item.profiles.map(p =>
          `<span class="inline-flex items-center gap-1 mr-1 mb-1 px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 text-slate-300">
            <span class="font-mono text-slate-500">#${escHtml(p.serial_number || '?')}</span>
            ${escHtml(p.name || p.user_id)}
            ${p.group_name ? `<span class="text-slate-600 text-[10px]">(${escHtml(p.group_name)})</span>` : ''}
          </span>`
        ).join('');
        return `<tr class="hover:bg-slate-800/40 transition">
          <td class="px-4 py-3 font-mono text-rose-300 whitespace-nowrap">${escHtml(item.proxy)}</td>
          <td class="px-4 py-3">
            <div class="flex flex-wrap gap-0.5">${profileList}</div>
          </td>
        </tr>`;
      }).join('');
    }
  }

  /** Lọc bảng used proxies theo query từ ô tìm kiếm */
  function filterUsedTable() {
    const q = (document.getElementById('pc-used-search')?.value || '').toLowerCase().trim();
    if (!q) {
      renderUsedRows(_lastUsed);
      return;
    }
    const filtered = _lastUsed.filter(item => {
      if (item.proxy.toLowerCase().includes(q)) return true;
      return item.profiles.some(p =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.serial_number || '').toLowerCase().includes(q) ||
        (p.group_name || '').toLowerCase().includes(q) ||
        (p.user_id || '').toLowerCase().includes(q)
      );
    });
    renderUsedRows(filtered);
  }

  /** Copy proxy chưa dùng vào clipboard */
  async function copyUnused() {
    if (_lastUnused.length === 0) {
      alert('Không có proxy chưa dùng để copy!');
      return;
    }
    try {
      await navigator.clipboard.writeText(_lastUnused.join('\n'));
      const btn = document.getElementById('btn-proxy-copy-unused');
      if (btn) {
        const orig = btn.innerHTML;
        btn.innerHTML = '<i class="ph-bold ph-check"></i> Đã copy!';
        setTimeout(() => { btn.innerHTML = orig; }, 2000);
      }
    } catch {
      // Fallback
      const ta = document.getElementById('pc-unused-textarea');
      if (ta) { ta.select(); document.execCommand('copy'); }
    }
  }

  /** Export proxy chưa dùng thành file .txt */
  function exportUnused() {
    if (_lastUnused.length === 0) {
      alert('Không có proxy chưa dùng để export!');
      return;
    }
    const blob = new Blob([_lastUnused.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.download = `proxy-chua-dung-${ts}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Reset toàn bộ UI về trạng thái ban đầu */
  function resetUI() {
    const input = document.getElementById('proxy-checker-input');
    if (input) input.value = '';
    const results = document.getElementById('proxy-checker-results');
    if (results) results.classList.add('hidden');
    _lastUnused = [];
  }

  /** Khởi tạo event listeners */
  function init() {
    document.getElementById('btn-proxy-check')?.addEventListener('click', runCheck);
    document.getElementById('btn-proxy-reset')?.addEventListener('click', resetUI);
    document.getElementById('btn-proxy-copy-unused')?.addEventListener('click', copyUnused);
    document.getElementById('btn-proxy-export-unused')?.addEventListener('click', exportUnused);
    // Search filter — real-time
    document.getElementById('pc-used-search')?.addEventListener('input', filterUsedTable);
  }

  return { init, runCheck, resetUI };
})();

// Khởi tạo Proxy Checker khi DOM sẵn sàng
document.addEventListener('DOMContentLoaded', () => {
  ProxyCheckerModule.init();
});

// =========================================================================
// FACEBOOK PAGE INVENTORY ENGINE (FEAT-007 Step 1)
// =========================================================================
let currentPageInvJobId = null;
let pageInvPollTimer = null;
let currentPageInvResults = { verifiedPages: [], unresolvedItems: [], totalScanned: 0 };

function initPageInventory() {
  const btnStart = document.getElementById('btn-page-inv-start');
  const btnStop = document.getElementById('btn-page-inv-stop');
  const btnExportCsv = document.getElementById('btn-page-inv-export-csv');
  const btnExportJson = document.getElementById('btn-page-inv-export-json');
  const searchInput = document.getElementById('page-inv-search');
  const filterSelect = document.getElementById('page-inv-filter-status');
  const showUnresolvedChk = document.getElementById('page-inv-show-unresolved');

  if (btnStart) {
    btnStart.addEventListener('click', startPageInventoryScan);
  }

  if (btnStop) {
    btnStop.addEventListener('click', stopPageInventoryScan);
  }

  if (btnExportCsv) {
    btnExportCsv.addEventListener('click', exportPageInventoryCSV);
  }

  if (btnExportJson) {
    btnExportJson.addEventListener('click', exportPageInventoryJSON);
  }

  if (searchInput) {
    searchInput.addEventListener('input', renderPageInventoryResults);
  }

  if (filterSelect) {
    filterSelect.addEventListener('change', renderPageInventoryResults);
  }

  if (showUnresolvedChk) {
    showUnresolvedChk.addEventListener('change', renderPageInventoryResults);
  }

  if (allProfiles && allProfiles.length > 0) {
    populatePageInventoryProfileSelector(allProfiles);
  }
}

function populatePageInventoryProfileSelector(profiles) {
  const select = document.getElementById('page-inv-profile-select');
  if (!select) return;
  const currentValue = select.value;

  select.innerHTML = '<option value="">-- Chọn profile để quét Page --</option>';
  profiles.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.user_id;
    opt.textContent = `#${p.serial_number || 'N/A'} - ${p.name || 'Unnamed'} (${p.user_id})`;
    if (p.user_id === currentValue) opt.selected = true;
    select.appendChild(opt);
  });
}

async function startPageInventoryScan() {
  const selectProfile = document.getElementById('page-inv-profile-select');
  const inputProfile = document.getElementById('page-inv-profile-input');
  const typed = (inputProfile?.value || '').trim();
  const profileId = typed || selectProfile?.value;
  const maxExpansions = document.getElementById('page-inv-max-expansions')?.value || '100';
  const timeoutMs = document.getElementById('page-inv-timeout-ms')?.value || '30000';
  const keepBrowserOpen = document.getElementById('page-inv-keep-open')?.checked !== false;
  const showUnresolved = document.getElementById('page-inv-show-unresolved')?.checked !== false;
  const errorAlert = document.getElementById('page-inv-error-alert');
  const errorText = document.getElementById('page-inv-error-text');

  if (errorAlert) errorAlert.classList.add('hidden');

  if (!profileId) {
    if (errorAlert && errorText) {
      errorText.textContent = 'Vui lòng chọn hoặc nhập một AdsPower profile để bắt đầu quét Page.';
      errorAlert.classList.remove('hidden');
    }
    showToast('Vui lòng chọn một AdsPower profile để bắt đầu!', 'warn');
    return;
  }

  setPageInventoryControlsState({ running: true });

  const progressPanel = document.getElementById('page-inv-job-progress');
  if (progressPanel) progressPanel.classList.remove('hidden');

  updatePageInventoryProgress({ percent: 5, stage: 'init', detail: 'Đang gửi yêu cầu khởi chạy tiến trình quét...' });

  try {
    const res = await fetch('/api/page-inventory/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileId,
        maxExpansions: Number(maxExpansions),
        timeoutMs: Number(timeoutMs),
        keepBrowserOpen,
        showUnresolved,
      }),
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      const errMsg = data.error || `HTTP ${res.status}: Khởi tạo thất bại`;
      if (errorAlert && errorText) {
        errorText.textContent = errMsg;
        errorAlert.classList.remove('hidden');
      }
      showToast(`❌ ${errMsg}`, 'error');
      setPageInventoryControlsState({ running: false });
      if (progressPanel) progressPanel.classList.add('hidden');
      return;
    }

    currentPageInvJobId = data.jobId;
    showToast(`🚀 Đã bắt đầu tiến trình quét Page (Job: ${currentPageInvJobId})`, 'info');

    if (pageInvPollTimer) clearInterval(pageInvPollTimer);
    pageInvPollTimer = setInterval(() => pollPageInventoryJob(currentPageInvJobId), 1000);

  } catch (err) {
    if (errorAlert && errorText) {
      errorText.textContent = `Lỗi kết nối server: ${err.message}`;
      errorAlert.classList.remove('hidden');
    }
    showToast(`❌ Không thể kết nối server: ${err.message}`, 'error');
    setPageInventoryControlsState({ running: false });
    if (progressPanel) progressPanel.classList.add('hidden');
  }
}

async function pollPageInventoryJob(jobId) {
  if (!jobId) return;

  try {
    const res = await fetch(`/api/page-inventory/jobs/${jobId}`);
    if (!res.ok) return;
    const data = await res.json();

    if (!data.success || !data.job) return;
    const job = data.job;

    if (job.progress) {
      updatePageInventoryProgress(job.progress);
    }

    const statusBadge = document.getElementById('page-inv-job-status-badge');
    if (statusBadge) {
      statusBadge.textContent = job.status.toUpperCase();
      statusBadge.className = `mt-1 text-sm font-bold ${
        job.status === 'running' ? 'text-blue-400 animate-pulse' :
        job.status === 'completed' ? 'text-emerald-400' :
        job.status === 'cancelled' ? 'text-amber-400' : 'text-rose-400'
      }`;
    }

    if (job.status === 'completed') {
      if (pageInvPollTimer) clearInterval(pageInvPollTimer);
      pageInvPollTimer = null;
      setPageInventoryControlsState({ running: false });

      if (job.result) {
        currentPageInvResults = job.result;
        renderPageInventoryResults();
      }

      showToast(`🎉 Quét hoàn tất! Tìm thấy ${job.result?.verifiedPages?.length || 0} Page xác thực.`, 'success');
      const progressPanel = document.getElementById('page-inv-job-progress');
      if (progressPanel) progressPanel.classList.add('hidden');

    } else if (job.status === 'failed') {
      if (pageInvPollTimer) clearInterval(pageInvPollTimer);
      pageInvPollTimer = null;
      setPageInventoryControlsState({ running: false });

      const errorAlert = document.getElementById('page-inv-error-alert');
      const errorText = document.getElementById('page-inv-error-text');
      if (errorAlert && errorText) {
        errorText.textContent = job.error || 'Tiến trình quét bị thất bại.';
        errorAlert.classList.remove('hidden');
      }
      showToast(`❌ Tiến trình quét thất bại: ${job.error}`, 'error');
      const progressPanel = document.getElementById('page-inv-job-progress');
      if (progressPanel) progressPanel.classList.add('hidden');

    } else if (job.status === 'cancelled') {
      if (pageInvPollTimer) clearInterval(pageInvPollTimer);
      pageInvPollTimer = null;
      setPageInventoryControlsState({ running: false });

      showToast(`ℹ️ Tiến trình quét đã bị hủy.`, 'info');
      const progressPanel = document.getElementById('page-inv-job-progress');
      if (progressPanel) progressPanel.classList.add('hidden');
    }
  } catch (err) {
    console.error('Poll job error:', err);
  }
}

async function stopPageInventoryScan() {
  if (!currentPageInvJobId) return;

  try {
    const res = await fetch(`/api/page-inventory/jobs/${currentPageInvJobId}/cancel`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('⏹️ Đã gửi lệnh hủy tiến trình quét Page thành công.', 'info');
    }
  } catch (err) {
    showToast(`Lỗi khi dừng job: ${err.message}`, 'error');
  }
}

function setPageInventoryControlsState({ running }) {
  const btnStart = document.getElementById('btn-page-inv-start');
  const btnStop = document.getElementById('btn-page-inv-stop');
  const selectProfile = document.getElementById('page-inv-profile-select');
  const maxExpansions = document.getElementById('page-inv-max-expansions');
  const timeoutMs = document.getElementById('page-inv-timeout-ms');
  const keepOpen = document.getElementById('page-inv-keep-open');

  if (btnStart) btnStart.disabled = running;
  if (btnStop) btnStop.disabled = !running;
  if (selectProfile) selectProfile.disabled = running;
  if (maxExpansions) maxExpansions.disabled = running;
  if (timeoutMs) timeoutMs.disabled = running;
  if (keepOpen) keepOpen.disabled = running;
}

function updatePageInventoryProgress(prog) {
  const bar = document.getElementById('page-inv-progress-bar');
  const percentLabel = document.getElementById('page-inv-percent-label');
  const phaseBadge = document.getElementById('page-inv-phase-badge');
  const stageLabel = document.getElementById('page-inv-stage-label');
  const detailLabel = document.getElementById('page-inv-detail-label');
  const checkpointLabel = document.getElementById('page-inv-checkpoint-label');
  const expansionsLabel = document.getElementById('page-inv-expansions-label');

  const statVerified = document.getElementById('page-inv-stat-verified');
  const statUnresolved = document.getElementById('page-inv-stat-unresolved');
  const statTotal = document.getElementById('page-inv-stat-total');

  if (bar) bar.style.width = `${prog.percent || 0}%`;
  if (percentLabel) percentLabel.textContent = `${prog.percent || 0}%`;
  if (phaseBadge) phaseBadge.textContent = prog.phase || 'OPEN_SWITCHER';
  if (stageLabel) stageLabel.textContent = prog.stage || getStageTitle(prog.stage);
  if (detailLabel) detailLabel.textContent = prog.detail || '';

  if (checkpointLabel) {
    checkpointLabel.textContent = prog.checkpoint ? `Checkpoint: ${prog.checkpoint.name}` : 'Checkpoint: Chưa có';
  }

  const clicks = prog.seeMoreClicks !== undefined ? prog.seeMoreClicks : (prog.expansionsCount || 0);
  if (expansionsLabel) expansionsLabel.textContent = `Bấm "Xem thêm": ${clicks}`;

  if (statVerified && prog.verifiedCount !== undefined) statVerified.textContent = String(prog.verifiedCount);
  if (statTotal && prog.discoveredCount !== undefined) statTotal.textContent = String(prog.discoveredCount);
}

function getStageTitle(stage) {
  if (!stage) return 'Đang xử lý...';
  if (stage.includes('—')) return stage;
  switch (stage) {
    case 'init': return 'OPEN_SWITCHER — Đang khởi tạo...';
    case 'browser_connect': return 'OPEN_SWITCHER — Mở trình duyệt AdsPower...';
    case 'cdp_attach': return 'OPEN_SWITCHER — Kết nối Playwright CDP...';
    case 'check_login': return 'OPEN_SWITCHER — Kiểm tra phiên Facebook...';
    case 'open_profile_switcher': return 'OPEN_SWITCHER — Mở menu tài khoản...';
    case 'expanding_profiles': return 'EXPAND — Đang tải thêm danh sách...';
    case 'extracting_dom': return 'CAPTURE — Phân tích dữ liệu & URL...';
    case 'completed': return 'COMPLETE — Hoàn tất quét Page!';
    case 'cancelled': return 'FAILED — Đã hủy!';
    default: return stage;
  }
}

function renderPageInventoryResults() {
  const tbody = document.getElementById('page-inv-tbody');
  const statVerified = document.getElementById('page-inv-stat-verified');
  const statUnresolved = document.getElementById('page-inv-stat-unresolved');
  const statTotal = document.getElementById('page-inv-stat-total');

  const search = (document.getElementById('page-inv-search')?.value || '').toLowerCase().trim();
  const filterStatus = document.getElementById('page-inv-filter-status')?.value || 'all';
  const showUnresolved = document.getElementById('page-inv-show-unresolved')?.checked !== false;

  const verified = currentPageInvResults.verifiedPages || [];
  const unresolved = currentPageInvResults.unresolvedItems || [];

  if (statVerified) statVerified.textContent = verified.length;
  if (statUnresolved) statUnresolved.textContent = unresolved.length;
  if (statTotal) statTotal.textContent = verified.length + unresolved.length;

  let displayItems = [];

  if (filterStatus === 'all' || filterStatus === 'verified') {
    displayItems.push(...verified);
  }

  if ((filterStatus === 'all' || filterStatus === 'unresolved') && showUnresolved) {
    displayItems.push(...unresolved);
  }

  if (search) {
    displayItems = displayItems.filter(item => {
      return (
        item.pageName.toLowerCase().includes(search) ||
        (item.pageUrl && item.pageUrl.toLowerCase().includes(search)) ||
        (item.pageId && item.pageId.toLowerCase().includes(search)) ||
        item.evidenceSource.toLowerCase().includes(search)
      );
    });
  }

  if (displayItems.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="px-5 py-10 text-center text-slate-500 font-sans">
          <div class="flex flex-col items-center justify-center space-y-2">
            <i class="ph-duotone ph-magnifying-glass text-3xl text-slate-600"></i>
            <p>Không tìm thấy kết quả Page nào phù hợp với bộ lọc hiện tại.</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = displayItems.map((item, idx) => {
    const isVerified = item.verified && item.pageUrl;
    const evidenceBadgeClass =
      item.evidenceSource === 'graphql' ? 'bg-purple-500/10 text-purple-300 border-purple-500/30' :
      item.evidenceSource === 'dom' ? 'bg-blue-500/10 text-blue-300 border-blue-500/30' :
      'bg-amber-500/10 text-amber-300 border-amber-500/30';

    const evidenceLabel =
      item.evidenceSource === 'graphql' ? 'GraphQL' :
      item.evidenceSource === 'dom' ? 'DOM Link' : 'DOM (Chưa rõ URL)';

    return `
      <tr class="hover:bg-surface-850/60 transition ${!isVerified ? 'bg-amber-950/10' : ''}">
        <td class="px-4 py-3 text-center font-mono text-slate-500">${idx + 1}</td>
        <td class="px-4 py-3 font-semibold text-white">${escapeHtml(item.pageName)}</td>
        <td class="px-4 py-3">
          ${
            isVerified
              ? `<div class="flex items-center space-x-1.5 font-mono text-xs text-blue-400">
                   <a href="${escapeHtml(item.pageUrl)}" target="_blank" class="hover:underline truncate max-w-md">${escapeHtml(item.pageUrl)}</a>
                   <button onclick="copyToClipboard('${escapeHtml(item.pageUrl)}', this)" class="hover:text-white p-0.5 text-slate-400" title="Copy URL">
                     <i class="ph ph-copy"></i>
                   </button>
                 </div>`
              : `<span class="text-amber-400/90 font-mono italic text-[11px]">Chưa xác thực URL (No URL Evidence)</span>`
          }
        </td>
        <td class="px-4 py-3 font-mono text-slate-300">
          ${item.pageId ? escapeHtml(item.pageId) : '<span class="text-slate-600">N/A</span>'}
        </td>
        <td class="px-4 py-3">
          <span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-mono border ${evidenceBadgeClass}">
            ${evidenceLabel}
          </span>
        </td>
        <td class="px-4 py-3 text-center">
          ${
            isVerified
              ? `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                   Verified
                 </span>`
              : `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                   Unresolved
                 </span>`
          }
        </td>
      </tr>
    `;
  }).join('');
}

function exportPageInventoryCSV() {
  const verified = currentPageInvResults.verifiedPages || [];
  const unresolved = currentPageInvResults.unresolvedItems || [];

  if (verified.length === 0 && unresolved.length === 0) {
    showToast('Chưa có dữ liệu để xuất file CSV!', 'warn');
    return;
  }

  let csvContent = 'data:text/csv;charset=utf-8,';

  csvContent += '=== VERIFIED FACEBOOK PAGES ===\n';
  csvContent += 'STT,Page Name,Exact Page URL,Page ID,Evidence Source,Status\n';
  verified.forEach((item, i) => {
    const name = `"${(item.pageName || '').replace(/"/g, '""')}"`;
    const url = `"${(item.pageUrl || '').replace(/"/g, '""')}"`;
    const id = `"${(item.pageId || '').replace(/"/g, '""')}"`;
    csvContent += `${i + 1},${name},${url},${id},${item.evidenceSource},Verified\n`;
  });

  csvContent += '\n=== UNRESOLVED ITEMS (MISSING EXACT URL EVIDENCE) ===\n';
  csvContent += 'STT,Page Name,Exact Page URL,Page ID,Evidence Source,Status\n';
  unresolved.forEach((item, i) => {
    const name = `"${(item.pageName || '').replace(/"/g, '""')}"`;
    csvContent += `${i + 1},${name},N/A,N/A,${item.evidenceSource},Unresolved\n`;
  });

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement('a');
  link.setAttribute('href', encodedUri);
  link.setAttribute('download', `facebook_pages_inventory_${Date.now()}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast('📄 Đã xuất file CSV (đã phân tách Verified & Unresolved) thành công.', 'success');
}

function exportPageInventoryJSON() {
  const data = {
    scannedAt: new Date().toISOString(),
    totalScanned: currentPageInvResults.totalScanned || 0,
    verifiedCount: currentPageInvResults.verifiedPages?.length || 0,
    unresolvedCount: currentPageInvResults.unresolvedItems?.length || 0,
    verifiedPages: currentPageInvResults.verifiedPages || [],
    unresolvedItems: currentPageInvResults.unresolvedItems || [],
  };

  const jsonStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(data, null, 2));
  const link = document.createElement('a');
  link.setAttribute('href', jsonStr);
  link.setAttribute('download', `facebook_pages_inventory_${Date.now()}.json`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast('📄 Đã xuất file JSON thành công.', 'success');
}
