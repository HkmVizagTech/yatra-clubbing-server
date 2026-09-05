const express = require('express');
const { getActiveEvent, getActiveEvents, getEventBySlug } = require('../lib/events');

const router = express.Router();

// Full shape used by an event's own landing page.
function publicEvent(e) {
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
    status: e.status,
  };
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
    res.json({ event: publicEvent(event) });
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
    res.json({ event: publicEvent(event) });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

module.exports = router;
