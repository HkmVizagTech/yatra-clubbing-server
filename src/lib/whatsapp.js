const config = require('../config');

function toMobile(phone) {
  return '91' + String(phone || '').replace(/\D/g, '').slice(-10);
}

function passDescription(row) {
  return [
    (row.qty_general || 0) > 0 ? `General × ${row.qty_general}` : '',
    (row.qty_student || 0) > 0 ? `Student × ${row.qty_student}` : '',
  ]
    .filter(Boolean)
    .join(', ') || 'Pass';
}

// Fire-and-forget WhatsApp template message via Flaxxa. Never throws.
function sendWhatsApp({ name, phone, ref, total, passDesc, templateName }) {
  const { url, token } = config.flaxxa;
  if (!url || !token || !phone) return;

  const mobile = toMobile(phone);
  const params = [
    { type: 'text', text: name || 'Devotee' },
    { type: 'text', text: passDesc || 'Pass' },
    { type: 'text', text: String(total ?? 0) },
    { type: 'text', text: ref || '' },
  ];

  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: mobile,
      type: 'template',
      template: { name: templateName || 'yatra_booking_confirmation', language: { code: 'en' }, components: [{ type: 'body', parameters: params }] },
    }),
  }).catch((e) => console.warn('[whatsapp] send failed:', e.message));
}

module.exports = { toMobile, passDescription, sendWhatsApp };
