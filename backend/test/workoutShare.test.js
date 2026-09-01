// ============================================================
// WORKOUT SHARING — comprehensive test suite.
//
// Covers: share creation, public preview, import (all destinations),
// cross-account security, duplicate handling, exercise library
// resolution, and transaction safety.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import jwt from 'jsonwebtoken';
import { resetRateLimits } from '../src/rateLimit.js';
import { id, now } from '../src/ids.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const JWT_SECRET = 'test-secret-workout-share';

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  return {
    driver: 'sqlite',
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await this.q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
    async tx(fn) {
      db.exec('BEGIN');
      const tx = {
        async q(sql, p = []) { return db.prepare(sql).all(...p); },
        async q1(sql, p = []) { const r = db.prepare(sql).all(...p); return r[0] || null; },
        async run(sql, p = []) { const r = db.prepare(sql).run(...p); return { changes: Number(r.changes) }; },
      };
      try { const result = await fn(tx); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    raw: db,
  };
}

function signToken(user) {
  return jwt.sign(user, JWT_SECRET, { expiresIn: '1h' });
}

async function seedOrgClient(db, suffix = '1') {
  const orgId = `org_${suffix}`;
  const clientId = `cl_${suffix}`;
  const userId = `usr_${suffix}`;
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [orgId, `Org ${suffix}`, `org-${suffix}`, now()]);
  await db.run('INSERT INTO users (id, org_id, email, password_hash, role, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [userId, orgId, `user${suffix}@test.com`, 'hash', 'CLIENT', `User ${suffix}`, now()]);
  await db.run('INSERT INTO clients (id, user_id, org_id, created_at) VALUES (?, ?, ?, ?)', [clientId, userId, orgId, now()]);
  return { orgId, clientId, userId };
}

async function seedExerciseLibrary(db, orgId) {
  const exId = 'ex_' + Math.random().toString(36).slice(2, 8);
  await db.run(
    'INSERT INTO exercise_library (id, org_id, name, primary_muscle, equipment, movement, ex_type, difficulty, is_global) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)',
    [exId, orgId, 'Bench Press', 'Chest', 'Barbell', 'horizontal_push', 'compound', 'BEGINNER']);
  return exId;
}

async function createPlannerWorkout(db, clientId, orgId, exerciseId, name = 'Push Day') {
  const wId = id('cw');
  await db.run('INSERT INTO client_workouts (id, org_id, client_id, name, created_at) VALUES (?,?,?,?,?)',
    [wId, orgId, clientId, name, now()]);
  await db.run(
    `INSERT INTO client_workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec) VALUES (?,?,?,?,?,?,?,?,?)`,
    [id('cwe'), wId, exerciseId, 0, 'Bench Press', 4, '8', '60', 120]);
  return wId;
}

async function startApi(db) {
  // Import route modules
  const meRoutes = (await import('../src/routes/me.js')).default;
  const workoutShareRoutes = (await import('../src/routes/workoutShare.js')).default;

  // Mock config
  const configMod = await import('../src/config.js');
  configMod.config.jwtSecret = JWT_SECRET;

  const app = express();
  app.use(express.json({ limit: '8mb' }));
  // Minimal cookie parser
  app.use((_req, _res, next) => {
    if (!_req.cookies) {
      _req.cookies = {};
      const raw = _req.headers.cookie || '';
      for (const part of raw.split(';')) {
        const [k, ...rest] = part.split('=');
        if (k) _req.cookies[k.trim()] = decodeURIComponent(rest.join('='));
      }
    }
    next();
  });
  app.use('/api/me', meRoutes(db));
  app.use('/api/workout-share', workoutShareRoutes(db));
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;

  const authedCall = async (userId, path, opts = {}) => {
    const token = signToken({ sub: userId, role: 'CLIENT', org: opts.org || 'org_1' });
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
    });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };

  const publicCall = async (path, opts = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, opts);
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };

  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { authedCall, publicCall, close, port };
}

// ============================================================
// SHARING TESTS
// ============================================================

test('authenticated client can share complete workout from planner', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId, clientId, userId } = await seedOrgClient(db, 'share1');
  const exId = await seedExerciseLibrary(db, orgId);
  const workoutId = await createPlannerWorkout(db, clientId, orgId, exId, 'Push Day');
  const { authedCall, close } = await startApi(db);
  t.after(() => close());

  const r = await authedCall(userId, '/api/me/workout-share', {
    method: 'POST',
    body: JSON.stringify({ workout_id: workoutId }),
  });

  assert.equal(r.status, 201);
  assert.ok(r.json.id);
  assert.ok(r.json.id.startsWith('shr_'));
});

test('authenticated client can share selected exercises only', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId, clientId, userId } = await seedOrgClient(db, 'share2');
  const exId = await seedExerciseLibrary(db, orgId);

  // Create a workout with 2 exercises
  const wId = id('cw');
  await db.run('INSERT INTO client_workouts (id, org_id, client_id, name, created_at) VALUES (?,?,?,?,?)',
    [wId, orgId, clientId, 'Full Day', now()]);
  const ex1 = id('cwe');
  const ex2 = id('cwe');
  await db.run(`INSERT INTO client_workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec) VALUES (?,?,?,?,?,?,?,?,?)`,
    [ex1, wId, exId, 0, 'Bench Press', 4, '8', '60', 120]);
  await db.run(`INSERT INTO client_workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec) VALUES (?,?,?,?,?,?,?,?,?)`,
    [ex2, wId, exId, 1, 'Incline Press', 3, '10', '40', 90]);

  const { authedCall, close } = await startApi(db);
  t.after(() => close());

  const r = await authedCall(userId, '/api/me/workout-share', {
    method: 'POST',
    body: JSON.stringify({ workout_id: wId, exercise_ids: [ex1] }),
  });

  assert.equal(r.status, 201);
  // Verify the snapshot only has 1 exercise
  const share = await db.q1('SELECT * FROM shared_workouts WHERE id = ?', [r.json.id]);
  const payload = JSON.parse(share.payload_json);
  assert.equal(payload.exercises.length, 1);
  assert.equal(payload.exercises[0].name, 'Bench Press');
});

test('cannot share another client\'s workout', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId: org1, clientId: cl1, userId: usr1 } = await seedOrgClient(db, 'sc1');
  const { clientId: cl2, userId: usr2 } = await seedOrgClient(db, 'sc2');
  const exId = await seedExerciseLibrary(db, org1);
  const workoutId = await createPlannerWorkout(db, cl1, org1, exId, 'Private Day');
  const { authedCall, close } = await startApi(db);
  t.after(() => close());

  // Client 2 tries to share client 1's workout
  const r = await authedCall(usr2, '/api/me/workout-share', {
    method: 'POST',
    body: JSON.stringify({ workout_id: workoutId }),
    org: org1,
  });

  assert.equal(r.status, 404);
});

test('cannot share a workout with non-existent exercise IDs', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId, clientId, userId } = await seedOrgClient(db, 'share3');
  const exId = await seedExerciseLibrary(db, orgId);
  const workoutId = await createPlannerWorkout(db, clientId, orgId, exId);
  const { authedCall, close } = await startApi(db);
  t.after(() => close());

  const r = await authedCall(userId, '/api/me/workout-share', {
    method: 'POST',
    body: JSON.stringify({ workout_id: workoutId, exercise_ids: ['nonexistent'] }),
  });

  assert.equal(r.status, 400);
});

test('snapshot is immutable — editing source workout does not change the share', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId, clientId, userId } = await seedOrgClient(db, 'immut');
  const exId = await seedExerciseLibrary(db, orgId);
  const workoutId = await createPlannerWorkout(db, clientId, orgId, exId, 'Push Day');
  const { authedCall, close } = await startApi(db);
  t.after(() => close());

  // Create share
  const shareRes = await authedCall(userId, '/api/me/workout-share', {
    method: 'POST',
    body: JSON.stringify({ workout_id: workoutId }),
  });
  const shareId = shareRes.json.id;

  // Edit the source workout
  await authedCall(userId, `/api/me/planner/workouts/${workoutId}`, {
    method: 'PUT',
    body: JSON.stringify({ name: 'Completely Different Day' }),
  });

  // Verify share is unchanged
  const share = await db.q1('SELECT * FROM shared_workouts WHERE id = ?', [shareId]);
  const payload = JSON.parse(share.payload_json);
  assert.equal(payload.name, 'Push Day');
});

// ============================================================
// PUBLIC PREVIEW TESTS
// ============================================================

test('public GET /api/workout-share/:id works without auth', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId, clientId } = await seedOrgClient(db, 'pub1');
  const shareId = id('shr');
  const payload = { type: 'workout', name: 'Push Day', notes: null, exercises: [{ name: 'Bench Press', sets: 4, reps: '8', weight: '60', rest_sec: 120 }] };
  await db.run('INSERT INTO shared_workouts (id, org_id, client_id, shared_by_name, workout_name, payload_json, created_at) VALUES (?,?,?,?,?,?,?)',
    [shareId, orgId, clientId, 'Rahul', 'Push Day', JSON.stringify(payload), now()]);

  const { publicCall, close } = await startApi(db);
  t.after(() => close());

  const r = await publicCall(`/api/workout-share/${shareId}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.id, shareId);
  assert.equal(r.json.shared_by_name, 'Rahul');
  assert.equal(r.json.workout.name, 'Push Day');
  assert.equal(r.json.workout.exercises.length, 1);
  assert.equal(r.json.workout.exercises[0].name, 'Bench Press');
});

test('public preview never leaks org_id or client_id', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId, clientId } = await seedOrgClient(db, 'pub2');
  const shareId = id('shr');
  const payload = { type: 'workout', name: 'Test', exercises: [] };
  await db.run('INSERT INTO shared_workouts (id, org_id, client_id, shared_by_name, workout_name, payload_json, created_at) VALUES (?,?,?,?,?,?,?)',
    [shareId, orgId, clientId, 'Test', 'Test', JSON.stringify(payload), now()]);

  const { publicCall, close } = await startApi(db);
  t.after(() => close());

  const r = await publicCall(`/api/workout-share/${shareId}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.org_id, undefined);
  assert.equal(r.json.client_id, undefined);
  assert.equal(r.json.shared_by_name, 'Test');
});

test('invalid share ID returns generic error', async (t) => {
  resetRateLimits();
  const db = await memDb();
  await seedOrgClient(db, 'pub3');
  const { publicCall, close } = await startApi(db);
  t.after(() => close());

  const r = await publicCall('/api/workout-share/shr_nonexistent');
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'This shared workout link is invalid or has expired');
});

test('malformed ID does not crash', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { publicCall, close } = await startApi(db);
  t.after(() => close());

  const r = await publicCall('/api/workout-share/../../etc/passwd');
  assert.ok(r.status >= 400);
});

// ============================================================
// IMPORT TESTS
// ============================================================

test('recipient can import all exercises to planner', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId: orgA, clientId: clA, userId: usrA } = await seedOrgClient(db, 'imp1');
  const { orgId: orgB, clientId: clB, userId: usrB } = await seedOrgClient(db, 'imp2');
  const exId = await seedExerciseLibrary(db, orgA);

  // Also add exercise to orgB's visibility (global)
  // exId is already global (is_global=1)

  const workoutId = await createPlannerWorkout(db, clA, orgA, exId, 'Push Day');

  // Client A creates share
  const db2 = await memDb(); // fresh DB for API since the route imports are cached
  // Actually, let's just use the same db and do everything through the API

  const { authedCall, publicCall, close } = await startApi(db);
  t.after(() => close());

  // A creates share
  const shareRes = await authedCall(usrA, '/api/me/workout-share', {
    method: 'POST',
    body: JSON.stringify({ workout_id: workoutId }),
  });
  assert.equal(shareRes.status, 201);
  const shareId = shareRes.json.id;

  // B previews
  const preview = await publicCall(`/api/workout-share/${shareId}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.json.workout.exercises.length, 1);

  // B imports to planner
  const importRes = await authedCall(usrB, `/api/me/workout-share/${shareId}/import`, {
    method: 'POST',
    body: JSON.stringify({ destination: 'planner' }),
  });
  assert.equal(importRes.status, 201);
  assert.equal(importRes.json.ok, true);
  assert.ok(importRes.json.id);
  assert.equal(importRes.json.destination, 'planner');

  // Verify the imported workout belongs to client B
  const imported = await db.q1('SELECT * FROM client_workouts WHERE id = ?', [importRes.json.id]);
  assert.ok(imported);
  assert.equal(imported.client_id, clB);
  assert.equal(imported.name, 'Push Day');

  // Verify exercises exist
  const exs = await db.q('SELECT * FROM client_workout_exercises WHERE workout_id = ?', [importRes.json.id]);
  assert.equal(exs.length, 1);
  assert.equal(exs[0].name, 'Bench Press');
});

test('recipient can import selected exercises by index', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId: orgA, clientId: clA, userId: usrA } = await seedOrgClient(db, 'sel1');
  const { orgId: orgB, clientId: clB, userId: usrB } = await seedOrgClient(db, 'sel2');
  const exId = await seedExerciseLibrary(db, orgA);

  // Create workout with 3 exercises
  const wId = id('cw');
  await db.run('INSERT INTO client_workouts (id, org_id, client_id, name, created_at) VALUES (?,?,?,?,?)',
    [wId, orgA, clA, 'Full Day', now()]);
  for (let i = 0; i < 3; i++) {
    await db.run(`INSERT INTO client_workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec) VALUES (?,?,?,?,?,?,?,?,?)`,
      [id('cwe'), wId, exId, i, `Exercise ${i + 1}`, 3, '10', '50', 90]);
  }

  const { authedCall, close } = await startApi(db);
  t.after(() => close());

  const shareRes = await authedCall(usrA, '/api/me/workout-share', {
    method: 'POST',
    body: JSON.stringify({ workout_id: wId }),
  });
  const shareId = shareRes.json.id;

  // Import only exercises 0 and 2
  const importRes = await authedCall(usrB, `/api/me/workout-share/${shareId}/import`, {
    method: 'POST',
    body: JSON.stringify({ exercise_indexes: [0, 2], destination: 'planner' }),
  });
  assert.equal(importRes.status, 201);

  const exs = await db.q('SELECT * FROM client_workout_exercises WHERE workout_id = ? ORDER BY position', [importRes.json.id]);
  assert.equal(exs.length, 2);
  // Names resolve to the library's canonical name
  assert.equal(exs[0].name, 'Bench Press');
  assert.equal(exs[1].name, 'Bench Press');
});

test('import for today creates a workout for today', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId: orgA, clientId: clA, userId: usrA } = await seedOrgClient(db, 'today1');
  const { orgId: orgB, clientId: clB, userId: usrB } = await seedOrgClient(db, 'today2');
  const exId = await seedExerciseLibrary(db, orgA);
  const workoutId = await createPlannerWorkout(db, clA, orgA, exId, 'Push Day');

  const { authedCall, close } = await startApi(db);
  t.after(() => close());

  const shareRes = await authedCall(usrA, '/api/me/workout-share', {
    method: 'POST',
    body: JSON.stringify({ workout_id: workoutId }),
  });
  const shareId = shareRes.json.id;

  const importRes = await authedCall(usrB, `/api/me/workout-share/${shareId}/import`, {
    method: 'POST',
    body: JSON.stringify({ destination: 'today' }),
  });
  assert.equal(importRes.status, 201);
  assert.equal(importRes.json.destination, 'today');
  assert.ok(importRes.json.id);

  // Verify the workout was created with correct source
  const w = await db.q1('SELECT * FROM workouts WHERE id = ?', [importRes.json.id]);
  assert.ok(w);
  assert.equal(w.client_id, clB);
  assert.equal(w.source, 'client_custom');
  assert.equal(w.status, 'assigned');
});

test('import to planner_day assigns to correct day', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId: orgA, clientId: clA, userId: usrA } = await seedOrgClient(db, 'day1');
  const { orgId: orgB, clientId: clB, userId: usrB } = await seedOrgClient(db, 'day2');
  const exId = await seedExerciseLibrary(db, orgA);
  const workoutId = await createPlannerWorkout(db, clA, orgA, exId, 'Push Day');

  const { authedCall, close } = await startApi(db);
  t.after(() => close());

  const shareRes = await authedCall(usrA, '/api/me/workout-share', {
    method: 'POST',
    body: JSON.stringify({ workout_id: workoutId }),
  });
  const shareId = shareRes.json.id;

  // Import to Monday (day_of_week = 0)
  const importRes = await authedCall(usrB, `/api/me/workout-share/${shareId}/import`, {
    method: 'POST',
    body: JSON.stringify({ destination: 'planner_day', day_of_week: 0 }),
  });
  assert.equal(importRes.status, 201);
  assert.equal(importRes.json.destination, 'planner_day');
  assert.equal(importRes.json.day_of_week, 0);

  // Verify the schedule entry
  const sched = await db.q1('SELECT * FROM client_workout_schedule WHERE client_id = ? AND day_of_week = ?', [clB, 0]);
  assert.ok(sched);
  assert.equal(sched.workout_id, importRes.json.id);
});

test('duplicate workout names are safely disambiguated', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId: orgA, clientId: clA, userId: usrA } = await seedOrgClient(db, 'dup1');
  const { orgId: orgB, clientId: clB, userId: usrB } = await seedOrgClient(db, 'dup2');
  const exId = await seedExerciseLibrary(db, orgA);
  const workoutId = await createPlannerWorkout(db, clA, orgA, exId, 'Push Day');

  // Client B already has a "Push Day"
  const existingWId = id('cw');
  await db.run('INSERT INTO client_workouts (id, org_id, client_id, name, created_at) VALUES (?,?,?,?,?)',
    [existingWId, orgB, clB, 'Push Day', now()]);

  const { authedCall, close } = await startApi(db);
  t.after(() => close());

  const shareRes = await authedCall(usrA, '/api/me/workout-share', {
    method: 'POST',
    body: JSON.stringify({ workout_id: workoutId }),
  });
  const shareId = shareRes.json.id;

  const importRes = await authedCall(usrB, `/api/me/workout-share/${shareId}/import`, {
    method: 'POST',
    body: JSON.stringify({ destination: 'planner' }),
  });
  assert.equal(importRes.status, 201);

  // Verify the name was disambiguated
  const imported = await db.q1('SELECT * FROM client_workouts WHERE id = ?', [importRes.json.id]);
  assert.ok(imported);
  assert.equal(imported.name, 'Push Day (shared)');
});

test('sender\'s workout is never modified by import', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId: orgA, clientId: clA, userId: usrA } = await seedOrgClient(db, 'orig1');
  const { userId: usrB } = await seedOrgClient(db, 'orig2');
  const exId = await seedExerciseLibrary(db, orgA);
  const workoutId = await createPlannerWorkout(db, clA, orgA, exId, 'Push Day');

  const { authedCall, close } = await startApi(db);
  t.after(() => close());

  const shareRes = await authedCall(usrA, '/api/me/workout-share', {
    method: 'POST',
    body: JSON.stringify({ workout_id: workoutId }),
  });
  const shareId = shareRes.json.id;

  // Record sender's workout before import
  const before = await db.q1('SELECT * FROM client_workouts WHERE id = ?', [workoutId]);
  const exBefore = await db.q('SELECT * FROM client_workout_exercises WHERE workout_id = ?', [workoutId]);

  // B imports
  await authedCall(usrB, `/api/me/workout-share/${shareId}/import`, {
    method: 'POST',
    body: JSON.stringify({ destination: 'planner' }),
  });

  // Verify sender's workout is unchanged
  const after = await db.q1('SELECT * FROM client_workouts WHERE id = ?', [workoutId]);
  const exAfter = await db.q('SELECT * FROM client_workout_exercises WHERE workout_id = ?', [workoutId]);
  assert.equal(after.name, before.name);
  assert.equal(exAfter.length, exBefore.length);
});

test('invalid destination is rejected', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId, clientId, userId } = await seedOrgClient(db, 'inv1');
  const exId = await seedExerciseLibrary(db, orgId);
  const workoutId = await createPlannerWorkout(db, clientId, orgId, exId);

  const { authedCall, close } = await startApi(db);
  t.after(() => close());

  const shareRes = await authedCall(userId, '/api/me/workout-share', {
    method: 'POST',
    body: JSON.stringify({ workout_id: workoutId }),
  });

  const importRes = await authedCall(userId, `/api/me/workout-share/${shareRes.json.id}/import`, {
    method: 'POST',
    body: JSON.stringify({ destination: 'invalid' }),
  });
  assert.equal(importRes.status, 422);
});

test('planner_day without day_of_week is rejected', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId, clientId, userId } = await seedOrgClient(db, 'dow1');
  const exId = await seedExerciseLibrary(db, orgId);
  const workoutId = await createPlannerWorkout(db, clientId, orgId, exId);

  const { authedCall, close } = await startApi(db);
  t.after(() => close());

  const shareRes = await authedCall(userId, '/api/me/workout-share', {
    method: 'POST',
    body: JSON.stringify({ workout_id: workoutId }),
  });

  const importRes = await authedCall(userId, `/api/me/workout-share/${shareRes.json.id}/import`, {
    method: 'POST',
    body: JSON.stringify({ destination: 'planner_day' }),
  });
  assert.equal(importRes.status, 400);
});

test('invalid day_of_week is rejected', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId, clientId, userId } = await seedOrgClient(db, 'dow2');
  const exId = await seedExerciseLibrary(db, orgId);
  const workoutId = await createPlannerWorkout(db, clientId, orgId, exId);

  const { authedCall, close } = await startApi(db);
  t.after(() => close());

  const shareRes = await authedCall(userId, '/api/me/workout-share', {
    method: 'POST',
    body: JSON.stringify({ workout_id: workoutId }),
  });

  const importRes = await authedCall(userId, `/api/me/workout-share/${shareRes.json.id}/import`, {
    method: 'POST',
    body: JSON.stringify({ destination: 'planner_day', day_of_week: 7 }),
  });
  assert.ok(importRes.status === 400 || importRes.status === 422, 'Expected 400 or 422 for invalid day_of_week');
});

test('importing non-existent share returns 404', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { userId } = await seedOrgClient(db, 'noexist');
  const { authedCall, close } = await startApi(db);
  t.after(() => close());

  const r = await authedCall(userId, '/api/me/workout-share/shr_nonexistent/import', {
    method: 'POST',
    body: JSON.stringify({ destination: 'planner' }),
  });
  assert.equal(r.status, 404);
});

test('invalid exercise indexes are filtered out gracefully', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId: orgA, clientId: clA, userId: usrA } = await seedOrgClient(db, 'idx1');
  const { userId: usrB } = await seedOrgClient(db, 'idx2');
  const exId = await seedExerciseLibrary(db, orgA);
  const workoutId = await createPlannerWorkout(db, clA, orgA, exId);

  const { authedCall, close } = await startApi(db);
  t.after(() => close());

  const shareRes = await authedCall(usrA, '/api/me/workout-share', {
    method: 'POST',
    body: JSON.stringify({ workout_id: workoutId }),
  });

  // Import with out-of-range indexes mixed with valid ones
  // (Zod schema catches negative indexes at validation; use only positive out-of-range)
  const importRes = await authedCall(usrB, `/api/me/workout-share/${shareRes.json.id}/import`, {
    method: 'POST',
    body: JSON.stringify({ exercise_indexes: [0, 99], destination: 'planner' }),
  });
  assert.equal(importRes.status, 201);
  // Only index 0 is valid (99 is out of range), so 1 exercise imported
  const exs = await db.q('SELECT * FROM client_workout_exercises WHERE workout_id = ?', [importRes.json.id]);
  assert.equal(exs.length, 1);
});

test('exercise library name-based fallback resolution works', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId: orgA, clientId: clA, userId: usrA } = await seedOrgClient(db, 'lib1');
  const { orgId: orgB, clientId: clB, userId: usrB } = await seedOrgClient(db, 'lib2');
  const exId = await seedExerciseLibrary(db, orgA);

  // Create workout with a custom-named exercise (no exercise_id, just name)
  const wId = id('cw');
  await db.run('INSERT INTO client_workouts (id, org_id, client_id, name, created_at) VALUES (?,?,?,?,?)',
    [wId, orgA, clA, 'Custom Day', now()]);
  await db.run(`INSERT INTO client_workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec) VALUES (?,?,?,?,?,?,?,?,?)`,
    [id('cwe'), wId, null, 0, 'Bench Press', 3, '10', '50', 90]);

  // Client B also has 'Bench Press' in their library (same global exercise)
  // exId is global, so both clients can see it

  const { authedCall, close } = await startApi(db);
  t.after(() => close());

  const shareRes = await authedCall(usrA, '/api/me/workout-share', {
    method: 'POST',
    body: JSON.stringify({ workout_id: wId }),
  });

  const importRes = await authedCall(usrB, `/api/me/workout-share/${shareRes.json.id}/import`, {
    method: 'POST',
    body: JSON.stringify({ destination: 'planner' }),
  });
  assert.equal(importRes.status, 201);

  // The exercise should be resolved to the library's ID
  const exs = await db.q('SELECT * FROM client_workout_exercises WHERE workout_id = ?', [importRes.json.id]);
  assert.equal(exs.length, 1);
  assert.equal(exs[0].exercise_id, exId);
  assert.equal(exs[0].name, 'Bench Press');
});

test('unauthenticated user cannot import (401)', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId, clientId } = await seedOrgClient(db, 'auth1');
  const exId = await seedExerciseLibrary(db, orgId);
  const workoutId = await createPlannerWorkout(db, clientId, orgId, exId);

  // Create share directly in DB
  const shareId = id('shr');
  const payload = { type: 'workout', name: 'Push Day', exercises: [{ name: 'Bench Press', sets: 4, reps: '8', weight: '60', rest_sec: 120 }] };
  await db.run('INSERT INTO shared_workouts (id, org_id, client_id, shared_by_name, workout_name, payload_json, created_at) VALUES (?,?,?,?,?,?,?)',
    [shareId, orgId, clientId, 'Test', 'Push Day', JSON.stringify(payload), now()]);

  const { publicCall, close } = await startApi(db);
  t.after(() => close());

  // Try import without auth token — import is under /api/me which requires auth
  const r = await publicCall(`/api/me/workout-share/${shareId}/import`, {
    method: 'POST',
    body: JSON.stringify({ destination: 'planner' }),
  });
  assert.equal(r.status, 401);
});

test('custom workout name can be provided on import', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId: orgA, clientId: clA, userId: usrA } = await seedOrgClient(db, 'cname1');
  const { userId: usrB } = await seedOrgClient(db, 'cname2');
  const exId = await seedExerciseLibrary(db, orgA);
  const workoutId = await createPlannerWorkout(db, clA, orgA, exId, 'Push Day');

  const { authedCall, close } = await startApi(db);
  t.after(() => close());

  const shareRes = await authedCall(usrA, '/api/me/workout-share', {
    method: 'POST',
    body: JSON.stringify({ workout_id: workoutId }),
  });

  const importRes = await authedCall(usrB, `/api/me/workout-share/${shareRes.json.id}/import`, {
    method: 'POST',
    body: JSON.stringify({ destination: 'planner', workout_name: 'My Custom Push' }),
  });
  assert.equal(importRes.status, 201);

  const imported = await db.q1('SELECT * FROM client_workouts WHERE id = ?', [importRes.json.id]);
  assert.equal(imported.name, 'My Custom Push');
});
