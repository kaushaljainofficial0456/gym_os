// ============================================================
// FOOD INTELLIGENCE DASHBOARD (Admin Console) — every number here comes
// from a real query against real tables/events; nothing is estimated
// or invented (per the spec's own "never fabricate metrics" rule).
//
// Data sources, all pre-existing:
//   - events (type IN food_ai_cache_hit|cache_miss|tier4_call|
//     tier4_success|tier4_failure|food_ai_failure_<reason>) -- real,
//     timestamped telemetry already written by foodAI.js on every
//     cache/AI decision point. This is the ONLY source for time-series
//     and provider latency/success-rate stats; there is no separate
//     analytics table.
//   - ai_food_estimates -- one row per canonical dish concept, with
//     times_used (cache reuse count), validation_status (AI_ESTIMATED |
//     COMMUNITY_VALIDATED_CANDIDATE | VERIFIED_SHARED_FOOD -- see
//     foodFeedback.js's own header comment on what each means).
//   - ai_food_feedback -- one row per user correction, per-100g
//     normalized (see foodFeedback.js).
//   - foodAIConfigSummary() (foodAI.js, already exported) -- the REAL
//     configured daily budget/cooldown state, reused here rather than
//     re-implemented.
//
// Anything this pass genuinely cannot compute (there is no $/call
// pricing configured anywhere for these providers) is reported as
// `null`/'unavailable', never invented -- see estimatedApiSavings below.
// ============================================================
import { now } from '../../ids.js';
import { foodAIConfigSummary } from './foodAI.js';

const AI_EVENT_TYPES = ['food_ai_cache_hit', 'food_ai_cache_miss', 'food_ai_tier4_call', 'food_ai_tier4_success', 'food_ai_tier4_failure'];

function safeParseJson(json) {
  try { return JSON.parse(json || '{}'); } catch { return {}; }
}

async function countEvents(db, type, sinceIso = null) {
  const row = sinceIso
    ? await db.q1('SELECT COUNT(*) AS n FROM events WHERE type = ? AND created_at >= ?', [type, sinceIso])
    : await db.q1('SELECT COUNT(*) AS n FROM events WHERE type = ?', [type]);
  return Number(row?.n || 0);
}

/** Real aggregate KPIs, today + all-time. A cache hit IS an avoided AI
 *  call by construction (see foodAI.js: a hit returns immediately,
 *  never reaching the tier4 call) -- "AI calls avoided" is just the
 *  cache-hit count, not a separate estimate. */
export async function getFoodIntelligenceOverview(db) {
  const todayStart = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
  const [
    cacheHitsToday, cacheMissesToday, aiCallsToday, aiSuccessToday, aiFailuresToday,
    cacheHitsTotal, cacheMissesTotal, aiCallsTotal, aiSuccessTotal, aiFailuresTotal,
    totalEstimates, totalFeedback, needsReview,
  ] = await Promise.all([
    countEvents(db, 'food_ai_cache_hit', todayStart),
    countEvents(db, 'food_ai_cache_miss', todayStart),
    countEvents(db, 'food_ai_tier4_call', todayStart),
    countEvents(db, 'food_ai_tier4_success', todayStart),
    countEvents(db, 'food_ai_tier4_failure', todayStart),
    countEvents(db, 'food_ai_cache_hit'),
    countEvents(db, 'food_ai_cache_miss'),
    countEvents(db, 'food_ai_tier4_call'),
    countEvents(db, 'food_ai_tier4_success'),
    countEvents(db, 'food_ai_tier4_failure'),
    db.q1('SELECT COUNT(*) AS n FROM ai_food_estimates'),
    db.q1('SELECT COUNT(*) AS n FROM ai_food_feedback'),
    db.q1(`SELECT COUNT(*) AS n FROM ai_food_estimates WHERE validation_status = 'COMMUNITY_VALIDATED_CANDIDATE'`),
  ]);

  return {
    today: { cacheHits: cacheHitsToday, cacheMisses: cacheMissesToday, aiCalls: aiCallsToday, aiSuccess: aiSuccessToday, aiFailures: aiFailuresToday },
    allTime: {
      cacheHits: cacheHitsTotal, cacheMisses: cacheMissesTotal, aiCalls: aiCallsTotal, aiSuccess: aiSuccessTotal, aiFailures: aiFailuresTotal,
      cacheHitRate: (cacheHitsTotal + cacheMissesTotal) > 0 ? cacheHitsTotal / (cacheHitsTotal + cacheMissesTotal) : null,
      aiSuccessRate: (aiSuccessTotal + aiFailuresTotal) > 0 ? aiSuccessTotal / (aiSuccessTotal + aiFailuresTotal) : null,
      totalAiEstimatedFoods: Number(totalEstimates?.n || 0),
      totalCorrections: Number(totalFeedback?.n || 0),
      needsReviewCount: Number(needsReview?.n || 0),
    },
    // No per-call $ pricing is configured anywhere for these providers
    // (Groq/Gemini/OpenRouter free-tier, Ollama local) -- shown honestly
    // as unavailable rather than invented, per the spec's own rule.
    estimatedApiSavings: null,
  };
}

/** Daily counts for the last `days` days. Fetched as ONE query over the
 *  whole window then bucketed in JS by created_at.slice(0,10) --
 *  matches this codebase's own established pattern for date-bucketing
 *  a TEXT timestamp column (see admin.js's revenue trend) rather than a
 *  driver-specific SQL date-group function. */
export async function getActivityTimeSeries(db, { days = 14 } = {}) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const placeholders = AI_EVENT_TYPES.map(() => '?').join(',');
  const rows = await db.q(
    `SELECT type, created_at FROM events WHERE type IN (${placeholders}) AND created_at >= ?`,
    [...AI_EVENT_TYPES, since]);
  const buckets = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    buckets.set(key, { date: key, cacheHits: 0, cacheMisses: 0, aiCalls: 0, aiSuccess: 0, aiFailures: 0 });
  }
  for (const row of rows) {
    const bucket = buckets.get(String(row.created_at).slice(0, 10));
    if (!bucket) continue;
    if (row.type === 'food_ai_cache_hit') bucket.cacheHits++;
    else if (row.type === 'food_ai_cache_miss') bucket.cacheMisses++;
    else if (row.type === 'food_ai_tier4_call') bucket.aiCalls++;
    else if (row.type === 'food_ai_tier4_success') bucket.aiSuccess++;
    else if (row.type === 'food_ai_tier4_failure') bucket.aiFailures++;
  }
  return [...buckets.values()];
}

/** Per-provider performance -- combines the REAL cost/cooldown state
 *  (foodAIConfigSummary, reused not duplicated) with success/failure/
 *  latency parsed from the actual tier4_success/tier4_failure events'
 *  data_json. Both event types carry a `provider_failure` array (every
 *  provider that failed en route, even on an eventually-successful
 *  call via fallback -- see foodAI.js) -- that's the accurate source
 *  for per-provider failures, not a guess from the single top-level
 *  `provider` field (which only ever names the FINAL outcome). */
export async function getProviderPerformance(db) {
  const config = await foodAIConfigSummary(db);
  const rows = await db.q(`SELECT type, data_json FROM events WHERE type IN ('food_ai_tier4_success', 'food_ai_tier4_failure')`);
  const stats = {};
  const ensure = (p) => { if (!stats[p]) stats[p] = { successes: 0, failures: 0, latencies: [] }; return stats[p]; };
  for (const p of config.chain) ensure(p);

  for (const row of rows) {
    const data = safeParseJson(row.data_json);
    if (Array.isArray(data.provider_failure)) {
      for (const f of data.provider_failure) if (f?.provider) ensure(f.provider).failures++;
    }
    if (row.type === 'food_ai_tier4_success' && data.provider) {
      const s = ensure(data.provider);
      s.successes++;
      if (typeof data.latencyMs === 'number') s.latencies.push(data.latencyMs);
    }
  }

  return config.chain.map((provider) => {
    const s = stats[provider] || { successes: 0, failures: 0, latencies: [] };
    const requests = s.successes + s.failures;
    return {
      provider,
      configured: config.chainAvailability[provider],
      requests, successes: s.successes, failures: s.failures,
      successRate: requests > 0 ? s.successes / requests : null,
      avgLatencyMs: s.latencies.length ? Math.round(s.latencies.reduce((a, b) => a + b, 0) / s.latencies.length) : null,
      dailyUsage: config.dailyUsage[provider] ?? 0,
      dailyLimit: config.dailyLimits[provider] ?? null,
      onCooldown: !!config.cooldownActive[provider],
    };
  });
}

export async function getTopFoods(db, { limit = 20 } = {}) {
  return db.q(
    `SELECT canonical_key, canonical_name, ai_provider, ai_model, confidence, validation_status, times_used, user_confirmation_count, created_at, updated_at
       FROM ai_food_estimates ORDER BY times_used DESC LIMIT ?`, [limit]);
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median, not mean -- one wildly-off correction must not dominate the
 *  ranking, matching the SAME reasoning foodFeedback.js's own
 *  aggregateAndMaybePromote() already uses for promoting an estimate. */
export async function getMostCorrectedFoods(db, { limit = 20 } = {}) {
  const rows = await db.q(
    `SELECT f.canonical_key, e.canonical_name, f.original_calories, f.adjusted_calories
       FROM ai_food_feedback f LEFT JOIN ai_food_estimates e ON e.canonical_key = f.canonical_key
      WHERE f.original_calories IS NOT NULL AND f.adjusted_calories IS NOT NULL AND f.original_calories > 0`);
  const byKey = new Map();
  for (const r of rows) {
    if (!byKey.has(r.canonical_key)) byKey.set(r.canonical_key, { canonicalKey: r.canonical_key, name: r.canonical_name || r.canonical_key, pctCorrections: [] });
    byKey.get(r.canonical_key).pctCorrections.push(((r.adjusted_calories - r.original_calories) / r.original_calories) * 100);
  }
  const result = [...byKey.values()].map((entry) => ({
    canonicalKey: entry.canonicalKey,
    name: entry.name,
    correctionCount: entry.pctCorrections.length,
    medianCorrectionPct: Math.round(median(entry.pctCorrections) * 10) / 10,
  }));
  result.sort((a, b) => b.correctionCount - a.correctionCount);
  return result.slice(0, limit);
}

/** The "needs review" queue -- foods the system ITSELF already
 *  flagged as COMMUNITY_VALIDATED_CANDIDATE (>= MIN_FEEDBACK_COUNT
 *  independent, mutually-consistent corrections -- see
 *  foodFeedback.js's aggregateAndMaybePromote). Never auto-promoted to
 *  VERIFIED_SHARED_FOOD by anything in this codebase -- that status is
 *  reserved for exactly this human review step. */
export async function getReviewQueue(db, { limit = 50 } = {}) {
  const rows = await db.q(
    `SELECT e.*, (SELECT COUNT(*) FROM ai_food_feedback f WHERE f.canonical_key = e.canonical_key) AS feedback_count
       FROM ai_food_estimates e WHERE e.validation_status = 'COMMUNITY_VALIDATED_CANDIDATE'
      ORDER BY e.updated_at DESC LIMIT ?`, [limit]);
  return rows.map((r) => ({ ...r, feedback_count: Number(r.feedback_count || 0) }));
}

/** Approves a community-corrected estimate as human-verified. The ONE
 *  place VERIFIED_SHARED_FOOD is ever set -- never automatic. */
export async function verifyFoodEstimate(db, { canonicalKey }) {
  const result = await db.run(
    `UPDATE ai_food_estimates SET validation_status = 'VERIFIED_SHARED_FOOD', updated_at = ? WHERE canonical_key = ? AND validation_status = 'COMMUNITY_VALIDATED_CANDIDATE'`,
    [now(), canonicalKey]);
  return result.changes === 1;
}

/** Rejects a promotion candidate -- the aggregate stays cached
 *  (nutrition_json was already updated when it was promoted), just no
 *  longer flagged for review; reverts to AI_ESTIMATED so a FUTURE
 *  fresh wave of feedback can re-trigger promotion instead of being
 *  permanently silenced. */
export async function rejectFoodEstimatePromotion(db, { canonicalKey }) {
  const result = await db.run(
    `UPDATE ai_food_estimates SET validation_status = 'AI_ESTIMATED', updated_at = ? WHERE canonical_key = ? AND validation_status = 'COMMUNITY_VALIDATED_CANDIDATE'`,
    [now(), canonicalKey]);
  return result.changes === 1;
}

/** Real counts of specific, checkable data-quality issues in the GLOBAL
 *  food library -- never a vague "quality score". */
export async function getDataQuality(db) {
  const [missingCalories, missingMacros, missingServing, duplicateNames] = await Promise.all([
    db.q1(`SELECT COUNT(*) AS n FROM foods WHERE is_global = 1 AND calories IS NULL`),
    db.q1(`SELECT COUNT(*) AS n FROM foods WHERE is_global = 1 AND (protein IS NULL OR carbs IS NULL OR fat IS NULL)`),
    db.q1(`SELECT COUNT(*) AS n FROM foods WHERE is_global = 1 AND (serving IS NULL OR serving = '') AND piece_g IS NULL`),
    db.q1(`SELECT COUNT(*) AS n FROM (SELECT LOWER(name) AS n FROM foods WHERE is_global = 1 GROUP BY LOWER(name) HAVING COUNT(*) > 1) dupes`),
  ]);
  return {
    missingCalories: Number(missingCalories?.n || 0),
    missingMacros: Number(missingMacros?.n || 0),
    missingServingInfo: Number(missingServing?.n || 0),
    duplicateGlobalNames: Number(duplicateNames?.n || 0),
  };
}
