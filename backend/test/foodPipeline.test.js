// ============================================================
// PHASE 1 — staged pipeline scaffold: parity + IR shape
//
// `normalize` and `segment` MUST reproduce the existing parsing exactly
// (they delegate to it). The other stages are Phase-1 scaffolds — this only
// checks they return well-formed IR and never throw. None of these are wired
// into `estimateMeal` yet (that is a later, gated phase).
// ============================================================
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import { splitItems, parseFragment, normalize as refNormalize } from '../src/services/foodEstimator.js';
import {
  normalize, segment, classify, retrieve, filterCandidates, rank, selectStrategy, inspect,
} from '../src/services/food/engine.js';
import { isFragment, emptyClassification, STRATEGIES } from '../src/services/food/types.js';

const CASES = [
  '2 roti', '150g chicken breast', '2 eggs and 1 banana', '1 bowl dal',
  '206g papdi chaat', '2 roti, dal and curd', 'rajma chawal', 'poha',
  'egg', '', '   ', 'quantum flux capacitor', '3 chapati + 100g rice',
  'roti with sabzi', '1/2 cup almonds', 'a dozen eggs',
];

test('normalize() reproduces the reference normalize exactly + tokenises it', () => {
  for (const s of [...CASES, 'Curd (Dahi)', 'Café AU LAIT', 'Rösti  &  eggs']) {
    const out = normalize(s);
    assert.equal(out.raw, String(s ?? ''));
    assert.equal(out.text, refNormalize(String(s ?? '')), `text mismatch for ${JSON.stringify(s)}`);
    assert.deepEqual(out.tokens, out.text ? out.text.split(' ').filter(Boolean) : []);
  }
});

test('segment() is exact parity with splitItems + parseFragment', () => {
  for (const s of CASES) {
    const expected = splitItems(s)
      .map((raw) => parseFragment(raw))
      .filter(Boolean)
      .map((p) => ({ qty: p.qty == null ? null : p.qty, unit: p.unit ?? null, name: p.name ?? null }));
    const actual = segment(s)
      .map((f) => ({ qty: f.qty, unit: f.unit, name: f.name_phrase || null }));
    assert.deepEqual(actual, expected, `segment parity failed for ${JSON.stringify(s)}`);
  }
});

test('segment() emits well-formed IR Fragments', () => {
  for (const s of CASES) {
    for (const f of segment(s)) {
      assert.ok(isFragment(f), `not a Fragment: ${JSON.stringify(f)}`);
      assert.equal(f.relation, 'standalone');      // Phase 1 placeholder
      assert.deepEqual(f.modifiers, []);           // Phase 1 placeholder
    }
  }
});

test('classify() returns an empty Phase-1 classification, never throws', () => {
  for (const s of CASES) {
    for (const f of segment(s)) {
      const c = classify(f, { cuisine_hint: 'indian' });
      assert.deepEqual(c, { ...emptyClassification({ cuisine_hint: 'indian' }) });
      assert.equal(c.kind, 'unknown');
      assert.equal(c.confidence, 0);
    }
  }
});

test('retrieve() delegates to the one FoodSearch and boxes candidates in IR shape', () => {
  const r = retrieve('paneer', emptyClassification(), {}, { limit: 5 });
  assert.deepEqual(r.layers_used, ['lexical']);
  assert.ok(r.candidates.length >= 1 && r.candidates.length <= 5);
  for (const c of r.candidates) {
    assert.equal(typeof c.source_id, 'string');
    assert.ok(c.row && c.row.food_name);
    assert.ok(c.evidence && 'match_kind' in c.evidence && c.evidence.quality_profile);
    assert.equal(typeof c.evidence.quality_profile.quarantined, 'boolean');
  }
  // empty / whitespace / no-match → empty, no throw
  assert.deepEqual(retrieve('', emptyClassification(), {}).candidates, []);
  assert.deepEqual(retrieve('   ', emptyClassification(), {}).candidates, []);
});

test('filter() is Phase-1 identity; rank() passes through + a margin; selectStrategy() = direct|unresolved', () => {
  const r = retrieve('chicken breast', emptyClassification(), {}, { limit: 6 });
  const kept = filterCandidates(r.candidates, emptyClassification(), {});
  assert.deepEqual(kept, r.candidates);

  const ranked = rank(kept, emptyClassification(), {});
  assert.deepEqual(ranked.ranked, kept);
  assert.ok(ranked.top1_margin === null || (typeof ranked.top1_margin === 'number' && ranked.top1_margin >= 0));

  const sel = selectStrategy(ranked, emptyClassification(), {});
  assert.ok(STRATEGIES.includes(sel.strategy));
  assert.equal(sel.strategy, 'direct');
  assert.equal(sel.candidate, ranked.ranked[0]);

  const none = selectStrategy(rank(filterCandidates(retrieve('zzzq-not-a-food', emptyClassification(), {}).candidates, emptyClassification(), {}), emptyClassification(), {}), emptyClassification(), {});
  assert.equal(none.strategy, 'unresolved');
  assert.equal(none.candidate, null);
});

test('inspect() runs the partial pipeline for observability without touching estimateMeal', () => {
  const out = inspect('2 roti, dal and curd', { cuisine_hint: 'indian' });
  assert.equal(out.normalized.text, refNormalize('2 roti, dal and curd'));
  assert.equal(out.fragments.length, 3);
  for (const fr of out.fragments) {
    assert.ok(STRATEGIES.includes(fr.strategy));
    assert.equal(typeof fr.candidate_count, 'number');
  }
});
