const express = require('express');
const config = require('../../config');
const { getDb, isMongoConfigured } = require('../../lib/mongodb');
const { isAdminAuthorized } = require('../../lib/auth');
const { getEventBySlug } = require('../../lib/events');

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

async function fetchAllPages(url, auth) {
  const all = [];
  let skip = 0;
  const count = 100;

  while (true) {
    const r = await fetch(`${url}?count=${count}&skip=${skip}`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!r.ok) throw new Error(`Razorpay request failed: HTTP ${r.status} (${url})`);
    const data = await r.json();
    all.push(...(data.items || []));
    if (!data.items || data.items.length < count) break;
    skip += count;
    if (skip > 10000) break; // safety cap
  }

  return all;
}

function requireAdminCheck(req, res) {
  return isAdminAuthorized(req);
}

// GET /api/admin/refund-audit
router.get('/refund-audit', async (req, res) => {
  if (!requireAdminCheck(req, res)) return res.status(401).json({ error: 'Unauthorized' });

  const { keyId, keySecret } = config.razorpay;
  if (!keyId || !keySecret) return res.status(500).json({ error: 'Razorpay not configured' });

  const code = String(req.query.event_code || req.query.event_slug || '');

  // Our platform creates Razorpay orders with receipt = booking ref (e.g. "YC-XXXXXX").
  // The prefix is per-event, so the audit scopes to that event's receipts only.
  let receiptPrefix = 'YC-';
  if (code) {
    const event = await getEventBySlug(code).catch(() => null);
    if (event && event.payments && event.payments.receiptPrefix) {
      receiptPrefix = event.payments.receiptPrefix;
    }
  }
  const ourReceiptPattern = new RegExp('^' + receiptPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

  let payments, orders;
  try {
    [payments, orders] = await Promise.all([
      fetchAllPages('https://api.razorpay.com/v1/payments', auth),
      fetchAllPages('https://api.razorpay.com/v1/orders', auth),
    ]);
  } catch (e) {
    return res.status(502).json({ error: String(e) });
  }

  // Scope to only orders our platform created (receipt = booking ref)
  const ourOrderIds = new Set(
    orders.filter((o) => o.receipt && ourReceiptPattern.test(o.receipt)).map((o) => o.id)
  );

  // Only payments that were actually captured (money taken) AND belong to one of our orders
  const captured = payments.filter(
    (p) =>
      (p.captured || p.status === 'captured' || p.status === 'refunded') &&
      p.order_id &&
      ourOrderIds.has(p.order_id)
  );

  // Cross-reference with MongoDB for name/ref where available
  const regByPaymentId = new Map();
  if (isMongoConfigured()) {
    const db = await getDb();
    const regs = await db.collection('registrations')
      .find({ payment_id: { $exists: true, $ne: null } })
      .project({ ref: 1, name: 1, phone: 1, payment_id: 1 })
      .toArray();
    for (const r of regs) regByPaymentId.set(String(r.payment_id), { ref: r.ref, name: r.name, phone: r.phone });
  }

  const rows = captured.map((p) => {
    const match = regByPaymentId.get(p.id);
    const fullyRefunded = p.refund_status === 'full' || p.amount_refunded >= p.amount;
    const partiallyRefunded = p.refund_status === 'partial' && !fullyRefunded;
    return {
      paymentId: p.id,
      ref: (match && match.ref) || null,
      name: (match && match.name) || (p.notes && p.notes.name) || null,
      phone: (match && match.phone) || p.contact || null,
      amount: p.amount, // paise
      amountRefunded: p.amount_refunded,
      status: fullyRefunded ? 'refunded' : partiallyRefunded ? 'partial' : 'not_refunded',
      trackedInDb: Boolean(match),
      createdAt: new Date(p.created_at * 1000).toISOString(),
    };
  });

  const notRefunded = rows.filter((r) => r.status !== 'refunded');
  const refunded = rows.filter((r) => r.status === 'refunded');
  const untracked = rows.filter((r) => !r.trackedInDb);

  res.json({
    totalCaptured: rows.length,
    refundedCount: refunded.length,
    notRefundedCount: notRefunded.length,
    untrackedCount: untracked.length,
    notRefundedAmount: notRefunded.reduce((s, r) => s + (r.amount - r.amountRefunded), 0),
    rows: rows.sort((a, b) => (a.status === 'refunded' ? 1 : 0) - (b.status === 'refunded' ? 1 : 0)),
  });
});

module.exports = router;
