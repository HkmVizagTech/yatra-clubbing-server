// One mobile number books a trip once. Run with:  npm test
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
    deleteMany: async () => ({ deletedCount: 0 }),
    countDocuments: async (q) => rows.filter((d) => matches(d, q)).length,
  };
}
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('./src/lib/mongodb.js', { getDb: async () => ({ collection: coll }), isMongoConfigured: () => true });
stub('./src/lib/storage.js', { configured: () => true, uploadStudentId: async () => 'k', signedIdUrl: async (k) => 'u' + k });

const express = require('express');
const config = require('./src/config');
config.razorpay.keyId = 'rzp_test_x';
config.razorpay.keySecret = 'secret';
const registerRouter = require('./src/routes/register');
const orderRouter = require('./src/routes/createOrder');
const publicRouter = require('./src/routes/publicEvent');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/register', registerRouter);
app.use('/api/create-order', orderRouter);
app.use('/api/public', publicRouter);

const WORKING = { key: 'working', name: 'Working', price: 799, requiresStudentId: false, features: [] };
let server, base, razorpayCalls = 0;
const realFetch = global.fetch;

test.before(async () => {
  const d = { start: '2099-12-06T06:00:00', end: '2099-12-06T19:00:00' };
  const events = coll('events');
  await events.insertOne({ code: 'T1', slug: 't1', name: 'Trip one', status: 'active', dates: d, tickets: [WORKING] });
  await events.insertOne({ code: 'T2', slug: 't2', name: 'Trip two', status: 'active', dates: d, tickets: [WORKING] });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  // anything sent to Razorpay is counted and refused, so no test can reach the real one
  global.fetch = async (url, init) => {
    if (String(url).includes('razorpay.com')) { razorpayCalls++; return { ok: false, text: async () => 'stubbed' }; }
    return realFetch(url, init);
  };
});
test.after(() => { server.close(); global.fetch = realFetch; });

const post = async (path, body) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const PAID = { paymentId: 'pay_1', orderId: 'order_1', status: 'paid' };
const booking = (extra) => ({ name: 'Ravi', phone: '9810000001', age: 24, gender: 'male', tickets: { working: 1 }, pass_key: 'working', event_code: 'T1', ...extra });

test('a paid booking is saved; the same number cannot start another one', async () => {
  const first = await post('/api/register', booking({ ref: 'D-1', payment: PAID }));
  assert.equal(first.status, 200);
  const row = await coll('registrations').findOne({ ref: 'D-1' });
  assert.equal(row.payment_status, 'paid');
  assert.equal(row.duplicate_of, null);

  const again = await post('/api/register', booking({ ref: 'D-2', name: 'Ravi K' })); // a new attempt, not paid yet
  assert.equal(again.status, 409);
  assert.equal(again.json.already_registered, true);
  assert.match(again.json.error, /already registered/i);
  assert.equal(await coll('registrations').findOne({ ref: 'D-2' }), null, 'nothing was stored');
});

test('create-order refuses BEFORE any payment is started', async () => {
  const before = razorpayCalls;
  const r = await post('/api/create-order', { amount: 799, tier_key: 'working', phone: '9810000001', receipt: 'D-3', event_code: 'T1' });
  assert.equal(r.status, 409);
  assert.equal(r.json.already_registered, true);
  assert.match(r.json.error, /already registered/i);
  assert.equal(razorpayCalls, before, 'Razorpay was never contacted');
});

test('a pending or failed attempt does NOT block a retry', async () => {
  await post('/api/register', booking({ ref: 'P-1', phone: '9810000002' })); // saved as pending
  const before = razorpayCalls;
  const r = await post('/api/create-order', { amount: 799, tier_key: 'working', phone: '9810000002', receipt: 'P-2', event_code: 'T1' });
  assert.notEqual(r.status, 409, 'not turned away');
  assert.equal(razorpayCalls, before + 1, 'it went on to ask Razorpay for an order');
  const retry = await post('/api/register', booking({ ref: 'P-2', phone: '9810000002' }));
  assert.equal(retry.status, 200);
});

test('saving the SAME booking again is fine (it is the same booking, not a second one)', async () => {
  const r = await post('/api/register', booking({ ref: 'D-1', payment: PAID }));
  assert.equal(r.status, 200);
  assert.equal((await coll('registrations').findOne({ ref: 'D-1' })).duplicate_of, null);
});

test('two tabs both paid: the second booking is kept (money was taken) and flagged for the admin', async () => {
  const r = await post('/api/register', booking({ ref: 'D-4', payment: { paymentId: 'pay_2', orderId: 'order_2', status: 'paid' } }));
  assert.equal(r.status, 200, 'not thrown away');
  assert.equal((await coll('registrations').findOne({ ref: 'D-4' })).duplicate_of, 'D-1');
});

test('the same number may book a DIFFERENT trip', async () => {
  const r = await post('/api/register', booking({ ref: 'X-1', event_code: 'T2', payment: { paymentId: 'pay_3', orderId: 'order_3', status: 'paid' } }));
  assert.equal(r.status, 200);
  assert.equal((await coll('registrations').findOne({ ref: 'X-1' })).duplicate_of, null);
});

test('the form is told while the person is typing', async () => {
  const yes = await post('/api/public/check-attendee', { event_code: 'T1', phone: '9810000001' });
  assert.equal(yes.json.registered, true);
  const pending = await post('/api/public/check-attendee', { event_code: 'T1', phone: '9810000002' });
  assert.equal(pending.json.registered, false, 'a pending attempt is not "registered"');
  const other = await post('/api/public/check-attendee', { event_code: 'T1', phone: '9810000009' });
  assert.equal(other.json.registered, false);
  const otherTrip = await post('/api/public/check-attendee', { event_code: 'T2', phone: '9810000002' });
  assert.equal(otherTrip.json.registered, false);
});

test('a failed payment attempt does not count either', async () => {
  await post('/api/register', booking({ ref: 'F-1', phone: '9810000004', payment: { paymentId: 'pay_9', status: 'failed' } }));
  const r = await post('/api/create-order', { amount: 799, tier_key: 'working', phone: '9810000004', receipt: 'F-2', event_code: 'T1' });
  assert.notEqual(r.status, 409);
});
