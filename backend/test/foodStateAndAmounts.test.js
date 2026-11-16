// ============================================================
// RAW / DRY vs COOKED, AND AMOUNTS WRITTEN AFTER THE FOOD (Phase 2).
//
// Measured before these fixes (engine output, not estimates):
//   "100g raw rice"          -> Murmura (puffed rice)          113 kcal  (raw rice ~365)
//   "50g uncooked moong dal" -> a COOKED moong dal              27 kcal  (dry ~163)
//   "50g dry chana"          -> Cabbage rolls (dry)
//   "100g raw potato"        -> Potato pancake
//   "100g atta"              -> Atta dal burfi
//   "50g raw oats"           -> Birthday Cake Protein Oats
//   "100g cooked soya chunks"-> DRY soya chunks                331 kcal  (soaked ~110)
//   "1 bowl oats"            -> 250 g of DRY oats              973 kcal
//   "chicken breast 200g"    -> an assumed 100 g; "paneer 100 g", "dal 1 bowl",
//                               "roti 2" -> unresolved
//   "poha with peanuts"      -> a 30 g handful of peanuts on top of the poha
// ============================================================
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import { estimateFood, modelAvailable, moveTrailingQuantity } from '../src/services/foodEstimator.js';
import { stapleState, rawVariantFor, cookedVariantFor, stapleByKey } from '../src/services/food/staples.js';

const live = modelAvailable();
const one = (text) => {
  const r = estimateFood(text);
  assert.equal(r.unresolved.length, 0, `${text}: ${JSON.stringify(r.unresolved)}`);
  assert.equal(r.items.length, 1, `${text}: ${r.items.map((i) => i.name).join(' + ')}`);
  return r.items[0];
};
const per100 = (it) => (it.calories / it.grams) * 100;

test('a state word picks the row in that state, never the other one', { skip: !live }, () => {
  const cases = [
    ['100g raw rice', 'rice_raw', 340, 380],
    ['100g uncooked rice', 'rice_raw', 340, 380],
    ['1 cup raw rice', 'rice_raw', 340, 380],
    ['50g toor dal raw', 'toor_dal_raw', 300, 350],
    ['50g uncooked moong dal', 'moong_dal_raw', 300, 350],
    ['50g raw masoor dal', 'masoor_dal_raw', 300, 350],
    ['50g dry chana', 'chana_dry', 270, 380],
    ['dry rajma 50 g', 'rajma_dry', 280, 340],
    ['100g raw potato', 'potato_raw', 55, 85],
    ['50g raw oats', 'oats', 360, 400],
    ['200g cooked oats', 'oats_cooked', 55, 90],
    ['100g cooked soya chunks', 'soya_chunks_cooked', 90, 130],
    ['50g dry sabudana', 'sabudana_dry', 330, 370],
    ['100g cooked dal', 'dal', 60, 130],
    ['raw mango', 'raw_mango', 35, 70],
  ];
  for (const [text, key, lo, hi] of cases) {
    const it = one(text);
    assert.equal(it.staple_key, key, `${text}: got ${it.staple_key} (${it.name})`);
    const k = per100(it);
    assert.ok(k >= lo && k <= hi, `${text}: ${k.toFixed(0)} kcal/100 g outside ${lo}-${hi}`);
    assert.ok(!it.unmatched_terms?.length, `${text}: state word should be accounted for`);
  }
});

test('a state word that changes nothing is accepted; one that would change the food is not forced', { skip: !live }, () => {
  assert.equal(one('100g raw paneer').staple_key, 'paneer');          // dairy: same food
  assert.equal(one('boiled rice').staple_key, 'white_rice');
  // A trailing "dry" is a dish without gravy on Indian menus -- it is not
  // turned into the raw ingredient by the state rule.
  assert.equal(stapleState(stapleByKey('banana')), 'ripe');            // "raw banana" is plantain, not this
});

test('flours and dry ingredients are the ingredient, not a sweet or a dish made from them', { skip: !live }, () => {
  for (const [text, key] of [['100g atta', 'atta'], ['2 tbsp atta', 'atta'], ['50g suji', 'suji'], ['50g rava', 'suji']]) {
    const it = one(text);
    assert.equal(it.staple_key, key, `${text}: ${it.name}`);
    assert.ok(per100(it) > 300, `${text}: a dry flour is >300 kcal/100 g, got ${per100(it).toFixed(0)}`);
  }
});

test('a katori / bowl of a dry staple is the cooked food; weights and dry words stay dry', { skip: !live }, () => {
  const bowl = one('1 bowl oats');
  assert.equal(bowl.staple_key, 'oats_cooked');
  assert.ok(bowl.calories < 300, `a bowl of cooked oats, got ${bowl.calories}`);
  const soya = one('1 katori soya chunks');
  assert.equal(soya.staple_key, 'soya_chunks_cooked');
  assert.ok(soya.calories < 250, `${soya.calories}`);
  assert.equal(one('40g oats').staple_key, 'oats');
  assert.equal(one('1 cup oats').staple_key, 'oats');
  assert.equal(one('1 bowl dry oats').staple_key, 'oats');
});

test('a weight of rice or dal without "cooked" or "dry" offers the dry row and is not called certain', { skip: !live }, () => {
  const rice = one('100g rice');
  assert.equal(rice.staple_key, 'white_rice', 'cooked stays the default');
  assert.equal(rice.alternatives[0]?.staple_key, 'rice_raw', 'dry rice offered first');
  assert.equal(rice.confidence_breakdown.identification, 'medium');
  assert.ok(rice.confidence_breakdown.reasons.identification.some((r) => /dry weight/.test(r)));
  const dal = one('50g masoor dal');
  assert.equal(dal.alternatives[0]?.staple_key, 'masoor_dal_raw');
  // Said cooked: certain, no state question.
  const cooked = one('100g cooked rice');
  assert.equal(cooked.confidence_breakdown.identification, 'high');
  assert.notEqual(cooked.alternatives[0]?.staple_key, 'rice_raw');
  // Raw vs cooked chicken differs by ~40%, not 2x: offered, but not doubted.
  assert.equal(one('100g chicken breast').confidence_breakdown.identification, 'high');
  // A household unit is not a weight: no dry-weight doubt on "1 katori rice".
  assert.notEqual(one('1 katori rice').confidence_breakdown.identification, 'medium');
});

test('an amount written after the food is the amount', { skip: !live }, () => {
  const cases = [
    ['chicken breast 200g', 200],
    ['paneer 100 g', 100],
    ['rice 150 grams', 150],
    ['milk 200ml', null],
    ['roti 2', 80],
    ['banana x2', null],
  ];
  for (const [text, grams] of cases) {
    const it = one(text);
    assert.equal(it.grams_assumed, false, `${text}: amount was given`);
    if (grams) assert.equal(it.grams, grams, text);
  }
  assert.equal(one('dal 1 bowl').unit, '1 x bowl');
  assert.equal(one('eggs 3').qty, 3);
});

test('numbers that are part of a name are not moved', () => {
  assert.equal(moveTrailingQuantity('chicken 65'), 'chicken 65');
  assert.equal(moveTrailingQuantity('omega 3'), 'omega 3');
  assert.equal(moveTrailingQuantity('vitamin b 12'), 'vitamin b 12');
  assert.equal(moveTrailingQuantity('2 roti'), '2 roti');
  assert.equal(moveTrailingQuantity('roti 2'), '2 roti');
  assert.equal(moveTrailingQuantity('dal 1 bowl'), '1 bowl dal');
  assert.equal(moveTrailingQuantity('banana x2'), '2 banana');
});

test('nuts added "with" a dish and no amount are a topping, not a handful', { skip: !live }, () => {
  const r = estimateFood('I had a plate of poha with peanuts and one cup of tea');
  assert.equal(r.unresolved.length, 0);
  const pea = r.items.find((i) => i.staple_key === 'peanuts');
  assert.ok(pea, r.items.map((i) => i.name).join(', '));
  assert.equal(pea.grams, 10);
  assert.equal(pea.grams_assumed, true, 'the topping amount is an assumption and says so');
  // Said, it counts as said.
  assert.equal(estimateFood('poha with 20g peanuts').items.find((i) => i.staple_key === 'peanuts').grams, 20);
  assert.equal(estimateFood('poha with a handful of peanuts').items.find((i) => i.staple_key === 'peanuts').grams, 30);
  assert.equal(one('a handful of peanuts').grams, 30);
});

test('raita, sabudana khichdi and soya chunk curry are themselves', { skip: !live }, () => {
  assert.equal(one('1 katori raita').staple_key, 'raita');
  const sk = one('1 plate sabudana khichdi');
  assert.equal(sk.staple_key, 'sabudana_khichdi');
  assert.equal(sk.confidence_breakdown.identification, 'high');
  const soya = one('1 katori soya chunks curry');
  assert.equal(soya.staple_key, 'soya_curry');
  assert.ok(soya.calories < 300, `${soya.calories}`);
});

test("the brief's example sentences: every food, every amount, nothing dropped", { skip: !live }, () => {
  const expect = [
    ['I ate two rotis with one bowl of dal and some curd', ['roti', 'dal', 'curd']],
    ['I had a plate of poha with peanuts and one cup of tea', ['poha', 'peanuts', 'chai']],
    ['I ate two slices of toast with 10 grams of butter and 15 grams of jam', ['toast', 'butter', 'jam']],
    ['Had chicken biryani, half a plate, with raita', ['chicken_biryani', 'raita']],
  ];
  for (const [text, keys] of expect) {
    const r = estimateFood(text);
    assert.deepEqual(r.unresolved, [], text);
    assert.deepEqual(r.items.map((i) => i.staple_key), keys, text);
  }
  const toast = estimateFood('I ate two slices of toast with 10 grams of butter and 15 grams of jam').items;
  assert.equal(toast[0].qty, 2);
  assert.equal(toast[1].grams, 10);
  assert.equal(toast[2].grams, 15);
  const biryani = estimateFood('Had chicken biryani, half a plate, with raita').items[0];
  assert.equal(biryani.qty, 0.5);
});

test('every raw/dry staple is a measured row and is linked from the names people use', () => {
  for (const key of ['rice_raw', 'toor_dal_raw', 'moong_dal_raw', 'urad_dal_raw', 'chana_dal_raw', 'masoor_dal_raw', 'chana_dry', 'rajma_dry', 'potato_raw', 'atta', 'suji', 'dalia_dry', 'sabudana_dry']) {
    const st = stapleByKey(key);
    assert.ok(st, key);
    assert.ok(st.ref && !st.inline, `${key}: must point at a measured row`);
    assert.ok(['raw', 'dry'].includes(stapleState(st)), key);
  }
  assert.equal(rawVariantFor('rice')?.key, 'rice_raw');
  assert.equal(rawVariantFor('moong dal')?.key, 'moong_dal_raw');
  assert.equal(rawVariantFor('paneer'), null);
  assert.equal(cookedVariantFor('oats')?.key, 'oats_cooked');
  assert.equal(cookedVariantFor('soya chunks')?.key, 'soya_chunks_cooked');
});

test('a nutrient a source never measured is named, not presented as a measured zero', { skip: !live }, () => {
  const r = estimateFood('100g paneer and 2 roti');
  const paneer = r.items.find((i) => i.staple_key === 'paneer');
  assert.equal(paneer.carbs, null, 'IFCT paneer has no carbohydrate value: null, not 0');
  assert.deepEqual(r.total_incomplete, { carbs: ['Paneer'] });
  assert.equal(estimateFood('2 roti').total_incomplete, undefined);
});
