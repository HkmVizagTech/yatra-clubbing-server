const crypto = require('crypto');
const express = require('express');
const config = require('../config');

const router = express.Router();

// POST /api/verify-payment
router.post('/', async (req, res) => {
  const secret = config.razorpay.keySecret;
  if (!secret) return res.status(500).json({ error: 'Razorpay secret not configured' });

  const body = req.body || {};
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ valid: false, error: 'Missing fields' });
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(String(razorpay_signature));
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);

  return res.status(valid ? 200 : 400).json({ valid });
});

module.exports = router;
