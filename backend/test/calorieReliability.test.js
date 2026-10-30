// What a calorie figure is and how far to trust it (calorieReliability.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifyCalorie } from '../src/services/intelligence/calorieReliability.js';
import { baselineEstimate } from '../src/services/intelligence/calorieModel.js';

const est = () => baselineEstimate({ user: { body_weight_kg: 80 }, session: { duration_minutes: 50, intensity_rating: 'moderate' } });
const codes = (q) => q.reliability_reasons.map((r) => r.code);

test('never changes a number -- only adds basis and reliability', () => {
  const e = est();
  const q = qualifyCalorie(e, { intensity: 'moderate' });
  for (const k of Object.keys(e)) assert.deepEqual(q[k], e[k]);
  assert.equal(q.basis, 'model_estimate');
});

test('baseline is "low": unvalidated for full sessions, range not a calibrated interval', () => {
  const q = qualifyCalorie(est(), { intensity: 'moderate' });
  assert.equal(q.reliability, 'low');
  assert.deepEqual(codes(q), ['not_validated', 'range_not_calibrated']);
});

test('no level above "low" exists for any provider until validation earns one', () => {
  for (const provider of ['baseline', 'ml']) {
    assert.ok(['low', 'very_low'].includes(qualifyCalorie({ ...est(), provider }).reliability));
  }
});

test('the experimental ml provider is "very_low"', () => {
  const q = qualifyCalorie({ ...est(), provider: 'ml' });
  assert.equal(q.reliability, 'very_low');
  assert.ok(codes(q).includes('ml_unvalidated'));
});

test('hard effort, estimated duration and previews each add their caveat', () => {
  const q = qualifyCalorie(est(), { intensity: 'hard', durationMeasured: false, preview: true });
  assert.deepEqual(codes(q).slice(2), ['hard_may_overestimate', 'duration_estimated', 'planned_not_performed']);
});

test('mock values say they are demo values; null stays null', () => {
  assert.equal(qualifyCalorie({ provider: 'mock', estimated_active_kcal: 300 }).reliability, 'demo');
  assert.equal(qualifyCalorie(null), null);
});
