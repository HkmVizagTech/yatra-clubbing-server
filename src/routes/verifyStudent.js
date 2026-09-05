const express = require('express');
const { getDb, isMongoConfigured } = require('../lib/mongodb');
const { isAdminAuthorized } = require('../lib/auth');
const { getEventBySlug } = require('../lib/events');
const { studentParams, sendTemplate } = require('../lib/whatsapp');

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

    const config = require('../config');
    const wUrl = config.flaxxa.url;
    const wToken = config.flaxxa.token;
    if (wUrl && wToken && row.phone) {
      // Load the event so the message can name which yatra this is about —
      // with more than one open at a time, the ref alone isn't enough.
      const event = (row.event_slug || row.event_code)
        ? await getEventBySlug(row.event_slug || row.event_code).catch(() => null)
        : null;

      const templates = (event && event.payments && event.payments.whatsapp) || {};
      const approved = action === 'approve';
      const templateName = approved
        ? (templates.studentApproved || 'student_id_approved')
        : (templates.studentRejected || 'student_id_rejected');

      sendTemplate({
        url: wUrl,
        token: wToken,
        phone: row.phone,
        templateName,
        parameters: studentParams(row, event, { approved, reason }),
      });
    }

    return res.json({ updated: true, ref, status: newStatus });
  } catch (e) {
    return res.status(502).json({ updated: false, error: String(e) });
  }
});

module.exports = router;
