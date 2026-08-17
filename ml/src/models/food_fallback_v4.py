"""
Tier-3 fallback, v4 -- final model, evaluated under BOTH deployment
regimes instead of only the hardest one.

WHAT v3 GOT WRONG ABOUT ITS OWN VALIDATION:
v1-v3 all validated with GroupShuffleSplit on the FIRST TOKEN of the food
name. That removes the entire food family from training -- so predicting
"chicken korma" happens with no chicken food of any kind seen. That is
the correct test for a genuinely novel food ("jalebi", absent from all
four sources), but it is NOT the common case.

In practice most tier-3 queries share a head noun with something known:
the user types "chicken korma", the database has "chicken curry". Scoring
only the hardest regime understates real accuracy; scoring only the
easier one overstates it. So both are measured and reported separately,
and the deployed model reports which regime a given query fell into.

  REGIME A (novel family)  -- head noun unseen in training. Hardest.
  REGIME B (known family)  -- head noun seen, full name unseen. Common.

MEASURED FLOOR (irreducible_error_floor.py, run on this same DB):
  * identical names across sources differ by only ~5.1% median -- naming
    is not the problem, and this case is tier 1 anyway.
  * foods sharing a HEAD NOUN genuinely differ by ~16.9% median. That is
    the floor for regime A, because the head noun is all the information
    a novel-family query carries.
So ~17% median APE is near-optimal for regime A, not a failure to tune.
"""
import json
import re
from pathlib import Path

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.model_selection import GroupShuffleSplit, ShuffleSplit
from sklearn.neighbors import NearestNeighbors
from sklearn.metrics import mean_absolute_error
from sklearn.preprocessing import normalize as l2norm
from scipy import sparse

from food_fallback_v2 import CLASS_CUES, normalize, load_rows, TARGETS, SEED  # noqa: E402

OUT_DIR = Path(__file__).resolve().parents[2] / "models" / "skos-food-v1"
COMPILED = {k: re.compile(v, re.I) for k, v in CLASS_CUES.items()}

BEST_CLASS_WEIGHT = 0.5      # from the v3 sweep
BEST_K = 5
BEST_WEIGHTING = "similarity"


def class_matrix(names, weight=BEST_CLASS_WEIGHT):
    rows = [[1.0 if rx.search(n) else 0.0 for rx in COMPILED.values()] for n in names]
    m = np.asarray(rows, dtype=float)
    norms = np.linalg.norm(m, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return (m / norms) * weight


def med_ape(pred, true):
    m = true > 1
    return float(np.median(np.abs(pred[m] - true[m]) / true[m]) * 100)


def mean_ape(pred, true):
    m = true > 1
    return float(np.mean(np.abs(pred[m] - true[m]) / true[m]) * 100)


def build_space(names_tr, names_te):
    wv = TfidfVectorizer(analyzer="word", ngram_range=(1, 2), min_df=2, sublinear_tf=True)
    cv = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), min_df=3, sublinear_tf=True)
    Xt_tr = l2norm(sparse.hstack([wv.fit_transform(names_tr), cv.fit_transform(names_tr)]).tocsr())
    Xt_te = l2norm(sparse.hstack([wv.transform(names_te), cv.transform(names_te)]).tocsr())
    A_tr = sparse.hstack([Xt_tr, sparse.csr_matrix(class_matrix(names_tr))]).tocsr()
    A_te = sparse.hstack([Xt_te, sparse.csr_matrix(class_matrix(names_te))]).tocsr()
    return A_tr, A_te


def evaluate(rows, tr, te, label):
    names = [r["name"] for r in rows]
    names_tr = [names[i] for i in tr]
    names_te = [names[i] for i in te]
    A_tr, A_te = build_space(names_tr, names_te)

    nn = NearestNeighbors(n_neighbors=BEST_K, metric="cosine").fit(A_tr)
    dist, idx = nn.kneighbors(A_te)
    sim = np.clip(1.0 - dist, 1e-6, None)
    w = sim / sim.sum(axis=1, keepdims=True)

    out = {}
    print(f"\n{label}   (train {len(tr)}, test {len(te)})")
    for t in TARGETS:
        y = np.array([r[t] for r in rows], dtype=float)
        pred = np.clip((y[tr][idx] * w).sum(axis=1), 0, None)
        out[t] = {
            "median_ape": round(med_ape(pred, y[te]), 1),
            "mean_ape": round(mean_ape(pred, y[te]), 1),
            "mae": round(float(mean_absolute_error(y[te], pred)), 2),
        }
        print(f"   {t:12s} medAPE {out[t]['median_ape']:5.1f}%   "
              f"meanAPE {out[t]['mean_ape']:6.1f}%   MAE {out[t]['mae']:7.2f}")

    y_e = np.array([r["energy_kcal"] for r in rows], dtype=float)
    pred_e = np.clip((y_e[tr][idx] * w).sum(axis=1), 0, None)
    resid = pred_e - y_e[te]
    out["_energy_interval_80"] = {
        "lo_offset": round(float(np.quantile(resid, 0.10)), 1),
        "hi_offset": round(float(np.quantile(resid, 0.90)), 1),
    }
    out["_top_similarity_median"] = round(float(np.median(sim[:, 0])), 3)
    return out


def main():
    rows = load_rows()
    names = [r["name"] for r in rows]
    groups = np.array([r["group"] for r in rows])
    print(f"rows {len(rows)}   distinct head nouns {len(set(groups))}")

    tr_a, te_a = next(GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=SEED)
                      .split(names, groups=groups))
    regime_a = evaluate(rows, tr_a, te_a, "REGIME A - novel food family (head noun unseen)")

    tr_b, te_b = next(ShuffleSplit(n_splits=1, test_size=0.2, random_state=SEED)
                      .split(names))
    regime_b = evaluate(rows, tr_b, te_b, "REGIME B - known family, unseen full name")

    payload = {
        "model_version": "skos-food-v1-fallback-v4",
        "method": "similarity-weighted kNN retrieval over measured foods",
        "config": {"k": BEST_K, "class_weight": BEST_CLASS_WEIGHT, "weighting": BEST_WEIGHTING},
        "regime_a_novel_family": regime_a,
        "regime_b_known_family": regime_b,
        "measured_floor": {
            "identical_name_median_ape": 5.1,
            "same_head_noun_median_ape": 16.9,
            "note": (
                "16.9% is the floor that applies to regime A: tier 3 runs only "
                "when no exact match exists, so the head noun is the best "
                "information available, and foods sharing a head noun genuinely "
                "differ by that much. The 5.1% identical-name figure describes "
                "tier 1, which uses a measured value directly."
            ),
        },
        "deployment_rule": (
            "Tier 3 output must always be labelled an estimate and shown with "
            "its interval. It must never be presented in the same visual "
            "weight as a tier-1 measured value."
        ),
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "fallback_v4_metrics.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")

    ea = regime_a["energy_kcal"]["median_ape"]
    eb = regime_b["energy_kcal"]["median_ape"]
    print("\nSUMMARY (energy, median APE)")
    print(f"   regime A, novel family : {ea:5.1f}%   (measured floor ~16.9%)")
    print(f"   regime B, known family : {eb:5.1f}%")
    print(f"   v1 regression baseline : 27.6%")
    print(f"\nWrote {OUT_DIR / 'fallback_v4_metrics.json'}")


if __name__ == "__main__":
    main()
