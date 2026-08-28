// ============================================================
// SKOS FOOD ENGINE — PLAUSIBILITY STAGE  (Phase 2)
//
// Judges a COMPLETED estimate item (a matched record scaled to a portion)
// against wide, class-aware nutritional bounds. On an implausible result it
// asks the caller to DOWNGRADE confidence and attach a reason. It NEVER
// changes a nutrition number and NEVER unresolves a food.
//
// Coarse class / prep are derived deterministically from the matched row +
// item name — NOT the Phase-3 classifier (which will later feed the
// query-intent class into `checkPlausibility` through the same signature).
//
// The bounds live in ml/data/overlays/category_plausibility.json, loaded
// lazily and cached. If the overlay is absent the check degrades to a no-op
// (verdict 'pass') — same graceful-degradation contract as getFoodSearch().
//
// This module is pure apart from the one lazy JSON read. No LLM. No parsing.
// No nutrition arithmetic beyond re-deriving per-100g density from the item's
// own already-computed calories/grams.
// ============================================================
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY = path.resolve(HERE, '..', '..', '..', '..', 'ml', 'data', 'overlays', 'category_plausibility.json');

let _cfg;
let _loadTried = false;

/** Returns the parsed overlay, or null if it can't be loaded. Cached. */
export function loadPlausibility() {
  if (_loadTried) return _cfg ?? null;
  _loadTried = true;
  try {
    _cfg = JSON.parse(fs.readFileSync(OVERLAY, 'utf8'));
  } catch {
    _cfg = null; // degrade to no-op
  }
  return _cfg ?? null;
}

/* ------------------------------------------------------------------ *
 *  Coarse class / prep — deterministic, row-derived (Phase 2)        *
 * ------------------------------------------------------------------ */

const BEVERAGE_RE = /\b(juice|milk|lassi|chaas|chaach|buttermilk|smoothie|shake|tea|chai|coffee|latte|cappuccino|cola|coke|pepsi|soda|soft ?drink|lemonade|nimbu ?pani|shikanji|sherbet|sharbat|kombucha|beer|lager|ale|wine|water|drink)\b/i;
const CONDIMENT_RE = /\b(sauce|ketchup|catsup|chutney|mayonnaise|mayo|jam|marmalade|preserve|pickle|achar|dressing|paste|syrup|dip|spread|relish|marinade|seasoning|oil|ghee|butter|honey|vinegar)\b/i;
const DISH_RE = /\b(curry|gravy|soup|stew|dal|daal|sambar|sambhar|rasam|kadhi|kadi|biryani|biriyani|pulao|pilaf|pilau|risotto|casserole|lasagn|salad|sandwich|burger|cheeseburger|pizza|wrap|roll|taco|burrito|quesadilla|noodle|pasta|spaghetti|bolognese|stir.?fry|fried rice|shakshuka|hummus|falafel|bibimbap|pho|ramen|paella|tagine|jollof|moussaka|paratha|parantha|dosa|idli|poha|upma|khichdi|khichri|halwa|kheer|payasam|chaat|bhaji|bhajji|pakora|pakoda|samosa|vada|tikki|thali|platter)\b/i;
const FRIED_NAME_RE = /\b(fried|deep.?fried|deep fry|pakora|pakoda|bhaji|bhajji|samosa|puri|poori|bhatura|vada|fries|french fried|tempura|crisp|chips|papad|papdi|jalebi|doughnut|donut|namkeen|sev|bhujia)\b/i;

/** @param {object} item  a food-v1 item  @param {object|null} row  the matched unified_food_db row (or null) */
export function coarseClassOf(item, row) {
  const name = String(item?.name || row?.food_name || '').toLowerCase();
  if (row && (row.brand || row.cuisine === 'PACKAGED')) return 'branded_product';
  if (BEVERAGE_RE.test(name) && !/\b(curry|soup|stew|shake mix|milk cake|milkshake cake)\b/i.test(name)) return 'beverage';
  if (CONDIMENT_RE.test(name) && !DISH_RE.test(name)) return 'condiment';
  if ((row && row.category === 'indian_dish') || DISH_RE.test(name)) return 'dish';
  return 'ingredient';
}

/** @returns {'raw'|'cooked'|'fried'|'any'} */
export function coarsePrepOf(item, row) {
  const name = String(item?.name || row?.food_name || '').toLowerCase();
  const cs = String(item?.cooking_state || row?.cooking_state || '').toLowerCase();
  if (FRIED_NAME_RE.test(name)) return 'fried';
  if (cs === 'raw') return 'raw';
  if (cs === 'cooked') return 'cooked';
  return 'any'; // ready_to_eat | unspecified | missing
}

/* ------------------------------------------------------------------ *
 *  The check                                                         *
 * ------------------------------------------------------------------ */

const clampPct = (x) => (Number.isFinite(x) ? Math.max(0, x) : 0);

/** how far `v` sits outside [lo,hi], as a fraction of the band's own scale */
function outsideFraction(v, band) {
  if (v == null || !Array.isArray(band)) return 0;
  const [lo, hi] = band;
  if (v >= lo && v <= hi) return 0;
  const edge = v < lo ? lo : hi;
  return clampPct(Math.abs(v - edge) / Math.max(Math.abs(hi), Math.abs(lo), 1));
}

/**
 * @param {object} item  a food-v1 item ({ calories, protein, carbs, fat, grams, name, cooking_state, source_id, ... })
 * @param {object|null} row  the matched unified_food_db row, if available (for class/prep derivation)
 * @param {{ classHint?: string, prepHint?: string }} [hints]  Phase 3+ passes the query-intent class here
 * @returns {{ verdict:'pass'|'soft_fail'|'hard_fail', reasons:string[], klass:string, prep:string, details:object }}
 */
export function checkPlausibility(item, row = null, hints = {}) {
  const cfg = loadPlausibility();
  const g = Number(item?.grams);
  if (!cfg || !(g > 0) || g < (cfg?.action?.min_grams_to_judge ?? 5)) {
    return { verdict: 'pass', reasons: [], klass: 'n/a', prep: 'n/a', details: {} };
  }

  const klass = hints.classHint || coarseClassOf(item, row);
  const prep = hints.prepHint || coarsePrepOf(item, row);
  const byClass = cfg.ranges[klass] || cfg.ranges.ingredient;
  const band = byClass[prep] || byClass.any || cfg.ranges.ingredient.any;

  const kcal = Number(item.calories);
  const per100 = (x) => (x == null || !Number.isFinite(Number(x)) ? null : (Number(x) / g) * 100);
  const k100 = Number.isFinite(kcal) ? (kcal / g) * 100 : null;
  const p100 = per100(item.protein);
  const c100 = per100(item.carbs);
  const f100 = per100(item.fat);

  const fracs = {
    kcal_density: outsideFraction(k100, band.kcal_100g),
    protein_density: outsideFraction(p100, band.protein_100g),
    carb_density: outsideFraction(c100, band.carb_100g),
    fat_density: outsideFraction(f100, band.fat_100g),
    serving_kcal: outsideFraction(kcal, band.serving_kcal),
  };
  const worst = Math.max(...Object.values(fracs));

  // Atwater self-consistency (mathematical, independent of the class bands).
  // SKIPPED for beverages: ethanol (~7 kcal/g) and sugar alcohols carry energy
  // that 4P+4C+9F does not count, so a beer / sweet drink legitimately runs a
  // high kcal:Atwater ratio and must not be flagged for it.
  let atwaterBad = false;
  if (klass !== 'beverage'
      && [item.protein, item.carbs, item.fat].every((x) => x != null && Number.isFinite(Number(x)))) {
    const expected = item.protein * 4 + item.carbs * 4 + item.fat * 9;
    if (expected <= 0) {
      atwaterBad = kcal > (cfg.atwater?.near_zero_macros_kcal_ceiling ?? 60);
    } else {
      const ratio = kcal / expected;
      atwaterBad = ratio < (cfg.atwater?.min_ratio ?? 0.5) || ratio > (cfg.atwater?.max_ratio ?? 2.0);
    }
  }

  const reasons = [];
  for (const [k, v] of Object.entries(fracs)) {
    if (v >= (cfg.action.soft_fail_outside_pct ?? 0.12)) {
      const label = { kcal_density: `${Math.round(k100)} kcal/100g`, protein_density: `${p100?.toFixed(1)} g protein/100g`,
        carb_density: `${c100?.toFixed(1)} g carb/100g`, fat_density: `${f100?.toFixed(1)} g fat/100g`,
        serving_kcal: `${Math.round(kcal)} kcal for this portion` }[k];
      reasons.push(`${label} is outside the plausible range for a ${prep === 'any' ? '' : prep + ' '}${klass}`);
    }
  }
  if (atwaterBad) reasons.push('stated calories are inconsistent with its protein/carb/fat (Atwater)');

  let verdict = 'pass';
  if (worst >= (cfg.action.hard_fail_outside_pct ?? 0.30) || (atwaterBad && cfg.action.hard_fail_on_atwater)) {
    verdict = 'hard_fail';
  } else if (worst >= (cfg.action.soft_fail_outside_pct ?? 0.12)) {
    verdict = 'soft_fail';
  }

  return {
    verdict, reasons, klass, prep,
    details: { kcal_100g: k100 == null ? null : Math.round(k100), protein_100g: p100, carb_100g: c100, fat_100g: f100, worst_outside_fraction: Math.round(worst * 100) / 100, atwater_bad: atwaterBad },
  };
}

// test hook — clears the lazy cache so a test can point at a different overlay
export function _resetForTests() { _cfg = undefined; _loadTried = false; }
