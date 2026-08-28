// ============================================================
// ML MONITORING DASHBOARD — the module deferred out of Phase 3c pending
// its own schema investigation (see mlMonitoringDashboard.js's own
// header for exactly which real tables/events back every number).
// Covers: the model-card summary, aggregation of PERSISTED workouts
// rows, aggregation of the two NEW calorie_ml_* events this pass added,
// and — critically — a real end-to-end proof (subprocess, provider=ml)
// that estimateWorkoutCalories() actually WRITES those events now,
// not just that the aggregation math is correct in isolation.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { resetRateLimits } from '../src/rateLimit.js';
import { hashPassword } from '../src/auth.js';
import { id, now } from '../src/ids.js';
import { runWithProvider, MODULES } from './helpers/providerRunner.js';
import {
  getModelCard, getEstimateStats, getEstimateActivity, getMlHealth, getMlMonitoringOverview,
} from '../src/services/intelligence/mlMonitoringDashboard.js';

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
    raw: db,
  });
  return mk();
}

async function seedOrgAndClient(db, { orgId = 'o1', clientId = 'c1' } = {}) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [orgId, 'Gym', 'gym-' + orgId, now()]);
  const userId = 'u_' + clientId;
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, 'x', 'CLIENT', 'C', 1, ?)`,
    [userId, orgId, `${clientId}@test.com`, now()]);
  await db.run(`INSERT INTO clients (id, user_id, org_id, goal, age, sex, height_cm, start_weight, current_weight, created_at) VALUES (?, ?, ?, 'FAT_LOSS', 30, 'M', 175, 80, 78, ?)`,
    [clientId, userId, orgId, now()]);
}

async function seedCompletedWorkout(db, { workoutId, orgId = 'o1', clientId = 'c1', provider, modelVersion, est, lower, upper, estimatedAt }) {
  await db.run(
    `INSERT INTO workouts (id, org_id, client_id, name, status, estimated_active_kcal, lower_kcal, upper_kcal, model_version, schema_version, calorie_provider, calorie_estimated_at, created_at)
     VALUES (?, ?, ?, 'Push Day', 'completed', ?, ?, ?, ?, '0.2', ?, ?, ?)`,
    [workoutId, orgId, clientId, est, lower, upper, modelVersion, provider, estimatedAt, now()]);
}

async function seedEvent(db, { type, data, createdAt }) {
  await db.run(`INSERT INTO events (id, org_id, user_id, type, data_json, created_at) VALUES (?, NULL, NULL, ?, ?, ?)`,
    [id('evt'), type, JSON.stringify(data), createdAt]);
}

test.beforeEach(() => { resetRateLimits(); });

// ---------------------------------------------------------------
// MODEL CARD
// ---------------------------------------------------------------

test('getModelCard: reads real metadata straight from the shipped skosCalV1.model.json artifact', () => {
  const card = getModelCard();
  assert.equal(card.modelVersion, 'skos-cal-v1');
  assert.equal(card.schemaVersion, '0.2');
  assert.ok(card.trainedOn && typeof card.trainedOn.participants === 'number', 'real participant count from the model artifact, not re-typed');
  assert.ok(Array.isArray(card.knownExercises) && card.knownExercises.includes('BENCH_PRESS'));
  assert.equal(typeof card.plausibilityCapKcalPerMin, 'number');
  assert.ok(Array.isArray(card.bodyWeightValidRangeKg) && card.bodyWeightValidRangeKg.length === 2);
  assert.equal(typeof card.mlEnabled, 'boolean', 'reflects whatever provider this test process actually resolved');
});

// ---------------------------------------------------------------
// ESTIMATE STATS / ACTIVITY — real PERSISTED workouts rows only
// ---------------------------------------------------------------

test('getEstimateStats: aggregates real persisted workouts by provider, never previews', async () => {
  const db = await memDb();
  await seedOrgAndClient(db);
  const recent = new Date().toISOString();
  await seedCompletedWorkout(db, { workoutId: 'w1', provider: 'baseline', modelVersion: 'skos-cal-baseline-v1', est: 200, lower: 170, upper: 230, estimatedAt: recent });
  await seedCompletedWorkout(db, { workoutId: 'w2', provider: 'baseline', modelVersion: 'skos-cal-baseline-v1', est: 300, lower: 255, upper: 345, estimatedAt: recent });
  await seedCompletedWorkout(db, { workoutId: 'w3', provider: 'ml', modelVersion: 'skos-cal-v1', est: 250, lower: 200, upper: 300, estimatedAt: recent });

  const stats = await getEstimateStats(db, { days: 30 });
  assert.equal(stats.totalEstimates, 3);
  const baseline = stats.byProvider.find((p) => p.provider === 'baseline');
  const ml = stats.byProvider.find((p) => p.provider === 'ml');
  assert.equal(baseline.count, 2);
  assert.equal(baseline.avgKcal, 250, 'mean of 200 and 300');
  assert.equal(ml.count, 1);
  assert.equal(ml.modelVersions[0], 'skos-cal-v1');
  // interval width: (300-200)/250 * 100 = 40%
  assert.equal(ml.avgIntervalWidthPct, 40);
});

test('getEstimateStats: a workout outside the window is excluded', async () => {
  const db = await memDb();
  await seedOrgAndClient(db);
  await seedCompletedWorkout(db, { workoutId: 'w_old', provider: 'baseline', modelVersion: 'skos-cal-baseline-v1', est: 200, lower: 170, upper: 230, estimatedAt: '2020-01-01T00:00:00.000Z' });
  const stats = await getEstimateStats(db, { days: 30 });
  assert.equal(stats.totalEstimates, 0);
});

test('getEstimateActivity: buckets persisted estimates per day per provider', async () => {
  const db = await memDb();
  await seedOrgAndClient(db);
  const today = new Date().toISOString();
  await seedCompletedWorkout(db, { workoutId: 'w1', provider: 'baseline', modelVersion: 'v', est: 100, lower: 85, upper: 115, estimatedAt: today });
  await seedCompletedWorkout(db, { workoutId: 'w2', provider: 'ml', modelVersion: 'skos-cal-v1', est: 120, lower: 100, upper: 140, estimatedAt: today });

  const days = await getEstimateActivity(db, { days: 7 });
  assert.equal(days.length, 7);
  const todayBucket = days[days.length - 1];
  assert.equal(todayBucket.baseline, 1);
  assert.equal(todayBucket.ml, 1);
  assert.equal(todayBucket.mock, 0);
});

// ---------------------------------------------------------------
// ML HEALTH — real telemetry from calorie_ml_success / calorie_ml_fallback
// ---------------------------------------------------------------

test('getMlHealth: an empty platform honestly reports "not instrumented yet", never a fabricated rate', async () => {
  const db = await memDb();
  const health = await getMlHealth(db, { days: 30 });
  assert.equal(health.instrumented, false);
  assert.equal(health.totalAttempts, 0);
  assert.equal(health.fallbackRatePct, null);
  assert.equal(health.flaggedSuccessRatePct, null);
});

test('getMlHealth: computes real fallback rate and per-category breakdown', async () => {
  const db = await memDb();
  const recent = new Date().toISOString();
  await seedEvent(db, { type: 'calorie_ml_success', data: { hasNote: false, stage: 'completion' }, createdAt: recent });
  await seedEvent(db, { type: 'calorie_ml_success', data: { hasNote: true, stage: 'completion' }, createdAt: recent });
  await seedEvent(db, { type: 'calorie_ml_fallback', data: { category: 'ml_timeout', stage: 'completion' }, createdAt: recent });
  await seedEvent(db, { type: 'calorie_ml_fallback', data: { category: 'ml_timeout', stage: 'completion' }, createdAt: recent });
  await seedEvent(db, { type: 'calorie_ml_fallback', data: { category: 'invalid_output', stage: 'preview' }, createdAt: recent });

  const health = await getMlHealth(db, { days: 30 });
  assert.equal(health.instrumented, true);
  assert.equal(health.totalAttempts, 5);
  assert.equal(health.successCount, 2);
  assert.equal(health.fallbackCount, 3);
  assert.equal(health.fallbackRatePct, 60, '3 of 5 attempts fell back');
  const timeoutCat = health.fallbacksByCategory.find((c) => c.category === 'ml_timeout');
  assert.equal(timeoutCat.count, 2);
  assert.equal(health.flaggedSuccessCount, 1, 'one of the two successes carried a model-reported note');
  assert.equal(health.flaggedSuccessRatePct, 50);
});

test('getMlHealth: events outside the window are excluded', async () => {
  const db = await memDb();
  await seedEvent(db, { type: 'calorie_ml_success', data: { hasNote: false }, createdAt: '2020-01-01T00:00:00.000Z' });
  const health = await getMlHealth(db, { days: 30 });
  assert.equal(health.totalAttempts, 0);
});

test('getMlMonitoringOverview: bundles model card, estimate stats and health in one call', async () => {
  const db = await memDb();
  const overview = await getMlMonitoringOverview(db, { days: 30 });
  assert.ok(overview.modelCard.modelVersion);
  assert.equal(overview.estimateStats.totalEstimates, 0);
  assert.equal(overview.mlHealth.instrumented, false);
});

// ---------------------------------------------------------------
// END-TO-END: estimateWorkoutCalories() with a real db and provider=ml
// actually WRITES calorie_ml_success / calorie_ml_fallback -- proves
// the wiring, not just the aggregation math above. Subprocess-isolated
// (config resolves CALORIE_MODEL_PROVIDER once at startup).
// ---------------------------------------------------------------

test('estimateWorkoutCalories(provider=ml) with a real db writes calorie_ml_success, readable by getMlHealth', () => {
  const snippet = `
    const { DatabaseSync } = await import('node:sqlite');
    const fs = await import('node:fs');
    const dbRaw = new DatabaseSync(':memory:');
    dbRaw.exec('PRAGMA foreign_keys = ON;');
    dbRaw.exec(fs.readFileSync('${MODULES.schema}', 'utf8'));
    const adapter = {
      async q(sql, params = []) { const stmt = dbRaw.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
      async q1(sql, params = []) { const rows = await adapter.q(sql, params); return rows[0] || null; },
      async run(sql, params = []) { const stmt = dbRaw.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; }
    };
    const cal = await import('${MODULES.calorieModel}');
    const out = await cal.estimateWorkoutCalories({
      user: { body_weight_kg: 78 },
      session: { duration_minutes: 20, intensity_rating: 'moderate' },
      exercises: []
    }, { db: adapter, stage: 'completion' });
    const events = await adapter.q("SELECT type, data_json FROM events WHERE type LIKE 'calorie_ml_%'");
    const health = await (await import('${MODULES.mlMonitoring}')).getMlHealth(adapter, { days: 1 });
    console.log('OUT:' + JSON.stringify({ provider: out.provider, events, health }));
  `;
  const r = runWithProvider({ nodeEnv: 'development', provider: 'ml', snippet });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.match(/OUT:(\{.*\})/)[1]);
  assert.equal(out.provider, 'ml');
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].type, 'calorie_ml_success');
  const data = JSON.parse(out.events[0].data_json);
  assert.equal(data.hasNote, true, 'an empty-exercise session is a real model-flagged case, not clean');
  assert.equal(data.stage, 'completion');
  assert.equal(out.health.instrumented, true);
  assert.equal(out.health.successCount, 1);
  assert.equal(out.health.fallbackCount, 0);
});

test('estimateWorkoutCalories(provider=ml) timeout writes calorie_ml_fallback with category ml_timeout', () => {
  const snippet = `
    const { DatabaseSync } = await import('node:sqlite');
    const fs = await import('node:fs');
    const dbRaw = new DatabaseSync(':memory:');
    dbRaw.exec('PRAGMA foreign_keys = ON;');
    dbRaw.exec(fs.readFileSync('${MODULES.schema}', 'utf8'));
    const adapter = {
      async q(sql, params = []) { const stmt = dbRaw.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
      async q1(sql, params = []) { const rows = await adapter.q(sql, params); return rows[0] || null; },
      async run(sql, params = []) { const stmt = dbRaw.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; }
    };
    const cal = await import('${MODULES.calorieModel}');
    cal.__setMlTimeoutForTests(30);
    cal.__setMlEstimateForTests(() => new Promise(() => {}));
    const out = await cal.estimateWorkoutCalories({
      user: { body_weight_kg: 78 },
      session: { workout_id: 'wko_x', duration_minutes: 20, intensity_rating: 'moderate' },
      exercises: []
    }, { db: adapter, stage: 'completion' });
    const events = await adapter.q("SELECT type, data_json FROM events WHERE type LIKE 'calorie_ml_%'");
    console.log('OUT:' + JSON.stringify({ provider: out.provider, events }));
  `;
  const r = runWithProvider({ nodeEnv: 'development', provider: 'ml', snippet });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.match(/OUT:(\{.*\})/)[1]);
  assert.equal(out.provider, 'baseline', 'still falls back correctly');
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].type, 'calorie_ml_fallback');
  const data = JSON.parse(out.events[0].data_json);
  assert.equal(data.category, 'ml_timeout');
});

test('estimateWorkoutCalories(provider=baseline) writes no calorie_ml_* telemetry -- only ml has anything to monitor', () => {
  const snippet = `
    const { DatabaseSync } = await import('node:sqlite');
    const fs = await import('node:fs');
    const dbRaw = new DatabaseSync(':memory:');
    dbRaw.exec('PRAGMA foreign_keys = ON;');
    dbRaw.exec(fs.readFileSync('${MODULES.schema}', 'utf8'));
    const adapter = {
      async q(sql, params = []) { const stmt = dbRaw.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
      async q1(sql, params = []) { const rows = await adapter.q(sql, params); return rows[0] || null; },
      async run(sql, params = []) { const stmt = dbRaw.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; }
    };
    const cal = await import('${MODULES.calorieModel}');
    await cal.estimateWorkoutCalories({
      user: { body_weight_kg: 78 },
      session: { duration_minutes: 20, intensity_rating: 'moderate' },
      exercises: []
    }, { db: adapter, stage: 'completion' });
    const events = await adapter.q("SELECT type FROM events WHERE type LIKE 'calorie_ml_%'");
    console.log('OUT:' + JSON.stringify({ events }));
  `;
  const r = runWithProvider({ nodeEnv: 'development', provider: 'baseline', snippet });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.match(/OUT:(\{.*\})/)[1]);
  assert.deepEqual(out.events, []);
});

test('POST /workouts/:id/complete (real HTTP route, provider=ml) persists the estimate AND writes calorie_ml_success -- the actual production wiring, not just a direct calorieModel.js call', () => {
  // Mirrors calorieObservability.test.js's own route-level harness (tests
  // F/I) -- the one thing THIS test adds is reading back the events table
  // afterward to prove workouts.js's `db: tx` wiring (added this pass)
  // actually reaches trackCalorieMlEvent, inside the same transaction as
  // the workout completion itself.
  const snippet = `
    const { DatabaseSync } = await import('node:sqlite');
    const fs = await import('node:fs');
    const dbRaw = new DatabaseSync(':memory:');
    dbRaw.exec('PRAGMA foreign_keys = ON;');
    dbRaw.exec(fs.readFileSync('${MODULES.schema}', 'utf8'));
    dbRaw.exec("INSERT INTO organizations (id, name, slug, created_at) VALUES ('o1', 'Gym A', 'gym-a', '2026-01-01T00:00:00Z')");
    dbRaw.exec("INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('u1', 'o1', 'c@a.in', 'x', 'CLIENT', 'C', 1, '2026-01-01T00:00:00Z')");
    dbRaw.exec("INSERT INTO clients (id, user_id, org_id, goal, age, sex, height_cm, start_weight, current_weight, created_at) VALUES ('c1', 'u1', 'o1', 'FAT_LOSS', 30, 'M', 175, 80, 78, '2026-01-01T00:00:00Z')");
    dbRaw.exec("INSERT INTO exercise_library (id, name, primary_muscle, equipment, movement, ex_type, is_global) VALUES ('libA', 'Bench Press', 'CHEST', 'BARBELL', 'horizontal_push', 'compound', 1)");
    // skos-cal-v1 (unlike baseline) deliberately never guesses a duration --
    // it requires a MEASURED one (started_at set, per POST /:id/start),
    // so the fixture seeds a real started_at 20 real minutes in the past
    // rather than relying on the model's own no-duration error path.
    const startedAt = new Date(Date.now() - 20 * 60_000).toISOString();
    dbRaw.exec(\`INSERT INTO workouts (id, org_id, client_id, name, scheduled_date, status, started_at, created_at) VALUES ('wko_1', 'o1', 'c1', 'Push Day', '2026-08-15', 'assigned', '\${startedAt}', '2026-08-15T00:00:00Z')\`);
    dbRaw.exec("INSERT INTO workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec) VALUES ('wxeA', 'wko_1', 'libA', 0, 'Bench Press', 3, '10', '60', 90)");
    const adapter = {
      async q(sql, params = []) { const stmt = dbRaw.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
      async q1(sql, params = []) { const rows = await adapter.q(sql, params); return rows[0] || null; },
      async run(sql, params = []) { const stmt = dbRaw.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
      exec(sql) { dbRaw.exec(sql); },
      async tx(fn) {
        dbRaw.exec('BEGIN');
        try { const out = await fn(adapter); dbRaw.exec('COMMIT'); return out; }
        catch (e) { try { dbRaw.exec('ROLLBACK'); } catch {} throw e; }
      },
      raw: dbRaw
    };
    const express = (await import('express')).default;
    const jwt = (await import('jsonwebtoken')).default;
    const { config } = await import('${MODULES.config}');
    const workoutRoutes = (await import('${MODULES.workouts}')).default;
    const app = express();
    app.use(express.json());
    app.use('/workouts', workoutRoutes(adapter));
    const server = app.listen(0);
    await new Promise((r) => server.on('listening', r));
    const token = jwt.sign({ sub: 'u1', role: 'CLIENT', org: 'o1', name: 'C' }, config.jwtSecret, { expiresIn: '1h' });
    const base = 'http://127.0.0.1:' + server.address().port + '/workouts/wko_1';
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
    const res = await fetch(base + '/complete', {
      method: 'POST', headers,
      body: JSON.stringify({ logs: [{ exercise_id: 'wxeA', sets: [{ actual_reps: 10, actual_weight: 60 }] }] })
    });
    const json = await res.json();
    server.closeAllConnections(); server.close();
    const w = await adapter.q1("SELECT calorie_provider, model_version FROM workouts WHERE id = 'wko_1'");
    const events = await adapter.q("SELECT type, data_json FROM events WHERE type LIKE 'calorie_ml_%'");
    console.log('OUT:' + JSON.stringify({ http: res.status, calorie: json.calorie ?? null, workout: w, events }));
  `;
  const r = runWithProvider({ nodeEnv: 'development', provider: 'ml', snippet });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.match(/OUT:(\{.*\})/)[1]);
  assert.equal(out.http, 200);
  assert.equal(out.workout.calorie_provider, 'ml', 'the real skos-cal-v1 model ran and was persisted');
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].type, 'calorie_ml_success');
  assert.equal(JSON.parse(out.events[0].data_json).stage, 'completion');
});

// ---------------------------------------------------------------
// ROUTE-LEVEL
// ---------------------------------------------------------------

async function startApp(db) {
  const authRoutes = (await import('../src/routes/auth.js')).default;
  const consoleRoutes = (await import('../src/routes/console.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes(db));
  app.use('/api/console', consoleRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, body, token) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close };
}

async function createSuperAdmin(db, api, email = 'admin@sk-os.test') {
  const userId = id('usr');
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, NULL, ?, ?, 'SUPER_ADMIN', ?, 1, ?)`,
    [userId, email, await hashPassword('adminpass1'), 'Platform Admin', now()]);
  const login = await api.call('POST', '/api/auth/login', { email, password: 'adminpass1' });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return { token: login.json.token, userId };
}

test('GET /api/console/intelligence/ml/* via HTTP, SUPER_ADMIN only', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  await seedOrgAndClient(db);
  const recent = new Date().toISOString();
  await seedCompletedWorkout(db, { workoutId: 'w1', provider: 'ml', modelVersion: 'skos-cal-v1', est: 200, lower: 170, upper: 230, estimatedAt: recent });
  await seedEvent(db, { type: 'calorie_ml_success', data: { hasNote: false }, createdAt: recent });
  const admin = await createSuperAdmin(db, api);

  const overview = await api.call('GET', '/api/console/intelligence/ml/overview', undefined, admin.token);
  assert.equal(overview.status, 200);
  assert.ok(overview.json.modelCard.modelVersion);
  assert.equal(overview.json.estimateStats.totalEstimates, 1);
  assert.equal(overview.json.mlHealth.successCount, 1);

  const estimates = await api.call('GET', '/api/console/intelligence/ml/estimates', undefined, admin.token);
  assert.equal(estimates.status, 200);
  assert.equal(estimates.json.byProvider[0].provider, 'ml');

  const activity = await api.call('GET', '/api/console/intelligence/ml/activity?days=7', undefined, admin.token);
  assert.equal(activity.status, 200);
  assert.equal(activity.json.days.length, 7);

  const health = await api.call('GET', '/api/console/intelligence/ml/health', undefined, admin.token);
  assert.equal(health.status, 200);
  assert.equal(health.json.instrumented, true);
});

test('GET /api/console/intelligence/ml/overview rejects a non-SUPER_ADMIN caller', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  await seedOrgAndClient(db);
  const ownerId = id('usr');
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, 'o1', ?, ?, 'GYM_OWNER', 'Owner', 1, ?)`,
    [ownerId, 'owner@test.com', await hashPassword('ownerpass1'), now()]);
  const ownerLogin = await api.call('POST', '/api/auth/login', { email: 'owner@test.com', password: 'ownerpass1' });
  const res = await api.call('GET', '/api/console/intelligence/ml/overview', undefined, ownerLogin.json.token);
  assert.equal(res.status, 403);
});
