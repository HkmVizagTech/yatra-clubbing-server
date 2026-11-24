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

module.exports = { configured, fetchAttendees };
