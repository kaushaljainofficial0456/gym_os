// How the workout page words the reliability the API attaches to every
// calorie estimate (backend calorieReliability.js). There is deliberately
// no wording for a high level: none exists until BARBELL's estimate is
// validated against measured energy for full sessions.
const LABELS = {
  low: 'Rough estimate',
  very_low: 'Very rough estimate',
  demo: 'Demo values',
};

/** { label, reasons[] } for a calorie object, or null when it carries no
 *  reliability (an older response) -- callers then show nothing extra
 *  rather than inventing a level. */
export function describeReliability(calorie) {
  const level = calorie?.reliability;
  if (!level || !LABELS[level]) return null;
  return {
    label: LABELS[level],
    reasons: (calorie.reliability_reasons || []).map((r) => r?.text).filter(Boolean),
  };
}
