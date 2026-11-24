const { getDb } = require('./mongodb');

const EVENTS_COLLECTION = 'events';

// ── When does a trip end? ────────────────────────────────────────────────────
// Dates are typed in the admin as local (India) times with no zone, so they are
// read as IST. A trip with an end date ends then; one with only a start date
// ends when that day does. After that, registrations close by themselves.
const IST = '+05:30';

function parseIst(value, endOfDayIfDateOnly = false) {
  if (!value) return null;
  const str = String(value).trim();
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(str);
  let iso = str;
  if (!hasZone) {
    if (str.length <= 10) iso = str + (endOfDayIfDateOnly ? 'T23:59:59' : 'T00:00:00');
    iso += IST;
  }
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function tripEndsAt(event) {
  const d = (event && event.dates) || {};
  const end = parseIst(d.end, true);
  if (end !== null) return end;
  const start = d.start ? String(d.start).slice(0, 10) : '';
  return start ? parseIst(start + 'T23:59:59') : null;
}

function hasEnded(event, now = Date.now()) {
  const ends = tripEndsAt(event);
  return ends !== null && now > ends;
}

function serializeEvent(e) {
  if (!e) return null;
  // A live trip whose date has passed is reported as closed straight away, even
  // before the background sweep has written that to the database.
  const ended = hasEnded(e);
  const autoClosed = e.status === 'active' && ended;
  return {
    ...e,
    ...(autoClosed ? { status: 'closed', autoClosed: true } : {}),
    ended,
    _id: e._id ? e._id.toString() : undefined,
    createdAt: e.createdAt instanceof Date ? e.createdAt.toISOString() : String(e.createdAt),
    updatedAt: e.updatedAt instanceof Date ? e.updatedAt.toISOString() : String(e.updatedAt),
  };
}

// The short public code is the canonical identifier (e.g. "RC26"). A legacy
// slug is kept as an optional alias for backwards compatibility with data that
// predates the code field.
function findByCodeOrSlug(query) {
  const raw = String(query || '').trim();
  if (!raw) return Promise.resolve(null);

  // Codes are stored upper-case and slugs lower-case, but people type URLs and
  // share links in whatever case they like — /yj must find the same event as
  // /YJ rather than 404. Matching the normalised forms as well as the raw value
  // keeps this an exact (index-usable) match instead of a regex scan.
  const upper = raw.toUpperCase();
  const lower = raw.toLowerCase();

  return getDb().then((db) =>
    db.collection(EVENTS_COLLECTION).findOne({
      $or: [
        { code: raw }, { code: upper },
        { slug: raw }, { slug: lower },
      ],
    })
  );
}

async function getEvents() {
  await closeExpiredEvents().catch(() => 0);
  const db = await getDb();
  const rows = await db.collection(EVENTS_COLLECTION).find({}).sort({ createdAt: -1 }).toArray();
  return rows.map(serializeEvent);
}

async function getEventBySlug(slug) {
  const row = await findByCodeOrSlug(slug);
  return serializeEvent(row);
}

async function getEventByCode(code) {
  const db = await getDb();
  const raw = String(code || '').trim();
  const row = await db
    .collection(EVENTS_COLLECTION)
    .findOne({ $or: [{ code: raw }, { code: raw.toUpperCase() }] });
  return serializeEvent(row);
}

// The single soonest active event. Kept for the legacy `/api/public/event`
// endpoint — with several events live this returns the next one up rather than
// whichever row Mongo happened to find first.
async function getActiveEvent() {
  const rows = await getActiveEvents();
  return rows[0] || null;
}

// Persist "closed" for live trips that have ended. Cheap (a handful of events),
// throttled, and safe to call often.
let lastSweep = 0;
async function closeExpiredEvents(force = false) {
  const now = Date.now();
  if (!force && now - lastSweep < 60 * 1000) return 0;
  lastSweep = now;
  const db = await getDb();
  const live = await db.collection(EVENTS_COLLECTION).find({ status: 'active' }).toArray();
  let closed = 0;
  for (const e of live) {
    if (hasEnded(e, now)) {
      await db.collection(EVENTS_COLLECTION).updateOne(
        { _id: e._id, status: 'active' },
        { $set: { status: 'closed', autoClosedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() } }
      );
      closed += 1;
      console.log('[events] auto-closed (trip ended):', e.code);
    }
  }
  return closed;
}

// Every published event, soonest first. Events without a start date sort last,
// newest-created among them.
async function getActiveEvents() {
  await closeExpiredEvents().catch(() => 0);
  const db = await getDb();
  const rows = await db.collection(EVENTS_COLLECTION).find({ status: 'active' }).toArray();
  return rows
    .map(serializeEvent)
    .filter((e) => e.status === 'active')
    .sort((a, b) => {
      const at = Date.parse(a.dates?.start || '') || Infinity;
      const bt = Date.parse(b.dates?.start || '') || Infinity;
      if (at !== bt) return at - bt;
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });
}

// Is this public code free? `exceptId` lets an event keep its own code on edit.
async function isCodeAvailable(code, exceptId) {
  const clean = String(code || '').trim().toUpperCase();
  if (!clean) return false;
  const db = await getDb();
  const row = await db.collection(EVENTS_COLLECTION).findOne({ code: clean });
  if (!row) return true;
  return exceptId ? String(row._id) === String(exceptId) : false;
}

// Is this page link (slug) free? A slug also must not equal another event's code,
// because both are accepted in the URL.
async function isSlugAvailable(slug, exceptId) {
  const clean = String(slug || '').trim().toLowerCase();
  if (!clean) return false;
  const db = await getDb();
  const row = await db.collection(EVENTS_COLLECTION).findOne({
    $or: [{ slug: clean }, { code: clean.toUpperCase() }],
  });
  if (!row) return true;
  return exceptId ? String(row._id) === String(exceptId) : false;
}

// One-time unique index on `code`. Runs in the background and never throws —
// if existing data has duplicate codes the index is simply not created, and the
// application-level check in isCodeAvailable still guards new writes.
let indexPromise = null;
function ensureCodeIndex() {
  if (!indexPromise) {
    indexPromise = getDb()
      .then((db) => db.collection(EVENTS_COLLECTION).createIndex({ code: 1 }, { unique: true }))
      .catch((e) => {
        console.warn('[events] unique index on code not created:', e.message);
        return null;
      });
  }
  return indexPromise;
}

async function createEvent(data) {
  const db = await getDb();
  const now = new Date().toISOString();
  const doc = { ...data, createdAt: now, updatedAt: now };
  await db.collection(EVENTS_COLLECTION).insertOne(doc);
  return serializeEvent({ ...doc, _id: doc._id });
}

async function updateEvent(identifier, data) {
  const db = await getDb();
  const update = { ...data, updatedAt: new Date().toISOString() };
  const row = await db.collection(EVENTS_COLLECTION).findOneAndUpdate(
    { $or: [{ code: identifier }, { slug: identifier }] },
    { $set: update },
    { returnDocument: 'after' }
  );
  return serializeEvent(row);
}

async function setEventStatus(identifier, status) {
  return updateEvent(identifier, { status });
}

async function deleteEvent(identifier) {
  const db = await getDb();
  const res = await db.collection(EVENTS_COLLECTION).deleteOne({
    $or: [{ code: identifier }, { slug: identifier }],
  });
  return res.deletedCount > 0;
}

// Count registrations scoped to the event's canonical public code. Falls back to
// legacy slug when needed so older data still shows under the correct event.
async function getRegistrationCountForEvent(identifier, event) {
  const db = await getDb();
  const code = event?.code || identifier;
  const slug = event?.slug || identifier;
  return db.collection('registrations').countDocuments({
    $or: [{ event_code: code }, { event_slug: code }, { event_slug: slug }],
  });
}

async function getNextRef(receiptPrefix) {
  const db = await getDb();
  const prefix = receiptPrefix || 'YC-';
  for (let i = 0; i < 10; i++) {
    const ref = prefix + Math.random().toString(36).slice(2, 8).toUpperCase();
    const existing = await db.collection('registrations').findOne({ ref });
    if (!existing) return ref;
  }
  return prefix + Date.now().toString(36).toUpperCase();
}

module.exports = {
  getEvents,
  getEventBySlug,
  getEventByCode,
  getActiveEvent,
  getActiveEvents,
  isCodeAvailable,
  isSlugAvailable,
  hasEnded,
  tripEndsAt,
  closeExpiredEvents,
  ensureCodeIndex,
  createEvent,
  updateEvent,
  setEventStatus,
  deleteEvent,
  getRegistrationCountForEvent,
  getNextRef,
};
