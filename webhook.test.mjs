import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const SECRET = 'test_webhook_secret_123';
const PORT = 4310;
const BASE = `http://127.0.0.1:${PORT}`;

const mongo = await MongoMemoryServer.create();
const uri = mongo.getUri();
const client = await MongoClient.connect(uri);
const db = client.db('yatra');

const server = spawn(process.execPath, ['src/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env,
    PORT: String(PORT), MONGODB_URI: uri, MONGODB_DB: 'yatra',
    RAZORPAY_WEBHOOK_SECRET: SECRET, ADMIN_TOKEN: 'x', FRONTEND_URL: 'http://localhost:3000',
    NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', d => { log += d; });
server.stderr.on('data', d => { log += d; });

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not start:\n' + log);
}
await waitUp();

function post(bodyObj, { secret = SECRET, deliveryId, tamper = false } = {}) {
  const body = JSON.stringify(bodyObj);
  const signed = tamper ? body.replace('"amount":9900', '"amount":100') : body;
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const headers = { 'Content-Type': 'application/json', 'x-razorpay-signature': sig };
  if (deliveryId) headers['x-razorpay-event-id'] = deliveryId;
  return fetch(`${BASE}/api/webhook/razorpay`, { method: 'POST', headers, body: signed });
}

const paid = (orderId, paymentId, receipt) => ({
  event: 'payment.captured',
  payload: {
    payment: { entity: { id: paymentId, order_id: orderId, amount: 9900, status: 'captured' } },
    order: { entity: { id: orderId, receipt, amount: 9900 } },
  },
});

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}

const regs = db.collection('registrations');
const audits = db.collection('webhook_events');

console.log('\n1) signature verification');
{
  const r = await post(paid('order_A', 'pay_A', 'YJ-AAA111'), { secret: 'wrong-secret' });
  check('wrong secret -> 400', r.status === 400, r.status);
  const r2 = await post(paid('order_A', 'pay_A', 'YJ-AAA111'), { tamper: true });
  check('tampered body -> 400', r2.status === 400, r2.status);
  const r3 = await fetch(`${BASE}/api/webhook/razorpay`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(paid('order_A', 'pay_A', 'YJ-AAA111')),
  });
  check('missing signature -> 400', r3.status === 400, r3.status);
}

console.log('\n2) reconciles a pending booking by order_id');
{
  await regs.insertOne({ ref: 'YJ-BBB222', order_id: 'order_B', payment_status: 'pending',
    name: 'Test Devotee', phone: '9999999999', total: 99, event_code: 'YJ', qty_general: 1 });
  const r = await post(paid('order_B', 'pay_B', 'YJ-BBB222'), { deliveryId: 'evt_B' });
  const j = await r.json();
  const row = await regs.findOne({ ref: 'YJ-BBB222' });
  check('200 ok', r.status === 200, r.status);
  check('reconciled:true', j.reconciled === true, JSON.stringify(j));
  check('payment_status -> paid', row.payment_status === 'paid', row.payment_status);
  check('payment_id stored', row.payment_id === 'pay_B', row.payment_id);
}

console.log('\n3) the case the fix is for: order_id missing, matched by receipt');
{
  await regs.insertOne({ ref: 'YJ-CCC333', payment_status: 'pending',
    name: 'No Order Id', phone: '9888888888', total: 99, event_code: 'YJ', qty_general: 1 });
  const r = await post(paid('order_C', 'pay_C', 'YJ-CCC333'), { deliveryId: 'evt_C' });
  const j = await r.json();
  const row = await regs.findOne({ ref: 'YJ-CCC333' });
  check('reconciled via receipt', j.reconciled === true, JSON.stringify(j));
  check('order_id backfilled', row.order_id === 'order_C', row.order_id);
  check('paid', row.payment_status === 'paid', row.payment_status);
}

console.log('\n4) idempotency');
{
  const before = await regs.findOne({ ref: 'YJ-BBB222' });
  const r1 = await post(paid('order_B', 'pay_B', 'YJ-BBB222'), { deliveryId: 'evt_B' });
  const j1 = await r1.json();
  check('same delivery id -> duplicate, no work', j1.duplicate === true, JSON.stringify(j1));

  // order.paid also fires for the same payment, with a different delivery id
  const orderPaid = { ...paid('order_B', 'pay_B', 'YJ-BBB222'), event: 'order.paid' };
  const r2 = await post(orderPaid, { deliveryId: 'evt_B2' });
  const j2 = await r2.json();
  check('order.paid after capture -> not re-reconciled', j2.reconciled === false, JSON.stringify(j2));
  const after = await regs.findOne({ ref: 'YJ-BBB222' });
  check('row unchanged', String(after.updated_at) === String(before.updated_at), 'updated_at moved');
}

console.log('\n5) payment.failed marks a pending booking failed, never a paid one');
{
  await regs.insertOne({ ref: 'YJ-DDD444', order_id: 'order_D', payment_status: 'pending',
    name: 'Will Fail', phone: '9777777777', total: 99, event_code: 'YJ' });
  const failEvt = { event: 'payment.failed', payload: {
    payment: { entity: { id: 'pay_D', order_id: 'order_D', amount: 9900, status: 'failed' } },
    order: { entity: { id: 'order_D', receipt: 'YJ-DDD444' } } } };
  const r = await post(failEvt, { deliveryId: 'evt_D' });
  const row = await regs.findOne({ ref: 'YJ-DDD444' });
  check('pending -> failed', row.payment_status === 'failed', row.payment_status);

  // a failed event must not undo an already-paid booking
  const failPaid = { event: 'payment.failed', payload: {
    payment: { entity: { id: 'pay_B', order_id: 'order_B' } },
    order: { entity: { id: 'order_B', receipt: 'YJ-BBB222' } } } };
  await post(failPaid, { deliveryId: 'evt_B3' });
  const stillPaid = await regs.findOne({ ref: 'YJ-BBB222' });
  check('paid booking stays paid', stillPaid.payment_status === 'paid', stillPaid.payment_status);
}

console.log('\n6) unknown event acknowledged (so Razorpay stops retrying)');
{
  const r = await post({ event: 'refund.processed', payload: {} }, { deliveryId: 'evt_E' });
  const j = await r.json();
  check('200 + ignored', r.status === 200 && j.ignored === 'refund.processed', JSON.stringify(j));
}

console.log('\n7) paid with no matching booking is recorded for a human');
{
  const r = await post(paid('order_X', 'pay_X', 'YJ-NOPE'), { deliveryId: 'evt_X' });
  const j = await r.json();
  check('reconciled:false', j.reconciled === false, JSON.stringify(j));
  const a = await audits.findOne({ delivery_id: 'evt_X' });
  check('audit row written', !!a && a.reason === 'no matching booking', JSON.stringify(a));
}

console.log('\n8) audit trail exists for every handled delivery');
{
  const n = await audits.countDocuments({});
  check('audit rows >= 5', n >= 5, 'count=' + n);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
if (fail) console.log('\n--- server log ---\n' + log);
server.kill(); await client.close(); await mongo.stop();
process.exit(fail ? 1 : 0);
