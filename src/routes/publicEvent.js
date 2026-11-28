const express = require('express');
const { getActiveEvent, getActiveEvents, getEventBySlug } = require('../lib/events');
const { hasAttendeeList, isReturningAttendee } = require('../lib/attendees');
const { lookupPerson } = require('../lib/vanabhojanam');

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
    if (event.returning && event.returning.liveLookup === true) return true;
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

// POST /api/public/check-attendee { event_code, phone }
//   -> { checkable, listed, known?, attended?, prefill? }
// Only a yes/no for ONE number is ever returned, and calls are rate limited, so
// the uploaded list can't be read out through here.
//
// With live lookup on, a person Vanabhojanam already knows also gets `prefill`:
// the few details the form asks for. That is personal data, so it is handed out
// far more sparingly than the yes/no (see prefillLimited).
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip) || { n: 0, t: now };
  if (now - rec.t > 10 * 60 * 1000) { rec.n = 0; rec.t = now; }
  rec.n += 1;
  hits.set(ip, rec);
  return rec.n > 40;
}
const fills = new Map();
function prefillLimited(ip) {
  const now = Date.now();
  const rec = fills.get(ip) || { n: 0, t: now };
  if (now - rec.t > 60 * 60 * 1000) { rec.n = 0; rec.t = now; }
  rec.n += 1;
  fills.set(ip, rec);
  return rec.n > 10; // ten people per hour from one connection
}

const YEARS = ['1st Year', '2nd Year', '3rd Year', '4th Year', '5th Year', 'Post Graduate'];
function cleanYear(v) {
  const t = String(v || '').trim();
  if (YEARS.includes(t)) return t;
  if (/post|pg|master|m\.?tech|mba|m\.?sc|mca/i.test(t)) return 'Post Graduate';
  const n = /([1-5])/.exec(t);
  return n ? YEARS[Number(n[1]) - 1] : '';
}
// Only what the form can hold, trimmed and normalised. Never email, birth date or ID.
function cleanPrefill(p) {
  if (!p || typeof p !== 'object') return null;
  const gender = String(p.gender || '').toLowerCase();
  const age = Number(p.age);
  const out = {
    name: String(p.name || '').trim().slice(0, 80),
    gender: gender === 'male' || gender === 'female' ? gender : '',
    age: Number.isFinite(age) && age >= 10 && age <= 80 ? String(Math.round(age)) : '',
    college: String(p.college || '').trim().slice(0, 120),
    course: String(p.course || '').trim().slice(0, 80),
    year: cleanYear(p.year),
  };
  return Object.values(out).some(Boolean) ? out : null;
}

router.post('/check-attendee', async (req, res) => {
  if (rateLimited(req.ip || 'x')) return res.status(429).json({ error: 'Too many checks. Try again in a few minutes.' });
  try {
    const body = req.body || {};
    const event = await getEventBySlug(String(body.event_code || '').trim());
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const live = !!(event.returning && event.returning.liveLookup === true);
    const hasList = await hasAttendeeList(String(event._id));
    if (!hasList && !live) return res.json({ checkable: false, listed: false });

    let listed = hasList ? await isReturningAttendee(String(event._id), body.phone) : false;
    let known = false;
    let attended = false;
    let prefill = null;
    if (live) {
      const found = await lookupPerson(body.phone);
      if (found) {
        known = found.found;
        attended = found.attended;
        if (found.attended) listed = true;
        if (found.found && !prefillLimited(req.ip || 'x')) prefill = cleanPrefill(found.person);
      }
    }
    res.json({ checkable: true, listed, known, attended, prefill });
  } catch (e) {
    res.status(502).json({ error: 'Could not check right now.' });
  }
});

module.exports = router;
