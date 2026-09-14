// ============================================================
// ACTIVATION MILESTONES -- signed up, finished onboarding, logged a first
// workout, logged a first meal.
//
// Signup already records an event on every path (auth.js, enrollment.js).
// The other three could not be answered from the event log:
//
//   - Finishing the onboarding wizard wrote only 'client_profile_updated',
//     the same event every later Settings save writes.
//   - Every workout and meal writes its own event, but under several types
//     (workout_completed, intel_workout_logged, cardio_logged; meal_logged,
//     intel_food_logged) and, when a trainer logs on a client's behalf,
//     under the trainer's user id. "When did this member first ..." meant
//     reconstructing it from all of them.
//
// Each milestone is now written once per member, the moment it becomes
// true, under the member's own user id.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const ts = '2026-01-01T00:00:00Z';
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(schema);
  // Columns later migrations added to meal_logs, which schema.sql predates
  // and POST /nutrition/clients/:id/meals/log writes.
  for (const ddl of ['ai_provider TEXT', 'ai_model TEXT', 'ai_confidence TEXT', 'quantity REAL', 'unit TEXT', 'unit_type TEXT', 'meal_template_id TEXT']) {
    try { raw.exec(`ALTER TABLE meal_logs ADD COLUMN ${ddl}`); } catch { /* already in schema.sql */ }
  }
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, p = []) { const st = raw.prepare(sql); return p.length ? st.all(...p) : st.all(); },
    async q1(sql, p = []) { const rows = await mk().q(sql, p); return rows[0] || null; },
    async run(sql, p = []) { const st = raw.prepare(sql); const r = p.length ? st.run(...p) : st.run(); return { changes: Number(r.changes) }; },
    async tx(fn) { return fn(mk()); },
    raw,
  });
  return mk();
}

async function startApi() {
  const express = (await import('express')).default;
  const jwt = (await import('jsonwebtoken')).default;
  const { config } = await import('../src/config.js');
  const meRoutes = (await import('../src/routes/me.js')).default;
  const nutritionRoutes = (await import('../src/routes/nutrition.js')).default;
  const workoutRoutes = (await import('../src/routes/workouts.js')).default;
  const { resetRateLimits } = await import('../src/rateLimit.js');
  resetRateLimits();

  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Gym', 'gym', ts]);
  await db.run(`INSERT INTO exercise_library (id, org_id, name, primary_muscle, equipment, is_global)
                VALUES ('ex_bench', NULL, 'Bench Press', 'chest', 'barbell', 1)`);
  for (const [u, c, mail] of [['u1', 'c1', 'a@x.in'], ['u2', 'c2', 'b@x.in']]) {
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                  VALUES (?,'o1',?,'x','CLIENT','C',1,?)`, [u, mail, ts]);
    await db.run('INSERT INTO clients (id, user_id, org_id, created_at) VALUES (?,?,?,?)', [c, u, 'o1', ts]);
  }
  const app = express();
  app.use(express.json());
  app.use('/api/me', meRoutes(db));
  app.use('/api/nutrition', nutritionRoutes(db));
  app.use('/api/workouts', workoutRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = (method, url, { as = 'u1', body } = {}) => fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt.sign({ sub: as, role: 'CLIENT', org: 'o1', name: 'C', email: `${as}@x.in` }, config.jwtSecret)}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const count = async (type, userId) => Number((await db.q1(
    'SELECT COUNT(*) AS n FROM events WHERE type = ? AND user_id = ?', [type, userId])).n);
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, count, close };
}

/** Creates a session through POST /me/workouts and completes it, as the Workout page does. */
async function logWorkout({ db, call }, as = 'u1', clientId = 'c1') {
  const created = await call('POST', '/api/me/workouts', {
    as, body: { name: 'Push', exercises: [{ exercise_id: 'ex_bench', sets: 3, reps: 8 }] },
  });
  assert.equal(created.status < 300, true, `create workout: ${created.status}`);
  const w = await db.q1(
    "SELECT id FROM workouts WHERE client_id = ? AND status = 'assigned' ORDER BY created_at DESC LIMIT 1", [clientId]);
  const wxe = await db.q1('SELECT id FROM workout_exercises WHERE workout_id = ?', [w.id]);
  const done = await call('POST', `/api/workouts/${w.id}/complete`, {
    as, body: { logs: [{ exercise_id: wxe.id, sets: [{ set_number: 1, actual_reps: 8, actual_weight: 40, completed: true }] }], duration_seconds: 1800 },
  });
  assert.equal(done.status, 200, `complete workout: ${done.status}`);
  return w.id;
}

const meal = (name) => ({ name, calories: 300, protein: 10, carbs: 50, fat: 5, source: 'manual', eaten: true });

test('finishing the onboarding wizard is recorded once; later profile saves are not', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  // The wizard's own request (OnboardingWizard.jsx handleSubmit).
  const wizard = await api.call('PUT', '/api/me/profile', {
    body: { name: 'Asha', sex: 'FEMALE', height_cm: 165, current_weight: 60, age: 30, goal: 'FAT_LOSS', experience: 'BEGINNER', unit_system: 'metric', onboarding_completed: true },
  });
  assert.equal(wizard.status, 200);
  assert.equal(await api.count('onboarding_completed', 'u1'), 1);

  // Settings saves afterwards, including one that repeats the flag.
  assert.equal((await api.call('PUT', '/api/me/profile', { body: { unit_system: 'imperial' } })).status, 200);
  assert.equal((await api.call('PUT', '/api/me/profile', { body: { goal: 'STRENGTH', onboarding_completed: true } })).status, 200);
  assert.equal(await api.count('onboarding_completed', 'u1'), 1);
  // The generic event cannot tell these apart -- which is why the milestone exists.
  assert.equal(await api.count('client_profile_updated', 'u1'), 3);
});

test('the first meal is recorded once per member, not once per meal', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  for (const name of ['Oats', 'Dal rice']) {
    assert.equal((await api.call('POST', '/api/nutrition/clients/c1/meals/log', { body: meal(name) })).status, 201);
  }
  assert.equal(await api.count('meal_logged', 'u1'), 2);
  assert.equal(await api.count('first_meal_logged', 'u1'), 1);

  assert.equal(await api.count('first_meal_logged', 'u2'), 0);
  assert.equal((await api.call('POST', '/api/nutrition/clients/c2/meals/log', { as: 'u2', body: meal('Eggs') })).status, 201);
  assert.equal(await api.count('first_meal_logged', 'u2'), 1);
});

test('a meal logged as not eaten is not a first meal', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  assert.equal((await api.call('POST', '/api/nutrition/clients/c1/meals/log', { body: { ...meal('Planned'), eaten: false } })).status, 201);
  assert.equal(await api.count('first_meal_logged', 'u1'), 0);
  assert.equal((await api.call('POST', '/api/nutrition/clients/c1/meals/log', { body: meal('Eaten') })).status, 201);
  assert.equal(await api.count('first_meal_logged', 'u1'), 1);
});

test('the first completed workout is recorded once, and not again after delete and relog', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const first = await logWorkout(api);
  assert.equal(await api.count('workout_completed', 'u1'), 1);
  assert.equal(await api.count('first_workout_logged', 'u1'), 1);

  await logWorkout(api);
  assert.equal(await api.count('first_workout_logged', 'u1'), 1);

  // Deleting every session and logging again leaves the member with one
  // completed workout -- but they were already activated.
  const rows = await api.db.q("SELECT id FROM workouts WHERE client_id = 'c1'");
  for (const r of rows) assert.equal((await api.call('DELETE', `/api/me/workouts/${r.id}`)).status < 300, true);
  assert.ok(first);
  await logWorkout(api);
  assert.equal(await api.count('first_workout_logged', 'u1'), 1);
});

test('a cardio session counts as a first workout, as it does for the training streak', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const bout = await api.call('POST', '/api/me/cardio', {
    body: { activity_id: 'badminton', activity_name: 'Badminton', duration_sec: 45 * 60, effort: 'moderate', kcal: 325, source: 'manual_retroactive', date: daysAgo(2) },
  });
  assert.equal(bout.status, 201);
  assert.equal(await api.count('first_workout_logged', 'u1'), 1);

  await logWorkout(api);
  assert.equal(await api.count('first_workout_logged', 'u1'), 1);
});
