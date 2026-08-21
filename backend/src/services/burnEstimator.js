// ============================================================
// WORKOUT CALORIE BURN — backed by skos-cal-v1.
//
// WHY THIS FILE IS NEW: the backend had NO calorie-burn estimation at all.
// Grepping for burn/MET/calorie-burn across backend/src returned nothing.
// A resistance-training app that tracks food intake but never estimates
// expenditure can only ever show half the energy balance.
//
// ── WHAT THE MODEL WILL AND WILL NOT TELL YOU ─────────────────────────
// skos-cal-v1 returns an estimate AND an interval (lower_kcal /
// upper_kcal), and the interval is wide on purpose: for a 40 min session
// at 87 kg it is roughly 89-426 kcal around a 275 kcal point estimate.
// That width is the honest uncertainty of predicting resistance-training
// expenditure from set/rep logs, and it is NOT a defect to be hidden.
// This service therefore always passes the interval through, and the UI
// is expected to show a range rather than a bare number.
//
// It also returns `notes` describing every assumption it had to make
// (defaulted intensity, body weight outside the trained range, exercises
// it does not know). Those are surfaced, not swallowed — an estimate the
// model itself has flagged as shaky must not be presented as a clean
// figure.
//
// ── WHAT IT DOES NOT COVER ────────────────────────────────────────────
// `estimated_active_kcal` is ACTIVE energy for the logged session. It is
// not TDEE, not BMR, and must never be added to a maintenance figure as
// though it were a separate meal. The model card is explicit that the
// gross-vs-net-of-resting question is unresolved, so this service does
// not attempt arithmetic that depends on the answer.
// ============================================================
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ML = path.resolve(HERE, '..', '..', '..', 'ml');

let _mlEstimate = null;
let _knownIds = null;
let _unavailable = false;

/**
 * The exercise ids the model was actually trained on, read FROM the model
 * file rather than hardcoded here, so this cannot drift out of sync when
 * skos-cal-v1 is retrained with more exercises.
 */
function knownExerciseIds() {
  if (_knownIds) return _knownIds;
  try {
    const model = require(path.join(ML, 'models', 'skos-cal-v1', 'model_v1.json'));
    _knownIds = new Set(Object.keys(model.correction_kcal_per_min_by_exercise_and_tier || {}));
  } catch {
    _knownIds = new Set();
  }
  return _knownIds;
}

/**
 * Map a free-text exercise name onto a trained exercise id.
 *
 * FOUND BY TESTING, NOT BY READING: the model matches on
 * `exercise.exercise_id`, not on a name field. Passing "bench press" left
 * every exercise unmapped, so the model reported "~100% of this session's
 * workload is outside the trained set" and fell back to baseline-only.
 * The giveaway was that a full 3-exercise session and an EMPTY session
 * returned the identical 477 kcal — the exercise correction was
 * contributing exactly nothing.
 *
 * Deliberately conservative. Returning null (unmapped) is a GOOD outcome:
 * the model flags it and widens its interval honestly. Guessing that
 * "chest fly" is close enough to BENCH_PRESS would silently apply the
 * wrong correction with no flag at all, which is strictly worse.
 */
export function toExerciseId(rawName) {
  const known = knownExerciseIds();
  if (!rawName) return null;
  const upper = String(rawName).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (known.has(upper)) return upper;

  const t = ` ${String(rawName).toLowerCase()} `;
  const has = (...words) => words.every((w) => t.includes(w));

  // Order matters: the more specific variant must win over its base lift.
  const candidates = [
    ['INCLINE_BENCH_PRESS', () => has('incline') && has('bench')],
    ['BENCH_PRESS', () => has('bench') && !has('incline') && !has('decline')],
    ['BARBELL_SQUAT', () => has('squat') && !has('split') && !has('bulgarian') && !has('hack')],
    ['LEG_PRESS', () => has('leg', 'press')],
    ['LEG_EXTENSION', () => has('leg', 'extension') || has('quad', 'extension')],
    ['LAT_PULLDOWN', () => has('lat') && has('pulldown') || has('lat', 'pull', 'down')],
    ['BICEP_CURL', () => (has('bicep') || has('biceps')) && has('curl')],
    ['TRICEPS_EXTENSION', () => (has('tricep') || has('triceps')) && has('extension')],
  ];
  for (const [id, test] of candidates) {
    if (known.has(id) && test()) return id;
  }
  return null;
}

function loadModel() {
  if (_mlEstimate || _unavailable) return _mlEstimate;
  try {
    // eslint-disable-next-line global-require
    ({ mlEstimate: _mlEstimate } = require(
      path.join(ML, 'models', 'skos-cal-v1', 'mlEstimate.reference.js')
    ));
  } catch {
    _unavailable = true;
    _mlEstimate = null;
  }
  return _mlEstimate;
}

export function burnModelAvailable() {
  return loadModel() !== null;
}

/**
 * Sum load volume for one exercise's sets. The model weights each
 * exercise's share of the session by volume, so this has to be real
 * kg-reps rather than a set count.
 */
function volumeOf(sets) {
  return (sets || []).reduce(
    (s, x) => s + (Number(x.actual_weight ?? x.weight) || 0) * (Number(x.actual_reps ?? x.reps) || 0),
    0
  );
}

/**
 * Shape our workout log into the model's input contract.
 *
 * Note the `completed_sets` filter in the model: it ignores exercises with
 * no completed sets, and reports a session with none as baseline-only. So
 * a set must be marked completed to count — passing prescribed-but-unlogged
 * sets would inflate the estimate with work nobody did.
 */
export function buildBurnInput({ bodyWeightKg, durationMinutes, intensity, exercises }) {
  return {
    user: { body_weight_kg: bodyWeightKg },
    session: {
      duration_minutes: durationMinutes,
      // The model accepts light/moderate/hard and FLAGS anything else
      // rather than silently absorbing it, so passing undefined here is
      // safe and produces a visible note.
      intensity_rating: intensity,
    },
    exercises: (exercises || []).map((e) => {
      const sets = (e.sets || []).filter((s) => s.completed !== 0 && s.completed !== false);
      return {
        name: e.name,
        // The field the model actually keys on. null when we cannot map the
        // name confidently -- the model then flags it rather than applying
        // a wrong correction.
        exercise_id: e.exercise_id || toExerciseId(e.name),
        total_volume_kg: volumeOf(sets),
        completed_sets: sets.map((s) => ({
          reps: Number(s.actual_reps ?? s.reps) || 0,
          weight_kg: Number(s.actual_weight ?? s.weight) || 0,
        })),
      };
    }),
  };
}

/**
 * Estimate burn for a session.
 *
 * Returns null — not a fabricated number — when the model refuses or the
 * inputs it hard-requires are missing. skos-cal-v1 THROWS without a body
 * weight and duration, and that refusal is a feature: guessing a body
 * weight would produce a confident figure with no basis. The caller
 * renders "add your weight to see calories burned", which is true and
 * actionable.
 */
export function estimateBurn({ bodyWeightKg, durationMinutes, intensity, exercises }) {
  const model = loadModel();
  if (!model) return null;
  if (!(Number(bodyWeightKg) > 0) || !(Number(durationMinutes) > 0)) return null;

  try {
    const out = model(buildBurnInput({ bodyWeightKg, durationMinutes, intensity, exercises }));
    const notes = out.note ? String(out.note).split(' | ').filter(Boolean) : [];
    return {
      schema_version: out.schema_version,
      model_version: out.model_version,
      kcal: out.estimated_active_kcal,
      lower_kcal: out.lower_kcal,
      upper_kcal: out.upper_kcal,
      // Surfaced so the UI can show a range and a caveat rather than
      // implying a precision the model does not claim.
      notes,
      // A cheap honesty signal for the UI: how wide the interval is
      // relative to the estimate. Above ~1.0 the range is wider than the
      // number itself and should be presented as "roughly", not a figure.
      uncertainty_ratio: out.estimated_active_kcal > 0
        ? Math.round(((out.upper_kcal - out.lower_kcal) / out.estimated_active_kcal) * 100) / 100
        : null,
    };
  } catch {
    // The model refuses out-of-scope sessions by throwing. That is a
    // legitimate answer, not an error to log noisily.
    return null;
  }
}
