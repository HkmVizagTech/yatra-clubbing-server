const express = require('express');
const { getColleges, getCollegeNames, addCollege, removeCollege, isMongoConfigured } = require('../lib/colleges');
const { isAdminAuthorized } = require('../lib/auth');

// ── Public: the shared global college list for the booking picker ──────────
// Plain names only — the cheapest, most cacheable shape a form can read.
const publicRouter = express.Router();
publicRouter.get('/list', async (req, res) => {
  if (!isMongoConfigured()) return res.json({ colleges: [] });
  try {
    res.json({ colleges: await getCollegeNames() });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// ── Admin: manage the list from the new /admin/colleges page ───────────────
const adminRouter = express.Router();

// GET /api/admin/colleges — full list (ids + names).
adminRouter.get('/', async (req, res) => {
  if (!isAdminAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!isMongoConfigured()) return res.json({ colleges: [] });
  try {
    res.json({ colleges: await getColleges() });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// POST /api/admin/colleges — add one.
adminRouter.post('/', async (req, res) => {
  if (!isAdminAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { name, short } = req.body || {};
  try {
    const result = await addCollege(name, short);
    if (result.error) return res.status(400).json({ error: result.error });
    res.status(201).json({ college: result });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// DELETE /api/admin/colleges/:id — remove one (by id or name).
adminRouter.delete('/:id', async (req, res) => {
  if (!isAdminAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const ok = await removeCollege(req.params.id);
    if (!ok) return res.status(404).json({ error: 'College not found' });
    res.json({ deleted: true });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

module.exports = { publicRouter, adminRouter };
