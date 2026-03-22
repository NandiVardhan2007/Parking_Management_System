/* ============================================================
   KPR TRANSPORT — WhatsApp Receipt Sharing
   wa-share.js  v3

   Flow — always goes DIRECTLY to WhatsApp, no OS share sheet:
   ────
   1. Renders the receipt card to a JPEG using html2canvas (2× scale).
   2. Brave blank-canvas guard: detects transparent canvas and falls
      back to text-only link.
   3. Downloads the JPEG to the device (gallery / Downloads).
   4. Opens wa.me/<phone>?text=<summary> directly in WhatsApp
      using an <a>.click() trick (works from async context on
      Safari iOS where window.open would be blocked).
   5. If html2canvas fails entirely → text-only wa.me link.

   Why no Web Share API?
   ─────────────────────
   navigator.share({ files }) shows the OS "choose an app" sheet.
   We want to go STRAIGHT to WhatsApp, so we skip it entirely.

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

  // Guard: html2canvas not loaded
  if (typeof html2canvas !== 'function') {
    console.warn('[KPR WA] html2canvas not loaded — text fallback');
    _openWhatsAppLink(waPhone, rec);
    return;
  }

  try {
    // Target the inner white .th-receipt div for a clean crop
    const target = document.getElementById('receiptContent').firstElementChild
                || document.getElementById('receiptContent');

    const canvas = await html2canvas(target, {
      backgroundColor: '#ffffff',
      scale:           2,        // 2× for Retina sharpness
      useCORS:         true,
      allowTaint:      true,     // allow embedded base64 UPI/QR image
      logging:         false,
      removeContainer: true
    });

    // Brave Shields blank-canvas guard: sample top-left pixel alpha
    const ctx    = canvas.getContext('2d');
    const sample = ctx.getImageData(0, 0, 1, 1).data; // [R,G,B,A]
    if (sample[3] === 0) {
      console.warn('[KPR WA] Canvas transparent (Brave Shields?)');
      if (typeof notify === 'function') notify('Image blocked by browser \u2014 sharing text only', 'warn');
      _openWhatsAppLink(waPhone, rec);
      return;
    }

    canvas.toBlob((blob) => {
      if (!blob) {
        _openWhatsAppLink(waPhone, rec);
        return;
      }
      // Always go directly to WhatsApp — no OS share sheet
      _downloadAndOpenWA(blob, waPhone, rec);
    }, 'image/jpeg', 0.95);

  } catch (err) {
    console.warn('[KPR WA] html2canvas error:', err);
    if (typeof notify === 'function') notify('Image error \u2014 opening WhatsApp with text', 'warn');
    _openWhatsAppLink(waPhone, rec);
  }
}

/**
 * Step 1: download the receipt JPEG to the device.
 * Step 2: open WhatsApp directly via wa.me.
 * The user just pastes / attaches the saved image in the chat.
 *
 * Uses <a>.click() instead of window.open — Safari iOS allows this
 * from async/setTimeout context; window.open would be blocked.
 */
function _downloadAndOpenWA(blob, waPhone, rec) {
  // Download the image
  const objUrl = URL.createObjectURL(blob);
  const dl     = document.createElement('a');
  dl.href      = objUrl;
  dl.download  = 'KPR-Receipt.jpg';
  document.body.appendChild(dl);
  dl.click();
  document.body.removeChild(dl);
  setTimeout(() => URL.revokeObjectURL(objUrl), 2000);

  if (typeof notify === 'function') notify('Receipt image saved \u2014 opening WhatsApp\u2026', 'success');

  // Open WhatsApp after a brief pause so the download triggers first
  setTimeout(() => _openWhatsAppLink(waPhone, rec), 700);
}

/**
 * Opens wa.me with the driver's number and a formatted text receipt.
 * wa.me always opens WhatsApp directly — no "choose an app" prompt.
 * Uses <a target="_blank">.click() for Safari async compatibility.
 */
function _openWhatsAppLink(waPhone, rec) {
  const msg   = _buildWhatsAppMessage(rec);
  const waUrl = waPhone
    ? 'https://wa.me/' + waPhone + '?text=' + encodeURIComponent(msg)
    : 'https://wa.me/?text='                + encodeURIComponent(msg);

  const a  = document.createElement('a');
  a.href   = waUrl;
  a.target = '_blank';
  a.rel    = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/** Builds the formatted WhatsApp text message from receipt data. */
function _buildWhatsAppMessage(rec) {
  const L = '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500';
  let msg  = '*KPR TRUCK PARKING*\n' + L + '\n';
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
  msg += '📞 9640019275 | 8885519275\n';
  msg += '📍 Beside DRK College, Bowrampet';
  return msg;
}