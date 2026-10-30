// Shared provider display names for the SK OS Health Intelligence Engine
// -- used by HealthDevices.jsx and anywhere else that needs to show a
// human-readable source name (Home.jsx, Nutrition.jsx, Workout.jsx). One
// place so the mapping can't drift between screens.
//
// ONLY the ten real wearable provider keys (backend/src/services/health/
// types.js's PROVIDERS) belong here. A canonical workout's
// primary_energy_source can also be one of SK OS's OWN internal calorie-
// model provider names ('baseline' | 'ml' | 'mock' -- see
// backend/src/services/intelligence/calorieModel.js's own provider
// values) when no wearable evidence exists -- those are intentionally
// NOT listed below; isWearableSource() is the one place that
// distinguishes "a real connected device" from "SK OS's own estimate",
// as an ALLOWLIST of the ten real providers, not a denylist of internal
// names (a denylist silently mislabels any internal name it doesn't
// happen to already know about -- exactly the bug this replaced: a
// 'baseline' source was briefly shown as "baseline + SK OS" instead of
// "Estimated by SK OS").
export const PROVIDER_LABEL = {
  apple_health: 'Apple Health', health_connect: 'Health Connect', samsung_health: 'Samsung Health',
  whoop: 'WHOOP', oura: 'Oura', garmin: 'Garmin', fitbit: 'Fitbit', polar: 'Polar', coros: 'COROS', ultrahuman: 'Ultrahuman',
};

export function isWearableSource(key) {
  return !!key && Object.prototype.hasOwnProperty.call(PROVIDER_LABEL, key);
}

/** A short, human "where this number came from" string for a
 *  health_daily_summaries.source_summary_json payload -- never exposes
 *  raw provider keys or "AI calculated" (spec §51). */
export function burnSourceLabel(sourceSummary) {
  const providers = (sourceSummary?.providers || []).filter(isWearableSource);
  if (!providers.length) return 'Barbell estimate';
  const labels = [...new Set(providers.map((p) => PROVIDER_LABEL[p]))];
  return labels.length > 1 ? `${labels.join(' + ')} + Barbell` : `${labels[0]} + Barbell`;
}

/**
 * What a wearable reported for a strength session BARBELL logged, for
 * display BESIDE BARBELL's own estimate -- never in place of it
 * (docs/WEARABLE_RECONCILIATION_DECISION.md). Reads a canonical-workout row
 * from GET /health/workouts. Rows reconciled before that decision carry the
 * wearable figure as their primary; both shapes resolve to the same note.
 * Returns null when no wearable reported energy for the session.
 */
export function wearableComparisonNote(canonical) {
  if (!canonical) return null;
  const provider = canonical.wearable_provider
    || (isWearableSource(canonical.primary_energy_source) ? canonical.primary_energy_source : null);
  const kcal = canonical.wearable_active_kcal
    ?? (isWearableSource(canonical.primary_energy_source) ? canonical.active_kcal : null);
  if (!provider || !(Number(kcal) > 0)) return null;
  const name = PROVIDER_LABEL[provider] || 'Your wearable';
  return {
    kcal: Math.round(Number(kcal)),
    label: canonical.wearable_source_device ? `${name} (${canonical.wearable_source_device})` : name,
    flagged: Number(canonical.disagreement_flag) === 1,
  };
}
