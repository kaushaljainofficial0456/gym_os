// ============================================================
// Tests for GET /api/trainer/clients/:clientId/dashboard
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import express from 'express';
import { config } from '../src/config.js';
import { todayKey, daysAgoIso } from '../src/utils/time.js';

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
    raw: db
  });
  return mk();
}

const idp = (p) => 'id_' + Math.random().toString(36).slice(2, 10);

function makeToken(userId, role, orgId, name = 'Test') {
  return jwt.sign({ sub: userId, role, org: orgId, name, email: 'test@test.com' }, config.jwtSecret, { expiresIn: '1h' });
}

// ---- Seed: 2 orgs, 2 trainers in org1, 1 in org2 ----
async function seedFull(db) {
  const org1 = idp('org');
  const org2 = idp('org');
  const owner1 = idp('usr');
  const trainerA = idp('usr');
  const trainerB = idp('usr');
  const trainer2 = idp('usr');
  const client1U = idp('usr'); const client1C = idp('cli');
  const client2U = idp('usr'); const client2C = idp('cli');
  const client3U = idp('usr'); const client3C = idp('cli');
  const client4U = idp('usr'); const client4C = idp('cli');
  const client5U = idp('usr'); const client5C = idp('cli');

  // Org 1
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)',
    [org1, 'Gym 1', 'gym1', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'GYM_OWNER', ?, 1, ?)`,
    [owner1, org1, 'owner1@test.com', 'x', 'Owner 1', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'TRAINER', ?, 1, ?)`,
    [trainerA, org1, 'trainerA@test.com', 'x', 'Trainer A', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'TRAINER', ?, 1, ?)`,
    [trainerB, org1, 'trainerB@test.com', 'x', 'Trainer B', '2026-01-01T00:00:00Z']);

  // Client 1 — assigned to Trainer A
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    [client1U, org1, 'c1@test.com', 'x', 'Alice', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, trainer_id, goal, current_weight, target_weight, start_weight, height_cm, age, sex, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [client1C, client1U, org1, trainerA, 'FAT_LOSS', 80, 75, 85, 170, 28, 'MALE', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO client_profiles (client_id, water_target_l, sleep_target_h) VALUES (?, 3, 8)', [client1C]);

  // Client 2 — assigned to Trainer A
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    [client2U, org1, 'c2@test.com', 'x', 'Bob', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, trainer_id, goal, current_weight, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [client2C, client2U, org1, trainerA, 'MUSCLE_GAIN', 70, '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO client_profiles (client_id) VALUES (?)', [client2C]);

  // Client 3 — assigned to Trainer B
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    [client3U, org1, 'c3@test.com', 'x', 'Charlie', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, trainer_id, goal, current_weight, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [client3C, client3U, org1, trainerB, 'GENERAL', 85, '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO client_profiles (client_id) VALUES (?)', [client3C]);

  // Org 2
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)',
    [org2, 'Gym 2', 'gym2', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'TRAINER', ?, 1, ?)`,
    [trainer2, org2, 'trainer2@test.com', 'x', 'Trainer 2', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    [client4U, org2, 'c4@test.com', 'x', 'Diana', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, trainer_id, goal, current_weight, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [client4C, client4U, org2, trainer2, 'FAT_LOSS', 65, '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO client_profiles (client_id) VALUES (?)', [client4C]);

  return {
    org1, org2, owner1, trainerA, trainerB, trainer2,
    client1U, client1C, client2U, client2C, client3U, client3C, client4U, client4C
  };
}

async function startServer(db) {
  const trainerRoutes = (await import('../src/routes/trainer.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/trainer', trainerRoutes(db));
  const server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api/trainer`;
  const close = () => new Promise(r => { server.closeAllConnections(); server.close(r); });
  return { base, close };
}

async function callGet(base, urlPath, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${base}${urlPath}`, { headers });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

// ============================================================
// 1. UNAUTHENTICATED → 401
// ============================================================
test('unauthenticated → 401', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startServer(db);
  t.after(close);
  const r = await callGet(base, `/clients/${s.client1C}/dashboard`, null);
  assert.equal(r.status, 401);
  assert.match(r.json.error, /auth/i);
});

// ============================================================
// 2. CLIENT ROLE → 403
// ============================================================
test('client role → 403', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startServer(db);
  t.after(close);
  const token = makeToken(s.client1U, 'CLIENT', s.org1);
  const r = await callGet(base, `/clients/${s.client1C}/dashboard`, token);
  assert.equal(r.status, 403);
  assert.match(r.json.error, /insufficient/i);
});

// ============================================================
// 3. TRAINER CAN ACCESS ASSIGNED CLIENT
// ============================================================
test('trainer can access assigned client', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startServer(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, `/clients/${s.client1C}/dashboard`, token);
  assert.equal(r.status, 200);
  assert.equal(r.json.client.id, s.client1C);
  assert.equal(r.json.client.name, 'Alice');
});

// ============================================================
// 4. TRAINER CANNOT ACCESS ANOTHER TRAINER'S CLIENT
// ============================================================
test('trainer cannot access another trainer\'s client', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startServer(db);
  t.after(close);

  // Trainer A tries to access Trainer B's client
  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, `/clients/${s.client3C}/dashboard`, token);
  assert.equal(r.status, 404, 'returns 404 to avoid leaking existence');
});

// ============================================================
// 5. CROSS-ORG CLIENT BLOCKED
// ============================================================
test('cross-org client blocked', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startServer(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, `/clients/${s.client4C}/dashboard`, token);
  assert.equal(r.status, 404);
});

// ============================================================
// 6. TRAINER WITH NO ASSIGNED CLIENT → 404
// ============================================================
test('nonexistent client → 404', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startServer(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, '/clients/nonexistent/dashboard', token);
  assert.equal(r.status, 404);
});

// ============================================================
// 7. CLIENT INFORMATION RETURNED CORRECTLY
// ============================================================
test('client information returned correctly', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startServer(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, `/clients/${s.client1C}/dashboard`, token);
  assert.equal(r.status, 200);
  const c = r.json.client;
  assert.equal(c.id, s.client1C);
  assert.equal(c.name, 'Alice');
  assert.equal(c.email, 'c1@test.com');
  assert.equal(c.goal, 'FAT_LOSS');
  assert.equal(c.currentWeight, 80);
  assert.equal(c.targetWeight, 75);
  assert.equal(c.height, 170);
  assert.equal(c.age, 28);
  assert.equal(c.sex, 'MALE');
  assert.equal(c.startWeight, 85);
});

// ============================================================
// 8. ADHERENCE RETURNED CORRECTLY
// ============================================================
test('adherence returned correctly', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startServer(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, `/clients/${s.client1C}/dashboard`, token);
  assert.equal(r.status, 200);
  assert.ok(typeof r.json.summary.adherence === 'number', 'adherence is a number');
  assert.ok(r.json.summary.status, 'status is present');
  assert.ok(['ON_TRACK', 'AT_RISK', 'NEEDS_ATTENTION', 'INACTIVE'].includes(r.json.summary.status));
});

// ============================================================
// 9. WEIGHT HISTORY RETURNED
// ============================================================
test('weight history returned', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const today = todayKey();
  const { daysAgoIso: dAgo } = await import('../src/utils/time.js');
  // Add weight logs
  await db.run('INSERT INTO weight_logs (id, client_id, date, weight, source, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [idp('wlg'), s.client1C, dAgo(30), 85, 'manual', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO weight_logs (id, client_id, date, weight, source, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [idp('wlg'), s.client1C, dAgo(14), 82, 'manual', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO weight_logs (id, client_id, date, weight, source, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [idp('wlg'), s.client1C, today, 80, 'manual', '2026-01-01T00:00:00Z']);

  const { base, close } = await startServer(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, `/clients/${s.client1C}/dashboard`, token);
  assert.equal(r.status, 200);
  assert.ok(r.json.weight.history.length >= 2, 'has weight history');
  assert.equal(r.json.weight.current, 80);
  assert.equal(r.json.weight.target, 75);
  // History should have date + weight objects
  const first = r.json.weight.history[0];
  assert.ok(first.date, 'has date');
  assert.ok(typeof first.weight === 'number', 'has weight number');
});

// ============================================================
// 10. 7-DAY WEIGHT CHANGE CORRECT
// ============================================================
test('7-day weight change correct', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const today = todayKey();
  const { daysAgoIso: dAgo } = await import('../src/utils/time.js');
  await db.run('INSERT INTO weight_logs (id, client_id, date, weight, source, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [idp('wlg'), s.client1C, dAgo(7), 82, 'manual', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO weight_logs (id, client_id, date, weight, source, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [idp('wlg'), s.client1C, today, 80, 'manual', '2026-01-01T00:00:00Z']);

  const { base, close } = await startServer(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, `/clients/${s.client1C}/dashboard`, token);
  assert.equal(r.status, 200);
  assert.equal(r.json.weight.change7d, -2);
  assert.equal(r.json.summary.weightChange7d, -2);
});

// ============================================================
// 11. TODAY'S WORKOUT RETURNED
// ============================================================
test('today\'s workout returned', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const today = todayKey();
  await db.run('INSERT INTO workouts (id, org_id, client_id, trainer_id, name, scheduled_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [idp('wko'), s.org1, s.client1C, s.trainerA, 'Push Day', today, 'assigned', '2026-01-01T00:00:00Z']);

  const { base, close } = await startServer(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, `/clients/${s.client1C}/dashboard`, token);
  assert.equal(r.status, 200);
  assert.ok(r.json.workouts.today, 'today workout present');
  assert.equal(r.json.workouts.today.name, 'Push Day');
  assert.equal(r.json.workouts.today.status, 'assigned');
});

// ============================================================
// 12. RECENT WORKOUTS RETURNED
// ============================================================
test('recent workouts returned', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { daysAgoIso: dAgo } = await import('../src/utils/time.js');
  const today = todayKey();
  // Create 3 recent workouts
  for (let i = 0; i < 3; i++) {
    await db.run('INSERT INTO workouts (id, org_id, client_id, trainer_id, name, scheduled_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [idp('wko'), s.org1, s.client1C, s.trainerA, `Workout ${i}`, dAgo(14 - i * 2), 'completed', '2026-01-01T00:00:00Z']);
  }

  const { base, close } = await startServer(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, `/clients/${s.client1C}/dashboard`, token);
  assert.equal(r.status, 200);
  assert.ok(r.json.workouts.recent.length >= 3, 'has recent workouts');
  // Most recent first
  assert.ok(r.json.workouts.recent[0].date >= r.json.workouts.recent[1].date, 'sorted desc');
  // Each has required fields
  const w = r.json.workouts.recent[0];
  assert.ok(w.date, 'has date');
  assert.ok(w.name, 'has name');
  assert.ok(w.status, 'has status');
});

// ============================================================
// 13. WORKOUT COMPLETION RATE CORRECT
// ============================================================
test('workout completion rate correct', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { daysAgoIso: dAgo } = await import('../src/utils/time.js');
  const today = todayKey();
  // 3 completed + 1 assigned in last 7 days
  for (let i = 0; i < 3; i++) {
    await db.run('INSERT INTO workouts (id, org_id, client_id, trainer_id, name, scheduled_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [idp('wko'), s.org1, s.client1C, s.trainerA, `W${i}`, dAgo(7 - i), 'completed', '2026-01-01T00:00:00Z']);
  }
  await db.run('INSERT INTO workouts (id, org_id, client_id, trainer_id, name, scheduled_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [idp('wko'), s.org1, s.client1C, s.trainerA, 'W today', today, 'assigned', '2026-01-01T00:00:00Z']);

  const { base, close } = await startServer(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, `/clients/${s.client1C}/dashboard`, token);
  assert.equal(r.status, 200);
  // 3 completed out of 4 = 75%
  assert.equal(r.json.workouts.completionRate7d, 75);
  assert.equal(r.json.summary.workoutsCompleted7d, 3);
  assert.equal(r.json.summary.workoutsScheduled7d, 4);
});

// ============================================================
// 14. ALERTS RETURNED
// ============================================================
test('alerts returned', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startServer(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, `/clients/${s.client1C}/dashboard`, token);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.alerts), 'alerts is array');
  // Each alert has required fields (may be empty if no rules fired)
  for (const a of r.json.alerts) {
    assert.ok(a.type, 'alert has type');
    assert.ok(a.severity, 'alert has severity');
    assert.ok(a.title, 'alert has title');
  }
});

// ============================================================
// 15. NUTRITION DATA RETURNED WHEN PLAN/LOGS EXIST
// ============================================================
test('nutrition data returned when plan and logs exist', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const today = todayKey();
  // Create nutrition plan
  const planId = idp('nut');
  await db.run('INSERT INTO nutrition_plans (id, org_id, trainer_id, client_id, name, calories, protein, carbs, fat, is_template, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)',
    [planId, s.org1, s.trainerA, s.client1C, 'Cut Plan', 2200, 160, 220, 70, '2026-01-01T00:00:00Z']);
  // Create meal log
  await db.run('INSERT INTO meal_logs (id, client_id, date, name, calories, protein, carbs, fat, eaten, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
    [idp('mlg'), s.client1C, today, 'Lunch', 600, 40, 70, 15, 'manual']);
  await db.run('INSERT INTO meal_logs (id, client_id, date, name, calories, protein, carbs, fat, eaten, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
    [idp('mlg'), s.client1C, today, 'Snack', 300, 20, 35, 10, 'manual']);

  const { base, close } = await startServer(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, `/clients/${s.client1C}/dashboard`, token);
  assert.equal(r.status, 200);
  assert.equal(r.json.nutrition.today.calories, 900, 'total eaten calories');
  assert.equal(r.json.nutrition.today.protein, 60, 'total eaten protein');
  assert.equal(r.json.nutrition.today.targetCalories, 2200, 'plan target calories');
  assert.equal(r.json.nutrition.today.targetProtein, 160, 'plan target protein');
  assert.equal(r.json.nutrition.today.targetCarbs, 220, 'plan target carbs');
  assert.equal(r.json.nutrition.today.targetFat, 70, 'plan target fat');
});

// ============================================================
// 16. MISSING NUTRITION PLAN HANDLED SAFELY
// ============================================================
test('missing nutrition plan handled safely', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startServer(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, `/clients/${s.client1C}/dashboard`, token);
  assert.equal(r.status, 200);
  assert.equal(r.json.nutrition.today.calories, 0);
  assert.equal(r.json.nutrition.today.targetCalories, null);
  assert.equal(r.json.nutrition.today.targetProtein, null);
});

// ============================================================
// 17. MISSING WEIGHT HISTORY HANDLED SAFELY
// ============================================================
test('missing weight history handled safely', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startServer(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, `/clients/${s.client1C}/dashboard`, token);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.weight.history, [], 'empty weight history');
  assert.equal(r.json.weight.change7d, null, 'no change when no data');
  assert.equal(r.json.summary.weightChange7d, null);
});

// ============================================================
// 18. MISSING WORKOUT HANDLED SAFELY
// ============================================================
test('missing workout handled safely', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startServer(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, `/clients/${s.client1C}/dashboard`, token);
  assert.equal(r.status, 200);
  assert.equal(r.json.workouts.today, null, 'no today workout');
  assert.deepEqual(r.json.workouts.recent, [], 'no recent workouts');
  assert.equal(r.json.workouts.completionRate7d, null, 'no completion rate');
  assert.equal(r.json.summary.workoutsCompleted7d, 0);
  assert.equal(r.json.summary.workoutsScheduled7d, 0);
});

// ============================================================
// 19. RESPONSE CONTAINS REQUIRED TOP-LEVEL SECTIONS
// ============================================================
test('response contains required top-level sections', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startServer(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, `/clients/${s.client1C}/dashboard`, token);
  assert.equal(r.status, 200);
  assert.ok(r.json.client, 'has client');
  assert.ok(r.json.summary, 'has summary');
  assert.ok(r.json.weight, 'has weight');
  assert.ok(r.json.workouts, 'has workouts');
  assert.ok(r.json.nutrition, 'has nutrition');
  assert.ok(r.json.hydration, 'has hydration');
  assert.ok(r.json.alerts !== undefined, 'has alerts');
  assert.ok(r.json.recentActivity !== undefined, 'has recentActivity');
  // Summary sub-fields
  const s_ = r.json.summary;
  assert.ok('status' in s_);
  assert.ok('adherence' in s_);
  assert.ok('weightChange7d' in s_);
  assert.ok('workoutsCompleted7d' in s_);
  assert.ok('workoutsScheduled7d' in s_);
  assert.ok('nutritionAdherence' in s_);
});

// ============================================================
// 20. NO SENSITIVE FIELDS EXPOSED
// ============================================================
test('no sensitive fields exposed', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startServer(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, `/clients/${s.client1C}/dashboard`, token);
  assert.equal(r.status, 200);
  const body = JSON.stringify(r.json);
  assert.ok(!body.includes('password'), 'no password field');
  assert.ok(!body.includes('password_hash'), 'no password_hash');
  assert.ok(!body.includes('token'), 'no token field');
  assert.ok(!body.includes('secret'), 'no secret field');
  assert.ok(!body.includes('Bearer'), 'no Bearer token');
  // client info should not contain trainer_id or org_id (internal)
  assert.ok(!('trainerId' in r.json.client), 'no trainerId exposed');
  assert.ok(!('orgId' in r.json.client), 'no orgId exposed');
  assert.ok(!('org_id' in r.json.client), 'no org_id exposed');
  assert.ok(!('trainer_id' in r.json.client), 'no trainer_id exposed');
});

// ============================================================
// GYM_OWNER → 403 (trainer-specific endpoint)
// ============================================================
test('GYM_OWNER → 403 on trainer-specific endpoint', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startServer(db);
  t.after(close);

  const token = makeToken(s.owner1, 'GYM_OWNER', s.org1);
  const r = await callGet(base, `/clients/${s.client1C}/dashboard`, token);
  assert.equal(r.status, 403);
  assert.match(r.json.error, /insufficient/i);
});

// ============================================================
// HYDRATION DATA RETURNED
// ============================================================
test('hydration data returned', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const today = todayKey();
  await db.run('INSERT INTO water_logs (id, client_id, date, litres) VALUES (?, ?, ?, ?)',
    [idp('wat'), s.client1C, today, 2.5]);

  const { base, close } = await startServer(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, `/clients/${s.client1C}/dashboard`, token);
  assert.equal(r.status, 200);
  assert.equal(r.json.hydration.today, 2.5);
  assert.equal(r.json.hydration.target, 3);
});

// ============================================================
// RECENT ACTIVITY FEED
// ============================================================
test('recent activity feed populated from workouts', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { daysAgoIso: dAgo } = await import('../src/utils/time.js');
  const today = todayKey();
  await db.run('INSERT INTO workouts (id, org_id, client_id, trainer_id, name, scheduled_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [idp('wko'), s.org1, s.client1C, s.trainerA, 'Push', dAgo(2), 'completed', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO workouts (id, org_id, client_id, trainer_id, name, scheduled_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [idp('wko'), s.org1, s.client1C, s.trainerA, 'Pull', today, 'assigned', '2026-01-01T00:00:00Z']);

  const { base, close } = await startServer(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, `/clients/${s.client1C}/dashboard`, token);
  assert.equal(r.status, 200);
  assert.ok(r.json.recentActivity.length >= 2, 'has recent activity');
  const push = r.json.recentActivity.find(a => a.name === 'Push');
  assert.ok(push, 'push workout in activity');
  assert.equal(push.type, 'workout_completed');
  const pull = r.json.recentActivity.find(a => a.name === 'Pull');
  assert.ok(pull, 'pull workout in activity');
  assert.equal(pull.type, 'workout_scheduled');
});
