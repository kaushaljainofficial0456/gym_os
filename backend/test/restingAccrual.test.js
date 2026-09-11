// ============================================================
// TODAY'S RESTING ENERGY MUST KEEP ACCRUING.
//
// Caught live: the burn screen showed a flat 150 kcal at 10:27 in the
// morning. The number was correct when it was WRITTEN -- reconciliation
// had run at ~2am, when two hours of BMR had genuinely accrued -- and then
// sat frozen all day, because every later read served the cached row.
//
// Resting energy is the one figure on that screen that keeps moving
// whether or not the user does anything, so it has to be derived from
// elapsed time on READ, not stored once and replayed.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDailyIntelligence } from '../src/services/health/dailyIntelligence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  const mk = () => ({
    async q(sql, p = []) { const st = db.prepare(sql); return p.length ? st.all(...p) : st.all(); },
    async q1(sql, p = []) { const rows = await mk().q(sql, p); return rows[0] || null; },
    async run(sql, p = []) { const st = db.prepare(sql); const r = p.length ? st.run(...p) : st.run(); return { changes: Number(r.changes) }; },
  });
  return mk();
}

const BMR = 1800;

async function seedSummary(db, { date, restingWritten, active = 0 }) {
  const ts = new Date().toISOString();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Org', 'org', ts]);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?,?,?,?,'CLIENT',?,1,?)`,
    ['u1', 'o1', 'c@test.com', 'x', 'Client', ts]);
  await db.run(
    `INSERT INTO health_daily_summaries (id, user_id, org_id, date, resting_energy, active_energy, total_energy, source_summary_json, computed_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ['hds1', 'u1', 'o1', date, restingWritten, active, restingWritten + active, JSON.stringify({ bmrPerDay: BMR }), ts, ts, ts]);
}

// UTC, because every case below asks the service for `tz: 'UTC'`. Built
// from LOCAL date parts this disagreed with the service's own day key for
// any machine ahead of UTC -- in IST, between local midnight and 05:30 the
// local date is already tomorrow in UTC terms, so the service correctly
// treated the row as a PAST day and served it unprorated while the
// assertion below expected a NEGATIVE number of elapsed hours. That made
// the suite fail for 5.5 hours every night on a passing service.
const todayKey = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

test("today's resting energy is recomputed from elapsed time, not served frozen from cache", async () => {
  const db = await memDb();
  // Written at ~2am: two hours of a 1800 kcal/day BMR.
  await seedSummary(db, { date: todayKey(), restingWritten: 150, active: 0 });

  const served = await getDailyIntelligence(db, { userId: 'u1', date: todayKey(), tz: 'UTC' });

  const hoursElapsed = (Date.now() - Date.parse(`${todayKey()}T00:00:00Z`)) / 3600000;
  const expected = (BMR / 24) * hoursElapsed;

  assert.ok(
    Math.abs(served.resting_energy - expected) < 5,
    `resting should track elapsed time (~${Math.round(expected)} kcal), got ${Math.round(served.resting_energy)}`,
  );
  // The specific regression: it must not still be the stored 150 once real
  // time has moved on.
  if (hoursElapsed > 3) {
    assert.notEqual(Math.round(served.resting_energy), 150, 'served the frozen cached value');
  }
  assert.equal(served.total_energy, served.resting_energy + 0, 'total is rebuilt around the live resting figure');
});

test('a PAST day is complete and is NOT re-prorated', async () => {
  const db = await memDb();
  // A finished day: a full 24h of BMR was already banked.
  await seedSummary(db, { date: '2026-01-05', restingWritten: BMR, active: 400 });

  const served = await getDailyIntelligence(db, { userId: 'u1', date: '2026-01-05', tz: 'UTC' });
  assert.equal(served.resting_energy, BMR, 'a past day keeps the figure it closed with');
  assert.equal(served.total_energy, BMR + 400);
});

test('a summary with no stored BMR is served unchanged rather than guessed at', async () => {
  const db = await memDb();
  const ts = new Date().toISOString();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Org', 'org', ts]);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?,?,?,?,'CLIENT',?,1,?)`,
    ['u1', 'o1', 'c@test.com', 'x', 'Client', ts]);
  await db.run(
    `INSERT INTO health_daily_summaries (id, user_id, org_id, date, resting_energy, active_energy, total_energy, computed_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ['hds1', 'u1', 'o1', todayKey(), 150, 0, 150, ts, ts, ts]);

  const served = await getDailyIntelligence(db, { userId: 'u1', date: todayKey(), tz: 'UTC' });
  // No BMR on record means no honest way to prorate -- better the stored
  // number than an invented one.
  assert.equal(served.resting_energy, 150);
});
