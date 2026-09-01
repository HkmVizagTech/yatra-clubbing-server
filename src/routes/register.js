const express = require('express');
const { getDb, isMongoConfigured } = require('../lib/mongodb');
const { getEventBySlug, getNextRef } = require('../lib/events');
const { uploadToCloudinary, parseDataUri } = require('../lib/cloudinary');

const router = express.Router();

// POST /api/register
router.post('/', async (req, res) => {
  const b = req.body || {};

  if (!isMongoConfigured()) {
    console.log('[register] MongoDB not configured — booking:', JSON.stringify({ ...b, idCard: '[omitted]' }));
    return res.json({ saved: false, configured: false });
  }

  const eventSlug = String(b.event_code || b.event_slug || b.eventSlug || '');
  const event = eventSlug ? await getEventBySlug(eventSlug) : null;
  if (eventSlug && !event) {
    return res.status(404).json({ saved: false, error: 'Event not found' });
  }
  const eventCode = event?.code || eventSlug;

  const tickets = b.tickets || {};
  const payment = b.payment || {};

  let idCardUrl = null;
  const idCard = b.idCard || null;
  if (idCard && idCard.data) {
    try {
      const { mime, b64 } = parseDataUri(idCard.data, idCard.type);
      const folder = eventCode ? `student-ids/${eventCode}` : 'student-ids';
      const publicId = `${b.ref || 'id'}-${Date.now()}`;
      idCardUrl = await uploadToCloudinary(b64, mime, publicId, folder);
    } catch (e) {
      console.warn('[register] Cloudinary upload failed:', e.message);
    }
  }

  const now = new Date();
  const setFields = {
    event_code: eventCode || eventSlug,
    event_slug: event.slug || eventSlug,
    ref: b.ref,
    name: b.name,
    phone: b.phone,
    email: b.email || null,
    pass_type: tickets.student > 0 && !(tickets.general > 0) ? 'student' : 'general',
    qty_general: tickets.general || 0,
    qty_student: tickets.student || 0,
    total: b.total || 0,
    student_status: b.studentStatus || null,
    payment_id: payment.paymentId || null,
    order_id: payment.orderId || null,
    payment_signature: payment.signature || null,
    payment_status: payment.status || (payment.paymentId ? 'paid' : 'pending'),
    raw: { ...b, idCard: undefined },
    updated_at: now,
  };
  // Only write the ID URL when a fresh upload succeeded, so the later "paid"
  // update (sent without the file) never wipes a previously stored ID.
  if (idCardUrl) setFields.id_card_url = idCardUrl;

  try {
    const db = await getDb();
    // Upsert by ref so an incomplete booking captured on entry is updated in
    // place when payment completes (no duplicate row).
    const query = { ref: b.ref };
    if (eventCode) query.event_code = eventCode;
    await db.collection('registrations').updateOne(
      query,
      { $set: setFields, $setOnInsert: { created_at: now } },
      { upsert: true }
    );
    res.json({ saved: true, idStored: Boolean(idCardUrl) });
  } catch (e) {
    res.status(502).json({ saved: false, error: String(e) });
  }
});

module.exports = router;
