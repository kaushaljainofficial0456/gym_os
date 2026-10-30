import { describe, it, expect } from 'vitest';
import { wearableComparisonNote } from '../src/healthProviderLabels.js';

// docs/WEARABLE_RECONCILIATION_DECISION.md: a wearable's figure for a
// strength session is shown beside Barbell's, never in place of it.
describe('wearableComparisonNote', () => {
  it('reads the separately-stored wearable figure, with device identity', () => {
    const n = wearableComparisonNote({ primary_energy_source: 'baseline', active_kcal: 420, wearable_provider: 'whoop', wearable_active_kcal: 327, disagreement_flag: 0 });
    expect(n).toEqual({ kcal: 327, label: 'WHOOP', flagged: false });
    const d = wearableComparisonNote({ primary_energy_source: 'baseline', wearable_provider: 'apple_health', wearable_active_kcal: 305.4, wearable_source_device: 'Apple Watch Series 9', disagreement_flag: 1 });
    expect(d).toEqual({ kcal: 305, label: 'Apple Health (Apple Watch Series 9)', flagged: true });
  });

  it('reads rows reconciled before the decision, where the wearable was primary', () => {
    expect(wearableComparisonNote({ primary_energy_source: 'whoop', active_kcal: 327 })).toEqual({ kcal: 327, label: 'WHOOP', flagged: false });
  });

  it('returns null for heart-rate-only evidence, a missing figure, or BARBELL alone', () => {
    expect(wearableComparisonNote({ primary_energy_source: 'baseline', active_kcal: 330, wearable_provider: 'apple_health', wearable_measurement_type: 'heart_rate_only', wearable_active_kcal: null })).toBeNull();
    expect(wearableComparisonNote({ primary_energy_source: 'baseline', active_kcal: 330 })).toBeNull();
    expect(wearableComparisonNote(null)).toBeNull();
  });
});
