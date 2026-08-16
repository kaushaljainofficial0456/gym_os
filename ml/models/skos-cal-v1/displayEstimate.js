// ============================================================
// Presentation layer for skos-cal-v1.
//
// WHY THIS IS A SEPARATE FILE: the model artifact (model_v1.json) and
// mlEstimate.reference.js are FROZEN. How a number is *displayed* is a
// product decision that will change more often than the model does, so it
// lives here rather than being baked into the estimator.
//
// DESIGN DECISION (2026-08-16) — show a SINGLE NUMBER, not a range.
// Rationale:
//   1. Calories are summed. Weekly totals, deficit maths and progress
//      charts all break if the atom is a range ("you burned 3,000-5,000
//      this week" is unusable).
//   2. The raw 90% conformal interval is not presentable. On a real
//      115-minute session it produced 0-959 kcal -- technically honest,
//      operationally worthless.
//   3. A range reads as evasive to users, who expect a number from every
//      other fitness product they have used.
// Honesty is preserved by CONFIDENCE-ADJUSTED PRESENTATION instead:
// a "~" prefix, a plain-language caveat, and a widening typical band --
// all driven by the flags mlEstimate already raises.
//
// The two bands are deliberately different things and must not be
// conflated:
//   typical_range -- where the answer usually lands. Derived from V1's
//                    OWN measured out-of-sample error distribution
//                    (VALIDATION_REPORT.md: median |%err| 14.7%,
//                    75th 26.5%, 90th 39.7%). This is what a user sees.
//   full_range    -- the 90% conformal interval from the model. A
//                    statistical guarantee, not a UI element. Kept for
//                    debugging, support and audit.
// ============================================================

// Percentiles of V1's own |% error| distribution -- measured, not chosen.
const TYPICAL_SPREAD = { high: 0.15, medium: 0.265, low: 0.397 };

// Heuristic 'clearly implausible' bar for the external-envelope check (see
// formatEstimate). NOT a validated boundary -- chosen so the flag fires on
// ~19% of realistic sessions rather than 92%, keeping the signal meaningful.
const EXTREME_DEPARTURE_FACTOR = 2.0;

// Multiplier applied to typical_range when the model reports NET output.
// A constant resting subtraction leaves ABSOLUTE error unchanged but shrinks
// the denominator, so PERCENTAGE error grows. Measured across representative
// sessions (SKOS_CALORIE_MODEL_VALIDATION_CALIBRATION_REPORT.md §7.1),
// net/gross ranges ~0.54-0.88 -> effective MAPE 22-35% vs 19.1% gross.
// Callers pass grossKcal so the true ratio is used rather than an assumed one.
const MODEL = require('./model_v1.json');
const CORR = MODEL.correction_kcal_per_min_by_exercise_and_tier;

// Blocker 7: is zero-correction (what an unknown exercise receives) inside the
// range of corrections actually OBSERVED for that tier? Computed from the
// artifact, so it stays true if the model is ever retrained.
const ZERO_CORRECTION_IS_UNOBSERVED = {};
for (const tier of ['light', 'moderate', 'hard']) {
  const vals = Object.values(CORR).map((c) => c[tier]);
  ZERO_CORRECTION_IS_UNOBSERVED[tier] = !(Math.min(...vals) <= 0 && 0 <= Math.max(...vals));
}

/**
 * @param {object} result - output of mlEstimate()
 * @returns {{primary_kcal:number, display_text:string, confidence:string,
 *            typical_range:[number,number], full_range:[number,number],
 *            caveat:(string|null), reasons:string[]}}
 */
function formatEstimate(result, opts = {}) {
  const notes = result.note ? result.note.split(' | ') : [];
  const reasons = [];
  const tier = opts.intensity_rating && ['light', 'moderate', 'hard'].includes(String(opts.intensity_rating).toLowerCase())
    ? String(opts.intensity_rating).toLowerCase()
    : 'moderate';

  // Confidence is driven by the flags the model already raises, so the two
  // can never drift apart.
  // Confidence scores ONLY things that vary between sessions.
  //
  // Deliberately NOT scored: the "session longer than the lab bout" flag.
  // It fires on essentially every real workout (the moderate tier's longest
  // measured bout is 5 minutes), so scoring it would mark every session
  // "low confidence" -- making the signal useless and training users to
  // ignore it. It is a standing property of the model, not of any one
  // session, so it belongs in the model card and info screen. It is still
  // surfaced in `reasons` for support and debugging.
  let score = 0;
  for (const n of notes) {
    if (n.includes('outside the trained set')) {
      const pct = parseInt((n.match(/~(\d+)%/) || [])[1] || '0', 10);
      if (pct > 50) score += 2;
      else if (pct >= 25) score += 1;
      reasons.push(`${pct}% of your workload uses exercises we haven't measured directly`);
      // BLOCKER 7 (validation report §6): an unknown exercise receives ZERO
      // correction. At `hard`, zero lies OUTSIDE the range of every correction
      // ever measured (observed +0.297 to +27.969, mean +9.06) -- so we KNOW
      // zero is wrong there, even though the data cannot say what the right
      // value would be. Downgrade confidence; never invent a substitute number.
      if (ZERO_CORRECTION_IS_UNOBSERVED[tier] && pct >= 25) {
        score += 2;
        reasons.push(`at "${tier}" intensity, unmeasured exercises are likely UNDER-counted (this is the model's least reliable combination)`);
      }
    } else if (n.includes('exceeded the plausibility cap')) {
      score += 3; reasons.push('estimated intensity hit our physiological safety ceiling');
    } else if (n.includes('outside the validated range')) {
      // Extended zone (2026-08-17): inside the hard gate, outside the evidence
      // base. Estimate still runs; it must not look as confident as one that
      // sits inside the validated band.
      score += 2;
      reasons.push('your body weight is outside the range this model was validated on');
    } else if (n.includes('exceeds the longest independently measured')) {
      score += 2;
      reasons.push('this session is longer than any independently measured resistance session, so the estimate is likely on the high side');
    } else if (n.includes('outside the training data')) {
      score += 2; reasons.push('body weight is outside the range the model was calibrated on');
    } else if (n.includes('unrecognized intensity_rating')) {
      score += 2; reasons.push('intensity rating was missing, so we assumed moderate');
    } else if (n.includes('no completed exercises')) {
      score += 3; reasons.push('no completed sets were logged');
    } else if (n.includes('exceeds the longest continuous bout')) {
      reasons.push('session is longer than the lab sessions this model was built from');  // not scored, see above
    }
  }

  // FREE ACTION 4 — external plausibility envelope.
  // Independent whole-session measurements (Rustaden 2020, Benito 2016,
  // Adeel 2021, Nakagata 2019) normalised per kg. If this session's implied
  // rate falls outside everything four independent labs have measured, that
  // is worth surfacing. It NEVER alters the estimate — only confidence.
  // CALIBRATION NOTE — the raw band is NOT usable as a per-session flag.
  // Measured over 2000 simulated realistic sessions, 92% fall outside it.
  // That is because the band comes from just two whole-session studies that
  // happened to agree very closely (0.0593 / 0.0603), so it is far narrower
  // than genuine between-session variability. A flag that fires on 92% of
  // sessions is noise -- the same mistake the duration flag made.
  //
  // So: the comparison is always REPORTED (useful for monitoring and
  // debugging), but only scored into confidence on an EXTREME departure --
  // more than 2x away from the band midpoint, which is 19% of sessions.
  // The 2x bar is an explicitly heuristic "clearly implausible" threshold,
  // not a validated boundary; it is documented as such.
  let envelope = null;
  const env = MODEL.external_plausibility_envelope_kcal_min_per_kg;
  if (env && opts.body_weight_kg > 0 && opts.duration_minutes > 0) {
    const perKg = (result.estimated_active_kcal / opts.duration_minutes) / opts.body_weight_kg;
    const mid = (env.min + env.max) / 2;
    const ratio = perKg / mid;
    const extreme = ratio > EXTREME_DEPARTURE_FACTOR || ratio < 1 / EXTREME_DEPARTURE_FACTOR;
    envelope = {
      per_kg: Number(perKg.toFixed(4)),
      band: [env.min, env.max],
      inside: perKg >= env.min && perKg <= env.max,
      ratio_to_band_midpoint: Number(ratio.toFixed(2)),
      extreme_departure: extreme,
    };
    if (extreme) {
      score += 2;
      reasons.push(
        ratio > 1
          ? `this session's intensity is ${ratio.toFixed(1)}x higher than independently measured resistance sessions`
          : `this session's intensity is ${(1 / ratio).toFixed(1)}x lower than independently measured resistance sessions`
      );
    }
  }

  const confidence = score === 0 ? 'high' : score <= 2 ? 'medium' : 'low';
  const kcal = result.estimated_active_kcal;
  const spread = TYPICAL_SPREAD[confidence];

  // Round to the nearest 5 -- showing "525" implies a precision we do not
  // have; "525" and "527" are not distinguishable by this model.
  const round5 = (n) => Math.round(n / 5) * 5;
  const primary = round5(kcal);

  const caveat = confidence === 'high'
    ? null
    : confidence === 'medium'
      ? 'Approximate — based on your logged workout'
      : 'Rough estimate — limited data for this type of session';

  // BLOCKER 6 (validation report §8.1): the model's conformal interval was
  // calibrated as a symmetric band, but `lower_kcal` is clamped at 0. Once it
  // clamps, the band is asymmetrically truncated and NO LONGER delivers its
  // stated 90% coverage. Detect and declare that, rather than letting a
  // "90% interval" label travel with a band that isn't one.
  const lowerClamped = result.lower_kcal === 0 && kcal > 0;
  const coverageValid = !lowerClamped;

  return {
    primary_kcal: primary,
    display_text: confidence === 'high' ? `${primary} kcal` : `~${primary} kcal`,
    confidence,
    typical_range: [round5(kcal * (1 - spread)), round5(kcal * (1 + spread))],
    full_range: [result.lower_kcal, result.upper_kcal],
    // Never advertise "90%" when the band has been truncated (blocker 6).
    full_range_coverage: coverageValid ? '90%' : 'undefined (lower bound truncated at 0)',
    full_range_coverage_valid: coverageValid,
    envelope,
    // FREE ACTION 5 — the validated population travels WITH the number, so it
    // cannot be quoted without its scope. Sourced from the artifact.
    validated_population: MODEL.trained_on.population,
    validated_scope: MODEL.validated_range
      ? `validated for body weight ${MODEL.validated_range.body_weight_kg.min}-${MODEL.validated_range.body_weight_kg.max}kg `
        + `and sessions up to ${MODEL.validated_range.duration_minutes.max}min`
      : null,
    estimable_scope: MODEL.estimable_range
      ? `estimates produced for body weight ${MODEL.estimable_range.body_weight_kg.min}-${MODEL.estimable_range.body_weight_kg.max}kg `
        + `and sessions up to ${MODEL.estimable_range.duration_minutes.max}min (beyond the validated band, confidence is reduced)`
      : null,
    caveat,
    reasons,
  };
}

module.exports = { formatEstimate };
