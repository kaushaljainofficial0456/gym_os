// ============================================================
// PERFORMANCE REGRESSION GUARDS
//
// These don't assert wall-clock time (too flaky across machines/CI) --
// they assert QUERY COUNT stays flat as data volume grows, which is what
// actually distinguishes "batched" from "N+1". A regression back to a
// per-row query would fail these even on a fast machine where the wall
// clock might still look acceptable.
//
// Also guards the org-timezone cache added to requireAuth (auth.js /
// utils/time.js) -- the fix for the single biggest per-request cost this
// perf pass found: every authenticated request used to run an uncached
// SELECT against organizations just to populate req.tz.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import express from 'express';
import { config } from '../src/config.js';
import { id, now } from '../src/ids.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

// In-memory SQLite wrapped with a call counter keyed by a caller-supplied
// tag (matched against the SQL text) -- same db surface shape as db.js's
// real adapter (q/q1/run), so routes work against it unmodified.
async function countingMemDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const sdb = new DatabaseSync(':memory:');
  sdb.exec('PRAGMA foreign_keys = ON;');
  sdb.exec(schema);
  const counts = new Map(); // normalized SQL -> count
  const bump = (sql) => {
    const s = sql.trim().replace(/\s+/g, ' ').toUpperCase();
    counts.set(s, (counts.get(s) || 0) + 1);
  };
  // Substring match against every distinct query seen, summed -- callers
  // pass a fragment (e.g. 'SELECT TIMEZONE FROM ORGANIZATIONS') rather than
  // the exact normalized text.
  const countOf = (fragment) => {
    const f = fragment.toUpperCase();
    let total = 0;
    for (const [sql, n] of counts) if (sql.includes(f)) total += n;
    return total;
  };
  const db = {
    driver: 'sqlite',
    async q(sql, params = []) { bump(sql); const stmt = sdb.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await db.q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { bump(sql); const stmt = sdb.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes), lastId: res.lastInsertRowid }; },
    exec(sql) { sdb.exec(sql); },
    async tx(fn) {
      sdb.exec('BEGIN');
      try { const out = await fn(db); sdb.exec('COMMIT'); return out; }
      catch (e) { try { sdb.exec('ROLLBACK'); } catch {} throw e; }
    },
    raw: sdb,
    _counts: counts,
    _countOf: countOf,
    _reset: () => counts.clear(),
  };
  return db;
}

function makeToken(userId, role, orgId) {
  return jwt.sign({ sub: userId, role, org: orgId, name: 'Test', email: 't@test.com' }, config.jwtSecret, { expiresIn: '1h' });
}

async function startApp(db, mountPath, routesFactory) {
  const app = express();
  app.use(express.json());
  app.use(mountPath, routesFactory(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}${mountPath}`;
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { base, close };
}

async function callGet(base, urlPath, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${base}${urlPath}`, { headers });
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON body */ }
  return { status: r.status, json };
}

// ---- shared org/trainer fixture ----
async function seedOrgAndTrainer(db) {
  const org = id('org');
  const owner = id('usr');
  await db.run(`INSERT INTO organizations (id, name, slug, timezone, created_at) VALUES (?, ?, ?, ?, ?)`,
    [org, 'Test Gym', `test-gym-${org}`, 'Asia/Kolkata', now()]);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'GYM_OWNER', ?, 1, ?)`,
    [owner, org, 'owner@test.com', 'x', 'Owner', now()]);
  return { org, owner };
}

// ============================================================
// 1. org-timezone lookup is cached, not re-queried on every call
//
// requireAuth (auth.js) calls getOrgTzCached() on EVERY authenticated
// request, via the process-wide getDb() singleton -- not an injectable db,
// so this is tested at the level that actually matters: repeated calls to
// getOrgTzCached() itself must not repeat the underlying SELECT. This is
// the fix for the single biggest per-request cost this perf pass found
// (every authenticated request across the whole app previously paid one
// extra DB round trip just for this).
// ============================================================
test('perf: getOrgTzCached only queries organizations once per TTL window', async (t) => {
  const db = await countingMemDb();
  const { org } = await seedOrgAndTrainer(db);
  const { getOrgTzCached } = await import('../src/utils/time.js');

  db._reset();
  // Sequential, like real requests over time (not simultaneous at t=0,
  // where a cache with no request-coalescing can legitimately see 2
  // concurrent misses -- that's a separate, acceptable characteristic,
  // not what this guard is checking).
  const tzs = [];
  for (let i = 0; i < 5; i++) tzs.push(await getOrgTzCached(db, org));

  assert.ok(tzs.every((tz) => tz === 'Asia/Kolkata'));
  const orgLookups = db._countOf('SELECT TIMEZONE FROM ORGANIZATIONS WHERE ID');
  // 5 sequential calls must not mean 5 organizations lookups.
  assert.ok(orgLookups <= 1, `expected organizations.timezone to be looked up at most once across 5 calls, got ${orgLookups}`);
});

// ============================================================
// 2. workouts/templates stays O(1) queries as template count grows (no N+1)
// ============================================================
test('perf: GET /workouts/templates query count does not scale with template count', async (t) => {
  const db = await countingMemDb();
  const { org, owner } = await seedOrgAndTrainer(db);
  const workoutsRoutes = (await import('../src/routes/workouts.js')).default;
  const { base, close } = await startApp(db, '/api/workouts', workoutsRoutes);
  t.after(close);
  const token = makeToken(owner, 'GYM_OWNER', org);

  // seed 2 templates, 3 exercises each
  for (let i = 0; i < 2; i++) {
    const tId = id('wkt');
    await db.run(`INSERT INTO workout_templates (id, org_id, trainer_id, name, type, is_global, created_at) VALUES (?, ?, ?, ?, 'custom', 0, ?)`,
      [tId, org, owner, `Template ${i}`, now()]);
    for (let j = 0; j < 3; j++) {
      await db.run(`INSERT INTO workout_exercises (id, workout_id, template_id, exercise_id, position, name, sets, reps, weight, rest_sec) VALUES (?, NULL, ?, NULL, ?, ?, 3, '10', 'BW', 60)`,
        [id('wxe'), tId, j, `Ex ${j}`]);
    }
  }
  db._reset();
  const r1 = await callGet(base, '/templates', token);
  assert.equal(r1.status, 200);
  const queriesFor2 = [...db._counts.values()].reduce((a, b) => a + b, 0);

  // seed 8 more templates (10 total), same exercise count each
  for (let i = 2; i < 10; i++) {
    const tId = id('wkt');
    await db.run(`INSERT INTO workout_templates (id, org_id, trainer_id, name, type, is_global, created_at) VALUES (?, ?, ?, ?, 'custom', 0, ?)`,
      [tId, org, owner, `Template ${i}`, now()]);
    for (let j = 0; j < 3; j++) {
      await db.run(`INSERT INTO workout_exercises (id, workout_id, template_id, exercise_id, position, name, sets, reps, weight, rest_sec) VALUES (?, NULL, ?, NULL, ?, ?, 3, '10', 'BW', 60)`,
        [id('wxe'), tId, j, `Ex ${j}`]);
    }
  }
  db._reset();
  const r2 = await callGet(base, '/templates', token);
  assert.equal(r2.status, 200);
  assert.equal(r2.json.templates.length, 10);
  const queriesFor10 = [...db._counts.values()].reduce((a, b) => a + b, 0);

  // With batching, the SELECT count for /templates itself is fixed (2:
  // templates list + one IN(...) exercises query) regardless of row count.
  // An N+1 regression would make queriesFor10 scale with template count
  // (10 templates -> ~10 extra queries); batched stays flat.
  assert.ok(queriesFor10 <= queriesFor2 + 1,
    `query count should stay flat as templates grow (2 templates: ${queriesFor2} queries, 10 templates: ${queriesFor10} queries) -- looks like an N+1 regression`);
});

// ============================================================
// 3. nutrition/plans stays O(1) queries as plan count grows (no N+1)
// ============================================================
test('perf: GET /nutrition/plans query count does not scale with plan count', async (t) => {
  const db = await countingMemDb();
  const { org, owner } = await seedOrgAndTrainer(db);
  const nutritionRoutes = (await import('../src/routes/nutrition.js')).default;
  const { base, close } = await startApp(db, '/api/nutrition', nutritionRoutes);
  t.after(close);
  const token = makeToken(owner, 'GYM_OWNER', org);

  for (let i = 0; i < 12; i++) {
    const pId = id('npl');
    await db.run(`INSERT INTO nutrition_plans (id, org_id, trainer_id, name, is_template, calories, protein, carbs, fat, created_at) VALUES (?, ?, ?, ?, 1, 2000, 150, 200, 60, ?)`,
      [pId, org, owner, `Plan ${i}`, now()]);
    await db.run(
      `INSERT INTO meals (id, plan_id, slot, name, calories, protein, carbs, fat, position) VALUES (?, ?, 'breakfast', 'Breakfast', 400, 30, 40, 10, 0)`,
      [id('mel'), pId]);
  }
  db._reset();
  const r = await callGet(base, '/plans', token);
  assert.equal(r.status, 200);
  assert.equal(r.json.plans.length, 12);

  // batched: 1 plans query + 1 IN(...) meals query = 2, never 1 + 12
  const total = [...db._counts.values()].reduce((a, b) => a + b, 0);
  assert.ok(total <= 3, `expected /nutrition/plans to run ~2 queries regardless of plan count, got ${total} for 12 plans`);
});
