// ============================================================
// FOOD BENCHMARK v2 — CI GATE (nutrition overhaul, 534 cases)
//
// v2 = the frozen v1 cases + 210 cases added by the nutrition overhaul
// (ml/data/benchmark/case_specs.v2.mjs): Indian dishes and ingredients at
// explicit weights, weighed multi-food meals (db_sum_scaled), natural-
// language Indian meals, recipe-priced regional dishes, international and
// packaged foods, and silent-drop traps.
//
// Two kinds of assertion:
//   1. HARD INVARIANTS that must hold on every commit -- zero silent drops,
//      zero fabrication (a confident number for a non-food).
//   2. No blocking regression against baseline.v2.json (same gate rules
//      as the v1 gate, src/eval/report.js GATES).
// ============================================================
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v1Adapter, v1Warmup } from '../src/eval/adapters.js';
import { runBenchmark } from '../src/eval/runner.js';
import { compareToBaseline } from '../src/eval/report.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATASET = path.join(ROOT, 'ml', 'data', 'benchmark', 'food_eval_set.v2.json');
const BASELINE = path.join(ROOT, 'ml', 'data', 'benchmark', 'baseline.v2.json');
const have = fs.existsSync(DATASET) && fs.existsSync(BASELINE) && v1Warmup();

let rep = null;
const run = () => {
  if (!rep) rep = runBenchmark(JSON.parse(fs.readFileSync(DATASET, 'utf8')), v1Adapter);
  return rep;
};

test('v2 benchmark has at least 500 cases', { skip: !fs.existsSync(DATASET) }, () => {
  const ds = JSON.parse(fs.readFileSync(DATASET, 'utf8'));
  assert.ok(ds.cases.length >= 500, `${ds.cases.length} cases`);
});

test('INVARIANT: zero silent food drops on the v2 benchmark', { skip: !have }, () => {
  const r = run();
  assert.equal(r.metrics['13d_silent_drop_rate_multi_food'], 0,
    r.per_case.filter((c) => c.silent_drop).map((c) => c.id).join(', '));
});

test('INVARIANT: zero fabrication (no confident number for a non-food)', { skip: !have }, () => {
  assert.equal(run().metrics['13_fabrication_rate'], 0);
});

test('no blocking regression against baseline.v2.json', { skip: !have }, () => {
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const cmp = compareToBaseline(run(), base);
  assert.ok(cmp.pass, JSON.stringify(cmp.blocking || cmp, null, 1).slice(0, 1500));
});
