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

// ---- 7. Out-of-range body weight ----
// BEHAVIOUR CHANGED 2026-08-17 (free action 2): this used to return a FLAGGED
// estimate. A flag does not stop a wrong number reaching a user, and the audit
// showed the correction is demonstrably implausible out here, so it now REFUSES
// and the caller's baseline fallback takes over. Test updated deliberately to
// assert the new contract, not weakened to accommodate it.
check('body weight far outside training range is REFUSED (was: flagged)', () => {
  assert.throws(() => mlEstimate({
    user: { body_weight_kg: 200 },
    session: { duration_minutes: 20, intensity_rating: 'moderate' },
    exercises: [{ exercise_id: 'BENCH_PRESS', sets: 3, total_volume_kg: 500, completed_sets: [1, 2, 3] }],
  }), /out of scope: body_weight_kg/);
});

// ---- 8. Missing required fields still throws (regression, unchanged) ----
check('missing body_weight_kg still throws', () => {
  assert.throws(() => mlEstimate({ session: { duration_minutes: 10 }, exercises: [] }));
});
check('missing duration_minutes still throws', () => {
  assert.throws(() => mlEstimate({ user: { body_weight_kg: 78.67 }, exercises: [] }));
});


// ---- display layer (displayEstimate.js) ----
const { formatEstimate } = require('./displayEstimate.js');

check('clean session -> high confidence, no "~" prefix, no caveat', () => {
  const out = formatEstimate(mlEstimate({
    user: { body_weight_kg: 78 },
    session: { duration_minutes: 5, intensity_rating: 'moderate' },
    exercises: [{ exercise_id: 'BENCH_PRESS', sets: 3, total_volume_kg: 900, completed_sets: [1] }],
  }));
  assert.strictEqual(out.confidence, 'high');
  assert.ok(!out.display_text.startsWith('~'), 'high confidence should not be hedged');
  assert.strictEqual(out.caveat, null);
});

check('mostly-untrained session -> downgraded confidence + caveat', () => {
  const out = formatEstimate(mlEstimate({
    user: { body_weight_kg: 65 },
    session: { duration_minutes: 60, intensity_rating: 'moderate' },
    exercises: [
      { exercise_id: 'BICEP_CURL', sets: 2, total_volume_kg: 500, completed_sets: [1] },
      { exercise_id: 'UNKNOWN_LIFT', sets: 6, total_volume_kg: 4500, completed_sets: [1] },
    ],
  }));
  assert.notStrictEqual(out.confidence, 'high');
  assert.ok(out.display_text.startsWith('~'), 'reduced confidence should be hedged with ~');
  assert.ok(out.caveat, 'expected a user-facing caveat');
  assert.ok(out.reasons.some(r => r.includes("haven't measured")), 'expected untrained-exercise reason');
});

check('a NORMAL gym session is not scored "low" (signal must stay meaningful)', () => {
  // Regression guard: an early version scored every real session "low"
  // because the duration flag fires on any workout over ~5 min. If every
  // session reads "rough estimate", users stop reading it entirely.
  const out = formatEstimate(mlEstimate({
    user: { body_weight_kg: 75 },
    session: { duration_minutes: 45, intensity_rating: 'hard' },
    exercises: [
      { exercise_id: 'BENCH_PRESS', sets: 4, total_volume_kg: 2000, completed_sets: [1] },
      { exercise_id: 'DEADLIFT', sets: 4, total_volume_kg: 2000, completed_sets: [1] },
    ],
  }));
  assert.notStrictEqual(out.confidence, 'low', 'a routine session should not be the worst confidence tier');
});

check('typical_range is always narrower than the raw 90% interval', () => {
  const out = formatEstimate(mlEstimate({
    user: { body_weight_kg: 65 },
    session: { duration_minutes: 115, intensity_rating: 'moderate' },
    exercises: [{ exercise_id: 'LAT_PULLDOWN', sets: 4, total_volume_kg: 5790, completed_sets: [1] }],
  }));
  const typicalWidth = out.typical_range[1] - out.typical_range[0];
  const fullWidth = out.full_range[1] - out.full_range[0];
  assert.ok(typicalWidth < fullWidth, `typical (${typicalWidth}) should be narrower than full (${fullWidth})`);
});

check('primary number is rounded to nearest 5 (no false precision)', () => {
  const out = formatEstimate({ estimated_active_kcal: 527, lower_kcal: 100, upper_kcal: 900 });
  assert.strictEqual(out.primary_kcal % 5, 0, 'should round to nearest 5');
});


// ---- blocker 6: interval coverage validity ----
check('B6: clamped lower bound is declared invalid, not labelled 90%', () => {
  const out = formatEstimate(mlEstimate({
    user: { body_weight_kg: 65 },
    session: { duration_minutes: 115, intensity_rating: 'moderate' },
    exercises: [{ exercise_id: 'BICEP_CURL', sets: 3, total_volume_kg: 800, completed_sets: [1] }],
  }));
  assert.strictEqual(out.full_range[0], 0, 'precondition: this case should clamp');
  assert.strictEqual(out.full_range_coverage_valid, false);
  assert.ok(out.full_range_coverage.includes('truncated'), 'must not advertise 90% on a truncated band');
});

check('B6: unclamped interval still reports 90% coverage', () => {
  const out = formatEstimate(mlEstimate({
    user: { body_weight_kg: 78 },
    session: { duration_minutes: 5, intensity_rating: 'moderate' },
    exercises: [{ exercise_id: 'BENCH_PRESS', sets: 3, total_volume_kg: 900, completed_sets: [1] }],
  }));
  assert.ok(out.full_range[0] > 0, 'precondition: this case should not clamp');
  assert.strictEqual(out.full_range_coverage_valid, true);
  assert.strictEqual(out.full_range_coverage, '90%');
});

// ---- blocker 7: hard-tier unknown-exercise bias ----
check('B7: hard tier + unknown exercises downgrades confidence and explains why', () => {
  const input = {
    user: { body_weight_kg: 75 },
    session: { duration_minutes: 60, intensity_rating: 'hard' },
    exercises: [
      { exercise_id: 'BENCH_PRESS', sets: 2, total_volume_kg: 1000, completed_sets: [1] },
      { exercise_id: 'DEADLIFT', sets: 6, total_volume_kg: 5000, completed_sets: [1] },
    ],
  };
  const out = formatEstimate(mlEstimate(input), { intensity_rating: 'hard' });
  assert.strictEqual(out.confidence, 'low', 'hard + unknown is the least reliable combination');
  assert.ok(out.reasons.some(r => r.includes('UNDER-counted')), 'must explain the direction of the bias');
});

check('B7: same unknown share at moderate does NOT trigger the hard-tier rule', () => {
  // Evidence-bound: at moderate, zero-correction sits INSIDE the observed
  // range, so the rule must not fire. Guards against over-flagging.
  const input = {
    user: { body_weight_kg: 75 },
    session: { duration_minutes: 60, intensity_rating: 'moderate' },
    exercises: [
      { exercise_id: 'BENCH_PRESS', sets: 2, total_volume_kg: 1000, completed_sets: [1] },
      { exercise_id: 'DEADLIFT', sets: 6, total_volume_kg: 5000, completed_sets: [1] },
    ],
  };
  const out = formatEstimate(mlEstimate(input), { intensity_rating: 'moderate' });
  assert.ok(!out.reasons.some(r => r.includes('UNDER-counted')), 'rule must be tier-specific, driven by the artifact');
});

check('B7: rule is derived from the artifact, not hardcoded', () => {
  // If the model is ever retrained such that zero falls inside the hard-tier
  // range, the rule must stop firing automatically.
  const M = require('./model_v1.json');
  const hard = Object.values(M.correction_kcal_per_min_by_exercise_and_tier).map(c => c.hard);
  assert.ok(Math.min(...hard) > 0, 'documented precondition: all hard corrections positive');
});


// ---- free actions 2 & 3: scope gates (refuse -> baseline fallback) ----
// NOTE: the estimable floor moved 57.3 -> 45kg on 2026-08-17 (product decision,
// checked: at 45kg worst case still implies 1.70-1.91 METs, above the lowest
// independently measured resistance MET of 1.30). 45kg is now ALLOWED-but-flagged;
// this test therefore asserts refusal below the NEW floor, not the old one.
check('A2: body weight below ESTIMABLE floor is REFUSED, not estimated', () => {
  assert.throws(() => mlEstimate({
    user: { body_weight_kg: 38 },
    session: { duration_minutes: 60, intensity_rating: 'moderate' },
    exercises: [{ exercise_id: 'BENCH_PRESS', sets: 3, total_volume_kg: 900, completed_sets: [1] }],
  }), /out of scope: body_weight_kg/);
});

check('A2: body weight above ESTIMABLE range is REFUSED', () => {
  assert.throws(() => mlEstimate({
    user: { body_weight_kg: 130 },
    session: { duration_minutes: 60, intensity_rating: 'moderate' },
    exercises: [{ exercise_id: 'BENCH_PRESS', sets: 3, total_volume_kg: 900, completed_sets: [1] }],
  }), /out of scope: body_weight_kg/);
});

check('A2: body weight INSIDE range still estimates normally', () => {
  const out = mlEstimate({
    user: { body_weight_kg: 75 },
    session: { duration_minutes: 60, intensity_rating: 'moderate' },
    exercises: [{ exercise_id: 'BENCH_PRESS', sets: 3, total_volume_kg: 900, completed_sets: [1] }],
  });
  assert.ok(out.estimated_active_kcal > 0);
});

check('A3: duration beyond ESTIMABLE range is REFUSED', () => {
  assert.throws(() => mlEstimate({
    user: { body_weight_kg: 75 },
    session: { duration_minutes: 180, intensity_rating: 'moderate' },
    exercises: [{ exercise_id: 'BENCH_PRESS', sets: 3, total_volume_kg: 900, completed_sets: [1] }],
  }), /out of scope: duration_minutes/);
});

check('A3: 150min (the widened bound) is still accepted', () => {
  const out = mlEstimate({
    user: { body_weight_kg: 75 },
    session: { duration_minutes: 150, intensity_rating: 'moderate' },
    exercises: [{ exercise_id: 'BENCH_PRESS', sets: 3, total_volume_kg: 900, completed_sets: [1] }],
  });
  assert.ok(out.estimated_active_kcal > 0, 'bound must be inclusive');
});

check('A2/A3: gates read from the artifact, not hardcoded', () => {
  const M = require('./model_v1.json');
  assert.ok(M.estimable_range && M.validated_range, 'both tiers must ship in the artifact');
  assert.ok(M.estimable_range.body_weight_kg.max >= M.validated_range.body_weight_kg.max,
    'estimable band must contain the validated band');
  assert.ok(M.estimable_range.duration_minutes.max >= M.validated_range.duration_minutes.max);
});

// ---- free action 4: external plausibility envelope ----
check('A4: envelope is reported whenever bw + duration are supplied', () => {
  const input = {
    user: { body_weight_kg: 75 },
    session: { duration_minutes: 60, intensity_rating: 'moderate' },
    exercises: [{ exercise_id: 'BENCH_PRESS', sets: 3, total_volume_kg: 900, completed_sets: [1] }],
  };
  const out = formatEstimate(mlEstimate(input), { body_weight_kg: 75, duration_minutes: 60, intensity_rating: 'moderate' });
  assert.ok(out.envelope, 'envelope must be reported');
  assert.ok(typeof out.envelope.ratio_to_band_midpoint === 'number');
});

check('A4: only EXTREME departures score into confidence (not the raw band)', () => {
  // Regression guard: scoring on the raw band fired on 92% of sessions,
  // which makes the signal useless. Only >2x departures may score.
  const input = {
    user: { body_weight_kg: 75 },
    session: { duration_minutes: 60, intensity_rating: 'moderate' },
    exercises: [{ exercise_id: 'BENCH_PRESS', sets: 3, total_volume_kg: 900, completed_sets: [1] }],
  };
  const out = formatEstimate(mlEstimate(input), { body_weight_kg: 75, duration_minutes: 60, intensity_rating: 'moderate' });
  if (!out.envelope.inside && !out.envelope.extreme_departure) {
    assert.ok(!out.reasons.some(r => r.includes('independently measured')),
      'a mild departure must NOT add a reason');
  }
});

// ---- free action 5: validated scope travels with the number ----
check('A5: validated population and scope are returned with every estimate', () => {
  const input = {
    user: { body_weight_kg: 75 },
    session: { duration_minutes: 60, intensity_rating: 'moderate' },
    exercises: [{ exercise_id: 'BENCH_PRESS', sets: 3, total_volume_kg: 900, completed_sets: [1] }],
  };
  const out = formatEstimate(mlEstimate(input), { body_weight_kg: 75, duration_minutes: 60 });
  assert.ok(out.validated_population.includes('male'), 'population must state the training cohort');
  assert.ok(out.validated_scope.includes('kg') && out.validated_scope.includes('min'));
});

console.log();


// ---- two-tier scope: extended zone must run BUT be visibly less confident ----
check('TIER: extended-zone body weight (125kg) estimates but is downgraded', () => {
  const input = {
    user: { body_weight_kg: 125 },
    session: { duration_minutes: 60, intensity_rating: 'moderate' },
    exercises: [{ exercise_id: 'BENCH_PRESS', sets: 3, total_volume_kg: 900, completed_sets: [1] }],
  };
  const raw = mlEstimate(input);
  assert.ok(raw.estimated_active_kcal > 0, 'must still produce an estimate');
  assert.ok(raw.note.includes('outside the validated range'), 'must flag the extended zone');
  const out = formatEstimate(raw, { body_weight_kg: 125, duration_minutes: 60 });
  assert.notStrictEqual(out.confidence, 'high', 'out-of-evidence must never read as high confidence');
});

check('TIER: extended-zone duration (150min) estimates but is downgraded', () => {
  const input = {
    user: { body_weight_kg: 75 },
    session: { duration_minutes: 150, intensity_rating: 'moderate' },
    exercises: [{ exercise_id: 'BENCH_PRESS', sets: 3, total_volume_kg: 900, completed_sets: [1] }],
  };
  const raw = mlEstimate(input);
  assert.ok(raw.estimated_active_kcal > 0);
  assert.ok(raw.note.includes('exceeds the longest independently measured'));
  const out = formatEstimate(raw, { body_weight_kg: 75, duration_minutes: 150 });
  assert.notStrictEqual(out.confidence, 'high');
});

check('TIER: inside the validated band can still reach high confidence', () => {
  // Guards against the widening making EVERY session low-confidence.
  const out = formatEstimate(mlEstimate({
    user: { body_weight_kg: 75 },
    session: { duration_minutes: 60, intensity_rating: 'moderate' },
    exercises: [{ exercise_id: 'BENCH_PRESS', sets: 3, total_volume_kg: 900, completed_sets: [1] }],
  }), { body_weight_kg: 75, duration_minutes: 60 });
  assert.strictEqual(out.confidence, 'high');
});

check('TIER: both scope strings are exposed and distinct', () => {
  const out = formatEstimate(mlEstimate({
    user: { body_weight_kg: 75 },
    session: { duration_minutes: 60, intensity_rating: 'moderate' },
    exercises: [{ exercise_id: 'BENCH_PRESS', sets: 3, total_volume_kg: 900, completed_sets: [1] }],
  }), { body_weight_kg: 75, duration_minutes: 60 });
  assert.ok(out.validated_scope.includes('100.1'), 'validated band stays evidence-anchored');
  assert.ok(out.estimable_scope.includes('125'), 'estimable band reflects the product decision');
  assert.notStrictEqual(out.validated_scope, out.estimable_scope);
});

// ---- widened lower bound (45kg) + evidence-grounded MET floor ----
check('BOUND: 45kg (the widened floor) estimates, flagged as extended', () => {
  const raw = mlEstimate({
    user: { body_weight_kg: 45 },
    session: { duration_minutes: 60, intensity_rating: 'moderate' },
    exercises: [{ exercise_id: 'BENCH_PRESS', sets: 3, total_volume_kg: 900, completed_sets: [1] }],
  });
  assert.ok(raw.estimated_active_kcal > 0, 'must produce an estimate at the boundary');
  assert.ok(raw.note.includes('outside the validated range'), 'must be flagged as extended zone');
  const out = formatEstimate(raw, { body_weight_kg: 45, duration_minutes: 60 });
  assert.notStrictEqual(out.confidence, 'high');
});

check('BOUND: below 45kg is still REFUSED', () => {
  assert.throws(() => mlEstimate({
    user: { body_weight_kg: 40 },
    session: { duration_minutes: 60, intensity_rating: 'moderate' },
    exercises: [{ exercise_id: 'BENCH_PRESS', sets: 3, total_volume_kg: 900, completed_sets: [1] }],
  }), /out of scope: body_weight_kg/);
});

check('FLOOR: min_active_rate_met ships and is evidence-grounded', () => {
  const M = require('./model_v1.json');
  assert.strictEqual(M.plausibility_guardrails.min_active_rate_met, 1.30);
  assert.ok(M.plausibility_guardrails.min_active_rate_rationale.includes('Adeel'),
    'floor must cite the measurement it comes from');
});

check('FLOOR: never triggers inside the estimable range (insurance, not adjustment)', () => {
  // If this ever starts firing, the model has drifted somewhere it should not
  // have — the floor exists to catch that, not to routinely reshape estimates.
  const M = require('./model_v1.json');
  let fired = 0;
  for (let bw = 45; bw <= 125; bw += 5) {
    for (const tier of ['light', 'moderate', 'hard']) {
      for (const ex of Object.keys(M.correction_kcal_per_min_by_exercise_and_tier)) {
        const o = mlEstimate({
          user: { body_weight_kg: bw },
          session: { duration_minutes: 60, intensity_rating: tier },
          exercises: [{ exercise_id: ex, sets: 3, total_volume_kg: 900, completed_sets: [1] }],
        });
        if ((o.note || '').includes('was floored')) fired++;
      }
    }
  }
  assert.strictEqual(fired, 0, 'floor should be dormant across the whole estimable range');
});

console.log('');
console.log(passed + ' check(s) passed.');
if (process.exitCode) console.log('SOME CHECKS FAILED - see above.');
