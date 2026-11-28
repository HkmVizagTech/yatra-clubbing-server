const { isReturningAttendee } = require('./attendees');
const { lookupPerson } = require('./vanabhojanam');

/**
 * Is this number a "returning" attendee for this trip? Two ways in:
 *   1. their number is on the trip's uploaded / synced list, or
 *   2. the trip has live lookup on and Vanabhojanam says they ATTENDED.
 * Someone Vanabhojanam knows who did NOT attend is not returning: regular price.
 * If Vanabhojanam cannot be reached the answer is simply "no".
 */
async function isReturning(event, phone) {
  if (await isReturningAttendee(String(event._id), phone)) return true;
  if (event.returning && event.returning.liveLookup === true) {
    const found = await lookupPerson(phone);
    return !!(found && found.attended);
  }
  return false;
}

// The amount a person pays for a pass. A pass may carry an optional
// `returningPrice`: returning attendees (see above) pay that; everyone else
// pays the normal price. The browser never decides this: create-order and
// register both call it with the phone number.
async function resolvePrice(event, tier, phone) {
  const base = Number(tier.price) || 0;
  const rp = tier.returningPrice;
  if (rp === null || rp === undefined || rp === '') return { amount: base, returning: false };
  const returningPrice = Number(rp);
  if (!Number.isFinite(returningPrice) || returningPrice <= 0) return { amount: base, returning: false };
  return (await isReturning(event, phone)) ? { amount: returningPrice, returning: true } : { amount: base, returning: false };
}

module.exports = { resolvePrice, isReturning };
