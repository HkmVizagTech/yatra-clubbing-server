const express = require('express');
const config = require('../config');
const { getDb, isMongoConfigured } = require('../lib/mongodb');
const { getEventBySlug } = require('../lib/events');

const router = express.Router();

// POST /api/create-order
router.post('/', async (req, res) => {
  const { keyId, keySecret } = config.razorpay;
  if (!keyId || !keySecret) {
    return res.status(503).json({ error: 'Razorpay not configured' });
  }

  const body = req.body || {};
  const amount = body.amount;
  if (!amount) return res.status(400).json({ error: 'amount required' });

  // Ensure the receipt uses the event's prefix so refund-audit scopes correctly.
  let finalReceipt = body.receipt || 'yatra';
  const eventId = body.event_code || body.event_slug;
  if (eventId) {
    const event = await getEventBySlug(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const prefix = (event.payments && event.payments.receiptPrefix) || 'YC-';
    if (!finalReceipt.startsWith(prefix)) {
      finalReceipt = finalReceipt.replace(/^[A-Za-z]{1,3}-/, '');
      finalReceipt = prefix + finalReceipt.toUpperCase();
    }
  }

  const credentials = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const r = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${credentials}` },
    body: JSON.stringify({ amount: Math.round(amount * 100), currency: 'INR', receipt: finalReceipt }),
  });

  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    return res.status(502).json({ error: 'Razorpay order failed', detail });
  }

  const order = await r.json();

  // Record the order id against the pending registration NOW, before the person
  // is handed to Razorpay's checkout.
  //
  // The webhook reconciles a payment by looking up { order_id }. Until this
  // write, order_id was only stored by the browser's own follow-up call after a
  // successful payment — so if the tab was closed, the network dropped, or the
  // handler never ran, the webhook had nothing to match and the booking stayed
  // "pending" despite the money having been taken. Writing it here is what makes
  // the webhook able to do its job.
  // The booking modal sends the ref as `receipt`; accept either. Match on the
  // ORIGINAL value, not finalReceipt — the prefix rewrite above can change the
  // receipt string, but the registration row keeps the ref the browser made.
  const bookingRef = String(body.ref || body.receipt || '').trim();

  if (isMongoConfigured() && bookingRef) {
    try {
      const db = await getDb();
      const query = { ref: bookingRef };
      if (eventId) query.event_code = eventId;
      await db.collection('registrations').updateOne(
        query,
        { $set: { order_id: order.id, updated_at: new Date() } }
      );
    } catch (e) {
      // Never block checkout on this — the browser still reports the payment.
      console.warn('[create-order] could not attach order_id to', bookingRef, '-', e.message);
    }
  }

  res.json({ orderId: order.id, amount: order.amount, currency: order.currency, keyId, receipt: finalReceipt });
});

module.exports = router;
