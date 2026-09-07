const express = require('express');
const { getDb, isMongoConfigured } = require('../lib/mongodb');
const { isAdminAuthorized } = require('../lib/auth');

const router = express.Router();

function requireAdmin(req, res) {
  if (!isAdminAuthorized(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// GET /api/registrations?event_code=...
router.get('/', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!isMongoConfigured()) return res.json({ count: 0, registrations: [] });

  const event_code = String(req.query.event_code || req.query.event_slug || '');
  try {
    const db = await getDb();
    const query = {};
    if (event_code) query.event_code = event_code;
    const rows = await db.collection('registrations').find(query).sort({ created_at: -1 }).toArray();
    const registrations = rows.map((r) => ({
      ...r,
      _id: r._id.toString(),
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    }));
    res.json({ count: registrations.length, registrations });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// PATCH /api/registrations?ref=...   body: { gender: 'male' | 'female' | 'other' | '' }
//
// Registrations taken before the booking form had a gender field have none, and
// buses and the overnight halls are allocated separately — so the team needs to
// be able to fill it in from the admin list once they know.
//
// Deliberately narrow: it can set gender and nothing else. An endpoint that
// accepted an arbitrary patch would let a stray admin request rewrite a
// payment_status or a ref.
const GENDERS = ['male', 'female', 'other'];

router.patch('/', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const ref = String(req.query.ref || (req.body && req.body.ref) || '').trim();
  if (!ref) return res.status(400).json({ error: 'ref required' });

  const raw = String((req.body && req.body.gender) || '').trim().toLowerCase();
  // '' clears the field again, for a value entered by mistake.
  if (raw && !GENDERS.includes(raw)) {
    return res.status(400).json({ error: `gender must be one of ${GENDERS.join(', ')} (or empty to clear)` });
  }
  if (!isMongoConfigured()) return res.json({ updated: false, configured: false });

  try {
    const db = await getDb();
    const r = await db.collection('registrations').findOneAndUpdate(
      { ref },
      { $set: { gender: raw || null, updated_at: new Date() } },
      { returnDocument: 'after', projection: { _id: 0, ref: 1, name: 1, gender: 1 } }
    );
    if (!r) return res.status(404).json({ updated: false, error: 'Booking not found' });
    return res.json({ updated: true, ref: r.ref, gender: r.gender });
  } catch (e) {
    return res.status(502).json({ updated: false, error: String(e) });
  }
});

// DELETE /api/registrations?ref=...
router.delete('/', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const ref = req.query.ref;
  if (!ref) return res.status(400).json({ error: 'ref required' });
  if (!isMongoConfigured()) return res.json({ deleted: false, configured: false });
  try {
    const db = await getDb();
    const result = await db.collection('registrations').deleteOne({ ref });
    res.json({ deleted: result.deletedCount > 0 });
  } catch (e) {
    res.status(502).json({ deleted: false, error: String(e) });
  }
});

module.exports = router;
