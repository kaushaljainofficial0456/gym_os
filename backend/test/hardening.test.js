// ============================================================
// Hardening-pass tests: tenant isolation, client permissions,
// meal composition, occupancy engine, planner, PG compatibility.
// ============================================================
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import express from 'express';
import { config } from '../src/config.js';
import { resetRateLimits } from '../src/rateLimit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  // meal_items.source/ai_confidence/ai_provider/ai_model and
  // ai_food_estimates.validation_status/version (food-AI Tier 4
  // provenance + feedback promotion, see foodFeedback.js) exist only via
  // scripts/init-db.js's guarded migrations, which this lightweight
  // in-memory DB doesn't run -- same gap documented in
  // nutrition-meal-log-api.test.js's memDb() for meal_logs.
  for (const ddl of [`source TEXT NOT NULL DEFAULT 'database'`, 'ai_confidence TEXT', 'ai_provider TEXT', 'ai_model TEXT']) {
    db.exec(`ALTER TABLE meal_items ADD COLUMN ${ddl}`);
  }
  for (const ddl of [`validation_status TEXT NOT NULL DEFAULT 'AI_ESTIMATED'`, `version INTEGER NOT NULL DEFAULT 1`]) {
    db.exec(`ALTER TABLE ai_food_estimates ADD COLUMN ${ddl}`);
  }
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await mk().q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
    exec(sql) { db.exec(sql); },
    tx(fn) {
      db.exec('BEGIN');
      try {
        const out = fn(mk());
        db.exec('COMMIT');
        return out;
      } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
    raw: db
  });
  return mk();
}

const idp = (p) => 'id_' + Math.random().toString(36).slice(2, 10);

// ---------- shared fixture: two orgs, one client each ----------
async function twoOrgFixture() {
  const db = await memDb();
  for (const [oid, slug] of [['o1', 'gym-a'], ['o2', 'gym-b']]) {
    await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [oid, 'Gym ' + oid, slug, '2026-01-01T00:00:00Z']);
  }
  for (const [uid, oid, email, name] of [['u1', 'o1', 'a@x.in', 'Rahul'], ['u2', 'o2', 'b@x.in', 'Sita']]) {
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
      [uid, oid, email, 'x', name, '2026-01-01T00:00:00Z']);
  }
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)', ['c1', 'u1', 'o1', 'FAT_LOSS', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)', ['c2', 'u2', 'o2', 'MUSCLE_GAIN', '2026-01-01T00:00:00Z']);
  return db;
}

// ---------- PG placeholder translation ----------
test('translateSql converts ? placeholders to $n for PostgreSQL', async (t) => {
  const { translateSql } = await import('../src/db.js');
  assert.equal(translateSql('SELECT * FROM x WHERE a = ? AND b = ?'), 'SELECT * FROM x WHERE a = $1 AND b = $2');
  assert.equal(translateSql('UPDATE t SET v = ? WHERE id = ?'), 'UPDATE t SET v = $1 WHERE id = $2');
  assert.equal(translateSql('SELECT 1'), 'SELECT 1');
  // NOTE: the codebase never uses `?` inside string literals — the translator is
  // naive but safe for every query in src/ (verified by grep).
  assert.equal(translateSql('WHERE name = ? AND (a = ? OR b = ?)'), 'WHERE name = $1 AND (a = $2 OR b = $3)');
});

// ---------- occupancy engine ----------
test('occupancy engine handles duplicate events and computes peak/busiest hour', async (t) => {
  const db = await memDb();
  const { computeOccupancy } = await import('../src/services/occupancy.js');
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym', 'gym', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, org_id, goal, created_at) VALUES (?, ?, ?, ?)', ['c1', 'o1', 'FAT_LOSS', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, org_id, goal, created_at) VALUES (?, ?, ?, ?)', ['c2', 'o1', 'FAT_LOSS', '2026-01-01T00:00:00Z']);
  const tz = 'Asia/Kolkata';
  const { dayKey } = await import('../src/utils/time.js');
  const d = dayKey(new Date(), tz);
  const events = [
    ['e1', 'c1', `${d}T06:00:00+05:30`, 'entry'],
    ['e2', 'c1', `${d}T06:05:00+05:30`, 'entry'],            // duplicate entry — ignored
    ['e3', 'c2', `${d}T07:00:00+05:30`, 'entry'],
    ['e4', 'c2', `${d}T08:00:00+05:30`, 'exit'],
    ['e5', 'c2', `${d}T08:05:00+05:30`, 'exit'],              // duplicate exit — ignored
    ['e6', 'c2', `${d}T08:30:00+05:30`, 'entry'],
    ['e7', 'c1', `${d}T09:00:00+05:30`, 'exit'],
    ['e8', 'c3x', `${d}T09:30:00+05:30`, 'exit']              // exit without entry — ignored
  ];
  // c3x has no client row; insert with FK off to simulate a stray event? FK is ON — use a real client.
  events[7][1] = 'c1';
  for (const [id, cid, ts, dir] of events) {
    await db.run('INSERT INTO attendance_events (id, org_id, client_id, ts, direction) VALUES (?, ?, ?, ?, ?)', [id, 'o1', cid, ts, dir]);
  }
  const snap = await computeOccupancy(db, 'o1', tz, { crowd_enabled: 1, crowd_capacity: 150 });
  assert.equal(snap.current, 1, 'only c2 remains inside (c1 exited at 09:00)');
  assert.equal(snap.peak, 2, 'peak is 2 (both inside at 07:00 and 08:30)');
  assert.ok(snap.byHour.length >= 4, 'hourly snapshots recorded');
  // busiest hour = the hour where the snapshot count was highest (2)
  const busy = snap.byHour.filter(h => h.count === 2);
  assert.ok(busy.length > 0, 'a 2-person hour exists');
  // disabled -> no data
  const off = await computeOccupancy(db, 'o1', tz, { crowd_enabled: 0, crowd_capacity: 150 });
  assert.equal(off.enabled, false);
  assert.equal(off.current, null);
});

// ---------- API-level: permissions + tenant isolation ----------
// Tokens must be signed with the SAME secret requireAuth verifies against (config.jwtSecret).
function tokenFor(user) {
  return jwt.sign({ sub: user.id, role: user.role, org: user.org_id, name: user.name }, config.jwtSecret, { expiresIn: '1h' });
}

async function startMeApi(db, user) {
  const meRoutes = (await import('../src/routes/me.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/me', meRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, body, u = user) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(u)}` },
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close };
}

test.afterEach(async () => {
  // nothing global; each test closes its own server
});

test('prescribed mode blocks client workout creation at the API', async (t) => {
  const db = await twoOrgFixture();
  const secret = 'test-secret';
  await db.run(`INSERT INTO gym_settings (org_id, workout_mode_default, allow_add_exercise) VALUES ('o1', 'prescribed', 1)`);
  await db.run(`INSERT INTO exercise_library (id, name, primary_muscle, equipment, is_global) VALUES ('ex1', 'Squat', 'QUADS', 'BARBELL', 1)`);
  const api = await startMeApi(db, { id: 'u1', role: 'CLIENT', org_id: 'o1' });
  t.after(() => api.close());
  const r = await api.call('POST', '/me/planner/workouts', { name: 'My Legs', exercises: [{ exercise_id: 'ex1', sets: 3, reps: '10' }] });
  assert.equal(r.status, 403, 'prescribed mode -> 403');
  await api.close();
});

test('custom mode allows planner creation; duplicate + schedule work', async (t) => {
  const db = await twoOrgFixture();
  const secret = 'test-secret';
  await db.run(`INSERT INTO gym_settings (org_id, workout_mode_default) VALUES ('o1', 'custom')`);
  await db.run(`INSERT INTO exercise_library (id, name, primary_muscle, equipment, is_global) VALUES ('ex1', 'Squat', 'QUADS', 'BARBELL', 1)`);
  await db.run(`INSERT INTO exercise_library (id, name, primary_muscle, equipment, is_global) VALUES ('ex2', 'Lunge', 'QUADS', 'DUMBBELL', 1)`);
  const api = await startMeApi(db, { id: 'u1', role: 'CLIENT', org_id: 'o1' });
  t.after(() => api.close());
  const created = await api.call('POST', '/me/planner/workouts', { name: 'Legs A', exercises: [
    { exercise_id: 'ex1', sets: 4, reps: '8', weight: '60' },
    { exercise_id: 'ex2', sets: 3, reps: '12', weight: '12' }
  ] });
  assert.equal(created.status, 200, 'custom mode allows creation');
  const wid = created.json.id;

  const plan = await api.call('GET', '/me/planner');
  assert.equal(plan.status, 200);
  assert.equal(plan.json.workouts.length, 1);
  assert.equal(plan.json.workouts[0].exercises.length, 2, 'exercises persisted');

  const dup = await api.call('POST', `/me/planner/workouts/${wid}/duplicate`);
  assert.equal(dup.status, 200);

  const sched = await api.call('PUT', '/me/planner/schedule', { schedule: { 0: wid, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null } });
  assert.equal(sched.status, 200, 'assign Monday');
  const plan2 = await api.call('GET', '/me/planner');
  assert.equal(plan2.json.schedule.length, 1);
  assert.equal(plan2.json.schedule[0].day_of_week, 0);
  await api.close();
});

// Regression coverage: the whole client-workout/planner surface in me.js
// had no rate limit at all before this (workoutWriteLimit).
test('client-workout/planner writes are rate-limited -- a burst past the per-minute cap gets 429', async (t) => {
  resetRateLimits();
  const db = await twoOrgFixture();
  await db.run(`INSERT INTO gym_settings (org_id, workout_mode_default) VALUES ('o1', 'custom')`);
  await db.run(`INSERT INTO exercise_library (id, name, primary_muscle, equipment, is_global) VALUES ('ex1', 'Squat', 'QUADS', 'BARBELL', 1)`);
  const api = await startMeApi(db, { id: 'u1', role: 'CLIENT', org_id: 'o1' });
  t.after(() => api.close());

  // Freeze time for the burst: the limiter keys its window on
  // Math.floor(Date.now() / windowMs), so real sequential requests can
  // straddle an actual clock-minute boundary under load and spuriously
  // never hit the limit -- a test-timing flake, not a real bug.
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const statuses = [];
  try {
    for (let i = 0; i < 45; i++) {
      statuses.push((await api.call('POST', '/me/planner/workouts', { name: `Burst ${i}`, exercises: [{ exercise_id: 'ex1', sets: 3, reps: '10' }] })).status);
    }
  } finally {
    mock.timers.reset();
  }
  assert.ok(statuses.includes(429), `expected at least one 429 in a 45-request burst against a 40/min limit, got ${statuses.filter((s) => s === 429).length} 429s`);
  assert.ok(statuses.slice(0, 40).every((s) => s === 200), 'the first 40 requests (at the configured limit) must all succeed');
});

test('client cannot inject another gym\'s exercise id into a workout', async (t) => {
  const db = await twoOrgFixture();
  const secret = 'test-secret';
  await db.run(`INSERT INTO gym_settings (org_id, workout_mode_default) VALUES ('o1', 'custom')`);
  // ex1 belongs to GYM B (o2) — not global, not o1
  await db.run(`INSERT INTO exercise_library (id, org_id, name, primary_muscle, equipment, is_global) VALUES ('exB', 'o2', 'Secret Lift', 'CHEST', 'BARBELL', 0)`);
  await db.run(`INSERT INTO exercise_library (id, name, primary_muscle, equipment, is_global) VALUES ('exG', 'Push-up', 'CHEST', 'BODYWEIGHT', 1)`);
  const api = await startMeApi(db, { id: 'u1', role: 'CLIENT', org_id: 'o1' });
  t.after(() => api.close());
  // only the cross-org exercise -> rejected
  const bad = await api.call('POST', '/me/planner/workouts', { name: 'X', exercises: [{ exercise_id: 'exB', sets: 3, reps: '10' }] });
  assert.equal(bad.status, 400, 'cross-org exercise rejected');
  // mixed: global passes, cross-org silently dropped by today-workout (no data leak)
  const today = await api.call('POST', '/me/workouts', { name: 'Mixed', exercises: [
    { exercise_id: 'exG', sets: 3, reps: '10' },
    { exercise_id: 'exB', sets: 3, reps: '10' }
  ] });
  assert.equal(today.status, 200);
  const w = await db.q1(`SELECT * FROM workouts WHERE client_id = 'c1' AND source = 'client_custom'`);
  assert.ok(w, 'workout created');
  const exs = await db.q(`SELECT * FROM workout_exercises WHERE workout_id = ?`, [w.id]);
  assert.equal(exs.length, 1, 'only the valid global exercise was attached');
  await api.close();
});

test('client cannot add another gym\'s food to their meal', async (t) => {
  const db = await twoOrgFixture();
  const secret = 'test-secret';
  // gym B's private food
  await db.run(`INSERT INTO foods (id, org_id, client_id, name, calories, protein, carbs, fat, is_global) VALUES ('fB', 'o2', NULL, 'Gym B Shake', 200, 10, 20, 5, 0)`);
  await db.run(`INSERT INTO foods (id, org_id, client_id, name, calories, protein, carbs, fat, is_global) VALUES ('fG', NULL, NULL, 'Rice', 150, 4, 32, 0, 1)`);
  await db.run(`INSERT INTO client_meal_templates (id, org_id, client_id, slot, name, position) VALUES ('mt1', 'o1', 'c1', 'Lunch', 'Lunch', 0)`);
  const api = await startMeApi(db, { id: 'u1', role: 'CLIENT', org_id: 'o1' });
  t.after(() => api.close());
  const bad = await api.call('POST', '/me/meals/mt1/items', { food_id: 'fB', quantity: 1 });
  assert.equal(bad.status, 404, 'another gym\'s food is not available to this client');
  const good = await api.call('POST', '/me/meals/mt1/items', { food_id: 'fG', quantity: 2 });
  assert.equal(good.status, 200, 'global food allowed');
  // meal totals recomputed: rice 150 kcal x 2
  const m = await db.q1(`SELECT * FROM client_meal_templates WHERE id = 'mt1'`);
  assert.equal(m.calories, 300, 'quantity-scaled calories');
  assert.equal(m.carbs, 64, 'quantity-scaled carbs');
  await api.close();
});

test('meal item quantity edits recompute totals', async (t) => {
  const db = await twoOrgFixture();
  const secret = 'test-secret';
  await db.run(`INSERT INTO foods (id, org_id, client_id, name, calories, protein, carbs, fat, is_global) VALUES ('fG', NULL, NULL, 'Poha', 250, 7, 40, 7, 1)`);
  await db.run(`INSERT INTO client_meal_templates (id, org_id, client_id, slot, name, position) VALUES ('mt1', 'o1', 'c1', 'Breakfast', 'Breakfast', 0)`);
  const api = await startMeApi(db, { id: 'u1', role: 'CLIENT', org_id: 'o1' });
  t.after(() => api.close());
  const added = await api.call('POST', '/me/meals/mt1/items', { food_id: 'fG', quantity: 1 });
  const items = await api.call('GET', '/me/meals/mt1/items');
  const itemId = items.json.items[0].id;
  await api.call('PUT', `/me/meals/mt1/items/${itemId}`, { quantity: 3 });
  const m = await db.q1(`SELECT * FROM client_meal_templates WHERE id = 'mt1'`);
  assert.equal(m.calories, 750, '3x poha = 750 kcal');
  assert.equal(m.protein, 21, '3x protein');
  const after = await api.call('DELETE', `/me/meals/mt1/items/${itemId}`);
  assert.equal(after.status, 200);
  const empty = await db.q1(`SELECT * FROM client_meal_templates WHERE id = 'mt1'`);
  assert.equal(empty.calories, 0, 'empty meal -> zeroed totals');
  await api.close();
});

// Regression coverage for a real bug found by inspection: PUT
// /me/meal-logs/:logId used to do `Math.max(0.1, Number(quantity))` with
// no finiteness check -- a non-numeric quantity produced NaN (Math.max
// with a NaN argument is ALWAYS NaN), which both node:sqlite and pg bind
// without erroring, silently overwriting that log entry's
// calories/protein/carbs/fat with NaN. Now caught by schema validation
// before the route ever runs.
test('PUT /me/meal-logs/:logId rejects a non-numeric quantity instead of silently storing NaN', async (t) => {
  const db = await twoOrgFixture();
  await db.run(`INSERT INTO foods (id, org_id, client_id, name, calories, protein, carbs, fat, is_global) VALUES ('fG', NULL, NULL, 'Rice', 150, 4, 32, 0, 1)`);
  await db.run(`INSERT INTO meal_logs (id, client_id, date, slot, name, calories, protein, carbs, fat, eaten, source, quantity, unit) VALUES ('mlg1', 'c1', '2026-01-01', 'Lunch', 'Rice', 150, 4, 32, 0, 1, 'manual', 100, 'g')`);
  const api = await startMeApi(db, { id: 'u1', role: 'CLIENT', org_id: 'o1' });
  t.after(() => api.close());

  const bad = await api.call('PUT', '/me/meal-logs/mlg1', { quantity: 'not-a-number' });
  assert.equal(bad.status, 422, 'a non-numeric quantity must be rejected, not coerced to NaN');

  const untouched = await db.q1(`SELECT * FROM meal_logs WHERE id = 'mlg1'`);
  assert.equal(untouched.calories, 150, 'the log entry must be completely untouched by the rejected request');
  assert.ok(!Number.isNaN(untouched.calories));
  await api.close();
});

// Regression coverage: a malformed ai_estimate payload (wrong type on a
// numeric field) must be rejected by schema validation, not silently
// coerced (e.g. the old `Number(ai_estimate.grams) || 100` fallback would
// have quietly substituted 100g for whatever nonsense was actually sent).
test('POST /me/meals/:id/items rejects a malformed ai_estimate payload (wrong type on a numeric field)', async (t) => {
  const db = await twoOrgFixture();
  await db.run(`INSERT INTO client_meal_templates (id, org_id, client_id, slot, name, position) VALUES ('mt1', 'o1', 'c1', 'Lunch', 'Lunch', 0)`);
  const api = await startMeApi(db, { id: 'u1', role: 'CLIENT', org_id: 'o1' });
  t.after(() => api.close());

  const bad = await api.call('POST', '/me/meals/mt1/items', { ai_estimate: { name: 'Bad Item', grams: 'a lot', calories: 200 } });
  assert.equal(bad.status, 422, 'a non-numeric grams value must be rejected outright');

  const items = await db.q(`SELECT * FROM meal_items WHERE meal_template_id = 'mt1'`);
  assert.equal(items.length, 0, 'nothing should have been inserted from the rejected request');
  await api.close();
});

test('client cannot log or delete another client\'s metric entries', async (t) => {
  const db = await twoOrgFixture();
  const secret = 'test-secret';
  await db.run(`INSERT INTO custom_metrics (id, org_id, client_id, name, frequency, created_at) VALUES ('m1', 'o1', 'c1', 'Waist', 'weekly', '2026-01-01T00:00:00Z')`);
  await db.run(`INSERT INTO custom_metrics (id, org_id, client_id, name, frequency, created_at) VALUES ('m2', 'o2', 'c2', 'Waist', 'weekly', '2026-01-01T00:00:00Z')`);
  await db.run(`INSERT INTO metric_entries (id, org_id, client_id, metric_id, value, date, created_at) VALUES ('e1', 'o2', 'c2', 'm2', 90, '2026-08-01', '2026-08-01T00:00:00Z')`);
  const api = await startMeApi(db, { id: 'u1', role: 'CLIENT', org_id: 'o1' });
  t.after(() => api.close());
  const forge = await api.call('POST', '/me/metrics/m2/entries', { value: 88 });
  assert.equal(forge.status, 404, 'cannot write to another client\'s metric');
  const del = await api.call('DELETE', '/me/metrics/m2/entries/e1');
  assert.equal(del.status, 404, 'cannot delete another client\'s entry');
  // own metric still works
  const own = await api.call('POST', '/me/metrics/m1/entries', { value: 87 });
  assert.equal(own.status, 200);
  await api.close();
});

test('metric create supports types and edit; boolean logs 0/1', async (t) => {
  const db = await twoOrgFixture();
  const secret = 'test-secret';
  const api = await startMeApi(db, { id: 'u1', role: 'CLIENT', org_id: 'o1' });
  t.after(() => api.close());
  const created = await api.call('POST', '/me/metrics', { name: 'Cardio done', type: 'boolean', frequency: 'daily' });
  assert.equal(created.status, 200);
  const mid = created.json.id;
  const boo = await api.call('POST', `/me/metrics/${mid}/entries`, { value: 1 });
  assert.equal(boo.status, 200);
  const upd = await api.call('PUT', `/me/metrics/${mid}`, { name: 'Cardio', unit: 'yes/no' });
  assert.equal(upd.status, 200);
  const list = await api.call('GET', '/me/metrics');
  const m = list.json.metrics.find((x) => x.id === mid);
  assert.equal(m.name, 'Cardio');
  assert.equal(m.type, 'boolean');
  assert.equal(m.latest.value, 1);
  await api.close();
});

test('gym settings defaults apply when no row exists (hybrid mode, permissions on)', async (t) => {
  const db = await twoOrgFixture();
  const secret = 'test-secret';
  const api = await startMeApi(db, { id: 'u1', role: 'CLIENT', org_id: 'o1' });
  t.after(() => api.close());
  const perms = await api.call('GET', '/me/permissions');
  assert.equal(perms.status, 200);
  assert.equal(perms.json.workout_mode, 'hybrid');
  assert.equal(perms.json.allow_substitute, true);
  assert.equal(perms.json.can_create_workout, true);
  await api.close();
});
