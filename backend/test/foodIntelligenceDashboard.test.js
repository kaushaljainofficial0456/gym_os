// ============================================================
// Food Intelligence dashboard (Admin Console) -- every assertion here
// checks that a number/list is DERIVED CORRECTLY from real seeded rows,
// never that a plausible-looking number merely appears. See
// foodIntelligenceDashboard.js's own header comment for the exact data
// sources (events telemetry, ai_food_estimates, ai_food_feedback,
// foodAIConfigSummary).
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
import {
  getFoodIntelligenceOverview, getActivityTimeSeries, getProviderPerformance,
  getTopFoods, getMostCorrectedFoods, getReviewQueue, verifyFoodEstimate, rejectFoodEstimatePromotion, getDataQuality,
} from '../src/services/intelligence/foodIntelligenceDashboard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  // validation_status/version are additive migration columns (see
  // init-db.js), not part of the base schema.sql.
  db.exec(`ALTER TABLE ai_food_estimates ADD COLUMN validation_status TEXT NOT NULL DEFAULT 'AI_ESTIMATED'`);
  db.exec(`ALTER TABLE ai_food_estimates ADD COLUMN version INTEGER NOT NULL DEFAULT 1`);
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

async function insertEvent(db, type, data, createdAt = now()) {
  await db.run('INSERT INTO events (id, org_id, user_id, type, data_json, created_at) VALUES (?, NULL, NULL, ?, ?, ?)',
    [id('evt'), type, JSON.stringify(data || {}), createdAt]);
}

async function insertEstimate(db, { key, name, provider = 'groq', model = 'test-model', timesUsed = 1, confirmations = 0, validationStatus = 'AI_ESTIMATED' }) {
  await db.run(
    `INSERT INTO ai_food_estimates (id, canonical_key, canonical_name, component_template_json, nutrition_json, uncertainty_json, assumptions_json, source, ai_provider, ai_model, confidence, times_used, user_confirmation_count, validation_status, created_at, updated_at)
     VALUES (?, ?, ?, '[]', '{}', '{}', '[]', 'ai_estimated', ?, ?, 'medium', ?, ?, ?, ?, ?)`,
    [id('afe'), key, name, provider, model, timesUsed, confirmations, validationStatus, now(), now()]);
}

async function insertFeedback(db, { key, originalCalories, adjustedCalories }) {
  await db.run(
    `INSERT INTO ai_food_feedback (id, canonical_key, original_calories, adjusted_calories, quantity_g, created_at) VALUES (?, ?, ?, ?, 100, ?)`,
    [id('aff'), key, originalCalories, adjustedCalories, now()]);
}

test.beforeEach(() => { resetRateLimits(); });

// ---------------------------------------------------------------
// OVERVIEW
// ---------------------------------------------------------------

test('getFoodIntelligenceOverview: an empty platform shows real zeros and null rates, never fabricated numbers', async () => {
  const db = await memDb();
  const overview = await getFoodIntelligenceOverview(db);
  assert.equal(overview.today.cacheHits, 0);
  assert.equal(overview.allTime.cacheHits, 0);
  assert.equal(overview.allTime.cacheHitRate, null, 'a rate over zero denominators must be null, never 0 or NaN');
  assert.equal(overview.allTime.aiSuccessRate, null);
  assert.equal(overview.estimatedApiSavings, null, 'no $/call pricing exists for these providers -- must never be invented');
});

test('getFoodIntelligenceOverview: reflects real seeded cache/AI events and computes correct rates', async () => {
  const db = await memDb();
  await insertEvent(db, 'food_ai_cache_hit', {});
  await insertEvent(db, 'food_ai_cache_hit', {});
  await insertEvent(db, 'food_ai_cache_hit', {});
  await insertEvent(db, 'food_ai_cache_miss', {});
  await insertEvent(db, 'food_ai_tier4_success', { provider: 'groq' });
  await insertEvent(db, 'food_ai_tier4_failure', {});
  await insertEstimate(db, { key: 'k1', name: 'Dish 1' });
  await insertFeedback(db, { key: 'k1', originalCalories: 200, adjustedCalories: 180 });

  const overview = await getFoodIntelligenceOverview(db);
  assert.equal(overview.allTime.cacheHits, 3);
  assert.equal(overview.allTime.cacheMisses, 1);
  assert.equal(overview.allTime.cacheHitRate, 0.75, '3 hits / (3 hits + 1 miss)');
  assert.equal(overview.allTime.aiSuccessRate, 0.5, '1 success / (1 success + 1 failure)');
  assert.equal(overview.allTime.totalAiEstimatedFoods, 1);
  assert.equal(overview.allTime.totalCorrections, 1);
});

// ---------------------------------------------------------------
// ACTIVITY TIME SERIES
// ---------------------------------------------------------------

test('getActivityTimeSeries: buckets events by real day, backfilling days with zero activity', async () => {
  const db = await memDb();
  const today = new Date().toISOString().slice(0, 10);
  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
  await insertEvent(db, 'food_ai_cache_hit', {}, threeDaysAgo);
  await insertEvent(db, 'food_ai_cache_hit', {}, threeDaysAgo);
  await insertEvent(db, 'food_ai_tier4_call', {}); // today

  const series = await getActivityTimeSeries(db, { days: 7 });
  assert.equal(series.length, 7);
  const todayBucket = series.find((d) => d.date === today);
  assert.equal(todayBucket.aiCalls, 1);
  const threeDaysAgoBucket = series.find((d) => d.date === threeDaysAgo.slice(0, 10));
  assert.equal(threeDaysAgoBucket.cacheHits, 2);
  const emptyDayCount = series.filter((d) => d.cacheHits === 0 && d.cacheMisses === 0 && d.aiCalls === 0 && d.aiSuccess === 0 && d.aiFailures === 0).length;
  assert.equal(emptyDayCount, 5, 'days with no real activity show real zeros, not omitted or fabricated');
});

// ---------------------------------------------------------------
// PROVIDER PERFORMANCE
// ---------------------------------------------------------------

test('getProviderPerformance: attributes successes/failures to the CORRECT provider, including a failed-then-fell-through attempt', async () => {
  const db = await memDb();
  // Groq failed, chain fell through to Gemini which succeeded -- BOTH
  // providers' outcomes must be attributed correctly from one event.
  await insertEvent(db, 'food_ai_tier4_success', {
    provider: 'gemini', latencyMs: 800,
    provider_failure: [{ provider: 'groq', reason: 'rate_limited' }],
  });
  await insertEvent(db, 'food_ai_tier4_success', { provider: 'gemini', latencyMs: 1200 });
  await insertEvent(db, 'food_ai_tier4_failure', {
    provider_failure: [{ provider: 'groq', reason: 'rate_limited' }, { provider: 'gemini', reason: 'timeout' }],
  });

  const providers = await getProviderPerformance(db);
  const groq = providers.find((p) => p.provider === 'groq');
  const gemini = providers.find((p) => p.provider === 'gemini');
  assert.equal(groq.failures, 2, 'groq failed in both the fallback-success case and the total-failure case');
  assert.equal(groq.successes, 0);
  assert.equal(gemini.successes, 2);
  assert.equal(gemini.failures, 1);
  assert.equal(gemini.avgLatencyMs, 1000, 'average of 800 and 1200');
  assert.equal(gemini.successRate, 2 / 3);
});

// ---------------------------------------------------------------
// TOP FOODS / MOST CORRECTED
// ---------------------------------------------------------------

test('getTopFoods: orders by real times_used, most-reused first', async () => {
  const db = await memDb();
  await insertEstimate(db, { key: 'popular', name: 'Popular Dish', timesUsed: 50 });
  await insertEstimate(db, { key: 'rare', name: 'Rare Dish', timesUsed: 2 });
  const top = await getTopFoods(db, { limit: 10 });
  assert.equal(top[0].canonical_key, 'popular');
  assert.equal(top[1].canonical_key, 'rare');
});

test('getMostCorrectedFoods: computes the MEDIAN correction percentage, resistant to one outlier', async () => {
  const db = await memDb();
  await insertEstimate(db, { key: 'biryani', name: 'Chicken Biryani' });
  // Three normal corrections around -8%, one wild outlier at -90%.
  await insertFeedback(db, { key: 'biryani', originalCalories: 500, adjustedCalories: 460 }); // -8%
  await insertFeedback(db, { key: 'biryani', originalCalories: 500, adjustedCalories: 458 }); // -8.4%
  await insertFeedback(db, { key: 'biryani', originalCalories: 500, adjustedCalories: 462 }); // -7.6%
  await insertFeedback(db, { key: 'biryani', originalCalories: 500, adjustedCalories: 50 });  // -90% outlier

  const corrected = await getMostCorrectedFoods(db, { limit: 10 });
  assert.equal(corrected[0].canonicalKey, 'biryani');
  assert.equal(corrected[0].correctionCount, 4);
  assert.ok(corrected[0].medianCorrectionPct > -10 && corrected[0].medianCorrectionPct < -7,
    `median should stay near -8%, not be dragged toward the -90% outlier (got ${corrected[0].medianCorrectionPct})`);
});

// ---------------------------------------------------------------
// REVIEW QUEUE
// ---------------------------------------------------------------

test('getReviewQueue / verifyFoodEstimate / rejectFoodEstimatePromotion: the human-verification step this codebase always reserved', async () => {
  const db = await memDb();
  await insertEstimate(db, { key: 'candidate1', name: 'Candidate Dish', validationStatus: 'COMMUNITY_VALIDATED_CANDIDATE' });
  await insertEstimate(db, { key: 'plain', name: 'Plain AI Estimate', validationStatus: 'AI_ESTIMATED' });

  const queue = await getReviewQueue(db);
  assert.equal(queue.length, 1, 'only the community-flagged candidate appears, never a plain AI_ESTIMATED row');
  assert.equal(queue[0].canonical_key, 'candidate1');

  const verified = await verifyFoodEstimate(db, { canonicalKey: 'candidate1' });
  assert.equal(verified, true);
  const row = await db.q1('SELECT validation_status FROM ai_food_estimates WHERE canonical_key = ?', ['candidate1']);
  assert.equal(row.validation_status, 'VERIFIED_SHARED_FOOD');

  // Cannot verify the same one twice -- it's no longer a pending candidate.
  const secondVerify = await verifyFoodEstimate(db, { canonicalKey: 'candidate1' });
  assert.equal(secondVerify, false);

  await insertEstimate(db, { key: 'candidate2', name: 'Second Candidate', validationStatus: 'COMMUNITY_VALIDATED_CANDIDATE' });
  const rejected = await rejectFoodEstimatePromotion(db, { canonicalKey: 'candidate2' });
  assert.equal(rejected, true);
  const row2 = await db.q1('SELECT validation_status FROM ai_food_estimates WHERE canonical_key = ?', ['candidate2']);
  assert.equal(row2.validation_status, 'AI_ESTIMATED', 'a rejected promotion reverts to AI_ESTIMATED, never stays flagged forever');
});

// ---------------------------------------------------------------
// DATA QUALITY
// ---------------------------------------------------------------

test('getDataQuality: counts real missing-data issues in the GLOBAL library only', async () => {
  const db = await memDb();
  await db.run(`INSERT INTO foods (id, name, calories, protein, carbs, fat, source, is_global) VALUES ('f1', 'Complete Food', 100, 10, 10, 5, 'VERIFIED_DATABASE', 1)`);
  await db.run(`INSERT INTO foods (id, name, calories, protein, carbs, fat, source, is_global) VALUES ('f2', 'No Calories', NULL, 10, 10, 5, 'USER_ENTERED', 1)`);
  await db.run(`INSERT INTO foods (id, name, calories, protein, carbs, fat, source, is_global) VALUES ('f3', 'No Macros', 100, NULL, NULL, NULL, 'USER_ENTERED', 1)`);
  // A client-owned (non-global) food with missing calories must NOT
  // count -- this queue is about the shared library's own quality.
  await db.run(`INSERT INTO foods (id, name, calories, source, is_global) VALUES ('f4', 'Personal Food', NULL, 'USER_ENTERED', 0)`);

  const quality = await getDataQuality(db);
  assert.equal(quality.missingCalories, 1);
  assert.equal(quality.missingMacros, 1);
});

// ---------------------------------------------------------------
// ROUTE-LEVEL: review-queue actions are audited
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

test('POST /api/console/intelligence/food/review-queue/:key/verify: writes an audit record', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  await insertEstimate(db, { key: 'k1', name: 'Dish', validationStatus: 'COMMUNITY_VALIDATED_CANDIDATE' });
  const admin = await createSuperAdmin(db, api);

  const res = await api.call('POST', '/api/console/intelligence/food/review-queue/k1/verify', undefined, admin.token);
  assert.equal(res.status, 200, JSON.stringify(res.json));

  const audit = await api.call('GET', '/api/console/audit', undefined, admin.token);
  assert.ok(audit.json.logs.some((l) => l.action === 'food_estimate_verified' && l.entity_id === 'k1'));
});
