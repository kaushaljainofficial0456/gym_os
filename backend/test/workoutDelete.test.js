// ============================================================
// DELETING A WORKOUT YOU LOGGED BY MISTAKE.
//
// "Log a past workout" is a form, and forms get filled in wrong — but a
// completed workout could not be deleted at all, so a mis-logged session
// was permanent.
//
// The hard part is not the delete, it is the cleanup. A completed
// workout leaves workout_logs, and those feed personal_records, which
// holds ONE rolling best per (client, exercise, type) and carries no
// workout_id. Removing the workout alone leaves the record it set
// standing forever: the app congratulating someone on a lift they never
// did, with nothing left to trace it to.
//
// So the interesting tests here are about what happens to the record.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const ts = '2026-01-01T00:00:00Z';

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(schema);
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
  const { resetRateLimits } = await import('../src/rateLimit.js');
  resetRateLimits();

  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Gym', 'gym', ts]);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                VALUES ('u1','o1','a@x.in','x','CLIENT','C',1,?)`, [ts]);
  await db.run('INSERT INTO clients (id, user_id, org_id, created_at) VALUES (?,?,?,?)', ['c1', 'u1', 'o1', ts]);
  await db.run(`INSERT INTO exercise_library (id, name, primary_muscle, equipment)
                VALUES ('ex1','Bench Press','chest','barbell')`);

  const app = express();
  app.use(express.json());
  app.use('/api/me', meRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const token = jwt.sign({ sub: 'u1', role: 'CLIENT', org: 'o1', name: 'C', email: 'a@x.in' }, config.jwtSecret);
  const call = (method, url) => fetch(`http://127.0.0.1:${port}${url}`, {
    method, headers: { Authorization: `Bearer ${token}` },
  });
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, close };
}

async function seedSession(db, { id: wid, status, source, weight, reps, date }) {
  await db.run(
    `INSERT INTO workouts (id, org_id, client_id, name, scheduled_date, status, source, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [wid, 'o1', 'c1', 'Push', date, status, source, ts]);
  await db.run(
    `INSERT INTO workout_logs (id, client_id, workout_id, exercise_id, date, sets_done, reps, weight)
     VALUES (?,?,?,?,?,?,?,?)`,
    [`wl_${wid}`, 'c1', wid, 'ex1', date, 1, reps, weight]);
}

async function setPR(db, { value, weight, reps, date, type = 'heaviest_weight' }) {
  await db.run(
    `INSERT INTO personal_records (id, client_id, exercise_id, type, value, weight, reps, date, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [`pr_${type}`, 'c1', 'ex1', type, value, weight, reps, date, ts]);
}

test('a completed workout the client logged can be deleted', async (t) => {
  const { db, call, close } = await startApi();
  t.after(() => close());
  await seedSession(db, { id: 'w1', status: 'completed', source: 'manual_retroactive', weight: 100, reps: 5, date: '2026-09-10' });

  const res = await call('DELETE', '/api/me/workouts/w1');
  assert.equal(res.status, 200);
  assert.equal(await db.q1('SELECT id FROM workouts WHERE id = ?', ['w1']), null);
  assert.equal(await db.q1('SELECT id FROM workout_logs WHERE workout_id = ?', ['w1']), null,
    'its logged sets go with it');
});

test('a record set only by the deleted session is removed', async (t) => {
  // The phantom-PR case: nothing else in history supports that lift, so
  // the record must not survive the session that created it.
  const { db, call, close } = await startApi();
  t.after(() => close());
  await seedSession(db, { id: 'w1', status: 'completed', source: 'manual_retroactive', weight: 100, reps: 5, date: '2026-09-10' });
  await setPR(db, { value: 100, weight: 100, reps: 5, date: '2026-09-10' });

  await call('DELETE', '/api/me/workouts/w1');
  assert.equal(await db.q1(`SELECT id FROM personal_records WHERE client_id = 'c1' AND exercise_id = 'ex1'`), null,
    'no history left, so no record left');
});

test('a record falls back to the best that genuinely remains', async (t) => {
  // The previous best might be from any earlier session, which is why
  // this is a recompute and not an "undo".
  const { db, call, close } = await startApi();
  t.after(() => close());
  await seedSession(db, { id: 'w_old', status: 'completed', source: 'client_custom', weight: 80, reps: 5, date: '2026-09-01' });
  await seedSession(db, { id: 'w_bad', status: 'completed', source: 'manual_retroactive', weight: 100, reps: 5, date: '2026-09-10' });
  await setPR(db, { value: 100, weight: 100, reps: 5, date: '2026-09-10' });

  await call('DELETE', '/api/me/workouts/w_bad');

  const pr = await db.q1(`SELECT value, weight, date FROM personal_records
                          WHERE client_id='c1' AND exercise_id='ex1' AND type='heaviest_weight'`);
  assert.ok(pr, 'the earlier session still supports a record');
  assert.equal(pr.weight, 80);
  assert.equal(pr.date, '2026-09-01', 'and it points at a session that still exists');
});

test('an untouched exercise keeps its record', async (t) => {
  const { db, call, close } = await startApi();
  t.after(() => close());
  await db.run(`INSERT INTO exercise_library (id, name, primary_muscle, equipment)
                VALUES ('ex2','Squat','quads','barbell')`);
  await seedSession(db, { id: 'w1', status: 'completed', source: 'manual_retroactive', weight: 100, reps: 5, date: '2026-09-10' });
  await db.run(
    `INSERT INTO personal_records (id, client_id, exercise_id, type, value, weight, reps, date, created_at)
     VALUES ('pr_other','c1','ex2','heaviest_weight',140,140,3,'2026-08-01',?)`, [ts]);

  await call('DELETE', '/api/me/workouts/w1');
  const other = await db.q1(`SELECT value FROM personal_records WHERE id = 'pr_other'`);
  assert.equal(other.value, 140, 'a different lift is none of this delete\'s business');
});

test('a workout the client did not create cannot be deleted', async (t) => {
  // A plan assigned by a trainer is the trainer's row.
  const { db, call, close } = await startApi();
  t.after(() => close());
  await seedSession(db, { id: 'w_assigned', status: 'completed', source: 'trainer', weight: 90, reps: 5, date: '2026-09-10' });

  const res = await call('DELETE', '/api/me/workouts/w_assigned');
  assert.equal(res.status, 404);
  assert.ok(await db.q1('SELECT id FROM workouts WHERE id = ?', ['w_assigned']));
});

test('another client\'s workout is not reachable', async (t) => {
  const { db, call, close } = await startApi();
  t.after(() => close());
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                VALUES ('u2','o1','b@x.in','x','CLIENT','D',1,?)`, [ts]);
  await db.run('INSERT INTO clients (id, user_id, org_id, created_at) VALUES (?,?,?,?)', ['c2', 'u2', 'o1', ts]);
  await db.run(`INSERT INTO workouts (id, org_id, client_id, name, scheduled_date, status, source, created_at)
                VALUES ('w_theirs','o1','c2','Push','2026-09-10','completed','client_custom',?)`, [ts]);

  const res = await call('DELETE', '/api/me/workouts/w_theirs');
  assert.equal(res.status, 404);
  assert.ok(await db.q1('SELECT id FROM workouts WHERE id = ?', ['w_theirs']));
});
