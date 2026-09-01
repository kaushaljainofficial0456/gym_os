// ============================================================
// SKOS FOOD ENGINE — COMPOSITE DECOMPOSITION  (Phase 3, Strategy C2)
//
// Turns a `composite_map.json` template into priced components and sums
// them via the EXISTING `CompositionalCalculator` (ml/models/skos-food-v1/
// compositional.reference.js) — the same summation engine Tier 4 (foodAI.js)
// already trusts for LLM-proposed components, now reused for curated
// templates instead of building a second summing implementation.
//
// Mass-reconciliation invariant (architecture §10): fractions are
// re-normalized to sum to 1.0 before scaling, and the scaled component
// grams are asserted to reconstruct the requested total within 0.1% by
// construction (they're derived FROM it, not independently estimated) —
// the >25% re-scale path exists only as a defensive invariant check, not
// because it is expected to trigger.
//
// This module NEVER decomposes a food on its own initiative — it only runs
// when the CALLER (food/engine.js's applyPhase3) has already decided a
// fragment is composite AND that no good single-row match exists for it.
// It never invents a dish structure: no `composite_map` entry for the
// requested `dish_key` means `{ ok: false }`, full stop — no LLM, no guess.
// ============================================================
'use strict';

import { getCompositeDish } from './classify.js';

const round1 = (x) => Math.round(x * 10) / 10;

/**
 * @param {string} dishKey        a composite_map.json key (from classifyComposite)
 * @param {number} totalGrams     the requested total edible mass for the dish
 * @param {{getCompositionalCalculator: Function}} deps  injected so this stays testable without the full foodEstimator singleton
 * @returns {object} `{ ok:true, ... }` or `{ ok:false, reason }`
 */
export function decompose(dishKey, totalGrams, deps) {
  const dish = getCompositeDish(dishKey);
  if (!dish) return { ok: false, reason: `no composite_map template for "${dishKey}"` };
  if (!Array.isArray(dish.components) || !dish.components.length) {
    return { ok: false, reason: `composite_map entry "${dishKey}" has no components` };
  }
  const grams = Number(totalGrams);
  if (!(grams > 0)) return { ok: false, reason: 'total grams must be > 0' };

  const fracSum = dish.components.reduce((s, c) => s + (Number(c.typical_fraction) || 0), 0);
  if (!(fracSum > 0)) return { ok: false, reason: `composite_map entry "${dishKey}" has no usable fractions` };

  const ingredients = dish.components.map((c) => ({
    name: c.name,
    amount: (Number(c.typical_fraction) / fracSum) * grams,
    unit: 'g',
    prep_state: c.prep_state || 'unspecified',
  }));

  // Hard invariant (architecture §10): |Σ component_grams - total_edible_g| /
  // total_edible_g <= 0.25. Re-normalizing fractions above already makes this
  // true by construction (up to floating-point noise); this re-scale branch
  // is a defensive backstop, not the primary mechanism.
  const summedBefore = ingredients.reduce((s, i) => s + i.amount, 0);
  const relDelta = Math.abs(summedBefore - grams) / grams;
  let rescaled = false;
  if (relDelta > 0.25 && summedBefore > 0) {
    const scale = grams / summedBefore;
    for (const i of ingredients) i.amount *= scale;
    rescaled = true;
  }

  const calc = deps?.getCompositionalCalculator ? deps.getCompositionalCalculator() : null;
  if (!calc) return { ok: false, reason: 'compositional calculator not available' };

  const computed = calc.compute(
    ingredients.map(({ name, amount, unit }) => ({ name, amount, unit })),
    { servings: 1, dishName: dishKey },
  );
  if (!computed.ok) {
    return { ok: false, reason: computed.reason, unresolved: computed.unresolved };
  }

  const summedAfter = ingredients.reduce((s, i) => s + i.amount, 0);

  // A structured-but-estimated fraction split is never as certain as an
  // exact single measured row (C1) — cap below compute()'s own optimistic
  // ceiling regardless of ingredient coverage, and drop further when a
  // meaningful share of components didn't resolve at all.
  const coverage = computed.coverage || { resolved_ingredients: 0, unresolved_ingredients: 0 };
  const totalParts = coverage.resolved_ingredients + coverage.unresolved_ingredients;
  const resolvedShare = totalParts > 0 ? coverage.resolved_ingredients / totalParts : 0;
  const confidence = resolvedShare >= 0.8 ? 'medium' : 'low';

  return {
    ok: true,
    dish_key: dishKey,
    cuisine: dish.cuisine || null,
    strategy: 'decompose',
    total_grams: round1(grams),
    components: computed.ingredients,
    unresolved_components: computed.unresolved,
    totals: computed.totals,
    confidence,
    mass_reconciliation: {
      requested_g: round1(grams),
      summed_component_g: round1(summedAfter),
      rescaled,
    },
  };
}
