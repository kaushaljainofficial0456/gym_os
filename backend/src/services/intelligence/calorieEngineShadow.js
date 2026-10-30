// ============================================================
// SESSION CALORIE ENGINE — HIDDEN MODE (docs/CALORIE_ENGINE_PROPOSAL.md §3)
//
// What this is: the input side of the exercise-aware engine, run on every
// completed session and LOGGED (workouts.calorie_features_json). It is
// never displayed, never persisted as an estimate, and never read by
// calorieModel.js, which remains the only source of a calorie figure.
//
// What this is NOT: an estimator. The engine's components need
// coefficients -- exercise-specific cost per unit work, recovery cost per
// second of rest, person effects -- that do not exist until they are
// fitted to criterion (laboratory) data. There are none, so every
// component reports status 'not_fitted' and the engine returns no number.
// No coefficient, multiplier or default rate is set by hand here; adding
// one requires fitted values that passed docs/CALORIE_MODEL_RESEARCH_PLAN.md.
//
// Why log it now: so that (a) the lab pilot's sessions carry exactly the
// features the engine will use, computed by the same code, and (b) the
// distribution of real members' sessions (density, rest, composition,
// completeness) is known before the engine is fitted.
// ============================================================

export const ENGINE_VERSION = 'skos-cal-engine-shadow-v0';
export const FEATURES_VERSION = 1;

// Components of the proposed engine and the inputs each needs. `fitted`
// stays false until criterion-fitted parameters exist.
export const ENGINE_COMPONENTS = Object.freeze([
  { name: 'person', inputs: ['body_mass_kg', 'height_cm', 'age_years', 'sex'], fitted: false },
  { name: 'exercise_work', inputs: ['exercise_classes', 'reps', 'external_load'], fitted: false },
  { name: 'recovery_between_sets', inputs: ['actual_rest_seconds'], fitted: false },
  { name: 'effort', inputs: ['reported_rir'], fitted: false },
  { name: 'heart_rate', inputs: ['validated_hr_device'], fitted: false },
  { name: 'individual_calibration', inputs: ['personal_criterion_measurement'], fitted: false },
]);

const share = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null);
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

function stats(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, total: null, mean: null, median: null, p90: null };
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1) + 0.5))];
  const total = v.reduce((a, b) => a + b, 0);
  return { n: v.length, total: round1(total), mean: round1(total / v.length), median: round1(q(0.5)), p90: round1(q(0.9)) };
}

function countBy(sets, keyFn) {
  const out = {};
  for (const s of sets) {
    const k = keyFn(s) || 'unknown';
    out[k] = (out[k] || 0) + 1;
  }
  for (const k of Object.keys(out)) out[k] = share(out[k], sets.length);
  return out;
}

/**
 * @param sets  completed sets: { reps, load_kg, set_started_at, set_completed_at,
 *              actual_rest_seconds, tick_interval_seconds, reported_rir,
 *              movement, primary_muscle, ex_type, equipment }
 * @param ctx   { activeMinutes, bodyMassKg, profile: {height_cm, age_years, sex},
 *              profileGaps: [], timing: analyzeSessionTiming(...).session }
 */
export function buildSessionFeatures(sets, ctx = {}) {
  const n = sets.length;
  const work = sets
    .filter((s) => s.set_started_at && s.set_completed_at)
    .map((s) => (Date.parse(s.set_completed_at) - Date.parse(s.set_started_at)) / 1000);
  const reps = sets.reduce((t, s) => t + (Number(s.reps) || 0), 0);
  const volume = sets.reduce((t, s) => t + (Number(s.reps) || 0) * (Number(s.load_kg) || 0), 0);
  const bodyweightReps = sets
    .filter((s) => String(s.equipment || '').toLowerCase() === 'bodyweight' || !(Number(s.load_kg) > 0))
    .reduce((t, s) => t + (Number(s.reps) || 0), 0);
  const rir = sets.map((s) => s.reported_rir).filter((x) => x != null && Number.isFinite(Number(x))).map(Number);
  const active = Number(ctx.activeMinutes) > 0 ? Number(ctx.activeMinutes) : null;
  return {
    version: FEATURES_VERSION,
    completeness: {
      sets: n,
      sets_with_completion_time: sets.filter((s) => s.set_completed_at).length,
      sets_with_start_time: work.length,
      sets_with_actual_rest: sets.filter((s) => s.actual_rest_seconds != null).length,
      sets_with_reported_rir: rir.length,
      sets_with_exercise_class: sets.filter((s) => s.movement || s.primary_muscle).length,
      profile_gaps: ctx.profileGaps || [],
      timing_flags: ctx.timing?.flags || [],
    },
    person: {
      body_mass_kg: ctx.bodyMassKg ?? null,
      height_cm: ctx.profile?.height_cm ?? null,
      age_years: ctx.profile?.age_years ?? null,
      sex: ctx.profile?.sex ?? null,
    },
    time: {
      active_minutes: active,
      paused_seconds: ctx.timing?.paused_seconds ?? null,
      set_seconds_measured: stats(work),
      actual_rest_seconds: stats(sets.map((s) => s.actual_rest_seconds)),
      tick_interval_seconds: stats(sets.map((s) => s.tick_interval_seconds)),
      sets_per_active_minute: active ? round1((n / active) * 100) / 100 : null,
    },
    composition: {
      by_movement: countBy(sets, (s) => s.movement),
      by_primary_muscle: countBy(sets, (s) => s.primary_muscle),
      by_ex_type: countBy(sets, (s) => s.ex_type),
    },
    load: {
      reps,
      external_volume_kg: round1(volume),
      external_volume_per_kg_body_mass: ctx.bodyMassKg > 0 ? Math.round((volume / ctx.bodyMassKg) * 100) / 100 : null,
      bodyweight_or_unloaded_reps: bodyweightReps,
    },
    effort: { reported_rir: stats(rir) },
  };
}

/** The engine's hidden-mode run: which components could run on these
 *  inputs, and the fact that none can produce a number yet. */
export function runShadowEngine(features) {
  const has = {
    body_mass_kg: features.person.body_mass_kg != null,
    height_cm: features.person.height_cm != null,
    age_years: features.person.age_years != null,
    sex: features.person.sex != null,
    exercise_classes: features.completeness.sets_with_exercise_class > 0,
    reps: features.load.reps > 0,
    external_load: features.load.external_volume_kg != null,
    actual_rest_seconds: features.completeness.sets_with_actual_rest > 0,
    reported_rir: features.completeness.sets_with_reported_rir > 0,
    validated_hr_device: false,
    personal_criterion_measurement: false,
  };
  return {
    engine_version: ENGINE_VERSION,
    status: 'not_fitted',
    estimate_kcal: null,
    components: ENGINE_COMPONENTS.map((c) => ({
      name: c.name,
      fitted: c.fitted,
      missing_inputs: c.inputs.filter((i) => !has[i]),
    })),
  };
}

/**
 * What in the member's profile is missing or stale for the calorie
 * estimate's own inputs -- the production formula already uses these, so
 * filling them in makes its existing inputs truer without changing the
 * formula. The 28-day staleness window is a prompting choice, not
 * physiology.
 */
export const STALE_WEIGHT_DAYS = 28;
export function calorieProfileGaps({ client = {}, latestWeightLogDate = null, workoutDate = null } = {}) {
  const gaps = [];
  if (!(Number(client.height_cm) > 0)) gaps.push('height');
  if (!(Number(client.age) > 0)) gaps.push('age');
  // Same codes restingEnergy.js's Mifflin-St Jeor accepts; anything else
  // falls back to the midpoint constant there, so it is worth asking.
  if (!['MALE', 'M', 'FEMALE', 'F'].includes(String(client.sex || '').toUpperCase())) gaps.push('sex');
  if (latestWeightLogDate) {
    const days = (Date.parse(`${workoutDate || new Date().toISOString().slice(0, 10)}T00:00:00Z`) - Date.parse(`${latestWeightLogDate}T00:00:00Z`)) / 86400000;
    if (days > STALE_WEIGHT_DAYS) gaps.push('weight_stale');
  } else if (Number(client.current_weight) > 0 || Number(client.start_weight) > 0 || Number(client.target_weight) > 0) {
    gaps.push('weight_not_logged');
  } else {
    gaps.push('weight_missing');
  }
  return gaps;
}
