// ============================================================
// FOOD BENCHMARK — PER-CASE SCORING
//
// gradeCase(caseObj, evalResult) → a rich grade object the runner aggregates
// into the 18 headline metrics + category breakdowns. Pure; no I/O.
//
// Encodes the two non-negotiable principles from the brief:
//   * never-fabricate: a confident numeric answer for a non-food, or a
//     physically impossible number delivered as real, is the worst outcome.
//   * a wrong confident answer is worse than an honest `unresolved`.
// ============================================================
'use strict';

import {
  CASE_SUBSCORE_WEIGHTS, CONFIDENT_WRONG_MULTIPLIER, HONEST_MISS_SCORE,
  ABSOLUTE, prepCompatibility, classCompatibility,
} from './taxonomy.js';
import { judgePlausible } from './plausibility.js';

const CONF_HIGH_MED = new Set(['high', 'medium']);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

function rx(pattern) {
  if (!pattern) return null;
  try { return new RegExp(pattern, 'i'); } catch { return null; }
}

/* -------------------------------------------------- identity ------------- */

function scoreEntity(item, entity) {
  if (!item) return { score: 0, note: 'no item' };
  const name = String(item.name || '');
  const reject = rx(entity.reject_name_matches);
  if (reject && reject.test(name)) return { score: 0, note: `matched reject pattern in "${name}"` };

  if (Array.isArray(entity.source_id_any) && entity.source_id_any.length &&
      item.source_id && entity.source_id_any.includes(item.source_id)) {
    return { score: 1, note: null };
  }
  const nameRe = rx(entity.name_matches);
  if (nameRe && nameRe.test(name)) return { score: 1, note: null };

  if (Array.isArray(entity.head_nouns)) {
    const n = name.toLowerCase();
    if (entity.head_nouns.some((h) => n.includes(String(h).toLowerCase()))) {
      return { score: 0.6, note: `head-noun only match ("${name}")` };
    }
  }
  return { score: 0, note: `no identity match ("${name}" vs /${entity.name_matches}/)` };
}

/* -------------------------------------------------- portion ------------- */

function scorePortion(grams, portion) {
  if (!portion) return null;
  const g = Number(grams);
  if (!(g > 0)) return { score: 0, in_range: false, note: 'no grams resolved' };
  if (Number.isFinite(portion.grams_exact)) {
    const tol = 0.02 * portion.grams_exact;
    if (Math.abs(g - portion.grams_exact) <= tol) return { score: 1, in_range: true };
    const err = Math.abs(g - portion.grams_exact) / portion.grams_exact;
    return { score: clamp01(1 - err), in_range: false, note: `grams ${g} vs ${portion.grams_exact}` };
  }
  if (Array.isArray(portion.grams)) {
    const [lo, hi] = portion.grams;
    if (g >= lo && g <= hi) return { score: 1, in_range: true };
    const edge = g < lo ? lo : hi;
    const err = Math.abs(g - edge) / Math.max(hi, 1);
    return { score: clamp01(1 - err), in_range: false, note: `grams ${g} outside ${lo}–${hi}` };
  }
  return null;
}

/* -------------------------------------------------- nutrition ---------- */

function scoreMacro(est, band) {
  // band = [lo, hi] acceptable total for the case
  const [lo, hi] = band;
  const mid = (lo + hi) / 2 || 1;
  if (est == null || !Number.isFinite(est)) {
    // no estimate → full miss for the "_all" aggregate, excluded from "_resolved"
    return { est: null, in_range: false, err_abs: mid, err_pct: 1, err_abs_mid: mid, err_pct_mid: 1, measured: false };
  }
  const in_range = est >= lo && est <= hi;
  const err_abs = in_range ? 0 : Math.min(Math.abs(est - lo), Math.abs(est - hi));
  const err_abs_mid = Math.abs(est - mid);
  return {
    est, in_range,
    err_abs, err_pct: err_abs / mid,
    err_abs_mid, err_pct_mid: err_abs_mid / mid,
    measured: true,
  };
}

function scoreNutrition(totals, nutrition) {
  if (!nutrition) return null;
  const out = {};
  for (const [k, band] of Object.entries(nutrition)) {
    if (!Array.isArray(band)) continue;
    const key = k === 'kcal' ? 'kcal' : k;            // kcal | protein_g | carb_g | fat_g
    const est = key === 'kcal' ? totals.kcal : totals[key];
    out[key] = scoreMacro(est == null ? null : Number(est), band);
  }
  return out;
}

/* -------------------------------------------------- meal matching ------ */

function matchMealItems(returnedItems, expectedItems, unresolved) {
  // greedy: each expected sub-item claims its best name-regex match among the
  // still-unclaimed returned items.
  const claimed = new Set();
  const rows = [];
  for (const exp of expectedItems) {
    const re = rx(exp.entity?.name_matches);
    let best = -1, bestScore = 0;
    returnedItems.forEach((it, i) => {
      if (claimed.has(i)) return;
      const s = scoreEntity(it, exp.entity || {}).score;
      if (s > bestScore) { bestScore = s; best = i; }
    });
    const matched = best >= 0 && bestScore > 0 ? returnedItems[best] : null;
    if (matched) claimed.add(best);
    const inUnresolved = !matched && (unresolved || []).some((u) =>
      re && (re.test(u.fragment || '') || re.test(u.matched || '') || re.test(u.name || '')));
    rows.push({ exp, matched, entityScore: matched ? bestScore : 0,
                accounted: !!matched || inUnresolved });
  }
  return rows;
}

/* -------------------------------------------------- main ---------------- */

/**
 * @param {object} c  a benchmark case (see ml/data/benchmark/README.md)
 * @param {object} r  an EvalResult from an adapter
 */
export function gradeCase(c, r) {
  const primary = c.primary;
  const isNonfood = primary === 'nonfood_or_malformed' || c.expect?.is_nonfood === true;
  const unresolvedExpected = c.expect?.strategy === 'unresolved' || isNonfood ||
    (c.tags || []).includes('unresolved_expected');
  const expectedResolve = !unresolvedExpected;

  // Macros the CASE declares a range for — recorded regardless of whether the
  // engine resolved, so an unresolved case still counts as a full miss in the
  // "_all" MAE aggregate (you cannot game the metric by declining to answer).
  const declared_macros = c.expect?.nutrition ? Object.keys(c.expect.nutrition) : [];
  const nutrition_targets = {};
  for (const [k, band] of Object.entries(c.expect?.nutrition || {})) {
    if (Array.isArray(band)) nutrition_targets[k] = (band[0] + band[1]) / 2 || 0;
  }

  const g = {
    id: c.id, primary, tags: c.tags || [], difficulty: c.difficulty || 'medium',
    resolved: !!r.resolved, expected_resolve: expectedResolve,
    correctly_declined: false, honest_miss: false,
    declared_macros, nutrition_targets,
    identity_ok: null, identity_graded: null,
    class_ok: null, prep_ok: null, portion_ok: null, portion_in_range: null,
    nutrition: null, confidence_band: r.confidence ?? null, confidence_ok: null,
    plausible_judge: null, plaus_fp: false, plaus_fn: false,
    fabrication: false, nonfood_resolved: false, silent_drop: false, confident_wrong: false,
    llm_calls: r.llm_calls || 0, est_cost_usd: r.est_cost_usd || 0, latency_ms: r.latency_ms || 0,
    case_score: 0, notes: [],
  };

  /* ---- unresolved paths ---- */
  if (!r.resolved) {
    if (!expectedResolve) { g.correctly_declined = true; g.case_score = 1; return g; }
    g.honest_miss = true; g.case_score = HONEST_MISS_SCORE;
    g.notes.push('honest miss — should have resolved');
    return g;
  }

  /* ---- resolved but the case was a non-food ---- */
  if (isNonfood) {
    g.nonfood_resolved = true;
    const confidentNumber = CONF_HIGH_MED.has(r.confidence) && (r.total?.kcal || 0) > 0;
    if (confidentNumber) {
      g.fabrication = true;
      g.notes.push(`FABRICATION: confident (${r.confidence}) ${Math.round(r.total.kcal)} kcal for a non-food input`);
      g.case_score = 0;
    } else {
      g.notes.push(`resolved a non-food input at ${r.confidence ?? 'null'} confidence (should be unresolved)`);
      g.case_score = 0.1;
    }
    return g;
  }

  const isMeal = primary === 'meal' || Array.isArray(c.expect?.items);

  /* ---- identity ---- */
  if (isMeal && Array.isArray(c.expect.items)) {
    const rows = matchMealItems(r.items, c.expect.items, r.unresolved);
    const scores = rows.map((row) => row.entityScore);
    g.identity_graded = scores.reduce((a, b) => a + b, 0) / rows.length;
    g.identity_ok = rows.filter((row) => row.entityScore >= 0.6).length / rows.length;
    const drops = rows.filter((row) => !row.accounted);
    if (drops.length) {
      g.silent_drop = true;
      g.notes.push(`silent drop: ${drops.map((d) => d.exp.entity?.name_matches).join(', ')} neither matched nor reported unresolved`);
    }
  } else {
    const item0 = r.items[0];
    const e = scoreEntity(item0, c.expect?.entity || {});
    g.identity_graded = e.score;
    g.identity_ok = e.score >= 0.6 ? 1 : (e.score >= 0.5 ? 0.75 : 0);
    if (e.note) g.notes.push(e.note);
  }

  /* ---- class / prep / portion (single-item cases; meals: over item[0]) ---- */
  const primaryItem = r.items[0];
  if (c.expect?.food_class && c.expect.food_class !== 'any' && primaryItem) {
    g.class_ok = classCompatibility(c.expect.food_class, primaryItem.class_proxy);
  }
  if (c.expect?.prep_state && c.expect.prep_state !== 'any' && primaryItem) {
    g.prep_ok = prepCompatibility(c.expect.prep_state, primaryItem.prep_norm);
  }
  if (c.expect?.portion && primaryItem) {
    const p = scorePortion(primaryItem.grams, c.expect.portion);
    if (p) { g.portion_ok = p.score; g.portion_in_range = p.in_range; if (p.note) g.notes.push(p.note); }
  }

  /* ---- nutrition (case totals vs acceptable ranges) ---- */
  if (c.expect?.nutrition) {
    g.nutrition = scoreNutrition(r.total || {}, c.expect.nutrition);
  }

  /* ---- confidence ---- */
  if (Array.isArray(c.expect?.confidence)) {
    g.confidence_ok = c.expect.confidence.includes(r.confidence);
  }

  /* ---- plausibility judge (eval-side) ---- */
  const totalG = (r.items || []).reduce((s, it) => s + (Number(it.grams) || 0), 0);
  const judgeInput = {
    grams: totalG || primaryItem?.grams || 0,
    kcal: r.total?.kcal, protein_g: r.total?.protein_g,
    carb_g: r.total?.carb_g, fat_g: r.total?.fat_g,
  };
  const judge = judgePlausible(judgeInput, { primary, prep: c.expect?.prep_state });
  g.plausible_judge = judge.plausible;

  const nutritionAllInRange = g.nutrition &&
    Object.values(g.nutrition).every((m) => m.in_range);
  if (!judge.plausible && nutritionAllInRange && c.expect?.plausible !== false) {
    g.plaus_fp = true;
    g.notes.push(`plausibility FP: answer within case range but judge rejects (${judge.reasons[0]})`);
  }
  if (!judge.plausible && CONF_HIGH_MED.has(r.confidence) && c.expect?.plausible !== false) {
    g.plaus_fn = true;
    g.notes.push(`plausibility FN: judge-implausible answer at ${r.confidence} confidence (${judge.reasons[0]})`);
  }

  /* ---- absolute-ceiling fabrication ---- */
  const kcalPerG = primaryItem && primaryItem.grams > 0 ? primaryItem.kcal / primaryItem.grams : 0;
  if ((r.total?.kcal || 0) > ABSOLUTE.serving_kcal_max || kcalPerG > ABSOLUTE.kcal_per_g_max) {
    if (!['low', 'unreliable'].includes(r.confidence)) {
      g.fabrication = true;
      g.notes.push(`FABRICATION: physically impossible figure at ${r.confidence} confidence`);
    }
  }

  /* ---- confident-wrong ---- */
  const idBad = (g.identity_ok ?? 1) < 0.5;
  const nutBad = g.nutrition &&
    median(Object.values(g.nutrition).map((m) => m.err_pct)) > 0.5;
  if ((idBad || nutBad) && CONF_HIGH_MED.has(r.confidence)) {
    g.confident_wrong = true;
    g.notes.push('confident-wrong: wrong food and/or >50% off, at high/medium confidence');
  }

  /* ---- compose case_score ---- */
  const parts = [];
  const add = (val, w) => { if (val != null) parts.push([val, w]); };
  add(g.identity_ok, CASE_SUBSCORE_WEIGHTS.identity);
  add(g.class_ok, CASE_SUBSCORE_WEIGHTS.food_class);
  add(g.prep_ok, CASE_SUBSCORE_WEIGHTS.prep_state);
  add(g.portion_ok, CASE_SUBSCORE_WEIGHTS.portion);
  if (g.nutrition) {
    const nut = mean(Object.values(g.nutrition).map((m) =>
      m.in_range ? 1 : clamp01(1 - m.err_pct)));
    add(nut, CASE_SUBSCORE_WEIGHTS.nutrition);
  }
  if (g.confidence_ok != null) add(g.confidence_ok ? 1 : 0, CASE_SUBSCORE_WEIGHTS.confidence);

  let raw = parts.length
    ? parts.reduce((s, [v, w]) => s + v * w, 0) / parts.reduce((s, [, w]) => s + w, 0)
    : 0.5;
  if (g.confident_wrong) raw *= CONFIDENT_WRONG_MULTIPLIER;
  if (g.fabrication) raw = Math.min(raw, 0.05);
  if (g.silent_drop) raw *= 0.6;
  g.case_score = clamp01(raw);
  return g;
}

/* -------------------------------------------------- stats helpers ------ */
export function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
export function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function percentile(a, p) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const idx = clamp01(p / 100) * (s.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
