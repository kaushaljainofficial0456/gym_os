// ============================================================
// PAYMENTS DEV BRIDGE — the one browser-callable mock-checkout route
// (POST /api/payments/mock/complete). Verifies it requires real auth,
// and that the { paymentId, signature } it hands back is exactly what
// the real verify path accepts -- i.e. it's a faithful stand-in for a
// gateway's checkout widget, not a shortcut that skips verification.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { resetRateLimits } from '../src/rateLimit.js';
import { createProviderOrder, providerName, verifyCheckoutSignature, _resetMockProviderStateForTests } from '../src/services/payments/paymentProvider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await mk().q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
    async tx(fn) {
      db.exec('BEGIN');
      try { const out = await fn(mk()); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
    raw: db,
  });
  return mk();
}

async function startApp(db) {
  const authRoutes = (await import('../src/routes/auth.js')).default;
  const paymentsDevRoutes = (await import('../src/routes/paymentsDev.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes(db));
  app.use('/api/payments', paymentsDevRoutes());
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, body, token) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  return { call, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

test.beforeEach(() => { resetRateLimits(); _resetMockProviderStateForTests(); });

test('POST /api/payments/mock/complete requires auth', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const res = await api.call('POST', '/api/payments/mock/complete', { providerOrderId: 'anything' });
  assert.equal(res.status, 401);
});

test('POST /api/payments/mock/complete: hands back a signature the real verify path actually accepts', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const signup = await api.call('POST', '/api/auth/setup-org', { orgName: 'Bridge Gym', ownerName: 'Owner', email: 'bridge@test.in', password: 'ownerpass1' });
  assert.equal(signup.status, 201);
  const token = signup.json.token;

  assert.equal(providerName(), 'mock');
  const order = await createProviderOrder({ amount: 1500, currency: 'INR', receipt: 'test-receipt', notes: {} });
  const res = await api.call('POST', '/api/payments/mock/complete', { providerOrderId: order.providerOrderId }, token);
  assert.equal(res.status, 200);
  assert.ok(res.json.paymentId);
  assert.ok(res.json.signature);
  assert.equal(verifyCheckoutSignature({ providerOrderId: order.providerOrderId, providerPaymentId: res.json.paymentId, signature: res.json.signature }), true);
});

test('POST /api/payments/mock/complete: an unknown providerOrderId is a clean 404, never a 500', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const signup = await api.call('POST', '/api/auth/setup-org', { orgName: 'Bridge Gym 2', ownerName: 'Owner', email: 'bridge2@test.in', password: 'ownerpass1' });
  const res = await api.call('POST', '/api/payments/mock/complete', { providerOrderId: 'order_does_not_exist' }, signup.json.token);
  assert.equal(res.status, 404);
});

test('GET /api/payments/provider reports the active provider (for the frontend to pick a checkout UI)', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const signup = await api.call('POST', '/api/auth/setup-org', { orgName: 'Bridge Gym 3', ownerName: 'Owner', email: 'bridge3@test.in', password: 'ownerpass1' });
  const res = await api.call('GET', '/api/payments/provider', undefined, signup.json.token);
  assert.equal(res.status, 200);
  assert.equal(res.json.provider, 'mock');
});
