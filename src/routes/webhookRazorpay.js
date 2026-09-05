const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { getDb, isMongoConfigured } = require('../lib/mongodb');
const { getEventBySlug } = require('../lib/events');
const { toMobile, passDescription } = require('../lib/whatsapp');

const router = express.Router();

// Events we act on. Razorpay fires payment.captured AND order.paid for the same
// successful payment, so both are handled and the DB guard below keeps the pair
// from being applied twice.
const PAID_EVENTS = new Set(['payment.captured', 'order.paid']);
const FAILED_EVENTS = new Set(['payment.failed']);

/**
 * Constant-time signature check.
 *
 * A plain `expected !== signature` leaks, through timing, how much of a guess
 * was correct — which is the one thing a signature check must not do.
 * timingSafeEqual throws when the buffers differ in length, so length is
 * compared first (that much is public: it's a fixed-width hex digest).
 */
function signatureMatches(rawBody, signature, secret) {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature || ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Keep a record of every webhook we accept, whether or not it matched a
 * booking. When someone says "I paid but got no confirmation", this collection
 * is the only place that can answer whether Razorpay ever told us.
 * Best-effort: never let logging fail the request.
 */
async function audit(db, entry) {
  try {
    await db.collection('webhook_events').insertOne({ ...entry, received_at: new Date() });
  } catch (e) {
    console.warn('[webhook/razorpay] could not write audit row:', e.message);
  }
}

async function sendConfirmation(row) {
  const wUrl = config.flaxxa.url;
  const wToken = config.flaxxa.token;
  if (!wUrl || !wToken || !row.phone) return;

  const mobile = toMobile(row.phone);
  const passDesc = passDescription(row);

  let templateName = 'yatra_booking_confirmation';
  if (row.event_slug || row.event_code) {
    const eventDoc = await getEventBySlug(row.event_slug || row.event_code).catch(() => null);
    templateName =
      (eventDoc && eventDoc.payments && eventDoc.payments.whatsapp && eventDoc.payments.whatsapp.booking) ||
      templateName;
  }

  return fetch(wUrl, {
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

// Razorpay sends application/json; we need the RAW body to verify the
// signature, so this router consumes `express.raw` (mounted in index.js before
// JSON parsing, for this path only).
router.post('/', async (req, res) => {
  const secret = config.razorpay.webhookSecret;
  if (!secret) {
    console.error('[webhook/razorpay] RAZORPAY_WEBHOOK_SECRET is not set — rejecting');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  // Must be the byte-for-byte body Razorpay signed. If it isn't a Buffer the
  // raw parser didn't run for this content-type, and re-serialising a parsed
  // object would not reproduce those bytes — so fail loudly instead of
  // computing a signature over something else and reporting "invalid".
  if (!Buffer.isBuffer(req.body)) {
    console.error('[webhook/razorpay] body was parsed, not raw — check the express.raw mount in index.js');
    return res.status(500).json({ error: 'Raw body unavailable' });
  }
  const rawBody = req.body.toString('utf8');

  if (!signatureMatches(rawBody, req.headers['x-razorpay-signature'], secret)) {
    console.warn('[webhook/razorpay] invalid signature — ignoring');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Malformed JSON' });
  }

  const eventName = event && event.event;
  const deliveryId = String(req.headers['x-razorpay-event-id'] || '');
  const payment = event?.payload?.payment?.entity || null;
  const order = event?.payload?.order?.entity || null;

  // Nothing we act on — acknowledge so Razorpay stops retrying.
  if (!PAID_EVENTS.has(eventName) && !FAILED_EVENTS.has(eventName)) {
    return res.json({ ok: true, ignored: eventName || 'unknown' });
  }

  if (!isMongoConfigured()) {
    console.warn('[webhook/razorpay] MongoDB not configured — cannot reconcile', eventName);
    return res.json({ ok: true, reconciled: false });
  }
  if (!payment) {
    console.warn('[webhook/razorpay]', eventName, 'carried no payment entity');
    return res.json({ ok: true, reconciled: false });
  }

  const orderId = payment.order_id || order?.id || null;
  // The order's receipt is the booking ref (create-order writes it), so it is a
  // usable fallback for bookings made before order_id was stored on the row.
  const receipt = order?.receipt || null;

  try {
    const db = await getDb();

    // Retries deliver the same event id. Skip work we've already done rather
    // than sending a second WhatsApp message.
    if (deliveryId) {
      const seen = await db.collection('webhook_events').findOne({ delivery_id: deliveryId, handled: true });
      if (seen) return res.json({ ok: true, duplicate: true });
    }

    const match = { $or: [] };
    if (orderId) match.$or.push({ order_id: orderId });
    if (receipt) match.$or.push({ ref: receipt });
    if (match.$or.length === 0) {
      await audit(db, { delivery_id: deliveryId, event: eventName, handled: false, reason: 'no order_id or receipt' });
      return res.json({ ok: true, reconciled: false });
    }

    if (FAILED_EVENTS.has(eventName)) {
      // Only ever move a still-pending booking to failed — never contradict a
      // capture that already landed.
      const r = await db.collection('registrations').updateOne(
        { ...match, payment_status: 'pending' },
        { $set: { payment_status: 'failed', payment_id: payment.id, updated_at: new Date() } }
      );
      await audit(db, {
        delivery_id: deliveryId, event: eventName, handled: true,
        order_id: orderId, payment_id: payment.id, matched: r.matchedCount,
      });
      console.log('[webhook/razorpay] payment failed:', orderId, '→ rows updated:', r.modifiedCount);
      return res.json({ ok: true, reconciled: r.modifiedCount > 0 });
    }

    // Paid. The `$ne: 'paid'` guard makes this idempotent: whichever of
    // payment.captured / order.paid arrives first does the work, and the second
    // (and any retry) finds nothing to change.
    const row = await db.collection('registrations').findOneAndUpdate(
      { ...match, payment_status: { $ne: 'paid' } },
      {
        $set: {
          payment_status: 'paid',
          payment_id: payment.id,
          order_id: orderId,
          updated_at: new Date(),
        },
      },
      { returnDocument: 'after' }
    );

    if (!row) {
      // Either the browser already confirmed it (normal), or nothing matches
      // (needs a human) — the audit row tells them apart.
      const exists = await db.collection('registrations').findOne(match, { projection: { ref: 1, payment_status: 1 } });
      await audit(db, {
        delivery_id: deliveryId, event: eventName, handled: true,
        order_id: orderId, payment_id: payment.id, receipt,
        matched: exists ? 1 : 0,
        reason: exists ? 'already ' + exists.payment_status : 'no matching booking',
      });
      if (!exists) {
        console.warn('[webhook/razorpay] PAID but no matching booking — order', orderId, 'receipt', receipt);
      }
      return res.json({ ok: true, reconciled: false });
    }

    console.log('[webhook/razorpay] payment confirmed:', orderId, '→', payment.id, 'ref', row.ref);
    await audit(db, {
      delivery_id: deliveryId, event: eventName, handled: true,
      order_id: orderId, payment_id: payment.id, ref: row.ref, matched: 1,
    });

    await sendConfirmation(row);
    return res.json({ ok: true, reconciled: true });
  } catch (e) {
    // A non-2xx makes Razorpay retry, which is what we want for a transient
    // database problem.
    console.error('[webhook/razorpay] DB error:', e);
    return res.status(502).json({ error: String(e) });
  }
});

module.exports = router;
