// ============================================================
// FOOD BENCHMARK — ENGINE ADAPTERS
//
// An adapter turns one benchmark case into a NORMALISED result the scorer can
// grade, and records latency + LLM usage + estimated cost. Adapters are the
// ONLY place that imports the estimator, and they call it READ-ONLY.
//
//   v1Adapter  — the current production deterministic engine
//                (backend/src/services/foodEstimator.js, unchanged).
//   v2Adapter  — a stub. Wired in a later phase; shares this exact contract so
//                a future engine is graded on identical cases.
//
// Normalised result shape (EvalResult):
//   {
//     resolved: boolean,
//     strategy: 'direct'|'unresolved'|...   (v1 can only produce the first two)
//     items: [{
//       name, source_id, source, grams, grams_basis, decomposed,
//       kcal, protein_g, carb_g, fat_g,
//       confidence,               // 'high'|'medium'|'low'|'unreliable'|null
//       prep_norm,                // normalised cooking state
//       class_proxy,              // DERIVED, not an engine output — see deriveClass()
//       namespace_proxy,          // 'branded'|'generic', DERIVED
//     }],
//     total: { kcal, protein_g, carb_g, fat_g },
//     confidence: band|null,      // meal-level
//     unresolved: [{fragment, reason}],
//     llm_calls: number,
//     est_cost_usd: number,
//     latency_ms: number,
//   }
// ============================================================
'use strict';

import { performance } from 'node:perf_hooks';
import * as V1 from '../services/foodEstimator.js';
import * as FOOD from '../services/food/index.js';

/* ---------------------------------------------------------------- */
/*  Derived proxies — clearly labelled, never presented as engine output.     */
/* ---------------------------------------------------------------- */

/** Map the estimator's raw cooking_state onto the benchmark's normalised
 *  vocabulary. The engine only ever emits raw|cooked|ready_to_eat|unspecified,
 *  so wet/dry/method detail is inferred from the matched food name. */
export function normPrep(row, itemName) {
  const cs = String(row?.cooking_state || row?._cs || '').toLowerCase();
  const n = String(itemName || row?.food_name || '').toLowerCase();
  if (cs === 'raw') return 'raw';
  if (cs === 'ready_to_eat') return 'ready_to_eat';
  if (cs === 'cooked') {
    if (/\b(fried|deep.fried|pakora|bhaji|bhajji|samosa|puri|poori|vada|fries|tempura|crisp)\b/.test(n)) return 'fried';
    if (/\b(roast|roasted|tandoori|grill|grilled|bbq|barbecue)\b/.test(n)) return 'roasted';
    if (/\b(bake|baked)\b/.test(n)) return 'baked';
    if (/\b(steam|steamed|idli|dhokla|momo)\b/.test(n)) return 'steamed';
    if (/\b(boil|boiled|poach)\b/.test(n)) return 'boiled';
    if (/\b(curry|gravy|dal|daal|sambar|rasam|soup|stew|kadhi|korma|makhani|rajma|rajmah|chole|kheer|halwa|lassi|khichdi|porridge)\b/.test(n)) return 'cooked_wet';
    return 'cooked';
  }
  return 'unspecified';
}

/** Coarse food-class from a matched database row. HEURISTIC — used only to give
 *  V1 a food-class baseline number where the engine itself produces none. */
export function deriveClass(row, itemName) {
  const n = String(itemName || row?.food_name || '').toLowerCase();
  if (!row) return 'unknown';
  if (row.brand || row.cuisine === 'PACKAGED') return 'branded_product';
  if (/\b(juice|milk|lassi|chaas|buttermilk|tea|coffee|cola|soda|soft drink|shake|smoothie|water|beer|wine|kombucha|sherbet|sharbat)\b/.test(n)) return 'beverage';
  if (/\b(sauce|ketchup|catsup|chutney|mayonnaise|mayo|jam|marmalade|pickle|achar|dressing|paste|syrup|dip|spread|relish|marinade|seasoning)\b/.test(n)) return 'condiment';
  if (row.category === 'indian_dish') return 'dish';
  if (/\b(curry|gravy|soup|stew|dal|daal|sambar|rasam|biryani|biriyani|pulao|pilaf|risotto|casserole|lasagne|lasagna|salad|sandwich|burger|pizza|wrap|roll|taco|burrito|noodle|pasta|stir.fry|fried rice|shakshuka|hummus|falafel|bibimbap|pho|ramen|paella|tagine|jollof)\b/.test(n)) return 'dish';
  return 'ingredient';
}

export function deriveNamespace(row) {
  return (row?.brand || row?.cuisine === 'PACKAGED') ? 'branded' : 'generic';
}

/* ---------------------------------------------------------------- */
/*  V1 adapter                                                                */
/* ---------------------------------------------------------------- */

let _search = null;
function rowFor(sourceId) {
  if (!_search) { try { _search = V1.getFoodSearch(); } catch { _search = null; } }
  return (_search && _search.bySourceId && _search.bySourceId.get(sourceId)) || null;
}

/** Warm every lazily-built index once so the first real case (or the first V2
 *  quarantine rescue) is not billed the one-time build. Returns whether the
 *  core model is available at all. */
export function v1Warmup() {
  try {
    V1.estimateFood('rice');                 // builds the FoodSearch index
    try { V1.estimateFoodKnn('warmup'); } catch { /* kNN artifact optional */ }
    return V1.modelAvailable();
  } catch { return false; }
}

export const v1Adapter = {
  id: 'v1',
  label: 'current production engine (foodEstimator.js / skos-food-v1, deterministic Tier 1)',
  llm: false,

  /** @param {{input:string}} c benchmark case  @returns {EvalResult} */
  run(c) {
    return runAndShape(c, () => V1.estimateFood(c.input), { engine: 'v1' });
  },
};

/**
 * V2 — the canonical `food/` engine with `ctx.engine === 'v2'` (architecture
 * Phase 2: plausibility downgrade + quarantine rescue over the V1 result).
 * Same normalised EvalResult contract as V1, graded on identical cases.
 * Still deterministic and local — no LLM, no cost (Phase 2 introduces neither).
 */
export const v2Adapter = {
  id: 'v2',
  label: 'v2 engine (food/engine.js, Phase 2 — plausibility gate + quarantine rescue)',
  llm: false,
  run(c) {
    return runAndShape(c, () => FOOD.estimateMeal(c.input, { engine: 'v2' }), { engine: 'v2' });
  },
};

/**
 * V3 — v2 + composite-dish classification/decomposition (architecture
 * Phase 3, Strategy C1/C2). Still deterministic and local: composite_map.json
 * is a curated overlay, decompose.js sums through the existing
 * CompositionalCalculator — no LLM, no cost.
 */
export const v3Adapter = {
  id: 'v3',
  label: 'v3 engine (food/engine.js, Phase 3 — composite classification + decomposition)',
  llm: false,
  run(c) {
    return runAndShape(c, () => FOOD.estimateMeal(c.input, { engine: 'v3' }), { engine: 'v3' });
  },
};

/** Shared: run an engine callable, shape its food-v1 envelope into an EvalResult. */
function runAndShape(c, call, { engine }) {
  const t0 = performance.now();
  let raw;
  try {
    raw = call();
  } catch (err) {
    return {
      resolved: false, strategy: 'error', items: [],
      total: { kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0 },
      confidence: null,
      unresolved: [{ fragment: c.input, reason: `engine threw: ${err.message}` }],
      llm_calls: 0, est_cost_usd: 0, latency_ms: performance.now() - t0, error: String(err.message),
    };
  }
  const latency_ms = performance.now() - t0;

  const items = (raw.items || []).map((it) => {
    const row = rowFor(it.source_id);
    return {
      name: it.name,
      source_id: it.source_id ?? null,
      source: it.source ?? row?.source ?? null,
      grams: Number(it.grams) || 0,
      grams_basis: it.grams_basis ?? null,
      // additive V2/V3 signals — ignored by V1, used by the report for observability
      decomposed: it.estimate_status === 'composite_decomposed',
      estimate_status: it.estimate_status ?? null,          // 'quarantine_rescue' (V2) | 'composite_decomposed' (V3)
      plausibility: it.plausibility?.verdict ?? null,        // 'soft_fail' | 'hard_fail' on a V2-flagged item
      kcal: numOrNull(it.calories),
      protein_g: numOrNull(it.protein),
      carb_g: numOrNull(it.carbs),
      fat_g: numOrNull(it.fat),
      confidence: it.confidence ?? null,
      prep_norm: normPrep({ cooking_state: it.cooking_state, food_name: it.name, ...row }, it.name),
      class_proxy: deriveClass(row, it.name),
      namespace_proxy: deriveNamespace(row),
    };
  });

  const rescued = items.filter((i) => i.estimate_status === 'quarantine_rescue').length;
  return {
    resolved: items.length > 0,
    strategy: items.length > 0 ? (rescued && rescued === items.length ? 'rescue' : 'direct') : 'unresolved',
    items,
    total: {
      kcal: numOrNull(raw.total?.calories) ?? 0,
      protein_g: numOrNull(raw.total?.protein) ?? 0,
      carb_g: numOrNull(raw.total?.carbs) ?? 0,
      fat_g: numOrNull(raw.total?.fat) ?? 0,
    },
    confidence: raw.confidence ?? null,
    unresolved: raw.unresolved || [],
    llm_calls: 0,               // Phase 2/3 add no external calls (kNN rescue + composite decomposition are local + deterministic)
    est_cost_usd: 0,
    latency_ms,
    v2: raw.v2 ?? null,
    v3: raw.v3 ?? null,
  };
}

export function getAdapter(id) {
  if (id === 'v1') return v1Adapter;
  if (id === 'v2') return v2Adapter;
  if (id === 'v3') return v3Adapter;
  throw new Error(`unknown engine "${id}" (expected v1 | v2 | v3)`);
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
