// ============================================================
// FOOD BENCHMARK — TAXONOMY, WEIGHTS, COMPATIBILITY MATRICES
//
// Phase 0 measurement infrastructure. This module is DATA ONLY — it defines
// how benchmark cases are categorised and how category scores roll up into a
// weighted overall. It never touches the estimator.
//
// Two orthogonal classifications per case:
//   `primary`  — one mutually-exclusive bucket (how the case is scored/weighted)
//   `tags[]`   — many cross-cutting labels (cuisine, prep, namespace, portion
//                style, linguistic difficulty) reported as their own slices
// ============================================================
'use strict';

/** Mutually-exclusive primary categories + their weight in the overall score.
 *  Weights ≈ real-world logging frequency, NOT equal — a regression in
 *  `composite_dish` matters more than one in `sauce_condiment`. Sum ≈ 1.0. */
export const PRIMARY_CATEGORIES = {
  single_ingredient: { weight: 0.17, label: 'Single ingredient' },
  prepared_food:     { weight: 0.17, label: 'Prepared food' },
  composite_dish:    { weight: 0.22, label: 'Composite dish' },
  meal:              { weight: 0.12, label: 'Meal (multi-food)' },
  beverage:          { weight: 0.10, label: 'Beverage' },
  snack:             { weight: 0.08, label: 'Snack' },
  dessert:           { weight: 0.06, label: 'Dessert' },
  sauce_condiment:   { weight: 0.04, label: 'Sauce / condiment' },
  nonfood_or_malformed: { weight: 0.04, label: 'Non-food / malformed' },
};

/** Cross-cutting tag groups. Each group is reported as its own breakdown so a
 *  gain in one cuisine that masks a loss in another is visible. */
export const TAG_GROUPS = {
  cuisine: ['indian', 'south_asian', 'east_asian', 'middle_eastern', 'european',
            'american', 'latin_american', 'african', 'mediterranean', 'global'],
  prep: ['raw', 'boiled', 'steamed', 'grilled', 'roasted', 'baked', 'fried',
         'cooked_wet', 'cooked_dry', 'ready_to_eat'],
  namespace: ['branded', 'generic'],
  portion_style: ['explicit_grams', 'count_portion', 'volume_portion',
                  'nl_quantity', 'no_quantity'],
  linguistic: ['alias', 'transliteration', 'spelling_variant', 'ambiguous'],
  structure: ['multi_food', 'stuffed', 'topped', 'combo'],
  difficulty: ['easy', 'medium', 'hard'],
  expectation: ['low_confidence_expected', 'unresolved_expected'],
};

/** Every strategy label a case may declare it expects. V1 can only ever report
 *  `direct` or `unresolved`; the rest are documented expected behaviour that
 *  V2 phases will be graded against. */
export const STRATEGIES = ['direct', 'prep_variant', 'decompose', 'semantic',
                           'llm', 'rescue', 'unresolved'];

/** Preparation-state compatibility for partial credit. 1.0 = exact / clearly
 *  the same thing, 0.5 = adjacent (a generic "cooked" row for a "grilled"
 *  expectation), 0 = contradictory (raw for fried). `any` in the expectation
 *  always scores 1.0. Keys are the NORMALISED prep vocabulary. */
const PREP_ADJ = {
  raw:         { raw: 1, unspecified: 0.5 },
  boiled:      { boiled: 1, cooked: 0.8, cooked_wet: 0.7, steamed: 0.6, unspecified: 0.4 },
  steamed:     { steamed: 1, boiled: 0.6, cooked: 0.7, unspecified: 0.4 },
  grilled:     { grilled: 1, roasted: 0.8, baked: 0.6, cooked: 0.6, cooked_dry: 0.6, unspecified: 0.3 },
  roasted:     { roasted: 1, grilled: 0.8, baked: 0.8, cooked: 0.6, cooked_dry: 0.6, unspecified: 0.3 },
  baked:       { baked: 1, roasted: 0.8, cooked: 0.6, cooked_dry: 0.6, unspecified: 0.3 },
  fried:       { fried: 1, cooked_dry: 0.5, cooked: 0.4, unspecified: 0.2 },
  cooked_wet:  { cooked_wet: 1, cooked: 0.85, boiled: 0.6, unspecified: 0.35 },
  cooked_dry:  { cooked_dry: 1, cooked: 0.8, roasted: 0.6, baked: 0.6, fried: 0.5, unspecified: 0.35 },
  cooked:      { cooked: 1, cooked_wet: 0.9, cooked_dry: 0.9, boiled: 0.8, steamed: 0.7, grilled: 0.7, roasted: 0.7, baked: 0.7, fried: 0.6, unspecified: 0.4 },
  ready_to_eat:{ ready_to_eat: 1, cooked: 0.6, unspecified: 0.6 },
  unspecified: { unspecified: 1, raw: 0.6, cooked: 0.6, ready_to_eat: 0.6 },
};

export function prepCompatibility(expected, actual) {
  if (!expected || expected === 'any') return 1;
  if (!actual) return 0;
  const e = String(expected).toLowerCase();
  const a = String(actual).toLowerCase();
  if (e === a) return 1;
  return (PREP_ADJ[e] && PREP_ADJ[e][a]) || 0;
}

/** Food-class compatibility (identity proxy). `dish` and `recipe` are treated
 *  as interchangeable; `meal` is only ever expected on multi-food cases. */
const CLASS_ADJ = {
  ingredient:       { ingredient: 1, condiment: 0.4 },
  dish:             { dish: 1, recipe: 1, prepared: 0.7 },
  recipe:           { recipe: 1, dish: 1, prepared: 0.7 },
  prepared:         { prepared: 1, dish: 0.7, ingredient: 0.5 },
  branded_product:  { branded_product: 1 },
  beverage:         { beverage: 1 },
  condiment:        { condiment: 1, ingredient: 0.4 },
  meal:             { meal: 1, dish: 0.5 },
};

export function classCompatibility(expected, actual) {
  if (!expected || expected === 'any') return 1;
  if (!actual) return 0;
  const e = String(expected).toLowerCase();
  const a = String(actual).toLowerCase();
  if (e === a) return 1;
  return (CLASS_ADJ[e] && CLASS_ADJ[e][a]) || 0;
}

/** Per-case score weighting of the sub-components. Identity dominates — a wrong
 *  food makes every downstream number meaningless. */
export const CASE_SUBSCORE_WEIGHTS = {
  identity: 0.34,
  food_class: 0.10,
  prep_state: 0.12,
  portion: 0.14,
  nutrition: 0.22,
  confidence: 0.08,
};

/** THE PRINCIPLE, ENCODED: a wrong answer delivered confidently is worse than
 *  an honest non-answer. A case that resolves to the wrong food OR a
 *  materially wrong calorie figure, while reporting `high`/`medium`
 *  confidence, has its whole per-case score multiplied by this. */
export const CONFIDENT_WRONG_MULTIPLIER = 0.2;

/** An honest `unresolved` on a case that SHOULD have resolved: not zero (it
 *  preserved the never-fabricate principle) but clearly a miss. */
export const HONEST_MISS_SCORE = 0.30;

/** Absolute physical ceilings for the fabrication check (independent of any
 *  category range). Nothing edible exceeds ~9 kcal/g; a single logged serving
 *  above ~4000 kcal or ~4 kg is a unit error, not a food. */
export const ABSOLUTE = {
  kcal_per_g_max: 9.1,
  serving_kcal_max: 4000,
  serving_grams_max: 4000,
};
