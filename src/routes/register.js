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

  // Yatra Clubbing events are student-only, so every registration is a single
  // student pass. The tier still travels in `tickets` (its key, qty 1) so the
  // WhatsApp pass description and admin breakdown keep working.
  const passType = b.pass_type === 'general' ? 'general' : 'student';
  const name = String(b.name || '').trim();
  const phone = String(b.phone || '').trim();
  const college = String(b.college || '').trim();
  const age = Number(b.age);

  if (passType === 'student') {
    if (!name) return res.status(400).json({ saved: false, error: 'Full name is required.' });
    if (!/^[0-9]{10}$/.test(phone)) return res.status(400).json({ saved: false, error: 'Enter a valid 10-digit mobile number.' });
    if (!college) return res.status(400).json({ saved: false, error: 'College / school name is required.' });
    if (!Number.isFinite(age) || age < 10 || age > 100) return res.status(400).json({ saved: false, error: 'Enter a valid age.' });
  }

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
  const totalQty = Object.values(tickets).reduce((s, n) => s + (Number(n) || 0), 0);
  const setFields = {
    event_code: eventCode || eventSlug,
    event_slug: event.slug || eventSlug,
    ref: b.ref,
    name,
    phone,
    email: b.email || null,
    age: Number.isFinite(age) ? age : null,
    college: college || null,
    course: String(b.course || '').trim() || null,
    year_of_study: String(b.year_of_study || '').trim() || null,
    gender: String(b.gender || '').trim() || null,
    pass_type: passType,
    qty_general: passType === 'general' ? totalQty : 0,
    qty_student: passType === 'student' ? totalQty : 0,
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
