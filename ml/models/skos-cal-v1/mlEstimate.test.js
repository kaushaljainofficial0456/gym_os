// Lightweight regression test for mlEstimate.reference.js — no framework,
// matches the project's dependency-free ethos. Run with:
//   node mlEstimate.test.js
// Covers the original hand-verified example (must still match exactly —
// proves the fixes in V1_PRE_INTEGRATION_AUDIT.md didn't touch the fitted
// numbers) plus every edge case the audit flagged.

const assert = require('assert');
const { mlEstimate } = require('./mlEstimate.reference.js');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.log(`FAIL: ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

// ---- 1. Regression: original hand-verified example must still match ----
// bench press, hard, 78.67kg, 10min -> 114 kcal (README.md's own worked
// example). Rate is well under the plausibility cap so the NUMBER is
// unchanged; a duration-extrapolation note is now expected (10min exceeds
// the 1min hard-tier source bout), which is correct new behavior, not a
// regression in the arithmetic.
check('bench press hard regression still = 114 kcal', () => {
  const out = mlEstimate({
    user: { body_weight_kg: 78.67 },
    session: { duration_minutes: 10, intensity_rating: 'hard' },
    exercises: [{ exercise_id: 'BENCH_PRESS', sets: 3, total_volume_kg: 500, completed_sets: [1, 2, 3] }],
  });
  assert.strictEqual(out.estimated_active_kcal, 114, `expected 114, got ${out.estimated_active_kcal}`);
  assert.ok(out.note && out.note.includes('exceeds the longest continuous bout'), 'expected duration-extrapolation note');
});

// ---- 2. Plausibility cap engages for BARBELL_SQUAT hard, long duration ----
check('BARBELL_SQUAT hard 90min is capped, not ~3261 kcal', () => {
  const out = mlEstimate({
    user: { body_weight_kg: 78.67 },
    session: { duration_minutes: 90, intensity_rating: 'hard' },
    exercises: [{ exercise_id: 'BARBELL_SQUAT', sets: 10, total_volume_kg: 5000, completed_sets: [1, 2, 3] }],
  });
  assert.strictEqual(out.estimated_active_kcal, 1800, `expected cap-derived 1800 (20 kcal/min x 90min), got ${out.estimated_active_kcal}`);
  assert.ok(out.note && out.note.includes('exceeded the plausibility cap'), 'expected cap note');
});

// ---- 3. Unrecognized intensity value is flagged, not silently absorbed ----
check('unrecognized intensity_rating ("very_hard") is flagged', () => {
  const out = mlEstimate({
    user: { body_weight_kg: 78.67 },
    session: { duration_minutes: 20, intensity_rating: 'very_hard' },
    exercises: [{ exercise_id: 'BENCH_PRESS', sets: 3, total_volume_kg: 500, completed_sets: [1, 2, 3] }],
  });
  assert.ok(out.note && out.note.includes('unrecognized intensity_rating'), 'expected unrecognized-intensity note');
});

// ---- 4. Known exercise logged with zero volume is not silently dropped ----
check('zero-volume known exercise (mixed session) contributes via set-share fallback', () => {
  const withZeroVolExercise = mlEstimate({
    user: { body_weight_kg: 78.67 },
    session: { duration_minutes: 30, intensity_rating: 'moderate' },
    exercises: [
      { exercise_id: 'BARBELL_SQUAT', sets: 3, total_volume_kg: 1000, completed_sets: [1, 2, 3] },
      { exercise_id: 'BICEP_CURL', sets: 3, total_volume_kg: 0, completed_sets: [1, 2, 3] }, // e.g. bands, no kg logged
    ],
  });
  const squatOnly = mlEstimate({
    user: { body_weight_kg: 78.67 },
    session: { duration_minutes: 30, intensity_rating: 'moderate' },
    exercises: [{ exercise_id: 'BARBELL_SQUAT', sets: 3, total_volume_kg: 1000, completed_sets: [1, 2, 3] }],
  });
  // BICEP_CURL's moderate correction (-2.203) is negative, so including it
  // (via set-share fallback) should pull the estimate DOWN from squat-only
  // — proving it was actually included, not silently zero-weighted away.
  assert.ok(withZeroVolExercise.estimated_active_kcal < squatOnly.estimated_active_kcal,
    `expected mixed session (${withZeroVolExercise.estimated_active_kcal}) < squat-only (${squatOnly.estimated_active_kcal})`);
});

// ---- 5. Partial-unknown session widens interval proportionally ----
// duration kept <= the moderate-tier source-bout threshold (5min) so the
// duration-extrapolation flag doesn't also fire and mask the comparison —
// isolating the unknown-share widening specifically.
check('partial-unknown session widens interval, not all-or-nothing', () => {
  const out = mlEstimate({
    user: { body_weight_kg: 78.67 },
    session: { duration_minutes: 4, intensity_rating: 'moderate' },
    exercises: [
      { exercise_id: 'BARBELL_SQUAT', sets: 3, total_volume_kg: 500, completed_sets: [1, 2, 3] },
      { exercise_id: 'DEADLIFT_UNKNOWN', sets: 6, total_volume_kg: 2000, completed_sets: [1, 2, 3] },
    ],
  });
  const allKnown = mlEstimate({
    user: { body_weight_kg: 78.67 },
    session: { duration_minutes: 4, intensity_rating: 'moderate' },
    exercises: [{ exercise_id: 'BARBELL_SQUAT', sets: 3, total_volume_kg: 500, completed_sets: [1, 2, 3] }],
  });
  const widthMixed = out.upper_kcal - out.lower_kcal;
  const widthAllKnown = allKnown.upper_kcal - allKnown.lower_kcal;
  assert.ok(widthMixed > widthAllKnown, `expected wider interval for partial-unknown session (${widthMixed}) than all-known (${widthAllKnown})`);
  assert.ok(out.note && out.note.includes('% of this session'), 'expected proportional unknown-share note');
});

// ---- 6. Empty session (no completed exercises) is flagged, not silent ----
check('empty session (zero completed exercises) is flagged', () => {
  const out = mlEstimate({
    user: { body_weight_kg: 78.67 },
    session: { duration_minutes: 15, intensity_rating: 'moderate' },
    exercises: [{ exercise_id: 'BARBELL_SQUAT', sets: 3, total_volume_kg: 500, completed_sets: [] }], // logged but not completed
  });
  assert.ok(out.note && out.note.includes('no completed exercises'), 'expected empty-session note');
});

// ---- 7. Out-of-range body weight is flagged ----
check('body weight far outside training range is flagged', () => {
  const out = mlEstimate({
    user: { body_weight_kg: 200 },
    session: { duration_minutes: 20, intensity_rating: 'moderate' },
    exercises: [{ exercise_id: 'BENCH_PRESS', sets: 3, total_volume_kg: 500, completed_sets: [1, 2, 3] }],
  });
  assert.ok(out.note && out.note.includes('outside the training data'), 'expected body-weight-out-of-range note');
});

// ---- 8. Missing required fields still throws (regression, unchanged) ----
check('missing body_weight_kg still throws', () => {
  assert.throws(() => mlEstimate({ session: { duration_minutes: 10 }, exercises: [] }));
});
check('missing duration_minutes still throws', () => {
  assert.throws(() => mlEstimate({ user: { body_weight_kg: 78.67 }, exercises: [] }));
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) console.log('SOME CHECKS FAILED — see above.');
