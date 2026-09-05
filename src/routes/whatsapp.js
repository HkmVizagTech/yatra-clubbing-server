const express = require('express');
const config = require('../config');
const { getEventBySlug } = require('../lib/events');
const { bookingParams, sendTemplate } = require('../lib/whatsapp');

const router = express.Router();

// POST /api/whatsapp — booking confirmation, sent by the browser right after a
// successful payment. The webhook sends the same template when the browser
// never comes back, so both paths build their parameters the same way.
router.post('/', async (req, res) => {
  const url = config.flaxxa.url;
  const token = config.flaxxa.token;
  if (!url || !token) {
    return res.json({ sent: false, reason: 'WhatsApp env vars not set' });
  }

  const body = req.body || {};
  const { phone, event_code, event_slug } = body;
  if (!phone) return res.status(400).json({ sent: false, error: 'Missing phone' });

  // Every parameter beyond the devotee's own details comes from the event, so
  // the template stays reusable across events.
  const eventId = event_code || event_slug;
  const event = eventId ? await getEventBySlug(eventId).catch(() => null) : null;

  const templateName =
    (event && event.payments && event.payments.whatsapp && event.payments.whatsapp.booking) ||
    'yatra_booking_confirmation';

  // Shape the request body like a stored registration so one builder serves both.
  const row = {
    name: body.name,
    ref: body.ref,
    total: body.total,
    raw: { tickets: body.tickets || {} },
  };

  const parameters = bookingParams(row, event);
  const sent = await sendTemplate({ url, token, phone, templateName, parameters });
  res.json({ sent, template: templateName, parameters: parameters.map((p) => p.text) });
});

module.exports = router;
