// ============================================================
// NUTRITION ACCURACY — REGRESSION SET
//
// One test per bug actually found and fixed during the nutrition accuracy
// pass. Every case here FAILED before its fix; the measured "before" value is
// recorded in the test so a regression is recognisable on sight rather than
// just red.
//
// EXPECTATIONS COME FROM THE APPLICATION'S OWN FOOD RECORDS, never from
// hand-typed macros: each arithmetic test looks up the row the engine
// actually matched and asserts the scaling identity against THAT row. A
// database refresh that changes a food's measured values therefore cannot
// make these tests lie -- they check that the app computes correctly from
// whatever it holds, which is the property that has to hold forever. Values
// that ARE hardcoded are structural (grams, item counts, ordering), not
// nutritional.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  estimateFood, getFoodSearch, resolveFoodQuantity, searchFoods,
} = await import('../src/services/foodEstimator.js');
const { parseQuantity, perPieceDefaults } = await import('../src/services/intelligence/units.js');
const { computeNutrition } = await import('../src/services/intelligence/nutrition.js');

const search = getFoodSearch();
const haveModel = !!search;
const skip = haveModel ? false : 'skos-food-v1 artifacts not present on this machine';

/** The row the engine matched, straight out of the loaded database. */
const rowOf = (sourceId) => search.bySourceId.get(sourceId);

/**
 * value = per100g x grams / 100.
 *
 * To TWO decimals, which is scaleNutrition's own documented rounding for a
 * per-item macro (the meal TOTAL is separately rounded to one, and calories
 * to a whole number). Asserted at the engine's real precision rather than a
 * tidier one invented here: a test that demanded 1 dp would be asserting a
 * behaviour the app does not have and never claimed to.
 */
const expectScaled = (per100g, grams) => Math.round((per100g * grams / 100) * 100) / 100;

/* ------------------------------------------------------------------ *
 *  BUG 1 — leading narration destroyed parsing and matched biscuits   *
 * ------------------------------------------------------------------ */

// parseQuantity only ever inspected tokens[0], so "i"/"ate"/"had" blocked
// quantity extraction, the number stayed in the food NAME, and the search
// token-matched products with numbers in their names. Measured before:
//   "I ate 200g curd"  -> Parle Hide &seek 200g(30)   474 kcal
//   "had 2 rotis"      -> 2-Minute noodles            384 kcal
//   "ate 100g rice"    -> Britannia bourbon 100g      494 kcal
//   "i had 250g paneer"-> Britannia toastea 250gm     432 kcal
const NARRATED = [
  ['I ate 200g curd', '200g curd', 200],
  ['had 2 rotis', '2 rotis', null],
  ['ate 100g rice', '100g rice', 100],
  ['i had 250g paneer', '250g paneer', 250],
  ['today I had 150g chicken', '150g chicken', 150],
];

for (const [narrated, plain, grams] of NARRATED) {
  test(`narration prefix: "${narrated}" resolves identically to "${plain}"`, { skip }, () => {
    const a = estimateFood(narrated).items[0];
    const b = estimateFood(plain).items[0];
    assert.ok(a, `"${narrated}" must resolve to an item`);
    assert.ok(b, `"${plain}" must resolve to an item`);
    assert.equal(a.source_id, b.source_id,
      `narration changed the matched food: "${a.name}" vs "${b.name}"`);
    assert.equal(a.calories, b.calories, 'narration changed the calories');
    if (grams !== null) {
      assert.equal(a.grams, grams, 'the explicit mass must survive the narration prefix');
      assert.equal(a.grams_assumed, false, 'an explicit mass must never fall back to the 100 g assumption');
    }
  });
}

test('narration prefix: a fragment of pure narration still reports honestly', { skip }, () => {
  // Stripping leading noise must not empty a fragment out of existence: with
  // nothing left to name a food, it belongs in `unresolved`, not silently gone.
  const r = estimateFood('i ate');
  assert.equal(r.items.length, 0);
  assert.ok(r.unresolved.length >= 1, 'an unnameable fragment must be reported, not dropped');
});

test('narration prefix: "a"/"an" still count as the number one', { skip }, () => {
  // 'a' and 'an' are in NOISE *and* in WORD_NUMBERS; stripping them as noise
  // would have silently turned "a banana" into an unquantified fragment.
  const r = estimateFood('a banana');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].qty, 1, '"a banana" is one banana');
});

/* ------------------------------------------------------------------ *
 *  BUG 2 — picker and parser disagreed on the same food + portion     *
 * ------------------------------------------------------------------ */

test('portion sizing: resolveFoodQuantity uses the food\'s OWN measured serving', { skip }, () => {
  // resolveFoodQuantity passed `servingGrams` where portionToGrams destructures
  // `foodServingGrams`, so the picker silently fell back to a generic volume
  // figure while the text parser used the measured one. Measured before, on
  // "Arhar with spinach": parser 403.3 g (measured_serving) vs picker 250 g
  // (generic volume) -- a 61% divergence on the same food and portion.
  const candidates = search.foods
    .filter((f) => Number(f.serving_grams) > 0 && /dal|curry/i.test(f.food_name))
    .slice(0, 5);
  assert.ok(candidates.length, 'need at least one bowl-able food with a measured serving');

  for (const c of candidates) {
    const hit = searchFoods(c.food_name, { limit: 1, withPortions: false })[0];
    if (!hit || !(Number(hit.serving_grams) > 0)) continue;
    const resolved = resolveFoodQuantity(hit, { portionKey: 'bowl', count: 1 });
    assert.ok(resolved, `${hit.food_name} must resolve`);
    assert.equal(resolved.grams, hit.serving_grams,
      `${hit.food_name}: a bowl must use the row's measured serving, not a generic volume`);
    assert.equal(resolved.grams_basis, 'measured_serving');
  }
});

test('portion sizing: the picker and the text parser agree on the same food', { skip }, () => {
  const withServing = search.foods.find((f) => Number(f.serving_grams) > 0 && /curry/i.test(f.food_name));
  const hit = searchFoods(withServing.food_name, { limit: 1, withPortions: false })[0];
  const picker = resolveFoodQuantity(hit, { portionKey: 'bowl', count: 1 });
  const parser = estimateFood(`1 bowl ${withServing.food_name}`).items[0];
  assert.ok(picker && parser, 'both paths must produce an answer');
  assert.equal(picker.grams, parser.grams,
    'the two quantity paths must never disagree about the same food and portion');
});

/* ------------------------------------------------------------------ *
 *  BUG 3 — ambiguous generic terms picked a row by JSON insertion order*
 * ------------------------------------------------------------------ */

test('ambiguity: "curd" resolves the same way on every call', { skip }, () => {
  // Five rows are named exactly "Curd" (43.5-77 kcal/100 g, a 77% spread) and
  // scored identically, so the winner came down to their order in the source
  // JSON. Determinism is the floor: the same query must not cost a user's day
  // differently run to run.
  const runs = Array.from({ length: 5 }, () => estimateFood('100g curd').items[0]?.source_id);
  assert.ok(runs[0], '"curd" must resolve');
  assert.equal(new Set(runs).size, 1, `"curd" resolved to ${new Set(runs).size} different foods across identical calls`);
});

test('ambiguity: a generic term does not resolve to a branded product', { skip }, () => {
  // "milk" returned OPEN_FOOD_FACTS' Amul carton (58 kcal) ahead of IFCT2017's
  // lab-measured "Milk, whole, Cow" (72.9). A user who names no brand is
  // asking for the food, not for one company's version of it.
  for (const q of ['milk', 'curd', 'paneer', 'roti']) {
    const top = search.search(q, { limit: 1 })[0];
    assert.ok(top, `"${q}" must resolve`);
    const row = rowOf(top.source_id);
    assert.ok(!row.brand, `"${q}" resolved to the branded product "${row.brand} ${row.food_name}"`);
  }
});

test('ambiguity: naming a brand DOES find that brand\'s product', { skip }, () => {
  // The other half of the same signal: `brand` was never indexed at all, so
  // "amul milk" could not reach the row stored as {food_name:'Milk',
  // brand:'Amul'} -- every query token has to match and 'amul' matched nothing.
  const branded = search.foods.find((f) => /^amul$/i.test(String(f.brand || '')));
  assert.ok(branded, 'expected at least one Amul row in the database');
  const q = `amul ${branded.food_name}`.toLowerCase();
  const hits = search.search(q, { limit: 5 });
  assert.ok(hits.length, `"${q}" must return something`);
  assert.ok(hits.some((h) => /^amul$/i.test(String(rowOf(h.source_id)?.brand || ''))),
    `"${q}" returned no Amul product`);
});

test('ambiguity: genuinely equivalent alternatives are offered, not hidden', { skip }, () => {
  // Cow vs buffalo milk is a real choice with a real difference (72.9 vs 107.3
  // kcal/100 g) and the user is the only one who knows which they drank.
  const item = estimateFood('200ml milk').items[0];
  assert.ok(item, 'milk must resolve');
  assert.equal(item.ambiguous, true, 'milk should offer alternatives');
  assert.ok(item.alternatives.length >= 1);
  for (const alt of item.alternatives) {
    assert.ok(alt.source_id && alt.name, 'an alternative must be identifiable');
    assert.notEqual(alt.source_id, item.source_id, 'an alternative must not be the chosen food');
  }
});

test('ambiguity: an unambiguous food offers no alternatives', { skip }, () => {
  // The flag has to mean something: if everything is "ambiguous" the UI can
  // only either nag constantly or ignore it.
  const item = estimateFood('200g paneer').items[0];
  assert.ok(item);
  assert.equal(item.ambiguous, false, 'paneer resolves clearly and must not raise a question');
  assert.deepEqual(item.alternatives, []);
});

/* ------------------------------------------------------------------ *
 *  BUG 4 — substring matching hit the middle of unrelated words       *
 * ------------------------------------------------------------------ */

test('matching: "chole" does not return cholesterol products', { skip }, () => {
  // "chole" is a substring of "cholesterol", so a plain `includes` returned
  // "Mayonnaise dressing, no cholesterol" (688 kcal) and "Cheese, cheddar,
  // imitation, low cholesterol" for one of the most common Indian dishes.
  const hits = searchFoods('chole', { limit: 8, withPortions: false });
  assert.ok(hits.length, '"chole" must still resolve');
  for (const h of hits) {
    assert.ok(!/cholesterol/i.test(h.food_name),
      `"chole" returned the unrelated "${h.food_name}"`);
  }
});

test('matching: genuine inflections still match', { skip }, () => {
  // The boundary guard must not become a plural-breaker: it admits a token
  // within 3 characters of the query, which is what separates "curd"->"curds"
  // from "chole"->"cholesterol".
  for (const q of ['tomato', 'curd', 'egg']) {
    assert.ok(search.search(q, { limit: 1 }).length, `"${q}" must still match something`);
  }
});

/* ------------------------------------------------------------------ *
 *  BUG 5 — an over-broad "alias" outranked real matches               *
 * ------------------------------------------------------------------ */

test('matching: a bulk-extracted alias does not hijack the results', { skip }, () => {
  // food_aliases.json maps "yogurt" onto 86 ids -- down to babyfood and
  // yogurt-covered candy -- and a flat 900-point alias floor let every one of
  // them outrank plain yogurt. An alias pointing at dozens of foods is an
  // extraction artefact, not a synonym.
  const hits = search.search('yogurt', { limit: 3 });
  assert.ok(hits.length, '"yogurt" must resolve');
  assert.ok(!/babyfood|candies|candy/i.test(hits[0].food_name),
    `"yogurt" resolved to "${hits[0].food_name}"`);
  assert.ok(!/tofu|soy/i.test(hits[0].food_name),
    `"yogurt" resolved to the non-dairy "${hits[0].food_name}"`);
});

test('matching: a specific alias still works', { skip }, () => {
  // The specificity rule must not disable the alias system it protects:
  // "rajma" (4 targets) and "roti" (1) are exactly what aliases are for.
  for (const q of ['rajma', 'roti', 'chole']) {
    const top = search.search(q, { limit: 1 })[0];
    assert.ok(top, `"${q}" must resolve through its alias`);
  }
});

/* ------------------------------------------------------------------ *
 *  BUG 6 — a quarantined row outranked a usable one and killed the    *
 *          answer entirely                                            *
 * ------------------------------------------------------------------ */

test('quality: a quarantined row never outranks a usable one', { skip }, () => {
  // estimateFood refuses to let an untrustworthy row contribute a number, so
  // ranking one first does not degrade the answer, it removes it: "150g butter
  // chicken" returned NOTHING once a quarantined INDB row outranked a usable
  // one.
  // The invariant that actually matters: estimateFood consumes hits[0] and
  // nothing else, so a quarantined row must never be the TOP hit while any
  // usable candidate exists. (Total ordering is deliberately NOT asserted: the
  // penalty is a fixed weight, so a quarantined near-perfect name match can
  // still sit above a usable but barely-related one further down the list --
  // which costs nothing, because nothing below hits[0] is priced.)
  for (const q of ['butter chicken', 'paneer', 'dal', 'rice', 'chicken']) {
    const hits = search.search(q, { limit: 6 });
    if (hits.length < 2) continue;
    const anyUsable = hits.some((h) => h.trustworthy !== false);
    if (!anyUsable) continue;
    assert.notEqual(hits[0].trustworthy, false,
      `"${q}": quarantined "${hits[0].food_name}" won despite a usable alternative`);
  }
});

test('quality: "150g butter chicken" produces an answer', { skip }, () => {
  const r = estimateFood('150g butter chicken');
  assert.equal(r.items.length, 1, `expected an answer, got unresolved: ${JSON.stringify(r.unresolved)}`);
  assert.equal(r.items[0].grams, 150);
  assert.ok(r.items[0].calories > 0);
});

/* ------------------------------------------------------------------ *
 *  THE ARITHMETIC — deterministic, from the matched row               *
 * ------------------------------------------------------------------ */

// The user-facing statement of the rule: value = per100g x grams / 100.
// 100 g = 60 kcal therefore 250 g = 150 kcal.
const QUANTITIES = [
  ['100g curd', 100], ['200g curd', 200], ['250g curd', 250],
  ['100g rice', 100], ['200g paneer', 200], ['0.5kg rice', 500],
  ['150g chicken', 150], ['50 g oats', 50],
];

for (const [input, grams] of QUANTITIES) {
  test(`arithmetic: "${input}" scales its matched row by ${grams}/100`, { skip }, () => {
    const item = estimateFood(input).items[0];
    assert.ok(item, `"${input}" must resolve`);
    assert.equal(item.grams, grams, 'explicit mass must be honoured exactly');
    assert.equal(item.grams_assumed, false);

    const row = rowOf(item.source_id);
    assert.ok(row, 'the matched row must be findable in the database');
    assert.equal(item.calories, Math.round(row.energy_kcal * grams / 100), 'calories');
    for (const [field, per100] of [['protein', row.protein_g], ['carbs', row.carb_g], ['fat', row.fat_g]]) {
      if (per100 === null || per100 === undefined) {
        // null means NOT MEASURED and is passed through as null on purpose --
        // a fabricated 0 would be worse than an honest gap.
        assert.equal(item[field], null, `${field} must stay null when the row does not measure it`);
      } else {
        assert.equal(item[field], expectScaled(per100, grams), field);
      }
    }
  });
}

test('arithmetic: doubling the mass exactly doubles every macro', { skip }, () => {
  const one = estimateFood('100g paneer').items[0];
  const two = estimateFood('200g paneer').items[0];
  assert.equal(one.source_id, two.source_id, 'both must match the same food');
  // Macros keep 2 dp and double exactly. Calories are rounded to a whole
  // number per item, so doubling the INPUT need not double the ROUNDED output
  // (paneer: 305.4 -> 305, and 610.8 -> 611). +/-1 kcal is that rounding, not
  // a scaling error -- asserting equality here would be asserting that
  // rounding does not happen.
  assert.equal(two.protein, Math.round(one.protein * 2 * 100) / 100);
  assert.ok(Math.abs(two.calories - one.calories * 2) <= 1,
    `${two.calories} should be ~2x ${one.calories}`);
});

test('arithmetic: kg and g are the same quantity', { skip }, () => {
  const kg = estimateFood('0.5kg rice').items[0];
  const g = estimateFood('500g rice').items[0];
  assert.equal(kg.source_id, g.source_id);
  assert.equal(kg.grams, g.grams);
  assert.equal(kg.calories, g.calories);
});

/* ------------------------------------------------------------------ *
 *  QUANTITY PARSING — the forms the spec calls out                    *
 * ------------------------------------------------------------------ */

test('quantity: counted, volume and mass forms all parse', { skip }, () => {
  const CASES = [
    ['100g curd', 100], ['250 g curd', 250], ['0.5 kg rice', 500],
    ['2 eggs', null], ['3 rotis', null], ['1 bowl dal', null],
    ['200ml milk', null], ['2 tbsp peanut butter', null],
  ];
  for (const [input, expectGrams] of CASES) {
    const item = estimateFood(input).items[0];
    assert.ok(item, `"${input}" must resolve to an item`);
    assert.ok(item.grams > 0, `"${input}" must have positive grams`);
    if (expectGrams !== null) assert.equal(item.grams, expectGrams, `"${input}" grams`);
  }
});

test('quantity: counted foods multiply a PER-PIECE weight, not a whole serving', { skip }, () => {
  const one = estimateFood('1 roti').items[0];
  const three = estimateFood('3 rotis').items[0];
  assert.equal(one.source_id, three.source_id);
  assert.equal(three.grams, one.grams * 3, '3 rotis must weigh exactly 3 rotis');
  assert.equal(three.calories, Math.round(rowOf(three.source_id).energy_kcal * three.grams / 100));
});

test('quantity: an unstated portion is FLAGGED as assumed, never presented as measured', { skip }, () => {
  // The rule from the spec: do not invent a weight for an undefined serving.
  // The engine may still fall back, but it must say so.
  const r = estimateFood('paneer');
  const item = r.items[0];
  if (item && item.grams_basis === 'assumed_100g') {
    assert.equal(item.grams_assumed, true, 'an assumed portion must be flagged as assumed');
  }
});

/* ------------------------------------------------------------------ *
 *  MULTI-FOOD — the spec's own worked example                         *
 * ------------------------------------------------------------------ */

test('multi-food: "I ate 200g curd and 2 rotis" resolves BOTH and sums them', { skip }, () => {
  // Measured before: this returned "Parle Hide &seek 200g(30)" (474 kcal) for
  // the curd, because the narration prefix pushed "200g" into the food name.
  const r = estimateFood('I ate 200g curd and 2 rotis');
  assert.equal(r.items.length, 2, `expected 2 items, got ${JSON.stringify(r.items.map((i) => i.name))}`);

  const curd = r.items.find((i) => /curd/i.test(i.matched_from));
  const roti = r.items.find((i) => /roti/i.test(i.matched_from));
  assert.ok(curd, 'the curd must resolve');
  assert.ok(roti, 'the rotis must resolve');
  assert.equal(curd.grams, 200, 'the explicit 200 g must be honoured');
  assert.ok(!/biscuit|hide|seek|bourbon|noodle/i.test(curd.name),
    `curd matched the packaged product "${curd.name}"`);

  // Each item is priced independently and the total is their sum.
  assert.equal(r.total.calories, Math.round(r.items.reduce((s, i) => s + i.calories, 0)));
});

test('multi-food: "two rotis with dal" is TWO foods, not one priced by the other', { skip }, () => {
  // "with" is a noise word rather than a separator, so this arrives as one
  // fragment; the unit parser then took "rotis" as the UNIT and "dal" as the
  // NAME, which priced the dal by a roti's weight AND lost the rotis
  // completely -- silently, because the fragment did resolve, so nothing was
  // reported unresolved and the meal total was simply short a food.
  const r = estimateFood('two rotis with dal');
  assert.equal(r.items.length, 2, `expected roti AND dal, got ${JSON.stringify(r.items.map((i) => i.name))}`);

  const roti = r.items.find((i) => /roti|chapati/i.test(i.name));
  const dal = r.items.find((i) => /dal/i.test(i.name));
  assert.ok(roti, 'the rotis must not disappear');
  assert.ok(dal, 'the dal must still resolve');
  // The count belongs to the food it was counting.
  assert.equal(roti.qty, 2, '"two" counts the rotis');
  assert.equal(roti.grams, estimateFood('1 roti').items[0].grams * 2, '2 rotis weigh 2 rotis');
});

test('multi-food: a generic unit is still a unit, not a second food', { skip }, () => {
  // The converse must not break: "1 bowl dal" is ONE food measured in bowls.
  // `piece`/`slice`/`bowl` carry no per-piece grams in the catalogue precisely
  // because they describe a shape, not a thing.
  for (const input of ['1 bowl dal', '2 pieces paneer', '1 cup rice']) {
    const r = estimateFood(input);
    assert.equal(r.items.length, 1, `"${input}" must stay a single food, got ${JSON.stringify(r.items.map((i) => i.name))}`);
  }
});

test('multi-food: the full sentence from the spec resolves every food', { skip }, () => {
  const r = estimateFood('I had two rotis with dal and some curd');
  assert.equal(r.items.length, 3, `expected roti + dal + curd, got ${JSON.stringify(r.items.map((i) => i.name))}`);
  assert.equal(r.total.calories, r.items.reduce((s, i) => s + i.calories, 0));
});

test('multi-food: nothing is silently dropped', { skip }, () => {
  // Anything that cannot be matched has to appear in `unresolved` -- a total
  // that quietly omits half the meal is worse than no total.
  const r = estimateFood('200g curd, 2 rotis and 3 xyzzyfoods');
  const accounted = r.items.length + r.unresolved.length;
  assert.equal(accounted, 3, 'every fragment must be either resolved or reported');
});

/* ------------------------------------------------------------------ *
 *  BUG 7 — grams against a household-measure serving were counted as  *
 *          SERVINGS (a 100x error), on the /intelligence food path    *
 * ------------------------------------------------------------------ */

// This is the second, table-backed nutrition path (services/intelligence/*),
// used by the /intelligence food routes. It is a different module from the
// skos-food-v1 engine above and had its own, worse arithmetic bug.

test('units: grams against a bowl/serving base scale by WEIGHT, not by count', () => {
  // multiplierFor had no branch for "mass input, household-measure base", so
  // gram input fell through to a last resort that treats the quantity as a
  // NUMBER OF SERVINGS. Measured before: 100 g of a 120 kcal/bowl dal came
  // back as 12,000 kcal (and 10,000 g); a 100 g apple as 5,200 kcal.
  const dal = { id: 'f1', name: 'Dal', serving: '1 bowl', calories: 120, protein: 6, carbs: 20, fat: 2 };
  const bowlGrams = perPieceDefaults.bowl; // the base this food is measured in

  const hundred = computeNutrition(dal, parseQuantity('100g'));
  assert.equal(hundred.qtyGrams, 100, '100 g must be 100 g');
  assert.equal(hundred.macros.calories, Math.round(120 * 100 / bowlGrams));
  assert.ok(hundred.macros.calories < 120, '100 g must be less than a whole 250 g bowl');

  // A mass equal to exactly one bowl must agree with asking for one bowl.
  const oneBowlByMass = computeNutrition(dal, parseQuantity(`${bowlGrams}g`));
  const oneBowlByName = computeNutrition(dal, parseQuantity('1 bowl'));
  assert.equal(oneBowlByMass.macros.calories, oneBowlByName.macros.calories,
    'the same amount expressed two ways must cost the same');
});

test('units: the scaling identity holds for a per-100g food', () => {
  // value = per100g x grams / 100. The spec's own example: 60 kcal at 100 g
  // is 150 kcal at 250 g.
  const curd = { id: 'f2', name: 'Curd', serving: '100 g', calories: 60, protein: 3.5, carbs: 4.5, fat: 3 };
  assert.equal(computeNutrition(curd, parseQuantity('250g')).macros.calories, 150);
  assert.equal(computeNutrition(curd, parseQuantity('100g')).macros.calories, 60);
  assert.equal(computeNutrition(curd, parseQuantity('0.5kg')).macros.calories, 300);
});

test('units: singular and plural piece words weigh the same', () => {
  // 'chapati', 'rotis' and 'phulkas' were missing from the per-piece table
  // while their counterparts were present, so each silently fell back to the
  // generic 50 g piece -- 43% heavier than a roti actually is.
  for (const [a, b] of [['roti', 'rotis'], ['chapati', 'chapatis'], ['phulka', 'phulkas']]) {
    assert.equal(perPieceDefaults[a], perPieceDefaults[b], `${a}/${b} must weigh the same`);
    assert.ok(perPieceDefaults[a] > 0, `${a} needs a per-piece weight`);
  }
  assert.notEqual(perPieceDefaults.roti, perPieceDefaults.piece,
    'a roti must not silently become the generic 50 g piece');
});

/* ------------------------------------------------------------------ *
 *  BUG 8 — "-es" plurals were mis-singularised and leaked into the    *
 *          food name                                                  *
 * ------------------------------------------------------------------ */

test('quantity: "-es" plural units are recognised as units', { skip }, () => {
  // A single /(?:es|s)$/ rule matches "es" before it can match "s", so
  // "pieces" singularised to "piec" and "apples" to "appl". Neither matched
  // any unit, so the plural stayed in the FOOD NAME and poisoned the search:
  // "2 pieces paneer" looked up "pieces paneer" and returned "Snacks, fruit
  // leather, pieces" -- 12 g and 43 kcal in place of 200 g of paneer.
  const paneer = estimateFood('2 pieces paneer').items[0];
  assert.ok(paneer, '"2 pieces paneer" must resolve');
  assert.match(paneer.name, /paneer/i, `resolved to "${paneer.name}" instead of paneer`);
  assert.ok(paneer.grams >= 50, `${paneer.grams}g is not two pieces of paneer`);

  const bread = estimateFood('2 slices bread').items[0];
  assert.ok(bread, '"2 slices bread" must resolve');
  assert.match(bread.name, /bread/i, `resolved to "${bread.name}"`);

  // "apples" must reach the catalogue's per-apple weight, not a generic guess.
  const apples = estimateFood('2 apples').items[0];
  const apple = estimateFood('1 apple').items[0];
  assert.ok(apples && apple);
  assert.equal(apples.grams, apple.grams * 2, 'two apples weigh two apples');
});

test('quantity: "-s" plurals and singulars still resolve identically', { skip }, () => {
  // The fix adds candidate forms rather than replacing the rule, so every
  // plural that already worked must keep working.
  for (const [plural, singular] of [['2 bowls dal', '2 bowl dal'], ['2 rotis', '2 roti']]) {
    const p = estimateFood(plural).items[0];
    const s = estimateFood(singular).items[0];
    assert.ok(p && s, `${plural} / ${singular} must both resolve`);
    assert.equal(p.grams, s.grams, `${plural} and ${singular} must weigh the same`);
    assert.equal(p.source_id, s.source_id);
  }
});

/* ------------------------------------------------------------------ *
 *  BUG 9 — progressive backoff discarded the HEAD NOUN and matched    *
 *          on the modifier                                            *
 * ------------------------------------------------------------------ */

test('backoff: a "<modifier> <food>" query resolves the FOOD, not the modifier', { skip }, () => {
  // Backoff dropped tokens from the END, but in these phrasings the food is
  // the LAST word, so it threw the food away and searched the adjective.
  // Measured before: "1 medium apple" -> "Beef, ground, MEDIUM, baked";
  // "120g grilled tofu" -> "Tomato sandwich (GRILLED)"; "black coffee" ->
  // "BLACK berry"; "generic potato chips" -> "Water, bottled, GENERIC".
  const CASES = [
    ['1 medium apple', /apple/i],
    ['120g grilled tofu', /tofu/i],
    ['black coffee', /coffee/i],
    ['150g grilled prawns', /prawn/i],
    ['200g steamed broccoli', /broccoli/i],
    ['generic potato chips', /potato|chip/i],
    ['homemade chapati', /chapati|roti/i],
    ['80g dry rolled oats', /oat/i],
  ];
  for (const [input, want] of CASES) {
    const item = estimateFood(input).items[0];
    assert.ok(item, `"${input}" must resolve`);
    assert.match(item.name, want, `"${input}" resolved to "${item.name}"`);
  }
});

test('backoff: a head-noun-FIRST query still resolves on its head noun', { skip }, () => {
  // The direction is chosen by score, not hardcoded, because Indian dish
  // names commonly lead with the head noun. Preferring the tail outright made
  // "rajma chawal" match `chawal` and return "Curd rice (Dahi bhaat/...)".
  const rajma = estimateFood('rajma chawal').items[0];
  assert.ok(rajma);
  assert.match(rajma.name, /rajma|kidney bean/i, `resolved to "${rajma.name}"`);
});

test('backoff: never invents a match for a food that does not exist', { skip }, () => {
  // Relaxing the query must not become a licence to match anything. Each of
  // these anchored on a token that names no food -- a pack size, a category
  // word, a negation -- and returned a confident number for a non-food.
  const NONFOOD = [
    'xyyzqq nonfoodterm 500g',   // anchored on the pack size "500g"
    'zzqxvv-not-a-real-ingredient', // anchored on "real"
    'zzzq-not-a-food',           // anchored on "not food"
    'plastic bag',               // "bag" grown into "bagel"
  ];
  for (const input of NONFOOD) {
    const r = estimateFood(input);
    assert.equal(r.items.length, 0, `"${input}" resolved to "${r.items[0]?.name}"`);
    assert.equal(r.total.calories, 0);
    assert.ok(r.unresolved.length >= 1, 'the miss must be reported, not silently dropped');
  }
});

test('backoff: at most half the query may be discarded', { skip }, () => {
  // A four-word phrase must not be "matched" on one incidental word.
  const r = estimateFood('zzqxvv fixture food alpha');
  assert.equal(r.items.length, 0);
  assert.ok(r.unresolved.length >= 1);
});

/* ------------------------------------------------------------------ *
 *  BUG 10 — "<food> with <food>" silently lost the second food        *
 * ------------------------------------------------------------------ */

test('with-conjunction: both foods are resolved, nothing is dropped', { skip }, () => {
  // `with` is a noise WORD, not a separator, so these arrived as one fragment
  // that resolved to a single food -- silently, since nothing was reported
  // unresolved and the total was simply short. Eight of the benchmark's
  // multi-item cases lost food this way.
  const CASES = [
    ['150g grilled chicken with 100g rice', [/chicken/i, /rice/i]],
    ['one bowl chicken curry with rice', [/chicken/i, /rice/i]],
    ['a plate of noodles with chicken', [/noodle/i, /chicken/i]],
    ['paneer bhurji with 2 rotis', [/paneer/i, /roti|chapati/i]],
  ];
  for (const [input, wants] of CASES) {
    const r = estimateFood(input);
    assert.equal(r.items.length, wants.length,
      `"${input}" -> ${JSON.stringify(r.items.map((i) => i.name))}`);
    for (const w of wants) {
      assert.ok(r.items.some((i) => w.test(i.name)), `"${input}" is missing ${w}`);
    }
    // The total rounds the sum; each item rounds its own figure. Those can
    // differ by a kcal (480.4 + 141.6 rounds to 622 item-wise but 621 as a
    // sum) -- that is rounding, not a lost or double-counted food, which is
    // what this is actually checking.
    const summed = r.items.reduce((s, i) => s + i.calories, 0);
    assert.ok(Math.abs(r.total.calories - summed) <= 1,
      `"${input}": total ${r.total.calories} vs items ${summed}`);
  }
});

test('with-conjunction: a fragment whose other half is not a food is left alone', { skip }, () => {
  // The guard against over-splitting a compound dish: both halves must name
  // something the catalogue actually knows.
  const r = estimateFood('rice with xyzzyqq');
  assert.equal(r.items.length, 1, `expected one item, got ${JSON.stringify(r.items.map((i) => i.name))}`);
});

test('with-conjunction: V1 and V3 agree, and neither double-counts', { skip }, async () => {
  // V3 re-split fragments V1 had already split, appending a second copy of
  // every food: "paneer bhurji with 2 rotis" came back as paneer + roti +
  // paneer + roti at 934 kcal instead of 467.
  const { estimateMeal } = await import('../src/services/food/index.js');
  for (const input of ['paneer bhurji with 2 rotis', 'dosa with sambar and chutney']) {
    const v1 = estimateFood(input);
    const v3 = estimateMeal(input, { engine: 'v3' });
    // Compared as SETS: V3 rebuilds the list while refining it, so item order
    // is not meaningful. What must hold is the same foods, the same total, and
    // each food exactly once.
    assert.deepEqual(v3.items.map((i) => i.name).sort(), v1.items.map((i) => i.name).sort(), input);
    assert.equal(v3.total.calories, v1.total.calories, input);
    for (const items of [v1.items, v3.items]) {
      const names = items.map((i) => i.name);
      assert.equal(new Set(names).size, names.length, `"${input}" contains a duplicate item`);
    }
  }
});
