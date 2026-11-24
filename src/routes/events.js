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
  isSlugAvailable,
  hasEnded,
  ensureCodeIndex,
} = require('../lib/events');

const { mergeAttendees, attendeeSummary, clearAttendees, listAttendees, removeAttendee } = require('../lib/attendees');
const { fetchAttendees, configured: vbConfigured } = require('../lib/vanabhojanam');

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
// The page link (slug) is the readable URL, e.g. /ramateertham-trip.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_SLUGS = new Set([
  'admin', 'login', 'logout', 'api', 'success', 'events', 'event', 'register', 'registrations',
  'book', 'booking', 'refund', 'public', 'static', 'assets', 'favicon.ico', 'robots.txt',
  'sitemap.xml', '_next', 'www',
]);
function slugProblem(slug) {
  if (!slug) return 'A page link is required.';
  if (slug.length < 3 || slug.length > 60 || !SLUG_RE.test(slug)) {
    return 'Use 3–60 lowercase letters, numbers and single hyphens, e.g. ramateertham-trip.';
  }
  if (RESERVED_SLUGS.has(slug)) return `"${slug}" is reserved by the site. Pick another link.`;
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
    // Page link: use what the admin typed, otherwise build it from the name.
    const explicit = toSlug(body.slug);
    let slug = explicit || toSlug(body.name);
    const sp = slugProblem(slug);
    if (sp) {
      if (explicit) return res.status(400).json({ error: sp, field: 'slug' });
      slug = (slug && slug.length >= 3 ? slug : 'trip') + '-trip';
    }
    if (!(await isSlugAvailable(slug))) {
      if (explicit) {
        return res.status(409).json({ error: `The link "${slug}" is already used by another event.`, field: 'slug' });
      }
      let n = 2;
      while (!(await isSlugAvailable(`${slug}-${n}`))) n++;
      slug = `${slug}-${n}`;
    }
    const data = sanitizeBody({ ...body, code, slug });
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

// GET /api/events/check-slug?slug=ramateertham-trip&except=<eventId>
router.get('/check-slug', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const slug = toSlug(req.query.slug);
  const problem = slugProblem(slug);
  if (problem) return res.json({ slug, available: false, error: problem });
  try {
    const available = await isSlugAvailable(slug, req.query.except || undefined);
    res.json({ slug, available, error: available ? null : `The link "${slug}" is already used by another event.` });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// ── Returning attendees (Excel upload) ───────────────────────────────────────
// The browser reads the spreadsheet and sends the mobile numbers it found; the
// list replaces any earlier one for this event.
router.get('/:id/attendees', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const event = await getEventBySlug(req.params.id);
    if (!event) return res.status(404).json({ error: 'Not found' });
    // ?list=1&q=&page= returns the people themselves (name + number), one page at a time
    if (req.query.list) {
      return res.json(await listAttendees(event._id, { q: req.query.q, page: req.query.page, limit: req.query.limit }));
    }
    res.json(await attendeeSummary(event._id));
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// POST /api/events/:id/attendees { entries: [{ phone, name }] }  (or { phones: [...] })
// ADDS to the trip's returning-attendee list. Two rows are the same person only
// when BOTH the number and the name match; everything else is kept.
router.post('/:id/attendees', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const body = req.body || {};
  const entries = Array.isArray(body.entries) ? body.entries : Array.isArray(body.phones) ? body.phones : null;
  if (!entries) return res.status(400).json({ error: 'Send { entries: [{ phone, name }] }.' });
  if (entries.length > 200000) return res.status(413).json({ error: 'That list is too large.' });
  try {
    const event = await getEventBySlug(req.params.id);
    if (!event) return res.status(404).json({ error: 'Not found' });
    const result = await mergeAttendees(event._id, entries, 'excel');
    if (result.added + result.updated + result.duplicates === 0) {
      return res.status(400).json({ error: 'No valid 10-digit mobile numbers were found in that file.', ...result });
    }
    res.json({ ...result, ...(await attendeeSummary(event._id)) });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// POST /api/events/:id/attendees/sync — pull "who attended Vanabhojanam" straight from
// its API and ADD them to this trip's returning-attendee list (anything uploaded
// from Excel stays; people already on the list are not duplicated).
router.post('/:id/attendees/sync', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!vbConfigured()) {
    return res.status(503).json({ error: 'The Vanabhojanam connection is not set up on the server yet (VANABHOJANAM_API_URL and VANABHOJANAM_API_KEY).' });
  }
  try {
    const event = await getEventBySlug(req.params.id);
    if (!event) return res.status(404).json({ error: 'Not found' });
    let attendees;
    try {
      attendees = await fetchAttendees(req.body && req.body.who === 'paid' ? 'paid' : 'attended');
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
    if (attendees.length === 0) {
      return res.status(400).json({
        error: (req.body && req.body.who === 'paid')
          ? 'Vanabhojanam returned nobody who has paid, so nothing was added.'
          : 'Vanabhojanam has no attendance records yet (nobody has been scanned in), so nothing was added. You can sync everyone who paid instead.',
        empty: true,
      });
    }
    const result = await mergeAttendees(event._id, attendees, 'vanabhojanam');
    res.json({ ...result, ...(await attendeeSummary(event._id)) });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// DELETE /api/events/:id/attendees/:rowId removes one person from the list.
router.delete('/:id/attendees/:rowId', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const event = await getEventBySlug(req.params.id);
    if (!event) return res.status(404).json({ error: 'Not found' });
    const removed = await removeAttendee(event._id, req.params.rowId);
    if (!removed) return res.status(404).json({ error: 'That person is not on the list.' });
    res.json({ removed, ...(await attendeeSummary(event._id)) });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

router.delete('/:id/attendees', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const event = await getEventBySlug(req.params.id);
    if (!event) return res.status(404).json({ error: 'Not found' });
    const removed = await clearAttendees(event._id);
    res.json({ removed });
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

    // A trip whose date has passed can't be published again. Change its dates first.
    const nextStatus = body.status !== undefined ? body.status : existing.status;
    const nextDates = body.dates !== undefined ? body.dates : existing.dates;
    if (nextStatus === 'active' && hasEnded({ dates: nextDates })) {
      return res.status(400).json({ error: "This trip's date has already passed, so it can't be live. Change its dates first, or leave it closed.", field: 'status' });
    }

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
    if (body.slug !== undefined) {
      const slug = toSlug(body.slug);
      if (slug) {
        const sp = slugProblem(slug);
        if (sp) return res.status(400).json({ error: sp, field: 'slug' });
        if (slug !== existing.slug && !(await isSlugAvailable(slug, existing._id))) {
          return res.status(409).json({ error: `The link "${slug}" is already used by another event.`, field: 'slug' });
        }
        update.slug = slug;
      }
    }
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
    if (body.timing !== undefined) update.timing = String(body.timing || '');
    if (body.transport !== undefined) update.transport = String(body.transport || '');
    if (body.highlights !== undefined) update.highlights = normalizeHighlights(body.highlights);
    if (body.benefits !== undefined) update.benefits = normalizeLines(body.benefits);
    if (body.dates !== undefined) update.dates = body.dates;
    if (body.timeline !== undefined) update.timeline = body.timeline;
    if (body.tickets !== undefined) update.tickets = body.tickets;
    if (body.branding !== undefined) update.branding = body.branding;
    if (body.payments !== undefined) update.payments = body.payments;
    // keep the server-written last-sync fields (lastSyncAt …) when the admin saves the form
    if (body.returning !== undefined) update.returning = { ...(existing.returning || {}), ...normalizeReturning(body.returning) };

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
    if (body.status === 'active') {
      const current = await getEventBySlug(id);
      if (current && hasEnded(current)) {
        return res.status(400).json({ error: "This trip's date has already passed, so it can't be live. Change its dates first." });
      }
    }
    const event = await setEventStatus(id, body.status);
    if (!event) return res.status(404).json({ error: 'Not found' });
    res.json({ event });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});


// ── Poster-derived content ───────────────────────────────────────────────────
// The printed poster carries three things the event record didn't: the photo
// highlights, the icon info strip (timing + transport), and the "why join"
// list. These normalise whatever the admin form sends.

function normalizeHighlights(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((h) => ({
      image: String((h && h.image) || '').trim(),
      title: String((h && h.title) || '').trim(),
      caption: String((h && h.caption) || '').trim(),
    }))
    // A highlight with neither a title nor an image has nothing to show.
    .filter((h) => h.title || h.image)
    .slice(0, 12);
}

function normalizeLines(v) {
  if (!Array.isArray(v)) return [];
  return v.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 20);
}

function toSlug(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// How returning attendees are treated. skipId: they don't have to upload a student ID.
function normalizeReturning(v) {
  const r = v && typeof v === 'object' ? v : {};
  return {
    skipId: r.skipId === true,
    label: String(r.label || '').trim().slice(0, 40),
    // pull new attendees from Vanabhojanam every hour (see lib/autoSync.js)
    autoSync: r.autoSync === true,
  };
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
      returningPrice: t.returningPrice == null || t.returningPrice === '' ? null : Math.max(0, Number(t.returningPrice) || 0),
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
    returning: normalizeReturning(body.returning),
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
    timing: String(body.timing || ''),
    transport: String(body.transport || ''),
    highlights: normalizeHighlights(body.highlights),
    benefits: normalizeLines(body.benefits),
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
