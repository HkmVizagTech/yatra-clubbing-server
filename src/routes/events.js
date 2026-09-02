const express = require('express');
const { isAdminAuthorized } = require('../lib/auth');
const { uploadToCloudinary, parseDataUri } = require('../lib/cloudinary');
const {
  getEvents,
  getEventBySlug,
  updateEvent,
  deleteEvent,
  setEventStatus,
  createEvent,
  getRegistrationCountForEvent,
  isCodeAvailable,
  ensureCodeIndex,
} = require('../lib/events');

const router = express.Router();

ensureCodeIndex();

const EVENT_STATUSES = ['draft', 'active', 'closed', 'cancelled'];

// The public code doubles as the event's URL (harekrishnavizag.org/YJ), so it
// has to stay short, unambiguous and clear of the app's own routes.
const CODE_RE = /^[A-Z0-9]{2,12}$/;
const RESERVED_CODES = new Set([
  'ADMIN', 'LOGIN', 'LOGOUT', 'API', 'EVENTS', 'EVENT', 'REGISTER',
  'REGISTRATIONS', 'BOOK', 'BOOKING', 'REFUND', 'PUBLIC', 'STATIC',
  'ASSETS', 'FAVICON', 'ROBOTS', 'SITEMAP', 'NEXT', 'WWW',
]);

function normalizeCode(raw) {
  return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Returns an error message, or null when the code is usable.
function codeProblem(code) {
  if (!code) return 'A public code is required — this becomes the event URL.';
  if (!CODE_RE.test(code)) return 'Use 2–12 letters and numbers only, e.g. YJ or RCY26.';
  if (RESERVED_CODES.has(code)) return `"${code}" is reserved by the site. Pick another code.`;
  return null;
}
const TICKET_KEYS = new Set(['general', 'student', 'vip', 'group', 'couple']);

function requireAdmin(req, res) {
  if (!isAdminAuthorized(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// POST /api/events/upload-image -> { url }
// Takes a base64 data URI from the admin's file picker and puts it on
// Cloudinary, so hero artwork is uploaded rather than pasted as a URL.
// The 10mb express.json limit in index.js caps what can arrive here.
router.post('/upload-image', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { data, type, slot } = req.body || {};
  if (!data) return res.status(400).json({ error: 'No image was sent.' });

  try {
    const { mime, b64 } = parseDataUri(data, type);
    if (!/^image\//.test(mime)) {
      return res.status(400).json({ error: 'That file is not an image. Use a JPG, PNG or WebP.' });
    }
    const publicId = `${String(slot || 'hero').replace(/[^a-zA-Z0-9_-]/g, '')}-${Date.now()}`;
    const url = await uploadToCloudinary(b64, mime, publicId, 'event-hero');
    if (!url) {
      return res.status(502).json({ error: 'Upload failed. Check the Cloudinary keys on the server.' });
    }
    res.json({ url });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

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
  if (!body.name) return res.status(400).json({ error: 'An event name is required.' });

  const code = normalizeCode(body.code);
  const problem = codeProblem(code);
  if (problem) return res.status(400).json({ error: problem, field: 'code' });

  try {
    if (!(await isCodeAvailable(code))) {
      return res.status(409).json({ error: `The code "${code}" is already used by another event.`, field: 'code' });
    }
    const data = sanitizeBody({ ...body, code });
    const event = await createEvent(data);
    res.status(201).json({ event });
  } catch (e) {
    if (e && e.code === 11000) {
      return res.status(409).json({ error: `The code "${code}" is already used by another event.`, field: 'code' });
    }
    res.status(502).json({ error: String(e) });
  }
});

// GET /api/events/check-code?code=YJ&except=<eventId> -> { available, error }
// Powers the live availability hint under the code field in the admin form.
// Declared before /:id so "check-code" isn't read as an event identifier.
router.get('/check-code', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const code = normalizeCode(req.query.code);
  const problem = codeProblem(code);
  if (problem) return res.json({ code, available: false, error: problem });
  try {
    const available = await isCodeAvailable(code, req.query.except || undefined);
    res.json({
      code,
      available,
      error: available ? null : `The code "${code}" is already used by another event.`,
    });
  } catch (e) {
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
    if (body.code !== undefined) {
      const code = normalizeCode(body.code);
      const problem = codeProblem(code);
      if (problem) return res.status(400).json({ error: problem, field: 'code' });
      if (code !== existing.code && !(await isCodeAvailable(code, existing._id))) {
        return res.status(409).json({ error: `The code "${code}" is already used by another event.`, field: 'code' });
      }
      update.code = code;
    }
    if (body.slug !== undefined) update.slug = toSlug(body.slug);
    if (body.name !== undefined) update.name = String(body.name);
    if (body.tagline !== undefined) update.tagline = String(body.tagline);
    if (body.org !== undefined) update.org = String(body.org);
    if (body.ageLimit !== undefined) update.ageLimit = String(body.ageLimit || '');
    if (body.locations !== undefined)
      update.locations = Array.isArray(body.locations)
        ? body.locations.map((s) => String(s || '').trim()).filter(Boolean)
        : [];
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
    ageLimit: String(body.ageLimit || ''),
    locations: Array.isArray(body.locations)
      ? body.locations.map((s) => String(s || '').trim()).filter(Boolean)
      : [],
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
