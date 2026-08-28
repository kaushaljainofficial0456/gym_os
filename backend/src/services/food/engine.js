// ============================================================
// SKOS FOOD ENGINE — CANONICAL CORE  (Phase 1)
//
// THE single import surface for food identification, search, and nutrition
// estimation. Routes and food-facing services import from here (or the
// food/index.js barrel), never from a second engine.
//
// PHASE 1 CONTRACT: this layer is BEHAVIOUR-IDENTICAL to the pre-existing
// `foodEstimator.js`. `estimateMeal` / `resolveFood` / `priceFood` are
// thin, documented wrappers that return exactly what `estimateFood` /
// `searchFoods` / `resolveFoodQuantity` return today — same `food-v1`
// shapes, same numbers, same parsing, same never-fabricate behaviour. The
// implementation still lives in `foodEstimator.js` (unchanged apart from the
// contains-pass trust fix and two additive re-exports); this module makes it
// the one canonical entry point and hangs the future pipeline (food/
// pipeline.js) off the same core. The staged pipeline is NOT wired into any
// live estimate in Phase 1.
//
// No LLM. No composite engine. No food-specific logic. No nutrition math
// changes.
// ============================================================
'use strict';

import * as impl from '../foodEstimator.js';

/* ------------------------------------------------------------------ *
 *  Canonical entry points  (Phase 1 = pass-through)                  *
 * ------------------------------------------------------------------ */

/**
 * Estimate a whole logged meal from free text.
 * PHASE 1: identical to `estimateFood(text)`. `ctx` is accepted for forward
 * compatibility (locale / cuisine hint) and is unused today.
 *
 * @param {string} text
 * @param {import('./types.js').Ctx} [ctx]
 * @returns {import('./types.js').MealEstimate}
 */
export function estimateMeal(text, ctx = {}) {
  void ctx;
  return impl.estimateFood(text);
}

/**
 * Ranked food search for the picker UI (FoodMatch shapes + portions).
 * PHASE 1: identical to `searchFoods(query, opts)`.
 *
 * @param {string} query
 * @param {{limit?:number, withPortions?:boolean}} [opts]
 * @param {import('./types.js').Ctx} [ctx]
 */
export function resolveFood(query, opts = {}, ctx = {}) {
  void ctx;
  return impl.searchFoods(query, opts);
}

/**
 * Resolve a chosen portion (+ optional oil level) into grams and final macros
 * for ONE food, without logging.
 * PHASE 1: identical to `resolveFoodQuantity(food, opts)`.
 *
 * @param {Object} food
 * @param {{portionKey?:string,count?:number,grams?:number,oilLevel?:string}} [opts]
 * @param {import('./types.js').Ctx} [ctx]
 */
export function priceFood(food, opts = {}, ctx = {}) {
  void ctx;
  return impl.resolveFoodQuantity(food, opts);
}

/* ------------------------------------------------------------------ *
 *  Legacy-named primitives — re-exported verbatim so no caller needs *
 *  to import `foodEstimator.js` directly. Zero behaviour change.     *
 * ------------------------------------------------------------------ */

export const {
  estimateFood,
  searchFoods,
  resolveFoodQuantity,
  getFoodSearch,
  modelAvailable,
  scaleNutrition,
  estimateFromBarcode,
  estimateCompositional,
  estimateFoodKnn,
  getCompositionalCalculator,
  getKnnFallback,
  getBarcodeIndex,
  cleanCode,
  canonicalEan13,
  resolveServing,
  splitItems,
  parseFragment,
  SOURCE_RANK,
} = impl;

// NOTE: the raw string→string `normalize` (reference primitive) is NOT
// re-exported here — the barrel's `normalize` is the pipeline STAGE below
// (`{ raw, text, tokens }`). `pipeline.js` gets the raw primitive from
// `foodEstimator.js` directly. Nothing else needs the raw form.

/* ------------------------------------------------------------------ *
 *  `foodSearch` — the ONE FoodSearch instance, exposed for the       *
 *  meal-template builder's SKOS fallback (me.js). Replaces the       *
 *  retired, encoding-corrupted second copy at                        *
 *  backend/src/services/skos-food/foodEstimate.reference.cjs.        *
 *                                                                     *
 *  Same `.search(query, opts)` surface that the old `foodSearch`     *
 *  exposed, now backed by the lazily-built canonical index so the    *
 *  meal builder resolves a name identically to every other path      *
 *  (and with correct Unicode normalisation — the retired copy's      *
 *  combining-marks regex was mojibake and stripped nothing).         *
 * ------------------------------------------------------------------ */

export const foodSearch = {
  /**
   * @param {string} query
   * @param {{limit?:number,cuisine?:string|null,allowBackoff?:boolean,allowFuzzy?:boolean}} [opts]
   */
  search(query, opts = {}) {
    const s = impl.getFoodSearch();
    if (!s) return [];
    return s.search(query, opts);
  },
};

/* ------------------------------------------------------------------ *
 *  Pipeline stages + IR types — the future staged engine, hung off   *
 *  the same core. Not wired into `estimateMeal` in Phase 1.          *
 * ------------------------------------------------------------------ */

export {
  normalize, segment, classify, retrieve,
  filter as filterCandidates, rank, selectStrategy, inspect,
} from './pipeline.js';

export {
  makeCtx, emptyClassification, isFragment, isMealEstimate,
  FOOD_KINDS, STRATEGIES,
} from './types.js';
