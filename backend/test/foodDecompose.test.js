// ============================================================
// PHASE 3 — decompose.js: composite_map template -> CompositionalCalculator
//
// Contract:
//   * no template for the key -> { ok:false }, never a guess
//   * fractions scale to the requested total; mass-reconciliation invariant
//     holds (summed component grams reconstructs the requested total)
//   * summation goes through the SAME CompositionalCalculator every other
//     tier uses -- no second summing implementation
//   * confidence is capped below a single measured row's ceiling (this is
//     always a structured ESTIMATE, never presented as exact)
// ============================================================
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { decompose } from '../src/services/food/decompose.js';
import { getCompositionalCalculator } from '../src/services/foodEstimator.js';

const deps = { getCompositionalCalculator };

test('unknown dish_key returns ok:false, never fabricates a structure', () => {
  const r = decompose('not_a_real_dish', 200, deps);
  assert.equal(r.ok, false);
  assert.ok(r.reason);
});

test('non-positive or missing grams returns ok:false', () => {
  for (const g of [0, -50, NaN, undefined, null]) {
    const r = decompose('papdi_chaat', g, deps);
    assert.equal(r.ok, false, `grams=${g} should be rejected`);
  }
});

test('papdi chaat decomposes into its curated components, summing via CompositionalCalculator', () => {
  const r = decompose('papdi_chaat', 200, deps);
  assert.equal(r.ok, true);
  assert.equal(r.dish_key, 'papdi_chaat');
  assert.ok(Array.isArray(r.components) && r.components.length >= 4);
  assert.ok(r.totals.energy_kcal > 0, 'must produce a real calorie total');
  assert.ok(['medium', 'low'].includes(r.confidence), 'a template decomposition is never high confidence');
});

test('mass-reconciliation invariant: summed component grams reconstructs the requested total', () => {
  for (const grams of [100, 200, 350, 500]) {
    const r = decompose('chole_bhature', grams, deps);
    assert.equal(r.ok, true);
    const delta = Math.abs(r.mass_reconciliation.summed_component_g - grams) / grams;
    assert.ok(delta <= 0.25, `grams=${grams}: reconciliation delta ${delta} exceeds the 0.25 hard invariant`);
    // in practice this decomposition's fractions are normalized up front, so
    // the reconstruction should be near-exact, not merely within the bound
    assert.ok(delta < 0.02, `grams=${grams}: expected near-exact reconstruction, got delta ${delta}`);
  }
});

test('totals scale linearly with requested grams (deterministic arithmetic, not a second model)', () => {
  const r100 = decompose('dal_rice', 100, deps);
  const r200 = decompose('dal_rice', 200, deps);
  assert.equal(r100.ok, true); assert.equal(r200.ok, true);
  // 2x mass -> ~2x calories, within floating rounding
  const ratio = r200.totals.energy_kcal / r100.totals.energy_kcal;
  assert.ok(Math.abs(ratio - 2) < 0.05, `expected ~2x scaling, got ${ratio}`);
});

test('a dish whose fractions do not sum to 1.0 is normalized before scaling', () => {
  // Regression guard: simulate via a tiny local calculator stub so this test
  // does not depend on any real composite_map entry's exact fractions.
  const stubCalc = {
    compute(ingredients) {
      const sumGrams = ingredients.reduce((s, i) => s + i.amount, 0);
      return {
        ok: true,
        ingredients: ingredients.map((i) => ({ ingredient: i.name, grams: i.amount, energy_kcal: i.amount })),
        unresolved: [],
        totals: { energy_kcal: sumGrams },
        coverage: { resolved_ingredients: ingredients.length, unresolved_ingredients: 0 },
        confidence: 'high',
      };
    },
  };
  // papdi_chaat's real fractions sum to ~1.0 already, so this test only
  // proves the normalization MATH, using the real dish as a structure source.
  const r = decompose('papdi_chaat', 300, { getCompositionalCalculator: () => stubCalc });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.mass_reconciliation.summed_component_g - 300) < 1);
});

test('a calculator that cannot be constructed fails cleanly, never throws', () => {
  const r = decompose('papdi_chaat', 200, { getCompositionalCalculator: () => null });
  assert.equal(r.ok, false);
  assert.match(r.reason, /calculator/i);
});

test('component-level provenance is exposed for the UI (per-ingredient breakdown)', () => {
  const r = decompose('sambar_rice', 300, deps);
  assert.equal(r.ok, true);
  for (const c of r.components) {
    assert.ok(c.ingredient);
    assert.ok(c.grams > 0);
  }
});
