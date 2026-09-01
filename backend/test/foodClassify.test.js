// ============================================================
// PHASE 3 — classify.js: composite-dish detection over composite_map.json
//
// Contract:
//   * alias / word-boundary match against a curated dish  -> kind:'composite', dish_key set
//   * combo-pattern text with NO curated template          -> kind:'composite', dish_key:null
//     (the caller must never force a decomposition from this alone)
//   * a plain simple food, or "roti" appearing inside a longer unrelated
//     word, must never classify as composite
//   * degrades to a no-op if the overlay can't be read (never throws)
// ============================================================
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyComposite, getCompositeDish, loadCompositeMap } from '../src/services/food/classify.js';

test('overlay loads and has a healthy number of curated dishes', () => {
  const cfg = loadCompositeMap();
  assert.ok(cfg, 'composite_map.json must load');
  const keys = Object.keys(cfg.dishes || {});
  assert.ok(keys.length >= 40, `expected a substantial curated set, got ${keys.length}`);
});

test('exact alias match resolves to the right dish_key', () => {
  const r = classifyComposite('papdi chaat');
  assert.equal(r.kind, 'composite');
  assert.equal(r.dish_key, 'papdi_chaat');
  assert.equal(r.match, 'alias');
});

test('alias matching is spelling/normalization tolerant (papri vs papdi, chat vs chaat)', () => {
  for (const phrase of ['papri chaat', 'papdi chat', 'papri chat']) {
    const r = classifyComposite(phrase);
    assert.equal(r.dish_key, 'papdi_chaat', `"${phrase}" should still resolve to papdi_chaat`);
  }
});

test('word-boundary containment matches an alias embedded in a longer phrase', () => {
  const r = classifyComposite('3 plates of chole bhature please');
  assert.equal(r.dish_key, 'chole_bhature');
});

test('longest-alias-wins: a phrase matching two aliases picks the more specific one', () => {
  // "roti dal" is itself a curated alias (roti_dal); it must not be shadowed
  // by any shorter, coincidentally-contained alias.
  const r = classifyComposite('roti dal');
  assert.equal(r.dish_key, 'roti_dal');
});

test('combo pattern with no curated template: composite kind, but dish_key stays null', () => {
  // "paneer rice" matches the "X rice" combo shape but has no composite_map entry —
  // the classifier must report the shape without inventing a template.
  const r = classifyComposite('paneer rice');
  assert.equal(r.kind, 'composite');
  assert.equal(r.dish_key, null);
  assert.equal(r.match, 'combo_pattern');
});

test('a simple food is never classified composite', () => {
  for (const s of ['roti', 'rice', 'paneer', 'banana', 'chicken breast', 'dal', 'egg']) {
    const r = classifyComposite(s);
    assert.equal(r.kind, 'unknown', `"${s}" must not be classified composite`);
    assert.equal(r.dish_key, null);
  }
});

test('word-boundary matching never fires on a substring inside an unrelated word', () => {
  // "dal" must not match inside "dalchini" (cinnamon) via naive substring containment.
  const r = classifyComposite('dalchini powder');
  assert.notEqual(r.dish_key, 'roti_dal');
  assert.notEqual(r.dish_key, 'dal_rice');
});

test('empty / whitespace input classifies as unknown, never throws', () => {
  for (const s of ['', '   ', null, undefined]) {
    const r = classifyComposite(s);
    assert.equal(r.kind, 'unknown');
    assert.equal(r.dish_key, null);
  }
});

test('getCompositeDish returns the full template for a known key, null otherwise', () => {
  const dish = getCompositeDish('papdi_chaat');
  assert.ok(dish);
  assert.ok(Array.isArray(dish.components) && dish.components.length > 0);
  assert.equal(getCompositeDish('not_a_real_dish'), null);
  assert.equal(getCompositeDish(null), null);
});

test('every curated dish has components whose fractions sum close to 1.0', () => {
  const cfg = loadCompositeMap();
  for (const [key, dish] of Object.entries(cfg.dishes)) {
    const sum = dish.components.reduce((s, c) => s + (Number(c.typical_fraction) || 0), 0);
    assert.ok(Math.abs(sum - 1) < 0.05, `${key}: fractions sum to ${sum}, expected ~1.0`);
    assert.ok(Number(dish.typical_serving_g) > 0, `${key}: typical_serving_g must be > 0`);
    for (const c of dish.components) {
      assert.ok(typeof c.name === 'string' && c.name.length > 0, `${key}: component missing a name`);
    }
  }
});

test('every curated dish has at least one alias and a cuisine tag', () => {
  const cfg = loadCompositeMap();
  for (const [key, dish] of Object.entries(cfg.dishes)) {
    assert.ok(Array.isArray(dish.aliases) && dish.aliases.length > 0, `${key}: needs at least one alias`);
    assert.ok(typeof dish.cuisine === 'string' && dish.cuisine.length > 0, `${key}: needs a cuisine tag`);
  }
});

test('an alias containing the literal word "with" still matches on the RAW phrase', () => {
  // Regression guard: engine.js must classify against the raw fragment, not
  // foodEstimator's parseFragment()-cleaned name -- parseFragment strips
  // "with" as noise (and can misread a leading dish word as a unit token),
  // so an alias like "dosa with sambar and chutney" or "aloo paratha with
  // curd" would be silently unmatchable if fed the cleaned name instead.
  for (const [phrase, expectedKey] of [
    ['dosa with sambar and chutney', 'dosa_sambar_chutney'],
    ['aloo paratha with curd', 'aloo_paratha_curd'],
    ['undhiyu with puri', 'undhiyu_puri'],
  ]) {
    const r = classifyComposite(phrase);
    assert.equal(r.dish_key, expectedKey, `"${phrase}" should match ${expectedKey} on the raw phrase`);
  }
});
