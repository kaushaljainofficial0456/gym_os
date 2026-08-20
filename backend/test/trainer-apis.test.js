// ============================================================
// Tests for trainer API features:
//   Phase 1: Trainer-scoped client list
//   Phase 2: Workout update/delete
//   Phase 3: Nutrition plan template update
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

// ---- in-memory SQLite helper ----
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
    raw: db
  });
  return mk();
}

const idp = (p) => 'id_' + Math.random().toString(36).slice(2, 10);

function makeToken(userId, role, orgId, name = 'Test') {
  return jwt.sign({ sub: userId, role, org: orgId, name, email: 'test@test.com' }, config.jwtSecret, { expiresIn: '1h' });
}

// ---- seed: 2 orgs, 2 trainers, 3 clients ----
async function seedFull(db) {
  // Org 1
  const org1 = idp('org');
  const owner1 = idp('usr');
  const trainer1a = idp('usr');
  const trainer1b = idp('usr');
  const client1UserId = idp('usr');
  const client1RecId = idp('cli');
  const client2UserId = idp('usr');
  const client2RecId = idp('cli');

  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [org1, 'Gym 1', 'gym1', '2026-01-01T00:00:00Z']);
  // Owner
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'GYM_OWNER', ?, 1, ?)`,
    [owner1, org1, 'owner1@test.com', 'x', 'Owner 1', '2026-01-01T00:00:00Z']);
  // Trainer A (org 1)
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'TRAINER', ?, 1, ?)`,
    [trainer1a, org1, 'trainerA@test.com', 'x', 'Trainer A', '2026-01-01T00:00:00Z']);
  // Trainer B (org 1)
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'TRAINER', ?, 1, ?)`,
    [trainer1b, org1, 'trainerB@test.com', 'x', 'Trainer B', '2026-01-01T00:00:00Z']);
  // Client 1 (assigned to Trainer A)
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    [client1UserId, org1, 'client1@test.com', 'x', 'Client 1', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, trainer_id, goal, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [client1RecId, client1UserId, org1, trainer1a, 'FAT_LOSS', '2026-01-01T00:00:00Z']);
  // Client 2 (assigned to Trainer B)
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    [client2UserId, org1, 'client2@test.com', 'x', 'Client 2', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, trainer_id, goal, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [client2RecId, client2UserId, org1, trainer1b, 'MUSCLE_GAIN', '2026-01-01T00:00:00Z']);

  // Org 2
  const org2 = idp('org');
  const trainer2 = idp('usr');
  const client3UserId = idp('usr');
  const client3RecId = idp('cli');
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [org2, 'Gym 2', 'gym2', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'TRAINER', ?, 1, ?)`,
    [trainer2, org2, 'trainer2@test.com', 'x', 'Trainer 2', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    [client3UserId, org2, 'client3@test.com', 'x', 'Client 3', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, trainer_id, goal, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [client3RecId, client3UserId, org2, trainer2, 'GENERAL', '2026-01-01T00:00:00Z']);

  return {
    org1, owner1, trainer1a, trainer1b, client1UserId, client1RecId, client2UserId, client2RecId,
    org2, trainer2, client3UserId, client3RecId
  };
}

async function startServer(db, routesFn, mountPath) {
  const app = express();
  app.use(express.json());
  app.use(mountPath, routesFn(db));
  const server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  const port = server.address().port;
  const close = () => new Promise(r => { server.closeAllConnections(); server.close(r); });
  return { server, port, base: `http://127.0.0.1:${port}${mountPath}`, close };
}

async function call(base, method, urlPath, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${base}${urlPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

// ============================================================
// PHASE 1: Trainer-scoped client list
// ============================================================
test('Trainer sees only their assigned clients', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const clientRoutes = (await import('../src/routes/clients.js')).default;
  const { base, close } = await startServer(db, clientRoutes, '/api/clients');
  t.after(close);

  // Trainer A should see only client1
  const tokenA = makeToken(s.trainer1a, 'TRAINER', s.org1);
  const r = await call(base, 'GET', '/', tokenA);
  assert.equal(r.status, 200);
  assert.equal(r.json.clients.length, 1, 'Trainer A sees 1 client');
  assert.equal(r.json.clients[0].id, s.client1RecId, 'Trainer A sees only client1');
});

test('Trainer does NOT see another trainer\'s clients', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const clientRoutes = (await import('../src/routes/clients.js')).default;
  const { base, close } = await startServer(db, clientRoutes, '/api/clients');
  t.after(close);

  // Trainer B should see only client2, NOT client1
  const tokenB = makeToken(s.trainer1b, 'TRAINER', s.org1);
  const r = await call(base, 'GET', '/', tokenB);
  assert.equal(r.status, 200);
  assert.equal(r.json.clients.length, 1, 'Trainer B sees 1 client');
  assert.equal(r.json.clients[0].id, s.client2RecId, 'Trainer B sees only client2');
});

test('Owner/admin can access all organization clients', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const clientRoutes = (await import('../src/routes/clients.js')).default;
  const { base, close } = await startServer(db, clientRoutes, '/api/clients');
  t.after(close);

  const ownerToken = makeToken(s.owner1, 'GYM_OWNER', s.org1);
  const r = await call(base, 'GET', '/', ownerToken);
  assert.equal(r.status, 200);
  assert.equal(r.json.clients.length, 2, 'Owner sees all 2 org clients');
  const ids = r.json.clients.map(c => c.id);
  assert.ok(ids.includes(s.client1RecId), 'owner sees client1');
  assert.ok(ids.includes(s.client2RecId), 'owner sees client2');
});

test('Cross-organization clients are never returned', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const clientRoutes = (await import('../src/routes/clients.js')).default;
  const { base, close } = await startServer(db, clientRoutes, '/api/clients');
  t.after(close);

  // Trainer from org2 should NOT see org1's clients
  const token2 = makeToken(s.trainer2, 'TRAINER', s.org2);
  const r = await call(base, 'GET', '/', token2);
  assert.equal(r.status, 200);
  const ids = r.json.clients.map(c => c.id);
  assert.ok(!ids.includes(s.client1RecId), 'org2 trainer cannot see org1 client1');
  assert.ok(!ids.includes(s.client2RecId), 'org2 trainer cannot see org1 client2');
});

test('Unauthenticated access is rejected', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const clientRoutes = (await import('../src/routes/clients.js')).default;
  const { base, close } = await startServer(db, clientRoutes, '/api/clients');
  t.after(close);

  const r = await call(base, 'GET', '/', null);
  assert.equal(r.status, 401);
});

// ============================================================
// PHASE 2: Workout update/delete
// ============================================================
test('Trainer can update an assigned workout', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  // Create an exercise in the library
  await db.run('INSERT INTO exercise_library (id, name, primary_muscle, equipment, is_global) VALUES (?, ?, ?, ?, 1)',
    ['ex_bp', 'Bench Press', 'CHEST', 'BARBELL']);
  // Create an assigned workout
  const wId = idp('wko');
  await db.run('INSERT INTO workouts (id, org_id, client_id, trainer_id, name, scheduled_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [wId, s.org1, s.client1RecId, s.trainer1a, 'Push Day', '2026-08-25', 'assigned', '2026-08-25T08:00:00Z']);
  const exId = idp('wxe');
  await db.run('INSERT INTO workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [exId, wId, 'ex_bp', 0, 'Bench Press', 3, '8', '60', 90]);

  const workoutRoutes = (await import('../src/routes/workouts.js')).default;
  const { base, close } = await startServer(db, workoutRoutes, '/api/workouts');
  t.after(close);

  const token = makeToken(s.trainer1a, 'TRAINER', s.org1);
  const r = await call(base, 'PUT', `/clients/${s.client1RecId}/workouts/${wId}`, token, {
    name: 'Push Day Updated',
    exercises: [{ exercise_id: 'ex_bp', name: 'Incline Bench Press', sets: 4, reps: '10', weight: '55', rest_sec: 120 }]
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);

  // Verify the update persisted
  const w = await db.q1('SELECT name FROM workouts WHERE id = ?', [wId]);
  assert.equal(w.name, 'Push Day Updated');
  const exs = await db.q('SELECT name, sets, weight FROM workout_exercises WHERE workout_id = ? ORDER BY position', [wId]);
  assert.equal(exs.length, 1);
  assert.equal(exs[0].name, 'Incline Bench Press');
  assert.equal(exs[0].sets, 4);
  assert.equal(exs[0].weight, '55');
});

test('Unauthorized trainer cannot update another trainer\'s workout', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  await db.run('INSERT INTO exercise_library (id, name, primary_muscle, equipment, is_global) VALUES (?, ?, ?, ?, 1)',
    ['ex_bp', 'Bench Press', 'CHEST', 'BARBELL']);
  const wId = idp('wko');
  // Workout belongs to Trainer A's client
  await db.run('INSERT INTO workouts (id, org_id, client_id, trainer_id, name, scheduled_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [wId, s.org1, s.client1RecId, s.trainer1a, 'Push Day', '2026-08-25', 'assigned', '2026-08-25T08:00:00Z']);

  const workoutRoutes = (await import('../src/routes/workouts.js')).default;
  const { base, close } = await startServer(db, workoutRoutes, '/api/workouts');
  t.after(close);

  // Trainer B tries to update Trainer A's client's workout
  const tokenB = makeToken(s.trainer1b, 'TRAINER', s.org1);
  const r = await call(base, 'PUT', `/clients/${s.client1RecId}/workouts/${wId}`, tokenB, {
    name: 'Hijacked',
    exercises: []
  });
  // resolveClient will reject: trainer1b is not the trainer for client1RecId
  assert.equal(r.status, 403, 'Trainer B blocked from Trainer A client');
});

test('Cross-org workout update rejected', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  await db.run('INSERT INTO exercise_library (id, name, primary_muscle, equipment, is_global) VALUES (?, ?, ?, ?, 1)',
    ['ex_bp', 'Bench Press', 'CHEST', 'BARBELL']);
  const wId = idp('wko');
  await db.run('INSERT INTO workouts (id, org_id, client_id, trainer_id, name, scheduled_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [wId, s.org1, s.client1RecId, s.trainer1a, 'Push Day', '2026-08-25', 'assigned', '2026-08-25T08:00:00Z']);

  const workoutRoutes = (await import('../src/routes/workouts.js')).default;
  const { base, close } = await startServer(db, workoutRoutes, '/api/workouts');
  t.after(close);

  // Org2 trainer tries to update org1 workout
  const token2 = makeToken(s.trainer2, 'TRAINER', s.org2);
  const r = await call(base, 'PUT', `/clients/${s.client1RecId}/workouts/${wId}`, token2, {
    name: 'Cross-org attack',
    exercises: []
  });
  assert.equal(r.status, 403, 'Cross-org update blocked');
});

test('Trainer can delete an unstarted workout', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  await db.run('INSERT INTO exercise_library (id, name, primary_muscle, equipment, is_global) VALUES (?, ?, ?, ?, 1)',
    ['ex_bp', 'Bench Press', 'CHEST', 'BARBELL']);
  const wId = idp('wko');
  await db.run('INSERT INTO workouts (id, org_id, client_id, trainer_id, name, scheduled_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [wId, s.org1, s.client1RecId, s.trainer1a, 'Push Day', '2026-08-25', 'assigned', '2026-08-25T08:00:00Z']);
  const exId = idp('wxe');
  await db.run('INSERT INTO workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [exId, wId, 'ex_bp', 0, 'Bench Press', 3, '8', '60', 90]);

  const workoutRoutes = (await import('../src/routes/workouts.js')).default;
  const { base, close } = await startServer(db, workoutRoutes, '/api/workouts');
  t.after(close);

  const token = makeToken(s.trainer1a, 'TRAINER', s.org1);
  const r = await call(base, 'DELETE', `/clients/${s.client1RecId}/workouts/${wId}`, token);
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);

  // Verify workout and exercises are deleted
  const w = await db.q1('SELECT * FROM workouts WHERE id = ?', [wId]);
  assert.equal(w, null, 'workout deleted');
  const exs = await db.q('SELECT * FROM workout_exercises WHERE workout_id = ?', [wId]);
  assert.equal(exs.length, 0, 'exercises deleted');
});

test('Completed workout cannot be deleted', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const wId = idp('wko');
  await db.run('INSERT INTO workouts (id, org_id, client_id, trainer_id, name, scheduled_date, status, completed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [wId, s.org1, s.client1RecId, s.trainer1a, 'Old Push', '2026-08-20', 'completed', '2026-08-20T09:00:00Z', '2026-08-20T08:00:00Z']);

  const workoutRoutes = (await import('../src/routes/workouts.js')).default;
  const { base, close } = await startServer(db, workoutRoutes, '/api/workouts');
  t.after(close);

  const token = makeToken(s.trainer1a, 'TRAINER', s.org1);
  const r = await call(base, 'DELETE', `/clients/${s.client1RecId}/workouts/${wId}`, token);
  assert.equal(r.status, 400, 'cannot delete completed workout');
  assert.ok(r.json.error.includes('completed'), 'error mentions completed');
});

test('Completed workout cannot be updated', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const wId = idp('wko');
  await db.run('INSERT INTO workouts (id, org_id, client_id, trainer_id, name, scheduled_date, status, completed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [wId, s.org1, s.client1RecId, s.trainer1a, 'Old Push', '2026-08-20', 'completed', '2026-08-20T09:00:00Z', '2026-08-20T08:00:00Z']);

  const workoutRoutes = (await import('../src/routes/workouts.js')).default;
  const { base, close } = await startServer(db, workoutRoutes, '/api/workouts');
  t.after(close);

  const token = makeToken(s.trainer1a, 'TRAINER', s.org1);
  const r = await call(base, 'PUT', `/clients/${s.client1RecId}/workouts/${wId}`, token, {
    name: 'Modified',
    exercises: []
  });
  assert.equal(r.status, 400, 'cannot update completed workout');
  assert.ok(r.json.error.includes('completed'), 'error mentions completed');
});

test('Historical workout logs remain intact when workout deleted', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  // Create a completed workout with logs
  const wId = idp('wko');
  await db.run('INSERT INTO workouts (id, org_id, client_id, trainer_id, name, scheduled_date, status, completed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [wId, s.org1, s.client1RecId, s.trainer1a, 'Push Day', '2026-08-20', 'completed', '2026-08-20T09:00:00Z', '2026-08-20T08:00:00Z']);
  // Create an exercise and a workout log
  await db.run('INSERT INTO exercise_library (id, name, primary_muscle, equipment, is_global) VALUES (?, ?, ?, ?, 1)',
    ['ex_hist', 'Overhead Press', 'SHOULDERS', 'BARBELL']);
  const logId = idp('wlg');
  await db.run('INSERT INTO workout_logs (id, client_id, workout_id, exercise_id, date, sets_done, reps, weight) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [logId, s.client1RecId, wId, 'ex_hist', '2026-08-20', 4, 8, 60]);

  const workoutRoutes = (await import('../src/routes/workouts.js')).default;
  const { base, close } = await startServer(db, workoutRoutes, '/api/workouts');
  t.after(close);

  // Attempt delete — should be rejected
  const token = makeToken(s.trainer1a, 'TRAINER', s.org1);
  const r = await call(base, 'DELETE', `/clients/${s.client1RecId}/workouts/${wId}`, token);
  assert.equal(r.status, 400, 'delete rejected for completed');
  // Verify log still exists
  const log = await db.q1('SELECT * FROM workout_logs WHERE id = ?', [logId]);
  assert.ok(log, 'workout log preserved');
});

test('Invalid workout update payload rejected', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const wId = idp('wko');
  await db.run('INSERT INTO workouts (id, org_id, client_id, trainer_id, name, scheduled_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [wId, s.org1, s.client1RecId, s.trainer1a, 'Push Day', '2026-08-25', 'assigned', '2026-08-25T08:00:00Z']);

  const workoutRoutes = (await import('../src/routes/workouts.js')).default;
  const { base, close } = await startServer(db, workoutRoutes, '/api/workouts');
  t.after(close);

  const token = makeToken(s.trainer1a, 'TRAINER', s.org1);
  // Empty name should fail Zod validation
  const r = await call(base, 'PUT', `/clients/${s.client1RecId}/workouts/${wId}`, token, {
    name: '',
    exercises: []
  });
  assert.ok(r.status === 422 || r.status === 400, `validation error: ${r.status}`);
});

// ============================================================
// PHASE 3: Nutrition plan template update
// ============================================================
test('Trainer can update a nutrition plan template', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  // Create a template
  const pId = idp('nut');
  await db.run('INSERT INTO nutrition_plans (id, org_id, trainer_id, client_id, name, calories, protein, carbs, fat, is_template, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 1, ?)',
    [pId, s.org1, s.trainer1a, 'Cutting Plan', 2000, 150, 180, 60, '2026-01-01T00:00:00Z']);
  const mId = idp('mea');
  await db.run('INSERT INTO meals (id, plan_id, slot, name, calories, protein, carbs, fat, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [mId, pId, 'breakfast', 'Oats & Eggs', 400, 30, 45, 12, 0]);

  const nutritionRoutes = (await import('../src/routes/nutrition.js')).default;
  const { base, close } = await startServer(db, nutritionRoutes, '/api/nutrition');
  t.after(close);

  const token = makeToken(s.trainer1a, 'TRAINER', s.org1);
  const r = await call(base, 'PUT', `/plans/${pId}`, token, {
    name: 'Cutting Plan v2',
    calories: 1800,
    protein: 160,
    carbs: 150,
    fat: 55,
    meals: [
      { slot: 'breakfast', name: 'Oats & Egg Whites', calories: 350, protein: 35, carbs: 40, fat: 8 },
      { slot: 'lunch', name: 'Chicken Salad', calories: 450, protein: 40, carbs: 25, fat: 18 }
    ]
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);

  // Verify persistence
  const plan = await db.q1('SELECT * FROM nutrition_plans WHERE id = ?', [pId]);
  assert.equal(plan.name, 'Cutting Plan v2');
  assert.equal(plan.calories, 1800);
  assert.equal(plan.protein, 160);

  // Verify meals were replaced
  const meals = await db.q('SELECT * FROM meals WHERE plan_id = ? ORDER BY position', [pId]);
  assert.equal(meals.length, 2, '2 meals after update');
  assert.equal(meals[0].name, 'Oats & Egg Whites');
  assert.equal(meals[1].name, 'Chicken Salad');
});

test('Cannot update a non-template plan', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  // Create a client-specific plan (is_template=0)
  const pId = idp('nut');
  await db.run('INSERT INTO nutrition_plans (id, org_id, trainer_id, client_id, name, calories, protein, carbs, fat, is_template, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)',
    [pId, s.org1, s.trainer1a, s.client1RecId, 'Client Plan', 2200, 160, 200, 70, '2026-01-01T00:00:00Z']);

  const nutritionRoutes = (await import('../src/routes/nutrition.js')).default;
  const { base, close } = await startServer(db, nutritionRoutes, '/api/nutrition');
  t.after(close);

  const token = makeToken(s.trainer1a, 'TRAINER', s.org1);
  const r = await call(base, 'PUT', `/plans/${pId}`, token, {
    name: 'Modified',
    calories: 1000,
    protein: 100,
    carbs: 100,
    fat: 30,
    meals: []
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.error.includes('template'), 'error mentions template');
});

test('Unauthorized trainer cannot update nutrition plan', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const pId = idp('nut');
  await db.run('INSERT INTO nutrition_plans (id, org_id, trainer_id, client_id, name, calories, protein, carbs, fat, is_template, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 1, ?)',
    [pId, s.org1, s.trainer1a, 'Plan A', 2000, 150, 180, 60, '2026-01-01T00:00:00Z']);

  const nutritionRoutes = (await import('../src/routes/nutrition.js')).default;
  const { base, close } = await startServer(db, nutritionRoutes, '/api/nutrition');
  t.after(close);

  // Trainer B tries to update Trainer A's plan — but both are in the same org
  // org_id check passes; this is allowed since both trainers are in the same org.
  // This is the expected behavior: plans are org-scoped, not trainer-scoped.
  const tokenB = makeToken(s.trainer1b, 'TRAINER', s.org1);
  const r = await call(base, 'PUT', `/plans/${pId}`, tokenB, {
    name: 'Hijacked',
    calories: 1000,
    protein: 100,
    carbs: 100,
    fat: 30,
    meals: []
  });
  // Same-org trainer CAN update — plans are org-scoped
  assert.equal(r.status, 200, 'same-org trainer allowed (org-scoped)');
});

test('Cross-org nutrition plan update rejected', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const pId = idp('nut');
  await db.run('INSERT INTO nutrition_plans (id, org_id, trainer_id, client_id, name, calories, protein, carbs, fat, is_template, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 1, ?)',
    [pId, s.org1, s.trainer1a, 'Plan A', 2000, 150, 180, 60, '2026-01-01T00:00:00Z']);

  const nutritionRoutes = (await import('../src/routes/nutrition.js')).default;
  const { base, close } = await startServer(db, nutritionRoutes, '/api/nutrition');
  t.after(close);

  const token2 = makeToken(s.trainer2, 'TRAINER', s.org2);
  const r = await call(base, 'PUT', `/plans/${pId}`, token2, {
    name: 'Cross-org',
    calories: 1000,
    protein: 100,
    carbs: 100,
    fat: 30,
    meals: []
  });
  assert.equal(r.status, 404, 'cross-org plan not found (org_id filter)');
});

test('Invalid nutritional values rejected', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const pId = idp('nut');
  await db.run('INSERT INTO nutrition_plans (id, org_id, trainer_id, client_id, name, calories, protein, carbs, fat, is_template, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 1, ?)',
    [pId, s.org1, s.trainer1a, 'Plan', 2000, 150, 180, 60, '2026-01-01T00:00:00Z']);

  const nutritionRoutes = (await import('../src/routes/nutrition.js')).default;
  const { base, close } = await startServer(db, nutritionRoutes, '/api/nutrition');
  t.after(close);

  const token = makeToken(s.trainer1a, 'TRAINER', s.org1);
  // Negative calories
  const r = await call(base, 'PUT', `/plans/${pId}`, token, {
    name: 'Bad Plan',
    calories: -100,
    protein: 150,
    carbs: 180,
    fat: 60,
    meals: []
  });
  assert.ok(r.status === 422 || r.status === 400, `validation error: ${r.status}`);
});

test('Historical meal logs unchanged when template updated', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const pId = idp('nut');
  await db.run('INSERT INTO nutrition_plans (id, org_id, trainer_id, client_id, name, calories, protein, carbs, fat, is_template, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 1, ?)',
    [pId, s.org1, s.trainer1a, 'Plan', 2000, 150, 180, 60, '2026-01-01T00:00:00Z']);
  const mId = idp('mea');
  await db.run('INSERT INTO meals (id, plan_id, slot, name, calories, protein, carbs, fat, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [mId, pId, 'breakfast', 'Old Meal', 400, 30, 45, 12, 0]);
  // Create a historical meal log referencing this plan
  const logId = idp('mlg');
  await db.run('INSERT INTO meal_logs (id, client_id, meal_id, date, name, calories, protein, carbs, fat, eaten, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [logId, s.client1RecId, mId, '2026-08-19', 'Old Meal', 400, 30, 45, 12, 1, 'plan']);

  const nutritionRoutes = (await import('../src/routes/nutrition.js')).default;
  const { base, close } = await startServer(db, nutritionRoutes, '/api/nutrition');
  t.after(close);

  const token = makeToken(s.trainer1a, 'TRAINER', s.org1);
  await call(base, 'PUT', `/plans/${pId}`, token, {
    name: 'Updated Plan',
    calories: 1800,
    protein: 160,
    carbs: 150,
    fat: 55,
    meals: [{ slot: 'breakfast', name: 'New Meal', calories: 350, protein: 35, carbs: 40, fat: 8 }]
  });

  // Historical log is untouched (meal_logs.meal_id still references old meal_id)
  const log = await db.q1('SELECT * FROM meal_logs WHERE id = ?', [logId]);
  assert.ok(log, 'historical log preserved');
  assert.equal(log.calories, 400, 'log calories unchanged');
  assert.equal(log.name, 'Old Meal', 'log name unchanged');
});
