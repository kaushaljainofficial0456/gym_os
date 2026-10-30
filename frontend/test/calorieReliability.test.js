import { describe, it, expect } from 'vitest';
import { describeReliability } from '../src/calorieReliability.js';

describe('describeReliability', () => {
  it('words each level the API can send, with its reasons', () => {
    const r = describeReliability({ reliability: 'low', reliability_reasons: [{ code: 'not_validated', text: 'Not yet checked.' }] });
    expect(r).toEqual({ label: 'Rough estimate', reasons: ['Not yet checked.'] });
    expect(describeReliability({ reliability: 'very_low' }).label).toBe('Very rough estimate');
    expect(describeReliability({ reliability: 'demo' }).label).toBe('Demo values');
  });

  it('never invents a level for a response without one, or an unknown one', () => {
    expect(describeReliability({ estimated_active_kcal: 300 })).toBeNull();
    expect(describeReliability({ reliability: 'high' })).toBeNull();
    expect(describeReliability(null)).toBeNull();
  });
});
