// Trip lifecycle + student-ID rules. Run with:  npm test
// In-memory stand-ins for MongoDB and Cloudflare R2: no network needed.
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-test-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ObjectId } = require('mongodb');

// ── in-memory Mongo (supports equality and $or) ────────────────────────────
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
    findOne: async (q) => rows.find((d) => matches(d, q)) || null,
    find: (q) => ({ toArray: async () => rows.filter((d) => matches(d, q)), sort() { return this; } }),
    insertOne: async (doc) => { const _id = new ObjectId(); rows.push({ ...doc, _id }); return { insertedId: _id }; },
    updateOne: async (q, u, opts = {}) => {
      let d = rows.find((x) => matches(x, q));
      if (!d && opts.upsert) { d = { _id: new ObjectId(), ...q }; rows.push(d); }
      if (!d) return { matchedCount: 0 };
      if (u.$set) Object.assign(d, u.$set);
      if (u.$setOnInsert && !d.__seen) { Object.assign(d, u.$setOnInsert); d.__seen = true; }
      return { matchedCount: 1 };
    },
    countDocuments: async (q) => rows.filter((d) => matches(d, q)).length,
  };
}
const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('./src/lib/mongodb.js', { getDb: async () => ({ collection: coll }), isMongoConfigured: () => true });
const uploads = [];
stub('./src/lib/storage.js', {
  configured: () => true,
  uploadStudentId: async (buf, mime, ref, code) => { uploads.push({ mime, ref, code, bytes: buf.length }); return `yatra/student-id-cards/${code}/${ref}.png`; },
  signedIdUrl: async (k) => 'https://signed.example/' + k,
});

const express = require('express');
const registerRouter = require('./src/routes/register');
const { hasEnded, tripEndsAt } = require('./src/lib/events');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/register', registerRouter);

const TIERS = [
  { key: 'student', name: 'Student', price: 599, requiresStudentId: true, features: [] },
  { key: 'working', name: 'Working', price: 799, requiresStudentId: false, features: [] },
];
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let server, base;
test.before(async () => {
  const events = coll('events');
  await events.insertOne({ code: 'LIVE', slug: 'live-trip', name: 'Live trip', status: 'active', dates: { start: '2099-12-06T06:00:00', end: '2099-12-06T19:00:00' }, tickets: TIERS });
  await events.insertOne({ code: 'OLD', slug: 'old-trip', name: 'Old trip', status: 'active', dates: { start: '2020-09-20T00:00:00' }, tickets: TIERS });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const post = async (body) => {
  const r = await fetch(base + '/api/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const person = (extra) => ({ name: 'Asha Reddy', phone: '9876543210', age: 20, gender: 'female', college: 'AU College', ...extra });

test('trip end: a trip with only a start date ends when that day ends (India time)', () => {
  const ev = { dates: { start: '2026-09-20T00:00:00' } };
  assert.equal(hasEnded(ev, Date.parse('2026-09-20T23:58:00+05:30')), false);
  assert.equal(hasEnded(ev, Date.parse('2026-09-21T00:01:00+05:30')), true);
  assert.equal(hasEnded(ev, Date.parse('2026-11-24T13:00:00+05:30')), true);
});

test('trip end: an end date/time wins; multi-day trips run through their last day; no dates never expire', () => {
  const ev = { dates: { start: '2026-12-06T06:00:00', end: '2026-12-06T19:00:00' } };
  assert.equal(hasEnded(ev, Date.parse('2026-12-06T18:59:00+05:30')), false);
  assert.equal(hasEnded(ev, Date.parse('2026-12-06T19:01:00+05:30')), true);
  const multi = { dates: { start: '2026-12-10', end: '2026-12-12' } };
  assert.equal(hasEnded(multi, Date.parse('2026-12-12T21:00:00+05:30')), false);
  assert.equal(hasEnded(multi, Date.parse('2026-12-13T01:00:00+05:30')), true);
  assert.equal(tripEndsAt({ dates: { display: 'Soon' } }), null);
  assert.equal(hasEnded({ dates: { display: 'Soon' } }, Date.parse('2099-01-01')), false);
});

test('student ID is mandatory: no ID → rejected, nothing is saved', async () => {
  const r = await post(person({ event_code: 'LIVE', ref: 'L-1', tickets: { student: 1 }, pass_key: 'student' }));
  assert.equal(r.status, 400);
  assert.match(r.json.error, /student ID/i);
  assert.equal(await coll('registrations').findOne({ ref: 'L-1' }), null);
});

test('student ID: a good photo is sent to Cloudflare R2 and only its key is stored', async () => {
  const r = await post(person({ event_code: 'LIVE', ref: 'L-2', tickets: { student: 1 }, pass_key: 'student', id_card: PNG }));
  assert.equal(r.status, 200);
  assert.equal(r.json.saved, true);
  const row = await coll('registrations').findOne({ ref: 'L-2' });
  assert.match(row.id_card_key, /^yatra\/student-id-cards\/LIVE\/L-2/);
  assert.equal(row.id_card_url, undefined, 'no public URL is stored');
  assert.equal(row.pass_type, 'student');
  assert.equal(row.total, 599, 'price comes from the trip, not the browser');
  assert.ok(uploads.some((u) => u.ref === 'L-2' && u.mime === 'image/png' && u.bytes > 0));
});

test('student ID: the later save for the same booking (after payment) reuses the stored ID', async () => {
  const r = await post(person({ event_code: 'LIVE', ref: 'L-2', tickets: { student: 1 }, pass_key: 'student', payment: { paymentId: 'pay_1', status: 'paid' } }));
  assert.equal(r.status, 200);
  const row = await coll('registrations').findOne({ ref: 'L-2' });
  assert.match(row.id_card_key, /L-2/);
  assert.equal(row.payment_status, 'paid');
});

test('student ID: wrong file type is refused', async () => {
  const r = await post(person({ event_code: 'LIVE', ref: 'L-3', tickets: { student: 1 }, pass_key: 'student', id_card: 'data:application/pdf;base64,JVBERi0xLjQ=' }));
  assert.equal(r.status, 400);
  assert.equal(await coll('registrations').findOne({ ref: 'L-3' }), null);
});

test('working pass needs no ID', async () => {
  const r = await post(person({ event_code: 'LIVE', ref: 'L-4', tickets: { working: 1 }, pass_key: 'working', college: '' }));
  assert.equal(r.status, 200);
  const row = await coll('registrations').findOne({ ref: 'L-4' });
  assert.equal(row.total, 799);
  assert.equal(row.id_card_key, undefined);
});

test('an ended trip takes no NEW bookings…', async () => {
  const r = await post(person({ event_code: 'OLD', ref: 'O-1', tickets: { working: 1 }, pass_key: 'working' }));
  assert.equal(r.status, 409);
  assert.equal(r.json.closed, true);
  assert.match(r.json.error, /ended/i);
  assert.equal(await coll('registrations').findOne({ ref: 'O-1' }), null);
});

test('…but a booking whose payment already went through is still saved', async () => {
  const r = await post(person({ event_code: 'OLD', ref: 'O-2', tickets: { working: 1 }, pass_key: 'working', payment: { paymentId: 'pay_9', orderId: 'order_9', status: 'paid' } }));
  assert.equal(r.status, 200);
  const row = await coll('registrations').findOne({ ref: 'O-2' });
  assert.equal(row.payment_status, 'paid');
});
