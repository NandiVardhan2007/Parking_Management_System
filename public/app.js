/* ============================================================
   KPR TRANSPORT - PARKING MANAGEMENT SYSTEM
   app.js  —  DAY-WISE BILLING

   BILLING MODEL:
   - Day-wise billing based on calendar date difference
   - Entry 01/02/26, Exit 04/02/26 = 3 days billed
   - Amount = (exitDate − entryDate) days × daily_rate
   - Minimum charge: 1 day

   TIME INPUTS:
   - Auto-populated with live current time on page/tab open
   - User can manually edit any time field
   - "↺ Now" button instantly resets to current time
   - Times sent to print server as "09:57 AM" format
   ============================================================ */

// ── API Config ───────────────────────────────────────────────
const API = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? `http://${window.location.hostname}:3000/api`
  : `${window.location.origin}/api`;

const PRINT_SECRET = 'KPR2024SECRET';

// ── Google Sheets Backup ─────────────────────────────────────
// Handled by Flask backend (server.py). Set env vars on Render:
//   GSHEET_ENTRY_URL = your entry sheet Apps Script URL
//   GSHEET_EXIT_URL  = your exit sheet Apps Script URL

// ── Data Store ───────────────────────────────────────────────
// localStorage is a fallback ONLY for true offline — always prefer server data
let db              = [];          // start empty, fill from server first
let dailyRate       = parseInt(localStorage.getItem('kpr_rate') || '130');
let recFilterStatus = 'all';
let backendOnline   = false;
let initialSyncDone = false;

// ── API helpers ──────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const res  = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
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
    // Update rate input if visible
    const rateEl = document.getElementById('hourlyRateInput') || document.getElementById('dailyRateInput');
    if (rateEl) rateEl.value = dailyRate;
    const rateShow = document.getElementById('rateShow');
    if (rateShow) rateShow.textContent = dailyRate;
  } catch (_) {
    backendOnline = false;
    if (!initialSyncDone) {
      // First load failed — fall back to localStorage so app still works offline
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
  // Force Asia/Kolkata so clock is correct even on UTC servers
  document.getElementById('clockTime').textContent =
    now.toLocaleTimeString('en-IN', { hour12: true, timeZone: 'Asia/Kolkata' });
  document.getElementById('clockDate').textContent =
    now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}
setInterval(tick, 1000);
tick();

// ── Date/Time helpers ────────────────────────────────────────

// ── IST helpers (Asia/Kolkata, UTC+5:30) ────────────────────
// Uses Intl.DateTimeFormat — correct on ALL devices/servers
// regardless of local timezone setting (UTC, IST, PST, etc.)

/**
 * Extract IST date+time parts from any Date object.
 * Pure function — testable with any timestamp.
 */
function _istParts(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year:     'numeric',
    month:    '2-digit',
    day:      '2-digit',
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  return {
    year:    p.year,
    month:   p.month,
    day:     p.day,
    hours:   p.hour === '24' ? '00' : p.hour,   // midnight edge case
    minutes: p.minute
  };
}

/** Returns today's date as "YYYY-MM-DD" in IST */
function localDateStr() {
  const p = _istParts(new Date());
  return `${p.year}-${p.month}-${p.day}`;
}

/** Returns current time as "HH:MM" (24h) in IST */
function liveTime24() {
  const p = _istParts(new Date());
  return `${p.hours}:${p.minutes}`;
}

/** "HH:MM" (24h) → "09:57 AM" */
function to12h(t24) {
  if (!t24) return '';
  try {
    const [h, m] = t24.split(':').map(Number);
    const ampm   = h >= 12 ? 'PM' : 'AM';
    const h12    = h % 12 || 12;
    return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
  } catch (e) { return t24; }
}

/** "09:57 AM" → "HH:MM" (24h) */
function to24h(t12) {
  if (!t12) return '';
  const m = t12.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return t12.slice(0, 5);
  let h = parseInt(m[1]);
  if (m[3].toUpperCase() === 'PM' && h !== 12) h += 12;
  if (m[3].toUpperCase() === 'AM' && h === 12)  h  = 0;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/** Calendar days between two date strings (exit − entry). Minimum 1. */
function daysBetween(entryDate, exitDate) {
  try {
    const a = new Date(entryDate + 'T00:00:00');
    const b = new Date(exitDate  + 'T00:00:00');
    const diff = Math.round((b - a) / 86400000); // ms per day
    return Math.max(1, diff);
  } catch (e) { return 1; }
}

/** Format days as "3 Days" / "1 Day" */
function fmtDuration(days) {
  return days + ' Day' + (days !== 1 ? 's' : '');
}

/** Full billing calc → { days, display, amount } */
function calcBilling(entryDate, entryTime, exitDate, exitTime) {
  const days = daysBetween(entryDate, exitDate || localDateStr());
  return {
    days,
    totalMin:       days * 1440,  // kept for legacy compat
    billableHours:  days * 24,    // kept for legacy compat
    display: fmtDuration(days),
    amount:  days * dailyRate
  };
}

// ── Date/Time input init ──────────────────────────────────────
function initAllDateTimeInputs() {
  const today = localDateStr();
  const now   = liveTime24();
  const ed = document.getElementById('entryDateInput');
  const et = document.getElementById('entryTimeInput');
  if (ed && !ed.value) ed.value = today;
  if (et && !et.value) et.value = now;
  // Exit date/time always use current time — updated via syncExitDateTime()
  syncExitDateTime();
}

/** Always keep hidden exit date/time in sync with live clock */
function syncExitDateTime() {
  const ed = document.getElementById('exitDateInput');
  const et = document.getElementById('exitTimeInput');
  // Only auto-fill if user hasn't manually set them
  if (ed && !exitDateManual) ed.value = localDateStr();
  if (et && !exitTimeManual) et.value = liveTime24();
}

/** Track if user manually changed entry or exit time/date */
let entryTimeManual = false;
let entryDateManual = false;
let exitTimeManual  = false;
let exitDateManual  = false;

/** Live auto-tick for entry time — stops once user manually edits */
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
    // Exit date/time: only auto-fill if user hasn't manually edited them
    const _xd = document.getElementById('exitDateInput');
    const _xt = document.getElementById('exitTimeInput');
    if (_xd && !exitDateManual) _xd.value = localDateStr();
    if (_xt && !exitTimeManual) _xt.value = liveTime24();
  }, 10000); // refresh every 10s
}

// ── Navigation ───────────────────────────────────────────────
function goTab(tab, btn) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('panel-' + tab).classList.add('active');
  btn.classList.add('active');
  document.getElementById('appBody').scrollTop = 0;
  if (tab === 'exit') {
    // Only auto-fill exit date/time when switching tabs if not manually set
    const _xd = document.getElementById('exitDateInput');
    const _xt = document.getElementById('exitTimeInput');
    if (_xd && !exitDateManual) _xd.value = localDateStr();
    if (_xt && !exitTimeManual) _xt.value = liveTime24();
    renderParked();
  }
  if (tab === 'records') renderRecords();
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
  // Append IST midnight offset so JS parses in IST, not UTC
  try {
    if (!dateStr) return '--';
    const d = new Date(dateStr + 'T00:00:00+05:30');
    return d.toLocaleDateString('en-IN', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      timeZone: 'Asia/Kolkata'
    });
  } catch (e) { return dateStr; }
}


// ── ENTRY ────────────────────────────────────────────────────
async function recordEntry() {
  const lorryInput = document.getElementById('entryLorry');
  const lorry      = lorryInput.value.trim().toUpperCase();
  if (!lorry) { notify('Enter lorry number!', 'error'); return; }

  const dup = db.find(r => r.lorry === lorry && r.status === 'IN');
  if (dup) { notify('WARNING: ' + lorry + ' already parked! Serial #' + dup.token, 'error'); return; }

  const entryDate = document.getElementById('entryDateInput').value || localDateStr();
  const entryTime = document.getElementById('entryTimeInput').value || liveTime24();
  // Always have a live fallback — no error needed

  const payload = {
    lorry,
    driver:    document.getElementById('entryDriver').value.trim()  || '--',
    phone:     document.getElementById('entryPhone').value.trim()   || '--',
    remarks:   document.getElementById('entryRemarks').value.trim() || '--',
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
    } catch (e) { notify('Server error: ' + e.message, 'error'); return; }
  } else {
    const token = getNextToken();
    rec = {
      id: Date.now(), token, lorry,
      driver:       payload.driver,
      phone:        payload.phone,
      remarks:      payload.remarks,
      entryDate,    entryTime,
      entryDisplay: formatDate(entryDate),
      exitDate:     null, exitTime: null,
      exitDisplay:  '--',
      durationMin:  null, amount: null,
      status:       'IN'
    };
    db.unshift(rec);
    saveLocal();
    notify('Saved locally (offline mode)', 'info');
  }

  updateStats(); refreshToken(); renderRecent();
  notify('Serial #' + rec.token + ' — ' + lorry + ' entered', 'success');
  showEntryReceipt(rec);
  clearEntry();
}

function clearEntry() {
  ['entryLorry', 'entryDriver', 'entryPhone', 'entryRemarks'].forEach(id => {
    document.getElementById(id).value = '';
  });
  // Reset date/time back to live auto-fill
  entryDateManual = false;
  entryTimeManual = false;
  document.getElementById('entryDateInput').value = localDateStr();
  document.getElementById('entryTimeInput').value = liveTime24();
}

// ── EXIT — LOOKUP ────────────────────────────────────────────
function lookupToken(val) {
  const errEl = document.getElementById('exitError');
  const card  = document.getElementById('lookupCard');
  errEl.style.display = 'none';
  card.style.display  = 'none';

  const num = parseInt(val);
  if (!val || isNaN(num)) return;

  const rec = db.find(r => r.token === num);
  if (!rec) {
    errEl.textContent   = 'Serial #' + num + ' not found.';
    errEl.style.display = 'block';
    return;
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

// ── EXIT — LOOKUP BY LORRY NUMBER ────────────────────────────
function lookupByLorry(val) {
  const errEl   = document.getElementById('exitError');
  const card    = document.getElementById('lookupCard');
  const lorryIn = val.trim().toUpperCase();

  if (!lorryIn) {
    errEl.style.display = 'none';
    card.style.display  = 'none';
    return;
  }

  // Find all currently parked vehicles matching the lorry number
  const matches = db.filter(r => r.lorry === lorryIn && r.status === 'IN');

  if (!matches.length) {
    // Maybe it already exited?
    const exited = db.find(r => r.lorry === lorryIn && r.status === 'OUT');
    errEl.textContent   = exited
      ? `${lorryIn} already exited (Token #${exited.token})`
      : `No active parking record found for "${lorryIn}".`;
    errEl.style.display = 'block';
    card.style.display  = 'none';
    document.getElementById('exitToken').value = '';
    return;
  }

  // Pick the latest entry (highest token) if multiple
  const rec = matches.reduce((a, b) => (a.token > b.token ? a : b));

  errEl.style.display = 'none';
  // Fill token field and trigger normal lookup
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
  const phoneRow  = rec.phone   !== '--' ? `<div class="rr"><span>Phone Number</span><span>${rec.phone}</span></div>`   : '';
  const remarkRow = rec.remarks !== '--' ? `<div class="rr"><span>Remarks</span><span>${rec.remarks}</span></div>` : '';
  const timeStr   = rec.entryTime ? to12h(rec.entryTime) : to12h(liveTime24());

  const driverRow2 = rec.driver !== '--' ? `<tr><td>Driver&nbsp;&nbsp;&nbsp;:</td><td>${rec.driver}</td></tr>` : '';
  const mobileRow2 = rec.phone  !== '--' ? `<tr><td>Mobile&nbsp;&nbsp;&nbsp;:</td><td>${rec.phone}</td></tr>` : '';
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
  // Print is only sent when user taps the 🖨 Print button
}

function showExitReceipt(rec) {
  const phoneRow  = rec.phone   !== '--' ? `<div class="rr"><span>Phone</span><span>${rec.phone}</span></div>`   : '';
  const remarkRow = rec.remarks !== '--' ? `<div class="rr"><span>Remarks</span><span>${rec.remarks}</span></div>` : '';

  const entryTimeStr = rec.entryTime ? to12h(rec.entryTime) : '';
  const exitTimeStr  = rec.exitTime  ? to12h(rec.exitTime)  : to12h(liveTime24());

  // Re-compute for display (in case fields came from server without durationMin)
  let durDisplay, amount;
  if (rec.durationMin != null && rec.amount != null) {
    // durationMin is now stored as days for day-wise billing
    const days = rec.days != null ? rec.days : Math.round(rec.durationMin / 1440);
    durDisplay = fmtDuration(Math.max(1, days));
    amount     = rec.amount;
  } else {
    const bill = calcBilling(rec.entryDate, rec.entryTime || '00:00', rec.exitDate, rec.exitTime || liveTime24());
    durDisplay = bill.display;
    amount     = bill.amount;
  }

  const driverRowX  = rec.driver  !== '--' ? `<tr><td>Driver&nbsp;&nbsp;&nbsp;:</td><td>${rec.driver}</td></tr>` : '';
  const mobileRowX  = rec.phone   !== '--' ? `<tr><td>Mobile&nbsp;&nbsp;&nbsp;:</td><td>${rec.phone}</td></tr>` : '';
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
          src="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAYGBgYHBgcICAcKCwoLCg8ODAwODxYQERAREBYiFRkVFRkVIh4kHhweJB42KiYmKjY+NDI0PkxERExfWl98fKcBBgYGBgcGBwgIBwoLCgsKDw4MDA4PFhAREBEQFiIVGRUVGRUiHiQeHB4kHjYqJiYqNj40MjQ+TERETF9aX3x8p//CABEIAqoCuAMBIgACEQEDEQH/xAAtAAEAAwEBAQEAAAAAAAAAAAAABAUGBwMCAQEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEAMQAAAC1QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKvN32OLN8/QAAPA99pzjopBzelzRtPTy9Rjtjz4kocwW2Zsza47Q5wsdFlrksFeLBX2AAQfksMdoc4WOizuiMd4e8E91ZYlxostcmen52ebVX2AAq7SlKHac46KQc3pc0bT08vw9lePPN2ObOj186rKFWWJ9AAAPCGdH9PH2AAAAAAKXHbHHHRfbxglow43DDjcUttUmO6Lzrop7KvNm4edeWnPpNeXWuyOuOfRZUwqeixZ5TY7Y44FsVPRYucNmzuiOfRZUUdF510U9gKWogkPovOuilXjtjjgWxU9Fi5w2bDjcUtsOcdFi5w2bO6IUt15nOG7xZ4A6LV2lWY7ovOuinsq82bhhxuGH2hU47Y446L7ePsAAAAAAUuO2OOOi1dpVmOAB0WrtKsx3ReddFIWa3AqY2dsyK3AzuiDHSNTSkphBpM2FjY6OrJWL8BbaXCD38AbPGDoUnI64598fdmRdFbc+LrNgtqkbvOU/RTDQ9jjjZyMIN3i/AW2lwg3fvz29Ndz7oPPj4mStceVVdUpjui866KVeO2OOAHReddFKvHbHHHRfbx9gAAAAAClx2xxx0WrtIRh1mKxZjZVdrVGO6LzropBzelzRoosqMUwANpU+kYyazryz0ua0pP8AiH7ngsIJ8gxfhcQyGWJFmBX+kzwPfRYrZkh7yTnfhK+DwsfoeEOzFZbVlmaXF7TFk/S0OuK/2leJ7QfmwIsoFLdUpjui866KVeO3GaKxZis6LjdmVWO2OOOi+3j7AAAAAAFLjtjjjovthfo3DDjcMONxS0PgQ+i866KeyrzZGs7iKaBh9oeirzZGs7iKaDn0nRGKaXNC9to5oOfSdEYppc0dFq7SrMd0XnXRT2VebNxS21SY42ZU67P05Gs7iKaBh9oeirzZGi7WvM0bMqddn6c3FLbVJjui866KeyrzZuKW2qTHdF51Ym6YcbhhxuGHF9jpkM6L7ePsAAAAAAVma3Aw7cDDtwMO3Aw7cDD7P1FLjtjjjZ+GTvSLs/UVma3Aqa6lijovOuilXjtjjjZwM2HReddFKvHbHHHRau0qzHdF510UhZrcDyqrqlMds8YNJmw2cDNhs8YNZTStcVNdSxR0XnXRSrx2xxxs/DJ3pF0Vtz40VNK1x5QbMYduBh24GHbgYduBh24Hl6gAAAAAAAQfUkgPGKZ7w9fIbTF6IsoYYtY+QK802ixWlPr5e54ZzZ8+PqGC2qbY0uc0ecIcOZDOi1dpVmOsa6xPp4Qyz8IYbPGdFM/mtxmjQQdDVGOLEma7O6Ig/P18jOaPOEq5rdEV/t5/JYQfmwM/T32OOj1/nAK7ac42Z6ZuxzZ0evnVZQ7TnHRSDm77HHR/Tx9gAAAAAADn1noK00DD7QqcdsccdF9sL9G459J0RimlzR0X28YJac+k158LbSmEvb6vNBz6TojFN2MI3YwnRYs8psdsccdFq7SrMd0XnViaDHaK5MI3YwnRYs8/VXmzcUttUmO6Lzrop7KvNkaL9/A6LzqxN0zuiOfRd78mE6LFnlNjtjjgAbMxjdiVV00ozvRYucLnHTIZ0X28fYAAAAAA8YsXHG7gZO9Iuz9RS47Y44sfrZexh9Fbc+NFTStceUGzGHbgZa5i443dRmw6LzrooixccdLePsIM7nxoqaVrjyg2Yw9f0jnxM0uEG7YQbuw5p0UhZrcDyqrqlMd0XnXRSFmtwMO3Aw9f0jnxZ67I64g+uHszXQZ3PjRU0rXHN/iVFHReddFPYGOn6IOfdB58RQdF9vH2AAAAAAPOHYDndt8SDU47Q4s9YYWP1We5M0Wd0RMlRpIq7SsM1tMXsz9h2A534XUEh2NcJkP3mHz9V/wWeixWzJ0qvGen11iaKDOglPmtZTGgkePsM5o8WaLRYrSmekRZRc5zR5wsdFlrkz0+usTRc+6DjismeEM+/Tw9yZos7oiZKjSTn0yHMNLPgDzzdjmzo/p4+w590HHFKsxsvby9QAAAAAABS3Xmc4bvFngBe0XudE59Jry613O5huGHG4YfaHoBS3Xmc4bsUOuz9ORov3ZlS3YwjS5o6L7YW4NFz7oMEz+uiyjn0Xe/JhG7GEbsSqumhkPovOrE0GOmQzovthfo3DD7QqcdsccL22jmg59J0RT67P05Gi7X2MI3YwjS5o6L7YW4NEY42LDjcPP0AAAAAAPGLFxx0t4+wx2xGHbgYduBh24GAh7HHADZ4wbthBu/fnt6a6DO58aKmla4w9togBWZrcDm9nDim7sOadFPYEH5x0U3bCDdsIPd4XpFr+kc+PiZK1xh/Df0pjui866KQs1uB5VV1SmO2eMGsppWuKn2x0U3bCDWU0rXHN7OHFN3nKfophoexxx0X28fYAAAAAA84cqKZzyh+BZ7TnHRSDm77HHR6/z8CmB4Q5kM2cGd4GT2ef0RX5rSZs2c6DPJPPug8+LPXYrSmen52ebXHaHOHk8IZta/QVZjui866KQc3fY42vtHnnhi+ic+JmlodcV/t5+pJ590HnxZ67I64efoK/ObPHHgDaPz1K9YDP0+lzRX/Fn4EPZ4zZk6VGknPosr4PDouN0R547WUxsvby9QAAAAAClx2xxwbOQYTosWeU2O6PDMJe1I6Iw+0KnHbHHC9or013PugwTBN2MJe1Nsa7n3QYJgmlzQbOCZrovOuilXjtjjjotXQXhkeixpRWZXZ/BirnQyT059ucgSddzuYRrOlujXc+6Dz4s9dkdcCrLRh9oeirzZuGHG4YcbhhxuKW2HOG7xZba7ncwjWdxFNBz6Toin12fpzcPP0AAAAAAKzNbgeXqCDO58biTkdcc++PuzIuz9RS47Y44sbi89hBnc+NxJyOuOfWdZZmugzufGippWuPKquqUx2zxg1lbOtj6qczBLCvAB9fIuNPgB0LISNgc+vYcw12O2Iy1zFxx0usm+xh9n6iszW4GHbgYduBh24Hl6g590HnxFBs/DJ3pF0Vtz40VNK1x5eoAAAAAAVebvscWdtT3BoufdBxx967LXJjvix8gDwh2Y2XtU+xYQfmwIsoOffH3FLPRYropS0+lzRtH56lfUaeMR+f8A14gD19ukHMfLqXPCAABOgjptPntsZLaYvRFlDDOWOdnm1V4883Y5s6P6U8gsMdocWTFYOj+niPaD8gBX6ClKHRYrZk6VGkgAAAAAAFLjujwyV7fn6AUuO2OOOi+2F+jcMONww4jRfv4HRedWJumHEaL9/A6LzqxN0zuiDHfZrsHrecgAC1qh1PzwO/Ocxelc7PEADYY/3Onc+3fPT4W2lMI9/AGzMY3Ywjd1JmjZmMaXNHRavP8AkQwAdFq8/YmdbvFltrudzDcPP0AAAAAAPGLFxx0t4+wBS47Y44sfrZexh24GAh7HHD38L0i1/SOfEUFj9bL2MO3AzuiDHz9CMnlrapAP3oPPdcWqX7lbIqfw0Pj9/ZAxV9nyAADf03vqDO6IMd4bgYfRW3PjcScjriDXZ2zIuitufF1mwsfrZexh24GAh7HHC9or013Pug8+IoOi+3j7AAAAAAHnDsBjPL38BtMXsyqx2xxx0WDOhGa2mL2ZVY7Y442ceR4FNX2FeWelodcfn6AFXm77HHR/Tx9jm8KbCAAN9b1Fucs+fr5OkTYU05UAADSbHHbEPGKZ6fnbY10GcM/T32ONrFuoRmtFndEV+a0mbOiwZ0IzW0xezKrHbHHGznQZBYQfkHvJPz9AAAAAAAq82bhh7Y0Rji3x0yGdF9sL9G4YcX2OmQxe20c0HPpOiKfXRZQKstGH2hU47o8Mle2MtDP1OpywABubzC7o5xB6rHPGcHKgAAazU1FQWmOmQxe0XudEYfaFTjtjjjovthfo3HPpNefAOi+2F+jcMOL7HTIYABe67ncw3Dz9AAAAAACszW4HN7qsszXc+6Dz4+JkrXHN/T7syK3Aw7cCprqWKOi866KewFZZjD7P1HjFi44959SN5znf5kpgALyjG2+MYOn+0KacqAA9/DXmi5/d5095krXGH8N/SmO2eMGsppWuMO3Aw7cDDtwMO3Aw7cDDtwMP4b+lMdY13RTGtwPL1AAAAAAACD6efyWHPtjnD112d0Rz74s/AAA0Xt4+wnwLAPGKZ6fnZ5tcdoc4Q4cyGbORKHn9xrA5h49EwB5AAA1FlhQAJx67X0yRWfNnXl1rsjrjHQZ3gVmzz+iItPY5ss7bLXprsdscceDwhnR/SnkFgrx55u5pjaVPpXGb6LzrZnpm7mmNp6eXqAAAAAAAc+iyphU9Fizz9AKstGH2h6A59FlTCp6LFnlNjujwzCPeeVPRYs8psdsccdFq8/Ymd6LFzhs4eT9ypg9KqjFLKuPwA+j5XWlM3sfvzMhLvq80HPpOiKfXZ+nNw8/Qc+6Dz4irbSmEvb6vNAw4vsdorkwj38AbMqddFlHPosqKAXuu53MNw8/QAAAAAAAx0jU0pKsOadFEWLjjpdZN9jD7P1HjFi44959SN3Yc06KewOfWdZZmugzufGippWuOb2cOKbvOU/RTGtwMRZaWlPWfzob7zpdWRZP6Gc0YzuiCDXZ2zIuitufGippWuPL1Bz7oPPiZpcIN3Ayd6RW4GWuYuOPd4XpF2fqAOffH3ZkVuBgIexxx0X28fYAAAAAAq83fY46O+fYr5/6KXHbHHFj9VnuTCvJMP3mGgkePsJ8CwKvN6XNFfdUt0a7n3QefHxMhzCv+LPwIfReddFIOb0uaNorfYYvaZwrpnhDOj+lPPJOO2PPiShzDRTPX8PaD8j2lV4sKu0pSh0WK2ZBzWkzZs50GQWGO0OLLu5odcc7tqyzNcCrzd9jj7uodialX2BS47Y446L7ePsAAAAAAUuO2OOOi+3jBLRh9oVOO2OOF7bRzQc+k15da7I6459FlTCp6LFnn6Dn1nWWZrufdB58WeuyOuFLUSDO9Fi5w2bDiNF+7MqeixZ5TY7Y44XttOJXPugwTP66LKFLdeZzhuxhG7EqruaYxxszGNLmgWxUt3iy213O5hGs6X0OiMPtCpx3R4ZKq6aUZ3osXOFzjpkM6L7ePsAAAAAAUuO2OONnAzYdF510UhZrcDyg2Yw9f0jnxZ67I6459Z1lma6DO58bFhBcStHVkrOU/RTOXMXHHvbUV6a7n3QefEUC2qRu2EGsppWuKn2x0U3bCDoUnI64g+uHszXQZ3PjYsIN3Ayd6RdFbc+NFTStcc3uqyzNdz7oPPj4mStcc3+JUUdF510U9gY6fogx2xGAh7HHHRfbx9gAAAAAClx2xxxs5Er2K+f8Aoq83fY4s1Z7kzRZ3ZnlKCD6efyWEH5AGchzIZD6LzropV47Y442ce6hGa0Wd2Zns1sccAAXuuyOuOfTIdmX2L6Jjj712d0RBrdBWGa0Wd2Zns1uM0Vl7S3RrufdB58fEysG1i3UIzVfYV56TIcwr/izFZY/VeWCHMNp6VPsWGO0OLPWH7zDZe3l6gAAAAAFLjujwyV7YyxNEClx3R4ZhL2pHRGH2h6KvNkaLtfYwjd4s8AdFq8/5EPovOuilXjujwyV7fn6AUuO6PDMI9/AGzKnXZ+nI1nS3RrjHGxZ3RBjp5ogAc+s9BWmg59Jrz4W2lJXtjPI3HPpNeXWuyOuDHeBuOfSdEU+uiyjn0Xe05mgXuu53MNw8/QAAAAAAA59MhxTdsIOhScjrjHeG4GH0Vtz40VNK1x5fntSkrOU/RTGtwOb+n3ZkXRW3PjYsIN3789vTXA8YsXHHv4A2eMGsppWuMPP1NKSs5T9FKPRBjpGppSUwg6FJyOuINdnbMitwM7og598fdmRa/pHPiZpcILiHuasx2zxg6FJyOuINNSxRY13RTGtwPL1AAAAAACrzelzRX/FmKzZ5/ZnlKBV2lYZqvsBK12WuSwpbqlMd0XnXRT2eMUx3wEzRZ3ZkRKij2leJ7Y7Q4su7mh1xzvwlRQWJFmA8PfwIdjXWJ9AeHuKzZ5/REyVGknPvj7ilntOcbM9M3Y5s2sWRAK6v+ABY+Xr9FYsxDmeEM2tfoIRh7H6AG09PL1AAAAAACrzZuGHG4YcbhhxuGHG4YfaFTjujwyVV00Mh9F51Ymgx2iuTCXtSOiMPtCpx2xxx0WrtPo5w3YoddFlHPosqKOi866KeyrzZuKW2qTHdF510U9lXmzcMPbGi590GCZ/XRZRz6LKigBbaUwj38AbMxjS5o6L7eMEtGH2hU47Y446L7YX6Nww+0PRV5s3Dz9AAAAAAClx2xxxY/Wy9jDtwMO3Aw/hv6Ux3ReddFEWLjj38AAttLhB7vC9IuitufGippWuPL1ADxixccXEPc1Zjui866KQs1uB5VV1SmO6LzropV47Y44XtFemugzufG4k5HXGO8NwMO3Ay1zFxxceWy9jD6K258XWbDosKb7GH2fqKXHbHHD38L0i6K258XWbDovt4+wAAAAABS47Y446LBnVZQqwWasHR6m0qzHdF510U+odgOdz4cw0oKnNaymKz3mBos7oiLT3NMbT0qfYsMdocWesP3mHz5e/gQ7GusT6A8I3oeFj9V5f3Oa0or9BSlDX/ABYkzXZa5LA8T2x2hzhDh2Y+bjM2ZtYPyKnNaymPn6r/AEJgPCHMhj3leR71/wAWJ66WmuSf+gAAAAABS47Y446LV2lWY4AHRau0qzHdF510U9gc+iyphUt2KHXZ+nNw868tOfSdEU+uiyjn0Xe/JhG7xZba7ncw3FLbVJjui866KeyrzZGs6X0Oic+k158LbSkqruaYx3ReddFKvHdHhkqruaYx3ReddFPZV5sjRfv4AL3XZHXHPrOs+DojDi+x2iuSVV00Mh9F51Ymgx0yGdF9vH2AAAAAAKXHbHHHRYU32MO3Aw7cDyqrqlMd0XnXRT2BjpGppSUwg1lNK1xUxs7ZkXRW3PjcScjriD64ezNdz7oPPj4mStcVMbO2ZF2fqKXHbHHD38L0i1/SOfEzS4QdLrJvsYfZ+o8YsXHG7qM2HReddFKvHbHHFj9bL2MPX9I58WeuyOuOfRZUUAvddkdcY7w3Aw7cDAQ9jjjovt4+wAAAAABS47cZo+foAAHh7is6LjdmeoHn6CvWAz9Ppc0aKLdwTNV9gIcwK+6i2xooM4Z+n0uaK+6i2xosdsccQYdmNBHu4Jmq+wFYsx83FTbGix2xxxBh2YrFmKzouN2ZVY7cZo2Xt5eogzhFlBz6Z6TyyWAiygAApcduM0bL28vUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//8QAAv/aAAwDAQACAAMAAAAhAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA00888o8IQ8wQgAAAIQg84g4AAQo8IA8Q48888AAAAAAAUEMMAoMEIoQkU4kIUoAMoU4kMEkIE08AoMMIUAAAAAAAUA88AowkwAgM8AcM88oUw8sI0scMcA4goU8oUAAAAAAAUE88Io8488I4A0EA048c8I088gUIAQAAoc8sUAAAAAAAUMMMMoMcIMcM00M0AoMA4scIMY4sAoMAsMMMcAAAAAAAwwwwwwUsww0oU8oUAowg8888Y0oUswYwwwwwwgAAAAAAAMAA0sg04gkQ8oQ8A488ocI4goQAIQ0cs8Qo0AAAAAAAAcIUMM0EIw0MwwkUAsQwkMAoMUsIYkU84wIkcAAAAAAAEMwUQwYwwEcoEAQYwgMMIwgowwgo0QYUoAgA8AAAAAAAg4U888IUsg88808AwUUIUggQgwE8c8IAQ8AE8IAAAAAAAE088IsMIAEwsQw0MEgYwwMscMIU0MsYw0MEMAAAAAAAEAQwww088McQYgAwEIAkMM8g4wowg8YkMYEI0AAAAAAAg8o0Y88IscMAg4Q8go0sQIMAoQU8YA8csIUsUIAAAAAAUwkY8IU8Ew8E0woUEokUAsUAoEIMMMME0scMsAAAAAAAwgQoUwUAQoUQYg8MowAAgU8QEQwwwwwgA8swYgAAAAAA0wEgU88IQAU48YAYAYkAAQUsg4A8IU8AQAQ8IAAAAAAAYIAUMMMUsMUsIIEAAAcgAAAIw84ww40M88I0sAAAAAAAEAAUQw08g8QwAQoAsAcQoAAgAwwokw8Qw08A8AAAAAAAg8sUUsUYoIgA0AoAAAAAAAAAA8Q008cUsUIQIgAAAAAAMMEcMMc0MgEIYIAAAAEgAAAsc8IUMI8MMc88sAAAAAAAwUA4Uww0oAQwEs8AAAAgAAAU4w8YwwwwwwwowgAAAAAAAoAgc88oQA4Q8AAIAAAQAEQ4o8s88U8IA0Ms0IAAAAAAAQkAEIAQkY4kUIkIkIAEE4UMsAAw0MQ84gU8sAAAAAAAAgIEQwEsIAUQYEIwgMQAAAkwYgAMMwE8wAUw0AAAAAAA0QQU848IQ8UA8co8YQ8MQ8oQAQ8cIUI0A0QAUAAAAAAAUEIU0IoQkAUAoIkMQkUwEgEwwI4040sUIYIkcAAAAAAAU8owwgoUQMAIE8A8sMYkMo0QMMwYUA4UoAgQ0AAAAAAAUAQ088AoQA0oUU8U88oEUg08c0A80o8c48IU8IAAAAAAYMAY8IMY08MoYIAY84sUEIMAAcIwMIoMMgY8sAAAAAAAAEMowwYgIwUwMcAE88YgIAgMokwAUgMQ8o0owgAAAAAA8csAUsgAoAc8AAUI0488488sIUs88s8088k88IAAAAAAMMMMMIYMsQ8IUEwgUoMAoMMEgU8w840EIUMIMAAAAAAAUQwwwoE88M8wYgAEQowgoU8QowwEQw8QwU8w8AAAAAAAUQ88AoggAU880IU884804AQogAQ8wQU0880oAgAAAAAAUA88AoAQwsEMgY0sAoMUIwIoYIoMU8oUMQMscAAAAAAAUQwwgoAgMYkwo0A4kwU8gMQwEcoUQgoU8oww0AAAAAAAc8888sAQA88s8YQ8YU8cs84U88scIQAIAAAAcIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/8QAAv/aAAwDAQACAAMAAAAQ88888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888c8884oUU48088848088488848soUU8cE88880U8888888Q880o0wo8Uk88g8Uo84o88g8wg8408Uo0848U8888888U88Uock888880888scU4884cc88so8co88o8U8888888Q88UoU488Y4soIM488Y4E0sc0csco88o08o8U8888888U884o0c40cs08s0Uo0088c40Y880o00o8880U888888c8888s8Msc0o8co8Uoccs8csc0o8M4cM88888c8888888w888sM848IIc8MUUs0s4Uk88EMsUo8EocEocU8888888U48Us0Qo40swwk8Uo4wk00o0Uo8Qk888wUg0U8888888ss804cM888o8UocMo88occoc8o8EocUo88o8U888888M88cc80ooM4scU488oUsM88M88s0c80UccUs8U88888884088o88484w8Uw0Uo8QwwQo0U488s8Yw0U8808888888U8888c8s8soc88cUo8U888o8soccsc08cU4cU888888McocA8Ug8cwo8880kocgYsQo8sM8EM0Y40Us0U88888884kw8488ow8o04o8YooYk8Uo8440888w08cs80888888ccocUs80ocUoccsUEs8scA888Esc888co8M4cc888888c8s8c8cco8U40EYc8g088sQsMc8cU88UsMU408888888wc88U88Uo8Uo84w888Ec888s488ww80Q88U0808888888U8808c8o8088cc8gEEgk88U884cE4808c8o8U888888Mco8Ao8wos88cUc8888o888c88s8w8cAo80sE88888880880U808s844wQ088cwo88840848Uo8U808880888888cUo8U880o8ss88I88s8I88408ssc888888s48c8888888Us8c88sY888Uk40888s88YY8s88880U8UcoUU8888888Uk8448Ukw8k8Ug4ww8888Us80o4084888U88088888888o8Es88o8UocU48cMEcs8E4cco8s888s8U8cU888888cEc8c4csYUUo8YoUMc0Q480s8k4c08s08cc48U8888888Q488o8Uk8Uo88g8Uk88o84wwc80808U4wUg0U8888888cocMo8Uo80488o888c08cEo8s4cUo8Uo888cU8888888kcc848UsMIo8w4c888Uc8Y4U0o8wo8co8c8cU888888wU8w840Y08Qowc8w888U88888Uo4Uo88s8Q8808888888U8c84cc48U48s888sc84888cE88Uo8kscU48c888888Uc48os80o8c4MU8s088os8s80Uoc0s8M80gs8U888888088884wQo4848Qw8Uo00o08o8U84880Q48U4008888888088so888884cc88kocco88oc888048Es8848U8888888E88UoM0MU880c8cIs8kosUs808cUsUU8U4ss08888888U88Uo8Uw8ws8Q080o0Uo4cowco0U88U84Qo0U8888888E88co888ck4cEo8ks88o8Es88o80o8U8888cU8888880c88so8sM0ws8cs0c8cws8c8c8o0Us8cM8880U8888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888/8QAFBEBAAAAAAAAAAAAAAAAAAAAoP/aAAgBAgEBPwBsn//EABQRAQAAAAAAAAAAAAAAAAAAAKD/2gAIAQMBAT8AbJ//xABGEAAABAMHBAICAAMEBwcDBQABAgMEAAUREBUhNFNzoQYSMbEgwTCBMkFREyJxchQjMzVAVGEWJEJSkaLRYmOSQ0RQgJD/2gAIAQEAAT8C/wD8vpu5WbtiHSNQe+kXxMdfgIviY6/ARfEx1+Ai+Jjr8BF8THX4CL4mOvwEXxMdfgIviY6/ARfEx1+Ai+Jjr8BDU5jtkTmHESAIxN3KzdsQ6RqD30i+Jjr8BDU5jtkTmHESAI2uZq/I4WKVbADiAYBF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"
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
  // Print is only sent when user taps the 🖨 Print button
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
  // Make sure exit time is set before switching
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
    const entryBtn     = isIn
      ? `<button class="btn btn-sm btn-primary" onclick='showEntryReceipt(${JSON.stringify(r)})'>Receipt</button>`
      : '';
    const exitBtn      = !isIn
      ? `<button class="btn btn-sm btn-ghost" onclick='showExitReceipt(${JSON.stringify(r)})'>Receipt</button>`
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
            <button class="btn btn-sm btn-red-sm" onclick="deleteRecord(${r.id})">Del</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

// ── STATS ─────────────────────────────────────────────────────
function updateStats() {
  const today  = localDateStr();
  const parked = db.filter(r => r.status === 'IN').length;
  const tEnt   = db.filter(r => r.entryDate === today).length;
  const tExit  = db.filter(r => r.status === 'OUT' && r.exitDate === today).length;
  const tRev   = db.filter(r => r.status === 'OUT' && r.exitDate === today)
                   .reduce((s, r) => s + (r.amount || 0), 0);
  const total  = db.length;
  const exited = db.filter(r => r.status === 'OUT').length;
  const totRev = db.filter(r => r.status === 'OUT').reduce((s, r) => s + (r.amount || 0), 0);

  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('s-parked',   parked);
  set('s-today',    tEnt);
  set('s-exits',    tExit);
  set('s-rev',      'Rs.' + tRev.toLocaleString('en-IN'));
  set('s-total',    total);
  set('s-p2',       parked);
  set('s-exited',   exited);
  set('s-totalrev', 'Rs.' + totRev.toLocaleString('en-IN'));
}

// ── DELETE / CLEAR ────────────────────────────────────────────
async function deleteRecord(id) {
  if (!confirm('Delete this record?')) return;
  if (backendOnline) {
    try { await apiFetch(`/records/${id}`, { method: 'DELETE' }); }
    catch (e) { notify('Server error: ' + e.message, 'error'); return; }
  }
  db = db.filter(r => r.id !== id);
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
  if (!recs.length) { notify('No records to export', 'error'); return; }
  const data = recs.map((r, i) => ({
    'Token No.':       '#' + (r.token || '--'),
    'S.No':            i + 1,
    'Lorry Number':    r.lorry,
    'Driver Name':     r.driver,
    'Driver Phone':    r.phone   || '--',
    'Remarks':         r.remarks,
    'Entry Date':      r.entryDate  ? formatDate(r.entryDate) : '--',
    'Entry Time':      r.entryTime  ? to12h(r.entryTime)      : '--',
    'Exit Date':       r.exitDate   ? formatDate(r.exitDate)  : '--',
    'Exit Time':       r.exitTime   ? to12h(r.exitTime)       : '--',
    'Duration':        r.durationMin != null ? fmtDuration(r.durationMin) : '--',
    'Rate/Day(Rs.)':  dailyRate,
    'Amount (Rs.)':    r.amount != null ? r.amount : '--',
    'Status':          r.status === 'IN' ? 'PARKED' : 'EXITED'
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
}

document.addEventListener('DOMContentLoaded', async function () {
  // Init UI inputs immediately
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
  // Use 'focus' so manual flag is set the INSTANT user taps the field,
  // preventing the 10s tick from overwriting their value mid-edit.
  // 'input' catches programmatic changes and fast edits too.
  if (_ed) {
    _ed.addEventListener('focus', () => { entryDateManual = true; });
    _ed.addEventListener('input', () => { entryDateManual = true; });
  }
  if (_et) {
    _et.addEventListener('focus', () => { entryTimeManual = true; });
    _et.addEventListener('input', () => { entryTimeManual = true; });
  }
  // Exit date/time — wire up manual flags once DOM is ready
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

  startEntryTimeTick();

  // Sync from server FIRST — don't show stale localStorage data
  await fullRefresh();

  // Auto-sync every 15 seconds
  setInterval(fullRefresh, 15000);

  // ── Re-sync whenever the page becomes visible again ──
  // This handles: switching back from another app, opening from recents,
  // returning from screen-off, or forward/back navigation on mobile
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') fullRefresh();
  });

  // Handles back-forward cache (bfcache) on iOS Safari
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) fullRefresh();
  });

  // Also sync when window regains focus (desktop browsers)
  window.addEventListener('focus', fullRefresh);
});

// ── Pull to Refresh ───────────────────────────────────────────
(function initPullToRefresh() {
  const THRESHOLD = 65;   // px to pull before release triggers refresh
  let startY = 0, currentY = 0, pulling = false, refreshing = false;

  const body     = document.getElementById('appBody');
  const ptr      = document.getElementById('ptrIndicator');
  const spinner  = document.getElementById('ptrSpinner');
  const ptrText  = document.getElementById('ptrText');

  if (!body || !ptr) return;

  body.addEventListener('touchstart', (e) => {
    if (body.scrollTop !== 0 || refreshing) return;
    startY   = e.touches[0].clientY;
    pulling  = true;
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
    // Snap back
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