// ============================================================
// STANDARD RECIPES — composite dishes priced from MEASURED ingredients.
//
// WHY. Some of the most-logged Indian dishes have no usable row in the food
// index: misal, thalipeeth, pithla, bhakri, ven pongal, paneer bhurji have
// none at all, and bhatura / kachori rows exist but are quarantined because
// INDB counted the whole frying bath as eaten (793 kcal / 100 g bhatura). The
// alternatives were a confident wrong match (misal -> pav bhaji, puran poli
// -> Polish sausage) or a hand-typed number. This module is the third way.
//
// HOW (the yield method food-composition databases use for dishes):
//
//     nutrient per 100 g of dish
//       = Σ (ingredient raw grams × that ingredient's measured value / 100)
//         ÷ finished weight of the batch × 100
//
// Every ingredient is pinned to ONE measured row by source_id (IFCT 2017
// for Indian raw ingredients, USDA FoodData Central where IFCT has no row) --
// never a fuzzy lookup, so the arithmetic is reproducible and auditable.
// Water added during cooking carries no nutrients and only changes the
// finished weight. Frying oil is entered as the oil ABSORBED by the food, not
// the oil in the pan -- the exact mistake the quarantined INDB rows made.
//
// WHAT IS AN ASSUMPTION (and is shown as one): the proportions of a typical
// home recipe, the finished weight (cooking water gained / lost) and the oil
// absorbed when frying. These are curated estimates, written down next to the
// number so they can be argued with, not measurements. A recipe-priced item is
// labelled `recipe_calculation`, never `verified_database`, and carries MEDIUM
// composition confidence. Ingredient rows with an unmeasured nutrient (IFCT
// paneer has no carbohydrate value) are reported in `incomplete`, never
// silently treated as measured zeros.
//
// Licence note: ingredient values come from the same sources as the rest of
// the index (IFCT 2017 / NIN; USDA FDC, public domain; Open Food Facts, ODbL,
// for the one packaged topping used). Recipe proportions are SK OS curation.
// ============================================================
'use strict';

/** The nutrients summed for a recipe (unified_food_db field names). */
export const RECIPE_NUTRIENTS = Object.freeze([
  'energy_kcal', 'protein_g', 'carb_g', 'fat_g', 'fiber_g', 'sugar_g', 'sodium_mg',
  'calcium_mg', 'iron_mg',
]);

/** Ingredient rows used below, by role, so a reviewer can check each once. */
const ROW = Object.freeze({
  ATTA: 'ifct:A019',          // Wheat flour, atta
  MAIDA: 'usda:789890',       // Flour, wheat, all-purpose
  BESAN: 'usda:174288',       // Chickpea flour (besan) -- USDA; IFCT lists the dal, not the flour
  SORGHUM_FLOUR: 'usda:2512373', // Flour, sorghum -- jowar
  MILLET_FLOUR: 'usda:172023',   // Millet flour -- proso millet, the closest measured analogue for bajra (pearl millet); no measured bajra flour row in the index
  RICE_FLOUR: 'usda:169714',  // Rice flour, white
  RICE: 'usda:169756',        // Rice, white, long-grain, raw
  SEMOLINA: 'usda:2003588',   // Flour, semolina (rava / suji)
  SAGO: 'usda:169717',        // Tapioca, pearl, dry (sabudana)
  MOTH: 'ifct:B016',          // Moth bean (matki)
  MOONG_DAL: 'ifct:B010',     // Green gram, dal
  URAD_DAL: 'ifct:B003',      // Black gram, dal
  POTATO: 'ifct:F006',        // Potato, brown skin
  ONION: 'ifct:G017',         // Onion, big
  TOMATO: 'ifct:D075',        // Tomato, ripe
  CAPSICUM: 'ifct:D033',      // Capsicum, green
  GREEN_CHILLI: 'ifct:G008',  // Chillies, green
  CORIANDER: 'ifct:G009',     // Coriander leaves
  PANEER: 'ifct:L003',        // Paneer
  CURD: 'usda:171284',        // Yogurt, plain, whole milk (home dahi; same row as the curd staple)
  MILK: 'ifct:L002',          // Milk, whole, cow
  GHEE: 'usda:171314',        // Ghee (same row as the ghee staple)
  OIL: 'usda:171410',         // Oil, peanut (groundnut oil; every vegetable oil is ~884 kcal / 100 g)
  PEANUT: 'ifct:H012',        // Ground nut, raw
  CASHEW: 'ifct:H005',        // Cashew nut
  COCONUT_FRESH: 'ifct:H007', // Coconut, kernel, fresh
  COCONUT_DRY: 'ifct:H006',   // Coconut, kernel, dry
  SUGAR: 'usda:169655',       // Sugars, granulated (same row as the sugar staple)
  JAGGERY: 'ifct:I001',       // Jaggery, cane
  FARSAN: 'off:8904071702349', // Mix Farsan (packaged label) -- the misal topping
  EGG: 'usda:171287',         // Egg, whole, raw, fresh
  TOOR_DAL: 'ifct:B021',      // Red gram, dal (toor / arhar)
  MILK_TONED: 'usda:2705385', // the milk staple's row (USDA "Milk, whole", 61 kcal -- close to Indian toned milk ~58-60)
  CUMIN: 'ifct:G025',         // Cumin seeds
  SOYA_CHUNKS: 'off:8906040412976', // Soya chunks, dry (packaged label; same row as the soya chunks staple)
  CARROT: 'ifct:F002',        // Carrot, orange
  CAULIFLOWER: 'ifct:D036',   // Cauliflower
  PEAS: 'ifct:D061',          // Peas, fresh
  OATS: 'usda:169705',        // Oats
  PAV: 'usda:172793',         // Rolls, dinner, plain (same row as the pav staple)
  CHICKEN_LEG: 'usda:173619', // Chicken, broilers or fryers, leg, meat only, raw
  GOAT: 'usda:175303',        // Game meat, goat, raw
  BUTTER: 'cnf:118',          // Butter, regular (same row as the butter staple)
  CREAM: 'usda:170859',       // Cream, fluid, heavy whipping
  TOMATO_PASTE: 'usda:170459', // Tomato products, canned, paste
});

const ing = (ref, g, note) => ({ ref, g, ...(note ? { note } : {}) });

/**
 * RECIPES[key] = {
 *   name, region,
 *   ingredients: [{ ref, g, note? }]   raw grams for ONE batch
 *   cooked_g     finished weight of that batch (the yield assumption)
 *   batch_serves human description of what the batch makes
 *   basis        why the proportions / yield are what they are
 * }
 */
export const RECIPES = Object.freeze({
  misal: {
    name: 'Misal (sprouted matki usal with farsan)',
    region: 'maharashtrian',
    ingredients: [
      ing(ROW.MOTH, 100, 'sprouted and cooked'), ing(ROW.ONION, 60), ing(ROW.TOMATO, 60),
      ing(ROW.COCONUT_DRY, 10, 'kat masala'), ing(ROW.OIL, 20, 'tadka + kat'), ing(ROW.FARSAN, 60, 'topping'),
    ],
    // 100 g dry matki cooks to ~250 g; onion/tomato cook down to ~90 g; the
    // thin "kat"/rassa adds ~260 g of water; plus oil, coconut, farsan.
    cooked_g: 690,
    batch_serves: '3 plates (~230 g each), without pav',
    basis: 'Typical Pune/Kolhapur home misal: 1 part dry matki to ~6 parts finished misal, ~7 g oil and ~20 g farsan per plate.',
  },
  usal: {
    name: 'Usal (sprouted matki curry)',
    region: 'maharashtrian',
    ingredients: [
      ing(ROW.MOTH, 100, 'sprouted and cooked'), ing(ROW.ONION, 60), ing(ROW.TOMATO, 60),
      ing(ROW.COCONUT_DRY, 10), ing(ROW.OIL, 15),
    ],
    cooked_g: 540,
    batch_serves: '3-4 katoris',
    basis: 'Misal without the farsan topping and with a thicker gravy.',
  },
  bhatura: {
    name: 'Bhatura',
    region: 'north_indian',
    ingredients: [
      ing(ROW.MAIDA, 200), ing(ROW.CURD, 50, 'leavening'), ing(ROW.SUGAR, 5), ing(ROW.OIL, 10, 'in the dough'),
      ing(ROW.OIL, 55, 'ABSORBED while deep frying (~15% of fried weight), not the frying bath'),
    ],
    // 200 g maida + 50 g curd + ~75 g water = ~340 g dough; frying drives off
    // ~35 g water and adds the 55 g absorbed oil.
    cooked_g: 360,
    batch_serves: '6 bhature (~60 g each)',
    basis: 'Standard maida-curd dough; oil uptake for deep-fried leavened breads is typically 10-20% of fried weight -- 15% used, shown so it can be checked. INDB "Bhatura" (793 kcal/100 g) is quarantined because it counts the frying bath as eaten.',
  },
  kachori: {
    name: 'Kachori (moong dal, khasta)',
    region: 'north_indian',
    ingredients: [
      ing(ROW.MAIDA, 100), ing(ROW.OIL, 25, 'moyan (shortening in the dough)'), ing(ROW.MOONG_DAL, 40, 'filling'),
      ing(ROW.OIL, 30, 'ABSORBED while deep frying, not the frying bath'),
    ],
    cooked_g: 215,
    batch_serves: '4 kachoris (~54 g each)',
    basis: 'Khasta kachori with spiced moong dal filling. INDB kachori rows are quarantined (frying bath counted as eaten).',
  },
  thalipeeth: {
    name: 'Thalipeeth',
    region: 'maharashtrian',
    ingredients: [
      // bhajani: roasted multigrain flour
      ing(ROW.SORGHUM_FLOUR, 30, 'bhajani'), ing(ROW.MILLET_FLOUR, 25, 'bhajani (bajra)'), ing(ROW.RICE_FLOUR, 15, 'bhajani'),
      ing(ROW.BESAN, 20, 'bhajani'), ing(ROW.URAD_DAL, 10, 'bhajani'),
      ing(ROW.ONION, 40), ing(ROW.CORIANDER, 5), ing(ROW.OIL, 12, 'tawa'),
    ],
    // + ~60 g water to knead; ~30 g lost on the tawa.
    cooked_g: 187,
    batch_serves: '2 thalipeeth (~90 g each)',
    basis: 'Bhajani flour (jowar, bajra, rice, chana, urad) with onion and coriander, patted thin and cooked on a tawa with ~6 g oil each.',
  },
  pithla: {
    name: 'Pithla',
    region: 'maharashtrian',
    ingredients: [ing(ROW.BESAN, 50), ing(ROW.ONION, 40), ing(ROW.GREEN_CHILLI, 5), ing(ROW.OIL, 10, 'tadka')],
    // besan whisked into ~250 g water and cooked down to a thick porridge.
    cooked_g: 280,
    batch_serves: '2 katoris',
    basis: 'Home pithla: 1 part besan to ~5 parts water, cooked thick.',
  },
  zunka: {
    name: 'Zunka',
    region: 'maharashtrian',
    ingredients: [ing(ROW.BESAN, 60), ing(ROW.ONION, 100), ing(ROW.GREEN_CHILLI, 5), ing(ROW.OIL, 20)],
    cooked_g: 200,
    batch_serves: '2 katoris',
    basis: 'Dry besan-onion stir fry (drier than pithla).',
  },
  jowar_bhakri: {
    name: 'Jowar bhakri',
    region: 'maharashtrian',
    ingredients: [ing(ROW.SORGHUM_FLOUR, 100)],
    // + ~70 g water; most of it stays in a soft bhakri.
    cooked_g: 150,
    batch_serves: '2 bhakri (~75 g each)',
    basis: 'Jowar flour and water only, no fat (a dry-roasted flatbread).',
  },
  bajra_bhakri: {
    name: 'Bajra bhakri',
    region: 'maharashtrian',
    ingredients: [ing(ROW.MILLET_FLOUR, 100, 'proso millet flour as the measured analogue for bajra')],
    cooked_g: 150,
    batch_serves: '2 bhakri (~75 g each)',
    basis: 'Bajra flour and water only. USDA millet flour stands in for pearl millet (no measured bajra flour row); the two differ by under 5% in energy in published tables.',
  },
  ven_pongal: {
    name: 'Ven pongal',
    region: 'south_indian',
    ingredients: [
      ing(ROW.RICE, 100), ing(ROW.MOONG_DAL, 50), ing(ROW.GHEE, 20), ing(ROW.CASHEW, 10),
    ],
    // rice + dal cooked with ~4.5 parts water, soft and slightly runny.
    cooked_g: 600,
    batch_serves: '3 bowls (~200 g each)',
    basis: 'Tamil-style ven pongal: 2:1 rice to moong dal, ghee + cashew tempering.',
  },
  paneer_bhurji: {
    name: 'Paneer bhurji',
    region: 'north_indian',
    ingredients: [
      ing(ROW.PANEER, 200), ing(ROW.ONION, 60), ing(ROW.TOMATO, 60), ing(ROW.CAPSICUM, 20),
      ing(ROW.GREEN_CHILLI, 5), ing(ROW.OIL, 15),
    ],
    // ~40 g water cooked off.
    cooked_g: 320,
    batch_serves: '2 katoris (~160 g each)',
    basis: 'Crumbled paneer sautéed with onion, tomato and capsicum in ~7 g oil per serving.',
  },
  paneer_tikka: {
    name: 'Paneer tikka',
    region: 'north_indian',
    ingredients: [
      ing(ROW.PANEER, 200), ing(ROW.CURD, 50, 'marinade'), ing(ROW.BESAN, 10, 'marinade'),
      ing(ROW.CAPSICUM, 40), ing(ROW.ONION, 40), ing(ROW.OIL, 10, 'basting'),
    ],
    // grilled: ~50 g water lost from the paneer and vegetables.
    cooked_g: 300,
    batch_serves: '2 plates (~6 pieces, ~150 g each)',
    basis: 'Curd-marinated paneer with capsicum and onion, grilled/tandoor, lightly basted.',
  },
  aloo_tikki: {
    name: 'Aloo tikki',
    region: 'north_indian',
    ingredients: [
      ing(ROW.POTATO, 300, 'boiled'), ing(ROW.MAIDA, 15, 'binder'), ing(ROW.OIL, 30, 'ABSORBED, shallow-fried'),
    ],
    cooked_g: 320,
    batch_serves: '6 tikki (~53 g each)',
    basis: 'Boiled potato patties, shallow-fried. Street versions fried longer absorb more oil -- use "more oil".',
  },
  sabudana_vada: {
    name: 'Sabudana vada',
    region: 'maharashtrian',
    ingredients: [
      ing(ROW.SAGO, 100, 'soaked'), ing(ROW.POTATO, 150, 'boiled'), ing(ROW.PEANUT, 40, 'roasted, crushed'),
      ing(ROW.OIL, 25, 'ABSORBED while deep frying'),
    ],
    // sago absorbs ~60 g water on soaking; frying drives some off.
    cooked_g: 340,
    batch_serves: '8 vadas (~42 g each)',
    basis: 'Soaked sago, potato and peanuts, deep-fried.',
  },
  ukadiche_modak: {
    name: 'Ukadiche modak',
    region: 'maharashtrian',
    ingredients: [
      ing(ROW.RICE_FLOUR, 100, 'outer shell'), ing(ROW.GHEE, 5), ing(ROW.COCONUT_FRESH, 100, 'filling'),
      ing(ROW.JAGGERY, 60, 'filling'),
    ],
    // + ~100 g water for the shell dough; steamed.
    cooked_g: 350,
    batch_serves: '10 modaks (~35 g each)',
    basis: 'Steamed rice-flour modak with coconut-jaggery filling.',
  },
  egg_biryani: {
    name: 'Egg biryani',
    region: 'indian',
    ingredients: [
      ing(ROW.RICE, 150), ing(ROW.EGG, 100, '2 eggs, boiled'), ing(ROW.ONION, 60, 'fried onions + masala'),
      ing(ROW.TOMATO, 40), ing(ROW.CURD, 30), ing(ROW.OIL, 20), ing(ROW.GHEE, 5),
    ],
    // 150 g raw rice cooks to ~450 g; masala cooks down; ~20 g water lost on dum.
    cooked_g: 680,
    batch_serves: '2 plates (~340 g each, one egg per plate)',
    basis: 'Home egg biryani: rice cooked with an onion-tomato-curd masala, oil and a little ghee, one boiled egg per plate.',
  },
  egg_roll: {
    name: 'Egg roll (kathi / frankie)',
    region: 'indian',
    ingredients: [
      ing(ROW.MAIDA, 60, 'paratha'), ing(ROW.OIL, 10, 'tawa'), ing(ROW.EGG, 50, 'one egg cooked onto the paratha'),
      ing(ROW.ONION, 25), ing(ROW.GREEN_CHILLI, 3),
    ],
    // + ~30 g water in the dough, ~10 g lost on the tawa.
    cooked_g: 168,
    batch_serves: '1 roll',
    basis: 'Kolkata-style egg roll: maida paratha with one egg, onion and chilli. Not the Chinese deep-fried egg roll (ask for "chinese egg roll").',
  },
  /* ---- Phase 2: everyday staples that used to carry HAND-ENTERED values ----
     Each replaces a typed [kcal, protein, carbs, fat] with a calculation from
     measured ingredients. The old hand value is in the comment, so the change
     can be checked. */
  soya_chunks_boiled: {
    name: 'Soya chunks (soaked / boiled)',
    region: 'indian',
    ingredients: [ing(ROW.SOYA_CHUNKS, 100, 'dry chunks')],
    cooked_g: 300,
    batch_serves: '~2 katoris',
    basis: 'Dry chunks boiled or soaked and squeezed take up about twice their weight in water (100 g dry -> ~300 g). Nothing else is added; a curry adds its own gravy.',
  },
  dal_home: {
    name: 'Dal (home, medium consistency)',
    region: 'indian',
    // Was USDA FNDDS "Dal" (145 kcal / 8.6 g protein per 100 g -- about
    // twice INDB's own plain home dals, 35-111 kcal / 100 g).
    ingredients: [ing(ROW.TOOR_DAL, 60), ing(ROW.ONION, 20), ing(ROW.TOMATO, 30), ing(ROW.GHEE, 5, 'tadka'), ing(ROW.CUMIN, 1)],
    cooked_g: 300,
    batch_serves: '2 katoris (~150 g each)',
    basis: 'Toor dal pressure-cooked to a medium consistency (1 part dry dal to 5 parts finished) with a light ghee tadka. Thin dals are lower, thick dals higher -- the consistency is the assumption.',
  },
  dal_tadka: {
    name: 'Dal tadka',
    region: 'indian',
    // hand value was [110, 5, 12, 4.6]
    ingredients: [ing(ROW.TOOR_DAL, 60), ing(ROW.ONION, 30), ing(ROW.TOMATO, 30), ing(ROW.GHEE, 12, 'tadka'), ing(ROW.CUMIN, 2)],
    cooked_g: 300,
    batch_serves: '2 katoris',
    basis: 'Dal with a fuller ghee tadka (~6 g per katori), restaurant/dhaba style.',
  },
  chai: {
    name: 'Chai (milk tea, with sugar)',
    region: 'indian',
    // hand value was [60, 2.1, 8.5, 2]
    ingredients: [ing(ROW.MILK_TONED, 100), ing(ROW.SUGAR, 8, '2 tsp')],
    cooked_g: 150,
    batch_serves: '1 cup (150 ml)',
    basis: '100 ml milk + 50 ml water + 2 tsp sugar per 150 ml cup; tea leaves contribute ~0 kcal.',
  },
  chai_no_sugar: {
    name: 'Chai (no sugar)',
    region: 'indian',
    // hand value was [39, 2.1, 3.1, 2]
    ingredients: [ing(ROW.MILK_TONED, 100)],
    cooked_g: 150,
    batch_serves: '1 cup (150 ml)',
    basis: '100 ml milk + 50 ml water per cup, no sugar.',
  },
  milk_coffee: {
    name: 'Coffee (with milk and sugar)',
    region: 'indian',
    // hand value was [64, 2.6, 8.4, 2.3]
    ingredients: [ing(ROW.MILK_TONED, 120), ing(ROW.SUGAR, 8, '2 tsp')],
    cooked_g: 150,
    batch_serves: '1 cup (150 ml)',
    basis: 'Filter / instant coffee: 120 ml milk + 30 ml decoction + 2 tsp sugar per cup; coffee contributes ~2 kcal.',
  },
  kadhi: {
    name: 'Kadhi',
    region: 'indian',
    // hand value was [95, 3, 8, 5.5]
    ingredients: [ing(ROW.CURD, 200), ing(ROW.BESAN, 30), ing(ROW.OIL, 10, 'tadka')],
    cooked_g: 380,
    batch_serves: '2-3 katoris',
    basis: 'Curd + besan simmered with ~200 g water, oil tadka; no pakoras (add them separately).',
  },
  mix_veg: {
    name: 'Mixed vegetable sabzi',
    region: 'indian',
    // hand value was [86, 2.5, 9, 4.5]
    ingredients: [ing(ROW.POTATO, 100), ing(ROW.CAULIFLOWER, 100), ing(ROW.PEAS, 50), ing(ROW.CARROT, 50), ing(ROW.TOMATO, 50), ing(ROW.ONION, 40), ing(ROW.OIL, 15)],
    cooked_g: 380,
    batch_serves: '2-3 katoris',
    basis: 'Seasonal dry/semi-dry sabzi, ~4 g oil per 100 g; ~25 g water lost in cooking.',
  },
  vada_pav: {
    name: 'Vada pav',
    region: 'maharashtrian',
    // hand value was [200, 5, 28, 7.5] per 100 g at 150 g
    ingredients: [ing(ROW.PAV, 40, 'one pav'), ing(ROW.POTATO, 70, 'boiled, spiced'), ing(ROW.BESAN, 15, 'batter'), ing(ROW.OIL, 10, 'ABSORBED while deep frying')],
    cooked_g: 140,
    batch_serves: '1 vada pav',
    basis: 'One pav with one batata vada (besan-coated, deep-fried); chutneys contribute little.',
  },
  jeera_rice: {
    name: 'Jeera rice',
    region: 'indian',
    // hand value was [151, 3, 27, 3.5]
    ingredients: [ing(ROW.RICE, 100), ing(ROW.GHEE, 10), ing(ROW.CUMIN, 3)],
    cooked_g: 310,
    batch_serves: '2 katoris',
    basis: 'Rice cooked to ~3x its raw weight, tempered with ghee and cumin.',
  },
  tomato_rice: {
    name: 'Tomato rice',
    region: 'south_indian',
    // No measured row exists for tomato rice (thakkali sadam); "tomato
    // rice" matched USDA beef-and-rice or a canned tomato-rice soup.
    ingredients: [ing(ROW.RICE, 100), ing(ROW.TOMATO, 150), ing(ROW.ONION, 40), ing(ROW.OIL, 12, 'tempering')],
    cooked_g: 420,
    batch_serves: '2-3 katoris',
    basis: 'Rice cooked to ~3x its raw weight with tomatoes and onion cooked down in oil, the way thakkali sadam / tomato bath is made at home.',
  },
  oats_porridge: {
    name: 'Oats porridge (with milk)',
    region: 'global',
    // hand value was [114, 5.4, 15, 3.7]
    ingredients: [ing(ROW.OATS, 40), ing(ROW.MILK_TONED, 200)],
    cooked_g: 240,
    batch_serves: '1 bowl',
    basis: '40 g oats cooked in 200 ml milk, no sugar.',
  },
  pakora: {
    name: 'Pakora (onion)',
    region: 'indian',
    // hand value was [282, 6, 25, 17.5]
    ingredients: [ing(ROW.BESAN, 50), ing(ROW.ONION, 60), ing(ROW.OIL, 20, 'ABSORBED while deep frying')],
    cooked_g: 140,
    batch_serves: '~7 pakoras (20 g each)',
    basis: 'Besan batter with onion, deep-fried; ~14% of fried weight is absorbed oil.',
  },
  chicken_biryani: {
    name: 'Chicken biryani',
    region: 'indian',
    // hand value was [170, 8, 20, 6.5]
    ingredients: [
      ing(ROW.RICE, 150), ing(ROW.CHICKEN_LEG, 200, 'edible meat'), ing(ROW.ONION, 80, 'fried onions + masala'),
      ing(ROW.TOMATO, 40), ing(ROW.CURD, 50, 'marinade'), ing(ROW.OIL, 25), ing(ROW.GHEE, 5),
    ],
    cooked_g: 750,
    batch_serves: '2-3 plates (~300 g each)',
    basis: 'Home/restaurant dum biryani: rice cooked to ~3x, chicken loses ~25% water, ~20 g lost on dum.',
  },
  butter_chicken: {
    name: 'Butter chicken (restaurant style)',
    region: 'north_indian',
    // hand value was [189, 13, 6, 12.5]
    ingredients: [
      ing(ROW.CHICKEN_LEG, 250, 'edible meat'), ing(ROW.BUTTER, 30), ing(ROW.CREAM, 60), ing(ROW.TOMATO_PASTE, 30),
      ing(ROW.TOMATO, 150), ing(ROW.ONION, 50), ing(ROW.OIL, 10),
    ],
    cooked_g: 500,
    batch_serves: '3 katoris',
    basis: 'Tandoori chicken in a tomato-butter-cream makhani gravy, restaurant proportions.',
  },
  mutton_curry: {
    name: 'Mutton curry',
    region: 'indian',
    // hand value was [198, 15, 3, 14]
    ingredients: [ing(ROW.GOAT, 250, 'edible meat'), ing(ROW.ONION, 100), ing(ROW.TOMATO, 80), ing(ROW.OIL, 30), ing(ROW.CURD, 30)],
    cooked_g: 450,
    batch_serves: '3 katoris',
    basis: 'Goat curry, ~7 g oil per 100 g. USDA goat meat is lean (109 kcal/100 g raw); fattier cuts read higher.',
  },
  rava_sheera: {
    name: 'Rava sheera',
    region: 'maharashtrian',
    ingredients: [ing(ROW.SEMOLINA, 50), ing(ROW.GHEE, 25), ing(ROW.SUGAR, 50), ing(ROW.MILK, 100)],
    // semolina roasted in ghee, cooked with the milk (+ ~60 g water).
    cooked_g: 280,
    batch_serves: '2 katoris',
    basis: 'Sooji/rava sheera (halwa): 1:1 semolina to sugar, half as much ghee.',
  },
});

/**
 * Price a recipe against the index's measured rows.
 *
 * @param {object} recipe       an entry of RECIPES
 * @param {Map<string,object>} rowsById  source_id -> measured row
 * @returns {null | { per100: Object, components: Array, incomplete: string[],
 *                    raw_g: number, cooked_g: number }}
 *   null when any ingredient row is missing or quarantined -- a recipe is
 *   all-or-nothing; a dish priced without one of its ingredients would be a
 *   silently wrong number.
 */
/**
 * Cooking fats: the oil, ghee and butter a cook ADDS (tadka, frying oil
 * absorbed, butter in a gravy). Their fat is the part of a dish's fat that
 * "less oil" / "more oil" changes -- the dal's, paneer's or meat's own fat is
 * not. Cream is left out: it is an ingredient of the gravy, not cooking oil.
 */
const COOKING_FATS = new Set([ROW.GHEE, ROW.OIL, ROW.BUTTER]);

export function priceRecipe(recipe, rowsById) {
  if (!recipe || !Array.isArray(recipe.ingredients) || !(recipe.cooked_g > 0)) return null;
  let cookingFatG = 0;
  const sums = Object.fromEntries(RECIPE_NUTRIENTS.map((k) => [k, 0]));
  const measured = Object.fromEntries(RECIPE_NUTRIENTS.map((k) => [k, true]));
  const incomplete = [];
  const components = [];
  let rawG = 0;
  for (const it of recipe.ingredients) {
    const row = rowsById.get(it.ref);
    if (!row || row.data_quality_flag || row.energy_kcal == null) return null;
    const f = it.g / 100;
    for (const k of RECIPE_NUTRIENTS) {
      const v = row[k];
      if (v == null) {
        // Not measured for this ingredient. Core macros are reported; the
        // optional micronutrients just become unknown for the dish.
        measured[k] = false;
        if (['protein_g', 'carb_g', 'fat_g'].includes(k)) incomplete.push(`${k} of ${row.food_name}`);
        continue;
      }
      sums[k] += Number(v) * f;
    }
    rawG += it.g;
    if (COOKING_FATS.has(it.ref) && row.fat_g != null) cookingFatG += Number(row.fat_g) * f;
    components.push({
      source_id: it.ref,
      food_name: row.food_name,
      source: row.source,
      grams: it.g,
      energy_kcal: Math.round(Number(row.energy_kcal) * f * 10) / 10,
      ...(it.note ? { note: it.note } : {}),
    });
  }
  const per100 = {};
  for (const k of RECIPE_NUTRIENTS) {
    // A micronutrient missing from ANY ingredient is unknown for the dish
    // (null), never a partial sum dressed up as the total. Energy and the
    // three macros are always reported, with gaps listed in `incomplete`.
    const core = ['energy_kcal', 'protein_g', 'carb_g', 'fat_g'].includes(k);
    per100[k] = core || measured[k]
      ? Math.round((sums[k] / recipe.cooked_g) * 100 * 1000) / 1000
      : null;
  }
  return {
    per100,
    components,
    incomplete,
    raw_g: rawG,
    cooked_g: recipe.cooked_g,
    // Fat from added cooking fat, per 100 g of the finished dish: the known
    // oil baseline for "less oil" / "more oil" (no approximation needed).
    cooking_fat_g_per_100g: Math.round((cookingFatG / recipe.cooked_g) * 100 * 1000) / 1000,
  };
}

/** The row ids every recipe needs (for tests and data checks). */
export function recipeRefs() {
  const out = new Set();
  for (const r of Object.values(RECIPES)) for (const i of r.ingredients) out.add(i.ref);
  return [...out];
}
