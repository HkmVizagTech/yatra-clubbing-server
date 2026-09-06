const config = require('../config');

const FALLBACK = 'To be shared';

/** Gupshup wants a bare country-code number: 919848012345, no + and no spaces. */
function toMobile(phone) {
  return '91' + String(phone || '').replace(/\D/g, '').slice(-10);
}

/**
 * Sanitise one template parameter.
 *
 * WhatsApp rejects the whole message if a parameter is an empty string, or
 * contains a newline, a tab, or four or more consecutive spaces. Every slot
 * therefore gets a non-empty fallback rather than being left blank — dropping a
 * parameter is not an option either, because the count must match the approved
 * template exactly.
 */
function param(value, fallback = FALLBACK) {
  const text = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {4,}/g, '   ')
    .trim();
  return text || fallback;
}

/** "₹1,299" — amounts read as money, not as a bare number. */
function inr(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return FALLBACK;
  return '₹' + n.toLocaleString('en-IN');
}

/**
 * "General × 2, Student × 1" for ANY tier set.
 *
 * The registration row stores per-tier counts under raw.tickets keyed by tier
 * key, so tier names come from the event. Legacy rows that predate raw.tickets
 * still fall back to the two counts.
 */
function passDescription(row, event) {
  const tiers = event && Array.isArray(event.tickets) ? event.tickets : [];
  const nameFor = (key) => {
    const tier = tiers.find((t) => t.key === key);
    if (tier && tier.name) return tier.name;
    return String(key).charAt(0).toUpperCase() + String(key).slice(1);
  };

  const counts = row && row.raw && row.raw.tickets;
  if (counts && typeof counts === 'object') {
    const parts = Object.keys(counts)
      .filter((key) => Number(counts[key]) > 0)
      .map((key) => `${nameFor(key)} × ${Number(counts[key])}`);
    if (parts.length) return parts.join(', ');
  }

  const legacy = [
    Number(row && row.qty_general) > 0 ? `General × ${row.qty_general}` : '',
    Number(row && row.qty_student) > 0 ? `Student × ${row.qty_student}` : '',
  ].filter(Boolean).join(', ');

  return legacy || 'Pass';
}

/**
 * Body parameters for the booking-confirmation template, IN TEMPLATE ORDER.
 *
 * ── This list is the contract with the approved template ────────────────────
 * WhatsApp matches parameters by position, not by name, and the count is frozen
 * once a template is approved: send the wrong number and every message is
 * rejected. So this array must mirror the approved body exactly.
 *
 * The approved template (acd5438d-…) has exactly ONE variable:
 *
 *   {{1}} devotee name
 *
 * Its date, start time, stop list and prasadam note are written into the
 * template text itself rather than passed in. That means the template is tied
 * to one yatra — a yatra on another date or route needs a new template, or this
 * one re-approved with variables for those fields.
 *
 * If variables are ever added to the template, extend this array in the same
 * order. `eventFields()` below already computes the obvious candidates (event
 * name, ref, passes, amount, date, timing, venue), so wiring them up is a
 * matter of appending them here.
 */
function bookingParams(row, event) {
  return [
    param(row && row.name, 'Devotee'),
  ];
}

/**
 * The values a richer booking template could fill in, ready to append to
 * bookingParams() when the template gains variables. Kept separate — and
 * exported for the /api/whatsapp response — so the live parameter list stays
 * unambiguous.
 */
function eventFields(row, event) {
  return {
    eventName: param(event && event.name, 'Yatra Clubbing'),
    ref: param(row && row.ref, '—'),
    passes: param(passDescription(row, event), 'Pass'),
    amount: param(inr(row && row.total)),
    date: param(event && event.dates && event.dates.display),
    timing: param(event && event.timing),
    venue: param(event && event.venue),
  };
}

/**
 * Student-ID outcome templates.
 *
 *   approved: {{1}} name  {{2}} event name  {{3}} booking ref  {{4}} date
 *   rejected: {{1}} name  {{2}} event name  {{3}} booking ref  {{4}} reason
 */
function studentParams(row, event, { approved, reason } = {}) {
  return [
    param(row && row.name, 'Devotee'),
    param(event && event.name, 'Yatra Clubbing'),
    param(row && row.ref, '—'),
    approved
      ? param(event && event.dates && event.dates.display)
      : param(reason, 'The ID photo could not be verified'),
  ];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which template to send, for one of 'booking' | 'studentApproved' | 'studentRejected'.
 *
 * Gupshup addresses templates by UUID, while the event record's
 * payments.whatsapp.* fields hold human template NAMES (they were written for
 * the Meta-style API). So an event override is only usable here when it is
 * actually a UUID; anything else falls back to the env default, which is where
 * the real Gupshup template ids live. Returning null — rather than guessing —
 * is deliberate: a wrong id is a message sent to the wrong template.
 */
function resolveTemplateId(kind, event) {
  const override = event && event.payments && event.payments.whatsapp
    ? event.payments.whatsapp[kind]
    : '';
  if (override && UUID_RE.test(String(override).trim())) return String(override).trim();
  const fallback = config.gupshup.templates[kind];
  return fallback && UUID_RE.test(fallback) ? fallback : null;
}

/**
 * Post one template message through Gupshup.
 *
 * Fire-and-forget by design: a WhatsApp failure must never fail a booking that
 * has already been paid for, so this never throws and never blocks the caller.
 * It resolves to a small result object so callers that DO want to report status
 * (the /api/whatsapp route) can.
 *
 * Gupshup's template endpoint is form-encoded, not JSON, and the template
 * itself travels as a JSON string inside one form field.
 */
function sendGupshup({ phone, templateId, params, label = 'template' }) {
  const { apiKey, appName, source, apiUrl } = config.gupshup;

  if (!apiKey || !appName || !source) {
    return Promise.resolve({ sent: false, reason: 'Gupshup env vars not set' });
  }
  if (!templateId) {
    return Promise.resolve({ sent: false, reason: `No Gupshup template id configured for ${label}` });
  }
  if (!phone) return Promise.resolve({ sent: false, reason: 'Missing phone' });

  const form = new URLSearchParams({
    channel: 'whatsapp',
    source,
    destination: toMobile(phone),
    'src.name': appName,
    template: JSON.stringify({ id: templateId, params }),
  });

  return fetch(apiUrl, {
    method: 'POST',
    headers: {
      apikey: apiKey,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cache-Control': 'no-cache',
    },
    body: form.toString(),
  })
    .then(async (r) => {
      const text = await r.text().catch(() => '');
      let body = null;
      try { body = JSON.parse(text); } catch { /* Gupshup errors are not always JSON */ }

      // Gupshup answers 202 { status: 'submitted', messageId } on success, and
      // can also answer 200 with status:'error' — so the status field is checked
      // as well as the HTTP code.
      const ok = r.ok && (!body || body.status !== 'error');
      if (!ok) {
        console.warn('[whatsapp]', label, r.status, text.slice(0, 300));
        return { sent: false, status: r.status, error: (body && body.message) || text.slice(0, 200) };
      }
      return { sent: true, messageId: body && body.messageId };
    })
    .catch((e) => {
      console.warn('[whatsapp] send failed:', e.message);
      return { sent: false, error: e.message };
    });
}

/** Send the booking confirmation for one registration row. */
function sendBookingConfirmation(row, event) {
  return sendGupshup({
    phone: row && row.phone,
    templateId: resolveTemplateId('booking', event),
    params: bookingParams(row, event),
    label: 'booking confirmation',
  });
}

/** Send the student-ID approved / rejected outcome. */
function sendStudentOutcome(row, event, { approved, reason } = {}) {
  const kind = approved ? 'studentApproved' : 'studentRejected';
  return sendGupshup({
    phone: row && row.phone,
    templateId: resolveTemplateId(kind, event),
    params: studentParams(row, event, { approved, reason }),
    label: kind,
  });
}

module.exports = {
  toMobile,
  param,
  inr,
  passDescription,
  bookingParams,
  eventFields,
  studentParams,
  resolveTemplateId,
  sendGupshup,
  sendBookingConfirmation,
  sendStudentOutcome,
};
