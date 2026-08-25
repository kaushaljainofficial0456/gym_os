// ============================================================
// AI food estimate feedback + AI-estimated meal items:
//   - POST /me/meals/:id/items with ai_estimate creates a source:'ai_estimated' item
//   - PUT .../items/:itemId rescales AI items via the same density path as database items
//   - POST /me/food-feedback records an observation, never touches the shared
//     cache directly (see foodFeedback.js)
//   - aggregateAndMaybePromote only promotes at/above MIN_FEEDBACK_COUNT, only
//     when the aggregate itself is Atwater-plausible, and NEVER touches an
//     already-VERIFIED_SHARED_FOOD row
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import express from 'express';
import { config } from '../src/config.js';
import { canonicalizeFoodQuery } from '../src/services/intelligence/foodAICache.js';
import { submitFeedback, aggregateAndMaybePromote, MIN_FEEDBACK_COUNT } from '../src/services/intelligence/foodFeedback.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  // Same migration gap as hardening.test.js's memDb() -- these columns
  // exist only via scripts/init-db.js's guarded migrations.
  for (const ddl of [`source TEXT NOT NULL DEFAULT 'database'`, 'ai_confidence TEXT', 'ai_provider TEXT', 'ai_model TEXT']) {
    db.exec(`ALTER TABLE meal_items ADD COLUMN ${ddl}`);
  }
  for (const ddl of [`validation_status TEXT NOT NULL DEFAULT 'AI_ESTIMATED'`, `version INTEGER NOT NULL DEFAULT 1`]) {
    db.exec(`ALTER TABLE ai_food_estimates ADD COLUMN ${ddl}`);
  }
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await mk().q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
    exec(sql) { db.exec(sql); },
    tx(fn) {
      db.exec('BEGIN');
      try { const out = fn(mk()); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
    raw: db
  });
  return mk();
}

function tokenFor(user) {
  return jwt.sign({ sub: user.id, role: user.role, org: user.org_id, name: user.name }, config.jwtSecret, { expiresIn: '1h' });
}

async function startMeApi(db, user) {
  const meRoutes = (await import('../src/routes/me.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/me', meRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, body, u = user) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(u)}` },
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close };
}

async function orgFixture(db) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym A', 'gym-a', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u1', 'o1', 'a@x.in', 'x', 'Rahul', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)', ['c1', 'u1', 'o1', 'FAT_LOSS', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO client_meal_templates (id, org_id, client_id, slot, name, position) VALUES (?, ?, ?, ?, ?, ?)', ['mt1', 'o1', 'c1', 'Lunch', 'Lunch', 0]);
  return { id: 'u1', role: 'CLIENT', org_id: 'o1' };
}

// Seeds N distinct real client rows (ai_food_feedback.client_id is a real
// FK -- see database/schema.sql) so aggregation tests can submit feedback
// "from" N different anonymized clients without a foreign-key violation.
async function seedClients(db, n) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['ofb', 'Gym FB', 'gym-fb', '2026-01-01T00:00:00Z']);
  const ids = [];
  for (let i = 0; i < n; i++) {
    const uid = `ufb${i}`, cid = `cfb${i}`;
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, 'ofb', ?, 'x', 'CLIENT', ?, 1, ?)`,
      [uid, `fb${i}@x.in`, `Feedback User ${i}`, '2026-01-01T00:00:00Z']);
    await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)', [cid, uid, 'ofb', 'GENERAL', '2026-01-01T00:00:00Z']);
    ids.push(cid);
  }
  return ids;
}

// ---------------- AI-estimated meal items ----------------

test('POST /me/meals/:id/items with ai_estimate creates a source:ai_estimated item and recomputes totals', async (t) => {
  const db = await memDb();
  const user = await orgFixture(db);
  const api = await startMeApi(db, user);
  t.after(() => api.close());

  const res = await api.call('POST', '/me/meals/mt1/items', {
    ai_estimate: { name: 'Chicken Chettinad Biryani', grams: 350, calories: 620, protein_g: 32, carbs_g: 70, fat_g: 22, confidence: 'medium', provider: 'groq', model: 'llama-3.3-70b' }
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.source, 'ai_estimated');

  const items = await db.q('SELECT * FROM meal_items WHERE meal_template_id = ?', ['mt1']);
  assert.equal(items.length, 1);
  assert.equal(items[0].source, 'ai_estimated');
  assert.equal(items[0].food_id, null);
  assert.equal(items[0].quantity, 350, 'AI items store literal grams as quantity');
  assert.equal(items[0].unit, 'g');
  assert.equal(items[0].calories, 620);
  assert.equal(items[0].ai_provider, 'groq');
  assert.equal(items[0].ai_confidence, 'medium');

  const m = await db.q1('SELECT * FROM client_meal_templates WHERE id = ?', ['mt1']);
  assert.equal(m.calories, 620, 'meal totals recomputed to include the AI item');
  assert.equal(m.protein, 32);
});

test('PUT .../items/:itemId rescales an AI item by density, same path as database items', async (t) => {
  const db = await memDb();
  const user = await orgFixture(db);
  const api = await startMeApi(db, user);
  t.after(() => api.close());

  const created = await api.call('POST', '/me/meals/mt1/items', {
    ai_estimate: { name: 'Paneer Tikka', grams: 100, calories: 200, protein_g: 14, carbs_g: 6, fat_g: 14 }
  });
  const items = await api.call('GET', '/me/meals/mt1/items');
  const itemId = items.json.items[0].id;

  // 100g -> 250g should scale linearly (density = 200kcal/100g = 2kcal/g)
  const put = await api.call('PUT', `/me/meals/mt1/items/${itemId}`, { quantity: 250 });
  assert.equal(put.status, 200);

  const m = await db.q1('SELECT * FROM client_meal_templates WHERE id = ?', ['mt1']);
  assert.equal(m.calories, 500, '250g @ 2kcal/g = 500 kcal');
  assert.equal(m.protein, 35, '250g @ 0.14 protein/g = 35g');
});

test('existing database-food path is unaffected by the new ai_estimate branch (source:database, servings semantics)', async (t) => {
  const db = await memDb();
  const user = await orgFixture(db);
  await db.run(`INSERT INTO foods (id, org_id, client_id, name, serving, calories, protein, carbs, fat, is_global) VALUES ('fG', NULL, NULL, 'Rice', '100 g', 150, 4, 32, 0, 1)`);
  const api = await startMeApi(db, user);
  t.after(() => api.close());

  const res = await api.call('POST', '/me/meals/mt1/items', { food_id: 'fG', quantity: 2 });
  assert.equal(res.status, 200);
  assert.equal(res.json.source, 'database');
  const items = await db.q('SELECT * FROM meal_items WHERE meal_template_id = ?', ['mt1']);
  assert.equal(items[0].source, 'database');
  assert.equal(items[0].calories, 300, 'servings multiplier, not literal grams');
});

// ---------------- feedback submission (HTTP) ----------------

test('POST /me/food-feedback records a normalized observation without touching the cache below threshold', async (t) => {
  const db = await memDb();
  const user = await orgFixture(db);
  const { key, displayName } = canonicalizeFoodQuery('paneer butter masala feedback test dish');
  await db.run(
    `INSERT INTO ai_food_estimates (id, canonical_key, canonical_name, cuisine, component_template_json, nutrition_json, uncertainty_json, assumptions_json, source, ai_provider, ai_model, confidence, times_used, user_confirmation_count, created_at, updated_at)
     VALUES ('afe1', ?, ?, 'Indian', '[]', ?, '{}', '[]', 'ai_estimated', 'groq', 'test-model', 'medium', 1, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    [key, displayName, JSON.stringify({ calories: 350, protein: 12, carbs: 20, fat: 24 })]);

  const api = await startMeApi(db, user);
  t.after(() => api.close());

  const res = await api.call('POST', '/me/food-feedback', {
    query: 'paneer butter masala feedback test dish',
    original_grams: 200, adjusted_grams: 200,
    original: { calories: 350, protein_g: 12, carbs_g: 20, fat_g: 24 },
    adjusted: { calories: 420, protein_g: 14, carbs_g: 22, fat_g: 30 },
    ai_provider: 'groq', ai_model: 'test-model'
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.recorded, true);
  assert.equal(res.json.promotion.reason, 'insufficient_evidence', 'one observation is not enough to promote');
  assert.equal(res.json.promotion.sampleCount, 1);

  const rows = await db.q('SELECT * FROM ai_food_feedback WHERE canonical_key = ?', [key]);
  assert.equal(rows.length, 1);
  // per-100g normalization: 420 kcal @ 200g -> 210 kcal/100g
  assert.equal(rows[0].adjusted_calories, 210);
  assert.equal(rows[0].client_id, 'c1', 'anti-abuse client id recorded');

  // the shared cache itself must be untouched by a single observation
  const est = await db.q1('SELECT * FROM ai_food_estimates WHERE canonical_key = ?', [key]);
  assert.equal(JSON.parse(est.nutrition_json).calories, 350, 'original AI estimate unchanged');
  assert.equal(est.validation_status, 'AI_ESTIMATED');
});

test('a no-op correction (within rounding) is not recorded as feedback', async (t) => {
  const db = await memDb();
  const user = await orgFixture(db);
  const { key, displayName } = canonicalizeFoodQuery('idli sambar noop feedback test');
  await db.run(
    `INSERT INTO ai_food_estimates (id, canonical_key, canonical_name, cuisine, component_template_json, nutrition_json, uncertainty_json, assumptions_json, source, ai_provider, ai_model, confidence, times_used, user_confirmation_count, created_at, updated_at)
     VALUES ('afe2', ?, ?, 'Indian', '[]', ?, '{}', '[]', 'ai_estimated', 'groq', 'test-model', 'medium', 1, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    [key, displayName, JSON.stringify({ calories: 200, protein: 8, carbs: 30, fat: 5 })]);
  const api = await startMeApi(db, user);
  t.after(() => api.close());

  const res = await api.call('POST', '/me/food-feedback', {
    query: 'idli sambar noop feedback test',
    original_grams: 100, adjusted_grams: 100,
    original: { calories: 200, protein_g: 8, carbs_g: 30, fat_g: 5 },
    adjusted: { calories: 201, protein_g: 8, carbs_g: 30, fat_g: 5 } // 1 kcal difference, below the 5kcal/100g threshold
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.recorded, false);
  assert.equal(res.json.promotion, undefined);
  const rows = await db.q('SELECT * FROM ai_food_feedback WHERE canonical_key = ?', [key]);
  assert.equal(rows.length, 0);
});

// ---------------- aggregation / promotion safeguards (direct unit tests) ----------------

test('aggregateAndMaybePromote promotes to COMMUNITY_VALIDATED_CANDIDATE once >= MIN_FEEDBACK_COUNT consistent corrections exist, using the median', async () => {
  const db = await memDb();
  const clientIds = await seedClients(db, 6);
  const key = 'canon_promote_test';
  await db.run(
    `INSERT INTO ai_food_estimates (id, canonical_key, canonical_name, cuisine, component_template_json, nutrition_json, uncertainty_json, assumptions_json, source, ai_provider, ai_model, confidence, times_used, user_confirmation_count, created_at, updated_at)
     VALUES ('afe3', ?, 'Promote Test Dish', 'Indian', '[]', ?, '{}', '[]', 'ai_estimated', 'groq', 'test-model', 'medium', 1, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    [key, JSON.stringify({ calories: 300, protein: 10, carbs: 40, fat: 8 })]);

  // MIN_FEEDBACK_COUNT independent, mutually-consistent corrections, all
  // agreeing the real value is ~400 kcal/100g -- one deliberate outlier
  // (800) must not drag the median.
  const corrections = [390, 400, 410, 405, 800, 395].slice(0, Math.max(MIN_FEEDBACK_COUNT, 5));
  // submitFeedback() already calls aggregateAndMaybePromote() internally
  // after every insert (that's the real production flow -- see
  // foodFeedback.js) -- so the promotion decision to assert on is the one
  // returned by the LAST call, not a redundant extra call with no new
  // evidence (which would just re-run the same aggregate and bump
  // `version` again for nothing).
  let result;
  for (let i = 0; i < corrections.length; i++) {
    ({ promotion: result } = await submitFeedback(db, {
      canonicalKey: key, originalGrams: 100, adjustedGrams: 100,
      original: { calories: 300, protein_g: 10, carbs_g: 40, fat_g: 8 },
      adjusted: { calories: corrections[i], protein_g: 13, carbs_g: 40, fat_g: 20 },
      clientId: clientIds[i]
    }));
  }

  assert.equal(result.promoted, true);
  assert.equal(result.sampleCount, corrections.length);

  const est = await db.q1('SELECT * FROM ai_food_estimates WHERE canonical_key = ?', [key]);
  assert.equal(est.validation_status, 'COMMUNITY_VALIDATED_CANDIDATE');
  assert.equal(est.version, 2, 'version incremented exactly once');
  const nutrition = JSON.parse(est.nutrition_json);
  // median of [390,400,405,410,800] (the 6th slice element only applies if
  // MIN_FEEDBACK_COUNT > 5) must sit near 400, nowhere near the 800 outlier
  assert.ok(nutrition.calories < 450, `median (${nutrition.calories}) must not be dragged by the outlier`);
});

test('aggregateAndMaybePromote never promotes below MIN_FEEDBACK_COUNT', async () => {
  const db = await memDb();
  const clientIds = await seedClients(db, MIN_FEEDBACK_COUNT);
  const key = 'canon_insufficient_test';
  await db.run(
    `INSERT INTO ai_food_estimates (id, canonical_key, canonical_name, cuisine, component_template_json, nutrition_json, uncertainty_json, assumptions_json, source, ai_provider, ai_model, confidence, times_used, user_confirmation_count, created_at, updated_at)
     VALUES ('afe4', ?, 'Insufficient Test Dish', 'Indian', '[]', ?, '{}', '[]', 'ai_estimated', 'groq', 'test-model', 'medium', 1, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    [key, JSON.stringify({ calories: 300, protein: 10, carbs: 40, fat: 8 })]);

  for (let i = 0; i < MIN_FEEDBACK_COUNT - 1; i++) {
    await submitFeedback(db, {
      canonicalKey: key, originalGrams: 100, adjustedGrams: 100,
      original: { calories: 300, protein_g: 10, carbs_g: 40, fat_g: 8 },
      adjusted: { calories: 400, protein_g: 13, carbs_g: 40, fat_g: 20 },
      clientId: clientIds[i]
    });
  }
  const result = await aggregateAndMaybePromote(db, key);
  assert.equal(result.promoted, false);
  assert.equal(result.reason, 'insufficient_evidence');
  const est = await db.q1('SELECT * FROM ai_food_estimates WHERE canonical_key = ?', [key]);
  assert.equal(est.validation_status, 'AI_ESTIMATED', 'still unpromoted');
  assert.equal(est.version, 1);
});

test('aggregateAndMaybePromote refuses to promote a physically implausible aggregate', async () => {
  const db = await memDb();
  const clientIds = await seedClients(db, MIN_FEEDBACK_COUNT);
  const key = 'canon_implausible_test';
  await db.run(
    `INSERT INTO ai_food_estimates (id, canonical_key, canonical_name, cuisine, component_template_json, nutrition_json, uncertainty_json, assumptions_json, source, ai_provider, ai_model, confidence, times_used, user_confirmation_count, created_at, updated_at)
     VALUES ('afe5', ?, 'Implausible Test Dish', 'Indian', '[]', ?, '{}', '[]', 'ai_estimated', 'groq', 'test-model', 'medium', 1, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    [key, JSON.stringify({ calories: 300, protein: 10, carbs: 40, fat: 8 })]);

  // Every "correction" claims 2000 kcal from macros that Atwater-math to ~250 --
  // internally consistent with each other, but not with basic physics.
  for (let i = 0; i < MIN_FEEDBACK_COUNT; i++) {
    await submitFeedback(db, {
      canonicalKey: key, originalGrams: 100, adjustedGrams: 100,
      original: { calories: 300, protein_g: 10, carbs_g: 40, fat_g: 8 },
      adjusted: { calories: 2000, protein_g: 5, carbs_g: 40, fat_g: 10 },
      clientId: clientIds[i]
    });
  }
  const result = await aggregateAndMaybePromote(db, key);
  assert.equal(result.promoted, false);
  assert.equal(result.reason, 'aggregate_failed_plausibility_check');
  const est = await db.q1('SELECT * FROM ai_food_estimates WHERE canonical_key = ?', [key]);
  assert.equal(est.validation_status, 'AI_ESTIMATED');
});

test('aggregateAndMaybePromote never touches an already-VERIFIED_SHARED_FOOD row, no matter how much feedback arrives', async () => {
  const db = await memDb();
  const clientIds = await seedClients(db, MIN_FEEDBACK_COUNT);
  const key = 'canon_verified_test';
  await db.run(
    `INSERT INTO ai_food_estimates (id, canonical_key, canonical_name, cuisine, component_template_json, nutrition_json, uncertainty_json, assumptions_json, source, ai_provider, ai_model, confidence, times_used, user_confirmation_count, validation_status, version, created_at, updated_at)
     VALUES ('afe6', ?, 'Verified Test Dish', 'Indian', '[]', ?, '{}', '[]', 'ai_estimated', 'groq', 'test-model', 'medium', 1, 0, 'VERIFIED_SHARED_FOOD', 3, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    [key, JSON.stringify({ calories: 300, protein: 10, carbs: 40, fat: 8 })]);

  for (let i = 0; i < MIN_FEEDBACK_COUNT; i++) {
    await submitFeedback(db, {
      canonicalKey: key, originalGrams: 100, adjustedGrams: 100,
      original: { calories: 300, protein_g: 10, carbs_g: 40, fat_g: 8 },
      adjusted: { calories: 500, protein_g: 15, carbs_g: 45, fat_g: 22 },
      clientId: clientIds[i]
    });
  }
  const result = await aggregateAndMaybePromote(db, key);
  assert.equal(result.promoted, false);
  assert.equal(result.reason, 'already_verified_leave_untouched');
  const est = await db.q1('SELECT * FROM ai_food_estimates WHERE canonical_key = ?', [key]);
  assert.equal(est.validation_status, 'VERIFIED_SHARED_FOOD', 'human-verified status is never silently changed');
  assert.equal(est.version, 3, 'version untouched');
  assert.equal(JSON.parse(est.nutrition_json).calories, 300, 'verified nutrition data untouched');
});

test('submitFeedback is a safe no-op on invalid input, never throws', async () => {
  const db = await memDb();
  const result = await submitFeedback(db, { canonicalKey: '', originalGrams: 0, adjustedGrams: 100, original: {}, adjusted: {} });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_input');
});
