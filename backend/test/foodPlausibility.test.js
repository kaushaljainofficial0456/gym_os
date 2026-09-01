// ============================================================
// PHASE 2 — plausibility stage: unit tests
//
// The overlay bounds are WIDE by design (bound "wrong kind of food / unit
// error / internally-inconsistent record", not "unusual recipe"). These tests
// pin: a clearly-off record hard_fails, a normal record passes, the bounds
// are class-aware, and the check never touches a nutrition value.
// ============================================================
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkPlausibility, coarseClassOf, coarsePrepOf, loadPlausibility, _resetForTests,
} from '../src/services/food/plausibility.js';

test('overlay loads', () => {
  _resetForTests();
  const cfg = loadPlausibility();
  assert.ok(cfg && cfg.ranges && cfg.ranges.ingredient && cfg.ranges.dish);
});

test('coarseClassOf — deterministic, row-derived', () => {
  assert.equal(coarseClassOf({ name: 'Amul Butter' }, { brand: 'Amul' }), 'branded_product');
  assert.equal(coarseClassOf({ name: 'Orange juice' }, null), 'beverage');
  assert.equal(coarseClassOf({ name: 'Tomato ketchup' }, null), 'condiment');
  assert.equal(coarseClassOf({ name: 'Chicken curry' }, null), 'dish');
  assert.equal(coarseClassOf({ name: 'Masala dosa' }, { category: 'indian_dish' }), 'dish');
  assert.equal(coarseClassOf({ name: 'Paneer' }, null), 'ingredient');
});

test('coarsePrepOf — name keywords beat a missing cooking_state', () => {
  assert.equal(coarsePrepOf({ name: 'Poori', cooking_state: 'unspecified' }, null), 'fried');
  assert.equal(coarsePrepOf({ name: 'Boiled rice', cooking_state: 'cooked' }, null), 'cooked');
  assert.equal(coarsePrepOf({ name: 'Apple', cooking_state: 'raw' }, null), 'raw');
  assert.equal(coarsePrepOf({ name: 'Something', cooking_state: 'ready_to_eat' }, null), 'any');
});

test('a normal ingredient record PASSES', () => {
  // 150 g cooked chicken breast ≈ 250 kcal, 38 P, 0 C, 10 F
  const r = checkPlausibility({ name: 'Chicken breast', calories: 250, protein: 38, carbs: 0, fat: 10, grams: 150, cooking_state: 'cooked' }, null);
  assert.equal(r.verdict, 'pass', JSON.stringify(r));
});

test('an internally-inconsistent record HARD-fails (Atwater)', () => {
  // 100 g "curd" claiming 65 kcal but 9.4 P / 5.1 C / 5.4 F  → Atwater ≈ 107, ratio 0.61
  // (below cfg.atwater.min_ratio 0.50? no — tune: this is a soft case) — use a clearer one:
  const r = checkPlausibility({ name: 'Mystery paste', calories: 500, protein: 2, carbs: 3, fat: 1, grams: 100 }, null);
  assert.equal(r.verdict, 'hard_fail');
  assert.ok(r.reasons.some((x) => /atwater/i.test(x)));
});

test('an absurd scaled result HARD-fails on density', () => {
  // one "item" at 900 kcal / 100 g and 80 g fat / 100 g — nothing edible is that dense except pure oil,
  // and this is tagged an ingredient (not a condiment)
  const r = checkPlausibility({ name: 'Rice bowl', calories: 900, protein: 5, carbs: 10, fat: 88, grams: 100, cooking_state: 'cooked' }, null);
  assert.equal(r.verdict, 'hard_fail');
});

test('beverages are exempt from the Atwater flag (ethanol / sugar-alcohol energy)', () => {
  // 330 ml beer ≈ 145 kcal, ~0.5 P / 13 C / 0 F → Atwater ≈ 52, ratio ≈ 2.8 — legit for beer
  const r = checkPlausibility({ name: 'Beer', calories: 145, protein: 0.5, carbs: 13, fat: 0, grams: 330 }, null);
  assert.ok(r.verdict !== 'hard_fail', JSON.stringify(r));
  assert.ok(!r.reasons.some((x) => /atwater/i.test(x)));
});

test('condiment class allows very high energy density (oil, nut butter)', () => {
  // 2 tbsp olive oil ≈ 27 g, 240 kcal, 0/0/27 → 889 kcal/100 g — fine for a condiment
  const r = checkPlausibility({ name: 'Olive oil', calories: 240, protein: 0, carbs: 0, fat: 27, grams: 27 }, null);
  assert.equal(r.verdict, 'pass', JSON.stringify(r));
});

test('missing / zero grams → no judgement (pass), never throws', () => {
  assert.equal(checkPlausibility({ name: 'x', calories: 100, grams: 0 }, null).verdict, 'pass');
  assert.equal(checkPlausibility({ name: 'x', calories: 100 }, null).verdict, 'pass');
  assert.equal(checkPlausibility(null, null).verdict, 'pass');
});

test('checkPlausibility never mutates the item', () => {
  const item = Object.freeze({ name: 'Rice bowl', calories: 900, protein: 5, carbs: 10, fat: 88, grams: 100 });
  assert.doesNotThrow(() => checkPlausibility(item, null)); // frozen → a write would throw
});

test('classHint overrides the row-derived class (Phase 3 hook)', () => {
  // same numbers, judged as a "dish" instead of the derived "ingredient"
  const asIngredient = checkPlausibility({ name: 'foo', calories: 450, protein: 3, carbs: 60, fat: 20, grams: 100 }, null);
  const asDish = checkPlausibility({ name: 'foo', calories: 450, protein: 3, carbs: 60, fat: 20, grams: 100 }, null, { classHint: 'dish', prepHint: 'cooked' });
  assert.ok(asIngredient.verdict !== undefined && asDish.verdict !== undefined);
  assert.equal(asDish.klass, 'dish');
});
