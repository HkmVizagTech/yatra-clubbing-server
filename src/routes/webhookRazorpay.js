const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { getDb, isMongoConfigured } = require('../lib/mongodb');
const { getEventBySlug } = require('../lib/events');
const { toMobile, passDescription } = require('../lib/whatsapp');

const router = express.Router();

// Razorpay sends application/json; we need the RAW body to verify the signature,
// so this router consumes `express.raw` (mounted in index.js before json parsing
// for this path only).
router.post('/', async (req, res) => {
  const secret = config.razorpay.webhookSecret;
  if (!secret) return res.status(500).json({ error: 'Webhook secret not configured' });

  const rawBody = Buffer.isBuffer(req.body)
    ? req.body.toString('utf8')
    : typeof req.body === 'string'
      ? req.body
      : JSON.stringify(req.body);
  const signature = String(req.headers['x-razorpay-signature'] || '');

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  if (expected !== signature) {
    console.warn('[webhook/razorpay] Invalid signature');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const event = JSON.parse(rawBody);
  const eventName = event && event.event;

  if (eventName === 'payment.captured' || eventName === 'order.paid') {
    const payment = event.payload && event.payload.payment && event.payload.payment.entity;
    if (!payment) return res.json({ ok: true });

    if (!isMongoConfigured()) {
      console.warn('[webhook/razorpay] MongoDB not configured');
      return res.json({ ok: true });
    }

    try {
      const db = await getDb();
      const row = await db.collection('registrations').findOneAndUpdate(
        { order_id: payment.order_id, payment_status: { $ne: 'paid' } },
        { $set: { payment_status: 'paid', payment_id: payment.id } },
        { returnDocument: 'after' }
      );

      if (!row) {
        // Already paid or not found — idempotent, not an error
        return res.json({ ok: true });
      }

      console.log('[webhook/razorpay] Payment confirmed:', payment.order_id, '→', payment.id);

      const wUrl = config.flaxxa.url;
      const wToken = config.flaxxa.token;
      if (wUrl && wToken && row.phone) {
        const mobile = toMobile(row.phone);
        const passDesc = passDescription(row);

        let templateName = 'yatra_booking_confirmation';
        if (row.event_slug || row.event_code) {
          const eventDoc = await getEventBySlug(row.event_slug || row.event_code).catch(() => null);
          templateName =
            (eventDoc && eventDoc.payments && eventDoc.payments.whatsapp && eventDoc.payments.whatsapp.booking) ||
            templateName;
        }

        fetch(wUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + wToken },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: mobile,
            type: 'template',
            template: {
              name: templateName,
              language: { code: 'en' },
              components: [{ type: 'body', parameters: [
                { type: 'text', text: row.name || 'Devotee' },
                { type: 'text', text: passDesc },
                { type: 'text', text: String(row.total || 0) },
                { type: 'text', text: row.ref || '' },
              ] }],
            },
          }),
        }).catch((e) => console.warn('[webhook/razorpay] WhatsApp failed:', e.message));
      }
    } catch (e) {
      console.error('[webhook/razorpay] DB error:', e);
      return res.status(502).json({ error: String(e) });
    }
  }

  return res.json({ ok: true });
});

module.exports = router;
