const express = require('express');
const { getDb, isMongoConfigured } = require('../lib/mongodb');
const { getEventBySlug, getNextRef } = require('../lib/events');
const { parseDataUri } = require('../lib/cloudinary'); // just the data-URI parser; uploads go to R2 (lib/storage.js)
const { resolvePrice } = require('../lib/pricing');
const { uploadStudentId, signedIdUrl } = require('../lib/storage');

const router = express.Router();

// Seat and accommodation on a yatra are allocated separately for men and
// women, so every student registration carries one of exactly these two.
const GENDERS = ['male', 'female'];

// POST /api/register
router.post('/', async (req, res) => {
  const b = req.body || {};

  if (!isMongoConfigured()) {
    console.log('[register] MongoDB not configured — booking:', JSON.stringify({ ...b, id_card: '[omitted]', idCard: '[omitted]' }));
    return res.json({ saved: false, configured: false });
  }

  const eventSlug = String(b.event_code || b.event_slug || b.eventSlug || '');
  const event = eventSlug ? await getEventBySlug(eventSlug) : null;
  if (eventSlug && !event) {
    return res.status(404).json({ saved: false, error: 'Event not found' });
  }
  const eventCode = event?.code || eventSlug;

  // Closed (or ended) trips take no NEW bookings. A booking that already exists,
  // or one that is being saved after a payment went through, must still be saved.
  if (event && event.status !== 'active') {
    const paid = !!(b.payment && b.payment.paymentId);
    let existing = null;
    if (!paid && b.ref) {
      try { existing = await (await getDb()).collection('registrations').findOne({ ref: b.ref }, { projection: { _id: 1 } }); } catch { /* treated as new */ }
    }
    if (!paid && !existing) {
      return res.status(409).json({ saved: false, closed: true, error: event.ended ? 'This trip has ended, so registrations are closed.' : 'Registrations for this trip are closed.' });
    }
  }

  const tickets = b.tickets || {};
  const payment = b.payment || {};

  // The pass decides who the booking is for. The event (set in admin) is the
  // source of truth: a tier flagged requiresStudentId is a student pass, any
  // other tier is for working people. Price comes from the tier, never from
  // the browser.
  const tierKey = String(b.pass_key || Object.keys(tickets)[0] || '');
  const eventTiers = Array.isArray(event && event.tickets) ? event.tickets : [];
  const tier = eventTiers.find((t) => t.key === tierKey) || null;
  if (eventTiers.length > 0 && !tier) {
    return res.status(400).json({ saved: false, error: 'That pass is not available for this yatra.' });
  }
  const passType = tier ? (tier.requiresStudentId ? 'student' : 'general') : (b.pass_type === 'general' ? 'general' : 'student');

  const name = String(b.name || '').trim();
  const phone = String(b.phone || '').trim();

  // Normal price, or the returning-attendee price if this number is on the
  // admin's uploaded list.
  let priced = null;
  if (tier) {
    try {
      priced = await resolvePrice(event, tier, phone);
    } catch (e) {
      return res.status(502).json({ saved: false, error: 'Could not confirm the price right now. Please try again.' });
    }
  }
  const total = priced ? priced.amount : Number(b.total) || 0;
  const returning = !!(priced && priced.returning);
  const college = String(b.college || '').trim();
  const organisation = String(b.organisation || '').trim();
  const age = Number(b.age);
  const gender = String(b.gender || '').trim().toLowerCase();

  if (!name) return res.status(400).json({ saved: false, error: 'Full name is required.' });
  if (!/^[0-9]{10}$/.test(phone)) return res.status(400).json({ saved: false, error: 'Enter a valid 10-digit mobile number.' });
  if (!Number.isFinite(age) || age < 10 || age > 100) return res.status(400).json({ saved: false, error: 'Enter a valid age.' });
  if (!GENDERS.includes(gender)) return res.status(400).json({ saved: false, error: 'Please select your gender.' });
  if (passType === 'student' && !college) {
    return res.status(400).json({ saved: false, error: 'College / school name is required.' });
  }

  // Student passes MUST have an ID on file. It arrives as a data-URI on the first
  // save and goes to Cloudflare R2; later saves for the same booking (after
  // payment) reuse the stored one.
  // People on the returning list (attended before) don't need to upload an ID on trips
  // that are set that way. The server decides this from their phone number — never from
  // anything the browser says.
  const waiveId = passType === 'student' && !!(priced && priced.returning) && !!(event && event.returning && event.returning.skipId);
  let newIdKey = null;
  if (passType === 'student' && !waiveId) {
    const query0 = { ref: b.ref };
    if (eventCode) query0.event_code = eventCode;
    if (b.id_card) {
      const { mime, b64 } = parseDataUri(String(b.id_card), 'image/jpeg');
      if (!/^image\/(jpeg|png|webp)$/.test(mime) || b64.length > 6 * 1024 * 1024) {
        return res.status(400).json({ saved: false, error: 'Upload a clear JPG or PNG photo of your ID (under 4 MB).' });
      }
      try {
        newIdKey = await uploadStudentId(Buffer.from(b64, 'base64'), mime, b.ref || Date.now(), eventCode);
      } catch (e) {
        console.error('[register] ID upload to R2 failed:', e.message);
        return res.status(e.code === 'NOT_CONFIGURED' ? 503 : 502).json({ saved: false, error: 'We could not upload your ID. Please try again.' });
      }
    } else {
      const db0 = await getDb();
      const prior = await db0.collection('registrations').findOne(query0, { projection: { id_card_key: 1, id_card_url: 1 } });
      if (!prior || !(prior.id_card_key || prior.id_card_url)) {
        return res.status(400).json({ saved: false, error: 'Please upload your student ID card. It is required for a student pass.' });
      }
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
    college: passType === 'student' ? college : null,
    organisation: passType === 'general' ? (organisation || null) : null,
    pass_key: tier ? tier.key : tierKey || null,
    ...(newIdKey ? { id_card_key: newIdKey } : {}),
    course: passType === 'student' ? String(b.course || '').trim() || null : null,
    year_of_study: passType === 'student' ? String(b.year_of_study || '').trim() || null : null,
    gender: GENDERS.includes(gender) ? gender : null,
    pass_type: passType,
    qty_general: passType === 'general' ? totalQty : 0,
    qty_student: passType === 'student' ? totalQty : 0,
    total,
    returning_attendee: returning,
    student_status: passType === 'student' ? (waiveId ? 'verified' : (b.studentStatus || 'Pending ID verification')) : null,
    id_waived: waiveId,
    payment_id: payment.paymentId || null,
    order_id: payment.orderId || null,
    payment_signature: payment.signature || null,
    payment_status: payment.status || (payment.paymentId ? 'paid' : 'pending'),
    raw: { ...b, id_card: undefined, idCard: undefined },
    updated_at: now,
  };

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
    res.json({ saved: true });
  } catch (e) {
    res.status(502).json({ saved: false, error: String(e) });
  }
});

module.exports = router;
