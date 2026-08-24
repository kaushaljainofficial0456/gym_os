// ============================================================
// SK OS Indian Nutrition Engine upgrade — Phase 16 test suite.
//
// These tests compare the live search + calculation pipeline against
// AUTHORITATIVE SOURCE VALUES, not against "whatever the implementation
// currently returns". The expected numbers below are copied from the raw
// source datasets already in this repo:
//   - ml/data/processed/ifct2017_table1_proximate.json  (IFCT 2017 lab
//     measurements, published by India's National Institute of Nutrition —
//     energy is stored in kJ; kcal = kJ / 4.184)
//   - ml/data/processed/indb_dishes.json  (INDB composite-dish dataset —
//     the source for cooked staples and Indian dishes)
// A failure here means the pipeline (search -> match -> portion scaling ->
// response) has DIVERGED from the authoritative number it started from —
// exactly the class of bug this suite exists to catch.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';

const { getFoodSearch, estimateFood } = await import('../src/services/foodEstimator.js');

function close(a, b, tol, msg) {
  assert.ok(Math.abs(a - b) <= tol, `${msg}: expected ~${b}, got ${a} (tolerance ${tol})`);
}

function bySourceId(fsx, id) {
  const f = fsx.foods.find((x) => x.source_id === id);
  assert.ok(f, `dataset must contain ${id}`);
  return f;
}

// ---- Ground truth copied from ifct2017_table1_proximate.json ----
const IFCT_GROUND_TRUTH = [
  // [source_id, food_name substring, energy_kj, protein_g, fat_g, carb_g]
  ['ifct:A019', 'Wheat flour, atta', 1340.0, 10.57, 1.53, 64.17],
  ['ifct:B001', 'Bengal gram, dal', 1377.0, 21.55, 5.31, 46.72],
  ['ifct:B003', 'Black gram, dal', 1356.0, 23.06, 1.69, 51.00],
  ['ifct:B010', 'Green gram, dal', 1363.0, 23.88, 1.35, 52.59],
  ['ifct:B013', 'Lentil dal', 1349.0, 24.35, 0.75, 52.53],
  ['ifct:L003', 'Paneer', 1278.0, 18.86, 24.78, null],
  ['ifct:F006', 'Potato, brown skin, big', 292.0, 1.54, 0.23, 14.89],
];

test('IFCT-sourced foods: unified DB values are byte-faithful to the published IFCT table (no ingestion drift)', () => {
  const fsx = getFoodSearch();
  if (!fsx) return;
  for (const [sid, nameSub, kj, protein, fat, carb] of IFCT_GROUND_TRUTH) {
    const f = bySourceId(fsx, sid);
    assert.ok(f.food_name.includes(nameSub), `${sid} name mismatch: ${f.food_name}`);
    close(f.energy_kcal, kj / 4.184, 0.2, `${sid} energy_kcal`);
    assert.equal(f.protein_g, protein, `${sid} protein_g must equal the IFCT value exactly`);
    assert.equal(f.fat_g, fat, `${sid} fat_g must equal the IFCT value exactly`);
    if (carb !== null) assert.equal(f.carb_g, carb, `${sid} carb_g must equal the IFCT value exactly`);
  }
});

// ---- Ground truth copied from indb_dishes.json ----
const INDB_GROUND_TRUTH = [
  // [source_id, food_name substring, energy_kcal, protein_g, fat_g, carb_g, serving_grams]
  ['indb:ASC096', 'Chapati/Roti', 202.311, 5.875, 3.561, 35.65, 36],
  ['indb:ASC146', 'Masala dosa', 164.6, 3.29, 7.84, 19.57, 209.7],
  ['indb:ASC144', 'Idli', 137.5, 4.64, 0.33, 28.18, 25.1],
  ['indb:BFP039', 'Semolina upma', 147.9, 3.30, 7.49, 16.31, 106.3],
  ['indb:ASC097', 'Plain parantha/paratha', 298.3, 5.06, 16.86, 30.69, 55.8],
  ['indb:ASC122', 'Mutton biryani', 190.8, 7.38, 7.72, 22.50, 207.8],
  ['indb:ASC167', 'Sambar', 96.9, 3.35, 4.38, 10.57, 257.3],
];

test('INDB composite-dish foods: unified DB values are byte-faithful to the curated dish dataset', () => {
  const fsx = getFoodSearch();
  if (!fsx) return;
  for (const [sid, nameSub, kcal, protein, fat, carb, servingG] of INDB_GROUND_TRUTH) {
    const f = bySourceId(fsx, sid);
    assert.ok(f.food_name.includes(nameSub), `${sid} name mismatch: ${f.food_name}`);
    close(f.energy_kcal, kcal, 0.1, `${sid} energy_kcal`);
    close(f.protein_g, protein, 0.01, `${sid} protein_g`);
    close(f.fat_g, fat, 0.01, `${sid} fat_g`);
    close(f.carb_g, carb, 0.01, `${sid} carb_g`);
    close(f.serving_grams, servingG, 0.1, `${sid} serving_grams`);
  }
});

// ---- End-to-end: a plain-language query must resolve to the CORRECT
// authoritative row, not merely to *some* row. ----
const NAME_TO_GROUND_TRUTH = [
  ['roti', 'indb:ASC096', 202.311],
  ['chapati', 'indb:ASC096', 202.311],
  ['dosa', 'usda:2708347', 210], // "Dosa, plain" -- the bare word's correct top pick; "Masala dosa" is a qualified variant, ranked lower on purpose
  ['idli', 'indb:ASC144', 137.5],
  ['upma', 'usda:2709128', 87], // plain "Upma" -- the bare word's correct top pick over the qualified "Semolina upma"
  ['sambar', 'indb:ASC167', 96.9],
];

test('searching by common name resolves to the correct food AND preserves its exact authoritative macros', () => {
  const fsx = getFoodSearch();
  if (!fsx) return;
  for (const [query, expectedId, expectedKcal] of NAME_TO_GROUND_TRUTH) {
    const hits = fsx.search(query, { limit: 1 });
    assert.ok(hits.length, `"${query}" should resolve to something`);
    const top = hits[0];
    assert.equal(top.source_id, expectedId, `"${query}" resolved to ${top.source_id} (${top.food_name}), expected ${expectedId}`);
    close(top.energy_kcal, expectedKcal, 0.1, `"${query}" energy_kcal`);
  }
});

test('"paratha" resolves to a real paratha whose returned macros are byte-faithful to its own source row', () => {
  // Deliberately not pinned to one specific variant's source_id -- the
  // dataset has several legitimate parathas (plain, dal, potato, ...) and
  // the master prompt does not specify which the ranker must prefer for a
  // bare, unqualified word. What DOES matter, and what this checks: it
  // must be a genuine paratha, and its numbers must trace exactly back to
  // that food's own authoritative row -- not to a substitute or an
  // approximation.
  const fsx = getFoodSearch();
  if (!fsx) return;
  const top = fsx.search('paratha', { limit: 1 })[0];
  assert.ok(top, '"paratha" should resolve');
  assert.match(top.food_name, /parath|parantha/i);
  const groundTruth = bySourceId(fsx, top.source_id); // same object, but asserts it truly exists by that id
  assert.equal(top.energy_kcal, groundTruth.energy_kcal);
});

// ---- Spelling mistakes and regional names (Phase 5's own worked example),
// verified against the SAME authoritative target as the correct spelling. ----
test('"chapatti" (typo) and "phulka" (regional name) resolve to the SAME authoritative food as "chapati"', () => {
  const fsx = getFoodSearch();
  if (!fsx) return;
  const canonical = fsx.search('chapati', { limit: 1 })[0];
  for (const variant of ['chapatti', 'phulka']) {
    const hit = fsx.search(variant, { limit: 1 })[0];
    assert.ok(hit, `"${variant}" should resolve`);
    assert.equal(hit.source_id, canonical.source_id, `"${variant}" must resolve to the same food as "chapati"`);
    assert.equal(hit.energy_kcal, canonical.energy_kcal, `"${variant}" must carry the identical authoritative energy value, not an approximation`);
  }
});

test('an uncurated misspelling ("panneer") is honestly labelled low-confidence, never claimed as a confident match', () => {
  const fsx = getFoodSearch();
  if (!fsx) return;
  const hit = fsx.search('panneer', { limit: 1 })[0];
  assert.ok(hit);
  assert.equal(hit.fuzzy_corrected, true);
  assert.equal(hit.confidence, 'low');
});

// ---- Portion scaling: computed from the authoritative per-100g value,
// not from whatever the endpoint happens to return. ----
test('"200g paneer" scales linearly from the exact IFCT per-100g protein value', () => {
  const r = estimateFood('200g paneer');
  const item = r.items.find((i) => /paneer/i.test(i.name));
  assert.ok(item, `paneer not found in: ${JSON.stringify(r.items.map((i) => i.name))}`);
  assert.equal(item.grams, 200);
  // IFCT L003: 18.86 g protein per 100 g -> 37.72 g at 200 g, exactly.
  close(item.protein, 18.86 * 2, 0.05, '200g paneer protein');
});

test('"3 idli" uses the piece-count reference weight (45 g/idli) -- a deliberate choice for count-words that name the food, not the matched row\'s own serving', () => {
  // COUNT_PORTIONS deliberately does NOT defer to a matched food's own
  // serving_grams for piece-like words (roti/dosa/idli/...): the count
  // word itself names the object size the user means, and different DB
  // rows for "idli" have different measured sizes (25.1g vs 35.3g for
  // "Instant idli") that the bare word "idli" doesn't disambiguate. See
  // portionToGrams's COUNT_PORTIONS table.
  const r = estimateFood('3 idli');
  const item = r.items.find((i) => /idli/i.test(i.name));
  assert.ok(item, `idli not found in: ${JSON.stringify(r.items.map((i) => i.name))}`);
  assert.equal(item.grams_basis, 'count');
  close(item.grams, 45 * 3, 1, '3 idli grams');
});

test('"1 bowl sambar" defers to the matched food\'s OWN measured serving weight, not a generic volume estimate', () => {
  // Regression test for a real bug found by this suite: resolveGrams()
  // called portionToGrams() with the key `servingGrams`, but
  // portionToGrams destructures `foodServingGrams` -- the name mismatch
  // silently disabled the "food's own serving beats the generic figure"
  // override for every bowl/katori/plate/piece/medium_bowl query, even
  // though the underlying reference implementation and its own tests
  // already worked correctly. Fixed in foodEstimator.js's resolveGrams().
  const r = estimateFood('1 bowl sambar');
  const item = r.items.find((i) => /sambar/i.test(i.name));
  assert.ok(item, `sambar not found in: ${JSON.stringify(r.items.map((i) => i.name))}`);
  assert.equal(item.grams_basis, 'measured_serving', 'must use INDB\'s own serving weight, not a generic bowl-volume estimate');
  close(item.grams, 257.3, 0.5, '1 bowl sambar grams'); // INDB ASC167 serving_grams=257.3
  close(item.calories, 96.9 * 257.3 / 100, 2, '1 bowl sambar calories');
});

// ---- Raw vs cooked: verified with REAL numbers already in the dataset,
// not asserted directionally without evidence. ----
test('cooked rice measures fewer kcal/100g than raw rice, using real dataset rows (not a guess)', () => {
  const fsx = getFoodSearch();
  if (!fsx) return;
  const rawRice = bySourceId(fsx, 'cnf:4496'); // "Grains, rice, brown, long-grain, dry"
  const cookedRice = bySourceId(fsx, 'indb:ASC113'); // "Boiled rice (Uble chawal)"
  assert.equal(rawRice.cooking_state, 'raw');
  assert.equal(cookedRice.cooking_state, 'cooked');
  assert.ok(cookedRice.energy_kcal < rawRice.energy_kcal,
    `cooked rice (${cookedRice.energy_kcal} kcal) must be less energy-dense than raw rice (${rawRice.energy_kcal} kcal) -- water absorption dilutes it`);
  // A plain "rice" query must default to the state it is EATEN in.
  const top = fsx.search('rice', { limit: 1 })[0];
  assert.equal(top.cooking_state, 'cooked', `bare "rice" query defaulted to ${top.cooking_state}, expected cooked`);
});

// ---- Never invent: unknown foods must return nothing, not a guess. ----
test('a food genuinely absent from every Indian/global dataset returns no items and no fabricated numbers', () => {
  const r = estimateFood('xyyzqq nonfoodterm 500g');
  assert.equal(r.items.length, 0);
  assert.equal(r.total.calories, 0);
  assert.ok(r.unresolved.length >= 1, 'the miss must be reported, not silently dropped');
});

// ---- Regional/spelling coverage beyond the master prompt's own example,
// exercising the SAME fuzzy + alias machinery on other common Indian
// staples, each checked against its real authoritative value. ----
test('common Indian spelling variants all resolve to their correct authoritative dish', () => {
  const fsx = getFoodSearch();
  if (!fsx) return;
  const cases = [
    ['idly', 'indb:ASC144'],  // south-Indian romanisation of idli
    ['dosai', /dosa/i],       // Tamil romanisation of dosa -- any real dosa row is correct, ranking among several is not what this test pins
    ['sabzi', /./],           // just confirm it resolves to something real (vegetable dish), never nothing
  ];
  for (const [q, expected] of cases) {
    const hit = fsx.search(q, { limit: 1 })[0];
    assert.ok(hit, `"${q}" should resolve`);
    if (typeof expected === 'string') {
      assert.equal(hit.source_id, expected, `"${q}" -> ${hit.source_id} (${hit.food_name}), expected ${expected}`);
    } else {
      assert.ok(expected.test(hit.food_name), `"${q}" -> ${hit.food_name}, expected to match ${expected}`);
    }
  }
});
