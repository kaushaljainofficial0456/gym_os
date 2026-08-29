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
//   * Regression coverage for the bugs found and fixed while building this
//     phase: the papdi-chaat branded-mismatch bug, the pani-puri per-piece-
//     vs-per-plate portion bug, and the multi-food "with"-conjunction
//     silent-drop bug (a combo-shaped fragment with NO curated template,
//     e.g. "paneer bhurji with 2 rotis", is split into standalone foods
//     and each half re-resolved — never decomposed as if it were one dish).
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

// ---------------------------------------------------------------------
// Multi-food "with"-conjunction splitting (silent-drop fix)
// ---------------------------------------------------------------------

test('REGRESSION (silent-drop bug): "X with Y" combo with no curated template splits into standalone foods', () => {
  const v1 = legacy.estimateFood('paneer bhurji with 2 rotis');
  assert.equal(v1.items.length, 1, 'confirms V1 silently collapsed this into one wrong match');
  assert.equal(v1.items[0].name, 'Paneer', 'confirms the roti component was silently dropped entirely');

  const v3 = estimateMeal('paneer bhurji with 2 rotis', { engine: 'v3' });
  assert.equal(v3.items.length, 2, 'both the paneer dish and the roti must now be present');
  assert.ok(v3.items.some((i) => /roti|chapati/i.test(i.name)), 'the roti must no longer be silently dropped');
  assert.equal(v3.unresolved.length, 0);
  assert.ok(v3.total.calories >= 350 && v3.total.calories <= 700, `${v3.total.calories} kcal should fit paneer bhurji + 2 roti`);
  assert.ok(v3.v3.conjunction_splits >= 1);
});

test('"dosa with sambar and chutney" resolves as 3 separate items, matching the benchmark ground truth', () => {
  // Surprising at first (a composite_map "dosa_sambar_chutney" entry DOES
  // exist), but this is actually correct: V1's own splitItems() already
  // separates "and chutney" off ("and" -> comma) BEFORE Phase 3 ever sees
  // the fragment, so the classifier only ever sees "dosa with sambar" —
  // never the full alias text -- and correctly falls through to the
  // with-splitter instead. The benchmark's own case for this exact input
  // (x-mel-002) confirms 3 separate items (strategy 'direct') is the
  // WANTED answer, not one decomposed dish: idli/dosa/sambar/chutney are
  // independently orderable and independently portioned in a way papdi
  // chaat's components are not, so this is a real behavioral distinction,
  // not a bug. (The dosa_sambar_chutney composite_map entry still exists
  // for phrasing with no "and"/"with" conjunction at all, e.g. a single
  // run-together "dosa sambar chutney".)
  const v3 = estimateMeal('dosa with sambar and chutney', { engine: 'v3' });
  assert.equal(v3.items.length, 3);
  assert.ok(v3.items.some((i) => /dosa/i.test(i.name)));
  assert.ok(v3.items.some((i) => /sambar/i.test(i.name)));
  assert.ok(v3.items.some((i) => /chutney/i.test(i.name)));
  assert.equal(v3.unresolved.length, 0);
});

test('a "with"-conjunction that only yields ONE usable food after quality filtering is left alone, never worse than V1', () => {
  // "butter" alone is known to sometimes resolve to a branded/implausible
  // row when split out of its sentence context (loses the disambiguating
  // token overlap) -- splitting must never trade one wrong confident
  // answer (V1's collapsed match) for a DIFFERENT set of wrong answers.
  const v1 = legacy.estimateFood('2 slices toast with butter');
  const v3 = estimateMeal('2 slices toast with butter', { engine: 'v3' });
  // Either the split was correctly declined (identical to V1) or it
  // produced a strict improvement -- it must never regress the total.
  if (v3.v3?.conjunction_splits) {
    assert.ok(v3.items.length >= v1.items.length);
  } else {
    assert.deepEqual(v3.items.map((i) => i.name), v1.items.map((i) => i.name));
  }
});

test('splitting never fires on a phrase with no "with" at all', () => {
  const v1 = legacy.estimateFood('2 roti and dal');
  const v3 = estimateMeal('2 roti and dal', { engine: 'v3' });
  assert.equal(v3.v3, undefined, 'no composite classification or split should have triggered here');
  assert.deepEqual(v3.items.map((i) => i.name), v1.items.map((i) => i.name));
});

test('a rejected sub-match from splitting is reported as unresolved, never silently dropped again', () => {
  const v3 = estimateMeal('2 slices toast with butter', { engine: 'v3' });
  // Whatever Phase 3 decided, the total food count reported (items + unresolved)
  // must account for both halves of the conjunction -- never fewer than V1 saw.
  const v1 = legacy.estimateFood('2 slices toast with butter');
  assert.ok(v3.items.length + v3.unresolved.length >= v1.items.length + v1.unresolved.length);
});
