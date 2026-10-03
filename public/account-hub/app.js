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

function warnBadges(a) {
  const b = [];
  if (a.duplicateProfile) b.push('<span class="badge badge-die" title="Trùng tên profile">TRÙNG TÊN</span>');
  if (a.duplicateId)      b.push('<span class="badge badge-die" title="Trùng AdsPower ID">TRÙNG ID</span>');
  if (a.duplicateHotmail) b.push('<span class="badge badge-die" title="Trùng hotmail">TRÙNG MAIL</span>');
  const cm = a.channelMatchStatus;
  if (cm === 'MATCHED')   b.push('<span class="badge badge-live" title="Đã khớp kênh Reup">KÊNH ✓</span>');
  if (cm === 'PENDING')   b.push('<span class="badge badge-warn" title="Chưa tìm thấy kênh Reup">KÊNH ?</span>');
  if (cm === 'AMBIGUOUS') b.push('<span class="badge badge-warn" title="Nhiều kết quả kênh Reup">KÊNH ⚠</span>');
  return b.length ? b.join(' ') : '—';
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
    tbody.innerHTML = `<tr class="ah-empty-row"><td colspan="10">Không có tài khoản nào.</td></tr>`;
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
        <td>${warnBadges(a)}</td>
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
  sse.addEventListener('notification', (e) => {
    try {
      const n = JSON.parse(e.data);
      toast(`🔔 ${n.title || 'Cảnh báo mới'}`, 'warn');
    } catch { /* ignore */ }
    refreshNotifCount();
    if (!notifModal.classList.contains('hidden')) loadNotifications();
  });
  sse.addEventListener('notification_count', (e) => {
    try { setNotifCount(JSON.parse(e.data).open); } catch { /* ignore */ }
  });
  sse.onerror = () => {
    // SSE not available yet (Phase 2 stub) — silent fail
    sse.close();
  };
}

// ============================================================
// Notifications panel (spec §1, §4.1)
// ============================================================
const notifModal   = document.getElementById('notif-modal');
const notifCountEl = document.getElementById('ah-notif-count');
const notifListEl  = document.getElementById('notif-list');

function setNotifCount(n) {
  const open = Number(n) || 0;
  notifCountEl.textContent = String(open);
  notifCountEl.classList.toggle('hidden', open === 0);
}

async function refreshNotifCount() {
  try {
    const r = await apiFetch('/notifications/count');
    setNotifCount(r.open);
  } catch { /* subsystem off */ }
}

async function loadNotifications() {
  notifListEl.innerHTML = 'Đang tải…';
  try {
    const items = await apiFetch('/notifications?status=OPEN');
    if (!items.length) {
      notifListEl.innerHTML = '<div class="ah-notif-empty">Không có cảnh báo nào.</div>';
      return;
    }
    notifListEl.innerHTML = items.map((n) => `
      <div class="ah-notif-item" data-id="${n.id}">
        <div class="ah-notif-main">
          <div class="ah-notif-title">${escHtml(n.title)}</div>
          ${n.detail ? `<div class="ah-notif-detail">${escHtml(n.detail)}</div>` : ''}
          <div class="ah-notif-meta">${escHtml(n.type)} · ${new Date(n.createdAt).toLocaleString('vi-VN')}</div>
        </div>
        <div class="ah-notif-actions">
          <button class="btn btn-sm btn-primary" onclick="resolveNotif('${n.id}')">✓ Đã xử lý</button>
          <button class="btn btn-sm" onclick="dismissNotif('${n.id}')">Bỏ qua</button>
        </div>
      </div>`).join('');
  } catch (e) {
    notifListEl.innerHTML = `<div class="ah-notif-empty">${escHtml(e.message)}</div>`;
  }
}

window.resolveNotif = async (id) => {
  try {
    await apiFetch(`/notifications/${id}/resolve`, { method: 'POST' });
    toast('Đã đánh dấu xử lý', 'success');
    await loadNotifications();
    await refreshNotifCount();
  } catch (e) { toast(e.message, 'error'); }
};

window.dismissNotif = async (id) => {
  try {
    await apiFetch(`/notifications/${id}/dismiss`, { method: 'POST' });
    await loadNotifications();
    await refreshNotifCount();
  } catch (e) { toast(e.message, 'error'); }
};

document.getElementById('btn-notifications').addEventListener('click', () => {
  notifModal.classList.remove('hidden');
  loadNotifications();
});
document.querySelectorAll('[data-modal="notif-modal"]').forEach((el) =>
  el.addEventListener('click', () => notifModal.classList.add('hidden')));
notifModal.querySelector('.ah-modal-backdrop')?.addEventListener('click', () => notifModal.classList.add('hidden'));

document.getElementById('btn-dup-scan').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const r = await apiFetch('/duplicates/scan', { method: 'POST' });
    const flagged = r.flagged ?? r.total ?? 0;
    toast(`Quét trùng xong: ${flagged} tài khoản bị gắn cờ`, flagged ? 'warn' : 'success');
    await loadAccounts();
    await refreshNotifCount();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
});

// ============================================================
// Sheet mapping config (Phase 1 — self-service mapping)
// ============================================================
const SYSTEM_FIELDS = [
  'profileName', 'adspowerUserId', 'adspowerSerialNumber', 'loginId', 'password',
  'hotmail', 'hotmailPassword', 'recoveryMail', 'youtubeChannelUrl',
  'accountStatus', 'country', 'linkedContent', 'note',
];

const mapModal = document.getElementById('mapping-modal');
const mapState = { sources: [], sourceId: null, tabs: [], headers: [] };

function colLetter(i) {
  let s = '', n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

function fillSelect(sel, items, value, label, placeholder) {
  sel.innerHTML = (placeholder ? `<option value="">${placeholder}</option>` : '')
    + items.map((it) => `<option value="${escHtml(String(value(it)))}">${escHtml(String(label(it)))}</option>`).join('');
}

async function openMapping() {
  mapModal.classList.remove('hidden');
  await loadSources();
}

async function loadSources() {
  mapState.sources = await apiFetch('/sheet-sources');
  fillSelect(document.getElementById('map-source-select'), mapState.sources,
    (s) => s.id, (s) => `${s.name} (${s.spreadsheetId})`, '— Chọn nguồn —');
  fillSelect(document.getElementById('map-field-select'), SYSTEM_FIELDS,
    (f) => f, (f) => f, '— Trường hệ thống —');
  if (mapState.sources.length) {
    document.getElementById('map-source-select').value = mapState.sourceId || mapState.sources[0].id;
    mapState.sourceId = document.getElementById('map-source-select').value;
    await loadTabsAndMappings();
  } else {
    mapState.sourceId = null;
  }
}

async function loadTabsAndMappings() {
  if (!mapState.sourceId) return;
  mapState.tabs = await apiFetch(`/sheet-sources/${mapState.sourceId}/tabs`);
  fillSelect(document.getElementById('map-tab-select'), mapState.tabs,
    (t) => t.title, (t) => t.title, '— Chọn tab —');
  fillSelect(document.getElementById('map-country-tab-select'), mapState.tabs,
    (t) => t.title, (t) => t.title, '— Tab Reup —');
  await renderMappings();
  await renderCountryTabs();
}

async function renderMappings() {
  const rows = await apiFetch(`/sheet-sources/${mapState.sourceId}/mappings`);
  document.getElementById('map-mappings-tbody').innerHTML = rows.map((m) => `
    <tr class="${m.needsAttention ? 'map-attention' : ''}">
      <td>${escHtml(m.systemField || m.customFieldId || '?')}</td>
      <td>${escHtml(m.columnLetter || colLetter(m.columnIndex))}</td>
      <td>${escHtml(m.mappedHeader || '')}${m.needsAttention ? ' ⚠️' : ''}</td>
      <td>${m.isKeyCandidate ? '🔑' : ''}</td>
      <td><button class="btn btn-sm btn-ghost" onclick="delMapping('${m.id}')">✕</button></td>
    </tr>`).join('') || '<tr><td colspan="5" class="map-empty">Chưa có mapping</td></tr>';
}

async function renderCountryTabs() {
  const rows = await apiFetch(`/sheet-sources/${mapState.sourceId}/country-tabs`);
  document.getElementById('map-country-tbody').innerHTML = rows.map((c) => `
    <tr>
      <td>${escHtml(c.country)}</td>
      <td>${escHtml(c.tabTitle || '(chưa gán)')}</td>
      <td><button class="btn btn-sm btn-ghost" onclick="delCountry('${c.id}')">✕</button></td>
    </tr>`).join('') || '<tr><td colspan="3" class="map-empty">Chưa có ánh xạ quốc gia</td></tr>';
}

window.delMapping = async (id) => {
  await apiFetch(`/sheet-sources/${mapState.sourceId}/mappings/${id}`, { method: 'DELETE' });
  toast('Đã xoá mapping'); await renderMappings();
};
window.delCountry = async (id) => {
  await apiFetch(`/sheet-sources/${mapState.sourceId}/country-tabs/${id}`, { method: 'DELETE' });
  toast('Đã xoá ánh xạ quốc gia'); await renderCountryTabs();
};

// ---- wiring ----
document.getElementById('btn-open-mapping').addEventListener('click', () => openMapping().catch((e) => toast(e.message, 'error')));
document.querySelectorAll('[data-modal="mapping-modal"]').forEach((el) =>
  el.addEventListener('click', () => mapModal.classList.add('hidden')));
mapModal.querySelector('.ah-modal-backdrop')?.addEventListener('click', () => mapModal.classList.add('hidden'));

document.getElementById('map-source-select').addEventListener('change', async (e) => {
  mapState.sourceId = e.target.value || null;
  mapState.headers = [];
  document.getElementById('map-preview-wrap').innerHTML = '';
  if (mapState.sourceId) await loadTabsAndMappings().catch((err) => toast(err.message, 'error'));
});

document.getElementById('map-add-source-btn').addEventListener('click', async () => {
  const name = document.getElementById('map-new-name').value.trim();
  const spreadsheetId = document.getElementById('map-new-sid').value.trim();
  if (!name || !spreadsheetId) return toast('Nhập tên và spreadsheet ID', 'error');
  try {
    const src = await apiFetch('/sheet-sources', { method: 'POST', body: JSON.stringify({ name, spreadsheetId }) });
    mapState.sourceId = src.id;
    document.getElementById('map-new-name').value = '';
    document.getElementById('map-new-sid').value = '';
    toast('Đã thêm nguồn'); await loadSources();
  } catch (e) { toast(e.message, 'error'); }
});

document.getElementById('map-inspect-btn').addEventListener('click', async () => {
  if (!mapState.sourceId) return toast('Chọn nguồn trước', 'error');
  try {
    await apiFetch(`/sheet-sources/${mapState.sourceId}/inspect`, { method: 'POST', body: '{}' });
    toast('Đã nạp danh sách tab'); await loadTabsAndMappings();
  } catch (e) { toast(e.message, 'error'); }
});

document.getElementById('map-preview-btn').addEventListener('click', async () => {
  const tabTitle = document.getElementById('map-tab-select').value;
  if (!mapState.sourceId || !tabTitle) return toast('Chọn nguồn và tab', 'error');
  try {
    const { headers, rows } = await apiFetch(`/sheet-sources/${mapState.sourceId}/schema`,
      { method: 'POST', body: JSON.stringify({ tabTitle }) });
    mapState.headers = headers;
    fillSelect(document.getElementById('map-col-select'), headers.map((h, i) => ({ h, i })),
      (o) => o.i, (o) => `${colLetter(o.i)} — ${o.h || '(trống)'}`, '— Chọn cột —');
    document.getElementById('map-preview-wrap').innerHTML = `
      <table class="ah-table map-preview">
        <thead><tr>${headers.map((h, i) => `<th>${colLetter(i)}<br>${escHtml(h)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${headers.map((_, i) => `<td>${escHtml(r[i] || '')}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>`;
  } catch (e) { toast(e.message, 'error'); }
});

document.getElementById('map-add-mapping-btn').addEventListener('click', async () => {
  const systemField = document.getElementById('map-field-select').value;
  const colVal = document.getElementById('map-col-select').value;
  if (!systemField || colVal === '') return toast('Chọn trường và cột', 'error');
  const columnIndex = Number(colVal);
  try {
    await apiFetch(`/sheet-sources/${mapState.sourceId}/mappings`, {
      method: 'POST',
      body: JSON.stringify({
        systemField, columnIndex, columnLetter: colLetter(columnIndex),
        mappedHeader: mapState.headers[columnIndex] || null,
        isKeyCandidate: document.getElementById('map-key-chk').checked,
      }),
    });
    document.getElementById('map-key-chk').checked = false;
    toast('Đã thêm mapping'); await renderMappings();
  } catch (e) { toast(e.message, 'error'); }
});

document.getElementById('map-add-country-btn').addEventListener('click', async () => {
  const country = document.getElementById('map-country-input').value.trim();
  const tabTitle = document.getElementById('map-country-tab-select').value || null;
  if (!country) return toast('Nhập quốc gia', 'error');
  const tab = mapState.tabs.find((t) => t.title === tabTitle);
  try {
    await apiFetch(`/sheet-sources/${mapState.sourceId}/country-tabs`, {
      method: 'POST',
      body: JSON.stringify({ country, tabId: tab?.id ?? null, tabTitle }),
    });
    document.getElementById('map-country-input').value = '';
    toast('Đã thêm ánh xạ quốc gia'); await renderCountryTabs();
  } catch (e) { toast(e.message, 'error'); }
});

document.getElementById('map-reconcile-btn').addEventListener('click', async () => {
  const tabTitle = document.getElementById('map-tab-select').value;
  if (!mapState.sourceId || !tabTitle) return toast('Chọn nguồn và tab', 'error');
  try {
    const body = mapState.headers.length ? { headers: mapState.headers } : { tabTitle };
    const report = await apiFetch(`/sheet-sources/${mapState.sourceId}/reconcile-mappings`,
      { method: 'POST', body: JSON.stringify(body) });
    const healed = report.healed?.length ?? 0;
    const flagged = report.orphaned?.length ?? 0;
    toast(`Tự sửa xong: ${healed} cột dời, ${flagged} cần chú ý`, flagged ? 'error' : 'success');
  } catch (e) { toast(e.message, 'error'); }
});

// ============================================================
// Bootstrap
// ============================================================
(async () => {
  await checkHealth();
  await loadAccounts();
  initSSE();
  await refreshNotifCount();
})();
