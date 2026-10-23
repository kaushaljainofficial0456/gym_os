// ============================================================
// CALORIE MODEL — the ONLY backend service responsible for
// calorie estimation (workout energy expenditure).
//
//   workout → feature extraction → calorieModel → estimate
//                                     ↓
//                        workout persistence → API response
//
// The service NEVER owns route handling and NEVER writes to the
// database by itself: it returns an estimate and callers persist it
// via persistCalorieResult(). The backend remains the sole writer —
// an ML provider can never touch PostgreSQL directly.
//
// Providers (env CALORIE_MODEL_PROVIDER, default 'baseline'):
//   baseline — deterministic MET-based heuristic. Clearly a baseline,
//              NOT ML. Always available.
//   mock     — fixed demo values for UI/test development only.
//   ml       — Sambhav's skos-cal-v1 model (see mlModels/skosCalV1.js).
//              Wired in as of Phase 3B Step 3. Default provider is still
//              'baseline' (config.js) — 'ml' only runs when explicitly
//              configured via CALORIE_MODEL_PROVIDER=ml, and per
//              Sambhav's own pre-integration audit should only be
//              enabled in dev/staging, never production, until his
//              documented production blockers are separately resolved.
//              Any failure (exception/timeout/invalid output) still
//              falls back to baseline so the API never breaks.
//
// estimateWorkoutCalories() is ASYNC and bounds the 'ml' provider to
// ML_TIMEOUT_MS (see callMlProviderWithTimeout) — a slow/hanging remote
// model can NEVER stall workout completion; it degrades to baseline.
//
// The frontend never learns which provider ran — only the persistence
// layer records it (workouts.calorie_provider). Do not expose model
// credentials or provider internals in any API response.
//
// INPUT CONTRACT (schema_version '0.2'): see docs/calorie-model-contract.md
//
// ML PROVIDER (Phase 3B Step 3): wired to Sambhav's skos-cal-v1 model,
// ported (ESM, mechanical, coefficients byte-for-byte unchanged) from
// origin/ml-sambhav @ e9147e4 — see mlModels/skosCalV1.js. Two SK-OS-owned
// adapter steps sit between the ported model and this file's own gate:
//   1. toMlInput() — canonicalizes a KNOWN GLOBAL exercise's opaque
//      backend exercise_id to Sambhav's canonical token (e.g. BENCH_PRESS)
//      on a transient copy only; baseline/persistence/training-data export
//      always see the real, unmapped exercise_id.
//   2. toNetOfResting() — Sambhav's model computes GROSS energy
//      expenditure; this contract defines estimated_active_kcal as energy
//      ABOVE resting (§3 below) — converted at this boundary, reusing the
//      SAME MET-based formula already used everywhere else in this file.
// Neither step touches validateCalorieResult(), the timeout boundary, or
// any fallback/observability behavior — all inherited unchanged from
// Phase 3B Step 1.
// ============================================================
import { dayKey } from '../../utils/time.js';
import { config, CALORIE_PROVIDERS } from '../../config.js';
import { mlEstimate as skosCalV1Estimate } from './mlModels/skosCalV1.js';
import { mifflinStJeorBmr } from './restingEnergy.js';
import { track } from '../events.js';

export const CALORIE_SCHEMA_VERSION = '0.2';
// v2 (2026-10): Compendium 2024 session METs, reported NET of this
// person's own resting energy. v1 rows (MET 4.5 for a moderate session,
// gross) stay labelled v1 so history is never silently reinterpreted.
export const BASELINE_MODEL_VERSION = 'skos-cal-baseline-v2';
export const MOCK_MODEL_VERSION = 'skos-cal-mock-v1';
export const DEFAULT_BODY_WEIGHT_KG = 70;

// MET (metabolic equivalent) for a whole resistance-training SESSION, by
// the effort the member reports, from the 2024 Adult Compendium of
// Physical Activities (Herrmann et al., J Sport Health Sci 2024;
// pacompendium.com):
//   light    3.0  02056 body-weight resistance exercises, general
//   moderate 3.5  02054 resistance training, multiple exercises, 8-15 reps
//                 at varied resistance -- an ordinary gym session
//   hard     6.0  02050 resistance training, power lifting or body
//                 building, vigorous effort
//
// The moderate figure is not only the Compendium's: four independent
// whole-session calorimetry studies of real gym sessions, rest between
// sets included, measured 0.059-0.067 kcal/min/kg gross, i.e. 3.4-3.8 MET
// (Rustaden 2020, Benito 2016, Adeel 2021, Nakagata 2019 -- the
// external_plausibility_envelope in ml/models/skos-cal-v1/model_v1.json).
// The previous values (3.0 / 4.5 / 6.0) were hand-picked; 4.5 for an
// ordinary session sat about 25% above every one of those measurements.
//
// A MET is GROSS: 1 MET is merely being alive. baselineEstimate() below
// subtracts the person's resting energy, because the stored figure is
// energy ABOVE resting (see calorie-model-contract.md §3, energyBalance.js).
export const INTENSITY_MET = { light: 3.0, moderate: 3.5, hard: 6.0 };

// The baseline's displayed band. NOT a calibrated interval -- no validated
// interval exists for a MET estimate of a whole session. It is wider than
// the +/-6% spread between those four labs' session means, to leave room
// for the person-to-person variation inside each study, and it is
// deliberately not the +/-15% this used to claim, which promised more
// precision than any of the evidence supports.
const BASELINE_BAND = 0.25;

const pos = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;

// Provider resolution returns the SINGLE authoritative value resolved and
// validated ONCE at startup by config.js (config.calorieModelProvider). It
// never reads process.env itself — mutating CALORIE_MODEL_PROVIDER at
// runtime has no effect on the running application. Missing/empty in any
// environment -> safe baseline default; staging/production invalid values
// already failed fast at startup; development invalid -> baseline + warning.
export function resolveProvider() {
  return config.calorieModelProvider;
}

// Sane upper bound for ACTIVE calories in a single resistance-training
// session. Rationale: ~2 h at vigorous effort ≈ 6 MET × 3.5 × 120 kg ÷
// 200 × 120 min ≈ 1512 kcal. Anything larger is a buggy provider, not a
// real session — reject and fall back rather than persist garbage.
export const MAX_ACTIVE_KCAL = 1500;

// Hard timeout budget for a provider call (env CALORIE_MODEL_PROVIDER=ml).
// Today's stub throws synchronously and never approaches this, but a real
// model is very likely a network call — this bounds it so a slow/hanging
// provider can NEVER stall workout completion
// (POST /:id/complete, POST /intel/confirm-workout). Kept small and
// explicit: those routes already do several sequential DB writes inside
// one transaction, so the ML call itself must stay well under a second
// budget that still feels instant to the caller.
export const ML_TIMEOUT_MS = 3000;

// Mutable budget actually used by callMlProviderWithTimeout — defaults to
// ML_TIMEOUT_MS. Test hook below (mirrors __setMlEstimateForTests) lets
// timeout-fallback tests use a tiny budget so they run fast and
// deterministically instead of waiting out the real production timeout.
// Production code never calls the setter.
let mlTimeoutMs = ML_TIMEOUT_MS;
export function __setMlTimeoutForTests(ms) {
  mlTimeoutMs = Number.isFinite(ms) && ms > 0 ? ms : ML_TIMEOUT_MS;
}

// Distinguishes "the provider took too long" from any other provider
// failure (throw, rejection, malformed output) so fallback observability
// can log an accurate category. Never exposed to the frontend or persisted.
export class MlTimeoutError extends Error {
  constructor(ms) {
    super(`calorie ml provider timed out after ${ms}ms`);
    this.name = 'MlTimeoutError';
  }
}

// ------------------------------------------------------------------
// VALIDATION GATE — the single place a provider result is checked
// before it can ever be persisted. Runs inside estimateWorkoutCalories,
// so every call site (workouts.js /:id/complete, intelligence.js
// /confirm-workout) is protected: persistCalorieResult only ever
// receives output that passed here. schema_version is stamped by the
// backend — a model-provided value is never trusted.
// ------------------------------------------------------------------
export function validateCalorieResult(result = {}) {
  const issues = [];
  const { estimated_active_kcal, lower_kcal, upper_kcal, model_version, provider } = result;
  const nonNegNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

  if (!nonNegNum(estimated_active_kcal)) {
    issues.push('estimated_active_kcal must be a finite number >= 0');
  } else if (estimated_active_kcal > MAX_ACTIVE_KCAL) {
    issues.push(`estimated_active_kcal exceeds the documented sane maximum (${MAX_ACTIVE_KCAL})`);
  }
  if (!nonNegNum(lower_kcal)) issues.push('lower_kcal must be a finite number >= 0');
  if (!nonNegNum(upper_kcal)) issues.push('upper_kcal must be a finite number >= 0');
  if (nonNegNum(lower_kcal) && nonNegNum(estimated_active_kcal) && nonNegNum(upper_kcal)) {
    if (lower_kcal > estimated_active_kcal || estimated_active_kcal > upper_kcal) {
      issues.push('range violated: lower_kcal <= estimated_active_kcal <= upper_kcal');
    }
  }
  if (typeof model_version !== 'string' || !model_version.trim()) {
    issues.push('model_version must be a non-empty string');
  }
  if (!CALORIE_PROVIDERS.includes(provider)) {
    issues.push('provider must be one of: baseline, mock, ml');
  }
  if (issues.length) return { ok: false, issues };
  return { ok: true, result: { ...result, schema_version: CALORIE_SCHEMA_VERSION } };
}

// ------------------------------------------------------------------
// Fallback observability — server-side only. Logs baseline fallbacks with
// a SAFE whitelist of fields: category, requested provider, opaque workout
// id, model version when known, and the static validation issues from our
// own gate. NEVER logs workout payloads, user data, body weight, set logs,
// raw ML output, or credentials.
// Categories: ml_unavailable (provider threw/rejected/returned nothing) |
//             ml_timeout (provider exceeded ML_TIMEOUT_MS) | invalid_output.
// ------------------------------------------------------------------
function logCalorieFallback(category, meta = {}) {
  const fields = { category, provider: meta.provider || null, workout_id: meta.workout_id || null };
  if (meta.model_version) fields.model_version = meta.model_version;
  if (Array.isArray(meta.issues) && meta.issues.length) fields.issues = meta.issues;
  console.warn('[sk-os] calorie: baseline fallback', fields);
}

// ------------------------------------------------------------------
// ML monitoring telemetry (Admin Console §"ML monitoring") — mirrors
// foodAI.js's own track()-into-events pattern, previously absent here
// (this file only ever logged fallbacks to console.warn, nowhere a
// dashboard could aggregate them). AWAITED (unlike a true fire-and-
// forget call) so the insert lands inside the SAME transaction the
// caller is usually already in before it commits -- on the Postgres
// driver a genuinely unawaited call could otherwise still be in flight
// when the surrounding db.tx() commits and returns its connection to
// the pool. Never throws (track()'s own try/catch), and adds at most
// one fast local write to the critical path -- `db` optional (a missing
// db silently no-ops). Only ever called for the 'ml' provider —
// baseline/mock have nothing to monitor. Payload is a SAFE whitelist
// only: category/hasNote booleans and the calling stage, never workout
// payloads, user data, or raw ML output — same whitelist discipline as
// logCalorieFallback above.
// ------------------------------------------------------------------
async function trackCalorieMlEvent(db, type, data) {
  if (!db) return;
  await track(db, { type, data }).catch(() => {});
}

// ------------------------------------------------------------------
// EXERCISE CANONICALIZATION (Phase 3B Step 3) — maps a KNOWN GLOBAL
// exercise's stable animation_key to Sambhav's trained canonical token.
// Deliberately covers only the 6 unambiguous exact matches confirmed
// against the real exercise_library seed data — INCLINE_BENCH_PRESS and
// TRICEPS_EXTENSION are intentionally NOT mapped (multiple plausible
// backend candidates, no source resolves which — never guessed; those
// exercises correctly fall through to the model's own "unknown exercise"
// path: zero correction, widened interval, flagged via note).
//
// SECURITY: animation_key is an org-settable free-text field on custom
// (non-global) exercises (POST /exercises accepts it). Never trust it
// for ML canonicalization unless the row is_global = 1 — otherwise a
// gym could mislabel an unrelated custom exercise into a trained
// correction it has nothing to do with.
// ------------------------------------------------------------------
const ANIMATION_KEY_TO_ML_CANONICAL = Object.freeze({
  bench_press: 'BENCH_PRESS',
  squat: 'BARBELL_SQUAT',
  leg_press: 'LEG_PRESS',
  leg_extension: 'LEG_EXTENSION',
  lat_pulldown: 'LAT_PULLDOWN',
  bicep_curl: 'BICEP_CURL'
});

// Returns the canonical token for a KNOWN GLOBAL exercise, or null when
// unmapped/unsafe (custom exercise, or not one of the 6 confirmed exact
// matches) — null means "use the model's own safe unknown-exercise
// behavior," never a guess.
export function mlCanonicalExerciseId({ animationKey, isGlobal } = {}) {
  if (!isGlobal) return null; // never trust an org-custom exercise's animation_key
  return ANIMATION_KEY_TO_ML_CANONICAL[String(animationKey || '').trim().toLowerCase()] || null;
}

// Builds a TRANSIENT copy of the contract-0.2 input for the ml provider
// only — swaps exercises[].exercise_id to its canonical token wherever
// exerciseCanonical (built by the caller from mlCanonicalExerciseId, see
// routes/workouts.js, routes/intelligence.js, services/trainingProgram.js)
// has a mapping. NEVER mutates `input` — baselineEstimate(input),
// persistence, and the training-data export always see the real,
// unmapped exercise_id. A no-op (returns `input` itself) when no map is
// supplied, so every existing caller that doesn't pass one is unaffected.
function toMlInput(input, exerciseCanonical) {
  if (!exerciseCanonical || !Object.keys(exerciseCanonical).length) return input;
  return {
    ...input,
    exercises: (input.exercises || []).map((e) => {
      const mapped = exerciseCanonical[e.exercise_id];
      return mapped ? { ...e, exercise_id: mapped } : e;
    })
  };
}

// ------------------------------------------------------------------
// GROSS -> NET-OF-RESTING CONVERSION (Phase 3B Step 3).
// Sambhav's skos-cal-v1 model computes GROSS energy expenditure during
// the workout period (confirmed: no resting-rate subtraction anywhere in
// his pipeline). This backend's contract defines estimated_active_kcal
// as energy expended ABOVE resting (docs/calorie-model-contract.md §3).
// Converts at this integration boundary by reusing the EXACT SAME
// MET-based formula already used everywhere else in this file
// (INTENSITY_MET / 3.5 / 200) — no new BMR formula invented. MET=1 is,
// by definition, resting metabolic rate (ACSM standard; the same
// resting-rate formula Sambhav's own audit independently used for this
// exact purpose).
//
// Subtracts the SAME absolute resting-kcal amount from
// estimated/lower/upper (a constant offset preserves interval width and
// ordering exactly — see derivation in the integration audit), then
// clamps each independently to >= 0 — but ONLY when the raw gross value
// was itself already sane (>= 0). A gross value that is ALREADY negative
// is never "fixed" by clamping — that would silently launder obviously
// broken provider output (e.g. a buggy/adversarial model) into a
// valid-looking 0 and defeat validateCalorieResult()'s garbage check,
// which runs AFTER this conversion. Clamping only ever applies to the
// legitimate case: a small-but-valid gross estimate that dips below the
// resting subtraction (net effort can't be less than "zero extra"), and
// can only ever pull a value UP to 0 — never past a sibling that stayed
// unclamped — so lower <= estimated <= upper is provably preserved for
// every input where the raw values were already sane.
// Never mutates its input; passes the result through unchanged if body
// weight/duration are somehow missing (defensive — Sambhav's own
// mlEstimate already throws on that case before this ever runs).
// ------------------------------------------------------------------
const RESTING_MET = 1.0; // ACSM: 1 MET = resting metabolic rate, by definition

/**
 * THIS person's resting energy, kcal per minute.
 *
 * Mifflin-St Jeor when weight, height and age are known -- the same
 * formula the nutrition targets and the energy balance use
 * (restingEnergy.js), so the three can never disagree about how much of a
 * session was simply being alive. Without them, the standard 1 MET
 * (3.5 ml O2/kg/min), which measured resting rates sit 10-20% below on
 * average (Byrne et al. 2005; Kozey et al. 2010) -- an honest fallback,
 * not a guess at the missing fields.
 */
export function restingKcalPerMinute(user = {}) {
  const bw = pos(user?.body_weight_kg);
  const bmr = mifflinStJeorBmr({ weightKg: bw, heightCm: user?.height_cm, age: user?.age_years, sex: user?.sex });
  if (Number.isFinite(bmr) && bmr > 0) return { perMin: bmr / 1440, source: 'mifflin_st_jeor' };
  if (bw) return { perMin: (RESTING_MET * 3.5 * bw) / 200, source: 'standard_met' };
  return null;
}

function toNetOfResting(grossResult, input) {
  const bw = pos(input?.user?.body_weight_kg);
  const durationMin = pos(input?.session?.duration_minutes);
  if (!bw || !durationMin) return grossResult;
  // The person's own resting rate when their profile allows it, the
  // standard 1 MET otherwise -- see restingKcalPerMinute.
  const restingKcal = restingKcalPerMinute(input.user).perMin * durationMin;
  const netify = (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return v; // not a number — let the gate's own type check catch it
    if (v < 0) return v; // already-invalid gross value — never "fixed" here, must still fail validation
    return Math.max(0, v - restingKcal);
  };
  return {
    ...grossResult,
    estimated_active_kcal: Math.round(netify(grossResult.estimated_active_kcal)),
    lower_kcal: Math.round(netify(grossResult.lower_kcal)),
    upper_kcal: Math.round(netify(grossResult.upper_kcal))
  };
}

// ------------------------------------------------------------------
// Bounds a provider call to ML_TIMEOUT_MS and ALWAYS settles — a hanging
// call can never hang this. mlImpl may be synchronous (today's stub,
// which throws immediately) or asynchronous (a real network-bound model);
// wrapping the call in Promise.resolve().then(...) normalizes both into
// a promise so they race identically against the timeout. mlImpl
// receives an AbortSignal so a future fetch-based implementation can
// cancel its own in-flight request on timeout — today's stub ignores it.
// On timeout the loser promise is left to settle in the background;
// racing it here means Promise.race already attached a handler to it,
// so a late resolution/rejection can never surface as an unhandled
// rejection.
// ------------------------------------------------------------------
async function callMlProviderWithTimeout(input) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), mlTimeoutMs);
  try {
    return await Promise.race([
      Promise.resolve().then(() => mlImpl(input, { signal: controller.signal })),
      new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new MlTimeoutError(mlTimeoutMs)));
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------
// ESTIMATE — public entry point. ASYNC so a real (network-bound) ML
// provider can be awaited safely; always resolves a well-formed result
// and never rejects for provider reasons — an unavailable, erroring, or
// slow/hanging ML provider (bounded by ML_TIMEOUT_MS, see
// callMlProviderWithTimeout) falls back to baseline. Every provider
// result passes through validateCalorieResult() first — invalid output
// (e.g. a buggy model) is NEVER persisted raw: it falls back to the
// baseline estimate, truthfully labeled provider 'baseline'.
//
// `mlExerciseCanonical` (optional, second arg): a plain
// { exercise_id -> 'BENCH_PRESS' } map built by the caller via
// mlCanonicalExerciseId() from already-fetched exercise_library rows.
// Used ONLY to build the transient ml-provider input (toMlInput) —
// omitted or empty is a safe no-op, unaffecting baseline/mock/persistence.
//
// `db` (optional): a db-like handle (or `tx`) used ONLY to record ML
// monitoring telemetry (trackCalorieMlEvent above) — never read from,
// never required. `stage` labels which call site this is for that same
// telemetry ('completion' — an actually-persisted workout, the default;
// 'preview' — trainingProgram.js's unpersisted next-session estimate) so
// a dashboard can report on real completions without preview volume
// silently inflating the count.
// ------------------------------------------------------------------
export async function estimateWorkoutCalories(input = {}, { mlExerciseCanonical, db = null, stage = 'completion' } = {}) {
  const provider = resolveProvider();
  let result = null;
  let note = null;
  if (provider === 'mock') {
    result = mockEstimate();
  } else if (provider === 'ml') {
    let timedOut = false;
    try {
      const mlInput = toMlInput(input, mlExerciseCanonical);
      const r = await callMlProviderWithTimeout(mlInput);
      if (r) result = { ...toNetOfResting(r, input), provider: 'ml' };
    } catch (e) {
      // fall through — the API must never break on ML availability or latency
      timedOut = e instanceof MlTimeoutError;
    }
    if (!result) {
      const category = timedOut ? 'ml_timeout' : 'ml_unavailable';
      note = timedOut ? 'ml provider timed out — baseline fallback' : 'ml provider unavailable — baseline fallback';
      logCalorieFallback(category, { provider, workout_id: input?.session?.workout_id || null });
      await trackCalorieMlEvent(db, 'calorie_ml_fallback', { category, stage });
      result = baselineEstimate(input);
    }
  } else {
    result = baselineEstimate(input);
  }

  const check = validateCalorieResult(result);
  if (!check.ok) {
    note = `invalid ${provider} output — baseline fallback (${check.issues.join('; ')})`;
    logCalorieFallback('invalid_output', {
      provider,
      workout_id: input?.session?.workout_id || null,
      model_version: result?.model_version || null,
      issues: check.issues
    });
    if (provider === 'ml') await trackCalorieMlEvent(db, 'calorie_ml_fallback', { category: 'invalid_output', stage });
    return { ...baselineEstimate(input), note };
  }
  if (provider === 'ml' && check.result.provider === 'ml') {
    await trackCalorieMlEvent(db, 'calorie_ml_success', { hasNote: !!check.result.note, stage });
  }
  return { ...check.result, ...(note ? { note } : {}) };
}

// ------------------------------------------------------------------
// BASELINE provider — deterministic MET estimate (labeled, not ML).
//   gross kcal/min  = session MET × 3.5 × body_weight_kg ÷ 200
//   active kcal     = (gross kcal/min − this person's resting kcal/min)
//                     × active minutes
// "Active minutes" is the measured session time with pauses removed.
// When no duration was measured it is estimated from the completed sets
// (never claimed as measured).
//
// It used to report the GROSS figure as "active" -- resting energy
// included -- while energyBalance.js adds workouts on top of a full day
// of resting energy, treating them as energy ABOVE resting as the
// contract says. Every baseline-estimated session was therefore counting
// its own resting minutes twice in the member's surplus/deficit.
// ------------------------------------------------------------------
export function baselineEstimate(input = {}) {
  const bw = pos(input?.user?.body_weight_kg) || DEFAULT_BODY_WEIGHT_KG;
  const intensity = normalizeIntensity(input?.session?.intensity_rating);
  const met = INTENSITY_MET[intensity] ?? INTENSITY_MET.moderate;
  const durationMin = pos(input?.session?.duration_minutes) ?? estimateDurationMinutes(input);
  const grossPerMin = (met * 3.5 * bw) / 200;
  const rest = restingKcalPerMinute({ ...(input?.user || {}), body_weight_kg: bw });
  const active = (perMin) => Math.max(0, (perMin - rest.perMin) * durationMin);
  const restLabel = rest.source === 'mifflin_st_jeor' ? 'Mifflin-St Jeor' : 'standard 1 MET';
  return {
    schema_version: CALORIE_SCHEMA_VERSION,
    estimated_active_kcal: Math.round(active(grossPerMin)),
    lower_kcal: Math.round(active(grossPerMin * (1 - BASELINE_BAND))),
    upper_kcal: Math.round(active(grossPerMin * (1 + BASELINE_BAND))),
    model_version: BASELINE_MODEL_VERSION,
    provider: 'baseline',
    method: 'Compendium 2024 session MET (' + met + ') × 3.5 × kg ÷ 200 per minute, less resting energy ('
      + restLabel + '), × active minutes (baseline, not ML)'
  };
}

// ------------------------------------------------------------------
// MOCK provider — fixed demo values, clearly labeled. UI/test only.
// ------------------------------------------------------------------
function mockEstimate() {
  return {
    schema_version: CALORIE_SCHEMA_VERSION,
    estimated_active_kcal: 300,
    lower_kcal: 250,
    upper_kcal: 350,
    model_version: MOCK_MODEL_VERSION,
    provider: 'mock',
    note: 'mock provider — fixed demo values, not a real estimate'
  };
}

// ------------------------------------------------------------------
// ML provider — Sambhav's skos-cal-v1 model (mlModels/skosCalV1.js),
// wired in as of Phase 3B Step 3. skosCalV1Estimate is synchronous
// (a local JSON lookup table, no network call) but callMlProviderWithTimeout
// awaits it identically to a future async/network-bound model — the
// AbortSignal it receives is unused today (nothing to cancel) but kept
// in the call shape for forward compatibility with a v2 that might need
// it. Output is GROSS energy expenditure; converted to net-of-resting by
// toNetOfResting() before it ever reaches validateCalorieResult().
// ------------------------------------------------------------------

// Provider dispatch indirection + test hook (mirrors resetRateLimits() in
// rateLimit.js): lets tests inject a fake ML provider (sync or async,
// optionally honoring the AbortSignal) to exercise the invalid-output and
// timeout fallback paths end-to-end. Production code never calls this
// setter — resetting (no args / non-function) restores the real model,
// not a stub, since skos-cal-v1 is now the actual configured provider.
let mlImpl = skosCalV1Estimate;
export function __setMlEstimateForTests(fn) {
  mlImpl = typeof fn === 'function' ? fn : skosCalV1Estimate;
}

// ------------------------------------------------------------------
// Feature extraction — builds the structured INPUT contract (schema 0.2)
// from ACTUAL completed per-set data (exercise_set_logs). Planned workload
// from workout_exercises is NEVER used as actual calorie workload:
// skipped exercises contribute 0 sets / 0 reps / 0 volume.
//
// This function is the SINGLE feature-engineering choke point — routes and
// services pass raw data here and never compute calorie features themselves.
// ------------------------------------------------------------------
export function buildWorkoutCalorieInput({ client, workout, exercises = [], setsByExercise = {}, durationSeconds = null, bodyWeightKg = null, intensity = null } = {}) {
  const allSets = [];
  const agg = exercises.map((we) => {
    const lib = we.library || null;
    // ACTUAL completed sets only — incomplete/skipped sets are never features.
    // Keyed by the workout_exercises row id at completion, but by the
    // library exercise id where sets are re-read from workout_logs
    // (dailyIntelligence.js) -- accept either, or that path saw a session
    // with no completed sets at all.
    const rows = setsByExercise[we.id] || (we.exercise_id ? setsByExercise[we.exercise_id] : null) || [];
    const completed = rows.filter((s) => s.completed !== 0 && s.completed !== false);
    const sets = completed.map((s, i) => ({
      set_number: s.set_number ?? i + 1,
      reps: pos(s.actual_reps) ?? 0,
      weight_kg: pos(s.actual_weight) ?? 0,
      rir: s.rir ?? null,
      rest_seconds: s.rest_seconds ?? null,
      completed: 1
    }));
    for (const st of sets) allSets.push(st);
    const totalReps = sets.reduce((a, s) => a + s.reps, 0);
    const totalVolume = sets.reduce((a, s) => a + s.reps * s.weight_kg, 0);
    return {
      base: {
        exercise_id: we.exercise_id || we.name || null,
        exercise_type: lib?.ex_type || we.ex_type || 'compound',
        muscle_group: normalizeMuscleName(lib?.primary_muscle || we.primary_muscle || null),
        equipment: lib?.equipment || we.equipment || null,
        movement_pattern: lib?.movement || we.movement || null,
        compound_or_isolation: classifyCompound(lib?.ex_type || we.ex_type, lib?.movement || we.movement),
        completed_sets: sets
      },
      sets: sets.length,
      totalReps,
      totalVolume
    };
  });

  const performed = agg.filter((a) => a.sets > 0);          // skipped exercises (0 sets) are excluded from session workload
  const totalSets = performed.reduce((a, x) => a + x.sets, 0);
  const totalReps = performed.reduce((a, x) => a + x.totalReps, 0);
  const totalVolume = performed.reduce((a, x) => a + x.totalVolume, 0);
  const compoundSets = performed.reduce((a, x) => a + (x.base.compound_or_isolation === 'compound' ? x.sets : 0), 0);
  const isolationSets = performed.reduce((a, x) => a + (x.base.compound_or_isolation === 'isolation' ? x.sets : 0), 0);

  const durationMin = pos(durationSeconds) != null ? Math.round((durationSeconds / 60) * 10) / 10 : null;
  const bodyWeight = pos(bodyWeightKg);
  const avgLoad = totalReps > 0 ? totalVolume / totalReps : null;

  const mapped = agg.map((x) => ({
    ...x.base,
    // --- v0.2 per-exercise aggregates (actual completed sets only) ---
    sets: x.sets,
    total_reps: x.totalReps,
    total_volume_kg: round1(x.totalVolume),
    average_load_kg: x.totalReps > 0 ? round1(x.totalVolume / x.totalReps) : 0
  }));

  return {
    schema_version: CALORIE_SCHEMA_VERSION,
    user: {
      age_years: client?.age != null ? Number(client.age) : null,
      sex: client?.sex ? String(client.sex).toLowerCase() : null,
      height_cm: pos(client?.height_cm),
      body_weight_kg: bodyWeight
    },
    session: {
      workout_id: workout?.id || null,
      duration_seconds: pos(durationSeconds),
      duration_minutes: durationMin,
      // The member's own answer when there is one (asked once, after the
      // session -- see sessionEffort), RIR-inferred otherwise.
      intensity_rating: strictIntensity(intensity) || sessionEffort(workout) || inferIntensity(allSets),
      // --- v0.2 session aggregates ---
      exercise_count: performed.length,
      total_sets: totalSets,
      total_reps: totalReps,
      total_volume_kg: round1(totalVolume),
      // --- v0.2 derived features (null when the denominator is unknown — never fabricated) ---
      volume_per_minute: durationMin ? round2(totalVolume / durationMin) : null,
      sets_per_minute: durationMin ? round2(totalSets / durationMin) : null,
      reps_per_minute: durationMin ? round2(totalReps / durationMin) : null,
      relative_load: bodyWeight && avgLoad != null ? round2(avgLoad / bodyWeight) : null,
      compound_set_ratio: totalSets > 0 ? round2(compoundSets / totalSets) : null,
      isolation_set_ratio: totalSets > 0 ? round2(isolationSets / totalSets) : null
    },
    exercises: mapped
  };
}

// Total completed sets across the input (skipped exercises contribute 0).
export function completedSetCount(input) {
  return (input?.exercises || []).reduce((n, e) => n + (e.completed_sets || []).length, 0);
}

// Estimate duration from completed sets when no measured duration exists.
// Reuses the same per-set math as the old session preview so behavior is
// consistent. The result is an ESTIMATE, never presented as measured.
export function estimateDurationMinutes(input = {}) {
  const sets = (input?.exercises || []).flatMap((e) => e.completed_sets || []);
  if (!sets.length) return 30;
  const rests = sets.map((s) => pos(s.rest_seconds)).filter(Number.isFinite);
  const avgRest = rests.length ? rests.reduce((a, b) => a + b, 0) / rests.length : 90;
  return Math.max(15, Math.round(sets.length * (1.6 + avgRest / 60)));
}

// ------------------------------------------------------------------
// Body weight at workout time (Phase 11).
//   Preference order (documented in docs/TEAM-CONTRACT.md):
//     1. nearest weight_logs entry at/before the workout day
//     2. clients.current_weight
//     3. clients.start_weight
//     4. clients.target_weight
//   Returns null when nothing is available — callers may pass the
//   service's DEFAULT_BODY_WEIGHT_KG at estimation time.
// ------------------------------------------------------------------
export async function resolveBodyWeight(db, clientId, workoutDate) {
  const d = workoutDate || dayKey();
  const log = await db.q1(
    `SELECT weight FROM weight_logs WHERE client_id = ? AND date <= ? ORDER BY date DESC, created_at DESC LIMIT 1`,
    [clientId, d]);
  if (log?.weight) return Number(log.weight);
  const c = await db.q1('SELECT current_weight, start_weight, target_weight FROM clients WHERE id = ?', [clientId]);
  if (!c) return null;
  return c.current_weight || c.start_weight || c.target_weight || null;
}

// Persist a calorie result onto the workout row (backend-only writer).
export async function persistCalorieResult(db, workoutId, result) {
  await db.run(
    `UPDATE workouts SET
       estimated_active_kcal = ?, lower_kcal = ?, upper_kcal = ?,
       model_version = ?, schema_version = ?, calorie_provider = ?, calorie_estimated_at = ?
     WHERE id = ?`,
    [result?.estimated_active_kcal ?? null, result?.lower_kcal ?? null, result?.upper_kcal ?? null,
     result?.model_version ?? null, result?.schema_version ?? null, result?.provider ?? null,
     new Date().toISOString(), workoutId]);
}

/**
 * The effort a member reported for a finished session ('light' | 'moderate'
 * | 'hard'), or null. Kept in the session's progress blob beside
 * __paused_ms rather than a new column, so recording it needs no schema
 * migration; every later re-estimate (wearable reconciliation included)
 * reads it from here and agrees with the figure the member was shown.
 */
export function sessionEffort(workout) {
  const raw = workout?.progress_json;
  if (!raw) return null;
  try {
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return strictIntensity(p?.__effort);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------
function strictIntensity(rating) {
  return ['light', 'moderate', 'hard'].includes(rating) ? rating : null;
}

function normalizeIntensity(rating) {
  const r = String(rating || '').toLowerCase();
  if (['light', 'easy', 'low'].includes(r)) return 'light';
  if (['hard', 'vigorous', 'high', 'intense'].includes(r)) return 'hard';
  return 'moderate';
}

// Derive an intensity rating from actual set RIRs (RIR 0-1 ≈ hard,
// 2-3 ≈ moderate, 4+ ≈ light). No RIR data → moderate.
function inferIntensity(sets) {
  const rirs = sets.map((s) => pos(s.rir)).filter(Number.isFinite);
  if (!rirs.length) return 'moderate';
  const avg = rirs.reduce((a, b) => a + b, 0) / rirs.length;
  if (avg <= 1) return 'hard';
  if (avg <= 3) return 'moderate';
  return 'light';
}

// Normalize a legacy muscle string (e.g. "CHEST" / "UPPER CHEST") to a
// canonical lowercase id. Kept local to avoid a muscles.js import cycle;
// mirrors the ALIASES table in services/muscles.js.
function normalizeMuscleName(name) {
  if (!name) return null;
  const n = String(name).toUpperCase().trim();
  const MAP = {
    'CHEST': 'chest', 'UPPER CHEST': 'upper_chest', 'SHOULDERS': 'shoulders',
    'SIDE DELTS': 'side_delts', 'REAR DELTS': 'rear_delts', 'DELTS': 'shoulders',
    'TRICEPS': 'triceps', 'BICEPS': 'biceps', 'FOREARMS': 'forearms',
    'TRAPS': 'traps', 'LATS': 'lats', 'UPPER BACK': 'upper_back',
    'LOWER BACK': 'lower_back', 'GLUTES': 'glutes', 'HAMSTRINGS': 'hamstrings',
    'QUADS': 'quads', 'CALVES': 'calves', 'CORE': 'core', 'ABS': 'abs',
    'ABDOMINALS': 'core', 'POSTERIOR CHAIN': 'posterior_chain', 'FRONT DELTS': 'shoulders'
  };
  return MAP[n] || n.toLowerCase() || null;
}

// compound vs isolation — from ex_type when explicit, else inferred
// from the movement pattern.
function classifyCompound(exType, movement) {
  if (exType === 'isolation') return 'isolation';
  if (exType === 'compound') return 'compound';
  const m = String(movement || '');
  if (m && !['isolation', 'carry', 'core'].includes(m)) return 'compound';
  return 'isolation';
}
