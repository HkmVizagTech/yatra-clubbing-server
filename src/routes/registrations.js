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
