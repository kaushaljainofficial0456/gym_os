// ============================================================
// REMINDERS (services/notificationGenerator.js), on a fixed clock.
//
// The generator existed but nothing in the app called it, and when it did
// run it failed for anyone without a saved preferences row (org_id is NOT
// NULL), ignored quiet hours, sent rest-day messages with that switch off,
// and could only send the daily recap in a 30-minute window. Each test
// pins the clock to a local time in the gym's timezone (Asia/Kolkata,
// UTC+5:30) so the time-of-day rules are what is under test.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateNotifications } from '../src/services/notificationGenerator.js';

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
    async tx(fn) {
      db.exec('BEGIN');
      try { const out = await fn(mk()); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
  });
  return mk();
}

const DAY = '2026-10-30';
const NEXT = '2026-10-31';
// A local wall-clock time in Asia/Kolkata.
const at = (date, hm) => new Date(`${date}T${hm}:00+05:30`);

async function setup({ prefs = null, water = null, dayStart = 4 } = {}) {
  const db = await memDb();
  const ts = '2026-10-01T00:00:00Z';
  await db.run(`INSERT INTO organizations (id, name, slug, type, timezone, created_at) VALUES ('org1', 'Iron', 'iron', 'gym', 'Asia/Kolkata', ?)`, [ts]);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('u1', 'org1', 'm@t.in', 'x', 'CLIENT', 'Member', 1, ?)`, [ts]);
  await db.run(`INSERT INTO clients (id, user_id, org_id, status, goal, created_at) VALUES ('c1', 'u1', 'org1', 'ON_TRACK', 'GENERAL', ?)`, [ts]);
  await db.run(`INSERT INTO client_profiles (client_id, water_target_l, day_start_hour) VALUES ('c1', 3, ?)`, [dayStart]);
  if (prefs) {
    const cols = Object.keys(prefs);
    await db.run(`INSERT INTO notification_preferences (user_id, org_id, updated_at, ${cols.join(', ')}) VALUES ('u1', 'org1', ?, ${cols.map(() => '?').join(', ')})`, [ts, ...Object.values(prefs)]);
  }
  if (water != null) await db.run(`INSERT INTO water_logs (id, client_id, date, litres) VALUES ('w1', 'c1', ?, ?)`, [DAY, water]);
  const run = (when) => generateNotifications(db, 'u1', 'org1', { now: when });
  const byKey = async (k) => db.q1('SELECT * FROM notifications WHERE user_id = ? AND dedup_key = ?', ['u1', k]);
  return { db, run, byKey };
}

// Only the reminder under test switched on, so others cannot mask it.
const ONLY = (k, extra = {}) => ({
  enabled: 1, workout_reminders: 0, water_reminders: 0, nutrition_reminders: 0, daily_summary: 0,
  tomorrow_workout: 0, rest_day_reminders: 0, incomplete_workout: 0, [k]: 1, ...extra,
});

test('someone who never opened Settings still gets reminders (the preferences row is created with its org)', async () => {
  const { db, run } = await setup();
  const made = await run(at(DAY, '13:00'));
  assert.ok(made.some((n) => n.type === 'nutrition_reminder'), JSON.stringify(made));
  const prefs = await db.q1('SELECT org_id FROM notification_preferences WHERE user_id = ?', ['u1']);
  assert.equal(prefs.org_id, 'org1');
});

test('quiet hours: nothing is created inside them, and a due reminder arrives after', async () => {
  const { run } = await setup({ prefs: ONLY('nutrition_reminders', { quiet_hours_start: '22:00', quiet_hours_end: '07:00' }) });
  assert.deepEqual(await run(at(DAY, '23:10')), []);
  const later = await run(at(NEXT, '13:00'));
  assert.equal(later.filter((n) => n.type === 'nutrition_reminder').length, 1);
});

test('water: against the member\'s own target, only when behind pace, once per window', async () => {
  const behind = await setup({ prefs: ONLY('water_reminders'), water: 0.5 });
  const first = await behind.run(at(DAY, '15:00'));
  const w = first.find((n) => n.type === 'water_reminder');
  assert.ok(w, 'behind pace at 3pm with 0.5 of 3 L');
  assert.match(w.body, /0\.5 of 3 L/);
  assert.equal((await behind.run(at(DAY, '15:40'))).length, 0, 'same window: no repeat');

  const onTrack = await setup({ prefs: ONLY('water_reminders'), water: 2.5 });
  assert.equal((await onTrack.run(at(DAY, '15:00'))).length, 0, 'ahead of pace: no nag');
});

test("tomorrow's session is announced in the evening; a rest day only if rest-day reminders are on", async () => {
  const off = await setup({ prefs: ONLY('tomorrow_workout') });
  assert.equal((await off.run(at(DAY, '19:00'))).length, 0, 'rest day tomorrow, rest-day reminders off: silence');

  const on = await setup({ prefs: ONLY('tomorrow_workout', { rest_day_reminders: 1 }) });
  await on.run(at(DAY, '19:00'));
  assert.ok(await on.byKey(`tomorrow_workout:${NEXT}`));

  const planned = await setup({ prefs: ONLY('tomorrow_workout') });
  await planned.db.run(`INSERT INTO workouts (id, org_id, client_id, name, scheduled_date, status, created_at) VALUES ('wk1', 'org1', 'c1', 'Push Day', ?, 'assigned', ?)`, [NEXT, '2026-10-01T00:00:00Z']);
  const made = await planned.run(at(DAY, '19:00'));
  assert.equal(made.length, 1);
  assert.match(made[0].body, /Push Day/);
});

test('daily recap: any time after the chosen time, including after midnight before the day starts', async () => {
  const { run, byKey } = await setup({ prefs: ONLY('daily_summary', { daily_summary_time: '23:30' }) });
  assert.equal((await run(at(DAY, '22:00'))).length, 0, 'before the chosen time');
  // 01:30 the next calendar day is still the 30th's logging day (4am start).
  const made = await run(at(NEXT, '01:30'));
  assert.equal(made.length, 1, JSON.stringify(made));
  const row = await byKey(`daily_summary:${DAY}`);
  assert.ok(row, 'filed under the logging day it summarises');
  assert.equal((await run(at(NEXT, '02:00'))).length, 0, 'once');
});

test('daily recap: inside quiet hours it still lands in the bell, marked silent', async () => {
  const { run } = await setup({ prefs: ONLY('daily_summary', { daily_summary_time: '23:30' }) });
  const [recap] = await run(at(NEXT, '01:30'));
  assert.equal(recap.silent, true, 'default quiet hours run 23:45-07:00');
});

test("daily recap: an evening the app was not opened is caught up the next day -- when there was something to report", async () => {
  const active = await setup({ prefs: ONLY('daily_summary'), water: 2 });
  const made = await active.run(at(NEXT, '10:00'));
  assert.equal(made.length, 1);
  assert.equal(made[0].title, '📊 Yesterday on Barbell');
  assert.match(made[0].body, /2 L water/);
  assert.equal(made[0].silent, undefined);

  const idle = await setup({ prefs: ONLY('daily_summary') });
  assert.equal((await idle.run(at(NEXT, '10:00'))).length, 0, 'an empty yesterday is not worth a message');
});

test('daily recap: a 00:30 recap time is not sent early the evening before', async () => {
  const { run } = await setup({ prefs: ONLY('daily_summary', { daily_summary_time: '00:30' }) });
  assert.equal((await run(at(DAY, '22:00'))).length, 0);
  assert.equal((await run(at(NEXT, '00:45'))).length, 1);
});

test('meal logging: after midday only if nothing is logged', async () => {
  const empty = await setup({ prefs: ONLY('nutrition_reminders') });
  assert.equal((await empty.run(at(DAY, '11:00'))).length, 0, 'morning: too early');
  assert.equal((await empty.run(at(DAY, '13:00'))).length, 1);

  const fed = await setup({ prefs: ONLY('nutrition_reminders') });
  await fed.db.run(`INSERT INTO meal_logs (id, client_id, date, name, calories, protein, carbs, fat, eaten) VALUES ('m1', 'c1', ?, 'Oats', 300, 10, 50, 5, 1)`, [DAY]);
  assert.equal((await fed.run(at(DAY, '13:00'))).length, 0);
});

test('PATCH /notifications/preferences keeps what the browser answered (it used to 400)', async () => {
  const express = (await import('express')).default;
  const jwt = (await import('jsonwebtoken')).default;
  const { config } = await import('../src/config.js');
  const routes = (await import('../src/routes/notifications.js')).default;
  const { db } = await setup();
  const app = express();
  app.set('db', db);
  app.use(express.json());
  app.use('/api/notifications', routes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/notifications/preferences`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: 'u1', role: 'CLIENT', org: 'org1' }, config.jwtSecret)}` },
      body: JSON.stringify({ browser_permission: 'granted', prompted_at: '2026-10-30T09:00:00.000Z' }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    const { preferences } = await res.json();
    assert.equal(preferences.browser_permission, 'granted');
    assert.equal(preferences.prompted_at, '2026-10-30T09:00:00.000Z');
  } finally {
    server.closeAllConnections(); server.close();
  }
});

test('everything off: nothing at all', async () => {
  const { run } = await setup({ prefs: { enabled: 0 } });
  assert.deepEqual(await run(at(DAY, '13:00')), []);
});
