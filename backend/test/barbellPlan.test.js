// ============================================================
// THE BARBELL PLAN for independent clients: 14 days of everything, then
// ₹59 a month or ₹590 a year. Mock payment provider; in-memory SQLite.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

async function startApi() {
  const express = (await import('express')).default;
  const jwt = (await import('jsonwebtoken')).default;
  const { config } = await import('../src/config.js');
  const planRoutes = (await import('../src/routes/plan.js')).default;
  const { planGate } = await import('../src/routes/plan.js');
  const { resetRateLimits } = await import('../src/rateLimit.js');
  const { mockSimulateCheckout } = await import('../src/services/payments/paymentProvider.js');
  resetRateLimits();
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(':memory:');
  raw.exec(schema);
  raw.exec('ALTER TABLE users ADD COLUMN plan_trial_from TEXT'); // scripts/init-db.js adds it
  const db = {
    async q(sql, p = []) { return raw.prepare(sql).all(...p); },
    async q1(sql, p = []) { return raw.prepare(sql).all(...p)[0] || null; },
    async run(sql, p = []) { const r = raw.prepare(sql).run(...p); return { changes: Number(r.changes) }; },
  };
  raw.exec(`INSERT INTO organizations (id, name, slug, type, created_at) VALUES ('org_ind', 'Independent', 'independent', 'independent', '2026-01-01')`);
  raw.exec(`INSERT INTO organizations (id, name, slug, created_at) VALUES ('org_gym', 'Iron Gym', 'iron', '2026-01-01')`);
  const addUser = (id, org, createdAt) => {
    raw.prepare(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?,?,?,'x','CLIENT',?,1,?)`)
      .run(id, org, `${id}@x.in`, `User ${id}`, createdAt);
    raw.prepare('INSERT INTO clients (id, user_id, org_id, created_at) VALUES (?,?,?,?)').run(`c_${id}`, id, org, createdAt);
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.cookies = {}; next(); });
  app.use(planGate(db));
  app.use('/api/plan', planRoutes(db));
  app.get('/api/me/home', (_req, res) => res.json({ ok: true }));
  app.get('/api/me/export', (_req, res) => res.json({ ok: true }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, url, sub, org, body) => {
    const token = jwt.sign({ sub, role: 'CLIENT', org, name: 'U', email: 'u@x.in' }, config.jwtSecret);
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null; try { json = JSON.parse(buf.toString()); } catch { /* pdf */ }
    return { status: res.status, json, buf, headers: res.headers };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { raw, addUser, call, close, mockSimulateCheckout };
}

test('a new independent client is on a 14-day trial with full access', async (t) => {
  const api = await startApi(); t.after(() => api.close());
  api.addUser('u_new', 'org_ind', new Date().toISOString());
  const s = await api.call('GET', '/api/plan/status', 'u_new', 'org_ind');
  assert.equal(s.json.applies, true);
  assert.equal(s.json.access, 'trial');
  assert.equal(s.json.trialDaysLeft, 14);
  assert.deepEqual(s.json.plans.map((p) => [p.id, p.amount, p.line]), [
    ['monthly', 59, 'Billed every month'], ['yearly', 590, 'Pay for 10 months, get 2 free'],
  ]);
  assert.equal((await api.call('GET', '/api/me/home', 'u_new', 'org_ind')).status, 200);
});

test('after the trial the app is held at the plans screen, but paying and leaving stay open', async (t) => {
  const api = await startApi(); t.after(() => api.close());
  api.addUser('u_old', 'org_ind', ago(40));
  api.raw.exec(`UPDATE users SET plan_trial_from = '${ago(40)}' WHERE id = 'u_old'`);
  const s = await api.call('GET', '/api/plan/status', 'u_old', 'org_ind');
  assert.equal(s.json.access, 'locked');
  const held = await api.call('GET', '/api/me/home', 'u_old', 'org_ind');
  assert.equal(held.status, 402);
  assert.equal(held.json.error, 'plan_required');
  assert.equal((await api.call('GET', '/api/me/export', 'u_old', 'org_ind')).status, 200, 'their data is always theirs to take');
  assert.equal((await api.call('GET', '/api/plan/status', 'u_old', 'org_ind')).status, 200);
});

test('buying a year unlocks everything for 365 days, with a receipt', async (t) => {
  const api = await startApi(); t.after(() => api.close());
  api.addUser('u_buy', 'org_ind', new Date().toISOString());
  const order = await api.call('POST', '/api/plan/order', 'u_buy', 'org_ind', { plan: 'yearly' });
  assert.equal(order.status, 200, JSON.stringify(order.json));
  assert.equal(order.json.order.amount, 590);
  const { paymentId, signature } = api.mockSimulateCheckout(order.json.order.provider_order_id);
  const paid = await api.call('POST', '/api/plan/verify', 'u_buy', 'org_ind', { orderId: order.json.order.id, providerPaymentId: paymentId, signature });
  assert.equal(paid.status, 200, JSON.stringify(paid.json));
  assert.equal(paid.json.status.access, 'active');
  const days = (Date.parse(paid.json.order.period_end) - Date.parse(paid.json.order.period_start)) / DAY;
  assert.equal(Math.round(days), 365);
  assert.match(paid.json.order.invoice_number, /^BBL-/);

  const again = await api.call('POST', '/api/plan/verify', 'u_buy', 'org_ind', { orderId: order.json.order.id, providerPaymentId: paymentId, signature });
  assert.equal(again.json.order.period_end, paid.json.order.period_end, 'confirming twice does not add a second year');

  const pdf = await api.call('GET', `/api/plan/receipts/${order.json.order.id}/pdf`, 'u_buy', 'org_ind');
  assert.equal(pdf.status, 200);
  assert.equal(pdf.buf.subarray(0, 4).toString(), '%PDF');
  assert.equal((await api.call('GET', `/api/plan/receipts/${order.json.order.id}/pdf`, 'u_other', 'org_ind')).status, 404, 'nobody else\'s');
});

test('paying early adds to the time already paid for, never losing days', async (t) => {
  const api = await startApi(); t.after(() => api.close());
  api.addUser('u_early', 'org_ind', new Date().toISOString());
  const buy = async () => {
    const o = await api.call('POST', '/api/plan/order', 'u_early', 'org_ind', { plan: 'monthly' });
    const { paymentId, signature } = api.mockSimulateCheckout(o.json.order.provider_order_id);
    return (await api.call('POST', '/api/plan/verify', 'u_early', 'org_ind', { orderId: o.json.order.id, providerPaymentId: paymentId, signature })).json.order;
  };
  const first = await buy();
  const second = await buy();
  assert.equal(second.period_start, first.period_end);
});

test('a forged payment is refused and grants nothing', async (t) => {
  const api = await startApi(); t.after(() => api.close());
  api.addUser('u_forge', 'org_ind', new Date().toISOString());
  const o = await api.call('POST', '/api/plan/order', 'u_forge', 'org_ind', { plan: 'monthly' });
  const bad = await api.call('POST', '/api/plan/verify', 'u_forge', 'org_ind', { orderId: o.json.order.id, providerPaymentId: 'pay_x', signature: 'ab'.repeat(32) });
  assert.equal(bad.status, 422);
  assert.equal((await api.call('GET', '/api/plan/status', 'u_forge', 'org_ind')).json.access, 'trial');
});

test('someone who used Barbell before the plan existed gets 14 days from the first check, not a locked door', async (t) => {
  const api = await startApi(); t.after(() => api.close());
  api.addUser('u_long', 'org_ind', '2020-01-01T00:00:00Z');
  const s = await api.call('GET', '/api/plan/status', 'u_long', 'org_ind');
  assert.equal(s.json.access, 'trial');
  assert.equal(s.json.trialDaysLeft, 14);
  const again = await api.call('GET', '/api/plan/status', 'u_long', 'org_ind');
  assert.equal(again.json.trialEndsAt, s.json.trialEndsAt, 'the start is recorded once, not reset on every visit');
});

test('gym members never see the plan and are never held', async (t) => {
  const api = await startApi(); t.after(() => api.close());
  api.addUser('u_gym', 'org_gym', '2020-01-01T00:00:00Z');
  assert.equal((await api.call('GET', '/api/plan/status', 'u_gym', 'org_gym')).json.applies, false);
  assert.equal((await api.call('GET', '/api/me/home', 'u_gym', 'org_gym')).status, 200);
  assert.equal((await api.call('POST', '/api/plan/order', 'u_gym', 'org_gym', { plan: 'monthly' })).status, 409);
});

test('a trainer\'s own org of type independent is not the solo plan: its clients pay the trainer', async (t) => {
  const api = await startApi(); t.after(() => api.close());
  api.raw.exec(`INSERT INTO organizations (id, name, slug, type, created_at) VALUES ('org_solo_pt', 'Asha PT', 'asha-pt', 'independent', '2026-01-01')`);
  api.addUser('u_pt_client', 'org_solo_pt', '2020-01-01T00:00:00Z');
  assert.equal((await api.call('GET', '/api/plan/status', 'u_pt_client', 'org_solo_pt')).json.applies, false);
  assert.equal((await api.call('GET', '/api/me/home', 'u_pt_client', 'org_solo_pt')).status, 200);
});

test('someone who leaves a gym gets their own 14 days from leaving', async (t) => {
  const api = await startApi(); t.after(() => api.close());
  api.addUser('u_left', 'org_ind', '2020-01-01T00:00:00Z');
  api.raw.exec(`UPDATE users SET plan_trial_from = '2020-01-01T00:00:00Z' WHERE id = 'u_left'`);
  api.raw.exec(`INSERT INTO client_gym_periods (id, client_id, org_id, joined_at, left_at, created_at) VALUES ('g1', 'c_u_left', 'org_gym', '2020-01-01', '${ago(2)}', '2020-01-01')`);
  const s = await api.call('GET', '/api/plan/status', 'u_left', 'org_ind');
  assert.equal(s.json.access, 'trial');
  assert.ok(s.json.trialDaysLeft >= 12 && s.json.trialDaysLeft <= 14, String(s.json.trialDaysLeft));
});
