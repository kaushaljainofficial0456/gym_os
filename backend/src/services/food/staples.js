// ============================================================
// EVERYDAY STAPLES — which food a common word means, and how people
// measure it. Curation, not new nutrition data.
//
// WHY THIS EXISTS. The food index holds 21,353 rows from five databases,
// and for the words people type most it answered the wrong question:
//
//   "chai"            -> "SILK Chai, soymilk"
//   "tea"             -> an OFF product row claiming 20 g protein / 100 ml
//   "bread"           -> "Bread, potato"
//   "chicken breast"  -> "...stewed, skin eaten"
//   "boiled egg"      -> a 45 kcal / 100 g row, labelled high confidence
//   quick-add         -> 100 g of everything; "1 egg" was unit 23 of 23
//
// The database is right to contain soy chai and potato bread. What was
// missing is the layer every serious tracker has: a short, hand-checked
// list saying which row the everyday word means, with the units people
// actually think in ("2 roti", "1 cup chai", "1 katori dal").
//
// NUMBERS COME FROM THE INDEX, NOT FROM HERE. Each staple points (`ref`)
// at a measured row -- INDB / IFCT 2017 for Indian dishes and ingredients,
// USDA / CNF for single ingredients, OFF Indian labels for packaged staples
// -- and search, the parser and the resolver return THAT row, byte for
// byte. This module chooses; it does not re-measure.
//
// The one exception is a staple whose best row is missing or implausible
// against independent references, where an `inline` value is carried with
// its basis stated. The implausible rows, so the overrides can be argued
// with rather than taken on trust:
//
//   INDB "Plain dosa"           381 kcal / 100 g   plain dosa is ~170-210
//   INDB "Sweet Lassi"           36 kcal / 100 ml  curd + sugar is ~75-95
//   INDB "Khaman (dhokla)"       55 kcal / 100 g   dhokla is ~160-220
//   USDA "Pakora"               125 kcal / 100 g   deep-fried fritters ~250-300
//   INDB poori, kadhi, butter chicken, rasgulla -- already quarantined by
//     the index's own data-quality flags (frying-bath contamination)
//   USDA "Biscuit"                 an American scone, not an Indian biscuit
//
// UNITS. Containers and countable foods defer to the catalogue in
// ml/models/skos-food-v1 (katori 150 ml x density, roti 40 g, idli 45 g)
// so there is ONE definition of a katori in the product, and a dish's own
// measured INDB serving still wins where the catalogue already lets it.
// A fixed weight is used only where the catalogue is wrong for that food:
// an Indian tea cup is 150 ml, not a 240 ml US cup; an Indian glass of milk
// is 250 ml, not 330; a bowl of poha is not 250 g of a wet dish.
// ============================================================
'use strict';

/* ── unit specs ─────────────────────────────────────────────────────── */

// A catalogue unit: grams come from portionToGrams (volume x the row's
// density, or the row's own measured serving, or the catalogue's count
// weight). `count` marks a countable piece -- what a bare number means.
const cat = (key, label = key) => ({ key, label, catalogue: true });
const catCount = (key, label = key) => ({ key, label, catalogue: true, count: true });
// A fixed weight, for units the catalogue lacks or gets wrong for this food.
const fix = (key, label, g) => ({ key, label, g });
const fixCount = (key, label, g) => ({ key, label, g, count: true });

const KATORI = cat('katori');
const BOWL = cat('bowl');
const PLATE = cat('plate');
const TSP = cat('teaspoon', 'tsp');
const TBSP = cat('tablespoon', 'tbsp');
const HANDFUL = cat('handful');
const CUP_TEA = fix('cup', 'cup', 150);         // Indian tea cup
const GLASS = fix('glass', 'glass', 250);       // Indian steel glass
const G100 = fix('g100', '100 g', 100);

/* ── the list ───────────────────────────────────────────────────────── */

/**
 * S(key, displayName, kind, opts)
 *   opts.ref      source_id of the measured row this word means
 *   opts.inline   [kcal, protein, carbs, fat, fiber] per 100 g, ONLY when
 *                 there is no trustworthy ref; requires opts.basis
 *   opts.units    natural units, the FIRST is the default
 *   opts.aliases  other names (Hindi / regional), lowercase
 *   opts.vague    aliases that are umbrella words ("sabzi", "biryani",
 *                 "chicken"): they still mean this staple, but at MEDIUM
 *                 confidence, because the person may have eaten a variant
 *   opts.alts     staple keys offered as "did you mean" when they would
 *                 change the answer (cow vs buffalo milk, boiled vs fried egg)
 */
const S = (key, name, kind, opts) => ({ key, name, kind, ...opts });

const STAPLES = [
  /* ---------------- breads ---------------- */
  S('roti', 'Roti / Chapati', 'bread', {
    ref: 'indb:ASC096',
    aliases: ['roti', 'chapati', 'chapatti', 'chapathi', 'phulka', 'fulka', 'wheat roti', 'atta roti', 'tawa roti'],
    units: [catCount('roti')],
  }),
  S('paratha', 'Paratha (plain)', 'bread', {
    ref: 'indb:ASC097',
    aliases: ['paratha', 'parantha', 'plain paratha', 'lachha paratha', 'tawa paratha'],
    vague: ['paratha', 'parantha'],
    alts: ['aloo_paratha'],
    units: [catCount('paratha')],
  }),
  S('aloo_paratha', 'Aloo paratha', 'bread', {
    ref: 'indb:ASC098',
    aliases: ['aloo paratha', 'aloo parantha', 'potato paratha', 'alu paratha'],
    units: [fixCount('paratha', 'paratha', 130)],
  }),
  S('puri', 'Puri', 'bread', {
    ref: 'usda:2707714',                         // INDB poori rows are quarantined
    aliases: ['puri', 'poori', 'pooris', 'puris'],
    units: [fixCount('puri', 'puri', 28)],       // catalogue's 119 g is several puris
  }),
  S('naan', 'Naan', 'bread', {
    ref: 'indb:ASC142',
    aliases: ['naan', 'nan', 'butter naan', 'plain naan', 'tandoori naan'],
    units: [fixCount('naan', 'naan', 90)],
  }),
  S('white_bread', 'Bread (white)', 'bread', {
    ref: 'usda:174924',
    aliases: ['bread', 'white bread', 'sandwich bread', 'bread slice', 'slice of bread',
      'bread slices', 'slices of bread', 'slice bread', 'slices bread'],
    units: [fixCount('slice', 'slice', 25)],
  }),
  S('toast', 'Toast (white bread)', 'bread', {
    ref: 'usda:2707599',
    aliases: ['toast', 'toasts', 'bread toast', 'toasted bread', 'white toast', 'dry toast'],
    units: [fixCount('slice', 'slice', 22)],      // a 25 g slice loses ~12% water toasting
  }),
  S('brown_bread', 'Bread (brown)', 'bread', {
    ref: 'usda:172688',
    aliases: ['brown bread', 'whole wheat bread', 'wheat bread', 'atta bread', 'multigrain bread'],
    units: [fixCount('slice', 'slice', 28)],
  }),

  /* ---------------- rice and grain dishes ---------------- */
  S('white_rice', 'Rice (cooked)', 'grain', {
    ref: 'usda:2708402',
    aliases: ['rice', 'white rice', 'chawal', 'steamed rice', 'plain rice', 'boiled rice', 'cooked rice', 'basmati rice'],
    units: [KATORI, PLATE, fix('cup', 'cup', 160)],
  }),
  S('brown_rice', 'Brown rice (cooked)', 'grain', {
    ref: 'usda:169704',
    aliases: ['brown rice'],
    units: [KATORI, PLATE, fix('cup', 'cup', 160)],
  }),
  S('jeera_rice', 'Jeera rice', 'grain', {
    inline: [151, 3.0, 27, 3.5, 0.6], basis: 'recipe', note: 'cooked rice with ~4 g ghee per 100 g; no measured row',
    aliases: ['jeera rice', 'cumin rice', 'zeera rice'],
    units: [KATORI, PLATE],
  }),
  S('chicken_biryani', 'Chicken biryani', 'grain', {
    inline: [170, 8.0, 20, 6.5, 0.8], basis: 'recipe',
    note: 'no measured chicken biryani row (USDA "Biryani with chicken" 104 kcal is low-confidence); between INDB mutton (191) and veg (175)',
    aliases: ['biryani', 'biriyani', 'chicken biryani', 'chicken biriyani', 'hyderabadi biryani'],
    vague: ['biryani', 'biriyani'],
    alts: ['veg_biryani', 'mutton_biryani'],
    units: [fix('plate', 'plate', 300), KATORI],
  }),
  S('mutton_biryani', 'Mutton biryani', 'grain', {
    ref: 'indb:ASC122',
    aliases: ['mutton biryani', 'mutton biriyani', 'gosht biryani'],
    units: [fix('plate', 'plate', 300), KATORI],
  }),
  S('veg_biryani', 'Veg biryani', 'grain', {
    ref: 'indb:ASC123',
    aliases: ['veg biryani', 'vegetable biryani', 'veg biriyani'],
    units: [fix('plate', 'plate', 300), KATORI],
  }),
  S('veg_pulao', 'Veg pulao', 'grain', {
    ref: 'indb:BFP136',
    aliases: ['pulao', 'veg pulao', 'pulav', 'vegetable pulao', 'matar pulao', 'peas pulao'],
    units: [PLATE, KATORI],
  }),
  S('khichdi', 'Khichdi', 'grain', {
    ref: 'indb:ASC487',
    aliases: ['khichdi', 'khichri', 'khichadi', 'dal khichdi', 'veg khichdi'],
    units: [BOWL, KATORI],
  }),
  S('curd_rice', 'Curd rice', 'grain', {
    ref: 'indb:ASC126',
    aliases: ['curd rice', 'dahi chawal', 'thayir sadam', 'mosaranna', 'dahi bhaat'],
    units: [BOWL, KATORI],
  }),
  S('poha', 'Poha', 'grain', {
    ref: 'indb:BFP045',
    aliases: ['poha', 'pohe', 'aval', 'kanda poha', 'batata poha', 'vegetable poha'],
    units: [BOWL, PLATE],
  }),
  S('upma', 'Upma', 'grain', {
    ref: 'usda:2709128',                         // the bare word; rava upma is its own staple
    aliases: ['upma', 'uppittu'],
    alts: ['rava_upma'],
    units: [BOWL, KATORI],
  }),
  S('rava_upma', 'Rava upma', 'grain', {
    ref: 'indb:BFP039',
    aliases: ['rava upma', 'suji upma', 'sooji upma', 'semolina upma'],
    units: [BOWL, KATORI],
  }),
  S('oats', 'Oats (dry)', 'grain', {
    ref: 'usda:169705',
    aliases: ['oats', 'rolled oats', 'quaker oats', 'instant oats', 'oats dry'],
    units: [fix('half_cup', '½ cup', 40), fix('cup', 'cup', 80), TBSP],
  }),
  S('oats_porridge', 'Oats porridge (with milk)', 'grain', {
    inline: [114, 5.4, 15, 3.7, 1.8], basis: 'recipe', note: '40 g oats + 200 ml toned milk; no measured row',
    aliases: ['oats porridge', 'oatmeal', 'oats with milk', 'porridge', 'milk oats'],
    units: [BOWL, KATORI],
  }),
  S('cornflakes', 'Cornflakes', 'grain', {
    ref: 'off:8901499008190',
    aliases: ['cornflakes', 'corn flakes', 'kelloggs cornflakes'],
    units: [fix('cup', 'cup', 30), fix('bowl', 'bowl', 45)],
  }),
  S('idli', 'Idli', 'grain', {
    ref: 'indb:ASC144',
    aliases: ['idli', 'idly', 'idlis', 'rice idli'],
    units: [catCount('idli')],
  }),
  S('dosa', 'Dosa (plain)', 'grain', {
    ref: 'usda:2708347',                         // INDB plain dosa (381) is implausible
    aliases: ['dosa', 'plain dosa', 'sada dosa', 'dosai', 'dosas'],
    units: [catCount('dosa')],
  }),
  S('masala_dosa', 'Masala dosa', 'grain', {
    ref: 'indb:ASC146',
    aliases: ['masala dosa', 'masala dosai', 'mysore masala dosa'],
    units: [fixCount('dosa', 'dosa', 210)],      // INDB's own serving for this dish
  }),

  /* ---------------- dal, curries, sabzi ---------------- */
  S('dal', 'Dal', 'dish', {
    ref: 'usda:2707427',
    aliases: ['dal', 'daal', 'dahl', 'toor dal', 'arhar dal', 'moong dal', 'masoor dal', 'yellow dal', 'plain dal', 'dal fry'],
    alts: ['dal_makhani'],
    units: [KATORI, BOWL],
  }),
  S('dal_tadka', 'Dal tadka', 'dish', {
    inline: [110, 5.0, 12, 4.6, 2.4], basis: 'recipe', note: 'thick dal with ghee tadka; no measured row',
    aliases: ['dal tadka', 'tadka dal', 'dal tarka'],
    units: [KATORI, BOWL],
  }),
  S('dal_makhani', 'Dal makhani', 'dish', {
    ref: 'indb:OSR139',
    aliases: ['dal makhani', 'dal makhni', 'maa ki dal', 'kaali dal'],
    units: [KATORI, BOWL],
  }),
  S('rajma', 'Rajma', 'dish', {
    ref: 'indb:ASC165',
    aliases: ['rajma', 'rajmah', 'rajma curry', 'rajma masala', 'kidney bean curry'],
    units: [KATORI, BOWL],
  }),
  S('chole', 'Chole', 'dish', {
    ref: 'indb:ASC162',
    aliases: ['chole', 'chhole', 'chana masala', 'chickpea curry', 'chole masala', 'pindi chole'],
    units: [KATORI, BOWL],
  }),
  S('sambar', 'Sambar', 'dish', {
    ref: 'indb:ASC167',
    aliases: ['sambar', 'sambhar', 'saambar'],
    units: [KATORI, BOWL],
  }),
  S('kadhi', 'Kadhi', 'dish', {
    inline: [95, 3.0, 8, 5.5, 0.5], basis: 'recipe', note: 'besan + curd, light tadka; INDB kadhi is quarantined',
    aliases: ['kadhi', 'kadi', 'punjabi kadhi', 'gujarati kadhi'],
    units: [KATORI, BOWL],
  }),
  S('paneer_butter_masala', 'Paneer butter masala', 'dish', {
    ref: 'indb:ASC222',
    aliases: ['paneer butter masala', 'paneer makhani', 'butter paneer', 'shahi paneer', 'paneer masala', 'kadai paneer'],
    units: [KATORI, BOWL],
  }),
  S('palak_paneer', 'Palak paneer', 'dish', {
    ref: 'indb:ASC215',
    aliases: ['palak paneer', 'saag paneer', 'spinach paneer'],
    units: [KATORI, BOWL],
  }),
  S('mix_veg', 'Mixed veg sabzi', 'veg', {
    inline: [86, 2.5, 9, 4.5, 3.0], basis: 'recipe', note: 'seasonal vegetables, ~4 g oil per 100 g; no measured mixed-veg row',
    aliases: ['sabzi', 'sabji', 'subzi', 'mix veg', 'mixed veg', 'mixed vegetable', 'veg sabzi', 'vegetable curry'],
    vague: ['sabzi', 'sabji', 'subzi', 'veg sabzi', 'vegetable curry'],
    units: [KATORI, BOWL],
  }),
  S('aloo_sabzi', 'Aloo sabzi', 'veg', {
    ref: 'indb:BFP239',
    aliases: ['aloo sabzi', 'aloo sabji', 'potato sabzi', 'aloo bhaji', 'jeera aloo', 'aloo curry', 'aloo ki sabzi'],
    units: [KATORI, BOWL],
  }),
  S('bhindi', 'Bhindi fry', 'veg', {
    ref: 'indb:BFP269',
    aliases: ['bhindi', 'bhindi fry', 'bhindi masala', 'okra fry', 'bhendi', 'bhindi sabzi'],
    vague: ['bhindi', 'bhendi'],
    units: [KATORI],
  }),
  S('chicken_curry', 'Chicken curry', 'dish', {
    ref: 'indb:ASC240',
    aliases: ['chicken curry', 'chicken masala', 'chicken gravy', 'murgh curry', 'kadai chicken'],
    units: [KATORI, BOWL],
  }),
  S('butter_chicken', 'Butter chicken', 'dish', {
    inline: [189, 13, 6, 12.5, 0.8], basis: 'recipe', note: 'restaurant-style; INDB butter chicken is quarantined',
    aliases: ['butter chicken', 'murgh makhani', 'chicken makhani'],
    units: [KATORI, BOWL],
  }),
  S('chicken_tikka_masala', 'Chicken tikka masala', 'dish', {
    inline: [148, 12, 6, 8.5, 1.0], basis: 'recipe',
    note: 'grilled tikka in a tomato-cream gravy; no measured row (the index has none by this name)',
    aliases: ['chicken tikka masala', 'tikka masala', 'murgh tikka masala'],
    units: [KATORI, BOWL],
  }),
  S('egg_curry', 'Egg curry', 'dish', {
    ref: 'indb:BFP240',
    aliases: ['egg curry', 'anda curry', 'egg masala', 'anda masala'],
    units: [KATORI, BOWL],
  }),
  S('fish_curry', 'Fish curry', 'dish', {
    ref: 'indb:ASC246',
    aliases: ['fish curry', 'machli curry', 'macher jhol', 'fish masala'],
    units: [KATORI, BOWL],
  }),
  S('mutton_curry', 'Mutton curry', 'dish', {
    inline: [198, 15, 3, 14, 0.6], basis: 'recipe', note: 'goat on the bone, edible portion; no measured mutton-curry row',
    aliases: ['mutton curry', 'mutton', 'goat curry', 'mutton masala', 'rogan josh', 'lamb curry'],
    vague: ['mutton'],
    units: [KATORI, BOWL],
  }),

  /* ---------------- eggs, meat, fish ---------------- */
  S('egg_boiled', 'Egg (boiled)', 'protein', {
    ref: 'usda:173424',                          // INDB "Boiled egg" (45 kcal) is a recipe row, not an egg
    aliases: ['egg', 'eggs', 'boiled egg', 'boiled eggs', 'hard boiled egg', 'anda', 'ubla anda', 'whole egg'],
    vague: ['egg', 'eggs', 'anda', 'whole egg'],
    alts: ['egg_fried', 'omelette'],
    units: [catCount('egg')],
  }),
  S('egg_white', 'Egg white', 'protein', {
    ref: 'usda:172183',
    aliases: ['egg white', 'egg whites', 'boiled egg white'],
    units: [fixCount('egg', 'egg white', 33)],
  }),
  S('omelette', 'Omelette', 'protein', {
    ref: 'usda:172185',
    aliases: ['omelette', 'omelet', 'egg omelette', 'masala omelette', 'anda omelette'],
    units: [fixCount('egg', 'egg', 60)],         // per egg used, incl. oil
  }),
  S('egg_fried', 'Fried egg', 'protein', {
    ref: 'indb:ASC057',
    aliases: ['fried egg', 'sunny side up', 'egg fry', 'half fry', 'bullseye'],
    units: [fixCount('egg', 'egg', 46)],
  }),
  S('egg_bhurji', 'Egg bhurji (scrambled)', 'protein', {
    ref: 'indb:ASC059',
    aliases: ['egg bhurji', 'anda bhurji', 'bhurji', 'scrambled egg', 'scrambled eggs'],
    units: [fixCount('egg', 'egg', 61)],
  }),
  S('chicken_breast', 'Chicken breast (cooked, skinless)', 'protein', {
    ref: 'cnf:842',
    aliases: ['chicken breast', 'chicken', 'boiled chicken', 'grilled chicken', 'grilled chicken breast', 'chicken breast cooked'],
    vague: ['chicken'],
    alts: ['chicken_breast_raw'],
    units: [G100, fixCount('piece', 'breast', 170)],
  }),
  S('chicken_breast_raw', 'Chicken breast (raw)', 'protein', {
    inline: [120, 22.5, 0, 2.6, 0], basis: 'usda', note: 'USDA SR raw skinless breast; not present in the index',
    aliases: ['raw chicken breast', 'chicken breast raw', 'uncooked chicken breast'],
    units: [G100],
  }),
  S('tandoori_chicken', 'Tandoori chicken', 'protein', {
    ref: 'indb:ASC241',
    aliases: ['tandoori chicken', 'chicken tikka', 'chicken tandoori'],
    units: [fixCount('piece', 'piece', 100)],
  }),
  S('fish_grilled', 'Fish (grilled)', 'protein', {
    ref: 'usda:2706272',
    aliases: ['fish', 'grilled fish', 'baked fish', 'fish fillet'],
    vague: ['fish'],
    units: [G100, fixCount('piece', 'fillet', 120)],
  }),
  S('prawns', 'Prawns (cooked)', 'protein', {
    ref: 'usda:2706362',
    aliases: ['prawns', 'shrimp', 'jhinga'],
    units: [G100, KATORI],
  }),

  /* ---------------- dairy and vegetarian protein ---------------- */
  // Plain "milk" in India is toned milk: 3.0% fat, 8.5% SNF. USDA's 3.25%
  // "Milk, whole" (61 kcal) is that composition within 5%, and unbranded --
  // a user who names no brand is asking for the food, not one dairy's
  // carton. "cup" is a measuring cup (240 ml) here: "1.5 cups milk" is a
  // recipe amount, unlike a cup of chai.
  S('milk', 'Milk (toned)', 'dairy', {
    ref: 'usda:2705385',
    aliases: ['milk', 'doodh', 'toned milk', 'plain milk', 'glass of milk'],
    alts: ['milk_full', 'milk_buffalo', 'milk_skim'],
    units: [GLASS, cat('cup'), fix('ml100', '100 ml', 100)],
  }),
  S('milk_full', 'Milk (full cream)', 'dairy', {
    ref: 'off:8906009501017',                    // Indian full cream is 6% fat; no unbranded 6% row
    aliases: ['full cream milk', 'whole milk', 'full fat milk'],
    units: [GLASS, cat('cup')],
  }),
  S('milk_cow', 'Cow milk (whole)', 'dairy', {
    ref: 'ifct:L002',
    aliases: ['cow milk', 'desi cow milk', 'gir cow milk', 'a2 milk'],
    units: [GLASS, cat('cup')],
  }),
  S('milk_buffalo', 'Buffalo milk', 'dairy', {
    ref: 'ifct:L001',
    aliases: ['buffalo milk', 'bhains ka doodh', 'bhains doodh'],
    units: [GLASS, cat('cup')],
  }),
  S('milk_skim', 'Milk (skimmed)', 'dairy', {
    ref: 'cnf:114',
    aliases: ['skim milk', 'skimmed milk', 'double toned milk', 'fat free milk'],
    units: [GLASS, cat('cup')],
  }),
  S('curd', 'Curd / Dahi', 'dairy', {
    ref: 'usda:171284',                          // plain whole-milk yogurt = home dahi, unbranded
    aliases: ['curd', 'dahi', 'yogurt', 'yoghurt', 'plain curd', 'homemade curd'],
    alts: ['greek_yogurt'],
    units: [KATORI, fix('cup', 'cup', 245), TBSP],
  }),
  S('greek_yogurt', 'Greek yogurt', 'dairy', {
    ref: 'off:8904083302292',
    aliases: ['greek yogurt', 'greek yoghurt', 'hung curd'],
    units: [fix('cup', 'cup', 170), KATORI],
  }),
  S('paneer', 'Paneer', 'dairy', {
    ref: 'ifct:L003',
    aliases: ['paneer', 'cottage cheese', 'panir', 'raw paneer'],
    // A "piece" is tikka-sized (~6 to a 180 g restaurant portion); a cube is
    // the smaller dice that goes into a curry.
    units: [G100, fixCount('piece', 'piece', 30), fixCount('cube', 'cube', 20)],
  }),
  S('tofu', 'Tofu', 'protein', {
    ref: 'off:8908001927116',
    aliases: ['tofu', 'soya paneer', 'bean curd'],
    units: [G100],
  }),
  S('soya_chunks', 'Soya chunks (dry)', 'protein', {
    ref: 'off:8906040412976',
    aliases: ['soya chunks', 'soya', 'soy chunks', 'nutrela', 'meal maker', 'soya nuggets'],
    vague: ['soya'],
    units: [fix('cup', 'cup (dry)', 50), G100],
  }),
  S('chickpeas', 'Chickpeas (boiled)', 'protein', {
    ref: 'usda:173757',
    aliases: ['chickpeas', 'boiled chana', 'chana', 'kabuli chana', 'chana salad', 'kala chana'],
    vague: ['chana'],
    units: [KATORI, fix('cup', 'cup', 164)],
  }),
  S('sprouts', 'Moong sprouts', 'protein', {
    ref: 'usda:2709764',
    aliases: ['sprouts', 'moong sprouts', 'sprouted moong', 'mung sprouts', 'sprout salad'],
    units: [KATORI, fix('cup', 'cup', 104)],
  }),
  S('whey', 'Whey protein', 'supplement', {
    inline: [400, 78, 8, 6, 0], basis: 'label',
    note: 'category-typical tub: 32 g scoop = ~25 g protein; the index has no generic whey row -- check your tub',
    aliases: ['whey', 'whey protein', 'protein powder', 'protein shake', 'whey isolate', 'scoop whey', 'protein'],
    vague: ['protein', 'protein shake', 'protein powder'],
    units: [fix('scoop', 'scoop', 32), fix('half_scoop', '½ scoop', 16)],
  }),
  S('cheese_slice', 'Cheese slice', 'dairy', {
    ref: 'off:8901648004264',
    aliases: ['cheese slice', 'cheese', 'processed cheese'],
    vague: ['cheese'],
    units: [fixCount('slice', 'slice', 20)],
  }),

  /* ---------------- drinks ---------------- */
  S('chai', 'Chai (milk tea, with sugar)', 'beverage', {
    inline: [60, 2.1, 8.5, 2.0, 0], basis: 'recipe',
    note: 'per 150 ml cup: 100 ml toned milk, 50 ml water, 2 tsp sugar. The index has no plain Indian chai row: INDB "Hot tea" (16 kcal) is milk-less, and a top-ranked OFF "Tea" row claims 20 g protein',
    aliases: ['chai', 'tea', 'masala chai', 'milk tea', 'cutting chai', 'adrak chai', 'ginger tea', 'elaichi chai', 'chaha', 'cha', 'indian tea', 'tea with milk', 'chai with milk'],
    alts: ['chai_no_sugar'],
    units: [CUP_TEA, fix('cutting', 'cutting (½ cup)', 75), fix('mug', 'mug', 250), fix('glass', 'glass', 200)],
  }),
  S('chai_no_sugar', 'Chai (no sugar)', 'beverage', {
    inline: [39, 2.1, 3.1, 2.0, 0], basis: 'recipe', note: 'same chai, no sugar',
    aliases: ['chai without sugar', 'tea without sugar', 'sugar free chai', 'chai no sugar', 'tea no sugar', 'sugarless tea'],
    units: [CUP_TEA, fix('mug', 'mug', 250)],
  }),
  S('coffee', 'Coffee (with milk and sugar)', 'beverage', {
    inline: [64, 2.6, 8.4, 2.3, 0], basis: 'recipe', note: 'per 150 ml: 120 ml toned milk, 2 tsp sugar; no measured row',
    aliases: ['coffee', 'milk coffee', 'filter coffee', 'nescafe', 'cold coffee', 'hot coffee', 'kaapi'],
    alts: ['black_coffee'],
    units: [CUP_TEA, fix('mug', 'mug', 250)],
  }),
  S('black_coffee', 'Black coffee', 'beverage', {
    ref: 'usda:2710375',
    aliases: ['black coffee', 'americano', 'espresso', 'coffee without milk'],
    units: [CUP_TEA, fix('mug', 'mug', 250)],
  }),
  S('green_tea', 'Green tea', 'beverage', {
    ref: 'cnf:7624',
    aliases: ['green tea'],
    units: [fix('cup', 'cup', 200)],
  }),
  S('black_tea', 'Black tea (no milk)', 'beverage', {
    ref: 'usda:2710488',
    aliases: ['black tea', 'lemon tea', 'tea without milk', 'kali chai', 'kahwa'],
    units: [fix('cup', 'cup', 200)],
  }),
  S('lassi', 'Lassi (sweet)', 'beverage', {
    ref: 'off:8901648001775',                    // INDB sweet lassi (36) is implausible
    aliases: ['lassi', 'sweet lassi', 'meethi lassi'],
    alts: ['chaas'],
    units: [GLASS],
  }),
  S('chaas', 'Buttermilk / Chaas', 'beverage', {
    ref: 'indb:ASC022',
    aliases: ['chaas', 'buttermilk', 'chhaas', 'mattha', 'majjige', 'salted lassi'],
    units: [GLASS],
  }),
  S('coconut_water', 'Coconut water', 'beverage', {
    ref: 'ifct:K002',
    aliases: ['coconut water', 'nariyal pani', 'tender coconut', 'elaneer'],
    units: [GLASS, fix('coconut', 'coconut', 300)],
  }),
  S('orange_juice', 'Orange juice', 'beverage', {
    ref: 'usda:169098',
    aliases: ['orange juice', 'mosambi juice', 'sweet lime juice', 'fresh juice'],
    vague: ['fresh juice'],
    units: [GLASS],
  }),
  S('cola', 'Cola', 'beverage', {
    ref: 'off:8901764012914',
    aliases: ['cola', 'coke', 'coca cola', 'pepsi', 'soft drink', 'thums up', 'cold drink'],
    vague: ['soft drink', 'cold drink'],
    units: [fix('can', 'can', 330), GLASS, fix('bottle', 'bottle', 500)],
  }),
  S('beer', 'Beer', 'beverage', {
    ref: 'usda:2710616',
    aliases: ['beer', 'lager'],
    units: [fix('can', 'can', 330), fix('bottle', 'bottle', 650), fix('pint', 'pint', 500)],
  }),

  /* ---------------- fruit (IFCT for Indian cultivars where measured) ---------------- */
  S('banana', 'Banana', 'fruit', {
    ref: 'usda:2709224',
    aliases: ['banana', 'kela', 'bananas', 'ripe banana'],
    units: [catCount('banana'), fixCount('small', 'small banana', 100), fixCount('large', 'large banana', 136)],
  }),
  S('apple', 'Apple', 'fruit', {
    ref: 'ifct:E001',
    aliases: ['apple', 'seb', 'apples'],
    units: [catCount('apple')],
  }),
  S('orange', 'Orange', 'fruit', {
    ref: 'usda:2709171',
    aliases: ['orange', 'santra', 'oranges', 'mosambi', 'sweet lime', 'kinnow'],
    units: [fixCount('orange', 'orange', 130)],
  }),
  S('mango', 'Mango', 'fruit', {
    ref: 'usda:2709242',
    aliases: ['mango', 'aam', 'mangoes', 'alphonso'],
    units: [fixCount('mango', 'mango', 200), fix('cup', 'cup (sliced)', 165)],
  }),
  S('papaya', 'Papaya', 'fruit', {
    ref: 'ifct:E049',
    aliases: ['papaya', 'papita'],
    units: [fix('cup', 'cup', 145), KATORI],
  }),
  S('watermelon', 'Watermelon', 'fruit', {
    ref: 'usda:167765',
    aliases: ['watermelon', 'tarbooz', 'tarbuj'],
    units: [fix('cup', 'cup', 152), fixCount('slice', 'slice', 280)],
  }),
  S('grapes', 'Grapes', 'fruit', {
    ref: 'usda:2709237',
    aliases: ['grapes', 'angoor', 'angur'],
    units: [fix('cup', 'cup', 151), HANDFUL],
  }),
  S('pomegranate', 'Pomegranate', 'fruit', {
    ref: 'usda:2709267',
    aliases: ['pomegranate', 'anar', 'pomegranate seeds'],
    units: [fix('cup', 'cup (seeds)', 174), KATORI],
  }),
  S('guava', 'Guava', 'fruit', {
    ref: 'usda:2709238',
    aliases: ['guava', 'amrood', 'peru'],
    units: [fixCount('guava', 'guava', 100)],
  }),
  S('pineapple', 'Pineapple', 'fruit', {
    ref: 'ifct:E053',
    aliases: ['pineapple', 'ananas'],
    units: [fix('cup', 'cup', 165), fixCount('slice', 'slice', 84)],
  }),
  S('dates', 'Dates', 'fruit', {
    ref: 'ifct:E019',
    aliases: ['dates', 'date', 'khajur', 'khajoor', 'medjool'],
    units: [fixCount('date', 'date', 9)],
  }),

  /* ---------------- vegetables (plain) ---------------- */
  S('salad', 'Green salad', 'veg', {
    inline: [20, 1.0, 4, 0.2, 1.6], basis: 'usda', note: 'cucumber, tomato, onion, lettuce, no dressing (USDA component values)',
    aliases: ['salad', 'green salad', 'cucumber salad', 'kachumber', 'veg salad', 'mixed salad'],
    units: [KATORI, BOWL],
  }),
  S('potato_boiled', 'Potato (boiled)', 'veg', {
    ref: 'usda:170114',
    aliases: ['boiled potato', 'potato', 'aloo', 'boiled aloo'],
    vague: ['potato', 'aloo'],
    units: [fixCount('potato', 'potato', 150), KATORI],
  }),
  S('sweet_potato', 'Sweet potato (boiled)', 'veg', {
    ref: 'usda:2709702',
    aliases: ['sweet potato', 'shakarkandi', 'shakarkand'],
    units: [fixCount('potato', 'sweet potato', 150), KATORI],
  }),

  /* ---------------- nuts, seeds, fats, sugar ---------------- */
  S('almonds', 'Almonds', 'nut', {
    ref: 'usda:170567',
    aliases: ['almonds', 'almond', 'badam', 'soaked almonds'],
    units: [fix('handful', 'handful', 28), fixCount('almond', 'almond', 1.2), fix('cup', 'cup', 143)],
  }),
  S('peanuts', 'Peanuts', 'nut', {
    ref: 'usda:2707514',
    aliases: ['peanuts', 'peanut', 'moongphali', 'mungfali', 'groundnuts', 'raw peanuts'],
    units: [fix('handful', 'handful', 30), TBSP, fix('cup', 'cup', 146)],
  }),
  S('peanuts_roasted', 'Peanuts (roasted)', 'nut', {
    ref: 'usda:2707519',
    aliases: ['roasted peanuts', 'roasted peanut', 'dry roasted peanuts', 'roasted groundnuts', 'bhuni moongphali'],
    units: [fix('handful', 'handful', 30), TBSP, fix('cup', 'cup', 146)],
  }),
  S('cashews', 'Cashews', 'nut', {
    ref: 'usda:2707494',
    aliases: ['cashews', 'cashew', 'kaju', 'cashew nuts'],
    units: [fix('handful', 'handful', 28), fixCount('cashew', 'cashew', 1.5), fix('cup', 'cup', 137)],
  }),
  S('walnuts', 'Walnuts', 'nut', {
    ref: 'usda:170187',
    aliases: ['walnuts', 'walnut', 'akhrot'],
    units: [fix('handful', 'handful', 28), fixCount('half', 'walnut half', 2), fix('cup', 'cup', 117)],
  }),
  S('peanut_butter', 'Peanut butter', 'fat', {
    ref: 'usda:2707537',
    aliases: ['peanut butter', 'pb', 'pintola'],
    units: [fix('tablespoon', 'tbsp', 16), fix('teaspoon', 'tsp', 5)],
  }),
  S('ghee', 'Ghee', 'fat', {
    ref: 'usda:171314',
    aliases: ['ghee', 'desi ghee', 'clarified butter'],
    units: [fix('teaspoon', 'tsp', 5), fix('tablespoon', 'tbsp', 14)],
  }),
  S('butter', 'Butter', 'fat', {
    ref: 'cnf:118',
    aliases: ['butter', 'amul butter', 'makhan'],
    units: [fix('teaspoon', 'tsp', 5), fix('tablespoon', 'tbsp', 14), fix('cube', 'restaurant cube', 10)],
  }),
  S('oil', 'Cooking oil', 'fat', {
    inline: [884, 0, 0, 100, 0], basis: 'usda', note: 'all vegetable oils are 884 kcal / 100 g',
    // A named oil (olive, mustard, coconut) is left to its own index row:
    // same energy, but the user asked for that oil, not "cooking oil".
    aliases: ['oil', 'cooking oil', 'refined oil', 'vegetable oil'],
    units: [fix('teaspoon', 'tsp', 4.5), fix('tablespoon', 'tbsp', 13.5)],
  }),
  S('sugar', 'Sugar', 'sweet', {
    ref: 'usda:169655',
    aliases: ['sugar', 'cheeni', 'white sugar'],
    units: [fix('teaspoon', 'tsp', 4), fix('tablespoon', 'tbsp', 12.5)],
  }),
  S('honey', 'Honey', 'sweet', {
    ref: 'usda:169640',
    aliases: ['honey', 'shahad'],
    units: [fix('teaspoon', 'tsp', 7), fix('tablespoon', 'tbsp', 21)],
  }),

  /* ---------------- snacks and sweets ---------------- */
  S('samosa', 'Samosa', 'snack', {
    ref: 'usda:2708730',                         // INDB samosa rows are quarantined
    aliases: ['samosa', 'samosas', 'aloo samosa'],
    units: [catCount('samosa')],
  }),
  S('vada_pav', 'Vada pav', 'snack', {
    inline: [200, 5.0, 28, 7.5, 2.0], basis: 'recipe', note: 'pav + potato vada + chutney; no measured row',
    aliases: ['vada pav', 'vada pao', 'wada pav'],
    units: [fixCount('piece', 'vada pav', 150)],
  }),
  S('pani_puri', 'Pani puri', 'snack', {
    // Composed from this index's own measured rows, per 25 g piece: 7 g
    // fried puri shell (usda:2707714), 5 g boiled potato (usda:170114),
    // 3 g boiled chickpeas (usda:173757), 2.5 g sonth chutney
    // (indb:ASC281) in 7.5 g spiced water. 6 pieces ~250 kcal, the top of
    // the published 150-250 range. Without it "4 pani puri" was 400 g.
    inline: [166, 3.5, 21.7, 7.3, 2.4], basis: 'recipe',
    note: 'composed from measured shell, filling and pani rows; no measured pani puri row exists',
    aliases: ['pani puri', 'pani puris', 'panipuri', 'pani poori', 'golgappa', 'golgappe', 'gol gappa', 'gol gappe', 'puchka', 'phuchka'],
    units: [fixCount('piece', 'pani puri', 25), fix('plate', 'plate (6)', 150)],
  }),
  S('spring_roll', 'Spring roll (veg)', 'snack', {
    ref: 'cnf:6346',                             // INDB spring roll is quarantined (frying bath counted)
    aliases: ['spring roll', 'spring rolls', 'veg spring roll', 'veg spring rolls', 'vegetable spring roll'],
    // A street / restaurant spring roll, not the 78 g egg roll the row was
    // measured as a serving of.
    units: [fixCount('roll', 'roll', 50)],
  }),
  S('pakora', 'Pakora', 'snack', {
    inline: [282, 6.0, 25, 17.5, 3.0], basis: 'recipe', note: 'besan-battered, deep-fried; USDA "Pakora" (125 kcal) is implausible for a fritter',
    aliases: ['pakora', 'pakoda', 'pakodas', 'bhajiya', 'bhaji', 'onion pakora', 'pakoras'],
    units: [fixCount('piece', 'piece', 20), fix('plate', 'plate', 120)],
  }),
  S('medu_vada', 'Medu vada', 'snack', {
    ref: 'usda:2709130',                         // INDB urad vada rows are quarantined
    aliases: ['medu vada', 'vada', 'vadai', 'urad vada'],
    vague: ['vada', 'vadai'],
    units: [catCount('vada')],
  }),
  S('dhokla', 'Dhokla', 'snack', {
    ref: 'indb:ASC474',                          // not "Khaman (dhokla)" at 55 kcal
    aliases: ['dhokla', 'khaman', 'khaman dhokla'],
    units: [fixCount('piece', 'piece', 30), fix('plate', 'plate', 150)],
  }),
  S('biscuit', 'Biscuit (Marie / glucose)', 'snack', {
    inline: [451, 7.0, 72, 15, 2.0], basis: 'label', note: 'Indian glucose / Marie biscuit labels; USDA "Biscuit" is an American scone',
    aliases: ['biscuit', 'biscuits', 'marie biscuit', 'parle g', 'glucose biscuit', 'cookie', 'cookies'],
    vague: ['biscuit', 'biscuits', 'cookie', 'cookies'],
    units: [fixCount('biscuit', 'biscuit', 7)],
  }),
  S('namkeen', 'Namkeen / Bhujia', 'snack', {
    ref: 'off:8904063240224',
    aliases: ['namkeen', 'bhujia', 'aloo bhujia', 'mixture', 'chivda', 'sev'],
    vague: ['namkeen', 'mixture'],
    units: [fix('handful', 'handful', 30), KATORI],
  }),
  S('chips', 'Potato chips', 'snack', {
    ref: 'usda:2709422',
    aliases: ['chips', 'potato chips', 'lays', 'wafers', 'crisps'],
    units: [fix('packet', 'small packet', 26), fix('handful', 'handful', 20)],
  }),
  S('gulab_jamun', 'Gulab jamun', 'sweet', {
    inline: [371, 4.0, 55, 15, 0.5], basis: 'recipe', note: 'with absorbed syrup; packaged-mix label values vary 81-420',
    aliases: ['gulab jamun', 'gulab jamuns'],
    units: [fixCount('piece', 'piece', 40)],
  }),
  S('jalebi', 'Jalebi', 'sweet', {
    inline: [383, 2.0, 60, 15, 0.5], basis: 'recipe', note: 'maida batter fried, soaked in syrup; no measured row',
    aliases: ['jalebi', 'jalebis', 'jilapi'],
    units: [fixCount('piece', 'piece', 25)],
  }),
  S('ladoo', 'Besan ladoo', 'sweet', {
    ref: 'indb:ASC343',
    aliases: ['ladoo', 'laddu', 'laddoo', 'besan ladoo', 'motichoor ladoo', 'boondi ladoo'],
    vague: ['ladoo', 'laddu', 'laddoo'],
    units: [catCount('ladoo')],
  }),
  S('rasgulla', 'Rasgulla', 'sweet', {
    inline: [186, 4.0, 38, 2.0, 0], basis: 'recipe', note: 'with syrup; INDB rasgulla is quarantined',
    aliases: ['rasgulla', 'rasagola', 'rosogolla', 'rasgullas'],
    units: [fixCount('piece', 'piece', 50)],
  }),
  S('kheer', 'Kheer', 'sweet', {
    ref: 'indb:ASC282',
    aliases: ['kheer', 'payasam', 'rice kheer', 'rice pudding'],
    units: [KATORI],
  }),
];

/* ── matching ───────────────────────────────────────────────────────── */

/** Lowercase, strip accents/punctuation, collapse whitespace. */
export function normStaple(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Unit words that can lead a food name the parser left intact
 *  ("scoop whey", "pack maggi"). Stripped before matching. */
const LEADING_UNIT_WORDS = new Set([
  'scoop', 'scoops', 'pack', 'packet', 'packets', 'piece', 'pieces', 'pc', 'pcs',
  'cup', 'cups', 'bowl', 'bowls', 'plate', 'plates', 'glass', 'glasses', 'katori',
  'slice', 'slices', 'serving', 'servings', 'of', 'a', 'an', 'some', 'my',
]);

function stripLeadingUnits(norm) {
  const toks = norm.split(' ');
  while (toks.length > 1 && LEADING_UNIT_WORDS.has(toks[0])) toks.shift();
  return toks.join(' ');
}

const FILLER = new Set(['of', 'a', 'an', 'some', 'my']);

/**
 * The unit word a food name still starts with, if any: "cup almonds" ->
 * "cup". The parser leaves one there when filler sits between the amount and
 * the unit ("half a cup of almonds"); the name is matched without it, but the
 * amount is still a cup, not half an almond.
 */
export function leadingUnit(name) {
  const toks = normStaple(name).split(' ');
  for (const t of toks.slice(0, -1)) {
    if (FILLER.has(t)) continue;
    return LEADING_UNIT_WORDS.has(t) ? t : null;
  }
  return null;
}

const BY_ALIAS = new Map();     // normalized phrase -> staple
const ALIAS_LIST = [];          // [{ phrase, tokens, staple }]
const VAGUE = new Set();        // "<key>|<phrase>" for umbrella aliases
for (const st of STAPLES) {
  const phrases = new Set([normStaple(st.name), ...st.aliases.map(normStaple)]);
  for (const v of st.vague || []) VAGUE.add(`${st.key}|${normStaple(v)}`);
  for (const p of phrases) {
    if (!p) continue;
    if (!BY_ALIAS.has(p)) BY_ALIAS.set(p, st);
    ALIAS_LIST.push({ phrase: p, tokens: p.split(' '), staple: st });
  }
}

/**
 * Staples for a query, best first.
 *
 *   exact     the whole query IS a name or alias           (1000)
 *   prefix    single-word type-ahead: "chap" -> chapati      (300-500)
 *   tokens    every query word appears in one alias         (~300)
 *
 * `vague` is set when the words matched are an umbrella term for the
 * staple rather than its name ("sabzi" for mixed veg).
 *
 * Prefix matching is for the search box only (`allowPrefix`). The meal
 * parser hands over a complete food name, and resolving "chap" to chapati
 * there would be inventing what was eaten.
 */
export function matchStaples(query, { limit = 3, allowPrefix = true } = {}) {
  const raw = normStaple(query);
  if (!raw) return [];
  const q = stripLeadingUnits(raw);
  const out = new Map();
  const take = (staple, score, kind, phrase) => {
    const prev = out.get(staple.key);
    const vague = kind !== 'exact' || VAGUE.has(`${staple.key}|${phrase}`);
    if (!prev || prev.score < score) out.set(staple.key, { staple, score, kind, vague });
  };

  const exact = BY_ALIAS.get(q);
  if (exact) take(exact, 1000, 'exact', q);

  const qTokens = q.split(' ');
  for (const { phrase, tokens, staple } of ALIAS_LIST) {
    if (phrase === q) continue;
    if (allowPrefix && qTokens.length === 1 && q.length >= 3
        && (phrase.startsWith(q) || tokens.some((t) => t.startsWith(q)))) {
      take(staple, 500 - Math.min(200, phrase.length - q.length), 'prefix', phrase);
      continue;
    }
    if (qTokens.length > 1 && qTokens.every((t) => tokens.includes(t))) {
      take(staple, 300 - (tokens.length - qTokens.length) * 10, 'tokens', phrase);
    }
  }
  return [...out.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** The single staple a complete food name means, or null. */
export function stapleFor(name) {
  const hit = matchStaples(name, { limit: 1, allowPrefix: false })[0];
  return hit && hit.score >= 300 ? hit.staple : null;
}

export function stapleByKey(key) {
  return STAPLES.find((s) => s.key === key) || null;
}

/* ── rows ───────────────────────────────────────────────────────────── */

export const STAPLE_SOURCE = 'SKOS_STAPLE';

/**
 * The row a staple stands for: its referenced measured row, unchanged
 * apart from added staple fields -- or, with no ref, its inline value as a
 * row of the same shape.
 *
 * `rowsById` is the index's own rows. A ref that is missing or flagged
 * untrustworthy falls back to inline if one exists, else the staple is
 * dropped (returns null) rather than shown with no numbers.
 */
export function stapleRow(st, rowsById) {
  const ref = st.ref ? rowsById.get(st.ref) : null;
  const staple = {
    staple_key: st.key,
    staple_name: st.name,
    match_kind: 'staple',
  };
  if (ref && ref.data_quality_flag == null && ref.trustworthy !== false) {
    // The measured row, byte-faithful. Confidence is the MATCH certainty:
    // this row is the one the word means. (An umbrella word lowers it at
    // match time -- see matchStaples.)
    return { ...ref, ...staple, confidence: 'high', trustworthy: true };
  }
  if (!st.inline) return null;
  const [kcal, protein, carbs, fat, fiber = null] = st.inline;
  return {
    source: STAPLE_SOURCE,
    source_id: `staple:${st.key}`,
    food_name: st.name,
    search_name: normStaple(st.name),
    // A cooked recipe estimate is a dish, the way INDB files its own rows.
    category: st.basis === 'recipe' && ['dish', 'veg', 'grain', 'snack', 'sweet'].includes(st.kind) ? 'indian_dish' : st.kind,
    cuisine: 'everyday',
    cooking_state: st.basis === 'recipe' ? 'cooked' : null,
    energy_kcal: kcal,
    protein_g: protein,
    carb_g: carbs,
    fat_g: fat,
    fiber_g: fiber,
    sugar_g: null,
    sodium_mg: null,
    calcium_mg: null,
    iron_mg: null,
    brand: null,
    // A recipe or label estimate is not a measurement: the chai in a given
    // cup depends on the sugar and the milk. A USDA component value is.
    confidence: st.basis === 'usda' ? 'high' : 'medium',
    trustworthy: true,
    basis: st.basis,
    basis_note: st.note || null,
    ...staple,
  };
}

/* ── units ──────────────────────────────────────────────────────────── */

// Words the parser or a user might use for a unit, mapped to a unit key.
const UNIT_SYNONYMS = {
  tbsp: 'tablespoon', tablespoons: 'tablespoon', tsp: 'teaspoon', teaspoons: 'teaspoon',
  cups: 'cup', bowls: 'bowl', plates: 'plate', glasses: 'glass', katoris: 'katori',
  slices: 'slice', pieces: 'piece', pcs: 'piece', pc: 'piece', nos: 'piece', no: 'piece',
  scoops: 'scoop', packets: 'packet', pack: 'packet', packs: 'packet', mugs: 'mug',
  cans: 'can', bottles: 'bottle', handfuls: 'handful', eggs: 'egg', rotis: 'roti',
  chapati: 'roti', chapatis: 'roti', chapatti: 'roti', phulka: 'roti',
  idlis: 'idli', dosas: 'dosa', bananas: 'banana', apples: 'apple', oranges: 'orange',
  dates: 'date', almonds: 'almond', cashews: 'cashew', samosas: 'samosa', vadas: 'vada',
  ladoos: 'ladoo', laddu: 'ladoo', laddus: 'ladoo', parathas: 'paratha', parantha: 'paratha',
  puris: 'puri', poori: 'puri', pooris: 'puri', naans: 'naan', biscuits: 'biscuit',
  cubes: 'cube', halves: 'half', 'half plate': 'plate',
};

export function canonUnit(unit) {
  const u = normStaple(unit);
  return UNIT_SYNONYMS[u] || UNIT_SYNONYMS[u.replace(/\s+/g, '_')] || u.replace(/\s+/g, '_');
}

/**
 * Which of this staple's units a word means, or null.
 *
 * With no unit word: a bare NUMBER means pieces when the staple comes in
 * pieces ("10 almonds" is ten almonds, not ten handfuls); otherwise, and
 * with no number either, the default unit ("chai" is a cup of chai).
 */
export function stapleUnit(st, unitWord, { hadQuantity = true } = {}) {
  if (unitWord) {
    const key = canonUnit(unitWord);
    const direct = st.units.find((u) => u.key === key);
    if (direct) return direct;
    // "3 eggs" on Egg white, "2 pieces" on Samosa: a word naming the food
    // itself, or a generic piece, means one of its countable units.
    const countUnit = st.units.find((u) => u.count);
    if (countUnit && (key === 'piece' || st.aliases.some((a) => canonUnit(a) === key))) return countUnit;
    return null;
  }
  if (hadQuantity) return st.units.find((u) => u.count) || st.units[0];
  return st.units[0];
}

export function stapleUnitByPortionKey(st, portionKey) {
  const key = String(portionKey || '').replace(/^staple_/, '');
  return st.units.find((u) => u.key === key) || null;
}

// The picker groups portions by these names; a unit must land in one.
const UNIT_GROUP = {
  katori: 'bowl', bowl: 'bowl', plate: 'plate', half_cup: 'bowl',
  cup: 'glass', glass: 'glass', mug: 'glass', cutting: 'glass', can: 'glass',
  bottle: 'glass', pint: 'glass', coconut: 'glass', ml100: 'glass',
  teaspoon: 'spoon', tablespoon: 'spoon', scoop: 'spoon', half_scoop: 'spoon',
};
export const unitGroup = (u) => (u.count ? 'count' : (UNIT_GROUP[u.key] || 'misc'));

export const ALL_STAPLES = STAPLES;
export default { matchStaples, stapleFor, stapleRow, stapleUnit, ALL_STAPLES };
