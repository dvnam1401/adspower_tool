/**
 * Account Hub — Frontend App (Phase 2)
 *
 * Vanilla JS, no framework.
 * Communicates with /api/account-hub/* REST endpoints.
 * Listens to /api/account-hub/events (SSE) for live updates.
 */

// ============================================================
// Auth token
// ============================================================
const token = localStorage.getItem('authToken') || sessionStorage.getItem('authToken') || '';

async function apiFetch(path, opts = {}) {
  const res = await fetch(`/api/account-hub${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(opts.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
  return data.data;
}

// ============================================================
// Toast
// ============================================================
const toastContainer = document.getElementById('ah-toast-container');

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `ah-toast toast-${type}`;
  el.textContent = msg;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ============================================================
// State
// ============================================================
let state = {
  accounts: [],
  total: 0,
  page: 1,
  limit: 50,
  totalPages: 1,
  search: '',
  accountStatus: '',
  adspowerStatus: '',
  sortBy: 'created_at',
  sortDir: 'desc',
  dieOnly: false,
  selectedAccount: null,
  editMode: false,
  editDraft: {},
};

// ============================================================
// DOM refs
// ============================================================
const tbody         = document.getElementById('accounts-tbody');
const paginationBar = document.getElementById('pagination-bar');
const searchInput   = document.getElementById('search-input');
const filterAS      = document.getElementById('filter-account-status');
const filterADS     = document.getElementById('filter-adspower-status');
const totalCount    = document.getElementById('ah-total-count');
const modal         = document.getElementById('account-modal');
const addModal      = document.getElementById('add-modal');
const dryRunBadge   = document.getElementById('ah-dry-run-badge');

// ============================================================
// Load accounts
// ============================================================
async function loadAccounts() {
  tbody.innerHTML = `<tr class="ah-loading-row"><td colspan="9">⏳ Đang tải…</td></tr>`;

  const params = new URLSearchParams({
    page:  state.page,
    limit: state.limit,
    sortBy:  state.sortBy,
    sortDir: state.sortDir,
  });
  if (state.search)         params.set('search',         state.search);
  if (state.accountStatus)  params.set('accountStatus',  state.accountStatus);
  if (state.adspowerStatus) params.set('adspowerStatus', state.adspowerStatus);
  if (state.dieOnly) {
    params.set('accountStatus',  'DIE');
    // Filter client-side for die-not-deleted (adspower still active/missing)
  }

  try {
    const result = await apiFetch(`/accounts?${params}`);
    state.accounts   = result.items || [];
    state.total      = result.total || 0;
    state.totalPages = result.totalPages || 1;

    let items = state.accounts;
    if (state.dieOnly) {
      items = items.filter(a => a.accountStatus === 'DIE' &&
        !['DELETED'].includes(a.adspowerStatus));
    }

    renderTable(items);
    renderPagination();
    totalCount.textContent = `${state.total} tài khoản`;
  } catch (err) {
    tbody.innerHTML = `<tr class="ah-empty-row"><td colspan="9">❌ ${err.message}</td></tr>`;
  }
}

// ============================================================
// Render table
// ============================================================
function statusBadge(s) {
  const map = {
    LIVE: 'badge-live', DIE: 'badge-die',
    CHECKING: 'badge-check', LOCKED: 'badge-grey',
    NEED_LOGIN: 'badge-warn', ERROR: 'badge-die', CUSTOM: 'badge-grey',
  };
  return `<span class="badge ${map[s] || 'badge-grey'}">${s}</span>`;
}

function adsStatusBadge(s) {
  const warn = ['MISSING','SYNC_ERROR','DELETE_PENDING'].includes(s);
  const ok   = s === 'ACTIVE';
  const cls  = ok ? 'badge-live' : warn ? 'badge-warn' : 'badge-grey';
  return `<span class="badge ${cls}">${s}</span>`;
}

function rowClass(a) {
  if (a.accountStatus === 'DIE') {
    return a.adspowerStatus === 'DELETED' ? 'row-die-deleted' : 'row-die-active';
  }
  return '';
}

function copyBtn(value) {
  if (!value) return '';
  return `<button class="copy-btn" onclick="copyText(event,'${escHtml(value)}')" title="Copy">⎘</button>`;
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function renderTable(accounts) {
  if (!accounts.length) {
    tbody.innerHTML = `<tr class="ah-empty-row"><td colspan="9">Không có tài khoản nào.</td></tr>`;
    return;
  }
  tbody.innerHTML = accounts.map(a => {
    const rowCls = rowClass(a);
    const lastSync = a.lastSeenAdspowerAt
      ? new Date(a.lastSeenAdspowerAt).toLocaleString('vi-VN')
      : '—';
    return `
      <tr class="${rowCls}" data-id="${a.id}">
        <td><input type="checkbox" class="row-check" data-id="${a.id}" /></td>
        <td title="${escHtml(a.profileName)}">
          ${escHtml(a.profileName)}
          ${a.adspowerUserId ? `<span class="ah-text-muted" style="font-size:11px;margin-left:4px">#${escHtml(a.adspowerUserId)}</span>` : ''}
        </td>
        <td>${statusBadge(a.accountStatus)}</td>
        <td>${adsStatusBadge(a.adspowerStatus)}</td>
        <td>${escHtml(a.loginId)}${copyBtn(a.loginId)}</td>
        <td>${escHtml(a.hotmail)}${copyBtn(a.hotmail)}</td>
        <td>${a.youtubeChannelUrl ? `<a href="${escHtml(a.youtubeChannelUrl)}" target="_blank" rel="noopener" class="ah-link">▶ Link</a>` : '—'}</td>
        <td>${lastSync}</td>
        <td>
          <button class="btn btn-sm" onclick="openAccount('${a.id}')">🔍 Chi tiết</button>
        </td>
      </tr>`;
  }).join('');
}

// ============================================================
// Pagination
// ============================================================
function renderPagination() {
  if (state.totalPages <= 1) { paginationBar.innerHTML = ''; return; }
  const pages = [];
  const cur = state.page, tot = state.totalPages;
  pages.push(`<button class="ah-page-btn${cur===1?' active':''}" onclick="goPage(1)">1</button>`);
  if (cur > 3) pages.push('<span>…</span>');
  for (let p = Math.max(2, cur-1); p <= Math.min(tot-1, cur+1); p++) {
    pages.push(`<button class="ah-page-btn${p===cur?' active':''}" onclick="goPage(${p})">${p}</button>`);
  }
  if (cur < tot - 2) pages.push('<span>…</span>');
  if (tot > 1) pages.push(`<button class="ah-page-btn${cur===tot?' active':''}" onclick="goPage(${tot})">${tot}</button>`);
  paginationBar.innerHTML =
    `<button class="ah-page-btn" onclick="goPage(${cur-1})" ${cur===1?'disabled':''}>‹</button>` +
    pages.join('') +
    `<button class="ah-page-btn" onclick="goPage(${cur+1})" ${cur===tot?'disabled':''}>›</button>`;
}

window.goPage = (p) => {
  if (p < 1 || p > state.totalPages) return;
  state.page = p;
  loadAccounts();
};

// ============================================================
// Copy utility
// ============================================================
window.copyText = async (e, text) => {
  e.stopPropagation();
  try {
    await navigator.clipboard.writeText(text);
    toast('Đã copy!', 'success');
  } catch { toast('Copy thất bại', 'error'); }
};

// ============================================================
// Account detail modal
// ============================================================
window.openAccount = async (id) => {
  try {
    const a = await apiFetch(`/accounts/${id}`);
    state.selectedAccount = a;
    state.editMode = false;
    state.editDraft = {};
    renderModal(a);
    loadHistory(id);
    modal.classList.remove('hidden');
  } catch (err) {
    toast(`Không thể tải tài khoản: ${err.message}`, 'error');
  }
};

function renderModal(a) {
  document.getElementById('modal-title').textContent = a.profileName;

  // Status row
  document.getElementById('modal-status-row').innerHTML =
    statusBadge(a.accountStatus) +
    adsStatusBadge(a.adspowerStatus) +
    (a.dieMarkedAt ? `<span class="badge badge-die">DIE từ ${new Date(a.dieMarkedAt).toLocaleDateString('vi-VN')}</span>` : '') +
    (accountHubConfig?.dryRun ? '<span class="badge badge-warn">🧪 Dry-run</span>' : '');

  // Fields
  const fields = [
    { label: 'Profile Name',       key: 'profileName',      editable: true },
    { label: 'AdsPower ID',        key: 'adspowerUserId',   editable: false },
    { label: 'Login ID / Email',   key: 'loginId',          editable: true },
    { label: 'Hotmail',            key: 'hotmail',          editable: true },
    { label: 'Recovery Mail',      key: 'recoveryMail',     editable: true },
    { label: 'YouTube Channel',    key: 'youtubeChannelUrl',editable: true },
    { label: 'Linked Content',     key: 'linkedContent',    editable: true },
    { label: 'Assigned To',        key: 'assignedTo',       editable: true },
    { label: 'Password',           key: 'hasPassword',      secret: true },
    { label: '2FA Secret',         key: 'hasTwoFactor',     secret: true },
    { label: 'Cookie',             key: 'hasCookie',        secret: true },
    { label: 'Token',              key: 'hasToken',         secret: true },
    { label: 'Tạo lúc',           key: 'createdAt',        editable: false },
    { label: 'Cập nhật',          key: 'updatedAt',        editable: false },
  ];

  const grid = document.getElementById('modal-fields');
  grid.innerHTML = fields.map(f => {
    let val = a[f.key];
    let display;
    if (f.secret) {
      display = val
        ? `<span class="badge badge-live">✓ Có</span>${
            f.editable !== false ? `<button class="btn btn-sm" onclick="viewSecret('${f.key}')">👁 Xem</button>` : ''
          }`
        : '<span class="badge badge-grey">Chưa có</span>';
    } else if (f.key === 'createdAt' || f.key === 'updatedAt') {
      display = val ? new Date(val).toLocaleString('vi-VN') : '—';
    } else {
      display = val ? `<span title="${escHtml(val)}">${escHtml(val)}</span>${copyBtn(val)}` : '—';
    }

    return `<div class="ah-field-item">
      <div class="ah-field-label">${f.label}</div>
      <div class="ah-field-value" id="field-${f.key}">${display}</div>
    </div>`;
  }).join('');

  // Footer bars
  document.getElementById('modal-edit-bar').classList.add('hidden');
  document.getElementById('modal-view-bar').classList.remove('hidden');
}

async function loadHistory(accountId) {
  try {
    const logs = await apiFetch(`/accounts/${accountId}/history`);
    const listEl = document.getElementById('modal-history-list');
    if (!logs.length) {
      listEl.innerHTML = '<div class="ah-history-item">Chưa có lịch sử.</div>';
      return;
    }
    listEl.innerHTML = logs.slice(0, 20).map(log => `
      <div class="ah-history-item">
        <strong>${log.action.toUpperCase()}</strong>
        ${log.actor ? `bởi <strong>${escHtml(log.actor)}</strong>` : ''}
        — ${new Date(log.createdAt).toLocaleString('vi-VN')}
      </div>`).join('');
  } catch {
    // History is optional — fail silently
  }
}

// ---- Edit mode ----
document.getElementById('btn-edit-account').addEventListener('click', () => {
  state.editMode = true;
  state.editDraft = { ...state.selectedAccount };
  enterEditMode();
});

function enterEditMode() {
  const a = state.selectedAccount;
  const editableKeys = ['profileName','loginId','hotmail','recoveryMail','youtubeChannelUrl','linkedContent','assignedTo'];
  editableKeys.forEach(key => {
    const cell = document.getElementById(`field-${key}`);
    if (cell) {
      cell.innerHTML = `<input class="ah-input" id="edit-${key}" value="${escHtml(a[key] || '')}" />`;
    }
  });
  document.getElementById('modal-edit-bar').classList.remove('hidden');
  document.getElementById('modal-view-bar').classList.add('hidden');
}

document.getElementById('btn-cancel-edit').addEventListener('click', () => {
  state.editMode = false;
  renderModal(state.selectedAccount);
  loadHistory(state.selectedAccount.id);
});

// Save draft — DB only
document.getElementById('btn-save-draft').addEventListener('click', async () => {
  await saveDraft(false);
});

// Save & Sync — DB + sync job (Phase 4 will flesh out sync job creation)
document.getElementById('btn-save-sync').addEventListener('click', async () => {
  await saveDraft(true);
});

async function saveDraft(andSync) {
  const a = state.selectedAccount;
  const editableKeys = ['profileName','loginId','hotmail','recoveryMail','youtubeChannelUrl','linkedContent','assignedTo'];
  const dto = { version: a.version };
  editableKeys.forEach(key => {
    const inp = document.getElementById(`edit-${key}`);
    if (inp) dto[key] = inp.value.trim() || null;
  });

  try {
    const updated = await apiFetch(`/accounts/${a.id}`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    });
    state.selectedAccount = updated;
    state.editMode = false;
    renderModal(updated);
    loadHistory(updated.id);
    toast(andSync ? 'Đã lưu. Tạo sync job…' : 'Đã lưu draft!', 'success');
    loadAccounts(); // Refresh table
    if (andSync) {
      toast('Sync job sẽ được tạo ở Phase 4.', 'warn');
    }
  } catch (err) {
    toast(`Lỗi: ${err.message}`, 'error');
  }
}

// Mark DIE
document.getElementById('btn-mark-die').addEventListener('click', async () => {
  if (!state.selectedAccount) return;
  if (!confirm(`Đánh dấu "${state.selectedAccount.profileName}" là DIE?`)) return;
  try {
    const updated = await apiFetch(`/accounts/${state.selectedAccount.id}/mark-die`, {
      method: 'POST',
      body: JSON.stringify({ version: state.selectedAccount.version }),
    });
    state.selectedAccount = updated;
    renderModal(updated);
    loadHistory(updated.id);
    toast('Đã đánh dấu DIE.', 'warn');
    loadAccounts();
  } catch (err) {
    toast(`Lỗi: ${err.message}`, 'error');
  }
});

// Close modal
['modal-close','btn-close-modal'].forEach(id => {
  document.getElementById(id)?.addEventListener('click', () => {
    modal.classList.add('hidden');
    state.selectedAccount = null;
  });
});
modal.querySelector('.ah-modal-backdrop')?.addEventListener('click', () => modal.classList.add('hidden'));

// ============================================================
// Add account modal
// ============================================================
document.getElementById('btn-add-account').addEventListener('click', () => {
  document.getElementById('add-account-form').reset();
  addModal.classList.remove('hidden');
});

document.querySelectorAll('[data-modal="add-modal"]').forEach(el => {
  el.addEventListener('click', () => addModal.classList.add('hidden'));
});
addModal.querySelector('.ah-modal-backdrop')?.addEventListener('click', () => addModal.classList.add('hidden'));

document.getElementById('btn-add-submit').addEventListener('click', async () => {
  const form = document.getElementById('add-account-form');
  const data = Object.fromEntries(new FormData(form).entries());
  if (!data.profileName?.trim()) { toast('Tên Profile là bắt buộc', 'warn'); return; }
  try {
    await apiFetch('/accounts', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    addModal.classList.add('hidden');
    toast('Đã tạo tài khoản!', 'success');
    state.page = 1;
    loadAccounts();
  } catch (err) {
    toast(`Lỗi: ${err.message}`, 'error');
  }
});

// ============================================================
// Toolbar events
// ============================================================
let searchTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = searchInput.value.trim();
    state.page = 1;
    loadAccounts();
  }, 400);
});

filterAS.addEventListener('change', () => {
  state.accountStatus = filterAS.value;
  state.dieOnly = false;
  state.page = 1;
  loadAccounts();
});

filterADS.addEventListener('change', () => {
  state.adspowerStatus = filterADS.value;
  state.dieOnly = false;
  state.page = 1;
  loadAccounts();
});

document.getElementById('btn-filter-die-pending').addEventListener('click', () => {
  state.dieOnly = !state.dieOnly;
  state.accountStatus = '';
  state.adspowerStatus = '';
  filterAS.value = '';
  filterADS.value = '';
  state.page = 1;
  document.getElementById('btn-filter-die-pending').textContent =
    state.dieOnly ? '✕ Xoá lọc DIE' : '⚡ DIE chưa xóa';
  loadAccounts();
});

document.getElementById('btn-reload').addEventListener('click', () => loadAccounts());

// ============================================================
// SSE — Live events from server
// ============================================================
let accountHubConfig = null;

async function checkHealth() {
  try {
    const h = await apiFetch('/health');
    accountHubConfig = h;
    if (!h.dryRun) dryRunBadge.classList.add('hidden');
  } catch {
    // subsystem might be off
  }
}

function initSSE() {
  const sse = new EventSource(`/api/account-hub/events?token=${encodeURIComponent(token)}`);
  sse.addEventListener('account_updated', (e) => {
    const data = JSON.parse(e.data);
    // If the updated account is currently open in the modal, refresh it
    if (state.selectedAccount?.id === data.id) {
      openAccount(data.id);
    }
    // Always refresh table
    loadAccounts();
  });
  sse.addEventListener('sync_job_done', () => loadAccounts());
  sse.onerror = () => {
    // SSE not available yet (Phase 2 stub) — silent fail
    sse.close();
  };
}

// ============================================================
// Bootstrap
// ============================================================
(async () => {
  await checkHealth();
  await loadAccounts();
  initSSE();
})();
