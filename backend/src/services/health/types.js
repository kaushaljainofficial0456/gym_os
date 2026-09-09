// ============================================================
// SK OS HEALTH INTELLIGENCE — canonical vocabulary.
//
// Every module in backend/src/services/health/ imports its enum/string
// values from here rather than restating them — the same discipline
// foodValidation.js's MACRO_FIELDS or calorieModel.js's INTENSITY_MET
// already follow elsewhere in this codebase. Keeps `if (provider ===
// 'garmin')` style branching out of the engine (the reconciliation/
// matching/confidence logic below never checks a provider name
// directly — it only ever reads a record's normalized fields and a
// provider's advertised CAPABILITIES, per PROVIDERS/section 3 & 10 of
// the spec this was built against).
// ============================================================

/** Every provider the architecture is designed for. Not every one has a
 *  working adapter yet — see providers/registry.js's own `implemented`
 *  flag for which ones actually connect vs. are architected-only. */
export const PROVIDERS = Object.freeze([
  'apple_health', 'health_connect', 'samsung_health',
  'whoop', 'oura', 'garmin', 'fitbit', 'polar', 'coros', 'ultrahuman',
]);

/** health_records.data_type — matches the CHECK constraint in schema.sql. */
export const DATA_TYPES = Object.freeze([
  'workout', 'energy_sample', 'heart_rate', 'steps', 'distance',
  'sleep', 'recovery', 'hrv', 'resting_hr', 'respiratory_rate', 'spo2',
  'body_temperature', 'body_metrics', 'vo2max',
]);

/** health_provider_connections.status. 'connected' must only ever be set
 *  after a REAL, verified token exchange — never as a UI placeholder. */
export const CONNECTION_STATUS = Object.freeze({
  DISCONNECTED: 'disconnected',
  PENDING: 'pending',
  CONNECTED: 'connected',
  ERROR: 'error',
  REVOKED: 'revoked',
});

/** Where a final energy/workout number ultimately came from — this is
 *  the single most important provenance field in the whole engine (spec
 *  §12/§51: every user-facing number must be able to answer "where did
 *  this come from"). 'skos' means "the user's own logged workout in this
 *  app", as distinct from 'skos_ml' (a MODEL estimate) and
 *  'met_fallback' (the oldest, least personalized baseline). */
export const SOURCES = Object.freeze({
  ...Object.fromEntries(PROVIDERS.map((p) => [p.toUpperCase(), p])),
  SKOS: 'skos',
  SKOS_ML: 'skos_ml',
  MET_FALLBACK: 'met_fallback',
});

export const CONFIDENCE_LEVELS = Object.freeze(['high', 'medium', 'low', 'very_low']);
export const DATA_QUALITY_STATES = Object.freeze(['complete', 'mostly_complete', 'partial', 'poor', 'unknown']);
export const RECORD_QUALITY = Object.freeze(['good', 'flagged', 'suspicious']);
export const READINESS_LABELS = Object.freeze({
  READY: 'ready',
  MODERATE: 'moderate',
  RECOVERY_RECOMMENDED: 'recovery_recommended',
});

/** A small, deliberately open activity-type vocabulary — free text in
 *  the DB (providers use wildly different taxonomies), but every
 *  normalizer should map into ONE of these where it reasonably can, so
 *  the matching engine's activity-similarity check (matching.js) has a
 *  stable set to compare against instead of every provider's own
 *  strings. Falls back to 'other' rather than inventing a category. */
export const ACTIVITY_TYPES = Object.freeze([
  'strength_training', 'running', 'walking', 'cycling', 'swimming',
  'rowing', 'elliptical', 'hiking', 'yoga', 'hiit', 'sports', 'other',
]);

/** Energy fields are never interchangeable (spec §24) — active_kcal is
 *  energy ABOVE resting for the interval; total_kcal is active+resting;
 *  resting_kcal is base metabolic cost alone. Naming this once here so
 *  no call site has to re-derive "which kcal field means what". */
export const ENERGY_FIELDS = Object.freeze(['active_kcal', 'total_kcal', 'resting_kcal']);
