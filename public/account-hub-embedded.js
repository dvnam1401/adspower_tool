/**
 * Account Hub — Embedded module for main SPA
 * Loaded after app.js. Reuses global authToken + showToast.
 * All DOM IDs prefixed "ah-" to avoid collisions.
 */
const AccountHub = (() => {
  let _init = false;

  // ---- API ----
  async function ahFetch(path, opts = {}) {
    const res = await fetch('/api/account-hub' + path, {
      ...opts,
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
        opts.headers || {}
      ),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'HTTP ' + res.status);
    return data.data;
  }

  function ahToast(msg, type) {
    if (typeof showToast === 'function') showToast(msg, type || 'success');
  }

  // ---- State ----
  const S = {
    accounts: [], total: 0, page: 1, limit: 50, totalPages: 1,
    search: '', accountStatus: '', adspowerStatus: '',
    sortBy: 'created_at', sortDir: 'desc', dieOnly: false,
    selected: null, editMode: false, cfg: null,
  };

  // ---- DOM refs ----
  let tbody, pgBar, searchEl, fAS, fADS, countEl, modal, addModal, dryBadge;

  function refs() {
    tbody    = document.getElementById('ah-accounts-tbody');
    pgBar    = document.getElementById('ah-pagination-bar');
    searchEl = document.getElementById('ah-search-input');
    fAS      = document.getElementById('ah-filter-account-status');
    fADS     = document.getElementById('ah-filter-adspower-status');
    countEl  = document.getElementById('ah-total-count');
    modal    = document.getElementById('ah-account-modal');
    addModal = document.getElementById('ah-add-modal');
    dryBadge = document.getElementById('ah-dry-run-badge');
  }

  // ---- Helpers ----
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var STATUS_MAP = {
    LIVE: 'ah-badge-live', DIE: 'ah-badge-die', CHECKING: 'ah-badge-check',
    LOCKED: 'ah-badge-grey', NEED_LOGIN: 'ah-badge-warn', ERROR: 'ah-badge-die', CUSTOM: 'ah-badge-grey',
  };

  function statusBadge(s) {
    return '<span class="ah-badge ' + (STATUS_MAP[s] || 'ah-badge-grey') + '">' + esc(s) + '</span>';
  }

  function adsStatusBadge(s) {
    var w = ['MISSING', 'SYNC_ERROR', 'DELETE_PENDING'].indexOf(s) !== -1;
    var ok = s === 'ACTIVE';
    return '<span class="ah-badge ' + (ok ? 'ah-badge-live' : w ? 'ah-badge-warn' : 'ah-badge-grey') + '">' + esc(s) + '</span>';
  }

  function rowClass(a) {
    if (a.accountStatus === 'DIE') return a.adspowerStatus === 'DELETED' ? 'row-die-deleted' : 'row-die-active';
    return '';
  }

  function cpBtn(v) {
    if (!v) return '';
    return '<button class="ah-copy-btn" onclick="AccountHub.copyText(event,\'' + esc(v) + '\')" title="Copy">\u2398</button>';
  }

  // ---- Load accounts ----
  async function load() {
    if (!tbody) return;
    tbody.innerHTML = '<tr class="ah-loading-row"><td colspan="9">\u23f3 \u0110ang t\u1ea3i\u2026</td></tr>';
    var p = new URLSearchParams({ page: S.page, limit: S.limit, sortBy: S.sortBy, sortDir: S.sortDir });
    if (S.search) p.set('search', S.search);
    if (S.accountStatus) p.set('accountStatus', S.accountStatus);
    if (S.adspowerStatus) p.set('adspowerStatus', S.adspowerStatus);
    if (S.dieOnly) p.set('accountStatus', 'DIE');
    try {
      var r = await ahFetch('/accounts?' + p);
      S.accounts = r.items || []; S.total = r.total || 0; S.totalPages = r.totalPages || 1;
      var items = S.accounts;
      if (S.dieOnly) items = items.filter(function(a) { return a.accountStatus === 'DIE' && a.adspowerStatus !== 'DELETED'; });
      renderTable(items);
      renderPg();
      if (countEl) countEl.textContent = S.total + ' t\u00e0i kho\u1ea3n';
    } catch(e) {
      if (tbody) tbody.innerHTML = '<tr class="ah-empty-row"><td colspan="9">\u274c ' + esc(e.message) + '</td></tr>';
    }
  }

  function renderTable(list) {
    if (!list.length) { tbody.innerHTML = '<tr class="ah-empty-row"><td colspan="9">Kh\u00f4ng c\u00f3 t\u00e0i kho\u1ea3n n\u00e0o.</td></tr>'; return; }
    tbody.innerHTML = list.map(function(a) {
      var cls = rowClass(a);
      var ls = a.lastSeenAdspowerAt ? new Date(a.lastSeenAdspowerAt).toLocaleString('vi-VN') : '\u2014';
      var yt = a.youtubeChannelUrl
        ? '<a href="' + esc(a.youtubeChannelUrl) + '" target="_blank" rel="noopener" class="ah-link">\u25b6 Link</a>'
        : '\u2014';
      return '<tr class="' + cls + '" data-id="' + a.id + '">'
        + '<td><input type="checkbox" class="ah-row-check" data-id="' + a.id + '" /></td>'
        + '<td title="' + esc(a.profileName) + '">' + esc(a.profileName)
          + (a.adspowerUserId ? '<span class="ah-text-muted" style="font-size:11px;margin-left:4px">#' + esc(a.adspowerUserId) + '</span>' : '')
        + '</td>'
        + '<td>' + statusBadge(a.accountStatus) + '</td>'
        + '<td>' + adsStatusBadge(a.adspowerStatus) + '</td>'
        + '<td>' + esc(a.loginId || '') + cpBtn(a.loginId) + '</td>'
        + '<td>' + esc(a.hotmail || '') + cpBtn(a.hotmail) + '</td>'
        + '<td>' + yt + '</td>'
        + '<td>' + ls + '</td>'
        + '<td><button class="ah-btn ah-btn-sm" onclick="AccountHub.open(\'' + a.id + '\')">\ud83d\udd0d Chi ti\u1ebft</button></td>'
        + '</tr>';
    }).join('');
  }

  function renderPg() {
    if (!pgBar) return;
    if (S.totalPages <= 1) { pgBar.innerHTML = ''; return; }
    var cur = S.page, tot = S.totalPages, pages = [];
    pages.push('<button class="ah-page-btn' + (cur===1?' active':'') + '" onclick="AccountHub.go(1)">1</button>');
    if (cur > 3) pages.push('<span style="color:#6b7280;padding:0 4px;">\u2026</span>');
    for (var i = Math.max(2, cur-1); i <= Math.min(tot-1, cur+1); i++)
      pages.push('<button class="ah-page-btn' + (i===cur?' active':'') + '" onclick="AccountHub.go(' + i + ')">' + i + '</button>');
    if (cur < tot-2) pages.push('<span style="color:#6b7280;padding:0 4px;">\u2026</span>');
    if (tot > 1) pages.push('<button class="ah-page-btn' + (cur===tot?' active':'') + '" onclick="AccountHub.go(' + tot + ')">' + tot + '</button>');
    pgBar.innerHTML = '<button class="ah-page-btn" onclick="AccountHub.go(' + (cur-1) + ')" ' + (cur===1?'disabled':'') + '>\u2039</button>'
      + pages.join('') + '<button class="ah-page-btn" onclick="AccountHub.go(' + (cur+1) + ')" ' + (cur===tot?'disabled':'') + '>\u203a</button>';
  }

  // ---- Open account modal ----
  async function openAccount(id) {
    try {
      var a = await ahFetch('/accounts/' + id);
      S.selected = a; S.editMode = false;
      renderModal(a); loadHist(id);
      modal.classList.remove('hidden');
    } catch(e) { ahToast('L\u1ed7i: ' + e.message, 'error'); }
  }

  var MODAL_FIELDS = [
    { label: 'Profile Name',     key: 'profileName',       editable: true },
    { label: 'AdsPower ID',      key: 'adspowerUserId',    editable: false },
    { label: 'Login ID / Email', key: 'loginId',           editable: true },
    { label: 'Hotmail',          key: 'hotmail',           editable: true },
    { label: 'Recovery Mail',    key: 'recoveryMail',      editable: true },
    { label: 'YouTube Channel',  key: 'youtubeChannelUrl', editable: true },
    { label: 'Linked Content',   key: 'linkedContent',     editable: true },
    { label: 'Assigned To',      key: 'assignedTo',        editable: true },
    { label: 'Password',         key: 'hasPassword',       secret: true },
    { label: '2FA Secret',       key: 'hasTwoFactor',      secret: true },
    { label: 'Cookie',           key: 'hasCookie',         secret: true },
    { label: 'Token',            key: 'hasToken',          secret: true },
    { label: 'T\u1ea1o l\u00fac', key: 'createdAt',       editable: false },
    { label: 'C\u1eadp nh\u1eadt', key: 'updatedAt',      editable: false },
  ];

  function renderModal(a) {
    var t = document.getElementById('ah-modal-title'); if (t) t.textContent = a.profileName;
    var sr = document.getElementById('ah-modal-status-row');
    if (sr) sr.innerHTML = statusBadge(a.accountStatus) + adsStatusBadge(a.adspowerStatus)
      + (a.dieMarkedAt ? '<span class="ah-badge ah-badge-die">DIE t\u1eeb ' + new Date(a.dieMarkedAt).toLocaleDateString('vi-VN') + '</span>' : '')
      + (S.cfg && S.cfg.dryRun ? '<span class="ah-badge ah-badge-warn">\ud83e\uddea Dry-run</span>' : '');

    var grid = document.getElementById('ah-modal-fields');
    if (grid) grid.innerHTML = MODAL_FIELDS.map(function(f) {
      var v = a[f.key], d;
      if (f.secret) d = v ? '<span class="ah-badge ah-badge-live">\u2713 C\u00f3</span>' : '<span class="ah-badge ah-badge-grey">Ch\u01b0a c\u00f3</span>';
      else if (f.key === 'createdAt' || f.key === 'updatedAt') d = v ? new Date(v).toLocaleString('vi-VN') : '\u2014';
      else d = v ? '<span title="' + esc(v) + '">' + esc(v) + '</span>' + cpBtn(v) : '\u2014';
      return '<div class="ah-field-item"><div class="ah-field-label">' + f.label + '</div>'
        + '<div class="ah-field-value" id="ah-field-' + f.key + '">' + d + '</div></div>';
    }).join('');

    var eb = document.getElementById('ah-modal-edit-bar');
    var vb = document.getElementById('ah-modal-view-bar');
    if (eb) eb.style.display = 'none';
    if (vb) vb.style.display = 'flex';
  }

  async function loadHist(id) {
    try {
      var logs = await ahFetch('/accounts/' + id + '/history');
      var el = document.getElementById('ah-modal-history-list'); if (!el) return;
      if (!logs.length) { el.innerHTML = '<div class="ah-history-item">Ch\u01b0a c\u00f3 l\u1ecbch s\u1eed.</div>'; return; }
      el.innerHTML = logs.slice(0, 20).map(function(l) {
        return '<div class="ah-history-item"><strong>' + l.action.toUpperCase() + '</strong>'
          + (l.actor ? ' b\u1edfi <strong>' + esc(l.actor) + '</strong>' : '')
          + ' \u2014 ' + new Date(l.createdAt).toLocaleString('vi-VN') + '</div>';
      }).join('');
    } catch(e) { /* optional */ }
  }

  var EDIT_KEYS = ['profileName','loginId','hotmail','recoveryMail','youtubeChannelUrl','linkedContent','assignedTo'];

  function enterEdit() {
    var a = S.selected;
    EDIT_KEYS.forEach(function(k) {
      var c = document.getElementById('ah-field-' + k);
      if (c) c.innerHTML = '<input class="ah-input" id="ah-edit-' + k + '" value="' + esc(a[k] || '') + '" />';
    });
    var eb = document.getElementById('ah-modal-edit-bar');
    var vb = document.getElementById('ah-modal-view-bar');
    if (eb) eb.style.display = 'flex';
    if (vb) vb.style.display = 'none';
  }

  async function saveDraft(andSync) {
    var a = S.selected, dto = { version: a.version };
    EDIT_KEYS.forEach(function(k) { var i = document.getElementById('ah-edit-' + k); if (i) dto[k] = i.value.trim() || null; });
    try {
      var u = await ahFetch('/accounts/' + a.id, { method: 'PATCH', body: JSON.stringify(dto) });
      S.selected = u; S.editMode = false;
      renderModal(u); loadHist(u.id);
      ahToast(andSync ? '\u0110\u00e3 l\u01b0u. T\u1ea1o sync job\u2026' : '\u0110\u00e3 l\u01b0u draft!', 'success');
      load();
      if (andSync) ahToast('Sync job s\u1ebd \u0111\u01b0\u1ee3c t\u1ea1o \u1edf Phase 4.', 'info');
    } catch(e) { ahToast('L\u1ed7i: ' + e.message, 'error'); }
  }

  async function checkHealth() {
    try {
      var h = await ahFetch('/health');
      S.cfg = h;
      if (!h.dryRun && dryBadge) dryBadge.style.display = 'none';
    } catch(e) { /* subsystem off */ }
  }

  function initSSE() {
    try {
      var sse = new EventSource('/api/account-hub/events?token=' + encodeURIComponent(authToken));
      sse.addEventListener('account_updated', function(e) {
        var d = JSON.parse(e.data);
        if (S.selected && S.selected.id === d.id) openAccount(d.id);
        load();
      });
      sse.addEventListener('sync_job_done', function() { load(); });
      sse.onerror = function() { sse.close(); };
    } catch(e) { /* SSE not available */ }
  }

  function wire() {
    // Reload
    var reloadBtn = document.getElementById('ah-btn-reload');
    if (reloadBtn) reloadBtn.addEventListener('click', function() { load(); });

    // Add account
    var addBtn = document.getElementById('ah-btn-add-account');
    if (addBtn) addBtn.addEventListener('click', function() {
      var f = document.getElementById('ah-add-account-form'); if (f) f.reset();
      if (addModal) addModal.classList.remove('hidden');
    });

    // Close modals via data-ah-modal
    document.querySelectorAll('[data-ah-modal]').forEach(function(el) {
      el.addEventListener('click', function() {
        var id = el.getAttribute('data-ah-modal');
        var m = document.getElementById(id); if (m) m.classList.add('hidden');
      });
    });
    if (addModal) {
      var bd = addModal.querySelector('.ah-modal-backdrop');
      if (bd) bd.addEventListener('click', function() { addModal.classList.add('hidden'); });
    }

    // Submit new account
    var submitBtn = document.getElementById('ah-btn-add-submit');
    if (submitBtn) submitBtn.addEventListener('click', async function() {
      var form = document.getElementById('ah-add-account-form');
      var data = Object.fromEntries(new FormData(form).entries());
      if (!data.profileName || !data.profileName.trim()) { ahToast('T\u00ean Profile l\u00e0 b\u1eaft bu\u1ed9c', 'warn'); return; }
      try {
        await ahFetch('/accounts', { method: 'POST', body: JSON.stringify(data) });
        if (addModal) addModal.classList.add('hidden');
        ahToast('\u0110\u00e3 t\u1ea1o t\u00e0i kho\u1ea3n!', 'success');
        S.page = 1; load();
      } catch(e) { ahToast('L\u1ed7i: ' + e.message, 'error'); }
    });

    // Search
    var st;
    if (searchEl) searchEl.addEventListener('input', function() {
      clearTimeout(st);
      st = setTimeout(function() { S.search = searchEl.value.trim(); S.page = 1; load(); }, 400);
    });

    // Filters
    if (fAS) fAS.addEventListener('change', function() { S.accountStatus = fAS.value; S.dieOnly = false; S.page = 1; load(); });
    if (fADS) fADS.addEventListener('change', function() { S.adspowerStatus = fADS.value; S.dieOnly = false; S.page = 1; load(); });

    var dpBtn = document.getElementById('ah-btn-filter-die-pending');
    if (dpBtn) dpBtn.addEventListener('click', function() {
      S.dieOnly = !S.dieOnly;
      S.accountStatus = ''; S.adspowerStatus = '';
      if (fAS) fAS.value = '';
      if (fADS) fADS.value = '';
      S.page = 1;
      dpBtn.textContent = S.dieOnly ? '\u2715 Xo\u00e1 l\u1ecdc DIE' : '\u26a1 DIE ch\u01b0a x\u00f3a';
      load();
    });

    // Modal close
    var mc = document.getElementById('ah-modal-close');
    if (mc) mc.addEventListener('click', function() { if (modal) modal.classList.add('hidden'); S.selected = null; });
    var bcm = document.getElementById('ah-btn-close-modal');
    if (bcm) bcm.addEventListener('click', function() { if (modal) modal.classList.add('hidden'); S.selected = null; });
    if (modal) {
      var mbd = modal.querySelector('.ah-modal-backdrop');
      if (mbd) mbd.addEventListener('click', function() { modal.classList.add('hidden'); S.selected = null; });
    }

    // Edit/save
    var editBtn = document.getElementById('ah-btn-edit-account');
    if (editBtn) editBtn.addEventListener('click', function() { S.editMode = true; enterEdit(); });
    var cancelEdit = document.getElementById('ah-btn-cancel-edit');
    if (cancelEdit) cancelEdit.addEventListener('click', function() {
      S.editMode = false;
      if (S.selected) { renderModal(S.selected); loadHist(S.selected.id); }
    });
    var saveD = document.getElementById('ah-btn-save-draft');
    if (saveD) saveD.addEventListener('click', function() { saveDraft(false); });
    var saveS = document.getElementById('ah-btn-save-sync');
    if (saveS) saveS.addEventListener('click', function() { saveDraft(true); });

    // Mark DIE
    var dieBtn = document.getElementById('ah-btn-mark-die');
    if (dieBtn) dieBtn.addEventListener('click', async function() {
      if (!S.selected) return;
      if (!confirm('D\u1ea5u "' + S.selected.profileName + '" l\u00e0 DIE?')) return;
      try {
        var u = await ahFetch('/accounts/' + S.selected.id + '/mark-die',
          { method: 'POST', body: JSON.stringify({ version: S.selected.version }) });
        S.selected = u; renderModal(u); loadHist(u.id);
        ahToast('\u0110\u00e3 d\u1ea5u DIE.', 'warn'); load();
      } catch(e) { ahToast('L\u1ed7i: ' + e.message, 'error'); }
    });
  }

  // ---- Public API ----
  return {
    lazyInit: function() {
      if (_init) return;
      _init = true;
      refs();
      wire();
      checkHealth().then(function() { load(); initSSE(); });
    },
    open: openAccount,
    go: function(p) {
      if (p < 1 || p > S.totalPages) return;
      S.page = p; load();
    },
    copyText: async function(e, text) {
      e.stopPropagation();
      try { await navigator.clipboard.writeText(text); ahToast('\u0110\u00e3 copy!', 'success'); }
      catch(e2) { ahToast('Copy th\u1ea5t b\u1ea1i', 'error'); }
    },
  };
})();
