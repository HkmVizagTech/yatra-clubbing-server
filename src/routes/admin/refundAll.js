const express = require('express');
const config = require('../../config');
const { getDb, isMongoConfigured } = require('../../lib/mongodb');
const { isAdminAuthorized } = require('../../lib/auth');

const router = express.Router();

function requireAdmin(res) {
  return function (req) {
    if (!isAdminAuthorized(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return false;
    }
    return true;
  };
}

async function issueRefund(paymentId) {
  const { keyId, keySecret } = config.razorpay;
  if (!keyId || !keySecret) return { ok: false, error: 'Razorpay not configured' };

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

  try {
    const r = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}/refund`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}), // empty body = full refund
    });
    const data = await r.json();

    if (r.ok && data.id) return { ok: true, refundId: data.id };

    const desc = (data.error && data.error.description) || '';
    // Treat "already fully refunded" as success so re-runs are idempotent
    if (desc.includes('already') || desc.includes('fully refunded') || (data.error && data.error.code === 'BAD_REQUEST_ERROR')) {
      const details = desc.toLowerCase();
      if (details.includes('refund') && details.includes('already')) return { ok: true, refundId: 'already-refunded' };
    }

    return { ok: false, error: desc || `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function eventCodeQuery(req) {
  return String(req.query.event_code || req.query.event_slug || '');
}

// GET /api/admin/refund-all
router.get('/refund-all', async (req, res) => {
  if (!requireAdmin(res)(req)) return;
  if (!isMongoConfigured()) return res.status(500).json({ error: 'MongoDB not configured' });

  const code = eventCodeQuery(req);
  const db = await getDb();
  const query = { payment_status: 'paid', payment_id: { $exists: true, $ne: null } };
  if (code) query.event_code = code;
  const paid = await db.collection('registrations')
    .find(query)
    .project({ ref: 1, name: 1, phone: 1, total: 1, payment_id: 1, payment_status: 1 })
    .toArray();

  const refundQuery = { payment_status: 'refunded' };
  if (code) refundQuery.event_code = code;
  const refunded = await db.collection('registrations').countDocuments(refundQuery);

  res.json({
    pending: paid.length,
    alreadyRefunded: refunded,
    bookings: paid.map((b) => ({ ref: b.ref, name: b.name, phone: b.phone, total: b.total, payment_id: b.payment_id })),
  });
});

// POST /api/admin/refund-all
router.post('/refund-all', async (req, res) => {
  if (!requireAdmin(res)(req)) return;
  if (!isMongoConfigured()) return res.status(500).json({ error: 'MongoDB not configured' });

  const code = eventCodeQuery(req);
  const db = await getDb();
  const query = { payment_status: 'paid', payment_id: { $exists: true, $ne: null } };
  if (code) query.event_code = code;
  const paid = await db.collection('registrations').find(query).toArray();

  const results = [];
  for (const booking of paid) {
    const resR = await issueRefund(String(booking.payment_id));
    if (resR.ok) {
      await db.collection('registrations').updateOne(
        { ref: booking.ref },
        { $set: { payment_status: 'refunded', refund_id: resR.refundId, refunded_at: new Date() } }
      );
    }
    results.push({ ref: booking.ref, name: booking.name, phone: booking.phone, total: booking.total || 0, ok: resR.ok, refundId: resR.refundId, error: resR.error });
  }

  const refunded = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  res.json({ refunded, failed, total: paid.length, results });
});

module.exports = router;
