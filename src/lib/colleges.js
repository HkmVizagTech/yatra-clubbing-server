const { getDb, isMongoConfigured } = require('./mongodb');

const COLLEGES_COLLECTION = 'colleges';

function serializeCollege(c) {
  if (!c) return null;
  return {
    _id: c._id ? c._id.toString() : undefined,
    name: c.name,
    short: c.short || '',
    createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : String(c.createdAt),
  };
}

// Sorted list of every college, for the public registration picker and the
// admin manager. short (an abbreviation) is stored but the picker shows name.
async function getColleges() {
  const db = await getDb();
  const rows = await db
    .collection(COLLEGES_COLLECTION)
    .find({})
    .sort({ name: 1 })
    .toArray();
  return rows.map(serializeCollege);
}

// The plain names, newest-first unrelated — a cheap, cacheable public shape.
async function getCollegeNames() {
  const rows = await getColleges();
  return rows.map((c) => c.name);
}

async function addCollege(name, short) {
  const db = await getDb();
  const clean = String(name || '').trim();
  if (!clean) return { error: 'College name is required.' };

  const existing = await db.collection(COLLEGES_COLLECTION).findOne({ name: { $regex: new RegExp('^' + clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') } });
  if (existing) return { error: 'That college is already on the list.', dup: true };

  const now = new Date();
  const doc = { name: clean, short: String(short || '').trim(), createdAt: now, updatedAt: now };
  const res = await db.collection(COLLEGES_COLLECTION).insertOne(doc);
  return serializeCollege({ ...doc, _id: res.insertedId });
}

async function removeCollege(id) {
  const db = await getDb();
  const filter = /^[0-9a-f]{24}$/i.test(id) ? { _id: new (require('mongodb').ObjectId)(id) } : { name: id };
  const res = await db.collection(COLLEGES_COLLECTION).deleteOne(filter);
  return res.deletedCount > 0;
}

module.exports = {
  getColleges,
  getCollegeNames,
  addCollege,
  removeCollege,
  isMongoConfigured,
};
