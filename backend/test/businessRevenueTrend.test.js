// ============================================================
// GET /api/business/overview — the "Revenue · 6 months" trend, a real
// bug found live while auditing this route for the performance pass.
//
// `payments` used to be fetched ONLY from the start of the CURRENT
// calendar month onward, then a "last 6 months" trend loop filtered
// THAT SAME month-scoped array by month. Every month except the
// current one could only ever match zero rows, so the gym owner's
// Business dashboard chart silently showed 0 revenue for the 5 prior
// months regardless of actual payment history -- and fell into the
// "No revenue recorded yet" empty state whenever the CURRENT month
// happened to have no payments yet, even for a gym with real revenue
// in prior months. See admin.js's own comment on the fix.
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
    async tx(fn) {
      db.exec('BEGIN');
      try { const out = await fn(mk()); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
    raw: db
  });
  return mk();
}

async function seedFixtures(db) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym A', 'gym-a', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'GYM_OWNER', ?, 1, ?)`,
    ['owner1', 'o1', 'owner1@a.in', 'x', 'Owner A', '2026-01-01T00:00:00Z']);
  // payments.client_id is NOT NULL -- a real client row to attach test
  // payments to (the route only ever reads org_id/amount/paid_at off
  // them, but the FK requires a real client_id).
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u1', 'o1', 'c1@a.in', 'x', 'Client One', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)', ['c1', 'u1', 'o1', 'FAT_LOSS', '2026-01-01T00:00:00Z']);
}

async function startAdminApi() {
  const db = await memDb();
  await seedFixtures(db);
  const adminRoutes = (await import('../src/routes/admin.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/business', adminRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const token = jwt.sign({ sub: 'owner1', role: 'GYM_OWNER', org: 'o1', name: 'Owner A' }, config.jwtSecret, { expiresIn: '1h' });
  const call = async (method, p) => {
    const res = await fetch(`${base}${p}`, { method, headers: { Authorization: `Bearer ${token}` } });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, close };
}

// A month 3 months before "now" -- YYYY-MM-01, robust across year
// boundaries (same approach as the route's own trendStart calc).
function monthsAgoStart(n) {
  const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}
function monthsAgoKey(n) {
  const d = new Date(); d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 7);
}

test('GET /business/overview: revenue trend includes a payment from 3 months ago, not just this month', async (t) => {
  const { db, call, close } = await startAdminApi();
  t.after(() => close());
  await db.run('INSERT INTO payments (id, org_id, client_id, amount, currency, paid_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['pay1', 'o1', 'c1', 5000, 'INR', monthsAgoStart(3)]);
  const r = await call('GET', '/api/business/overview');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const trend = r.json.revenueTrend;
  assert.ok(Array.isArray(trend) && trend.length === 6, 'trend must cover 6 months');
  const monthRow = trend.find((t) => t.month === monthsAgoKey(3));
  assert.ok(monthRow, 'the 3-months-ago month must be present in the trend');
  assert.equal(monthRow.total, 5000, 'a real payment from 3 months ago must show up in its own month, not silently drop to 0');
});

test('GET /business/overview: monthlyRevenue only counts THIS month, even though the trend query now spans 6 months', async (t) => {
  const { db, call, close } = await startAdminApi();
  t.after(() => close());
  const today = new Date().toISOString().slice(0, 10);
  await db.run('INSERT INTO payments (id, org_id, client_id, amount, currency, paid_at) VALUES (?, ?, ?, ?, ?, ?)', ['pay_this', 'o1', 'c1', 1200, 'INR', today]);
  await db.run('INSERT INTO payments (id, org_id, client_id, amount, currency, paid_at) VALUES (?, ?, ?, ?, ?, ?)', ['pay_old', 'o1', 'c1', 9000, 'INR', monthsAgoStart(4)]);
  const r = await call('GET', '/api/business/overview');
  assert.equal(r.status, 200);
  assert.equal(r.json.monthlyRevenue, 1200, 'monthlyRevenue must stay scoped to the current month, not the whole widened trend window');
});

test('GET /business/overview: a gym with zero payments this month but real history is not shown as "no revenue"', async (t) => {
  const { db, call, close } = await startAdminApi();
  t.after(() => close());
  await db.run('INSERT INTO payments (id, org_id, client_id, amount, currency, paid_at) VALUES (?, ?, ?, ?, ?, ?)', ['pay_old2', 'o1', 'c1', 3000, 'INR', monthsAgoStart(2)]);
  const r = await call('GET', '/api/business/overview');
  assert.equal(r.status, 200);
  assert.equal(r.json.monthlyRevenue, 0, 'no payment THIS month, so monthlyRevenue is correctly 0');
  const anyRevenueInTrend = r.json.revenueTrend.some((t) => t.total > 0);
  assert.ok(anyRevenueInTrend, 'the trend itself must still show the real revenue from 2 months ago -- this is exactly what the old bug hid');
});
