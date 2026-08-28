#!/usr/bin/env node
// ============================================================
// SKOS FOOD BENCHMARK — CLI
//
//   node backend/scripts/food-benchmark.js [options]
//
//   --engine v1|v2          engine adapter to run            (default v1)
//   --dataset <path>        frozen benchmark JSON            (default ml/data/benchmark/food_eval_set.v1.json)
//   --baseline <path>       prior report JSON to compare against
//   --gate                  exit 1 if the regression gate fails (needs --baseline)
//   --save-baseline <path>  write this run as the baseline   (v1 only; refuses to clobber without --force)
//   --out <path>            write the full machine report JSON
//   --md <path>             write the human-readable report text
//   --filter k=v            subset: primary=… | tag=… | difficulty=… | id=…   (repeatable)
//   --quiet                 suppress the console report
//
// Read-only against the estimator. Exits 0 unless --gate fails or an error.
// ============================================================
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdapter, v1Warmup } from '../src/eval/adapters.js';
import { runBenchmark } from '../src/eval/runner.js';
import { formatReport, compareToBaseline } from '../src/eval/report.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_DATASET = path.join(ROOT, 'ml', 'data', 'benchmark', 'food_eval_set.v1.json');

function parseArgs(argv) {
  const a = { engine: 'v1', dataset: DEFAULT_DATASET, filters: [], quiet: false, force: false };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    const next = () => argv[++i];
    if (t === '--engine') a.engine = next();
    else if (t === '--dataset') a.dataset = path.resolve(next());
    else if (t === '--baseline') a.baseline = path.resolve(next());
    else if (t === '--save-baseline') a.saveBaseline = path.resolve(next());
    else if (t === '--out') a.out = path.resolve(next());
    else if (t === '--md') a.md = path.resolve(next());
    else if (t === '--gate') a.gate = true;
    else if (t === '--force') a.force = true;
    else if (t === '--quiet') a.quiet = true;
    else if (t === '--filter') a.filters.push(next());
    else { console.error(`unknown arg: ${t}`); process.exit(2); }
  }
  return a;
}

function buildFilter(specs) {
  if (!specs.length) return null;
  const preds = specs.map((s) => {
    const [k, v] = s.split('=');
    if (k === 'primary') return (c) => c.primary === v;
    if (k === 'difficulty') return (c) => (c.difficulty || 'medium') === v;
    if (k === 'id') return (c) => c.id === v;
    if (k === 'tag') return (c) => (c.tags || []).includes(v);
    throw new Error(`bad --filter "${s}" (expected primary=|tag=|difficulty=|id=)`);
  });
  return (c) => preds.every((p) => p(c));
}

async function main() {
  const args = parseArgs(process.argv);

  if (!fs.existsSync(args.dataset)) {
    console.error(`dataset not found: ${args.dataset}\n  build it first:  node ml/data/benchmark/build.mjs`);
    process.exit(2);
  }
  const dataset = JSON.parse(fs.readFileSync(args.dataset, 'utf8'));
  if (!Array.isArray(dataset.cases) || !dataset.cases.length) {
    console.error('dataset has no cases'); process.exit(2);
  }

  const adapter = getAdapter(args.engine);
  if (args.engine === 'v1') {
    const ok = v1Warmup();
    if (!ok) console.error('WARNING: v1 model artifacts unavailable — every case will be unresolved');
  }

  const report = runBenchmark(dataset, adapter, {
    filter: buildFilter(args.filters),
    keepResults: true,
  });

  let cmp = null;
  if (args.baseline) {
    if (!fs.existsSync(args.baseline)) { console.error(`baseline not found: ${args.baseline}`); process.exit(2); }
    const base = JSON.parse(fs.readFileSync(args.baseline, 'utf8'));
    cmp = compareToBaseline(report, base);
  }

  const text = formatReport(report, cmp);
  if (!args.quiet) console.log(text);

  if (args.out) { fs.writeFileSync(args.out, JSON.stringify(report, null, 2)); console.error(`report JSON → ${rel(args.out)}`); }
  if (args.md) { fs.writeFileSync(args.md, text + '\n'); console.error(`report text → ${rel(args.md)}`); }

  if (args.saveBaseline) {
    if (args.engine !== 'v1') { console.error('refusing to save a non-v1 run as the baseline'); process.exit(2); }
    if (fs.existsSync(args.saveBaseline) && !args.force) {
      console.error(`baseline exists: ${rel(args.saveBaseline)} — pass --force to overwrite`); process.exit(2);
    }
    if (args.filters.length) { console.error('refusing to save a FILTERED run as the baseline'); process.exit(2); }
    fs.writeFileSync(args.saveBaseline, JSON.stringify(report, null, 2));
    console.error(`baseline written → ${rel(args.saveBaseline)}`);
  }

  if (args.gate) {
    if (!cmp) { console.error('--gate requires --baseline'); process.exit(2); }
    console.error(cmp.pass ? 'GATE: PASS' : `GATE: ${cmp.hardFail ? 'HARD FAIL' : 'FAIL'} — ${cmp.blocking.length} blocking regression(s)`);
    process.exit(cmp.pass ? 0 : 1);
  }
  process.exit(0);
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
main().catch((e) => { console.error(e); process.exit(1); });
