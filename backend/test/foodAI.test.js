// ============================================================
// FOOD AI (Tier 4) — validation, uncertainty, confidence, canonicalization,
// component grounding, caching, and provider-failure fallback behaviour.
//
// Deliberately NOT happy-path-only (per the food-AI spec's own testing
// section): most of these tests exist to prove a BAD input or a FAILED
// provider is handled safely, not that a good one produces a nice number.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import {
  validateAIFoodResponse, resolveUncertainty, resolveComponents,
  sumComponentTotals, deriveConfidence, estimateFoodAI, isFoodAIAvailable,
  recomputeAdjustedComponents, _resetCostSafetyStateForTests,
} from '../src/services/intelligence/foodAI.js';
import { getFoodSearch } from '../src/services/foodEstimator.js';
import { canonicalizeFoodQuery, isPersonalQuery } from '../src/services/intelligence/foodAICache.js';

// A rate-limit (429) response mocked in one test marks that provider on
// cooldown for the rest of this file's process (see foodAI.js's own
// comment on why this state is module-level, not per-call) -- without
// resetting it between tests, an earlier 429 test silently turns a later
// "ollama succeeds" test into "ollama was skipped, on cooldown".
test.beforeEach(() => { _resetCostSafetyStateForTests(); });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const schema = fs.readFileSync(path.join(root, 'database', 'schema.sql'), 'utf8');

// ---- in-memory SQLite helper (same pattern as nutrition-meal-log-api.test.js) ----
async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  // ai_food_estimates.validation_status/version (feedback promotion, see
  // foodFeedback.js) exist only via scripts/init-db.js's guarded
  // migrations, which this lightweight in-memory DB doesn't run -- same
  // gap documented in hardening.test.js's and foodFeedback.test.js's
  // memDb() helpers.
  for (const ddl of [`validation_status TEXT NOT NULL DEFAULT 'AI_ESTIMATED'`, `version INTEGER NOT NULL DEFAULT 1`]) {
    db.exec(`ALTER TABLE ai_food_estimates ADD COLUMN ${ddl}`);
  }
  return {
    driver: 'sqlite',
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const stmt = db.prepare(sql); const rows = params.length ? stmt.all(...params) : stmt.all(); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
    raw: db,
  };
}

const validComponent = (over = {}) => ({
  name: 'cooked rice', estimated_weight_g: 200,
  calories: 260, protein_g: 5, carbs_g: 56, fat_g: 1, assumption: 'base', ...over,
});

const validResponse = (over = {}) => ({
  food_name: 'Chicken biryani',
  food_type: 'composite_dish',
  cuisine: 'Indian',
  is_branded_or_restaurant: false,
  serving: { description: '1 plate', estimated_weight_g: 550 },
  components: [
    validComponent(),
    { name: 'chicken', estimated_weight_g: 150, calories: 280, protein_g: 32, carbs_g: 4, fat_g: 15, assumption: 'protein' },
  ],
  totals: { calories: 540, protein_g: 37, carbs_g: 60, fat_g: 16 },
  uncertainty: { calories_low: 450, calories_high: 650, protein_low: 28, protein_high: 45, carbs_low: 45, carbs_high: 75, fat_low: 10, fat_high: 24 },
  confidence: 'medium',
  assumptions: ['moderate oil'],
  needs_user_confirmation: ['portion_size'],
  ...over,
});

/* ------------------------------------------------------------------ */
/*  Schema / plausibility validation                                   */
/* ------------------------------------------------------------------ */

test('validateAIFoodResponse — accepts a well-formed response', () => {
  const r = validateAIFoodResponse(validResponse());
  assert.equal(r.ok, true);
});

test('validateAIFoodResponse — rejects a non-object', () => {
  assert.equal(validateAIFoodResponse(null).ok, false);
  assert.equal(validateAIFoodResponse('just a string').ok, false);
  assert.equal(validateAIFoodResponse(42).ok, false);
});

test('validateAIFoodResponse — rejects missing food_name', () => {
  const r = validateAIFoodResponse(validResponse({ food_name: '' }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /food_name/);
});

test('validateAIFoodResponse — rejects missing/invalid serving weight', () => {
  assert.equal(validateAIFoodResponse(validResponse({ serving: null })).ok, false);
  assert.equal(validateAIFoodResponse(validResponse({ serving: { estimated_weight_g: 0 } })).ok, false);
  assert.equal(validateAIFoodResponse(validResponse({ serving: { estimated_weight_g: -50 } })).ok, false);
});

test('validateAIFoodResponse — rejects an implausibly heavy serving (unit-error guard)', () => {
  const r = validateAIFoodResponse(validResponse({ serving: { estimated_weight_g: 50_000 } }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /exceeds plausible bound/);
});

test('validateAIFoodResponse — rejects empty/missing components', () => {
  assert.equal(validateAIFoodResponse(validResponse({ components: [] })).ok, false);
  assert.equal(validateAIFoodResponse(validResponse({ components: null })).ok, false);
});

test('validateAIFoodResponse — rejects a component with a negative weight or macro', () => {
  const negWeight = validateAIFoodResponse(validResponse({ components: [validComponent({ estimated_weight_g: -10 })] }));
  assert.equal(negWeight.ok, false);
  const negMacro = validateAIFoodResponse(validResponse({ components: [validComponent({ protein_g: -5 })] }));
  assert.equal(negMacro.ok, false);
});

test('validateAIFoodResponse — rejects negative totals (calories, protein, carbs, fat)', () => {
  assert.equal(validateAIFoodResponse(validResponse({ totals: { calories: -100, protein_g: 10, carbs_g: 10, fat_g: 10 } })).ok, false);
  assert.equal(validateAIFoodResponse(validResponse({ totals: { calories: 100, protein_g: -1, carbs_g: 10, fat_g: 10 } })).ok, false);
});

test('validateAIFoodResponse — rejects NaN/Infinity anywhere in totals', () => {
  assert.equal(validateAIFoodResponse(validResponse({ totals: { calories: NaN, protein_g: 10, carbs_g: 10, fat_g: 10 } })).ok, false);
  assert.equal(validateAIFoodResponse(validResponse({ totals: { calories: Infinity, protein_g: 10, carbs_g: 10, fat_g: 10 } })).ok, false);
});

test('validateAIFoodResponse — rejects the exact impossible-output example: high calories, all-zero macros', () => {
  // "100 g food, 10,000 kcal, 0g fat, 0g protein, 0g carbs" from the spec.
  const r = validateAIFoodResponse(validResponse({ totals: { calories: 500, protein_g: 0, carbs_g: 0, fat_g: 0 } }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /zero/);
});

test('validateAIFoodResponse — rejects calories wildly inconsistent with macros (Atwater check)', () => {
  // 10g protein + 10g carb + 10g fat = 90+40+40=170kcal expected; 3000 is not a rounding error.
  const r = validateAIFoodResponse(validResponse({ totals: { calories: 3000, protein_g: 10, carbs_g: 10, fat_g: 10 } }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /Atwater/);
});

test('validateAIFoodResponse — accepts totals within generous Atwater tolerance (fiber/rounding slack)', () => {
  // 37*4 + 60*4 + 16*9 = 532 expected vs 540 actual -- within tolerance.
  const r = validateAIFoodResponse(validResponse());
  assert.equal(r.ok, true);
});

test('validateAIFoodResponse — an invalid confidence string is coerced to low, not rejected', () => {
  const r = validateAIFoodResponse(validResponse({ confidence: 'super-duper-certain' }));
  assert.equal(r.ok, true);
  assert.equal(r.value.confidence, 'low');
});

/* ------------------------------------------------------------------ */
/*  Uncertainty — must always be a valid range                         */
/* ------------------------------------------------------------------ */

test('resolveUncertainty — keeps a valid AI-supplied interval as-is', () => {
  const totals = { calories: 500, protein_g: 30, carbs_g: 50, fat_g: 15 };
  const raw = { calories_low: 400, calories_high: 600, protein_low: 25, protein_high: 35, carbs_low: 40, carbs_high: 60, fat_low: 10, fat_high: 20 };
  const out = resolveUncertainty(raw, totals);
  assert.equal(out.calories_low, 400);
  assert.equal(out.calories_high, 600);
});

test('resolveUncertainty — replaces an interval where low > estimate', () => {
  const totals = { calories: 500, protein_g: 30, carbs_g: 50, fat_g: 15 };
  const out = resolveUncertainty({ calories_low: 550, calories_high: 600 }, totals);
  assert.ok(out.calories_low <= 500 && out.calories_high >= 500);
});

test('resolveUncertainty — replaces an interval where high < estimate', () => {
  const totals = { calories: 500, protein_g: 30, carbs_g: 50, fat_g: 15 };
  const out = resolveUncertainty({ calories_low: 100, calories_high: 300 }, totals);
  assert.ok(out.calories_low <= 500 && out.calories_high >= 500);
});

test('resolveUncertainty — replaces a negative low bound', () => {
  const totals = { calories: 500, protein_g: 30, carbs_g: 50, fat_g: 15 };
  const out = resolveUncertainty({ calories_low: -50, calories_high: 600 }, totals);
  assert.ok(out.calories_low >= 0);
});

test('resolveUncertainty — generates a conservative interval when the AI omits uncertainty entirely', () => {
  const totals = { calories: 500, protein_g: 30, carbs_g: 50, fat_g: 15 };
  const out = resolveUncertainty(null, totals);
  for (const [lo, hi, est] of [
    [out.calories_low, out.calories_high, 500], [out.protein_low, out.protein_high, 30],
    [out.carbs_low, out.carbs_high, 50], [out.fat_low, out.fat_high, 15],
  ]) {
    assert.ok(lo >= 0, `low ${lo} must be >= 0`);
    assert.ok(lo <= est, `low ${lo} must be <= estimate ${est}`);
    assert.ok(hi >= est, `high ${hi} must be >= estimate ${est}`);
  }
});

/* ------------------------------------------------------------------ */
/*  Component resolution — DB-grounded vs AI-guessed                   */
/* ------------------------------------------------------------------ */

test('resolveComponents — a component matching a real database food is DB-grounded, not AI-guessed', () => {
  const { components, groundedCount } = resolveComponents([
    { name: 'chicken breast', estimated_weight_g: 150, calories: 999999, protein_g: 1, carbs_g: 1, fat_g: 1 },
  ]);
  assert.equal(components.length, 1);
  if (groundedCount > 0) {
    // If the local model DB is present in this test environment, the
    // absurd AI-supplied 999999 kcal must have been REPLACED by the real
    // matched food's scaled macros, not passed through.
    assert.ok(components[0].calories < 1000, 'grounded component must use real DB macros, not the AI guess');
    assert.equal(components[0].db_grounded, true);
  }
});

test('resolveComponents — a component with no plausible database match falls back to the AI-provided macros, flagged ungrounded', () => {
  const { components } = resolveComponents([
    { name: 'xyzzy-not-a-real-food-zzq', estimated_weight_g: 50, calories: 123, protein_g: 4, carbs_g: 5, fat_g: 6 },
  ]);
  assert.equal(components.length, 1);
  assert.equal(components[0].db_grounded, false);
  assert.equal(components[0].calories, 123);
});

test('sumComponentTotals — sums across components correctly', () => {
  const totals = sumComponentTotals([
    { calories: 100, protein_g: 10, carbs_g: 5, fat_g: 2 },
    { calories: 200, protein_g: 20, carbs_g: 10, fat_g: 4 },
  ]);
  assert.deepEqual(totals, { calories: 300, protein_g: 30, carbs_g: 15, fat_g: 6 });
});

/* ------------------------------------------------------------------ */
/*  Confidence — backend-derived, never the AI's own claim             */
/* ------------------------------------------------------------------ */

test('deriveConfidence — high grounding + narrow uncertainty -> high', () => {
  const c = deriveConfidence({
    groundedCount: 4, totalCount: 4,
    uncertainty: { calories_low: 480, calories_high: 520 },
    totals: { calories: 500 }, isBrandedOrRestaurant: false,
  });
  assert.equal(c, 'high');
});

test('deriveConfidence — zero grounded components -> unreliable, regardless of narrow uncertainty', () => {
  const c = deriveConfidence({
    groundedCount: 0, totalCount: 3,
    uncertainty: { calories_low: 490, calories_high: 510 },
    totals: { calories: 500 }, isBrandedOrRestaurant: false,
  });
  assert.equal(c, 'unreliable');
});

test('deriveConfidence — branded/restaurant items are capped below high even with perfect grounding', () => {
  // Spec: "branded food does not get falsely treated as verified" -- even
  // if every ingredient happened to match the DB, we still don't know the
  // ACTUAL recipe, so this must never reach 'high'.
  const c = deriveConfidence({
    groundedCount: 4, totalCount: 4,
    uncertainty: { calories_low: 490, calories_high: 510 },
    totals: { calories: 500 }, isBrandedOrRestaurant: true,
  });
  assert.notEqual(c, 'high');
});

test('deriveConfidence — wide uncertainty relative to the estimate prevents high confidence', () => {
  const c = deriveConfidence({
    groundedCount: 4, totalCount: 4,
    uncertainty: { calories_low: 100, calories_high: 900 }, // 160% spread
    totals: { calories: 500 }, isBrandedOrRestaurant: false,
  });
  assert.notEqual(c, 'high');
});

/* ------------------------------------------------------------------ */
/*  Canonicalization — collisions where safe, never where not          */
/* ------------------------------------------------------------------ */

test('canonicalizeFoodQuery — word-order variants of the same dish collide', () => {
  const a = canonicalizeFoodQuery('Chettinad Chicken Biryani');
  const b = canonicalizeFoodQuery('chicken chettinad biryani');
  const c = canonicalizeFoodQuery('Chettinad biryani chicken');
  assert.equal(a.key, b.key);
  assert.equal(b.key, c.key);
});

test('canonicalizeFoodQuery — style/descriptor synonyms collide with the plain dish name', () => {
  const a = canonicalizeFoodQuery('chettinad style chicken biryani');
  const b = canonicalizeFoodQuery('Chettinad Chicken Biryani');
  assert.equal(a.key, b.key);
});

test('canonicalizeFoodQuery — genuinely different dishes never collide', () => {
  const biryani = canonicalizeFoodQuery('chicken biryani');
  const friedRice = canonicalizeFoodQuery('chicken fried rice');
  assert.notEqual(biryani.key, friedRice.key);
});

test('canonicalizeFoodQuery — brand folds into the key, so branded and generic queries do not collide', () => {
  const generic = canonicalizeFoodQuery('chicken burger');
  const branded = canonicalizeFoodQuery('chicken burger', { brand: 'McDonalds' });
  assert.notEqual(generic.key, branded.key);
});

test('isPersonalQuery / canonicalizeFoodQuery — personal-possessive queries are flagged, not cached globally', () => {
  assert.equal(isPersonalQuery("my mom's chicken curry"), true);
  assert.equal(isPersonalQuery('restaurant style chicken curry'), false);
  const r = canonicalizeFoodQuery("my mom's chicken curry");
  assert.equal(r.isPersonal, true);
});

/* ------------------------------------------------------------------ */
/*  estimateFoodAI — cache short-circuit, graceful unavailability      */
/* ------------------------------------------------------------------ */

test('estimateFoodAI — no configured provider AND no cache -> graceful unresolved, never throws', async () => {
  const db = await memDb();
  const savedProvider = process.env.FOOD_AI_PROVIDER;
  const savedAllow = process.env.ALLOW_PAID_AI;
  process.env.FOOD_AI_PROVIDER = 'openai'; // paid, and ALLOW_PAID_AI is not set -> blocked
  delete process.env.ALLOW_PAID_AI;
  try {
    // Re-import isn't needed -- foodAI.js reads env vars at module load,
    // so this test instead exercises isFoodAIAvailable()'s live check
    // directly for provider names that are never configured in test env.
    assert.equal(isFoodAIAvailable() === true || isFoodAIAvailable() === false, true); // sanity: never throws
    const result = await estimateFoodAI(db, { query: 'a genuinely novel imaginary dish xyzzyplonk' });
    assert.equal(result.ok, false);
    assert.equal(result.estimate_status, 'unresolved');
    assert.equal(result.tier, 4);
  } finally {
    if (savedProvider === undefined) delete process.env.FOOD_AI_PROVIDER; else process.env.FOOD_AI_PROVIDER = savedProvider;
    if (savedAllow === undefined) delete process.env.ALLOW_PAID_AI; else process.env.ALLOW_PAID_AI = savedAllow;
  }
});

test('estimateFoodAI — a cache hit returns without needing any provider configured (cache hit avoids AI call)', async () => {
  const db = await memDb();
  const { key, displayName } = canonicalizeFoodQuery('chettinad chicken biryani test cache entry');
  await db.run(
    `INSERT INTO ai_food_estimates (id, canonical_key, canonical_name, cuisine, component_template_json, nutrition_json, uncertainty_json, assumptions_json, source, ai_provider, ai_model, confidence, times_used, user_confirmation_count, created_at, updated_at)
     VALUES ('afe_test1', ?, ?, 'Indian', '[]', ?, '{}', '[]', 'ai_estimated', 'mock', 'mock-model', 'medium', 0, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    [key, displayName, JSON.stringify({ calories: 900, protein: 40, carbs: 100, fat: 35 })]);

  // No AI provider needs to be configured for this to succeed -- proves
  // the cache path returns before any provider-availability check matters.
  const result = await estimateFoodAI(db, { query: 'chettinad chicken biryani test cache entry' });
  assert.equal(result.ok, true);
  assert.equal(result.from_cache, true);
  assert.equal(result.totals.calories, 900);

  const row = await db.q1('SELECT times_used FROM ai_food_estimates WHERE canonical_key = ?', [key]);
  assert.equal(row.times_used, 1, 'cache hit should bump times_used');
});

test('estimateFoodAI — a personal-possessive query never reads or writes the global cache', async () => {
  const db = await memDb();
  // Seed a cache row for the word-set this WOULD canonicalize to, if it
  // weren't personal -- proves the personal path deliberately skips the
  // cache lookup rather than accidentally matching a generic template.
  const { key } = canonicalizeFoodQuery('mom chicken curry unique test marker');
  await db.run(
    `INSERT INTO ai_food_estimates (id, canonical_key, canonical_name, cuisine, component_template_json, nutrition_json, uncertainty_json, assumptions_json, source, ai_provider, ai_model, confidence, times_used, user_confirmation_count, created_at, updated_at)
     VALUES ('afe_test2', ?, 'X', NULL, '[]', '{}', '{}', '[]', 'ai_estimated', 'mock', 'm', 'low', 0, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    [key]);
  const result = await estimateFoodAI(db, { query: "my mom's chicken curry unique test marker" });
  // No provider configured in this test env, so a real (non-personal)
  // query would fail with 'unresolved' too -- the meaningful assertion is
  // that it did NOT come back as a (wrong) cache hit.
  assert.notEqual(result.from_cache, true);
});

test('estimateFoodAI — a successful/cached AI estimate never writes a row into the measured `foods` table', async () => {
  const db = await memDb();
  const { key, displayName } = canonicalizeFoodQuery('unique no leakage test dish 12345');
  await db.run(
    `INSERT INTO ai_food_estimates (id, canonical_key, canonical_name, cuisine, component_template_json, nutrition_json, uncertainty_json, assumptions_json, source, ai_provider, ai_model, confidence, times_used, user_confirmation_count, created_at, updated_at)
     VALUES ('afe_test3', ?, ?, NULL, '[]', ?, '{}', '[]', 'ai_estimated', 'mock', 'm', 'low', 0, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    [key, displayName, JSON.stringify({ calories: 400, protein: 20, carbs: 40, fat: 10 })]);
  const before = await db.q('SELECT COUNT(*) AS n FROM foods', []);
  await estimateFoodAI(db, { query: 'unique no leakage test dish 12345' });
  const after = await db.q('SELECT COUNT(*) AS n FROM foods', []);
  assert.equal(before[0].n, after[0].n, 'estimateFoodAI must never insert into the measured foods table');
});

/* ------------------------------------------------------------------ */
/*  Provider-failure handling — mocked at the HTTP layer               */
/*  (same t.mock.method(globalThis, 'fetch', ...) pattern already      */
/*  established in barcodeApi.test.js). The default test-env provider  */
/*  is ollama (FOOD_AI_PROVIDER unset -> AI_PROVIDER unset -> 'ollama'),*/
/*  so these intercept http://localhost:11434 specifically.            */
/* ------------------------------------------------------------------ */

function mockOllama(t, handler) {
  const realFetch = globalThis.fetch;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (!String(url).includes('11434')) return realFetch(url, opts);
    calls.push(String(url));
    return handler(String(url), opts);
  });
  return calls;
}

test('estimateFoodAI — malformed (non-JSON) provider response is rejected, not passed through', async (t) => {
  const db = await memDb();
  mockOllama(t, () => new Response('this is not json at all, just prose', { status: 200 }));
  const result = await estimateFoodAI(db, { query: 'malformed response test dish' });
  assert.equal(result.ok, false);
  assert.equal(result.estimate_status, 'unresolved');
});

test('estimateFoodAI — a provider response that is valid JSON but fails schema validation is rejected', async (t) => {
  const db = await memDb();
  mockOllama(t, () => new Response(JSON.stringify({ message: { content: JSON.stringify({ totals: { calories: -500 } }) } }), { status: 200 }));
  const result = await estimateFoodAI(db, { query: 'invalid schema test dish' });
  assert.equal(result.ok, false);
});

test('estimateFoodAI — provider HTTP 429 (rate limit) fails gracefully, never throws', async (t) => {
  const db = await memDb();
  mockOllama(t, () => new Response('rate limited', { status: 429 }));
  await assert.doesNotReject(async () => {
    const result = await estimateFoodAI(db, { query: 'rate limit test dish' });
    assert.equal(result.ok, false);
    assert.equal(result.estimate_status, 'unresolved');
  });
});

test('callProviderRaw — a hung request is aborted at timeoutMs, not left to hang forever', async (t) => {
  // Tests the timeout mechanism directly via callProviderRaw's own
  // timeoutMs parameter, rather than through estimateFoodAI (whose
  // FOOD_AI_TIMEOUT_MS is read ONCE at module load -- an env var set
  // inside a test after that has no effect, so exercising it end to end
  // here would mean actually waiting out the real ~15s default).
  const { callProviderRaw } = await import('../src/services/intelligence/aiProvider.js');
  mockOllama(t, (url, opts) => new Promise((resolve, reject) => {
    // Never resolves on its own -- only the AbortSignal ends it, exactly
    // like a genuinely hung upstream request. This is also the regression
    // test for the bug fixed alongside it: callOllama previously never
    // forwarded `signal` into its own fetch() call, so this promise would
    // never have settled and the test (and any real hung ollama call)
    // would hang indefinitely instead of timing out.
    opts?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const t0 = Date.now();
  await assert.rejects(
    () => callProviderRaw('ollama', 'system', 'user', { timeoutMs: 150 }),
    /timed out/,
  );
  assert.ok(Date.now() - t0 < 2000, 'must abort near timeoutMs, not hang');
});

test('estimateFoodAI — a well-formed provider response produces a valid, fully-grounded-where-possible estimate end to end', async (t) => {
  const db = await memDb();
  mockOllama(t, () => new Response(JSON.stringify({
    message: { content: JSON.stringify(validResponse({ food_name: 'End to end test biryani' })) },
  }), { status: 200 }));
  const result = await estimateFoodAI(db, { query: 'end to end test biryani unique marker' });
  assert.equal(result.ok, true);
  assert.equal(result.tier, 4);
  assert.equal(result.source, 'ai_estimated');
  assert.ok(result.uncertainty.calories_low <= result.totals.calories);
  assert.ok(result.uncertainty.calories_high >= result.totals.calories);
  assert.ok(['high', 'medium', 'low', 'unreliable'].includes(result.confidence));
  assert.equal(result.provenance.tier, 4);
  assert.equal(result.provenance.source, 'ai_estimated');

  // Second call for the SAME query must hit the cache, not the provider again.
  const calls2 = mockOllama(t, () => { throw new Error('must not call the provider again -- cache should have short-circuited'); });
  const result2 = await estimateFoodAI(db, { query: 'end to end test biryani unique marker' });
  assert.equal(result2.from_cache, true);
  assert.equal(calls2.length, 0);
});

/* ------------------------------------------------------------------ */
/*  AI provenance -- provider/model/version/created_at/validation_status */
/*  must all be recorded correctly for a newly generated estimate,      */
/*  both in the response and in the ai_food_estimates cache row it      */
/*  writes. Regression coverage for the bug where `model` was recorded  */
/*  as the (usually unset) FOOD_AI_MODEL env var directly instead of    */
/*  the model the call actually used -- see aiProvider.js's             */
/*  callProviderRaw/call*WithKey for the fix (vendor-echoed model when  */
/*  the response provides one, else the resolved request-side id).      */
/* ------------------------------------------------------------------ */
test('estimateFoodAI — records real AI provenance (provider, model, version, created_at, validation_status), never a fabricated or null model', async (t) => {
  const db = await memDb();
  mockOllama(t, () => new Response(JSON.stringify({
    message: { content: JSON.stringify(validResponse({ food_name: 'Provenance test dish' })) },
  }), { status: 200 }));

  const result = await estimateFoodAI(db, { query: 'provenance test dish unique marker' });
  assert.equal(result.ok, true);
  assert.equal(result.ai.provider, 'ollama');
  // Ollama has no per-call model override -- it always uses the fixed
  // OLLAMA_MODEL constant, so the recorded model must equal whatever that
  // resolves to in this process, and must never be null even though
  // FOOD_AI_MODEL (a DIFFERENT, unrelated env var) is unset in this test.
  const expectedOllamaModel = process.env.OLLAMA_MODEL || 'llama3.2';
  assert.equal(result.ai.model, expectedOllamaModel);
  assert.ok(result.ai.model, 'model must never be null for a successful estimate');
  assert.equal(result.validation_status, 'AI_ESTIMATED');

  const row = await db.q1('SELECT * FROM ai_food_estimates WHERE canonical_key = ?', [result.cache_key]);
  assert.ok(row, 'a fresh estimate must write a cache row');
  assert.equal(row.ai_provider, 'ollama');
  assert.equal(row.ai_model, expectedOllamaModel, 'the cache row must record the REAL model used, not the unset FOOD_AI_MODEL env var');
  assert.ok(row.ai_model, 'ai_model must never be null/empty on the persisted row');
  assert.equal(row.validation_status, 'AI_ESTIMATED');
  assert.equal(row.version, 1);
  assert.ok(row.created_at, 'created_at must be recorded');
  assert.ok(!Number.isNaN(Date.parse(row.created_at)), 'created_at must be a valid timestamp');
});

/* ------------------------------------------------------------------ */
/*  recomputeAdjustedComponents — user adjustment flow, never a second  */
/*  AI call. Spec: "do NOT blindly trust the original AI total".        */
/* ------------------------------------------------------------------ */

test('recomputeAdjustedComponents — no edits reproduces the same grounded totals deterministically', () => {
  const search = getFoodSearch();
  if (!search) { assert.ok(true, 'model DB not present -- skipping'); return; }
  const { components: original } = resolveComponents([
    { name: 'cooked rice', estimated_weight_g: 200, calories: 1, protein_g: 1, carbs_g: 1, fat_g: 1 },
  ]);
  const { components, totals } = recomputeAdjustedComponents(original, [null]);
  assert.equal(components.length, 1);
  assert.equal(components[0].provenance.name, 'ai_original');
  assert.equal(components[0].provenance.estimated_weight_g, 'ai_original');
  if (original[0].db_grounded) {
    assert.equal(components[0].calories, original[0].calories);
    assert.equal(totals.calories, original[0].calories);
  }
});

test('recomputeAdjustedComponents — grams-only edit re-scales the SAME matched food, linearly', () => {
  const search = getFoodSearch();
  if (!search) { assert.ok(true, 'model DB not present -- skipping'); return; }
  const { components: original } = resolveComponents([
    { name: 'cooked rice', estimated_weight_g: 200, calories: 1, protein_g: 1, carbs_g: 1, fat_g: 1 },
  ]);
  if (!original[0].db_grounded) { assert.ok(true, 'rice did not ground in this DB snapshot -- skipping'); return; }

  const { components } = recomputeAdjustedComponents(original, [{ estimated_weight_g: 400 }]);
  assert.equal(components[0].matched_source_id, original[0].matched_source_id);
  assert.equal(components[0].db_grounded, true);
  assert.equal(components[0].provenance.estimated_weight_g, 'user_adjusted');
  assert.equal(components[0].provenance.name, 'ai_original');
  // 400g is exactly 2x 200g -- calories must double exactly (real scaleNutrition, not approximated).
  assert.ok(Math.abs(components[0].calories - original[0].calories * 2) < 0.5);
});

test('recomputeAdjustedComponents — an ingredient NAME swap re-resolves through Tier 2\'s alias-aware lookup', () => {
  const search = getFoodSearch();
  if (!search) { assert.ok(true, 'model DB not present -- skipping'); return; }
  const { components: original } = resolveComponents([
    { name: 'rice', estimated_weight_g: 200, calories: 1, protein_g: 1, carbs_g: 1, fat_g: 1 },
  ]);
  // Swap "rice" for "mutton" -- must re-resolve to real goat meat via the
  // SAME curated alias map Tier 2 uses, not stay pinned to the rice match.
  const { components } = recomputeAdjustedComponents(original, [{ name: 'mutton', estimated_weight_g: 300 }]);
  assert.equal(components[0].name, 'mutton');
  assert.equal(components[0].provenance.name, 'user_adjusted');
  assert.equal(components[0].provenance.estimated_weight_g, 'user_adjusted');
  if (components[0].db_grounded) {
    assert.ok(!/tallow|lard|korma|curry/i.test(components[0].matched_food || ''),
      `mutton swap must not resolve to rendered fat or a dish, got "${components[0].matched_food}"`);
  }
});

test('recomputeAdjustedComponents — removing a component drops it from totals entirely', () => {
  // Names deliberately unresolvable against the real DB (unlike "rice"/
  // "oil", which the alias-aware lookup WOULD ground -- and correctly so,
  // even on an untouched sibling component, since re-deriving via the same
  // deterministic function on the same inputs always reproduces the same
  // result. Using genuinely unresolvable names here keeps this test about
  // removal, not about whether Case 2's re-resolution attempt fires.
  const original = [
    { name: 'zzqxvv-fixture-food-a', estimated_weight_g: 200, calories: 260, protein_g: 5, carbs_g: 56, fat_g: 1, db_grounded: false, matched_source_id: null },
    { name: 'zzqxvv-fixture-food-b', estimated_weight_g: 20, calories: 177, protein_g: 0, carbs_g: 0, fat_g: 20, db_grounded: false, matched_source_id: null },
  ];
  const { components, totals } = recomputeAdjustedComponents(original, [null, { removed: true }]);
  assert.equal(components.length, 1);
  assert.equal(components[0].name, 'zzqxvv-fixture-food-a');
  assert.equal(Math.round(totals.calories), 260);
});

test('recomputeAdjustedComponents — an unresolvable swapped name carries forward the ORIGINAL implied density, never fabricates a number', () => {
  const original = [
    { name: 'mystery sauce', estimated_weight_g: 100, calories: 200, protein_g: 2, carbs_g: 20, fat_g: 10, db_grounded: false, matched_source_id: null },
  ];
  const { components } = recomputeAdjustedComponents(original, [{ name: 'zzqxvv-still-not-real', estimated_weight_g: 50 }]);
  assert.equal(components[0].db_grounded, false);
  // Density (2 kcal/g) carried forward and applied to the new 50g, not a
  // fabricated or zeroed-out value: 50g x 2kcal/g = 100kcal.
  assert.equal(components[0].calories, 100);
  assert.equal(components[0].provenance.name, 'user_adjusted');
});

test('recomputeAdjustedComponents — all components removed returns an empty result, not a crash', () => {
  const original = [
    { name: 'rice', estimated_weight_g: 200, calories: 260, protein_g: 5, carbs_g: 56, fat_g: 1, db_grounded: false },
  ];
  const { components, totals } = recomputeAdjustedComponents(original, [{ removed: true }]);
  assert.equal(components.length, 0);
  assert.deepEqual(totals, { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
});
