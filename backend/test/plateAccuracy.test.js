// ============================================================
// THE PLATE, MADE MORE ACCURATE — oil, and units that fit the food.
//
//   * "Less oil" / "more oil" on a cooked dish come from the same oil
//     model the classic picker uses (adjustOil, the dish's own fat as its
//     recipe oil), so the two can never disagree about the same katori.
//     "Less" must always lower calories and "more" raise them -- relative
//     words over absolute levels could not promise that by themselves.
//   * Foods whose fat is their own (an egg, nuts, milk) get no oil choice:
//     subtracting their fat as "oil" would invent a leaner food.
//   * The food-kind patterns that order portions were once written with
//     literal backspace bytes where \b belonged, so nothing matched and a
//     lassi was offered "by the piece". These pin the repaired order.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describeMeal, searchFoods, resolveFoodQuantity, getFoodSearch, plateOil } from '../src/services/foodEstimator.js';

const item = (text) => {
  const r = describeMeal(text);
  assert.equal(r.items.length, 1, `${text}: ${JSON.stringify(r.unresolved)}`);
  return r.items[0];
};

test('a cooked dish offers less and more oil, each moving calories the right way', () => {
  for (const text of ['1 katori dal', 'rajma', 'paneer butter masala', '2 aloo paratha', 'chicken biryani']) {
    const it = item(text);
    assert.ok(it.oil, `${text}: oil should be a choice`);
    const less = it.oil.options.find((o) => o.key === 'less');
    const more = it.oil.options.find((o) => o.key === 'more');
    assert.ok(less && more, `${text}: both directions offered`);
    assert.ok(less.per100.calories < it.per100.calories, `${text}: less oil lowers calories`);
    assert.ok(more.per100.calories > it.per100.calories, `${text}: more oil raises calories`);
    assert.ok(less.per100.fat < it.per100.fat && more.per100.fat > it.per100.fat, `${text}: and fat with it`);
    // Never more than 70% of the dish's fat taken away as "oil".
    assert.ok(less.oil_g_per_100g >= it.per100.fat * 0.3, `${text}: less oil keeps the food's own fat`);
  }
});

test('the plate and the classic picker price the same oil level identically', () => {
  const search = getFoodSearch();
  const it = item('1 katori dal');
  const row = search.stapleRowByKey(it.staple_key);
  const less = it.oil.options.find((o) => o.key === 'less');
  const classic = resolveFoodQuantity({ ...row, category: 'indian_dish' }, { grams: 150, oilLevel: less.level });
  assert.ok(classic.oil?.applied, JSON.stringify(classic.oil));
  assert.equal(Math.round((less.per100.calories * 150) / 100), Math.round(classic.totals.energy_kcal));
});

test('foods whose fat is their own get no oil choice', () => {
  for (const text of ['2 boiled eggs', '10 almonds', 'a glass of lassi', 'a cup of chai', '200ml milk', '1 katori rice', '2 roti']) {
    assert.equal(item(text).oil, null, text);
  }
  assert.equal(plateOil({ food_name: 'Ghee', cooking_state: 'cooked', fat_g: 99, energy_kcal: 900 }), null);
});

test('portions are ordered for what the food is', () => {
  const first = (q) => searchFoods(q, { limit: 1 })[0]?.portions?.[0]?.key;
  assert.match(first('mango lassi'), /cup|glass|mug/, 'a drink is logged by the cup or glass');
  assert.match(first('peanut butter'), /spoon|tbsp|tsp/, 'a spread by the spoon');
  assert.match(first('paneer butter masala'), /katori|bowl/, 'a curry with butter in its name is still a curry');
  assert.match(first('rice flour'), /spoon|cup/, 'a flour is not a grain dish');
});

test('no control characters hide in the food engine sources', () => {
  // The bug class itself: a raw backspace inside a regex literal is
  // invisible in review and silently matches nothing. It was in both files
  // (the reference model's deli-meat rule had never matched in JS, while
  // its Python twin did).
  for (const rel of ['../src/services/foodEstimator.js', '../src/services/food/staples.js',
    '../../ml/models/skos-food-v1/foodEstimate.reference.js']) {
    const src = fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    assert.equal(/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(src), false, rel);
  }
});

/* ── everyday plates said as one phrase ─────────────────────────────── */

const names = (text) => describeMeal(text).items.map((it) => it.name);

test('a curry and its rice, said as one phrase, are both logged', () => {
  // Before: raw dried rajma (299 kcal/100 g); 33 g of porridge; the rice
  // silently dropped; curd rice instead of kadhi.
  assert.deepEqual(names('rajma chawal'), ['Rajma', 'Rice (cooked)']);
  assert.deepEqual(names('dal chawal'), ['Dal', 'Rice (cooked)']);
  assert.deepEqual(names('chole chawal'), ['Chole', 'Rice (cooked)']);
  assert.deepEqual(names('kadhi chawal'), ['Kadhi', 'Rice (cooked)']);
  assert.deepEqual(names('sambar rice'), ['Sambar', 'Rice (cooked)']);
  assert.deepEqual(names('peanut butter toast'), ['Peanut butter', 'Toast (white bread)']);
});

test('a dish that IS rice is never split', () => {
  assert.deepEqual(names('curd rice'), ['Curd rice']);
  assert.deepEqual(names('jeera rice'), ['Jeera rice']);
  assert.equal(names('lemon rice').length, 1);
});

test('a number counts servings of the plate, or the rotis', () => {
  const two = describeMeal('2 rajma chawal').items;
  assert.deepEqual(two.map((it) => it.qty), [2, 2]);
  const dalRoti = describeMeal('2 dal roti').items;
  assert.deepEqual(dalRoti.map((it) => [it.name, it.qty]), [['Dal', 1], ['Roti / Chapati', 2]]);
});

test('a dish that starts with a countable food stays one dish', () => {
  // Before: a boiled egg plus curry LEAVES; a medu vada plus 580 g of pav bhaji.
  assert.deepEqual(names('egg curry'), ['Egg curry']);
  assert.deepEqual(names('vada pav'), ['Vada pav']);
  assert.deepEqual(describeMeal('2 vada pav').items.map((it) => it.qty), [2]);
  assert.deepEqual(names('egg curry rice'), ['Egg curry', 'Rice (cooked)']);
  // ...while a counted food beside a different one is still two foods.
  assert.deepEqual(names('2 roti dal'), ['Roti / Chapati', 'Dal']);
});

test('bread said in slices is bread', () => {
  const [bread] = describeMeal('2 bread slices').items;
  assert.equal(bread.name, 'Bread (white)');
  assert.equal(bread.grams, 50);
});

test('street snacks are sized by the piece, not by 100 g each', () => {
  // Before: "4 pani puri" was 4 x 100 g; a spring roll was 100 g.
  const [pp] = describeMeal('4 pani puri').items;
  assert.equal(pp.name, 'Pani puri');
  assert.equal(pp.grams, 100);
  assert.ok(pp.calories >= 120 && pp.calories <= 200, `${pp.calories} kcal for four`);
  assert.equal(describeMeal('6 golgappe').items[0].name, 'Pani puri');
  const [roll] = describeMeal('1 spring roll').items;
  assert.equal(roll.grams, 50);
});
