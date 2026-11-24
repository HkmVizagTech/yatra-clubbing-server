// Returning-attendee list: merge rules, the Vanabhojanam sync, and what the list
// does to price + student-ID at booking time. Run with:  npm test
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-test-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ObjectId } = require('mongodb');

// ── in-memory Mongo ────────────────────────────────────────────────────────
const store = new Map();
const matches = (doc, q) => Object.entries(q || {}).every(([k, v]) => {
  if (k === '$or') return v.some((sub) => matches(doc, sub));
  return String(doc[k]) === String(v);
});
function coll(name) {
  if (!store.has(name)) store.set(name, []);
  const rows = store.get(name);
  return {
    createIndex: async () => 'ok',
    dropIndex: async () => { throw new Error('no such index'); },
    findOne: async (q) => rows.find((d) => matches(d, q)) || null,
    find: (q) => ({ toArray: async () => rows.filter((d) => matches(d, q)).map((d) => d), sort() { return this; } }),
    insertOne: async (doc) => { const _id = new ObjectId(); rows.push({ ...doc, _id }); return { insertedId: _id }; },
    insertMany: async (docs) => { for (const d of docs) rows.push({ ...d, _id: new ObjectId() }); return { insertedCount: docs.length }; },
    updateOne: async (q, u, opts = {}) => {
      let d = rows.find((x) => matches(x, q));
      if (!d && opts.upsert) { d = { _id: new ObjectId(), ...q, ...(u.$setOnInsert || {}) }; rows.push(d); }
      if (!d) return { matchedCount: 0 };
      if (u.$set) Object.assign(d, u.$set);
      return { matchedCount: 1 };
    },
    deleteMany: async (q) => { let n = 0; for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], q)) { rows.splice(i, 1); n++; } return { deletedCount: n }; },
    countDocuments: async (q) => rows.filter((d) => matches(d, q)).length,
  };
}
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('./src/lib/mongodb.js', { getDb: async () => ({ collection: coll }), isMongoConfigured: () => true });
const uploads = [];
stub('./src/lib/storage.js', {
  configured: () => true,
  uploadStudentId: async (buf, mime, ref, code) => { uploads.push({ ref }); return `yatra/student-id-cards/${code}/${ref}.png`; },
  signedIdUrl: async (k) => 'https://signed.example/' + k,
});

const express = require('express');
const config = require('./src/config');
const att = require('./src/lib/attendees');
const { fetchAttendees } = require('./src/lib/vanabhojanam');
const registerRouter = require('./src/routes/register');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/register', registerRouter);

const phoneN = (i) => String(9000000000 + i); // 9000000000… all valid mobiles
const people = (from, to) => Array.from({ length: to - from }, (_, i) => ({ phone: phoneN(from + i), name: `Person ${from + i}` }));

// ── list rules ─────────────────────────────────────────────────────────────
test('uploads ADD: 100 first, then 50 more → 150 (the first 100 stay)', async () => {
  const first = await att.mergeAttendees('t1', people(0, 100));
  assert.deepEqual([first.added, first.total], [100, 100]);
  const second = await att.mergeAttendees('t1', people(100, 150));
  assert.deepEqual([second.added, second.duplicates, second.total], [50, 0, 150]);
  assert.equal(await att.isReturningAttendee('t1', phoneN(5)), true, 'an early person is still on the list');
  assert.equal(await att.isReturningAttendee('t1', phoneN(120)), true, 'and so is a later one');
});

test('re-uploading overlapping people only adds the new ones', async () => {
  // 20 already there (0–19 from the first batch) + 30 genuinely new
  const r = await att.mergeAttendees('t1', [...people(0, 20), ...people(500, 530)]);
  assert.deepEqual([r.added, r.duplicates, r.total], [30, 20, 180]);
});

test('same number + different names → both kept', async () => {
  await att.mergeAttendees('t2', [{ phone: '9123456780', name: 'Asha Reddy' }]);
  const r = await att.mergeAttendees('t2', [{ phone: '9123456780', name: 'Ravi Reddy' }]);
  assert.deepEqual([r.added, r.duplicates, r.total], [1, 0, 2]);
  assert.equal((await att.attendeeSummary('t2')).numbers, 1, 'one number, two people');
});

test('same number + same name → one (ignoring case, spacing and punctuation)', async () => {
  await att.mergeAttendees('t3', [{ phone: '9123456781', name: 'K. Sai Ram' }]);
  const r = await att.mergeAttendees('t3', [
    { phone: '9123456781', name: 'k sai   ram' },
    { phone: '+91 91234 56781', name: 'K.SAI RAM' },
  ]);
  assert.deepEqual([r.added, r.duplicates, r.total], [0, 2, 1]);
});

test('duplicates inside a single upload are collapsed too', async () => {
  const r = await att.mergeAttendees('t4', [
    { phone: '9123456782', name: 'Meena' },
    { phone: '9123456782', name: 'Meena' },
    { phone: '9123456782', name: 'Meena S' },
  ]);
  assert.deepEqual([r.added, r.duplicates, r.total], [2, 1, 2]);
});

test('a phone-only row is not duplicated, and learns the name when one arrives', async () => {
  await att.mergeAttendees('t5', ['9123456783']);
  const dup = await att.mergeAttendees('t5', ['9123456783']);
  assert.deepEqual([dup.added, dup.duplicates, dup.total], [0, 1, 1]);
  const named = await att.mergeAttendees('t5', [{ phone: '9123456783', name: 'Divya' }]);
  assert.deepEqual([named.added, named.updated, named.total], [0, 1, 1], 'filled in, not added twice');
  const again = await att.mergeAttendees('t5', [{ phone: '9123456783', name: 'divya' }]);
  assert.deepEqual([again.added, again.duplicates, again.total], [0, 1, 1]);
});

test('unusable numbers are counted, not stored; lists are per trip', async () => {
  const r = await att.mergeAttendees('t6', ['12345', '5876543210', { phone: '', name: 'x' }, '9123456784']);
  assert.deepEqual([r.added, r.invalid, r.total], [1, 3, 1]);
  assert.equal(await att.isReturningAttendee('t6', '9123456784'), true);
  assert.equal(await att.isReturningAttendee('t1', '9123456784'), false, 'another trip does not see it');
  assert.equal(await att.isReturningAttendee('t6', 'not a number'), false);
});

test('remove all', async () => {
  assert.ok((await att.clearAttendees('t6')) >= 1);
  assert.equal(await att.hasAttendeeList('t6'), false);
});

// ── Vanabhojanam sync ──────────────────────────────────────────────────────
test('Vanabhojanam sync: sends the key, reads { name, phone }, and ADDS to what is there', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url, key: req.headers['x-api-key'] });
    if (req.headers['x-api-key'] !== 'secret-key') { res.statusCode = 401; return res.end('{}'); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'success', count: 2, attendees: [{ name: 'Arjun', phone: '9876543210' }, { name: 'Sita', phone: '9123456780' }] }));
  });
  await new Promise((r) => srv.listen(0, r));
  const original = { ...config.vanabhojanam };
  try {
    config.vanabhojanam.apiUrl = `http://127.0.0.1:${srv.address().port}`;

    config.vanabhojanam.apiKey = 'wrong';
    await assert.rejects(fetchAttendees(), /rejected the API key/);

    config.vanabhojanam.apiKey = 'secret-key';
    const list = await fetchAttendees();
    assert.equal(seen.at(-1).url, '/integrations/attendees?who=attended');
    await fetchAttendees('paid');
    assert.equal(seen.at(-1).url, '/integrations/attendees?who=paid');
    assert.deepEqual(list.map((p) => p.phone), ['9876543210', '9123456780']);

    await att.mergeAttendees('t7', [{ phone: '9000000099', name: 'From Excel' }], 'excel');
    const r = await att.mergeAttendees('t7', list, 'vanabhojanam');
    assert.deepEqual([r.added, r.total], [2, 3], 'the Excel person is still there');
    assert.deepEqual((await att.attendeeSummary('t7')).sources.sort(), ['excel', 'vanabhojanam']);
    const again = await att.mergeAttendees('t7', list, 'vanabhojanam');
    assert.deepEqual([again.added, again.duplicates, again.total], [0, 2, 3], 'syncing twice adds nothing');
  } finally {
    Object.assign(config.vanabhojanam, original);
    srv.close();
  }
});

test('Vanabhojanam sync: not configured / unreachable gives a clear error', async () => {
  const original = { ...config.vanabhojanam };
  try {
    config.vanabhojanam.apiUrl = '';
    config.vanabhojanam.apiKey = '';
    await assert.rejects(fetchAttendees(), (e) => e.code === 'NOT_CONFIGURED');
  } finally { Object.assign(config.vanabhojanam, original); }
});

// ── booking: price + ID for returning attendees ───────────────────────────
const STUDENT = { key: 'student', name: 'Student', price: 199, returningPrice: 99, requiresStudentId: true, features: [] };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let server, base, skipEventId, keepEventId;
test.before(async () => {
  const events = coll('events');
  const d = { start: '2099-12-06T06:00:00', end: '2099-12-06T19:00:00' };
  skipEventId = (await events.insertOne({ code: 'SKIP', slug: 'skip', name: 'Skip ID trip', status: 'active', dates: d, tickets: [STUDENT], returning: { skipId: true, label: 'Vanabhojanam' } })).insertedId;
  keepEventId = (await events.insertOne({ code: 'KEEP', slug: 'keep', name: 'Keep ID trip', status: 'active', dates: d, tickets: [STUDENT], returning: { skipId: false } })).insertedId;
  await att.mergeAttendees(String(skipEventId), [{ phone: '9876543210', name: 'Arjun' }], 'vanabhojanam');
  await att.mergeAttendees(String(keepEventId), [{ phone: '9876543210', name: 'Arjun' }], 'vanabhojanam');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const post = async (body) => {
  const r = await fetch(base + '/api/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const student = (extra) => ({ name: 'Asha', age: 20, gender: 'female', college: 'AU', tickets: { student: 1 }, pass_key: 'student', ...extra });

test('returning attendee on a "skip ID" trip: ₹99, no ID needed, marked verified', async () => {
  const before = uploads.length;
  const r = await post(student({ event_code: 'SKIP', ref: 'S-1', phone: '9876543210' }));
  assert.equal(r.status, 200);
  const row = await coll('registrations').findOne({ ref: 'S-1' });
  assert.equal(row.total, 99);
  assert.equal(row.returning_attendee, true);
  assert.equal(row.id_waived, true);
  assert.equal(row.student_status, 'verified');
  assert.equal(row.id_card_key, undefined);
  assert.equal(uploads.length, before, 'nothing was uploaded');
});

test('NOT on the list: ₹199 and the ID is mandatory', async () => {
  const no = await post(student({ event_code: 'SKIP', ref: 'S-2', phone: '9000000001' }));
  assert.equal(no.status, 400);
  assert.match(no.json.error, /student ID/i);
  assert.equal(await coll('registrations').findOne({ ref: 'S-2' }), null);

  const yes = await post(student({ event_code: 'SKIP', ref: 'S-3', phone: '9000000001', id_card: PNG }));
  assert.equal(yes.status, 200);
  const row = await coll('registrations').findOne({ ref: 'S-3' });
  assert.equal(row.total, 199);
  assert.equal(row.returning_attendee, false);
  assert.equal(row.id_waived, false);
  assert.equal(row.student_status, 'Pending ID verification');
  assert.match(row.id_card_key, /S-3/);
});

test('the browser cannot waive the ID: claiming "returning" in the payload changes nothing', async () => {
  const r = await post(student({ event_code: 'SKIP', ref: 'S-4', phone: '9000000002', returning_attendee: true, id_waived: true, total: 1, studentStatus: 'verified' }));
  assert.equal(r.status, 400, 'still needs an ID');
});

test('a trip that does NOT skip the ID: attendees still pay ₹99 but must upload it', async () => {
  const no = await post(student({ event_code: 'KEEP', ref: 'K-1', phone: '9876543210' }));
  assert.equal(no.status, 400);
  const yes = await post(student({ event_code: 'KEEP', ref: 'K-2', phone: '9876543210', id_card: PNG }));
  assert.equal(yes.status, 200);
  const row = await coll('registrations').findOne({ ref: 'K-2' });
  assert.equal(row.total, 99);
  assert.equal(row.id_waived, false);
});

test('a number with a different name on the same phone still counts as returning', async () => {
  await att.mergeAttendees(String(skipEventId), [{ phone: '9876543210', name: 'Arjun Brother' }], 'excel');
  const r = await post(student({ event_code: 'SKIP', ref: 'S-5', phone: '9876543210' }));
  assert.equal(r.status, 200);
});

// ── hourly auto-sync ───────────────────────────────────────────────────────
const { runAutoSync } = require('./src/lib/autoSync');

async function withVanabhojanam(handler, fn) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, r));
  const original = { ...config.vanabhojanam };
  config.vanabhojanam.apiUrl = `http://127.0.0.1:${srv.address().port}`;
  config.vanabhojanam.apiKey = 'secret-key';
  try { return await fn(); } finally { Object.assign(config.vanabhojanam, original); srv.close(); }
}
const okList = (list) => (req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ status: 'success', count: list.length, attendees: list }));
};

test('auto-sync: pulls into trips that opted in, skips ended / opted-out / cancelled trips', async () => {
  const events = coll('events');
  const future = { start: '2099-12-06T06:00:00', end: '2099-12-06T19:00:00' };
  const on = (await events.insertOne({ code: 'AUTO1', name: 'Auto on', status: 'draft', dates: future, tickets: [], returning: { autoSync: true } })).insertedId;
  const off = (await events.insertOne({ code: 'AUTO2', name: 'Auto off', status: 'active', dates: future, tickets: [], returning: { autoSync: false } })).insertedId;
  const ended = (await events.insertOne({ code: 'AUTO3', name: 'Ended', status: 'closed', dates: { start: '2020-01-01T00:00:00' }, tickets: [], returning: { autoSync: true } })).insertedId;
  const cancelled = (await events.insertOne({ code: 'AUTO4', name: 'Cancelled', status: 'cancelled', dates: future, tickets: [], returning: { autoSync: true } })).insertedId;

  await withVanabhojanam(okList([{ name: 'Arjun', phone: '9876543210' }, { name: 'Sita', phone: '9123456780' }]), async () => {
    const r = await runAutoSync();
    assert.equal(r.synced, 1, 'only the opted-in, running trip');
    assert.deepEqual(r.trips.map((t) => t.code), ['AUTO1']);
  });
  assert.equal(await att.isReturningAttendee(String(on), '9876543210'), true);
  assert.equal(await att.hasAttendeeList(String(off)), false);
  assert.equal(await att.hasAttendeeList(String(ended)), false);
  assert.equal(await att.hasAttendeeList(String(cancelled)), false);

  const doc = await events.findOne({ code: 'AUTO1' });
  assert.ok(doc['returning.lastSyncAt'], 'records when it last ran');
  assert.equal(doc['returning.lastSyncAdded'], 2);
  assert.equal(doc['returning.lastSyncError'], '');
});

test('auto-sync: running again adds nobody twice, and keeps what was uploaded by hand', async () => {
  const trip = await coll('events').findOne({ code: 'AUTO1' });
  await att.mergeAttendees(String(trip._id), [{ phone: '9000000077', name: 'From Excel' }], 'excel');
  await withVanabhojanam(okList([{ name: 'Arjun', phone: '9876543210' }, { name: 'Sita', phone: '9123456780' }, { name: 'New Person', phone: '9000000088' }]), async () => {
    const r = await runAutoSync();
    assert.deepEqual([r.trips[0].added, r.trips[0].total], [1, 4], 'only the genuinely new person was added');
  });
  assert.equal(await att.isReturningAttendee(String(trip._id), '9000000077'), true, 'the Excel person is still there');
});

test('auto-sync: Vanabhojanam down or rejecting the key is recorded, never thrown', async () => {
  await withVanabhojanam((req, res) => { res.statusCode = 500; res.end('{}'); }, async () => {
    const r = await runAutoSync();
    assert.match(r.trips[0].error, /HTTP 500/);
  });
  const doc = await coll('events').findOne({ code: 'AUTO1' });
  assert.match(doc['returning.lastSyncError'], /HTTP 500/);
  assert.equal(await att.hasAttendeeList(String(doc._id)), true, 'the existing list is untouched by a failed run');
});

test('auto-sync: nobody attended yet → no change, no error', async () => {
  await withVanabhojanam(okList([]), async () => {
    const r = await runAutoSync();
    assert.equal(r.trips[0].added, 0);
    assert.match(r.trips[0].note, /no attendance/);
  });
  assert.equal((await coll('events').findOne({ code: 'AUTO1' }))['returning.lastSyncError'], '');
});

test('auto-sync: does nothing when the Vanabhojanam connection is not configured', async () => {
  const original = { ...config.vanabhojanam };
  try {
    config.vanabhojanam.apiUrl = '';
    assert.deepEqual(await runAutoSync(), { skipped: 'not configured' });
  } finally { Object.assign(config.vanabhojanam, original); }
});
