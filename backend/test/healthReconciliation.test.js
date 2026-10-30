// ============================================================
// Unit tests for the EnergyReconciliationEngine
// (backend/src/services/health/reconciliation.js) -- directly implements
// the spec's own TEST 1-15 (§90). Pure functions, no DB: `estimateMl` is
// a fake injected per test, standing in for calorieModel.js's real
// estimateWorkoutCalories().
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileWorkout, buildExternalWorkoutCandidate, clusterWearableWorkouts, reconcileDailyEnergy,
} from '../src/services/health/reconciliation.js';

const SKOS_WORKOUT = { start_time: '2026-01-01T18:00:00Z', end_time: '2026-01-01T19:00:00Z', activity_type: 'strength_training' };
// A non-strength session logged in SK OS: keeps the original wearable-
// primary reconciliation (product decision only covers strength).
const CARDIO_WORKOUT = { ...SKOS_WORKOUT, activity_type: 'running' };
const wearableWorkout = (over = {}) => ({
  id: 'r1', data_type: 'workout', provider: 'apple_health', start_time: '2026-01-01T18:00:00Z', end_time: '2026-01-01T19:00:00Z',
  activity_type: 'strength_training', active_kcal: 300, ...over,
});

function fakeMl(kcal, provider = 'baseline') {
  return async (durationSeconds) => ({ kcal: kcal * (durationSeconds / 3600), modelName: 'skos-cal', modelVersion: 'test', provider });
}

test('TEST 1 -- SK OS workout, no wearable at all -> SK OS ML', async () => {
  const r = await reconcileWorkout(SKOS_WORKOUT, [], { estimateMl: fakeMl(330) });
  assert.equal(r.sourceType, 'skos_ml');
  assert.equal(r.coverageRatio, 0);
  assert.ok(r.activeKcal > 0);
});

test('TEST 6 -- no SK OS workout, wearable auto-detects one -> external workout candidate', () => {
  const record = { id: 'r1', provider: 'apple_health', activity_type: 'running', start_time: '2026-01-01T07:00:00Z', end_time: '2026-01-01T07:40:00Z', active_kcal: 320, auto_detected: true };
  const candidate = buildExternalWorkoutCandidate(record);
  assert.equal(candidate.skosWorkoutId, null);
  assert.equal(candidate.activeKcal, 320);
  assert.equal(candidate.primarySource, 'apple_health');
  assert.equal(candidate.autoDetected, true);
});

test('TEST 9 -- WHOOP + Apple Health report the same workout -> ONE cluster, not two', () => {
  const whoop = { id: 'w1', provider: 'whoop', activity_type: 'running', start_time: '2026-01-01T07:00:00Z', end_time: '2026-01-01T07:40:00Z', active_kcal: 320 };
  const apple = { id: 'a1', provider: 'apple_health', activity_type: 'running', start_time: '2026-01-01T07:02:00Z', end_time: '2026-01-01T07:38:00Z', active_kcal: 305 };
  const unrelated = { id: 'u1', provider: 'apple_health', activity_type: 'walking', start_time: '2026-01-01T12:00:00Z', end_time: '2026-01-01T12:20:00Z', active_kcal: 60 };
  const clusters = clusterWearableWorkouts([whoop, apple, unrelated]);
  assert.equal(clusters.length, 2, 'the matching pair collapses into one cluster; the unrelated walk is its own');
  const pairCluster = clusters.find((c) => c.length === 2);
  assert.ok(pairCluster, 'whoop+apple should be clustered together');
  assert.deepEqual(new Set(pairCluster.map((r) => r.id)), new Set(['w1', 'a1']));
});

test('TEST 10 -- Apple 600 + WHOOP 620 daily active -> ONE canonical estimate via consensus, NOT 1220', () => {
  const r = reconcileDailyEnergy({ intervalActiveKcalSum: 0, dailyAggregates: [{ provider: 'apple_health', active_kcal: 600 }, { provider: 'whoop', active_kcal: 620 }] });
  assert.equal(r.activeEnergy, 610, 'median of 600/620');
  assert.notEqual(r.activeEnergy, 1220);
});

test('TEST 11 -- daily aggregate (650) already contains a 300kcal workout -> not added again', () => {
  // intervalActiveKcalSum here represents "300" (the workout's own
  // reconciled total) -- the daily provider aggregate (650) already
  // contains it, so the final activeEnergy must be 650, not 950.
  const r = reconcileDailyEnergy({ intervalActiveKcalSum: 300, dailyAggregates: [{ provider: 'apple_health', active_kcal: 650 }] });
  assert.equal(r.activeEnergy, 650);
  assert.notEqual(r.activeEnergy, 950);
  assert.equal(r.reconciliationStatus, 'ok');
});

test('TEST 11b -- if the aggregate and interval sum disagree wildly, flag a warning (never silently fabricate)', () => {
  const r = reconcileDailyEnergy({ intervalActiveKcalSum: 900, dailyAggregates: [{ provider: 'apple_health', active_kcal: 200 }] });
  assert.equal(r.reconciliationStatus, 'warning');
});

test('no wearable + no dailyAggregates -> falls back to the interval sum, not zero', () => {
  const r = reconcileDailyEnergy({ intervalActiveKcalSum: 450, dailyAggregates: [] });
  assert.equal(r.activeEnergy, 450);
  assert.equal(r.source, 'interval_sum');
});

test('TEST 13 -- a record reporting TOTAL energy must never be read as active energy', async () => {
  // The candidate here has total_kcal set but active_kcal null -- the
  // matching/reconciliation code must not fall back to reading total_kcal.
  for (const workout of [SKOS_WORKOUT, CARDIO_WORKOUT]) {
    const r = await reconcileWorkout(workout, [wearableWorkout({ active_kcal: null, total_kcal: 900 })], { estimateMl: fakeMl(330) });
    assert.equal(r.wearableKcal, null, 'active_kcal was null; total_kcal must never substitute for it');
  }
});

// ---------------------------------------------------------------
// STRENGTH SESSIONS -- product decision (docs/WEARABLE_RECONCILIATION_
// DECISION.md): BARBELL's estimate is the stored figure; a wearable's own
// figure is kept beside it with provenance, compared, flagged past 40%,
// never averaged in and never a reason to raise confidence. These replace
// the earlier "wearable wins" tests for strength sessions; the same
// scenarios for non-strength sessions are kept further down.
// ---------------------------------------------------------------
test('STRENGTH -- the live case, BARBELL 420 vs WHOOP 327: BARBELL stays primary, WHOOP kept separately', async () => {
  const whoop = [wearableWorkout({ id: 'w1', provider: 'whoop', active_kcal: 327, auto_detected: true })];
  const r = await reconcileWorkout(SKOS_WORKOUT, whoop, { estimateMl: fakeMl(420) });

  assert.equal(Math.round(r.activeKcal), 420, 'the stored figure is BARBELL’s estimate');
  assert.equal(r.primarySource, 'baseline', 'attributed to the BARBELL provider that produced it');
  assert.equal(r.sourceType, 'skos_ml');
  assert.equal(r.energyBasis, 'model_estimate');
  assert.equal(r.policy, 'barbell_primary_strength_v1');
  assert.notEqual(Math.round(r.activeKcal), 747, 'never summed');
  assert.notEqual(Math.round(r.activeKcal), Math.round((420 + 327) / 2), 'never averaged');
  assert.equal(r.wearable.kcal, 327, 'the WHOOP figure is preserved as reported');
  assert.equal(r.wearable.provider, 'whoop');
  assert.equal(r.wearable.measurementType, 'device_estimate');
  assert.equal(r.wearable.coverageRatio, 1);
  assert.equal(r.autoDetected, true);
  assert.deepEqual(r.matchedRecordIds, ['w1'], 'the wearable record is linked to the session');
  // |420-327| / 420 = 22%: recorded, below the 40% monitoring flag.
  assert.ok(Math.abs(r.disagreementRatio - 93 / 420) < 1e-9);
  assert.equal(r.disagreementFlag, false);
  assert.equal(r.dataQualityFlag, false);
});

test('STRENGTH -- the mirror case, WHOOP 420 vs BARBELL 327: still BARBELL, whichever is larger', async () => {
  const r = await reconcileWorkout(SKOS_WORKOUT, [wearableWorkout({ provider: 'whoop', active_kcal: 420 })], { estimateMl: fakeMl(327) });
  assert.equal(Math.round(r.activeKcal), 327);
  assert.equal(r.wearable.kcal, 420);
  assert.ok(Math.abs(r.disagreementRatio - 93 / 420) < 1e-9, 'symmetric: same ratio either way round');
});

test('STRENGTH -- a disagreement over 40% is flagged for monitoring, and changes nothing else', async () => {
  const r = await reconcileWorkout(SKOS_WORKOUT, [wearableWorkout({ active_kcal: 350 })], { estimateMl: fakeMl(900) });
  assert.equal(Math.round(r.activeKcal), 900, 'neither figure is assumed correct: BARBELL’s stays as stored');
  assert.equal(r.disagreementFlag, true);
  assert.ok(r.disagreementRatio > 0.4);
  assert.equal(r.dataQualityFlag, false, 'a monitoring flag, not a verdict that the data is bad');
  const quiet = await reconcileWorkout(SKOS_WORKOUT, [], { estimateMl: fakeMl(900) });
  assert.deepEqual(r.confidence, quiet.confidence, 'confidence is not moved by the wearable in either direction');
});

test('STRENGTH -- a wearable covering the session does not raise confidence', async () => {
  const none = await reconcileWorkout(SKOS_WORKOUT, [], { estimateMl: fakeMl(330) });
  const agreeing = await reconcileWorkout(SKOS_WORKOUT, [wearableWorkout({ active_kcal: 330 })], { estimateMl: fakeMl(330) });
  assert.equal(agreeing.disagreementRatio, 0);
  assert.deepEqual(agreeing.confidence, none.confidence, 'full coverage and exact agreement still validate nothing');
});

test('STRENGTH -- a wearable workout with NO calories: kept as evidence, no comparison invented', async () => {
  const r = await reconcileWorkout(SKOS_WORKOUT, [wearableWorkout({ active_kcal: null })], { estimateMl: fakeMl(330) });
  assert.equal(Math.round(r.activeKcal), 330);
  assert.equal(r.wearable.kcal, null);
  assert.equal(r.wearable.measurementType, 'device_workout_without_energy');
  assert.equal(r.disagreementRatio, null);
  assert.equal(r.disagreementFlag, false);
});

test('STRENGTH -- heart-rate samples only: never named as the source of BARBELL’s estimate', async () => {
  const hr = [{ id: 'hr1', data_type: 'heart_rate', provider: 'apple_health', source_device: 'Watch7,1', start_time: '2026-01-01T18:10:00Z', end_time: '2026-01-01T18:40:00Z', heart_rate_avg: 140 }];
  const r = await reconcileWorkout(SKOS_WORKOUT, hr, { estimateMl: fakeMl(330) });
  const none = await reconcileWorkout(SKOS_WORKOUT, [], { estimateMl: fakeMl(330) });
  assert.equal(r.primarySource, 'baseline', 'the estimate is attributed to BARBELL, not to apple_health');
  assert.equal(r.sourceType, 'skos_ml');
  assert.equal(r.energyBasis, 'model_estimate');
  assert.equal(Math.round(r.activeKcal), 330);
  assert.equal(r.wearable.measurementType, 'heart_rate_only');
  assert.equal(r.wearable.kcal, null);
  assert.equal(r.wearable.sourceDevice, 'Watch7,1', 'device identity preserved');
  assert.equal(r.coverageRatio, 0.5, 'the samples span 30 of 60 minutes');
  assert.deepEqual(r.matchedRecordIds, ['hr1']);
  assert.deepEqual(r.confidence, none.confidence, 'HR samples do not raise confidence');
});

test('STRENGTH -- incomplete coverage: compared like-for-like, never gap-filled into a hybrid', async () => {
  // WHOOP recorded only the middle 30 minutes of a 60-minute session.
  const partial = [wearableWorkout({ provider: 'whoop', start_time: '2026-01-01T18:15:00Z', end_time: '2026-01-01T18:45:00Z', active_kcal: 160 })];
  const r = await reconcileWorkout(SKOS_WORKOUT, partial, { estimateMl: fakeMl(420) });
  assert.equal(Math.round(r.activeKcal), 420, 'the whole-session figure is BARBELL’s, not WHOOP + gap fill');
  assert.equal(r.uncoveredEstimateKcal, null);
  assert.equal(r.wearable.coverageRatio, 0.5);
  assert.equal(Math.round(r.wearable.comparedBarbellKcal), 210, 'compared with BARBELL’s estimate for the same 30 minutes');
  assert.ok(Math.abs(r.disagreementRatio - 50 / 210) < 1e-9);
});

test('STRENGTH -- a wearable record running well past the session is not compared at all', async () => {
  // 18:00-20:00 record against an 18:00-19:00 session: its 500 kcal covers an hour BARBELL never saw.
  const long = [wearableWorkout({ end_time: '2026-01-01T20:00:00Z', active_kcal: 500 })];
  const r = await reconcileWorkout(SKOS_WORKOUT, long, { estimateMl: fakeMl(330) });
  assert.equal(r.wearable.kcal, 500, 'still preserved as reported');
  assert.equal(r.disagreementRatio, null, 'different intervals: no disagreement figure');
  assert.equal(r.disagreementFlag, false);
});

test('STRENGTH -- source attribution: device and app identity carried from the record', async () => {
  const rec = wearableWorkout({ source_device: 'Apple Watch Series 9', source_app: 'com.apple.health' });
  const r = await reconcileWorkout(SKOS_WORKOUT, [rec], { estimateMl: fakeMl(330, 'ml') });
  assert.equal(r.primarySource, 'ml', 'the estimate names the BARBELL provider that ran');
  assert.equal(r.wearable.provider, 'apple_health');
  assert.equal(r.wearable.sourceDevice, 'Apple Watch Series 9');
  assert.equal(r.wearable.sourceApp, 'com.apple.health');
});

test('STRENGTH -- two wearables on one session: one median wearable figure, still not primary', async () => {
  const both = [wearableWorkout({ id: 'a', active_kcal: 300 }), wearableWorkout({ id: 'b', provider: 'whoop', active_kcal: 340 })];
  const r = await reconcileWorkout(SKOS_WORKOUT, both, { estimateMl: fakeMl(330) });
  assert.equal(Math.round(r.activeKcal), 330);
  assert.equal(r.wearable.kcal, 320, 'median of 300 and 340, never their sum');
});

// ---------------------------------------------------------------
// NON-STRENGTH SESSIONS -- unchanged wearable-primary reconciliation
// (requirement: preserve cardio behaviour until separately validated).
// These are the original TEST 2/3/5/14/15 assertions.
// ---------------------------------------------------------------
test('NON-STRENGTH TEST 2 -- full-coverage wearable workout -> wearable primary, NOT wearable+ML summed', async () => {
  const r = await reconcileWorkout(CARDIO_WORKOUT, [wearableWorkout({ activity_type: 'running' })], { estimateMl: fakeMl(330) });
  assert.equal(r.sourceType, 'wearable_direct');
  assert.equal(r.primarySource, 'apple_health');
  assert.equal(r.activeKcal, 300, 'must be exactly the wearable figure, not 300+330');
  assert.equal(r.uncoveredEstimateKcal, null);
  assert.equal(r.energyBasis, 'device_estimate', 'labelled as the device’s estimate, not a measurement');
});

test('NON-STRENGTH TEST 3 -- partial coverage -> ML only fills the genuine gap', async () => {
  const partial = [wearableWorkout({ activity_type: 'running', start_time: '2026-01-01T18:08:00Z', end_time: '2026-01-01T18:52:00Z', active_kcal: 250 })];
  const r = await reconcileWorkout(CARDIO_WORKOUT, partial, { estimateMl: fakeMl(330) });
  assert.equal(r.sourceType, 'wearable_direct');
  assert.ok(r.coverageRatio < 0.9);
  assert.equal(r.wearableKcal, 250);
  assert.ok(Math.abs(r.uncoveredEstimateKcal - 330 * (16 / 60)) < 1);
  assert.equal(r.activeKcal, 250 + r.uncoveredEstimateKcal);
});

test('NON-STRENGTH TEST 5 -- auto-detected wearable workout overlapping the session matches automatically', async () => {
  const r = await reconcileWorkout(CARDIO_WORKOUT, [wearableWorkout({ provider: 'whoop', activity_type: 'running', start_time: '2026-01-01T18:05:00Z', end_time: '2026-01-01T18:52:00Z', active_kcal: 280, auto_detected: true })], { estimateMl: fakeMl(330) });
  assert.equal(r.autoDetected, true);
  assert.equal(r.primarySource, 'whoop');
});

test('NON-STRENGTH TEST 14/15 -- SK OS estimate kept as secondary; a large discrepancy is flagged, never averaged', async () => {
  const r = await reconcileWorkout(CARDIO_WORKOUT, [wearableWorkout({ activity_type: 'running', active_kcal: 350 })], { estimateMl: fakeMl(900) });
  assert.equal(r.activeKcal, 350);
  assert.equal(r.secondaryEstimateKcal, 900);
  assert.notEqual(r.activeKcal, (350 + 900) / 2);
  assert.equal(r.dataQualityFlag, true);
  assert.equal(r.confidence.level, 'low');
});

test('NON-STRENGTH TEST 4 -- heart-rate samples only: kept as evidence, the estimate keeps its own label and confidence', async () => {
  const hr = [{ id: 'hr1', data_type: 'heart_rate', provider: 'apple_health', start_time: '2026-01-01T18:10:00Z', end_time: '2026-01-01T18:40:00Z', heart_rate_avg: 140 }];
  const r = await reconcileWorkout(CARDIO_WORKOUT, hr, { estimateMl: fakeMl(330) });
  const none = await reconcileWorkout(CARDIO_WORKOUT, [], { estimateMl: fakeMl(330) });
  assert.equal(r.sourceType, 'skos_ml');
  assert.equal(r.primarySource, 'baseline', 'was mislabelled apple_health before this fix');
  assert.equal(r.activeKcal, none.activeKcal, 'the figure itself is unchanged');
  assert.deepEqual(r.confidence, none.confidence);
  assert.equal(r.wearable.measurementType, 'heart_rate_only');
  assert.deepEqual(r.matchedRecordIds, ['hr1']);
});
