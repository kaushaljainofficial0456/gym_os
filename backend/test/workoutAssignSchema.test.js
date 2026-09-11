// ============================================================
// Regression test for an audit-session fix: validate()'s
// `req.body = parsed.data` replaces the request body wholesale with
// whatever Zod parsed -- any field a caller sends that isn't declared on
// the schema is silently stripped, not just ignored-but-harmless. Found
// live: POST /workouts/clients/:id/assign reads req.body.scheduled_date
// and req.body.day_label directly (see workouts.js), and
// WorkoutBuilder.jsx's assign() genuinely sends a trainer-picked date --
// but schemas.workoutTemplate never declared either field, so every
// assigned workout silently landed on TODAY regardless of what date was
// requested, with no error.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import express from 'express';
import { config } from '../src/config.js';
import { schemas } from '../src/validate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

test('schemas.workoutTemplate keeps scheduled_date and day_label instead of stripping them', () => {
  const parsed = schemas.workoutTemplate.parse({
    name: 'Leg Day',
    scheduled_date: '2026-09-15',
    day_label: 'Future Leg Day',
    exercises: [{ name: 'Squat', sets: 3, reps: '8', weight: '60kg', rest_sec: 90 }],
  });
  assert.equal(parsed.scheduled_date, '2026-09-15');
  assert.equal(parsed.day_label, 'Future Leg Day');
});

test('POST /workouts/clients/:id/assign persists the requested scheduled_date and day_label (integration)', async (t) => {
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
    raw: db,
  });
  const dbi = mk();

  await dbi.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Org', 'org', '2026-01-01T00:00:00Z']);
  await dbi.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'TRAINER', ?, 1, ?)`,
    ['trainer1', 'o1', 't@a.in', 'x', 'Trainer', '2026-01-01T00:00:00Z']);
  await dbi.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u1', 'o1', 'c@a.in', 'x', 'Client', '2026-01-01T00:00:00Z']);
  await dbi.run('INSERT INTO clients (id, user_id, org_id, trainer_id, goal, created_at) VALUES (?, ?, ?, ?, ?, ?)', ['c1', 'u1', 'o1', 'trainer1', 'FAT_LOSS', '2026-01-01T00:00:00Z']);

  const workoutRoutes = (await import('../src/routes/workouts.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/workouts', workoutRoutes(dbi));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const port = server.address().port;
  const token = jwt.sign({ sub: 'trainer1', role: 'TRAINER', org: 'o1', name: 'Trainer' }, config.jwtSecret, { expiresIn: '1h' });

  const res = await fetch(`http://127.0.0.1:${port}/api/workouts/clients/c1/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: 'Future Leg Day', scheduled_date: '2026-09-15', day_label: 'Future Leg Day',
      exercises: [{ name: 'Squat', sets: 3, reps: '8', weight: '60kg', rest_sec: 90 }],
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 201);

  const row = await dbi.q1('SELECT * FROM workouts WHERE id = ?', [body.id]);
  assert.equal(row.scheduled_date, '2026-09-15', 'must use the trainer-requested date, not silently default to today');
  assert.equal(row.day_label, 'Future Leg Day');
});
