// ============================================================
// ENERGY RECONCILIATION ENGINE — the core of the "brain" (spec §59/§60).
// "Never simply sum every record" is the one rule every function below
// exists to enforce.
//
// Deliberately split into a PURE core (this file's exported functions)
// that takes already-fetched records + an injected ML-estimate callback
// and returns a decision -- no DB, no fetch, fully deterministic and
// unit-testable against the spec's own TEST 1-15 (see
// backend/test/healthReconciliation.test.js). The DB-touching
// orchestration (fetching a user's real workouts/health_records for a
// day, calling backend/src/services/intelligence/calorieModel.js for the
// real ML estimate, and WRITING health_canonical_workouts/
// health_energy_intervals/health_reconciliation_log) lives in
// dailyIntelligence.js, which composes these functions rather than
// duplicating their logic.
// ============================================================
import { findBestMatch, scoreMatch, computeCoverage, MATCH_THRESHOLD, FULL_COVERAGE_THRESHOLD } from './matching.js';
import { computeConfidence } from './confidence.js';

// A wearable-vs-model disagreement past this ratio is flagged, never
// silently averaged (spec §15 test 15 / §36/§73).
export const DISAGREEMENT_FLAG_THRESHOLD = 0.4;
// Same idea for two independent wearable daily aggregates disagreeing
// with the sum of that day's reconciled workout intervals (spec §26's
// "energy ledger" tolerance / §61).
export const DAILY_RECONCILIATION_TOLERANCE = 0.3;

function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Reconciles ONE SK OS-logged workout against candidate wearable
 * records for the same day (spec's TEST 1-4, 14, 15).
 *
 * @param {object} skosWorkout - { start_time, end_time, activity_type }
 * @param {object[]} candidates - wearable health_records overlapping the day
 *   (data_type in workout|energy_sample|heart_rate)
 * @param {object} opts
 *   estimateMl: async (durationSeconds) => { kcal, modelName, modelVersion, provider }
 *     -- the ONLY way this module ever gets an SK OS ML number; it never
 *     imports calorieModel.js itself (spec §32: keep skos-cal-v1, call
 *     it, don't reinvent it -- but this module stays DB/model-free so it
 *     can be unit tested with a fake).
 * @returns the full reconciliation decision for this workout.
 */
export async function reconcileWorkout(skosWorkout, candidates, { estimateMl }) {
  const workoutCandidates = candidates.filter((c) => c.data_type === 'workout');
  const physioCandidates = candidates.filter((c) => c.data_type === 'energy_sample' || c.data_type === 'heart_rate');

  const durationSeconds = (Date.parse(skosWorkout.end_time) - Date.parse(skosWorkout.start_time)) / 1000;
  // Always compute the SK OS estimate for the FULL session as a
  // secondary/comparison value (spec §14/§23: retained, never discarded,
  // even when a wearable wins) -- independent of whichever branch below
  // ends up primary.
  const secondary = durationSeconds > 0 ? await estimateMl(durationSeconds) : null;

  const matchedCandidates = workoutCandidates.filter((c) => scoreMatch(skosWorkout, c).score >= MATCH_THRESHOLD);

  if (matchedCandidates.length > 0) {
    // TEST 2/3/5/9: one or more wearable WORKOUT records matched.
    const best = findBestMatch(skosWorkout, workoutCandidates);
    const coverage = computeCoverage(skosWorkout, matchedCandidates);
    // Source fusion (spec §62/§63), never summation: if MULTIPLE
    // wearables matched (e.g. WHOOP + Apple Health both reported this
    // workout), take the median of their reported energy as consensus
    // rather than adding them.
    const wearableValues = matchedCandidates.map((c) => c.active_kcal).filter((v) => v != null);
    const wearableKcal = median(wearableValues);

    let activeKcal = wearableKcal;
    let sourceType = 'wearable_direct';
    let uncoveredEstimateKcal = null;
    if (coverage.coverageRatio < FULL_COVERAGE_THRESHOLD && coverage.uncoveredSeconds > 0) {
      // TEST 3: partial coverage -- estimate ONLY the genuinely
      // uncovered portion, add it to (never instead of) the wearable's
      // own reported energy for what it DID cover.
      const uncoveredEstimate = await estimateMl(coverage.uncoveredSeconds);
      uncoveredEstimateKcal = uncoveredEstimate?.kcal ?? null;
      activeKcal = (wearableKcal || 0) + (uncoveredEstimateKcal || 0);
    }

    const disagreementRatio = secondary?.kcal != null && wearableKcal != null
      ? Math.abs(wearableKcal - secondary.kcal) / Math.max(wearableKcal, secondary.kcal, 1)
      : null;
    const flagged = disagreementRatio != null && disagreementRatio > DISAGREEMENT_FLAG_THRESHOLD;

    const confidence = computeConfidence({
      sourceType, coverageRatio: coverage.coverageRatio,
      dataQuality: flagged ? 'flagged' : 'good', matchScore: best?.score ?? null, disagreementRatio,
    });

    return {
      activeKcal, sourceType,
      primarySource: best?.candidate?.provider || matchedCandidates[0].provider,
      coverageRatio: coverage.coverageRatio,
      matchScore: best?.score ?? null, matchReason: best?.matchReason ?? null,
      matchedRecordIds: matchedCandidates.map((c) => c.id),
      wearableKcal, uncoveredEstimateKcal,
      secondaryEstimateKcal: secondary?.kcal ?? null, secondaryModel: secondary ? { name: secondary.modelName, version: secondary.modelVersion } : null,
      disagreementRatio, dataQualityFlag: flagged,
      autoDetected: matchedCandidates.some((c) => c.auto_detected),
      confidence,
    };
  }

  // No matched WORKOUT record -- check for physiological/activity
  // evidence overlapping this window (TEST 4: "user forgot to start the
  // watch" -- absence of a workout record is NOT absence of evidence).
  const overlappingPhysio = physioCandidates.filter((c) => {
    const cs = Date.parse(c.start_time), ce = Date.parse(c.end_time || c.start_time);
    const ss = Date.parse(skosWorkout.start_time), se = Date.parse(skosWorkout.end_time);
    return Number.isFinite(cs) && cs < se && ce > ss;
  });

  const sourceType = overlappingPhysio.length > 0 ? 'wearable_physiological' : 'skos_ml';
  const activeKcal = secondary?.kcal ?? null;
  const confidence = computeConfidence({
    sourceType, coverageRatio: overlappingPhysio.length > 0 ? 1 : 0, dataQuality: 'good',
  });

  return {
    activeKcal, sourceType,
    primarySource: sourceType === 'wearable_physiological' ? overlappingPhysio[0].provider : (secondary?.provider || 'skos_ml'),
    coverageRatio: overlappingPhysio.length > 0 ? 1 : 0,
    matchScore: null, matchReason: null, matchedRecordIds: overlappingPhysio.map((c) => c.id),
    wearableKcal: null, uncoveredEstimateKcal: null,
    secondaryEstimateKcal: secondary?.kcal ?? null, secondaryModel: secondary ? { name: secondary.modelName, version: secondary.modelVersion } : null,
    disagreementRatio: null, dataQualityFlag: false,
    autoDetected: false,
    confidence,
  };
}

/**
 * TEST 6/20: a wearable-detected workout with NO corresponding SK OS
 * session. Packaged as an external-workout candidate rather than
 * silently ignored.
 */
export function buildExternalWorkoutCandidate(record) {
  const confidence = computeConfidence({ sourceType: 'wearable_direct', coverageRatio: 1, dataQuality: record.data_quality === 'suspicious' ? 'suspicious' : 'good' });
  return {
    skosWorkoutId: null,
    activityType: record.activity_type,
    startTime: record.start_time,
    endTime: record.end_time,
    activeKcal: record.active_kcal ?? null,
    primarySource: record.provider,
    sourceType: 'wearable_direct',
    coverageRatio: 1,
    matchedRecordIds: [record.id],
    autoDetected: !!record.auto_detected,
    confidence,
  };
}

/**
 * TEST 9: two (or more) wearable workout records with no SK OS session,
 * describing the same physical event (e.g. WHOOP + Apple Health both
 * reported it). Groups records into clusters via mutual match score --
 * each cluster becomes ONE external canonical workout backed by every
 * record in it, never one-canonical-per-record.
 */
export function clusterWearableWorkouts(records) {
  const remaining = [...records];
  const clusters = [];
  while (remaining.length) {
    const seed = remaining.shift();
    const cluster = [seed];
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (scoreMatch(seed, remaining[i]).score >= MATCH_THRESHOLD) {
        cluster.push(remaining[i]);
        remaining.splice(i, 1);
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

/**
 * TEST 10/11: daily active-energy containment. A provider's OWN daily
 * aggregate (spec §25/§26 "energy ledger") typically already CONTAINS
 * that day's workout energy from the SAME provider -- summing the
 * aggregate with per-workout intervals would double-count it. Multiple
 * providers' daily aggregates are fused via consensus (median), never
 * summed (spec §62).
 *
 * @param {number} intervalActiveKcalSum - sum of this day's RECONCILED
 *   workout-interval active_kcal (from reconcileWorkout results above)
 * @param {{provider:string, active_kcal:number}[]} dailyAggregates -
 *   provider-reported whole-day active-energy figures, if any
 */
export function reconcileDailyEnergy({ intervalActiveKcalSum, dailyAggregates = [] }) {
  const values = dailyAggregates.map((d) => d.active_kcal).filter((v) => Number.isFinite(v));
  if (!values.length) {
    return { activeEnergy: intervalActiveKcalSum, source: 'interval_sum', reconciliationStatus: 'ok', diffRatio: null };
  }
  const consensus = median(values);
  const diffRatio = consensus > 0 ? (intervalActiveKcalSum - consensus) / consensus : 0;
  // A workout's (or any interval subset's) energy being LESS than the
  // day's own total is normal, expected containment (spec TEST 11: 300
  // inside 650 is fine, not a disagreement) -- the genuinely suspicious
  // case is the interval-based reconstruction EXCEEDING what the
  // provider says is physically possible for the whole day (spec TEST
  // 11b). Only that direction is flagged; never warn just because a
  // component is smaller than the whole.
  const reconciliationStatus = diffRatio > DAILY_RECONCILIATION_TOLERANCE ? 'warning' : 'ok';
  return {
    // The provider's own daily aggregate is authoritative when present
    // -- it already contains workout energy, so it is NOT added to
    // intervalActiveKcalSum (that would be exactly the double-count
    // TEST 11 exists to catch).
    activeEnergy: consensus,
    source: dailyAggregates.length > 1 ? 'consensus' : dailyAggregates[0].provider,
    reconciliationStatus,
    diffRatio,
    intervalActiveKcalSum,
  };
}
