// ============================================================
// STANDARD RECIPES (food/recipes.js) and the regional dishes they price.
//
// What must hold:
//   - every ingredient is a real, non-quarantined measured row
//   - the arithmetic is the documented yield method, exactly
//   - every recipe dish is internally consistent (energy ~ Atwater of its
//     own macros) and plausible for a cooked dish
//   - a recipe value is labelled recipe_calculation, never verified
//   - unmeasured ingredient nutrients are REPORTED, not counted as zero
//   - the parser finds these dishes, and splits the classic pairings
// ============================================================
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import { RECIPES, priceRecipe, recipeRefs, RECIPE_NUTRIENTS } from '../src/services/food/recipes.js';
import { getFoodSearch, estimateFood, modelAvailable } from '../src/services/foodEstimator.js';
import { nutritionSourceForRow } from '../src/services/nutrition/provenance.js';

const live = modelAvailable();

test('priceRecipe is the yield method: Σ(ingredient × g/100) ÷ cooked_g × 100', () => {
  const rows = new Map([
    ['a', { food_name: 'A', energy_kcal: 400, protein_g: 10, carb_g: 80, fat_g: 2, fiber_g: 5, sugar_g: 1, sodium_mg: 10, calcium_mg: 20, iron_mg: 2 }],
    ['b', { food_name: 'B', energy_kcal: 900, protein_g: 0, carb_g: 0, fat_g: 100, fiber_g: 0, sugar_g: 0, sodium_mg: 0, calcium_mg: 0, iron_mg: 0 }],
  ]);
  const r = priceRecipe({ ingredients: [{ ref: 'a', g: 100 }, { ref: 'b', g: 10 }], cooked_g: 200 }, rows);
  // (400 + 90) / 200 * 100 = 245
  assert.equal(r.per100.energy_kcal, 245);
  assert.equal(r.per100.protein_g, 5);
  assert.equal(r.per100.fat_g, 6);
  assert.equal(r.raw_g, 110);
  assert.deepEqual(r.incomplete, []);
});

test('a missing ingredient row makes the whole recipe unavailable (never priced without it)', () => {
  const rows = new Map([['a', { food_name: 'A', energy_kcal: 100, protein_g: 1, carb_g: 1, fat_g: 1 }]]);
  assert.equal(priceRecipe({ ingredients: [{ ref: 'a', g: 50 }, { ref: 'missing', g: 5 }], cooked_g: 50 }, rows), null);
});

test('an unmeasured macro is reported in `incomplete`; an unmeasured micronutrient makes it unknown', () => {
  const rows = new Map([
    ['p', { food_name: 'Paneer', energy_kcal: 305, protein_g: 19, carb_g: null, fat_g: 25, fiber_g: null }],
    ['o', { food_name: 'Onion', energy_kcal: 48, protein_g: 1.5, carb_g: 9.6, fat_g: 0.2, fiber_g: 2.5 }],
  ]);
  const r = priceRecipe({ ingredients: [{ ref: 'p', g: 100 }, { ref: 'o', g: 50 }], cooked_g: 140 }, rows);
  assert.deepEqual(r.incomplete, ['carb_g of Paneer']);
  assert.equal(r.per100.fiber_g, null, 'fibre unknown for paneer -> unknown for the dish, not a partial sum');
  assert.ok(r.per100.carb_g > 0, 'the measured onion carbs still count');
});

test('every recipe ingredient is a real, trustworthy measured row', { skip: !live }, () => {
  const s = getFoodSearch();
  for (const ref of recipeRefs()) {
    const row = s.bySourceId.get(ref);
    assert.ok(row, `missing ingredient row ${ref}`);
    assert.ok(!row.data_quality_flag, `${ref} is quarantined: ${row.data_quality_flag}`);
    assert.ok(row.energy_kcal != null, `${ref} has no energy value`);
  }
});

test('every recipe documents its basis, batch and yield', () => {
  for (const [key, r] of Object.entries(RECIPES)) {
    assert.ok(r.name && r.basis && r.batch_serves, key);
    assert.ok(r.cooked_g > 0, key);
    assert.ok(r.ingredients.length >= 1, key);
    // A finished dish can lose cooking water but not most of its dry matter:
    // a yield below 60% of the raw weight would be a data-entry error.
    const raw = r.ingredients.reduce((s, i) => s + i.g, 0);
    assert.ok(r.cooked_g >= raw * 0.6, `${key}: cooked ${r.cooked_g} g vs raw ${raw} g`);
  }
});

test('every recipe dish is Atwater-consistent and plausible for a cooked dish', { skip: !live }, () => {
  const s = getFoodSearch();
  for (const key of Object.keys(RECIPES)) {
    const row = [...s.bySourceId.values()].find((r) => r.source_id === `recipe:${key}`);
    assert.ok(row, `recipe:${key} not in the index`);
    const atw = 4 * row.protein_g + 4 * row.carb_g + 9 * row.fat_g;
    // IFCT reports energy with its own conversion factors, so a few percent
    // of drift from 4/4/9 is expected; more would mean a broken recipe.
    assert.ok(Math.abs(row.energy_kcal - atw) / row.energy_kcal < 0.06, `${key}: ${row.energy_kcal} vs Atwater ${atw.toFixed(0)}`);
    assert.ok(row.energy_kcal >= 40 && row.energy_kcal <= 600, `${key}: ${row.energy_kcal} kcal/100g`);
    assert.equal(nutritionSourceForRow(row), 'recipe_calculation');
    assert.equal(row.confidence, 'medium', 'a recipe estimate is never presented at high confidence');
    for (const k of RECIPE_NUTRIENTS) assert.ok(k in row, `${key} lacks ${k}`);
  }
});

const names = (r) => r.items.map((i) => i.name.toLowerCase());

test('the dishes that had no answer, or a wrong one, now resolve to themselves', { skip: !live }, () => {
  const cases = {
    misal: /^misal$/, thalipeeth: /thalipeeth/, pithla: /pithla/, 'jowar bhakri': /jowar bhakri/,
    'ven pongal': /pongal/, 'paneer bhurji': /paneer bhurji/, 'paneer tikka': /paneer tikka/,
    'aloo tikki': /aloo tikki/, 'sabudana vada': /sabudana vada/, kachori: /kachori/, modak: /modak/,
    'rava sheera': /sheera/, 'puran poli': /puran poli/,
  };
  for (const [input, re] of Object.entries(cases)) {
    const r = estimateFood(input);
    assert.equal(r.items.length, 1, `${input} -> ${names(r).join(' | ')}`);
    assert.match(r.items[0].name.toLowerCase(), re, input);
    assert.deepEqual(r.unresolved, [], input);
  }
});

test('puran poli uses the measured INDB row, not a recipe and never a sausage', { skip: !live }, () => {
  const it = estimateFood('puran poli').items[0];
  assert.equal(it.source_id, 'indb:ASC467');
});

test('classic pairings split into their parts with the customary accompaniment', { skip: !live }, () => {
  const mp = estimateFood('misal pav');
  assert.deepEqual(names(mp), ['misal', 'pav']);
  assert.equal(mp.items[1].qty, 2, 'misal comes with two pav');

  const cb = estimateFood('chole bhature');
  assert.deepEqual(names(cb), ['chole', 'bhatura']);
  assert.equal(cb.items[1].qty, 2);

  // A number counts the side that comes in pieces.
  const cb2 = estimateFood('3 chole bhature');
  assert.equal(cb2.items.find((i) => /bhatura/i.test(i.name)).qty, 3);

  assert.deepEqual(names(estimateFood('pithla bhakri')), ['pithla', 'jowar bhakri']);
  assert.deepEqual(names(estimateFood('idli vada sambar')), ['idli', 'medu vada', 'sambar']);
  assert.deepEqual(names(estimateFood('dal chawal papad')), ['dal', 'rice (cooked)', 'papad (roasted)']);
});

test('a bhatura is priced with absorbed oil, not the frying bath', { skip: !live }, () => {
  const b = estimateFood('1 bhatura').items[0];
  const kcalPer100 = (b.calories / b.grams) * 100;
  // INDB's quarantined row is 793 kcal/100 g (frying bath counted).
  assert.ok(kcalPer100 > 300 && kcalPer100 < 450, `${kcalPer100.toFixed(0)} kcal/100g`);
});
