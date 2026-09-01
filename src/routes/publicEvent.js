const express = require('express');
const { getActiveEvent } = require('../lib/events');

const router = express.Router();

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
    status: e.status,
  };
}

// GET /api/public/event
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
