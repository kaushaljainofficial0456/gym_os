// ============================================================
// RETROACTIVE WORKOUT LOGGING — a session the user did but forgot to
// start in the app.
//
// The property these tests exist to protect is a SPLIT one, and it is easy
// to break in either direction:
//
//   LIVE session      started_at is server-authoritative. A client that
//                     could claim its own start time could claim a
//                     three-hour session for a twenty-minute one and
//                     inflate the calorie estimate with it.
//                     (workoutCalorie.test.js owns that assertion.)
//
//   RETROACTIVE       there is no server observation to protect -- the app
//                     was not running -- so the user's own account is the
//                     only source, and the row is labelled
//                     manual_retroactive so it is never mistaken for a
//                     measured one.
//
// A change that makes client times trusted everywhere passes the tests
// below and breaks the live guarantee; a change that trusts them nowhere
// passes workoutCalorie.test.js and silently files every retroactive
// workout under today. Both files have to stay green.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import jwt from 'jsonwebtoken';
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
    async q(sql, p = []) { const st = db.prepare(sql); return p.length ? st.all(...p) : st.all(); },
    async q1(sql, p = []) { const rows = await mk().q(sql, p); return rows[0] || null; },
    async run(sql, p = []) { const st = db.prepare(sql); const r = p.length ? st.run(...p) : st.run(); return { changes: Number(r.changes) }; },
    async tx(fn) {
      db.exec('BEGIN');
      try { const out = await fn(mk()); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
  });
  return mk();
}

const CLIENT = { id: 'u1', role: 'CLIENT', org_id: 'o1' };

async function seed(db) {
  const ts = '2026-01-01T00:00:00Z';
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Gym', 'gym', ts]);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?,?,?,?,'CLIENT',?,1,?)`,
    ['u1', 'o1', 'c@a.in', 'x', 'Client', ts]);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, age, sex, height_cm, current_weight, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ['c1', 'u1', 'o1', 'GENERAL', 30, 'M', 175, 78, ts]);
  await db.run(`INSERT INTO exercise_library (id, name, primary_muscle, equipment, movement, ex_type, is_global) VALUES (?,?,?,?,?,?,1)`,
    ['libA', 'Bench Press', 'CHEST', 'BARBELL', 'horizontal_push', 'compound']);
}

/** Mounts /me and /workouts together, the way index.js does -- the
 *  retroactive flow spans both (create on one, complete on the other). */
async function startApi(db) {
  const meRoutes = (await import('../src/routes/me.js')).default;
  const workoutRoutes = (await import('../src/routes/workouts.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/me', meRoutes(db));
  app.use('/workouts', workoutRoutes(db));
  // A real signed token: both routers run their own requireAuth, so a
  // fake req.user injected upstream is simply overwritten.
  const token = jwt.sign({ sub: CLIENT.id, role: CLIENT.role, org: CLIENT.org_id, name: 'Client' }, config.jwtSecret, { expiresIn: '1h' });
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

const pad = (n) => String(n).padStart(2, '0');
const dayKeyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

test('a workout logged for a PAST date lands on that date, not today', async (t) => {
  const db = await memDb();
  await seed(db);
  const api = await startApi(db);
  t.after(() => api.close());

  const past = new Date(Date.now() - 4 * 86400000);
  const date = dayKeyOf(past);
  const startedAt = new Date(`${date}T18:00:00`).toISOString();

  const created = await api.call('POST', '/me/workouts', {
    name: 'Retro', date, started_at: startedAt,
    exercises: [{ exercise_id: 'libA', sets: 3, reps: '8', weight: '60' }],
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.equal(created.json.source, 'manual_retroactive', 'a past-dated workout is labelled as retroactive');
  assert.ok(created.json.exercises?.length, 'the created exercise rows come back, so completion needs no second round trip');

  const done = await api.call('POST', `/workouts/${created.json.id}/complete`, {
    logs: created.json.exercises.map((e) => ({
      exercise_id: e.id,
      sets: [{ actual_reps: 8, actual_weight: 60, rir: 1, completed: true }],
    })),
    performed_date: date,
    started_at: startedAt,
    completed_at: new Date(Date.parse(startedAt) + 60 * 60000).toISOString(),
    duration_seconds: 3600,
  });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.duration_min, 60);

  const w = await db.q1('SELECT * FROM workouts WHERE id = ?', [created.json.id]);
  assert.equal(w.scheduled_date, date, 'stored on the historical date');
  assert.equal(w.started_at, startedAt, 'the real start time is persisted -- wearable matching depends on it');
  assert.equal(w.status, 'completed');

  // The LOG rows must carry the historical date too, or Progress, streaks
  // and volume would all credit the wrong day.
  const logs = await db.q('SELECT * FROM workout_logs WHERE workout_id = ?', [created.json.id]);
  assert.ok(logs.length > 0);
  assert.equal(logs[0].date, date, 'workout_logs are dated when the session happened');
});

test('a retroactive workout feeds the EXISTING PR engine', async (t) => {
  const db = await memDb();
  await seed(db);
  const api = await startApi(db);
  t.after(() => api.close());

  const date = dayKeyOf(new Date(Date.now() - 2 * 86400000));
  const startedAt = new Date(`${date}T18:00:00`).toISOString();
  const created = await api.call('POST', '/me/workouts', {
    name: 'Retro PR', date, started_at: startedAt,
    exercises: [{ exercise_id: 'libA', sets: 1, reps: '5', weight: '100' }],
  });
  const done = await api.call('POST', `/workouts/${created.json.id}/complete`, {
    logs: [{ exercise_id: created.json.exercises[0].id, sets: [{ actual_reps: 5, actual_weight: 100, completed: true }] }],
    performed_date: date, started_at: startedAt,
    completed_at: new Date(Date.parse(startedAt) + 45 * 60000).toISOString(),
    duration_seconds: 2700,
  });
  assert.equal(done.status, 200);
  assert.ok(done.json.prs?.length > 0, 'a genuine best set logged retroactively is still a PR');

  const stored = await db.q('SELECT * FROM personal_records WHERE client_id = ?', ['c1']);
  assert.ok(stored.length > 0, 'and it reaches the same personal_records table a live session writes');
});

test('a FUTURE workout is refused at creation', async (t) => {
  const db = await memDb();
  await seed(db);
  const api = await startApi(db);
  t.after(() => api.close());

  const future = dayKeyOf(new Date(Date.now() + 2 * 86400000));
  const r = await api.call('POST', '/me/workouts', {
    name: 'Tomorrow', date: future,
    exercises: [{ exercise_id: 'libA', sets: 1 }],
  });
  assert.equal(r.status, 422);
  assert.match(r.json.error, /future/i);
});

test('overlap detection reports an existing session, and reports none when there is none', async (t) => {
  const db = await memDb();
  await seed(db);
  const api = await startApi(db);
  t.after(() => api.close());

  const date = dayKeyOf(new Date(Date.now() - 3 * 86400000));
  const startedAt = new Date(`${date}T18:00:00`).toISOString();

  const before = await api.call('GET', `/me/workouts/overlapping?date=${date}&started_at=${encodeURIComponent(startedAt)}&duration_min=60`);
  assert.equal(before.json.overlapping.length, 0, 'nothing logged yet');

  const created = await api.call('POST', '/me/workouts', {
    name: 'First session', date, started_at: startedAt,
    exercises: [{ exercise_id: 'libA', sets: 1, reps: '8', weight: '60' }],
  });
  await api.call('POST', `/workouts/${created.json.id}/complete`, {
    logs: [{ exercise_id: created.json.exercises[0].id, sets: [{ actual_reps: 8, actual_weight: 60, completed: true }] }],
    performed_date: date, started_at: startedAt,
    completed_at: new Date(Date.parse(startedAt) + 60 * 60000).toISOString(),
    duration_seconds: 3600,
  });

  // Same hour -> flagged.
  const clash = await api.call('GET', `/me/workouts/overlapping?date=${date}&started_at=${encodeURIComponent(startedAt)}&duration_min=60`);
  assert.equal(clash.json.overlapping.length, 1, 'a second session at the same time is flagged, not silently duplicated');
  assert.equal(clash.json.overlapping[0].name, 'First session');

  // Hours later the same day -> a genuinely separate session, not a clash.
  const later = new Date(`${date}T06:00:00`).toISOString();
  const apart = await api.call('GET', `/me/workouts/overlapping?date=${date}&started_at=${encodeURIComponent(later)}&duration_min=30`);
  assert.equal(apart.json.overlapping.length, 0, 'two real sessions in one day are legitimate');
});

test('a retroactive workout appears in the client workout list (not a second-class record)', async (t) => {
  const db = await memDb();
  await seed(db);
  const api = await startApi(db);
  t.after(() => api.close());

  const date = dayKeyOf(new Date(Date.now() - 5 * 86400000));
  const created = await api.call('POST', '/me/workouts', {
    name: 'Retro Listed', date, started_at: new Date(`${date}T18:00:00`).toISOString(),
    exercises: [{ exercise_id: 'libA', sets: 1 }],
  });
  assert.equal(created.status, 200);

  const list = await api.call('GET', '/me/workouts');
  const found = (list.json.workouts || []).find((w) => w.id === created.json.id);
  // The list filters on source; adding a new source value without adding it
  // here is exactly how a retroactive workout becomes invisible.
  assert.ok(found, 'retroactive workouts are listed alongside custom ones');
  assert.equal(found.source, 'manual_retroactive');
});
