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

function fakeMl(kcal) {
  return async (durationSeconds) => ({ kcal: kcal * (durationSeconds / 3600), modelName: 'skos-cal-v1', modelVersion: 'test', provider: 'skos_ml' });
}

test('TEST 1 -- SK OS workout, no wearable at all -> SK OS ML', async () => {
  const r = await reconcileWorkout(SKOS_WORKOUT, [], { estimateMl: fakeMl(330) });
  assert.equal(r.sourceType, 'skos_ml');
  assert.equal(r.coverageRatio, 0);
  assert.ok(r.activeKcal > 0);
});

test('TEST 2 -- full-coverage wearable workout -> wearable primary, NOT wearable+ML summed', async () => {
  const candidates = [{ id: 'r1', data_type: 'workout', provider: 'apple_health', start_time: '2026-01-01T18:00:00Z', end_time: '2026-01-01T19:00:00Z', activity_type: 'strength_training', active_kcal: 300 }];
  const r = await reconcileWorkout(SKOS_WORKOUT, candidates, { estimateMl: fakeMl(330) });
  assert.equal(r.sourceType, 'wearable_direct');
  assert.equal(r.primarySource, 'apple_health');
  assert.equal(r.activeKcal, 300, 'must be exactly the wearable figure, not 300+330');
  assert.equal(r.uncoveredEstimateKcal, null);
});

test('TEST 3 -- partial coverage (18:08-18:52 of 18:00-19:00) -> ML only fills the genuine gap', async () => {
  const candidates = [{ id: 'r1', data_type: 'workout', provider: 'apple_health', start_time: '2026-01-01T18:08:00Z', end_time: '2026-01-01T18:52:00Z', activity_type: 'strength_training', active_kcal: 250 }];
  const r = await reconcileWorkout(SKOS_WORKOUT, candidates, { estimateMl: fakeMl(330) });
  assert.equal(r.sourceType, 'wearable_direct');
  assert.ok(r.coverageRatio < 0.9);
  assert.equal(r.wearableKcal, 250);
  assert.ok(r.uncoveredEstimateKcal > 0, 'the 16 uncovered minutes must be estimated');
  // 16 min of a 330 kcal/hr rate ~= 88 kcal
  assert.ok(Math.abs(r.uncoveredEstimateKcal - 330 * (16 / 60)) < 1);
  assert.equal(r.activeKcal, 250 + r.uncoveredEstimateKcal);
});

test('TEST 4 -- no wearable workout, but overlapping physiological evidence -> use it, not pure fallback', async () => {
  const candidates = [{ id: 'hr1', data_type: 'heart_rate', provider: 'apple_health', start_time: '2026-01-01T18:10:00Z', end_time: '2026-01-01T18:40:00Z', heart_rate_avg: 140 }];
  const r = await reconcileWorkout(SKOS_WORKOUT, candidates, { estimateMl: fakeMl(330) });
  assert.equal(r.sourceType, 'wearable_physiological');
  assert.equal(r.coverageRatio, 1);
  assert.equal(r.matchedRecordIds.length, 1);
});

test('TEST 5 -- auto-detected wearable workout overlapping SK OS session matches automatically', async () => {
  const candidates = [{ id: 'r1', data_type: 'workout', provider: 'whoop', start_time: '2026-01-01T18:05:00Z', end_time: '2026-01-01T18:52:00Z', activity_type: 'strength_training', active_kcal: 280, auto_detected: true }];
  const r = await reconcileWorkout(SKOS_WORKOUT, candidates, { estimateMl: fakeMl(330) });
  assert.equal(r.autoDetected, true);
  assert.equal(r.primarySource, 'whoop');
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
  const candidates = [{ id: 'r1', data_type: 'workout', provider: 'apple_health', start_time: '2026-01-01T18:00:00Z', end_time: '2026-01-01T19:00:00Z', activity_type: 'strength_training', active_kcal: null, total_kcal: 900 }];
  const r = await reconcileWorkout(SKOS_WORKOUT, candidates, { estimateMl: fakeMl(330) });
  assert.equal(r.wearableKcal, null, 'active_kcal was null; total_kcal must never substitute for it');
});

test('TEST 14 -- wearable primary AND SK OS ML retained as secondary evidence, not discarded', async () => {
  const candidates = [{ id: 'r1', data_type: 'workout', provider: 'apple_health', start_time: '2026-01-01T18:00:00Z', end_time: '2026-01-01T19:00:00Z', activity_type: 'strength_training', active_kcal: 350 }];
  const r = await reconcileWorkout(SKOS_WORKOUT, candidates, { estimateMl: fakeMl(340) });
  assert.equal(r.activeKcal, 350);
  assert.equal(r.primarySource, 'apple_health');
  assert.equal(r.secondaryEstimateKcal, 340, 'SK OS ML estimate must still be present for comparison');
});

test('TEST 15 -- large wearable-vs-ML discrepancy is flagged, never blindly averaged', async () => {
  const candidates = [{ id: 'r1', data_type: 'workout', provider: 'apple_health', start_time: '2026-01-01T18:00:00Z', end_time: '2026-01-01T19:00:00Z', activity_type: 'strength_training', active_kcal: 350 }];
  const r = await reconcileWorkout(SKOS_WORKOUT, candidates, { estimateMl: fakeMl(900) });
  assert.equal(r.activeKcal, 350, 'wearable stays primary -- never averaged with the ML figure');
  assert.notEqual(r.activeKcal, (350 + 900) / 2);
  assert.equal(r.dataQualityFlag, true);
  assert.equal(r.confidence.level, 'low', 'a flagged large disagreement should not read as high confidence');
});
