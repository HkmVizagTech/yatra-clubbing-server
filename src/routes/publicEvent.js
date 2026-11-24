const express = require('express');
const { getActiveEvent, getActiveEvents, getEventBySlug } = require('../lib/events');
const { hasAttendeeList, isReturningAttendee } = require('../lib/attendees');

const router = express.Router();

// Full shape used by an event's own landing page.
function publicEvent(e, opts = {}) {
  return {
    code: e.code,
    slug: e.slug,
    name: e.name,
    tagline: e.tagline,
    org: e.org,
    ageLimit: e.ageLimit,
    locations: Array.isArray(e.locations) ? e.locations : [],
    description: e.description,
    venue: e.venue,
    timing: e.timing || '',
    transport: e.transport || '',
    highlights: Array.isArray(e.highlights) ? e.highlights : [],
    benefits: Array.isArray(e.benefits) ? e.benefits : [],
    dates: e.dates,
    timeline: e.timeline,
    tickets: (e.tickets || []).map((t) => ({
      key: t.key,
      name: t.name,
      price: t.price,
      was: t.was,
      returningPrice: t.returningPrice == null ? null : t.returningPrice,
      maxQty: t.maxQty,
      description: t.description,
      tag: t.tag,
      requiresStudentId: t.requiresStudentId,
      features: t.features || [],
    })),
    branding: {
      heroDesktop: e.branding && e.branding.heroDesktop,
      heroMobile: e.branding && e.branding.heroMobile,
      themeColor: e.branding && e.branding.themeColor,
      showCountdown: e.branding && e.branding.showCountdown,
      mantra: e.branding && e.branding.mantra,
    },
    // The booking ref prefix belongs to the event, so refs read YJ-… not YC-….
    receiptPrefix: (e.payments && e.payments.receiptPrefix) || 'YC-',
    // true when the admin has uploaded a returning-attendee list for this event
    returning: {
      enabled: !!opts.returningEnabled,
      // returning attendees don't have to upload a student ID
      skipId: !!(e.returning && e.returning.skipId),
      // e.g. "Vanabhojanam", used in the booking form's wording
      label: (e.returning && e.returning.label) || '',
    },
    status: e.status,
    // the trip's date has passed (so the page says "ended", not just "closed")
    ended: !!e.ended,
  };
}

// Does this event have an uploaded attendee list? Never throws — a database
// hiccup just means "no special pricing is advertised".
async function listEnabled(event) {
  try {
    return await hasAttendeeList(String(event._id));
  } catch (e) {
    return false;
  }
}

// Trimmed shape for the home page's chooser cards — enough to decide, no more.
function eventCard(e) {
  const tickets = Array.isArray(e.tickets) ? e.tickets : [];
  const prices = tickets.map((t) => Number(t.price) || 0).filter((n) => n > 0);
  // The cheapest original (pre-discount) price — only shown when it is genuinely
  // above the current price, so home cards read "₹199 ~~₹299~~" and never
  // invent a discount that isn't there.
  const wasList = tickets
    .map((t) => ({ was: Number(t.was) || 0, price: Number(t.price) || 0 }))
    .filter((t) => t.was > 0 && t.was > t.price)
    .map((t) => t.was);
  return {
    code: e.code,
    slug: e.slug,
    name: e.name,
    tagline: e.tagline,
    org: e.org,
    venue: e.venue,
    ageLimit: e.ageLimit,
    locations: Array.isArray(e.locations) ? e.locations : [],
    dates: e.dates,
    priceFrom: prices.length ? Math.min(...prices) : null,
    wasFrom: wasList.length ? Math.min(...wasList) : null,
    ticketCount: tickets.length,
    branding: {
      heroDesktop: e.branding && e.branding.heroDesktop,
      heroMobile: e.branding && e.branding.heroMobile,
      themeColor: e.branding && e.branding.themeColor,
    },
    status: e.status,
  };
}

// GET /api/public/events — every published event, soonest first.
// This is what the home page lists so people can pick the yatra they want.
router.get('/events', async (req, res) => {
  try {
    const events = await getActiveEvents();
    res.json({ events: events.map(eventCard) });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// GET /api/public/event/:code — one event by its public code (e.g. /YJ).
// Non-active events are returned too, with their status, so the page can show
// the right "cancelled" or "registrations closed" message instead of a 404.
router.get('/event/:code', async (req, res) => {
  try {
    const event = await getEventBySlug(String(req.params.code || '').trim());
    if (!event) return res.status(404).json({ event: null, error: 'Event not found' });
    res.json({ event: publicEvent(event, { returningEnabled: await listEnabled(event) }) });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// GET /api/public/event — legacy single-event endpoint. Returns the soonest
// active event. Kept so an older deployed frontend keeps working.
router.get('/event', async (req, res) => {
  try {
    const event = await getActiveEvent();
    if (!event) {
      return res.json({ event: null, message: 'No active event right now.' });
    }
    res.json({ event: publicEvent(event, { returningEnabled: await listEnabled(event) }) });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// POST /api/public/check-attendee { event_code, phone } -> { checkable, listed }
// Only a yes/no for ONE number is ever returned, and calls are rate limited, so
// the uploaded list can't be read out through here.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip) || { n: 0, t: now };
  if (now - rec.t > 10 * 60 * 1000) { rec.n = 0; rec.t = now; }
  rec.n += 1;
  hits.set(ip, rec);
  return rec.n > 40;
}
router.post('/check-attendee', async (req, res) => {
  if (rateLimited(req.ip || 'x')) return res.status(429).json({ error: 'Too many checks. Try again in a few minutes.' });
  try {
    const body = req.body || {};
    const event = await getEventBySlug(String(body.event_code || '').trim());
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!(await hasAttendeeList(String(event._id)))) return res.json({ checkable: false, listed: false });
    res.json({ checkable: true, listed: await isReturningAttendee(String(event._id), body.phone) });
  } catch (e) {
    res.status(502).json({ error: 'Could not check right now.' });
  }
});

module.exports = router;
