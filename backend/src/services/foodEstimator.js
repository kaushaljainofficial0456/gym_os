// ============================================================
// FOOD LOGGING — backed by skos-food-v1.
//
// CANONICAL CORE (Phase 1): this file is the IMPLEMENTATION body of the food
// engine. New callers should import from `services/food/index.js` (the
// canonical surface: `estimateMeal` / `resolveFood` / `priceFood` + these
// primitives re-exported + the staged pipeline). The route layer
// (nutrition.js, me.js, intelligence.js) already does. `barcodeLookup.js` and
// `intelligence/foodAI.js` still import here directly and are folded in by a
// later phase — they use the same functions, there is only one FoodSearch.
//
// WHAT THIS REPLACED, AND WHY IT MATTERED:
// This file was a 23-item hardcoded table with hand-typed macros and a
// regex matcher. Its own header called it an MVP placeholder. It was also
// measurably wrong: paneer was 265 kcal against a lab-measured 305, and
// anything outside those 23 foods silently contributed NOTHING to the
// total -- "2 rotis and rajma chawal" returned only the roti, so the user
// saw a confident number that had quietly dropped half their meal.
//
// It now resolves against the skos-food-v1 database (21,353 foods: IFCT
// 2017 lab values, USDA, INDB Indian dishes, Canadian NF, Open Food Facts)
// through the same ranking/confidence code the Python model uses.
//
// ── THE PIECE THAT DID NOT EXIST BEFORE ───────────────────────────────
// skos-food-v1 resolves ONE food per query (tier 1) or one dish from its
// ingredients (tier 2). This endpoint is handed a free-text SENTENCE:
// "2 rotis, dal and a glass of milk". Splitting that sentence into
// quantified items is glue that lives HERE, not in the model, and it is
// the part to be suspicious of -- the model's accuracy is measured, this
// parser's is not. Anything it fails to resolve is reported in
// `unresolved` rather than dropped, which is the behaviour the old
// version got wrong.
//
// ── MODULE FORMAT ─────────────────────────────────────────────────────
// The backend is ESM; the model's reference implementation is CommonJS
// (it is shared with plain-node test harnesses). createRequire bridges
// them rather than converting the model file, which must stay
// byte-identical to the version the Python parity tests run against.
//
// ── COST ──────────────────────────────────────────────────────────────
// The database is 14.6 MB of JSON and the search index is built once from
// it. That is done LAZILY on first use and cached for process lifetime --
// per-request construction would add ~400 ms and a full re-parse to every
// call. First call pays; the rest do not.
// ============================================================
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { round1 } from '../utils/time.js';
import {
  ALL_STAPLES, matchStaples, stapleRow, stapleByKey, stapleUnit,
  stapleUnitByPortionKey, unitGroup, leadingUnit,
} from './food/staples.js';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ML = path.resolve(HERE, '..', '..', '..', 'ml');
const PROC = path.join(ML, 'data', 'processed');

const {
  FoodSearch, toGrams, scaleNutrition, portionToGrams, canonicalPortion,
  listPortions, adjustOil, OIL_LEVELS, normalize, SOURCE_RANK, nameContainsQuery,
  COUNT_PORTIONS,
} = require(path.join(ML, 'models', 'skos-food-v1', 'foodEstimate.reference.js'));

/**
 * Is this unit word a FOOD in its own right ("roti", "egg", "idli"), as
 * opposed to a generic container ("piece", "slice")?
 *
 * The catalogue already draws exactly this line: a countable entry that
 * publishes its own per-piece `grams` is a specific food, while `piece` and
 * `slice` carry none because they describe a shape, not a thing. Read from
 * the catalogue rather than restated as a second hand-maintained list, so a
 * food added there is automatically understood here.
 */
function isCountableFood(unit) {
  const p = COUNT_PORTIONS[unit];
  return !!(p && Number(p.grams) > 0);
}

// Re-exported for food/pipeline.js (Phase 1 canonical core). The `normalize`
// stage and the source-preference ordering are the SAME primitives the one
// FoodSearch uses — surfaced here so the pipeline never grows a second copy.
// Pure re-exports; no behaviour change.
export { normalize, SOURCE_RANK };

// Re-exported for food/engine.js's Phase-2 quarantine rescue: sizing a
// rescued item's portion must use the SAME grams-precedence
// (explicit mass → portion catalogue → the row's own serving → 100 g) the
// live path uses, not a second copy. `resolveGrams` is defined below; the
// re-export is hoisted here for visibility. Pure re-export; no behaviour
// change to the estimate path.
export { resolveGrams };

const {
  BarcodeIndex, autoLogFromBarcode, cleanCode, canonicalEan13, resolveServing,
} = require(path.join(ML, 'models', 'skos-food-v1', 'barcodeLookup.reference.js'));

const { CompositionalCalculator } = require(path.join(ML, 'models', 'skos-food-v1', 'compositional.reference.js'));
const { FallbackKnnIndex } = require(path.join(ML, 'models', 'skos-food-v1', 'fallbackKnn.reference.js'));

// Re-exported for barcodeLookup.js (live/DB-cache fallback layered on top of
// this local snapshot): same code-cleaning and per-100g-scaling primitives
// the static index uses, so an external-API or DB-cached hit is scaled
// identically to a local-snapshot hit rather than duplicating that math.
export { cleanCode, canonicalEan13, resolveServing };
// Re-exported for foodAI.js (Tier 4): resolving an AI-proposed component
// ("rice", 350g) against a REAL matched database row uses the exact same
// per-100g scaling math every other tier uses, so an AI-grounded component
// total and a Tier-1 search result are computed identically, not by two
// different formulas that could quietly disagree.
export { scaleNutrition };

/* ------------------------------------------------------------------ */
/*  Lazy singletons                                                    */
/* ------------------------------------------------------------------ */

let _search = null;
let _barcodes = null;
let _loadError = null;
let _compositional = null;
let _knn = null;
let _knnLoadError = null;

function readJSON(file) {
  return JSON.parse(fs.readFileSync(path.join(PROC, file), 'utf8'));
}

/**
 * Returns the search index, or null if the model artifacts are missing.
 *
 * Returning null rather than throwing is deliberate: a deployment without
 * the ml/ directory should degrade to "cannot estimate", not 500 on every
 * nutrition request. The caller surfaces that as a clear message.
 */
export function getFoodSearch() {
  if (_search || _loadError) return _search;
  try {
    const db = readJSON('unified_food_db.json');
    let aliases = {};
    try {
      aliases = readJSON('food_aliases.json').aliases || {};
    } catch {
      // Aliases are an enhancement (regional dish names), not a
      // requirement. Search still works without them.
    }
    _search = withStaples(new FoodSearch(db, aliases));
  } catch (err) {
    _loadError = err;
    _search = null;
  }
  return _search;
}

/**
 * The index, with the hand-verified staples (services/food/staples.js)
 * consulted FIRST.
 *
 * Search, the meal parser and the resolve route all reach foods through
 * `search.search()`, so this one wrapper is the whole integration: a staple
 * is shaped like an index row and every downstream step -- scaling, the
 * parser's grams, the picker's portions -- handles it without a second
 * path. Everything the staples do not cover falls through to the index
 * exactly as before, which keeps the calibrated ranker and the food
 * benchmark untouched.
 *
 * `staplePrefix: false` turns off type-ahead prefix matching; the meal
 * parser passes it, because it hands over a complete food name and a
 * prefix guess there ("cha" -> chai) would be inventing what was eaten.
 */
function withStaples(inner) {
  const rowsById = new Map(inner.foods.map((f) => [f.source_id, f]));
  const byKey = new Map();          // staple key -> its row
  const bySourceId = new Map();     // row source_id -> staple key
  for (const st of ALL_STAPLES) {
    const row = stapleRow(st, rowsById);
    if (!row) continue;
    byKey.set(st.key, row);
    bySourceId.set(row.source_id, st.key);
  }
  // The index row a staple points at must keep its staple UNITS whichever way
  // it is reached -- by the everyday word ("roti") or by its own name
  // ("Chapati/Roti", which is what the resolve route searches with). Without
  // this a portion chosen as "1 roti" could not be resolved for the same food.
  // Only the units travel: the index's own confidence and match kind stay,
  // because reaching "Rice, cooked, NFS" from "jollof rice" is a weak match
  // and must still say so.
  const decorate = (f) => {
    const key = bySourceId.get(f.source_id);
    return key ? { ...f, staple_key: key, staple_name: byKey.get(key).staple_name } : f;
  };
  const RANK = { high: 0, medium: 1, low: 2, unreliable: 3 };
  const lower = (a, b) => ((RANK[a] ?? 3) >= (RANK[b] ?? 3) ? a : b);

  const wrapped = Object.create(inner);
  wrapped.search = function search(query, opts = {}) {
    const limit = opts.limit ?? 8;
    // A staple's own id asked for directly (the resolve route may pass one).
    const direct = bySourceId.has(String(query)) ? byKey.get(bySourceId.get(String(query))) : null;
    const hits = matchStaples(query, { limit: 3, allowPrefix: opts.staplePrefix !== false });
    const stapleIds = new Set(hits.map((h) => byKey.get(h.staple.key)?.source_id).filter(Boolean));
    // The index's own answer for the same query, when there is room for it.
    // Where it reached the SAME row the staple points at, its match kind is
    // kept: "roti" is still an alias_exact hit on "Chapati/Roti", the staple
    // merely agrees. `staple_match` records that a staple chose the row.
    const indexHits = (direct ? 1 : 0) + hits.length >= limit ? [] : inner.search(query, opts);
    const indexKind = new Map(indexHits.filter((f) => stapleIds.has(f.source_id)).map((f) => [f.source_id, f.match_kind]));
    const staples = [
      ...(direct ? [{ ...direct, _score: 20000, _matchKind: 'staple_id', match_kind: 'staple_id', staple_match: 'id' }] : []),
      ...hits.filter((h) => byKey.has(h.staple.key)).map((h) => {
        const row = byKey.get(h.staple.key);
        return {
          ...row,
          // Above every index score: a staple is always the default answer
          // when it matches, and never "ambiguous" with an index row.
          _score: 10000 + h.score,
          _matchKind: indexKind.get(row.source_id) || `staple_${h.kind}`,
          match_kind: indexKind.get(row.source_id) || `staple_${h.kind}`,
          staple_match: h.kind,
          // An umbrella word ("sabzi", "biryani") or a partial match is the
          // right staple at medium certainty: a variant is just as likely.
          confidence: h.vague ? lower(row.confidence, 'medium') : row.confidence,
        };
      }),
    ];
    const seen = new Set(staples.map((r) => r.source_id));
    if (staples.length >= limit) return staples.slice(0, limit);
    const rest = indexHits.filter((f) => !seen.has(f.source_id)).map(decorate);
    return [...staples, ...rest].slice(0, limit);
  };
  /** A staple's row by key (for its curated alternatives). */
  wrapped.stapleRowByKey = (key) => byKey.get(key) || null;
  // Lookups by id (the V2/V3 engines, the eval adapter) must find an inline
  // staple ("staple:chai") as well as the index's own rows.
  const ids = new Map(inner.bySourceId);
  for (const row of byKey.values()) if (!ids.has(row.source_id)) ids.set(row.source_id, row);
  wrapped.bySourceId = ids;
  return wrapped;
}

/** True when this row was chosen BY a staple match (not merely decorated). */
const isStapleHit = (food) => food?.staple_match != null;

/**
 * The staple's curated "did you mean" list, in the same shape as
 * ambiguousAlternatives and under the same rule: offered only when the
 * alternative would change the answer by AMBIGUITY_KCAL_SPREAD or more.
 * "200ml milk" offers buffalo and full-cream milk; "200g paneer" offers
 * nothing, because nothing else is what "paneer" means.
 */
function stapleAlternatives(food, search) {
  const st = stapleByKey(food.staple_key);
  const topKcal = Number(food.energy_kcal);
  if (!st || !st.alts || !(topKcal > 0) || !search.stapleRowByKey) return [];
  return st.alts
    .map((k) => search.stapleRowByKey(k))
    .filter((r) => r && r.source_id !== food.source_id)
    .filter((r) => Math.abs(Number(r.energy_kcal) - topKcal) / topKcal >= AMBIGUITY_KCAL_SPREAD)
    .slice(0, 3)
    .map((r) => ({
      source_id: r.source_id,
      name: r.staple_name || r.food_name,
      brand: r.brand || null,
      energy_kcal_per_100g: r.energy_kcal ?? null,
      protein_g_per_100g: r.protein_g ?? null,
      source: r.source,
      confidence: r.confidence,
      staple_key: r.staple_key,
    }));
}

export function getBarcodeIndex() {
  if (_barcodes) return _barcodes;
  try {
    _barcodes = new BarcodeIndex(readJSON('off_barcode_index.json'));
  } catch {
    _barcodes = new BarcodeIndex({});   // empty index -> every scan is a clean miss
  }
  return _barcodes;
}

export function modelAvailable() {
  return getFoodSearch() !== null;
}

/**
 * Tier 2 — compositional calculator (ml/models/skos-food-v1/compositional.reference.js).
 * Prices a dish from a user-supplied ingredient list against the SAME
 * measured database and search engine Tier 1 uses. Returns null if the
 * search index itself is unavailable (same degrade-gracefully contract as
 * every other lazy singleton here).
 */
export function getCompositionalCalculator() {
  if (_compositional) return _compositional;
  const search = getFoodSearch();
  if (!search) return null;
  _compositional = new CompositionalCalculator(search);
  return _compositional;
}

/**
 * Tier 3 — similarity-weighted kNN fallback (ml/models/skos-food-v1/
 * fallbackKnn.reference.js), reading the static index exported by
 * ml/src/inference/export_fallback_v4_index.py. Returns null if the
 * artifact hasn't been generated for this deployment -- a missing Tier 3
 * index must degrade to "not available", never throw and never fall back
 * to inventing a match.
 */
export function getKnnFallback() {
  if (_knn || _knnLoadError) return _knn;
  try {
    const payload = JSON.parse(
      fs.readFileSync(path.join(ML, 'models', 'skos-food-v1', 'fallback_v4_index.json'), 'utf8'));
    _knn = new FallbackKnnIndex(payload);
  } catch (err) {
    _knnLoadError = err;
    _knn = null;
  }
  return _knn;
}

/* ------------------------------------------------------------------ */
/*  Free-text -> quantified items                                      */
/* ------------------------------------------------------------------ */

/** Number words users actually type. Kept small on purpose: "a dozen
 *  eggs" is worth handling, invented ranges are not. */
const WORD_NUMBERS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, half: 0.5, dozen: 12,
  couple: 2, quarter: 0.25,
};

/** Fractions typed as glyphs or as "1/2". */
const GLYPH_FRACTIONS = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3 };

/**
 * Units we recognise. Mass/volume go through the model's own toGrams;
 * household portions go through its portion catalogue, which is
 * food-specific (a bowl of dal is 250 g, a bowl of spinach 62 g).
 */
const MASS_VOLUME = /^(g|gm|gms|gram|grams|kg|kgs|kilo|kilos|kilogram|kilograms|ml|millilitre|milliliter|l|litre|liter|oz|ounce|ounces|lb|lbs|pound|pounds|tsp|teaspoon|teaspoons|tbsp|tablespoon|tablespoons|cup|cups)$/i;

/** Filler words that are never part of a food name. */
const NOISE = new Set([
  'of', 'with', 'and', 'plus', 'some', 'my', 'the', 'a', 'an', 'had', 'ate',
  'eaten', 'for', 'breakfast', 'lunch', 'dinner', 'snack', 'today', 'i',
  'also', 'then', 'about', 'approx', 'approximately', 'around',
]);

/**
 * Split a sentence into item fragments.
 *
 * Splits on commas, newlines, "+", and the word "and". "and" is genuinely
 * ambiguous -- "rajma and rice" is two items but "salt and pepper" is a
 * seasoning pair -- and this deliberately treats it as a separator,
 * because in a food LOG the two-item reading is overwhelmingly the common
 * one and over-splitting merely produces an unresolved fragment the user
 * can see, whereas under-splitting silently loses food from the total.
 */
export function splitItems(text) {
  return String(text || '')
    .replace(/\band\b/gi, ',')
    .split(/[,\n;+&]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * "A with B" -> ["A", "B"], but ONLY when both halves are independently real
 * foods.
 *
 * `with` is treated as a noise WORD rather than a separator (unlike "and"),
 * which is right for "rice with ghee" as a dish name and wrong for the far
 * more common "<food> with <food>" log entry. The consequence was a SILENT
 * loss -- the fragment resolved, so nothing was reported unresolved, and the
 * meal total was simply missing a food:
 *   "150g grilled chicken with 100g rice"  -> the rice vanished
 *   "one bowl chicken curry with rice"     -> the rice vanished
 *   "coffee with milk and 2 biscuits"      -> the milk vanished
 *   "a plate of noodles with chicken"      -> the chicken vanished
 * Eight of the benchmark's multi-item cases lost food this way, and silent
 * drops are the one failure class the release gate treats as non-negotiable.
 *
 * The guard against over-splitting a genuine compound dish is that BOTH
 * halves must name something the catalogue actually knows: "toast with
 * butter" splits because toast and butter are both real foods, while a
 * fragment whose second half resolves to nothing is left exactly as it was.
 * Returns null when the fragment should not be split.
 */
function splitWithConjunction(fragment, search) {
  const raw = String(fragment || '');
  if (!/\bwith\b/i.test(raw)) return null;
  const idx = raw.search(/\bwith\b/i);
  const before = raw.slice(0, idx).trim();
  const after = raw.slice(idx).replace(/^with\b/i, '').trim();
  if (!before || !after) return null;

  /* THE WHOLE PHRASE MAY ITSELF BE A CATALOGUED DISH. "Poha with curd (Poha
     aur dahi)" and "Curd with potatoes (Dahi aloo)" are single measured INDB
     rows, and splitting them replaces one measured dish with two guessed
     components -- which is how V2's composite kcal-in-range rate fell 3 pp.
     An `exact_name`/`alias_exact` hit on the FULL fragment is the catalogue
     stating that this exact dish exists under this exact name, which is much
     stronger evidence than the incidental token overlap behind "toast with
     butter" -> "Fast foods, breakfast, french toast with butter" (all_tokens)
     or "chicken with rice" -> "Chicken with rice and vegetable, diet frozen"
     (name_prefix). Only the strong form blocks the split. */
  // Searched as "<before> with <after>", NOT through parseFragment, because
  // parseFragment strips `with` as a noise word -- it would look up "poha
  // curd", which is not the name of anything, and the dish would never be
  // recognised.
  const wholePhrase = `${before} with ${after}`;
  const whole = search.search(wholePhrase, { limit: 1 })[0];
  if (whole && (whole.match_kind === 'exact_name' || whole.match_kind === 'alias_exact'
                || whole.staple_match === 'exact')) return null;

  // Each half must parse to a named food AND that name must retrieve
  // something. Anything less and the split would trade one honest answer for
  // a guess plus a miss.
  const halves = [before, after];
  for (const half of halves) {
    const p = parseFragment(half);
    if (!p || !p.name) return null;
    const hits = search.search(p.name, { limit: 1 });
    if (!hits.length || hits[0].trustworthy === false) return null;
  }
  return halves;
}

/** Pull a leading quantity off a fragment: "2.5 bowls dal" -> 2.5. */
function parseQuantity(tokens) {
  if (!tokens.length) return { qty: null, rest: tokens };
  const first = tokens[0];

  if (GLYPH_FRACTIONS[first] !== undefined) {
    return { qty: GLYPH_FRACTIONS[first], rest: tokens.slice(1) };
  }
  // "1/2"
  const frac = first.match(/^(\d+)\/(\d+)$/);
  if (frac) {
    const d = Number(frac[2]);
    if (d > 0) return { qty: Number(frac[1]) / d, rest: tokens.slice(1) };
  }
  // "150g" glued together
  const glued = first.match(/^(\d+(?:\.\d+)?)([a-z]+)$/i);
  if (glued) {
    return { qty: Number(glued[1]), rest: [glued[2], ...tokens.slice(1)] };
  }
  const num = Number(first);
  if (Number.isFinite(num) && first !== '') {
    return { qty: num, rest: tokens.slice(1) };
  }
  if (WORD_NUMBERS[first] !== undefined) {
    return { qty: WORD_NUMBERS[first], rest: tokens.slice(1) };
  }
  return { qty: null, rest: tokens };
}

/**
 * Parse one fragment into { qty, unit, name }.
 * "2 bowls of dal"  -> { qty: 2, unit: 'bowl', name: 'dal' }
 * "150g paneer"     -> { qty: 150, unit: 'g',  name: 'paneer' }
 * "rajma chawal"    -> { qty: null, unit: null, name: 'rajma chawal' }
 */
export function parseFragment(fragment) {
  // A pack size in brackets -- "1 packet potato chips (52g)" -- is the
  // label's weight for ONE of what was counted. Read before punctuation is
  // stripped below; the bare "52g" is then dropped from the name as usual.
  const pack = String(fragment || '').match(/\(\s*(\d+(?:\.\d+)?)\s*(?:g|gm|gms|gram|grams|ml)\s*\)/i);
  const packGrams = pack ? Number(pack[1]) : null;
  const cleaned = String(fragment || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s./½¼¾⅓⅔-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;

  let tokens = cleaned.split(' ');

  /* LEADING NARRATION BLOCKS THE QUANTITY PARSER.
     parseQuantity only ever inspects tokens[0], so a fragment that opens
     with narration ("i ate 200g curd", "had 2 rotis") found no quantity at
     all. The damage was not just a missing amount: the number token stayed
     in the food NAME (NOISE filtering below drops "i"/"ate" but not
     "200g"), so the search ran on "200g curd" and token-matched PRODUCTS
     WITH NUMBERS IN THEIR NAMES. Measured, before this fix:
       "I ate 200g curd" -> Parle Hide &seek 200g(30)   474 kcal
       "had 2 rotis"     -> 2-Minute noodles            384 kcal
       "ate 100g rice"   -> Britannia bourbon 100g      494 kcal
     -- each also silently sized at the assumed 100 g. Dropping leading
     noise first makes "i ate 200g curd" parse identically to "200g curd".

     `a`/`an` are in NOISE *and* in WORD_NUMBERS ("a banana" = 1 banana), so
     they are deliberately kept for parseQuantity rather than stripped. The
     length guard keeps a fragment that is nothing but noise intact, so it
     still reports as unresolved instead of becoming empty. */
  while (tokens.length > 1 && NOISE.has(tokens[0]) && WORD_NUMBERS[tokens[0]] === undefined) {
    tokens = tokens.slice(1);
  }

  const { qty, rest } = parseQuantity(tokens);
  tokens = rest;
  // "half a cup of almonds", "quarter of a plate": filler between the amount
  // and its unit. Left in place, the unit check below saw "a" and the cup
  // was lost.
  if (qty != null) {
    while (tokens.length > 2 && (tokens[0] === 'a' || tokens[0] === 'an' || tokens[0] === 'of')) {
      tokens = tokens.slice(1);
    }
  }
  // What was said, before any word is taken as a unit -- see the
  // whole-dish check below the unit step.
  const spoken = tokens.filter((t) => !NOISE.has(t)).join(' ');

  let unit = null;
  if (tokens.length) {
    /* Singularise so "bowls"/"rotis" hit the same catalogue entry.
       Candidate forms, most literal first. A single `/(?:es|s)$/` rule was
       wrong for -es plurals: the alternation matches "es" before it can match
       "s", so "pieces" became "piec" and "apples" became "appl". Neither
       matched any unit, so the plural stayed in the FOOD NAME and corrupted
       the search -- "2 pieces paneer" looked up "pieces paneer" and returned
       "Snacks, fruit leather, pieces" (12 g, 43 kcal) instead of paneer. */
    const head = tokens[0];
    const forms = [head, head.replace(/s$/, ''), head.replace(/es$/, '')];
    const mass = forms.find((f) => MASS_VOLUME.test(f));
    if (mass) {
      unit = mass;
      tokens = tokens.slice(1);
    } else {
      const portion = forms.map((f) => canonicalPortion(f)).find(Boolean);
      if (portion) {
        unit = portion;
        tokens = tokens.slice(1);
      }
    }
  }

  /* A MEASUREMENT IS NOT A FOOD NAME. parseQuantity only consumes a LEADING
     quantity, so one written anywhere else ("xyyzqq nonfoodterm 500g",
     "1 packet potato chips (52g)") stayed in the name and became a search
     term. Packaged products carry their pack size in their titles, so those
     tokens match them and nothing else -- "xyyzqq nonfoodterm 500g" returned
     "BRITANNIA bourbon 500g" at 494 kcal, a confident number for a food that
     does not exist. Only number+unit tokens are dropped, never bare numerals,
     because those can be part of a real name ("chicken 65"). */
  let name = tokens
    .filter((t) => !NOISE.has(t))
    .filter((t) => !/^\d+(?:\.\d+)?(?:g|gm|gms|kg|ml|l|oz|lb|lbs)$/.test(t))
    .join(' ').trim();

  // COUNTABLE FOODS ARE THEIR OWN UNIT. "2 rotis", "3 eggs", "2 idli" --
  // roti/egg/idli are entries in the portion catalogue, so the unit-parsing
  // step above consumes the only word in the fragment and leaves no food
  // name. The old behaviour reported these as unresolved, which is absurd:
  // "2 rotis" is one of the most common things an Indian user will type,
  // and it was silently contributing nothing to the total.
  //
  // When stripping the unit leaves nothing behind, the unit IS the food.
  // Keep both: the name resolves the food, the unit gives the per-piece
  // weight for it.
  if (!name && unit) name = unit;

  /* TWO FOODS IN ONE FRAGMENT: "two rotis with dal".
     `with` is a NOISE word, not a separator (unlike "and"), so this arrives
     as a single fragment. The unit-parsing step above then consumed "rotis"
     as the UNIT and left "dal" as the NAME, producing "2 roti-weights of
     dal" -- which both prices the dal by a roti's weight AND loses the rotis
     entirely. It was a SILENT loss: the fragment resolved, so nothing was
     reported unresolved, and the meal total was simply missing a food.

     When the unit is itself a food and a DIFFERENT food name remains, the
     fragment names both. The count belongs to the food it was counting --
     "two" counts rotis, not dal -- so the quantity stays with the unit-food
     and the trailing name is emitted as a companion with no quantity of its
     own, which lets it fall through to its own measured serving. */
  /* ...UNLESS THE TWO WORDS ARE ONE DISH. "egg curry" and "vada pav" begin
     with a countable food, so the step above read them as "egg" + "curry"
     and "vada" + "pav" -- a boiled egg plus curry LEAVES, and a medu vada
     plus a 580 g plate of pav bhaji. When the whole phrase is a curated
     everyday dish, it is that dish; a leading number counts servings of it. */
  if (name && unit && name !== unit && isCountableFood(unit) && isStapleName(spoken)) {
    return { qty, unit: null, name: spoken, raw: fragment };
  }
  if (name && unit && name !== unit && isCountableFood(unit)) {
    return {
      qty, unit, name: unit, raw: fragment,
      companion: { qty: null, unit: null, name, raw: fragment },
    };
  }

  // A fragment that names no food even after that ("2 bowls" alone) is
  // genuinely ambiguous. Report it rather than guessing.
  if (!name) return { qty, unit, name: null, raw: fragment };
  return packGrams ? { qty, unit, name, raw: fragment, packGrams } : { qty, unit, name, raw: fragment };
}

/* ------------------------------------------------------------------ */
/*  Grams resolution                                                   */
/* ------------------------------------------------------------------ */

const DEFAULT_SERVING_G = 100;

/**
 * Decide how many grams an item is, in the priority the contract sets out:
 *   1. an explicit mass/volume the user typed
 *   2. a household portion, sized FOR THIS FOOD by the model's catalogue
 *   3. the food's own measured serving weight, x quantity
 *   4. 100 g, flagged as an assumption
 */
/**
 * Grams for `n` of a staple unit. Catalogue units (katori, bowl, roti,
 * idli...) go through portionToGrams, so a katori here is the same katori
 * as everywhere else and a dish's own measured INDB serving still wins
 * where the catalogue lets it; fixed units (a 150 ml tea cup, a 32 g
 * scoop) are what the staple says.
 */
function stapleUnitGrams(food, unit, n = 1) {
  return stapleUnitPortion(food, unit, n)?.grams ?? null;
}

/** { grams, basis } for `n` of a staple unit -- the catalogue's own basis
 *  (count / volume / measured_serving) for catalogue units, so a katori of
 *  dal is described exactly as it is everywhere else; 'staple_unit' for the
 *  fixed weights the staples module sets. */
function stapleUnitPortion(food, unit, n = 1) {
  if (!unit) return null;
  if (unit.g) return { grams: round1(n * unit.g), basis: 'staple_unit' };
  const p = portionToGrams(unit.key, n, {
    foodName: food.food_name, cookingState: food.cooking_state, foodServingGrams: food.serving_grams,
  });
  return p && p.grams > 0 ? { grams: p.grams, basis: p.basis } : null;
}

/** toGrams knows one spelling of some units ("tablespoon", not
 *  "tablespoons"), and "4 tablespoons rice" fell through to an assumed
 *  400 g. Try the singular forms too. */
function massVolumeGrams(qty, unit, foodName) {
  for (const u of new Set([unit, unit.replace(/es$/i, ''), unit.replace(/s$/i, '')])) {
    const { grams } = toGrams(qty, u, foodName);
    if (grams > 0) return grams;
  }
  return null;
}

const isStaple = (food) => food && food.staple_key != null;

function resolveGrams(parsedIn, food) {
  // "half a cup of almonds": filler between the amount and the unit left the
  // unit at the front of the name. The name still matches (staples strip it),
  // but the amount is half a CUP -- not half an almond (0.6 g).
  const lead = !parsedIn.unit && parsedIn.name ? leadingUnit(parsedIn.name) : null;
  const parsed = lead ? { ...parsedIn, unit: lead } : parsedIn;
  const qty = parsed.qty == null ? 1 : parsed.qty;

  // A pack weight typed with the food -- "1 packet potato chips (52g)" -- is
  // a measurement of that pack, from its label. It beats every estimate.
  if (parsed.packGrams > 0 && !(parsed.unit && MASS_VOLUME.test(parsed.unit))) {
    return { grams: round1(parsed.packGrams * qty), basis: 'measured', assumed: false,
             description: `${qty} x ${parsed.packGrams} g pack` };
  }

  // A hand-verified staple knows its own units ("2 roti" = 80 g, "a cup
  // of chai" = 150 ml, "10 almonds" = 12 g). Checked BEFORE the mass/volume
  // path because "cup", "tbsp" and "tsp" are volume words too: that path
  // read "a cup of chai" as a 240 ml US cup (247 g) when an Indian tea cup
  // is 150 ml. Real mass and volume units (g, ml, kg) are not staple units,
  // so they still fall through to measurement below.
  if (isStaple(food)) {
    const st = stapleByKey(food.staple_key);
    const unit = st && stapleUnit(st, parsed.unit, { hadQuantity: parsed.qty != null });
    const p = unit && stapleUnitPortion(food, unit, qty);
    if (p) {
      return { grams: p.grams, basis: p.basis, assumed: !parsed.unit && parsed.qty == null,
               description: `${qty} x ${unit.label}`, unit_key: unit.key };
    }
  }

  if (parsed.unit && MASS_VOLUME.test(parsed.unit)) {
    // toGrams returns { grams, method, note } -- NOT a number. Treating the
    // returned object as one meant `g > 0` was always false, so every
    // explicit mass silently fell through to the 100 g assumption and got
    // multiplied by the amount: "150g paneer" logged 15,000 g / 45,810 kcal.
    const grams = massVolumeGrams(qty, parsed.unit, food.food_name);
    if (grams > 0) {
      return { grams: round1(grams), basis: 'measured', assumed: false,
               description: `${qty} ${parsed.unit}` };
    }
  }

  if (parsed.unit) {
    // Param name must match portionToGrams's own destructuring
    // (`foodServingGrams`, not `servingGrams`) -- the mismatch silently
    // disabled the "food's own measured serving beats the generic figure"
    // override for bowl/katori/plate/piece/medium_bowl portions: "1 bowl
    // dal" fell through to a generic 250ml x density estimate even when
    // the matched food publishes its own measured serving_grams. Found via
    // the SK OS Indian Nutrition Engine upgrade's Phase 16 ground-truth
    // test suite (indianFoodAuthoritative.test.js), not previously covered
    // by any existing test.
    const p = portionToGrams(parsed.unit, qty, {
      foodName: food.food_name,
      cookingState: food.cooking_state,
      foodServingGrams: food.serving_grams,
    });
    if (p && p.grams > 0) {
      return { grams: p.grams, basis: p.basis, assumed: false,
               description: `${qty} x ${parsed.unit}` };
    }
  }

  if (food.serving_grams > 0) {
    return {
      grams: round1(food.serving_grams * qty),
      basis: 'food_serving',
      assumed: false,
      description: food.serving_description
        ? `${qty} x ${food.serving_description}`
        : `${qty} serving`,
    };
  }

  return {
    grams: DEFAULT_SERVING_G * qty,
    basis: 'assumed_100g',
    assumed: true,
    description: `${qty} x 100 g (assumed)`,
  };
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Ambiguity — several equally good answers that disagree on nutrition */
/* ------------------------------------------------------------------ */

/** Within this fraction of the top score, a candidate is "equally good". */
const AMBIGUITY_SCORE_BAND = 0.06;
/** Below this relative energy spread the choice does not change the answer. */
const AMBIGUITY_KCAL_SPREAD = 0.25;

/**
 * Decide whether the top hit was a genuine winner or a coin-flip, and if it
 * was a coin-flip, say what it was flipping between.
 *
 * WHY: a query like "curd" matches five rows named exactly "Curd" whose
 * energy runs 43.5–77 kcal/100 g (a 77% spread) and which historically
 * scored IDENTICALLY, so which one the user's day was costed against came
 * down to their order in the source JSON. Ranking now picks a defensible
 * one deterministically, but "defensible" is not "certain": when the runners
 * up are just as good a lexical match AND would give a materially different
 * number, the honest thing is to say so rather than present one figure as
 * settled. Nothing is blocked and no flow changes -- the top hit is still
 * used, exactly as before -- this only ATTACHES the runners-up so the UI can
 * offer them (CONTRACT: report, never silently decide).
 *
 * Returns [] when the top hit wins clearly, or when the alternatives agree
 * closely enough on nutrition that choosing between them is not worth a
 * question.
 */
function ambiguousAlternatives(hits) {
  const top = hits[0];
  if (!top || hits.length < 2) return [];
  const topScore = typeof top._score === 'number' ? top._score : null;
  if (topScore === null || topScore <= 0) return [];
  const topKcal = Number(top.energy_kcal);
  if (!(topKcal > 0)) return [];

  const rivals = hits.slice(1).filter((h) => {
    if (h.trustworthy === false) return false;            // never offer a quarantined row
    if (typeof h._score !== 'number') return false;
    if ((topScore - h._score) / topScore > AMBIGUITY_SCORE_BAND) return false; // clearly beaten
    const kcal = Number(h.energy_kcal);
    if (!(kcal > 0)) return false;
    return Math.abs(kcal - topKcal) / topKcal >= AMBIGUITY_KCAL_SPREAD;        // would change the answer
  });

  return rivals.slice(0, 3).map((h) => ({
    source_id: h.source_id,
    name: h.food_name,
    brand: h.brand || null,
    energy_kcal_per_100g: h.energy_kcal ?? null,
    protein_g_per_100g: h.protein_g ?? null,
    source: h.source,
    confidence: h.confidence,
  }));
}

/**
 * Estimate a whole logged meal from free text.
 *
 * The response KEEPS the old envelope ({ text, items, total, estimate })
 * so the existing client keeps working unchanged, and adds the
 * contract fields (schema_version, tier, confidence, unresolved)
 * alongside. Per CONTRACT_skos-food-v1.md that is the migration shape.
 */
/**
 * THE definition of "what counts as one logged item" in a sentence:
 * splitItems, then "<food> with <food>" expanded once the catalogue confirms
 * both halves are real foods.
 *
 * Exported because every engine has to agree on it. When only V1 expanded,
 * V3 kept iterating the UNEXPANDED fragments, found no item tagged with the
 * whole "paneer bhurji with 2 rotis" (V1 had already filed them under each
 * half), and re-split it -- appending a second copy of both foods, for
 * 934 kcal instead of 467. Two engines disagreeing about where one item ends
 * is precisely the drift this file's single-implementation rule exists to
 * prevent.
 *
 * Kept out of splitItems itself, which is a pure string function used in
 * places where no search index exists.
 */
/** A complete food name that is one of the curated staples, word for word. */
function isStapleName(name) {
  const hit = name ? matchStaples(name, { limit: 1, allowPrefix: false })[0] : null;
  return hit?.kind === 'exact';
}

/* The second half of an Indian plate, said as one phrase: "rajma chawal",
   "dal roti", "sambar rice", "peanut butter toast". */
const PAIR_TAILS = {
  chawal: 'rice', chaawal: 'rice', chawel: 'rice', rice: 'rice', bhaat: 'rice', bhat: 'rice',
  roti: 'roti', rotis: 'roti', chapati: 'roti', chapatis: 'roti', phulka: 'roti', phulkas: 'roti',
  toast: 'toast',
};
const PAIR_WORDS = {
  rice: /\b(rice|chawal|chaawal|bhaat|bhat|annam|saadam)\b/i,
  roti: /\b(roti|chapati|chapatti|phulka)\b/i,
  toast: /\b(toast|bread)\b/i,
};

/**
 * "rajma chawal" -> ["rajma", "rice"]: a curry and what it is eaten with,
 * said as one phrase.
 *
 * With nothing to split on, the whole phrase went to search as one name and
 * matched whatever shared a word with it, always silently:
 *   "rajma chawal"  -> raw dried kidney beans, 299 kcal / 100 g
 *   "dal chawal"    -> 33 g of rice-dal porridge, 128 kcal for a plate
 *   "chole chawal"  -> the chole alone; the rice vanished
 *   "kadhi chawal"  -> curd rice
 *
 * Split only when BOTH halves are curated staples word for word, and never
 * when the whole phrase is itself a dish -- "curd rice", "jeera rice" and
 * anything the index knows by exactly that name stay whole, the same guard
 * splitWithConjunction uses.
 *
 * Amounts: a number with rice or toast counts servings of the plate ("2
 * rajma chawal" is two of each); with roti it counts the rotis, the way
 * "2 roti dal" already reads. A container ("1 plate ...") describes the
 * whole plate, so each half takes its own natural serving instead.
 */
function splitPairedDish(fragment, search) {
  const p0 = parseFragment(fragment);
  if (!p0?.name) return null;
  // "egg curry rice" arrives as a counted egg plus "curry rice"; the pair is
  // read from the whole phrase, and the egg curry is then whole again.
  const p = p0.companion
    ? { ...p0, unit: null, name: `${p0.name} ${p0.companion.name}` }
    : p0;
  const words = p.name.split(' ');
  if (words.length < 2) return null;
  const tail = PAIR_TAILS[words.at(-1)];
  const head = words.slice(0, -1).join(' ');
  if (!tail || !isStapleName(head) || !isStapleName(tail)) return null;
  if (isStapleName(p.name)) return null;
  // The index's word for the whole phrase counts only if that row really is
  // the pair. Its alias expansion reports "rajma chawal" as an alias_exact
  // hit on RAW DRIED rajma, and "sambar rice" as an exact hit on plain
  // sambar -- rows that never mention the rice at all.
  const whole = search.search(p.name, { limit: 1, staplePrefix: false })[0];
  if (whole && (whole.match_kind === 'exact_name' || whole.match_kind === 'alias_exact')
      && PAIR_WORDS[tail].test(String(whole.food_name || ''))) return null;
  const count = p.qty != null && (!p.unit || isCountableFood(p.unit)) ? `${p.qty} ` : '';
  if (tail === 'roti') return [head, `${count}${tail}`];
  return [`${count}${head}`, `${count}${tail}`];
}

export function expandFragments(text, search = getFoodSearch()) {
  const fragments = splitItems(text);
  if (!search) return fragments;
  return fragments
    .flatMap((f) => splitWithConjunction(f, search) || [f])
    .flatMap((f) => splitPairedDish(f, search) || [f]);
}

export function estimateFood(text) {
  const search = getFoodSearch();
  const fragments = expandFragments(text, search);

  if (!search) {
    return {
      text,
      items: [],
      total: { calories: 0, protein: 0, carbs: 0, fat: 0 },
      estimate: true,
      schema_version: 'food-v1',
      model_available: false,
      unresolved: fragments.map((f) => ({ fragment: f, reason: 'food model not available on this deployment' })),
      disclaimer: 'Food model unavailable — no estimate produced.',
    };
  }

  const items = [];
  const unresolved = [];
  const total = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  let worst = 'high';
  const RANK = { high: 0, medium: 1, low: 2, unreliable: 3 };

  for (const fragment of fragments) {
    const first = parseFragment(fragment);
    if (!first) {
      // `continue` here was a silent drop: a fragment that would not parse
      // vanished from BOTH items and unresolved, so the total quietly omitted
      // it. Nothing may leave this loop unaccounted for.
      unresolved.push({ fragment, reason: 'could not read this part' });
      continue;
    }
    // A fragment can name two foods ("two rotis with dal") -- see parseFragment.
    const parsedItems = first.companion ? [first, first.companion] : [first];

    for (const parsed of parsedItems) {
    if (!parsed.name) {
      unresolved.push({ fragment, reason: 'no food named in this part' });
      continue;
    }

    /* limit 4, not 1, to see whether the top hit was a CLEAR winner or one of
       several equally good answers. This costs nothing: FoodSearch already
       scores all 21,353 rows on every query and `limit` only slices the
       result, so nothing extra is computed and no second search runs. */
    const hits = search.search(parsed.name, { limit: 4, staplePrefix: false });
    if (!hits.length) {
      unresolved.push({ fragment, reason: `no match for "${parsed.name}"` });
      continue;
    }
    const food = hits[0];
    const alternatives = isStapleHit(food) ? stapleAlternatives(food, search) : ambiguousAlternatives(hits);

    // A row flagged unreliable must not contribute a NUMBER to a total the
    // user will trust -- see CONTRACT §5. It is reported, not silently
    // added and not silently dropped.
    if (food.trustworthy === false) {
      unresolved.push({
        fragment,
        matched: food.food_name,
        reason: food.data_quality_flag || 'matched food has a known data-quality problem',
      });
      continue;
    }

    const q = resolveGrams(parsed, food);
    const scaled = scaleNutrition(food, q.grams);
    if (!scaled) {
      unresolved.push({ fragment, matched: food.food_name, reason: 'could not resolve a quantity' });
      continue;
    }

    const t = scaled.totals;
    if (RANK[food.confidence] > RANK[worst]) worst = food.confidence;

    items.push({
      // Legacy fields the current client renders. A staple shows the name
      // the person used ("Milk (toned)"), not its measured row's database
      // title ("Milk, whole"), which would read as a different milk.
      name: isStapleHit(food) ? food.staple_name : food.food_name,
      source_name: food.food_name,
      staple_key: food.staple_key ?? null,
      unit_key: q.unit_key ?? null,
      unit: q.description,
      qty: parsed.qty == null ? 1 : parsed.qty,
      calories: Math.round(t.energy_kcal ?? 0),
      protein: t.protein_g,
      carbs: t.carb_g,
      fat: t.fat_g,
      // Contract fields.
      source_id: food.source_id,
      source: food.source,
      grams: scaled.grams,
      grams_basis: q.basis,
      grams_assumed: q.assumed,
      confidence: food.confidence,
      // Available on `food` since the trustworthy gate above already reads
      // it — just wasn't being copied through to the response. Same fields,
      // same meaning, as me.js's /foods/search route exposes for search
      // results from the same underlying engine.
      trustworthy: food.trustworthy !== false,
      match_kind: food.match_kind || null,
      cooking_state: food.cooking_state,
      matched_from: fragment,
      /* Runners-up that matched this fragment just as well but would give a
         materially different number (see ambiguousAlternatives). Empty for
         the overwhelming majority of items. The chosen food, the totals and
         every existing field are unchanged whether or not this is populated:
         it is strictly additional information for the UI to offer a
         "did you mean?" switch, never a change to what was logged. */
      ambiguous: alternatives.length > 0,
      alternatives,
      // null means NOT MEASURED. Passed through as null on purpose so the
      // UI can render "—" instead of a fabricated 0.
      fiber_g: t.fiber_g,
      sugar_g: t.sugar_g,
      sodium_mg: t.sodium_mg,
    });

    total.calories += t.energy_kcal ?? 0;
    total.protein += t.protein_g ?? 0;
    total.carbs += t.carb_g ?? 0;
    total.fat += t.fat_g ?? 0;
    }
  }

  return {
    text,
    items,
    total: {
      calories: Math.round(total.calories),
      protein: round1(total.protein),
      carbs: round1(total.carbs),
      fat: round1(total.fat),
    },
    estimate: true,
    schema_version: 'food-v1',
    tier: 1,
    model_version: 'skos-food-v1',
    confidence: items.length ? worst : null,
    unresolved,
    disclaimer: unresolved.length
      ? 'Some items could not be matched and are NOT included in the total.'
      : 'Matched against measured food-composition data. Portion sizes are estimates.',
  };
}

/**
 * Ranked food search for the picker UI. Returns FoodMatch shapes
 * (CONTRACT §3.1) with a `portions` array attached.
 *
 * TWO PASSES, DELIBERATELY:
 *
 * 1. The model's RANKED search. This is the calibrated one -- it decides
 *    which single food "tomato" most likely means, and its confidence
 *    labels are measured against held-out lab data.
 *
 * 2. A plain CONTAINS pass. Ranking alone is wrong for a type-ahead:
 *    querying "tomato" returned four raw tomato cultivars (green, orange,
 *    ripe, yellow) and nothing else, because those score highest. But
 *    someone typing "tomato" is often reaching for tomato soup, tomato
 *    ketchup or a tomato curry, and a suggestion list exists to show the
 *    BREADTH of what is available, not to insist on one answer.
 *
 * Ranked hits stay first so the best match is still the default. The
 * contains pass fills the rest, preferring names that START with the
 * query and then shorter names, since "Tomato soup" is a likelier target
 * than "Babyfood, dinner, macaroni and tomato and beef, junior".
 */
export function searchFoods(query, { limit = 8, withPortions = true } = {}) {
  const search = getFoodSearch();
  if (!search) return [];
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];

  /* Reserve room for the contains pass instead of letting the ranker fill
     every slot. Querying "tomato" used to return eight tomato CULTIVARS --
     green, orange, ripe, yellow, roma, pickled -- which is a taxonomy, not
     a useful suggestion list. Half the slots now go to the ranked best
     matches and half to other foods whose names contain the query, which
     is where tomato soup, ketchup and curries live. */
  const rankedKeep = Math.max(1, Math.ceil(limit / 2));
  const ranked = search.search(q, { limit }).slice(0, rankedKeep);
  const seen = new Set(ranked.map((f) => f.source_id));

  let extra = [];
  if (ranked.length < limit) {
    const norm = (x) => (x._norm || String(x.food_name || '').toLowerCase());
    extra = search.foods
      // Same word-boundary rule the ranked scorer uses -- `includes` alone put
      // seven cholesterol products ("Mayonnaise dressing, no cholesterol",
      // "Cheese, cheddar, imitation, low cholesterol", ...) into the picker for
      // the query "chole". Fixing this only in score() left the type-ahead,
      // which is what users actually look at, still showing them.
      .filter((f) => !seen.has(f.source_id) && nameContainsQuery(norm(f), q))
      .sort((a, b) => {
        const as = norm(a).startsWith(q) ? 0 : 1;
        const bs = norm(b).startsWith(q) ? 0 : 1;
        if (as !== bs) return as - bs;
        return norm(a).length - norm(b).length;
      })
      .slice(0, limit - ranked.length)
      .map((f) => ({
        ...f,
        // These did not go through the calibrated ranker, so they must not
        // borrow its confidence labels. `low` is the honest floor.
        //
        // BUT they must still carry the SAME trust / data-quality semantics
        // the ranked path (_searchExact) assigns — otherwise a row with a
        // `data_quality_flag` (frying-bath contamination etc.) reaches the
        // picker as a plain `confidence: 'low'` with no `trustworthy` field
        // and, because the UI only disables `trustworthy === false`, becomes
        // loggable. A caller must not be able to tell a candidate came via
        // the contains pass and thereby skip the trust check (CONTRACT
        // §3.2 / §5). This mirrors _searchExact's own mapping exactly; it
        // does not "fix" or reshape the row, only labels it honestly.
        confidence: f.data_quality_flag ? 'unreliable' : (f.confidence || 'low'),
        trustworthy: !f.data_quality_flag,
        match_kind: 'name_contains',
        ...(f.data_quality_flag ? { data_quality_flag: f.data_quality_flag } : {}),
      }));
  }

  const out = [...ranked, ...extra];
  if (!withPortions) return out;

  return out.map((f) => ({
    ...f,
    // Portions are FOOD-SPECIFIC: a bowl of dal is 250 g, a bowl of
    // spinach 62 g. Computed per result rather than published as a global
    // table, which is the whole point of CONTRACT §3.4b.
    portions: safePortions(f),
  }));
}

/** listPortions can throw on odd names; a missing portion list must not
 *  take down the search request. */
function safePortions(food) {
  if (isStaple(food)) {
    const st = stapleByKey(food.staple_key);
    if (st) {
      return st.units
        .map((u, i) => ({
          key: `staple_${u.key}`, unit_key: u.key, label: u.label, group: unitGroup(u),
          basis: u.g ? 'staple' : 'catalogue', grams: stapleUnitGrams(food, u, 1),
          default: i === 0, recommended: true,
        }))
        .filter((p) => Number(p.grams) > 0);
    }
  }
  try {
    return rankPortions(food, listPortions(food.food_name, food.cooking_state)
      .map((p) => ({
        ...p,
        // Prefer the food's OWN measured serving weight when it has one.
        grams: p.basis === 'serving' && food.serving_grams ? food.serving_grams : p.grams,
      }))
      // Drop portions the catalogue could not weigh for THIS food. They
      // rendered as "Piece · 0g" / "Slice · 0g" -- a chip that logs
      // nothing, offered next to real ones, which is worse than absent:
      // a per-piece weight only exists for foods that come in pieces.
      .filter((p) => Number(p.grams) > 0));
  } catch {
    return [];
  }
}

/* What a food is, for choosing which units make sense. Order matters:
   the first match wins.

     powder    first, but only on words that ARE powders ("rice flour",
               "milk powder", "garam masala") -- "masala" alone is a dish
     beverage  before dishes ("lassi", "masala chai")
     dish, grain   before fat: "Paneer in butter sauce" and "butter
               chicken" are curries, not spreads to log by the teaspoon
     fat, nut  what is left: "peanut butter", "mango pickle", "almonds"

   These patterns are word-bounded (\b). They were once written with
   literal backspace characters where the \b belonged, so none of them
   ever matched and every food was ranked as a generic "solid" -- a glass
   of lassi offered by the piece. */
const PORTION_KINDS = [
  ['powder', /\b(flour|atta|maida|besan|powder|garam masala|chaat masala|salt|spices?|seeds?)\b/i],
  ['beverage', /\b(tea|chai|coffee|milk|juice|lassi|shake|smoothie|soda|cola|drink|buttermilk|chaas|sharbat|beer|wine|water|latte)\b/i],
  ['dish', /\b(curry|gravy|dal|daal|sambar|rasam|soup|stew|kadhi|korma|makhani|masala|rajma|chole|sabzi|sabji|bhaji|kheer|halwa|raita|paneer|butter chicken|tikka|keema)\b/i],
  ['grain', /\b(rice|biryani|biriyani|pulao|pulav|khichdi|poha|upma|noodles|pasta|maggi|oats|porridge|cereal|muesli)\b/i],
  ['fat', /\b(ghee|butter|oil|jam|honey|sugar|syrup|sauce|ketchup|mayonnaise|mayo|chutney|pickle|achar|spread|dressing|cream)\b/i],
  ['nut', /\b(nuts?|almonds?|peanuts?|cashews?|walnuts?|pistachios?|raisins?|chips|namkeen|bhujia|mixture|trail)\b/i],
];

// Units that make sense for each kind, best first. Count units for the food
// itself ("Egg", "Roti / chapati") always lead, whatever the kind.
const PORTION_PREFS = {
  beverage: ['tea_cup', 'glass', 'cup', 'mug', 'small_glass'],
  fat: ['teaspoon', 'tablespoon'],
  powder: ['teaspoon', 'tablespoon', 'cup'],
  nut: ['handful', 'tablespoon', 'katori'],
  grain: ['katori', 'half_plate', 'plate', 'bowl'],
  dish: ['katori', 'bowl', 'ladle', 'serving_spoon'],
  solid: ['piece', 'slice', 'katori', 'handful', 'half_plate'],
};

/**
 * Put the units that make sense for THIS food first, and flag them.
 *
 * listPortions offers all 22 containers for every food -- an egg could be
 * logged by the "Tall glass", and the one unit anyone uses for it ("Egg,
 * 50 g") came 23rd of 23. Nothing is removed (the picker can still offer
 * every unit, and the resolve route still accepts any of them); the order
 * changes and the relevant ones carry `recommended`, the first `default`.
 */
function rankPortions(food, portions) {
  const name = `${food.food_name || ''} ${food.category || ''}`;
  const kind = (PORTION_KINDS.find(([, re]) => re.test(name)) || ['solid'])[0];
  const prefs = PORTION_PREFS[kind];
  const ownCount = portions.filter((p) => p.group === 'count' && p.key !== 'piece' && p.key !== 'slice');
  const ranked = [];
  const seen = new Set();
  const push = (p, recommended) => {
    if (!p || seen.has(p.key)) return;
    seen.add(p.key);
    ranked.push({ ...p, recommended });
  };
  ownCount.forEach((p) => push(p, true));
  prefs.forEach((k) => push(portions.find((p) => p.key === k), true));
  portions.forEach((p) => {
    // A pinch is for spices; anything else gets it last and unflagged.
    push(p, false);
  });
  return ranked.map((p, i) => ({ ...p, default: i === 0 }));
}

/**
 * Resolve a chosen quantity (grams, or a portion x count) plus an optional
 * oil level into final macros for ONE logged item.
 *
 * Order of preference for grams matches CONTRACT §3.4b:
 *   explicit grams  ->  portion x the food's own density/serving  ->  100 g
 *
 * OIL is applied through the model's adjustOil, never by adding
 * `grams x 9 kcal` here. The model treats the selected level as a DELTA
 * from the dish's own recipe oil, so picking "low" on a dish that already
 * assumes a lot of oil REDUCES its calories -- and it conserves mass,
 * because 10 g of added oil is also 10 g of extra food. Hand-rolling that
 * arithmetic in a route is how the UI and the model start disagreeing.
 */
export function resolveFoodQuantity(food, { portionKey, count = 1, grams, oilLevel } = {}) {
  if (!food) return null;
  const n = Number(count) > 0 ? Number(count) : 1;

  let g = null;
  let basis = null;
  let label = null;

  const staple = isStaple(food) ? stapleByKey(food.staple_key) : null;
  const stapleUnitFor = staple && (portionKey
    ? (stapleUnitByPortionKey(staple, portionKey) || stapleUnit(staple, portionKey))
    : stapleUnit(staple, null, { hadQuantity: false }));

  if (Number(grams) > 0) {
    g = Number(grams);
    basis = 'grams';
    label = `${g} g`;
  } else if (stapleUnitFor && stapleUnitGrams(food, stapleUnitFor, n)) {
    // A staple's own unit ("staple_cup", "roti") or, with no portion at
    // all, its default unit -- 1 cup of chai, not 100 g of it.
    g = stapleUnitGrams(food, stapleUnitFor, n);
    basis = 'staple_unit';
    label = `${n} ${stapleUnitFor.label}`;
  } else if (portionKey) {
    const p = portionToGrams(portionKey, n, {
      foodName: food.food_name,
      cookingState: food.cooking_state,
      // `foodServingGrams`, NOT `servingGrams` -- portionToGrams destructures
      // that exact name, so the misspelled key silently disabled the "the
      // food's OWN measured serving beats the generic volume figure"
      // override for bowl/katori/plate/piece/medium_bowl. The identical bug
      // was found and fixed in resolveGrams above; this second call site was
      // missed, which meant the two paths disagreed on the SAME food and
      // portion: "1 bowl Arhar dal aur palak" resolved to 403.3 g through
      // the text estimator (measured_serving) but 250 g here (generic
      // volume) -- a 61% divergence between the picker and the parser.
      foodServingGrams: food.serving_grams,
    });
    if (p && p.grams > 0) {
      g = p.grams;
      basis = p.basis;
      label = `${n} x ${portionKey.replace(/_/g, ' ')}`;
    }
  }
  if (!(g > 0)) {
    if (food.serving_grams > 0) {
      g = food.serving_grams * n;
      basis = 'food_serving';
      label = `${n} x serving`;
    } else {
      g = 100 * n;
      basis = 'assumed_100g';
      label = `${n} x 100 g (assumed)`;
    }
  }

  const scaled = scaleNutrition(food, g);
  if (!scaled) return null;

  let totals = scaled.totals;
  let oil = null;
  const level = oilLevel && OIL_LEVELS[oilLevel] !== undefined ? oilLevel : null;
  if (level) {
    /* adjustOil takes an OPTIONS OBJECT and works PER 100 g -- calling it
       as adjustOil(food, grams, level) silently returned nothing, which is
       why the oil buttons appeared to do exactly zero.

       It also needs `baselineOilG`: the oil this dish's recipe ALREADY
       assumes, because the selected level is applied as a delta from that,
       not piled on top. Choosing "low" for an oily dish must REDUCE its
       calories.

       HONEST LIMITATION: those per-recipe baselines were derived from 541
       real recipes in the Python OilAdjuster, which was never ported to
       JS. Here the baseline is approximated by the dish's own fat_g, and
       ONLY for cooked dishes, where added oil is the dominant source of
       fat. For paneer, nuts or meat -- where fat is intrinsic -- that
       approximation would over-subtract, so oil adjustment is refused
       rather than guessed, and the response says which happened. */
    const isCookedDish = food.cooking_state === 'cooked' || food.category === 'indian_dish';
    const baselineOilG = isCookedDish && Number(food.fat_g) >= 0 ? Number(food.fat_g) : null;

    if (baselineOilG === null) {
      oil = { level, applied: false, reason: 'no oil baseline for this food — its fat is not mostly added oil' };
    } else {
      const adj = adjustOil(food, { level, baselineOilG });
      // NOTE the field names: adjustOil returns *_adjusted keys, not bare
      // ones. Reading adj.energy_kcal (which does not exist) made every
      // level silently report "adjustment unavailable" even though the
      // model had computed a perfectly good answer.
      if (adj && adj.adjusted !== false && adj.energy_kcal_adjusted != null) {
        // adjustOil returns PER-100g values; rescale to the logged portion.
        const factor = g / 100;
        const before = scaled.totals.energy_kcal ?? 0;
        const per100 = (v) => (v == null ? null : Math.round(v * factor * 100) / 100);
        totals = {
          ...totals,
          energy_kcal: per100(adj.energy_kcal_adjusted),
          fat_g: per100(adj.fat_g_adjusted) ?? totals.fat_g,
          protein_g: per100(adj.protein_g_adjusted) ?? totals.protein_g,
          carb_g: per100(adj.carb_g_adjusted) ?? totals.carb_g,
        };
        oil = {
          level,
          applied: true,
          g_per_100g: OIL_LEVELS[level],
          baseline_oil_g_per_100g: adj.baseline_oil_g_per_100g ?? baselineOilG,
          delta_kcal: (totals.energy_kcal ?? 0) - before,
          basis: 'approximated from this dish fat content',
        };
      } else {
        oil = { level, applied: false, reason: (adj && adj.reason) || 'adjustment unavailable' };
      }
    }
  }

  return {
    schema_version: 'food-v1',
    source_id: food.source_id,
    name: food.food_name,
    grams: Math.round(g * 10) / 10,
    grams_basis: basis,
    quantity_label: label,
    confidence: food.confidence,
    cooking_state: food.cooking_state || null,
    totals,
    oil,
    portions: safePortions(food),
  };
}

/**
 * Barcode scan -> one logged item at the product's own serving size
 * (CONTRACT §3.6). Returns null on a miss so the route can 404 rather
 * than substituting a guessed food.
 */
export function estimateFromBarcode(code, servings = 1) {
  return autoLogFromBarcode(code, servings, getBarcodeIndex());
}

/* ------------------------------------------------------------------ */
/*  Tier 2 — compositional (ingredients known)                         */
/* ------------------------------------------------------------------ */

/**
 * Price a dish from a user-supplied ingredient list.
 * ingredients: [{ name, amount, unit }, ...]
 * Returns null if the model isn't available on this deployment; otherwise
 * the calculator's own result shape (CompositionalCalculator.compute()),
 * ok:true/false per-call, never throws on a bad/partial ingredient list.
 */
export function estimateCompositional(ingredients, { servings = 1, dishName = null } = {}) {
  const calc = getCompositionalCalculator();
  if (!calc) return null;
  return calc.compute(ingredients, { servings, dishName });
}

/* ------------------------------------------------------------------ */
/*  Tier 3 — similarity-weighted kNN (name only)                       */
/* ------------------------------------------------------------------ */

/** Confidence bands derived from the MEASURED regime accuracy in
 *  fallback_v4_metrics.json (regime A ~17% / regime B ~15% median APE at
 *  reasonable similarity) -- not invented thresholds. A low top-similarity
 *  means the nearest measured neighbour is still a poor stand-in for the
 *  query, which is exactly when this tier should say so rather than
 *  present a number with unearned confidence. */
function knnConfidence(topSimilarity) {
  if (topSimilarity >= 0.55) return 'medium';
  if (topSimilarity >= 0.3) return 'low';
  return 'unreliable';
}

/**
 * Tier 3: similarity-weighted kNN estimate for a food name search found
 * nothing for. Shaped like a Tier-1 food match (same per-100g field names)
 * so a caller that already knows how to render/scale a "food" object needs
 * minimal special-casing, but explicitly tagged as an estimate throughout
 * -- never presented with Tier-1's confidence.
 *
 * Returns null when the model artifact isn't available on this deployment,
 * or when the query shares nothing at all with the measured corpus (no
 * neighbours found) -- never a fabricated match.
 */
export function estimateFoodKnn(query, { grams = 100 } = {}) {
  const knn = getKnnFallback();
  if (!knn) return null;
  const result = knn.predict(query);
  if (!result) return null;

  const factor = grams / 100;
  const p = result.predicted;
  return {
    schema_version: 'food-v1',
    tier: 3,
    estimate: true,
    estimate_status: 'knn_estimated',
    source_id: null,
    food_name: query,
    matched_neighbor: result.neighbors[0]?.name || null,
    neighbors: result.neighbors,
    top_similarity: round1(result.top_similarity * 100) / 100,
    confidence: knnConfidence(result.top_similarity),
    trustworthy: false, // an estimate, never a measured value -- callers must not treat it as Tier 1
    match_kind: 'knn_similarity',
    energy_kcal: round1(p.energy_kcal),
    protein_g: round1(p.protein_g),
    fat_g: round1(p.fat_g),
    carb_g: round1(p.carb_g),
    grams: round1(grams),
    totals: {
      calories: Math.round(p.energy_kcal * factor),
      protein: round1(p.protein_g * factor),
      carbs: round1(p.carb_g * factor),
      fat: round1(p.fat_g * factor),
    },
    disclaimer: 'No exact or ingredient-based match was found. This is an estimate based on similar measured foods, not a direct measurement.',
  };
}

/* ------------------------------------------------------------------ */
/*  The plate — what the logger shows before anything is logged        */
/* ------------------------------------------------------------------ */

/*
 * A plate item is one food on its way to the log, shaped so the UI can
 * re-price it INSTANTLY as the person changes "2 roti" to "3 roti" or
 * "katori" to "bowl", without a round trip per tap:
 *
 *   per100   the measured row's own per-100 g values (never re-derived)
 *   units    natural units with the grams ONE of them weighs, for THIS
 *            food -- a katori of dal is 150 g, a katori of poha is not
 *   qty, unit_key, grams   what was understood
 *
 * Grams per unit come from the server (portion -> grams depends on the
 * food's density and measured serving; see /foods/resolve). Scaling by
 * grams is plain proportion, which is all the client does with them.
 */
const G_UNIT = { key: 'g', label: 'g', grams: 1 };

function plateUnits(row) {
  const seen = new Set();
  const out = [];
  for (const p of safePortions(row)) {
    if (!(Number(p.grams) > 0) || seen.has(p.key)) continue;
    seen.add(p.key);
    out.push({ key: p.key, label: p.label, grams: round1(p.grams) });
    if (out.length >= 6) break;
  }
  return [...out, G_UNIT];
}

const per100Of = (row) => ({
  calories: row.energy_kcal ?? 0,
  protein: row.protein_g ?? 0,
  carbs: row.carb_g ?? 0,
  fat: row.fat_g ?? 0,
  fiber: row.fiber_g ?? null,
});

/** The row a plate item prices against: the staple-decorated row when a
 *  staple chose it (its units are the staple's), else the index row. */
function plateRow(search, sourceId, stapleKey) {
  if (stapleKey && search.stapleRowByKey) {
    const r = search.stapleRowByKey(stapleKey);
    if (r && r.source_id === sourceId) return r;
  }
  const raw = search.bySourceId.get(sourceId);
  if (!raw) return null;
  // A staple's measured row reached by its own name keeps the staple units.
  const st = ALL_STAPLES.find((s) => s.ref === sourceId);
  return st ? { ...raw, staple_key: st.key, staple_name: st.name } : raw;
}

/** One unit the item was understood in, from estimateFood's description. */
function understoodUnit(it, units) {
  const qty = Number(it.qty) > 0 ? Number(it.qty) : 1;
  const grams = Number(it.grams) || 0;
  if (it.unit_key) {
    const u = units.find((x) => x.key === `staple_${it.unit_key}`);
    if (u) return { unit: u, qty, units };
  }
  const text = String(it.unit || '').replace(/^[\d./]+\s*(x\s*)?/i, '').trim();
  if (/^(g|gm|gms|gram|grams|kg)$/i.test(text) || !grams) {
    return { unit: G_UNIT, qty: grams || 100, units };
  }
  // A catalogue portion that weighs exactly what was understood.
  const match = units.find((u) => u.key !== 'g' && Math.abs(u.grams * qty - grams) <= Math.max(1, grams * 0.01));
  if (match) return { unit: match, qty, units };
  // Otherwise keep the words the person used ("200 ml", "4 tablespoons").
  // Three decimals: 200 ml of milk is 1.03 g per ml, and rounding that to
  // 1 g would quietly drop 3% when the amount is changed.
  const typed = { key: 'typed', label: text.replace(/\(assumed\)/, '').trim() || 'serving', grams: Math.round((grams / qty) * 1000) / 1000 };
  return { unit: typed, qty, units: [typed, ...units] };
}

/* Foods whose fat is mostly the oil or ghee they were cooked in -- the only
   ones where "less oil" / "more oil" means anything. Curries, dals, rice
   dishes and the fried or griddled breads. Not drinks, nuts, spreads, or a
   boiled egg: their fat is the food's own, and subtracting it as "oil" would
   invent a leaner food than exists. */
const OILY_COOKING = /(paratha|parantha|puri|poori|bhatura|bhature|dosa|uttapam|uthappam|chilla|cheela|pakora|pakoda|bhajji|bhaji|tikki|cutlet|omelette|omelet|bhurji|fry|fried|tadka|tarka)/i;

function oilApplies(row) {
  const name = `${row.food_name || ''} ${row.staple_name || ''} ${row.category || ''}`;
  const kind = (PORTION_KINDS.find(([, re]) => re.test(name)) || ['solid'])[0];
  if (kind === 'beverage' || kind === 'fat' || kind === 'nut' || kind === 'powder') return false;
  const cooked = row.cooking_state === 'cooked' || row.category === 'indian_dish';
  return cooked && (kind === 'dish' || kind === 'grain' || OILY_COOKING.test(name));
}

/**
 * "Less oil" and "more oil" for a cooked dish, as the per-100 g values the
 * plate re-prices from.
 *
 * The same model and the same baseline as resolveFoodQuantity's oil levels
 * (adjustOil, with the dish's own fat standing in for its recipe oil), so
 * the plate and the classic picker can never disagree about a katori of dal
 * made with less oil. Two choices instead of five absolute levels, because
 * "how many grams of oil per 100 g" is not a question anyone can answer at
 * the table -- but each choice IS one of those levels, picked relative to
 * the dish:
 *
 *   less   the next level clearly below this dish's own oil -- never more
 *          than 70% of its fat removed, because some of it is always the
 *          food's own (paneer, the dal itself)
 *   more   the next level clearly above it
 *
 * So "less" always lowers and "more" always raises the dish's calories;
 * absolute levels labelled with relative words could not promise that.
 */
export function plateOil(row) {
  if (!oilApplies(row) || row.energy_kcal == null) return null;
  const baseline = Number(row.fat_g);
  // Under 2 g of fat per 100 g nothing was cooked in oil to speak of --
  // plain rice, a phulka -- and "more oil" would describe a different dish.
  if (!(baseline >= 2)) return null;
  const levels = Object.entries(OIL_LEVELS).sort((a, b) => a[1] - b[1]);
  const less = [...levels].reverse().find(([, g]) => g <= baseline - 1.5 && g >= baseline * 0.3);
  const more = levels.find(([, g]) => g >= baseline + 2);
  const at = (level) => {
    const adj = adjustOil(row, { level, baselineOilG: baseline });
    if (!adj || adj.adjusted === false || adj.energy_kcal_adjusted == null) return null;
    return {
      calories: adj.energy_kcal_adjusted,
      protein: adj.protein_g_adjusted ?? row.protein_g ?? 0,
      carbs: adj.carb_g_adjusted ?? row.carb_g ?? 0,
      fat: adj.fat_g_adjusted ?? row.fat_g ?? 0,
    };
  };
  const options = [];
  for (const [key, pick] of [['less', less], ['more', more]]) {
    const per100 = pick && at(pick[0]);
    if (per100) options.push({ key, level: pick[0], oil_g_per_100g: pick[1], per100 });
  }
  return options.length ? { baseline_g_per_100g: round1(baseline), options } : null;
}

function toPlateItem(it, row) {
  const base = plateUnits(row);
  const { unit, qty, units } = understoodUnit(it, base);
  return {
    name: it.name,
    source_name: it.source_name ?? row.food_name,
    source_id: it.source_id,
    staple_key: it.staple_key ?? row.staple_key ?? null,
    source: it.source ?? row.source,
    confidence: it.confidence ?? null,
    trustworthy: it.trustworthy !== false,
    ambiguous: !!it.ambiguous,
    alternatives: it.alternatives || [],
    matched_from: it.matched_from ?? null,
    grams_basis: it.grams_basis ?? null,
    assumed: !!it.grams_assumed,
    per100: per100Of(row),
    oil: plateOil(row),
    units,
    unit_key: unit.key,
    qty,
    grams: it.grams,
    calories: it.calories,
    protein: it.protein,
    carbs: it.carbs,
    fat: it.fat,
  };
}

/**
 * "2 roti, 1 katori dal and a cup of chai" -> plate items. The meal parser
 * (estimateFood) does the understanding; this only reshapes each item so
 * it can be adjusted before it is logged. Unresolved fragments pass through
 * untouched -- the UI must show them, never drop them.
 */
export function describeMeal(text) {
  const est = estimateFood(text);
  const search = getFoodSearch();
  if (!search) return { ...est, items: [] };
  const items = est.items.map((it) => {
    const row = plateRow(search, it.source_id, it.staple_key);
    return row ? toPlateItem(it, row) : null;
  }).filter(Boolean);
  return { ...est, items };
}

/**
 * A plate item for one known food (a swap to an alternative, or a pick from
 * search), at its natural default unit -- "Buffalo milk" arrives as one
 * glass, not 100 g.
 */
export function plateItemFor(sourceId, { stapleKey = null } = {}) {
  const search = getFoodSearch();
  if (!search) return null;
  const row = plateRow(search, sourceId, stapleKey) || null;
  if (!row || row.data_quality_flag) return null;
  const units = plateUnits(row);
  const unit = units[0];
  const qty = unit.key === 'g' ? 100 : 1;
  const grams = round1(unit.grams * qty);
  const s = scaleNutrition(row, grams);
  const t = s?.totals || {};
  return toPlateItem({
    name: row.staple_name || row.food_name,
    source_name: row.food_name,
    source_id: row.source_id,
    staple_key: row.staple_key ?? null,
    source: row.source,
    confidence: row.confidence ?? 'high',
    trustworthy: true,
    alternatives: row.staple_key ? stapleAlternatives(row, search) : [],
    qty,
    unit: `${qty} x ${unit.label}`,
    unit_key: unit.key.startsWith('staple_') ? unit.key.slice(7) : null,
    grams,
    calories: Math.round(t.energy_kcal ?? 0),
    protein: t.protein_g,
    carbs: t.carb_g,
    fat: t.fat_g,
  }, row);
}
