// ============================================================
// FOOD BENCHMARK — RUNNER + AGGREGATION
//
// runBenchmark(dataset, adapter, opts) → a full report object:
//   { meta, metrics (the 18), categories, tag_slices, calibration,
//     weighted_overall, worst_cases, per_case[] }
//
// Read-only. The adapter is the only thing that touches the estimator.
// ============================================================
'use strict';

import { performance } from 'node:perf_hooks';
import { gradeCase, mean, median, percentile } from './score.js';
import { PRIMARY_CATEGORIES, TAG_GROUPS } from './taxonomy.js';

const CONF_NOMINAL = { high: 0.90, medium: 0.65, low: 0.40, unreliable: 0.15 };
const MACROS = [['kcal', 'kcal'], ['protein_g', 'protein'], ['carb_g', 'carb'], ['fat_g', 'fat']];
const rate = (n, d) => (d ? n / d : 0);
const r3 = (x) => Math.round(x * 1000) / 1000;
const r1 = (x) => Math.round(x * 10) / 10;

export function runBenchmark(dataset, adapter, opts = {}) {
  const cases = (opts.filter ? dataset.cases.filter(opts.filter) : dataset.cases);
  const grades = [];
  const runStart = performance.now();

  for (const c of cases) {
    const res = adapter.run(c);
    const grade = gradeCase(c, res);
    grade._result = opts.keepResults ? res : undefined;
    grades.push(grade);
  }
  const wallMs = performance.now() - runStart;

  /* ---------- 1–4, 15: identity / class / prep / portion / namespace ---- */
  const withIdentity = grades.filter((g) => g.identity_ok != null);
  const withClass = grades.filter((g) => g.class_ok != null);
  const withPrep = grades.filter((g) => g.prep_ok != null);
  const withPortion = grades.filter((g) => g.portion_ok != null);

  const identity_accuracy = rate(withIdentity.filter((g) => g.identity_ok >= 0.5).length, withIdentity.length);
  const identity_graded = mean(withIdentity.map((g) => g.identity_graded ?? 0));
  const class_accuracy = rate(withClass.filter((g) => g.class_ok >= 0.5).length, withClass.length);
  const prep_accuracy = rate(withPrep.filter((g) => g.prep_ok >= 0.5).length, withPrep.length);
  const prep_graded = mean(withPrep.map((g) => g.prep_ok));
  const portion_accuracy = rate(withPortion.filter((g) => g.portion_in_range).length, withPortion.length);
  const portion_graded = mean(withPortion.map((g) => g.portion_ok));

  const brandCases = cases.map((c, i) => ({ c, g: grades[i] }))
    .filter(({ c }) => (c.tags || []).includes('branded') || (c.tags || []).includes('generic'));
  const nsGrade = ({ c, g }) => {
    if (!g.resolved || !g._result) return null;
    const want = (c.tags || []).includes('branded') ? 'branded' : 'generic';
    const got = g._result.items?.[0]?.namespace_proxy;
    return got ? (got === want ? 1 : 0) : null;
  };
  // namespace proxy needs the result; recompute lightly if results weren't kept
  const brand_generic_accuracy = brandCases.length
    ? computeNamespace(brandCases, adapter)
    : { overall: null, branded: null, generic: null, n: 0 };

  /* ---------- 5: composite decomposition ---- */
  const composite = grades.filter((g) => g.primary === 'composite_dish');
  const compDecompAttempt = rate(composite.filter((g) => g._result?.items?.some((i) => i.decomposed)).length, composite.length);
  const compKcalInRange = rate(
    composite.filter((g) => g.nutrition?.kcal?.in_range).length,
    composite.filter((g) => g.nutrition?.kcal).length);
  const compScore = mean(composite.map((g) => g.case_score));

  /* ---------- 6–9: macro MAE / MAPE (3 variants) ---- */
  const macroMetrics = {};
  for (const [key, short] of MACROS) {
    const withMacro = grades.filter((g) =>
      g.expected_resolve && g.declared_macros.includes(key));   // cases that DECLARE this macro range
    const resolvedWith = withMacro.filter((g) => g.resolved && g.nutrition?.[key]?.measured);
    // unresolved (or resolved-but-no-estimate) → full miss = the case-range midpoint
    const errAll = withMacro.map((g) => (g.resolved && g.nutrition?.[key]?.measured)
      ? g.nutrition[key].err_abs
      : (g.nutrition_targets[key] ?? 0));
    const pctAll = withMacro.map((g) => (g.resolved && g.nutrition?.[key]?.measured)
      ? g.nutrition[key].err_pct : 1);
    const errRes = resolvedWith.map((g) => g.nutrition[key].err_abs);
    const pctRes = resolvedWith.map((g) => g.nutrition[key].err_pct);
    // Midpoint variant: distance from the range MIDPOINT (never 0 inside the
    // band). The band-edge MAPE above is 0 for any in-range answer, so its
    // median collapses to 0 when >half the cases are in range — the midpoint
    // MAPE is the sharper signal for tracking V2 gains inside the band.
    const pctResMid = resolvedWith.map((g) => g.nutrition[key].err_pct_mid);
    const pctAllMid = withMacro.map((g) => (g.resolved && g.nutrition?.[key]?.measured)
      ? g.nutrition[key].err_pct_mid : 1);
    macroMetrics[short] = {
      n_cases_declared: withMacro.length,
      resolution_rate: r3(rate(resolvedWith.length, withMacro.length)),
      in_range_rate: r3(rate(resolvedWith.filter((g) => g.nutrition[key].in_range).length, resolvedWith.length)),
      mae_resolved: r1(mean(errRes)),
      mae_all: r1(mean(errAll)),
      mape_edge_resolved_median: r3(median(pctRes)),
      mape_edge_all_median: r3(median(pctAll)),
      mape_edge_all_mean: r3(mean(pctAll)),
      mape_mid_resolved_median: r3(median(pctResMid)),
      mape_mid_all_median: r3(median(pctAllMid)),
      mape_mid_all_mean: r3(mean(pctAllMid)),
    };
  }

  /* ---------- 10–11: plausibility FP / FN ---- */
  const resolved = grades.filter((g) => g.resolved && !g.correctly_declined && g.primary !== 'nonfood_or_malformed');
  const fpEligible = resolved.filter((g) => g.nutrition && Object.keys(g.nutrition).length);
  const plausibility_false_positive = {
    rate: r3(rate(resolved.filter((g) => g.plaus_fp).length, fpEligible.length)),
    count: resolved.filter((g) => g.plaus_fp).length,
    eligible: fpEligible.length,
  };
  const plausibility_false_negative = {
    rate: r3(rate(resolved.filter((g) => g.plaus_fn).length, resolved.length)),
    count: resolved.filter((g) => g.plaus_fn).length,
    eligible: resolved.length,
  };

  /* ---------- 12: unresolved rate ---- */
  const shouldResolve = grades.filter((g) => g.expected_resolve);
  const unresolved_rate = r3(rate(shouldResolve.filter((g) => !g.resolved).length, shouldResolve.length));

  /* ---------- 13: fabrication rate ---- */
  const fabrication_rate = r3(rate(grades.filter((g) => g.fabrication).length, grades.length));
  const fabrication_count = grades.filter((g) => g.fabrication).length;
  const nonfood_resolved_soft = grades.filter((g) => g.nonfood_resolved && !g.fabrication).length;

  /* ---------- 14: confidence calibration ---- */
  const bins = {};
  for (const band of ['high', 'medium', 'low', 'unreliable']) bins[band] = { n: 0, correct: 0 };
  for (const g of resolved) {
    const b = g.confidence_band;
    if (!bins[b]) continue;
    bins[b].n++;
    const idOk = (g.identity_ok ?? 0) >= 0.5;
    const nutOk = !g.nutrition || (g.nutrition.kcal ? g.nutrition.kcal.in_range : true);
    if (idOk && nutOk) bins[b].correct++;
  }
  let ece = 0; const totalBinned = Object.values(bins).reduce((s, x) => s + x.n, 0);
  const calibration_table = {};
  for (const [band, x] of Object.entries(bins)) {
    const observed = x.n ? x.correct / x.n : null;
    calibration_table[band] = { n: x.n, observed_accuracy: observed == null ? null : r3(observed), nominal: CONF_NOMINAL[band] };
    if (x.n && observed != null) ece += (x.n / totalBinned) * Math.abs(observed - CONF_NOMINAL[band]);
  }

  /* ---------- 16–18: latency / llm / cost ---- */
  const lat = grades.map((g) => g.latency_ms);
  const latency = {
    mean_ms: r1(mean(lat)), p50_ms: r1(median(lat)),
    p90_ms: r1(percentile(lat, 90)), p95_ms: r1(percentile(lat, 95)),
    max_ms: r1(Math.max(...lat, 0)), total_wall_ms: r1(wallMs),
  };
  const llm_escalation_rate = r3(rate(grades.filter((g) => g.llm_calls > 0).length, grades.length));
  const est_cost_usd_per_estimate = round6(mean(grades.map((g) => g.est_cost_usd)));

  /* ---------- silent-drop (never-fabricate corollary) ---- */
  const multi = grades.filter((g) => g.primary === 'meal' || (g.tags || []).includes('multi_food'));
  const silent_drop_rate = r3(rate(multi.filter((g) => g.silent_drop).length, multi.length));

  /* ---------- category + tag breakdowns ---- */
  const categories = {};
  for (const [cat, meta] of Object.entries(PRIMARY_CATEGORIES)) {
    const gs = grades.filter((g) => g.primary === cat);
    if (!gs.length) { categories[cat] = { n: 0, weight: meta.weight, case_score: null }; continue; }
    categories[cat] = {
      n: gs.length, weight: meta.weight, label: meta.label,
      case_score: r3(mean(gs.map((g) => g.case_score))),
      identity_accuracy: r3(rate(gs.filter((g) => g.identity_ok != null && g.identity_ok >= 0.5).length,
                                 gs.filter((g) => g.identity_ok != null).length)),
      kcal_mape_mid_median: r3(median(gs.filter((g) => g.resolved && g.nutrition?.kcal?.measured)
        .map((g) => g.nutrition.kcal.err_pct_mid))),
      kcal_in_range_rate: r3(rate(gs.filter((g) => g.nutrition?.kcal?.in_range).length,
                                  gs.filter((g) => g.resolved && g.nutrition?.kcal?.measured).length)),
      unresolved_rate: r3(rate(gs.filter((g) => g.expected_resolve && !g.resolved).length,
                               gs.filter((g) => g.expected_resolve).length)),
      confident_wrong: gs.filter((g) => g.confident_wrong).length,
      fabrication: gs.filter((g) => g.fabrication).length,
    };
  }

  const sliceStats = (gs) => ({
    n: gs.length,
    case_score: r3(mean(gs.map((g) => g.case_score))),
    identity_accuracy: r3(rate(gs.filter((g) => g.identity_ok != null && g.identity_ok >= 0.5).length,
                               gs.filter((g) => g.identity_ok != null).length)),
    kcal_mape_mid_median: r3(median(gs.filter((g) => g.resolved && g.nutrition?.kcal?.measured)
      .map((g) => g.nutrition.kcal.err_pct_mid))),
    confident_wrong: gs.filter((g) => g.confident_wrong).length,
    plaus_fn: gs.filter((g) => g.plaus_fn).length,
    fabrication: gs.filter((g) => g.fabrication).length,
  });

  const tag_slices = {};
  for (const [group, tags] of Object.entries(TAG_GROUPS)) {
    tag_slices[group] = {};
    for (const tag of tags) {
      const gs = grades.filter((g) => (g.tags || []).includes(tag));
      if (gs.length) tag_slices[group][tag] = sliceStats(gs);
    }
  }
  // difficulty is a per-case FIELD, not a tag — break it out explicitly
  const difficulty_slices = {};
  for (const d of ['easy', 'medium', 'hard']) {
    const gs = grades.filter((g) => (g.difficulty || 'medium') === d);
    if (gs.length) difficulty_slices[d] = sliceStats(gs);
  }

  /* ---------- weighted overall ---- */
  let wsum = 0, wtot = 0;
  for (const [cat, meta] of Object.entries(PRIMARY_CATEGORIES)) {
    const cs = categories[cat]?.case_score;
    if (cs == null) continue;
    wsum += cs * meta.weight; wtot += meta.weight;
  }
  const weighted_overall = r3(wtot ? wsum / wtot : 0);
  const unweighted_overall = r3(mean(grades.map((g) => g.case_score)));

  /* ---------- worst cases (for eyeballing) ---- */
  const worst_cases = [...grades]
    .sort((a, b) => a.case_score - b.case_score)
    .slice(0, 25)
    .map((g) => ({ id: g.id, primary: g.primary, score: r3(g.case_score),
                   confident_wrong: g.confident_wrong, fabrication: g.fabrication,
                   plaus_fn: g.plaus_fn, notes: g.notes.slice(0, 3) }));

  return {
    meta: {
      engine: adapter.id, engine_label: adapter.label,
      dataset_version: dataset.meta?.version, n_cases: cases.length,
      run_at: new Date().toISOString(),
    },
    weighted_overall, unweighted_overall,
    metrics: {
      '1_food_identity_accuracy': r3(identity_accuracy),
      '1b_food_identity_graded': r3(identity_graded),
      '2_food_class_accuracy': r3(class_accuracy),
      '2_note': 'V1 has no class output — computed from a heuristic proxy over the matched row',
      '3_prep_state_accuracy': r3(prep_accuracy),
      '3b_prep_state_graded': r3(prep_graded),
      '4_portion_accuracy': r3(portion_accuracy),
      '4b_portion_graded': r3(portion_graded),
      '5_composite_decomposition': {
        decomposition_attempt_rate: r3(compDecompAttempt),
        kcal_total_in_range_rate: r3(compKcalInRange),
        category_case_score: r3(compScore),
      },
      '6_kcal': macroMetrics.kcal,
      '7_protein': macroMetrics.protein,
      '8_carb': macroMetrics.carb,
      '9_fat': macroMetrics.fat,
      '10_plausibility_false_positive': plausibility_false_positive,
      '11_plausibility_false_negative': plausibility_false_negative,
      '12_unresolved_rate': unresolved_rate,
      '13_fabrication_rate': fabrication_rate,
      '13b_fabrication_count': fabrication_count,
      '13c_nonfood_resolved_low_conf': nonfood_resolved_soft,
      '13d_silent_drop_rate_multi_food': silent_drop_rate,
      '14_confidence_calibration': { ece: r3(ece), table: calibration_table },
      '15_brand_generic_accuracy': brand_generic_accuracy,
      '16_latency': latency,
      '17_llm_escalation_rate': llm_escalation_rate,
      '18_est_cost_usd_per_estimate': est_cost_usd_per_estimate,
    },
    categories, tag_slices, difficulty_slices, worst_cases,
    per_case: grades.map((g) => ({
      id: g.id, primary: g.primary, tags: g.tags, difficulty: g.difficulty,
      resolved: g.resolved, case_score: r3(g.case_score),
      identity_ok: g.identity_ok, class_ok: g.class_ok, prep_ok: g.prep_ok,
      portion_ok: g.portion_ok == null ? null : r3(g.portion_ok),
      confidence_band: g.confidence_band, confidence_ok: g.confidence_ok,
      kcal_err_pct: g.nutrition?.kcal ? r3(g.nutrition.kcal.err_pct) : null,
      plaus_fn: g.plaus_fn, plaus_fp: g.plaus_fp,
      confident_wrong: g.confident_wrong, fabrication: g.fabrication, silent_drop: g.silent_drop,
      latency_ms: r1(g.latency_ms), notes: g.notes,
    })),
  };
}

/* -------------------------------------------------- helpers ------------ */

function round6(x) { return Math.round(x * 1e6) / 1e6; }

/** Namespace accuracy needs the raw result; do a light second pass. */
function computeNamespace(brandCases, adapter) {
  let bOk = 0, bN = 0, gOk = 0, gN = 0;
  for (const { c } of brandCases) {
    const res = adapter.run(c);
    const got = res.items?.[0]?.namespace_proxy;
    if (!res.resolved || !got) continue;
    const want = (c.tags || []).includes('branded') ? 'branded' : 'generic';
    if (want === 'branded') { bN++; if (got === 'branded') bOk++; }
    else { gN++; if (got === 'generic') gOk++; }
  }
  return {
    n: bN + gN,
    overall: (bN + gN) ? r3((bOk + gOk) / (bN + gN)) : null,
    branded: bN ? r3(bOk / bN) : null,
    generic: gN ? r3(gOk / gN) : null,
  };
}
