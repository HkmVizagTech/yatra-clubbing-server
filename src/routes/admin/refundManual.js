const express = require('express');
const config = require('../../config');
const { getDb, isMongoConfigured } = require('../../lib/mongodb');
const { isAdminAuthorized } = require('../../lib/auth');

const router = express.Router();

async function issueRefund(paymentId) {
  const { keyId, keySecret } = config.razorpay;
  if (!keyId || !keySecret) return { ok: false, error: 'Razorpay not configured' };

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

  try {
    // First fetch payment details to get the amount
    const payRes = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    const payData = await payRes.json();

    if (!payRes.ok) {
      return { ok: false, error: (payData.error && payData.error.description) || `Payment fetch failed: HTTP ${payRes.status}` };
    }

    // Attempt full refund
    const refRes = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}/refund`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const refData = await refRes.json();

    if (refRes.ok && refData.id) {
      return { ok: true, refundId: refData.id, amount: payData.amount };
    }

    const desc = (refData.error && refData.error.description) || '';
    if (desc.toLowerCase().includes('already') && desc.toLowerCase().includes('refund')) {
      return { ok: true, refundId: 'already-refunded', amount: payData.amount };
    }

    return { ok: false, error: desc || `HTTP ${refRes.status}` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// POST /api/admin/refund-manual
router.post('/refund-manual', async (req, res) => {
  if (!isAdminAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const body = req.body || {};
  const ids = (body.paymentIds || []).map((s) => String(s).trim()).filter(Boolean);

  if (!ids.length) return res.status(400).json({ error: 'No payment IDs provided' });

  const db = isMongoConfigured() ? await getDb() : null;

  const results = [];
  for (const paymentId of ids) {
    const resR = await issueRefund(paymentId);

    // Try to mark in MongoDB if a booking exists with this payment_id
    if (db && resR.ok) {
      await db.collection('registrations')
        .updateOne(
          { payment_id: paymentId },
          { $set: { payment_status: 'refunded', refund_id: resR.refundId, refunded_at: new Date() } }
        )
        .catch(() => {});
    }

    results.push({ paymentId, ...resR });
  }

  const refunded = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  res.json({ refunded, failed, results });
});

module.exports = router;
