const { getDb } = require('./mongodb');

const EVENTS_COLLECTION = 'events';

function serializeEvent(e) {
  if (!e) return null;
  return {
    ...e,
    _id: e._id ? e._id.toString() : undefined,
    createdAt: e.createdAt instanceof Date ? e.createdAt.toISOString() : String(e.createdAt),
    updatedAt: e.updatedAt instanceof Date ? e.updatedAt.toISOString() : String(e.updatedAt),
  };
}

// The short public code is the canonical identifier (e.g. "RC26"). A legacy
// slug is kept as an optional alias for backwards compatibility with data that
// predates the code field.
function findByCodeOrSlug(query) {
  return getDb().then((db) =>
    db.collection(EVENTS_COLLECTION).findOne({
      $or: [{ code: query }, { slug: query }],
    })
  );
}

async function getEvents() {
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
  const row = await db.collection(EVENTS_COLLECTION).findOne({ code });
  return serializeEvent(row);
}

// The single soonest active event. Kept for the legacy `/api/public/event`
// endpoint — with several events live this returns the next one up rather than
// whichever row Mongo happened to find first.
async function getActiveEvent() {
  const rows = await getActiveEvents();
  return rows[0] || null;
}

// Every published event, soonest first. Events without a start date sort last,
// newest-created among them.
async function getActiveEvents() {
  const db = await getDb();
  const rows = await db.collection(EVENTS_COLLECTION).find({ status: 'active' }).toArray();
  return rows
    .map(serializeEvent)
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
  ensureCodeIndex,
  createEvent,
  updateEvent,
  setEventStatus,
  deleteEvent,
  getRegistrationCountForEvent,
  getNextRef,
};
