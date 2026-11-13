// ============================================================
// NUTRITION PROVENANCE — where a logged number came from, decided on the
// server, and the server-side re-pricing that makes "verified" mean
// something.
//
// Every logged food carries ONE of these source classes (meal_logs.
// nutrition_source). They are ordered by how much a number can be trusted:
//
//   verified_database   a measured food-composition row (IFCT 2017, INDB,
//                       USDA FoodData Central, Canadian Nutrient File),
//                       scaled by the server from the grams logged
//   brand_label         a packaged product's printed label (Open Food Facts
//                       transcriptions, a scanned label, a curated label)
//   recipe_calculation  computed from a documented recipe's measured
//                       ingredients (food/recipes.js) or a curated staple
//                       whose value is a recipe estimate
//   ai_estimate         proposed by an AI model (components grounded where
//                       possible, see intelligence/foodAI.js)
//   user_provided       typed in by the person, or a saved meal they built
//   previous_log        copied from one of the person's own earlier logs
//   plan                a trainer's plan meal
//
// THE RULE: a client can never ASSERT a trusted class. "verified_database",
// "brand_label" and "recipe_calculation" are only ever assigned here, after
// the server has found the row itself and priced the grams itself. A client
// hint can only move an item DOWN the list (an AI estimate stays an AI
// estimate; a number with no row behind it is user_provided).
// ============================================================
'use strict';

import { priceBySourceId } from '../foodEstimator.js';

export const NUTRITION_SOURCES = Object.freeze([
  'verified_database', 'brand_label', 'recipe_calculation', 'ai_estimate',
  'user_provided', 'previous_log', 'plan',
]);

/** Classes a client may claim: only ones that make no trust claim. */
const CLIENT_CLAIMABLE = new Set(['ai_estimate', 'user_provided', 'previous_log']);

/** The source class of a food-database / staple / recipe row. */
export function nutritionSourceForRow(row) {
  if (!row) return 'user_provided';
  const src = String(row.source || '');
  const sid = String(row.source_id || '');
  if (src === 'SKOS_RECIPE' || sid.startsWith('recipe:')) return 'recipe_calculation';
  if (src === 'SKOS_STAPLE' || sid.startsWith('staple:')) {
    // A curated staple with no measured row carries its own value; say what
    // KIND of value it is (see food/staples.js `basis`).
    if (row.basis === 'usda') return 'verified_database';
    if (row.basis === 'label') return 'brand_label';
    return 'recipe_calculation';
  }
  if (src === 'OPEN_FOOD_FACTS' || sid.startsWith('off:')) return 'brand_label';
  if (['IFCT2017', 'INDB', 'USDA_FDC', 'CNF_CANADA'].includes(src)) return 'verified_database';
  return 'user_provided';
}

/** foods.source (the gym / My Foods table) -> source class. */
export function nutritionSourceForFoodsTable(source) {
  switch (String(source || '').toUpperCase()) {
    case 'VERIFIED_DATABASE': return 'verified_database';
    case 'PACKAGING_LABEL':
    case 'OCR_EXTRACTED': return 'brand_label';
    case 'ESTIMATED': return 'ai_estimate';
    default: return 'user_provided';
  }
}

const r1 = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 10) / 10);

/**
 * Decide what to STORE for one logged item.
 *
 * With a `source_id` and `grams`, the server re-prices the item from the
 * row itself; the client's numbers are kept only as a cross-check (and the
 * difference is reported, never silently trusted). Without one, the client's
 * numbers are stored with the most cautious class the item allows.
 *
 * @param {object} it  a validated log item (validate.js mealLogBatch item)
 * @returns {{calories:number, protein:number, carbs:number, fat:number,
 *            fiber:number|null, sugar:number|null, sodium:number|null,
 *            grams:number|null, source_id:string|null,
 *            nutrition_source:string, repriced:boolean, client_delta_kcal:number|null}}
 */
export function resolveLoggedNutrition(it) {
  const isAI = ['ai', 'ai_estimated', 'ai_estimated_user_adjusted', 'knn_estimated'].includes(it.source);
  if (it.source_id && Number(it.grams) > 0 && !isAI) {
    const p = priceBySourceId(it.source_id, Number(it.grams), { stapleKey: it.staple_key || null, oil: it.oil || null });
    if (p) {
      const t = p.totals;
      const kcal = Math.round(Number(t.calories) || 0);
      return {
        calories: kcal,
        protein: r1(t.protein) ?? 0,
        carbs: r1(t.carbs) ?? 0,
        fat: r1(t.fat) ?? 0,
        fiber: r1(t.fiber),
        sugar: r1(t.sugar),
        sodium: r1(t.sodium),
        grams: r1(p.grams),
        source_id: it.source_id,
        nutrition_source: nutritionSourceForRow(p.row),
        repriced: Math.abs(kcal - Math.round(Number(it.calories) || 0)) > Math.max(2, kcal * 0.02),
        client_delta_kcal: Math.round(Number(it.calories) || 0) - kcal,
      };
    }
  }
  const hinted = CLIENT_CLAIMABLE.has(it.nutrition_source) ? it.nutrition_source : null;
  const cls = isAI ? 'ai_estimate' : it.source === 'plan' ? 'plan' : (hinted || 'user_provided');
  return {
    calories: Math.round(Number(it.calories) || 0),
    protein: r1(it.protein) ?? 0,
    carbs: r1(it.carbs) ?? 0,
    fat: r1(it.fat) ?? 0,
    fiber: r1(it.fiber),
    sugar: r1(it.sugar),
    sodium: r1(it.sodium),
    grams: Number(it.grams) > 0 ? r1(it.grams) : null,
    source_id: null,
    nutrition_source: cls,
    repriced: false,
    client_delta_kcal: null,
  };
}
