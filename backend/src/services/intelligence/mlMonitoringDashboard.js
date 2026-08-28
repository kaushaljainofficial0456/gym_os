// ============================================================
// ML MONITORING DASHBOARD (Admin Console) — the "ML monitoring"
// module deferred out of Phase 3c pending its own schema investigation
// (same discipline Food Intelligence's dashboard used before it was
// built). Investigated calorieModel.js / skosCalV1.js / skosCalV1.model.json
// first; every number here comes from one of two real sources:
//
//   1. `workouts` columns already persisted by every completed estimate
//      (calorie_provider, model_version, estimated/lower/upper_kcal) —
//      the unambiguous source of truth for what actually ran and what
//      it produced. Unaffected by this pass; these rows already existed.
//   2. Two NEW event types this pass added to calorieModel.js —
//      `calorie_ml_success` / `calorie_ml_fallback` — because before
//      this pass a fallback (timeout/unavailable/invalid output) was
//      ONLY ever `console.warn`'d, nowhere a dashboard could aggregate
//      it. Honestly empty ("no data yet") until real traffic
//      accumulates after this deploy — never backfilled or estimated
//      from history that predates the instrumentation.
//
// Model-card metadata (participant count, population, exercise coverage,
// guardrails) is read directly from Sambhav's own shipped
// skosCalV1.model.json artifact, never re-typed from docs/memory, so it
// can never silently drift from what the running model actually is.
// ============================================================
import { config } from '../../config.js';
import { ML_TIMEOUT_MS, MAX_ACTIVE_KCAL } from './calorieModel.js';
import MODEL from './mlModels/skosCalV1.model.json' with { type: 'json' };

function round1(v) { return Math.round(v * 10) / 10; }
function safeParseJson(json) { try { return JSON.parse(json || '{}'); } catch { return {}; } }

function summarize(values) {
  if (!values.length) return { avg: null, median: null };
  const sorted = [...values].sort((a, b) => a - b);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { avg: round1(avg), median: round1(median) };
}

/** The model's own self-reported scope/caveats — read verbatim from the
 *  shipped artifact, not re-described here (see this file's header). */
export function getModelCard() {
  return {
    provider: config.calorieModelProvider,
    mlEnabled: config.calorieModelProvider === 'ml',
    timeoutMs: ML_TIMEOUT_MS,
    maxActiveKcal: MAX_ACTIVE_KCAL,
    modelVersion: MODEL.model_version,
    schemaVersion: MODEL.schema_version,
    trainedAt: MODEL.trained_at,
    trainedOn: MODEL.trained_on,
    knownExercises: Object.keys(MODEL.correction_kcal_per_min_by_exercise_and_tier || {}),
    plausibilityCapKcalPerMin: MODEL.plausibility_guardrails?.max_active_rate_kcal_min ?? null,
    plausibilityCapRationale: MODEL.plausibility_guardrails?.rationale ?? null,
    bodyWeightValidRangeKg: MODEL.body_weight_validity
      ? [MODEL.body_weight_validity.flag_below_kg, MODEL.body_weight_validity.flag_above_kg]
      : null,
    bodyWeightValidityNote: MODEL.body_weight_validity?.note ?? null,
  };
}

/** Real per-provider distribution + estimate stats from PERSISTED
 *  completed-workout rows only (never unpersisted previews) — the
 *  unambiguous record of what actually ran and what it produced.
 *  Interval width is reported as a % of the estimate itself, since raw
 *  kcal width isn't comparable across sessions of very different size. */
export async function getEstimateStats(db, { days = 30 } = {}) {
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = await db.q(
    `SELECT calorie_provider AS provider, model_version, estimated_active_kcal, lower_kcal, upper_kcal
       FROM workouts
      WHERE status = 'completed' AND calorie_provider IS NOT NULL AND calorie_estimated_at >= ?`,
    [sinceIso]);
  const byProvider = new Map();
  for (const r of rows) {
    const p = r.provider || 'unknown';
    if (!byProvider.has(p)) byProvider.set(p, { provider: p, count: 0, kcal: [], widthPct: [], modelVersions: new Set() });
    const b = byProvider.get(p);
    b.count += 1;
    if (Number.isFinite(r.estimated_active_kcal)) b.kcal.push(r.estimated_active_kcal);
    if (Number.isFinite(r.lower_kcal) && Number.isFinite(r.upper_kcal) && r.estimated_active_kcal > 0) {
      b.widthPct.push(((r.upper_kcal - r.lower_kcal) / r.estimated_active_kcal) * 100);
    }
    if (r.model_version) b.modelVersions.add(r.model_version);
  }
  return {
    days,
    totalEstimates: rows.length,
    byProvider: [...byProvider.values()].map((b) => ({
      provider: b.provider,
      count: b.count,
      modelVersions: [...b.modelVersions],
      avgKcal: summarize(b.kcal).avg,
      medianKcal: summarize(b.kcal).median,
      avgIntervalWidthPct: summarize(b.widthPct).avg,
    })).sort((a, b) => b.count - a.count),
  };
}

/** Daily persisted-estimate counts per provider — real completions
 *  only, same source as getEstimateStats, bucketed for a chart. Mirrors
 *  foodIntelligenceDashboard.js's getActivityTimeSeries bucketing. */
export async function getEstimateActivity(db, { days = 14 } = {}) {
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = await db.q(
    `SELECT calorie_provider AS provider, calorie_estimated_at AS at
       FROM workouts
      WHERE status = 'completed' AND calorie_provider IS NOT NULL AND calorie_estimated_at >= ?`,
    [sinceIso]);
  const buckets = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    buckets.set(key, { date: key, baseline: 0, ml: 0, mock: 0 });
  }
  for (const row of rows) {
    const bucket = buckets.get(String(row.at).slice(0, 10));
    if (!bucket) continue;
    if (row.provider === 'baseline') bucket.baseline++;
    else if (row.provider === 'ml') bucket.ml++;
    else if (row.provider === 'mock') bucket.mock++;
  }
  return [...buckets.values()];
}

/** Real fallback + quality-flag telemetry from the two event types this
 *  pass added. Honestly empty until real traffic accumulates after
 *  deploy — see this file's header. */
export async function getMlHealth(db, { days = 30 } = {}) {
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const [successRows, fallbackRows] = await Promise.all([
    db.q(`SELECT data_json FROM events WHERE type = 'calorie_ml_success' AND created_at >= ?`, [sinceIso]),
    db.q(`SELECT data_json FROM events WHERE type = 'calorie_ml_fallback' AND created_at >= ?`, [sinceIso]),
  ]);
  const successes = successRows.map((r) => safeParseJson(r.data_json));
  const fallbacks = fallbackRows.map((r) => safeParseJson(r.data_json));
  const totalAttempts = successes.length + fallbacks.length;

  const byCategory = new Map();
  for (const f of fallbacks) {
    const cat = f.category || 'unknown';
    byCategory.set(cat, (byCategory.get(cat) || 0) + 1);
  }
  const flaggedSuccessCount = successes.filter((s) => s.hasNote).length;

  return {
    days,
    instrumented: totalAttempts > 0,
    totalAttempts,
    successCount: successes.length,
    fallbackCount: fallbacks.length,
    fallbackRatePct: totalAttempts ? round1((fallbacks.length / totalAttempts) * 100) : null,
    fallbacksByCategory: [...byCategory.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
    flaggedSuccessCount,
    flaggedSuccessRatePct: successes.length ? round1((flaggedSuccessCount / successes.length) * 100) : null,
  };
}

/** Everything the dashboard's landing view needs in one call. */
export async function getMlMonitoringOverview(db, { days = 30 } = {}) {
  const [modelCard, estimateStats, mlHealth] = await Promise.all([
    Promise.resolve(getModelCard()),
    getEstimateStats(db, { days }),
    getMlHealth(db, { days }),
  ]);
  return { modelCard, estimateStats, mlHealth };
}
