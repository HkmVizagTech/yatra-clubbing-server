const express = require('express');
const config = require('../config');
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
  res.json({ orderId: order.id, amount: order.amount, currency: order.currency, keyId, receipt: finalReceipt });
});

module.exports = router;
