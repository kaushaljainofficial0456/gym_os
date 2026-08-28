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

import { v1Adapter, v1Warmup, getAdapter } from '../src/eval/adapters.js';
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

test('V2 gate is wired but unimplemented in Phase 0', () => {
  const v2 = getAdapter('v2');
  assert.equal(v2.id, 'v2');
  assert.throws(() => v2.run({ input: 'x' }), /stub/i, 'v2Adapter must be an explicit stub until a v2 engine exists');
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
