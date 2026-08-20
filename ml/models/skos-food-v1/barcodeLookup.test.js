/**
 * Parity + invariant tests for the JS barcode-lookup reference
 * implementation.
 *
 * PURPOSE: mirrors ml/tests/test_barcode_lookup.py case-for-case, on the
 * SAME fixture records, so a divergence between the two languages shows
 * up as a failing test here rather than as a wrong number in the app --
 * the same discipline used for foodEstimate.reference.js / .test.js.
 *
 * Run: node ml/models/skos-food-v1/barcodeLookup.test.js
 */

'use strict';

const {
  BarcodeIndex, cleanCode, canonicalEan13, resolveServing, autoLogFromBarcode,
  DEFAULT_SERVING_G
} = require('./barcodeLookup.reference.js');

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
// Same two fixture records as test_barcode_lookup.py: a 12-digit product
// with a known serving size, and one with none published at all.
const PROTEIN_BAR = {
  source: 'OPEN_FOOD_FACTS',
  barcode: '890123456789',
  source_id: 'off:890123456789',
  food_name: 'Test Protein Bar',
  brand: 'TestBrand',
  serving_size_label: '1 bar (40 g)',
  serving_grams: 40.0,
  serving_grams_source: 'off_serving_quantity',
  energy_kcal: 450.0,
  protein_g: 30.0,
  fat_g: 15.0,
  carb_g: 40.0,
  fiber_g: null,
  sugar_g: 10.0,
  sodium_mg: 200.0,
  calcium_mg: null,
  iron_mg: null
};

const LOOSE_SNACK = {
  source: 'OPEN_FOOD_FACTS',
  barcode: '8901234567895',
  source_id: 'off:8901234567895',
  food_name: 'Test Loose Snack',
  brand: null,
  serving_size_label: null,
  serving_grams: null,
  serving_grams_source: null,
  energy_kcal: 500.0,
  protein_g: 8.0,
  fat_g: 25.0,
  carb_g: 55.0,
  fiber_g: 3.0,
  sugar_g: 20.0,
  sodium_mg: 300.0,
  calcium_mg: 50.0,
  iron_mg: 2.0
};

function fixtureIndex() {
  const data = {};
  for (const rec of [PROTEIN_BAR, LOOSE_SNACK]) {
    data[rec.barcode] = rec;
    data[canonicalEan13(rec.barcode)] = rec;
  }
  return new BarcodeIndex(data);
}

// -------------------------------------------------------------- cleanCode
check('cleanCode strips whitespace', () => {
  assert(cleanCode('  890123456789  ') === '890123456789');
});
check('cleanCode strips off: prefix', () => {
  assert(cleanCode('off:890123456789') === '890123456789');
});
check('cleanCode strips non-digits', () => {
  assert(cleanCode('8901-2345-6789') === '890123456789');
});
check('cleanCode handles null/empty', () => {
  assert(cleanCode(null) === '');
  assert(cleanCode('') === '');
});

// ---------------------------------------------------------- canonicalEan13
check('canonicalEan13 pads 12-digit UPC-A', () => {
  assert(canonicalEan13('890123456789') === '0890123456789');
});
check('canonicalEan13 leaves 13-digit alone', () => {
  assert(canonicalEan13('8901234567895') === '8901234567895');
});
check('canonicalEan13 leaves 14-digit GTIN alone', () => {
  const code14 = '12345678901234';
  assert(canonicalEan13(code14) === code14);
});
check('canonicalEan13 pads short EAN-8', () => {
  assert(canonicalEan13('12345678') === '0000012345678');
});

// -------------------------------------------------------------- BarcodeIndex
check('BarcodeIndex exact raw code hit', () => {
  const idx = fixtureIndex();
  const r = idx.lookup('890123456789');
  assert(r && r.food_name === 'Test Protein Bar');
});
check('BarcodeIndex resolves the UPC-A/EAN-13 leading-zero collision both ways', () => {
  const idx = fixtureIndex();
  const rawHit = idx.lookup('890123456789');
  const paddedHit = idx.lookup('0890123456789');
  assert(rawHit && paddedHit, 'both forms must resolve');
  assert(rawHit.barcode === paddedHit.barcode);
});
check('BarcodeIndex miss returns null', () => {
  const idx = fixtureIndex();
  assert(idx.lookup('000000000000') === null);
});
check('BarcodeIndex tolerates whitespace and off: prefix', () => {
  const idx = fixtureIndex();
  assert(idx.lookup('  890123456789 ') !== null);
  assert(idx.lookup('off:890123456789') !== null);
});
check('BarcodeIndex empty code is a clean miss', () => {
  const idx = fixtureIndex();
  assert(idx.lookup('') === null);
  assert(idx.lookup(null) === null);
});

// -------------------------------------------------------------- resolveServing
check('resolveServing scales a known serving correctly', () => {
  const r = resolveServing(PROTEIN_BAR, 1.0);
  assert(r.serving_grams_known === true);
  assert(r.grams === 40.0);
  assertClose(r.totals.energy_kcal, 180.0, 0.1, 'energy for one bar');
  assertClose(r.totals.protein_g, 12.0, 0.1, 'protein for one bar');
});
check('resolveServing multiplies with servings count', () => {
  const r = resolveServing(PROTEIN_BAR, 2.5);
  assert(r.grams === 100.0);
  assertClose(r.totals.energy_kcal, 450.0, 0.1);
});
check('resolveServing falls back to 100g and flags unknown serving', () => {
  const r = resolveServing(LOOSE_SNACK, 1.0);
  assert(r.serving_grams_known === false);
  assert(r.grams === DEFAULT_SERVING_G);
});
check('resolveServing keeps a null macro null through scaling', () => {
  const r = resolveServing(PROTEIN_BAR, 3);
  assert(r.totals.fiber_g === null, 'unmeasured fiber must not become 0');
});
check('resolveServing on a null record returns null', () => {
  assert(resolveServing(null) === null);
});

// -------------------------------------------------------------- autoLogFromBarcode
check('autoLogFromBarcode hit shape and confidence always high', () => {
  const idx = fixtureIndex();
  const result = autoLogFromBarcode('890123456789', 1.0, idx);
  assert(result.schema_version === 'food-v1');
  assert(result.tier === 'barcode');
  assert(result.match_kind === 'barcode_exact');
  assert(result.confidence === 'high');
});
check('autoLogFromBarcode known serving produces no notes', () => {
  const idx = fixtureIndex();
  const result = autoLogFromBarcode('890123456789', 1.0, idx);
  assert(result.notes.length === 0);
  assert(result.quantity.serving_grams_known === true);
});
check('autoLogFromBarcode unknown serving produces a note and still logs', () => {
  const idx = fixtureIndex();
  const result = autoLogFromBarcode('8901234567895', 1.0, idx);
  assert(result !== null);
  assert(result.quantity.serving_grams_known === false);
  assert(result.quantity.grams === DEFAULT_SERVING_G);
  assert(result.notes.length >= 1);
});
check('autoLogFromBarcode miss returns null, never a guess', () => {
  const idx = fixtureIndex();
  assert(autoLogFromBarcode('000000000000', 1.0, idx) === null);
});
check('autoLogFromBarcode totals scale with servings count', () => {
  const idx = fixtureIndex();
  const one = autoLogFromBarcode('890123456789', 1.0, idx);
  const two = autoLogFromBarcode('890123456789', 2.0, idx);
  assertClose(two.totals.energy_kcal, one.totals.energy_kcal * 2, 0.1);
});
check('autoLogFromBarcode defaults servings to 1 when omitted', () => {
  const idx = fixtureIndex();
  const withDefault = autoLogFromBarcode('890123456789', undefined, idx);
  assert(withDefault.quantity.servings === 1.0);
});

// -------------------------------------------------------------------- report
console.log('');
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`${passed} check(s) passed.`);
