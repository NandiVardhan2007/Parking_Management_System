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

// ── Data Store ───────────────────────────────────────────────
let db              = JSON.parse(localStorage.getItem('kpr_db')   || '[]');
let dailyRate       = parseInt(localStorage.getItem('kpr_rate')   || '130');
let recFilterStatus = 'all';
let backendOnline   = false;

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
    backendOnline = true;
  } catch (_) {
    backendOnline = false;
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
  const v = parseInt(document.getElementById('dailyRateInput').value) || 130;
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
    now.toLocaleTimeString('en-IN', { hour12: true });
  document.getElementById('clockDate').textContent =
    now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
setInterval(tick, 1000);
tick();

// ── Time helpers ─────────────────────────────────────────────

/** Returns current time as "HH:MM" (24h) for <input type="time"> */
function liveTime24() {
  const n = new Date();
  return n.toTimeString().slice(0, 5); // "HH:MM"
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
  const days = daysBetween(entryDate, exitDate || new Date().toISOString().split('T')[0]);
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
  const today = new Date().toISOString().split('T')[0];
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
  if (ed) ed.value = new Date().toISOString().split('T')[0];
  if (et) et.value = liveTime24();
}

/** Track if user manually changed entry time/date */
let entryTimeManual = false;
let entryDateManual = false;

/** Live auto-tick for entry time — stops once user manually edits */
function startEntryTimeTick() {
  setInterval(() => {
    if (!entryTimeManual) {
      const et = document.getElementById('entryTimeInput');
      if (et) et.value = liveTime24();
    }
    if (!entryDateManual) {
      const ed = document.getElementById('entryDateInput');
      if (ed) ed.value = new Date().toISOString().split('T')[0];
    }
    // Keep exit date/time always current
    syncExitDateTime();
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
    syncExitDateTime();
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
  try {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch (e) { return dateStr; }
}

// ── ENTRY ────────────────────────────────────────────────────
async function recordEntry() {
  const lorryInput = document.getElementById('entryLorry');
  const lorry      = lorryInput.value.trim().toUpperCase();
  if (!lorry) { notify('Enter lorry number!', 'error'); return; }

  const dup = db.find(r => r.lorry === lorry && r.status === 'IN');
  if (dup) { notify('WARNING: ' + lorry + ' already parked! Serial #' + dup.token, 'error'); return; }

  const entryDate = document.getElementById('entryDateInput').value || new Date().toISOString().split('T')[0];
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
  document.getElementById('entryDateInput').value = new Date().toISOString().split('T')[0];
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

  const exitDate = document.getElementById('exitDateInput').value  || new Date().toISOString().split('T')[0];
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
  document.getElementById('exitDateInput').value = new Date().toISOString().split('T')[0];
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
        <tr class="th-total-row"><td>Total Paid :</td><td><b>₹${(amount || 0).toLocaleString('en-IN')}</b></td></tr>
      </table>
      <div class="th-dash"></div>
      <div class="th-footer">THANK YOU - DRIVE SAFE</div>
      <div class="th-qr-wrap">
        <div id="receiptQR" data-upi="${upiUrl}"></div>
        <div class="th-upi">PhonePe/GPay: 9640019275</div>
      </div>
    </div>`;

  // Generate QR code for UPI payment
  setTimeout(() => {
    const qrEl = document.getElementById('receiptQR');
    if (qrEl && typeof QRCode !== 'undefined') {
      new QRCode(qrEl, { text: upiUrl, width: 128, height: 128, colorDark: '#000', colorLight: '#fff' });
    }
  }, 50);

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
  const exitDate = document.getElementById('exitDateInput')?.value || new Date().toISOString().split('T')[0];
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
  if (ed && !ed.value) ed.value = new Date().toISOString().split('T')[0];

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
  const today  = new Date().toISOString().split('T')[0];
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
          const entryDate = row['Entry Date'] ? new Date(row['Entry Date']).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
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
  XLSX.writeFile(wb, fname + '_' + new Date().toISOString().split('T')[0] + '.xlsx');
  notify('Exported ' + recs.length + ' records', 'success');
}

// ── INIT ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async function () {
  document.getElementById('dailyRateInput').value = dailyRate;
  document.getElementById('rateShow').textContent  = dailyRate;

  // Set entry date/time to now; exit is always live
  const today = new Date().toISOString().split('T')[0];
  const now   = liveTime24();
  const _ed = document.getElementById('entryDateInput');
  const _et = document.getElementById('entryTimeInput');
  if (_ed) _ed.value = today;
  if (_et) _et.value = now;
  syncExitDateTime();

  // Mark manual edit when user changes entry date/time
  if (_ed) _ed.addEventListener('change', () => { entryDateManual = true; });
  if (_et) _et.addEventListener('change', () => { entryTimeManual = true; });
  // Reset manual flags when clearEntry() is called (handled in clearEntry)

  startEntryTimeTick();

  updateStats(); refreshToken(); renderRecent();

  await syncFromServer();
  showOnlineStatus();
  updateStats(); refreshToken(); renderRecent();

  setInterval(async () => {
    await syncFromServer();
    showOnlineStatus();
    updateStats();
  }, 30000);

  // Exit date/time are always live (hidden fields) — no listeners needed
});