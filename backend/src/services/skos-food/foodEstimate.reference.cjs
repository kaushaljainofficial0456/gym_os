/**
 * skos-food-v1 ΓÇö JS REFERENCE IMPLEMENTATION
 *
 * WHY THIS FILE EXISTS
 * The backend is Node; the model is Python. skos-cal-v1 shipped
 * `mlEstimate.reference.js` for exactly this reason and it made the port a
 * mechanical translation rather than a reimplementation. This is the same
 * contract for food.
 *
 * SCOPE ΓÇö deliberately tier 1 + oil, not everything:
 *   INCLUDED  search / ranking / confidence, cooking-state preference,
 *             portion units -> grams, oil adjustment, nutrition scaling.
 *   EXCLUDED  tier 3 (kNN over TF-IDF vectors) ΓÇö porting a trained
 *             retrieval model to JS would mean reimplementing the
 *             vectoriser and shipping the index, and it is the LEAST
 *             accurate tier (14.9ΓÇô21.6% median APE). Call the Python
 *             service for it, or omit it and report "not found", which the
 *             contract already allows.
 *   PARTIAL   tier 2 works here because it is just repeated tier-1 lookups
 *             plus arithmetic; ingredient aliases are shipped as data.
 *
 * PARITY IS NOT ASSUMED. `foodEstimate.test.js` re-checks the invariants the
 * Python suite pins ΓÇö ranking order, oil monotonicity, mass conservation,
 * unit conversion ΓÇö so a divergence surfaces as a failing test rather than
 * as a wrong number in the app.
 *
 * DATA: loads `unified_food_db.json` (same artifact the Python side uses).
 * There is one database, not two.
 */

'use strict';

const SOURCE_RANK = { INDB: 0, IFCT2017: 1, USDA_FDC: 2, CNF_CANADA: 3, OPEN_FOOD_FACTS: 4 };

const KCAL_PER_G_OIL = 8.84;          // USDA: cooking oil 884 kcal/100 g
const MAX_PLAUSIBLE_KCAL = 902;       // pure fat; nothing edible exceeds it

// Measured percentiles across 541 real Indian recipes (g oil / 100 g dish).
const OIL_LEVELS = { none: 0.0, low: 2.0, moderate: 4.5, high: 10.0, very_high: 17.0 };

// IFCT Table 12 ΓÇö every profile sums to exactly 100%.
const OIL_FATTY_ACID_PROFILE = {
  'coconut oil':   { sfa: 90.9, mufa: 7.2,  pufa: 1.9 },
  'corn oil':      { sfa: 16.6, mufa: 33.7, pufa: 49.7 },
  'gingelly oil':  { sfa: 16.2, mufa: 41.4, pufa: 42.3 },
  'sesame oil':    { sfa: 16.2, mufa: 41.4, pufa: 42.3 },
  'groundnut oil': { sfa: 18.9, mufa: 53.9, pufa: 27.2 },
  'peanut oil':    { sfa: 18.9, mufa: 53.9, pufa: 27.2 },
  'mustard oil':   { sfa: 5.7,  mufa: 67.1, pufa: 27.2 },
  'palm oil':      { sfa: 45.0, mufa: 43.5, pufa: 11.5 },
  'rice bran oil': { sfa: 23.8, mufa: 44.1, pufa: 32.1 },
  'safflower oil': { sfa: 9.2,  mufa: 14.0, pufa: 76.8 },
  'soyabean oil':  { sfa: 16.0, mufa: 24.1, pufa: 60.0 },
  'sunflower oil': { sfa: 11.4, mufa: 26.0, pufa: 62.6 },
  ghee:            { sfa: 71.0, mufa: 26.4, pufa: 2.5 },
  vanaspati:       { sfa: 61.4, mufa: 33.9, pufa: 4.7 }
};

// ---------------------------------------------------------------- units --
const ML_PER_UNIT = {
  tsp: 5, teaspoon: 5, tbsp: 15, tablespoon: 15, cup: 240, cups: 240,
  katori: 150, bowl: 250, 'small bowl': 180, 'soup bowl': 300,
  glass: 250, 'tall glass': 350, 'tea cup': 150,
  ml: 1, litre: 1000, l: 1000, drop: 0.05, drops: 0.05, pinch: 0.35, dash: 0.6
};

// A tablespoon is a VOLUME: 1 tbsp of oil is ~13.8 g, of honey ~21 g, of
// flour ~8 g. A flat 15 g/tbsp rule is wrong by up to 2.6x.
const DENSITY_PATTERNS = [
  [/\boil\b/i, 0.92], [/\bghee\b/i, 0.91], [/\bbutter\b/i, 0.91],
  [/\bhoney\b/i, 1.42], [/\bsyrup\b/i, 1.33],
  [/\bmilk\b|\bcurd\b|\bdahi\b|\byogh?urt\b/i, 1.03],
  [/\bcream\b|\bmalai\b/i, 0.99],
  [/\bsugar\b|\bjaggery\b/i, 0.85], [/\bsalt\b/i, 1.20],
  [/\bbesan\b|\bgram flour\b/i, 0.60],
  [/\bsemolina\b|\bsuji\b|\brava\b/i, 0.75],
  [/\bflour\b|\batta\b|\bmaida\b/i, 0.55],
  [/\brice\b|\bpoha\b/i, 0.85],
  [/\bdal\b|\blentil\b/i, 0.85],
  [/\bpowder\b|\bmasala\b/i, 0.50],
  [/\bleaves\b|\bspinach\b|\bpalak\b/i, 0.25],
  [/\balmond\b|\bcashew\b|\bpeanut\b/i, 0.60]
];

const PIECE_GRAMS = [
  [/\begg\b/i, 50], [/\bclove\b/i, 3], [/\bonion\b/i, 110], [/\btomato\b/i, 100],
  [/\bpotato\b/i, 150], [/\bchill?i\b/i, 5], [/\blemon\b|\blime\b/i, 60],
  [/\bbanana\b/i, 120], [/\bapple\b/i, 180], [/\broti\b|\bchapati\b/i, 40],
  [/\bdosa\b/i, 85], [/\bidli\b/i, 45], [/\bslice\b|\bbread\b/i, 25]
];

const COUNT_UNITS = new Set(['no', 'nos', 'no.', 'nos.', 'piece', 'pieces', 'pc',
  'pcs', 'clove', 'cloves', 'slice', 'slices', 'medium', 'small', 'large']);

const UNQUANTIFIABLE = /to taste|as required|as needed|enough|few|handful|garnish|for frying|a little|optional/i;

function densityFor(foodName) {
  for (const [rx, d] of DENSITY_PATTERNS) if (rx.test(foodName || '')) return d;
  return 1.0;
}

function pieceGramsFor(foodName) {
  for (const [rx, g] of PIECE_GRAMS) if (rx.test(foodName || '')) return g;
  return null;
}

/** (amount, unit, foodName) -> { grams, method, note }. grams is null when
 *  genuinely unquantifiable ΓÇö never a silent guess. */
function toGrams(amount, unit, foodName = '') {
  const unitRaw = String(unit || '').trim().toLowerCase();
  if (UNQUANTIFIABLE.test(unitRaw) || UNQUANTIFIABLE.test(String(amount || ''))) {
    return { grams: null, method: 'unquantifiable', note: `'${unitRaw || amount}' has no measurable quantity` };
  }
  const amt = Number(String(amount).trim());
  if (!Number.isFinite(amt) || amt <= 0) {
    return { grams: null, method: 'unparseable_amount', note: `could not read amount '${amount}'` };
  }
  const u = unitRaw.replace(/\(.*?\)/g, '').replace(/[^a-z. ]/g, '').trim();

  if (['g', 'gram', 'grams', 'gm', 'gms'].includes(u)) return { grams: amt, method: 'mass', note: null };
  if (['kg', 'kilogram', 'kilograms'].includes(u)) return { grams: amt * 1000, method: 'mass', note: null };
  if (u === 'mg') return { grams: amt / 1000, method: 'mass', note: null };

  if (ML_PER_UNIT[u] !== undefined) {
    const ml = amt * ML_PER_UNIT[u];
    const d = densityFor(foodName);
    return { grams: ml * d, method: 'volume', note: `${ml.toFixed(1)}ml x ${d} g/ml` };
  }
  if (COUNT_UNITS.has(u) || u === '') {
    const pg = pieceGramsFor(foodName);
    if (pg !== null) return { grams: amt * pg, method: 'count', note: `${amt} x ${pg}g/piece` };
    return { grams: null, method: 'unknown_piece_weight', note: `no reference weight for one '${foodName}'` };
  }
  return { grams: null, method: 'unknown_unit', note: `unit '${unitRaw}' not recognised` };
}

// ------------------------------------------------------------ cooking ----
const NORMALLY_COOKED = new Set(['rice', 'wheat', 'atta', 'quinoa', 'millet', 'bajra',
  'jowar', 'ragi', 'barley', 'oats', 'pasta', 'noodles', 'vermicelli', 'semolina',
  'suji', 'rava', 'poha', 'dal', 'daal', 'lentil', 'lentils', 'chickpeas', 'chickpea',
  'rajma', 'kidney', 'beans', 'bean', 'gram', 'peas', 'moong', 'urad', 'toor',
  'chana', 'chicken', 'mutton', 'lamb', 'goat', 'beef', 'pork', 'fish', 'prawn',
  'keema', 'potato', 'aloo', 'yam']);

const NORMALLY_RAW = new Set(['apple', 'banana', 'orange', 'mango', 'grape', 'papaya',
  'guava', 'watermelon', 'pear', 'peach', 'pomegranate', 'pineapple', 'cucumber',
  'tomato', 'lettuce', 'salad', 'sprouts', 'carrot', 'almond', 'cashew', 'walnut',
  'peanut', 'curd', 'dahi', 'yoghurt', 'yogurt', 'milk', 'paneer', 'cheese',
  'honey', 'jaggery', 'sugar', 'oil', 'ghee', 'butter']);

const DRIED_RE = /\b(dried|dry|dehydrated|desiccated|sun.dried|freeze.dried|raisin|prune)\b/i;
const NORMALLY_DRY = new Set(['dal', 'lentil', 'gram', 'chana', 'rice', 'wheat', 'flour',
  'spice', 'masala', 'powder', 'chilli', 'turmeric', 'cumin', 'pepper', 'almond',
  'cashew', 'raisin', 'date', 'dates', 'nut', 'nuts', 'seed', 'seeds', 'tea',
  'coffee', 'sugar', 'pasta', 'sago', 'poha', 'tapioca']);

function tokensOf(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean); }

/** The state a food is normally EATEN in ΓÇö which is what a user logging it
 *  means. Rice is 358 kcal/100g raw and 129 cooked; defaulting wrong is a
 *  342 kcal error on a 150 g portion. */
function expectedState(foodName) {
  const t = new Set(tokensOf(foodName));
  for (const w of t) if (NORMALLY_COOKED.has(w)) return 'cooked';
  for (const w of t) if (NORMALLY_RAW.has(w)) return 'raw';
  return null;
}

function moistureMismatch(foodName) {
  if (!DRIED_RE.test(foodName || '')) return false;
  const t = new Set(tokensOf(foodName));
  for (const w of t) if (NORMALLY_DRY.has(w)) return false;
  return true;
}

// ------------------------------------------------------------- search ----
function normalize(text) {
  return String(text || '')
    .normalize('NFKD').replace(/[╠Ç-═»]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const BRAND_PENALTIES = [
  [/\bbabyfood\b/i, 60],
  [/\b(applebee|mcdonald|burger king|kfc|domino|subway|denny|wendy|taco bell|starbucks|kellogg|kraft|nestle|hershey|pillsbury)\b/i, 45],
  [/\balcoholic beverage\b/i, 50],
  [/\b(vinegar|extract|flavou?ring|seasoning mix)\b/i, 30],
  [/\b(feet|foot|skins?|giblets?|gizzards?|necks?|tails?|livers?|hearts?|brains?|tripe|offal)\b/i, 55],
  [/\bnfs\b/i, 8],
  // Deli/processed forms: water-added, reformed sandwich meats at roughly
  // half the energy of the cut they are named after ("chicken breast"
  // returned an oven-roasted deli slice at 79 kcal against a real breast's
  // 168). Applied as a NAME penalty (precomputed in the constructor, like
  // every other entry here) rather than inside score(): a deli slice is a
  // property of the food, not of the query.
  [/\b(deli|luncheon|oven.roasted|honey.roasted|cold cut|reformed|water added)\b/i, 160]
];

const PREP_WORDS = new Set(['creamed', 'deviled', 'benedict', 'fried', 'scrambled',
  'omelet', 'battered', 'breaded', 'stuffed', 'candied', 'pickled', 'smoked',
  'sauce', 'salad', 'soup', 'stew', 'curry', 'casserole', 'sandwich', 'burger',
  'pie', 'cake', 'cookie', 'chips', 'kebab', 'roll', 'wrap', 'pizza', 'juice',
  'drink', 'shake', 'smoothie', 'dessert', 'pudding', 'canned', 'frozen', 'instant']);

const UNCOMMON = new Set(['duck', 'quail', 'goose', 'emu', 'ostrich', 'turkey',
  'capon', 'venison', 'bison', 'elk', 'rabbit', 'navajo', 'alaska', 'apache']);

const STOPWORDS = new Set(['raw', 'fresh', 'whole', 'the', 'and', 'with', 'without', 'of', 'in', 'a']);

// A COMPONENT of a food is not the food. Caught by comparing model output to
// lab values: "egg" returned "Egg, chicken, YOLK, cooked" at 351 kcal against
// a whole egg's 135 -- a +160% error on one of the most-logged foods there is.
const COMPONENT_PARTS = new Set(['yolk', 'yolks', 'white', 'whites', 'albumen',
  'bran', 'germ', 'husk', 'peel', 'rind', 'pulp', 'juice', 'solids', 'curds', 'whey']);

// Deli/processed forms sold ready-sliced. "chicken breast" returned an
// oven-roasted deli slice at 79 kcal against real breast at 168.
const DELI_FORM_RE = /(deli|luncheon|oven.roasted|honey.roasted|cold cut|processed|reformed|water added)/i;

class FoodSearch {
  /**
   * @param {Array} foods  parsed unified_food_db.json
   * @param {Object} aliases  parsed food_aliases.json `aliases` map (optional)
   */
  constructor(foods, aliases = {}) {
    this.foods = foods.map((f) => {
      const norm = f.search_name || normalize(f.food_name);
      return {
        ...f,
        _norm: norm,
        _tokens: norm.split(' ').filter(Boolean),
        _head: normalize(String(f.food_name || '').split(',')[0]),
        _penalty: BRAND_PENALTIES.reduce((s, [rx, p]) => s + (rx.test(f.food_name || '') ? p : 0), 0),
        _aliasTokens: new Set()
      };
    });
    this.bySourceId = new Map(this.foods.map((f) => [f.source_id, f]));
    this.aliases = aliases || {};
    for (const [alias, ids] of Object.entries(this.aliases)) {
      const toks = alias.split(' ');
      for (const id of ids) {
        const f = this.bySourceId.get(id);
        if (f) for (const t of toks) f._aliasTokens.add(t);
      }
    }
  }

  score(food, qNorm, qTokens) {
    const name = food._norm;
    if (!name) return null;
    const tokens = food._tokens;
    let score = 0;

    if (name === qNorm) {
      score += 1000;
      food._matchKind = 'exact_name';
    } else if (food._head === qNorm) {
      // "HeadNoun, qualifier" is the generic-food convention. But
      // "Cauliflower, pea and potato bhujia" has that shape and is a dish,
      // so a qualifier listing OTHER ingredients scores lower.
      const rest = String(food.food_name || '').slice(qNorm.length).toLowerCase();
      const composite = /\band\b|\bwith\b|\bmixed\b/.test(rest);
      score += composite ? 300 : 800;
      food._matchKind = composite ? 'composite_dish' : 'head_noun';
    } else if (name.startsWith(qNorm + ' ')) {
      score += 500;
      food._matchKind = 'name_prefix';
    } else {
      const matched = qTokens.filter((t) => tokens.includes(t)).length;
      const aliasMatched = qTokens.filter((t) => food._aliasTokens.has(t)).length;
      if (matched === 0 && aliasMatched === 0) {
        if (!name.includes(qNorm)) return null;
        score += 40;
        food._matchKind = 'substring';
      } else if (matched >= aliasMatched) {
        if (matched < qTokens.length) return null;
        score += 200;
        food._matchKind = 'all_tokens';
        const first = Math.min(...qTokens.filter((t) => tokens.includes(t)).map((t) => tokens.indexOf(t)));
        score -= first * 12;
      } else {
        const covered = qTokens.filter((t) => tokens.includes(t) || food._aliasTokens.has(t)).length;
        if (covered < qTokens.length) return null;
        score += 180;
        food._matchKind = 'regional_alias_tokens';
      }
    }

    // Generic queries (single word) want the simplest, most representative
    // result — heavily penalize extra tokens that indicate specialization.
    // Multi-word queries already specify what they want, so extra tokens are
    // less harmful (e.g. "chicken breast" expects "breast" in the name).
    const extraTokens = Math.max(0, tokens.length - qTokens.length);
    const extraPenalty = qTokens.length === 1 ? 20 : 6;
    score -= extraTokens * extraPenalty;

    const qSet = new Set(qTokens);
    score -= tokens.filter((t) => PREP_WORDS.has(t) && !qSet.has(t)).length * 45;
    score -= tokens.filter((t) => UNCOMMON.has(t) && !qSet.has(t)).length * 40;
    score -= tokens.filter((t) => COMPONENT_PARTS.has(t) && !qSet.has(t)).length * 90;

    // A bare one-word query wants the INGREDIENT, not a dish made from it.
    // "brinjal" returned "Brinjal bhartha" -- 65 kcal for a dish against 25
    // for the vegetable. Multi-word dish queries are untouched.
    if (qTokens.length === 1 && food.category === 'indian_dish' && tokens.length > 1) {
      score -= 120;
    }

    const rawName = String(food.food_name || '').toLowerCase();
    if (/\b(with|w\/)\b/.test(rawName)) {
      const after = rawName.split(/\b(?:with|w\/)\b/)[1] || '';
      if (![...qSet].some((t) => after.includes(t))) score -= 25;
    }

    const state = food.cooking_state;
    const eatenAs = expectedState(food.food_name);
    if (eatenAs && (state === 'raw' || state === 'cooked')) {
      score += state === eatenAs ? 70 : -70;
    } else if (state === 'raw') {
      score += 10;
    }

    if (moistureMismatch(food.food_name) &&
        ![...qSet].some((t) => ['dried', 'dry', 'dehydrated', 'raisin', 'prune'].includes(t))) {
      score -= 120;
    }

    score -= food._penalty;
    score -= (SOURCE_RANK[food.source] ?? 5) * 4;
    if (food.serving_grams) score += 8;
    if (food.data_quality_flag) score -= 150;
    return score;
  }

  search(query, { limit = 8, cuisine = null, allowBackoff = true } = {}) {
    const qNorm = normalize(query);
    if (!qNorm) return [];
    let qTokens = qNorm.split(' ').filter((t) => !STOPWORDS.has(t));
    if (!qTokens.length) qTokens = qNorm.split(' ');

    let out = this._searchExact(qNorm, qTokens, limit, cuisine);
    if (out.length || !allowBackoff || qTokens.length < 2) return out;

    // Progressive backoff: every query token must normally match, which
    // returns NOTHING for "apple big" when the DB holds "Apples, raw".
    // Measured as the largest single cause of unresolved queries.
    // Guard: keep at least one non-stopword, non-numeric token so that a
    // query like "2 bowls dal" does not back off to just "2" (which matches
    // products like "2-Minute noodles" instead of the intended food).
    for (let drop = 1; drop < qTokens.length; drop += 1) {
      const sub = qTokens.slice(0, qTokens.length - drop);
      if (sub.length < 2) break;
      const hasNonNumeric = sub.some((t) => !/^\d+$/.test(t));
      if (!hasNonNumeric) break;
      out = this._searchExact(sub.join(' '), sub, limit, cuisine);
      if (out.length) {
        for (const r of out) {
          r.query_relaxed = true;
          r.matched_on = sub.join(' ');
          r.unmatched_query_terms = qTokens.slice(qTokens.length - drop);
        }
        return out;
      }
    }
    return [];
  }

  _searchExact(qNorm, qTokens, limit, cuisine) {
    const aliasBoost = new Map();
    for (const id of (this.aliases[qNorm] || [])) aliasBoost.set(id, 900);

    const scored = [];
    for (const f of this.foods) {
      if (cuisine && f.cuisine !== cuisine) continue;
      f._matchKind = null;
      let s = this.score(f, qNorm, qTokens);
      let kind = f._matchKind;
      const boost = aliasBoost.get(f.source_id);
      if (boost !== undefined) {
        const relaxed = boost - f._penalty - (SOURCE_RANK[f.source] ?? 5) * 4;
        if (relaxed >= (s ?? 0)) { s = relaxed; kind = 'alias_exact'; }
      }
      if (s !== null && s !== undefined) scored.push({ s, f, kind });
    }
    scored.sort((a, b) => (b.s - a.s) || (a.f._norm.length - b.f._norm.length));

    return scored.slice(0, limit).map(({ s, f, kind }) => {
      const mTokens = new Set([...f._tokens, ...f._aliasTokens]);
      const qSet = new Set(qTokens);
      const inter = [...qSet].filter((t) => mTokens.has(t)).length;
      const overlap = Math.min(inter / Math.max(1, qSet.size), inter / Math.max(1, f._tokens.length));

      let confidence;
      if (f.data_quality_flag) confidence = 'unreliable';
      else if (kind === 'exact_name' || kind === 'alias_exact' || overlap >= 0.65) confidence = 'high';
      else if (overlap >= 0.40) confidence = 'medium';
      else confidence = 'low';

      // Head-noun and name-prefix matches indicate the food's core identity,
      // even when the food has many extra qualifier tokens that reduce the
      // overlap ratio. A single-word query like "egg" matching the head of
      // "Egg, chicken, whole, cooked, poached" is semantically a strong match
      // despite low token overlap — promote to at least medium confidence.
      if (confidence === 'low' && (kind === 'head_noun' || kind === 'name_prefix')) {
        confidence = 'medium';
      }

      return {
        source_id: f.source_id,
        food_name: f.food_name,
        energy_kcal: f.energy_kcal ?? null,
        protein_g: f.protein_g ?? null,
        fat_g: f.fat_g ?? null,
        carb_g: f.carb_g ?? null,
        fiber_g: f.fiber_g ?? null,
        sodium_mg: f.sodium_mg ?? null,
        serving_description: f.serving_description ?? null,
        serving_grams: f.serving_grams ?? null,
        cooking_state: f.cooking_state ?? 'unspecified',
        cuisine: f.cuisine ?? null,
        source: f.source,
        confidence,
        trustworthy: !f.data_quality_flag,
        match_kind: kind,
        ...(f.data_quality_flag ? { data_quality_flag: f.data_quality_flag } : {}),
        _score: Math.round(s * 10) / 10
      };
    });
  }
}

// --------------------------------------------------------------- oil -----
/** Re-price a food for a different oil level. The adjustment is a DELTA
 *  from the oil the dish already assumes ΓÇö adding on top double-counts ΓÇö
 *  and it conserves MASS, since 10 g of oil is 10 g of food as well as
 *  88 kcal. */
function adjustOil(food, { level = 'moderate', baselineOilG, customOilGPer100g = null, oilType = null } = {}) {
  const baseKcal = food.energy_kcal;
  if (baseKcal === null || baseKcal === undefined) return { error: 'food has no energy value' };
  if (baselineOilG === null || baselineOilG === undefined) {
    return { adjusted: false, reason: 'no oil baseline known for this food', energy_kcal: baseKcal };
  }

  let target;
  if (level === 'custom') {
    if (customOilGPer100g === null) return { error: "level='custom' requires customOilGPer100g" };
    target = Number(customOilGPer100g);
  } else {
    if (!(level in OIL_LEVELS)) return { error: `unknown oil level '${level}'` };
    target = OIL_LEVELS[level];
  }
  if (!(target >= 0)) return { error: 'oil quantity cannot be negative' };

  const delta = target - baselineOilG;
  const newMass = 100 + delta;
  if (newMass <= 0) return { error: 'implied negative food mass' };

  const absEnergy = Math.max(0, baseKcal + delta * KCAL_PER_G_OIL);
  const adjKcal = (absEnergy / newMass) * 100;

  const out = {
    adjusted: true,
    oil_level: level,
    baseline_oil_g_per_100g: round2(baselineOilG),
    target_oil_g_per_100g: round2(target),
    delta_oil_g_per_100g: round2(delta),
    energy_kcal_original: round1(baseKcal),
    energy_kcal_adjusted: round1(adjKcal),
    energy_delta_pct: baseKcal ? round1(((adjKcal - baseKcal) / baseKcal) * 100) : null
  };
  if (food.fat_g !== null && food.fat_g !== undefined) {
    out.fat_g_adjusted = round1((Math.max(0, food.fat_g + delta) / newMass) * 100);
  }
  for (const k of ['protein_g', 'carb_g']) {
    if (food[k] !== null && food[k] !== undefined) out[`${k}_adjusted`] = round1((food[k] / newMass) * 100);
  }
  if (oilType && delta > 0) {
    const split = fattyAcidSplit(oilType, delta);
    if (split) out.added_fat_profile = split;
    else out.added_fat_profile_note = `no measured fatty-acid profile for '${oilType}'`;
  }
  return out;
}

/** Coconut is 90.9% saturated and mustard 5.7% ΓÇö a 16x difference at
 *  identical calories ΓÇö so an unknown oil returns null rather than a
 *  default profile. */
function fattyAcidSplit(oilType, grams) {
  const p = OIL_FATTY_ACID_PROFILE[String(oilType || '').trim().toLowerCase()];
  if (!p || !grams) return null;
  return {
    oil_type: oilType,
    saturated_g: round2((grams * p.sfa) / 100),
    monounsaturated_g: round2((grams * p.mufa) / 100),
    polyunsaturated_g: round2((grams * p.pufa) / 100),
    source: 'IFCT2017 Table 12'
  };
}

// --------------------------------------------------------- portions -----
// Household portions users actually think in. A portion is a VOLUME, not a
// mass: one medium bowl of dal, of rice and of salad are three different
// weights. Volumes are CALIBRATED against ~900 real INDB serving weights
// (ml/src/validation/portion_calibration.py) -- overall bias 0.94, bowl
// 0.95, plate 0.98, i.e. essentially unbiased.
const VOLUME_PORTIONS = {
  teaspoon:      { ml: 5,    label: 'Teaspoon',      group: 'spoon' },
  tablespoon:    { ml: 25,   label: 'Tablespoon',    group: 'spoon' },
  serving_spoon: { ml: 45,   label: 'Serving spoon', group: 'spoon' },
  ladle:         { ml: 90,   label: 'Ladle',         group: 'spoon' },
  small_bowl:    { ml: 220,  label: 'Small bowl',    group: 'bowl' },
  katori:        { ml: 150,  label: 'Katori',        group: 'bowl' },
  medium_bowl:   { ml: 250,  label: 'Medium bowl',   group: 'bowl' },
  bowl:          { ml: 250,  label: 'Bowl',          group: 'bowl' },
  large_bowl:    { ml: 400,  label: 'Large bowl',    group: 'bowl' },
  soup_bowl:     { ml: 350,  label: 'Soup bowl',     group: 'bowl' },
  quarter_plate: { ml: 120,  label: 'Quarter plate', group: 'plate' },
  half_plate:    { ml: 200,  label: 'Half plate',    group: 'plate' },
  plate:         { ml: 350,  label: 'Regular plate', group: 'plate' },
  full_plate:    { ml: 500,  label: 'Full plate',    group: 'plate' },
  small_glass:   { ml: 150,  label: 'Small glass',   group: 'glass' },
  glass:         { ml: 330,  label: 'Glass',         group: 'glass' },
  tall_glass:    { ml: 350,  label: 'Tall glass',    group: 'glass' },
  tea_cup:       { ml: 150,  label: 'Tea cup',       group: 'glass' },
  cup:           { ml: 240,  label: 'Cup',           group: 'glass' },
  mug:           { ml: 300,  label: 'Mug',           group: 'glass' },
  handful:       { ml: 60,   label: 'Handful',       group: 'misc' },
  pinch:         { ml: 0.35, label: 'Pinch',         group: 'misc' }
};

// Counted items. NOT calibrated against INDB: its "1 egg" for boiled egg is
// 151 g (the whole dish with accompaniments) while one egg is ~50 g. Fitting
// to that figure would make every bare-egg entry wrong.
const COUNT_PORTIONS = {
  piece:   { label: 'Piece', group: 'count' },
  slice:   { label: 'Slice', group: 'count' },
  roti:    { label: 'Roti / chapati', group: 'count', grams: 40 },
  paratha: { label: 'Paratha', group: 'count', grams: 85 },
  dosa:    { label: 'Dosa', group: 'count', grams: 85 },
  idli:    { label: 'Idli', group: 'count', grams: 45 },
  poori:   { label: 'Poori', group: 'count', grams: 119 },
  samosa:  { label: 'Samosa', group: 'count', grams: 68 },
  vada:    { label: 'Vada', group: 'count', grams: 60 },
  ladoo:   { label: 'Ladoo', group: 'count', grams: 36 },
  biscuit: { label: 'Biscuit', group: 'count', grams: 19 },
  egg:     { label: 'Egg', group: 'count', grams: 50 },
  banana:  { label: 'Banana', group: 'count', grams: 120 },
  apple:   { label: 'Apple', group: 'count', grams: 180 }
};

// Real spread of measured servings, shown as a RANGE so the UI does not
// imply a precision that does not exist. A "bowl" is not a defined unit.
const OBSERVED_SPREAD = {
  bowl: [166, 354], medium_bowl: [166, 354], small_bowl: [181, 343],
  soup_bowl: [307, 398], plate: [236, 554], tall_glass: [304, 423],
  glass: [203, 411], cup: [191, 486], tablespoon: [16, 26],
  piece: [50, 234], slice: [73, 184]
};

const PORTION_ALIAS = {
  tbsp: 'tablespoon', tsp: 'teaspoon', bowls: 'bowl', plates: 'plate',
  'big bowl': 'large_bowl', 'regular plate': 'plate', 'half plate': 'half_plate',
  'serving spoon': 'serving_spoon', 'small glass': 'small_glass',
  'tall glass': 'tall_glass', 'tea cup': 'tea_cup', 'medium bowl': 'medium_bowl',
  'small bowl': 'small_bowl', 'large bowl': 'large_bowl', 'soup bowl': 'soup_bowl',
  'quarter plate': 'quarter_plate', 'full plate': 'full_plate'
};

// A cooked wet dish is not its dry ingredient: "Dal makhani" matches the dry
// dal density (0.85) but is served as a curry (~1.0). Ignoring this was the
// residual bias calibration found on bowls (0.87, corrected to 0.95).
const WET_DISH_RE = /curry|gravy|dal|daal|sambar|rasam|soup|stew|kadhi|korma|makhani|rajma|chole|kheer|halwa|raita|lassi|khichdi|porridge|upma|poha|pulao|biryani|rice/i;
const DRY_FINISHED_RE = /roasted|fried|papad|chips|namkeen|bhujia|biscuit|cookie|cracker|khakhra|toast|rusk|wafer/i;

function canonicalPortion(key) {
  const k = String(key || '').trim().toLowerCase().replace(/\s+/g, '_');
  const spaced = k.replace(/_/g, ' ');
  if (VOLUME_PORTIONS[k] || COUNT_PORTIONS[k]) return k;
  if (PORTION_ALIAS[spaced]) return PORTION_ALIAS[spaced];
  if (PORTION_ALIAS[k]) return PORTION_ALIAS[k];
  return null;
}

function effectiveDensity(foodName, cookingState) {
  const base = densityFor(foodName);
  if (cookingState === 'cooked' && WET_DISH_RE.test(foodName || '') &&
      !DRY_FINISHED_RE.test(foodName || '')) return Math.max(base, 1.0);
  return base;
}

/** Portions to offer for THIS food, each with the grams it would mean. */
function listPortions(foodName, cookingState) {
  const density = effectiveDensity(foodName, cookingState);
  const out = [];
  for (const key of Object.keys(VOLUME_PORTIONS)) {
    const spec = VOLUME_PORTIONS[key];
    const e = {
      key, label: spec.label, group: spec.group, basis: 'volume',
      volume_ml: spec.ml, grams: Math.round(spec.ml * density * 10) / 10
    };
    if (OBSERVED_SPREAD[key]) e.observed_range_g = OBSERVED_SPREAD[key];
    out.push(e);
  }
  for (const key of Object.keys(COUNT_PORTIONS)) {
    const spec = COUNT_PORTIONS[key];
    // a count portion only makes sense for a food that comes in that form:
    // offering "1 idli" for dal would be nonsense
    if (key !== 'piece' && key !== 'slice' &&
        !new RegExp(key, 'i').test(foodName || '')) continue;
    const e = { key, label: spec.label, group: spec.group, basis: 'count',
      grams: spec.grams === undefined ? null : spec.grams };
    if (OBSERVED_SPREAD[key]) e.observed_range_g = OBSERVED_SPREAD[key];
    out.push(e);
  }
  return out;
}

/** (portion, count) -> grams. Prefers the food's OWN measured serving where
 *  it has one, then a count reference, then volume x density. */
function portionToGrams(portionKey, count, opts) {
  const { foodName = '', cookingState = null, foodServingGrams = null } = opts || {};
  const key = canonicalPortion(portionKey);
  if (!key) return { grams: null, basis: 'unknown_portion', note: `'${portionKey}' is not a known portion` };
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return { grams: null, basis: 'bad_count', note: `bad count '${count}'` };

  if (foodServingGrams && ['bowl', 'katori', 'plate', 'piece', 'medium_bowl'].indexOf(key) !== -1) {
    return { grams: Math.round(n * foodServingGrams * 10) / 10, basis: 'measured_serving',
      note: 'this food publishes its own serving weight' };
  }
  if (COUNT_PORTIONS[key]) {
    const g = COUNT_PORTIONS[key].grams;
    if (g === undefined || g === null) {
      return { grams: null, basis: 'unknown_piece_weight', note: `no reference weight for one '${key}'` };
    }
    return { grams: Math.round(n * g * 10) / 10, basis: 'count', note: `${n} x ${g} g` };
  }
  const spec = VOLUME_PORTIONS[key];
  const d = effectiveDensity(foodName, cookingState);
  return { grams: Math.round(n * spec.ml * d * 10) / 10, basis: 'volume',
    note: `${n} x ${spec.ml}ml x ${d} g/ml` };
}

// -------------------------------------------------------- nutrition ------
const NUTRIENT_FIELDS = ['energy_kcal', 'protein_g', 'fat_g', 'carb_g', 'fiber_g',
  'sugar_g', 'sodium_mg', 'calcium_mg', 'iron_mg', 'potassium_mg'];

/** Scale a per-100g food to an actual portion. Nulls stay null ΓÇö a
 *  missing nutrient is UNKNOWN, and rendering it as 0 would tell a user a
 *  food contains none of something we simply never measured. */
function scaleNutrition(food, grams) {
  if (!(grams > 0)) return null;
  const factor = grams / 100;
  const totals = {};
  for (const k of NUTRIENT_FIELDS) {
    const v = food[k];
    totals[k] = (v === null || v === undefined) ? null : round2(v * factor);
  }
  return { grams: round1(grams), totals };
}

function round1(x) { return Math.round(x * 10) / 10; }
function round2(x) { return Math.round(x * 100) / 100; }

module.exports = {
  FoodSearch, normalize, toGrams, densityFor,
  expectedState, moistureMismatch,
  adjustOil, fattyAcidSplit, scaleNutrition,
  listPortions, portionToGrams, canonicalPortion, effectiveDensity,
  OIL_LEVELS, OIL_FATTY_ACID_PROFILE, KCAL_PER_G_OIL, MAX_PLAUSIBLE_KCAL,
  VOLUME_PORTIONS, COUNT_PORTIONS, OBSERVED_SPREAD,
  SOURCE_RANK
};
