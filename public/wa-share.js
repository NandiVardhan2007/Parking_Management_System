/* ============================================================
   KPR TRANSPORT — WhatsApp Receipt Sharing   wa-share.js v5
   ============================================================ */

async function shareImageWhatsApp() {
  if (!window._lastReceiptData) {
    if (typeof notify === 'function') notify('No receipt to share', 'warn');
    return;
  }
  const rec = window._lastReceiptData;
  if (typeof notify === 'function') notify('Rendering receipt image...', 'info');
  if (typeof html2canvas !== 'function') { shareTextWhatsApp(); return; }
  try {
    const target = document.getElementById('receiptContent').firstElementChild
                || document.getElementById('receiptContent');
    const canvas = await html2canvas(target, {
      backgroundColor: '#ffffff', scale: 2,
      useCORS: true, allowTaint: true, logging: false, removeContainer: true
    });
    const ctx = canvas.getContext('2d');
    const px  = ctx.getImageData(0, 0, 1, 1).data;
    if (px[3] === 0) {
      if (typeof notify === 'function') notify('Image blocked — sharing text instead', 'warn');
      shareTextWhatsApp(); return;
    }
    canvas.toBlob(async (blob) => {
      if (!blob) { shareTextWhatsApp(); return; }
      const file = new File([blob], 'KPR-Receipt.jpg', { type: 'image/jpeg' });
      if (navigator.share && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: 'KPR Parking Receipt' });
          return;
        } catch (e) {
          if (e.name === 'AbortError') return;
        }
      }
      if (typeof notify === 'function') notify('Downloading image and opening WhatsApp...', 'info');
      _downloadBlob(blob);
      setTimeout(() => shareTextWhatsApp(), 800);
    }, 'image/jpeg', 0.95);
  } catch (err) {
    console.warn('[KPR WA] html2canvas error:', err);
    shareTextWhatsApp();
  }
}

function shareTextWhatsApp() {
  if (!window._lastReceiptData) {
    if (typeof notify === 'function') notify('No receipt to share', 'warn');
    return;
  }
  const rec      = window._lastReceiptData;
  const rawPhone = (rec.phone || '').replace(/\D/g, '');
  const waPhone  = rawPhone.length === 10 ? '91' + rawPhone
                 : rawPhone.length  >  10 ? rawPhone : '';
  const msg   = _buildWhatsAppMessage(rec);
  const waUrl = waPhone
    ? 'https://wa.me/' + waPhone + '?text=' + encodeURIComponent(msg)
    : 'https://wa.me/?text='                + encodeURIComponent(msg);
  const a = document.createElement('a');
  a.href = waUrl; a.target = '_blank'; a.rel = 'noopener noreferrer';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

function _downloadBlob(blob) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = 'KPR-Receipt.jpg';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function _buildWhatsAppMessage(rec) {
  const SEP  = '-----------------------------------------';
  const TICK = '\`\`\`';
  let body = '';
  body += 'KPR TRUCK PARKING\n';
  body += SEP + '\n';
  body += ' Token  : #' + rec.token + '\n';
  body += 'Vehicle : ' + rec.lorry  + '\n';
  if (rec.driver) body += 'Driver  : ' + rec.driver + '\n';
  if (rec.phone)  body += 'Phone   : ' + rec.phone  + '\n';
  body += SEP + '\n';
  body += 'Entry   : ' + rec.entry_date;
  if (rec.entry_time) body += '  ' + rec.entry_time;
  body += '\n';
  if (rec.type === 'exit') {
    body += 'Exit    : ' + rec.exit_date;
    if (rec.exit_time) body += '  ' + rec.exit_time;
    body += '\n';
    body += 'Stay    : ' + rec.duration + '\n';
    body += 'Rate    : Rs.' + rec.rate + '/day\n';
    body += SEP + '\n';
    body += 'TOTAL   : Rs.' + rec.amount + '\n';
  } else {
    body += 'Rate    : Rs.' + rec.rate + '/day\n';
    body += SEP + '\n';
    body += 'Amount will be billed on exit\n';
  }
  body += SEP + '\n';
  body += 'Ph: 9640019275 | 8885519275\n';
  body += 'Beside DRK College, Bowrampet';
  // Wrap in triple-backtick block so WhatsApp renders monospace
  // giving pixel-perfect column alignment regardless of font
  return TICK + '\n' + body + '\n' + TICK;
}
const shareOnWhatsApp = shareImageWhatsApp;