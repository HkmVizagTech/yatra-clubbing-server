const express = require('express');
const { getDb, isMongoConfigured } = require('../lib/mongodb');
const { isAdminAuthorized } = require('../lib/auth');
const { getEventBySlug } = require('../lib/events');
const { sendStudentOutcome } = require('../lib/whatsapp');

const router = express.Router();

// POST /api/verify-student
router.post('/', async (req, res) => {
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body || {};
  const { ref, action, reason = '' } = body;
  if (!ref || !['approve', 'reject'].includes(action || '')) {
    return res.status(400).json({ error: 'Missing ref or invalid action' });
  }

  if (!isMongoConfigured()) {
    return res.json({ updated: false, reason: 'MongoDB not configured' });
  }

  const newStatus = action === 'approve' ? 'verified' : 'rejected' + (reason ? ` — ${reason}` : '');

  try {
    const db = await getDb();
    const row = await db.collection('registrations').findOneAndUpdate(
      { ref },
      { $set: { student_status: newStatus } },
      { returnDocument: 'after' }
    );

    if (!row) return res.status(404).json({ updated: false, error: 'Booking not found' });

    if (row.phone) {
      // Load the event so the message can name which yatra this is about —
      // with more than one open at a time, the ref alone isn't enough.
      const event = (row.event_slug || row.event_code)
        ? await getEventBySlug(row.event_slug || row.event_code).catch(() => null)
        : null;

      // Not awaited: the admin's approve/reject click must not wait on WhatsApp,
      // and sendStudentOutcome never throws.
      sendStudentOutcome(row, event, { approved: action === 'approve', reason });
    }

    return res.json({ updated: true, ref, status: newStatus });
  } catch (e) {
    return res.status(502).json({ updated: false, error: String(e) });
  }
});

module.exports = router;
