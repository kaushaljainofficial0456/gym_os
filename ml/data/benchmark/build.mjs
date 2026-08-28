// ============================================================
// SKOS FOOD BENCHMARK — DATASET BUILDER
//
//   node ml/data/benchmark/build.mjs [--out <path>] [--strict]
//
// Expands case_specs.v1.mjs + case_specs.v1.extra.mjs into the FROZEN
// dataset food_eval_set.v1.json.
//
// For a `db` ground-truth spec, this scans unified_food_db.json with the
// SPEC's own criteria (source preference + name regex + cooking state) — it
// does NOT use the estimator's ranker — snapshots the authoritative row, and
// writes nutrition = row × grams/100 ± tolerance. That keeps ground truth
// independent of the thing being graded.
//
// For authored / std / published specs the ranges are literal domain values
// (deliberately WIDE where recipe variance is real) and are passed through.
//
// Read-only. No estimator import.
// ============================================================
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const DB_PATH = path.join(ROOT, 'ml', 'data', 'processed', 'unified_food_db.json');

const args = process.argv.slice(2);
const OUT = argVal('--out') || path.join(HERE, 'food_eval_set.v1.json');
const STRICT = args.includes('--strict');
function argVal(flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; }

const VALID_PRIMARY = new Set([
  'single_ingredient', 'prepared_food', 'composite_dish', 'meal', 'beverage',
  'snack', 'dessert', 'sauce_condiment', 'nonfood_or_malformed',
]);

const specsA = (await import('./case_specs.v1.mjs')).default;
const specsB = (await import('./case_specs.v1.extra.mjs')).default;
const SPECS = [...specsA, ...specsB];

const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
console.error(`loaded ${db.length} DB rows from ${path.relative(ROOT, DB_PATH)}`);

/* ------------------------------------------------ DB ground-truth lookup */

const SOURCE_RANK_DEFAULT = ['IFCT2017', 'INDB', 'USDA_FDC', 'CNF_CANADA', 'OPEN_FOOD_FACTS'];

function findAuthoritativeRow({ prefer, name, cs }) {
  const order = (prefer && prefer.length) ? prefer : SOURCE_RANK_DEFAULT;
  let pool = db.filter((f) => name.test(String(f.food_name || '')));
  if (!pool.length) return null;

  const score = (f) => {
    let s = 0;
    const si = order.indexOf(f.source);
    s += (si === -1 ? order.length + 2 : si) * 1000;        // source preference dominates
    if (cs && String(f.cooking_state || '') === cs) s -= 400; // exact cooking-state match
    else if (cs && f.cooking_state) s += 150;                 // wrong stated state
    if (f.energy_kcal == null) s += 5000;                     // unusable — push right down
    if (f.data_quality_flag) s += 800;                        // avoid quarantined rows as ground truth
    if (f.per_100g_unreliable) s += 600;
    if (!(f.serving_grams > 0)) s += 20;
    s += String(f.food_name || '').length * 0.3;              // shorter, more generic name
    return s;
  };
  pool.sort((a, b) => score(a) - score(b));
  return pool[0] && pool[0].energy_kcal != null ? pool[0] : null;
}

const round = (x, d = 1) => { const m = 10 ** d; return Math.round(x * m) / m; };

function bandFromRow(row, grams, tol) {
  const f = grams / 100;
  const macro = (v) => {
    if (v == null || !Number.isFinite(Number(v))) return null;
    const mid = Number(v) * f;
    return [round(Math.max(0, mid * (1 - tol))), round(mid * (1 + tol))];
  };
  const out = { kcal: macro(row.energy_kcal) };
  const p = macro(row.protein_g); if (p) out.protein_g = p;
  const c = macro(row.carb_g); if (c) out.carb_g = c;
  const ft = macro(row.fat_g); if (ft) out.fat_g = ft;
  return out;
}

/* ------------------------------------------------ expansion */

const seen = new Set();
const problems = [];
const out = [];
const dbMatched = [];
const dbUnmatched = [];

for (const spec of SPECS) {
  const { id, input, primary, tags = [], difficulty = 'medium', expect = {}, gt = { m: 'none' } } = spec;

  if (!id || seen.has(id)) { problems.push(`duplicate/missing id: ${id}`); continue; }
  seen.add(id);
  if (!VALID_PRIMARY.has(primary)) { problems.push(`${id}: bad primary "${primary}"`); continue; }
  if (typeof input !== 'string') { problems.push(`${id}: input is not a string`); continue; }

  const c = {
    id, input, primary, tags, difficulty,
    expect: JSON.parse(JSON.stringify({
      entity: expect.entity, food_class: expect.food_class, prep_state: expect.prep_state,
      portion: expect.portion, nutrition: expect.nutrition || null,
      confidence: expect.confidence, strategy: expect.strategy || null,
      plausible: expect.plausible, is_nonfood: expect.is_nonfood, items: expect.items,
    })),
    ground_truth: { method: 'none', source: null },
  };

  if (gt.m === 'db') {
    const row = findAuthoritativeRow({ prefer: gt.prefer, name: gt.name, cs: gt.cs });
    if (row) {
      c.expect.nutrition = bandFromRow(row, gt.grams, gt.tol ?? 0.18);
      if (!c.expect.portion) c.expect.portion = { grams: [round(gt.grams * 0.92), round(gt.grams * 1.08)] };
      c.ground_truth = {
        method: 'db_row_scaled',
        source: `${row.source} ${row.source_id} "${row.food_name}" × ${gt.grams}g ±${Math.round((gt.tol ?? 0.18) * 100)}%`,
        resolved_source_id: row.source_id,
        resolved_name: row.food_name,
        resolved_per_100g: { energy_kcal: row.energy_kcal, protein_g: row.protein_g, carb_g: row.carb_g, fat_g: row.fat_g },
        reference_grams: gt.grams,
      };
      dbMatched.push(id);
    } else {
      c.expect.nutrition = null;
      if (!c.expect.portion) c.expect.portion = { grams: [round(gt.grams * 0.9), round(gt.grams * 1.1)] };
      c.ground_truth = { method: 'db_unmatched', source: `NO ROW for /${gt.name.source}/ in [${(gt.prefer || []).join(',') || 'any'}] — nutrition not scored` };
      dbUnmatched.push(id);
      problems.push(`${id}: db ground-truth criteria matched no usable row (/${gt.name.source}/) — nutrition metrics will skip this case`);
    }
  } else if (gt.m === 'authored' || gt.m === 'std' || gt.m === 'published') {
    c.expect.nutrition = gt.nutrition || expect.nutrition || null;
    if (!c.expect.portion && gt.gramsRef) c.expect.portion = { grams: [round(gt.gramsRef * 0.9), round(gt.gramsRef * 1.1)] };
    c.ground_truth = {
      method: gt.m === 'std' ? 'standard_portion' : gt.m === 'published' ? 'published_range' : 'authored_range',
      source: gt.note || null,
      reference_grams: gt.gramsRef ?? null,
    };
  } else {
    c.ground_truth = { method: 'none', source: 'identity / prep / portion / class only' };
  }

  out.push(c);
}

if (problems.length) {
  console.error(`\n${problems.length} note(s):`);
  for (const p of problems) console.error('  - ' + p);
  if (STRICT && dbUnmatched.length) { console.error('\n--strict: aborting on unmatched db ground-truth'); process.exit(1); }
}

/* ------------------------------------------------ stats + write */

const byPrimary = {};
for (const c of out) byPrimary[c.primary] = (byPrimary[c.primary] || 0) + 1;
const byTag = {};
for (const c of out) for (const t of c.tags) byTag[t] = (byTag[t] || 0) + 1;
const byGtMethod = {};
for (const c of out) byGtMethod[c.ground_truth.method] = (byGtMethod[c.ground_truth.method] || 0) + 1;
const nWithNutrition = out.filter((c) => c.expect.nutrition && Object.keys(c.expect.nutrition).length).length;

const dataset = {
  meta: {
    version: 'v1',
    built_at: new Date().toISOString(),
    n_cases: out.length,
    n_with_nutrition_ground_truth: nWithNutrition,
    source_db: { path: 'ml/data/processed/unified_food_db.json', rows: db.length },
    methodology:
      'db_row_scaled: an authoritative IFCT/INDB/USDA/CNF row selected by source preference + ' +
      'name regex + cooking state (NOT the estimator ranker), scaled to a reference portion ± a ' +
      'tolerance. standard_portion / published_range / authored_range: literal wide ranges from ' +
      'nutrition references and domain knowledge, tolerances widened where recipe variance is real. ' +
      'none: identity / preparation / portion / class scored only.',
    counts_by_primary: byPrimary,
    counts_by_ground_truth_method: byGtMethod,
    counts_by_tag: byTag,
    db_ground_truth: { matched: dbMatched.length, unmatched: dbUnmatched.length, unmatched_ids: dbUnmatched },
  },
  cases: out,
};

fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2));
console.error(`\nwrote ${out.length} cases → ${path.relative(ROOT, OUT)}`);
console.error(`  nutrition ground truth: ${nWithNutrition}/${out.length}`);
console.error(`  by primary: ${JSON.stringify(byPrimary)}`);
console.error(`  by gt method: ${JSON.stringify(byGtMethod)}`);
console.error(`  db anchor: ${dbMatched.length} matched, ${dbUnmatched.length} unmatched`);
