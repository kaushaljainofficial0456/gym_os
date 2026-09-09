// ============================================================
// WEARABLE PROVIDER — the abstraction every adapter in this directory
// implements. This file defines the CONTRACT and shared helpers; it has
// no provider-specific logic of its own.
//
// JS has no interfaces, so this is documentation + a runtime shape
// check (assertProviderShape) rather than an enforced type. Every
// adapter module default-exports an object matching this shape:
//
//   {
//     key: 'whoop',                 // one of types.js's PROVIDERS
//     implemented: true,            // false => architected only, see below
//     nativeOnly: false,            // true => cannot run from this web
//                                   //   backend at all (HealthKit/Health
//                                   //   Connect/Samsung Health — see
//                                   //   their own files)
//     capabilities: { workouts: true, activeEnergy: true, ... },
//     getAuthorizeUrl(state, redirectUri) -> string | throws
//     exchangeCode(code, redirectUri) -> { accessToken, refreshToken, expiresAt, externalAccountId, scopes }
//     refreshAccessToken(refreshToken) -> { accessToken, refreshToken, expiresAt }
//     incrementalSync({ accessToken, cursor, since }) -> { records: CanonicalHealthRecordInput[], nextCursor }
//     normalizeWorkout(raw) -> CanonicalHealthRecordInput
//     normalizeDailyActivity(raw) -> CanonicalHealthRecordInput[]
//     normalizeSleep(raw) -> CanonicalHealthRecordInput
//   }
//
// A method a provider genuinely cannot support (e.g. Oura has no HRV
// endpoint in this adapter) is simply absent — callers must always check
// `capabilities` first (spec §3: "never assume unavailable data exists"),
// never call-and-catch as a way to probe for support.
//
// `implemented: false` means: the adapter file exists, the capabilities
// are documented, normalizer functions exist and are unit-tested against
// representative fixture payloads (see backend/test/healthProviders.test.js)
// -- but connect()/sync() are NOT wired to a live, credentialed API,
// because this environment has no registered developer app / client
// secret for that provider. Calling connect() on one of these returns a
// clear NOT_CONFIGURED error, never a fake success.
//
// `nativeOnly: true` (Apple Health, Android Health Connect, Samsung
// Health) means there is no web OAuth flow at all — these platforms
// grant permissions to a NATIVE app via HealthKit / Health Connect /
// Samsung Health SDK calls that only exist inside an iOS/Android
// process. A browser cannot reach them (spec §106). connect() on these
// always returns a REQUIRES_NATIVE_APP error describing exactly that,
// never a fake permission prompt.
// ============================================================

/** A provider that has advertised a capability but is missing the
 *  live-credential wiring to actually use it. Distinct from a genuine
 *  runtime failure (network error, expired token) -- callers branch on
 *  `.code` to decide what to tell the user (spec §86: never claim
 *  connected while silently falling back). */
export class ProviderNotConfiguredError extends Error {
  constructor(provider, missingEnvVars = []) {
    super(`${provider} is not configured (missing: ${missingEnvVars.join(', ') || 'credentials'})`);
    this.name = 'ProviderNotConfiguredError';
    this.code = 'NOT_CONFIGURED';
    this.provider = provider;
    this.missingEnvVars = missingEnvVars;
  }
}

export class RequiresNativeAppError extends Error {
  constructor(provider, platform) {
    super(`${provider} requires the SK OS ${platform} app -- it cannot be connected from a web browser`);
    this.name = 'RequiresNativeAppError';
    this.code = 'REQUIRES_NATIVE_APP';
    this.provider = provider;
    this.platform = platform;
  }
}

/** The full capability vocabulary a provider MAY advertise. Every
 *  adapter's `capabilities` object should only set fields it actually
 *  supports to `true` -- omitted/false fields are treated identically
 *  (both mean "don't ask this provider for that data"). */
export const CAPABILITY_KEYS = Object.freeze([
  'workouts', 'autoDetectedWorkouts', 'activeEnergy', 'totalEnergy', 'restingEnergy',
  'heartRate', 'steps', 'distance', 'sleep', 'recovery', 'hrv', 'restingHeartRate',
  'respiratoryRate', 'spo2', 'bodyTemperature', 'bodyMetrics', 'vo2max', 'routes',
]);

export function emptyCapabilities() {
  return Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, false]));
}

/** Builds the standard shape for a native-only provider (Apple Health,
 *  Health Connect, Samsung Health) -- every method that would need a live
 *  connection throws RequiresNativeAppError instead of pretending to
 *  work. `normalizers` are still real, independently testable pure
 *  functions (see each provider's own file) -- only the live sync
 *  boundary is stubbed, not the data-shape logic. */
export function nativeOnlyProvider({ key, platform, capabilities, normalizers = {} }) {
  const notNative = () => { throw new RequiresNativeAppError(key, platform); };
  return {
    key,
    implemented: false,
    nativeOnly: true,
    platform,
    capabilities: { ...emptyCapabilities(), ...capabilities },
    getAuthorizeUrl: notNative,
    exchangeCode: notNative,
    refreshAccessToken: notNative,
    incrementalSync: notNative,
    ...normalizers,
  };
}
