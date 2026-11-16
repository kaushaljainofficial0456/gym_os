// ============================================================
// SKOS FOOD BENCHMARK — CASE SPECS v3 (Phase 2 expansion toward 1,000)
//
// Merged with the v1 + v2 specs by build.mjs --version v3 into
// food_eval_set.v3.json. Same spec format, plus one ground-truth method:
//
//   xsrc   MULTI-SOURCE RANGE. The same food as measured by IFCT 2017,
//          USDA FoodData Central and the Canadian Nutrient File, each row
//          chosen by THIS spec's own name pattern (never the estimator's
//          ranker). The band runs from the lowest to the highest source
//          reading at the reference grams, +/- tolerance. Real databases
//          disagree (papaya 24 vs 43 kcal/100 g, desi vs kabuli chana); the
//          band says how much, instead of pretending one row is the truth.
//          A food only one source measures falls back to that row and is
//          labelled db_row_scaled.
//
// GROUND-TRUTH POLICY (unchanged from v2, restated):
//   - every number comes from a measured database row; nothing in this
//     file is a hand-typed nutrient value
//   - standard portions are USDA FNDDS / SR reference portion weights
//     (medium banana 118 g, large egg 50 g, 1 cup cooked rice 158 g ...),
//     scored as portion ranges, with the nutrition band from the xsrc rows
//   - natural-language meals with household units are scored on identity
//     per item and silent drops only (method none)
//   - a case whose reference row is the row the engine itself uses is
//     reported separately as "same-row" by the independence split
//     (NUTRITION_ACCURACY_REPORT.md) -- it tests arithmetic, not composition
// ============================================================
'use strict';

const db = (prefer, name, cs, grams, tol = 0.2) => ({ m: 'db', prefer, name, cs: cs ?? null, grams, tol });
const dbsum = (parts, tol = 0.2) => ({ m: 'dbsum', parts: parts.map(([prefer, name, cs, grams]) => ({ prefer, name, cs: cs ?? null, grams })), tol });
const xsrc = (f, grams, tol = 0.15) => ({ m: 'xsrc', name: f.re, cs: f.cs ?? null, reject: f.reject ?? null, grams, tol });
const none = () => ({ m: 'none' });
const published = (nutrition, gramsRef, note) => ({ m: 'published', nutrition, gramsRef, note });

const C = [];
const add = (id, input, primary, tags, difficulty, expect, gt) =>
  C.push({ id, input, primary, tags, difficulty, expect, gt: gt || none() });
const items = (...res) => res.map((r) => ({ entity: { name_matches: r } }));
const pad = (n) => String(n).padStart(3, '0');

/* =====================================================================
 * FOODS measured by more than one database. `say` is what a person types;
 * `id` is the identity the engine's answer must match; `re` selects each
 * source's row; `reject` keeps prepared / dried / juiced forms out.
 * ===================================================================== */
export const FOODS = [
  { key: 'banana', say: 'banana', id: 'banana', re: /^bananas?,? (ripe|raw)/i, cs: 'raw', reject: /dehydrated|powder|chips|plantain/i, w: [120, 100] },
  { key: 'apple', say: 'apple', id: 'apple', re: /^apples?,? (raw|big|red|green|with skin)/i, cs: 'raw', reject: /juice|dried|sauce|crab|pie|candied|babyfood|chips/i, w: [150, 100] },
  { key: 'orange', say: 'orange', id: 'orange', re: /^oranges?,? (raw|all commercial|pulp)/i, cs: 'raw', reject: /juice|peel|chicken/i, w: [130, 100] },
  { key: 'mango', say: 'mango', id: 'mango', re: /^mangos?,? (raw|ripe)/i, cs: 'raw', reject: /dried|nectar|green|ginger/i, w: [150, 100] },
  { key: 'papaya', say: 'papaya', id: 'papaya', re: /^papaya, ripe|^papayas, raw/i, cs: 'raw', reject: /dried|nectar|canned/i, w: [150, 200] },
  { key: 'guava', say: 'guava', id: 'guava', re: /^guavas?,? (common|raw|white|pink)/i, cs: 'raw', reject: /nectar|sauce/i, w: [100, 150] },
  { key: 'grapes', say: 'grapes', id: 'grape', re: /^grapes?,? (red|green|american|black|seedless|red or green)/i, cs: 'raw', reject: /juice|leaves|canned|raisin/i, w: [100, 80] },
  { key: 'pomegranate', say: 'pomegranate', id: 'pomegranate|anar', re: /^pomegranates?,? (raw|maroon|seeds)/i, cs: 'raw', reject: /juice/i, w: [100, 150] },
  { key: 'watermelon', say: 'watermelon', id: 'watermelon|water melon', re: /^water ?melon,? (raw|dark)/i, cs: 'raw', reject: /seed|juice/i, w: [200, 300] },
  { key: 'pineapple', say: 'pineapple', id: 'pineapple', re: /^pineapple,? (raw|all)|^pineapple \(/i, cs: 'raw', reject: /juice|canned|frozen/i, w: [100, 150] },
  { key: 'tomato', say: 'tomato', id: 'tomato', re: /^tomato(es)?,? (red|ripe|raw)/i, cs: 'raw', reject: /green|juice|paste|sauce|puree|canned|sun-dried|soup|ketchup/i, w: [100, 60] },
  { key: 'onion', say: 'onion', id: 'onion', re: /^onions?,? (raw|big)/i, cs: 'raw', reject: /rings|dehydrated|frozen|spring|soup|powder|sweet|young/i, w: [100, 50] },
  { key: 'carrot', say: 'carrot', id: 'carrot', re: /^carrots?,? (raw|orange|red)/i, cs: 'raw', reject: /juice|canned|frozen|dehydrated|baby/i, w: [100, 60] },
  { key: 'cucumber', say: 'cucumber', id: 'cucumber|kheera', re: /^cucumbers?,? (with peel|raw|green)/i, cs: 'raw', reject: /pickle/i, w: [100, 150] },
  { key: 'cabbage', say: 'cabbage', id: 'cabbage', re: /^cabbage,? (raw|green)/i, cs: 'raw', reject: /cooked|red|savoy|chinese|napa|pickled/i, w: [100, 150] },
  { key: 'green_peas', say: 'green peas', id: 'pea', re: /^peas?,? (green,? raw|fresh)/i, cs: 'raw', reject: /canned|frozen|split|dry|edible-podded|cooked|boiled|soup/i, w: [100, 50] },
  { key: 'okra', say: 'raw bhindi', id: 'bhindi|okra|ladies', re: /^okra,? raw|^ladies finger/i, cs: 'raw', reject: /cooked|frozen|batter/i, w: [100, 150] },
  { key: 'brinjal', say: 'brinjal', id: 'brinjal|eggplant|baingan', re: /^eggplant,? raw|^brinjal/i, cs: 'raw', reject: /cooked|pickled|bharta/i, w: [100, 200] },
  { key: 'capsicum', say: 'capsicum', id: 'capsicum|pepper', re: /^peppers?,? sweet,? green,? raw|^pepper, sweet, green, raw|^capsicum,? green/i, cs: 'raw', reject: /cooked|frozen|canned/i, w: [100, 80] },
  { key: 'beetroot', say: 'beetroot', id: 'beet', re: /^beets?,? raw|^beet ?root/i, cs: 'raw', reject: /greens|cooked|canned|pickled/i, w: [100, 80] },
  { key: 'mushroom', say: 'mushrooms', id: 'mushroom', re: /^mushrooms?,? (white,? )?raw$|^mushrooms, raw/i, cs: 'raw', reject: /cooked|canned|stir|dried|shiitake|portabella|oyster|enoki/i, w: [100, 80] },
  { key: 'sweet_potato', say: 'raw sweet potato', id: 'sweet potato|shakarkand', re: /^sweet ?potato(es)?,? (raw|pink)/i, cs: 'raw', reject: /cooked|canned|leaves|frozen|baked|fries/i, w: [150, 100] },
  { key: 'potato_raw', say: 'raw potato', id: 'potato', re: /^potato(es)?,? (flesh and skin,? raw|brown skin|white,? flesh and skin,? raw)/i, cs: 'raw', reject: /red|baked|boiled|fried|frozen|sweet|dehydrated|flour|salad|chips|, skin$/i, w: [150, 200] },
  { key: 'almonds', say: 'almonds', id: 'almond|badam', re: /^(nuts, )?almonds?$|^almond \(|^nuts, almonds$/i, cs: null, w: [30, 20] },
  { key: 'cashews', say: 'cashews', id: 'cashew|kaju', re: /^(nuts, )?cashew nuts?,? raw|^cashew nut \(/i, cs: null, reject: /butter|roasted|oil/i, w: [30, 20] },
  { key: 'walnuts', say: 'walnuts', id: 'walnut|akhrot', re: /^(nuts, )?walnuts?,? english|^walnut \(/i, cs: null, reject: /black|oil|glazed/i, w: [30, 20] },
  { key: 'peanuts', say: 'raw peanuts', id: 'peanut|groundnut|ground nut', re: /^peanuts?,? (all types, )?raw|^ground ?nut \(/i, cs: null, reject: /butter|oil|roasted|boiled|flour/i, w: [30, 50] },
  { key: 'pistachio', say: 'pistachios', id: 'pista', re: /^(nuts, )?pistachio nuts?,? raw|^pistachio nuts \(/i, cs: null, reject: /roasted/i, w: [30, 20] },
  { key: 'raisins', say: 'golden raisins', id: 'raisin|kishmish', re: /^raisins?,? (dried, )?golden|^raisin, golden/i, cs: null, reject: /cooked|chocolate|bran|bread/i, w: [30, 20] },
  { key: 'dates', say: 'dates', id: 'date|khajur', re: /^dates?,? (medjool|dry|deglet)|^date, medjool/i, cs: null, reject: /syrup|bars/i, w: [50, 30] },
  { key: 'coconut_fresh', say: 'fresh coconut', id: 'coconut', re: /^(nuts, )?coconut meat,? raw|^coconut meat, raw|^coconut, kernel, fresh/i, cs: null, reject: /dried|milk|water|cream|oil/i, w: [50, 30] },
  { key: 'milk_whole', say: 'whole milk', id: 'milk', re: /^milk,? whole,? cow|^milk, whole$/i, cs: null, w: [250, 200] },
  { key: 'buffalo_milk', say: 'buffalo milk', id: 'buffalo', re: /^milk,? (indian )?buffalo|^milk, whole, buffalo/i, cs: null, w: [250, 200] },
  { key: 'paneer', say: 'paneer', id: 'paneer', re: /^paneer$|^cheese, paneer/i, cs: null, w: [100, 50] },
  { key: 'butter', say: 'butter', id: 'butter', re: /^butter,? (salted|regular)$|^butter$/i, cs: null, w: [10, 20] },
  { key: 'cheddar', say: 'cheddar cheese', id: 'cheddar|cheese', re: /^cheese,? cheddar/i, cs: null, reject: /reduced|low|nonfat|fat free|sharp|mild|sauce|imitation/i, w: [30, 20] },
  { key: 'egg', say: 'raw egg', id: 'egg', re: /^eggs?,? (whole,? raw|poultry, whole, raw)/i, cs: 'raw', reject: /dried|frozen|substitute|duck|goose|quail|turkey|country/i, w: [100, 50] },
  { key: 'egg_boiled', say: 'boiled egg', id: 'egg', re: /^eggs?,? (whole,? cooked,? hard.?boiled|poultry, whole, boiled)/i, cs: 'cooked', w: [100, 50] },
  { key: 'chicken_raw', say: 'raw chicken breast', id: 'chicken', re: /^chicken, broilers? or fryers, breast, skinless, boneless, meat only, raw$|^chicken, broiler, breast, skinless, boneless, meat, raw|^chicken, poultry, breast, skinless/i, cs: null, w: [200, 150] },
  { key: 'mutton_raw', say: 'raw mutton', id: 'mutton|goat|lamb', re: /^game meat, goat, raw|^goat, (legs|shoulder)/i, cs: null, w: [150, 200] },
  { key: 'rohu', say: 'rohu fish', id: 'rohu|fish|carp', re: /^rohu|^fish, carp, raw/i, cs: 'raw', w: [150, 100] },
  { key: 'prawns_raw', say: 'raw prawns', id: 'prawn|shrimp', re: /^(crustaceans, )?shrimp,? (mixed species, )?raw|^prawns?,? (small|big)|^tiger prawns, brown/i, cs: null, reject: /canned|breaded|cooked|dried/i, w: [100, 150] },
  { key: 'atta', say: 'atta', id: 'atta|wheat flour', re: /^wheat flour,? atta|^wheat flour, whole-grain, soft/i, cs: null, w: [80, 50] },
  { key: 'semolina', say: 'suji', id: 'semolina|suji|rava|sooji', re: /^semolina, enriched$|^wheat,? semolina/i, cs: null, reject: /cooked|pudding/i, w: [50, 40] },
  { key: 'rajma', say: 'dry rajma', id: 'rajma|kidney', re: /^rajmah,? red|^beans,? kidney,? red,? mature seeds,? raw/i, cs: null, reject: /canned|cooked|sprouted/i, w: [60, 50] },
  { key: 'chana', say: 'dry kabuli chana', id: 'chana|chickpea|bengal gram', re: /^chickpeas \(garbanzo beans, bengal gram\), mature seeds, raw|^bengal gram,? whole/i, cs: null, w: [60, 50] },
  { key: 'moong_whole', say: 'raw whole moong', id: 'moong|mung|green gram', re: /^green gram,? whole|^mung beans,? mature seeds,? raw/i, cs: null, reject: /sprouted|cooked/i, w: [50, 40] },
  { key: 'masoor', say: 'raw masoor dal', id: 'masoor|lentil', re: /^lentils?,? raw|^lentil dal \(/i, cs: null, reject: /sprouted|cooked|pink|red split/i, w: [50, 40] },
  { key: 'soybean', say: 'soybeans', id: 'soy', re: /^soybeans?,? mature seeds,? raw|^soybean, brown/i, cs: null, reject: /roasted|cooked|green|sprouted|flour/i, w: [40, 30] },
  { key: 'coconut_water', say: 'coconut water', id: 'coconut water|nariyal', re: /^coconut water|^nuts, coconut water|^coconut water \(liquid/i, cs: null, reject: /bottled|sweetened/i, w: [250, 200], ml: true },
];

/* =====================================================================
 * X1. Each food at an explicit weight, written two ways: amount first
 *     ("120g banana") and amount after ("banana 100 g" -- the trailing
 *     form the parser used to drop). Multi-source reference band.
 * ===================================================================== */
let n = 0;
for (const f of FOODS) {
  const unit = f.ml ? 'ml' : 'g';
  const [w1, w2] = f.w;
  add(`x3-${pad(++n)}`, `${w1}${unit} ${f.say}`, 'single_ingredient', ['global', 'explicit_grams', 'v3_xsrc'], 'easy',
    { entity: { name_matches: f.id }, strategy: 'direct' }, xsrc(f, w1));
  add(`x3-${pad(++n)}`, `${f.say} ${w2} ${unit === 'g' ? 'g' : 'ml'}`, 'single_ingredient', ['global', 'explicit_grams', 'trailing_amount', 'v3_xsrc'], 'medium',
    { entity: { name_matches: f.id }, strategy: 'direct' }, xsrc(f, w2));
}
for (const f of FOODS) {
  const w3 = Math.round((f.w[0] + f.w[1]) / 2);
  const unit = f.ml ? 'ml' : 'grams';
  add(`x3-${pad(++n)}`, `${w3} ${unit} of ${f.say}`, 'single_ingredient', ['global', 'explicit_grams', 'v3_xsrc'], 'easy',
    { entity: { name_matches: f.id }, strategy: 'direct' }, xsrc(f, w3));
}
const byKey = Object.fromEntries(FOODS.map((f) => [f.key, f]));

/* =====================================================================
 * P1. Standard household portions -- USDA FNDDS / SR reference weights.
 *     Scored on the PORTION (grams) and on nutrition at that weight.
 * ===================================================================== */
const PORTIONS = [
  // [input, food key, reference grams, note]
  ['1 medium banana', 'banana', 118, 'USDA: banana, medium (7"–7⅞") 118 g'],
  ['1 banana', 'banana', 118, 'USDA: banana, medium 118 g'],
  ['1 small banana', 'banana', 101, 'USDA: banana, small (6"–6⅞") 101 g'],
  ['1 large banana', 'banana', 136, 'USDA: banana, large (8"–8⅞") 136 g'],
  ['1 apple', 'apple', 182, 'USDA: apple, medium (3" dia) 182 g'],
  ['1 medium apple', 'apple', 182, 'USDA: apple, medium 182 g'],
  ['1 orange', 'orange', 131, 'USDA: orange, medium (2⅝" dia) 131 g'],
  ['1 mango', 'mango', 207, 'USDA: mango, whole without refuse 207 g'],
  ['1 cup grapes', 'grapes', 151, 'USDA: grapes, 1 cup 151 g'],
  ['1 cup watermelon', 'watermelon', 152, 'USDA: watermelon, diced, 1 cup 152 g'],
  ['1 cup papaya', 'papaya', 145, 'USDA: papaya, 1 cup cubes 145 g'],
  ['1 cup pineapple', 'pineapple', 165, 'USDA: pineapple, 1 cup chunks 165 g'],
  ['1 tomato', 'tomato', 123, 'USDA: tomato, medium (2⅗" dia) 123 g'],
  ['1 onion', 'onion', 110, 'USDA: onion, medium (2½" dia) 110 g'],
  ['1 carrot', 'carrot', 61, 'USDA: carrot, medium 61 g'],
  ['1 large egg', 'egg', 50, 'USDA: egg, large 50 g'],
  ['2 eggs', 'egg', 100, 'USDA: egg, large 50 g each'],
  ['3 eggs', 'egg', 150, 'USDA: egg, large 50 g each'],
  ['2 boiled eggs', 'egg_boiled', 100, 'USDA: egg, large hard-boiled 50 g each'],
  ['1 boiled egg', 'egg_boiled', 50, 'USDA: egg, large hard-boiled 50 g'],
  ['10 almonds', 'almonds', 12, 'USDA: almond 1.2 g each'],
  ['20 almonds', 'almonds', 24, 'USDA: almond 1.2 g each'],
  ['1 cup milk', 'milk_whole', 244, 'USDA: milk, 1 cup 244 g'],
  ['1 glass milk', 'milk_whole', 250, 'Indian steel glass 250 ml ≈ 258 g (density 1.03); range covers 240–270'],
  ['1 tbsp butter', 'butter', 14, 'USDA: butter, 1 tbsp 14.2 g'],
  ['1 tsp butter', 'butter', 5, 'USDA: butter, 1 tsp 4.7 g'],
  ['1 cup coconut water', 'coconut_water', 240, 'USDA: coconut water, 1 cup 240 g'],
  ['5 dates', 'dates', 120, 'USDA: medjool date 24 g each'],
  ['1 cup green peas', 'green_peas', 145, 'USDA: peas, green, raw, 1 cup 145 g'],
  ['1 cup raw mushrooms', 'mushroom', 70, 'USDA: mushrooms, white, raw, 1 cup pieces 70 g'],
  ['1 cup chopped cabbage', 'cabbage', 89, 'USDA: cabbage, raw, 1 cup chopped 89 g'],
  ['1 slice cheddar cheese', 'cheddar', 28, 'USDA: cheddar, 1 slice (1 oz) 28 g'],
  ['1 cup atta', 'atta', 120, 'USDA: whole-wheat flour, 1 cup 120 g'],
  ['1 cup raw rajma', 'rajma', 184, 'USDA: kidney beans, raw, 1 cup 184 g'],
  ['1 cup raw kabuli chana', 'chana', 200, 'USDA: chickpeas, raw, 1 cup 200 g'],
  ['1 cup masoor dal raw', 'masoor', 192, 'USDA: lentils, raw, 1 cup 192 g'],
];
let p = 0;
for (const [input, key, grams, note] of PORTIONS) {
  const f = byKey[key];
  const lo = Math.round(grams * 0.8); const hi = Math.round(grams * 1.2);
  add(`pt3-${pad(++p)}`, input, 'single_ingredient', ['global', 'count_portion', 'v3_portion'], 'medium',
    { entity: { name_matches: f.id }, portion: { grams: [lo, hi] }, strategy: 'direct' },
    { ...xsrc(f, grams, 0.15), note });
}

/* =====================================================================
 * R1. Raw / dry vs cooked -- each the measured row for THAT state.
 * ===================================================================== */
const STATE = [
  ['100g raw rice', 'rice', /^rice, white, long-grain, regular, raw, unenriched/i, 'raw', 100, '(?<!un)cooked|puffed|murmura'],
  ['150 g uncooked rice', 'rice', /^rice, white, long-grain, regular, raw, unenriched/i, 'raw', 150, '(?<!un)cooked|puffed|murmura'],
  ['80g uncooked basmati rice', 'rice', /^rice, white, long-grain, regular, raw, unenriched/i, 'raw', 80, '(?<!un)cooked|puffed|murmura'],
  ['200g cooked rice', 'rice', /^rice, white, long-grain, regular, cooked, enriched, with salt/i, 'cooked', 200, 'raw|puffed'],
  ['150g boiled rice', 'rice', /^rice, white, long-grain, regular, cooked, enriched, with salt/i, 'cooked', 150, 'raw|puffed'],
  ['60g raw brown rice', 'brown rice', /^rice, brown, long-grain, raw/i, 'raw', 60, '(?<!un)cooked'],
  ['50g toor dal raw', 'toor|arhar|red gram', /^red gram, dal/i, null, 50, 'cooked|curry'],
  ['60g uncooked toor dal', 'toor|arhar|red gram', /^red gram, dal/i, null, 60, 'cooked|curry'],
  ['50g uncooked moong dal', 'moong|mung|green gram', /^green gram, dal/i, null, 50, 'cooked|curry|whole'],
  ['40g raw urad dal', 'urad|black gram', /^black gram, dal/i, null, 40, 'cooked|vada'],
  ['50g raw chana dal', 'chana dal|bengal gram', /^bengal gram, dal/i, null, 50, 'cooked|curry'],
  ['60g dry chana', 'chana|chickpea|bengal gram', /^bengal gram, whole/i, null, 60, 'cabbage|roll|curry'],
  ['50 g dry rajma', 'rajma|kidney', /^rajmah, red/i, null, 50, 'curry|masala'],
  ['100g raw potato', 'potato', /^potato, brown skin, big/i, null, 100, 'pancake|fries|boiled'],
  ['200g boiled potato', 'potato', /^potato, boiled, from fresh,  ?peel eaten, no added fat/i, null, 200, 'raw|pancake|fried'],
  ['100g atta', 'atta|wheat flour', /^wheat flour, atta/i, null, 100, 'burfi|ladoo|halwa'],
  ['2 tbsp atta', 'atta|wheat flour', /^wheat flour, atta/i, null, 16, 'burfi|ladoo|halwa'],
  ['50g suji', 'semolina|suji|rava', /^wheat, semolina/i, null, 50, 'dosa|upma|halwa'],
  ['50g rava', 'semolina|suji|rava', /^wheat, semolina/i, null, 50, 'dosa|upma|halwa'],
  ['50g dry sabudana', 'sabudana|sago|tapioca', /^tapioca, pearl, dry/i, null, 50, 'khichdi|vada'],
  ['50g raw oats', 'oat', /^cereals, oats, regular and quick, not fortified, dry/i, null, 50, 'cake|protein|cookie|bar'],
  ['40g dry oats', 'oat', /^cereals, oats, regular and quick, not fortified, dry/i, null, 40, 'cake|protein|cookie|bar'],
  ['200g cooked oats', 'oat', /^cereals, oats, regular and quick, unenriched, cooked with water/i, null, 200, 'dry|cookie'],
  ['100g raw paneer', 'paneer', /^paneer$/i, null, 100, 'tikka|masala|bhurji'],
  ['200 g raw chicken breast', 'chicken', /^chicken, broiler or fryers, breast, skinless, boneless, meat only, raw$/i, null, 200, 'cooked|fried|curry'],
  ['150g grilled chicken breast', 'chicken', /^chicken, broilers or fryers, breast, meat only, cooked, roasted/i, null, 150, 'raw|fried|curry'],
  ['100g boiled chickpeas', 'chickpea|chana', /^chickpeas \(garbanzo beans, bengal gram\), mature seeds, cooked, boiled, without salt/i, null, 100, 'raw|flour|curry'],
  ['50g raw peanuts', 'peanut|groundnut', /^peanuts, raw$/i, null, 50, 'butter|oil|chikki'],
  ['30g roasted peanuts', 'peanut|groundnut', /^peanuts, all types, dry-roasted, without salt/i, null, 30, 'butter|oil|raw'],
  ['100g raw mango', 'mango|kairi', /^mango, green, raw/i, null, 100, 'chutney|pickle|ripe'],
];
let r = 0;
for (const [input, idRe, rowRe, cs, grams, reject] of STATE) {
  add(`st3-${pad(++r)}`, input, 'single_ingredient', ['indian', 'raw_vs_cooked', 'explicit_grams', 'v3_state'], 'medium',
    { entity: { name_matches: idRe, reject_name_matches: reject }, strategy: 'direct' },
    db(['IFCT2017', 'USDA_FDC', 'CNF_CANADA'], rowRe, cs, grams, 0.2));
}

/* =====================================================================
 * S1. Spellings, transliterations and plurals -- identity only.
 * ===================================================================== */
const SPELL = [
  ['2 chapathis', 'roti|chapati'], ['2 chappatis', 'roti|chapati'], ['3 phulkas', 'roti|chapati|phulka'],
  ['1 parantha', 'paratha|parantha'], ['1 prantha', 'paratha|parantha'], ['2 aloo parathas', 'aloo paratha|potato'],
  ['1 plate biriyani', 'biryani'], ['1 plate briyani', 'biryani'], ['chicken biriyani', 'biryani'],
  ['1 bowl dhal', '\\bdal|dhal|lentil'], ['1 katori daal', '\\bdal|dhal|lentil'], ['dal fry', '\\bdal|dhal'],
  ['2 idlis', 'idli'], ['3 idly', 'idli|idly'], ['1 dosai', 'dosa|dosai'], ['1 masala dosai', 'masala dosa|dosa'],
  ['1 bowl sambhar', 'sambar|sambhar'], ['1 katori raitha', 'raita'], ['1 bowl kichdi', 'khichdi|khichri'],
  ['1 bowl khichadi', 'khichdi|khichri'], ['1 plate pohe', 'poha|pohe'], ['1 bowl upama', 'upma'],
  ['100g panner', 'paneer'], ['100 gm paneer', 'paneer'], ['1 bowl curd', 'curd|dahi|yog'], ['1 bowl yoghurt', 'curd|dahi|yog'],
  ['1 glass chaas', 'chaas|buttermilk'], ['1 glass lassi', 'lassi'], ['1 cup chaha', 'chai|tea'], ['1 cutting chai', 'chai|tea'],
  ['2 rotis with bhendi', 'roti|chapati'], ['1 bowl rajmah', 'rajma|kidney'], ['1 bowl chhole', 'chole|chana|chickpea'],
  ['1 plate pav bhaji', 'pav bhaji'], ['2 vada pavs', 'vada pav'], ['1 plate misal pav', 'misal'],
  ['2 samosas', 'samosa'], ['3 pakodas', 'pakora|pakoda|bhaji'], ['1 plate pani puri', 'pani ?puri|golgappa'],
  ['2 gulab jamuns', 'gulab jamun'], ['1 piece jalebi', 'jalebi'], ['2 rasgullas', 'rasgulla|rasagola'],
  ['1 bowl kheer', 'kheer'], ['2 laddoos', 'ladd?oo|laddu'], ['1 plate upma', 'upma'],
  ['1 bowl oatmeal', 'oat'], ['2 slices brown bread', 'bread'], ['1 omlette', 'omelet'], ['2 egg omlette', 'omelet|egg'],
  ['1 bowl chicken curry', 'chicken'], ['1 bowl mutton curry', 'mutton|goat|lamb'], ['1 plate egg bhurji', 'egg|bhurji'],
  ['1 bowl palak paneer', 'palak|spinach'], ['1 bowl aloo gobhi', 'aloo|gob|potato'], ['1 bowl baingan bharta', 'baingan|brinjal|eggplant|bharta'],
  ['1 cup black coffee', 'coffee'], ['1 cup green tea', 'green tea|tea'], ['1 glass nimbu pani', 'nimbu|lemon'],
  ['1 bowl sprouts', 'sprout'],
  ['1 bowl moong dal', '\\bdal|moong|lentil'], ['1 bowl masoor dal', '\\bdal|masoor|lentil'], ['1 bowl toor dal', '\\bdal|toor|arhar'],
  ['1 bowl dal makhani', 'makhani'], ['1 bowl kadhi', 'kadhi|kadi'], ['1 bowl mix veg', 'mix|veg|sabzi'],
  ['1 plate veg pulao', 'pulao|pulav'], ['1 plate jeera rice', 'jeera|rice'], ['1 plate curd rice', 'curd rice|curd'],
  ['1 plate lemon rice', 'lemon rice|rice'], ['1 plate fried rice', 'fried rice'], ['1 plate hakka noodles', 'noodle|hakka'],
  ['1 bowl maggi', 'maggi|noodle'], ['2 dhoklas', 'dhokla'], ['1 plate kanda poha', 'poha'],
  ['2 thepla', 'thepla'], ['1 bhakri', 'bhakri'], ['2 jowar bhakri', 'jowar|bhakri'], ['1 puran poli', 'puran'],
  ['2 medu vada', 'vada'], ['2 uttapam', 'uttapam|uthappam'], ['1 rava dosa', 'rava dosa|dosa'],
  ['1 bowl rasam', 'rasam'], ['1 cup filter coffee', 'coffee'], ['1 glass sweet lassi', 'lassi'],
  ['1 glass mango lassi', 'lassi|mango'], ['1 bowl fruit salad', 'fruit|salad'], ['1 bowl paneer bhurji', 'paneer|bhurji'],
  ['1 plate paneer tikka', 'paneer tikka|tikka'], ['1 plate tandoori chicken', 'tandoori'], ['2 chicken seekh kebab', 'kebab|seekh'],
  ['1 bowl butter chicken', 'butter chicken|makhani|murgh'], ['1 plate egg fried rice', 'fried rice|egg'], ['1 egg roll', 'egg roll|roll'],
  ['1 bowl soya chunks curry', 'soya'], ['1 bowl sabudana khichdi', 'sabudana|sago'], ['1 plate misal', 'misal'],
];
let s = 0;
for (const [input, id] of SPELL) {
  add(`sp3-${pad(++s)}`, input, 'prepared_food', ['indian', 'spelling_variant', 'v3_spelling'], 'medium',
    { entity: { name_matches: id }, strategy: 'direct' }, none());
}

/* =====================================================================
 * D1. Drinks, packaged and supplements at a stated volume / weight.
 * ===================================================================== */
const DRINK = [
  ['330ml coke', 'cola|coke|coca', ['USDA_FDC'], /^beverages, carbonated, cola, regular$/i, 330],
  ['500 ml coca cola', 'cola|coke|coca', ['USDA_FDC'], /^beverages, carbonated, cola, regular$/i, 500],
  ['250ml orange juice', 'orange juice|juice', ['USDA_FDC'], /^orange juice, raw/i, 250],
  ['200ml apple juice', 'apple juice|juice', ['USDA_FDC'], /^apple juice, 100%$/i, 200],
  ['330 ml beer', 'beer', ['USDA_FDC'], /^alcoholic beverage, beer, regular, all/i, 330],
  ['250ml whole milk', 'milk', ['USDA_FDC'], /^milk, whole$/i, 250],
  ['200 ml skimmed milk', 'skim|milk', ['USDA_FDC'], /^milk, nonfat, fluid, with added vitamin a and vitamin d/i, 200],
  ['250ml buttermilk', 'buttermilk|chaas', ['USDA_FDC'], /^milk, buttermilk, fluid, cultured, lowfat/i, 250],
  ['300ml coconut water', 'coconut water', ['USDA_FDC'], /^nuts, coconut water \(liquid from coconuts\)/i, 300],
  ['240 ml black coffee', 'coffee', ['USDA_FDC'], /^beverages, coffee, brewed, prepared with tap water$/i, 240],
  ['240ml green tea', 'green tea|tea', ['USDA_FDC'], /^beverages, tea, green, brewed, regular/i, 240],
  ['200ml soy milk', 'soy', ['USDA_FDC'], /^soymilk, original and vanilla, unfortified/i, 200],
  ['250 ml sugarcane juice', 'sugarcane|ganna', ['IFCT2017'], /^sugarcane, juice/i, 250],
  ['30g peanut butter', 'peanut butter', ['USDA_FDC'], /^peanut butter, smooth style, without salt/i, 30],
  ['20g honey', 'honey', ['USDA_FDC'], /^honey$/i, 20],
  ['10g sugar', 'sugar', ['USDA_FDC'], /^sugars, granulated$/i, 10],
  ['15g ghee', 'ghee|butter oil', ['USDA_FDC'], /^butter oil, anhydrous/i, 15],
  ['10 ml mustard oil', 'oil', ['USDA_FDC'], /^oil, mustard/i, 9],
  ['1 tbsp olive oil', 'oil', ['USDA_FDC'], /^oil, olive, salad or cooking/i, 13.5],
  ['30g dark chocolate', 'chocolate', ['USDA_FDC'], /^chocolate, dark, 70-85% cacao solids/i, 30],
];
let d = 0;
for (const [input, id, prefer, rowRe, grams] of DRINK) {
  add(`dr3-${pad(++d)}`, input, input.match(/ml|juice|milk|beer|coffee|tea|water/i) ? 'beverage' : 'sauce_condiment',
    ['global', 'explicit_grams', 'v3_drink'], 'easy', { entity: { name_matches: id }, strategy: 'direct' },
    db(prefer, rowRe, null, grams, 0.2));
}
// A whey scoop: label ranges across common Indian/global brands, 30 g scoop.
add('dr3-021', '1 scoop whey protein', 'beverage', ['global', 'supplement', 'v3_drink'], 'medium',
  { entity: { name_matches: 'whey|protein' }, strategy: 'direct' },
  published({ kcal: [100, 140], protein_g: [20, 27] }, 30, 'whey concentrate/isolate labels: 110–130 kcal and 21–25 g protein per ~30 g scoop'));

/* =====================================================================
 * M1. Weighed multi-food meals (dbsum): every component weighed.
 * ===================================================================== */
const RICE_COOKED = [['USDA_FDC'], /^rice, white, long-grain, regular, cooked, enriched, with salt/i, null];
const ROTI = [['INDB'], /^Chapati\/Roti$|^Chapati|^Roti/i, null];
const MEALS = [
  ['150g cooked rice, 100g boiled chickpeas and 50g onion', [[...RICE_COOKED, 150], [['USDA_FDC'], /^chickpeas \(garbanzo beans, bengal gram\), mature seeds, cooked, boiled, without salt/i, null, 100], [['IFCT2017'], /^onion, big/i, null, 50]]],
  ['200g cooked rice and 100g paneer', [[...RICE_COOKED, 200], [['IFCT2017'], /^paneer$/i, null, 100]]],
  ['100g raw chicken breast and 150g raw potato', [[['USDA_FDC'], /^chicken, broiler or fryers, breast, skinless, boneless, meat only, raw$/i, null, 100], [['IFCT2017'], /^potato, brown skin, big/i, null, 150]]],
  ['2 boiled eggs, 1 banana and 250ml milk', null],
  ['50g oats, 200ml milk and 1 banana', null],
  ['30g almonds and 2 dates', null],
  ['100g paneer, 100g capsicum and 50g onion', [[['IFCT2017'], /^paneer$/i, null, 100], [['IFCT2017'], /^capsicum, green/i, null, 100], [['IFCT2017'], /^onion, big/i, null, 50]]],
  ['150g grilled chicken breast with 200g cooked rice', [[['USDA_FDC'], /^chicken, broilers or fryers, breast, meat only, cooked, roasted/i, null, 150], [...RICE_COOKED, 200]]],
  ['200g curd and 100g banana', [[['USDA_FDC'], /^yogurt, plain, whole milk/i, null, 200], [['USDA_FDC'], /^banana, raw$/i, null, 100]]],
  ['50g peanuts and 30g jaggery', [[['USDA_FDC'], /^peanuts, raw$/i, null, 50], [['IFCT2017'], /^jaggery, cane/i, null, 30]]],
  ['100g apple, 100g papaya and 100g pomegranate', [[['IFCT2017'], /^apple, big/i, null, 100], [['IFCT2017'], /^papaya, ripe/i, null, 100], [['IFCT2017'], /^pomegranate, maroon seeds/i, null, 100]]],
  ['60g raw masoor dal and 80g raw rice', [[['IFCT2017'], /^lentil dal/i, null, 60], [['USDA_FDC'], /^rice, white, long-grain, regular, raw, unenriched/i, null, 80]]],
  ['200g boiled potato and 100g green peas', [[['USDA_FDC'], /^potato, boiled, from fresh,  ?peel eaten, no added fat/i, null, 200], [['IFCT2017'], /^peas, fresh/i, null, 100]]],
  ['150g rohu fish and 150g cooked rice', [[['IFCT2017'], /^rohu/i, null, 150], [...RICE_COOKED, 150]]],
  ['100g tofu and 100g broccoli', [[['USDA_FDC'], /^tofu, raw, firm, prepared with calcium sulfate/i, null, 100], [['USDA_FDC'], /^broccoli, raw$/i, null, 100]]],
  ['30g whey and 300ml milk', null],
];
let m = 0;
for (const [input, parts] of MEALS) {
  const ids = input.split(/,| and | with /).map((x) => x.trim()).filter(Boolean);
  add(`ml3-${pad(++m)}`, input, 'meal', ['global', 'multi_food', 'explicit_grams', 'v3_meal'], 'medium',
    { strategy: 'direct', items: ids.map(() => ({ entity: { name_matches: '.' } })) },
    parts ? dbsum(parts, 0.2) : none());
}

/* =====================================================================
 * N1. Natural-language Indian meals -- identity per item, no drops.
 * ===================================================================== */
const NL = [
  ['I ate two rotis with one bowl of dal and some curd', ['roti|chapati', '\\bdal|lentil', 'curd|dahi|yog']],
  ['I had a plate of poha with peanuts and one cup of tea', ['poha', 'peanut', 'chai|tea']],
  ['I ate two slices of toast with 10 grams of butter and 15 grams of jam', ['toast|bread', 'butter', 'jam']],
  ['Had chicken biryani, half a plate, with raita', ['biryani', 'raita']],
  ['breakfast was 2 idli with sambar and coconut chutney', ['idli', 'sambar', 'chutney|coconut']],
  ['lunch: 3 rotis, 1 katori rajma, salad', ['roti|chapati', 'rajma|kidney', 'salad']],
  ['2 eggs and 2 slices of bread', ['egg', 'bread']],
  ['1 bowl oats with milk and a banana', ['oat', 'banana']],
  ['dinner was jeera rice with dal tadka', ['jeera|rice', 'dal|tadka']],
  ['had a masala dosa and filter coffee', ['masala dosa|dosa', 'coffee']],
  ['2 aloo parathas with curd and pickle', ['aloo paratha|potato', 'curd|dahi|yog', 'pickle|achar']],
  ['a plate of chole bhature', ['chole|chana|chickpea|bhatur']],
  ['paneer butter masala with 2 butter naan', ['paneer', 'naan']],
  ['1 glass of lassi and 2 samosas', ['lassi', 'samosa']],
  ['upma and a cup of chai', ['upma', 'chai|tea']],
  ['two boiled eggs and a cup of black coffee', ['egg', 'coffee']],
  ['a bowl of khichdi with ghee', ['khichdi|khichri', 'ghee']],
  ['vada pav and cutting chai', ['vada pav', 'chai|tea']],
  ['3 chapatis, bhindi sabzi and a bowl of dal', ['roti|chapati', 'bhindi|okra', '\\bdal|lentil']],
  ['curd rice with pickle', ['curd rice|curd|rice', 'pickle|achar']],
  ['grilled chicken 200g with 1 cup rice', ['chicken', 'rice']],
  ['protein shake with 1 banana', ['whey|protein', 'banana']],
  ['handful of almonds and a cup of green tea', ['almond', 'tea']],
  ['2 pav with misal', ['pav', 'misal']],
  ['pongal with sambar', ['pongal', 'sambar']],
  ['1 plate pav bhaji with extra butter', ['pav bhaji|pav', 'butter']],
  ['half plate veg biryani and raita', ['biryani', 'raita']],
  ['mutton curry with 2 rotis', ['mutton|goat|lamb', 'roti|chapati']],
  ['sprouts salad and buttermilk', ['sprout', 'buttermilk|chaas']],
  ['egg bhurji with 2 pav', ['egg|bhurji', 'pav']],
];
let q = 0;
for (const [input, ids] of NL) {
  add(`nl3-${pad(++q)}`, input, 'meal', ['indian', 'multi_food', 'natural_language', 'v3_nl'], 'hard',
    { strategy: 'direct', items: items(...ids) }, none());
}

/* =====================================================================
 * T1. Amount syntax and robustness.
 * ===================================================================== */
const SYNTAX = [
  ['roti 2', 'roti|chapati', { grams: [64, 96] }],
  ['eggs 3', 'egg', { grams: [120, 180] }],
  ['banana x2', 'banana', { grams: [190, 290] }],
  ['2x banana', 'banana', { grams: [190, 290] }],
  ['dal 1 bowl', '\\bdal|lentil', null],
  ['rice 150 grams', 'rice', { grams: [140, 160] }],
  ['paneer 100 g', 'paneer', { grams: [95, 105] }],
  ['milk 200ml', 'milk', { grams: [195, 215] }],
  ['½ cup cooked rice', 'rice', { grams: [64, 96] }],
  ['1/2 plate chicken biryani', 'biryani', null],
  ['half a katori dal', '\\bdal|lentil', null],
  ['a couple of rotis', 'roti|chapati', null],
  ['2 ROTI', 'roti|chapati', { grams: [64, 96] }],
  ['2 roti!!!', 'roti|chapati', { grams: [64, 96] }],
  ['two medium rotis', 'roti|chapati', { grams: [64, 96] }],
  ['1.5 cups cooked rice', 'rice', null],
  ['250 gm curd', 'curd|dahi|yog', { grams: [240, 260] }],
  ['1 kg watermelon', 'watermelon', { grams: [950, 1050] }],
  ['0.5 kg chicken breast', 'chicken', { grams: [480, 520] }],
  ['3 big rotis', 'roti|chapati', null],
];
let t = 0;
for (const [input, id, portion] of SYNTAX) {
  add(`sx3-${pad(++t)}`, input, 'prepared_food', ['global', 'amount_syntax', 'v3_syntax'], 'medium',
    { entity: { name_matches: id }, ...(portion ? { portion } : {}), strategy: 'direct' }, none());
}

/* Not food / malformed: must NOT be resolved into a number. */
const NONFOOD = ['my phone charger', 'running shoes', '12345', "'; DROP TABLE meal_logs; --", 'lorem ipsum dolor',
  'the', 'gym membership', 'sleep 8 hours', 'walked 10000 steps', 'a lot', '??', 'xyz abc qwe'];
let z = 0;
for (const input of NONFOOD) {
  add(`nf3-${pad(++z)}`, input, 'nonfood_or_malformed', ['global', 'v3_nonfood'], 'medium',
    { strategy: 'unresolved', is_nonfood: true }, none());
}

export default C;
