// ============================================================
// What a calorie figure IS and how far to trust it -- attached to every
// calorie object the API returns, so the workout page never has to guess.
//
// Read-only: it never changes a number. The estimate itself still comes
// only from calorieModel.js's estimateWorkoutCalories.
//
//   basis        'model_estimate' -- BARBELL's model. Nothing in the app
//                measures energy; a wearable's figure is its own estimate
//                and is reported separately (docs/WEARABLE_RECONCILIATION_
//                DECISION.md).
//   reliability  'low' (baseline) | 'very_low' (skos-cal-v1, which failed
//                every whole-session check) | 'demo' (mock).
//                There is no 'high' yet: no BARBELL estimate has been
//                validated against measured energy for full gym sessions
//                (docs/CALORIE_OVERHAUL_REPORT.md). A level is earned by
//                passing the research protocol's gates, not assigned.
//   reasons      [{ code, text }] -- short, user-presentable.
// ============================================================

const REASONS = Object.freeze({
  not_validated: 'Not yet checked against measured energy for full gym sessions.',
  range_not_calibrated: 'The range is a ±25% band around the estimate, not a measured margin of error.',
  hard_may_overestimate: 'Heavy sessions with long rests measured lower than this in published studies, so this may run high.',
  ml_unvalidated: 'This experimental model was built from short single-exercise tests and did worse than the standard estimate on full sessions.',
  duration_estimated: 'Session length was estimated from your sets, not timed.',
  planned_not_performed: 'Based on the planned session, before it was done.',
  demo_values: 'Demo values, not an estimate.',
});

const reason = (code) => ({ code, text: REASONS[code] });

/**
 * @param {object} calorie  an estimateWorkoutCalories result or persisted view
 * @param {object} ctx      { intensity, durationMeasured, preview }
 * @returns the same object plus basis / reliability / reliability_reasons,
 *          or null for null.
 */
export function qualifyCalorie(calorie, { intensity = null, durationMeasured = true, preview = false } = {}) {
  if (!calorie) return calorie ?? null;
  const reasons = [];
  let reliability = 'low';
  if (calorie.provider === 'mock') {
    reliability = 'demo';
    reasons.push(reason('demo_values'));
  } else {
    if (calorie.provider === 'ml') {
      reliability = 'very_low';
      reasons.push(reason('ml_unvalidated'));
    }
    reasons.push(reason('not_validated'));
    if (calorie.provider === 'baseline') reasons.push(reason('range_not_calibrated'));
    if (intensity === 'hard') reasons.push(reason('hard_may_overestimate'));
    if (!durationMeasured) reasons.push(reason('duration_estimated'));
    if (preview || calorie.source === 'preview') reasons.push(reason('planned_not_performed'));
  }
  return { ...calorie, basis: 'model_estimate', reliability, reliability_reasons: reasons };
}

export { REASONS as CALORIE_RELIABILITY_REASONS };
