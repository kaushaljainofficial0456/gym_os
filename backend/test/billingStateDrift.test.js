// ============================================================
// A LIVE SUBSCRIPTION IS THE TRUTH; org_billing_state IS A CACHE.
//
// The two are written in separate steps, so they drift. A gym with an
// ACTIVE subscription — 75 seats, paid, running to 2027 — still had a
// billing_state row reading SETUP, and the Enterprise screen gates on
// that field alone. So a gym with 26 paying clients, three trainers and
// eight lakh of recorded revenue was greeted with:
//
//     "Let's get your gym set up."  [ Start setup ]
//
// Not merely a wrong label: the button leads to an onboarding wizard for
// a gym that finished onboarding in August. The cache was able to lie in
// the one direction that locks a paying customer out of their product.
//
// This is the fourth appearance of one pattern in this codebase — a
// status COLUMN believed over the facts that define it. The others:
// subscriptions.status vs its end date (reported 23 active members for a
// gym with 2), analytics churn (structurally always 0%), and renewals
// due (counted every already-passed date).
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOrgBillingSnapshot } from '../src/services/enterprise/subscriptionLifecycle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const ts = '2026-01-01T00:00:00Z';

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(schema);
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, p = []) { const st = raw.prepare(sql); return p.length ? st.all(...p) : st.all(); },
    async q1(sql, p = []) { const rows = await mk().q(sql, p); return rows[0] || null; },
    async run(sql, p = []) { const st = raw.prepare(sql); const r = p.length ? st.run(...p) : st.run(); return { changes: Number(r.changes) }; },
    raw,
  });
  return mk();
}

const future = new Date(Date.now() + 365 * 86400000).toISOString();
const past = new Date(Date.now() - 3 * 86400000).toISOString();

async function gym(db, { billingStatus, subStatus, endDate = future, capacity = 75 } = {}) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Gym', 'gym', ts]);
  if (billingStatus) {
    await db.run('INSERT INTO org_billing_state (org_id, status, updated_at) VALUES (?,?,?)',
      ['o1', billingStatus, ts]);
  }
  if (subStatus) {
    await db.run(
      `INSERT INTO sk_packages (id, name, client_capacity, price, currency, duration_days, status, effective_from, created_at)
       VALUES ('pkg1','Growth',?,12000,'INR',365,'active',?,?)`, [capacity, ts, ts]);
    await db.run(
      `INSERT INTO org_subscriptions (id, org_id, package_id, client_capacity, price, currency, status, start_date, end_date, created_at, updated_at)
       VALUES ('osub1','o1','pkg1',?,12000,'INR',?,?,?,?,?)`,
      [capacity, subStatus, ts, endDate, ts, ts]);
  }
  return db;
}

test('an ACTIVE subscription makes the gym active, whatever the cache says', async () => {
  // The exact production shape: paid, live, and locked out.
  const db = await memDb();
  await gym(db, { billingStatus: 'SETUP', subStatus: 'ACTIVE' });

  const snap = await getOrgBillingSnapshot(db, 'o1');
  assert.equal(snap.status, 'ACTIVE', 'a paying gym is not "setting up"');
  assert.equal(snap.purchasedCapacity, 75);
});

test('the stale row is healed, not just routed around', async () => {
  const db = await memDb();
  await gym(db, { billingStatus: 'SETUP', subStatus: 'ACTIVE' });

  await getOrgBillingSnapshot(db, 'o1');
  const row = await db.q1('SELECT status FROM org_billing_state WHERE org_id = ?', ['o1']);
  assert.equal(row.status, 'ACTIVE', 'the drift is corrected at source');
});

test('no subscription means no promotion — SETUP stays SETUP', async () => {
  // The correction must only ever run in the direction the evidence
  // supports. A gym that genuinely has not bought anything still needs
  // the onboarding wizard this fix removes from everyone else.
  const db = await memDb();
  await gym(db, { billingStatus: 'SETUP', subStatus: null });

  const snap = await getOrgBillingSnapshot(db, 'o1');
  assert.equal(snap.status, 'SETUP');
  assert.equal(snap.subscription, null);
  assert.equal(snap.purchasedCapacity, 0);
});

test('a non-active subscription does not promote the gym either', async () => {
  const db = await memDb();
  await gym(db, { billingStatus: 'PAYMENT_PENDING', subStatus: 'PENDING_PAYMENT' });

  const snap = await getOrgBillingSnapshot(db, 'o1');
  assert.equal(snap.status, 'PAYMENT_PENDING', 'an unpaid order is not access');
});

test('an expired subscription expires the gym rather than reviving it', async () => {
  // The lapse path has to keep working: the healing above must not
  // resurrect a subscription whose end date has passed.
  const db = await memDb();
  await gym(db, { billingStatus: 'ACTIVE', subStatus: 'ACTIVE', endDate: past });

  const snap = await getOrgBillingSnapshot(db, 'o1');
  assert.notEqual(snap.status, 'ACTIVE', 'a finished subscription is not active');
  const row = await db.q1('SELECT status FROM org_subscriptions WHERE id = ?', ['osub1']);
  assert.equal(row.status, 'EXPIRED');
});

test('an already-consistent gym is left alone', async () => {
  const db = await memDb();
  await gym(db, { billingStatus: 'ACTIVE', subStatus: 'ACTIVE' });
  const snap = await getOrgBillingSnapshot(db, 'o1');
  assert.equal(snap.status, 'ACTIVE');
});
