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
import { checkPlausibility, coarseClassOf } from './plausibility.js';

/* ------------------------------------------------------------------ *
 *  Engine version selection                                          *
 *                                                                    *
 *  V1 is the immutable baseline. V2 = V1 + a post-COMPUTE plausibility*
 *  pass + a quarantine-rescue pass (architecture Phase 2). V2 runs    *
 *  ONLY when explicitly requested — `ctx.engine === 'v2'` or          *
 *  FOOD_ENGINE_V2=1 — so every live route stays byte-identical to V1  *
 *  until a later, gated cutover.                                      *
 * ------------------------------------------------------------------ */

function v2Enabled(ctx) {
  return ctx?.engine === 'v2' || process.env.FOOD_ENGINE_V2 === '1';
}

/* ------------------------------------------------------------------ *
 *  Canonical entry points                                            *
 * ------------------------------------------------------------------ */

/**
 * Estimate a whole logged meal from free text.
 *
 * DEFAULT (no `ctx.engine`): byte-identical to `estimateFood(text)` — the
 * frozen V1 behaviour and permanent regression floor.
 *
 * `ctx.engine === 'v2'` (or FOOD_ENGINE_V2=1): applies Phase-2 post-processing
 * over the V1 result — a plausibility pass that DOWNGRADES CONFIDENCE (never a
 * number, never an unresolve) on an implausible record, and a quarantine
 * rescue that turns a data-quality-flagged drop into a clearly-labelled
 * similar-food estimate instead of a silent zero. Parsing, nutrition
 * arithmetic and the never-fabricate contract are untouched.
 *
 * @param {string} text
 * @param {import('./types.js').Ctx & {engine?:string}} [ctx]
 * @returns {import('./types.js').MealEstimate}
 */
export function estimateMeal(text, ctx = {}) {
  const base = impl.estimateFood(text);
  if (!v2Enabled(ctx)) return base;
  return applyPhase2(base);
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

// Phase 2 — plausibility stage, exported for direct use + tests.
export { checkPlausibility, coarseClassOf, coarsePrepOf, loadPlausibility } from './plausibility.js';

/* ================================================================== *
 *  PHASE 2 — post-COMPUTE plausibility + quarantine rescue            *
 *                                                                    *
 *  Operates on a COMPLETED V1 result. It may:                        *
 *    - attach `item.plausibility` and, on a hard fail, drop that      *
 *      item's `confidence` to 'low' (never 'high'/'medium' on a       *
 *      record whose scaled numbers are implausible for its kind);     *
 *    - move a data-quality-flagged `unresolved` entry into `items`    *
 *      as a labelled similar-food estimate (`source: 'knn_estimate'`, *
 *      `trustworthy: false`, `estimate_status: 'quarantine_rescue'`,  *
 *      `confidence: 'low'`) — never a silent zero.                    *
 *  It NEVER changes a matched record's nutrition values, NEVER        *
 *  re-parses differently, NEVER unresolves a food that V1 resolved.   *
 * ================================================================== */

const RANK = { high: 0, medium: 1, low: 2, unreliable: 3 };
const round1 = (x) => Math.round(x * 10) / 10;
const downgrade = (band) => (band === 'unreliable' ? 'unreliable' : 'low');

// Only rescue a quarantined drop when kNN actually has a defensible similar
// food. Below this, a rough guess is worse than an honest "couldn't match
// this" — so we leave it unresolved (V1 behaviour) rather than resolve it wrong.
const RESCUE_MIN_SIMILARITY = 0.40;

const titleCase = (s) => String(s || '').replace(/\b\w/g, (m) => m.toUpperCase());

function rowFor(sourceId) {
  const s = impl.getFoodSearch();
  return (s && s.bySourceId && s.bySourceId.get(sourceId)) || null;
}

/** A trust-gate (quarantine) drop is the ONLY `unresolved` entry that carries
 *  `matched` AND is not the "could not resolve a quantity" case. */
function isQuarantineDrop(u) {
  return !!u && typeof u.matched === 'string' && u.matched.length > 0
    && u.reason !== 'could not resolve a quantity'
    && u.reason !== 'no food named in this part'
    && !/^no match for /.test(String(u.reason || ''));
}

function tryRescue(u) {
  const parsed = impl.parseFragment(u.fragment);
  if (!parsed || !parsed.name) return null;

  // Re-locate the quarantined record for its COOKING-STATE hint only.
  const s = impl.getFoodSearch();
  const qrow = (s ? s.search(parsed.name, { limit: 1 })[0] : null) || null;

  // Portion: size from the parsed qty/unit against the household-portion
  // catalogue, NOT the quarantined row's own `serving_grams` — some
  // data-quality flags ARE "this serving weight is impossible". An explicit
  // mass/volume the user typed still wins (resolveGrams handles that first).
  let grams = 100;
  try {
    const q = impl.resolveGrams(parsed, { food_name: parsed.name });
    if (q && Number(q.grams) > 0) grams = Math.min(1500, Math.max(10, Number(q.grams)));
  } catch { /* keep 100 */ }

  const knn = impl.estimateFoodKnn(parsed.name, { grams });
  if (!knn || !knn.totals || !(Number(knn.totals.calories) >= 0)) return null;
  if (!(Number(knn.top_similarity) >= RESCUE_MIN_SIMILARITY)) return null; // weak → stay honestly unresolved

  const rescue = {
    // The name is the USER'S term, not the quarantined record's — this is an
    // estimate FOR THE QUERY from similar foods, using the quarantined record
    // for nothing but a cooking-state hint.
    name: titleCase(parsed.name),
    unit: `${Math.round(grams)} g (estimated)`,
    qty: parsed.qty == null ? 1 : parsed.qty,
    calories: Math.round(knn.totals.calories),
    protein: knn.totals.protein,
    carbs: knn.totals.carbs,
    fat: knn.totals.fat,
    source_id: null,
    source: 'knn_estimate',
    grams: round1(grams),
    grams_basis: 'estimated',
    grams_assumed: true,
    // a rescue of a QUARANTINED match is inherently shaky — capped at 'low'
    // so it can never be presented confidently and can never trip the
    // fabrication ceiling check (which exempts low/unreliable).
    confidence: 'low',
    trustworthy: false,
    match_kind: 'knn_similarity',
    cooking_state: (qrow && qrow.cooking_state) || 'unspecified',
    matched_from: u.fragment,
    fiber_g: null, sugar_g: null, sodium_mg: null,
    // additive labelling
    estimate_status: 'quarantine_rescue',
    matched_neighbor: knn.matched_neighbor || null,
    replaced_reason: u.reason,
  };

  // Don't emit a rescue we can't stand behind: if the similar-food estimate is
  // itself nutritionally implausible for its kind, an honest "couldn't match
  // this" is better than a wrong number wearing an "estimated" label.
  if (checkPlausibility(rescue, null).verdict === 'hard_fail') return null;
  return rescue;
}

export function applyPhase2(base) {
  if (!base || !Array.isArray(base.items)) return base;

  let worst = 'high';
  let changed = false;
  const items = [];
  const total = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  let downgrades = 0, advisories = 0, rescues = 0;

  // 1 — plausibility pass over the items V1 already resolved
  for (const it of base.items) {
    const chk = checkPlausibility(it, rowFor(it.source_id));
    let out = it;
    if (chk.verdict === 'hard_fail') {
      out = { ...it, confidence: downgrade(it.confidence), plausibility: { verdict: 'hard_fail', reasons: chk.reasons, details: chk.details } };
      if (out.confidence !== it.confidence) changed = true;
      changed = true; downgrades++;
    } else if (chk.verdict === 'soft_fail') {
      out = { ...it, plausibility: { verdict: 'soft_fail', reasons: chk.reasons, details: chk.details } };
      changed = true; advisories++;
    }
    items.push(out);
    if (RANK[out.confidence] > RANK[worst]) worst = out.confidence;
    total.calories += Number(out.calories) || 0;
    total.protein += Number(out.protein) || 0;
    total.carbs += Number(out.carbs) || 0;
    total.fat += Number(out.fat) || 0;
  }

  // 2 — quarantine rescue over the trust-gate drops (never touches a genuine
  //     "no match" / "no food named" entry)
  const stillUnresolved = [];
  for (const u of (base.unresolved || [])) {
    if (!isQuarantineDrop(u)) { stillUnresolved.push(u); continue; }
    const rescued = tryRescue(u);
    if (!rescued) { stillUnresolved.push(u); continue; }
    items.push(rescued);
    rescues++; changed = true;
    if (RANK[rescued.confidence] > RANK[worst]) worst = rescued.confidence;
    total.calories += rescued.calories || 0;
    total.protein += rescued.protein || 0;
    total.carbs += rescued.carbs || 0;
    total.fat += rescued.fat || 0;
  }

  if (!changed) return base;

  return {
    ...base,
    items,
    total: {
      calories: Math.round(total.calories),
      protein: round1(total.protein),
      carbs: round1(total.carbs),
      fat: round1(total.fat),
    },
    confidence: items.length ? worst : null,
    unresolved: stillUnresolved,
    disclaimer: stillUnresolved.length
      ? 'Some items could not be matched and are NOT included in the total.'
      : (rescues
        ? 'Some items are estimated from similar foods, not direct matches — see the item labels.'
        : base.disclaimer),
    engine: 'v2',
    v2: { plausibility_downgrades: downgrades, plausibility_advisories: advisories, quarantine_rescues: rescues },
  };
}
