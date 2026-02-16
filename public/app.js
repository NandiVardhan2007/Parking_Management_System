/* ============================================================
   KPR TRANSPORT - PARKING MANAGEMENT SYSTEM
   app.js  —  API-first with localStorage offline fallback
   ============================================================ */

// ── API Config ──────────────────────────────────────────────
const API = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? `http://${window.location.hostname}:3000/api`
  : `${window.location.origin}/api`;

// ── PRINT SERVER CONFIG ─────────────────────────────────────
// Change the IP below to your parking laptop's local IP address.
// To find it: Windows → open CMD → type "ipconfig" → look for IPv4 Address
//             Linux/Mac → open Terminal → type "ip addr" or "ifconfig"
// Both devices (phone/PC running the website + parking laptop) must be on the SAME WiFi.
const PRINT_SERVER = 'http://192.168.1.10:5000';  // ← CHANGE THIS TO YOUR LAPTOP IP
const PRINT_SECRET = 'KPR2024SECRET';              // Must match print_server.py
// ────────────────────────────────────────────────────────────

// ── Data Store (local cache) ────────────────────────────────
let db          = JSON.parse(localStorage.getItem('kpr_db')   || '[]');
let dailyRate   = parseInt(localStorage.getItem('kpr_rate')   || '120');
let recFilterStatus = 'all';

// Track whether backend is reachable
let backendOnline = false;

// ── Sync helpers ─────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'API error');
  return json;
}

// Sync from backend into local cache
async function syncFromServer() {
  try {
    const [records, settings] = await Promise.all([
      apiFetch('/records?limit=5000'),
      apiFetch('/settings')
    ]);
    db        = records.data;
    dailyRate = parseFloat(settings.data.daily_rate) || 120;
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
  badge.textContent  = backendOnline ? '● Live' : '○ Offline';
  badge.style.color  = backendOnline ? '#22c55e' : '#f59e0b';
  badge.title        = backendOnline
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
  const v = parseInt(document.getElementById('dailyRateInput').value) || 120;
  dailyRate = v;
  localStorage.setItem('kpr_rate', v);
  document.getElementById('rateShow').textContent = v;

  if (backendOnline) {
    try {
      await apiFetch('/settings', {
        method: 'POST',
        body: JSON.stringify({ daily_rate: v })
      });
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

  const d = now.toLocaleDateString('en-IN');
  const t = now.toLocaleTimeString('en-IN', { hour12: true });
  ['entryDate', 'exitDate'].forEach(id => {
    const e = document.getElementById(id); if (e) e.value = d;
  });
  ['entryTime', 'exitTime'].forEach(id => {
    const e = document.getElementById(id); if (e) e.value = t;
  });
}
setInterval(tick, 1000);
tick();

// ── Navigation ───────────────────────────────────────────────
function goTab(tab, btn) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('panel-' + tab).classList.add('active');
  btn.classList.add('active');
  document.getElementById('appBody').scrollTop = 0;
  if (tab === 'exit')    renderParked();
  if (tab === 'records') renderRecords();
  updateStats();
}

// ── Notifications ────────────────────────────────────────────
function notify(msg, type = 'info') {
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warn: '⚠️' };
  const el    = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span style="flex:1">${msg}</span>`;
  document.getElementById('notifyWrap').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ── Calculations ─────────────────────────────────────────────
function calcDays(entryISO, exitISO) {
  const diff = new Date(exitISO) - new Date(entryISO);
  if (diff <= 0) return 1;
  return Math.max(1, Math.ceil(diff / 86400000));
}
function calcAmt(days) { return days * dailyRate; }

// ── ENTRY ────────────────────────────────────────────────────
async function recordEntry() {
  const lorryInput = document.getElementById('entryLorry');
  const lorry      = lorryInput.value.trim().toUpperCase();
  if (!lorry) { notify('Enter lorry number!', 'error'); return; }

  const dup = db.find(r => r.lorry === lorry && r.status === 'IN');
  if (dup) { notify('WARNING: ' + lorry + ' already parked! Token #' + dup.token, 'error'); return; }

  const payload = {
    lorry,
    driver:  document.getElementById('entryDriver').value.trim()  || '--',
    phone:   document.getElementById('entryPhone').value.trim()   || '--',
    remarks: document.getElementById('entryRemarks').value.trim() || '--',
    entryISO: new Date().toISOString()
  };

  let rec;

  if (backendOnline) {
    try {
      const resp = await apiFetch('/records', {
        method: 'POST',
        body:   JSON.stringify(payload)
      });
      rec = resp.data;
      db.unshift(rec);
      saveLocal();
    } catch (e) {
      notify('Server error: ' + e.message, 'error');
      return;
    }
  } else {
    const now   = new Date();
    const token = getNextToken();
    rec = {
      id:           Date.now(),
      token,
      lorry,
      driver:       payload.driver,
      phone:        payload.phone,
      remarks:      payload.remarks,
      entryISO:     now.toISOString(),
      entryDisplay: now.toLocaleString('en-IN'),
      exitISO:      null,
      exitDisplay:  '--',
      days:         null,
      amount:       null,
      status:       'IN'
    };
    db.unshift(rec);
    saveLocal();
    notify('Saved locally (offline mode)', 'info');
  }

  updateStats(); refreshToken(); renderRecent();
  notify('Token #' + rec.token + ' — ' + lorry + ' entered', 'success');
  showEntryReceipt(rec);
  clearEntry();
}

function clearEntry() {
  ['entryLorry', 'entryDriver', 'entryPhone', 'entryRemarks'].forEach(id => {
    document.getElementById(id).value = '';
  });
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
    errEl.textContent   = 'Token #' + num + ' not found.';
    errEl.style.display = 'block';
    return;
  }

  if (rec.status === 'OUT') {
    errEl.textContent   = 'Token #' + num + ' (' + rec.lorry + ') already exited on ' + rec.exitDisplay;
    errEl.style.display = 'block';
    return;
  }

  const now  = new Date();
  const days = calcDays(rec.entryISO, now.toISOString());
  const amt  = calcAmt(days);

  document.getElementById('lkToken').textContent = '#' + rec.token;
  document.getElementById('lkLorry').textContent = rec.lorry;

  const phoneRow  = rec.phone   !== '--'
    ? `<div class="di"><div class="di-lbl">Phone</div><div class="di-val blue">${rec.phone}</div></div>`
    : '<div></div>';
  const remarkRow = rec.remarks !== '--'
    ? `<div class="di full"><div class="di-lbl">Remarks</div><div class="di-val">${rec.remarks}</div></div>`
    : '';

  document.getElementById('lkDetails').innerHTML =
    `<div class="di"><div class="di-lbl">Driver</div><div class="di-val">${rec.driver}</div></div>` +
    phoneRow +
    `<div class="di"><div class="di-lbl">Entry Date</div><div class="di-val">${new Date(rec.entryISO).toLocaleDateString('en-IN')}</div></div>` +
    `<div class="di"><div class="di-lbl">Entry Time</div><div class="di-val">${new Date(rec.entryISO).toLocaleTimeString('en-IN')}</div></div>` +
    remarkRow;

  document.getElementById('lkAmount').textContent = 'Rs.' + amt.toLocaleString('en-IN');
  document.getElementById('lkInfo').textContent   = days + ' day' + (days > 1 ? 's' : '') + ' × Rs.' + dailyRate + '/day';
  card.style.display = 'block';
}

function clearExitForm() {
  document.getElementById('exitToken').value           = '';
  document.getElementById('exitError').style.display   = 'none';
  document.getElementById('lookupCard').style.display  = 'none';
}

// ── EXIT — PROCESS ───────────────────────────────────────────
async function processExit() {
  const val   = document.getElementById('exitToken').value.trim();
  const errEl = document.getElementById('exitError');
  errEl.style.display = 'none';

  const num = parseInt(val);
  if (!val || isNaN(num)) {
    errEl.textContent = 'Please enter a valid token number.';
    errEl.style.display = 'block';
    return;
  }

  const idx = db.findIndex(r => r.token === num && r.status === 'IN');
  if (idx === -1) {
    const gone = db.find(r => r.token === num);
    errEl.textContent   = gone
      ? 'Token #' + num + ' (' + gone.lorry + ') already exited.'
      : 'Token #' + num + ' not found.';
    errEl.style.display = 'block';
    return;
  }

  const now = new Date();
  let rec   = db[idx];

  if (backendOnline) {
    try {
      const resp = await apiFetch(`/records/${rec.id}/exit`, {
        method: 'PATCH',
        body:   JSON.stringify({ rate: dailyRate, exitISO: now.toISOString() })
      });
      db[idx] = resp.data;
      rec     = resp.data;
      saveLocal();
    } catch (e) {
      notify('Server error: ' + e.message, 'error');
      return;
    }
  } else {
    const days = calcDays(rec.entryISO, now.toISOString());
    const amt  = calcAmt(days);
    rec.exitISO     = now.toISOString();
    rec.exitDisplay = now.toLocaleString('en-IN');
    rec.days        = days;
    rec.amount      = amt;
    rec.status      = 'OUT';
    db[idx]         = rec;
    saveLocal();
    notify('Saved locally (offline mode)', 'info');
  }

  updateStats(); renderParked(); renderRecent();
  showExitReceipt(rec);
  clearExitForm();
  notify('Token #' + num + ' exited — Rs.' + rec.amount, 'success');
}

// ── AUTO PRINT — Send to parking laptop printer ───────────────
async function sendToPrinter(data) {
  try {
    const resp = await fetch(`${PRINT_SERVER}/print`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'X-Print-Token': PRINT_SECRET
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(6000)
    });
    if (resp.ok) {
      notify('🖨 Receipt sent to printer ✓', 'success');
    } else {
      console.warn('[KPR Print] Server responded with error:', resp.status);
      notify('⚠ Printer server error (' + resp.status + ')', 'warn');
    }
  } catch (err) {
    // Non-fatal — printer offline or laptop not reachable
    console.warn('[KPR Print] Print server unreachable:', err.message);
    notify('⚠ Printer offline — use browser print', 'warn');
  }
}

// ── RECEIPTS ─────────────────────────────────────────────────
function showEntryReceipt(rec) {
  const ed         = new Date(rec.entryISO);
  const phoneRow   = rec.phone   !== '--' ? `<div class="rr"><span>Phone</span><span>${rec.phone}</span></div>`   : '';
  const remarkRow  = rec.remarks !== '--' ? `<div class="rr"><span>Remarks</span><span>${rec.remarks}</span></div>` : '';

  document.getElementById('receiptContent').innerHTML =
    `<div class="rh">
      <h1>KPR TRANSPORT</h1>
      <p>PARKING MANAGEMENT SYSTEM</p>
      <p style="margin-top:5px;letter-spacing:2px">*** ENTRY RECEIPT ***</p>
    </div>
    <div class="tok-blk">
      <div class="tok-lab">Parking Token No.</div>
      <div class="tok-num">#${rec.token}</div>
      <div class="tok-hint">Please keep this receipt for exit</div>
    </div>
    <div class="rs"><h3>Vehicle Details</h3>
      <div class="rr bold"><span>Lorry No.</span><span>${rec.lorry}</span></div>
      <div class="rr"><span>Driver</span><span>${rec.driver}</span></div>
      ${phoneRow}${remarkRow}
    </div>
    <div class="rs"><h3>Entry Details</h3>
      <div class="rr"><span>Date</span><span>${ed.toLocaleDateString('en-IN')}</span></div>
      <div class="rr"><span>Time</span><span>${ed.toLocaleTimeString('en-IN')}</span></div>
    </div>
    <div class="rs"><h3>Billing Info</h3>
      <div class="rr"><span>Rate / Day</span><span>Rs.${dailyRate}.00</span></div>
      <div class="rr"><span>Payment</span><span>On Exit</span></div>
    </div>
    <div class="rf">
      <p>Printed: ${new Date().toLocaleString('en-IN')}</p>
      <p style="margin-top:4px">Thank you for choosing KPR Transport</p>
    </div>`;

  // Store print data for the print button
  window._lastReceiptData = {
    type:       'entry',
    token:      String(rec.token),
    lorry:      rec.lorry,
    driver:     rec.driver !== '--' ? rec.driver : '',
    phone:      rec.phone  !== '--' ? rec.phone  : '',
    remarks:    rec.remarks !== '--' ? rec.remarks : '',
    entry_time: ed.toLocaleDateString('en-IN') + ' ' + ed.toLocaleTimeString('en-IN'),
    rate:       dailyRate
  };

  document.getElementById('receiptOv').classList.add('open');

  // Auto-send to printer immediately when receipt appears
  sendToPrinter(window._lastReceiptData);
}

function showExitReceipt(rec) {
  const ed        = new Date(rec.entryISO);
  const xd        = new Date(rec.exitISO);
  const phoneRow  = rec.phone   !== '--' ? `<div class="rr"><span>Phone</span><span>${rec.phone}</span></div>`   : '';
  const remarkRow = rec.remarks !== '--' ? `<div class="rr"><span>Remarks</span><span>${rec.remarks}</span></div>` : '';

  document.getElementById('receiptContent').innerHTML =
    `<div class="rh">
      <h1>KPR TRANSPORT</h1>
      <p>PARKING MANAGEMENT SYSTEM</p>
      <p style="margin-top:5px;letter-spacing:2px">*** EXIT RECEIPT ***</p>
    </div>
    <div class="tok-blk">
      <div class="tok-lab">Parking Token No.</div>
      <div class="tok-num">#${rec.token}</div>
    </div>
    <div class="rs"><h3>Vehicle Details</h3>
      <div class="rr bold"><span>Lorry No.</span><span>${rec.lorry}</span></div>
      <div class="rr"><span>Driver</span><span>${rec.driver}</span></div>
      ${phoneRow}${remarkRow}
    </div>
    <div class="rs"><h3>Parking Duration</h3>
      <div class="rr"><span>Entry Date</span><span>${ed.toLocaleDateString('en-IN')}</span></div>
      <div class="rr"><span>Entry Time</span><span>${ed.toLocaleTimeString('en-IN')}</span></div>
      <div class="rr"><span>Exit Date</span><span>${xd.toLocaleDateString('en-IN')}</span></div>
      <div class="rr"><span>Exit Time</span><span>${xd.toLocaleTimeString('en-IN')}</span></div>
      <div class="rr bold"><span>Duration</span><span>${rec.days} Day${rec.days > 1 ? 's' : ''}</span></div>
    </div>
    <div class="rs"><h3>Billing</h3>
      <div class="rr"><span>Rate / Day</span><span>Rs.${dailyRate}.00</span></div>
      <div class="rr"><span>Days</span><span>${rec.days}</span></div>
      <div class="rr total"><span>TOTAL</span><span>Rs.${rec.amount.toLocaleString('en-IN')}.00</span></div>
    </div>
    <div class="rf">
      <p>Printed: ${new Date().toLocaleString('en-IN')}</p>
      <p style="margin-top:4px">Thank you for using KPR Transport Parking</p>
    </div>`;

  // Store print data for the print button
  window._lastReceiptData = {
    type:       'exit',
    token:      String(rec.token),
    lorry:      rec.lorry,
    driver:     rec.driver  !== '--' ? rec.driver  : '',
    phone:      rec.phone   !== '--' ? rec.phone   : '',
    remarks:    rec.remarks !== '--' ? rec.remarks : '',
    entry_time: ed.toLocaleDateString('en-IN') + ' ' + ed.toLocaleTimeString('en-IN'),
    exit_time:  xd.toLocaleDateString('en-IN') + ' ' + xd.toLocaleTimeString('en-IN'),
    duration:   rec.days + ' Day' + (rec.days > 1 ? 's' : ''),
    days:       rec.days,
    rate:       dailyRate,
    amount:     rec.amount
  };

  document.getElementById('receiptOv').classList.add('open');

  // Auto-send to printer immediately when receipt appears
  sendToPrinter(window._lastReceiptData);
}

function closeReceipt() {
  document.getElementById('receiptOv').classList.remove('open');
  document.getElementById('receiptOv').scrollTop = 0;
  window._lastReceiptData = null;
}

function printReceipt() {
  // Open browser print dialog (as backup / for manual reprint)
  const c = document.getElementById('receiptContent').innerHTML;
  const w = window.open('', '_blank', 'width=400,height=650');
  w.document.write(`<!DOCTYPE html><html><head><title>KPR Receipt</title>
    <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:"Courier New",monospace;padding:16px;max-width:380px}
    .rh{text-align:center;border-bottom:2px dashed #bbb;padding-bottom:12px;margin-bottom:12px}
    h1{font-size:20px;letter-spacing:3px}
    p{font-size:11px;color:#666;margin-top:2px}
    .tok-blk{text-align:center;padding:12px;border:2px dashed #aaa;border-radius:6px;margin:12px 0}
    .tok-num{font-size:48px;font-weight:bold;letter-spacing:4px}
    .tok-lab{font-size:10px;text-transform:uppercase;letter-spacing:3px;color:#666}
    .tok-hint{font-size:10px;color:#888;margin-top:3px}
    .rs{border-top:1px dashed #ccc;padding-top:8px;margin-top:8px}
    h3{font-size:10px;text-transform:uppercase;letter-spacing:2px;color:#666;margin-bottom:7px}
    .rr{display:flex;justify-content:space-between;margin:4px 0;font-size:13px}
    .rr.bold{font-weight:bold}
    .rr.total{border-top:2px solid #111;border-bottom:2px solid #111;padding:6px 0;margin-top:6px;font-size:16px;font-weight:bold}
    .rf{text-align:center;border-top:2px dashed #bbb;padding-top:10px;margin-top:12px;font-size:10px;color:#666}
    @media print{body{padding:0}}
    </style></head><body>${c}</body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 300);

  // Also re-send to printer (in case it was missed on first auto-send)
  if (window._lastReceiptData) {
    sendToPrinter(window._lastReceiptData);
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
    const driverLine = r.driver !== '--' ? ` Driver: <b>${r.driver}</b>` : '';
    const phoneLine  = r.phone  !== '--' ? ` · <span style="color:var(--blue)">${r.phone}</span>` : '';
    return `
      <div class="pk-card">
        <div class="pk-top">
          <span class="pk-token">#${r.token}</span>
          <span class="pk-lorry">${r.lorry}</span>
        </div>
        <div class="pk-meta">Entered: <b>${r.entryDisplay}</b>${driverLine}${phoneLine}</div>
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
  const el  = document.getElementById('parkedList');
  const cEl = document.getElementById('parkedCount');
  let parked = db.filter(r => r.status === 'IN');

  if (filter) {
    const q = filter.toLowerCase();
    parked = parked.filter(r =>
      r.lorry.toLowerCase().includes(q) || String(r.token).includes(q)
    );
  }

  if (cEl) cEl.textContent = parked.length + ' lorr' + (parked.length !== 1 ? 'ies' : 'y');

  if (!parked.length) {
    el.innerHTML = `<div class="empty"><div class="ei">P</div><p>${filter ? 'No results' : 'No lorries parked'}</p></div>`;
    return;
  }

  const now = new Date();
  el.innerHTML = parked.map(r => {
    const days       = calcDays(r.entryISO, now.toISOString());
    const amt        = calcAmt(days);
    const driverLine = r.driver !== '--' ? `<br>Driver: <b>${r.driver}</b>` : '';
    const phoneLine  = r.phone  !== '--' ? ` · <span style="color:var(--blue)">${r.phone}</span>` : '';
    return `
      <div class="pk-card">
        <div class="pk-top">
          <span class="pk-token">#${r.token}</span>
          <span class="pk-lorry">${r.lorry}</span>
        </div>
        <div class="pk-meta">Entered: <b>${r.entryDisplay}</b>${driverLine}${phoneLine}</div>
        <div class="pk-foot">
          <div>
            <div class="pk-due">Rs.${amt.toLocaleString('en-IN')}</div>
            <div class="pk-days">${days} day${days > 1 ? 's' : ''} parked</div>
          </div>
          <button class="btn btn-sm btn-danger" onclick="goToExit(${r.token})">Exit</button>
        </div>
      </div>`;
  }).join('');
}

function filterParked(val) { renderParked(val); }

function goToExit(token) {
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

  if (recFilterStatus !== 'all') {
    recs = recs.filter(r => r.status === recFilterStatus);
  }
  if (q) {
    recs = recs.filter(r =>
      r.lorry.toLowerCase().includes(q)  ||
      r.driver.toLowerCase().includes(q) ||
      String(r.token).includes(q)
    );
  }

  if (!recs.length) {
    el.innerHTML = '<div class="empty"><div class="ei">📋</div><p>No records found</p></div>';
    return;
  }

  el.innerHTML = recs.map(r => {
    const isIn     = r.status === 'IN';
    const amtText  = r.amount != null ? 'Rs.' + r.amount.toLocaleString('en-IN') : '--';
    const phoneRow = r.phone !== '--'
      ? `<span><span style="font-size:9px">PHONE</span><b style="color:var(--blue)">${r.phone}</b></span>`
      : '<span></span>';

    const entryBtn = isIn
      ? `<button class="btn btn-sm btn-primary" onclick='showEntryReceipt(${JSON.stringify(r)})'>Receipt</button>`
      : '';
    const exitBtn  = !isIn
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
          <span><span style="font-size:9px">ENTRY</span><b>${r.entryDisplay}</b></span>
          <span><span style="font-size:9px">EXIT</span><b>${r.exitDisplay}</b></span>
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
  const today  = new Date().toDateString();
  const parked = db.filter(r => r.status === 'IN').length;
  const tEnt   = db.filter(r => new Date(r.entryISO).toDateString() === today).length;
  const tExit  = db.filter(r => r.status === 'OUT' && r.exitISO && new Date(r.exitISO).toDateString() === today).length;
  const tRev   = db.filter(r => r.status === 'OUT' && r.exitISO && new Date(r.exitISO).toDateString() === today)
                   .reduce((s, r) => s + (r.amount || 0), 0);
  const total  = db.length;
  const exited = db.filter(r => r.status === 'OUT').length;
  const totRev = db.filter(r => r.status === 'OUT')
                   .reduce((s, r) => s + (r.amount || 0), 0);

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
    try {
      await apiFetch(`/records/${id}`, { method: 'DELETE' });
    } catch (e) {
      notify('Server error: ' + e.message, 'error'); return;
    }
  }

  db = db.filter(r => r.id !== id);
  saveLocal();
  renderRecords(); updateStats(); refreshToken();
  notify('Record deleted', 'info');
}

async function clearAllData() {
  if (!confirm('Delete ALL records permanently? This cannot be undone.')) return;

  if (backendOnline) {
    try {
      await apiFetch('/records', {
        method: 'DELETE',
        body:   JSON.stringify({ confirm: 'DELETE_ALL' })
      });
    } catch (e) {
      notify('Server error: ' + e.message, 'error'); return;
    }
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
          lorry:    (row['Lorry Number'] || row['lorry'] || '').toString(),
          driver:   row['Driver Name']   || row['driver']  || '--',
          phone:    row['Driver Phone']  || row['phone']   || '--',
          remarks:  row['Remarks']       || row['remarks'] || '--',
          token:    row['Token'] ? parseInt(row['Token']) : undefined,
          entryISO: row['Entry DateTime'] ? new Date(row['Entry DateTime']).toISOString() : undefined,
          exitISO:  row['Exit DateTime']  ? new Date(row['Exit DateTime']).toISOString()  : undefined
        })).filter(r => r.lorry.trim());

        const resp = await apiFetch('/import', {
          method: 'POST',
          body:   JSON.stringify({ records: payload })
        });
        added = resp.added;
        await syncFromServer();
        if (resp.errors?.length) {
          st.textContent = `Imported ${added} records. ${resp.errors.length} errors skipped.`;
        } else {
          st.textContent = `Imported ${added} records successfully!`;
        }
      } else {
        let nxt = getNextToken();
        rows.forEach(row => {
          const lorry = (row['Lorry Number'] || row['lorry'] || '').toString().toUpperCase().trim();
          if (!lorry) return;
          const ed = new Date(row['Entry DateTime'] || row['entry'] || new Date());
          const xr = row['Exit DateTime'] || row['exit'] || null;
          const xd = xr ? new Date(xr) : null;
          const status = xd ? 'OUT' : 'IN';
          const days   = xd ? calcDays(ed.toISOString(), xd.toISOString()) : null;
          db.push({
            id: Date.now() + added,
            token: parseInt(row['Token']) || nxt++,
            lorry, status, days,
            driver:       row['Driver Name']  || '--',
            phone:        row['Driver Phone'] || '--',
            remarks:      row['Remarks']      || '--',
            entryISO:     ed.toISOString(),
            entryDisplay: ed.toLocaleString('en-IN'),
            exitISO:      xd ? xd.toISOString() : null,
            exitDisplay:  xd ? xd.toLocaleString('en-IN') : '--',
            amount:       days ? calcAmt(days) : null
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
    'Driver Phone':    r.phone  || '--',
    'Remarks':         r.remarks,
    'Entry Date':      r.entryISO ? new Date(r.entryISO).toLocaleDateString('en-IN') : '--',
    'Entry Time':      r.entryISO ? new Date(r.entryISO).toLocaleTimeString('en-IN') : '--',
    'Exit Date':       r.exitISO  ? new Date(r.exitISO).toLocaleDateString('en-IN')  : '--',
    'Exit Time':       r.exitISO  ? new Date(r.exitISO).toLocaleTimeString('en-IN')  : '--',
    'Duration (Days)': r.days   != null ? r.days   : '--',
    'Rate/Day (Rs.)':  dailyRate,
    'Amount (Rs.)':    r.amount != null ? r.amount : '--',
    'Status':          r.status === 'IN' ? 'PARKED' : 'EXITED'
  }));

  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Records');
  ws['!cols'] = [
    {wch:10},{wch:5},{wch:16},{wch:16},{wch:14},{wch:20},
    {wch:13},{wch:12},{wch:13},{wch:12},{wch:12},{wch:10},{wch:12},{wch:10}
  ];
  XLSX.writeFile(wb, fname + '_' + new Date().toISOString().split('T')[0] + '.xlsx');
  notify('Exported ' + recs.length + ' records', 'success');
}

// ── INIT ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async function () {
  document.getElementById('dailyRateInput').value = dailyRate;
  document.getElementById('rateShow').textContent  = dailyRate;

  updateStats();
  refreshToken();
  renderRecent();

  await syncFromServer();
  showOnlineStatus();
  updateStats();
  refreshToken();
  renderRecent();

  setInterval(async () => {
    await syncFromServer();
    showOnlineStatus();
    updateStats();
  }, 30000);
});