// ============================================================
// Gym Community feature tests.
//   node --test backend/test/community.test.js
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
  // Columns added via scripts/init-db.js's guarded MIGRATIONS array (added
  // by the Enterprise build, merged in after this file's own fixture was
  // written), which this lightweight in-memory DB doesn't run -- same gap
  // documented throughout the Enterprise test suite's memDb() helpers.
  // Needed here because PUT /admin/settings now writes both this file's
  // own community_* columns AND these gym-profile columns in one query.
  for (const ddl of ['contact_email TEXT', 'contact_phone TEXT', 'address TEXT', 'city TEXT', 'country TEXT', 'logo_url TEXT', 'website TEXT', 'instagram_url TEXT', 'description TEXT']) {
    db.exec(`ALTER TABLE gym_settings ADD COLUMN ${ddl}`);
  }
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await mk().q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
    exec(sql) { db.exec(sql); },
    async tx(fn) {
      db.exec('BEGIN');
      try { const out = await fn(mk()); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
    raw: db
  });
  return mk();
}

const ts = new Date().toISOString().slice(0, 19) + 'Z';

// Seed two orgs with clients, workouts, and completed sessions
async function seedFull(db) {
  for (const [oid, slug] of [['o1', 'gym-a'], ['o2', 'gym-b']]) {
    await db.run('INSERT INTO organizations (id, name, slug, timezone, created_at) VALUES (?,?,?,?,?)',
      [oid, 'Org ' + oid, oid === 'o1' ? 'gym-a' : 'gym-b', 'Asia/Kolkata', ts]);
    await db.run(
      `INSERT INTO gym_settings (org_id, brand_name, crowd_enabled, workout_mode_default,
        allow_substitute, allow_add_exercise, allow_edit_targets, community_enabled, community_leaderboard_enabled, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [oid, oid === 'o1' ? 'Reforma Fitness' : 'Another Gym', 1, 'hybrid', 1, 1, 1, 1, 1, ts]);
  }
  const users = [
    ['u1','o1','c1@a.in','CLIENT','Arjun'],
    ['u2','o1','c2@a.in','CLIENT','Rahul'],
    ['u3','o1','c3@a.in','CLIENT','Neha'],
    ['u4','o2','c4@b.in','CLIENT','CrossGym'],
    ['owner1','o1','owner@a.in','GYM_OWNER','Owner A'],
  ];
  for (const [uid,org,email,role,name] of users) {
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?,?,?,?,?,?,1,?)`,
      [uid, org, email, 'x', role, name, ts]);
  }
  for (const [uid,cid] of [['u1','c1'],['u2','c2'],['u3','c3'],['u4','c4']]) {
    await db.run(`INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?,?,?,?,?)`,
      [cid, uid, uid === 'u4' ? 'o2' : 'o1', 'GENERAL', ts]);
  }
  await db.run(`INSERT INTO exercise_library (id, name, primary_muscle, equipment, is_global) VALUES (?,?,?,?,1)`,
    ['ex1', 'Bench Press', 'CHEST', 'BARBELL']);

  // Use dates relative to TODAY in the org's timezone (Asia/Kolkata)
  // so streak tests never go stale regardless of when they run.
  const orgTz = 'Asia/Kolkata';
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: orgTz });
  const todayMs = new Date(todayStr + 'T12:00:00Z').getTime();
  const days = [];
  for (let i = 5; i >= 1; i--) {
    const d = new Date(todayMs - i * 86400000);
    days.push(d.toISOString().slice(0, 10));
  }

  let wid = 0;
  const completeWorkout = async (clientId, date, weight, reps) => {
    wid++;
    const workoutId = `wko${wid}`;
    await db.run(
      `INSERT INTO workouts (id, org_id, client_id, name, scheduled_date, status, source, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      [workoutId, 'o1', clientId, `Session ${wid}`, date, 'completed', 'program', ts]);
    const exId = `wxe${wid}`;
    await db.run(
      `INSERT INTO workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec) VALUES (?,?,?,?,?,?,?,?,?)`,
      [exId, workoutId, 'ex1', 0, 'Bench Press', 3, '10', `${weight}`, 90]);
    const logId = `wlg${wid}`;
    await db.run(
      `INSERT INTO workout_logs (id, client_id, workout_id, exercise_id, date, sets_done, reps, weight, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      [logId, clientId, workoutId, 'ex1', date, 3, reps, weight, ts]);
    for (let s = 1; s <= 3; s++) {
      await db.run(
        `INSERT INTO exercise_set_logs (id, workout_log_id, client_id, exercise_id, set_number, actual_reps, actual_weight, completed) VALUES (?,?,?,?,?,?,?,1)`,
        [`stl${wid}_${s}`, logId, clientId, 'ex1', s, reps, weight]);
    }
  };

  for (let i = 0; i < 5; i++) await completeWorkout('c1', days[4 - i], 60, 10);
  for (let i = 0; i < 3; i++) await completeWorkout('c2', days[4 - i], 50, 8);
  for (let i = 0; i < 2; i++) await completeWorkout('c3', days[4 - i], 40, 12);

  for (const cid of ['c1', 'c2', 'c3']) {
    await db.run(`INSERT INTO community_members (client_id, org_id, enabled, updated_at) VALUES (?,?,1,?)`, [cid, 'o1', ts]);
  }
}

async function startApi() {
  const db = await memDb();
  await seedFull(db);
  const communityRoutes = (await import('../src/routes/community.js')).default;
  const adminRoutes = (await import('../src/routes/admin.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/community', communityRoutes(db));
  app.use('/api/admin', adminRoutes(db));
  const server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const token = (sub, role = 'CLIENT', org = 'o1') =>
    jwt.sign({ sub, role, org, name: sub }, config.jwtSecret, { expiresIn: '1h' });
  const call = async (method, p, body, tok) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok || token('u1')}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise(r => { server.closeAllConnections(); server.close(r); });
  return { db, call, close, token };
}

test('membership: client can opt in and out', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const r1 = await call('GET', '/api/community/membership');
  assert.equal(r1.status, 200);
  assert.equal(r1.json.membership.enabled, 1);
  const r2 = await call('PUT', '/api/community/membership', { enabled: false });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.enabled, false);
  const r3 = await call('PUT', '/api/community/membership', { enabled: true });
  assert.equal(r3.status, 200);
  assert.equal(r3.json.enabled, true);
});

test('leaderboards: streak ranking is correct', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const r = await call('GET', '/api/community/leaderboards?period=week');
  assert.equal(r.status, 200);
  const streaks = r.json.leaderboards.streak;
  assert.ok(streaks.length >= 3, 'At least 3 members on streak board');
  const arjun = streaks.find(e => e.name === 'Arjun');
  assert.ok(arjun, 'Arjun is on the streak board');
  assert.equal(arjun.rank, 1);
  assert.equal(arjun.value, 5);
  const rahul = streaks.find(e => e.name === 'Rahul');
  assert.equal(rahul.rank, 2);
  assert.equal(rahul.value, 3);
  const neha = streaks.find(e => e.name === 'Neha');
  assert.equal(neha.rank, 3);
  assert.equal(neha.value, 2);
});

test('leaderboards: volume ranking sums weight×reps×sets', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const r = await call('GET', '/api/community/leaderboards?period=all');
  const volumes = r.json.leaderboards.volume;
  assert.ok(volumes.length >= 3);
  // Arjun: 5 sessions × 60kg × 10reps × 3sets = 9000 kg
  const arjun = volumes.find(e => e.name === 'Arjun');
  assert.equal(arjun.value, 9000, 'Arjun total volume = 9000 kg');
  const rahul = volumes.find(e => e.name === 'Rahul');
  assert.equal(rahul.value, 3600);
  const neha = volumes.find(e => e.name === 'Neha');
  assert.equal(neha.value, 2880);
});

test('leaderboards: completed workouts ranking', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const r = await call('GET', '/api/community/leaderboards?period=all');
  const completed = r.json.leaderboards.completedWorkouts;
  assert.ok(completed.length >= 3);
  assert.equal(completed[0].name, 'Arjun');
  assert.equal(completed[0].value, 5);
  assert.equal(completed[1].name, 'Rahul');
  assert.equal(completed[1].value, 3);
});

test('leaderboards: period=day shows only today', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const r = await call('GET', '/api/community/leaderboards?period=day');
  assert.equal(r.status, 200);
  const volumes = r.json.leaderboards.volume;
  assert.equal(volumes.length, 0, 'No workouts today in seed data');
});

test('leaderboards: period=month includes all workouts', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const r = await call('GET', '/api/community/leaderboards?period=month');
  const volumes = r.json.leaderboards.volume;
  const arjun = volumes.find(e => e.name === 'Arjun');
  assert.equal(arjun.value, 9000);
});

test('multi-tenancy: gym B clients never appear in gym A leaderboard', async (t) => {
  const { call, close, db, token: tk } = await startApi();
  t.after(() => close());
  // Make u4 a member of o2 so they can access the leaderboard
  await db.run('INSERT INTO community_members (client_id, org_id, enabled, updated_at) VALUES (?, ?, 1, ?)',
    ['c4', 'o2', '2026-01-01T00:00:00Z']);
  const r = await call('GET', '/api/community/leaderboards?period=week', null, tk('u4', 'CLIENT', 'o2'));
  assert.equal(r.status, 200);
  const all = [
    ...r.json.leaderboards.streak,
    ...r.json.leaderboards.volume,
    ...r.json.leaderboards.completedWorkouts,
  ];
  assert.ok(!all.some(e => e.name === 'Arjun' || e.name === 'Rahul' || e.name === 'Neha'),
    'Gym A clients must not appear in Gym B leaderboard');
});

test('privacy: disabled member absent from leaderboard', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  await db.run('UPDATE community_members SET enabled = 0 WHERE client_id = ?', ['c3']);
  const r = await call('GET', '/api/community/leaderboards?period=week');
  const all = [
    ...r.json.leaderboards.streak,
    ...r.json.leaderboards.volume,
    ...r.json.leaderboards.completedWorkouts,
  ];
  assert.ok(!all.some(e => e.name === 'Neha'),
    'Disabled member must not appear on any leaderboard');
});

test('sharing: member can share a completed workout', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const w = await db.q1("SELECT id FROM workouts WHERE client_id = 'c1' AND status = 'completed' LIMIT 1");
  const r = await call('POST', '/api/community/shares', { workout_id: w.id });
  assert.equal(r.status, 201);
  assert.ok(r.json.id, 'Share created');
});

test('sharing: non-member cannot share', async (t) => {
  const { call, close, db, token: tk } = await startApi();
  t.after(() => close());
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?,?,?,?,?,?,1,?)`,
    ['u5', 'o1', 'c5@a.in', 'x', 'CLIENT', 'Lurker', ts]);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?,?,?,?,?)',
    ['c5', 'u5', 'o1', 'GENERAL', ts]);
  await db.run(
    `INSERT INTO workouts (id, org_id, client_id, name, scheduled_date, status, source, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    ['wko999', 'o1', 'c5', 'Secret', '2026-08-25', 'completed', 'program', ts]);
  await db.run(
    `INSERT INTO workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec) VALUES (?,?,?,?,?,?,?,?,?)`,
    ['wxe999', 'wko999', 'ex1', 0, 'Bench', 3, '10', '50', 90]);
  const r = await call('POST', '/api/community/shares', { workout_id: 'wko999' }, tk('u5', 'CLIENT', 'o1'));
  assert.equal(r.status, 403, 'Non-member cannot share');
});

test('sharing: member can unshare', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const w = await db.q1("SELECT id FROM workouts WHERE client_id = 'c1' AND status = 'completed' LIMIT 1");
  const s = await call('POST', '/api/community/shares', { workout_id: w.id });
  assert.equal(s.status, 201);
  const r = await call('DELETE', `/api/community/shares/${s.json.id}`);
  assert.equal(r.status, 200);
  const feed = await call('GET', '/api/community/feed');
  assert.ok(!feed.json.shares.some(x => x.id === s.json.id));
});

test('copy: member can copy a shared workout into their planner', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const w = await db.q1("SELECT id FROM workouts WHERE client_id = 'c1' AND status = 'completed' LIMIT 1");
  const s = await call('POST', '/api/community/shares', { workout_id: w.id });
  assert.equal(s.status, 201);
  const tk2 = jwt.sign({ sub: 'u2', role: 'CLIENT', org: 'o1', name: 'Rahul' }, config.jwtSecret, { expiresIn: '1h' });
  const r2 = await call('POST', `/api/community/shares/${s.json.id}/copy`,
    { name: 'My Bench Day', exercises: [{ exercise_id: 'ex1', name: 'Bench Press', sets: 4, reps: '8', weight: '40' }] }, tk2);
  assert.equal(r2.status, 201);
  assert.ok(r2.json.id, 'Copied workout ID returned');
  assert.equal(r2.json.name, 'My Bench Day');
  assert.equal(r2.json.exerciseCount, 1);
  const planner = await db.q1('SELECT * FROM client_workouts WHERE id = ?', [r2.json.id]);
  assert.ok(planner, 'Copied workout exists in planner');
  assert.equal(planner.client_id, 'c2');
  const exs = await db.q('SELECT * FROM client_workout_exercises WHERE workout_id = ?', [r2.json.id]);
  assert.equal(exs.length, 1);
  assert.equal(exs[0].name, 'Bench Press');
  assert.equal(exs[0].sets, 4);
  // Original unchanged
  const origW = await db.q1('SELECT * FROM workouts WHERE id = ?', [w.id]);
  assert.equal(origW.name, 'Session 1');
});

test('copy: non-member/cross-org cannot copy', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const w = await db.q1("SELECT id FROM workouts WHERE client_id = 'c1' AND status = 'completed' LIMIT 1");
  const s = await call('POST', '/api/community/shares', { workout_id: w.id });
  const tk4 = jwt.sign({ sub: 'u4', role: 'CLIENT', org: 'o2', name: 'CrossGym' }, config.jwtSecret, { expiresIn: '1h' });
  const r = await call('POST', `/api/community/shares/${s.json.id}/copy`, {}, tk4);
  assert.ok(r.status >= 400, 'Non-member/cross-org copy must be rejected');
});

test('feed: shows shares with author names', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const w = await db.q1("SELECT id FROM workouts WHERE client_id = 'c1' AND status = 'completed' LIMIT 1");
  await call('POST', '/api/community/shares', { workout_id: w.id });
  const feed = await call('GET', '/api/community/feed');
  assert.equal(feed.status, 200);
  assert.ok(feed.json.shares.length >= 1);
  const share = feed.json.shares[0];
  assert.equal(share.authorName, 'Arjun');
  assert.ok(Array.isArray(share.payload));
});

test('disabling membership removes shares from feed', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const w = await db.q1("SELECT id FROM workouts WHERE client_id = 'c1' AND status = 'completed' LIMIT 1");
  await call('POST', '/api/community/shares', { workout_id: w.id });
  let feed = await call('GET', '/api/community/feed');
  assert.ok(feed.json.shares.length >= 1);
  // Disable membership — shares are auto-deleted AND feed returns 403
  await call('PUT', '/api/community/membership', { enabled: false });
  feed = await call('GET', '/api/community/feed');
  assert.equal(feed.status, 403, 'Feed returns 403 after membership disabled');
  // Verify shares were actually deleted from DB
  const remaining = await db.q('SELECT * FROM community_workout_shares WHERE client_id = ?', ['c1']);
  assert.equal(remaining.length, 0, 'Shares auto-deleted from DB on membership disable');
});

test('unauthenticated requests are rejected', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const r = await call('GET', '/api/community/leaderboards', null, 'invalid-token');
  assert.equal(r.status, 401);
});

test('gym owner can view leaderboards (read-only)', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const r = await call('GET', '/api/community/leaderboards?period=week', null,
    jwt.sign({ sub: 'owner1', role: 'GYM_OWNER', org: 'o1', name: 'Owner' }, config.jwtSecret, { expiresIn: '1h' }));
  assert.equal(r.status, 200);
  assert.ok(r.json.leaderboards.streak.length >= 1);
});

test('tie-breaking is deterministic', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const r = await call('GET', '/api/community/leaderboards?period=week');
  const streaks = r.json.leaderboards.streak;
  const ranks = streaks.map(e => e.rank);
  assert.equal(new Set(ranks).size, ranks.length, 'No duplicate ranks');
});

// ---- NEW TESTS: admin settings round-trip ----

test('admin settings: PUT round-trip saves all fields including community', async (t) => {
  const { db, close } = await startApi();
  t.after(() => close());
  // Use express + direct route for admin (needs GYM_OWNER role)
  const adminRoutes = (await import('../src/routes/admin.js')).default;
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes(db));
  const server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const tok = jwt.sign({ sub: 'owner1', role: 'GYM_OWNER', org: 'o1', name: 'Owner A' }, config.jwtSecret, { expiresIn: '1h' });
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));

  // PUT settings
  const putRes = await fetch(`${base}/api/admin/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({
      brand_name: 'Test Gym',
      tagline: 'We lift',
      crowd_capacity: 80,
      crowd_enabled: 1,
      workout_mode_default: 'hybrid',
      allow_substitute: 1,
      allow_add_exercise: 0,
      allow_edit_targets: 1,
      community_enabled: 1,
      community_leaderboard_enabled: 0,
    }),
  });
  assert.equal(putRes.status, 200, `PUT /settings returned ${putRes.status}`);
  const putBody = await putRes.json();
  assert.equal(putBody.ok, true);

  // GET settings and verify all fields
  const getRes = await fetch(`${base}/api/admin/settings`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  assert.equal(getRes.status, 200);
  const getBody = await getRes.json();
  const s = getBody.settings;
  assert.equal(s.brand_name, 'Test Gym');
  assert.equal(s.tagline, 'We lift');
  assert.equal(s.crowd_capacity, 80);
  assert.equal(s.crowd_enabled, 1);
  assert.equal(s.workout_mode_default, 'hybrid');
  assert.equal(s.allow_substitute, 1);
  assert.equal(s.allow_add_exercise, 0);
  assert.equal(s.allow_edit_targets, 1);
  assert.equal(s.community_enabled, 1);
  assert.equal(s.community_leaderboard_enabled, 0);
});

// ---- copy with exercise_id: null (matching UI flow) ----

test('copy: exercise_id: null accepted (UI flow)', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  // Share Arjun's workout
  const w = await db.q1("SELECT id FROM workouts WHERE client_id = 'c1' AND status = 'completed' LIMIT 1");
  const s = await call('POST', '/api/community/shares', { workout_id: w.id });
  assert.equal(s.status, 201);
  // Rahul copies with exercise_id: null (matching UI payload)
  const tk2 = jwt.sign({ sub: 'u2', role: 'CLIENT', org: 'o1', name: 'Rahul' }, config.jwtSecret, { expiresIn: '1h' });
  const r2 = await call('POST', `/api/community/shares/${s.json.id}/copy`,
    { name: 'Copy Test', exercises: [{ exercise_id: null, name: 'Bench Press', sets: 3, reps: '10', weight: 'BW', rest_sec: 120 }] }, tk2);
  assert.equal(r2.status, 201, `Copy with null exercise_id returned ${r2.status}`);
  assert.ok(r2.json.id);
  // Verify rest_sec is preserved
  const exs = await db.q('SELECT * FROM client_workout_exercises WHERE workout_id = ?', [r2.json.id]);
  assert.equal(exs[0].rest_sec, 120, 'rest_sec preserved from client payload');
});

// ---- copy preserves rest_sec from share snapshot ----

test('copy: rest_sec preserved from shared workout', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  // Share Arjun's workout — payload now includes rest_sec
  const w = await db.q1("SELECT id FROM workouts WHERE client_id = 'c1' AND status = 'completed' LIMIT 1");
  const s = await call('POST', '/api/community/shares', { workout_id: w.id });
  assert.equal(s.status, 201);
  // Rahul copies without overrides — should use snapshot rest_sec
  const tk2 = jwt.sign({ sub: 'u2', role: 'CLIENT', org: 'o1', name: 'Rahul' }, config.jwtSecret, { expiresIn: '1h' });
  const r2 = await call('POST', `/api/community/shares/${s.json.id}/copy`, {}, tk2);
  assert.equal(r2.status, 201);
  const exs = await db.q('SELECT * FROM client_workout_exercises WHERE workout_id = ?', [r2.json.id]);
  // Snapshot has rest_sec from workout_exercises (90 in seed data)
  assert.equal(exs[0].rest_sec, 90, 'rest_sec preserved from snapshot');
});

// ---- copy >20 exercises rejected ----

test('copy: >20 exercises rejected', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const w = await db.q1("SELECT id FROM workouts WHERE client_id = 'c1' AND status = 'completed' LIMIT 1");
  const s = await call('POST', '/api/community/shares', { workout_id: w.id });
  const exercises = Array.from({ length: 21 }, (_, i) => ({ name: `Ex ${i}`, sets: 3, reps: '10', weight: 'BW' }));
  const tk2 = jwt.sign({ sub: 'u2', role: 'CLIENT', org: 'o1', name: 'Rahul' }, config.jwtSecret, { expiresIn: '1h' });
  const r = await call('POST', `/api/community/shares/${s.json.id}/copy`, { exercises }, tk2);
  assert.equal(r.status, 422, 'Should reject >20 exercises');
});

// ---- non-member leaderboard access ----

test('non-member client gets 403 on leaderboard', async (t) => {
  const { db, close } = await startApi();
  t.after(() => close());
  // Create a client with NO community membership
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?,?,?,?,?,?,1,?)`,
    ['u5', 'o1', 'c5@a.in', 'x', 'CLIENT', 'Lurker', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?,?,?,?,?)',
    ['c5', 'u5', 'o1', 'GENERAL', '2026-01-01T00:00:00Z']);
  const communityRoutes = (await import('../src/routes/community.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/community', communityRoutes(db));
  const server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const tok = jwt.sign({ sub: 'u5', role: 'CLIENT', org: 'o1', name: 'Lurker' }, config.jwtSecret, { expiresIn: '1h' });
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const r = await fetch(`${base}/api/community/leaderboards?period=week`, { headers: { Authorization: `Bearer ${tok}` } });
  assert.equal(r.status, 403, 'Non-member gets 403 on leaderboards');
});

test('non-member client gets 403 on feed', async (t) => {
  const { db, close } = await startApi();
  t.after(() => close());
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?,?,?,?,?,?,1,?)`,
    ['u6', 'o1', 'c6@a.in', 'x', 'CLIENT', 'Lurker2', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?,?,?,?,?)',
    ['c6', 'u6', 'o1', 'GENERAL', '2026-01-01T00:00:00Z']);
  const communityRoutes = (await import('../src/routes/community.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/community', communityRoutes(db));
  const server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const tok = jwt.sign({ sub: 'u6', role: 'CLIENT', org: 'o1', name: 'Lurker2' }, config.jwtSecret, { expiresIn: '1h' });
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const r = await fetch(`${base}/api/community/feed`, { headers: { Authorization: `Bearer ${tok}` } });
  assert.equal(r.status, 403, 'Non-member gets 403 on feed');
});

// ---- share deletion: ownership enforcement ----

test('share: owner can delete own share', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const w = await db.q1("SELECT id FROM workouts WHERE client_id = 'c1' AND status = 'completed' LIMIT 1");
  const s = await call('POST', '/api/community/shares', { workout_id: w.id });
  assert.equal(s.status, 201);
  const r = await call('DELETE', `/api/community/shares/${s.json.id}`);
  assert.equal(r.status, 200, 'Owner can delete own share');
  // Verify it's gone
  const g = await call('GET', '/api/community/feed');
  assert.equal(g.json.shares.find(x => x.id === s.json.id), undefined, 'Share removed from feed');
});

test('share: cannot delete another users share', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const w = await db.q1("SELECT id FROM workouts WHERE client_id = 'c1' AND status = 'completed' LIMIT 1");
  const s = await call('POST', '/api/community/shares', { workout_id: w.id });
  assert.equal(s.status, 201);
  // Rahul (u2) tries to delete Arjuns (u1) share
  const tk2 = jwt.sign({ sub: 'u2', role: 'CLIENT', org: 'o1', name: 'Rahul' }, config.jwtSecret, { expiresIn: '1h' });
  const r = await call('DELETE', `/api/community/shares/${s.json.id}`, null, tk2);
  assert.equal(r.status, 404, 'Cannot delete another users share');
  // Verify it still exists
  const g = await call('GET', '/api/community/feed');
  assert.ok(g.json.shares.find(x => x.id === s.json.id), 'Share still in feed');
});

test('share: cross-gym share cannot be deleted', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  // Enable community in o2 and give c4 membership so they can share
  await db.run('UPDATE gym_settings SET community_enabled = 1 WHERE org_id = ?', ['o2']);
  const ts2 = new Date().toISOString().slice(0, 19) + 'Z';
  await db.run('INSERT OR REPLACE INTO community_members (client_id, org_id, enabled, updated_at) VALUES (?, ?, 1, ?)',
    ['c4', 'o2', ts2]);
  // c4 needs a completed workout (none seeded for o2 clients)
  const c4wId = 'wko_cross';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  await db.run(
    `INSERT INTO workouts (id, org_id, client_id, name, scheduled_date, status, source, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    [c4wId, 'o2', 'c4', 'Cross Workout', today, 'completed', 'program', ts2]);
  await db.run(
    `INSERT INTO workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec) VALUES (?,?,?,?,?,?,?,?,?)`,
    ['wxe_cross', c4wId, 'ex1', 0, 'Bench Press', 3, '10', '60', 90]);
  // CrossGym (u4/o2) shares a workout
  const tk4 = jwt.sign({ sub: 'u4', role: 'CLIENT', org: 'o2', name: 'CrossGym' }, config.jwtSecret, { expiresIn: '1h' });
  const s = await call('POST', '/api/community/shares', { workout_id: c4wId }, tk4);
  assert.equal(s.status, 201, 'Cross-gym member can share in own gym');
  // Arjun (o1) tries to delete CrossGyms (o2) share — must get 404 (share not found in o1 scope)
  const r = await call('DELETE', `/api/community/shares/${s.json.id}`);
  assert.equal(r.status, 404, 'Cross-gym share deletion blocked');
});
