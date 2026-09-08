const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { getDb, isMongoConfigured } = require('../lib/mongodb');

const router = express.Router();

/**
 * Gupshup callback receiver for outbound WhatsApp template messages.
 *
 * Register this URL as the app's callback in the Gupshup dashboard, e.g.
 *
 *   https://<host>/api/webhook/gupshup
 *
 * Gupshup POSTs JSON for every lifecycle event of a template message —
 * enqueued → sent → delivered → read, or failed — and this endpoint records
 * each one so message deliveries can be tracked from the logs and the
 * registrations collection.
 *
 * The signature/headers are verified when GUPSHUP_WEBHOOK_SECRET is configured:
 * Gupshup signs requests either with the `x-gupshup-signature` header (HMAC
 * SHA-256 hex of the raw body, keyed by the app token) or with the `GupShup`
 * header carrying the raw token. When no secret is set (local dev) any payload
 * is accepted and the missing config is logged so the gap is visible in the
 * deploy log rather than silent.
 */

// Constant-time compare; the Razorpay webhook has the same helper.
function constantEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function signatureMatches(rawBody, signature, secret) {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return constantEqual(expected, signature);
}

// A booking WhatsApp message id (ABG…) looks nothing like a phone number, so
// these are keys into log/storage fields — keep them free of PII en route.
function maskPhone(destination) {
  const d = String(destination || '');
  if (!d) return '';
  return d.length >= 7 ? d.slice(0, 2) + '******' + d.slice(-2) : '**masked**';
}

router.get('/', (req, res) => {
  res.json({ ok: true, service: 'gupshup-webhook' });
});

router.post('/', async (req, res) => {
  // The raw parser (mounted in index.js before the JSON parser) gives us the
  // exact bytes Gupshup signed. If the body isn't a Buffer the mount broke.
  if (!Buffer.isBuffer(req.body)) {
    console.error('[webhook/gupshup] body was parsed, not raw — check the express.raw mount in index.js');
    return res.status(500).json({ error: 'Raw body unavailable' });
  }
  const rawBody = req.body.toString('utf8');

  const secret = config.gupshup.webhookSecret;
  const signedHeader = req.headers['x-gupshup-signature'];
  const tokenHeader = req.headers['gupshup'];
  const tokenValid =
    tokenHeader && (constantEqual(tokenHeader, secret) || constantEqual(tokenHeader, config.gupshup.apiKey));

  if (secret) {
    const signedOk = signedHeader && signatureMatches(rawBody, signedHeader, secret);
    if (!signedOk && !tokenValid) {
      // Signature vs token: whichever failed, do not say which header was wrong
      // in the response — the endpoint is public and that detail is a hint.
      console.warn('[webhook/gupshup] request rejected — bad or missing auth headers');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } else {
    console.warn('[webhook/gupshup] GUPSHUP_WEBHOOK_SECRET is not set — accepting unverified callbacks');
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Malformed JSON' });
  }
  if (!event || typeof event !== 'object') {
    return res.status(400).json({ error: 'Expected a JSON object' });
  }

  const eventType = String(event.eventType || event.type || 'unknown');
  const payload = event && typeof event.payload === 'object' ? event.payload : {};
  const messageId = payload.id || event.id || null;
  const destination = event.destination || null;
  const errorCode = event.errorCode || payload.errorCode || null;
  const reason = event.errorReason || event.details || payload.reason || null;
  const ts = Number(event.ts) || null;

  console.log(
    '[webhook/gupshup]',
    eventType,
    JSON.stringify({
      messageId: messageId || null,
      destination: maskPhone(destination),
      ts,
      errorCode: errorCode || null,
      reason: (reason || '').toString().slice(0, 200) || null,
    })
  );

  // Persist + reconcile against the booking whose confirmation this message was.
  if (!isMongoConfigured()) {
    console.warn('[webhook/gupshup] MongoDB not configured — not persisting');
    return res.json({ ok: true, event: eventType });
  }

  try {
    const db = await getDb();

    // Idempotent audit trail: a (messageId, eventType) pair is recorded once.
    if (messageId) {
      const key = `${eventType}:${messageId}`;
      await db.collection('webhook_events').updateOne(
        { source: 'gupshup', dedupe: key },
        {
          $setOnInsert: {
            source: 'gupshup',
            dedupe: key,
            event_type: eventType,
            message_id: String(messageId),
            destination,
            error_code: errorCode ? String(errorCode) : null,
            reason: reason ? String(reason).slice(0, 300) : null,
            gupshup_ts: ts,
            received_at: new Date(),
          },
        },
        { upsert: true }
      );
    }

    // Stamp the booking status fields so the admin exports can say whether the
    // confirmation was actually delivered, read, or failed.
    const statusField = {
      delivered: 'whatsapp_delivered_at',
      read: 'whatsapp_read_at',
      failed: 'whatsapp_failed_at',
    }[eventType];

    if (messageId && statusField) {
      const set = { whatsapp_status: eventType, [statusField]: new Date(), whatsapp_status_at: new Date() };
      if (eventType === 'failed' && reason) {
        set.whatsapp_failure_reason = String(reason).slice(0, 300);
      }
      const r = await db.collection('registrations').updateOne(
        { whatsapp_message_id: String(messageId) },
        { $set: set }
      );
      if (r.matchedCount > 0) {
        console.log('[webhook/gupshup] stamped booking', eventType, 'for message', messageId);
      }
    }
  } catch (e) {
    // Never fail the request because logging did — Gupshup would retry forever.
    console.warn('[webhook/gupshup] could not persist callback:', e.message);
  }

  return res.json({ ok: true, event: eventType });
});

module.exports = router;