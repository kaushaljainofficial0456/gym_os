"""
Export step for Tier 3 (kNN fallback) deployment.

food_fallback_v4.py (ml/src/models/) is an EVALUATION script: it fits its
TF-IDF vectorizers on an 80% train split and scores against a 20% held-out
split, to MEASURE accuracy honestly. That script is not touched here and
must not be -- its tuned hyperparameters (k=5, class_weight=0.5,
weighting='similarity', see BEST_K/BEST_CLASS_WEIGHT/BEST_WEIGHTING) and
its reported regime A/B metrics are the validated result this project
already trusts.

THIS script does the separate, standard "ship it" step: fit the SAME
vectorizers with the SAME hyperparameters on the FULL corpus (not an 80%
split -- a deployed model should see everything the evaluation held back),
then export just enough (vocabulary + IDF weights for both the word and
char_wb vectorizers, plus the row corpus: normalized name + the 4 target
values) for a query-time transform to be reproduced exactly in JS at
runtime. This mirrors the project's own established pattern: Python
computes once, JS reads a static artifact (see unified_food_db.json,
food_aliases.json, off_barcode_index.json).

Row VECTORS are deliberately NOT exported -- only vocabulary+idf+row text.
The JS engine reconstructs each row's TF-IDF vector once at process start
(cheap: plain string tokenization, no ML library needed) and caches it for
the process lifetime, exactly like FoodSearch already does for the Tier 1
index. This keeps the exported artifact small (vocabulary-bounded, not
row-count x dimensionality) instead of shipping a dense/sparse matrix dump.

Also exports a small GOLDEN set: fixed queries with their expected top-5
neighbours, similarities and blended predictions, computed here in Python
against the full-corpus fit -- used by fallbackKnn.reference.js's parity
test to prove the JS engine reproduces this exact math, not an
approximation of it.
"""
import json
import sys
from pathlib import Path

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.preprocessing import normalize as l2norm
from scipy import sparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "models"))
from food_fallback_v2 import CLASS_CUES, normalize, load_rows, TARGETS  # noqa: E402
from food_fallback_v4 import class_matrix, BEST_K, BEST_CLASS_WEIGHT  # noqa: E402

OUT_DIR = Path(__file__).resolve().parents[2] / "models" / "skos-food-v1"


def vectorizer_export(vec):
    """vocabulary_ maps term -> column index; idf_ is aligned to those
    columns. Exporting both, nothing else -- this is everything a
    query-time transform needs to reproduce sklearn's TfidfVectorizer
    exactly (sublinear tf, smooth idf, per-row L2 norm)."""
    vocab = {str(k): int(v) for k, v in vec.vocabulary_.items()}
    idf = [float(x) for x in vec.idf_]
    return {"vocabulary": vocab, "idf": idf,
            "analyzer": vec.analyzer, "ngram_range": list(vec.ngram_range)}


def build_full_space(names):
    wv = TfidfVectorizer(analyzer="word", ngram_range=(1, 2), min_df=2, sublinear_tf=True)
    cv = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), min_df=3, sublinear_tf=True)
    Xw = wv.fit_transform(names)
    Xc = cv.fit_transform(names)
    Xt = l2norm(sparse.hstack([Xw, Xc]).tocsr())
    A = sparse.hstack([Xt, sparse.csr_matrix(class_matrix(names))]).tocsr()
    return wv, cv, A


def cosine_topk(query_vec, matrix, k):
    """True cosine similarity (not a raw dot product -- A's rows are not
    globally unit-normed after the class-cue concat, see build_space's own
    comment in food_fallback_v4.py)."""
    qn = np.sqrt(query_vec.multiply(query_vec).sum())
    if qn == 0:
        return np.array([]), np.array([])
    row_norms = np.sqrt(matrix.multiply(matrix).sum(axis=1)).A.ravel()
    dots = matrix.dot(query_vec.T).toarray().ravel()
    denom = np.where(row_norms > 0, row_norms, 1.0) * qn
    sims = np.where(row_norms > 0, dots / denom, 0.0)
    top = np.argsort(-sims)[:k]
    return top, sims[top]


def predict(rows, top_idx, sims, target):
    sim = np.clip(sims, 1e-6, None)
    w = sim / sim.sum()
    y = np.array([rows[i][target] for i in top_idx], dtype=float)
    return float(max(0.0, (y * w).sum()))


def main():
    rows = load_rows()
    names = [r["name"] for r in rows]
    print(f"fitting on full corpus: {len(rows)} rows")

    wv, cv, A = build_full_space(names)
    print(f"word vocab: {len(wv.vocabulary_)}   char vocab: {len(cv.vocabulary_)}   "
          f"combined dim (incl class cues): {A.shape[1]}")

    golden_queries = [
        "chicken biryani",
        "paneer butter masala",
        "gulab jamun",
        names[len(names) // 3],       # an exact in-corpus name (sanity: top match ~= itself)
        "homemade rogan josh curry",
    ]
    golden = []
    for q in golden_queries:
        qn = normalize(q)
        qw = wv.transform([qn])
        qc = cv.transform([qn])
        qt = l2norm(sparse.hstack([qw, qc]).tocsr())
        qa = sparse.hstack([qt, sparse.csr_matrix(class_matrix([qn]))]).tocsr()
        top_idx, sims = cosine_topk(qa, A, BEST_K)
        preds = {t: round(predict(rows, top_idx, sims, t), 2) for t in TARGETS}
        golden.append({
            "query": q,
            "normalized": qn,
            "neighbors": [{"name": rows[i]["name"], "similarity": round(float(s), 6)}
                          for i, s in zip(top_idx, sims)],
            "predicted": preds,
        })
        print(f"  query={q!r:40s} -> top1={rows[top_idx[0]]['name']!r} "
              f"sim={sims[0]:.4f}  energy_kcal={preds['energy_kcal']}")

    payload = {
        "model_version": "skos-food-v1-fallback-v4",
        "config": {"k": BEST_K, "class_weight": BEST_CLASS_WEIGHT},
        "class_cues": CLASS_CUES,  # ordered dict -- JS must build its 12-dim vector in this exact key order
        "word_vectorizer": vectorizer_export(wv),
        "char_vectorizer": vectorizer_export(cv),
        "rows": [{"name": r["name"], **{t: r[t] for t in TARGETS}} for r in rows],
        "golden": golden,
    }
    out_path = OUT_DIR / "fallback_v4_index.json"
    out_path.write_text(json.dumps(payload), encoding="utf-8")
    print(f"\nwrote {out_path}  ({out_path.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
