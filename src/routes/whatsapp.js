const express = require('express');
const { getEventBySlug } = require('../lib/events');
const { bookingParams, eventFields, resolveTemplateId, sendBookingConfirmation } = require('../lib/whatsapp');

const router = express.Router();

// POST /api/whatsapp — booking confirmation, sent by the browser the moment a
// payment succeeds. The Razorpay webhook sends the same template when the
// browser never comes back, so both paths build their parameters the same way.
router.post('/', async (req, res) => {
  const body = req.body || {};
  const { phone, event_code, event_slug } = body;
  if (!phone) return res.status(400).json({ sent: false, error: 'Missing phone' });

  // Every parameter beyond the devotee's own details comes from the event, so
  // one approved template stays reusable across yatras.
  const eventId = event_code || event_slug;
  const event = eventId ? await getEventBySlug(eventId).catch(() => null) : null;

  // Shape the request body like a stored registration so one builder serves both.
  const row = {
    name: body.name,
    phone,
    ref: body.ref,
    total: body.total,
    raw: { tickets: body.tickets || {} },
  };

  const result = await sendBookingConfirmation(row, event);
  res.json({
    ...result,
    template: resolveTemplateId('booking', event),
    parameters: bookingParams(row, event),
    // Not sent — the approved template hardcodes these. Returned so the admin
    // can see what a template with variables would have been able to include.
    available: eventFields(row, event),
  });
});

module.exports = router;
