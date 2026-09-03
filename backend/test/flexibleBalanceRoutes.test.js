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

test('a new surplus on a LATER, distinct day merges into the SAME active plan with the exact combined balance (never a second plan, never double-counted)', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  const day1 = yesterday(); // the day the plan was created from: +350 (2350 - 2000)
  await logMeal(db, 'c1', day1, 2350);
  const applied = await call('POST', '/api/me/nutrition/balance/apply', { strategy: 'EASY' });
  const planId = applied.json.plan.id;
  assert.equal(applied.json.plan.remainingSurplusCalories, 350);
  assert.equal(applied.json.plan.dailyAdjustmentCalories, 70);

  // Simulate real time passing -- rather than re-touching day1 (which was
  // already fully accounted for at apply time; re-examining it would
  // double-count that same food, a real gap caught while writing this
  // test, not assumed), back-date last_reconciled_date to TWO days before
  // day1 so reconcile's next completed day is a distinct, clean day
  // (day1 - 1) with its own separate surplus logged on it.
  const dayBefore = dayKey(addDays(day1 + 'T00:00:00Z', -1), TZ);
  const twoBefore = dayKey(addDays(day1 + 'T00:00:00Z', -2), TZ);
  await db.run('UPDATE nutrition_balance_adjustments SET last_reconciled_date = ? WHERE id = ?', [twoBefore, planId]);
  await logMeal(db, 'c1', dayBefore, 2500); // a SEPARATE day's surplus: +500 (2500 - 2000)

  const after = await call('GET', '/api/me/nutrition/balance');
  assert.ok(after.json.activePlan, 'the merge must keep the SAME plan active, not clear it');
  assert.equal(after.json.activePlan.id, planId, 'must be the same plan row, not a second one');
  // Hand-computed: settle day1-1's own planned paydown (70) off the
  // original 350 -> 280, then fold in that day's own new surplus (500)
  // -> 780 total. Anything else here (e.g. re-adding the ORIGINAL 350 a
  // second time) would show up as a wrong number, not just "some number
  // bigger than 350" -- the bug this exact scenario caught earlier.
  assert.equal(after.json.activePlan.remainingSurplusCalories, 780);
  assert.equal(after.json.activePlan.originalSurplusCalories, 850, '350 original + 500 newly merged');

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

test('a plan settles to COMPLETED with no negative drift once its remaining balance reaches zero (final-day rounding)', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  await logMeal(db, 'c1', yesterday(), 2350); // +350
  const applied = await call('POST', '/api/me/nutrition/balance/apply', { strategy: 'EASY' });
  const planId = applied.json.plan.id;

  // Fast-forward to "the plan's last day": directly set a small remaining
  // balance (smaller than one day's own adjustment, exactly the real
  // final-day situation a multi-day plan eventually reaches) and back-date
  // last_reconciled_date so the next GET settles a day two days before the
  // surplus-source day -- deliberately a day with NO food logged at all,
  // so reconcile's own "did THIS day generate a new surplus" check finds
  // nothing to merge and the small manually-set balance settles cleanly
  // to zero (using sourceDate - 1 instead would re-detect the very meal
  // that created the plan and merge it right back in -- caught live while
  // writing this test, not assumed).
  const row = await db.q1('SELECT * FROM nutrition_balance_adjustments WHERE id = ?', [planId]);
  const cleanPrevDay = dayKey(addDays(row.source_date + 'T00:00:00Z', -2), TZ);
  await db.run(
    'UPDATE nutrition_balance_adjustments SET remaining_surplus_calories = ?, last_reconciled_date = ? WHERE id = ?',
    [5, cleanPrevDay, planId], // 5 kcal left -- smaller than daily_adjustment_calories (70)
  );

  const after = await call('GET', '/api/me/nutrition/balance');
  assert.equal(after.status, 200);
  assert.equal(after.json.activePlan, null, 'the plan must close out, not linger with a near-zero balance');
  assert.equal(after.json.justSettled, true, 'the ONE call that closes it out must say so, for the "balance is settled" toast');

  const closedRow = await db.q1('SELECT * FROM nutrition_balance_adjustments WHERE id = ?', [planId]);
  assert.equal(closedRow.status, 'COMPLETED');
  assert.equal(closedRow.remaining_surplus_calories, 0, 'must never go negative -- clamped exactly to zero');

  // A second GET right after must NOT re-announce settlement (justSettled
  // is a one-time edge, not a persisted flag on an already-closed plan).
  const again = await call('GET', '/api/me/nutrition/balance');
  assert.equal(again.json.justSettled, false);
});

test('a manual base-target change is detected and the recalculate endpoint rebuilds against it', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  await logMeal(db, 'c1', yesterday(), 2350);
  await call('POST', '/api/me/nutrition/balance/apply', { strategy: 'EASY' });

  // Simulate editing the base target the same way
  // POST /me/nutrition/targets/confirm does -- a fresh nutrition_plans row,
  // "latest wins".
  await db.run(
    'INSERT INTO nutrition_plans (id, org_id, trainer_id, client_id, name, calories, protein, carbs, fat, is_template, created_at) VALUES (?,?,?,?,?,?,?,?,?,0,?)',
    ['np1_new', 'o1', 'u1', 'c1', 'My Nutrition Plan', 1900, 140, 190, 60, '2026-02-01T00:00:00Z'],
  );

  const drifted = await call('GET', '/api/me/nutrition/balance');
  assert.equal(drifted.json.activePlan.targetChanged, true, 'a live base-target change must be surfaced, never silently ignored');
  assert.equal(drifted.json.activePlan.baseCalorieTarget, 2000, 'the plan keeps its OLD snapshot until an explicit recalculate');

  const recalced = await call('POST', '/api/me/nutrition/balance/recalculate');
  assert.equal(recalced.status, 200, JSON.stringify(recalced.json));
  assert.equal(recalced.json.plan.baseCalorieTarget, 1900);
  assert.equal(recalced.json.plan.baseProteinTarget, 140);
  assert.equal(recalced.json.plan.adjustedProteinTarget, 140, 'protein stays protected across a recalculation too');

  const after = await call('GET', '/api/me/nutrition/balance');
  assert.equal(after.json.activePlan.targetChanged, false, 'recalculating against the new target must clear the drift flag');
});

test('cross-user rejection: client 2 cannot see, cancel, decline, or recalculate client 1\'s plan through any mutation route', async (t) => {
  const { db, call, token2, close } = await startApp(); t.after(() => close());
  await logMeal(db, 'c1', yesterday(), 2350);
  const applied = await call('POST', '/api/me/nutrition/balance/apply', { strategy: 'EASY' });
  const planId = applied.json.plan.id;

  // None of these routes accept a plan/client id from the request -- every
  // one resolves the acting client from the authenticated token only. So
  // client 2's calls can only ever act on client 2's OWN (empty) state --
  // there is no id-based surface to even attempt cross-tenant access on.
  const cancel2 = await call('POST', '/api/me/nutrition/balance/cancel', undefined, token2);
  const decline2 = await call('POST', '/api/me/nutrition/balance/decline', undefined, token2);
  const recalc2 = await call('POST', '/api/me/nutrition/balance/recalculate', undefined, token2);
  assert.equal(cancel2.status, 200); // no-op on client 2's own (nonexistent) plan
  assert.equal(decline2.status, 200); // no-op, nothing eligible for client 2
  assert.equal(recalc2.status, 404); // client 2 has no active plan to recalculate

  // Client 1's plan must be completely untouched by any of the above.
  const row = await db.q1('SELECT status FROM nutrition_balance_adjustments WHERE id = ?', [planId]);
  assert.equal(row.status, 'ACTIVE');
  const stillThere = await call('GET', '/api/me/nutrition/balance');
  assert.ok(stillThere.json.activePlan);
  assert.equal(stillThere.json.activePlan.id, planId);
});

// ---- retroactive correction: editing/deleting a food log for a date a
// plan has already settled must correct the plan's balance by exactly
// the delta, never silently drift or double-apply. ----

test('editing a food log on an ALREADY-SETTLED past date retroactively increases the plan\'s remaining balance by the new surplus', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());

  // Construct the plan directly (rather than via /apply + back-dating
  // BEFORE source_date, which isn't a state reconcile can ever reach in
  // real production -- last_reconciled_date only ever walks FORWARD from
  // source_date, never behind it; caught live while writing this test,
  // not assumed) so that exactly one real, due day -- yesterday -- is
  // left to settle, and nothing beyond it: source_date = 2 days ago,
  // last_reconciled_date = 2 days ago too, so the next (and only) due day
  // is yesterday itself, landing last_reconciled_date there with no
  // further day due before "today".
  const today = dayKey(new Date(), TZ);
  const twoAgo = dayKey(addDays(today + 'T00:00:00Z', -2), TZ);
  const oneAgo = dayKey(addDays(today + 'T00:00:00Z', -1), TZ);
  const planId = 'nba_edittest';
  await db.run(
    `INSERT INTO nutrition_balance_adjustments (
       id, org_id, client_id, source_date, original_surplus_calories, remaining_surplus_calories,
       strategy, planned_days, remaining_days, daily_adjustment_calories,
       base_calorie_target, base_protein_target, base_carbs_target, base_fat_target,
       adjusted_calorie_target, adjusted_protein_target, adjusted_carbs_target, adjusted_fat_target,
       status, last_reconciled_date, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [planId, 'o1', 'c1', twoAgo, 350, 350, 'EASY', 5, 5, 70, 2000, 150, 200, 65, 1930, 150, 186.3, 65, 'ACTIVE', twoAgo, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
  );
  const logId = 'ml_editme';
  await db.run(
    `INSERT INTO meal_logs (id, client_id, date, name, calories, protein, carbs, fat, eaten, source, quantity, unit) VALUES (?,?,?,?,?,?,?,?,1,'manual',?,?)`,
    [logId, 'c1', oneAgo, 'Editable meal', 500, 30, 50, 15, 100, 'g'],
  );

  const settled = await call('GET', '/api/me/nutrition/balance');
  assert.equal(settled.json.activePlan.remainingSurplusCalories, 280, '350 - 70 (one day\'s planned paydown), no new surplus (500 kcal < 2000 target)');
  const dayRow = await db.q1('SELECT * FROM nutrition_balance_adjustment_days WHERE adjustment_id = ? AND date = ?', [planId, oneAgo]);
  assert.ok(dayRow, 'the settled day must be recorded for later retroactive correction');
  assert.equal(dayRow.actual_calories, 500);
  assert.equal(dayRow.day_surplus, 0);

  // Now the client goes back and edits that day's entry up to 2400 kcal
  // (500 * 4.8) -- a genuine new surplus (2400 - 2000 = 400 > threshold)
  // on a day that was already settled. No further day is due to settle
  // between here and "today", so the next GET's own reconcile pass is a
  // clean no-op and the balance it reports is exactly this correction.
  const edited = await call('PUT', `/api/me/meal-logs/${logId}`, { quantity: 480, unit: 'g' });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  assert.equal(edited.json.log.calories, 2400);

  const after = await call('GET', '/api/me/nutrition/balance');
  assert.equal(after.json.activePlan.remainingSurplusCalories, 680, '280 + 400 newly-discovered surplus on the already-settled day');
  // Hand-computed via the same safety math used throughout: safe ceiling
  // = min(300, 800) = 300; ceil(680/5) = 136 <= 300, no extension needed.
  assert.equal(after.json.activePlan.dailyAdjustmentCalories, 140);
  assert.equal(after.json.activePlan.adjustedCalorieTarget, 1860);

  // Deleting that same edit must reverse the correction exactly, back to
  // the pre-edit balance -- not to zero, not double-subtracted.
  const deleted = await call('DELETE', `/api/me/meal-logs/${logId}`);
  assert.equal(deleted.status, 200);
  const afterDelete = await call('GET', '/api/me/nutrition/balance');
  assert.equal(afterDelete.json.activePlan.remainingSurplusCalories, 280);
});

test('editing/deleting a food log for TODAY (never settled) does not touch any plan', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  await logMeal(db, 'c1', yesterday(), 2350);
  const applied = await call('POST', '/api/me/nutrition/balance/apply', { strategy: 'EASY' });
  const planId = applied.json.plan.id;

  const today = dayKey(new Date(), TZ);
  const logId = 'ml_today';
  await db.run(
    `INSERT INTO meal_logs (id, client_id, date, name, calories, protein, carbs, fat, eaten, source, quantity, unit) VALUES (?,?,?,?,?,?,?,?,1,'manual',?,?)`,
    [logId, 'c1', today, 'Today meal', 400, 20, 40, 10, 100, 'g'],
  );

  await call('PUT', `/api/me/meal-logs/${logId}`, { quantity: 900, unit: 'g' }); // huge increase, still today
  const afterEdit = await call('GET', '/api/me/nutrition/balance');
  assert.equal(afterEdit.json.activePlan.remainingSurplusCalories, 350, 'editing an UNSETTLED day (today) must never move the balance');
  assert.equal(afterEdit.json.activePlan.id, planId);

  await call('DELETE', `/api/me/meal-logs/${logId}`);
  const afterDelete = await call('GET', '/api/me/nutrition/balance');
  assert.equal(afterDelete.json.activePlan.remainingSurplusCalories, 350);
});

test('a retroactive deletion that fully removes an already-settled day\'s surplus can bring the plan to COMPLETED', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  const day1 = yesterday();
  await logMeal(db, 'c1', day1, 2350); // +350
  const applied = await call('POST', '/api/me/nutrition/balance/apply', { strategy: 'EASY' });
  const planId = applied.json.plan.id;

  // Manually shrink the plan to a small remaining balance smaller than the
  // surplus about to be deleted, then attach that surplus to an
  // already-settled day so deleting it can fully zero the plan out.
  await db.run('UPDATE nutrition_balance_adjustments SET remaining_surplus_calories = ? WHERE id = ?', [50, planId]);
  const dayBefore = dayKey(addDays(day1 + 'T00:00:00Z', -1), TZ);
  await db.run(
    `INSERT INTO nutrition_balance_adjustment_days (id, adjustment_id, date, base_target, settled_amount, day_surplus, actual_calories, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ['nbad_seed', planId, dayBefore, 2000, 0, 200, 2200, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
  );
  const logId = 'ml_deleteme';
  await db.run(
    `INSERT INTO meal_logs (id, client_id, date, name, calories, protein, carbs, fat, eaten, source) VALUES (?,?,?,?,?,?,?,?,1,'manual')`,
    [logId, 'c1', dayBefore, 'Big meal to delete', 2200, 100, 200, 80],
  );

  const deleted = await call('DELETE', `/api/me/meal-logs/${logId}`);
  assert.equal(deleted.status, 200);
  const after = await call('GET', '/api/me/nutrition/balance');
  assert.equal(after.json.activePlan, null, 'removing the day\'s entire surplus must settle the plan, never leave it lingering');
  const closedRow = await db.q1('SELECT status, remaining_surplus_calories FROM nutrition_balance_adjustments WHERE id = ?', [planId]);
  assert.equal(closedRow.status, 'COMPLETED');
  assert.equal(closedRow.remaining_surplus_calories, 0);
});

// ---- abandonment safety valve + full plan-history coverage ----

test('a plan abandoned for longer than MAX_PLAN_DURATION_DAYS expires outright instead of lingering ACTIVE forever', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  const today = dayKey(new Date(), TZ);
  // last_reconciled_date far enough in the past that no amount of
  // one-day-at-a-time catch-up (this module's normal model) would ever
  // be a reasonable UX -- simulates a client who applied a plan and then
  // never opened the app again.
  const staleDate = dayKey(addDays(today + 'T00:00:00Z', -30), TZ);
  const planId = 'nba_stale';
  await db.run(
    `INSERT INTO nutrition_balance_adjustments (
       id, org_id, client_id, source_date, original_surplus_calories, remaining_surplus_calories,
       strategy, planned_days, remaining_days, daily_adjustment_calories,
       base_calorie_target, base_protein_target, base_carbs_target, base_fat_target,
       adjusted_calorie_target, adjusted_protein_target, adjusted_carbs_target, adjusted_fat_target,
       status, last_reconciled_date, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [planId, 'o1', 'c1', staleDate, 350, 350, 'EASY', 5, 5, 70, 2000, 150, 200, 65, 1930, 150, 186.3, 65, 'ACTIVE', staleDate, staleDate + 'T00:00:00Z', staleDate + 'T00:00:00Z'],
  );

  const res = await call('GET', '/api/me/nutrition/balance');
  assert.equal(res.status, 200);
  assert.equal(res.json.activePlan, null, 'an abandoned plan must not stay reported as active');
  assert.equal(res.json.justExpired, true);
  assert.equal(res.json.justSettled, false, 'expiry and settlement are distinct outcomes, never conflated');

  const row = await db.q1('SELECT status FROM nutrition_balance_adjustments WHERE id = ?', [planId]);
  assert.equal(row.status, 'EXPIRED');

  // A second GET must not re-announce the expiry (one-time edge, not a
  // persisted flag on an already-expired plan) -- matches justSettled's
  // own established behavior.
  const again = await call('GET', '/api/me/nutrition/balance');
  assert.equal(again.json.justExpired, false);
});

test('GET /nutrition/balance/history merges Completed/Cancelled/Expired plans with Declined events, newest first', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());

  // A cancelled plan.
  await logMeal(db, 'c1', yesterday(), 2350);
  await call('POST', '/api/me/nutrition/balance/apply', { strategy: 'EASY' });
  await call('POST', '/api/me/nutrition/balance/cancel');

  // A declined prompt on an EARLIER, distinct day (so it isn't read as
  // the same still-pending surplus event as the one just cancelled).
  const earlier = dayKey(addDays(yesterday() + 'T00:00:00Z', -5), TZ);
  await db.run(
    `INSERT INTO nutrition_balance_prompts (id, org_id, client_id, source_date, decision, created_at) VALUES (?,?,?,?,?,?)`,
    ['nbp_hist', 'o1', 'c1', earlier, 'DECLINED', '2026-01-01T00:00:00Z'],
  );

  const res = await call('GET', '/api/me/nutrition/balance/history');
  assert.equal(res.status, 200);
  const statuses = res.json.history.map((h) => h.status).sort();
  assert.deepEqual(statuses, ['CANCELLED', 'DECLINED']);
  const declined = res.json.history.find((h) => h.status === 'DECLINED');
  assert.equal(declined.sourceDate, earlier);
  assert.equal(declined.strategy, null, 'a decline never redistributed anything -- no strategy to report');
});
