// ============================================================
// SKOS FOOD ENGINE — PIPELINE STAGES  (Phase 1 scaffold)
//
//     normalize → segment → classify → retrieve → filter → rank → strategy
//
// PHASE 1 SCOPE — deliberately partial, per the approved architecture:
//   * `normalize` and `segment` are REAL, thin wrappers over the existing
//     estimator primitives. They are extracted here as-is so the pipeline
//     has a proven, parity-tested foundation. They preserve current parsing
//     behaviour exactly (foodEstimator.parseFragment / splitItems).
//   * `classify`, `retrieve`, `filter`, `rank`, `selectStrategy` exist with
//     their final SIGNATURES and a documented Phase-1 implementation:
//       - classify / filter    : no-op passthrough returning a valid IR object
//       - retrieve / rank       : delegate to the ONE FoodSearch (lexical L0/L1
//                                 only), box results in the IR shape
//       - selectStrategy        : direct | unresolved only
//     Later phases replace these bodies (semantic retrieval, feature ranker,
//     prep-variant / decompose / rescue routing) WITHOUT changing signatures.
//
// NOTHING HERE IS CALLED BY `estimateMeal` IN PHASE 1. `estimateMeal` is a
// pass-through to the existing `estimateFood` (see food/engine.js). These
// stages are individually unit-tested so Phase 2+ can be built on a proven
// base. Wiring the pipeline into a live estimate is a later, gated phase.
//
// No LLM. No food-specific logic. No nutrition arithmetic.
// ============================================================
'use strict';

import {
  splitItems, parseFragment as legacyParseFragment, getFoodSearch,
  normalize as refNormalize, SOURCE_RANK,
} from '../foodEstimator.js';
import { makeCtx, emptyClassification } from './types.js';

/* ------------------------------------------------------------------ *
 *  Stage 0 — normalize                                               *
 * ------------------------------------------------------------------ */

/**
 * Canonical text form. Delegates to the SAME `normalize` the one FoodSearch
 * uses (NFKD, diacritics stripped, parenthetical groups removed, non-alnum →
 * space, collapsed). Behaviour-preserving by construction.
 *
 * @param {string} text
 * @param {import('./types.js').Ctx} [ctx]
 * @returns {import('./types.js').NormalizedInput}
 */
export function normalize(text, ctx = {}) {
  void makeCtx(ctx); // reserved: locale-aware transliteration is a later phase
  const raw = String(text ?? '');
  const canonical = refNormalize(raw);
  return { raw, text: canonical, tokens: canonical ? canonical.split(' ').filter(Boolean) : [] };
}

/* ------------------------------------------------------------------ *
 *  Stage 1 — segment                                                 *
 * ------------------------------------------------------------------ */

/**
 * Sentence → quantified item fragments. Delegates EXACTLY to the existing
 * `splitItems` + `parseFragment`, then boxes each into the IR `Fragment`
 * shape. A fragment that `parseFragment` rejects (null) is dropped, mirroring
 * `estimateFood`'s own `if (!parsed) continue;`. A fragment that names no
 * food is kept with `name_phrase: ''` (mirrors `estimateFood`'s
 * "unresolved: no food named" path).
 *
 * PARITY GUARANTEE (see food/pipeline.test.js): for every input,
 *   segment(text).map(f => ({ qty: f.qty, unit: f.unit, name: f.name_phrase || null }))
 * equals splitItems(text).map(parseFragment).filter(Boolean).map(p => ({...}))
 *
 * `relation` and `modifiers` are placeholders in Phase 1 (`'standalone'` /
 * `[]`); ` with `/adjacency relation detection and modifier extraction are a
 * later phase and do not affect any current behaviour.
 *
 * @param {string} text
 * @param {import('./types.js').Ctx} [ctx]
 * @returns {import('./types.js').Fragment[]}
 */
export function segment(text, ctx = {}) {
  void ctx;
  const frags = splitItems(text);
  const out = [];
  for (const raw of frags) {
    const parsed = legacyParseFragment(raw);
    if (!parsed) continue;
    out.push({
      raw,
      qty: parsed.qty == null ? null : parsed.qty,
      unit: parsed.unit ?? null,
      name_phrase: parsed.name ?? '',
      modifiers: [],           // Phase 2+: descriptive words split from the name
      relation: 'standalone',  // Phase 2+: 'and' | 'with' | 'combo'
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 *  Stage 2 — classify   (Phase 3 fills this)                          *
 * ------------------------------------------------------------------ */

/**
 * Route a fragment to the right resolution strategy. PHASE 1: returns an
 * empty classification (`kind: 'unknown'`) — nothing is inferred, nothing is
 * routed on it. Phase 3 implements the modifier lexicon + head-noun lookup
 * (+ an LLM tie-break only when retrieval margin is low, Phase 8).
 *
 * @param {import('./types.js').Fragment} fragment
 * @param {import('./types.js').Ctx} [ctx]
 * @returns {import('./types.js').FoodClassification}
 */
export function classify(fragment, ctx = {}) {
  void fragment;
  return emptyClassification(ctx);
}

/* ------------------------------------------------------------------ *
 *  Stage 3 — retrieve   (Phase 2/8 add semantic + LLM layers)        *
 * ------------------------------------------------------------------ */

const qualityProfile = (row) => ({
  source_rank: SOURCE_RANK[row?.source] ?? 5,
  completeness: null,                        // Phase 4
  atwater_ok: null,                          // Phase 4
  has_serving: !!(Number(row?.serving_grams) > 0),
  quarantined: !!row?.data_quality_flag,
  per100g_unreliable: !!row?.per_100g_unreliable,
});

/**
 * Candidate generation. PHASE 1: lexical L0/L1 only — delegates to the ONE
 * `FoodSearch` (exact / alias / token / substring / progressive backoff /
 * spelling-fuzzy), the exact matcher every live path already uses. Phase 2
 * adds an L2 semantic layer; Phase 8 an L3 LLM query-understanding layer.
 * Results are boxed in the IR `Candidate` shape; the rows are NOT reshaped.
 *
 * @param {string} namePhrase
 * @param {import('./types.js').FoodClassification} classification
 * @param {import('./types.js').Ctx} [ctx]
 * @param {{limit?:number}} [opts]
 * @returns {import('./types.js').RetrievalResult}
 */
export function retrieve(namePhrase, classification, ctx = {}, opts = {}) {
  void classification; void ctx;
  const search = getFoodSearch();
  if (!search || !String(namePhrase || '').trim()) {
    return { candidates: [], layers_used: [] };
  }
  const hits = search.search(String(namePhrase), { limit: opts.limit ?? 8 }) || [];
  return {
    candidates: hits.map((h) => ({
      row: h,
      source_id: h.source_id,
      evidence: {
        match_kind: h.match_kind ?? null,
        token_coverage: null,          // Phase 3 (feature extraction)
        phrase_match: null,
        semantic_sim: null,            // Phase 2 (L2)
        head_noun_match: null,
        prep_compatible: null,         // Phase 6
        namespace_match: null,         // Phase 3
        cuisine_match: null,
        quality_profile: qualityProfile(h),
      },
      score: typeof h._score === 'number' ? h._score : null,
    })),
    layers_used: ['lexical'],
  };
}

/* ------------------------------------------------------------------ *
 *  Stage 4 — filter   (Phase 2/3 add quarantine/namespace/prep gates)*
 * ------------------------------------------------------------------ */

/**
 * Drop candidates that cannot be used directly. PHASE 1: identity — returns
 * the input unchanged. The live `estimateFood` path already applies the
 * `trustworthy === false` gate itself (unchanged); this stage will take that
 * over, plus namespace and prep-compatibility filtering, in Phase 2/3.
 *
 * @param {import('./types.js').Candidate[]} candidates
 * @param {import('./types.js').FoodClassification} classification
 * @param {import('./types.js').Ctx} [ctx]
 * @returns {import('./types.js').Candidate[]}
 */
export function filter(candidates, classification, ctx = {}) {
  void classification; void ctx;
  return Array.isArray(candidates) ? candidates : [];
}

/* ------------------------------------------------------------------ *
 *  Stage 5 — rank   (Phase 3 = feature-based scorer)                  *
 * ------------------------------------------------------------------ */

/**
 * Order candidates + expose a top-1 margin. PHASE 1: pass-through — the ONE
 * FoodSearch already returns its list ranked by `FoodSearch.score`, so this
 * only computes the margin from the scores it produced. Phase 3 replaces the
 * hand-weighted `score()` with a feature-vector model (linear, then learned)
 * WITHOUT changing this signature.
 *
 * @param {import('./types.js').Candidate[]} candidates
 * @param {import('./types.js').FoodClassification} classification
 * @param {import('./types.js').Ctx} [ctx]
 * @returns {import('./types.js').RankedResult}
 */
export function rank(candidates, classification, ctx = {}) {
  void classification; void ctx;
  const ranked = Array.isArray(candidates) ? candidates : [];
  let top1_margin = null;
  if (ranked.length >= 2 && typeof ranked[0].score === 'number' && typeof ranked[1].score === 'number') {
    const s0 = ranked[0].score, s1 = ranked[1].score;
    const denom = Math.max(Math.abs(s0), 1);
    top1_margin = Math.round(((s0 - s1) / denom) * 1000) / 1000;
  } else if (ranked.length === 1 && typeof ranked[0].score === 'number') {
    top1_margin = 1;
  }
  return { ranked, top1_margin };
}

/* ------------------------------------------------------------------ *
 *  Stage 6 — selectStrategy   (Phase 3/6 add the full routing table) *
 * ------------------------------------------------------------------ */

/**
 * Pick how the top candidate becomes a number. PHASE 1: `direct` when there
 * is a candidate, `unresolved` when there is not — nothing else. Phase 3
 * adds `prep_variant`; Phase 6 `decompose` / `rescue`; Phase 2/8
 * `semantic` / `llm`. The live `estimateFood` path is unaffected — it still
 * does "top hit → resolveGrams → scaleNutrition" itself.
 *
 * @param {import('./types.js').RankedResult} rankedResult
 * @param {import('./types.js').FoodClassification} classification
 * @param {import('./types.js').Ctx} [ctx]
 * @returns {import('./types.js').StrategySelection}
 */
export function selectStrategy(rankedResult, classification, ctx = {}) {
  void classification; void ctx;
  const top = rankedResult && Array.isArray(rankedResult.ranked) ? rankedResult.ranked[0] : null;
  if (!top) return { strategy: 'unresolved', reason: 'no candidate retrieved', candidate: null };
  return { strategy: 'direct', reason: 'phase-1: single-record lookup', candidate: top };
}

/* ------------------------------------------------------------------ *
 *  Convenience: run the (partial) pipeline for observability/tests.  *
 *  NOT used by estimateMeal. Returns the IR at every stage.          *
 * ------------------------------------------------------------------ */

/**
 * @param {string} text
 * @param {import('./types.js').Ctx} [ctx]
 * @returns {{ normalized, fragments: Array }}
 */
export function inspect(text, ctx = {}) {
  const normalized = normalize(text, ctx);
  const fragments = segment(text, ctx).map((fragment) => {
    const classification = classify(fragment, ctx);
    const retrieval = retrieve(fragment.name_phrase, classification, ctx);
    const filtered = filter(retrieval.candidates, classification, ctx);
    const ranked = rank(filtered, classification, ctx);
    const strategy = selectStrategy(ranked, classification, ctx);
    return {
      fragment, classification,
      candidate_count: retrieval.candidates.length,
      layers_used: retrieval.layers_used,
      top1_margin: ranked.top1_margin,
      strategy: strategy.strategy,
      top_source_id: strategy.candidate?.source_id ?? null,
    };
  });
  return { normalized, fragments };
}
