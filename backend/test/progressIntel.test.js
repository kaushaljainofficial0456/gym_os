// ============================================================
// PROGRESS 2.0 — trend engine + intelligence assembly.
//
// The two failure modes this feature has to be protected against are
// (a) inventing a trend that the data does not support, and (b) showing
// wearable-derived metrics to a user who has no wearable. Most of the
// tests below are one or the other.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeSeries, normalizeSeries, comparePeriods, streak, goalProgress, rollingAverage, linearSlopePerDay,
} from '../src/services/progress/trendEngine.js';
import { getProgressIntel } from '../src/services/progress/progressIntel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

const dayKey = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  const mk = () => ({
    async q(sql, params = []) { const st = db.prepare(sql); return params.length ? st.all(...params) : st.all(); },
    async q1(sql, params = []) { const rows = await mk().q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const st = db.prepare(sql); const r = params.length ? st.run(...params) : st.run(); return { changes: Number(r.changes) }; },
  });
  return mk();
}

async function seedClient(db, { targetWeight = null } = {}) {
  const ts = '2026-01-01T00:00:00Z';
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Org', 'org', ts]);
  await db.run('INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?,?,?,?,?,?,1,?)',
    ['u1', 'o1', 'c@test.com', 'x', 'CLIENT', 'Client', ts]);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, current_weight, target_weight, age, sex, height_cm, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ['c1', 'u1', 'o1', 'FAT_LOSS', 90, targetWeight, 30, 'MALE', 178, ts]);
  return { userId: 'u1', orgId: 'o1', clientId: 'c1' };
}

const addWeight = (db, day, kg) => db.run(
  'INSERT INTO weight_logs (id, client_id, date, weight, source, created_at) VALUES (?,?,?,?,?,?)',
  [`w${day}${kg}`, 'c1', dayKey(day), kg, 'manual', new Date().toISOString()]);

/* ───────────────────────── trend engine ───────────────────────── */

test('normalizeSeries sorts, drops unusable rows, and collapses same-day duplicates to their mean', () => {
  const s = normalizeSeries([
    { date: '2026-03-03', value: 80 },
    { date: '2026-03-01', value: 82 },
    { date: '2026-03-03', value: 82 },     // same day as the first -> mean 81
    { date: '2026-03-02', value: null },   // unusable
    { date: null, value: 5 },              // unusable
  ]);
  assert.deepEqual(s.map((p) => p.date), ['2026-03-01', '2026-03-03']);
  assert.equal(s[1].value, 81, 'two weigh-ins on one day are ONE data point, not two points of trend');
});

test('a single reading is reported as insufficient, never as a trend', () => {
  const a = analyzeSeries([{ date: '2026-03-01', value: 90 }], { valueKey: 'value' });
  assert.equal(a.insufficient, true);
  assert.equal(a.reason, 'single_point');
  assert.equal(a.ratePerWeek, null, 'no rate can be honestly derived from one point');
  assert.equal(a.current, 90, 'the reading itself is still reported');
});

test('an empty series reports no_data rather than zeros', () => {
  const a = analyzeSeries([], { valueKey: 'value' });
  assert.equal(a.insufficient, true);
  assert.equal(a.reason, 'no_data');
  assert.equal(a.count, 0);
});

test('a per-week rate needs BOTH enough points and enough elapsed days', () => {
  // Four points, but all inside three days -- extrapolating to a week
  // would multiply noise into a confident-looking number.
  const tight = analyzeSeries([
    { date: '2026-03-01', value: 90 }, { date: '2026-03-02', value: 89.6 },
    { date: '2026-03-03', value: 89.2 }, { date: '2026-03-04', value: 88.8 },
  ], { valueKey: 'value' });
  assert.equal(tight.ratePerWeek, null, 'under a week of span -> no weekly rate');
  assert.ok(tight.slopePerDay < 0, 'the raw slope is still available');

  const spread = analyzeSeries([
    { date: '2026-03-01', value: 90 }, { date: '2026-03-05', value: 89.5 },
    { date: '2026-03-10', value: 89 }, { date: '2026-03-15', value: 88.5 },
  ], { valueKey: 'value' });
  assert.ok(spread.ratePerWeek != null && spread.ratePerWeek < 0, 'a fortnight of data supports a weekly rate');
});

test('slope uses real calendar gaps, so missing days do not distort the trend', () => {
  // Same values; the second series has a long gap before the last point.
  const even = linearSlopePerDay([
    { date: '2026-03-01', value: 10 }, { date: '2026-03-02', value: 11 }, { date: '2026-03-03', value: 12 },
  ]);
  const gapped = linearSlopePerDay([
    { date: '2026-03-01', value: 10 }, { date: '2026-03-02', value: 11 }, { date: '2026-03-31', value: 12 },
  ]);
  assert.equal(Math.round(even * 100) / 100, 1, 'one unit per day');
  assert.ok(gapped < even, 'the same rise spread over a month is a gentler slope, not the same one');
});

test('rollingAverage smooths without inventing points outside the series', () => {
  const s = [
    { date: '2026-03-01', value: 10 }, { date: '2026-03-02', value: 20 },
    { date: '2026-03-03', value: 10 }, { date: '2026-03-04', value: 20 },
  ];
  const r = rollingAverage(s, 3);
  assert.equal(r.length, s.length);
  assert.deepEqual(r.map((p) => p.date), s.map((p) => p.date));
  assert.ok(Math.max(...r.map((p) => p.value)) < 20, 'peaks are damped');
});

test('comparePeriods returns null when there is no previous window to compare against', () => {
  const rows = [{ date: dayKey(2), value: 10 }, { date: dayKey(1), value: 12 }];
  assert.equal(comparePeriods(rows, { days: 30, valueKey: 'value' }), null, 'nothing before the current window');
});

test('comparePeriods compares two NON-overlapping windows', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ date: dayKey(i), value: i < 10 ? 150 : 100 });
  const c = comparePeriods(rows, { days: 10, valueKey: 'value' });
  assert.equal(c.current, 150);
  assert.equal(c.previous, 100);
  assert.equal(c.changePercent, 50);
});

test('a current streak only counts when it reaches today or yesterday', () => {
  const live = streak([dayKey(0), dayKey(1), dayKey(2)]);
  assert.equal(live.current, 3);

  // A three-day run that ended a fortnight ago is a PAST streak.
  const stale = streak([dayKey(14), dayKey(15), dayKey(16)]);
  assert.equal(stale.current, 0, 'a broken streak is not a current streak');
  assert.equal(stale.best, 3, 'but it is still the best run so far');
});

test('goal ETA is withheld when the trend moves AWAY from the target', () => {
  const towards = goalProgress({ start: 95, current: 90, target: 85, ratePerWeek: -0.5 });
  assert.ok(towards.weeksToTarget > 0);
  assert.equal(Math.round(towards.percent), 50, 'halfway from 95 to 85');

  const away = goalProgress({ start: 95, current: 90, target: 85, ratePerWeek: +0.5 });
  assert.equal(away.weeksToTarget, null, 'gaining weight gives no ETA to a lower target');

  const noTrend = goalProgress({ start: 95, current: 90, target: 85, ratePerWeek: null });
  assert.equal(noTrend.weeksToTarget, null);
  assert.equal(noTrend.remaining, -5);
});

/* ───────────────────── intelligence assembly ───────────────────── */

test('a brand-new client reports every capability false and fabricates nothing', async () => {
  const db = await memDb();
  const ids = await seedClient(db);
  const intel = await getProgressIntel(db, { userId: ids.userId, clientId: ids.clientId, days: 90 });

  for (const key of ['weight', 'workouts', 'nutrition', 'prs', 'measurements', 'progressPhotos']) {
    assert.equal(intel.capabilities[key].available, false, `${key} must not claim to be available`);
  }
  // The wearable-dependent ones are the important half of this assertion:
  // a user with no wearable must never be told they have sleep/recovery.
  for (const key of ['sleep', 'recovery', 'readiness']) {
    assert.equal(intel.capabilities[key].available, false, `${key} must be false without a health source`);
    assert.equal(intel.capabilities[key].source, null, `${key} must not name a source it does not have`);
  }
  assert.equal(intel.weight.analysis.insufficient, true);
  assert.equal(intel.insights.length, 0, 'no data means no insights, not filler');
  assert.equal(intel.prs.total, 0);
});

test('wearable capabilities are per-METRIC, not one hasWearable flag', async () => {
  const db = await memDb();
  const ids = await seedClient(db);
  const ts = new Date().toISOString();
  // A source that provides sleep but no recovery score -- exactly the
  // Apple-Health-style case the UI must handle without inventing recovery.
  await db.run(
    `INSERT INTO health_daily_summaries (id, user_id, org_id, date, sleep_duration_seconds, steps, computed_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ['hds1', ids.userId, ids.orgId, dayKey(1), 27000, 8000, ts, ts, ts]);

  const intel = await getProgressIntel(db, { userId: ids.userId, clientId: ids.clientId, days: 90 });
  assert.equal(intel.capabilities.sleep.available, true, 'sleep has real values');
  assert.equal(intel.capabilities.steps.available, true);
  assert.equal(intel.capabilities.recovery.available, false, 'no recovery score was ever recorded');
  assert.equal(intel.capabilities.readiness.available, false);
});

test('weight trend, goal progress and insights are derived from real logged rows', async () => {
  const db = await memDb();
  const ids = await seedClient(db, { targetWeight: 85 });
  // A clean four-week downward trend.
  for (let i = 28; i >= 0; i -= 4) await addWeight(db, i, 92 - (28 - i) * 0.15);

  const intel = await getProgressIntel(db, { userId: ids.userId, clientId: ids.clientId, days: 90 });
  const a = intel.weight.analysis;
  assert.equal(a.insufficient, false);
  assert.ok(a.change < 0, 'weight went down');
  assert.ok(a.ratePerWeek < 0, 'and the weekly rate reflects it');
  assert.ok(intel.weight.goal, 'a target weight produces goal progress');
  assert.ok(intel.weight.goal.weeksToTarget > 0, 'trending toward the target gives an ETA');

  const titles = intel.insights.map((i) => i.title);
  assert.ok(titles.some((t) => /trending down/i.test(t)), `expected a trend insight, got: ${titles.join(' | ')}`);
  // Every insight must carry its own supporting numbers.
  for (const i of intel.insights) {
    assert.ok(i.description && i.description.length > 0, 'an insight without evidence is a slogan');
    assert.ok(i.confidence, 'insights state their confidence');
  }
});

test('a flat month is reported as a plateau rather than as a tiny fake trend', async () => {
  const db = await memDb();
  const ids = await seedClient(db);
  for (let i = 28; i >= 0; i -= 4) await addWeight(db, i, 90);

  const intel = await getProgressIntel(db, { userId: ids.userId, clientId: ids.clientId, days: 90 });
  const titles = intel.insights.map((i) => i.title);
  assert.ok(titles.some((t) => /plateau/i.test(t)), `expected a plateau insight, got: ${titles.join(' | ')}`);
  assert.ok(intel.insights.some((i) => i.type === 'warning'));
});

test('PRs come from the existing engine tables, with current bests and a dated timeline kept separate', async () => {
  const db = await memDb();
  const ids = await seedClient(db);
  const ts = new Date().toISOString();
  await db.run('INSERT INTO exercise_library (id, org_id, name, primary_muscle, equipment, movement, ex_type, is_global) VALUES (?,NULL,?,?,?,?,?,1)',
    ['ex1', 'Bench Press', 'chest', 'barbell', 'horizontal_push', 'compound']);
  await db.run('INSERT INTO personal_records (id, client_id, exercise_id, type, value, weight, reps, date, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ['pr1', 'c1', 'ex1', 'heaviest_weight', 75, 75, 5, dayKey(3), ts]);
  await db.run('INSERT INTO personal_records (id, client_id, exercise_id, type, value, weight, reps, date, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ['pr2', 'c1', 'ex1', 'est_1rm', 87.5, 75, 5, dayKey(3), ts]);
  // The dated record of WHEN it was set lives on the log, because
  // personal_records only ever holds the current best per exercise/type.
  await db.run('INSERT INTO workout_logs (id, client_id, exercise_id, date, sets_done, reps, weight, is_pr, created_at) VALUES (?,?,?,?,?,?,?,1,?)',
    ['wl1', 'c1', 'ex1', dayKey(3), 3, 5, 75, ts]);

  const intel = await getProgressIntel(db, { userId: ids.userId, clientId: ids.clientId, days: 90 });
  assert.equal(intel.capabilities.prs.available, true);
  assert.equal(intel.prs.byExercise.length, 1);
  assert.equal(intel.prs.byExercise[0].exercise, 'Bench Press');
  assert.deepEqual(Object.keys(intel.prs.byExercise[0].records).sort(), ['est_1rm', 'heaviest_weight']);
  assert.equal(intel.prs.timeline.length, 1, 'the timeline answers WHEN, from the logs');
  assert.equal(intel.prs.recentCount, 1);
  assert.ok(intel.insights.some((i) => i.metric === 'prs'), 'PR data feeds the insight engine');
});

test('out-of-order and duplicate rows do not corrupt the series', async () => {
  const db = await memDb();
  const ids = await seedClient(db);
  await addWeight(db, 2, 90);
  await addWeight(db, 10, 92);      // inserted out of order
  await addWeight(db, 6, 91);
  await db.run('INSERT INTO weight_logs (id, client_id, date, weight, source, created_at) VALUES (?,?,?,?,?,?)',
    ['dup', 'c1', dayKey(2), 90, 'manual', new Date().toISOString()]);   // duplicate day

  const intel = await getProgressIntel(db, { userId: ids.userId, clientId: ids.clientId, days: 90 });
  const dates = intel.weight.series.map((p) => p.date);
  assert.deepEqual([...dates].sort(), dates, 'series is chronological regardless of insert order');
  assert.equal(new Set(dates).size, dates.length, 'one point per day');
  assert.equal(dates.length, 3);
});

test('aggregates are NUMBERS even when the driver returns bigint as a string (PG behaviour)', async () => {
  // PostgreSQL returns SUM()/COUNT() over integers as BIGINT, and node-pg
  // hands BIGINT back as a STRING. SQLite returns a JS number for the same
  // query, so this class of bug passes every local test and only breaks in
  // production -- which is exactly what happened: `sets` arrived as "17",
  // the UI added it with `total + row.sets`, and a sets total rendered as
  // 1,71,71,71,73,13,13,...
  const db = await memDb();
  const ids = await seedClient(db);
  const realQ = db.q.bind(db);
  // Wrap the driver so every aggregate column comes back as a string,
  // reproducing node-pg's bigint handling against the real code path.
  db.q = async (sql, params) => {
    const rows = await realQ(sql, params);
    return rows.map((r) => {
      const out = { ...r };
      for (const k of ['sets', 'reps', 'exercises', 'entries', 'n', 'volume']) {
        if (out[k] != null && typeof out[k] === 'number') out[k] = String(out[k]);
      }
      return out;
    });
  };
  const ts = new Date().toISOString();
  await db.run('INSERT INTO exercise_library (id, org_id, name, primary_muscle, equipment, movement, ex_type, is_global) VALUES (?,NULL,?,?,?,?,?,1)',
    ['ex1', 'Bench Press', 'chest', 'barbell', 'horizontal_push', 'compound']);
  for (let i = 0; i < 3; i++) {
    await db.run('INSERT INTO workout_logs (id, client_id, exercise_id, date, sets_done, reps, weight, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [`wl${i}`, 'c1', 'ex1', dayKey(i + 1), 4, 10, 60, ts]);
  }

  const intel = await getProgressIntel(db, { userId: ids.userId, clientId: ids.clientId, days: 90 });
  for (const session of intel.training.sessions) {
    assert.equal(typeof session.sets, 'number', 'sets must be a number, never a string');
    assert.equal(typeof session.reps, 'number');
    assert.equal(typeof session.exercises, 'number');
  }
  // The actual regression: summing must ADD, not concatenate.
  const total = intel.training.sessions.reduce((acc, x) => acc + x.sets, 0);
  assert.equal(total, 12, `three sessions of 4 sets must total 12, got ${total}`);
  for (const m of intel.training.byMuscle) assert.equal(typeof m.sets, 'number');
  assert.equal(typeof intel.capabilities.workouts.count, 'number');
});
