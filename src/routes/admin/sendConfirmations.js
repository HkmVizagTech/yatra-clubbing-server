const express = require('express');
const { getDb, isMongoConfigured } = require('../../lib/mongodb');
const { isAdminAuthorized } = require('../../lib/auth');
const { getEventBySlug } = require('../../lib/events');
const { sendBookingConfirmation, resolveTemplateId } = require('../../lib/whatsapp');

const router = express.Router();

// Gupshup is fine with a burst this small, but pacing the sends keeps one
// throttled response from cascading through the whole batch.
const GAP_MS = 400;

function requireAdmin(req, res) {
  if (!isAdminAuthorized(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Who still needs a confirmation.
 *
 * Eligible = paid, has a phone, and has never been stamped by
 * recordConfirmationSent(). `includeUnpaid` exists for the rare case of a
 * booking marked pending that the team knows was actually paid; it is off by
 * default so a routine run can never message someone who has not paid.
 */
async function findPending(db, { eventCode, includeUnpaid, refs }) {
  const query = {};
  if (eventCode) query.event_code = eventCode;
  if (Array.isArray(refs) && refs.length) query.ref = { $in: refs };
  if (!includeUnpaid) query.payment_status = 'paid';

  const rows = await db.collection('registrations')
    .find(query)
    .sort({ created_at: 1 })
    .toArray();

  const already = [];
  const noPhone = [];
  const pending = [];
  rows.forEach((r) => {
    if (r.whatsapp_sent_at) already.push(r);
    else if (!r.phone) noPhone.push(r);
    else pending.push(r);
  });
  return { rows, pending, already, noPhone };
}

function summarise(r) {
  return {
    ref: r.ref,
    name: r.name,
    phone: r.phone,
    total: r.total,
    payment_status: r.payment_status,
    created_at: r.created_at,
    whatsapp_sent_at: r.whatsapp_sent_at || null,
  };
}

// GET /api/admin/send-confirmations?event_code=YJ
//
// Preview only — never sends. This is the safe way to see who the POST would
// message before any message leaves.
router.get('/send-confirmations', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!isMongoConfigured()) return res.json({ configured: false, pending: [] });

  const eventCode = String(req.query.event_code || req.query.event_slug || '');
  const includeUnpaid = req.query.include_unpaid === '1';

  try {
    const db = await getDb();
    const { pending, already, noPhone } = await findPending(db, { eventCode, includeUnpaid });
    const event = eventCode ? await getEventBySlug(eventCode).catch(() => null) : null;

    res.json({
      configured: true,
      event_code: eventCode || null,
      template: resolveTemplateId('booking', event),
      counts: {
        pending: pending.length,
        alreadySent: already.length,
        missingPhone: noPhone.length,
      },
      pending: pending.map(summarise),
      alreadySent: already.map(summarise),
      missingPhone: noPhone.map(summarise),
    });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// POST /api/admin/send-confirmations?event_code=YJ   body: { confirm: true }
//
// Sends the booking confirmation to everyone the GET above lists as pending.
// Real messages go out, so it refuses to run without an explicit
// `confirm: true` in the body — a bare POST from a stray click does nothing.
//
// Safe to re-run: each successful send stamps whatsapp_sent_at, and stamped
// rows are skipped. Pass `refs` to target specific bookings, and `resend: true`
// (which requires `refs`) to deliberately message someone a second time.
router.post('/send-confirmations', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!isMongoConfigured()) return res.json({ configured: false, sent: 0 });

  const body = req.body || {};
  if (body.confirm !== true) {
    return res.status(400).json({
      error: 'Refusing to send without { "confirm": true } in the body.',
      hint: 'GET this same path first to see exactly who would be messaged.',
    });
  }

  const eventCode = String(req.query.event_code || body.event_code || '');
  const includeUnpaid = body.include_unpaid === true;
  const refs = Array.isArray(body.refs) ? body.refs.map(String).filter(Boolean) : null;
  const resend = body.resend === true;

  if (resend && (!refs || !refs.length)) {
    return res.status(400).json({
      error: 'resend:true needs an explicit refs list, so a re-send is always deliberate.',
    });
  }

  try {
    const db = await getDb();
    const found = await findPending(db, { eventCode, includeUnpaid, refs });

    // On a deliberate resend the already-stamped rows are the whole point.
    const targets = resend
      ? found.rows.filter((r) => r.phone)
      : found.pending;

    if (!targets.length) {
      return res.json({
        configured: true,
        sent: 0,
        failed: 0,
        skipped: {
          alreadySent: found.already.length,
          missingPhone: found.noPhone.length,
        },
        results: [],
        note: 'Nobody is waiting on a confirmation.',
      });
    }

    // The event is loaded once, not per row: every target shares it, and it is
    // only needed to resolve the template id.
    const event = eventCode ? await getEventBySlug(eventCode).catch(() => null) : null;
    if (!resolveTemplateId('booking', event)) {
      return res.status(400).json({
        error: 'No Gupshup booking template id is configured — set GUPSHUP_TEMPLATE_BOOKING.',
      });
    }

    const results = [];
    for (const row of targets) {
      // Sequential on purpose: paced sends, and a clear per-row outcome the
      // admin can act on rather than one opaque batch failure.
      const eventForRow = eventCode
        ? event
        : await getEventBySlug(row.event_slug || row.event_code).catch(() => null);

      const outcome = await sendBookingConfirmation(row, eventForRow);
      results.push({
        ref: row.ref,
        name: row.name,
        phone: row.phone,
        ...outcome,
      });
      if (targets.length > 1) await sleep(GAP_MS);
    }

    const sent = results.filter((r) => r.sent).length;
    res.json({
      configured: true,
      sent,
      failed: results.length - sent,
      skipped: {
        alreadySent: resend ? 0 : found.already.length,
        missingPhone: found.noPhone.length,
      },
      results,
    });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

module.exports = router;
