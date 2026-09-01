const express = require('express');
const config = require('../config');
const { getEventBySlug } = require('../lib/events');
const { toMobile, passDescription } = require('../lib/whatsapp');

const router = express.Router();

// POST /api/whatsapp
router.post('/', async (req, res) => {
  const url = config.flaxxa.url;
  const token = config.flaxxa.token;

  if (!url || !token) {
    return res.json({ sent: false, reason: 'WhatsApp env vars not set' });
  }

  const body = req.body || {};
  const { name = 'Devotee', phone, ref = '', total = '', tickets = {}, event_code, event_slug } = body;
  if (!phone) return res.status(400).json({ sent: false, error: 'Missing phone' });

  let templateName = 'yatra_booking_confirmation';
  const eventId = event_code || event_slug;
  if (eventId) {
    const event = await getEventBySlug(eventId).catch(() => null);
    templateName = (event && event.payments && event.payments.whatsapp && event.payments.whatsapp.booking) || templateName;
  }

  const mobile = toMobile(phone);
  const passDesc = passDescription({ qty_general: tickets.general ?? 0, qty_student: tickets.student ?? 0 });

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: mobile,
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'en' },
        components: [{ type: 'body', parameters: [
          { type: 'text', text: name },
          { type: 'text', text: passDesc },
          { type: 'text', text: String(total) },
          { type: 'text', text: ref },
        ] }],
      },
    }),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) console.warn('[whatsapp] error', r.status, JSON.stringify(data));
  res.json({ sent: r.ok, status: r.status, data });
});

module.exports = router;
