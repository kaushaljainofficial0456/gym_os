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
export function priceRecipe(recipe, rowsById) {
  if (!recipe || !Array.isArray(recipe.ingredients) || !(recipe.cooked_g > 0)) return null;
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
  return { per100, components, incomplete, raw_g: rawG, cooked_g: recipe.cooked_g };
}

/** The row ids every recipe needs (for tests and data checks). */
export function recipeRefs() {
  const out = new Set();
  for (const r of Object.values(RECIPES)) for (const i of r.ingredients) out.add(i.ref);
  return [...out];
}
