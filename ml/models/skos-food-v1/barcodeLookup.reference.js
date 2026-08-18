/**
 * skos-food-v1 — barcode lookup, JS REFERENCE IMPLEMENTATION
 *
 * WHY A SEPARATE FILE FROM foodEstimate.reference.js:
 * Text search (foodEstimate.reference.js -> FoodSearch) is fuzzy retrieval
 * over free text: it ranks candidates and can legitimately be wrong. Barcode
 * lookup is an EXACT key lookup over whatever a scanner reads verbatim --
 * dict[barcode] -> product, or a miss. There is no ranking and no confidence
 * CALIBRATION question the way the contract's §3.2 means it for search, so
 * this stays its own small module rather than a mode inside FoodSearch.
 *
 * `confidence` on a barcode result is always `"high"` — the identity match
 * is exact by construction. That is a DIFFERENT claim from "we know how
 * much of it you ate": `serving_grams_known` is the separate, honest flag
 * for that, because plenty of Open Food Facts products carry no
 * serving_size at all.
 *
 * DATA: takes a parsed `off_barcode_index.json` object (same artifact the
 * Python side reads) — this module does not touch the filesystem itself,
 * matching how FoodSearch takes `foods` as a constructor argument rather
 * than loading unified_food_db.json on its own.
 *
 * NOTE FOR TEXT SEARCH: a product findable here is not guaranteed to also
 * surface via FoodSearch — the barcode index is deliberately broader (see
 * ml/src/ingestion/build_barcode_index.py) than the India-tagged set text
 * search draws on, since broadening carries no "wrong food" risk for an
 * exact key lookup the way it would for ranked text search.
 *
 * PARITY: mirrors ml/src/inference/barcode_lookup.py field-for-field.
 * barcodeLookup.test.js checks both against the same fixture records.
 */

'use strict';

const DEFAULT_SERVING_G = 100.0;
const SCALED_FIELDS = ['energy_kcal', 'protein_g', 'fat_g', 'carb_g',
  'fiber_g', 'sugar_g', 'sodium_mg', 'calcium_mg', 'iron_mg'];

/** Scanners hand back plain digits; tolerate whitespace and a stray
 *  'off:' source_id prefix if a caller passes that in by mistake. */
function cleanCode(code) {
  if (code === null || code === undefined) return '';
  let s = String(code).trim();
  if (s.startsWith('off:')) s = s.slice(4);
  return s.replace(/\D/g, '');
}

/** A UPC-A code is numerically an EAN-13 with a leading zero, so 12-digit
 *  and 13-digit scans of the SAME physical product must both resolve. See
 *  build_barcode_index.py for why both forms are stored as keys at build
 *  time. */
function canonicalEan13(code) {
  if (code.length <= 13) return code.padStart(13, '0');
  return code;
}

class BarcodeIndex {
  /** @param {Object} indexData  parsed off_barcode_index.json */
  constructor(indexData) {
    this._data = indexData || {};
  }

  size() {
    return new Set(Object.values(this._data).map((r) => r.barcode)).size;
  }

  /** Exact lookup only. Returns the record or null — never a "closest"
   *  match; a scanned barcode that isn't indexed is a miss, not an
   *  invitation to guess. */
  lookup(code) {
    const c = cleanCode(code);
    if (!c) return null;
    if (Object.prototype.hasOwnProperty.call(this._data, c)) return this._data[c];
    const canon = canonicalEan13(c);
    return Object.prototype.hasOwnProperty.call(this._data, canon) ? this._data[canon] : null;
  }
}

function round1(x) { return Math.round(x * 10) / 10; }
function round2(x) { return Math.round(x * 100) / 100; }

/** Scale a barcode record's per-100g macros to N of the PRODUCT'S OWN
 *  serving size. Falls back to 100 g only when the product publishes no
 *  serving size at all, and says so explicitly via
 *  `serving_grams_known: false` — an assumed default must never be
 *  presented as the product's real serving. */
function resolveServing(record, servings = 1.0) {
  if (!record) return null;
  const servingGrams = record.serving_grams;
  const known = servingGrams !== null && servingGrams !== undefined;
  const gramsEach = known ? servingGrams : DEFAULT_SERVING_G;
  const totalGrams = round1(gramsEach * servings);
  const factor = totalGrams / 100.0;

  const totals = {};
  for (const f of SCALED_FIELDS) {
    const v = record[f];
    totals[f] = (v === null || v === undefined) ? null : round2(v * factor);
  }

  return {
    servings,
    serving_grams_known: known,
    serving_grams_each: gramsEach,
    grams: totalGrams,
    totals
  };
}

/** The barcode-scan auto-log flow end to end: scanned code -> product ->
 *  totals for N of THAT product's own servings. Returns null on a miss;
 *  the caller (Kaushal's endpoint) owns the not-found UX (manual search /
 *  manual entry) — this layer never guesses a substitute food for an
 *  unrecognised code.
 *  @param {string} code
 *  @param {number} servings
 *  @param {BarcodeIndex} index */
function autoLogFromBarcode(code, servings, index) {
  const n = (servings === undefined || servings === null) ? 1.0 : servings;
  const record = index.lookup(code);
  if (!record) return null;
  const resolved = resolveServing(record, n);
  const notes = [];
  if (!resolved.serving_grams_known) {
    notes.push('Product does not publish a serving size; defaulted to 100 g. ' +
      'Confirm the actual amount before logging.');
  }
  return {
    schema_version: 'food-v1',
    tier: 'barcode',
    match_kind: 'barcode_exact',
    food: record,
    quantity: {
      servings: resolved.servings,
      grams: resolved.grams,
      serving_grams_each: resolved.serving_grams_each,
      serving_grams_known: resolved.serving_grams_known
    },
    totals: resolved.totals,
    confidence: 'high',   // identity match is exact by construction
    notes
  };
}

module.exports = {
  BarcodeIndex, cleanCode, canonicalEan13, resolveServing, autoLogFromBarcode,
  DEFAULT_SERVING_G, SCALED_FIELDS
};
