const config = require('../config');

// Reads the list of people who attended Vanabhojanam from its integration API
// (GET /integrations/attendees, x-api-key). Returns [{ name, phone }].
function configured() {
  return Boolean(config.vanabhojanam.apiUrl && config.vanabhojanam.apiKey);
}

// who: 'attended' (default — scanned in at the gate) or 'paid' (everyone who paid)
async function fetchAttendees(who = 'attended') {
  if (!configured()) {
    const e = new Error('The Vanabhojanam connection is not set up on the server (VANABHOJANAM_API_URL / VANABHOJANAM_API_KEY).');
    e.code = 'NOT_CONFIGURED';
    throw e;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(config.vanabhojanam.apiUrl + '/integrations/attendees?who=' + (who === 'paid' ? 'paid' : 'attended'), {
      headers: { 'x-api-key': config.vanabhojanam.apiKey, accept: 'application/json' },
      signal: ctl.signal,
    });
    if (r.status === 401) throw new Error('Vanabhojanam rejected the API key.');
    if (!r.ok) throw new Error('Vanabhojanam responded with HTTP ' + r.status + '.');
    const body = await r.json();
    if (!body || !Array.isArray(body.attendees)) throw new Error('Vanabhojanam sent an unexpected response.');
    return body.attendees;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Vanabhojanam did not answer in time.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ── One person, looked up live by mobile number ─────────────────────────────
// Used while someone fills the registration form: is this number known to
// Vanabhojanam, did they attend, and what details can pre-fill the form?
//   → { found, attended, person: { name, gender, age, college, course, year } }
//   → null  when the lookup could not be done (not configured, down, slow).
// A failed lookup must never block a booking or change a price: callers treat
// null as "not known", i.e. the normal price and an empty form.
//
// Answers are remembered for a few minutes, so the price the person was shown
// while typing is the price the server charges a moment later.
const memory = new Map();
const KEEP_MS = 10 * 60 * 1000;      // known / attended answers
const KEEP_UNKNOWN_MS = 2 * 60 * 1000; // "not found"

async function lookupPerson(phone) {
  if (!configured()) return null;
  const p = String(phone || '').replace(/\D/g, '').slice(-10);
  if (!/^[6-9][0-9]{9}$/.test(p)) return null;

  const hit = memory.get(p);
  if (hit && hit.until > Date.now()) return hit.value;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(config.vanabhojanam.apiUrl + '/integrations/person?phone=' + p, {
      headers: { 'x-api-key': config.vanabhojanam.apiKey, accept: 'application/json' },
      signal: ctl.signal,
    });
    if (!r.ok) return null;
    const body = await r.json();
    if (!body || body.status !== 'success') return null;
    const value = { found: !!body.found, attended: !!body.attended, person: body.person || null };
    if (memory.size > 2000) memory.clear();
    memory.set(p, { value, until: Date.now() + (value.found ? KEEP_MS : KEEP_UNKNOWN_MS) });
    return value;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function forgetLookups() { memory.clear(); }

module.exports = { configured, fetchAttendees, lookupPerson, forgetLookups };
