// ============================================================
// LATE-ARRIVING WEARABLE DATA MUST REOPEN AN ALREADY-RECONCILED DAY.
//
// Caught live: connect a wearable today, and yesterday's burn screen still
// showed SK OS figures only. Yesterday had been reconciled before the
// wearable existed -- the cached summary was complete and correct AT THE
// TIME -- and every later read served it, so a workout the provider
// delivered afterwards for that day never appeared. Reconciliation only
// ran when a day had NO summary at all, which is precisely the case this
// is not.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileUserDay, getBurnBreakdown } from '../src/services/health/dailyIntelligence.js';
import { upsertHealthRecord } from '../src/services/health/dedup.js';

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

async function seed(db) {
  const ts = '2026-01-01T00:00:00Z';
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Org', 'org', ts]);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?,?,?,?,'CLIENT',?,1,?)`,
    ['u1', 'o1', 'c@test.com', 'x', 'Client', ts]);
  await db.run(`INSERT INTO clients (id, user_id, org_id, goal, current_weight, age, sex, height_cm, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ['c1', 'u1', 'o1', 'GENERAL', 80, 30, 'male', 180, ts]);
  return { userId: 'u1', orgId: 'o1', clientId: 'c1' };
}

/** Mirrors the route's staleness rule, which is the thing under test. */
async function hasNewerHealthData(db, { userId, date, computedAt }) {
  if (!computedAt) return true;
  const row = await db.q1(
    `SELECT MAX(synced_at) AS newest FROM health_records
      WHERE user_id = ? AND deleted_at IS NULL AND start_time >= ? AND start_time < ?`,
    [userId, `${date}T00:00:00Z`, `${date}T23:59:59Z`]);
  if (!row?.newest) return false;
  return Date.parse(row.newest) > Date.parse(computedAt);
}

const DATE = '2026-02-10';

test('a wearable workout that arrives AFTER a day was reconciled reopens that day', async () => {
  const db = await memDb();
  const ids = await seed(db);

  // Pass 1 -- the day is reconciled with no wearable data at all.
  await reconcileUserDay(db, { ...ids, date: DATE, tz: 'UTC' });
  const before = await getBurnBreakdown(db, { userId: ids.userId, date: DATE });
  assert.ok(before, 'the day has a summary');
  const activeBefore = before.totals?.active ?? 0;

  // The wearable delivers a workout for that day only now.
  await upsertHealthRecord(db, { userId: ids.userId, orgId: ids.orgId }, {
    provider: 'whoop', provider_record_id: 'late-1', data_type: 'workout',
    activity_type: 'running', start_time: `${DATE}T07:00:00Z`, end_time: `${DATE}T07:45:00Z`,
    active_kcal: 420, auto_detected: true,
  });

  // The staleness check is what decides whether the day gets reopened.
  const stale = await hasNewerHealthData(db, { userId: ids.userId, date: DATE, computedAt: before.computed_at });
  assert.equal(stale, true, 'newly-synced records for the day must mark it stale');

  await reconcileUserDay(db, { ...ids, date: DATE, tz: 'UTC' });
  const after = await getBurnBreakdown(db, { userId: ids.userId, date: DATE });

  assert.ok((after.totals?.active ?? 0) > activeBefore, 'the wearable workout must now be counted');
  const workoutLines = (after.entries || []).filter((e) => e.type === 'workout');
  assert.ok(workoutLines.length >= 1, 'and it must appear as its own line, not just in the total');
});

test('a day with NO new records is left alone rather than recomputed on every read', async () => {
  const db = await memDb();
  const ids = await seed(db);
  await reconcileUserDay(db, { ...ids, date: DATE, tz: 'UTC' });
  const summary = await getBurnBreakdown(db, { userId: ids.userId, date: DATE });

  const stale = await hasNewerHealthData(db, { userId: ids.userId, date: DATE, computedAt: summary.computed_at });
  assert.equal(stale, false, 'no new evidence means no recompute -- this check is what keeps reads cheap');
});

test('records belonging to a DIFFERENT day never mark this one stale', async () => {
  const db = await memDb();
  const ids = await seed(db);
  await reconcileUserDay(db, { ...ids, date: DATE, tz: 'UTC' });
  const summary = await getBurnBreakdown(db, { userId: ids.userId, date: DATE });

  await upsertHealthRecord(db, { userId: ids.userId, orgId: ids.orgId }, {
    provider: 'whoop', provider_record_id: 'other-day', data_type: 'workout',
    activity_type: 'running', start_time: '2026-02-14T07:00:00Z', end_time: '2026-02-14T07:45:00Z',
    active_kcal: 400,
  });

  const stale = await hasNewerHealthData(db, { userId: ids.userId, date: DATE, computedAt: summary.computed_at });
  assert.equal(stale, false, 'the staleness window is scoped to the day being read');
});
