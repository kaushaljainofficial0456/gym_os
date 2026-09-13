// ============================================================
// CARDIO SESSIONS — bouts that now exist after you finish them.
//
// A cardio session used to live only in React state: you ran for forty
// minutes, the app showed a calorie summary, and it was gone. Nothing
// reached history, the day's burn, the streak or Progress — and "log a
// past cardio session" could not be built at all, because there was
// nowhere to put one.
//
// Two things these tests hold. A run or a game IS a training day, so it
// has to reach the same consistency maths that lifting does. And the
// kcal figure is an ESTIMATE supplied by the client, so it is bounded —
// an estimate is not a number to accept unchecked.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProgressIntel } from '../src/services/progress/progressIntel.js';

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
  for (const [u, c, mail] of [['u1', 'c1', 'a@x.in'], ['u2', 'c2', 'b@x.in']]) {
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                  VALUES (?,'o1',?,'x','CLIENT','C',1,?)`, [u, mail, ts]);
    await db.run('INSERT INTO clients (id, user_id, org_id, created_at) VALUES (?,?,?,?)', [c, u, 'o1', ts]);
  }
  const app = express();
  app.use(express.json());
  app.use('/api/me', meRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = (method, url, { as = 'u1', body } = {}) => fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt.sign({ sub: as, role: 'CLIENT', org: 'o1', name: 'C', email: 'a@x.in' }, config.jwtSecret)}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, close };
}

const bout = (over = {}) => ({
  activity_id: 'badminton', activity_name: 'Badminton',
  duration_sec: 45 * 60, effort: 'moderate', kcal: 325, source: 'manual_retroactive', ...over,
});

test('a session is stored and comes back', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const res = await call('POST', '/api/me/cardio', { body: bout({ date: '2026-09-10' }) });
  assert.equal(res.status, 201);

  const list = await (await call('GET', '/api/me/cardio')).json();
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].activityName, 'Badminton');
  assert.equal(list.sessions[0].durationMin, 45);
  assert.equal(list.sessions[0].kcal, 325);
});

test('a run counts as a training day in Progress', async (t) => {
  // The whole point of storing these. Counting only lifted sets told
  // someone who runs five mornings a week that they had not trained.
  const { db, call, close } = await startApi();
  t.after(() => close());
  const day = new Date().toISOString().slice(0, 10);
  await call('POST', '/api/me/cardio', { body: bout({ activity_id: 'running', activity_name: 'Running', date: day }) });

  const intel = await getProgressIntel(db, { userId: 'u1', clientId: 'c1', days: 90 });
  assert.ok(intel.consistency.trainedDays.includes(day), 'the run is a training day');
  assert.equal(intel.cardio.sessions.length, 1);
});

test('a two-minute bout is not a training day', async (t) => {
  // A mis-tap or a walk to the shops with the app open. The lifting side
  // already applies a qualifying bar; this is the same instinct.
  const { db, call, close } = await startApi();
  t.after(() => close());
  const day = new Date().toISOString().slice(0, 10);
  await call('POST', '/api/me/cardio', { body: bout({ duration_sec: 120, date: day }) });

  const intel = await getProgressIntel(db, { userId: 'u1', clientId: 'c1', days: 90 });
  assert.ok(!intel.consistency.trainedDays.includes(day));
  assert.equal(intel.cardio.sessions.length, 1, 'it is still recorded, just not qualifying');
});

test('a session cannot be logged in the future', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const res = await call('POST', '/api/me/cardio', { body: bout({ date: future }) });
  assert.equal(res.status, 422);
});

test('an absurd calorie figure is refused', async (t) => {
  // kcal comes from the client, where the MET model lives. That makes it
  // an input, and inputs get bounded.
  const { call, close } = await startApi();
  t.after(() => close());
  assert.equal((await call('POST', '/api/me/cardio', { body: bout({ kcal: 99999 }) })).status, 422);
  assert.equal((await call('POST', '/api/me/cardio', { body: bout({ kcal: -5 }) })).status, 422);
});

test('an absurd duration is refused', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  assert.equal((await call('POST', '/api/me/cardio', { body: bout({ duration_sec: 5 }) })).status, 422);
  assert.equal((await call('POST', '/api/me/cardio', { body: bout({ duration_sec: 60 * 60 * 20 }) })).status, 422);
});

test('you only ever see your own sessions', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  await call('POST', '/api/me/cardio', { as: 'u1', body: bout({ activity_name: 'Mine' }) });
  await call('POST', '/api/me/cardio', { as: 'u2', body: bout({ activity_name: 'Theirs' }) });

  const mine = await (await call('GET', '/api/me/cardio', { as: 'u1' })).json();
  assert.deepEqual(mine.sessions.map((s) => s.activityName), ['Mine']);
});

test('another client\'s session cannot be deleted by id', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  await call('POST', '/api/me/cardio', { as: 'u2', body: bout() });
  const theirs = (await (await call('GET', '/api/me/cardio', { as: 'u2' })).json()).sessions[0];

  const res = await call('DELETE', `/api/me/cardio/${theirs.id}`, { as: 'u1' });
  assert.equal(res.status, 404);
  const still = await (await call('GET', '/api/me/cardio', { as: 'u2' })).json();
  assert.equal(still.sessions.length, 1);
});

test('your own session can be deleted', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  await call('POST', '/api/me/cardio', { body: bout() });
  const mine = (await (await call('GET', '/api/me/cardio')).json()).sessions[0];
  assert.equal((await call('DELETE', `/api/me/cardio/${mine.id}`)).status, 200);
  assert.equal((await (await call('GET', '/api/me/cardio')).json()).sessions.length, 0);
});
