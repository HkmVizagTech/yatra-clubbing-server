const { getDb } = require('./mongodb');

// People who attended an earlier trip (Vanabhojanam, …), kept per trip (by its
// _id). The list is built up over time from two sources — Excel uploads and the
// Vanabhojanam API sync — and only ever answers one question for the public
// site: "is this mobile number on the list?". The list itself is never returned.
//
// Identity of a row = mobile number + name. So:
//   • same number, different names  → both kept (e.g. siblings sharing a phone)
//   • same number AND same name     → one row (duplicate)
//   • uploads ADD to the list; they never replace it
const COL = 'event_attendees';

// 10-digit Indian mobile. Accepts +91 / 0 prefixes, spaces, dashes.
function normalizePhone(raw) {
  const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (digits.length < 10) return null;
  const last = digits.slice(-10);
  return /^[6-9]\d{9}$/.test(last) ? last : null;
}

// "  K. Sai  Ram " and "k sai ram" are the same name.
function nameKey(raw) {
  return String(raw == null ? '' : raw)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

let indexPromise = null;
function ensureIndex(db) {
  if (!indexPromise) {
    const c = db.collection(COL);
    indexPromise = (async () => {
      // The first version made (trip, phone) unique, which would reject two
      // different people on one number. Replace it with (trip, phone, name).
      try { await c.dropIndex('event_id_1_phone_1'); } catch (e) { /* not there */ }
      await c.createIndex({ event_id: 1, phone: 1, name_key: 1 }, { unique: true });
    })().catch(() => null);
  }
  return indexPromise;
}

// Add people to a trip's list. `entries` are phone strings or { phone, name }.
// Returns what happened so the admin can see it:
//   added      new rows
//   updated    phone-only rows that just learned a name
//   duplicates same phone + same name already there (skipped)
//   invalid    not a usable mobile number
async function mergeAttendees(eventId, entries, source = 'excel') {
  const id = String(eventId);
  const db = await getDb();
  await ensureIndex(db);
  const c = db.collection(COL);

  const existing = await c.find({ event_id: id }).toArray();
  const byPhone = new Map(); // phone -> Map(nameKey -> doc)
  for (const d of existing) {
    if (!byPhone.has(d.phone)) byPhone.set(d.phone, new Map());
    byPhone.get(d.phone).set(d.name_key || '', d);
  }

  let added = 0, updated = 0, duplicates = 0, invalid = 0;
  const now = new Date();
  const inserts = [];
  const fills = [];

  for (const e of entries || []) {
    const isObj = e && typeof e === 'object';
    const phone = normalizePhone(isObj ? e.phone : e);
    if (!phone) { invalid++; continue; }
    const name = isObj && e.name ? String(e.name).trim().slice(0, 120) : '';
    const nk = nameKey(name);

    let people = byPhone.get(phone);
    if (!people) { people = new Map(); byPhone.set(phone, people); }

    if (people.has(nk)) { duplicates++; continue; }          // same phone + same name
    if (!nk) {                                               // phone-only entry
      if (people.size > 0) { duplicates++; continue; }       // number is already on the list
    } else if (people.has('')) {                             // we only had the number: add the name to it
      const doc = people.get('');
      fills.push({ _id: doc._id, name, name_key: nk });
      people.delete('');
      people.set(nk, { ...doc, name, name_key: nk });
      updated++;
      continue;
    }

    const doc = { event_id: id, phone, name, name_key: nk, source, uploaded_at: now };
    people.set(nk, doc);
    inserts.push(doc);
    added++;
  }

  for (const f of fills) {
    await c.updateOne({ _id: f._id }, { $set: { name: f.name, name_key: f.name_key } });
  }
  for (let i = 0; i < inserts.length; i += 5000) {
    await c.insertMany(inserts.slice(i, i + 5000), { ordered: false });
  }

  const total = await c.countDocuments({ event_id: id });
  return { added, updated, duplicates, invalid, total };
}

async function attendeeSummary(eventId) {
  const db = await getDb();
  const rows = await db.collection(COL).find({ event_id: String(eventId) }).toArray();
  const phones = new Set(rows.map((r) => r.phone));
  const latest = rows.reduce((m, r) => (r.uploaded_at && (!m || r.uploaded_at > m) ? r.uploaded_at : m), null);
  return {
    count: rows.length,          // people (number + name)
    numbers: phones.size,        // distinct mobile numbers
    uploadedAt: latest,
    sources: [...new Set(rows.map((r) => r.source || 'excel'))],
  };
}

async function clearAttendees(eventId) {
  const db = await getDb();
  const r = await db.collection(COL).deleteMany({ event_id: String(eventId) });
  return r.deletedCount || 0;
}

async function hasAttendeeList(eventId) {
  const db = await getDb();
  const n = await db.collection(COL).countDocuments({ event_id: String(eventId) }, { limit: 1 });
  return n > 0;
}

// Booking-time check: any row with this mobile number counts.
async function isReturningAttendee(eventId, phone) {
  const p = normalizePhone(phone);
  if (!p) return false;
  const db = await getDb();
  const row = await db.collection(COL).findOne({ event_id: String(eventId), phone: p }, { projection: { _id: 1 } });
  return !!row;
}

module.exports = {
  normalizePhone,
  nameKey,
  mergeAttendees,
  attendeeSummary,
  clearAttendees,
  hasAttendeeList,
  isReturningAttendee,
};
