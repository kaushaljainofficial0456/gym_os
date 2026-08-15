// ============================================================
// skos-cal-v1 — ESM PORT of the `ml` provider reference implementation.
// Mechanically ported from origin/ml-sambhav @ e9147e4
// (ml/models/skos-cal-v1/mlEstimate.reference.js) — CommonJS require()/
// module.exports converted to ESM import/export ONLY. No calculation
// logic was changed; every fitted number in skosCalV1.model.json
// (correction_kcal_per_min_by_exercise_and_tier, interval_offsets_kcal_per_min)
// is BYTE-FOR-BYTE identical to Sambhav's shipped artifact — see
// skosCalV1.model.json (copied verbatim via `git show origin/ml-sambhav`).
//
// This file computes GROSS workout-period energy expenditure exactly as
// Sambhav's model defines it. The backend's v0.2 contract defines
// estimated_active_kcal as energy ABOVE resting
// (docs/calorie-model-contract.md §3) — the gross->net-of-resting
// conversion happens ONE LAYER UP, in calorieModel.js's
// estimateWorkoutCalories() (toNetOfResting()), so this file stays a
// clean, auditable, minimally-diffed port of Sambhav's original logic.
// Exercise-id canonicalization (opaque backend id -> BENCH_PRESS etc.)
// also happens one layer up (calorieModel.js's toMlInput()) — this file
// is never given SK OS's opaque ids directly in production; the input it
// receives already has canonical tokens substituted where safely known.
//
// IMPORTANT SCOPE CAVEAT — read before wiring this in for real users:
//   - Validated on 14 participants, 100% male, ~20-35yo, ISOLATED
//     single-exercise lab bouts (see Sambhav's MODEL_CARD.md). NOT yet
//     validated on real multi-exercise SK OS sessions or on women/other
//     ages.
//   - The per-exercise correction below was learned for a single
//     continuous exercise. Extending it to a multi-exercise SESSION
//     (below) via volume-weighting is a REASONABLE BUT NOT INDEPENDENTLY
//     VALIDATED extrapolation — flagged explicitly, not hidden.
//   - Per Sambhav's own V1_PRE_INTEGRATION_AUDIT.md: NOT production-ready
//     (10 CRITICAL findings). Dev/staging only — see backend/docs and
//     config.js's provider gating.
//
// ---- 2026-08-16: revised per V1_PRE_INTEGRATION_AUDIT.md (Sambhav) ----
// This revision fixes the runtime CALCULATION-LOGIC and FLAGGING gaps
// found in the audit. It does NOT retrain anything — every fitted number
// in skosCalV1.model.json is unchanged; proof in Sambhav's
// docs/_v1_audit_fix_diff.txt (origin/ml-sambhav). What changed there
// (preserved unchanged by this port) is how those numbers get COMBINED
// and FLAGGED at inference time:
//   1. Baseline+correction rate is capped at a documented physiological
//      plausibility ceiling (audit #3/#4/#5/#6) — a safety net, not a
//      scientific fix; the real fix needs real multi-set session data.
//   2. Unrecognized intensity_rating values are flagged, never silently
//      absorbed into "moderate" (audit #8a).
//   3. A known exercise logged with zero volume (e.g. a bodyweight
//      variant) no longer gets silently zero-weighted out of the
//      correction blend (audit #16).
//   4. Interval widening now scales proportionally to how much of the
//      session's workload is unmapped, instead of only firing when
//      EVERY exercise is unknown (audit #18).
//   5. Sessions whose body weight or duration land well outside what the
//      training data could actually inform are flagged (audit #13, #9).
//   6. An empty (zero-completed-exercise) session still returns an
//      estimate for API-shape consistency, but is explicitly flagged
//      rather than presented as an ordinary exercise estimate (audit #17).
// ============================================================

import MODEL from './skosCalV1.model.json' with { type: 'json' };

const DEFAULT_TARGET_COVERAGE = '90'; // matches the 90% jackknife+ interval in skosCalV1.model.json
const SUPPORTED_INTENSITY_TIERS = ['light', 'moderate', 'hard'];
const FLAG_WIDEN_FACTOR = MODEL.unmapped_exercise_fallback.widen_interval_factor; // reuse the one already-documented widen factor rather than invent new ones

/**
 * @param {object} input - the exact calorie-model-contract.md v0.2 shape
 *   (with exercise_id already canonicalized where safely known, applied
 *   one layer up by calorieModel.js — never assumed here)
 * @returns {{schema_version:string, estimated_active_kcal:number, lower_kcal:number, upper_kcal:number, model_version:string, note?:string}}
 *   GROSS energy expenditure — the caller converts to net-of-resting.
 * @throws when required fields are missing — the CALLER (calorieModel.js
 *   estimateWorkoutCalories) already catches this and falls back to the
 *   baseline provider, per the existing provider architecture. This
 *   function deliberately does NOT guess a body weight or duration itself.
 */
export function mlEstimate(input) {
  const bw = numOrNull(input?.user?.body_weight_kg);
  const durationMin = numOrNull(input?.session?.duration_minutes);
  if (!bw || !durationMin) {
    throw new Error('skos-cal-v1 requires body_weight_kg and duration_minutes — falling back to baseline');
  }

  const notes = [];

  const { tier, wasDefaulted } = normalizeTier(input?.session?.intensity_rating);
  if (wasDefaulted) {
    notes.push(`unrecognized intensity_rating (expected one of ${SUPPORTED_INTENSITY_TIERS.join('/')}) — defaulted to "moderate"`);
  }

  const met = MODEL.baseline.met_by_tier[tier];
  const baselineRate = (met * 3.5 * bw) / 200; // kcal/min, same formula as the deployed baseline

  // Body-weight validity flag (audit #13) — the correction terms can't
  // reflect real body-weight scaling at all (source data used one constant
  // cohort weight for every participant); flag when this user is well
  // outside the range that constant was even a reasonable stand-in for.
  const bwValidity = MODEL.body_weight_validity;
  const bwOutOfRange = bwValidity && (bw < bwValidity.flag_below_kg || bw > bwValidity.flag_above_kg);
  if (bwOutOfRange) {
    notes.push(`body_weight_kg (${bw}) is outside the training data's plausible range [${bwValidity.flag_below_kg}, ${bwValidity.flag_above_kg}] — correction terms do not scale with body weight (see skosCalV1.model.json body_weight_validity)`);
  }

  const exercises = (input?.exercises || []).filter((e) => (e.completed_sets || []).length > 0);

  if (exercises.length === 0) {
    // Empty session (audit #17): still return a shape-consistent estimate
    // (baseline only, no correction) rather than throwing — but flag it
    // explicitly so downstream consumers can choose to suppress/caveat it,
    // instead of presenting a confident number for zero logged work.
    notes.push('no completed exercises in this session — estimate reflects baseline-only activity for the logged duration, not exercise-specific correction');
  }

  const { weights, basis } = computeWeights(exercises);

  let correctionRate = 0; // kcal/min, weighted average across exercises in this session
  let anyKnownExercise = false;
  let unknownWeightShare = 0;
  const table = MODEL.correction_kcal_per_min_by_exercise_and_tier;

  for (const { exercise, weight } of weights) {
    const lookup = table[exercise.exercise_id];
    if (lookup) {
      anyKnownExercise = true;
      correctionRate += weight * lookup[tier];
    } else {
      unknownWeightShare += weight;
    }
  }
  const anyUnknownExercise = unknownWeightShare > 0;
  if (anyUnknownExercise) {
    const pct = Math.round(unknownWeightShare * 100);
    notes.push(`~${pct}% of this session's workload is exercises outside the trained set — correction applied only to known exercises (weighting basis: ${basis})`);
  }

  // Duration-extrapolation flag (audit #3/#4/#5/#9): the correction was fit
  // on short continuous bouts (skosCalV1.model.json.source_measured_bout_duration_minutes),
  // never on anything resembling a full multi-set session. Flag whenever the
  // logged duration exceeds what was actually measured for this tier.
  const maxSourceBoutMin = MODEL.source_measured_bout_duration_minutes?.[tier];
  const exceedsSourceBout = anyKnownExercise && maxSourceBoutMin != null && durationMin > maxSourceBoutMin;
  if (exceedsSourceBout) {
    notes.push(`session duration (${durationMin}min) exceeds the longest continuous bout this tier was ever measured on (${maxSourceBoutMin}min) — rate is extrapolated, not directly validated for this duration`);
  }

  const rawActiveRate = Math.max(0, baselineRate + correctionRate); // never negative

  // Plausibility guardrail (audit #3/#4/#5/#6): cap the rate at a
  // documented physiological ceiling. This is a safety net against
  // extrapolation blowups (e.g. uncapped BARBELL_SQUAT/hard ≈ 36 kcal/min
  // at cohort-mean body weight) — it does not make the rate scientifically
  // accurate for long durations, it prevents an impossible number from
  // ever reaching a user.
  const cap = MODEL.plausibility_guardrails?.max_active_rate_kcal_min;
  const wasCapped = cap != null && rawActiveRate > cap;
  const activeRate = wasCapped ? cap : rawActiveRate;
  if (wasCapped) {
    notes.push(`estimated rate (${rawActiveRate.toFixed(1)} kcal/min) exceeded the plausibility cap (${cap} kcal/min) and was capped — treat this estimate as low-confidence, see skosCalV1.model.json plausibility_guardrails`);
  }

  const estimated = activeRate * durationMin;

  // Interval widening: proportional to how much of the session is
  // unmapped-exercise workload (audit #18 — previously all-or-nothing),
  // plus a flat widen whenever any other red flag above fired. Reuses the
  // single already-documented widen factor rather than inventing new,
  // unvalidated numbers for each flag.
  const proportionalUnknownWiden = 1 + (FLAG_WIDEN_FACTOR - 1) * unknownWeightShare;
  const anyOtherFlag = wasDefaulted || bwOutOfRange || exceedsSourceBout || wasCapped || exercises.length === 0;
  const widen = Math.max(proportionalUnknownWiden, anyOtherFlag ? FLAG_WIDEN_FACTOR : 1.0);

  const iv = MODEL.interval_offsets_kcal_per_min[DEFAULT_TARGET_COVERAGE];
  const lower = Math.max(0, estimated + iv.lo_offset_kcal_min * durationMin * widen);
  const upper = estimated + iv.hi_offset_kcal_min * durationMin * widen;

  const out = {
    schema_version: MODEL.schema_version,
    estimated_active_kcal: Math.round(estimated),
    lower_kcal: Math.round(lower),
    upper_kcal: Math.round(upper),
    model_version: MODEL.model_version,
  };
  if (notes.length > 0) {
    out.note = notes.join(' | ');
  }
  return out;
}

/**
 * Weight each completed exercise's share of the session for blending
 * per-minute corrections. Fix for audit #16: previously, a KNOWN exercise
 * logged with total_volume_kg=0 (e.g. a bodyweight variant) inside an
 * otherwise-loaded session got silently weight=0 (its volume share of a
 * nonzero session total is 0/total=0), dropping its trained correction
 * entirely. Now: if EVERY completed exercise has usable load-volume, weight
 * by volume share (unchanged from before for the common case). If ANY
 * exercise lacks a usable volume figure, the WHOLE session falls back to
 * set-count weighting — a single consistent basis, so weights still sum to
 * 1, and no known exercise vanishes just because its own volume was 0.
 */
function computeWeights(exercises) {
  if (exercises.length === 0) return { weights: [], basis: 'none' };
  const totalVolume = exercises.reduce((s, e) => s + (e.total_volume_kg || 0), 0);
  const everyExerciseHasVolume = exercises.every((e) => (e.total_volume_kg || 0) > 0);
  const useVolumeBasis = totalVolume > 0 && everyExerciseHasVolume;

  if (useVolumeBasis) {
    return {
      basis: 'volume',
      weights: exercises.map((exercise) => ({ exercise, weight: (exercise.total_volume_kg || 0) / totalVolume })),
    };
  }
  const totalSets = exercises.reduce((s, e) => s + (e.sets || 0), 0);
  return {
    basis: 'sets',
    weights: exercises.map((exercise) => ({ exercise, weight: (exercise.sets || 0) / (totalSets || 1) })),
  };
}

function normalizeTier(rating) {
  const r = String(rating || '').toLowerCase().trim();
  if (SUPPORTED_INTENSITY_TIERS.includes(r)) {
    return { tier: r, wasDefaulted: false };
  }
  return { tier: 'moderate', wasDefaulted: true };
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
