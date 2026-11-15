// ============================================================
// In-app sharing: send a workout or meal straight to a person, who gets a
// bell notification and an inbox entry they can add or dismiss.
//
// Who can be found and sent to is the privacy-critical part: only people
// the sender can already see in the app -- their gym's community (both
// opted in) and friend communities they share. A stranger is never listed
// and a send to one is refused, whatever id the app puts in the request.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import express from 'express';
import { config } from '../src/config.js';
import { resetRateLimits } from '../src/rateLimit.js';
import { dayKey, plannerDay } from '../src/utils/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const TZ = 'Asia/Kolkata';
const today = () => dayKey(new Date(), TZ);
const T0 = '2026-01-01T00:00:00Z';

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  try { db.exec(`ALTER TABLE notifications ADD COLUMN channel TEXT`); } catch { /* already there */ }
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await mk().q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
    exec(sql) { db.exec(sql); },
    async tx(fn) {
      db.exec('BEGIN');
      try { const out = await fn(mk()); db.exec('COMMIT'); return out; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
  });
  return mk();
}

/*  o1 (gym A): asha (sender, community on), ben (community on), cara (community OFF)
    o2 (gym B): dev -- a friend of asha's through a friend community
    o2:         eli -- connected to nobody */
async function fixture({ ashaInCommunity = true, prescribedFor = null } = {}) {
  const db = await memDb();
  for (const [oid, slug] of [['o1', 'gym-a'], ['o2', 'gym-b']]) {
    await db.run('INSERT INTO organizations (id, name, slug, timezone, created_at) VALUES (?, ?, ?, ?, ?)', [oid, `Gym ${oid}`, slug, TZ, T0]);
  }
  const people = [['asha', 'o1', 'Asha Rao'], ['ben', 'o1', 'Ben Kumar'], ['cara', 'o1', 'Cara Das'], ['dev', 'o2', 'Dev Shah'], ['eli', 'o2', 'Eli Stone']];
  for (const [p, oid, name] of people) {
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, 'x', 'CLIENT', ?, 1, ?)`, [`u_${p}`, oid, `${p}@x.in`, name, T0]);
    await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)', [`c_${p}`, `u_${p}`, oid, 'FAT_LOSS', T0]);
  }
  for (const [p, on] of [['asha', ashaInCommunity], ['ben', true], ['cara', false]]) {
    await db.run('INSERT INTO community_members (client_id, org_id, enabled, updated_at) VALUES (?, ?, ?, ?)', [`c_${p}`, 'o1', on ? 1 : 0, T0]);
  }
  await db.run(`INSERT INTO communities (id, name, created_at, updated_at) VALUES ('fc1', 'Sunday Runners', ?, ?)`, [T0, T0]);
  for (const p of ['asha', 'dev']) {
    await db.run(`INSERT INTO community_memberships (id, community_id, client_id, status, joined_at, updated_at) VALUES (?, 'fc1', ?, 'active', ?, ?)`, [`m_${p}`, `c_${p}`, T0, T0]);
  }
  if (prescribedFor) await db.run(`INSERT INTO gym_settings (org_id, workout_mode_default) VALUES (?, 'prescribed')`, [prescribedFor]);
  for (const [eid, name, muscle] of [['ex1', 'Bench Press', 'CHEST'], ['ex2', 'Barbell Row', 'BACK']]) {
    await db.run(`INSERT INTO exercise_library (id, name, primary_muscle, equipment, is_global) VALUES (?, ?, ?, 'BARBELL', 1)`, [eid, name, muscle]);
  }
  // Asha's saved workout (a superset) and saved meal.
  await db.run(`INSERT INTO client_workouts (id, org_id, client_id, name, created_at) VALUES ('cw_push', 'o1', 'c_asha', 'Push Pull', ?)`, [T0]);
  await db.run(`INSERT INTO client_workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, superset_group) VALUES ('cwe1', 'cw_push', 'ex1', 0, 'Bench Press', 3, '10', '40', 'a')`);
  await db.run(`INSERT INTO client_workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, superset_group) VALUES ('cwe2', 'cw_push', 'ex2', 1, 'Barbell Row', 3, '10', '40', 'a')`);
  await db.run(`INSERT INTO client_meal_templates (id, org_id, client_id, slot, name, calories, protein, carbs, fat, position) VALUES ('cmt1', 'o1', 'c_asha', 'Lunch', 'Paneer Bowl', 520, 32, 48, 20, 0)`);
  await db.run(`INSERT INTO meal_items (id, meal_template_id, name, quantity, unit, calories, protein, carbs, fat, position) VALUES ('mi1', 'cmt1', 'Paneer', 100, 'g', 300, 18, 4, 22, 0)`);
  return db;
}

const tokenFor = (p, org) => jwt.sign({ sub: `u_${p}`, role: 'CLIENT', org, name: p }, config.jwtSecret, { expiresIn: '1h' });
const ORG = { asha: 'o1', ben: 'o1', cara: 'o1', dev: 'o2', eli: 'o2' };

async function startApi(db) {
  resetRateLimits();
  const appShareRoutes = (await import('../src/routes/appShares.js')).default;
  const trackingRoutes = (await import('../src/routes/tracking.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/app-shares', appShareRoutes(db));
  app.use('/tracking', trackingRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const { port } = server.address();
  const as = (p) => async (method, url, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(p, ORG[p])}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { as, close };
}

test('people: gym community members and friend-community members, never a stranger', async (t) => {
  const db = await fixture();
  const api = await startApi(db);
  t.after(() => api.close());
  const r = await api.as('asha')('GET', '/app-shares/people');
  assert.equal(r.status, 200);
  const ids = r.json.people.map((p) => p.client_id).sort();
  assert.deepEqual(ids, ['c_ben', 'c_dev'], 'Ben (gym, opted in) and Dev (friend community); not Cara (opted out), not Eli, not herself');
  assert.equal(r.json.people.find((p) => p.client_id === 'c_dev').communities[0], 'Sunday Runners');
  const s = await api.as('asha')('GET', '/app-shares/people?q=ben');
  assert.deepEqual(s.json.people.map((p) => p.name), ['Ben Kumar']);
});

test('people: gym members are not listed to a sender who has not joined the gym community', async (t) => {
  const db = await fixture({ ashaInCommunity: false });
  const api = await startApi(db);
  t.after(() => api.close());
  const r = await api.as('asha')('GET', '/app-shares/people');
  assert.deepEqual(r.json.people.map((p) => p.client_id), ['c_dev']);
  assert.equal(r.json.gym_community, false);
});

test('send a workout: recipients get an inbox entry and a bell notification; strangers are dropped', async (t) => {
  const db = await fixture();
  const api = await startApi(db);
  t.after(() => api.close());
  const r = await api.as('asha')('POST', '/app-shares', { kind: 'workout', workout_id: 'cw_push', recipients: ['c_ben', 'c_dev', 'c_eli', 'c_cara'], message: 'Try this' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.sent, 2, 'Ben and Dev only');
  const rows = await db.q('SELECT recipient_client_id, recipient_org_id, sender_name FROM app_shares ORDER BY recipient_client_id');
  assert.deepEqual(rows.map((x) => [x.recipient_client_id, x.recipient_org_id]), [['c_ben', 'o1'], ['c_dev', 'o2']]);
  assert.equal(rows[0].sender_name, 'Asha Rao');
  const notes = await db.q(`SELECT user_id, org_id, title, data_json FROM notifications WHERE type = 'share_received' ORDER BY user_id`);
  assert.equal(notes.length, 2);
  assert.equal(notes[1].org_id, 'o2', 'the cross-gym friend\'s notification carries their own gym');
  assert.match(notes[0].title, /Asha Rao shared a workout/);
  assert.match(JSON.parse(notes[0].data_json).link, /^\/app\/client\?share=ash/);

  const only = await api.as('asha')('POST', '/app-shares', { kind: 'workout', workout_id: 'cw_push', recipients: ['c_eli'] });
  assert.equal(only.status, 422, 'a send to nobody reachable is refused');
});

test('recipient: inbox preview, then "every week" on days including today', async (t) => {
  const db = await fixture();
  const api = await startApi(db);
  t.after(() => api.close());
  await api.as('asha')('POST', '/app-shares', { kind: 'workout', workout_id: 'cw_push', recipients: ['c_ben'] });
  const inbox = await api.as('ben')('GET', '/app-shares/inbox');
  assert.equal(inbox.json.shares.length, 1);
  const s = inbox.json.shares[0];
  assert.equal(s.from, 'Asha Rao');
  assert.deepEqual(s.workout.exercises.map((e) => e.superset_group), ['a', 'a'], 'the superset travels with it');

  const days = [plannerDay(today()), (plannerDay(today()) + 3) % 7];
  const acc = await api.as('ben')('POST', `/app-shares/${s.id}/accept`, { action: 'days', days });
  assert.equal(acc.status, 200, JSON.stringify(acc.json));
  assert.ok(acc.json.today_workout_id, 'today is one of the days, so it is today\'s workout now');
  const saved = await db.q1(`SELECT * FROM client_workouts WHERE client_id = 'c_ben'`);
  assert.equal(saved.name, 'Push Pull');
  const sched = await db.q(`SELECT day_of_week FROM client_workout_schedule WHERE client_id = 'c_ben' ORDER BY day_of_week`);
  assert.deepEqual(sched.map((x) => x.day_of_week), [...days].sort((a, b) => a - b));
  const todayW = await api.as('ben')('GET', '/tracking/me/today');
  assert.equal(todayW.json.workout.name, 'Push Pull');

  const note = await db.q1(`SELECT read FROM notifications WHERE user_id = 'u_ben' AND type = 'share_received'`);
  assert.equal(note.read, 1, 'answering it clears the bell');
  const again = await api.as('ben')('POST', `/app-shares/${s.id}/accept`, { action: 'today' });
  assert.equal(again.status, 409);
  assert.equal((await api.as('ben')('GET', '/app-shares/inbox')).json.shares.length, 0);
});

test('recipient: "do it today" and "save" each add exactly that', async (t) => {
  const db = await fixture();
  const api = await startApi(db);
  t.after(() => api.close());
  const sent = await api.as('asha')('POST', '/app-shares', { kind: 'workout', workout_id: 'cw_push', recipients: ['c_ben', 'c_dev'] });
  const [toBen, toDev] = sent.json.ids;
  const a = await api.as('ben')('POST', `/app-shares/${toBen}/accept`, { action: 'today' });
  assert.equal(a.status, 200);
  assert.equal((await db.q(`SELECT id FROM client_workouts WHERE client_id = 'c_ben'`)).length, 0, 'today only: nothing saved');
  const w = await db.q1(`SELECT id, scheduled_date FROM workouts WHERE client_id = 'c_ben'`);
  assert.equal(w.scheduled_date, today());
  const b = await api.as('dev')('POST', `/app-shares/${toDev}/accept`, { action: 'planner' });
  assert.equal(b.status, 200);
  assert.equal((await db.q(`SELECT id FROM client_workouts WHERE client_id = 'c_dev'`)).length, 1);
  assert.equal((await db.q(`SELECT * FROM client_workout_schedule WHERE client_id = 'c_dev'`)).length, 0);
});

test('a shared meal is added to the recipient\'s meals', async (t) => {
  const db = await fixture();
  const api = await startApi(db);
  t.after(() => api.close());
  const sent = await api.as('asha')('POST', '/app-shares', { kind: 'meal', meal_ids: ['cmt1'], recipients: ['c_ben'] });
  assert.equal(sent.status, 201, JSON.stringify(sent.json));
  const inbox = await api.as('ben')('GET', '/app-shares/inbox');
  assert.equal(inbox.json.shares[0].meal.items[0].name, 'Paneer Bowl');
  const acc = await api.as('ben')('POST', `/app-shares/${sent.json.ids[0]}/accept`, { action: 'meal' });
  assert.equal(acc.status, 200, JSON.stringify(acc.json));
  const meal = await db.q1(`SELECT * FROM client_meal_templates WHERE client_id = 'c_ben'`);
  assert.equal(meal.name, 'Paneer Bowl');
  assert.equal((await db.q('SELECT * FROM meal_items WHERE meal_template_id = ?', [meal.id])).length, 1);
  const wrong = await api.as('ben')('POST', `/app-shares/${sent.json.ids[0]}/accept`, { action: 'today' });
  assert.equal(wrong.status, 409);
});

test('dismiss removes it from the inbox; nobody else can answer it', async (t) => {
  const db = await fixture();
  const api = await startApi(db);
  t.after(() => api.close());
  const sent = await api.as('asha')('POST', '/app-shares', { kind: 'workout', workout_id: 'cw_push', recipients: ['c_ben'] });
  const sid = sent.json.ids[0];
  assert.equal((await api.as('dev')('POST', `/app-shares/${sid}/accept`, { action: 'today' })).status, 404, 'not Dev\'s');
  assert.equal((await api.as('dev')('POST', `/app-shares/${sid}/dismiss`)).status, 404);
  assert.equal((await api.as('ben')('POST', `/app-shares/${sid}/dismiss`)).status, 200);
  assert.equal((await api.as('ben')('GET', '/app-shares/inbox')).json.shares.length, 0);
  assert.equal((await api.as('ben')('POST', `/app-shares/${sid}/accept`, { action: 'today' })).status, 409);
});

test('a recipient whose gym follows the coach\'s plan can do it today but not save it', async (t) => {
  const db = await fixture({ prescribedFor: 'o2' });
  const api = await startApi(db);
  t.after(() => api.close());
  const sent = await api.as('asha')('POST', '/app-shares', { kind: 'workout', workout_id: 'cw_push', recipients: ['c_dev'] });
  const sid = sent.json.ids[0];
  const inbox = await api.as('dev')('GET', '/app-shares/inbox');
  assert.equal(inbox.json.can_plan, false);
  assert.equal((await api.as('dev')('POST', `/app-shares/${sid}/accept`, { action: 'planner' })).status, 403);
  assert.equal((await api.as('dev')('POST', `/app-shares/${sid}/accept`, { action: 'today' })).status, 200);
});

test('a sender can only share their own workout', async (t) => {
  const db = await fixture();
  await db.run(`INSERT INTO client_workouts (id, org_id, client_id, name, created_at) VALUES ('cw_ben', 'o1', 'c_ben', 'Ben Secret', ?)`, [T0]);
  const api = await startApi(db);
  t.after(() => api.close());
  const r = await api.as('asha')('POST', '/app-shares', { kind: 'workout', workout_id: 'cw_ben', recipients: ['c_dev'] });
  assert.equal(r.status, 404);
});
