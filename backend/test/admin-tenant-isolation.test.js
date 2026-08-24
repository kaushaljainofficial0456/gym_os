// ============================================================
// Tenant isolation for backend/src/routes/admin.js's client_id-in-body
// write routes (subscriptions, payments, attendance).
//
// Unlike every other client-scoped write route in this codebase (which
// resolves the client from a URL :id param through resolveClient), these
// three take client_id from the JSON body. Before this fix, that value
// was used directly in INSERTs with no check that it belonged to the
// authenticated org -- an owner in one org could attach a subscription/
// payment/attendance row to a client id from a DIFFERENT org. See
// requireOrgClient in admin.js.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import express from 'express';
import { config } from '../src/config.js';

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
    exec(sql) { db.exec(sql); },
    // admin.js's subscription-creation route wraps its writes in db.tx() --
    // same BEGIN/COMMIT/ROLLBACK shape as every other memDb() in this test
    // suite that exercises a tx()-using route (see nutrition-api.test.js).
    async tx(fn) {
      db.exec('BEGIN');
      try { const out = await fn(mk()); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
    raw: db
  });
  return mk();
}

// Two orgs, one owner each, one client each -- the minimum shape needed to
// prove org A's owner cannot attach records to org B's client.
async function seedTwoOrgs(db) {
  for (const [oid, slug] of [['o1', 'gym-a'], ['o2', 'gym-b']]) {
    await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [oid, 'Org ' + oid, slug, '2026-01-01T00:00:00Z']);
  }
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'GYM_OWNER', ?, 1, ?)`,
    ['owner1', 'o1', 'owner1@a.in', 'x', 'Owner A', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u1', 'o1', 'c1@a.in', 'x', 'Client A', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)', ['c1', 'u1', 'o1', 'FAT_LOSS', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u2', 'o2', 'c2@b.in', 'x', 'Client B', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)', ['c2', 'u2', 'o2', 'FAT_LOSS', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO packages (id, org_id, name, amount, currency, period_days) VALUES (?, ?, ?, ?, ?, ?)',
    ['pkg1', 'o1', 'Monthly', 2000, 'INR', 30]);
}

async function startAdminApi() {
  const db = await memDb();
  await seedTwoOrgs(db);
  const adminRoutes = (await import('../src/routes/admin.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/business', adminRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const token = jwt.sign({ sub: 'owner1', role: 'GYM_OWNER', org: 'o1', name: 'Owner A' }, config.jwtSecret, { expiresIn: '1h' });
  const call = async (method, p, body) => {
    const res = await fetch(`${base}${p}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, close };
}

test('POST /business/subscriptions rejects a client_id from another org', async (t) => {
  const { db, call, close } = await startAdminApi();
  t.after(() => close());
  const r = await call('POST', '/api/business/subscriptions', { client_id: 'c2', package_id: 'pkg1' });
  assert.equal(r.status, 404, 'cross-org client_id must be rejected, not silently accepted');
  const rows = await db.q('SELECT * FROM subscriptions WHERE client_id = ?', ['c2']);
  assert.equal(rows.length, 0, 'no subscription must be attached to another org\'s client');
});

test('POST /business/subscriptions succeeds for a same-org client_id (regression check)', async (t) => {
  const { db, call, close } = await startAdminApi();
  t.after(() => close());
  const r = await call('POST', '/api/business/subscriptions', { client_id: 'c1', package_id: 'pkg1' });
  assert.equal(r.status, 201, 'legitimate same-org subscription must still work');
  const rows = await db.q('SELECT * FROM subscriptions WHERE client_id = ?', ['c1']);
  assert.equal(rows.length, 1);
});

test('POST /business/payments rejects a client_id from another org', async (t) => {
  const { db, call, close } = await startAdminApi();
  t.after(() => close());
  const r = await call('POST', '/api/business/payments', { client_id: 'c2', amount: 500 });
  assert.equal(r.status, 404);
  const rows = await db.q('SELECT * FROM payments WHERE client_id = ?', ['c2']);
  assert.equal(rows.length, 0, 'no payment must be attached to another org\'s client');
});

test('POST /business/payments succeeds for a same-org client_id (regression check)', async (t) => {
  const { call, close } = await startAdminApi();
  t.after(() => close());
  const r = await call('POST', '/api/business/payments', { client_id: 'c1', amount: 500 });
  assert.equal(r.status, 201);
});

test('POST /business/attendance rejects a client_id from another org', async (t) => {
  const { db, call, close } = await startAdminApi();
  t.after(() => close());
  const r = await call('POST', '/api/business/attendance', { client_id: 'c2', present: true });
  assert.equal(r.status, 404);
  const rows = await db.q('SELECT * FROM attendance WHERE client_id = ?', ['c2']);
  assert.equal(rows.length, 0, 'no attendance row must be attached to another org\'s client');
});

test('POST /business/attendance succeeds for a same-org client_id (regression check)', async (t) => {
  const { call, close } = await startAdminApi();
  t.after(() => close());
  const r = await call('POST', '/api/business/attendance', { client_id: 'c1', present: true });
  assert.equal(r.status, 201);
});
