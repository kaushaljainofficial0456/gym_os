// ============================================================
// PHASE 1 — canonical food core: BEHAVIOUR-PARITY GUARD
//
// Proves the new `services/food/` layer returns EXACTLY what the pre-existing
// `foodEstimator.js` primitives return — same shapes, same numbers, same
// never-fabricate behaviour — for a spread of inputs (grams, counts, volume,
// multi-food, ambiguous, quarantined-alias, non-food, empty). If a later
// phase ever changes `estimateMeal` away from a pass-through, this fails.
//
// Also: exactly ONE FoodSearch class ships (the retired skos-food/*.cjs
// duplicate is gone), and the contains-pass trust leak is closed.
// ============================================================
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as legacy from '../src/services/foodEstimator.js';
import * as food from '../src/services/food/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const INPUTS = [
  '2 roti', '1 roti', '150g chicken breast', '2 eggs and 1 banana',
  '1 bowl dal', '81g puri', '30g puri', '206g papdi chaat', 'papdi chaat',
  '2 roti, dal and curd', 'rajma chawal', 'chole bhature', 'pav bhaji',
  'poha', 'upma', '1 bowl rajma', 'paneer butter masala', 'masala dosa',
  'rice', '100 g paneer', 'quantum flux capacitor', '', '   ',
  'egg', 'chicken', '2 bowls dal', '1 plate rice', '3 chapati', '1 apple',
];

test('estimateMeal(text) is byte-identical to estimateFood(text)', () => {
  for (const s of INPUTS) {
    const a = legacy.estimateFood(s);
    const b = food.estimateMeal(s);
    assert.deepEqual(b, a, `mismatch for input ${JSON.stringify(s)}`);
  }
});

test('estimateMeal(null|undefined) matches estimateFood — no crash, no fabrication', () => {
  assert.deepEqual(food.estimateMeal(null), legacy.estimateFood(null));
  assert.deepEqual(food.estimateMeal(undefined), legacy.estimateFood(undefined));
});

test('resolveFood(query, opts) is identical to searchFoods(query, opts)', () => {
  for (const q of ['tomato', 'paneer', 'dal', 'chicken', 'poori', 'oreo', 'milk']) {
    for (const opts of [{}, { limit: 4 }, { limit: 6, withPortions: false }]) {
      assert.deepEqual(food.resolveFood(q, opts), legacy.searchFoods(q, opts), `q=${q} opts=${JSON.stringify(opts)}`);
    }
  }
});

test('priceFood(food, opts) is identical to resolveFoodQuantity(food, opts)', () => {
  const hits = legacy.searchFoods('paneer', { limit: 1, withPortions: false });
  assert.ok(hits.length, 'need a match to price');
  const f = hits[0];
  for (const opts of [{ grams: 150 }, { portionKey: 'katori', count: 1 }, { grams: 100, oilLevel: 'low' }, {}]) {
    assert.deepEqual(
      food.priceFood(f, opts),
      legacy.resolveFoodQuantity(f, opts),
      `opts=${JSON.stringify(opts)}`);
  }
});

test('the canonical barrel re-exports every legacy primitive (same reference)', () => {
  for (const name of [
    'estimateFood', 'searchFoods', 'resolveFoodQuantity', 'getFoodSearch', 'modelAvailable',
    'scaleNutrition', 'estimateFromBarcode', 'estimateCompositional', 'estimateFoodKnn',
    'getCompositionalCalculator', 'getKnnFallback', 'getBarcodeIndex', 'cleanCode',
    'canonicalEan13', 'resolveServing', 'splitItems', 'parseFragment', 'SOURCE_RANK',
  ]) {
    assert.equal(food[name], legacy[name], `food.${name} must be the same reference as legacy.${name}`);
  }
  // `normalize` on the barrel is deliberately the pipeline STAGE, not the raw
  // string primitive — it returns { raw, text, tokens }, not a bare string.
  assert.equal(typeof food.normalize('x').text, 'string');
  assert.notEqual(food.normalize, legacy.normalize);
});

test('`foodSearch` (skos-food replacement) delegates to the ONE canonical FoodSearch', () => {
  const idx = legacy.getFoodSearch();
  assert.ok(idx, 'model must be available');
  for (const q of ['paneer', 'chapati roti', 'nonexistent-xyzzy-food']) {
    const viaCore = food.foodSearch.search(q, { limit: 3, allowBackoff: true });
    const direct = idx.search(q, { limit: 3, allowBackoff: true });
    assert.deepEqual(viaCore, direct, `foodSearch.search must equal getFoodSearch().search for "${q}"`);
  }
  // `me.js` POST /meals/:id/items calls it exactly this way:
  const r = food.foodSearch.search('paneer', { limit: 1, allowBackoff: true });
  assert.ok(Array.isArray(r) && r.length && r[0].food_name, 'meal-builder fallback lookup still resolves a name');
});

test('the retired duplicate engine is gone and only ONE FoodSearch class ships', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'backend', 'src', 'services', 'skos-food')),
    'backend/src/services/skos-food/ must be deleted');

  // grep the shipped source for `class FoodSearch` definitions
  const roots = [path.join(ROOT, 'backend', 'src'), path.join(ROOT, 'ml', 'models', 'skos-food-v1')];
  const defs = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!/\.(js|cjs|mjs)$/.test(e.name) || /\.test\.[cm]?js$/.test(e.name)) continue;
      const src = fs.readFileSync(p, 'utf8');
      if (/\bclass\s+FoodSearch\b/.test(src)) defs.push(path.relative(ROOT, p));
    }
  };
  roots.forEach(walk);
  assert.deepEqual(defs, ['ml\\models\\skos-food-v1\\foodEstimate.reference.js'.replace(/\\/g, path.sep)],
    `expected exactly one FoodSearch definition, found: ${JSON.stringify(defs)}`);
});

test('contains-pass leak closed: a data_quality_flag row surfaced by name_contains is labelled untrustworthy', () => {
  // "poori" — INDB "Poori" (frying-bath data_quality_flag) is reachable via the
  // ranked alias path AND the contains pass ("...poori..." substrings). Every
  // returned candidate carrying a data_quality_flag must be trustworthy:false
  // + confidence:'unreliable', regardless of which pass produced it.
  const results = legacy.searchFoods('poori', { limit: 8, withPortions: false });
  const flagged = results.filter((r) => r.data_quality_flag);
  assert.ok(flagged.length >= 1, 'expected at least one data_quality_flagged "poori" candidate');
  for (const r of flagged) {
    assert.equal(r.trustworthy, false, `"${r.food_name}" (${r.match_kind}) has a data_quality_flag but trustworthy=${r.trustworthy}`);
    assert.equal(r.confidence, 'unreliable', `"${r.food_name}" (${r.match_kind}) confidence=${r.confidence}, expected 'unreliable'`);
  }
  // and a name_contains candidate WITHOUT a flag keeps the honest 'low' floor
  const cleanContains = results.find((r) => r.match_kind === 'name_contains' && !r.data_quality_flag);
  if (cleanContains) {
    assert.equal(cleanContains.trustworthy, true);
    assert.ok(['low', 'medium', 'high'].includes(cleanContains.confidence));
  }
});
