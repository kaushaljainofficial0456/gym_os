// ============================================================
// Flexible Calorie Balance — endpoint integration tests. Full express app
// + in-memory SQLite built from the real schema.sql, mirroring the
// existing pattern in meFoodsResolve.test.js. Covers: surplus-threshold
// gating, preview (non-mutating), apply/decline/cancel, cross-user
// isolation, and duplicate-request idempotency. The pure calculation
// engine itself (safety floors, protein protection, 4/4/9 consistency,
// strategy extension) is covered separately in flexibleBalanceCalc.test.js
// — these tests focus on persistence + endpoint behavior only.
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
import { dayKey, addDays } from '../src/utils/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const sdb = new DatabaseSync(':memory:');
  sdb.exec('PRAGMA foreign_keys = ON;');
  sdb.exec(schema);
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, params = []) { const stmt = sdb.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await mk().q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const stmt = sdb.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
    exec(sql) { sdb.exec(sql); },
    // Mirrors src/db.js's own sqlite .tx() implementation exactly (that
    // module only exposes a singleton via getDb(), not a factory usable
    // against an isolated :memory: instance, so this is duplicated here
    // rather than imported).
    async tx(fn) {
      sdb.exec('BEGIN');
      try {
        const txDb = {
          driver: 'sqlite',
          async q(sql, params = []) { const stmt = sdb.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
          async q1(sql, params = []) { const rows = await txDb.q(sql, params); return rows[0] || null; },
          async run(sql, params = []) { const stmt = sdb.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
          exec(sql) { sdb.exec(sql); },
          raw: sdb,
        };
        const out = await fn(txDb);
        sdb.exec('COMMIT');
        return out;
      } catch (e) {
        try { sdb.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      }
    },
    raw: sdb,
  });
  return mk();
}

const TZ = 'Asia/Kolkata'; // matches organizations.timezone default in schema.sql
const yesterday = () => dayKey(addDays(new Date(), -1), TZ);

async function seedFixtures(db) {
  await db.run('INSERT INTO organizations (id, name, slug, timezone, created_at) VALUES (?, ?, ?, ?, ?)', ['o1', 'Gym A', 'gym-a', TZ, '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u1', 'o1', 'client1@test.com', 'x', 'Client One', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)',
    ['c1', 'u1', 'o1', 'GENERAL', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO nutrition_plans (id, org_id, trainer_id, client_id, name, calories, protein, carbs, fat, is_template, created_at) VALUES (?,?,?,?,?,?,?,?,?,0,?)',
    ['np1', 'o1', 'u1', 'c1', 'My Nutrition Plan', 2000, 150, 200, 65, '2026-01-01T00:00:00Z']);

  await db.run('INSERT INTO organizations (id, name, slug, timezone, created_at) VALUES (?, ?, ?, ?, ?)', ['o2', 'Gym B', 'gym-b', TZ, '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u2', 'o2', 'client2@test.com', 'x', 'Client Two', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)',
    ['c2', 'u2', 'o2', 'GENERAL', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO nutrition_plans (id, org_id, trainer_id, client_id, name, calories, protein, carbs, fat, is_template, created_at) VALUES (?,?,?,?,?,?,?,?,?,0,?)',
    ['np2', 'o2', 'u2', 'c2', 'My Nutrition Plan', 1800, 120, 180, 60, '2026-01-01T00:00:00Z']);
}

async function logMeal(db, clientId, date, calories) {
  await db.run(
    `INSERT INTO meal_logs (id, client_id, date, name, calories, protein, carbs, fat, eaten, source) VALUES (?,?,?,?,?,?,?,?,1,'manual')`,
    ['ml_' + Math.random().toString(36).slice(2, 10), clientId, date, 'Test meal', calories, 100, 150, 60],
  );
}

async function startApp() {
  const db = await memDb();
  await seedFixtures(db);
  const meRoutes = (await import('../src/routes/me.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/me', meRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const token = jwt.sign({ sub: 'u1', role: 'CLIENT', org: 'o1', name: 'Client One' }, config.jwtSecret, { expiresIn: '1h' });
  const token2 = jwt.sign({ sub: 'u2', role: 'CLIENT', org: 'o2', name: 'Client Two' }, config.jwtSecret, { expiresIn: '1h' });
  const call = async (method, p, body, tok = token) => {
    const headers = { 'Content-Type': 'application/json' };
    if (tok) headers.Authorization = `Bearer ${tok}`;
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, token, token2, close };
}

test.beforeEach(() => { resetRateLimits(); });

test('GET /me/nutrition/balance: a small (below-threshold) surplus does not prompt', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  await logMeal(db, 'c1', yesterday(), 2080); // +80 over the 2000 base target -- below SURPLUS_PROMPT_THRESHOLD
  const res = await call('GET', '/api/me/nutrition/balance');
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.promptEligible, null);
  assert.equal(res.json.activePlan, null);
});

test('GET /me/nutrition/balance: an eligible surplus is surfaced for prompting', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  await logMeal(db, 'c1', yesterday(), 2350); // +350 -- comfortably above threshold
  const res = await call('GET', '/api/me/nutrition/balance');
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.ok(res.json.promptEligible);
  assert.equal(res.json.promptEligible.surplusCalories, 350);
  assert.equal(res.json.promptEligible.sourceDate, yesterday());
});

test('POST /nutrition/balance/preview does not create a plan (read-only)', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  await logMeal(db, 'c1', yesterday(), 2350);
  const res = await call('POST', '/api/me/nutrition/balance/preview', { strategy: 'EASY' });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.preview.feasible, true);
  assert.equal(res.json.preview.macros.protein, 150); // protected floor
  const after = await call('GET', '/api/me/nutrition/balance');
  assert.equal(after.json.activePlan, null, 'preview must not persist a plan');
});

test('POST /nutrition/balance/apply creates an ACTIVE plan; a repeat GET keeps showing it (not re-prompting)', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  await logMeal(db, 'c1', yesterday(), 2350);
  const applied = await call('POST', '/api/me/nutrition/balance/apply', { strategy: 'EASY' });
  assert.equal(applied.status, 201, JSON.stringify(applied.json));
  assert.equal(applied.json.plan.status, 'ACTIVE');
  assert.equal(applied.json.plan.remainingSurplusCalories, 350);

  const after = await call('GET', '/api/me/nutrition/balance');
  assert.ok(after.json.activePlan);
  assert.equal(after.json.activePlan.id, applied.json.plan.id);
  assert.equal(after.json.promptEligible, null);
});

test('POST /nutrition/balance/decline is idempotent and prevents re-prompting for the same day', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  await logMeal(db, 'c1', yesterday(), 2350);
  const d1 = await call('POST', '/api/me/nutrition/balance/decline');
  assert.equal(d1.status, 200);
  const d2 = await call('POST', '/api/me/nutrition/balance/decline'); // repeat -- must not error
  assert.equal(d2.status, 200);

  const after = await call('GET', '/api/me/nutrition/balance');
  assert.equal(after.json.promptEligible, null, 'the same declined surplus event must not re-prompt');
  assert.equal(after.json.activePlan, null, 'decline must never create a plan');
});

test('POST /nutrition/balance/cancel ends an active plan; base target is what remains in effect', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  await logMeal(db, 'c1', yesterday(), 2350);
  await call('POST', '/api/me/nutrition/balance/apply', { strategy: 'EASY' });
  const cancelled = await call('POST', '/api/me/nutrition/balance/cancel');
  assert.equal(cancelled.status, 200);

  const after = await call('GET', '/api/me/nutrition/balance');
  assert.equal(after.json.activePlan, null);

  const history = await call('GET', '/api/me/nutrition/balance/history');
  assert.equal(history.status, 200);
  assert.equal(history.json.history.length, 1);
  assert.equal(history.json.history[0].status, 'CANCELLED');
});

test('a new surplus while a plan is ACTIVE merges into the SAME plan (never a second one)', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  const day1 = yesterday();
  await logMeal(db, 'c1', day1, 2350); // +350
  const applied = await call('POST', '/api/me/nutrition/balance/apply', { strategy: 'EASY' });
  const planId = applied.json.plan.id;

  // Simulate a day passing: back-date the plan's own bookkeeping by one
  // day (rather than sleeping in real time) and log a second day's
  // surplus on the newly "elapsed" date, exactly like reconcileActivePlan
  // expects to find on its next call.
  const row = await db.q1('SELECT * FROM nutrition_balance_adjustments WHERE id = ?', [planId]);
  const day0 = dayKey(addDays(day1 + 'T00:00:00Z', -1), TZ);
  await db.run('UPDATE nutrition_balance_adjustments SET last_reconciled_date = ? WHERE id = ?', [day0, planId]);
  await logMeal(db, 'c1', day1, 300); // additional food logged for day1 itself -- pushes it further over

  const after = await call('GET', '/api/me/nutrition/balance');
  assert.ok(after.json.activePlan, 'the merge must keep the SAME plan active, not clear it');
  assert.equal(after.json.activePlan.id, planId, 'must be the same plan row, not a second one');
  assert.ok(after.json.activePlan.remainingSurplusCalories > 350, 'the new surplus must have been folded in');

  const rows = await db.q(`SELECT id FROM nutrition_balance_adjustments WHERE client_id = 'c1' AND status = 'ACTIVE'`);
  assert.equal(rows.length, 1, 'exactly one active plan must exist after a merge');
});

test('cross-client isolation: client 2 sees no trace of client 1\'s balance', async (t) => {
  const { db, call, token2, close } = await startApp(); t.after(() => close());
  await logMeal(db, 'c1', yesterday(), 2350);
  await call('POST', '/api/me/nutrition/balance/apply', { strategy: 'EASY' });

  const res = await call('GET', '/api/me/nutrition/balance', undefined, token2);
  assert.equal(res.status, 200);
  assert.equal(res.json.activePlan, null);
  assert.equal(res.json.promptEligible, null);
  assert.equal(res.json.baseTarget.calories, 1800); // client 2's OWN base target, unaffected
});

test('concurrent duplicate apply requests never create two active plans', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  await logMeal(db, 'c1', yesterday(), 2350);
  const [r1, r2] = await Promise.all([
    call('POST', '/api/me/nutrition/balance/apply', { strategy: 'EASY' }),
    call('POST', '/api/me/nutrition/balance/apply', { strategy: 'EASY' }),
  ]);
  assert.equal(r1.status, 201); assert.equal(r2.status, 201);
  const rows = await db.q(`SELECT id FROM nutrition_balance_adjustments WHERE client_id = 'c1' AND status = 'ACTIVE'`);
  assert.equal(rows.length, 1, 'a race between two concurrent applies must still leave exactly one active plan');
});

test('a bad strategy value is rejected by validation, not silently accepted', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  await logMeal(db, 'c1', yesterday(), 2350);
  const res = await call('POST', '/api/me/nutrition/balance/apply', { strategy: 'ULTRA_MEGA' });
  assert.equal(res.status, 422);
});
