const { getDb } = require('./mongodb');
const { hasEnded } = require('./events');
const { mergeAttendees } = require('./attendees');
const { fetchAttendees, configured } = require('./vanabhojanam');

// Keeps each opted-in trip's Excel/special-price list topped up from Vanabhojanam.
// A trip opts in with "Sync automatically every hour" in the admin
// (event.returning.autoSync). Only people who actually ATTENDED are pulled, only
// for trips that haven't ended, and it only ever ADDS (Excel uploads stay).
let running = false;

async function runAutoSync() {
  if (running) return { skipped: 'already running' };
  if (!configured()) return { skipped: 'not configured' };
  running = true;
  const summary = [];
  try {
    const db = await getDb();
    const events = await db.collection('events').find({}).toArray();
    const due = events.filter((e) =>
      e.returning && e.returning.autoSync === true &&
      e.status !== 'cancelled' && !hasEnded(e)
    );
    if (due.length === 0) return { synced: 0, trips: [] };

    // One call to Vanabhojanam serves every trip.
    let attendees = null;
    let fetchError = null;
    try {
      attendees = await fetchAttendees('attended');
    } catch (e) {
      fetchError = e.message;
    }

    const now = new Date().toISOString();
    for (const e of due) {
      const set = { 'returning.lastSyncAt': now };
      if (fetchError) {
        set['returning.lastSyncError'] = fetchError;
        summary.push({ code: e.code, error: fetchError });
      } else if (attendees.length === 0) {
        set['returning.lastSyncError'] = '';
        set['returning.lastSyncAdded'] = 0;
        summary.push({ code: e.code, added: 0, note: 'no attendance records yet' });
      } else {
        const r = await mergeAttendees(e._id, attendees, 'vanabhojanam');
        set['returning.lastSyncError'] = '';
        set['returning.lastSyncAdded'] = r.added;
        set['returning.lastSyncTotal'] = r.total;
        summary.push({ code: e.code, added: r.added, total: r.total });
      }
      await db.collection('events').updateOne({ _id: e._id }, { $set: set });
    }
    return { synced: due.length, trips: summary };
  } finally {
    running = false;
  }
}

// Runs shortly after boot, then every `minutes`. Never throws, never keeps the process alive.
function startAutoSync(minutes = 60) {
  const every = Math.max(5, Number(minutes) || 60) * 60 * 1000;
  const tick = () =>
    runAutoSync()
      .then((r) => { if (r && r.trips && r.trips.length) console.log('[auto-sync]', JSON.stringify(r.trips)); })
      .catch((e) => console.warn('[auto-sync] failed:', e.message));
  setTimeout(tick, 20 * 1000).unref();
  setInterval(tick, every).unref();
  console.log('[auto-sync] Vanabhojanam list sync runs every ' + every / 60000 + ' minutes for trips that have it switched on');
}

module.exports = { runAutoSync, startAutoSync };
