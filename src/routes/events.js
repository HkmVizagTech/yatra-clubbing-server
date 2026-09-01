const express = require('express');
const { isAdminAuthorized } = require('../lib/auth');
const {
  getEvents,
  getEventBySlug,
  updateEvent,
  deleteEvent,
  setEventStatus,
  createEvent,
  getRegistrationCountForEvent,
} = require('../lib/events');

const router = express.Router();

const EVENT_STATUSES = ['draft', 'active', 'closed', 'cancelled'];
const TICKET_KEYS = new Set(['general', 'student', 'vip', 'group', 'couple']);

function requireAdmin(req, res) {
  if (!isAdminAuthorized(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// GET /api/events?event_code=... -> list with registration counts
router.get('/', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const events = await getEvents();
    const counts = await Promise.all(
      events.map(async (e) => getRegistrationCountForEvent(e.code || e.slug, e).catch(() => 0))
    );
    const withCounts = events.map((e, i) => ({ ...e, registration_count: counts[i] }));
    res.json({ events: withCounts });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// POST /api/events -> create
router.post('/', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const body = req.body || {};
  if (!body.name) return res.status(400).json({ error: 'name is required' });
  try {
    const data = sanitizeBody(body);
    const event = await createEvent(data);
    res.status(201).json({ event });
  } catch (e) {
    if (e && e.code === 11000) return res.status(409).json({ error: 'Event code already exists' });
    res.status(502).json({ error: String(e) });
  }
});

// GET /api/events/:id  (id may be a short code or legacy slug)
router.get('/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = req.params.id;
  try {
    const event = await getEventBySlug(id);
    if (!event) return res.status(404).json({ error: 'Not found' });
    const count = await getRegistrationCountForEvent(id, event).catch(() => 0);
    res.json({ event: { ...event, registration_count: count } });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// PUT /api/events/:id
router.put('/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = req.params.id;
  const body = req.body || {};
  try {
    const existing = await getEventBySlug(id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const update = {};
    if (body.code !== undefined) update.code = String(body.code).trim().toUpperCase();
    if (body.slug !== undefined) update.slug = toSlug(body.slug);
    if (body.name !== undefined) update.name = String(body.name);
    if (body.tagline !== undefined) update.tagline = String(body.tagline);
    if (body.org !== undefined) update.org = String(body.org);
    if (body.description !== undefined) update.description = String(body.description);
    if (body.venue !== undefined) update.venue = String(body.venue);
    if (body.status !== undefined) {
      if (!EVENT_STATUSES.includes(body.status)) return res.status(400).json({ error: 'Invalid status' });
      update.status = body.status;
    }
    if (body.dates !== undefined) update.dates = body.dates;
    if (body.timeline !== undefined) update.timeline = body.timeline;
    if (body.tickets !== undefined) update.tickets = body.tickets;
    if (body.branding !== undefined) update.branding = body.branding;
    if (body.payments !== undefined) update.payments = body.payments;

    const event = await updateEvent(id, update);
    if (!event) return res.status(404).json({ error: 'Not found' });
    res.json({ event });
  } catch (e) {
    if (e && e.code === 11000) return res.status(409).json({ error: 'Event code already exists' });
    res.status(502).json({ error: String(e) });
  }
});

// DELETE /api/events/:id
router.delete('/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = req.params.id;
  try {
    const event = await getEventBySlug(id);
    if (!event) return res.status(404).json({ error: 'Not found' });
    const count = await getRegistrationCountForEvent(id, event).catch(() => 0);
    if (count > 0) {
      return res
        .status(409)
        .json({ error: 'Cannot delete an event that has registrations. Close or cancel it instead.' });
    }
    const ok = await deleteEvent(id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// POST /api/events/:id/status
router.post('/:id/status', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = req.params.id;
  const body = req.body || {};
  if (!body.status || !EVENT_STATUSES.includes(body.status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  try {
    const event = await setEventStatus(id, body.status);
    if (!event) return res.status(404).json({ error: 'Not found' });
    res.json({ event });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

function toSlug(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sanitizeBody(body) {
  const slug = toSlug(body.slug) || 'event-' + Date.now().toString(36);
  const code =
    String(body.code || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '') || slug.slice(0, 8).toUpperCase();
  const status = EVENT_STATUSES.includes(body.status) ? body.status : 'draft';

  const rawTickets = Array.isArray(body.tickets) ? body.tickets : [];
  const tickets = rawTickets.map((t, i) => {
    const key = String(t.key || '').trim() || `tier${i}`;
    return {
      key,
      name: String(t.name || key),
      price: Number(t.price) || 0,
      was: t.was == null ? null : Number(t.was),
      maxQty: Number(t.maxQty) || (key === 'student' ? 1 : 20),
      description: String(t.description || ''),
      tag: t.tag ? String(t.tag) : undefined,
      requiresStudentId: Boolean(t.requiresStudentId),
      features: Array.isArray(t.features) ? t.features.map(String) : [],
    };
  });

  const rawTimeline = Array.isArray(body.timeline) ? body.timeline : [];
  const timeline = rawTimeline.map((t) => ({
    time: String(t.time || ''),
    title: String(t.title || ''),
    description: String(t.description || ''),
  }));

  const b = body.branding || {};
  const p = body.payments || {};
  const w = p.whatsapp || {};

  return {
    code,
    slug,
    name: String(body.name || 'Untitled event'),
    tagline: String(body.tagline || ''),
    org: String(body.org || ''),
    description: String(body.description || ''),
    venue: String(body.venue || ''),
    dates: {
      display: String((body.dates || {}).display || ''),
      start: String((body.dates || {}).start || '') || undefined,
      end: String((body.dates || {}).end || '') || undefined,
    },
    timeline,
    tickets,
    branding: {
      heroDesktop: String(b.heroDesktop || ''),
      heroMobile: String(b.heroMobile || ''),
      themeColor: String(b.themeColor || '#E07B00'),
      showCountdown: Boolean(b.showCountdown),
      mantra: String(b.mantra || ''),
    },
    payments: {
      receiptPrefix: String(p.receiptPrefix || 'YC-'),
      whatsapp: {
        booking: String(w.booking || ''),
        studentApproved: String(w.studentApproved || ''),
        studentRejected: String(w.studentRejected || ''),
      },
    },
    status,
  };
}

module.exports = router;
