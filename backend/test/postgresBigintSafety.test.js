// ============================================================
// POSTGRES BIGINT SAFETY — regression test for a real bug found live
// against the deployed Postgres backend (never caught by the rest of
// this suite, which runs entirely on SQLite):
//
//   Postgres reports SUM()/COUNT() as `bigint`, and the `pg` driver
//   deliberately returns bigint values as STRINGS, not numbers, to
//   avoid silently losing precision past 2^53. SQLite's driver returns
//   real numbers for the identical query. getOrgBillingSnapshot() did
//   `(subscription.client_capacity || 0) + (addonRows[0]?.total || 0)`
//   -- on Postgres that's `75 + "0"`, which is JS STRING
//   CONCATENATION, not addition: "750", not 75. A fresh 75-capacity
//   purchase showed as "PURCHASED CAPACITY 750" on the live site and,
//   combined with a separate frontend loading-state bug (see
//   EnterpriseQR.jsx), made client QR generation look broken.
//
// This file can't spin up a real Postgres instance, so it proves the
// FIX (Number(...) around every DB-returned aggregate) the direct way:
// a minimal fake `db` that behaves exactly like the real `pg` driver
// for COUNT/SUM columns (returns their string form) and like normal
// for everything else, wrapping a real in-memory SQLite database for
// the actual query execution.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOrgBillingSnapshot, getActiveTrainerCount } from '../src/services/enterprise/subscriptionLifecycle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

// Column names that Postgres would actually return as a bigint string
// for a COUNT(*)/SUM(...) expression -- matches exactly what this
// file's own queries alias their aggregate as ('n', 'total').
const BIGINT_ALIASES = new Set(['n', 'total']);

function pgLikeStringify(rows) {
  return rows.map((row) => {
    const out = { ...row };
    for (const key of Object.keys(out)) {
      if (BIGINT_ALIASES.has(key) && out[key] !== null && out[key] !== undefined) out[key] = String(out[key]);
    }
    return out;
  });
}

async function fakePgDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  // trainers.status is migration-only (see init-db.js's MIGRATIONS
  // array), not in schema.sql's own CREATE TABLE -- same test-DB gap
  // documented throughout this suite's other memDb() helpers.
  db.exec(`ALTER TABLE trainers ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'`);
  return {
    driver: 'postgres', // just a label -- what matters is the string-coercion behavior below
    async q(sql, params = []) {
      const stmt = db.prepare(sql);
      const rows = params.length ? stmt.all(...params) : stmt.all();
      return pgLikeStringify(rows);
    },
    async q1(sql, params = []) {
      const rows = await this.q(sql, params);
      return rows[0] || null;
    },
    async run(sql, params = []) {
      const stmt = db.prepare(sql);
      const res = params.length ? stmt.run(...params) : stmt.run();
      return { changes: Number(res.changes) };
    },
    async tx(fn) {
      db.exec('BEGIN');
      try { const out = await fn(this); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
    raw: db,
  };
}

test('getOrgBillingSnapshot: purchasedCapacity is a real number, not string concatenation, when the driver returns bigint aggregates as strings', async () => {
  const db = await fakePgDb();
  const nowIso = '2026-01-01T00:00:00Z';
  await db.run(`INSERT INTO organizations (id, name, slug, created_at) VALUES ('org1', 'Org', 'org', ?)`, [nowIso]);
  await db.run(`INSERT INTO org_billing_state (org_id, status, updated_at) VALUES ('org1', 'ACTIVE', ?)`, [nowIso]);
  await db.run(`INSERT INTO sk_packages (id, name, client_capacity, price, currency, duration_days, version, status, effective_from, created_at) VALUES ('pkg1', '75 Clients', 75, 12000, 'INR', 365, 1, 'active', ?, ?)`, [nowIso, nowIso]);
  await db.run(
    `INSERT INTO org_subscriptions (id, org_id, package_id, client_capacity, price, currency, status, start_date, end_date, created_at, updated_at)
     VALUES ('sub1', 'org1', 'pkg1', 75, 12000, 'INR', 'ACTIVE', ?, '2030-01-01T00:00:00Z', ?, ?)`, [nowIso, nowIso, nowIso]);

  const snapshot = await getOrgBillingSnapshot(db, 'org1');
  assert.equal(snapshot.purchasedCapacity, 75, 'must be the NUMBER 75, not the STRING "750" (a real bug this exact scenario produced live)');
  assert.equal(typeof snapshot.purchasedCapacity, 'number');
  assert.equal(snapshot.activeClients, 0);
  assert.equal(typeof snapshot.activeClients, 'number');
  assert.equal(snapshot.availableCapacity, 75);
});

test('getOrgBillingSnapshot: capacity add-on SUM is added correctly, not concatenated, and active clients subtract correctly', async () => {
  const db = await fakePgDb();
  const nowIso = '2026-01-01T00:00:00Z';
  await db.run(`INSERT INTO organizations (id, name, slug, created_at) VALUES ('org1', 'Org', 'org', ?)`, [nowIso]);
  await db.run(`INSERT INTO org_billing_state (org_id, status, updated_at) VALUES ('org1', 'ACTIVE', ?)`, [nowIso]);
  await db.run(`INSERT INTO sk_packages (id, name, client_capacity, price, currency, duration_days, version, status, effective_from, created_at) VALUES ('pkg1', '75 Clients', 75, 12000, 'INR', 365, 1, 'active', ?, ?)`, [nowIso, nowIso]);
  await db.run(
    `INSERT INTO org_subscriptions (id, org_id, package_id, client_capacity, price, currency, status, start_date, end_date, created_at, updated_at)
     VALUES ('sub1', 'org1', 'pkg1', 75, 12000, 'INR', 'ACTIVE', ?, '2030-01-01T00:00:00Z', ?, ?)`, [nowIso, nowIso, nowIso]);
  await db.run(`INSERT INTO org_capacity_purchases (id, org_id, subscription_id, increment, price, currency, created_at) VALUES ('cap1', 'org1', 'sub1', 10, 1800, 'INR', ?)`, [nowIso]);
  for (let i = 0; i < 3; i++) {
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, 'org1', ?, 'x', 'CLIENT', ?, 1, ?)`, [`u${i}`, `u${i}@test.in`, `U ${i}`, nowIso]);
    await db.run(`INSERT INTO clients (id, user_id, org_id, status, goal, created_at) VALUES (?, ?, 'org1', 'ON_TRACK', 'GENERAL', ?)`, [`c${i}`, `u${i}`, nowIso]);
  }

  const snapshot = await getOrgBillingSnapshot(db, 'org1');
  assert.equal(snapshot.purchasedCapacity, 85, '75 base + 10 add-on = 85, not "7510" or any other concatenation');
  assert.equal(snapshot.activeClients, 3);
  assert.equal(snapshot.availableCapacity, 82);
});

test('getActiveTrainerCount: returns a real number even for zero trainers (a bigint "0" string is truthy in JS -- the old `|| 0` fallback never fired)', async () => {
  const db = await fakePgDb();
  await db.run(`INSERT INTO organizations (id, name, slug, created_at) VALUES ('org1', 'Org', 'org', '2026-01-01T00:00:00Z')`);
  const count = await getActiveTrainerCount(db, 'org1');
  assert.equal(count, 0);
  assert.equal(typeof count, 'number');
});
