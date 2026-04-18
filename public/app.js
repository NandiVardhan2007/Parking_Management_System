/* ============================================================
   KPR TRANSPORT - PARKING MANAGEMENT SYSTEM
   app.js  —  DAY-WISE BILLING + MONTHLY REVENUE  (v3)
   
   BUG FIX APPLIED: Prevent autocomplete race condition
   Changes marked with // FIX: comments
   ============================================================ */

// ── API Config ───────────────────────────────────────────────
const API = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? `http://${window.location.hostname}:3000/api`
  : `${window.location.origin}/api`;

const PRINT_SECRET = 'KPR2024SECRET';

// ── Data Store ───────────────────────────────────────────────
let db              = [];
let dailyRate       = parseInt(localStorage.getItem('kpr_rate') || '130');
let recFilterStatus = 'all';
let backendOnline   = false;
let initialSyncDone = false;

// FIX 1: Add submission tracking flag to prevent autocomplete race condition
let _isSubmitting   = false;

// ── API helpers ──────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const mergedHeaders = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const res = await fetch(API + path, { ...opts, headers: mergedHeaders });
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    if (!res.ok) {
      throw new Error(
        `Server error (HTTP ${res.status}). ` +
        `Common causes: MONGO_URI not set in Render Environment, ` +
        `or MongoDB Atlas IP whitelist missing 0.0.0.0/0. ` +
        `Diagnose at: ${API}/health`
      );
    }
    throw new Error(`Server returned non-JSON (${res.status}). Check Render service logs.`);
  }
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'API error');
  return json;
}

async function syncFromServer() {
  try {
    const [records, settings] = await Promise.all([
      apiFetch('/records?limit=5000'),
      apiFetch('/settings')
    ]);
    db         = records.data;
    dailyRate  = parseFloat(settings.data.hourly_rate) || 130;
    saveLocal();
    backendOnline   = true;
    initialSyncDone = true;
    const rateEl = document.getElementById('hourlyRateInput') || document.getElementById('dailyRateInput');
    if (rateEl) rateEl.value = dailyRate;
    const rateShow = document.getElementById('rateShow');
    if (rateShow) rateShow.textContent = dailyRate;
  } catch (_) {
    backendOnline = false;
    if (!initialSyncDone) {
      db = JSON.parse(localStorage.getItem('kpr_db') || '[]');
      initialSyncDone = true;
    }
    showOnlineStatus();
  }
}

function saveLocal() {
  localStorage.setItem('kpr_db',   JSON.stringify(db));
  localStorage.setItem('kpr_rate', String(dailyRate));
}

function showOnlineStatus() {
  const badge = document.getElementById('onlineBadge');
  if (!badge) return;
  badge.textContent = backendOnline ? '● Live' : '○ Offline';
  badge.style.color = backendOnline ? '#22c55e' : '#f59e0b';
  badge.title       = backendOnline
    ? 'Connected to server — data is synced'
    : 'Server unreachable — using local storage';
}

// ── Token ────────────────────────────────────────────────────
function getNextToken() {
  if (!db.length) return 1;
  return Math.max(...db.map(r => r.token || 0)) + 1;
}
function refreshToken() {
  const el = document.getElementById('nextToken');
  if (el) el.textContent = '#' + getNextToken();
}

// ── Rate ─────────────────────────────────────────────────────
async function saveRate() {
  const rateInput = document.getElementById('hourlyRateInput') || document.getElementById('dailyRateInput');
  const v = parseInt(rateInput?.value) || 130;
  dailyRate = v;
  localStorage.setItem('kpr_rate', v);
  document.getElementById('rateShow').textContent = v;
  if (backendOnline) {
    try {
      await apiFetch('/settings', { method: 'POST', body: JSON.stringify({ hourly_rate: v }) });
      notify('Rate updated to Rs.' + v + '/day', 'success');
    } catch (e) {
      notify('Saved locally — server sync failed', 'info');
    }
  } else {
    notify('Rate updated to Rs.' + v + '/day (offline)', 'success');
  }
}

// ── Clock ────────────────────────────────────────────────────
function tick() {
  const now = new Date();
  document.getElementById('clockTime').textContent =
    now.toLocaleTimeString('en-IN', { hour12: true, timeZone: 'Asia/Kolkata' });
  document.getElementById('clockDate').textContent =
    now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}
setInterval(tick, 1000);
tick();

// ── IST helpers ──────────────────────────────────────────────
function _istParts(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  return {
    year: p.year, month: p.month, day: p.day,
    hours: p.hour === '24' ? '00' : p.hour, minutes: p.minute
  };
}

function localDateStr() {
  const p = _istParts(new Date());
  return `${p.year}-${p.month}-${p.day}`;
}

function liveTime24() {
  const p = _istParts(new Date());
  return `${p.hours}:${p.minutes}`;
}

function currentYearMonth() {
  const p = _istParts(new Date());
  return `${p.year}-${p.month}`;   // e.g. "2026-04"
}

function to12h(t24) {
  if (!t24) return '';
  try {
    const [h, m] = t24.split(':').map(Number);
    const ampm   = h >= 12 ? 'PM' : 'AM';
    const h12    = h % 12 || 12;
    return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
  } catch (e) { return t24; }
}

function to24h(t12) {
  if (!t12) return '';
  const m = t12.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return t12.slice(0, 5);
  let h = parseInt(m[1]);
  if (m[3].toUpperCase() === 'PM' && h !== 12) h += 12;
  if (m[3].toUpperCase() === 'AM' && h === 12)  h  = 0;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

function daysBetween(entryDate, exitDate) {
  try {
    const a = new Date(entryDate + 'T00:00:00');
    const b = new Date(exitDate  + 'T00:00:00');
    const diff = Math.round((b - a) / 86400000);
    return Math.max(1, diff);
  } catch (e) { return 1; }
}

function fmtDuration(days) {
  return days + ' Day' + (days !== 1 ? 's' : '');
}

function calcBilling(entryDate, entryTime, exitDate, exitTime) {
  const days = daysBetween(entryDate, exitDate || localDateStr());
  return {
    days,
    totalMin:      days * 1440,
    billableHours: days * 24,
    display: fmtDuration(days),
    amount:  days * dailyRate
  };
}

// ── Month label helper ────────────────────────────────────────
function monthLabel(ym) {
  // ym = "2026-04"
  try {
    const [y, m] = ym.split('-');
    const d = new Date(parseInt(y), parseInt(m) - 1, 1);
    return d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  } catch (e) { return ym; }
}

// ── Date/Time input init ──────────────────────────────────────
function initAllDateTimeInputs() {
  const today = localDateStr();
  const now   = liveTime24();
  const ed = document.getElementById('entryDateInput');
  const et = document.getElementById('entryTimeInput');
  if (ed && !ed.value) ed.value = today;
  if (et && !et.value) et.value = now;
  syncExitDateTime();
}

function syncExitDateTime() {
  const ed = document.getElementById('exitDateInput');
  const et = document.getElementById('exitTimeInput');
  if (ed && !exitDateManual) ed.value = localDateStr();
  if (et && !exitTimeManual) et.value = liveTime24();
}

let entryTimeManual = false;
let entryDateManual = false;
let exitTimeManual  = false;
let exitDateManual  = false;

function startEntryTimeTick() {
  setInterval(() => {
    if (!entryTimeManual) {
      const et = document.getElementById('entryTimeInput');
      if (et) et.value = liveTime24();
    }
    if (!entryDateManual) {
      const ed = document.getElementById('entryDateInput');
      if (ed) ed.value = localDateStr();
    }
    const _xd = document.getElementById('exitDateInput');
    const _xt = document.getElementById('exitTimeInput');
    if (_xd && !exitDateManual) _xd.value = localDateStr();
    if (_xt && !exitTimeManual) _xt.value = liveTime24();
  }, 10000);
}

// ── Navigation ───────────────────────────────────────────────
function goTab(tab, btn) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('panel-' + tab).classList.add('active');
  btn.classList.add('active');
  document.getElementById('appBody').scrollTop = 0;
  if (tab === 'exit') {
    const _xd = document.getElementById('exitDateInput');
    const _xt = document.getElementById('exitTimeInput');
    if (_xd && !exitDateManual) _xd.value = localDateStr();
    if (_xt && !exitTimeManual) _xt.value = liveTime24();
    renderParked();
  }
  if (tab === 'records') { renderRecords(); renderMonthlyRevenue(); }
  updateStats();
}

// ── Notifications ─────────────────────────────────────────────
function notify(msg, type = 'info') {
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warn: '⚠️' };
  const el    = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span style="flex:1">${msg}</span>`;
  document.getElementById('notifyWrap').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ── Date format helper ───────────────────────────────────────
function formatDate(dateStr) {
  try {
    if (!dateStr) return '--';
    const d = new Date(dateStr + 'T00:00:00+05:30');
    return d.toLocaleDateString('en-IN', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      timeZone: 'Asia/Kolkata'
    });
  } catch (e) { return dateStr; }
}

// ── LORRY AUTOCOMPLETE ────────────────────────────────────────
let _acTimer = null;

function lorryAutocomplete(val) {
  const query = val.trim().toUpperCase();
  hideLorryDropdown();
  if (query.length < 2) return;

  clearTimeout(_acTimer);
  _acTimer = setTimeout(() => {
    const lorryMap = {};
    db.forEach(r => {
      if (!r.lorry.startsWith(query)) return;
      const existing = lorryMap[r.lorry];
      if (!existing || r.token > existing.token) lorryMap[r.lorry] = r;
    });

    const matches = Object.values(lorryMap)
      .sort((a, b) => b.token - a.token)
      .slice(0, 6);

    if (!matches.length) return;
    showLorryDropdown(matches);
  }, 120);
}

function showLorryDropdown(matches) {
  let dd = document.getElementById('lorryDropdown');
  if (!dd) return;

  dd.innerHTML = matches.map(r => {
    const isParked  = r.status === 'IN';
    const badge     = isParked
      ? `<span class="ac-badge ac-badge-in">PARKED</span>`
      : `<span class="ac-badge ac-badge-out">EXITED</span>`;
    const driverTxt = r.driver !== '--' ? r.driver : '—';
    const phoneTxt  = r.phone  !== '--' ? r.phone  : '';
    const sub       = phoneTxt ? `${driverTxt} · ${phoneTxt}` : driverTxt;
    return `<div class="ac-item" data-lorry="${r.lorry}" onclick="selectLorry('${r.lorry}')">
      <div class="ac-top">
        <span class="ac-lorry">${r.lorry}</span>
        ${badge}
      </div>
      <div class="ac-sub">${sub}</div>
    </div>`;
  }).join('');

  dd.style.display = 'block';
}

function hideLorryDropdown() {
  const dd = document.getElementById('lorryDropdown');
  if (dd) { dd.style.display = 'none'; dd.innerHTML = ''; }
}

function selectLorry(lorry) {
  // FIX 2: Prevent autocomplete from changing input during form submission
  if (_isSubmitting) {
    console.log('[KPR] Blocked selectLorry during submission:', lorry);
    return;
  }

  const lorryInput = document.getElementById('entryLorry');
  if (lorryInput) lorryInput.value = lorry;
  hideLorryDropdown();

  const past = db
    .filter(r => r.lorry === lorry)
    .sort((a, b) => b.token - a.token)[0];

  if (!past) return;

  const dEl = document.getElementById('entryDriver');
  const pEl = document.getElementById('entryPhone');
  const rEl = document.getElementById('entryRemarks');

  if (dEl && (!dEl.value.trim() || dEl.value.trim() === '--') && past.driver !== '--') dEl.value = past.driver;
  if (pEl && (!pEl.value.trim() || pEl.value.trim() === '--') && past.phone  !== '--') pEl.value = past.phone;
  if (rEl && (!rEl.value.trim() || rEl.value.trim() === '--') && past.remarks !== '--') rEl.value = past.remarks;

  const fillBadge = document.getElementById('acFillBadge');
  if (fillBadge) {
    const visits = db.filter(r => r.lorry === lorry).length;
    fillBadge.textContent =
      `✔ Details loaded from last visit · ${visits} visit${visits !== 1 ? 's' : ''} on record`;
    fillBadge.style.display = 'block';
    clearTimeout(fillBadge._timer);
    fillBadge._timer = setTimeout(() => { fillBadge.style.display = 'none'; }, 4000);
  }

  if (past.status === 'IN') notify(`⚠ ${lorry} is currently parked (Token #${past.token})`, 'warn');

  if (dEl && dEl.value) {
    if (pEl && !pEl.value) pEl.focus();
    else if (dEl && !dEl.value) dEl.focus();
  }
}

// ── ENTRY ────────────────────────────────────────────────────
async function recordEntry() {
  // FIX 3: Clear all autocomplete timers BEFORE reading input value
  // This prevents delayed selectLorry() from changing the input after we read it
  _isSubmitting = true;
  clearTimeout(_acTimer);
  hideLorryDropdown();

  const lorryInput = document.getElementById('entryLorry');
  const lorry      = lorryInput.value.trim().toUpperCase();
  if (!lorry) { 
    _isSubmitting = false;  // FIX 4: Re-enable on validation failure
    notify('Enter lorry number!', 'error'); 
    return; 
  }

  const dup = db.find(r => r.lorry === lorry && r.status === 'IN');
  if (dup) { 
    _isSubmitting = false;  // FIX 4: Re-enable on validation failure
    notify('WARNING: ' + lorry + ' already parked! Serial #' + dup.token, 'error'); 
    return; 
  }

  const entryDate = document.getElementById('entryDateInput').value || localDateStr();
  const entryTime = document.getElementById('entryTimeInput').value || liveTime24();

  const payload = {
    lorry,
    driver:  document.getElementById('entryDriver').value.trim()  || '--',
    phone:   document.getElementById('entryPhone').value.trim()   || '--',
    remarks: document.getElementById('entryRemarks').value.trim() || '--',
    entryDate,
    entryTime
  };

  let rec;

  if (backendOnline) {
    try {
      const resp = await apiFetch('/records', { method: 'POST', body: JSON.stringify(payload) });
      rec = resp.data;
      db.unshift(rec);
      saveLocal();
    } catch (e) { 
      _isSubmitting = false;  // FIX 4: Re-enable on error
      notify('Server error: ' + e.message, 'error'); 
      return; 
    }
  } else {
    const token = getNextToken();
    rec = {
      id: Date.now(), token, lorry,
      driver:       payload.driver,
      phone:        payload.phone,
      remarks:      payload.remarks,
      entryDate,    entryTime,
      entryDisplay: formatDate(entryDate),
      exitDate: null, exitTime: null,
      exitDisplay: '--',
      durationMin: null, amount: null,
      status: 'IN'
    };
    db.unshift(rec);
    saveLocal();
    notify('Saved locally (offline mode)', 'info');
  }

  updateStats(); refreshToken(); renderRecent();
  notify('Serial #' + rec.token + ' — ' + lorry + ' entered', 'success');
  showEntryReceipt(rec);
  clearEntry();

  // FIX 4: Re-enable autocomplete after successful submission
  _isSubmitting = false;
}

function clearEntry() {
  ['entryLorry', 'entryDriver', 'entryPhone', 'entryRemarks'].forEach(id => {
    document.getElementById(id).value = '';
  });
  entryDateManual = false;
  entryTimeManual = false;
  document.getElementById('entryDateInput').value = localDateStr();
  document.getElementById('entryTimeInput').value = liveTime24();
  hideLorryDropdown();
  const fillBadge = document.getElementById('acFillBadge');
  if (fillBadge) fillBadge.style.display = 'none';
  
  // FIX 4: Clear submission flag when form is cleared
  _isSubmitting = false;
}

// ── EXIT — LOOKUP ────────────────────────────────────────────
function lookupToken(val) {
  const errEl = document.getElementById('exitError');
  const card  = document.getElementById('lookupCard');
  errEl.style.display = 'none';
  card.style.display  = 'none';

  const num = parseInt(val);
  if (!val || isNaN(num)) return;

  // FIX: Handle duplicate tokens - find ALL matches first
  const matches = db.filter(r => r.token === num);
  
  if (!matches.length) {
    errEl.textContent   = 'Serial #' + num + ' not found.';
    errEl.style.display = 'block';
    return;
  }

  // FIX: If multiple matches, prefer the one that's currently PARKED (status=IN)
  // This handles the duplicate token bug gracefully
  const rec = matches.find(r => r.status === 'IN') || matches[0];

  // FIX: Warn if duplicates detected
  if (matches.length > 1) {
    console.warn(`[KPR] Token #${num} has ${matches.length} records! Showing: ${rec.lorry}`, matches);
    notify(`⚠ Warning: Multiple records found for #${num}. Showing ${rec.lorry}`, 'warn');
  }

  if (rec.status === 'OUT') {
    errEl.textContent   = 'Serial #' + num + ' (' + rec.lorry + ') already exited on ' + rec.exitDisplay;
    errEl.style.display = 'block';
    return;
  }

  const exitDate = document.getElementById('exitDateInput').value  || localDateStr();
  const exitTime = document.getElementById('exitTimeInput').value  || liveTime24();
  const bill     = calcBilling(rec.entryDate, rec.entryTime || '00:00', exitDate, exitTime);

  document.getElementById('lkToken').textContent = '#' + rec.token;
  document.getElementById('lkLorry').textContent = rec.lorry;

  const phoneRow  = rec.phone   !== '--'
    ? `<div class="di"><div class="di-lbl">Phone</div><div class="di-val blue">${rec.phone}</div></div>`
    : '<div></div>';
  const remarkRow = rec.remarks !== '--'
    ? `<div class="di full"><div class="di-lbl">Remarks</div><div class="di-val">${rec.remarks}</div></div>`
    : '';
  const entryTimeDisp = rec.entryTime ? ' ' + to12h(rec.entryTime) : '';

  document.getElementById('lkDetails').innerHTML =
    `<div class="di"><div class="di-lbl">Driver</div><div class="di-val">${rec.driver}</div></div>` +
    phoneRow +
    `<div class="di full"><div class="di-lbl">Entry</div><div class="di-val">${formatDate(rec.entryDate)}${entryTimeDisp}</div></div>` +
    remarkRow;

  document.getElementById('lkAmount').textContent = 'Rs.' + bill.amount.toLocaleString('en-IN');
  document.getElementById('lkInfo').textContent   =
    bill.display + ' × Rs.' + dailyRate + '/day';
  card.style.display = 'block';
}

// ── EXIT — LOOKUP BY LORRY ────────────────────────────────────
function lookupByLorry(val) {
  const errEl   = document.getElementById('exitError');
  const card    = document.getElementById('lookupCard');
  const lorryIn = val.trim().toUpperCase();

  if (!lorryIn) {
    errEl.style.display = 'none';
    card.style.display  = 'none';
    return;
  }

  const matches = db.filter(r => r.lorry === lorryIn && r.status === 'IN');

  if (!matches.length) {
    const exited = db.find(r => r.lorry === lorryIn && r.status === 'OUT');
    errEl.textContent   = exited
      ? `${lorryIn} already exited (Token #${exited.token})`
      : `No active parking record found for "${lorryIn}".`;
    errEl.style.display = 'block';
    card.style.display  = 'none';
    document.getElementById('exitToken').value = '';
    return;
  }

  const rec = matches.reduce((a, b) => (a.token > b.token ? a : b));
  errEl.style.display = 'none';
  document.getElementById('exitToken').value = rec.token;
  lookupToken(String(rec.token));
}

function clearExitForm() {
  document.getElementById('exitToken').value          = '';
  document.getElementById('exitLorrySearch').value    = '';
  document.getElementById('exitError').style.display  = 'none';
  document.getElementById('lookupCard').style.display = 'none';
  exitDateManual = false;
  exitTimeManual = false;
  document.getElementById('exitDateInput').value = localDateStr();
  document.getElementById('exitTimeInput').value = liveTime24();
}

// ── EXIT — PROCESS ───────────────────────────────────────────
async function processExit() {
  const val   = document.getElementById('exitToken').value.trim();
  const errEl = document.getElementById('exitError');
  errEl.style.display = 'none';

  const num = parseInt(val);
  if (!val || isNaN(num)) {
    errEl.textContent = 'Please enter a valid token number.';
    errEl.style.display = 'block'; return;
  }

  const idx = db.findIndex(r => r.token === num && r.status === 'IN');
  if (idx === -1) {
    const gone = db.find(r => r.token === num);
    errEl.textContent   = gone
      ? 'Serial #' + num + ' (' + gone.lorry + ') already exited.'
      : 'Serial #' + num + ' not found.';
    errEl.style.display = 'block'; return;
  }

  const exitDate = document.getElementById('exitDateInput').value;
  const exitTime = document.getElementById('exitTimeInput').value || liveTime24();
  if (!exitDate) { errEl.textContent = 'Select exit date!'; errEl.style.display = 'block'; return; }

  let rec = db[idx];

  if (backendOnline) {
    try {
      const resp = await apiFetch(`/records/${rec.id}/exit`, {
        method: 'PATCH',
        body:   JSON.stringify({ exitDate, exitTime })
      });
      db[idx] = resp.data;
      rec     = resp.data;
      saveLocal();
    } catch (e) { notify('Server error: ' + e.message, 'error'); return; }
  } else {
    const bill     = calcBilling(rec.entryDate, rec.entryTime || '00:00', exitDate, exitTime);
    rec.exitDate   = exitDate; rec.exitTime  = exitTime;
    rec.exitDisplay = formatDate(exitDate);
    rec.durationMin = bill.totalMin;
    rec.amount      = bill.amount;
    rec.status      = 'OUT';
    db[idx]         = rec;
    saveLocal();
    notify('Saved locally (offline mode)', 'info');
  }

  updateStats(); renderParked(); renderRecent();
  showExitReceipt(rec);
  clearExitForm();
  notify('Serial #' + num + ' exited — Rs.' + rec.amount, 'success');
}

// ── PRINT QUEUE ──────────────────────────────────────────────
async function sendToPrinter(data) {
  try {
    const resp = await fetch(`${API}/print-queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Print-Token': PRINT_SECRET },
      body:   JSON.stringify(data),
      signal: AbortSignal.timeout(8000)
    });
    if (resp.ok) {
      const json = await resp.json();
      console.log('[KPR Print] Job queued, ID:', json.data?.job_id);
      notify('🖨 Print job queued — printing at parking ✓', 'success');
    } else {
      notify('⚠ Print queue error (' + resp.status + ')', 'warn');
    }
  } catch (err) {
    console.warn('[KPR Print]', err.message);
    notify('⚠ Could not queue print job', 'warn');
  }
}

// ── RECEIPTS ─────────────────────────────────────────────────
function showEntryReceipt(rec) {
  const timeStr   = rec.entryTime ? to12h(rec.entryTime) : to12h(liveTime24());

  const driverRow2  = rec.driver !== '--' ? `<tr><td>Driver&nbsp;&nbsp;&nbsp;:</td><td>${rec.driver}</td></tr>` : '';
  const mobileRow2  = rec.phone  !== '--' ? `<tr><td>Mobile&nbsp;&nbsp;&nbsp;:</td><td>${rec.phone}</td></tr>`  : '';
  const remarksRow2 = rec.remarks !== '--' ? `<tr><td colspan="2" style="padding-top:4px;font-size:12px;color:#555">${rec.remarks}</td></tr>` : '';

  document.getElementById('receiptContent').innerHTML =
    `<div class="th-receipt">
      <div class="th-header">
        <div class="th-title">KPR TRUCK PARKING</div>
        <div class="th-sub">Beside DRK College, Bowrampet</div>
        <div class="th-sub">Ph: 9640019275 | 8885519275</div>
      </div>
      <div class="th-dash"></div>
      <div class="th-type">**ENTRY RECEIPT**</div>
      <div class="th-dash"></div>
      <table class="th-table">
        <tr><td>Serial No&nbsp;:</td><td><b>#${rec.token}</b></td></tr>
        <tr><td>Vehicle No:</td><td><b>${rec.lorry}</b></td></tr>
        ${driverRow2}
        ${mobileRow2}
      </table>
      <div class="th-dash"></div>
      <table class="th-table">
        <tr><td>Entry Date :</td><td>${formatDate(rec.entryDate)}</td></tr>
        <tr><td>Entry Time :</td><td>${timeStr}</td></tr>
        <tr><td>Per Day&nbsp;&nbsp;&nbsp;:</td><td><b>₹${dailyRate}</b></td></tr>
        ${remarksRow2}
      </table>
      <div class="th-dash"></div>
      <div class="th-note">
        <b>Note:</b><br>
        Management is not responsible<br>
        for any loss, theft, or damage<br>
        to vehicle or its contents.
      </div>
      <div class="th-dash"></div>
      <div class="th-footer">THANK YOU - DRIVE SAFE</div>
    </div>`;

  window._lastReceiptData = {
    type:       'entry',
    token:      String(rec.token),
    lorry:      rec.lorry,
    driver:     rec.driver  !== '--' ? rec.driver  : '',
    phone:      rec.phone   !== '--' ? rec.phone   : '',
    remarks:    rec.remarks !== '--' ? rec.remarks : '',
    entry_date: formatDate(rec.entryDate),
    entry_time: timeStr,
    rate:       dailyRate
  };

  document.getElementById('receiptOv').classList.add('open');
}

function showExitReceipt(rec) {
  const entryTimeStr = rec.entryTime ? to12h(rec.entryTime) : '';
  const exitTimeStr  = rec.exitTime  ? to12h(rec.exitTime)  : to12h(liveTime24());

  let durDisplay, amount;
  if (rec.durationMin != null && rec.amount != null) {
    const days = Math.max(1, Math.round(rec.durationMin / 1440));
    durDisplay = fmtDuration(days);
    amount     = rec.amount;
  } else {
    const bill = calcBilling(rec.entryDate, rec.entryTime || '00:00', rec.exitDate, rec.exitTime || liveTime24());
    durDisplay = bill.display;
    amount     = bill.amount;
  }

  const driverRowX  = rec.driver  !== '--' ? `<tr><td>Driver&nbsp;&nbsp;&nbsp;:</td><td>${rec.driver}</td></tr>` : '';
  const mobileRowX  = rec.phone   !== '--' ? `<tr><td>Mobile&nbsp;&nbsp;&nbsp;:</td><td>${rec.phone}</td></tr>`  : '';
  const upiUrl      = `upi://pay?pa=9640019275@ybl&pn=KPR%20Truck%20Parking&am=${amount || 0}&cu=INR`;

  document.getElementById('receiptContent').innerHTML =
    `<div class="th-receipt">
      <div class="th-header">
        <div class="th-title">KPR TRUCK PARKING</div>
        <div class="th-sub">Beside DRK College, Bowrampet</div>
        <div class="th-sub">Ph: 9640019275 | 8885519275</div>
      </div>
      <div class="th-dash"></div>
      <div class="th-type">**EXIT RECEIPT**</div>
      <div class="th-dash"></div>
      <table class="th-table">
        <tr><td>Serial No&nbsp;:</td><td><b>#${rec.token}</b></td></tr>
        <tr><td>Vehicle No:</td><td><b>${rec.lorry}</b></td></tr>
        ${driverRowX}
        ${mobileRowX}
      </table>
      <div class="th-dash"></div>
      <table class="th-table">
        <tr><td>Entry Date :</td><td>${formatDate(rec.entryDate)}</td></tr>
        <tr><td>Entry Time :</td><td>${entryTimeStr || '--'}</td></tr>
        <tr><td>Exit Date&nbsp;:</td><td>${formatDate(rec.exitDate)}</td></tr>
        <tr><td>Exit Time&nbsp;:</td><td>${exitTimeStr}</td></tr>
        <tr class="th-total-row"><td>Total Paid :</td><td><b>Rs.${(amount || 0).toLocaleString('en-IN')}</b></td></tr>
      </table>
      <div class="th-dash"></div>
      <div class="th-footer">THANK YOU - DRIVE SAFE</div>
      <div class="th-qr-wrap">
        <img
          src="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAYGBgYHBgcICAcKCwoLCg8ODAwODxYQERAREBYiFRkVFRkVIh4kHhweJB42KiYmKjY+NDI0PkxERExfWl98fKcBBgYGBgcGBwgIBwoLCgsKDw4MDA4PFhAREBEQFiIVGRUVGRUiHiQeHB4kHjYqJiYqNj40MjQ+TERETF9aX3x8p//CABEIAqoCuAMBIgACEQEDEQH/xAAtAAEAAwEBAQEAAAAAAAAAAAAABAUGBwMCAQEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEAMQAAAC1QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKvN32OLN8/QAAPA99pzjopBzelzRtPTy9Rjtjz4kocwW2Zsza47Q5wsdFlrksFeLBX2AAQfksMdoc4WOizuiMd4e8E91ZYlxostcmen52ebVX2AAq7SlKHac46KQc3pc0bT08vw9lePPN2ObOj186rKFWWJ9AAAPCGdH9PH2AAAAAAKXHbHHHRfbxglow43DDjcUttUmO6LzropBzelzRtPTy9Rjtjz4kocwW2Zsza47Q5wsdFlrksFeLBX2AAQfksMdoc4WOizuiMd4e8E91ZYlxostcmen52ebVX2AAq7SlKHac46KQc3pc0bT08vw9lePPN2ObOj186rKFWWJ9AAAPCGdH9PH2AAAAAAUuO2OOOi1dpVmOAB0WrtKsx3ReddFIWa3AqY2dsyK3AzuiDHSNTSkphBpM2FjY6OrJWL8BbaXCD38AbPGDoUnI64g+uHszXQZ3PjRU0rXHN/iVFHReddFKvHbHHHRfbx9gAAAAAClx2xxx0WrtIRh1mKxZjZVdrVGO6LzropBzelzRoosqMUwANpU+kYyazryz0ua0pP+iH7ngsIJ8gxfhcQyGWJFmBX+kzwPfRYrZkh7yTnfhK+DwsfoeEOzFZbVlmaXF7TFk/S0OuK/2leJ7QfmwIsoFLdUpjui866KVeO2OOAHReddFKvHbHHHRfbx9gAAAAAFLjdjjjovt4wS0YcbhhxuKW2qTHdF51Ym6YcbhhxuGHF9jpkM6L7ePsAAAAAAUuO2OONnAzYdF510UhZrcDyg2Yw9f0jnxZ67I6459Z1lma6DO58bFhBcStHVkrOU/RTOXMXHHvbUV6a7n3QefEUC2qRu2EGsppWuKn2x0U3bCDoUnI64g+uHszXQZ3PjYsIN3Ayd6RdFbc+NFTStcc3uqyzNdz7oPPj4mStcc3+JUUdF510U9gY6fogx2xGAh7HHHRfbx9gAAAAAClx2xxxs5Er2K+f+irzd9jizVnuTNFndmeUoIPp5/JYQfkAZyHMhkPovOuilXjtjjjY"
          alt="Scan to Pay via PhonePe"
          width="140" height="140"
          style="display:block;margin:6px auto;border-radius:6px;"
        />
        <div class="th-upi">Scan to Pay via PhonePe</div>
        <div class="th-upi" style="font-size:11px;margin-top:2px;">UPI: 9640019275@ybl</div>
      </div>
    </div>`;

  window._lastReceiptData = {
    type:       'exit',
    token:      String(rec.token),
    lorry:      rec.lorry,
    driver:     rec.driver  !== '--' ? rec.driver  : '',
    phone:      rec.phone   !== '--' ? rec.phone   : '',
    remarks:    rec.remarks !== '--' ? rec.remarks : '',
    entry_date: formatDate(rec.entryDate),
    entry_time: entryTimeStr,
    exit_date:  formatDate(rec.exitDate),
    exit_time:  exitTimeStr,
    duration:   durDisplay,
    rate:       dailyRate,
    amount:     amount
  };

  document.getElementById('receiptOv').classList.add('open');
}

function closeReceipt() {
  document.getElementById('receiptOv').classList.remove('open');
  document.getElementById('receiptOv').scrollTop = 0;
  window._lastReceiptData = null;
}

function printReceipt() {
  if (window._lastReceiptData) {
    sendToPrinter(window._lastReceiptData);
  } else {
    notify('No receipt data to print', 'warn');
  }
}

// ── RENDER: RECENTLY PARKED ───────────────────────────────────
function renderRecent() {
  const el     = document.getElementById('recentList');
  const parked = db.filter(r => r.status === 'IN').slice(0, 5);
  if (!parked.length) {
    el.innerHTML = '<div class="empty"><div class="ei">P</div><p>No lorries parked yet</p></div>';
    return;
  }
  el.innerHTML = parked.map(r => {
    const timeStr    = r.entryTime ? ' · <b>' + to12h(r.entryTime) + '</b>' : '';
    const driverLine = r.driver !== '--' ? ` · Driver: <b>${r.driver}</b>` : '';
    const phoneLine  = r.phone  !== '--' ? ` · <span style="color:var(--blue)">${r.phone}</span>` : '';
    return `
      <div class="pk-card">
        <div class="pk-top">
          <span class="pk-token">#${r.token}</span>
          <span class="pk-lorry">${r.lorry}</span>
        </div>
        <div class="pk-meta">In: <b>${r.entryDisplay}</b>${timeStr}${driverLine}${phoneLine}</div>
        <div class="pk-foot">
          <div><div class="pk-due">--</div><div class="pk-days">Billing on exit</div></div>
          <button class="btn btn-sm btn-danger" onclick="goToExit(${r.token})">Exit</button>
        </div>
      </div>`;
  }).join('');
}

// ── RENDER: CURRENTLY PARKED ──────────────────────────────────
function renderParked(filter) {
  filter = filter || '';
  const el   = document.getElementById('parkedList');
  const cEl  = document.getElementById('parkedCount');
  let parked = db.filter(r => r.status === 'IN');
  if (filter) {
    const q = filter.toLowerCase();
    parked  = parked.filter(r => r.lorry.toLowerCase().includes(q) || String(r.token).includes(q));
  }
  if (cEl) cEl.textContent = parked.length + ' lorr' + (parked.length !== 1 ? 'ies' : 'y');
  if (!parked.length) {
    el.innerHTML = `<div class="empty"><div class="ei">P</div><p>${filter ? 'No results' : 'No lorries parked'}</p></div>`;
    return;
  }
  const exitDate = document.getElementById('exitDateInput')?.value || localDateStr();
  const exitTime = document.getElementById('exitTimeInput')?.value || liveTime24();
  el.innerHTML = parked.map(r => {
    const bill       = calcBilling(r.entryDate, r.entryTime || '00:00', exitDate, exitTime);
    const timeStr    = r.entryTime ? ' · <b>' + to12h(r.entryTime) + '</b>' : '';
    const driverLine = r.driver !== '--' ? `<br>Driver: <b>${r.driver}</b>` : '';
    const phoneLine  = r.phone  !== '--' ? ` · <span style="color:var(--blue)">${r.phone}</span>` : '';
    return `
      <div class="pk-card">
        <div class="pk-top">
          <span class="pk-token">#${r.token}</span>
          <span class="pk-lorry">${r.lorry}</span>
        </div>
        <div class="pk-meta">In: <b>${r.entryDisplay}</b>${timeStr}${driverLine}${phoneLine}</div>
        <div class="pk-foot">
          <div>
            <div class="pk-due">Rs.${bill.amount.toLocaleString('en-IN')}</div>
            <div class="pk-days">${bill.display}</div>
          </div>
          <button class="btn btn-sm btn-danger" onclick="goToExit(${r.token})">Exit</button>
        </div>
      </div>`;
  }).join('');
}

function filterParked(val) { renderParked(val); }

function goToExit(token) {
  const et = document.getElementById('exitTimeInput');
  if (et && !et.value) et.value = liveTime24();
  const ed = document.getElementById('exitDateInput');
  if (ed && !ed.value) ed.value = localDateStr();

  document.getElementById('exitToken').value = token;
  lookupToken(String(token));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('nav-exit').classList.add('active');
  document.getElementById('panel-exit').classList.add('active');
  document.getElementById('appBody').scrollTop = 0;
  updateStats();
}

// ── RENDER: ALL RECORDS ───────────────────────────────────────
function setFilter(val, btn) {
  recFilterStatus = val;
  document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  renderRecords();
}

function renderRecords() {
  const el = document.getElementById('recordsList');
  const q  = (document.getElementById('recSearch')?.value || '').toLowerCase();
  let recs = db.slice();
  if (recFilterStatus !== 'all') recs = recs.filter(r => r.status === recFilterStatus);
  if (q) recs = recs.filter(r =>
    r.lorry.toLowerCase().includes(q) ||
    r.driver.toLowerCase().includes(q) ||
    String(r.token).includes(q)
  );
  if (!recs.length) {
    el.innerHTML = '<div class="empty"><div class="ei">📋</div><p>No records found</p></div>';
    return;
  }

  window._recMap = {};
  recs.forEach(r => { window._recMap[String(r.id)] = r; });

  el.innerHTML = recs.map(r => {
    const isIn         = r.status === 'IN';
    const amtText      = r.amount != null ? 'Rs.' + r.amount.toLocaleString('en-IN') : '--';
    const phoneRow     = r.phone !== '--'
      ? `<span><span style="font-size:9px">PHONE</span><b style="color:var(--blue)">${r.phone}</b></span>`
      : '<span></span>';
    const entryTimeStr = r.entryTime ? ' ' + to12h(r.entryTime) : '';
    const exitTimeStr  = r.exitTime  ? ' ' + to12h(r.exitTime)  : '';
    const entryFull    = r.entryDisplay + entryTimeStr;
    const exitFull     = isIn ? '--' : (r.exitDisplay || '--') + exitTimeStr;
    const rid          = String(r.id);
    const entryBtn     = isIn
      ? `<button class="btn btn-sm btn-primary" onclick="showEntryReceipt(window._recMap['${rid}'])">Receipt</button>`
      : '';
    const exitBtn      = !isIn
      ? `<button class="btn btn-sm btn-ghost" onclick="showExitReceipt(window._recMap['${rid}'])">Receipt</button>`
      : '';
    return `
      <div class="rec-card ${isIn ? 'in' : 'out'}">
        <div class="rc-top">
          <span class="rc-token">#${r.token}</span>
          <span class="rc-lorry">${r.lorry}</span>
          <span class="badge ${isIn ? 'badge-in' : 'badge-out'}">${isIn ? 'PARKED' : 'EXITED'}</span>
        </div>
        <div class="rc-meta">
          <span><span style="font-size:9px">DRIVER</span><b>${r.driver}</b></span>
          ${phoneRow}
          <span><span style="font-size:9px">ENTRY</span><b>${entryFull}</b></span>
          <span><span style="font-size:9px">EXIT</span><b>${exitFull}</b></span>
        </div>
        <div class="rc-foot">
          <div class="rc-amt">${amtText}</div>
          <div class="rc-acts">
            ${entryBtn}${exitBtn}
            <button class="btn btn-sm btn-red-sm" onclick="deleteRecord('${rid}')">Del</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════
//  MONTHLY REVENUE SECTION
// ══════════════════════════════════════════════════════════════

// Get all months that have at least one exit, sorted newest first
function getAvailableMonths() {
  const months = new Set();
  months.add(currentYearMonth()); // always include current month
  db.filter(r => r.status === 'OUT' && r.exitDate)
    .forEach(r => months.add(r.exitDate.slice(0, 7)));
  return Array.from(months).sort((a, b) => b.localeCompare(a));
}

// Compute revenue stats for a YYYY-MM month string
function getMonthStats(ym) {
  const recs   = db.filter(r => r.status === 'OUT' && r.exitDate && r.exitDate.startsWith(ym));
  const revenue = recs.reduce((s, r) => s + (r.amount || 0), 0);
  const exits   = recs.length;
  // entries this month
  const entries = db.filter(r => r.entryDate && r.entryDate.startsWith(ym)).length;
  return { ym, revenue, exits, entries, recs };
}

// Render the monthly revenue browser card
function renderMonthlyRevenue() {
  const container = document.getElementById('monthlyRevenueCard');
  if (!container) return;

  const months  = getAvailableMonths();
  const selEl   = document.getElementById('monthPicker');
  const selected = selEl ? selEl.value : currentYearMonth();
  const stats   = getMonthStats(selected);

  // Populate month picker options
  if (selEl) {
    const curVal = selEl.value || currentYearMonth();
    // Build option set from available months + current picker value
    const allMonths = new Set([...months, curVal]);
    const sorted    = Array.from(allMonths).sort((a, b) => b.localeCompare(a));
    selEl.innerHTML = sorted.map(m =>
      `<option value="${m}" ${m === curVal ? 'selected' : ''}>${monthLabel(m)}</option>`
    ).join('');
  }

  // Daily breakdown for the selected month
  const dayMap = {};
  stats.recs.forEach(r => {
    const day = r.exitDate;
    if (!dayMap[day]) dayMap[day] = { count: 0, amount: 0 };
    dayMap[day].count++;
    dayMap[day].amount += (r.amount || 0);
  });
  const days = Object.entries(dayMap).sort((a, b) => b[0].localeCompare(a[0]));

  // Peak day
  let peakDay = null, peakAmt = 0;
  days.forEach(([d, v]) => { if (v.amount > peakAmt) { peakAmt = v.amount; peakDay = d; } });

  const breakdownHtml = days.length
    ? days.map(([d, v]) => `
        <div class="mrev-day-row ${d === peakDay ? 'mrev-peak' : ''}">
          <div class="mrev-day-date">${formatDate(d)}</div>
          <div class="mrev-day-count">${v.count} exit${v.count !== 1 ? 's' : ''}</div>
          <div class="mrev-day-amt">Rs.${v.amount.toLocaleString('en-IN')}</div>
        </div>`).join('')
    : `<div class="empty" style="padding:20px 0"><div class="ei" style="font-size:28px">📭</div><p>No exits this month</p></div>`;

  const isCurrentMonth = selected === currentYearMonth();
  const currentLabel   = isCurrentMonth
    ? '<span style="color:#f59e0b;font-size:10px;letter-spacing:1px"> ★ THIS MONTH</span>'
    : '';

  document.getElementById('mrevLabel').innerHTML      = monthLabel(selected) + currentLabel;
  document.getElementById('mrevRevenue').textContent  = 'Rs.' + stats.revenue.toLocaleString('en-IN');
  document.getElementById('mrevExits').textContent    = stats.exits;
  document.getElementById('mrevEntries').textContent  = stats.entries;
  document.getElementById('mrevBreakdown').innerHTML  = breakdownHtml;

  const avgEl = document.getElementById('mrevAvg');
  if (avgEl) avgEl.textContent = stats.exits > 0
    ? 'Rs.' + Math.round(stats.revenue / stats.exits).toLocaleString('en-IN') + ' avg/exit'
    : '—';
}

function onMonthPickerChange() {
  renderMonthlyRevenue();
}

// Navigate months: dir = -1 (previous) or +1 (next)
function shiftMonth(dir) {
  const selEl = document.getElementById('monthPicker');
  if (!selEl || !selEl.value) return;
  const [y, m] = selEl.value.split('-').map(Number);
  const d = new Date(y, m - 1 + dir, 1);
  const newYm = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

  // Add option if not already present
  const exists = Array.from(selEl.options).some(o => o.value === newYm);
  if (!exists) {
    const opt = document.createElement('option');
    opt.value = newYm;
    opt.textContent = monthLabel(newYm);
    // Insert in sorted order
    const options = Array.from(selEl.options);
    const idx = options.findIndex(o => o.value < newYm);
    if (idx === -1) selEl.appendChild(opt);
    else selEl.insertBefore(opt, options[idx]);
  }
  selEl.value = newYm;
  renderMonthlyRevenue();
}

// ── STATS ─────────────────────────────────────────────────────
function updateStats() {
  const today  = localDateStr();
  const ym     = currentYearMonth();  // e.g. "2026-04"

  const parked = db.filter(r => r.status === 'IN').length;
  const tEnt   = db.filter(r => r.entryDate === today).length;
  const tExit  = db.filter(r => r.status === 'OUT' && r.exitDate === today).length;
  const tRev   = db.filter(r => r.status === 'OUT' && r.exitDate === today)
                   .reduce((s, r) => s + (r.amount || 0), 0);
  const total  = db.length;
  const exited = db.filter(r => r.status === 'OUT').length;

  // ── Monthly revenue (auto-resets each calendar month) ────────────
  const mRev = db
    .filter(r => r.status === 'OUT' && r.exitDate && r.exitDate.startsWith(ym))
    .reduce((s, r) => s + (r.amount || 0), 0);

  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('s-parked',   parked);
  set('s-today',    tEnt);
  set('s-exits',    tExit);
  set('s-rev',      'Rs.' + tRev.toLocaleString('en-IN'));
  set('s-total',    total);
  set('s-p2',       parked);
  set('s-exited',   exited);
  set('s-totalrev', 'Rs.' + mRev.toLocaleString('en-IN'));  // ← now shows THIS month
}

// ── DELETE / CLEAR ────────────────────────────────────────────
async function deleteRecord(id) {
  if (!confirm('Delete this record?')) return;
  if (backendOnline) {
    try { await apiFetch(`/records/${id}`, { method: 'DELETE' }); }
    catch (e) { notify('Server error: ' + e.message, 'error'); return; }
  }
  db = db.filter(r => String(r.id) !== String(id));
  saveLocal();
  renderRecords(); updateStats(); refreshToken();
  notify('Record deleted', 'info');
}

async function clearAllData() {
  if (!confirm('Delete ALL records permanently? This cannot be undone.')) return;
  if (backendOnline) {
    try { await apiFetch('/records', { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE_ALL' }) }); }
    catch (e) { notify('Server error: ' + e.message, 'error'); return; }
  }
  db = [];
  saveLocal();
  renderRecords(); renderRecent(); renderParked(); updateStats(); refreshToken();
  notify('All data cleared', 'info');
}

// ── IMPORT EXCEL ──────────────────────────────────────────────
function importExcel(event) {
  const file = event.target.files[0];
  if (!file) return;
  const st = document.getElementById('importStatus');
  st.textContent = 'Reading file...';
  const reader = new FileReader();
  reader.onload = async function(e) {
    try {
      const wb   = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
      let added  = 0;
      if (backendOnline) {
        const payload = rows.map(row => ({
          lorry:     (row['Lorry Number'] || row['lorry'] || '').toString(),
          driver:    row['Driver Name']  || row['driver']  || '--',
          phone:     row['Driver Phone'] || row['phone']   || '--',
          remarks:   row['Remarks']      || row['remarks'] || '--',
          token:     row['Token'] ? parseInt(row['Token']) : undefined,
          entryDate: row['Entry Date'] ? new Date(row['Entry Date']).toISOString().split('T')[0] : undefined,
          entryTime: row['Entry Time'] ? to24h(String(row['Entry Time'])) : undefined,
          exitDate:  row['Exit Date']  ? new Date(row['Exit Date']).toISOString().split('T')[0]  : undefined,
          exitTime:  row['Exit Time']  ? to24h(String(row['Exit Time']))  : undefined
        })).filter(r => r.lorry.trim());
        const resp = await apiFetch('/import', { method: 'POST', body: JSON.stringify({ records: payload }) });
        added = resp.added;
        await syncFromServer();
        st.textContent = resp.errors?.length
          ? `Imported ${added} records. ${resp.errors.length} errors skipped.`
          : `Imported ${added} records successfully!`;
      } else {
        let nxt = getNextToken();
        rows.forEach(row => {
          const lorry = (row['Lorry Number'] || row['lorry'] || '').toString().toUpperCase().trim();
          if (!lorry) return;
          const entryDate = row['Entry Date'] ? new Date(row['Entry Date']).toISOString().split('T')[0] : localDateStr();
          const entryTime = row['Entry Time'] ? to24h(String(row['Entry Time'])) : null;
          const exitDate  = row['Exit Date']  ? new Date(row['Exit Date']).toISOString().split('T')[0]  : null;
          const exitTime  = row['Exit Time']  ? to24h(String(row['Exit Time']))  : null;
          const bill      = exitDate ? calcBilling(entryDate, entryTime || '00:00', exitDate, exitTime || '23:59') : null;
          db.push({
            id: Date.now() + added,
            token: parseInt(row['Token']) || nxt++,
            lorry, status: exitDate ? 'OUT' : 'IN',
            driver:       row['Driver Name']  || '--',
            phone:        row['Driver Phone'] || '--',
            remarks:      row['Remarks']      || '--',
            entryDate, entryTime, entryDisplay: formatDate(entryDate),
            exitDate,  exitTime,  exitDisplay:  exitDate ? formatDate(exitDate) : '--',
            durationMin: bill ? bill.totalMin : null,
            amount:      bill ? bill.amount   : null
          });
          added++;
        });
        saveLocal();
        st.textContent = `Imported ${added} records (offline)!`;
      }
      updateStats(); renderRecent(); refreshToken();
      notify('Imported ' + added + ' records', 'success');
    } catch (err) {
      st.textContent = 'Error: ' + err.message;
      notify('Import failed', 'error');
    }
  };
  reader.readAsArrayBuffer(file);
}

// ── EXPORT EXCEL ──────────────────────────────────────────────
function exportExcel(filter) {
  let recs  = db.slice();
  let fname = 'KPR_All';
  if (filter === 'in')  { recs = recs.filter(r => r.status === 'IN');  fname = 'KPR_Parked'; }
  if (filter === 'out') { recs = recs.filter(r => r.status === 'OUT'); fname = 'KPR_Exited'; }

  // Export by selected month if on records tab with month selected
  if (filter === 'month') {
    const selEl = document.getElementById('monthPicker');
    const ym = selEl ? selEl.value : currentYearMonth();
    recs  = db.filter(r => r.status === 'OUT' && r.exitDate && r.exitDate.startsWith(ym));
    fname = 'KPR_' + ym;
  }

  if (!recs.length) { notify('No records to export', 'error'); return; }
  const data = recs.map((r, i) => ({
    'Token No.':      '#' + (r.token || '--'),
    'S.No':           i + 1,
    'Lorry Number':   r.lorry,
    'Driver Name':    r.driver,
    'Driver Phone':   r.phone   || '--',
    'Remarks':        r.remarks,
    'Entry Date':     r.entryDate  ? formatDate(r.entryDate) : '--',
    'Entry Time':     r.entryTime  ? to12h(r.entryTime)      : '--',
    'Exit Date':      r.exitDate   ? formatDate(r.exitDate)  : '--',
    'Exit Time':      r.exitTime   ? to12h(r.exitTime)       : '--',
    'Duration':       r.durationMin != null ? fmtDuration(Math.max(1, Math.round(r.durationMin / 1440))) : '--',
    'Rate/Day(Rs.)':  dailyRate,
    'Amount (Rs.)':   r.amount != null ? r.amount : '--',
    'Status':         r.status === 'IN' ? 'PARKED' : 'EXITED'
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Records');
  ws['!cols'] = [
    {wch:10},{wch:5},{wch:16},{wch:16},{wch:14},{wch:20},
    {wch:13},{wch:11},{wch:12},{wch:11},{wch:22},{wch:12},{wch:12},{wch:10}
  ];
  XLSX.writeFile(wb, fname + '_' + localDateStr() + '.xlsx');
  notify('Exported ' + recs.length + ' records', 'success');
}

// ── INIT ──────────────────────────────────────────────────────
async function fullRefresh() {
  await syncFromServer();
  showOnlineStatus();
  updateStats(); refreshToken(); renderRecent(); renderParked(); renderRecords();
  renderMonthlyRevenue();
}

document.addEventListener('DOMContentLoaded', async function () {
  const rateEl = document.getElementById('hourlyRateInput') || document.getElementById('dailyRateInput');
  if (rateEl) rateEl.value = dailyRate;
  document.getElementById('rateShow').textContent = dailyRate;

  const today = localDateStr();
  const now   = liveTime24();
  const _ed = document.getElementById('entryDateInput');
  const _et = document.getElementById('entryTimeInput');
  if (_ed) _ed.value = today;
  if (_et) _et.value = now;
  syncExitDateTime();

  if (_ed) {
    _ed.addEventListener('focus', () => { entryDateManual = true; });
    _ed.addEventListener('input', () => { entryDateManual = true; });
  }
  if (_et) {
    _et.addEventListener('focus', () => { entryTimeManual = true; });
    _et.addEventListener('input', () => { entryTimeManual = true; });
  }
  const _xd = document.getElementById('exitDateInput');
  const _xt = document.getElementById('exitTimeInput');
  if (_xd) {
    _xd.addEventListener('focus', () => { exitDateManual = true; });
    _xd.addEventListener('input', () => { exitDateManual = true; });
  }
  if (_xt) {
    _xt.addEventListener('focus', () => { exitTimeManual = true; });
    _xt.addEventListener('input', () => { exitTimeManual = true; });
  }

  // Init month picker to current month
  const selEl = document.getElementById('monthPicker');
  if (selEl) selEl.value = currentYearMonth();

  startEntryTimeTick();

  await fullRefresh();

  setInterval(fullRefresh, 15000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') fullRefresh();
  });

  window.addEventListener('pageshow', (e) => {
    if (e.persisted) fullRefresh();
  });

  window.addEventListener('focus', fullRefresh);
});

// ── Pull to Refresh ───────────────────────────────────────────
(function initPullToRefresh() {
  const THRESHOLD = 65;
  let startY = 0, currentY = 0, pulling = false, refreshing = false;

  const body     = document.getElementById('appBody');
  const ptr      = document.getElementById('ptrIndicator');
  const spinner  = document.getElementById('ptrSpinner');
  const ptrText  = document.getElementById('ptrText');

  if (!body || !ptr) return;

  body.addEventListener('touchstart', (e) => {
    if (body.scrollTop !== 0 || refreshing) return;
    startY  = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });

  body.addEventListener('touchmove', (e) => {
    if (!pulling || refreshing) return;
    currentY = e.touches[0].clientY;
    const dist = Math.min(currentY - startY, THRESHOLD + 20);
    if (dist <= 0) return;

    const pct = Math.min(dist / THRESHOLD, 1);
    ptr.style.transform = `translateY(${-52 + 52 * pct}px)`;
    ptr.classList.add('ptr-visible');
    ptr.classList.remove('ptr-ready', 'ptr-loading');
    if (dist >= THRESHOLD) {
      ptr.classList.add('ptr-ready');
      ptrText.textContent = 'Release to refresh';
    } else {
      ptrText.textContent = 'Pull to refresh';
    }
    spinner.style.transform = `rotate(${pct * 180}deg)`;
  }, { passive: true });

  body.addEventListener('touchend', async () => {
    if (!pulling) return;
    pulling = false;
    const dist = currentY - startY;
    if (dist >= THRESHOLD && !refreshing) {
      refreshing = true;
      ptr.classList.add('ptr-loading');
      ptr.classList.remove('ptr-ready');
      ptr.style.transform = 'translateY(0)';
      spinner.style.transform = '';
      ptrText.textContent = 'Refreshing...';
      await fullRefresh();
      notify('Data refreshed', 'success');
      refreshing = false;
    }
    ptr.style.transition = 'transform 0.25s ease';
    ptr.style.transform  = 'translateY(-52px)';
    setTimeout(() => {
      ptr.classList.remove('ptr-visible', 'ptr-ready', 'ptr-loading');
      ptr.style.transition = '';
      ptrText.textContent = 'Pull to refresh';
    }, 250);
    startY = 0; currentY = 0;
  }, { passive: true });
})();