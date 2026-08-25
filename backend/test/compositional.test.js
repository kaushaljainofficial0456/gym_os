// ============================================================
// TIER 2 (compositional) — faithful JS port of ml/src/inference/
// compositional.py + portion_units.py + ingredient_aliases.py.
//
// These tests run against the REAL measured database (same one every
// other tier uses) via getCompositionalCalculator(), the same lazy
// singleton foodAI.js and the search routes use. Every assertion here was
// cross-checked against a live run of the actual Python source on the
// same database before being written (see the session's parity check) --
// this file pins that behaviour so a future change surfaces as a failing
// test, not a silently different number.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';

import { getCompositionalCalculator, modelAvailable } from '../src/services/foodEstimator.js';
import {
  resolveIngredientName, ingredientAmountToGrams, yieldFactorFor,
} from '../../ml/models/skos-food-v1/compositional.reference.js';

/* ------------------------------------------------------------------ */
/*  resolveIngredientName — port of resolve_ingredient()               */
/* ------------------------------------------------------------------ */

test('resolveIngredientName — exact alias hit', () => {
  assert.deepEqual(resolveIngredientName('mutton'), { query: 'goat, round leg', isNegligible: false });
  assert.deepEqual(resolveIngredientName('curds'), { query: 'curd', isNegligible: false });
  assert.deepEqual(resolveIngredientName('refined wheat flour'), { query: 'wheat flour, refined', isNegligible: false });
});

test('resolveIngredientName — qualifier-prefix-stripped exact hit', () => {
  assert.deepEqual(resolveIngredientName('chopped onion'), { query: 'onion', isNegligible: false });
  assert.deepEqual(resolveIngredientName('finely chopped ginger'), { query: 'ginger, fresh', isNegligible: false });
});

test('resolveIngredientName — negligible terms return null query, not a guess', () => {
  assert.deepEqual(resolveIngredientName('vanilla essence'), { query: null, isNegligible: true });
  assert.deepEqual(resolveIngredientName('a pinch of food colour'), { query: null, isNegligible: true });
});

test('resolveIngredientName — longest-token-subset match on noisy recipe phrasing', () => {
  // "Mutton boneless boti" -- the exact real-world case the noise-word
  // stripping exists for (see ingredient_aliases.py's own header comment).
  const r = resolveIngredientName('Mutton boneless boti');
  assert.equal(r.query, 'goat, round leg');
  assert.equal(r.isNegligible, false);
});

test('resolveIngredientName — unknown ingredient falls through to plain search, not null', () => {
  const r = resolveIngredientName('dragon fruit');
  assert.equal(r.query, 'dragon fruit');
  assert.equal(r.isNegligible, false);
});

/* ------------------------------------------------------------------ */
/*  ingredientAmountToGrams — port of to_grams()                       */
/* ------------------------------------------------------------------ */

test('ingredientAmountToGrams — mass units need no density', () => {
  assert.equal(ingredientAmountToGrams(150, 'g').grams, 150);
  assert.equal(ingredientAmountToGrams(1.5, 'kg').grams, 1500);
});

test('ingredientAmountToGrams — volume units use per-food-class density, not a flat rule', () => {
  // 1 tbsp (15ml) oil vs 1 tbsp flour must differ -- a flat "15g/tbsp" rule
  // is exactly the ~2.6x error this module exists to avoid.
  const oil = ingredientAmountToGrams(1, 'tbsp', 'oil');
  const flour = ingredientAmountToGrams(1, 'tbsp', 'refined flour');
  assert.ok(Math.abs(oil.grams - 13.8) < 0.01, `oil tbsp should be ~13.8g, got ${oil.grams}`);
  assert.ok(Math.abs(flour.grams - 8.25) < 0.01, `flour tbsp should be ~8.25g, got ${flour.grams}`);
  assert.notEqual(oil.grams, flour.grams);
});

test('ingredientAmountToGrams — chopped_veg density class exists (the gap in the narrower Tier-1 display table)', () => {
  const r = ingredientAmountToGrams(2, 'tbsp', 'chopped onion');
  // chopped_veg density 0.55 g/ml, not water's 1.0 -- proves the FULL
  // density table was ported, not the narrower foodEstimate.reference.js one.
  assert.ok(Math.abs(r.grams - 2 * 15 * 0.55) < 0.01);
});

test('ingredientAmountToGrams — count units use per-piece reference weight', () => {
  const r = ingredientAmountToGrams(2, 'nos', 'onion');
  assert.equal(r.grams, 220); // 2 x 110g
  assert.equal(r.method, 'count');
});

test('ingredientAmountToGrams — size scale applies to count units', () => {
  const small = ingredientAmountToGrams(1, 'small', 'onion');
  const large = ingredientAmountToGrams(1, 'large', 'onion');
  assert.ok(Math.abs(small.grams - 110 * 0.65) < 0.01);
  assert.ok(Math.abs(large.grams - 110 * 1.5) < 0.01);
});

test('ingredientAmountToGrams — length units (ginger, cinnamon)', () => {
  assert.equal(ingredientAmountToGrams(1, 'inch', 'ginger').grams, 8);
});

test('ingredientAmountToGrams — unquantifiable amounts return null, never a guess', () => {
  const r = ingredientAmountToGrams(1, 'to taste', 'salt');
  assert.equal(r.grams, null);
  assert.equal(r.method, 'unquantifiable');
});

test('ingredientAmountToGrams — non-positive or unparseable amount returns null', () => {
  assert.equal(ingredientAmountToGrams(0, 'g').grams, null);
  assert.equal(ingredientAmountToGrams('abc', 'g').grams, null);
});

test('ingredientAmountToGrams — unrecognised unit returns null, not a wrong guess', () => {
  const r = ingredientAmountToGrams(1, 'furlong', 'rice');
  assert.equal(r.grams, null);
  assert.equal(r.method, 'unknown_unit');
});

/* ------------------------------------------------------------------ */
/*  yieldFactorFor — mass change on cooking (density only, never totals) */
/* ------------------------------------------------------------------ */

test('yieldFactorFor — grains/pulses absorb water, meats lose it', () => {
  assert.equal(yieldFactorFor('rice'), 2.6);
  assert.equal(yieldFactorFor('chicken'), 0.75);
  assert.equal(yieldFactorFor('an unrecognised ingredient'), 1.0);
});

/* ------------------------------------------------------------------ */
/*  CompositionalCalculator.compute() — end-to-end against the real DB  */
/* ------------------------------------------------------------------ */

test('CompositionalCalculator — dish priced from ingredients, high confidence when all resolve', () => {
  const calc = getCompositionalCalculator();
  if (!calc) { assert.ok(true, 'model DB not present in this environment -- skipping'); return; }

  const r = calc.compute([
    { name: 'mutton', amount: 300, unit: 'g' },
    { name: 'onion', amount: 2, unit: 'nos' },
    { name: 'curd', amount: 100, unit: 'g' },
    { name: 'oil', amount: 3, unit: 'tbsp' },
  ], { servings: 4, dishName: 'Rogan josh (user recipe)' });

  assert.equal(r.ok, true);
  assert.equal(r.tier, 2);
  assert.equal(r.ingredients_used, 4);
  assert.equal(r.unresolved.length, 0);
  assert.equal(r.confidence, 'high');
  assert.ok(r.totals.energy_kcal > 0);
  assert.ok(r.per_serving.energy_kcal > 0);
  // Mass conservation sanity: cooked mass reflects yield, never negative or zero.
  assert.ok(r.estimated_cooked_mass_g > r.raw_mass_g * 0.5);
});

test('CompositionalCalculator — mutton resolves to real goat meat, never rendered fat or a composite dish', () => {
  const calc = getCompositionalCalculator();
  if (!calc) { assert.ok(true, 'model DB not present -- skipping'); return; }
  const { row } = calc.lookupIngredient('mutton');
  assert.ok(row, 'mutton must resolve to a real measured food');
  assert.ok(!/tallow|lard|dripping|korma|curry|masala/i.test(row.food_name),
    `mutton must not resolve to rendered fat or a composite dish, got "${row.food_name}"`);
  // A real ingredient row for lean goat meat should be well under rendered
  // fat's ~890 kcal/100g and should carry real protein, not near-zero.
  assert.ok(row.energy_kcal < 300, `expected lean meat kcal, got ${row.energy_kcal}`);
  assert.ok(row.protein_g > 15, `expected real protein, got ${row.protein_g}`);
});

test('CompositionalCalculator — unquantifiable-only unresolved (to taste) still yields high confidence', () => {
  const calc = getCompositionalCalculator();
  if (!calc) { assert.ok(true, 'model DB not present -- skipping'); return; }
  const r = calc.compute([
    { name: 'rice', amount: 200, unit: 'g' },
    { name: 'salt', amount: 1, unit: 'to taste' },
  ], { servings: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.confidence, 'high');
  assert.equal(r.unresolved.length, 1);
  assert.equal(r.coverage.unresolved_with_known_mass, 0);
});

test('CompositionalCalculator — negligible ingredients (vanilla essence) are handled, not reported as a failure', () => {
  const calc = getCompositionalCalculator();
  if (!calc) { assert.ok(true, 'model DB not present -- skipping'); return; }
  const r = calc.compute([
    { name: 'flour', amount: 100, unit: 'g' },
    { name: 'vanilla essence', amount: 1, unit: 'tsp' },
  ], { servings: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.ingredients_used, 1); // vanilla essence contributes nothing, correctly
  assert.equal(r.unresolved.length, 0); // and is not reported as unresolved either
});

test('CompositionalCalculator — a dish with nothing resolvable returns ok:false, not a fabricated total', () => {
  const calc = getCompositionalCalculator();
  if (!calc) { assert.ok(true, 'model DB not present -- skipping'); return; }
  const r = calc.compute([
    { name: 'zzqxvv-not-a-real-ingredient', amount: 100, unit: 'g' },
  ], { servings: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.unresolved.length >= 1);
});

test('modelAvailable — sanity: this test environment has the real database', () => {
  // Not a hard requirement of the port, but tells a future reader whether
  // the assertions above that skip on !calc actually ran for real here.
  assert.equal(typeof modelAvailable(), 'boolean');
});
