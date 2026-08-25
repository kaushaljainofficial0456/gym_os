/**
 * skos-food-v1 — TIER 3 (kNN fallback) JS REFERENCE IMPLEMENTATION
 *
 * WHERE THIS SITS (see CONTRACT_skos-food-v1.md):
 *   tier 1  exact / alias match      -> lab value, best possible
 *   tier 2  ingredients known        -> sum of lab values (compositional.reference.js)
 *   tier 3  THIS FILE: name only     -> similarity-weighted kNN, ~15-25% median error
 *   tier 4  AI fallback              -> composition guess, backend-priced
 *
 * WHAT THIS PORTS, AND WHY IT NEEDED AN EXPORT STEP FIRST:
 * ml/src/models/food_fallback_v4.py is an EVALUATION script -- it fits its
 * TF-IDF vectorizers on an 80% split and scores against a held-out 20%, to
 * MEASURE accuracy honestly (the validated numbers in fallback_v4_metrics.json:
 * regime A ~17% median APE, regime B ~15%). It is not a servable "given one
 * new query, return an estimate" function, and it is not touched by this
 * file. ml/src/inference/export_fallback_v4_index.py does the separate,
 * standard "ship it" step -- fits the SAME vectorizers with the SAME
 * hyperparameters (k=5, class_weight=0.5) on the FULL corpus instead of a
 * split, and exports vocabulary+idf+row-corpus to fallback_v4_index.json.
 * THIS file reads that artifact and reproduces the query-time math exactly.
 *
 * THE MATH, VERIFIED EMPIRICALLY AGAINST A LIVE sklearn (not assumed):
 *   1. word vector:  TfidfVectorizer(analyzer='word', ngram_range=(1,2),
 *      sublinear_tf=True, smooth_idf=True) -- tokens are whitespace-split
 *      words of length >= 2 (single characters are DROPPED), 1-grams plus
 *      adjacent-pair 2-grams joined by a single space. tf' = 1 + ln(count)
 *      for count>0. idf(t) = ln((1+n)/(1+df(t))) + 1 (sklearn's smooth_idf
 *      default). Each row's raw tf'*idf vector is then L2-normalized
 *      (sklearn's own per-document default norm='l2').
 *   2. char vector: TfidfVectorizer(analyzer='char_wb', ngram_range=(3,5),
 *      sublinear_tf=True) -- EACH WHITESPACE-DELIMITED WORD (including
 *      single-character ones -- char_wb does NOT apply the word analyzer's
 *      length filter) is padded with one leading+trailing space, then every
 *      contiguous substring of length 3, 4 and 5 is extracted from the
 *      padded word. Same tf'/idf/L2-norm as above, in its own vocabulary.
 *   3. combined text vector = L2normalize(concat(word_vec, char_vec)) --
 *      a SECOND normalization over the concatenation. Because each block
 *      was already independently unit-normed, this does NOT reduce to
 *      "concat two unit vectors" -- concatenating two already-unit vectors
 *      gives norm sqrt(2) (when both are nonzero), and dividing by that
 *      preserves their 50/50 relative weight without special-casing it.
 *   4. class vector = L2normalize(12-dim binary CLASS_CUES regex match) * 0.5.
 *      Class weight (0.5) is applied AFTER normalization, per the tuned
 *      BEST_CLASS_WEIGHT in food_fallback_v4.py.
 *   5. final vector = concat(combined text vector, class vector) -- this
 *      concatenation is NOT renormalized again. Its L2 norm is therefore
 *      NOT 1 in general (sqrt(1.25) =~ 1.118 when a class cue matched,
 *      exactly 1.0 when none did) -- cosine similarity between two such
 *      vectors MUST be computed as a genuine dot(A,B)/(|A|*|B|), never a
 *      raw dot product.
 *   6. k=5 nearest neighbours by that cosine similarity; prediction =
 *      similarity-weighted average of the neighbours' measured
 *      energy_kcal/protein_g/fat_g/carb_g (only these 4 -- the validated
 *      targets), clipped to >= 0. Weights: sim' = max(sim, 1e-6) (guards a
 *      literal all-zero-similarity row), w_i = sim'_i / sum(sim').
 *
 * ml/src/inference/fallbackKnn.parity.test.js checks this file's output
 * against the `golden` fixed-query set the export script computed directly
 * from sklearn, so a divergence in tokenization or normalization surfaces
 * as a failing test, not a silently different number.
 */

'use strict';

const COMBINING_MARKS_RE = /[̀-ͯ]/g;

/** Port of food_fallback_v2.py's normalize(): NFKD decompose, strip
 *  combining marks, lowercase, non-alnum -> space, collapse whitespace. */
function normalize(text) {
  const n = String(text || '').normalize('NFKD').replace(COMBINING_MARKS_RE, '').toLowerCase();
  return n.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** sklearn's word analyzer, ngram_range=(1,2): tokens are runs of 2+
 *  word characters; already-normalized text only contains [a-z0-9\s], so a
 *  plain whitespace split + length filter reproduces sklearn's \b\w\w+\b
 *  token_pattern exactly. 2-grams join adjacent tokens with ONE space. */
function wordNgrams(normalizedText) {
  const tokens = normalizedText.split(' ').filter((t) => t.length >= 2);
  const grams = [...tokens];
  for (let i = 0; i < tokens.length - 1; i++) grams.push(`${tokens[i]} ${tokens[i + 1]}`);
  return grams;
}

/** sklearn's char_wb analyzer, ngram_range=(3,5): each whitespace-delimited
 *  "word" (INCLUDING single characters -- char_wb has no length filter,
 *  verified empirically: a solo "a" still yields ' a ' in char-space even
 *  though it is absent from word-space) is padded with one space on each
 *  side, then every contiguous substring of length 3, 4 and 5 is taken. */
function charWbNgrams(normalizedText) {
  const words = normalizedText.split(' ').filter((w) => w.length > 0);
  const grams = [];
  for (const w of words) {
    const padded = ` ${w} `;
    for (let n = 3; n <= 5; n++) {
      for (let i = 0; i + n <= padded.length; i++) grams.push(padded.slice(i, i + n));
    }
  }
  return grams;
}

/** tf'=1+ln(count) per term (sublinear_tf), idf looked up from the fitted
 *  vocabulary (OOV terms are dropped, matching sklearn's fixed-vocabulary
 *  .transform() behaviour), then the whole vector L2-normalized -- sklearn's
 *  own per-document default. Returns a Map<localIndex, normalizedValue>. */
function tfidfVector(grams, vocabulary, idf) {
  const counts = new Map();
  for (const g of grams) counts.set(g, (counts.get(g) || 0) + 1);

  const raw = new Map(); // localIndex -> tf' * idf
  for (const [term, count] of counts) {
    const idx = vocabulary[term];
    if (idx === undefined) continue; // OOV -- contributes nothing
    const tf = 1 + Math.log(count);
    raw.set(idx, tf * idf[idx]);
  }
  let sumSq = 0;
  for (const v of raw.values()) sumSq += v * v;
  const norm = Math.sqrt(sumSq);
  if (norm > 0) for (const [idx, v] of raw) raw.set(idx, v / norm);
  return raw;
}

function vectorNorm(map) {
  let sumSq = 0;
  for (const v of map.values()) sumSq += v * v;
  return Math.sqrt(sumSq);
}

class FallbackKnnIndex {
  /** @param {object} payload - the parsed fallback_v4_index.json artifact */
  constructor(payload) {
    this.k = payload.config?.k || 5;
    this.classWeight = payload.config?.class_weight ?? 0.5;
    this.wordVocab = payload.word_vectorizer.vocabulary;
    this.wordIdf = payload.word_vectorizer.idf;
    this.charVocab = payload.char_vectorizer.vocabulary;
    this.charIdf = payload.char_vectorizer.idf;
    // Preserve export order -- class_matrix()'s dimension order in Python
    // is CLASS_CUES.items() insertion order; JSON round-trips object key
    // order, so this reproduces it. (Correctness only needs INTERNAL
    // consistency between query and row vectors, not literal parity with
    // Python's own column numbering -- cosine similarity is invariant to
    // any consistent relabelling of dimensions.)
    this.classCues = Object.entries(payload.class_cues || {}).map(([name, pattern]) => [name, new RegExp(pattern, 'i')]);
    this.rows = payload.rows;

    // Global index space for this file's OWN vectors: word block, then
    // char block (offset by word vocab size), then class block (offset by
    // word+char size). Only needs to be self-consistent.
    this.charOffset = Object.keys(this.wordVocab).length ? Math.max(...Object.values(this.wordVocab)) + 1 : 0;
    this.classOffset = this.charOffset + (Object.keys(this.charVocab).length ? Math.max(...Object.values(this.charVocab)) + 1 : 0);

    // Precompute every row's final A-vector + norm once (mirrors
    // FoodSearch's own lazy-singleton index-build pattern) and an inverted
    // index (featureIndex -> [[rowIndex, value], ...]) so a query only
    // scores rows it actually shares a feature with, instead of an O(rows)
    // scan per query.
    this._rowVectors = new Array(this.rows.length);
    this._rowNorms = new Float64Array(this.rows.length);
    this._inverted = new Map();
    for (let i = 0; i < this.rows.length; i++) {
      const vec = this._buildVector(this.rows[i].name, { alreadyNormalized: true });
      this._rowVectors[i] = vec;
      this._rowNorms[i] = vectorNorm(vec);
      for (const idx of vec.keys()) {
        let bucket = this._inverted.get(idx);
        if (!bucket) { bucket = []; this._inverted.set(idx, bucket); }
        bucket.push(i);
      }
    }
  }

  _classVector(normalizedText) {
    const raw = this.classCues.map(([, rx]) => (rx.test(normalizedText) ? 1.0 : 0.0));
    let sumSq = 0;
    for (const v of raw) sumSq += v * v;
    const norm = Math.sqrt(sumSq);
    if (norm === 0) return raw.map(() => 0);
    return raw.map((v) => (v / norm) * this.classWeight);
  }

  /** Builds the final A-vector (Map<globalIndex, value>) for one text. */
  _buildVector(text, { alreadyNormalized = false } = {}) {
    const normalized = alreadyNormalized ? text : normalize(text);
    const wordVec = tfidfVector(wordNgrams(normalized), this.wordVocab, this.wordIdf);
    const charVec = tfidfVector(charWbNgrams(normalized), this.charVocab, this.charIdf);

    // Second-stage L2 norm over the concat of the two already-unit-normed
    // blocks (see file header, step 3) -- NOT assumed to be sqrt(2);
    // computed genuinely so an entirely-OOV block (norm 0) is handled
    // correctly too.
    let sumSq = 0;
    for (const v of wordVec.values()) sumSq += v * v;
    for (const v of charVec.values()) sumSq += v * v;
    const textNorm = Math.sqrt(sumSq);

    const combined = new Map();
    if (textNorm > 0) {
      for (const [idx, v] of wordVec) combined.set(idx, v / textNorm);
      for (const [idx, v] of charVec) combined.set(this.charOffset + idx, v / textNorm);
    }

    const classVec = this._classVector(normalized);
    for (let i = 0; i < classVec.length; i++) {
      if (classVec[i] !== 0) combined.set(this.classOffset + i, classVec[i]);
    }
    return combined; // NOT renormalized again -- matches the source exactly
  }

  /**
   * Similarity-weighted kNN prediction for a free-text food name.
   * Returns null if the query shares literally nothing with the corpus
   * (all-zero vector -- e.g. a query in a script this corpus has no
   * coverage for at all) rather than fabricating neighbours.
   * Otherwise returns { neighbors: [{name, similarity}], predicted: {...},
   * top_similarity }.
   */
  predict(queryText, { k } = {}) {
    const kk = k || this.k;
    const normalized = normalize(queryText);
    const query = this._buildVector(normalized, { alreadyNormalized: true });
    const qNorm = vectorNorm(query);
    if (qNorm === 0 || !this.rows.length) return null;

    // Inverted-index scoring: accumulate partial dot products only for
    // rows sharing at least one feature with the query -- mathematically
    // identical to a full scan (a row with zero overlap has dot product 0
    // and therefore similarity 0, so it can never enter a top-k unless
    // fewer than k rows have any overlap at all, handled below).
    const dots = new Map();
    for (const [idx, qv] of query) {
      const bucket = this._inverted.get(idx);
      if (!bucket) continue;
      for (const rowIdx of bucket) {
        const rv = this._rowVectors[rowIdx].get(idx);
        dots.set(rowIdx, (dots.get(rowIdx) || 0) + qv * rv);
      }
    }
    if (!dots.size) return null;

    const scored = [];
    for (const [rowIdx, dot] of dots) {
      const rNorm = this._rowNorms[rowIdx];
      if (rNorm === 0) continue;
      scored.push([rowIdx, dot / (rNorm * qNorm)]);
    }
    if (!scored.length) return null;
    scored.sort((a, b) => b[1] - a[1]);
    const top = scored.slice(0, kk);

    const sims = top.map(([, s]) => Math.max(s, 1e-6));
    const simSum = sims.reduce((a, b) => a + b, 0);
    const weights = sims.map((s) => s / simSum);

    const targets = ['energy_kcal', 'protein_g', 'fat_g', 'carb_g'];
    const predicted = {};
    for (const t of targets) {
      let acc = 0;
      for (let i = 0; i < top.length; i++) acc += (this.rows[top[i][0]][t] || 0) * weights[i];
      predicted[t] = Math.max(0, acc);
    }

    return {
      neighbors: top.map(([rowIdx, sim], i) => ({
        name: this.rows[rowIdx].name, similarity: sim, weight: weights[i],
      })),
      predicted,
      top_similarity: top[0][1],
    };
  }
}

module.exports = { FallbackKnnIndex, normalize, wordNgrams, charWbNgrams };
