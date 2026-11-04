// ============================================================
// RECEIPTS FOR EVERY PAYMENT.
//
// A payment taken at the desk had no receipt and did not appear in the
// member's own payment history; only online payments were invoiced, and
// only an owner could download those, from Enterprise billing. Now every
// payment has a receipt the member who paid and that gym's owner can
// download, and nobody else can.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const ts = '2026-01-01T00:00:00Z';

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(schema);
  // Added by scripts/init-db.js rather than schema.sql, as other suites do.
  raw.exec('ALTER TABLE subscriptions ADD COLUMN lifecycle_status TEXT');
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, p = []) { const st = raw.prepare(sql); return p.length ? st.all(...p) : st.all(); },
    async q1(sql, p = []) { const rows = await mk().q(sql, p); return rows[0] || null; },
    async run(sql, p = []) { const st = raw.prepare(sql); const r = p.length ? st.run(...p) : st.run(); return { changes: Number(r.changes) }; },
    async tx(fn) { return fn(mk()); },
    raw,
  });
  return mk();
}

async function startApi() {
  const express = (await import('express')).default;
  const jwt = (await import('jsonwebtoken')).default;
  const { config } = await import('../src/config.js');
  const adminRoutes = (await import('../src/routes/admin.js')).default;
  const enrollmentRoutes = (await import('../src/routes/enrollment.js')).default;
  const receiptRoutes = (await import('../src/routes/receipts.js')).default;
  const { resetRateLimits } = await import('../src/rateLimit.js');
  resetRateLimits();

  const db = await memDb();
  for (const o of ['o1', 'o2']) await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', [o, `Gym ${o}`, o, ts]);
  for (const [u, c, o] of [['u1', 'c1', 'o1'], ['u2', 'c2', 'o1']]) {
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                  VALUES (?,?,?,'x','CLIENT',?,1,?)`, [u, o, `${u}@x.in`, `Member ${u}`, ts]);
    await db.run('INSERT INTO clients (id, user_id, org_id, created_at) VALUES (?,?,?,?)', [c, u, o, ts]);
  }
  for (const [u, o] of [['own1', 'o1'], ['own2', 'o2']]) {
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                  VALUES (?,?,?,'x','GYM_OWNER','Owner',1,?)`, [u, o, `${u}@x.in`, ts]);
  }

  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes(db));
  app.use('/api/enrollment', enrollmentRoutes(db));
  app.use('/api/receipts', receiptRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const tokenFor = (sub, role, org) => jwt.sign({ sub, role, org, name: 'X', email: `${sub}@x.in` }, config.jwtSecret);
  const call = async (method, url, sub, role, org, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(sub, role, org)}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buf.toString('utf8')); } catch { /* a PDF */ }
    return { status: res.status, headers: res.headers, buf, json };
  };
  const owner = (method, url, body) => call(method, url, 'own1', 'GYM_OWNER', 'o1', body);
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, owner, close };
}

test('a payment recorded at the desk gets a receipt, dated the day it was paid', async (t) => {
  const { db, owner, close } = await startApi();
  t.after(() => close());
  const res = await owner('POST', '/api/admin/payments', { client_id: 'c1', amount: 1999, method: 'upi', paid_on: '2026-02-03', reference: 'UTR 4521 9988' });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.match(res.json.receipt.number, /^SKOS-/);

  const payment = await db.q1('SELECT * FROM payments WHERE id = ?', [res.json.paymentId]);
  assert.equal(payment.paid_at.slice(0, 10), '2026-02-03');
  const order = await db.q1('SELECT * FROM payment_orders WHERE id = ?', [payment.external_ref]);
  assert.equal(order.provider, 'manual');
  assert.equal(order.provider_order_id, 'UTR 4521 9988');
  const invoice = await db.q1('SELECT * FROM invoices WHERE order_id = ?', [order.id]);
  assert.equal(invoice.issued_at.slice(0, 10), '2026-02-03');
});

test('a payment cannot be dated in the future', async (t) => {
  const { owner, close } = await startApi();
  t.after(() => close());
  const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const res = await owner('POST', '/api/admin/payments', { client_id: 'c1', amount: 500, paid_on: tomorrow });
  assert.equal(res.status, 422);
});

test('the member sees a desk payment in their own history, and can download its receipt', async (t) => {
  const { call, owner, close } = await startApi();
  t.after(() => close());
  const rec = await owner('POST', '/api/admin/payments', { client_id: 'c1', amount: 1500, method: 'cash' });
  const list = await call('GET', '/api/enrollment/client/payments', 'u1', 'CLIENT', 'o1');
  assert.equal(list.status, 200);
  const row = list.json.payments.find((p) => p.paymentId === rec.json.paymentId);
  assert.ok(row, 'the desk payment is in the member\'s list');
  assert.equal(row.status, 'SUCCESS');
  assert.equal(row.invoice.number, rec.json.receipt.number);

  const pdf = await call('GET', `/api/receipts/payments/${rec.json.paymentId}/pdf`, 'u1', 'CLIENT', 'o1');
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(pdf.buf.subarray(0, 4).toString(), '%PDF');
  assert.match(pdf.headers.get('content-disposition'), new RegExp(`${rec.json.receipt.number}\\.pdf`));
});

test('the gym owner can download it too; another member and another gym cannot', async (t) => {
  const { call, owner, close } = await startApi();
  t.after(() => close());
  const rec = await owner('POST', '/api/admin/payments', { client_id: 'c1', amount: 1500, method: 'cash' });
  const url = `/api/receipts/payments/${rec.json.paymentId}/pdf`;
  assert.equal((await owner('GET', url)).status, 200);
  assert.equal((await call('GET', url, 'u2', 'CLIENT', 'o1')).status, 404, 'another member of the same gym');
  assert.equal((await call('GET', url, 'own2', 'GYM_OWNER', 'o2')).status, 404, 'the owner of another gym');
  assert.equal((await call('GET', url, 'tr1', 'TRAINER', 'o1')).status, 404, 'a trainer: money is the owner\'s');
});

test('a payment recorded before receipts existed gets one on first download, and only one', async (t) => {
  const { db, call, close } = await startApi();
  t.after(() => close());
  await db.run(`INSERT INTO payments (id, org_id, client_id, amount, currency, method, status, paid_at)
                VALUES ('pay_old', 'o1', 'c1', 999, 'INR', 'cash', 'paid', '2026-01-10T10:00:00Z')`);
  const first = await call('GET', '/api/receipts/payments/pay_old/pdf', 'u1', 'CLIENT', 'o1');
  assert.equal(first.status, 200);
  const second = await call('GET', '/api/receipts/payments/pay_old/pdf', 'u1', 'CLIENT', 'o1');
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('content-disposition'), first.headers.get('content-disposition'), 'the same receipt both times');
  const invoices = await db.q("SELECT * FROM invoices WHERE org_id = 'o1'");
  assert.equal(invoices.length, 1);
  assert.equal(invoices[0].issued_at.slice(0, 10), '2026-01-10');
});

test('a new membership sold at the desk is receipted too', async (t) => {
  const { db, owner, close } = await startApi();
  t.after(() => close());
  await db.run(`INSERT INTO packages (id, org_id, name, amount, currency, period_days) VALUES ('pk1', 'o1', 'Monthly', 1999, 'INR', 30)`);
  const res = await owner('POST', '/api/admin/subscriptions', { client_id: 'c1', package_id: 'pk1' });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const payment = await db.q1('SELECT * FROM payments WHERE id = ?', [res.json.paymentId]);
  const invoice = await db.q1('SELECT * FROM invoices WHERE order_id = ?', [payment.external_ref]);
  assert.ok(invoice, 'receipt issued with the membership');
});

test('paying at the desk for a membership marked due clears it; a part payment does not', async (t) => {
  const { db, owner, close } = await startApi();
  t.after(() => close());
  await db.run(`INSERT INTO subscriptions (id, org_id, client_id, plan_name, amount, currency, start_date, end_date, status, payment_status)
                VALUES ('sub_due', 'o1', 'c1', 'Monthly', 1999, 'INR', '2026-11-01', '2026-12-01', 'active', 'pending')`);
  const part = await owner('POST', '/api/admin/payments', { client_id: 'c1', amount: 999, method: 'cash' });
  assert.equal(part.status, 201);
  assert.equal((await db.q1("SELECT payment_status FROM subscriptions WHERE id = 'sub_due'")).payment_status, 'pending', 'still due after a part payment');
  const rest = await owner('POST', '/api/admin/payments', { client_id: 'c1', amount: 1999, method: 'upi' });
  assert.equal(rest.status, 201);
  assert.equal((await db.q1("SELECT payment_status FROM subscriptions WHERE id = 'sub_due'")).payment_status, 'paid');
  const booked = await db.q('SELECT subscription_id FROM payments WHERE client_id = ?', ['c1']);
  assert.ok(booked.every((p) => p.subscription_id === 'sub_due'), 'both booked against the membership');
});
