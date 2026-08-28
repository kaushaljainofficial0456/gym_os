// ============================================================
// SKOS FOOD ENGINE — INTERMEDIATE REPRESENTATION (IR)
//
// Phase 1 of the Universal Food Estimation Architecture. This module defines
// the TYPED CONTRACT for the staged pipeline
//
//     normalize → segment → classify → retrieve → filter → rank → strategy
//
// It contains typedefs + a few pure constructors/guards ONLY. No estimation
// logic, no I/O, no imports from the estimator. Later phases fill the stages
// (see food/pipeline.js); Phase 1 wires none of them into a live estimate —
// they exist so the pipeline can be built and unit-tested incrementally
// without ever changing what `estimateMeal` returns.
//
// The FINAL result shapes (`FoodEstimateItem`, `MealEstimate`) are the
// EXISTING `food-v1` API contract, documented here so the wrapper in
// food/engine.js is provably a pass-through.
// ============================================================
'use strict';

/**
 * @typedef {Object} Ctx  Request context threaded through every stage.
 * @property {string|null} [cuisine_hint]  a caller/locale hint, never authoritative
 * @property {string|null} [locale]
 * @property {string|null} [tz]
 * @property {number} [now]  epoch ms; defaults to Date.now() at call time
 */

/**
 * @typedef {Object} NormalizedInput  Output of `normalize`.
 * @property {string} raw     the untouched input
 * @property {string} text    canonical lowercase form (NFKD, diacritics stripped, punctuation → space)
 * @property {string[]} tokens whitespace tokens of `text`
 */

/**
 * @typedef {'standalone'|'and'|'with'|'combo'} FragmentRelation
 */

/**
 * @typedef {Object} Fragment  One quantified item extracted from a sentence.
 * @property {string} raw            the fragment as split from the sentence
 * @property {number|null} qty       leading quantity, or null
 * @property {string|null} unit      recognised mass/volume/portion unit, or null
 * @property {string} name_phrase    the food-name text after qty/unit/noise removal
 * @property {string[]} modifiers    descriptive words seen but not part of the name (Phase 2+ populates)
 * @property {FragmentRelation} relation  how this fragment relates to its neighbours
 */

/**
 * @typedef {'ingredient'|'prepared'|'composite'|'branded'|'beverage'|'meal'|'unknown'} FoodKind
 */

/**
 * @typedef {Object} FoodClassification  Output of `classify` (Phase 3 fills it).
 * @property {FoodKind} kind
 * @property {string|null} prep_intent   raw|boiled|steamed|grilled|roasted|baked|fried|cooked_wet|cooked_dry|ready_to_eat|null
 * @property {string|null} cuisine_hint
 * @property {string|null} brand_token
 * @property {string[]} modifiers_normalised
 * @property {number} confidence         0..1 — how sure the classifier is (Phase 1 stub: 0)
 */

/**
 * @typedef {Object} QualityProfile  Per-candidate data-quality evidence (Phase 4 fills it).
 * @property {number} source_rank
 * @property {number|null} completeness
 * @property {boolean|null} atwater_ok
 * @property {boolean} has_serving
 * @property {boolean} quarantined       has a data_quality_flag
 * @property {boolean} per100g_unreliable
 */

/**
 * @typedef {Object} Evidence  Why a candidate is a candidate (Phase 3 fills the ML parts).
 * @property {string|null} match_kind
 * @property {number|null} token_coverage
 * @property {boolean|null} phrase_match
 * @property {number|null} semantic_sim
 * @property {boolean|null} head_noun_match
 * @property {boolean|null} prep_compatible
 * @property {boolean|null} namespace_match
 * @property {boolean|null} cuisine_match
 * @property {QualityProfile|null} quality_profile
 */

/**
 * @typedef {Object} Candidate  A retrieved database row + its evidence.
 * @property {Object} row              the unified_food_db row (or a FoodMatch shape from the ranked path)
 * @property {string} source_id
 * @property {Evidence} evidence
 * @property {number|null} [score]     set by `rank`
 */

/**
 * @typedef {Object} RetrievalResult  Output of `retrieve`.
 * @property {Candidate[]} candidates
 * @property {string[]} layers_used    e.g. ['exact','token'] — Phase 2 adds 'semantic', Phase 8 'llm'
 */

/**
 * @typedef {Object} RankedResult  Output of `rank`.
 * @property {Candidate[]} ranked
 * @property {number|null} top1_margin  normalised score[0]-score[1]; drives escalation & confidence (Phase 3+)
 */

/**
 * @typedef {'direct'|'prep_variant'|'decompose'|'semantic'|'llm'|'rescue'|'unresolved'} Strategy
 */

/**
 * @typedef {Object} StrategySelection  Output of `selectStrategy`.
 * @property {Strategy} strategy
 * @property {string} reason
 * @property {Candidate|null} candidate
 */

/* ---------------- FINAL RESULT SHAPES (existing food-v1 API contract) ------ */

/**
 * @typedef {Object} FoodEstimateItem  One resolved item in a MealEstimate. UNCHANGED from today.
 * @property {string} name
 * @property {string} unit           human portion description, e.g. "2 x roti", "150 g"
 * @property {number} qty
 * @property {number} calories       rounded
 * @property {number|null} protein
 * @property {number|null} carbs
 * @property {number|null} fat
 * @property {string} source_id
 * @property {string} source
 * @property {number} grams
 * @property {string} grams_basis    measured|count|volume|measured_serving|food_serving|assumed_100g
 * @property {boolean} grams_assumed
 * @property {'high'|'medium'|'low'|'unreliable'} confidence
 * @property {boolean} trustworthy
 * @property {string|null} match_kind
 * @property {string} cooking_state
 * @property {string} matched_from
 * @property {number|null} fiber_g
 * @property {number|null} sugar_g
 * @property {number|null} sodium_mg
 */

/**
 * @typedef {Object} MealEstimate  Return of `estimateMeal` / `estimateFood`. UNCHANGED from today.
 * @property {string} text
 * @property {FoodEstimateItem[]} items
 * @property {{calories:number,protein:number,carbs:number,fat:number}} total
 * @property {true} estimate
 * @property {'food-v1'} schema_version
 * @property {number} [tier]
 * @property {string} [model_version]
 * @property {boolean} [model_available]
 * @property {'high'|'medium'|'low'|'unreliable'|null} confidence
 * @property {Array<{fragment:string,reason:string,matched?:string}>} unresolved
 * @property {string} disclaimer
 */

/* ---------------- pure constructors / guards (testable, no deps) ----------- */

/** Normalise a caller-supplied context; never throws. */
export function makeCtx(ctx = {}) {
  return {
    cuisine_hint: ctx.cuisine_hint ?? null,
    locale: ctx.locale ?? null,
    tz: ctx.tz ?? null,
    now: Number.isFinite(ctx.now) ? ctx.now : Date.now(),
  };
}

/** A valid Phase-1 classification with nothing inferred yet. */
export function emptyClassification(ctx = {}) {
  return {
    kind: 'unknown',
    prep_intent: null,
    cuisine_hint: ctx.cuisine_hint ?? null,
    brand_token: null,
    modifiers_normalised: [],
    confidence: 0,
  };
}

export const FOOD_KINDS = /** @type {FoodKind[]} */ ([
  'ingredient', 'prepared', 'composite', 'branded', 'beverage', 'meal', 'unknown',
]);

export const STRATEGIES = /** @type {Strategy[]} */ ([
  'direct', 'prep_variant', 'decompose', 'semantic', 'llm', 'rescue', 'unresolved',
]);

/** @param {any} x @returns {x is Fragment} */
export function isFragment(x) {
  return !!x && typeof x === 'object'
    && typeof x.raw === 'string'
    && (x.qty === null || typeof x.qty === 'number')
    && (x.unit === null || typeof x.unit === 'string')
    && typeof x.name_phrase === 'string'
    && Array.isArray(x.modifiers)
    && ['standalone', 'and', 'with', 'combo'].includes(x.relation);
}

/** @param {any} x @returns {x is MealEstimate} */
export function isMealEstimate(x) {
  return !!x && typeof x === 'object'
    && Array.isArray(x.items)
    && x.total && typeof x.total.calories === 'number'
    && x.estimate === true
    && x.schema_version === 'food-v1'
    && Array.isArray(x.unresolved)
    && typeof x.disclaimer === 'string';
}
