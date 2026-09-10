// ============================================================
// SAMSUNG HEALTH PROVIDER ADAPTER.
//
// nativeOnly: true -- Samsung Health data access is exclusively through
// the Samsung Health SDK (Android, on-device), no web OAuth (spec §7/
// §67/§106). Same connect()-always-throws treatment as the other two
// native adapters.
//
// Samsung Health's exact field availability depends on the connected
// device/app (spec §7: "never assume all Samsung users have the same
// fields") -- more so than Apple Health or Health Connect, where the
// platform itself defines a fixed set of record types. Capabilities
// below are therefore the SDK's documented MAXIMUM, not a guarantee --
// a real native bridge must still report actual availability per user
// via the connection's own capabilities_json (health_provider_connections
// table), not this static default.
// ============================================================
import { nativeOnlyProvider } from './baseProvider.js';

/** Expected native-bridge exercise payload (Samsung Health SDK's
 *  Exercise data type): { uuid, exercise_type, start_time, end_time,
 *  calorie, distance, mean_heart_rate, max_heart_rate }. */
function normalizeExercise(raw) {
  return {
    provider: 'samsung_health',
    provider_record_id: raw.uuid,
    data_type: 'workout',
    activity_type: samsungExerciseTypeToActivityType(raw.exercise_type),
    start_time: raw.start_time,
    end_time: raw.end_time,
    active_kcal: numOrNull(raw.calorie),
    distance_m: numOrNull(raw.distance),
    heart_rate_avg: numOrNull(raw.mean_heart_rate),
    heart_rate_max: numOrNull(raw.max_heart_rate),
    data_quality: 'good',
  };
}

/** Samsung Health SDK's daily step-count aggregate. */
function normalizeSteps(raw) {
  return {
    provider: 'samsung_health',
    provider_record_id: `steps_${raw.day_time || raw.start_time}`,
    data_type: 'steps',
    start_time: raw.start_time,
    end_time: raw.end_time,
    steps: numOrNull(raw.count),
    data_quality: 'good',
  };
}

/** Samsung Health SDK's Sleep data type. */
function normalizeSleep(raw) {
  const startMs = Date.parse(raw.start_time);
  const endMs = Date.parse(raw.end_time);
  return {
    provider: 'samsung_health',
    provider_record_id: raw.uuid,
    data_type: 'sleep',
    start_time: raw.start_time,
    end_time: raw.end_time,
    sleep_duration_seconds: Number.isFinite(startMs) && Number.isFinite(endMs) ? (endMs - startMs) / 1000 : null,
    data_quality: 'good',
  };
}

function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function samsungExerciseTypeToActivityType(t) {
  // Samsung Health SDK exercise_type is a numeric constant catalog;
  // mapping only representative examples. Unmapped -> 'other'.
  const MAP = { 1001: 'walking', 1002: 'running', 11007: 'cycling', 13001: 'strength_training' };
  return MAP[t] || 'other';
}

export default nativeOnlyProvider({
  key: 'samsung_health',
  platform: 'Android',
  capabilities: {
    workouts: true, activeEnergy: true, heartRate: true, steps: true,
    distance: true, sleep: true, bodyMetrics: true,
    // Everything else varies by device/app per this file's header note.
  },
  normalizers: { normalizeExercise, normalizeSteps, normalizeSleep },
});
