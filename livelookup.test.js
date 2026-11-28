// Live lookup in Vanabhojanam while registering: attended -> special price and no ID,
// known but NOT attended -> details pre-filled but the normal price, unknown -> normal.
// Run with:  npm test
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-test-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ObjectId } = require('mongodb');

// ── in-memory Mongo (same shape the other suites use) ─────────────────────
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
stub('./src/lib/storage.js', {
  configured: () => true,
  uploadStudentId: async (buf, mime, ref, code) => `yatra/student-id-cards/${code}/${ref}.png`,
  signedIdUrl: async (k) => 'https://signed.example/' + k,
});

const express = require('express');
const config = require('./src/config');
const { forgetLookups } = require('./src/lib/vanabhojanam');
const registerRouter = require('./src/routes/register');
const publicRouter = require('./src/routes/publicEvent');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/register', registerRouter);
app.use('/api/public', publicRouter);

// ── a fake Vanabhojanam ─────────────────────────────────────────────────────
const PEOPLE = {
  9111111111: { found: true, attended: true, person: { name: 'Arjun', gender: 'Male', age: 22, college: 'AU', course: 'B.Tech', year: '3rd Year' } },
  9222222222: { found: true, attended: false, person: { name: 'Meena', gender: 'Female', age: 20, college: 'GITAM', course: 'BBA', year: '2nd' } },
};
let vb, calls = 0;
const original = { ...config.vanabhojanam };
const STUDENT = { key: 'student', name: 'Student', price: 199, returningPrice: 99, requiresStudentId: true, features: [] };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let server, base;

test.before(async () => {
  vb = http.createServer((req, res) => {
    calls++;
    const u = new URL(req.url, 'http://x');
    if (req.headers['x-api-key'] !== 'live-key') { res.statusCode = 401; return res.end('{}'); }
    const phone = u.searchParams.get('phone');
    if (phone === '9333333333') { res.statusCode = 500; return res.end('{}'); } // Vanabhojanam having a bad day
    res.setHeader('content-type', 'application/json');
    const p = PEOPLE[phone];
    res.end(JSON.stringify(p ? { status: 'success', ...p } : { status: 'success', found: false, attended: false, person: null }));
  });
  await new Promise((r) => vb.listen(0, r));
  config.vanabhojanam.apiUrl = `http://127.0.0.1:${vb.address().port}`;
  config.vanabhojanam.apiKey = 'live-key';

  const d = { start: '2099-12-06T06:00:00', end: '2099-12-06T19:00:00' };
  const events = coll('events');
  await events.insertOne({ code: 'LIVE', slug: 'live', name: 'Live trip', status: 'active', dates: d, tickets: [STUDENT], returning: { skipId: true, label: 'Vanabhojanam', liveLookup: true } });
  await events.insertOne({ code: 'OFF', slug: 'off', name: 'Off trip', status: 'active', dates: d, tickets: [STUDENT], returning: { skipId: true, label: 'Vanabhojanam' } });

  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); vb.close(); Object.assign(config.vanabhojanam, original); });
test.beforeEach(() => forgetLookups());

const post = async (path, body) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const register = (extra) => post('/api/register', { name: 'Asha', age: 20, gender: 'female', college: 'AU', tickets: { student: 1 }, pass_key: 'student', ...extra });
const check = (phone, code = 'LIVE') => post('/api/public/check-attendee', { event_code: code, phone });

test('ATTENDED in Vanabhojanam: the special price, no student ID needed', async () => {
  const r = await register({ event_code: 'LIVE', ref: 'L-1', phone: '9111111111' });
  assert.equal(r.status, 200);
  const row = await coll('registrations').findOne({ ref: 'L-1' });
  assert.equal(row.total, 99);
  assert.equal(row.returning_attendee, true);
  assert.equal(row.id_waived, true);
  assert.equal(row.student_status, 'verified');
});

test('KNOWN but did NOT attend: the normal price, and the ID is still required', async () => {
  const no = await register({ event_code: 'LIVE', ref: 'L-2', phone: '9222222222' });
  assert.equal(no.status, 400);
  assert.match(no.json.error, /student ID/i);
  const yes = await register({ event_code: 'LIVE', ref: 'L-3', phone: '9222222222', id_card: PNG });
  assert.equal(yes.status, 200);
  const row = await coll('registrations').findOne({ ref: 'L-3' });
  assert.equal(row.total, 199);
  assert.equal(row.returning_attendee, false);
  assert.equal(row.id_waived, false);
});

test('NOT in Vanabhojanam at all: the normal price and the ID', async () => {
  const r = await register({ event_code: 'LIVE', ref: 'L-4', phone: '9444444444', id_card: PNG });
  assert.equal(r.status, 200);
  const row = await coll('registrations').findOne({ ref: 'L-4' });
  assert.equal(row.total, 199);
  assert.equal(row.id_waived, false);
});

test('Vanabhojanam failing never blocks a booking: normal price, ID required', async () => {
  const noId = await register({ event_code: 'LIVE', ref: 'L-5', phone: '9333333333' });
  assert.equal(noId.status, 400);
  const ok = await register({ event_code: 'LIVE', ref: 'L-6', phone: '9333333333', id_card: PNG });
  assert.equal(ok.status, 200);
  assert.equal((await coll('registrations').findOne({ ref: 'L-6' })).total, 199);
});

test('a trip WITHOUT live lookup ignores Vanabhojanam completely', async () => {
  const before = calls;
  const r = await register({ event_code: 'OFF', ref: 'O-1', phone: '9111111111', id_card: PNG });
  assert.equal(r.status, 200);
  assert.equal((await coll('registrations').findOne({ ref: 'O-1' })).total, 199, 'an attendee still pays full price here');
  assert.equal(calls, before, 'Vanabhojanam was not even asked');
  assert.deepEqual((await check('9111111111', 'OFF')).json, { checkable: false, listed: false });
});

test('the browser cannot fake it: claiming returning / waived changes nothing', async () => {
  const r = await register({ event_code: 'LIVE', ref: 'L-7', phone: '9222222222', returning_attendee: true, id_waived: true, total: 1, studentStatus: 'verified' });
  assert.equal(r.status, 400);
});

test('check: attended -> special price flag + details to pre-fill', async () => {
  const r = await check('9111111111');
  assert.equal(r.status, 200);
  assert.equal(r.json.listed, true);
  assert.equal(r.json.attended, true);
  assert.equal(r.json.known, true);
  assert.deepEqual(r.json.prefill, { name: 'Arjun', gender: 'male', age: '22', college: 'AU', course: 'B.Tech', year: '3rd Year' });
});

test('check: known but not attended -> NOT listed, yet details still come to pre-fill', async () => {
  const r = await check('9222222222');
  assert.equal(r.json.listed, false);
  assert.equal(r.json.attended, false);
  assert.equal(r.json.known, true);
  assert.equal(r.json.prefill.name, 'Meena');
  assert.equal(r.json.prefill.gender, 'female');
  assert.equal(r.json.prefill.year, '2nd Year', 'Vanabhojanam\'s "2nd" becomes the form\'s "2nd Year"');
});

test('check: unknown number and a failing Vanabhojanam -> nothing pre-filled, nothing listed', async () => {
  for (const phone of ['9555555555', '9333333333']) {
    const r = await check(phone);
    assert.equal(r.status, 200);
    assert.equal(r.json.listed, false);
    assert.equal(r.json.prefill, null);
  }
});

test('the pre-fill never carries more than the form needs', async () => {
  PEOPLE['9777777777'] = { found: true, attended: false, person: { name: 'Zed', gender: 'Male', age: 25, college: 'X', course: 'Y', year: '4th Year', email: 'z@z.com', dob: '1999-01-01', idKey: 'secret' } };
  forgetLookups();
  const r = await check('9777777777');
  assert.deepEqual(Object.keys(r.json.prefill || {}).sort(), ['age', 'college', 'course', 'gender', 'name', 'year']);
  assert.equal(JSON.stringify(r.json).includes('z@z.com') || JSON.stringify(r.json).includes('secret'), false);
});

test('details are handed out sparingly: after 10 per hour from one connection, only the yes/no remains', async () => {
  let blocked;
  for (let i = 0; i < 14; i++) {
    PEOPLE[`96000000${String(i).padStart(2, '0')}`] = { found: true, attended: true, person: { name: `P${i}`, gender: 'Male', age: 21, college: 'X', course: 'Y', year: '1st Year' } };
    blocked = await check(`96000000${String(i).padStart(2, '0')}`);
  }
  assert.equal(blocked.json.prefill, null, 'no more details once the allowance is used');
  assert.equal(blocked.json.listed, true, 'but the price check still works');
});

