// ============================================================
// APPLE HEALTH / HEALTHKIT PROVIDER ADAPTER.
//
// nativeOnly: true -- HealthKit has NO web OAuth flow. Permissions are
// granted to a NATIVE iOS process via HKHealthStore.requestAuthorization,
// which does not exist in a browser (spec §5/§67/§106). connect() here
// always throws RequiresNativeAppError -- this is deliberate, not a
// missing feature: there is no legitimate way to "connect Apple Health"
// from this web backend, and pretending otherwise would be exactly the
// fake-connected-state the spec prohibits (§instructions).
//
// What IS real: the normalizer functions below, which define the
// CONTRACT a future iOS native bridge (e.g. a Capacitor/React Native
// HealthKit plugin) would need to serialize samples INTO before POSTing
// them to this backend's ingestion endpoint. The exact bridge library's
// JSON shape will vary -- this is SK OS's own expected input shape, not
// a captured HealthKit response (HealthKit has no JSON wire format of
// its own; it's a native Swift/Obj-C API).
//
// active_kcal here is HKQuantityTypeIdentifierActiveEnergyBurned --
// explicitly energy from activity, NEVER added to resting/basal energy
// again by this file (spec §5's own warning) -- that summation, if ever
// needed, belongs one layer up in the reconciliation engine, which
// already tracks active/resting/total as separate fields for this exact
// reason.
// ============================================================
import { nativeOnlyProvider } from './baseProvider.js';

/** Expected native-bridge workout payload shape:
 *  { uuid, workoutActivityType, startDate, endDate, duration,
 *    totalEnergyBurned: { unit: 'kcal', value }, totalDistance?: { unit, value },
 *    sourceName? } */
function normalizeWorkout(raw) {
  return {
    provider: 'apple_health',
    provider_record_id: raw.uuid,
    data_type: 'workout',
    activity_type: hkActivityTypeToActivityType(raw.workoutActivityType),
    start_time: raw.startDate,
    end_time: raw.endDate,
    duration_seconds: numOrNull(raw.duration),
    active_kcal: raw.totalEnergyBurned ? kcalFrom(raw.totalEnergyBurned) : null,
    distance_m: raw.totalDistance ? metersFrom(raw.totalDistance) : null,
    auto_detected: raw.workoutActivityType != null && raw.wasUserEntered !== true,
    user_entered: raw.wasUserEntered === true,
    data_quality: 'good',
  };
}

/** Expected native-bridge quantity-sample payload:
 *  { uuid, quantityType: 'activeEnergyBurned'|'basalEnergyBurned'|'heartRate'|'stepCount',
 *    startDate, endDate, quantity: { unit, value } } */
function normalizeQuantitySample(raw) {
  const base = {
    provider: 'apple_health',
    provider_record_id: raw.uuid,
    start_time: raw.startDate,
    end_time: raw.endDate,
    data_quality: 'good',
  };
  switch (raw.quantityType) {
    case 'activeEnergyBurned':
      return { ...base, data_type: 'energy_sample', active_kcal: kcalFrom(raw.quantity) };
    case 'basalEnergyBurned':
      // HealthKit's resting/basal energy -- kept SEPARATE from active_kcal.
      return { ...base, data_type: 'energy_sample', resting_kcal: kcalFrom(raw.quantity) };
    case 'heartRate':
      return { ...base, data_type: 'heart_rate', heart_rate_avg: numOrNull(raw.quantity?.value) };
    case 'stepCount':
      return { ...base, data_type: 'steps', steps: numOrNull(raw.quantity?.value) };
    case 'respiratoryRate':
      return { ...base, data_type: 'respiratory_rate', respiratory_rate: numOrNull(raw.quantity?.value) };
    case 'oxygenSaturation':
      return { ...base, data_type: 'spo2', spo2_pct: numOrNull(raw.quantity?.value) * (raw.quantity?.unit === '%' ? 1 : 100) };
    case 'heartRateVariabilitySDNN':
      return { ...base, data_type: 'hrv', hrv_ms: numOrNull(raw.quantity?.value) };
    case 'vo2Max':
      return { ...base, data_type: 'vo2max', vo2max: numOrNull(raw.quantity?.value) };
    default:
      return null; // unrecognized quantity type -- never guess, drop it (caller should log this as a data-quality gap)
  }
}

/** Expected native-bridge sleep payload:
 *  { uuid, startDate, endDate, sleepAnalysisValue: 'asleep'|'inBed'|... } --
 *  HealthKit reports sleep as a SERIES of interval samples, not one
 *  session; a real bridge would need to merge these into sessions before
 *  calling this normalizer once per session with a computed duration. */
function normalizeSleep(raw) {
  const startMs = Date.parse(raw.startDate);
  const endMs = Date.parse(raw.endDate);
  return {
    provider: 'apple_health',
    provider_record_id: raw.uuid,
    data_type: 'sleep',
    start_time: raw.startDate,
    end_time: raw.endDate,
    sleep_duration_seconds: Number.isFinite(startMs) && Number.isFinite(endMs) ? (endMs - startMs) / 1000 : null,
    data_quality: 'good',
  };
}

function kcalFrom(q) {
  const v = numOrNull(q?.value);
  if (v == null) return null;
  if (q.unit === 'kJ') return v / 4.184;
  return v; // 'kcal' or unspecified -- HealthKit's own default energy unit is kcal
}
function metersFrom(q) {
  const v = numOrNull(q?.value);
  if (v == null) return null;
  if (q.unit === 'km') return v * 1000;
  if (q.unit === 'mi') return v * 1609.344;
  return v; // 'm'
}
function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function hkActivityTypeToActivityType(t) {
  const MAP = {
    traditionalStrengthTraining: 'strength_training', functionalStrengthTraining: 'strength_training',
    running: 'running', walking: 'walking', cycling: 'cycling', swimming: 'swimming',
    rowing: 'rowing', elliptical: 'elliptical', hiking: 'hiking', yoga: 'yoga',
    highIntensityIntervalTraining: 'hiit',
  };
  return MAP[t] || 'other';
}

export default nativeOnlyProvider({
  key: 'apple_health',
  platform: 'iOS',
  capabilities: {
    workouts: true, autoDetectedWorkouts: true, activeEnergy: true, restingEnergy: true,
    heartRate: true, steps: true, distance: true, sleep: true, hrv: true,
    respiratoryRate: true, spo2: true, vo2max: true, bodyMetrics: true, routes: true,
    // recovery / recoveryScore intentionally NOT set -- HealthKit has no
    // native recovery-score concept (that's a third-party app construct).
  },
  normalizers: { normalizeWorkout, normalizeQuantitySample, normalizeSleep },
});
