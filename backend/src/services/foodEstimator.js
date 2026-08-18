// ============================================================
// FOOD LOGGING — backed by skos-food-v1.
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

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ML = path.resolve(HERE, '..', '..', '..', 'ml');
const PROC = path.join(ML, 'data', 'processed');

const {
  FoodSearch, toGrams, scaleNutrition, portionToGrams, canonicalPortion,
} = require(path.join(ML, 'models', 'skos-food-v1', 'foodEstimate.reference.js'));

const {
  BarcodeIndex, autoLogFromBarcode,
} = require(path.join(ML, 'models', 'skos-food-v1', 'barcodeLookup.reference.js'));

/* ------------------------------------------------------------------ */
/*  Lazy singletons                                                    */
/* ------------------------------------------------------------------ */

let _search = null;
let _barcodes = null;
let _loadError = null;

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
    _search = new FoodSearch(db, aliases);
  } catch (err) {
    _loadError = err;
    _search = null;
  }
  return _search;
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
  const cleaned = String(fragment || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s./½¼¾⅓⅔-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;

  let tokens = cleaned.split(' ');
  const { qty, rest } = parseQuantity(tokens);
  tokens = rest;

  let unit = null;
  if (tokens.length) {
    // Singularise so "bowls"/"rotis" hit the same catalogue entry.
    const head = tokens[0];
    const singular = head.replace(/(?:es|s)$/, '');
    if (MASS_VOLUME.test(head) || MASS_VOLUME.test(singular)) {
      unit = MASS_VOLUME.test(head) ? head : singular;
      tokens = tokens.slice(1);
    } else if (canonicalPortion(head) || canonicalPortion(singular)) {
      unit = canonicalPortion(head) || canonicalPortion(singular);
      tokens = tokens.slice(1);
    }
  }

  let name = tokens.filter((t) => !NOISE.has(t)).join(' ').trim();

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

  // A fragment that names no food even after that ("2 bowls" alone) is
  // genuinely ambiguous. Report it rather than guessing.
  if (!name) return { qty, unit, name: null, raw: fragment };
  return { qty, unit, name, raw: fragment };
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
function resolveGrams(parsed, food) {
  const qty = parsed.qty == null ? 1 : parsed.qty;

  if (parsed.unit && MASS_VOLUME.test(parsed.unit)) {
    // toGrams returns { grams, method, note } -- NOT a number. Treating the
    // returned object as one meant `g > 0` was always false, so every
    // explicit mass silently fell through to the 100 g assumption and got
    // multiplied by the amount: "150g paneer" logged 15,000 g / 45,810 kcal.
    const { grams } = toGrams(qty, parsed.unit, food.food_name);
    if (grams > 0) {
      return { grams: round1(grams), basis: 'measured', assumed: false,
               description: `${qty} ${parsed.unit}` };
    }
  }

  if (parsed.unit) {
    const p = portionToGrams(parsed.unit, qty, {
      foodName: food.food_name,
      cookingState: food.cooking_state,
      servingGrams: food.serving_grams,
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

/**
 * Estimate a whole logged meal from free text.
 *
 * The response KEEPS the old envelope ({ text, items, total, estimate })
 * so the existing client keeps working unchanged, and adds the
 * contract fields (schema_version, tier, confidence, unresolved)
 * alongside. Per CONTRACT_skos-food-v1.md that is the migration shape.
 */
export function estimateFood(text) {
  const search = getFoodSearch();
  const fragments = splitItems(text);

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
    const parsed = parseFragment(fragment);
    if (!parsed) continue;
    if (!parsed.name) {
      unresolved.push({ fragment, reason: 'no food named in this part' });
      continue;
    }

    const hits = search.search(parsed.name, { limit: 1 });
    if (!hits.length) {
      unresolved.push({ fragment, reason: `no match for "${parsed.name}"` });
      continue;
    }
    const food = hits[0];

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
      // Legacy fields the current client renders.
      name: food.food_name,
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
      cooking_state: food.cooking_state,
      matched_from: fragment,
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
 * (CONTRACT §3.1).
 */
export function searchFoods(query, { limit = 8 } = {}) {
  const search = getFoodSearch();
  if (!search) return [];
  return search.search(query, { limit });
}

/**
 * Barcode scan -> one logged item at the product's own serving size
 * (CONTRACT §3.6). Returns null on a miss so the route can 404 rather
 * than substituting a guessed food.
 */
export function estimateFromBarcode(code, servings = 1) {
  return autoLogFromBarcode(code, servings, getBarcodeIndex());
}
