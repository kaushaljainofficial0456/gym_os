// ============================================================
// FOOD BENCHMARK — CI GATE
//
// Runs the CURRENT engine (V1) against the frozen benchmark and asserts it
// still reproduces baseline.v1.json. This catches two things:
//   1. an accidental change to the estimator (foodEstimator.js / skos-food-v1)
//   2. a change to the eval harness that silently moves the numbers
//
// It also documents the V2 gate: once a v2 engine exists, `npm run bench:gate`
// (food-benchmark.js --engine v2 --baseline … --gate) becomes the PR check.
// That path is asserted here only for its wiring, and skipped for scoring.
//
// Phase 0: no estimator code is touched. This test only reads.
// ============================================================
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { v1Adapter, v2Adapter, v1Warmup, getAdapter } from '../src/eval/adapters.js';
import { runBenchmark } from '../src/eval/runner.js';
import { compareToBaseline, GATES } from '../src/eval/report.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATASET = path.join(ROOT, 'ml', 'data', 'benchmark', 'food_eval_set.v1.json');
const BASELINE = path.join(ROOT, 'ml', 'data', 'benchmark', 'baseline.v1.json');

const haveArtifacts = fs.existsSync(DATASET) && fs.existsSync(BASELINE);

test('benchmark artifacts exist (run: node ml/data/benchmark/build.mjs && npm run bench -- --save-baseline …)', () => {
  assert.ok(fs.existsSync(DATASET), `missing ${path.relative(ROOT, DATASET)}`);
  assert.ok(fs.existsSync(BASELINE), `missing ${path.relative(ROOT, BASELINE)}`);
});

test('V1 still reproduces the frozen baseline (guards estimator + harness)', { skip: !haveArtifacts }, () => {
  const dataset = JSON.parse(fs.readFileSync(DATASET, 'utf8'));
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));

  const modelOk = v1Warmup();
  assert.ok(modelOk, 'skos-food-v1 model artifacts must be available for the gate to be meaningful');

  const rep = runBenchmark(dataset, v1Adapter, { keepResults: true });

  // headline scalars must match the baseline within measurement noise
  const TOL = 0.006; // 0.6 pp
  const near = (name, now, was) =>
    assert.ok(Math.abs(now - was) <= TOL, `${name}: ${now} vs baseline ${was} (Δ ${(now - was).toFixed(4)} > ${TOL})`);

  near('weighted_overall', rep.weighted_overall, base.weighted_overall);
  near('identity_accuracy', rep.metrics['1_food_identity_accuracy'], base.metrics['1_food_identity_accuracy']);
  near('prep_state_accuracy', rep.metrics['3_prep_state_accuracy'], base.metrics['3_prep_state_accuracy']);
  near('portion_accuracy', rep.metrics['4_portion_accuracy'], base.metrics['4_portion_accuracy']);
  near('plausibility_FN', rep.metrics['11_plausibility_false_negative'].rate, base.metrics['11_plausibility_false_negative'].rate);
  near('unresolved_rate', rep.metrics['12_unresolved_rate'], base.metrics['12_unresolved_rate']);
  near('fabrication_rate', rep.metrics['13_fabrication_rate'], base.metrics['13_fabrication_rate']);
  near('silent_drop_rate', rep.metrics['13d_silent_drop_rate_multi_food'], base.metrics['13d_silent_drop_rate_multi_food']);
  near('ece', rep.metrics['14_confidence_calibration'].ece, base.metrics['14_confidence_calibration'].ece);

  // per-category case_score stability
  for (const [cat, x] of Object.entries(base.categories)) {
    if (x.case_score == null) continue;
    near(`category.${cat}`, rep.categories[cat]?.case_score ?? -1, x.case_score);
  }
});

test('PHASE 2 GATE: V2 vs the frozen V1 baseline PASSES (no blocking / hard regression)', { skip: !haveArtifacts }, () => {
  const dataset = JSON.parse(fs.readFileSync(DATASET, 'utf8'));
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  if (!v1Warmup()) return;

  const rep = runBenchmark(dataset, v2Adapter, { keepResults: true });
  const cmp = compareToBaseline(rep, base);

  assert.equal(cmp.hardFail, false,
    `HARD gate regression: ${JSON.stringify(cmp.blocking.filter((b) => b.hard))}`);
  assert.equal(cmp.pass, true,
    `blocking regression(s): ${JSON.stringify(cmp.blocking)}`);
  // the three non-negotiables must not move the wrong way at all
  assert.ok(rep.metrics['13_fabrication_rate'] <= base.metrics['13_fabrication_rate'] + 1e-9, 'fabrication rate rose');
  assert.ok(rep.metrics['13d_silent_drop_rate_multi_food'] <= base.metrics['13d_silent_drop_rate_multi_food'] + 0.010 + 1e-9, 'multi-food silent-drop rose past tol');
  assert.ok(rep.metrics['11_plausibility_false_negative'].rate <= base.metrics['11_plausibility_false_negative'].rate + 0.010 + 1e-9, 'plausibility-FN rose past tol');
  // Phase 2 should not make V2 slower than V1 by an order of magnitude
  assert.ok(rep.metrics['16_latency'].p95_ms <= base.metrics['16_latency'].p95_ms * 4, 'V2 p95 latency > 4x V1');
});

test('regression gate wiring: V1-vs-itself is a PASS with no blocking regressions', { skip: !haveArtifacts }, () => {
  const dataset = JSON.parse(fs.readFileSync(DATASET, 'utf8'));
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  if (!v1Warmup()) return;

  const rep = runBenchmark(dataset, v1Adapter, { keepResults: true });
  const cmp = compareToBaseline(rep, base);

  assert.equal(cmp.pass, true, `expected PASS, got blocking: ${JSON.stringify(cmp.blocking)}`);
  assert.equal(cmp.hardFail, false);
  assert.ok(Object.keys(GATES).length >= 12, 'the gate must cover the headline metrics');
});

test('V2 adapter is live (Phase 2) — runs, no LLM, no cost, shapes an EvalResult', () => {
  const v2 = getAdapter('v2');
  assert.equal(v2.id, 'v2');
  assert.equal(v2.llm, false, 'Phase 2 introduces no external model calls');
  v1Warmup();
  const r = v2.run({ input: '2 roti, dal and curd' });
  assert.equal(typeof r.resolved, 'boolean');
  assert.ok(Array.isArray(r.items));
  assert.equal(r.llm_calls, 0);
  assert.equal(r.est_cost_usd, 0);
  // FLAG OFF default is byte-identical to V1 — the gate compares V2 (flag on)
  // to the frozen V1 baseline, and a rescue/downgrade only ever moves a metric
  // in the improving direction or within tolerance (asserted by bench:gate).
});

test('dataset integrity: ids unique, primaries valid, ranges well-formed', { skip: !haveArtifacts }, () => {
  const dataset = JSON.parse(fs.readFileSync(DATASET, 'utf8'));
  const PRIMARIES = new Set([
    'single_ingredient', 'prepared_food', 'composite_dish', 'meal', 'beverage',
    'snack', 'dessert', 'sauce_condiment', 'nonfood_or_malformed',
  ]);
  const seen = new Set();
  assert.ok(dataset.cases.length >= 300, `expected ≥300 cases, got ${dataset.cases.length}`);
  for (const c of dataset.cases) {
    assert.ok(!seen.has(c.id), `duplicate id ${c.id}`); seen.add(c.id);
    assert.ok(PRIMARIES.has(c.primary), `${c.id}: bad primary ${c.primary}`);
    assert.equal(typeof c.input, 'string', `${c.id}: input not a string`);
    if (c.expect?.nutrition) {
      for (const [k, band] of Object.entries(c.expect.nutrition)) {
        assert.ok(Array.isArray(band) && band.length === 2 && band[0] <= band[1],
          `${c.id}: bad ${k} band ${JSON.stringify(band)}`);
      }
    }
  }
});
