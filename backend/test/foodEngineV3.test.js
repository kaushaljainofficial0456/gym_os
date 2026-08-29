// ============================================================
// PHASE 3 — v3 engine (composite classification + decomposition)
//
// Contract:
//   * FLAG OFF (default, engine unset or 'v1'/'v2') -> byte-identical to
//     before Phase 3 existed. v3 must never engage uninvited.
//   * FLAG ON (engine:'v3') -> V1 + Phase2 (plausibility/rescue) + Phase3:
//       - Strategy C1 first: a trustworthy, plausible, NON-BRANDED direct
//         match is never second-guessed by a template guess.
//       - A composite fragment with no good C1 match gets decomposed via
//         its composite_map template (Strategy C2) instead of matching
//         whatever row happens to share tokens with it.
//       - A combo-pattern fragment with NO curated template is left alone
//         — Phase 3 never guesses a dish's structure.
//       - A genuinely simple food (no composite classification at all) is
//         never decomposed.
//   * Regression coverage for the two bugs found and fixed while building
//     this phase: the papdi-chaat branded-mismatch bug, and the pani-puri
//     per-piece-vs-per-plate portion bug.
// ============================================================
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import * as legacy from '../src/services/foodEstimator.js';
import { estimateMeal, applyPhase3 } from '../src/services/food/engine.js';

const OFF_INPUTS = [
  '2 roti', '150g chicken breast', '206g papdi chaat', '4 pani puri',
  'rajma chawal', 'poha', 'quantum flux capacitor', '100 g paneer',
];

test('FLAG OFF: v3 code existing does not change v1/v2 behavior at all', () => {
  for (const s of OFF_INPUTS) {
    assert.deepEqual(estimateMeal(s), legacy.estimateFood(s), `default differs for ${JSON.stringify(s)}`);
    assert.deepEqual(estimateMeal(s, { engine: 'v1' }), legacy.estimateFood(s));
  }
  assert.notEqual(process.env.FOOD_ENGINE_V3, '1');
});

test('REGRESSION (papdi-chaat bug): a branded-snack lexical mismatch is replaced by the real decomposition', () => {
  const v1 = legacy.estimateFood('206g papdi chaat');
  assert.equal(v1.items[0].source, 'OPEN_FOOD_FACTS');
  assert.match(v1.items[0].name, /Quinoa Puffs/, 'confirms the known V1 bug is still reproducible pre-fix');

  const v3 = estimateMeal('206g papdi chaat', { engine: 'v3' });
  assert.equal(v3.items.length, 1);
  const it = v3.items[0];
  assert.equal(it.source, 'composite_decompose');
  assert.equal(it.estimate_status, 'composite_decomposed');
  assert.equal(it.decomposition.dish_key, 'papdi_chaat');
  assert.ok(!/Quinoa/i.test(it.name), 'must no longer answer with the branded snack');
  assert.equal(it.grams, 206, 'the explicit 206g must still be honoured exactly');
  // The branded mismatch put this at 871 kcal; the decomposed answer must be
  // materially different (a real fix, not a rounding nudge).
  assert.notEqual(it.calories, v1.items[0].calories);
  assert.ok(it.calories > 100 && it.calories < 800, `${it.calories} kcal should be a plausible plate of chaat`);
});

test('REGRESSION (pani-puri portion bug): count multiplies PER-PIECE weight, not a whole-plate weight', () => {
  const v3 = estimateMeal('4 pani puri', { engine: 'v3' });
  assert.equal(v3.items.length, 1);
  const it = v3.items[0];
  assert.equal(it.decomposition.dish_key, 'pani_puri');
  // Ground truth: ~20g/piece -> 4 pieces ~= 80g, not 4 x a 120g plate (480g).
  assert.ok(it.grams >= 60 && it.grams <= 120, `4 pani puri should be ~80g, got ${it.grams}g`);
  assert.ok(it.calories >= 60 && it.calories <= 400, `${it.calories} kcal should fit a small piece-count portion`);
});

test('Strategy C1 first: a composite dish with an existing GOOD (non-branded) direct match is left alone', () => {
  // "rajma chawal" already resolves cleanly to real INDB/IFCT rows in V1 —
  // Phase 3 must not touch a working direct match just because the phrase
  // also happens to have a composite_map template.
  const v1 = legacy.estimateFood('rajma chawal');
  const v3 = estimateMeal('rajma chawal', { engine: 'v3' });
  if (v1.items.length && v1.items[0].trustworthy !== false) {
    assert.equal(v3.items[0].source, v1.items[0].source, 'a good C1 match must not be replaced by a template guess');
    assert.equal(v3.items[0].calories, v1.items[0].calories);
  }
});

test('a combo-pattern phrase with NO curated template is left completely alone', () => {
  const v1 = legacy.estimateFood('paneer rice');
  const v3 = estimateMeal('paneer rice', { engine: 'v3' });
  assert.deepEqual(v3.items, v1.items, 'no composite_map entry for this combo -> Phase 3 must be a no-op');
  assert.deepEqual(v3.unresolved, v1.unresolved);
});

test('a simple, non-composite food is never decomposed', () => {
  for (const s of ['2 roti', '150g chicken breast', '100 g paneer', '1 banana']) {
    const v1 = legacy.estimateFood(s);
    const v3 = estimateMeal(s, { engine: 'v3' });
    for (const it of v3.items) {
      assert.notEqual(it.source, 'composite_decompose', `"${s}" must never be routed through decomposition`);
    }
    assert.equal(v3.items.length, v1.items.length);
  }
});

test('v3 still applies Phase 2 (quarantine rescue keeps working underneath Phase 3)', () => {
  const v2 = estimateMeal('81g puri', { engine: 'v2' });
  const v3 = estimateMeal('81g puri', { engine: 'v3' });
  assert.equal(v3.items[0].estimate_status, 'quarantine_rescue');
  assert.equal(v3.items[0].calories, v2.items[0].calories, 'v3 must not alter a Phase-2 rescue it does not touch');
});

test('a decomposed item moves the fragment OUT of unresolved and INTO items', () => {
  const v3 = estimateMeal('206g papdi chaat', { engine: 'v3' });
  assert.equal(v3.unresolved.length, 0);
  assert.equal(v3.items.length, 1);
});

test('mixed meal: only the composite fragment is decomposed, the rest resolve normally', () => {
  const v3 = estimateMeal('2 roti and 206g papdi chaat', { engine: 'v3' });
  const roti = v3.items.find((i) => /roti/i.test(i.name));
  const chaat = v3.items.find((i) => i.source === 'composite_decompose');
  assert.ok(roti, 'roti must still resolve normally');
  assert.ok(chaat, 'the composite fragment must be decomposed');
  assert.equal(chaat.decomposition.dish_key, 'papdi_chaat');
  assert.equal(v3.total.calories, roti.calories + chaat.calories);
});

test('applyPhase3 on a result with no composite fragments returns the SAME object (no needless copy)', () => {
  const base = estimateMeal('2 roti', { engine: 'v2' });
  assert.equal(applyPhase3(base, '2 roti'), base);
});

test('applyPhase3 with no original text is a safe no-op', () => {
  const base = estimateMeal('206g papdi chaat', { engine: 'v2' });
  assert.equal(applyPhase3(base, undefined), base);
  assert.equal(applyPhase3(base, ''), base);
});

test('v3 result carries engine/v3 provenance when a decomposition actually happened', () => {
  const v3 = estimateMeal('206g papdi chaat', { engine: 'v3' });
  assert.equal(v3.engine, 'v3');
  assert.ok(v3.v3 && v3.v3.composite_decompositions >= 1);
});

test('decomposed item never claims high confidence', () => {
  const v3 = estimateMeal('4 sambar rice', { engine: 'v3' });
  const it = v3.items.find((i) => i.source === 'composite_decompose');
  if (it) assert.notEqual(it.confidence, 'high');
});
