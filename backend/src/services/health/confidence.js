// ============================================================
// CONFIDENCE ENGINE — pure scoring, no DB access (spec §28).
//
// Every final energy/workout number gets a confidence_score (0..1,
// internal) and a confidence_level (high/medium/low/very_low, the ONLY
// thing ever shown to a user -- spec §28: never display "87.3942%").
// ============================================================

export const CONFIDENCE_THRESHOLDS = Object.freeze({ high: 0.8, medium: 0.55, low: 0.3 });

export function confidenceLevel(score) {
  if (score >= CONFIDENCE_THRESHOLDS.high) return 'high';
  if (score >= CONFIDENCE_THRESHOLDS.medium) return 'medium';
  if (score >= CONFIDENCE_THRESHOLDS.low) return 'low';
  return 'very_low';
}

// Base score per source directness (spec §27's priority order, restated
// as a numeric prior rather than an ordered list so it composes with
// coverage/quality below instead of being an all-or-nothing switch).
const SOURCE_BASE_SCORE = Object.freeze({
  wearable_direct: 0.95,     // provider-reported energy directly on a matched, high-quality workout record
  wearable_physiological: 0.7, // no matched workout, but real HR/activity samples covering the interval
  skos_ml: 0.5,               // model estimate, no wearable evidence at all
  met_fallback: 0.3,          // oldest, least personalized baseline
});

/**
 * @param {object} input
 *   sourceType: one of SOURCE_BASE_SCORE's keys
 *   coverageRatio: 0..1 -- how much of the interval this source actually covers
 *   dataQuality: 'good' | 'flagged' | 'suspicious'
 *   matchScore: 0..1 | null -- the WorkoutMatchingEngine score, if this came from a matched workout
 *   disagreementRatio: 0..1 | null -- |a-b|/max(a,b) between this source and a secondary estimate, if one exists (spec §36/§15 test)
 * @returns {{ score: number, level: string, reasons: string[] }}
 */
export function computeConfidence({ sourceType, coverageRatio = 1, dataQuality = 'good', matchScore = null, disagreementRatio = null }) {
  const reasons = [];
  let score = SOURCE_BASE_SCORE[sourceType] ?? 0.4;
  reasons.push(`base ${sourceType} = ${score.toFixed(2)}`);

  if (coverageRatio < 1) {
    const penalty = (1 - coverageRatio) * 0.4;
    score -= penalty;
    reasons.push(`coverage ${(coverageRatio * 100).toFixed(0)}% (-${penalty.toFixed(2)})`);
  }
  if (matchScore != null && matchScore < 0.8) {
    const penalty = (0.8 - matchScore) * 0.3;
    score -= penalty;
    reasons.push(`weak workout match ${(matchScore * 100).toFixed(0)}% (-${penalty.toFixed(2)})`);
  }
  if (dataQuality === 'flagged') { score -= 0.15; reasons.push('data flagged (-0.15)'); }
  if (dataQuality === 'suspicious') { score -= 0.35; reasons.push('data suspicious (-0.35)'); }
  // A large disagreement between two independent estimates for the SAME
  // interval lowers confidence in EITHER of them (spec §36: flag, don't
  // silently trust one) -- this never changes WHICH source is primary,
  // only how confident the engine is willing to say it is about it.
  if (disagreementRatio != null && disagreementRatio > 0.4) {
    score -= 0.25;
    reasons.push(`large disagreement with secondary estimate ${(disagreementRatio * 100).toFixed(0)}% (-0.25)`);
  }

  score = Math.max(0, Math.min(1, score));
  return { score, level: confidenceLevel(score), reasons };
}

/** Day-level data quality (spec §65) -- distinct from per-record
 *  data_quality: this is "how complete was today's picture", derived
 *  from how much of the day (or of a specific workout) had ANY evidence
 *  at all, wearable or SK OS. */
export function dataQualityState(coverageRatio) {
  if (coverageRatio >= 0.95) return 'complete';
  if (coverageRatio >= 0.75) return 'mostly_complete';
  if (coverageRatio >= 0.4) return 'partial';
  if (coverageRatio > 0) return 'poor';
  return 'unknown';
}
