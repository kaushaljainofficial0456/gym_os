// ============================================================
// FOOD BENCHMARK — REPORT FORMATTING + REGRESSION GATE
//
//   formatReport(report)         → human-readable text block
//   compareToBaseline(rep, base) → { pass, deltas, blocking[], improved[] }
//
// The gate encodes: a change is an improvement ONLY if the weighted overall
// (and the "never-fabricate" guards) improve or hold, with no category
// regressing past its tolerance. Category-level, not one aggregate.
// ============================================================
'use strict';

/** Per-metric regression tolerance. `dir` = which direction is BETTER.
 *  `block` = a regression beyond `tol` blocks rollout unless explicitly
 *  approved. `hard` = a regression here blocks unconditionally (safety). */
export const GATES = {
  weighted_overall:                { dir: 'up',   tol: 0.010, block: true },
  '1_food_identity_accuracy':      { dir: 'up',   tol: 0.020, block: true },
  '3_prep_state_accuracy':         { dir: 'up',   tol: 0.030, block: true },
  '4_portion_accuracy':            { dir: 'up',   tol: 0.030, block: true },
  '5_composite_decomposition.kcal_total_in_range_rate': { dir: 'up', tol: 0.030, block: true },
  '6_kcal.mape_mid_all_median':    { dir: 'down', tol: 0.030, block: true },
  '6_kcal.in_range_rate':          { dir: 'up',   tol: 0.030, block: true },
  '7_protein.mape_mid_all_median': { dir: 'down', tol: 0.040, block: false },
  '8_carb.mape_mid_all_median':    { dir: 'down', tol: 0.040, block: false },
  '9_fat.mape_mid_all_median':     { dir: 'down', tol: 0.040, block: false },
  '10_plausibility_false_positive.rate': { dir: 'down', tol: 0.030, block: false },
  '11_plausibility_false_negative.rate': { dir: 'down', tol: 0.010, block: true, hard: true },
  '12_unresolved_rate':            { dir: 'down', tol: 0.030, block: false },
  '13_fabrication_rate':           { dir: 'down', tol: 0.000, block: true, hard: true },
  '13d_silent_drop_rate_multi_food': { dir: 'down', tol: 0.010, block: true, hard: true },
  '14_confidence_calibration.ece': { dir: 'down', tol: 0.030, block: false },
  '17_llm_escalation_rate':        { dir: 'down', tol: 0.100, block: false },
  '18_est_cost_usd_per_estimate':  { dir: 'down', tol: 0.002, block: false },
};
/** Per-primary-category case_score regression tolerance. */
export const CATEGORY_GATE_TOL = 0.030;

function dig(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

export function compareToBaseline(rep, base) {
  const deltas = {};
  const blocking = [];
  const improved = [];
  const warnings = [];

  for (const [key, cfg] of Object.entries(GATES)) {
    const now = key.startsWith('weighted_overall') ? rep.weighted_overall : dig(rep.metrics, key);
    const was = key.startsWith('weighted_overall') ? base.weighted_overall : dig(base.metrics, key);
    if (typeof now !== 'number' || typeof was !== 'number') continue;
    const delta = now - was;
    const better = cfg.dir === 'up' ? delta > 0 : delta < 0;
    const regressionAmt = cfg.dir === 'up' ? -delta : delta;   // positive = worse
    deltas[key] = { was, now, delta: round4(delta), better, dir: cfg.dir };
    if (regressionAmt > cfg.tol) {
      const entry = { metric: key, was, now, regressed_by: round4(regressionAmt), tol: cfg.tol, hard: !!cfg.hard };
      if (cfg.block || cfg.hard) blocking.push(entry);
      else warnings.push(entry);
    } else if (better && Math.abs(delta) > cfg.tol) {
      improved.push({ metric: key, was, now, improved_by: round4(Math.abs(delta)) });
    }
  }

  // category-level regression gate
  for (const [cat, meta] of Object.entries(rep.categories || {})) {
    const now = meta.case_score;
    const was = base.categories?.[cat]?.case_score;
    if (typeof now !== 'number' || typeof was !== 'number') continue;
    const delta = now - was;
    deltas[`category.${cat}`] = { was, now, delta: round4(delta), better: delta > 0, dir: 'up' };
    if (-delta > CATEGORY_GATE_TOL) {
      blocking.push({ metric: `category.${cat}`, was, now, regressed_by: round4(-delta), tol: CATEGORY_GATE_TOL, hard: false });
    } else if (delta > CATEGORY_GATE_TOL) {
      improved.push({ metric: `category.${cat}`, was, now, improved_by: round4(delta) });
    }
  }

  const hardFail = blocking.some((b) => b.hard);
  const pass = blocking.length === 0;
  return { pass, hardFail, blocking, warnings, improved, deltas };
}

export function formatReport(rep, cmp) {
  const m = rep.metrics;
  const L = [];
  const p = (s = '') => L.push(s);
  const pct = (x) => (x == null ? '  n/a' : (x * 100).toFixed(1).padStart(5) + '%');

  p('══════════════════════════════════════════════════════════════════════');
  p(` SKOS FOOD BENCHMARK — ${rep.meta.engine.toUpperCase()}   (${rep.meta.n_cases} cases, dataset ${rep.meta.dataset_version})`);
  p(` ${rep.meta.engine_label}`);
  p(` run ${rep.meta.run_at}`);
  p('══════════════════════════════════════════════════════════════════════');
  p('');
  p(` WEIGHTED OVERALL ....... ${(rep.weighted_overall * 100).toFixed(1)}%      (unweighted ${(rep.unweighted_overall * 100).toFixed(1)}%)`);
  p('');
  p(' ── 18 METRICS ────────────────────────────────────────────────────────');
  p(`  1  Food identity accuracy ........ ${pct(m['1_food_identity_accuracy'])}   (graded ${pct(m['1b_food_identity_graded'])})`);
  p(`  2  Food-class accuracy (proxy) ... ${pct(m['2_food_class_accuracy'])}`);
  p(`  3  Preparation-state accuracy .... ${pct(m['3_prep_state_accuracy'])}   (graded ${pct(m['3b_prep_state_graded'])})`);
  p(`  4  Portion accuracy ............. ${pct(m['4_portion_accuracy'])}   (graded ${pct(m['4b_portion_graded'])})`);
  p(`  5  Composite decomposition ...... attempt ${pct(m['5_composite_decomposition'].decomposition_attempt_rate)}  · kcal-in-range ${pct(m['5_composite_decomposition'].kcal_total_in_range_rate)}  · score ${pct(m['5_composite_decomposition'].category_case_score)}`);
  for (const [n, k] of [['6', 'kcal'], ['7', 'protein'], ['8', 'carb'], ['9', 'fat']]) {
    const x = m[`${n}_${k}`];
    p(`  ${n}  ${k.toUpperCase().padEnd(7)} MAE(res) ${String(x.mae_resolved).padStart(7)}  MAE(all) ${String(x.mae_all).padStart(7)}  · in-range ${pct(x.in_range_rate)}  · MAPE-mid(all,med) ${pct(x.mape_mid_all_median)}  · resolve ${pct(x.resolution_rate)}`);
  }
  p(` 10  Plausibility false positives .. ${pct(m['10_plausibility_false_positive'].rate)}   (${m['10_plausibility_false_positive'].count}/${m['10_plausibility_false_positive'].eligible})`);
  p(` 11  Plausibility false negatives .. ${pct(m['11_plausibility_false_negative'].rate)}   (${m['11_plausibility_false_negative'].count}/${m['11_plausibility_false_negative'].eligible})   ◄ confident-wrong slipping through`);
  p(` 12  Unresolved rate .............. ${pct(m['12_unresolved_rate'])}`);
  p(` 13  Fabrication rate ............. ${pct(m['13_fabrication_rate'])}   (${m['13b_fabrication_count']} cases;  ${m['13c_nonfood_resolved_low_conf']} non-food resolved at low conf;  silent-drop ${pct(m['13d_silent_drop_rate_multi_food'])})`);
  p(` 14  Confidence calibration (ECE) . ${m['14_confidence_calibration'].ece.toFixed(3)}`);
  for (const [b, x] of Object.entries(m['14_confidence_calibration'].table)) {
    if (!x.n) continue;
    p(`        ${b.padEnd(11)} n=${String(x.n).padStart(4)}   observed ${pct(x.observed_accuracy)}   nominal ${(x.nominal * 100).toFixed(0)}%`);
  }
  const bg = m['15_brand_generic_accuracy'];
  p(` 15  Brand/generic accuracy ....... ${pct(bg.overall)}   (branded ${pct(bg.branded)} · generic ${pct(bg.generic)} · n=${bg.n})`);
  p(` 16  Latency ..................... p50 ${m['16_latency'].p50_ms}ms · p95 ${m['16_latency'].p95_ms}ms · mean ${m['16_latency'].mean_ms}ms · max ${m['16_latency'].max_ms}ms`);
  p(` 17  LLM escalation rate ......... ${pct(m['17_llm_escalation_rate'])}`);
  p(` 18  Est. cost / estimate ........ $${m['18_est_cost_usd_per_estimate'].toFixed(6)}`);
  p('');
  p(' ── PER-CATEGORY (all visible; weighted into overall) ─────────────────');
  p('   category                 n   score   identity  kcalMAPEmid  kcalInRng  unres   cWrong  fab');
  for (const [cat, x] of Object.entries(rep.categories)) {
    if (!x.n) { p(`   ${cat.padEnd(22)} ${String(x.n).padStart(3)}     —`); continue; }
    p(`   ${cat.padEnd(22)} ${String(x.n).padStart(3)}  ${pct(x.case_score)}   ${pct(x.identity_accuracy)}   ${pct(x.kcal_mape_mid_median)}    ${pct(x.kcal_in_range_rate)}   ${pct(x.unresolved_rate)}   ${String(x.confident_wrong).padStart(4)}  ${String(x.fabrication).padStart(3)}`);
  }
  p('');
  p(' ── DIFFICULTY (case_score · identity · kcalMAPE-mid · cWrong · plausFN) ');
  for (const [d, x] of Object.entries(rep.difficulty_slices || {})) {
    p(`     ${d.padEnd(10)} n=${String(x.n).padStart(3)}   ${pct(x.case_score)}  ${pct(x.identity_accuracy)}  ${pct(x.kcal_mape_mid_median)}   ${String(x.confident_wrong).padStart(3)}  ${String(x.plaus_fn).padStart(3)}`);
  }
  p('');
  p(' ── TAG SLICES (case_score · identity · kcalMAPE-mid · cWrong · plausFN) ');
  for (const [group, tags] of Object.entries(rep.tag_slices)) {
    if (!Object.keys(tags).length) continue;
    p(`   [${group}]`);
    for (const [tag, x] of Object.entries(tags)) {
      p(`     ${tag.padEnd(22)} n=${String(x.n).padStart(3)}   ${pct(x.case_score)}  ${pct(x.identity_accuracy)}  ${pct(x.kcal_mape_mid_median)}   ${String(x.confident_wrong).padStart(3)}  ${String(x.plaus_fn).padStart(3)}`);
    }
  }

  if (cmp) {
    p('');
    p(' ── REGRESSION GATE vs BASELINE ──────────────────────────────────────');
    p(`   RESULT: ${cmp.pass ? 'PASS' : (cmp.hardFail ? 'HARD FAIL' : 'FAIL (blocked)')}`);
    if (cmp.improved.length) {
      p('   improved:');
      for (const i of cmp.improved) p(`     + ${i.metric}: ${fmtNum(i.was)} → ${fmtNum(i.now)}  (+${i.improved_by})`);
    }
    if (cmp.warnings.length) {
      p('   soft regressions (non-blocking, note in the phase report):');
      for (const w of cmp.warnings) p(`     ~ ${w.metric}: ${fmtNum(w.was)} → ${fmtNum(w.now)}  (worse by ${w.regressed_by}, tol ${w.tol})`);
    }
    if (cmp.blocking.length) {
      p('   BLOCKING regressions (require explicit approval to roll out):');
      for (const b of cmp.blocking) p(`     ✗ ${b.metric}: ${fmtNum(b.was)} → ${fmtNum(b.now)}  (worse by ${b.regressed_by}, tol ${b.tol})${b.hard ? '  [HARD]' : ''}`);
    }
  }

  p('');
  p(' ── 10 WORST CASES ───────────────────────────────────────────────────');
  for (const w of rep.worst_cases.slice(0, 10)) {
    p(`   ${w.id.padEnd(16)} ${w.primary.padEnd(20)} ${(w.score * 100).toFixed(0).padStart(3)}%  ${[w.fabrication && 'FAB', w.confident_wrong && 'cWRONG', w.plaus_fn && 'plausFN'].filter(Boolean).join(' ')}`);
    if (w.notes[0]) p(`       ${w.notes[0]}`);
  }
  p('══════════════════════════════════════════════════════════════════════');
  return L.join('\n');
}

function fmtNum(x) { return typeof x === 'number' ? (Math.abs(x) < 1 ? x.toFixed(3) : x.toFixed(1)) : String(x); }
function round4(x) { return Math.round(x * 1e4) / 1e4; }
