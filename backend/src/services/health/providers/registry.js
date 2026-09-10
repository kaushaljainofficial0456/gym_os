// ============================================================
// PROVIDER REGISTRY — the ONLY place that maps a provider key to its
// adapter module. Every other file in this engine (routes, sync,
// reconciliation) looks a provider up here rather than importing a
// specific provider module or branching on provider name (spec §10:
// "do not write if provider === 'garmin' throughout the intelligence
// engine").
// ============================================================
import { emptyCapabilities, ProviderNotConfiguredError } from './baseProvider.js';
import whoop from './whoopProvider.js';
import oura from './ouraProvider.js';
import appleHealth from './appleHealthProvider.js';
import healthConnect from './healthConnectProvider.js';
import samsungHealth from './samsungHealthProvider.js';

/** Architected-but-unimplemented providers (spec §4/§10): the same
 *  WearableProvider shape as a real adapter, but every live-action
 *  method throws NOT_CONFIGURED rather than either working or being
 *  silently absent. This is what lets routes.js/health.js's own
 *  `GET /health/devices` list ALL ten providers with an honest status
 *  today, and what lets a real adapter be dropped in later (whoopProvider.js
 *  is the template) without touching the registry's callers at all. */
function architectedOnlyProvider(key, capabilities) {
  const notConfigured = () => { throw new ProviderNotConfiguredError(key, ['adapter not yet implemented']); };
  return {
    key,
    implemented: false,
    nativeOnly: false,
    capabilities: { ...emptyCapabilities(), ...capabilities },
    getAuthorizeUrl: notConfigured,
    exchangeCode: notConfigured,
    refreshAccessToken: notConfigured,
    incrementalSync: notConfigured,
  };
}

const REGISTRY = {
  whoop,
  oura,
  apple_health: appleHealth,
  health_connect: healthConnect,
  samsung_health: samsungHealth,
  // Real OAuth 2.0 APIs exist for all five of these; no SK OS adapter
  // code has been written yet (spec §4: "prioritize the architecture and
  // the highest-value integrations" -- WHOOP/Oura/the three native
  // platforms were prioritized this pass). Capabilities reflect each
  // platform's OWN publicly documented data model, not a guess.
  garmin: architectedOnlyProvider('garmin', {
    workouts: true, autoDetectedWorkouts: true, activeEnergy: true, totalEnergy: true,
    heartRate: true, steps: true, distance: true, sleep: true, vo2max: true,
  }),
  fitbit: architectedOnlyProvider('fitbit', {
    workouts: true, activeEnergy: true, totalEnergy: true, heartRate: true,
    steps: true, distance: true, sleep: true, restingHeartRate: true,
  }),
  polar: architectedOnlyProvider('polar', {
    workouts: true, activeEnergy: true, heartRate: true, sleep: true, hrv: true,
  }),
  coros: architectedOnlyProvider('coros', {
    workouts: true, activeEnergy: true, heartRate: true, steps: true, distance: true,
  }),
  ultrahuman: architectedOnlyProvider('ultrahuman', {
    sleep: true, hrv: true, restingHeartRate: true, recovery: true, bodyTemperature: true,
  }),
};

export function getProvider(key) {
  const p = REGISTRY[key];
  if (!p) throw new Error(`Unknown health provider: ${key}`);
  return p;
}

export function listProviders() {
  return Object.values(REGISTRY);
}
