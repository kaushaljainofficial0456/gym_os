// ============================================================
// PUT /api/workouts/templates/:id  and  DELETE /api/workouts/templates/:id
//
// Both endpoints are new, and both exist because of one real failure:
// the builder screen only ever POSTed. "Editing" a template therefore
// created a SECOND template with the new contents and left the original
// untouched -- so a trainer who refined Legs B three times ended up with
// four Legs Bs and no saved work. The first test here is that bug,
// pinned: saving an existing template must UPDATE it, and the template
// count must not grow.
//
// The rest of this file defends the blast radius. workout_exercises is
// shared by templates (template_id) and by workouts actually assigned to
// clients (workout_id). Editing or deleting a blueprint must never touch
// the sessions built from it -- those are what a client was given, and
// in the delete case the UI explicitly promises the user they are kept.
// A promise in a confirm dialog is only worth what the query scoping
// makes true, so it is asserted here.
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
    async tx(fn) { return fn(mk()); },
    exec(sql) { db.exec(sql); },
    raw: db
  });
  return mk();
}

async function seed(db) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym A', 'gym-a', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o2', 'Gym B', 'gym-b', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'TRAINER', ?, 1, ?)`,
    ['t1', 'o1', 'trainer1@a.in', 'x', 'Trainer One', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'TRAINER', ?, 1, ?)`,
    ['t2', 'o2', 'trainer2@b.in', 'x', 'Trainer Two', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u_c1', 'o1', 'client1@a.in', 'x', 'Client One', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO clients (id, user_id, org_id, trainer_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    ['c1', 'u_c1', 'o1', 't1', '2026-01-01T00:00:00Z']);

  await db.run(`INSERT INTO workout_templates (id, org_id, trainer_id, name, type, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ['wt_legs', 'o1', 't1', 'Legs B', 'legs', '2026-01-02T00:00:00Z']);
  await db.run(`INSERT INTO workout_exercises (id, template_id, position, name, sets, reps, weight, rest_sec) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ['we_squat', 'wt_legs', 0, 'front_squat', 4, '8', '60', 90]);

  // A session ALREADY ASSIGNED to a client from that template, with its
  // own exercise row. This is the thing that must survive both an edit
  // and a delete.
  await db.run(`INSERT INTO workouts (id, org_id, template_id, client_id, trainer_id, name, status, scheduled_date, created_at) VALUES (?, ?, ?, ?, ?, ?, 'assigned', ?, ?)`,
    ['w_assigned', 'o1', 'wt_legs', 'c1', 't1', 'Legs B', '2026-01-10', '2026-01-05T00:00:00Z']);
  await db.run(`INSERT INTO workout_exercises (id, workout_id, position, name, sets, reps, weight, rest_sec) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ['we_assigned', 'w_assigned', 0, 'front_squat', 4, '8', '60', 90]);
}

async function startApp() {
  const db = await memDb();
  await seed(db);
  const workoutRoutes = (await import('../src/routes/workouts.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/workouts', workoutRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const tokenFor = (sub, org) => jwt.sign({ sub, role: 'TRAINER', org, name: sub }, config.jwtSecret, { expiresIn: '1h' });
  const call = async (method, p, body, who = ['t1', 'o1']) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { Authorization: `Bearer ${tokenFor(who[0], who[1])}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body is fine */ }
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, close };
}

const legsPayload = (over = {}) => ({
  name: 'Legs B',
  type: 'legs',
  notes: '',
  exercises: [
    { name: 'front_squat', sets: 5, reps: '5', weight: '80', rest_sec: 120 },
    { name: 'leg_press', sets: 3, reps: '12', weight: '140', rest_sec: 90 },
  ],
  ...over,
});

test('PUT updates the template in place -- three edits do not become four templates', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());

  for (let i = 0; i < 3; i++) {
    const res = await call('PUT', '/api/workouts/templates/wt_legs', legsPayload());
    assert.equal(res.status, 200, JSON.stringify(res.json));
  }

  const all = await db.q('SELECT id, name FROM workout_templates WHERE org_id = ?', ['o1']);
  assert.equal(all.length, 1, 'editing must not create additional templates -- this is the bug being pinned');
  assert.equal(all[0].id, 'wt_legs', 'and it must still be the SAME template row');
});

test('PUT replaces the exercise list -- new exercises land, removed ones go, order is kept', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());

  const res = await call('PUT', '/api/workouts/templates/wt_legs', legsPayload());
  assert.equal(res.status, 200);

  const rows = await db.q(
    'SELECT name, sets, reps, position FROM workout_exercises WHERE template_id = ? ORDER BY position', ['wt_legs']);
  assert.deepEqual(rows.map((r) => r.name), ['front_squat', 'leg_press']);
  assert.equal(rows[0].sets, 5, 'the edited prescription is what persisted, not the original 4');
  assert.deepEqual(rows.map((r) => r.position), [0, 1]);

  // Dropping to a single exercise must actually drop the other one --
  // a replace that only ever adds would silently accumulate.
  await call('PUT', '/api/workouts/templates/wt_legs', legsPayload({
    exercises: [{ name: 'leg_press', sets: 3, reps: '12', weight: '140', rest_sec: 90 }],
  }));
  const after = await db.q('SELECT name FROM workout_exercises WHERE template_id = ?', ['wt_legs']);
  assert.deepEqual(after.map((r) => r.name), ['leg_press']);
});

test('PUT does not touch exercises belonging to an already-assigned workout', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());

  await call('PUT', '/api/workouts/templates/wt_legs', legsPayload());

  const assigned = await db.q('SELECT id, name, sets FROM workout_exercises WHERE workout_id = ?', ['w_assigned']);
  assert.equal(assigned.length, 1, "the client's assigned session keeps its own exercise row");
  assert.equal(assigned[0].id, 'we_assigned');
  assert.equal(assigned[0].sets, 4, 'and keeps the prescription it was given, not the template edit');
});

test('DELETE removes the template but keeps workouts already assigned from it -- the promise the confirm dialog makes', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());

  const res = await call('DELETE', '/api/workouts/templates/wt_legs');
  assert.equal(res.status, 200, JSON.stringify(res.json));

  assert.equal((await db.q('SELECT id FROM workout_templates WHERE id = ?', ['wt_legs'])).length, 0);
  assert.equal((await db.q('SELECT id FROM workout_exercises WHERE template_id = ?', ['wt_legs'])).length, 0);

  const workout = await db.q1('SELECT id, name, template_id FROM workouts WHERE id = ?', ['w_assigned']);
  assert.ok(workout, 'the assigned session still exists');
  assert.equal(workout.name, 'Legs B');
  assert.equal(workout.template_id, null, 'it just loses the pointer to the deleted blueprint (ON DELETE SET NULL)');

  const stillThere = await db.q('SELECT id FROM workout_exercises WHERE workout_id = ?', ['w_assigned']);
  assert.equal(stillThere.length, 1, 'and it keeps every exercise the client was actually given');
});

test('a trainer from another gym can neither edit nor delete this template', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());

  const put = await call('PUT', '/api/workouts/templates/wt_legs', legsPayload({ name: 'Stolen' }), ['t2', 'o2']);
  assert.equal(put.status, 404, 'cross-org edit must not succeed');

  const del = await call('DELETE', '/api/workouts/templates/wt_legs', undefined, ['t2', 'o2']);
  assert.equal(del.status, 404, 'cross-org delete must not succeed');

  const row = await db.q1('SELECT name FROM workout_templates WHERE id = ?', ['wt_legs']);
  assert.equal(row.name, 'Legs B', 'the template is untouched by both attempts');
});

test('PUT on a template that does not exist is a 404, not a silent create', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());

  const res = await call('PUT', '/api/workouts/templates/wt_nope', legsPayload());
  assert.equal(res.status, 404);
  assert.equal((await db.q('SELECT id FROM workout_templates WHERE org_id = ?', ['o1'])).length, 1,
    'a PUT to a missing id must not add a template');
});
