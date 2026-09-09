// ============================================================
// ANDROID HEALTH CONNECT PROVIDER ADAPTER.
//
// nativeOnly: true -- Health Connect is an on-device Android API
// (androidx.health.connect); permissions are granted via a native
// Android permission flow, not web OAuth (spec §6/§67/§106). Same
// treatment as appleHealthProvider.js: connect() always throws
// RequiresNativeAppError, and the normalizer functions below define the
// CONTRACT a future Android native bridge would serialize records into,
// modeled directly on Health Connect's documented record types
// (ExerciseSessionRecord, ActiveCaloriesBurnedRecord,
// TotalCaloriesBurnedRecord, HeartRateRecord, StepsRecord,
// DistanceRecord, SleepSessionRecord) -- never a captured real response.
//
// Health Connect data is interval-based and a session record does NOT
// necessarily carry its own complete energy figure (spec §6) -- a
// session must be combined with any ActiveCaloriesBurnedRecord /
// TotalCaloriesBurnedRecord whose interval overlaps it. That combination
// is the reconciliation engine's job (matching.js/reconciliation.js);
// this file only normalizes each record type independently.
// ============================================================
import { nativeOnlyProvider } from './baseProvider.js';

/** ExerciseSessionRecord -> CanonicalHealthRecordInput. Shape assumed:
 *  { metadata: { id }, exerciseType, startTime, endTime, title? }.
 *  Deliberately carries NO energy field of its own -- see file header. */
function normalizeExerciseSession(raw) {
  return {
    provider: 'health_connect',
    provider_record_id: raw.metadata?.id,
    data_type: 'workout',
    activity_type: hcExerciseTypeToActivityType(raw.exerciseType),
    start_time: raw.startTime,
    end_time: raw.endTime,
    auto_detected: raw.exerciseRoute == null && raw.title == null, // heuristic only -- Health Connect doesn't expose an explicit auto-detected flag the way WHOOP/Oura do
    data_quality: 'good',
  };
}

/** ActiveCaloriesBurnedRecord -> CanonicalHealthRecordInput. Shape
 *  assumed: { metadata: { id }, startTime, endTime, energy: { value, unit } }. */
function normalizeActiveCalories(raw) {
  return {
    provider: 'health_connect',
    provider_record_id: raw.metadata?.id,
    data_type: 'energy_sample',
    start_time: raw.startTime,
    end_time: raw.endTime,
    active_kcal: energyToKcal(raw.energy),
    data_quality: 'good',
  };
}

/** TotalCaloriesBurnedRecord -> CanonicalHealthRecordInput -- kept
 *  distinct from active (spec §24: never conflate total with active). */
function normalizeTotalCalories(raw) {
  return {
    provider: 'health_connect',
    provider_record_id: raw.metadata?.id,
    data_type: 'energy_sample',
    start_time: raw.startTime,
    end_time: raw.endTime,
    total_kcal: energyToKcal(raw.energy),
    data_quality: 'good',
  };
}

function normalizeHeartRate(raw) {
  const samples = raw.samples || [];
  const values = samples.map((s) => Number(s.beatsPerMinute)).filter(Number.isFinite);
  return {
    provider: 'health_connect',
    provider_record_id: raw.metadata?.id,
    data_type: 'heart_rate',
    start_time: raw.startTime,
    end_time: raw.endTime,
    heart_rate_avg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    heart_rate_min: values.length ? Math.min(...values) : null,
    heart_rate_max: values.length ? Math.max(...values) : null,
    data_quality: 'good',
  };
}

function normalizeSteps(raw) {
  return {
    provider: 'health_connect',
    provider_record_id: raw.metadata?.id,
    data_type: 'steps',
    start_time: raw.startTime,
    end_time: raw.endTime,
    steps: numOrNull(raw.count),
    data_quality: 'good',
  };
}

function normalizeSleepSession(raw) {
  const startMs = Date.parse(raw.startTime);
  const endMs = Date.parse(raw.endTime);
  return {
    provider: 'health_connect',
    provider_record_id: raw.metadata?.id,
    data_type: 'sleep',
    start_time: raw.startTime,
    end_time: raw.endTime,
    sleep_duration_seconds: Number.isFinite(startMs) && Number.isFinite(endMs) ? (endMs - startMs) / 1000 : null,
    sleep_stages_json: raw.stages ? JSON.stringify(raw.stages) : null,
    data_quality: 'good',
  };
}

function energyToKcal(energy) {
  const v = numOrNull(energy?.value);
  if (v == null) return null;
  if (energy.unit === 'kilojoules') return v / 4.184;
  return v; // 'kilocalories' or unspecified
}
function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function hcExerciseTypeToActivityType(t) {
  // Health Connect's ExerciseType is a large numeric/string enum --
  // mapping only the handful needed here; unmapped -> 'other'.
  const MAP = {
    EXERCISE_TYPE_STRENGTH_TRAINING: 'strength_training', EXERCISE_TYPE_RUNNING: 'running',
    EXERCISE_TYPE_WALKING: 'walking', EXERCISE_TYPE_BIKING: 'cycling',
    EXERCISE_TYPE_SWIMMING_POOL: 'swimming', EXERCISE_TYPE_ROWING: 'rowing',
    EXERCISE_TYPE_YOGA: 'yoga', EXERCISE_TYPE_HIKING: 'hiking',
  };
  return MAP[t] || 'other';
}

export default nativeOnlyProvider({
  key: 'health_connect',
  platform: 'Android',
  capabilities: {
    workouts: true, activeEnergy: true, totalEnergy: true, heartRate: true,
    steps: true, distance: true, sleep: true, bodyMetrics: true,
    // autoDetectedWorkouts / hrv / recovery: Health Connect exposes these
    // only if the CONTRIBUTING app (e.g. a specific watch's own app)
    // writes them -- never assumed present (spec §6's own warning).
  },
  normalizers: {
    normalizeExerciseSession, normalizeActiveCalories, normalizeTotalCalories,
    normalizeHeartRate, normalizeSteps, normalizeSleepSession,
  },
});
