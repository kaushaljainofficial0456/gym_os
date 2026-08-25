/**
 * skos-food-v1 — TIER 2 (compositional) JS REFERENCE IMPLEMENTATION
 *
 * WHERE THIS SITS (see CONTRACT_skos-food-v1.md):
 *   tier 1  exact / alias match      -> lab value, best possible
 *   tier 2  THIS FILE: ingredients known -> sum of lab values, near-lab accuracy
 *   tier 3  name only                -> kNN retrieval, ~15-25% median error
 *   tier 4  AI fallback              -> composition guess, backend-priced
 *
 * FAITHFUL PORT, NOT A REIMPLEMENTATION. This mirrors three Python modules
 * byte-for-byte in behaviour:
 *   ml/src/inference/portion_units.py      -> ingredientAmountToGrams()
 *   ml/src/inference/ingredient_aliases.py -> resolveIngredientName()
 *   ml/src/inference/compositional.py      -> CompositionalCalculator
 * Every table (density classes, piece weights, yield factors, the 199-entry
 * alias map) is copied from those files, not re-derived or approximated.
 *
 * NOT THE SAME AS foodEstimate.reference.js's toGrams()/densityFor():
 * that pair is a smaller, Tier-1-DISPLAY approximation (15 density classes,
 * 13 piece patterns) meant for showing a household-portion size next to a
 * search result. It is deliberately narrower than portion_units.py (20
 * density classes, 29 piece patterns, length units, the full unquantifiable
 * list) and reusing it here would silently change Tier 2's validated
 * accuracy for anything landing in the gap -- e.g. "2 tbsp chopped onion"
 * has no chopped_veg density class in the narrower table, so it would fall
 * through to water density (1.0) instead of the correct 0.55. This file
 * ports the FULL table instead, independently of that other one.
 *
 * Reuses the SAME FoodSearch engine every other tier uses (constructor
 * argument) -- ingredient resolution goes through the one measured
 * database, never a second data source.
 */

'use strict';

/* ==================================================================== *
 *  portion_units.py port — culinary unit -> grams                       *
 * ==================================================================== */

const ML_PER_UNIT = {
  tsp: 5.0, teaspoon: 5.0, teaspoons: 5.0,
  tbsp: 15.0, tablespoon: 15.0, tablespoons: 15.0,
  cup: 240.0, cups: 240.0,
  katori: 150.0,
  bowl: 250.0, 'small bowl': 180.0, 'soup bowl': 300.0,
  glass: 250.0, 'tall glass': 350.0, 'tea cup': 150.0,
  ml: 1.0, millilitre: 1.0, litre: 1000.0, l: 1000.0,
  drop: 0.05, drops: 0.05,
  pinch: 0.35, dash: 0.6,
};

const DENSITY_G_PER_ML = {
  oil: 0.92, ghee: 0.91, butter: 0.91,
  honey: 1.42, syrup: 1.33, jaggery_liquid: 1.30,
  milk: 1.03, curd: 1.03, cream: 0.99,
  sugar_granulated: 0.85, salt: 1.20,
  flour: 0.55, besan: 0.60, semolina: 0.75, rice_raw: 0.85,
  dal_raw: 0.85, spice_powder: 0.50, grated: 0.40,
  chopped_veg: 0.55, leafy: 0.25, nuts: 0.60,
  water: 1.0,
};

const DENSITY_PATTERNS = [
  ['oil', /\boil\b/i],
  ['ghee', /\bghee\b/i],
  ['butter', /\bbutter\b|\bmargarine\b|\bvanaspati\b/i],
  ['honey', /\bhoney\b/i],
  ['syrup', /\bsyrup\b|\bmolasses\b|\btreacle\b/i],
  ['milk', /\bmilk\b|\bbuttermilk\b|\bchaas\b/i],
  ['curd', /\bcurd\b|\bdahi\b|\byogh?urt\b/i],
  ['cream', /\bcream\b|\bmalai\b/i],
  ['sugar_granulated', /\bsugar\b|\bjaggery\b|\bgur\b/i],
  ['salt', /\bsalt\b|\bnamak\b/i],
  ['besan', /\bbesan\b|\bgram flour\b|\bchickpea flour\b/i],
  ['semolina', /\bsemolina\b|\bsuji\b|\brava\b/i],
  ['flour', /\bflour\b|\batta\b|\bmaida\b|\bstarch\b/i],
  ['rice_raw', /\brice\b|\bpoha\b|\bmurmura\b/i],
  ['dal_raw', /\bdal\b|\bdaal\b|\bgram\b|\blentil\b|\bbean\b|\bpea\b/i],
  ['spice_powder', /\bpowder\b|\bmasala\b|\bturmeric\b|\bhaldi\b|\bchilli\b|\bcumin\b|\bjeera\b|\bcoriander\b|\bdhania\b|\bgaram\b/i],
  ['grated', /\bgrated\b|\bshredded\b|\bdesiccated\b/i],
  ['leafy', /\bleaves\b|\bleaf\b|\bcoriander leaves\b|\bmint\b|\bpalak\b|\bspinach\b|\bmethi\b|\bcurry leaves\b/i],
  ['nuts', /\balmond\b|\bcashew\b|\bwalnut\b|\bpeanut\b|\bpistachio\b/i],
  ['chopped_veg', /\bchopped\b|\bdiced\b|\bsliced\b|\bcubed\b|\bonion\b|\btomato\b|\bpotato\b|\bcarrot\b/i],
];

const PIECE_GRAMS = [
  [/\begg\b/i, 50.0],
  [/\bclove\b.*\bgarlic\b|\bgarlic\b.*\bclove\b|\bcloves?\b/i, 3.0],
  [/\bonion\b/i, 110.0], [/\btomato\b/i, 100.0], [/\bpotato\b/i, 150.0],
  [/\bgreen chill?i(es)?\b|\bchill?i\b/i, 5.0],
  [/\blemon\b|\blime\b/i, 60.0],
  [/\bbanana\b/i, 120.0], [/\bapple\b/i, 180.0], [/\borange\b/i, 130.0],
  [/\bcurry leaf\b|\bcurry leaves\b|\bsprig\b/i, 1.0],
  [/\bbread\b|\bslice\b/i, 25.0],
  [/\broti\b|\bchapati\b/i, 40.0], [/\bdosa\b/i, 85.0], [/\bidli\b/i, 45.0],
  [/\bcashew\b/i, 1.5], [/\balmond\b/i, 1.2], [/\bwalnut\b/i, 5.0],
  [/\braisin\b|\bkishmish\b/i, 0.5],
  [/\bcardamom\b|\belaichi\b/i, 0.3],
  [/\bpepper ?corn\b/i, 0.05],
  [/\bcinnamon\b|\bdalchini\b/i, 2.0],
  [/\bbay leaf\b|\btej patta\b/i, 0.2],
  [/\bcoconut\b/i, 400.0],
  [/\bcucumber\b/i, 200.0], [/\bcarrot\b/i, 70.0],
  [/\bcapsicum\b|\bbell pepper\b/i, 120.0],
  [/\bbrinjal\b|\beggplant\b/i, 250.0],
  [/\bokra\b|\bbhindi\b|\blady.?s? finger\b/i, 10.0],
];

const COUNT_UNITS = new Set([
  'no', 'nos', 'no.', 'nos.', 'piece', 'pieces', 'pc', 'pcs',
  'clove', 'cloves', 'slice', 'slices', 'cube', 'cubes',
  'sprig', 'sprigs', 'stick', 'sticks', 'flake', 'flakes',
  'medium', 'small', 'large', 'whole', 'pepper corns', 'lemon',
]);

const SIZE_SCALE = { small: 0.65, medium: 1.0, large: 1.5 };

const LENGTH_GRAMS_PER_UNIT = { inch: 8.0, cm: 3.0 };

const UNQUANTIFIABLE_RE = /to taste|as required|as needed|as per|enough|few|handful|garnish|for frying|for greasing|a little|optional|pinch of salt/i;

function densityForIngredient(foodName) {
  for (const [cls, rx] of DENSITY_PATTERNS) {
    if (rx.test(foodName || '')) return [DENSITY_G_PER_ML[cls], cls];
  }
  return [DENSITY_G_PER_ML.water, 'water_default'];
}

function pieceGramsForIngredient(foodName) {
  for (const [rx, g] of PIECE_GRAMS) {
    if (rx.test(foodName || '')) return g;
  }
  return null;
}

/**
 * Port of portion_units.py's to_grams(). Returns { grams, method, note }.
 * grams is null when the quantity is genuinely unquantifiable or the unit
 * is unrecognised -- never a silent guess.
 */
function ingredientAmountToGrams(amount, unit, foodName = '') {
  const unitRaw = String(unit || '').trim().toLowerCase();
  if (UNQUANTIFIABLE_RE.test(unitRaw) || UNQUANTIFIABLE_RE.test(String(amount || ''))) {
    return { grams: null, method: 'unquantifiable', note: `'${unitRaw || amount}' has no measurable quantity` };
  }

  const amt = Number(String(amount).trim());
  if (!Number.isFinite(amt)) {
    return { grams: null, method: 'unparseable_amount', note: `could not read amount '${amount}'` };
  }
  if (amt <= 0) {
    return { grams: null, method: 'non_positive', note: 'amount must be > 0' };
  }

  let u = unitRaw.replace(/\(.*?\)/g, '').trim();
  u = u.replace(/[^a-z. ]/g, '').trim();

  // mass units first -- no density needed
  if (u === 'g' || u === 'gram' || u === 'grams' || u === 'gm' || u === 'gms') {
    return { grams: amt, method: 'mass', note: null };
  }
  if (u === 'kg' || u === 'kilogram' || u === 'kilograms') {
    return { grams: amt * 1000.0, method: 'mass', note: null };
  }
  if (u === 'mg') {
    return { grams: amt / 1000.0, method: 'mass', note: null };
  }

  // volume units -> density
  if (Object.prototype.hasOwnProperty.call(ML_PER_UNIT, u)) {
    const ml = amt * ML_PER_UNIT[u];
    const [dens, cls] = densityForIngredient(foodName);
    return { grams: ml * dens, method: 'volume', note: `${ml.toFixed(1)}ml x ${dens} g/ml (${cls})` };
  }

  // length units (ginger, cinnamon stick)
  if (Object.prototype.hasOwnProperty.call(LENGTH_GRAMS_PER_UNIT, u)) {
    return { grams: amt * LENGTH_GRAMS_PER_UNIT[u], method: 'length', note: null };
  }

  // count units -> per-piece reference weight
  if (COUNT_UNITS.has(u) || u === '') {
    const pg = pieceGramsForIngredient(foodName);
    const scale = Object.prototype.hasOwnProperty.call(SIZE_SCALE, u) ? SIZE_SCALE[u] : 1.0;
    if (pg !== null) {
      return { grams: amt * pg * scale, method: 'count', note: `${amt} x ${pg}g/piece` };
    }
    return { grams: null, method: 'unknown_piece_weight', note: `no reference weight for one '${foodName}'` };
  }

  return { grams: null, method: 'unknown_unit', note: `unit '${unitRaw}' not recognised` };
}

/* ==================================================================== *
 *  ingredient_aliases.py port — recipe term -> measured-food query      *
 * ==================================================================== */

const INGREDIENT_ALIASES = {
  oil: 'sunflower oil', fat: 'sunflower oil', 'cooking oil': 'sunflower oil',
  'refined oil': 'sunflower oil', 'vegetable oil': 'sunflower oil', 'salad oil': 'sunflower oil',
  'mustard oil': 'mustard oil', 'coconut oil': 'coconut oil', 'olive oil': 'olive oil',
  'sesame oil': 'sesame oil', 'groundnut oil': 'peanut oil', 'peanut oil': 'peanut oil',
  butter: 'butter, salted', 'unsalted butter': 'butter, unsalted', ghee: 'clarified butter ghee',
  margarine: 'margarine', cream: 'cream, fresh', 'fresh cream': 'cream, fresh', malai: 'cream, fresh',
  curd: 'curd', curds: 'curd', dahi: 'curd', yoghurt: 'curd', yogurt: 'curd', 'hung curd': 'curd',
  buttermilk: 'buttermilk', milk: 'milk, whole, cow', 'whole milk': 'milk, whole, cow',
  'skimmed milk': 'milk, skim', 'toned milk': 'milk, whole, cow',
  'condensed milk': 'milk, condensed, sweetened', 'evaporated milk': 'milk, evaporated',
  'milk powder': 'milk powder, whole', khoa: 'khoa', mawa: 'khoa', paneer: 'paneer',
  cheese: 'cheese, processed', 'processed cheese': 'cheese, processed', 'cheese spread': 'cheese, processed',
  mozzarella: 'cheese, mozzarella', 'refined flour': 'wheat flour, refined',
  'refined wheat flour': 'wheat flour, refined', maida: 'wheat flour, refined',
  'all purpose flour': 'wheat flour, refined', 'wheat flour': 'wheat flour, atta',
  'whole wheat flour': 'wheat flour, atta', atta: 'wheat flour, atta',
  besan: 'chickpea flour', 'gram flour': 'chickpea flour', cornflour: 'corn starch',
  'corn flour': 'corn starch', cornstarch: 'corn starch', 'rice flour': 'rice flour',
  semolina: 'wheat, semolina', suji: 'wheat, semolina', rava: 'wheat, semolina', sooji: 'wheat, semolina',
  'bread crumbs': 'bread crumbs, dry', breadcrumbs: 'bread crumbs, dry',
  sugar: 'sugar, white', 'castor sugar': 'sugar, white', 'caster sugar': 'sugar, white',
  'powdered sugar': 'sugar, white', 'icing sugar': 'sugar, white', 'brown sugar': 'sugar, brown',
  jaggery: 'jaggery', gur: 'jaggery', honey: 'honey',
  pepper: 'pepper, black', 'pepper powder': 'pepper, black', 'black pepper': 'pepper, black',
  peppercorn: 'pepper, black', peppercorns: 'pepper, black',
  'red chilli powder': 'chillies, red', 'chilli powder': 'chillies, red', 'chili powder': 'chillies, red',
  'red chilli': 'chillies, red', 'dry red chilli': 'chillies, red',
  'green chilli': 'chillies, green - all varieties', 'green chillies': 'chillies, green - all varieties',
  turmeric: 'turmeric powder', 'turmeric powder': 'turmeric powder', haldi: 'turmeric powder',
  cumin: 'cumin seeds', 'cumin seeds': 'cumin seeds', jeera: 'cumin seeds', 'cumin powder': 'cumin seeds',
  'coriander powder': 'coriander seeds', 'coriander seeds': 'coriander seeds', dhania: 'coriander seeds',
  'garam masala': 'garam masala', clove: 'cloves syzygium', cloves: 'cloves syzygium', laung: 'cloves syzygium',
  cardamom: 'cardamom, green', 'green cardamom': 'cardamom, green', 'black cardamom': 'cardamom, black',
  elaichi: 'cardamom, green', 'bay leaf': 'bay leaf', 'tej patta': 'bay leaf',
  'mustard seeds': 'mustard seeds', rai: 'mustard seeds',
  'fenugreek seeds': 'fenugreek seeds', 'methi seeds': 'fenugreek seeds',
  asafoetida: 'asafoetida', hing: 'asafoetida', fennel: 'spices, fennel seed', saunf: 'spices, fennel seed',
  nutmeg: 'nutmeg', saffron: 'saffron', kesar: 'saffron',
  'kasuri methi': 'fenugreek leaves, dried', 'poppy seeds': 'poppy seeds', 'khus khus': 'poppy seeds',
  onion: 'onion', onions: 'onion', 'spring onion': 'onion, spring', garlic: 'garlic',
  ginger: 'ginger, fresh', 'ginger garlic paste': 'ginger, fresh',
  tomato: 'tomato, ripe', tomatoes: 'tomato, ripe', 'tomato puree': 'tomato puree',
  'coriander leaves': 'coriander leaves', 'curry leaves': 'curry leaves', 'mint leaves': 'mint leaves',
  pudina: 'mint leaves', spinach: 'spinach', palak: 'spinach', potato: 'potato', aloo: 'potato',
  carrot: 'carrot', peas: 'peas, green', 'green peas': 'peas, green', matar: 'peas, green',
  capsicum: 'capsicum, green', cauliflower: 'cauliflower', cabbage: 'cabbage', brinjal: 'brinjal',
  okra: 'okra', bhindi: 'okra', cucumber: 'cucumber', beetroot: 'beetroot', mushroom: 'mushroom',
  'lemon juice': 'lemon juice', 'lime juice': 'lemon juice',
  coconut: 'coconut meat, raw', 'grated coconut': 'coconut meat, raw', 'desiccated coconut': 'coconut, desiccated',
  'coconut milk': 'coconut milk', rice: 'rice, raw milled', 'basmati rice': 'rice, raw milled',
  'toor dal': 'red gram, dal', 'arhar dal': 'red gram, dal', 'moong dal': 'green gram, dal',
  'urad dal': 'black gram, dal', 'chana dal': 'bengal gram, dal', 'masoor dal': 'lentil, dal',
  rajma: 'rajmah', chana: 'bengal gram, whole', chickpeas: 'bengal gram, whole',
  poha: 'rice, parboiled, milled', sabudana: 'sago', vermicelli: 'wheat, vermicelli',
  egg: 'egg, poultry, whole, raw', eggs: 'egg, poultry, whole, raw',
  'egg white': 'egg, poultry, white, raw', 'egg yolk': 'egg, poultry, yolk, raw',
  chicken: 'chicken, poultry, breast, skinless', pork: 'pork, back ribs, lean', beef: 'beef, round leg',
  bacon: 'pork, bacon, raw', ham: 'ham, sliced, regular', mutton: 'goat, round leg',
  lamb: 'sheep, round leg', fish: 'fish, indian mackerel', prawns: 'prawn',
  keema: 'goat, round leg', 'minced meat': 'goat, round leg',
  'baking powder': 'baking powder', 'baking soda': 'baking soda', 'soda bicarbonate': 'baking soda',
  yeast: "yeast, baker's", vinegar: 'vinegar', salt: 'salt, table', water: 'water',
  'cocoa powder': 'cocoa powder, unsweetened', cashew: 'cashew nut', cashewnut: 'cashew nut',
  almond: 'almond', raisins: 'raisins', kishmish: 'raisins', walnut: 'walnut',
  peanut: 'peanuts, raw', groundnut: 'peanuts, raw', 'sesame seeds': 'sesame seeds', til: 'sesame seeds',
  tamarind: 'tamarind pulp', imli: 'tamarind pulp',
};

const NEGLIGIBLE_TERMS = new Set([
  'vanilla essence', 'vanilla extract', 'essence', 'food colour', 'food color', 'colouring',
  'rose essence', 'kewra', 'kewra water', 'rose water', 'edible silver foil', 'silver foil',
  'varak', 'toothpick', 'banana leaf', 'muslin cloth', 'butter paper', 'ice cubes', 'ice',
]);

const NOISE_WORDS = new Set([
  'finely', 'chopped', 'grated', 'sliced', 'diced', 'cubed', 'minced', 'boiled', 'fresh', 'dried',
  'roasted', 'raw', 'washed', 'soaked', 'powdered', 'powder', 'ground', 'crushed', 'peeled', 'shelled',
  'boneless', 'bone', 'with', 'without', 'and', 'or', 'of', 'the', 'small', 'medium', 'large', 'big',
  'ripe', 'unripe', 'tender', 'pieces', 'piece', 'cut', 'cleaned', 'trimmed', 'lean', 'curry', 'boti',
  'cubes', 'strips', 'mince', 'seeds', 'seed', 'leaves', 'leaf',
]);

const QUALIFIER_PREFIXES = [
  'finely chopped ', 'chopped ', 'grated ', 'sliced ', 'boiled ', 'fresh ',
  'dried ', 'roasted ', 'raw ', 'washed ', 'soaked ', 'powdered ',
];

function coreTokens(text) {
  const toks = (String(text || '').toLowerCase().match(/[a-z]+/g)) || [];
  return toks.filter((t) => !NOISE_WORDS.has(t));
}

/**
 * Port of resolve_ingredient(). Returns { query, isNegligible }.
 * query === null means "no reliable mapping -- report unresolved rather
 * than guess" (only reachable via the negligible path here).
 */
function resolveIngredientName(name) {
  const raw = String(name || '').trim().toLowerCase();
  if (!raw) return { query: null, isNegligible: false };
  if (NEGLIGIBLE_TERMS.has(raw)) return { query: null, isNegligible: true };
  if (Object.prototype.hasOwnProperty.call(INGREDIENT_ALIASES, raw)) {
    return { query: INGREDIENT_ALIASES[raw], isNegligible: false };
  }

  for (const qual of QUALIFIER_PREFIXES) {
    if (raw.startsWith(qual)) {
      const sub = raw.slice(qual.length).trim();
      if (NEGLIGIBLE_TERMS.has(sub)) return { query: null, isNegligible: true };
      if (Object.prototype.hasOwnProperty.call(INGREDIENT_ALIASES, sub)) {
        return { query: INGREDIENT_ALIASES[sub], isNegligible: false };
      }
    }
  }

  for (const n of NEGLIGIBLE_TERMS) {
    if (raw.includes(n)) return { query: null, isNegligible: true };
  }

  const ingTokens = new Set(coreTokens(raw));
  if (ingTokens.size) {
    let bestKey = null;
    let bestLen = 0;
    for (const key of Object.keys(INGREDIENT_ALIASES)) {
      const kTokens = coreTokens(key);
      if (!kTokens.length) continue;
      if (kTokens.every((t) => ingTokens.has(t)) && kTokens.length > bestLen) {
        bestKey = key;
        bestLen = kTokens.length;
      }
    }
    if (bestKey) return { query: INGREDIENT_ALIASES[bestKey], isNegligible: false };
  }

  return { query: name, isNegligible: false }; // fall through to plain search
}

/* ==================================================================== *
 *  compositional.py port — price a dish from its ingredients            *
 * ==================================================================== */

const NUTRIENT_FIELDS = [
  'energy_kcal', 'protein_g', 'fat_g', 'carb_g', 'fiber_g', 'sugar_g',
  'sodium_mg', 'calcium_mg', 'iron_mg', 'potassium_mg', 'magnesium_mg',
  'zinc_mg', 'phosphorus_mg', 'vitamin_c_mg', 'folate_b9_ug',
  'thiamine_b1_mg', 'riboflavin_b2_mg', 'niacin_b3_mg',
];

const YIELD_FACTORS = [
  [/\brice\b|\bpoha\b|\bbroken wheat\b|\bdaliya\b|\bbulgur\b|\bquinoa\b/i, 2.6],
  [/\bpasta\b|\bnoodle|\bmacaroni\b|\bvermicelli\b|\bsemiya\b/i, 2.4],
  [/\bdal\b|\bdaal\b|\blentil\b|\bgram\b|\bbean\b|\brajma\b|\bchana\b|\bchickpea\b|\bmoong\b|\burad\b|\btoor\b|\bmasoor\b/i, 2.5],
  [/\bsemolina\b|\bsuji\b|\brava\b/i, 2.8],
  [/\bflour\b|\batta\b|\bmaida\b|\bbesan\b/i, 1.4],
  [/\bchicken\b|\bmutton\b|\blamb\b|\bbeef\b|\bpork\b|\bkeema\b|\bmince\b/i, 0.75],
  [/\bfish\b|\bprawn\b|\bshrimp\b/i, 0.80],
  [/\begg\b/i, 0.90],
  [/\bspinach\b|\bpalak\b|\bmethi\b|\bleaves\b|\bleafy\b/i, 0.45],
  [/\bonion\b|\btomato\b|\bcabbage\b|\bcauliflower\b|\bgourd\b|\bokra\b|\bbhindi\b|\bbrinjal\b|\beggplant\b|\bcapsicum\b|\bmushroom\b/i, 0.70],
  [/\bpotato\b|\baloo\b|\bcarrot\b|\bbeetroot\b|\byam\b|\bsweet potato\b/i, 0.90],
  [/\bwater\b/i, 0.35],
  [/\bmilk\b|\bcurd\b|\bdahi\b|\byogh?urt\b/i, 0.85],
  [/\boil\b|\bghee\b|\bbutter\b/i, 1.0],
  [/\bsugar\b|\bjaggery\b|\bsalt\b|\bpowder\b|\bmasala\b|\bspice\b/i, 1.0],
];

const RENDERED_FAT_RE = /tallow|lard|dripping|suet|shortening|animal fat|rendered fat|fat, chicken|fat, beef|fat, pork|fat, mutton|fat, duck|bologna|salami|pepperoni|hot dog|frankfurter|luncheon meat|deli-meat|deli meat|loaf, chicken|macaroni and cheese loaf/i;

const CONDIMENT_RE = /chutney|masala|icing|pickle|achar|filling|dip|sauce|jam|spread|powder|paste|marinade|dressing|syrup|glaze|seasoning/i;

const FAT_INGREDIENT_RE = /oil|ghee|butter|tallow|lard|dripping|suet|margarine|vanaspati|fat/i;

function yieldFactorFor(name) {
  for (const [rx, y] of YIELD_FACTORS) {
    if (rx.test(name || '')) return y;
  }
  return 1.0;
}

function round1(x) { return Math.round(x * 10) / 10; }
function round2(x) { return Math.round(x * 100) / 100; }

class CompositionalCalculator {
  /** @param {object} search - a FoodSearch instance (same one every other tier uses) */
  constructor(search) {
    this.search = search;
    this._bySourceId = new Map((search?.foods || []).map((f) => [f.source_id, f]));
  }

  /**
   * Public entry point for resolving a single ingredient name to a
   * measured food row, without pricing a whole dish -- reused by Tier 4
   * (foodAI.js) to ground AI-proposed components through the SAME curated
   * alias map + dish-exclusion + rendered-fat safety net Tier 2 itself
   * uses, instead of a second, narrower resolution path. Returns
   * { row, cookingState, negligible }; row is null when unresolved.
   */
  lookupIngredient(ingredientName) {
    return this._lookup(ingredientName);
  }

  /**
   * Resolve an ingredient to a measured food. Port of _lookup().
   * Returns { row, cookingState, negligible }.
   */
  _lookup(ingredientName) {
    const { query, isNegligible } = resolveIngredientName(ingredientName);
    if (isNegligible) return { row: null, cookingState: null, negligible: true };
    if (query === null) return { row: null, cookingState: null, negligible: false };

    let results = this.search.search(query, { limit: 12 }) || [];
    if (!results.length && query !== ingredientName) {
      results = this.search.search(ingredientName, { limit: 12 }) || [];
    }
    if (!results.length) return { row: null, cookingState: null, negligible: false };

    // An INGREDIENT must resolve to an ingredient, never a composite DISH.
    const ingredientOnly = results.filter((r) => {
      const full = this._bySourceId.get(r.source_id);
      return r.source !== 'INDB' && (full?.category) !== 'indian_dish';
    });
    let pool = ingredientOnly.length ? ingredientOnly : results;

    // SAFETY NET: never let a normal ingredient resolve to rendered fat,
    // unless the ingredient itself is asking for fat/oil.
    if (!FAT_INGREDIENT_RE.test(ingredientName)) {
      const nonFat = pool.filter((r) => !RENDERED_FAT_RE.test(r.food_name || ''));
      pool = nonFat.length ? nonFat : pool;
    }

    const rawFirst = pool.filter((r) => r.cooking_state === 'raw');
    const unspec = pool.filter((r) => r.cooking_state === 'unspecified');
    const pick = (rawFirst.length ? rawFirst : unspec.length ? unspec : pool)[0];
    const row = this._bySourceId.get(pick.source_id) || pick;
    return { row, cookingState: pick.cooking_state, negligible: false };
  }

  /**
   * ingredients: [{ name, amount, unit }, ...]
   * Returns totals for the whole dish, per serving, and per 100g of
   * finished food, with per-ingredient provenance -- port of compute().
   */
  compute(ingredients, { servings = 1, dishName = null } = {}) {
    const totals = {};
    for (const k of NUTRIENT_FIELDS) totals[k] = 0.0;
    let rawMass = 0.0;
    let cookedMass = 0.0;
    const lines = [];
    const unresolved = [];

    for (const ing of ingredients || []) {
      const name = String(ing?.name || '').trim();
      if (!name) continue;

      const { grams, method, note } = ingredientAmountToGrams(ing.amount, ing.unit, name);
      if (grams === null) {
        unresolved.push({ ingredient: name, reason: note, amount: ing.amount, unit: ing.unit });
        continue;
      }

      const { row: food, cookingState: matchedState, negligible } = this._lookup(name);
      if (negligible) continue; // trace item: handled, not a failure
      if (!food || food.energy_kcal == null) {
        unresolved.push({ ingredient: name, grams: round1(grams), reason: 'no measured food matched this ingredient' });
        continue;
      }

      const factor = grams / 100.0;
      const contrib = {};
      for (const k of NUTRIENT_FIELDS) {
        const v = food[k];
        if (v !== null && v !== undefined) {
          contrib[k] = v * factor;
          totals[k] += contrib[k];
        }
      }

      // Yield only applies to a RAW-measured match; a cooked DB entry
      // already bakes the mass change in.
      let yf, yieldBasis;
      if (matchedState === 'cooked') {
        yf = 1.0;
        yieldBasis = 'matched food already cooked; no yield applied';
      } else {
        yf = yieldFactorFor(name);
        yieldBasis = 'raw ingredient; yield factor applied';
      }
      rawMass += grams;
      cookedMass += grams * yf;

      lines.push({
        ingredient: name,
        matched_food: food.food_name,
        matched_source: food.source,
        grams: round1(grams),
        conversion: method,
        conversion_note: note,
        yield_factor: yf,
        yield_basis: yieldBasis,
        matched_cooking_state: matchedState,
        energy_kcal: round1(contrib.energy_kcal || 0.0),
      });
    }

    if (!lines.length) {
      return { ok: false, reason: 'no ingredient could be both measured and matched', unresolved };
    }

    const out = {
      ok: true,
      dish_name: dishName,
      tier: 2,
      method: 'compositional: measured ingredients summed',
      servings,
      raw_mass_g: round1(rawMass),
      estimated_cooked_mass_g: round1(cookedMass),
      ingredients_used: lines.length,
      ingredients: lines,
      unresolved,
      totals: Object.fromEntries(Object.entries(totals).filter(([, v]) => v).map(([k, v]) => [k, round2(v)])),
    };
    if (servings > 0) {
      out.per_serving = Object.fromEntries(Object.entries(totals).filter(([, v]) => v).map(([k, v]) => [k, round2(v / servings)]));
    }
    if (cookedMass > 0) {
      out.per_100g_cooked = Object.fromEntries(Object.entries(totals).filter(([, v]) => v).map(([k, v]) => [k, round2((v / cookedMass) * 100.0)]));
    }

    if (dishName && CONDIMENT_RE.test(dishName)) {
      out.serving_caveat = 'this is a condiment/spice blend: the whole-batch totals are reliable, but a per-serving figure depends on how much of the batch is actually eaten, which no recipe fixes. Validation shows 54% median error per-serving for this class vs 25% for main dishes -- prefer logging the amount actually consumed.';
    }

    const missingNamed = unresolved.filter((u) => u.grams != null).length;
    out.coverage = {
      resolved_ingredients: lines.length,
      unresolved_ingredients: unresolved.length,
      unresolved_with_known_mass: missingNamed,
    };
    if (unresolved.length === 0) {
      out.confidence = 'high';
    } else if (missingNamed === 0) {
      out.confidence = 'high';
      out.note = 'unresolved items are unquantifiable seasonings (to taste / for garnish); their nutritional contribution is negligible';
    } else if (lines.length >= 2 * unresolved.length) {
      out.confidence = 'medium';
    } else {
      out.confidence = 'low';
      out.note = 'a large share of ingredients could not be matched; totals are incomplete, not merely approximate';
    }
    return out;
  }
}

module.exports = {
  CompositionalCalculator,
  resolveIngredientName,
  ingredientAmountToGrams,
  yieldFactorFor,
  densityForIngredient,
  pieceGramsForIngredient,
  NUTRIENT_FIELDS,
  INGREDIENT_ALIASES,
  NEGLIGIBLE_TERMS,
  NOISE_WORDS,
};
