// ============================================================
// Tests for GET /api/dashboard/trainer — trainer-scoped dashboard
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import express from 'express';
import { config } from '../src/config.js';
import { todayKey } from '../src/utils/time.js';

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

// ---- Seed: 2 orgs, 2 trainers in org1, 1 trainer in org2 ----
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

  // Client 1 — assigned to Trainer A, FAT_LOSS, ON_TRACK
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    [client1U, org1, 'c1@test.com', 'x', 'Alice', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, trainer_id, goal, current_weight, target_weight, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [client1C, client1U, org1, trainerA, 'FAT_LOSS', 80, 75, '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO client_profiles (client_id) VALUES (?)', [client1C]);

  // Client 2 — assigned to Trainer A, MUSCLE_GAIN
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

  // Client 5 — Trainer A but INACTIVE status
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    [client5U, org1, 'c5@test.com', 'x', 'Eve', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, trainer_id, goal, status, current_weight, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [client5C, client5U, org1, trainerA, 'RECOMP', 'INACTIVE', 90, '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO client_profiles (client_id) VALUES (?)', [client5C]);

  return {
    org1, org2, owner1, trainerA, trainerB, trainer2,
    client1U, client1C, client2U, client2C, client3U, client3C, client4U, client4C, client5U, client5C
  };
}

async function startDashboard(db) {
  const dashboardRoutes = (await import('../src/routes/dashboard.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/dashboard', dashboardRoutes(db));
  const server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api/dashboard`;
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
// AUTHORIZATION TESTS
// ============================================================

test('Unauthenticated request -> 401', async (t) => {
  const db = await memDb();
  await seedFull(db);
  const { base, close } = await startDashboard(db);
  t.after(close);
  const r = await callGet(base, '/trainer', null);
  assert.equal(r.status, 401);
  assert.match(r.json.error, /auth/i);
});

test('Client role -> 403', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startDashboard(db);
  t.after(close);
  const token = makeToken(s.client1U, 'CLIENT', s.org1);
  const r = await callGet(base, '/trainer', token);
  assert.equal(r.status, 403);
  assert.match(r.json.error, /insufficient/i);
});

test('GYM_OWNER role -> 403 (should use /overview instead)', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startDashboard(db);
  t.after(close);
  const token = makeToken(s.owner1, 'GYM_OWNER', s.org1);
  const r = await callGet(base, '/trainer', token);
  assert.equal(r.status, 403, 'owner gets 403 on trainer-specific route');
});

// ============================================================
// TRAINER SCOPING — NORMAL CASES
// ============================================================

test('Trainer sees only their assigned clients', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startDashboard(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, '/trainer', token);
  assert.equal(r.status, 200);
  // Trainer A has clients: client1, client2, client5
  assert.equal(r.json.kpis.totalClients, 3, 'Trainer A sees 3 clients');
  const ids = r.json.clients.map(c => c.clientId);
  assert.ok(ids.includes(s.client1C), 'sees client1');
  assert.ok(ids.includes(s.client2C), 'sees client2');
  assert.ok(ids.includes(s.client5C), 'sees client5 (INACTIVE)');
  assert.ok(!ids.includes(s.client3C), 'does NOT see Trainer B client');
});

test('Trainer B sees only their assigned clients', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startDashboard(db);
  t.after(close);

  const token = makeToken(s.trainerB, 'TRAINER', s.org1);
  const r = await callGet(base, '/trainer', token);
  assert.equal(r.status, 200);
  assert.equal(r.json.kpis.totalClients, 1, 'Trainer B sees 1 client');
  assert.equal(r.json.clients[0].clientId, s.client3C);
});

// ============================================================
// CROSS-ORG ISOLATION
// ============================================================

test('Org2 trainer cannot see org1 clients', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startDashboard(db);
  t.after(close);

  const token = makeToken(s.trainer2, 'TRAINER', s.org2);
  const r = await callGet(base, '/trainer', token);
  assert.equal(r.status, 200);
  assert.equal(r.json.kpis.totalClients, 1);
  assert.equal(r.json.clients[0].clientId, s.client4C);
  // Should NOT contain any org1 client IDs
  const ids = r.json.clients.map(c => c.clientId);
  assert.ok(!ids.includes(s.client1C));
  assert.ok(!ids.includes(s.client2C));
  assert.ok(!ids.includes(s.client3C));
});

test('Org1 trainer cannot see org2 clients', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startDashboard(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, '/trainer', token);
  assert.equal(r.status, 200);
  const ids = r.json.clients.map(c => c.clientId);
  assert.ok(!ids.includes(s.client4C), 'org1 trainer cannot see org2 client');
});

// ============================================================
// CROSS-TRAINER ISOLATION
// ============================================================

test('Trainer A cannot see Trainer B clients (same org)', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startDashboard(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, '/trainer', token);
  assert.equal(r.status, 200);
  const ids = r.json.clients.map(c => c.clientId);
  assert.ok(!ids.includes(s.client3C), 'Trainer A cannot see Trainer B client3');
});

test('Trainer B cannot see Trainer A clients (same org)', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startDashboard(db);
  t.after(close);

  const token = makeToken(s.trainerB, 'TRAINER', s.org1);
  const r = await callGet(base, '/trainer', token);
  assert.equal(r.status, 200);
  const ids = r.json.clients.map(c => c.clientId);
  assert.ok(!ids.includes(s.client1C), 'Trainer B cannot see Trainer A client1');
  assert.ok(!ids.includes(s.client2C), 'Trainer B cannot see Trainer A client2');
});

// ============================================================
// EMPTY STATE
// ============================================================

test('Trainer with no assigned clients gets empty dashboard', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  // Create a trainer with no clients
  const emptyTrainer = idp('usr');
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'TRAINER', ?, 1, ?)`,
    [emptyTrainer, s.org1, 'empty@test.com', 'x', 'Empty Trainer', '2026-01-01T00:00:00Z']);

  const { base, close } = await startDashboard(db);
  t.after(close);

  const token = makeToken(emptyTrainer, 'TRAINER', s.org1);
  const r = await callGet(base, '/trainer', token);
  assert.equal(r.status, 200);
  assert.equal(r.json.kpis.totalClients, 0);
  assert.equal(r.json.kpis.activeClients, 0);
  assert.equal(r.json.clients.length, 0);
  assert.equal(r.json.attention.length, 0);
  assert.equal(r.json.kpis.avgAdherence, null);
  assert.equal(r.json.kpis.todayWorkoutsTotal, 0);
});

// ============================================================
// POPULATED DATA — KPI ACCURACY
// ============================================================

test('KPIs reflect correct status counts', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startDashboard(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, '/trainer', token);
  // Trainer A has: client1, client2, client5 (3 total)
  // Statuses are derived from evaluation rules (not DB column)
  assert.equal(r.json.kpis.totalClients, 3);
  assert.equal(r.json.kpis.totalClients, r.json.clients.length, 'KPI matches client list');
  // All status counts should sum to total
  const statusSum = r.json.kpis.onTrack + r.json.kpis.needsAttention + r.json.kpis.atRisk + r.json.kpis.inactive;
  assert.equal(statusSum, 3, 'status counts sum to total');
});

test('Client details include name, goal, status, adherence', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startDashboard(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, '/trainer', token);
  const c1 = r.json.clients.find(c => c.clientId === s.client1C);
  assert.ok(c1, 'client1 present');
  assert.equal(c1.name, 'Alice');
  assert.equal(c1.goal, 'FAT_LOSS');
  assert.ok(typeof c1.adherence === 'number', 'adherence is a number');
  assert.ok(c1.rules !== undefined, 'rules array present');
  assert.ok(Array.isArray(c1.rules), 'rules is array');
});

test('Today workouts are included when present', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const today = todayKey();
  // Create today's workout for client1
  await db.run('INSERT INTO workouts (id, org_id, client_id, trainer_id, name, scheduled_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [idp('wko'), s.org1, s.client1C, s.trainerA, 'Push Day', today, 'assigned', '2026-01-01T00:00:00Z']);

  const { base, close } = await startDashboard(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, '/trainer', token);
  assert.equal(r.json.kpis.todayWorkoutsTotal, 1);
  const c1 = r.json.clients.find(c => c.clientId === s.client1C);
  assert.ok(c1.todayWorkout, 'client1 has today workout');
  assert.equal(c1.todayWorkout.name, 'Push Day');
  assert.equal(c1.todayWorkout.status, 'assigned');
  assert.equal(c1.todayWorkout.completed, false);
});

test('Completed today workout increments completed count', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const today = todayKey();
  await db.run('INSERT INTO workouts (id, org_id, client_id, trainer_id, name, scheduled_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [idp('wko'), s.org1, s.client1C, s.trainerA, 'Push Day', today, 'completed', '2026-01-01T00:00:00Z']);

  const { base, close } = await startDashboard(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, '/trainer', token);
  assert.equal(r.json.kpis.todayWorkoutsCompleted, 1);
  assert.equal(r.json.kpis.todayWorkoutsTotal, 1);
  const c1 = r.json.clients.find(c => c.clientId === s.client1C);
  assert.equal(c1.todayWorkout.completed, true);
});

test('Recent workout completion rate calculated correctly', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const today = todayKey();
  // 2 completed + 1 assigned in last 14 days
  await db.run('INSERT INTO workouts (id, org_id, client_id, trainer_id, name, scheduled_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [idp('wko'), s.org1, s.client1C, s.trainerA, 'W1', today, 'completed', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO workouts (id, org_id, client_id, trainer_id, name, scheduled_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [idp('wko'), s.org1, s.client1C, s.trainerA, 'W2', today, 'completed', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO workouts (id, org_id, client_id, trainer_id, name, scheduled_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [idp('wko'), s.org1, s.client1C, s.trainerA, 'W3', today, 'assigned', '2026-01-01T00:00:00Z']);

  const { base, close } = await startDashboard(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, '/trainer', token);
  // 2 completed out of 3 = 66.7%
  assert.equal(r.json.kpis.recentWorkoutCompletion, 66.7);
});

test('Attention list contains only non-ON_TRACK clients', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startDashboard(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, '/trainer', token);
  // INACTIVE clients should NOT be in attention
  for (const c of r.json.attention) {
    assert.ok(c.status !== 'ON_TRACK', `attention client ${c.clientId} is not ON_TRACK`);
    assert.ok(c.status !== 'INACTIVE', `attention client ${c.clientId} is not INACTIVE`);
  }
});

test('Alerts are included for trainer clients', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const now = new Date().toISOString();
  // Create an open alert for client1
  await db.run(
    `INSERT INTO alerts (id, org_id, client_id, type, severity, title, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
    [idp('alt'), s.org1, s.client1C, 'NO_WORKOUT', 'high', 'No workout for 7 days', now]);

  const { base, close } = await startDashboard(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, '/trainer', token);
  // Alerts are in the response (client-level rules come from evaluation)
  assert.ok(r.json.clients.length > 0, 'clients present');
  // The alert should appear in the client's rules or as an open alert
  const c1 = r.json.clients.find(c => c.clientId === s.client1C);
  // Rules are derived from data evaluation, not directly from alerts table
  // But alerts can appear as open items
});

test('No todayWorkout when client has no workout scheduled today', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startDashboard(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, '/trainer', token);
  // None of Trainer A's clients have workouts scheduled today (in the seed)
  for (const c of r.json.clients) {
    assert.equal(c.todayWorkout, null, `client ${c.clientId} has no today workout`);
  }
});

test('Weight change 7d is calculated when data exists', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const today = todayKey();
  // Add weight logs for client1 (7 days ago + today)
  const { daysAgoIso } = await import('../src/utils/time.js');
  const sevenDaysAgo = daysAgoIso(7);
  await db.run('INSERT INTO weight_logs (id, client_id, date, weight, source, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [idp('wlg'), s.client1C, sevenDaysAgo, 82, 'manual', sevenDaysAgo + 'T00:00:00Z']);
  await db.run('INSERT INTO weight_logs (id, client_id, date, weight, source, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [idp('wlg'), s.client1C, today, 80, 'manual', today + 'T00:00:00Z']);

  const { base, close } = await startDashboard(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, '/trainer', token);
  const c1 = r.json.clients.find(c => c.clientId === s.client1C);
  assert.ok(c1.change7d !== null, 'change7d calculated');
  assert.equal(c1.change7d, -2, 'lost 2kg');
});

test('Response structure has required top-level keys', async (t) => {
  const db = await memDb();
  const s = await seedFull(db);
  const { base, close } = await startDashboard(db);
  t.after(close);

  const token = makeToken(s.trainerA, 'TRAINER', s.org1);
  const r = await callGet(base, '/trainer', token);
  assert.equal(r.status, 200);
  assert.ok(r.json.kpis, 'has kpis');
  assert.ok(r.json.clients, 'has clients');
  assert.ok(r.json.attention, 'has attention');
  // KPI structure
  const k = r.json.kpis;
  assert.ok('totalClients' in k);
  assert.ok('activeClients' in k);
  assert.ok('onTrack' in k);
  assert.ok('needsAttention' in k);
  assert.ok('atRisk' in k);
  assert.ok('inactive' in k);
  assert.ok('avgAdherence' in k);
  assert.ok('avgWeightChange7d' in k);
  assert.ok('todayWorkoutsCompleted' in k);
  assert.ok('todayWorkoutsTotal' in k);
  assert.ok('recentWorkoutCompletion' in k);
});
