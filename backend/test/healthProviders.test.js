// ============================================================
// Unit tests for the provider adapters' NORMALIZER functions
// (backend/src/services/health/providers/*.js) and the registry.
//
// Every fixture payload below is HAND-WRITTEN based on each provider's
// publicly documented API/SDK shape -- NOT a captured real response
// (this environment has no live credentials for any provider -- see
// each adapter file's own header). These tests assert the TRANSFORM
// logic is correct given a representative shape; they do NOT prove the
// adapter is compatible with the live API today.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import whoop from '../src/services/health/providers/whoopProvider.js';
import oura from '../src/services/health/providers/ouraProvider.js';
import appleHealth from '../src/services/health/providers/appleHealthProvider.js';
import healthConnect from '../src/services/health/providers/healthConnectProvider.js';
import samsungHealth from '../src/services/health/providers/samsungHealthProvider.js';
import { getProvider, listProviders } from '../src/services/health/providers/registry.js';
import { ProviderNotConfiguredError, RequiresNativeAppError } from '../src/services/health/providers/baseProvider.js';
import { PROVIDERS } from '../src/services/health/types.js';

test('registry lists all ten architected providers', () => {
  const keys = listProviders().map((p) => p.key).sort();
  assert.deepEqual(keys, [...PROVIDERS].sort());
});

test('getProvider throws on an unknown key rather than returning undefined', () => {
  assert.throws(() => getProvider('not_a_real_provider'));
});

test('WHOOP: connect() without credentials throws ProviderNotConfiguredError, never a fake URL', () => {
  assert.throws(() => whoop.getAuthorizeUrl('state', 'https://example.test/callback'), ProviderNotConfiguredError);
});

test('WHOOP: normalizeWorkout converts kilojoules to kcal and keeps source_score/source_metric distinct (never renamed)', () => {
  const raw = { id: 'whoop-1', start: '2026-01-01T18:00:00Z', end: '2026-01-01T18:58:00Z', sport_id: 45, score_state: 'SCORED', score: { strain: 12.4, average_heart_rate: 138, max_heart_rate: 165, kilojoule: 1339 } };
  const n = whoop.normalizeWorkout(raw);
  assert.equal(n.provider, 'whoop');
  assert.equal(n.activity_type, 'strength_training');
  assert.ok(Math.abs(n.active_kcal - 1339 / 4.184) < 0.01);
  assert.equal(n.source_score, 12.4);
  assert.equal(n.source_metric, 'strain');
  assert.equal(n.auto_detected, true);
  assert.equal(n.data_quality, 'good');
});

test('WHOOP: an unscored workout is flagged, not silently treated as good data', () => {
  const raw = { id: 'whoop-2', start: '2026-01-01T18:00:00Z', end: '2026-01-01T18:30:00Z', sport_id: 0, score_state: 'PENDING_SCORE', score: {} };
  const n = whoop.normalizeWorkout(raw);
  assert.equal(n.data_quality, 'flagged');
});

test('WHOOP: normalizeRecovery stores WHOOP\'s own recovery score as source_score, never as an SK OS score field', () => {
  const raw = { cycle_id: 'c1', created_at: '2026-01-01T06:00:00Z', score_state: 'SCORED', score: { recovery_score: 68, resting_heart_rate: 52, hrv_rmssd_milli: 45.2 } };
  const n = whoop.normalizeRecovery(raw);
  assert.equal(n.source_score, 68);
  assert.equal(n.source_metric, 'recovery');
  assert.equal(n.resting_hr, 52);
});

test('WHOOP: verifyWebhookSignature accepts a correctly-signed payload, rejects a tampered one, and fails closed with no secret', async (t) => {
  const { config } = await import('../src/config.js');
  const originalSecret = config.whoopClientSecret;
  t.after(() => { config.whoopClientSecret = originalSecret; });

  const crypto = await import('node:crypto');
  config.whoopClientSecret = 'unit-test-secret';
  const body = JSON.stringify({ user_id: 123, id: 'e1', type: 'workout.updated', trace_id: 't1' });
  const timestamp = '1700000000000';
  const goodSignature = crypto.createHmac('sha256', 'unit-test-secret').update(`${timestamp}${body}`).digest('base64');

  assert.equal(whoop.verifyWebhookSignature(body, goodSignature, timestamp), true);
  assert.equal(whoop.verifyWebhookSignature(body, goodSignature.slice(0, -2) + 'xx', timestamp), false, 'a tampered signature must never verify');
  assert.equal(whoop.verifyWebhookSignature(body, goodSignature, '1700000099999'), false, 'a mismatched timestamp changes the signed string -- must not verify');
  assert.equal(whoop.verifyWebhookSignature(body, null, timestamp), false, 'a missing signature must never verify');

  config.whoopClientSecret = null;
  assert.equal(whoop.verifyWebhookSignature(body, goodSignature, timestamp), false, 'must fail closed with no secret configured, never fall back to a guessable default');
});

test('Oura: normalizeWorkout distinguishes auto-detected from manual (spec §9)', () => {
  const auto = oura.normalizeWorkout({ id: 'o1', activity: 'running', calories: 320, distance: 5000, start_datetime: '2026-01-01T07:00:00Z', end_datetime: '2026-01-01T07:40:00Z', source: 'autodetected' });
  const manual = oura.normalizeWorkout({ id: 'o2', activity: 'strength_training', calories: 250, start_datetime: '2026-01-01T18:00:00Z', end_datetime: '2026-01-01T18:45:00Z', source: 'manual' });
  assert.equal(auto.auto_detected, true);
  assert.equal(auto.user_entered, false);
  assert.equal(manual.auto_detected, false);
  assert.equal(manual.user_entered, true);
});

test('Oura: normalizeDailyActivity keeps active_calories and total_calories as separate fields (spec §24)', () => {
  const [n] = oura.normalizeDailyActivity({ day: '2026-01-01', active_calories: 640, total_calories: 2180, steps: 8421, equivalent_walking_distance: 6200 });
  assert.equal(n.active_kcal, 640);
  assert.equal(n.total_kcal, 2180);
  assert.notEqual(n.active_kcal, n.total_kcal);
  assert.equal(n.steps, 8421);
});

test('Oura: normalizeReadiness stores Oura\'s own readiness score as source_score, never SK OS readiness', () => {
  const n = oura.normalizeReadiness({ day: '2026-01-01', score: 82, contributors: { resting_heart_rate: 54, hrv_balance: 41 } });
  assert.equal(n.source_score, 82);
  assert.equal(n.source_metric, 'readiness');
});

test('Oura: connect() without credentials throws ProviderNotConfiguredError', () => {
  assert.throws(() => oura.getAuthorizeUrl('state', 'https://example.test/callback'), ProviderNotConfiguredError);
});

test('Apple Health: nativeOnly provider always throws RequiresNativeAppError on connect, never fakes success', () => {
  assert.equal(appleHealth.nativeOnly, true);
  assert.throws(() => appleHealth.getAuthorizeUrl(), RequiresNativeAppError);
});

test('Apple Health: normalizeWorkout never adds active energy into resting energy (spec §5)', () => {
  const n = appleHealth.normalizeWorkout({ uuid: 'a1', workoutActivityType: 'traditionalStrengthTraining', startDate: '2026-01-01T18:00:00Z', endDate: '2026-01-01T18:58:00Z', duration: 3480, totalEnergyBurned: { unit: 'kcal', value: 312 } });
  assert.equal(n.active_kcal, 312);
  assert.equal(n.resting_kcal, undefined, 'workout normalizer must not fabricate a resting figure');
});

test('Apple Health: normalizeQuantitySample keeps activeEnergyBurned and basalEnergyBurned as SEPARATE data points', () => {
  const active = appleHealth.normalizeQuantitySample({ uuid: 'q1', quantityType: 'activeEnergyBurned', startDate: '2026-01-01T00:00:00Z', endDate: '2026-01-01T23:59:59Z', quantity: { unit: 'kcal', value: 640 } });
  const basal = appleHealth.normalizeQuantitySample({ uuid: 'q2', quantityType: 'basalEnergyBurned', startDate: '2026-01-01T00:00:00Z', endDate: '2026-01-01T23:59:59Z', quantity: { unit: 'kcal', value: 1540 } });
  assert.equal(active.active_kcal, 640);
  assert.equal(active.resting_kcal, undefined);
  assert.equal(basal.resting_kcal, 1540);
  assert.equal(basal.active_kcal, undefined);
});

test('Apple Health: an unrecognized quantity type is dropped (returns null), never guessed', () => {
  const n = appleHealth.normalizeQuantitySample({ uuid: 'q3', quantityType: 'someFutureAppleType', startDate: '2026-01-01T00:00:00Z', endDate: '2026-01-01T00:01:00Z', quantity: { unit: 'x', value: 1 } });
  assert.equal(n, null);
});

test('Health Connect: nativeOnly, and ExerciseSessionRecord carries no energy of its own (spec §6)', () => {
  assert.equal(healthConnect.nativeOnly, true);
  const n = healthConnect.normalizeExerciseSession({ metadata: { id: 'hc1' }, exerciseType: 'EXERCISE_TYPE_RUNNING', startTime: '2026-01-01T07:00:00Z', endTime: '2026-01-01T07:30:00Z' });
  assert.equal(n.data_type, 'workout');
  assert.equal(n.active_kcal, undefined, 'a session record alone has no energy figure -- must come from a separate ActiveCaloriesBurnedRecord');
});

test('Health Connect: ActiveCaloriesBurnedRecord and TotalCaloriesBurnedRecord stay distinct', () => {
  const active = healthConnect.normalizeActiveCalories({ metadata: { id: 'e1' }, startTime: '2026-01-01T07:00:00Z', endTime: '2026-01-01T07:30:00Z', energy: { value: 250, unit: 'kilocalories' } });
  const total = healthConnect.normalizeTotalCalories({ metadata: { id: 't1' }, startTime: '2026-01-01T07:00:00Z', endTime: '2026-01-01T07:30:00Z', energy: { value: 310, unit: 'kilocalories' } });
  assert.equal(active.active_kcal, 250);
  assert.equal(total.total_kcal, 310);
});

test('Samsung Health: nativeOnly, connect() throws RequiresNativeAppError', () => {
  assert.equal(samsungHealth.nativeOnly, true);
  assert.throws(() => samsungHealth.getAuthorizeUrl(), RequiresNativeAppError);
});

test('every provider advertises capabilities using only keys from the shared vocabulary', () => {
  const validKeys = new Set(['workouts', 'autoDetectedWorkouts', 'activeEnergy', 'totalEnergy', 'restingEnergy',
    'heartRate', 'steps', 'distance', 'sleep', 'recovery', 'hrv', 'restingHeartRate',
    'respiratoryRate', 'spo2', 'bodyTemperature', 'bodyMetrics', 'vo2max', 'routes']);
  for (const p of listProviders()) {
    for (const k of Object.keys(p.capabilities)) {
      assert.ok(validKeys.has(k), `${p.key} advertises unknown capability "${k}"`);
    }
  }
});
