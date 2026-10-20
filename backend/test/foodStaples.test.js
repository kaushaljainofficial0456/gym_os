// ============================================================
// EVERYDAY STAPLES — the common case must be fast AND right.
//
// Pins the specific failures the staples layer fixes, measured from the
// real index before the change:
//
//   "chai"            -> "SILK Chai, soymilk"
//   "tea"             -> an OFF row claiming 20 g protein / 100 ml
//   "boiled egg"      -> a 45 kcal / 100 g row, labelled high confidence
//   "chicken breast"  -> "...stewed, skin eaten"
//   "bread"           -> "Bread, potato"
//   quick-add         -> 100 g of everything; "1 egg" was unit 23 of 23
//   "a cup of chai"   -> 247 g (a 240 ml US cup, not a 150 ml tea cup)
//   "1 scoop whey"    -> no unit understood
//
// and the design rule that makes the layer safe: a staple POINTS at a
// measured row and returns it byte for byte. It does not re-measure.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_STAPLES, matchStaples, stapleFor } from '../src/services/food/staples.js';
import { searchFoods, estimateFood, resolveFoodQuantity } from '../src/services/foodEstimator.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', '..', 'ml', 'data', 'processed', 'unified_food_db.json'), 'utf8'));
const ROWS = new Map(DB.map((f) => [f.source_id, f]));

/* ── the curation itself ─────────────────────────────────────────── */

test('every staple points at a real, trustworthy measured row -- or says why not', () => {
  for (const s of ALL_STAPLES) {
    if (s.ref) {
      const row = ROWS.get(s.ref);
      assert.ok(row, `${s.key}: ref ${s.ref} is not in the index`);
      assert.ok(row.data_quality_flag == null, `${s.key}: ref ${s.ref} is quarantined (${row.data_quality_flag})`);
    } else {
      // No measured row: an inline value is allowed only with its basis
      // and the reason stated, so it can be checked and argued with.
      assert.ok(Array.isArray(s.inline), `${s.key} has neither a ref nor an inline value`);
      assert.ok(['usda', 'recipe', 'label'].includes(s.basis), `${s.key}: inline value with no basis`);
      assert.ok(s.note && s.note.length > 10, `${s.key}: inline value with no stated reason`);
    }
  }
});

test('inline values are Atwater-consistent (catches typos)', () => {
  for (const s of ALL_STAPLES.filter((x) => x.inline)) {
    const [kcal, p, c, f, fiber = 0] = s.inline;
    if (kcal < 10) continue;
    // Fiber yields ~2 kcal/g, not 4.
    const atwater = p * 4 + (c - (fiber || 0)) * 4 + (fiber || 0) * 2 + f * 9;
    const diff = Math.abs(atwater - kcal);
    assert.ok(kcal < 60 ? diff <= 6 : diff / kcal <= 0.12, `${s.key}: ${kcal} kcal vs ${Math.round(atwater)} from its macros`);
  }
});

test('keys are unique, every staple has a unit, and no alias means two foods', () => {
  const keys = new Set();
  const owner = new Map();
  for (const s of ALL_STAPLES) {
    assert.ok(!keys.has(s.key), `duplicate staple key ${s.key}`);
    keys.add(s.key);
    assert.ok(s.units.length > 0, `${s.key} has no units`);
    for (const a of s.aliases) {
      assert.ok(!owner.has(a) || owner.get(a) === s.key, `alias "${a}" belongs to both ${owner.get(a)} and ${s.key}`);
      owner.set(a, s.key);
    }
  }
});

/* ── matching ─────────────────────────────────────────────────────── */

test('the words people type mean the food they mean', () => {
  const cases = {
    chai: 'chai', tea: 'chai', 'masala chai': 'chai', 'green tea': 'green_tea',
    'black coffee': 'black_coffee', egg: 'egg_boiled', 'boiled egg': 'egg_boiled',
    omelette: 'omelette', 'chicken breast': 'chicken_breast', bread: 'white_bread',
    'brown bread': 'brown_bread', rice: 'white_rice', dahi: 'curd', roti: 'roti',
    chapati: 'roti', idly: 'idli', dal: 'dal', 'scoop whey': 'whey',
  };
  for (const [q, key] of Object.entries(cases)) assert.equal(stapleFor(q)?.key, key, `"${q}" should mean ${key}`);
});

test('a phrase the staples do not know is left to the full index', () => {
  assert.equal(stapleFor('egg biryani'), null);
  assert.equal(stapleFor('rice flour'), null);
  assert.equal(stapleFor('apple juice'), null);
});

test('type-ahead prefixes suggest, but a complete-name lookup never guesses', () => {
  // "chap" is only the start of "chapati". ("cha" would be a bad example:
  // it IS a word for tea, in Bengali.)
  assert.ok(matchStaples('chap').some((h) => h.staple.key === 'roti'));
  assert.equal(stapleFor('chap'), null);
});

/* ── the measured row, byte for byte ──────────────────────────────── */

test('a staple returns its measured row unchanged', () => {
  const [roti] = searchFoods('roti');
  assert.equal(roti.source_id, 'indb:ASC096');
  const src = ROWS.get('indb:ASC096');
  for (const k of ['energy_kcal', 'protein_g', 'carb_g', 'fat_g']) assert.equal(roti[k], src[k], k);
  assert.equal(roti.staple_key, 'roti');
  assert.equal(roti.staple_name, 'Roti / Chapati');
});

test('the specific bad answers are gone', () => {
  assert.equal(searchFoods('chai')[0].food_name, 'Chai (milk tea, with sugar)');
  assert.equal(searchFoods('tea')[0].staple_key, 'chai', 'not the 20 g-protein "Tea" row');
  assert.equal(Math.round(searchFoods('boiled egg')[0].energy_kcal), 155, 'not the 45 kcal row');
  assert.match(searchFoods('chicken breast')[0].food_name, /breast, meat, roasted/i, 'skinless, not skin eaten');
  assert.equal(searchFoods('bread')[0].staple_key, 'white_bread');
});

/* ── units: the natural one, by default ───────────────────────────── */

const defaultPortion = (q) => searchFoods(q)[0].portions.find((p) => p.default);

test('search defaults each staple to its natural unit, not 100 g', () => {
  assert.deepEqual([defaultPortion('roti').label, defaultPortion('roti').grams], ['roti', 40]);
  assert.deepEqual([defaultPortion('egg').label, defaultPortion('egg').grams], ['egg', 50]);
  assert.deepEqual([defaultPortion('chai').label, defaultPortion('chai').grams], ['cup', 150]);
  assert.deepEqual([defaultPortion('whey').label, defaultPortion('whey').grams], ['scoop', 32]);
  assert.equal(defaultPortion('rice').label, 'katori');
});

test('catalogue weights stay the single source of truth', () => {
  // Staples reuse the catalogue for countable foods and containers, so the
  // product has one idli and one katori, not two.
  assert.equal(estimateFood('3 idli').items[0].grams, 135);   // 45 g each
  assert.equal(estimateFood('2 roti').items[0].grams, 80);
  assert.equal(estimateFood('1 banana').items[0].grams, 120);
});

test('the meal parser uses staple units end to end', () => {
  const r = estimateFood('2 roti, 1 katori dal and a cup of chai');
  assert.deepEqual(r.items.map((i) => i.grams), [80, 150, 150], 'a chai cup is 150 ml');
  assert.equal(r.unresolved.length, 0);
  assert.equal(estimateFood('10 almonds').items[0].grams, 12, 'ten almonds, not ten handfuls');
  assert.equal(estimateFood('almonds').items[0].grams, 28, 'no number: one handful');
  assert.equal(estimateFood('2 scoops whey').items[0].grams, 64);
  assert.equal(estimateFood('1 masala dosa').items[0].grams, 210, "INDB's own serving");
});

test('measured amounts still measure, staple or not', () => {
  assert.equal(estimateFood('200g chicken breast').items[0].grams, 200);
  assert.equal(estimateFood('250 ml milk').items[0].grams_basis, 'measured');
});

test('the resolve route prices a staple by its own unit, whichever way it was found', () => {
  const [chai] = searchFoods('chai');
  assert.equal(resolveFoodQuantity(chai, {}).grams, 150, 'default: one cup');
  assert.equal(resolveFoodQuantity(chai, { portionKey: 'staple_mug', count: 1 }).grams, 250);
  assert.equal(resolveFoodQuantity(chai, { grams: 100 }).grams, 100, 'an explicit weight always wins');

  // Reached by its own index name, the same row keeps its staple units --
  // the resolve route searches by name, so "1 roti" must still resolve.
  const byName = searchFoods('Chapati/Roti', { limit: 1 })[0];
  assert.equal(byName.staple_key, 'roti');
  assert.equal(resolveFoodQuantity(byName, { portionKey: 'staple_roti', count: 3 }).grams, 120);
});

test('non-staple foods get their own count unit first, not a teaspoon', () => {
  const rows = searchFoods('banana raw', { limit: 8 }).filter((f) => !f.staple_key);
  const banana = rows.find((f) => /banana/i.test(f.food_name));
  assert.ok(banana, 'expected an index banana row');
  assert.equal(banana.portions[0].label, 'Banana');
  assert.equal(banana.portions[0].default, true);
});
