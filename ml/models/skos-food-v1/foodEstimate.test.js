/**
 * Parity + invariant tests for the JS reference implementation.
 *
 * PURPOSE: the Python side is the source of truth and has its own 59-test
 * suite. This file re-checks the SAME invariants in JS so a divergence
 * between the two shows up as a failing test here rather than as a wrong
 * number in the app. Every assertion mirrors one in
 * `ml/tests/test_food_model.py`.
 *
 * Run: node ml/models/skos-food-v1/foodEstimate.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  FoodSearch, normalize, toGrams, densityFor,
  expectedState, moistureMismatch,
  adjustOil, fattyAcidSplit, scaleNutrition,
  listPortions, portionToGrams, canonicalPortion, effectiveDensity,
  OIL_LEVELS, OIL_FATTY_ACID_PROFILE, KCAL_PER_G_OIL, MAX_PLAUSIBLE_KCAL
} = require('./foodEstimate.reference.js');

let passed = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS: ${label}`);
  } catch (e) {
    failures.push(`${label} -> ${e.message}`);
    console.log(`FAIL: ${label} -> ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertClose(a, b, tol, msg) {
  if (Math.abs(a - b) > tol) throw new Error(`${msg || ''} expected ~${b}, got ${a}`);
}

// ---------------------------------------------------------------- data --
const PROC = path.resolve(__dirname, '..', '..', 'data', 'processed');
const db = JSON.parse(fs.readFileSync(path.join(PROC, 'unified_food_db.json'), 'utf8'));
let aliases = {};
try {
  aliases = JSON.parse(fs.readFileSync(path.join(PROC, 'food_aliases.json'), 'utf8')).aliases || {};
} catch (e) { /* aliases optional */ }

const fsx = new FoodSearch(db, aliases);
const first = (q) => { const r = fsx.search(q, { limit: 1 }); return r.length ? r[0] : null; };

// ------------------------------------------------------------ database --
check('database loads with expected scale', () => {
  assert(db.length > 20000, `only ${db.length} foods`);
});

check('energy is physically possible everywhere (pure fat ~900)', () => {
  const bad = db.filter((f) => f.energy_kcal != null && (f.energy_kcal < 0 || f.energy_kcal > MAX_PLAUSIBLE_KCAL));
  assert(bad.length === 0, `impossible energy: ${bad.slice(0, 2).map((b) => b.food_name)}`);
});

check('source_id is unique (it is the identity callers persist)', () => {
  const ids = db.map((f) => f.source_id);
  assert(ids.length === new Set(ids).size, `${ids.length - new Set(ids).size} duplicates`);
});

check('macros are never negative', () => {
  const bad = db.filter((f) => ['protein_g', 'fat_g', 'carb_g'].some((k) => (f[k] ?? 0) < 0));
  assert(bad.length === 0, `negative macros on ${bad.length} rows`);
});

// -------------------------------------------------------------- search --
check('generic query returns the generic food, not a brand', () => {
  for (const [q, banned] of [['chicken', 'applebee'], ['rice', 'alcoholic'], ['apple', 'vinegar']]) {
    const r = first(q);
    assert(r, `${q} did not resolve`);
    assert(!r.food_name.toLowerCase().includes(banned), `${q} -> ${r.food_name}`);
  }
});

check('staples default to the state they are EATEN in (rice cooked, not raw)', () => {
  const r = first('rice');
  assert(r.cooking_state === 'cooked', `rice -> ${r.cooking_state}`);
  assert(r.energy_kcal < 200, `raw rice leaked through at ${r.energy_kcal} kcal`);
});

check('fresh fruit is not returned dried (papaya 24 not 302)', () => {
  for (const [q, ceiling] of [['papaya', 60], ['peach', 90], ['fig', 150]]) {
    const r = first(q);
    assert(r && r.energy_kcal < ceiling, `${q} -> ${r && r.food_name} ${r && r.energy_kcal}`);
  }
});

check('offal does not outrank normal cuts', () => {
  const r = first('chicken');
  for (const organ of ['feet', 'giblet', 'gizzard']) {
    assert(!r.food_name.toLowerCase().includes(organ), `chicken -> ${r.food_name}`);
  }
});

check('Indian dishes resolve', () => {
  const dishes = ['idli', 'dosa', 'poha', 'biryani', 'samosa', 'paratha', 'sambar',
    'khichdi', 'pulao', 'dhokla', 'paneer', 'rajma', 'chapati', 'halwa', 'kheer'];
  const missing = dishes.filter((d) => first(d) === null);
  assert(missing.length === 0, `unresolved: ${missing}`);
});

check('exact match is high confidence', () => {
  const r = first('paneer');
  assert(r.confidence === 'high', `paneer confidence ${r.confidence}`);
});

check('confidence is always one of the four contract values', () => {
  for (const q of ['rice', 'paneer', 'idli', 'chicken']) {
    const r = first(q);
    assert(['high', 'medium', 'low', 'unreliable'].includes(r.confidence), `${q} -> ${r.confidence}`);
  }
});

check('known-bad rows are marked untrustworthy, never silently clean', () => {
  const r = first('dum aloo');
  if (r) {
    assert(r.trustworthy === false, 'flagged row reported as trustworthy');
    assert(r.data_quality_flag, 'flagged row missing its reason');
  }
});

check('empty and nonsense queries return nothing', () => {
  assert(fsx.search('').length === 0, 'empty query returned results');
  assert(fsx.search('   ').length === 0, 'blank query returned results');
  assert(fsx.search('zzzqqxwv').length === 0, 'nonsense query invented a match');
});

check('progressive backoff resolves multi-word queries', () => {
  const r = first('apple big');
  assert(r !== null, '"apple big" should resolve via backoff');
});

// --------------------------------------------------------------- units --
check('mass units are exact', () => {
  assert(toGrams(250, 'g', 'rice').grams === 250);
  assert(toGrams(1, 'kg', 'rice').grams === 1000);
});

check('volume conversion is density-aware (tbsp is a VOLUME)', () => {
  const oil = toGrams(1, 'tbsp', 'sunflower oil').grams;
  const honey = toGrams(1, 'tbsp', 'honey').grams;
  const flour = toGrams(1, 'tbsp', 'wheat flour').grams;
  assertClose(oil, 13.8, 0.5, 'tbsp oil');
  assert(honey > oil, 'honey must be denser than oil');
  assert(flour < oil, 'flour must be lighter than oil');
});

check('density lookup is food-aware', () => {
  assert(densityFor('sunflower oil') < 1.0);
  assert(densityFor('honey') > 1.0);
});

check('count units use reference weights', () => {
  const r = toGrams(3, 'nos', 'egg');
  assertClose(r.grams, 150, 10, '3 eggs');
  assert(r.method === 'count');
});

check('unquantifiable returns null, never a guess', () => {
  const r = toGrams(1, 'to taste', 'salt');
  assert(r.grams === null, 'invented a quantity for "to taste"');
  assert(r.method === 'unquantifiable');
});

check('unknown unit and non-positive amounts are rejected', () => {
  assert(toGrams(1, 'smidgen', 'flour').grams === null);
  assert(toGrams(0, 'g', 'rice').grams === null);
  assert(toGrams(-5, 'g', 'rice').grams === null);
});

// ------------------------------------------------------- cooking state --
check('cooking-state priors match the Python side', () => {
  for (const f of ['rice', 'dal', 'chicken', 'potato']) assert(expectedState(f) === 'cooked', f);
  for (const f of ['banana', 'apple', 'curd', 'almond']) assert(expectedState(f) === 'raw', f);
  assert(expectedState('zzz unknown substance') === null, 'guessed a state with no evidence');
});

check('moisture mismatch flags dried fruit but not normally-dry staples', () => {
  assert(moistureMismatch('Papaya, dried') === true);
  assert(moistureMismatch('Papaya, raw') === false);
  assert(moistureMismatch('Lentil dal, dried') === false, 'pulses are sold dry');
});

// ----------------------------------------------------------------- oil --
check('oil levels are ordered and measured', () => {
  assert(OIL_LEVELS.none === 0);
  assert(OIL_LEVELS.low < OIL_LEVELS.moderate);
  assert(OIL_LEVELS.moderate < OIL_LEVELS.high);
  assert(OIL_LEVELS.high < OIL_LEVELS.very_high);
});

check('more oil increases energy monotonically', () => {
  const food = { energy_kcal: 163, fat_g: 6, protein_g: 8, carb_g: 18 };
  const vals = ['none', 'low', 'moderate', 'high', 'very_high']
    .map((lv) => adjustOil(food, { level: lv, baselineOilG: 5.75 }).energy_kcal_adjusted);
  for (let i = 1; i < vals.length; i += 1) assert(vals[i] >= vals[i - 1], `not monotonic: ${vals}`);
});

check('less oil than the recipe assumes REDUCES energy (delta, not addition)', () => {
  const food = { energy_kcal: 163, fat_g: 6, protein_g: 8, carb_g: 18 };
  const r = adjustOil(food, { level: 'low', baselineOilG: 5.75 });
  assert(r.energy_kcal_adjusted < r.energy_kcal_original, 'low oil did not reduce energy');
  assert(r.delta_oil_g_per_100g < 0, 'delta should be negative');
});

check('mass is conserved (10 g oil adds 10 g mass, not just 88 kcal)', () => {
  const food = { energy_kcal: 163, fat_g: 6, protein_g: 8, carb_g: 18 };
  const r = adjustOil(food, { level: 'very_high', baselineOilG: 5.75 });
  const delta = r.delta_oil_g_per_100g;
  const expected = ((163 + delta * KCAL_PER_G_OIL) / (100 + delta)) * 100;
  assertClose(r.energy_kcal_adjusted, expected, 0.2, 'mass not conserved');
});

check('invalid oil inputs are rejected', () => {
  const food = { energy_kcal: 163 };
  assert(adjustOil(food, { level: 'extreme', baselineOilG: 5 }).error, 'accepted unknown level');
  assert(adjustOil(food, { level: 'custom', baselineOilG: 5 }).error, 'custom without value');
  assert(adjustOil(food, { level: 'custom', baselineOilG: 5, customOilGPer100g: -3 }).error, 'accepted negative oil');
});

check('every fatty-acid profile sums to 100% (IFCT Table 12)', () => {
  for (const [oil, p] of Object.entries(OIL_FATTY_ACID_PROFILE)) {
    assertClose(p.sfa + p.mufa + p.pufa, 100, 0.2, `${oil} composition`);
  }
});

check('oil types differ in saturation (coconut vs mustard ~16x)', () => {
  const coco = fattyAcidSplit('coconut oil', 10);
  const mustard = fattyAcidSplit('mustard oil', 10);
  assert(coco.saturated_g > 5 * mustard.saturated_g, 'saturation difference lost');
});

check('unknown oil returns no profile rather than a default', () => {
  assert(fattyAcidSplit('avocado oil', 10) === null, 'invented a profile');
});

// ---------------------------------------------------------- nutrition --
check('portion scaling is linear and preserves nulls', () => {
  const food = { energy_kcal: 100, protein_g: 10, fat_g: null, carb_g: 5 };
  const r = scaleNutrition(food, 250);
  assertClose(r.totals.energy_kcal, 250, 0.01, 'energy scale');
  assertClose(r.totals.protein_g, 25, 0.01, 'protein scale');
  assert(r.totals.fat_g === null, 'null nutrient became a number — unknown is not zero');
});

check('zero or negative portion returns null', () => {
  assert(scaleNutrition({ energy_kcal: 100 }, 0) === null);
  assert(scaleNutrition({ energy_kcal: 100 }, -5) === null);
});

// ----------------------------------------------------------- portions --
check('same portion differs by food density (bowl of dal vs spinach)', () => {
  const dal = portionToGrams('medium_bowl', 1, { foodName: 'Dal makhani', cookingState: 'cooked' }).grams;
  const spinach = portionToGrams('medium_bowl', 1, { foodName: 'Spinach' }).grams;
  assert(dal > 2 * spinach, `dal ${dal}g vs spinach ${spinach}g — density ignored`);
});

check('portions scale linearly with count', () => {
  const one = portionToGrams('medium_bowl', 1, { foodName: 'Dal' }).grams;
  const three = portionToGrams('medium_bowl', 3, { foodName: 'Dal' }).grams;
  assertClose(three, 3 * one, 0.5, 'portion scaling');
});

check('portion sizes are ordered (small < medium < large)', () => {
  const f = { foodName: 'Dal makhani', cookingState: 'cooked' };
  const bowls = ['small_bowl', 'medium_bowl', 'large_bowl'].map((k) => portionToGrams(k, 1, f).grams);
  for (let i = 1; i < bowls.length; i += 1) assert(bowls[i] >= bowls[i - 1], `bowls ${bowls}`);
  const plates = ['quarter_plate', 'half_plate', 'plate', 'full_plate'].map((k) => portionToGrams(k, 1, f).grams);
  for (let i = 1; i < plates.length; i += 1) assert(plates[i] >= plates[i - 1], `plates ${plates}`);
});

check('portion aliases resolve to canonical keys', () => {
  const pairs = [['tbsp', 'tablespoon'], ['big bowl', 'large_bowl'],
    ['regular plate', 'plate'], ['half plate', 'half_plate'], ['serving spoon', 'serving_spoon']];
  for (const [alias, expected] of pairs) {
    assert(canonicalPortion(alias) === expected, `${alias} -> ${canonicalPortion(alias)}`);
  }
});

check('unknown portion and bad counts are rejected, not guessed', () => {
  assert(portionToGrams('bucket', 1, {}).grams === null);
  assert(portionToGrams('bowl', 0, {}).grams === null);
  assert(portionToGrams('bowl', -2, {}).grams === null);
});

check("food's own measured serving beats the generic figure", () => {
  const r = portionToGrams('bowl', 2, { foodName: 'Some dish', foodServingGrams: 180 });
  assert(r.basis === 'measured_serving', `basis ${r.basis}`);
  assertClose(r.grams, 360, 0.5, 'measured serving');
});

check('count portions use ITEM weight, not INDB dish weight', () => {
  const r = portionToGrams('egg', 2, { foodName: 'Egg' });
  assert(r.basis === 'count');
  assertClose(r.grams, 100, 0.5, '2 eggs');
});

check('cooked wet dish is denser than its dry ingredient', () => {
  assert(effectiveDensity('Dal makhani', 'cooked') > effectiveDensity('Dal', null));
});

check('listPortions offers the expected household set with ranges', () => {
  const ps = listPortions('Dal makhani', 'cooked');
  const keys = new Set(ps.map((p) => p.key));
  for (const k of ['teaspoon', 'tablespoon', 'serving_spoon', 'small_bowl',
    'medium_bowl', 'large_bowl', 'half_plate', 'plate', 'glass']) {
    assert(keys.has(k), `missing portion ${k}`);
  }
  const bowl = ps.find((p) => p.key === 'bowl');
  assert(Array.isArray(bowl.observed_range_g), 'bowl must carry its observed spread');
});

// ------------------------------------------------------- normalisation --
check('normalize strips scientific names and punctuation', () => {
  assert(!normalize('Lentil (Lens culinaris)').includes('lens'));
  assert(normalize('Rice, White!') === normalize('rice white'));
});

// -------------------------------------------------------------- report --
console.log('');
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`${passed} check(s) passed.`);
