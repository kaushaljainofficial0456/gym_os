// ============================================================
// PHASE 2 — v2 engine (plausibility downgrade + quarantine rescue)
//
// Contract:
//   * FLAG OFF  → byte-identical to V1 (estimateFood). The frozen baseline.
//   * FLAG ON   → V1 result, then:
//       - a data-quality-flagged drop MAY become a labelled `knn_estimate`
//         rescue item (confidence 'low', trustworthy false) — never a silent 0;
//       - an implausible record's confidence MAY drop to 'low' — never a
//         number changed, never a food unresolved that V1 resolved;
//       - parsing, nutrition arithmetic and never-fabricate are untouched.
// ============================================================
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import * as legacy from '../src/services/foodEstimator.js';
import { estimateMeal, applyPhase2 } from '../src/services/food/engine.js';

const OFF_INPUTS = [
  '2 roti', '150g chicken breast', '2 eggs and 1 banana', '1 bowl dal',
  '206g papdi chaat', '2 roti, dal and curd', 'rajma chawal', 'poha',
  'egg', '', '   ', 'quantum flux capacitor', '100 g paneer', 'rice',
  '3 chapati', '1 apple', 'chicken', '2 bowls dal',
];

test('FLAG OFF: estimateMeal(text) is byte-identical to estimateFood(text)', () => {
  for (const s of OFF_INPUTS) {
    assert.deepEqual(estimateMeal(s), legacy.estimateFood(s), `default (no ctx) differs for ${JSON.stringify(s)}`);
    assert.deepEqual(estimateMeal(s, {}), legacy.estimateFood(s), `ctx:{} differs for ${JSON.stringify(s)}`);
    assert.deepEqual(estimateMeal(s, { engine: 'v1' }), legacy.estimateFood(s), `engine:v1 differs for ${JSON.stringify(s)}`);
  }
});

test('FLAG OFF via FOOD_ENGINE_V2 unset — env not set in this suite, default path holds', () => {
  assert.notEqual(process.env.FOOD_ENGINE_V2, '1');
  assert.deepEqual(estimateMeal('206g papdi chaat'), legacy.estimateFood('206g papdi chaat'));
});

test('FLAG ON: a clean common meal is unchanged (no gratuitous downgrades / rescues)', () => {
  for (const s of ['2 roti', '100 g paneer', '1 bowl dal', '2 roti, dal and curd', '150g chicken breast']) {
    const v1 = legacy.estimateFood(s);
    const v2 = estimateMeal(s, { engine: 'v2' });
    assert.deepEqual(v2.items.map((i) => [i.name, i.calories, i.protein, i.carbs, i.fat, i.grams]),
      v1.items.map((i) => [i.name, i.calories, i.protein, i.carbs, i.fat, i.grams]),
      `v2 changed a clean result for ${JSON.stringify(s)}`);
    assert.deepEqual(v2.total, v1.total, `v2 changed the total for ${JSON.stringify(s)}`);
  }
});

test('FLAG ON: a quarantined drop is RESCUED as a labelled estimate, not a silent zero', () => {
  const v1 = legacy.estimateFood('81g puri');
  assert.equal(v1.items.length, 0);
  assert.equal(v1.unresolved.length, 1);
  assert.ok(v1.unresolved[0].matched, 'V1 matched then trust-gated it');

  const v2 = estimateMeal('81g puri', { engine: 'v2' });
  assert.equal(v2.items.length, 1, 'rescued into one item');
  const it = v2.items[0];
  assert.equal(it.estimate_status, 'quarantine_rescue');
  assert.equal(it.source, 'knn_estimate');
  assert.equal(it.source_id, null);
  assert.equal(it.trustworthy, false);
  assert.equal(it.confidence, 'low', 'a rescue is never presented confidently');
  assert.ok(it.calories > 0 && it.grams > 0);
  assert.equal(v2.unresolved.length, 0);
  assert.equal(v2.total.calories, it.calories);
  assert.equal(v2.engine, 'v2');
  assert.ok(v2.v2 && v2.v2.quarantine_rescues >= 1);
});

test('FLAG ON: parsing is preserved — the rescue re-parses the SAME fragment', () => {
  // "81g puri": explicit 81 g must be honoured by the rescue's own grams resolution
  const v2 = estimateMeal('81g puri', { engine: 'v2' });
  assert.equal(v2.items[0].grams, 81);
});

test('FLAG ON: a genuine "no match" is NOT rescued — stays honestly unresolved', () => {
  const v2 = estimateMeal('quantum flux capacitor', { engine: 'v2' });
  assert.equal(v2.items.length, 0);
  assert.equal(v2.unresolved.length, 1);
  assert.equal(v2.total.calories, 0);
  assert.equal(v2.confidence, null);
});

test('FLAG ON: never-fabricate — V2 adds no confident resolution to a non-food that V1 lacked', () => {
  // V1 may already resolve garbage to SOME low-confidence fuzzy match; that is
  // honest, not fabrication. The contract is: V2 must not turn a non-food into
  // a NEW high/medium-confidence number, and must not increase the item count.
  const CONFIDENT = new Set(['high', 'medium']);
  for (const s of ['quantum flux capacitor', 'asdfghjkl', 'the weather today', 'plastic bag', '']) {
    const v1 = legacy.estimateFood(s);
    const v2 = estimateMeal(s, { engine: 'v2' });
    assert.ok(v2.items.length <= v1.items.length, `${s}: v2 added items (${v1.items.length} -> ${v2.items.length})`);
    const v1Confident = v1.items.filter((i) => CONFIDENT.has(i.confidence)).length;
    const v2Confident = v2.items.filter((i) => CONFIDENT.has(i.confidence)).length;
    assert.ok(v2Confident <= v1Confident, `${s}: v2 has more confident items (${v1Confident} -> ${v2Confident})`);
    for (const it of v2.items.filter((i) => i.estimate_status === 'quarantine_rescue')) {
      assert.equal(it.confidence, 'low');
      assert.equal(it.trustworthy, false);
    }
  }
});

test('FLAG ON: an implausible record is DOWNGRADED, never renumbered', () => {
  // find a case where V1 gives a confident item that plausibility rejects
  const cand = ['3 walnut halves', '12 almonds', '1 cup popcorn'];
  let sawDowngrade = false;
  for (const s of cand) {
    const v1 = legacy.estimateFood(s);
    const v2 = estimateMeal(s, { engine: 'v2' });
    if (!v1.items.length || !v2.items.length) continue;
    // numbers identical, only confidence may fall + a `plausibility` note added
    assert.equal(v2.items[0].calories, v1.items[0].calories, `${s}: rescue/plausibility changed a number`);
    assert.equal(v2.items[0].grams, v1.items[0].grams);
    if (v2.items[0].plausibility && v2.items[0].plausibility.verdict === 'hard_fail') {
      assert.equal(v2.items[0].confidence, 'low');
      sawDowngrade = true;
    }
  }
  assert.ok(sawDowngrade, 'expected at least one hard-fail downgrade among the candidates');
});

test('FLAG ON: applyPhase2 on an already-clean result returns the SAME object (no needless copy)', () => {
  const base = legacy.estimateFood('2 roti');
  assert.equal(applyPhase2(base), base);
});

test('FLAG ON: multi-food silent-drop cannot regress — a rescued sub-item is still accounted', () => {
  // A meal whose sub-items all resolve cleanly: v2 must not drop or duplicate anything.
  const v1 = legacy.estimateFood('2 roti, dal and curd');
  const v2 = estimateMeal('2 roti, dal and curd', { engine: 'v2' });
  assert.equal(v2.items.length, v1.items.length);
  assert.equal(v2.unresolved.length, v1.unresolved.length);
});
