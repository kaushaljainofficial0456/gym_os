// ============================================================
// Search-latency benchmark (SK OS Indian Nutrition Engine upgrade, Phase
// 14: "benchmark common searches" instead of assuming a linear scan over
// ~21,353 foods per query is or isn't a problem).
//
// This is a REGRESSION GUARD, not a tight perf gate: the ceiling is set
// generously above the measured baseline so it fails loudly on a real
// blowup (e.g. an accidental O(n^2) change) without flaking on a slow CI
// runner. The actual measured numbers are logged for the record.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';

const { getFoodSearch } = await import('../src/services/foodEstimator.js');

function bench(fsx, queries, opts, reps) {
  for (const q of queries) fsx.search(q, opts); // warm up (V8 JIT)
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < reps; i += 1) for (const q of queries) fsx.search(q, opts);
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1e6 / (reps * queries.length); // ms/query
}

test('food model dataset loads at the expected scale', () => {
  const fsx = getFoodSearch();
  assert.ok(fsx, 'food model must be available for this benchmark to mean anything');
  assert.ok(fsx.foods.length > 15000, `expected ~21k foods, got ${fsx.foods.length}`);
});

test('exact/alias-hit queries resolve well under the regression ceiling', () => {
  const fsx = getFoodSearch();
  if (!fsx) return; // model unavailable on this deployment -- covered elsewhere, not a search-perf question
  const ms = bench(fsx, ['rice', 'chapati', 'paneer', 'dosa', 'idli', 'biryani', 'dal', 'egg', 'chicken breast', 'banana'], { limit: 8 }, 15);
  console.log(`[bench] exact/alias hits: ${ms.toFixed(2)} ms/query`);
  assert.ok(ms < 200, `exact-hit search regressed to ${ms.toFixed(1)} ms/query (ceiling 200ms)`);
});

test('progressive-backoff (multi-word) queries resolve well under the regression ceiling', () => {
  const fsx = getFoodSearch();
  if (!fsx) return;
  const ms = bench(fsx, ['apple big', 'fresh banana raw', 'spicy chicken curry with rice'], { limit: 8 }, 15);
  console.log(`[bench] backoff (multi-word): ${ms.toFixed(2)} ms/query`);
  assert.ok(ms < 300, `backoff search regressed to ${ms.toFixed(1)} ms/query (ceiling 300ms)`);
});

test('the ABSOLUTE WORST CASE -- a total miss that runs every fallback tier -- stays well under the regression ceiling', () => {
  const fsx = getFoodSearch();
  if (!fsx) return;
  // Nonsense tokens long enough to enter the fuzzy tier but far from any
  // real word, so exact, backoff, AND fuzzy all run and all fail -- the
  // single most expensive path through search().
  const ms = bench(fsx, ['zzzqqxwv wobblefritz', 'asdkjfhqwerty', 'quantum flux capacitor device'], { limit: 8 }, 10);
  console.log(`[bench] total miss (every tier runs): ${ms.toFixed(2)} ms/query`);
  assert.ok(ms < 500, `worst-case miss regressed to ${ms.toFixed(1)} ms/query (ceiling 500ms) -- an API request should never wait this long on a single search`);
});
