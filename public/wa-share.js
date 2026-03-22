/* ============================================================
   KPR TRANSPORT — WhatsApp Receipt Sharing
   wa-share.js  v2  (all-browser tested)

   Flow
   ────
   1. Renders the receipt card to a JPEG using html2canvas (2× scale).
   2. Brave blank-canvas guard: if Shields blocked the render,
      we detect an all-transparent canvas and fall back to text.
   3. Mobile browsers that support Web Share API with files
      (Android Chrome ≥ 89, Samsung Internet, Edge mobile):
        → Native OS share sheet — user picks WhatsApp → JPEG lands in chat.
   4. Everything else (iOS Safari, desktop, Brave, Firefox):
        → Downloads the JPEG to the device.
        → Opens wa.me/<phone>?text=<summary> via <a>.click() trick
          (more reliable than window.open from async context — Safari
          blocks window.open unless called synchronously from a user tap).
   5. If html2canvas fails entirely → falls back to text-only wa.me link.

   Phone number logic
   ──────────────────
   • Strips non-digit characters.
   • Exactly 10 digits  → prepend 91 (India).
   • > 10 digits        → use as-is (already has country code).
   • Empty / too short  → wa.me without number; user picks contact.
   ============================================================ */

async function shareOnWhatsApp() {
  if (!window._lastReceiptData) {
    if (typeof notify === 'function') notify('No receipt to share', 'warn');
    return;
  }

  const rec      = window._lastReceiptData;
  const rawPhone = (rec.phone || '').replace(/\D/g, '');
  const waPhone  = rawPhone.length === 10 ? '91' + rawPhone
                 : rawPhone.length  >  10 ? rawPhone
                 : '';

  if (typeof notify === 'function') notify('Preparing receipt image\u2026', 'info');

  if (typeof html2canvas !== 'function') {
    console.warn('[KPR WA] html2canvas not loaded \u2014 falling back to text');
    _openWhatsAppLink(waPhone, rec);
    return;
  }

  try {
    const target = document.getElementById('receiptContent').firstElementChild
                || document.getElementById('receiptContent');

    const canvas = await html2canvas(target, {
      backgroundColor: '#ffffff',
      scale:           2,
      useCORS:         true,
      allowTaint:      true,
      logging:         false,
      removeContainer: true
    });

    // Brave blank-canvas guard: Shields (Strict) randomises pixels and
    // can produce a fully-transparent canvas. Detect by sampling alpha.
    const ctx    = canvas.getContext('2d');
    const sample = ctx.getImageData(0, 0, 1, 1).data;  // [R,G,B,A]
    if (sample[3] === 0) {
      console.warn('[KPR WA] Canvas is transparent (Brave Shields?)');
      if (typeof notify === 'function') notify('Image blocked by browser \u2014 sharing text only', 'warn');
      _openWhatsAppLink(waPhone, rec);
      return;
    }

    canvas.toBlob((blob) => {
      if (!blob) { _openWhatsAppLink(waPhone, rec); return; }

      const file = new File([blob], 'KPR-Receipt.jpg', { type: 'image/jpeg' });

      // Path A: Web Share API (Android Chrome 89+, Samsung Internet, Edge)
      if (navigator.share && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file] })
          .then(() => {})
          .catch((e) => { if (e.name !== 'AbortError') _downloadAndOpenWA(blob, waPhone, rec); });
        return;
      }

      // Path B: download JPEG + open wa.me (iOS Safari, desktop, Brave, Firefox)
      _downloadAndOpenWA(blob, waPhone, rec);

    }, 'image/jpeg', 0.95);

  } catch (captureErr) {
    console.warn('[KPR WA] html2canvas error:', captureErr);
    if (typeof notify === 'function') notify('Image error \u2014 opening WhatsApp with text', 'warn');
    _openWhatsAppLink(waPhone, rec);
  }
}

// Downloads JPEG then opens wa.me.
// Uses <a>.click() so it works from async context on Safari iOS —
// window.open() called from setTimeout/async is blocked by Safari.
function _downloadAndOpenWA(blob, waPhone, rec) {
  const objUrl = URL.createObjectURL(blob);
  const dl = document.createElement('a');
  dl.href = objUrl; dl.download = 'KPR-Receipt.jpg';
  document.body.appendChild(dl); dl.click(); document.body.removeChild(dl);
  setTimeout(() => URL.revokeObjectURL(objUrl), 2000);

  if (typeof notify === 'function') notify('Receipt saved \u2014 opening WhatsApp\u2026', 'success');
  setTimeout(() => _openWhatsAppLink(waPhone, rec), 900);
}

// Opens wa.me link via <a target="_blank">.click() — more permissive
// than window.open on Safari from async/setTimeout callbacks.
function _openWhatsAppLink(waPhone, rec) {
  const msg  = _buildWhatsAppMessage(rec);
  const waUrl = waPhone
    ? 'https://wa.me/' + waPhone + '?text=' + encodeURIComponent(msg)
    : 'https://wa.me/?text='                + encodeURIComponent(msg);

  const a = document.createElement('a');
  a.href = waUrl; a.target = '_blank'; a.rel = 'noopener noreferrer';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

// Builds the formatted WhatsApp text message from receipt data.
function _buildWhatsAppMessage(rec) {
  const L = '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500';
  let msg = '*KPR TRUCK PARKING*\n' + L + '\n';
  msg += 'Serial No : *#' + rec.token + '*\n';
  msg += 'Vehicle   : *'  + rec.lorry + '*\n';
  if (rec.driver) msg += 'Driver    : ' + rec.driver + '\n';
  if (rec.phone)  msg += 'Phone     : ' + rec.phone  + '\n';
  msg += L + '\n';
  msg += 'Entry     : ' + rec.entry_date;
  if (rec.entry_time) msg += '  ' + rec.entry_time;
  msg += '\n';
  if (rec.type === 'exit') {
    msg += 'Exit      : ' + rec.exit_date;
    if (rec.exit_time) msg += '  ' + rec.exit_time;
    msg += '\n';
    msg += 'Duration  : ' + rec.duration + '\n';
    msg += 'Rate      : Rs.' + rec.rate + '/day\n';
    msg += L + '\n';
    msg += '*Total Paid : Rs.' + rec.amount + '*\n';
  } else {
    msg += 'Rate      : Rs.' + rec.rate + '/day\n';
    msg += L + '\n';
    msg += '_Amount will be billed on exit_\n';
  }
  msg += L + '\n';
  msg += 'KPR Transport\n';
  msg += '\ud83d\udcde 9640019275 | 8885519275\n';
  msg += '\ud83d\udccd Beside DRK College, Bowrampet';
  return msg;
}
