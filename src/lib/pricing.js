const { isReturningAttendee } = require('./attendees');

// The amount a person pays for a pass. A pass may carry an optional
// `returningPrice`: people whose mobile number is on the event's uploaded
// attendee list pay that; everyone else (or any event without a list) pays the
// normal price. The browser never decides this — create-order and register both
// call it with the phone number.
async function resolvePrice(event, tier, phone) {
  const base = Number(tier.price) || 0;
  const rp = tier.returningPrice;
  if (rp === null || rp === undefined || rp === '') return { amount: base, returning: false };
  const returningPrice = Number(rp);
  if (!Number.isFinite(returningPrice) || returningPrice <= 0) return { amount: base, returning: false };
  const listed = await isReturningAttendee(String(event._id), phone);
  return listed ? { amount: returningPrice, returning: true } : { amount: base, returning: false };
}

module.exports = { resolvePrice };
