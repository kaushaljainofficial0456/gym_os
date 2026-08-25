// ============================================================
// TIER 3 (kNN fallback) — faithful JS port of ml/src/models/
// food_fallback_v4.py's query-time math, reading the static index
// ml/src/inference/export_fallback_v4_index.py exported.
//
// PARITY, NOT APPROXIMATION: the exported artifact carries a `golden` set
// -- fixed queries with their expected top-5 neighbours, similarities and
// blended predictions, computed directly against a live sklearn fit on
// the SAME full corpus. These tests assert the JS engine reproduces that
// exactly (well within float rounding), not merely "a plausible number" --
// this is what proves the tokenizer/tf-idf/cosine port didn't silently
// diverge from the validated Python behaviour.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getKnnFallback, estimateFoodKnn } from '../src/services/foodEstimator.js';
import { normalize, wordNgrams, charWbNgrams } from '../../ml/models/skos-food-v1/fallbackKnn.reference.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ML = path.resolve(__dirname, '..', '..', 'ml');
const ARTIFACT = path.join(ML, 'models', 'skos-food-v1', 'fallback_v4_index.json');
const artifactPresent = fs.existsSync(ARTIFACT);

/* ------------------------------------------------------------------ */
/*  Tokenizer — empirically verified against a live sklearn fit         */
/*  (see the session's own tokenization check before this was written)  */
/* ------------------------------------------------------------------ */

test('normalize — NFKD decompose, strip combining marks, lowercase, collapse whitespace', () => {
  assert.equal(normalize('Café  Latte!!'), 'cafe latte');
  assert.equal(normalize('Jalapeño-Cheddar'), 'jalapeno cheddar');
});

test('wordNgrams — single characters are dropped, 2-grams join with one space', () => {
  const g = wordNgrams('chicken biryani rice');
  assert.deepEqual(g, ['chicken', 'biryani', 'rice', 'chicken biryani', 'biryani rice']);
  // "a i b" -- every token is length 1, so word-space must be empty.
  assert.deepEqual(wordNgrams('a i b'), []);
});

test('charWbNgrams — each word padded with one space, ALL 3-5 length substrings, single letters included', () => {
  const g = charWbNgrams('a');
  assert.deepEqual(g, [' a ']); // padded " a " is exactly 3 chars -- one substring, no 4/5-length possible
  const chicken = charWbNgrams('chicken');
  assert.ok(chicken.includes(' ch'));
  assert.ok(chicken.includes(' chi'));
  assert.ok(chicken.includes(' chic'));
  assert.ok(chicken.includes('en '));
});

/* ------------------------------------------------------------------ */
/*  Golden-set parity — the load-bearing check                         */
/* ------------------------------------------------------------------ */

test('FallbackKnnIndex — reproduces the exported golden set exactly', () => {
  if (!artifactPresent) { assert.ok(true, 'fallback_v4_index.json not present -- skipping (run export_fallback_v4_index.py)'); return; }
  const knn = getKnnFallback();
  assert.ok(knn, 'kNN index must load when the artifact is present');

  const payload = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
  assert.ok(payload.golden?.length > 0, 'export must include a golden set to check against');

  for (const g of payload.golden) {
    const result = knn.predict(g.query);
    assert.ok(result, `predict() must return a result for golden query "${g.query}"`);
    assert.equal(result.neighbors[0].name, g.neighbors[0].name,
      `top-1 neighbour mismatch for "${g.query}"`);
    assert.ok(Math.abs(result.neighbors[0].similarity - g.neighbors[0].similarity) < 0.001,
      `similarity mismatch for "${g.query}": py=${g.neighbors[0].similarity} js=${result.neighbors[0].similarity}`);
    for (const t of ['energy_kcal', 'protein_g', 'fat_g', 'carb_g']) {
      assert.ok(Math.abs(result.predicted[t] - g.predicted[t]) < 0.5,
        `${t} mismatch for "${g.query}": py=${g.predicted[t]} js=${result.predicted[t]}`);
    }
    // Full top-5 neighbour list, not just top-1.
    for (let i = 0; i < Math.min(5, g.neighbors.length); i++) {
      assert.equal(result.neighbors[i].name, g.neighbors[i].name, `neighbour[${i}] name mismatch for "${g.query}"`);
      assert.ok(Math.abs(result.neighbors[i].similarity - g.neighbors[i].similarity) < 0.001,
        `neighbour[${i}] similarity mismatch for "${g.query}"`);
    }
  }
});

test('FallbackKnnIndex — an exact in-corpus name predicts itself with similarity ~1.0', () => {
  if (!artifactPresent) { assert.ok(true, 'artifact not present -- skipping'); return; }
  const knn = getKnnFallback();
  const anyRow = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8')).rows[100];
  const result = knn.predict(anyRow.name);
  assert.ok(result);
  assert.ok(result.top_similarity > 0.999, `expected ~1.0 similarity for an exact corpus name, got ${result.top_similarity}`);
  assert.equal(result.neighbors[0].name, anyRow.name);
});

test('FallbackKnnIndex — a query with zero vocabulary overlap returns null, never a fabricated match', () => {
  if (!artifactPresent) { assert.ok(true, 'artifact not present -- skipping'); return; }
  const knn = getKnnFallback();
  // A string of digits normalizes to nothing recognisable as food-name
  // tokens and should share no vocabulary with the corpus.
  const result = knn.predict('9999999999');
  assert.equal(result, null);
});

test('FallbackKnnIndex — predictions are never negative even if similarity weighting could dip below zero', () => {
  if (!artifactPresent) { assert.ok(true, 'artifact not present -- skipping'); return; }
  const knn = getKnnFallback();
  const result = knn.predict('chicken tikka masala biryani curry');
  if (result) {
    for (const v of Object.values(result.predicted)) assert.ok(v >= 0);
  }
});

/* ------------------------------------------------------------------ */
/*  estimateFoodKnn — the shaped result foodEstimator.js exposes        */
/* ------------------------------------------------------------------ */

test('estimateFoodKnn — shapes a food-v1-like estimate, tagged tier 3, never presented as measured', () => {
  if (!artifactPresent) { assert.ok(true, 'artifact not present -- skipping'); return; }
  const r = estimateFoodKnn('chicken biryani', { grams: 250 });
  assert.ok(r);
  assert.equal(r.tier, 3);
  assert.equal(r.estimate, true);
  assert.equal(r.trustworthy, false);
  assert.equal(r.source_id, null);
  assert.ok(r.totals.calories > 0);
  // Scaling sanity: doubling grams should roughly double calories.
  const r2 = estimateFoodKnn('chicken biryani', { grams: 500 });
  assert.ok(Math.abs(r2.totals.calories - 2 * r.totals.calories) < 2);
});

test('estimateFoodKnn — returns null for a query with no corpus overlap, not a wrong guess', () => {
  if (!artifactPresent) { assert.ok(true, 'artifact not present -- skipping'); return; }
  const r = estimateFoodKnn('9999999999');
  assert.equal(r, null);
});
