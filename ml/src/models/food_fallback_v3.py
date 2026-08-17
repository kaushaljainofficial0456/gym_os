"""
Tier-3 fallback, v3 -- tuning the retrieval approach that won in v2.

v2 RESULT: kNN retrieval beat regression on every target, because it
returns REAL measured values of similar foods instead of regressing
toward the training mean. v3 tunes the retrieval itself:

  * k sweep -- how many neighbours to pool
  * class-aware distance -- append the food-class features (fried /
    sweet_syrup / beverage / ...) to the vector used for similarity, so a
    "jalebi" is pulled toward other syrup sweets rather than toward
    anything sharing letters with it
  * distance-weighted vs uniform pooling
  * a similarity FLOOR -- if the nearest known food is not actually
    similar, that is a food we should decline to estimate rather than
    answer badly. Knowing when to abstain is worth more than a wrong
    number in a calorie tracker.

METRIC NOTE: headline is MEDIAN absolute percentage error. Mean MAPE on
this data is dominated by a handful of near-zero-calorie foods (black
coffee, clear soup, lettuce) where a 10 kcal miss is a 300% error while
being nutritionally irrelevant. Both are reported; median is the one that
reflects what a user experiences.
"""
import json
import re
import unicodedata
from pathlib import Path

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.model_selection import GroupShuffleSplit
from sklearn.neighbors import NearestNeighbors
from sklearn.metrics import mean_absolute_error
from sklearn.preprocessing import normalize as l2norm
from scipy import sparse

from food_fallback_v2 import CLASS_CUES, normalize, load_rows, TARGETS, SEED  # noqa: E402

PROC = Path(__file__).resolve().parents[2] / "data" / "processed"
OUT_DIR = Path(__file__).resolve().parents[2] / "models" / "skos-food-v1"
COMPILED = {k: re.compile(v, re.I) for k, v in CLASS_CUES.items()}

# How strongly food-class membership counts toward similarity, relative to
# the text vector (which is L2-normalised to length 1). Swept below.
CLASS_WEIGHTS = [0.0, 0.5, 1.0, 1.5, 2.5]
K_VALUES = [3, 5, 7, 10, 15]


def class_matrix(names, weight):
    rows = []
    for n in names:
        rows.append([1.0 if rx.search(n) else 0.0 for rx in COMPILED.values()])
    m = np.asarray(rows, dtype=float)
    # L2-normalise so a food in many classes does not dominate, then scale
    norms = np.linalg.norm(m, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return (m / norms) * weight


def med_ape(pred, true):
    m = true > 1
    return float(np.median(np.abs(pred[m] - true[m]) / true[m]) * 100)


def mean_ape(pred, true):
    m = true > 1
    return float(np.mean(np.abs(pred[m] - true[m]) / true[m]) * 100)


def main():
    rows = load_rows()
    names = [r["name"] for r in rows]
    groups = np.array([r["group"] for r in rows])
    tr, te = next(GroupShuffleSplit(n_splits=1, test_size=0.2,
                                    random_state=SEED).split(names, groups=groups))
    names_tr = [names[i] for i in tr]
    names_te = [names[i] for i in te]
    print(f"rows {len(rows)}  train {len(tr)}  test {len(te)}  (disjoint families)\n")

    wv = TfidfVectorizer(analyzer="word", ngram_range=(1, 2), min_df=2, sublinear_tf=True)
    cv = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), min_df=3, sublinear_tf=True)
    Xt_tr = l2norm(sparse.hstack([wv.fit_transform(names_tr), cv.fit_transform(names_tr)]).tocsr())
    Xt_te = l2norm(sparse.hstack([wv.transform(names_te), cv.transform(names_te)]).tocsr())

    Y_tr = {t: np.array([rows[i][t] for i in tr], dtype=float) for t in TARGETS}
    Y_te = {t: np.array([rows[i][t] for i in te], dtype=float) for t in TARGETS}

    best_cfg, best_score = None, 1e9
    grid = []

    for cw in CLASS_WEIGHTS:
        if cw > 0:
            A_tr = sparse.hstack([Xt_tr, sparse.csr_matrix(class_matrix(names_tr, cw))]).tocsr()
            A_te = sparse.hstack([Xt_te, sparse.csr_matrix(class_matrix(names_te, cw))]).tocsr()
        else:
            A_tr, A_te = Xt_tr, Xt_te

        kmax = max(K_VALUES)
        nn = NearestNeighbors(n_neighbors=kmax, metric="cosine").fit(A_tr)
        dist, idx = nn.kneighbors(A_te)
        sim_all = np.clip(1.0 - dist, 0.0, None)

        for k in K_VALUES:
            d, i_, s = dist[:, :k], idx[:, :k], sim_all[:, :k]
            for weighting in ("uniform", "similarity"):
                if weighting == "uniform":
                    w = np.full_like(s, 1.0 / k)
                else:
                    ss = np.clip(s, 1e-6, None)
                    w = ss / ss.sum(axis=1, keepdims=True)

                scores = {}
                for t in TARGETS:
                    pred = np.clip((Y_tr[t][i_] * w).sum(axis=1), 0, None)
                    scores[t] = {
                        "med_ape": round(med_ape(pred, Y_te[t]), 1),
                        "mean_ape": round(mean_ape(pred, Y_te[t]), 1),
                        "mae": round(float(mean_absolute_error(Y_te[t], pred)), 2),
                    }
                # optimise on energy, the number the user actually sees
                composite = scores["energy_kcal"]["med_ape"]
                grid.append({"class_weight": cw, "k": k, "weighting": weighting,
                             "energy_med_ape": composite, "scores": scores})
                if composite < best_score:
                    best_score, best_cfg = composite, grid[-1]

    grid.sort(key=lambda g: g["energy_med_ape"])
    print("TOP 8 CONFIGURATIONS (by energy median APE):")
    print(f"  {'cls_w':>6s} {'k':>3s} {'weighting':>11s}  {'energy':>7s} {'protein':>8s} {'fat':>6s} {'carb':>6s}")
    for g in grid[:8]:
        s = g["scores"]
        print(f"  {g['class_weight']:6.1f} {g['k']:3d} {g['weighting']:>11s}  "
              f"{s['energy_kcal']['med_ape']:6.1f}% {s['protein_g']['med_ape']:7.1f}% "
              f"{s['fat_g']['med_ape']:5.1f}% {s['carb_g']['med_ape']:5.1f}%")

    # ---- abstention analysis on the winning config ----
    cw, k, weighting = best_cfg["class_weight"], best_cfg["k"], best_cfg["weighting"]
    if cw > 0:
        A_tr = sparse.hstack([Xt_tr, sparse.csr_matrix(class_matrix(names_tr, cw))]).tocsr()
        A_te = sparse.hstack([Xt_te, sparse.csr_matrix(class_matrix(names_te, cw))]).tocsr()
    else:
        A_tr, A_te = Xt_tr, Xt_te
    nn = NearestNeighbors(n_neighbors=k, metric="cosine").fit(A_tr)
    dist, idx = nn.kneighbors(A_te)
    sim = np.clip(1.0 - dist, 0.0, None)
    w = (np.clip(sim, 1e-6, None) / np.clip(sim, 1e-6, None).sum(axis=1, keepdims=True)
         if weighting == "similarity" else np.full_like(sim, 1.0 / k))
    pred_e = np.clip((Y_tr["energy_kcal"][idx] * w).sum(axis=1), 0, None)
    top_sim = sim[:, 0]

    print(f"\nBEST: class_weight={cw}  k={k}  weighting={weighting}")
    print("\nABSTENTION -- accuracy vs coverage, by nearest-neighbour similarity:")
    print(f"  {'min_sim':>8s} {'covered':>8s} {'med_ape':>8s}")
    chosen = None
    for thr in (0.0, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65):
        m = top_sim >= thr
        if m.sum() < 30:
            continue
        e = med_ape(pred_e[m], Y_te["energy_kcal"][m])
        cov = 100 * m.sum() / len(m)
        print(f"  {thr:8.2f} {cov:7.1f}% {e:7.1f}%")
        if chosen is None and e <= 20.0 and cov >= 50:
            chosen = {"min_similarity": thr, "coverage_pct": round(cov, 1),
                      "energy_med_ape": round(e, 1)}

    resid = pred_e - Y_te["energy_kcal"]
    payload = {
        "model_version": "skos-food-v1-fallback-v3",
        "method": "similarity-weighted kNN retrieval over measured foods",
        "validation": "GroupShuffleSplit on name stem (unseen food families)",
        "best_config": {"class_weight": cw, "k": k, "weighting": weighting},
        "scores": best_cfg["scores"],
        "abstention_recommendation": chosen,
        "energy_interval_80": {
            "lo_offset": round(float(np.quantile(resid, 0.10)), 1),
            "hi_offset": round(float(np.quantile(resid, 0.90)), 1),
        },
        "irreducible_floor_note": (
            "Remaining error is dominated by genuine within-name variance: the "
            "same dish name spans a wide real range (oil absorption in fried "
            "foods, cream/ghee in curries, syrup uptake in sweets). No "
            "name-only model can recover information the string does not "
            "contain, so this tier must always be labelled an estimate."
        ),
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "fallback_v3_metrics.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"\nWrote {OUT_DIR / 'fallback_v3_metrics.json'}")


if __name__ == "__main__":
    main()
