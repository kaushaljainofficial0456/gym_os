// ============================================================
// CONFIDENCE BY DIMENSION (food/confidence.js)
//
// identification / portion / composition, each from evidence; overall is
// the weakest. These tests pin the rules, and check the live engine applies
// them (no estimate is "high" when its amount was never said).
// ============================================================
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { confidenceBreakdown, weakest } from '../src/services/food/confidence.js';
import { estimateFood, modelAvailable } from '../src/services/foodEstimator.js';

test('overall is the weakest dimension', () => {
  assert.equal(weakest('high', 'medium', 'high'), 'medium');
  assert.equal(weakest('high', 'high', 'low'), 'low');
  assert.equal(weakest('high'), 'high');
});

test('a weighed amount of a lab-measured ingredient by its exact name is high on every axis', () => {
  const b = confidenceBreakdown({ staple_match: 'exact', grams_basis: 'measured', qty_stated: true, unit_stated: true, source: 'IFCT2017', cooking_state: 'raw' });
  assert.deepEqual([b.identification, b.portion, b.composition, b.overall], ['high', 'high', 'high', 'high']);
});

test('no amount said -> portion low, whatever else is certain', () => {
  const b = confidenceBreakdown({ staple_match: 'exact', grams_basis: 'volume', grams_assumed: true, source: 'USDA_FDC' });
  assert.equal(b.portion, 'low');
  assert.equal(b.overall, 'low');
  assert.match(b.reasons.portion[0], /no amount given/);
});

test('a stated household amount is medium (sizes vary)', () => {
  const b = confidenceBreakdown({ staple_match: 'exact', grams_basis: 'count', qty_stated: true, unit_stated: true, source: 'INDB', category: 'indian_dish', cooking_state: 'cooked' });
  assert.equal(b.portion, 'medium');
  assert.equal(b.composition, 'medium', 'a cooked dish varies between kitchens');
});

test('words left unaccounted for, a relaxed or a spelling-corrected match all make identification low', () => {
  assert.equal(confidenceBreakdown({ match_kind: 'exact_name', unmatched_terms: ['bhurji'] }).identification, 'low');
  assert.equal(confidenceBreakdown({ match_kind: 'exact_name', query_relaxed: true }).identification, 'low');
  assert.equal(confidenceBreakdown({ match_kind: 'exact_name', fuzzy_corrected: true }).identification, 'low');
  assert.equal(confidenceBreakdown({ staple_match: 'exact', vague: true }).identification, 'medium');
});

test('recipe and restaurant values are never high composition; AI is low', () => {
  assert.equal(confidenceBreakdown({ source: 'SKOS_RECIPE' }).composition, 'medium');
  assert.equal(confidenceBreakdown({ source: 'INDB', cooking_state: 'cooked', context: ['restaurant'] }).composition, 'low');
  assert.equal(confidenceBreakdown({ estimate_kind: 'ai' }).composition, 'low');
});

test('a size word that was not applied lowers portion confidence and says so', () => {
  const b = confidenceBreakdown({ staple_match: 'exact', grams_basis: 'count', qty_stated: true, sizes: ['large'] });
  assert.equal(b.portion, 'low');
  assert.ok(b.reasons.portion.some((r) => /large/.test(r)));
});

const live = modelAvailable();

test('live engine: every item carries a breakdown and confidence equals its weakest dimension', { skip: !live }, () => {
  for (const meal of ['2 roti, dal and curd', '200g chicken breast', 'restaurant butter chicken', 'misal pav', 'poha']) {
    for (const it of estimateFood(meal).items) {
      const b = it.confidence_breakdown;
      assert.ok(b, `${meal}: ${it.name} has no breakdown`);
      assert.equal(it.confidence, weakest(b.identification, b.portion, b.composition), `${meal}: ${it.name}`);
    }
  }
});

test('live engine: "200g chicken breast" is high; "poha" (no amount) is not', { skip: !live }, () => {
  assert.equal(estimateFood('200g chicken breast').items[0].confidence, 'high');
  const poha = estimateFood('poha').items[0];
  assert.notEqual(poha.confidence, 'high');
  assert.equal(poha.confidence_breakdown.portion, 'low');
});

test('live engine: "restaurant" is recorded and lowers composition for a cooked dish', { skip: !live }, () => {
  const it = estimateFood('restaurant butter chicken').items[0];
  assert.deepEqual(it.context, ['restaurant']);
  assert.equal(it.confidence_breakdown.composition, 'low');
});
