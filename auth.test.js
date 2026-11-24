// Auth + roles tests. Run with:  npm test
// Uses an in-memory stand-in for MongoDB, so no database is needed.
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-test-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');

// ── in-memory Mongo ────────────────────────────────────────────────────────
const store = new Map();
function coll(name) {
  if (!store.has(name)) store.set(name, []);
  const rows = store.get(name);
  const match = (doc, q) => Object.entries(q || {}).every(([k, v]) => String(doc[k]) === String(v));
  return {
    createIndex: async () => 'ok',
    findOne: async (q) => rows.find((d) => match(d, q)) || null,
    find: (q) => ({ toArray: async () => rows.filter((d) => match(d, q)) }),
    insertOne: async (doc) => {
      if (doc.email && rows.some((d) => d.email === doc.email)) { const e = new Error('dup'); e.code = 11000; throw e; }
      const _id = new ObjectId();
      rows.push({ ...doc, _id });
      return { insertedId: _id };
    },
    updateOne: async (q, u) => {
      const d = rows.find((x) => match(x, q));
      if (!d) return { matchedCount: 0 };
      if (u.$set) Object.assign(d, u.$set);
      if (u.$inc) for (const [k, v] of Object.entries(u.$inc)) d[k] = (d[k] || 0) + v;
      return { matchedCount: 1 };
    },
    countDocuments: async (q) => rows.filter((d) => match(d, q)).length,
  };
}
const mongoPath = require.resolve('./src/lib/mongodb.js');
require.cache[mongoPath] = {
  id: mongoPath, filename: mongoPath, loaded: true,
  exports: { getDb: async () => ({ collection: coll }), isMongoConfigured: () => true },
};

const express = require('express');
const { authenticate, enforce } = require('./src/lib/auth');
const { createUser } = require('./src/lib/adminUsers');
const { hashPassword, verifyPassword, passwordProblem } = require('./src/lib/passwords');
const { requiredPermission, ROLE_KEYS, can } = require('./src/lib/permissions');
const authRouter = require('./src/routes/admin/auth');
const usersRouter = require('./src/routes/admin/users');

// A tiny app: the real auth stack + stub handlers on the paths the real routes use.
const app = express();
app.use(express.json());
app.use('/api', authenticate, enforce);
app.use('/api/admin/auth', authRouter);
app.use('/api/admin/users', usersRouter);
const ok = (req, res) => res.json({ ok: true });
for (const [m, p] of [
  ['get', '/api/events'], ['get', '/api/events/RT26'], ['post', '/api/events'], ['get', '/api/events/check-code'], ['put', '/api/events/RT26'],
  ['get', '/api/registrations'], ['delete', '/api/registrations'], ['post', '/api/verify-student'],
  ['get', '/api/admin/colleges'], ['post', '/api/admin/colleges'], ['post', '/api/admin/refund-manual'],
  ['get', '/api/admin/refund-audit'], ['post', '/api/admin/send-confirmations'], ['get', '/api/admin/something-new'],
  ['post', '/api/register'], ['post', '/api/create-order'], ['get', '/api/public/events'],
]) app[m](p, ok);

let server, base;
test.before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const role of ROLE_KEYS) await createUser({ name: role, email: `${role}@t.test`, password: 'Passw0rd-12345', role });
});
test.after(() => server.close());

const call = async (method, url, { token, body } = {}) => {
  const r = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, json };
};
const login = async (role, password = 'Passw0rd-12345') => call('POST', '/api/admin/auth/login', { body: { email: `${role}@t.test`, password } });
const tokenFor = async (role) => (await login(role)).json.token;

test('passwords: hashed, verified, never stored in plain text', async () => {
  const h = await hashPassword('Correct-Horse-9');
  assert.match(h, /^scrypt\$/);
  assert.ok(!h.includes('Correct-Horse-9'));
  assert.equal(await verifyPassword('Correct-Horse-9', h), true);
  assert.equal(await verifyPassword('correct-horse-9', h), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
  assert.ok(passwordProblem('short1'));
  assert.ok(passwordProblem('onlyletterslong'));
  assert.equal(passwordProblem('Abcdefghij1'), null);
});

test('login: right password gives a JWT + role permissions; wrong password is rejected', async () => {
  const good = await login('admin');
  assert.equal(good.status, 200);
  assert.equal(good.json.user.role, 'admin');
  assert.ok(good.json.user.permissions.includes('events:write'));
  assert.ok(!good.json.user.permissions.includes('users:manage'));
  const claims = jwt.decode(good.json.token);
  assert.equal(claims.iss, 'yatra-clubbing');
  assert.equal(claims.aud, 'admin');
  assert.ok(claims.exp > claims.iat);
  assert.equal((await login('admin', 'wrong-password-1')).status, 401);
  assert.equal((await call('POST', '/api/admin/auth/login', { body: { email: 'nobody@t.test', password: 'Passw0rd-12345' } })).status, 401);
});

test('tokens: missing, tampered, expired, wrong-audience and alg=none are all rejected', async () => {
  const t = await tokenFor('admin');
  assert.equal((await call('GET', '/api/events')).status, 401);
  assert.equal((await call('GET', '/api/events', { token: t })).status, 200);
  assert.equal((await call('GET', '/api/events', { token: t.slice(0, -3) + 'abc' })).status, 401);
  const claims = jwt.decode(t);
  const secret = process.env.JWT_SECRET;
  const mk = (extra, opts = {}) => jwt.sign({ role: 'super_admin', ver: 0, ...extra }, secret, { subject: claims.sub, issuer: 'yatra-clubbing', audience: 'admin', ...opts });
  assert.equal((await call('GET', '/api/events', { token: mk({}, { expiresIn: -10 }) })).status, 401);
  assert.equal((await call('GET', '/api/events', { token: jwt.sign({ ver: 0 }, secret, { subject: claims.sub, issuer: 'yatra-clubbing', audience: 'someone-else', expiresIn: '1h' }) })).status, 401);
  const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') + '.' + Buffer.from(JSON.stringify({ sub: claims.sub, iss: 'yatra-clubbing', aud: 'admin', ver: 0, exp: 9999999999 })).toString('base64url') + '.';
  assert.equal((await call('GET', '/api/events', { token: none })).status, 401);
  // the role inside the token is ignored: a viewer cannot promote themselves by forging claims
  const viewerClaims = jwt.decode(await tokenFor('viewer'));
  const forged = jwt.sign({ role: 'super_admin', ver: 0 }, 'a-different-secret-a-different-secret-1', { subject: viewerClaims.sub, issuer: 'yatra-clubbing', audience: 'admin', expiresIn: '1h' });
  assert.equal((await call('GET', '/api/admin/users', { token: forged })).status, 401);
});

test('role matrix: every role against every protected endpoint', async () => {
  // [method, path, super_admin, admin, verifier, viewer, devotee]
  const M = [
    ['GET', '/api/events', 200, 200, 200, 200, 200],
    ['GET', '/api/events/RT26', 200, 200, 200, 200, 403],
    ['POST', '/api/events', 200, 200, 403, 403, 403],
    ['GET', '/api/events/check-code', 200, 200, 403, 403, 403],
    ['PUT', '/api/events/RT26', 200, 200, 403, 403, 403],
    ['GET', '/api/registrations', 200, 200, 200, 200, 200],
    ['DELETE', '/api/registrations', 200, 200, 403, 403, 403],
    ['POST', '/api/verify-student', 200, 200, 200, 403, 403],
    ['GET', '/api/admin/colleges', 200, 200, 200, 200, 403],
    ['POST', '/api/admin/colleges', 200, 200, 403, 403, 403],
    ['POST', '/api/admin/refund-manual', 200, 200, 403, 403, 403],
    ['GET', '/api/admin/refund-audit', 200, 200, 403, 403, 403],
    ['POST', '/api/admin/send-confirmations', 200, 200, 403, 403, 403],
    ['GET', '/api/admin/users', 200, 403, 403, 403, 403],
    ['GET', '/api/admin/something-new', 200, 403, 403, 403, 403], // unlisted admin paths fail closed
    ['GET', '/api/admin/auth/me', 200, 200, 200, 200, 200],
  ];
  const roles = ['super_admin', 'admin', 'verifier', 'viewer', 'devotee'];
  const tokens = Object.fromEntries(await Promise.all(roles.map(async (r) => [r, await tokenFor(r)])));
  for (const [method, url, ...expected] of M) {
    for (let i = 0; i < roles.length; i++) {
      const r = await call(method, url, { token: tokens[roles[i]] });
      assert.equal(r.status, expected[i], `${roles[i]} ${method} ${url} → expected ${expected[i]}, got ${r.status}`);
    }
    if (url !== '/api/admin/auth/me') assert.equal((await call(method, url)).status, 401, `anonymous ${method} ${url}`);
  }
});

test('public booking routes stay open without sign-in', async () => {
  for (const [m, u] of [['POST', '/api/register'], ['POST', '/api/create-order'], ['GET', '/api/public/events']]) {
    assert.equal((await call(m, u)).status, 200, `${m} ${u}`);
  }
  assert.equal(requiredPermission('POST', '/api/webhook/razorpay'), null);
  assert.equal(requiredPermission('GET', '/api/events?x=1/'), 'events:list');
  assert.equal(requiredPermission('GET', '/api/events/RT26'), 'events:read');
});

test('revocation: disabling a user or changing their role bites immediately; password change ends old sessions', async () => {
  const sa = await tokenFor('super_admin');
  const created = await call('POST', '/api/admin/users', { token: sa, body: { name: 'Temp', email: 'temp@t.test', password: 'Passw0rd-12345', role: 'admin' } });
  assert.equal(created.status, 201);
  const id = created.json.user.id;
  assert.ok(!('passwordHash' in created.json.user));
  const tempToken = (await call('POST', '/api/admin/auth/login', { body: { email: 'temp@t.test', password: 'Passw0rd-12345' } })).json.token;
  assert.equal((await call('POST', '/api/events', { token: tempToken })).status, 200);

  await call('PATCH', `/api/admin/users/${id}`, { token: sa, body: { role: 'viewer' } });
  assert.equal((await call('POST', '/api/events', { token: tempToken })).status, 401, 'old token is dead after a role change');
  const viewerToken = (await call('POST', '/api/admin/auth/login', { body: { email: 'temp@t.test', password: 'Passw0rd-12345' } })).json.token;
  assert.equal((await call('POST', '/api/events', { token: viewerToken })).status, 403);

  await call('PATCH', `/api/admin/users/${id}`, { token: sa, body: { active: false } });
  assert.equal((await call('GET', '/api/events', { token: viewerToken })).status, 401, 'disabled user is locked out at once');
  assert.equal((await call('POST', '/api/admin/auth/login', { body: { email: 'temp@t.test', password: 'Passw0rd-12345' } })).status, 403);

  await call('PATCH', `/api/admin/users/${id}`, { token: sa, body: { active: true } });
  const t1 = (await call('POST', '/api/admin/auth/login', { body: { email: 'temp@t.test', password: 'Passw0rd-12345' } })).json.token;
  const changed = await call('POST', '/api/admin/auth/change-password', { token: t1, body: { current: 'Passw0rd-12345', next: 'Brand-New-Pass-77' } });
  assert.equal(changed.status, 200);
  assert.equal((await call('GET', '/api/events', { token: t1 })).status, 401, 'old session ends on password change');
  assert.equal((await call('GET', '/api/events', { token: changed.json.token })).status, 200, 'the fresh token works');
  assert.equal((await call('POST', '/api/admin/auth/change-password', { token: changed.json.token, body: { current: 'wrong', next: 'Another-Pass-88' } })).status, 400);
});

test('user management guards', async () => {
  const sa = await tokenFor('super_admin');
  const list = await call('GET', '/api/admin/users', { token: sa });
  assert.equal(list.status, 200);
  assert.ok(list.json.users.length >= 4);
  assert.ok(list.json.roles.some((r) => r.key === 'verifier'));
  const me = list.json.users.find((u) => u.email === 'super_admin@t.test');

  assert.equal((await call('PATCH', `/api/admin/users/${me.id}`, { token: sa, body: { role: 'admin' } })).status, 400, 'cannot change own role');
  assert.equal((await call('PATCH', `/api/admin/users/${me.id}`, { token: sa, body: { active: false } })).status, 400, 'cannot disable self');
  assert.equal((await call('POST', '/api/admin/users', { token: sa, body: { name: 'X', email: 'admin@t.test', password: 'Passw0rd-12345', role: 'admin' } })).status, 409, 'duplicate email');
  assert.equal((await call('POST', '/api/admin/users', { token: sa, body: { name: 'X', email: 'x@t.test', password: 'weak', role: 'admin' } })).status, 400, 'weak password');
  assert.equal((await call('POST', '/api/admin/users', { token: sa, body: { name: 'X', email: 'x@t.test', password: 'Passw0rd-12345', role: 'god' } })).status, 400, 'unknown role');
  assert.equal((await call('GET', '/api/admin/users', { token: await tokenFor('admin') })).status, 403);

  // a second super admin can demote the first (they are not the last one)
  const second = await call('POST', '/api/admin/users', { token: sa, body: { name: 'Second', email: 'second@t.test', password: 'Passw0rd-12345', role: 'super_admin' } });
  assert.equal(second.status, 201);
  const t2 = (await call('POST', '/api/admin/auth/login', { body: { email: 'second@t.test', password: 'Passw0rd-12345' } })).json.token;
  assert.equal((await call('PATCH', `/api/admin/users/${me.id}`, { token: t2, body: { role: 'admin' } })).status, 200);
  assert.equal((await call('GET', '/api/admin/users', { token: t2 })).status, 200);
  // the demoted one has lost user-management at once
  assert.equal((await call('GET', '/api/admin/users', { token: sa })).status, 401);
});

test('login throttling: repeated failures are locked out', async () => {
  let last;
  for (let i = 0; i < 10; i++) last = await call('POST', '/api/admin/auth/login', { body: { email: 'viewer@t.test', password: 'nope-nope-nope-1' } });
  assert.equal(last.status, 429);
  assert.equal((await login('viewer')).status, 429, 'even the right password waits out the lockout');
});

test('permissions table sanity', () => {
  assert.ok(can('super_admin', 'users:manage'));
  assert.ok(!can('admin', 'users:manage'));
  assert.ok(can('verifier', 'students:verify') && !can('verifier', 'events:write'));
  assert.ok(can('viewer', 'registrations:read') && !can('viewer', 'registrations:write'));
  // revenue figures: super admin + admin only
  for (const r of ['super_admin', 'admin']) assert.ok(can(r, 'dashboard:revenue'), r);
  for (const r of ['verifier', 'viewer', 'devotee']) assert.ok(!can(r, 'dashboard:revenue'), r);
  // devotee: dashboard counts + registrations, strictly read-only
  assert.ok(can('devotee', 'dashboard:read') && can('devotee', 'registrations:read'));
  for (const p of ['registrations:write', 'students:verify', 'events:write', 'events:read', 'colleges:read', 'refunds:manage', 'users:manage']) assert.ok(!can('devotee', p), p);
});
