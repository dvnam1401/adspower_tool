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
  
  const isAuthenticated = await checkAuthStatus();
  if (isAuthenticated) {
    fetchStatus();
    fetchGroups().then(() => fetchProfiles(1));
    fetchSkills();
    fetchHealingEvents();
    fetchWorkflowStatus();
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
    'tab-logs': {
      title: 'Live Logs & Telemetry Console',
      desc: 'Theo dõi luồng log, sự kiện mạng và quyết định của Agent theo thời gian thực'
    },
    'tab-settings': {
      title: 'Cấu Hình Hệ Thống & AI (Settings)',
      desc: 'Tùy chỉnh AdsPower API, giới hạn luồng tự động hóa và kết nối 9router / Gemini AI'
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
        headerDesc.textContent = pageMeta[targetTab].desc;
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
  };

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
            <p class="text-sm font-sans">Đang đồng bộ toàn bộ 100% profiles từ AdsPower...</p>
          </div>
        </td>
      </tr>
    `;
  }

  try {
    // Luôn luôn gọi fetchAll=true để lấy toàn bộ 100% profiles trên tất cả các nhóm
    const res = await fetch(`/api/profiles?fetchAll=true`);
    const data = await res.json();

    allProfiles = data.list || [];
    
    // Update stats
    const totalCount = allProfiles.length;
    document.getElementById('stat-total-profiles').textContent = totalCount;
    document.getElementById('badge-nav-profiles').textContent = totalCount;

    populateCDPProfileSelector(allProfiles);
    
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

  return allProfiles.filter(p => {
    const matchSearch =
      !search ||
      p.user_id?.toLowerCase().includes(search) ||
      p.serial_number?.toLowerCase().includes(search) ||
      p.name?.toLowerCase().includes(search) ||
      p.ip?.toLowerCase().includes(search) ||
      p.group_name?.toLowerCase().includes(search) ||
      (p.username && p.username.toLowerCase().includes(search));

    const matchGroup = !selectedGroupId || p.group_id === selectedGroupId;

    const isActive = activeProfileIds.has(p.user_id);
    const matchStatus =
      selectedStatus === 'all' ||
      (selectedStatus === 'active' && isActive) ||
      (selectedStatus === 'inactive' && !isActive);

    return matchSearch && matchGroup && matchStatus;
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
    if (pageItems.length > 0) {
      selectAll.checked = pageItems.every(p => selectedProfileIds.has(p.user_id));
    } else {
      selectAll.checked = false;
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
    const isActive = activeProfileIds.has(p.user_id);
    const isSelected = selectedProfileIds.has(p.user_id);
    const proxyInfo = p.ip ? `${p.ip} (${(p.ip_country || 'N/A').toUpperCase()})` : 'Mặc định';

    return `
      <tr class="hover:bg-surface-850/60 transition group ${isSelected ? 'bg-brand-950/30' : ''}">
        <td class="px-4 py-3.5 text-center">
          <input type="checkbox" data-profile-id="${p.user_id}" ${isSelected ? 'checked' : ''} onchange="toggleSelectProfile('${p.user_id}', this.checked)" class="profile-chk rounded bg-slate-800 border-slate-700 text-brand-500 focus:ring-0 cursor-pointer">
        </td>
        <td class="px-4 py-3.5">
          <span class="inline-flex items-center px-2 py-0.5 rounded-lg text-xs font-mono font-bold bg-slate-800 text-brand-300 border border-slate-700">
            #${p.serial_number || 'N/A'}
          </span>
        </td>
        <td class="px-4 py-3.5">
          <div class="flex flex-col">
            <span class="font-medium text-white group-hover:text-brand-300 transition">${escapeHtml(p.name || 'Unnamed')}</span>
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
            <button onclick="triggerFBLogin('${p.user_id}', '${escapeHtml(p.name || '')}')" class="px-2.5 py-1.5 rounded-lg bg-indigo-600/30 hover:bg-indigo-600/60 text-indigo-300 border border-indigo-500/40 text-xs font-semibold transition inline-flex items-center gap-1" title="Tự động đăng nhập Facebook + 2FA">
              <i class="ph-bold ph-lightning"></i> Auto Login
            </button>
            ${
              isActive
                ? `<button id="btn-toggle-${p.user_id}" onclick="stopBrowser('${p.user_id}')" class="px-2.5 py-1.5 rounded-lg bg-rose-600/20 hover:bg-rose-600/40 text-rose-300 border border-rose-500/30 text-xs font-semibold transition inline-flex items-center gap-1">
                     <i class="ph-bold ph-stop"></i> Đóng
                   </button>`
                : `<button id="btn-toggle-${p.user_id}" onclick="startBrowser('${p.user_id}')" class="px-2.5 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-xs font-semibold shadow-md shadow-brand-500/20 transition inline-flex items-center gap-1">
                     <i class="ph-bold ph-play"></i> Mở
                   </button>`
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

  document.getElementById('select-status')?.addEventListener('change', () => {
    currentPage = 1;
    renderProfiles();
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
    showToast('Đang làm mới toàn bộ dữ liệu từ AdsPower...', 'info');
    fetchProfiles(1);
  });

  document.getElementById('btn-refresh').addEventListener('click', () => {
    fetchStatus();
    fetchGroups();
    fetchProfiles(1);
    fetchSkills();
  });

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
    const pageItems = getCurrentPageProfiles();
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
      showToast('✅ Batch workflow hoàn thành!', 'success');
      updateWorkflowEngineBadge('idle');
      setWorkflowControlState('idle');
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
    allProfiles.forEach(p => workflowSelectedProfiles.add(p.user_id));
    const searchVal = document.getElementById('wf-profile-search')?.value?.trim()?.toLowerCase() || '';
    renderWorkflowProfileList(searchVal);
  });
  document.getElementById('btn-wf-deselect-all')?.addEventListener('click', () => {
    workflowSelectedProfiles.clear();
    const searchVal = document.getElementById('wf-profile-search')?.value?.trim()?.toLowerCase() || '';
    renderWorkflowProfileList(searchVal);
  });

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

    showToast(`🚀 Đang chuẩn bị và khởi chạy ${profileIdentifiers.length} profiles...`, 'info');
    try {
      const res = await fetch('/api/workflow/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileIdentifiers, workflowName, concurrency }),
      });
      const data = await res.json();
      if (data.success) {
        setWorkflowControlState('running');
        renderWorkflowTasks(data.tasks || []);

        if (data.notFoundCount > 0) {
          showToast(`⚠️ Đã chạy ${data.resolvedCount} profile hợp lệ. Lưu ý có ${data.notFoundCount} profile không tìm thấy trên AdsPower!`, 'warn');
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
      renderWorkflowProfileList();
      fetchWorkflowStatus();
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
    return;
  }

  const matched = [];
  const notFound = [];

  lines.forEach(line => {
    const cleanLower = line.toLowerCase();
    const serial = line.replace(/^#/, '');

    const found = allProfiles.find(
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
}

async function fetchWorkflowStatus() {
  try {
    const res = await fetch('/api/workflow/status');
    if (!res.ok) return;
    const data = await res.json();
    updateWorkflowEngineBadge(data.engineState);
    renderWorkflowTasks(data.tasks || []);
    updateWorkflowCounts();

    const badge = document.getElementById('badge-nav-workflow');
    if (badge) badge.textContent = data.engineState || 'idle';
  } catch {}
}

function renderWorkflowProfileList(filterQuery = '') {
  const container = document.getElementById('wf-profile-list');
  if (!container) return;

  if (!allProfiles || allProfiles.length === 0) {
    container.innerHTML = `<div class="text-xs text-slate-500 text-center py-6">Chưa có profiles. Hãy tải danh sách ở tab Profiles trước.</div>`;
    return;
  }

  const filtered = filterQuery
    ? allProfiles.filter(
        p =>
          p.name?.toLowerCase().includes(filterQuery) ||
          p.user_id?.toLowerCase().includes(filterQuery) ||
          String(p.serial_number || '').includes(filterQuery)
      )
    : allProfiles;

  if (filtered.length === 0) {
    container.innerHTML = `<div class="text-xs text-slate-500 text-center py-6">Không tìm thấy profile khớp với "${escapeHtml(
      filterQuery
    )}"</div>`;
    return;
  }

  container.innerHTML = filtered
    .map(p => {
      const isSelected = workflowSelectedProfiles.has(p.user_id);
      const isActive = activeProfileIds.has(p.user_id);
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
  if (!el) return;
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

  return `
    <div class="w-2.5 h-2.5 rounded-full shrink-0 ${cfg.dot}"></div>
    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-2 mb-1 flex-wrap">
        <span class="text-xs font-bold text-slate-200 truncate">${escapeHtml(displayName)}</span>
        ${task.profileName && task.profileId !== task.profileName ? `<span class="text-[10px] text-slate-500 font-mono">(${escapeHtml(task.profileId)})</span>` : ''}
        <span class="text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-slate-800 ${cfg.color}">${cfg.label}</span>
        ${task.status === 'running' ? `<span class="text-[10px] text-slate-500 truncate">${escapeHtml(stepInfo)}</span>` : ''}
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

function setWorkflowControlState(state) {
  updateWorkflowEngineBadge(state);
  const btnRun = document.getElementById('btn-wf-run');
  const btnPause = document.getElementById('btn-wf-pause');
  const btnResume = document.getElementById('btn-wf-resume');
  const btnCancel = document.getElementById('btn-wf-cancel');

  if (state === 'running') {
    if (btnRun) btnRun.disabled = true;
    if (btnPause) btnPause.disabled = false;
    if (btnResume) btnResume.disabled = true;
    if (btnCancel) btnCancel.disabled = false;
  } else if (state === 'paused') {
    if (btnRun) btnRun.disabled = true;
    if (btnPause) btnPause.disabled = true;
    if (btnResume) btnResume.disabled = false;
    if (btnCancel) btnCancel.disabled = false;
  } else {
    // idle / cancelled
    if (btnRun) btnRun.disabled = false;
    if (btnPause) btnPause.disabled = true;
    if (btnResume) btnResume.disabled = true;
    if (btnCancel) btnCancel.disabled = true;
  }
}

