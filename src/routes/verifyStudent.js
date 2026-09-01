const express = require('express');
const { getDb, isMongoConfigured } = require('../lib/mongodb');
const { isAdminAuthorized } = require('../lib/auth');
const { getEventBySlug } = require('../lib/events');
const { toMobile } = require('../lib/whatsapp');

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
      const mobile = toMobile(row.phone);
      let templateName = action === 'approve' ? 'student_id_approved' : 'student_id_rejected';
      if (row.event_slug || row.event_code) {
        const event = await getEventBySlug(row.event_slug || row.event_code).catch(() => null);
        const templates = event && event.payments && event.payments.whatsapp;
        if (templates) {
          templateName = action === 'approve'
            ? (templates.studentApproved || templateName)
            : (templates.studentRejected || templateName);
        }
      }
      const params = action === 'approve'
        ? [{ type: 'text', text: row.name || 'Devotee' }, { type: 'text', text: ref }]
        : [
            { type: 'text', text: row.name || 'Devotee' },
            { type: 'text', text: ref },
            { type: 'text', text: reason || 'ID could not be verified' },
          ];

      fetch(wUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + wToken },
        body: JSON.stringify({
          messaging_product: 'whatsapp', to: mobile, type: 'template',
          template: { name: templateName, language: { code: 'en' }, components: [{ type: 'body', parameters: params }] },
        }),
      }).catch((e) => console.warn('[verify-student] WhatsApp failed:', e.message));
    }

    return res.json({ updated: true, ref, status: newStatus });
  } catch (e) {
    return res.status(502).json({ updated: false, error: String(e) });
  }
});

module.exports = router;
