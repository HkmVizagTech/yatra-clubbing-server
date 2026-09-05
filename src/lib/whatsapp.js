const FALLBACK = 'To be shared';

function toMobile(phone) {
  return '91' + String(phone || '').replace(/\D/g, '').slice(-10);
}

/**
 * Sanitise one template parameter.
 *
 * Meta rejects the whole message if a parameter is an empty string, or contains
 * a newline, a tab, or four or more consecutive spaces. Every slot therefore
 * gets a non-empty fallback rather than being left blank — dropping a parameter
 * is not an option either, because the count must match the approved template.
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
 * key, so tier names come from the event. The old version only looked at
 * qty_general / qty_student, which meant a VIP, couple or group tier showed up
 * as the literal word "Pass" — fine for one event, wrong for the next one.
 * Legacy rows that predate raw.tickets still fall back to the two counts.
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
 * Body parameters for the booking-confirmation template, in template order.
 *
 * Every value is read from the event record, so one approved template serves
 * every future yatra — nothing here is specific to a particular event. If you
 * change this list, the approved template has to change with it: WhatsApp
 * matches parameters by position, not by name.
 *
 *   {{1}} devotee name      {{5}} amount paid
 *   {{2}} event name        {{6}} date
 *   {{3}} booking ref       {{7}} timing
 *   {{4}} passes            {{8}} reporting point
 */
function bookingParams(row, event) {
  return [
    param(row && row.name, 'Devotee'),
    param(event && event.name, 'Yatra Clubbing'),
    param(row && row.ref, '—'),
    param(passDescription(row, event), 'Pass'),
    param(inr(row && row.total)),
    param(event && event.dates && event.dates.display),
    param(event && event.timing),
    param(event && event.venue),
  ].map((text) => ({ type: 'text', text }));
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
  ].map((text) => ({ type: 'text', text }));
}

/** Post one template message. Fire-and-forget: never throws, never blocks. */
function sendTemplate({ url, token, phone, templateName, parameters }) {
  if (!url || !token || !phone) return Promise.resolve(false);
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: toMobile(phone),
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'en' },
        components: [{ type: 'body', parameters }],
      },
    }),
  })
    .then(async (r) => {
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        console.warn('[whatsapp]', templateName, r.status, detail.slice(0, 300));
      }
      return r.ok;
    })
    .catch((e) => {
      console.warn('[whatsapp] send failed:', e.message);
      return false;
    });
}

module.exports = {
  toMobile,
  param,
  inr,
  passDescription,
  bookingParams,
  studentParams,
  sendTemplate,
};
