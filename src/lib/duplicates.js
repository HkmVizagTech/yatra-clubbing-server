const { getDb } = require('./mongodb');

// One mobile number books a trip once. "Already registered" means a PAID booking
// for that trip with that number: a pending or failed attempt never blocks a
// retry, so nobody is locked out by a payment that did not go through.
const MESSAGE = 'This mobile number is already registered for this trip.';

/** The paid registration for this trip + number, or null. `exceptRef` skips the booking being saved right now. */
async function findPaidRegistration(eventCode, phone, exceptRef) {
  const p = String(phone || '').replace(/\D/g, '').slice(-10);
  if (!eventCode || !/^[0-9]{10}$/.test(p)) return null;
  const db = await getDb();
  const rows = await db.collection('registrations').find({ event_code: eventCode, phone: p, payment_status: 'paid' }).toArray();
  return rows.find((r) => !exceptRef || r.ref !== exceptRef) || null;
}

module.exports = { findPaidRegistration, ALREADY_REGISTERED: MESSAGE };
