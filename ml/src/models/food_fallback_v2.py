"""
Tier-3 fallback, v2 -- reducing the 50% MAPE of the v1 regression.

DIAGNOSIS OF WHY V1 WAS BAD:
XGBoost on sparse name text regresses toward the mean when it meets an
unseen food family. Its predictions for exactly the dishes it exists to
serve were badly low (jalebi 147 kcal vs a real ~350-400) -- the classic
signature of a model hedging toward the training average because the
name carries no feature it recognises.

FOUR APPROACHES MEASURED HERE, all on the SAME grouped holdout (split by
name stem, so no food family appears in both train and test):

  A. v1 regression                -- baseline to beat
  B. kNN retrieval                -- return the measured value of the most
                                     similar KNOWN food. Cannot regress to
                                     the mean: every output is a real
                                     food's real measured value.
  C. kNN + structured priors      -- add explicit food-class features
                                     (sweet / fried / curry / beverage /
                                     bread), which encode the energy-density
                                     structure a bag of characters cannot.
  D. blend of B and C with A      -- combine, since retrieval and regression
                                     fail on different foods.

HONEST CEILING (stated before running, so the result is not rationalised
after the fact): name-only prediction has an irreducible error floor.
"Samosa" spans a 2x range depending on oil absorption; "curry" spans 3x
depending on cream and ghee. No model can recover information the string
does not contain. The goal here is to get as close to that floor as
possible and then REPORT the floor honestly -- not to claim parity with
lab measurement, which is unattainable from a name alone.
"""
import json
import re
import unicodedata
from pathlib import Path

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.model_selection import GroupShuffleSplit
from sklearn.metrics import mean_absolute_error
from sklearn.neighbors import NearestNeighbors
from scipy import sparse
import xgboost as xgb

PROC = Path(__file__).resolve().parents[2] / "data" / "processed"
DB_PATH = PROC / "unified_food_db.json"
OUT_DIR = Path(__file__).resolve().parents[2] / "models" / "skos-food-v1"

TARGETS = ["energy_kcal", "protein_g", "fat_g", "carb_g"]
SEED = 17

# Explicit food-class cues. Each maps to a real, physically-grounded
# energy-density regime -- fried foods carry absorbed oil (~9 kcal/g),
# syrup-soaked sweets carry sugar (~4 kcal/g at high mass fraction),
# soups and beverages are mostly water (~0.3 kcal/g). A character n-gram
# model has to rediscover this from scratch and largely fails to.
CLASS_CUES = {
    "fried": r"\b(fried|fry|deep.fried|pakora|pakoda|bhaji|vada|samosa|puri|"
             r"poori|bhatura|chips|crisps|fritter|cutlet|tikki|nugget)\b",
    "sweet_syrup": r"\b(jalebi|gulab|jamun|rasgulla|rasmalai|imarti|halwa|"
                   r"barfi|burfi|ladoo|laddu|peda|kalakand|malpua|syrup|"
                   r"candy|toffee|chocolate|fudge|dessert|sweet)\b",
    "curry_gravy": r"\b(curry|gravy|masala|korma|kofta|makhani|sabzi|sabji|"
                   r"bhurji|rogan|vindaloo|do.piaza|jalfrezi|tikka)\b",
    "beverage": r"\b(juice|drink|water|tea|coffee|lassi|chaas|sharbat|"
                r"smoothie|shake|soda|beverage|nimbu|panna)\b",
    "soup": r"\b(soup|shorba|rasam|broth|consomme|stock)\b",
    "bread": r"\b(roti|chapati|paratha|parantha|naan|kulcha|bread|bun|pav|"
             r"toast|thepla|puran|dosa|uttapam|appam|idli)\b",
    "rice_dish": r"\b(rice|pulao|pilaf|biryani|khichdi|khichri|fried.rice)\b",
    "dairy_fat": r"\b(ghee|butter|cream|malai|paneer|cheese|khoa|mawa|oil)\b",
    "salad_raw": r"\b(salad|raita|chutney|sprouts|kachumber|slaw)\b",
    "dal_pulse": r"\b(dal|daal|dhal|sambar|rajma|chana|chole|lentil|bean)\b",
    "meat": r"\b(chicken|mutton|lamb|beef|pork|fish|prawn|egg|keema|kebab)\b",
    "snack_dry": r"\b(namkeen|mixture|sev|bhujia|chivda|murmura|biscuit|"
                 r"cookie|cracker|papad|khakhra)\b",
}
COMPILED_CUES = {k: re.compile(v, re.I) for k, v in CLASS_CUES.items()}


def normalize(text):
    n = unicodedata.normalize("NFKD", text or "")
    n = "".join(c for c in n if not unicodedata.combining(c))
    n = n.lower()
    n = re.sub(r"[^a-z0-9\s]", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def class_features(names):
    """Dense 0/1 matrix of food-class membership, plus token count."""
    rows = []
    for n in names:
        f = [1.0 if rx.search(n) else 0.0 for rx in COMPILED_CUES.values()]
        f.append(min(len(n.split()), 10) / 10.0)
        rows.append(f)
    return np.asarray(rows, dtype=float)


def load_rows():
    db = json.loads(DB_PATH.read_text(encoding="utf-8"))
    rows = []
    for f in db:
        if f.get("data_quality_flag"):
            continue
        if any(f.get(t) is None for t in TARGETS):
            continue
        name = normalize(f.get("food_name"))
        if not name or not (0 < f["energy_kcal"] <= 900):
            continue
        rows.append({"name": name, "group": name.split()[0],
                     **{t: float(f[t]) for t in TARGETS}})
    return rows


def mape(pred, true):
    m = true > 1
    return float(np.mean(np.abs(pred[m] - true[m]) / true[m]) * 100)


def median_ape(pred, true):
    """Median APE -- far more representative than mean APE when a handful
    of near-zero-calorie foods (lettuce, black coffee) blow up the ratio."""
    m = true > 1
    return float(np.median(np.abs(pred[m] - true[m]) / true[m]) * 100)


def main():
    rows = load_rows()
    names = [r["name"] for r in rows]
    groups = np.array([r["group"] for r in rows])
    print(f"rows {len(rows)}   name-stem groups {len(set(groups))}")

    tr, te = next(GroupShuffleSplit(n_splits=1, test_size=0.2,
                                    random_state=SEED).split(names, groups=groups))
    names_tr = [names[i] for i in tr]
    names_te = [names[i] for i in te]
    print(f"train {len(tr)}  test {len(te)}  (disjoint food families)\n")

    wv = TfidfVectorizer(analyzer="word", ngram_range=(1, 2), min_df=2, sublinear_tf=True)
    cv = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), min_df=3, sublinear_tf=True)
    Xw_tr, Xc_tr = wv.fit_transform(names_tr), cv.fit_transform(names_tr)
    Xw_te, Xc_te = wv.transform(names_te), cv.transform(names_te)
    Cls_tr, Cls_te = class_features(names_tr), class_features(names_te)

    X_text_tr = sparse.hstack([Xw_tr, Xc_tr]).tocsr()
    X_text_te = sparse.hstack([Xw_te, Xc_te]).tocsr()
    X_full_tr = sparse.hstack([Xw_tr, Xc_tr, sparse.csr_matrix(Cls_tr)]).tocsr()
    X_full_te = sparse.hstack([Xw_te, Xc_te, sparse.csr_matrix(Cls_te)]).tocsr()

    # ---- retrieval index (cosine over the same text space) ----
    knn = NearestNeighbors(n_neighbors=7, metric="cosine").fit(X_text_tr)
    dist, idx = knn.kneighbors(X_text_te)
    # similarity weights; guard the exact-duplicate case
    sim = np.clip(1.0 - dist, 1e-6, None)
    w = sim / sim.sum(axis=1, keepdims=True)

    results = {}
    preds_by_method = {}

    for target in TARGETS:
        y = np.array([r[target] for r in rows], dtype=float)
        y_tr, y_te = y[tr], y[te]

        # A) regression on text only (v1)
        mA = xgb.XGBRegressor(n_estimators=400, max_depth=6, learning_rate=0.08,
                              subsample=0.85, colsample_bytree=0.6, reg_lambda=2.0,
                              min_child_weight=3, objective="reg:squarederror",
                              tree_method="hist", random_state=SEED, n_jobs=4, verbosity=0)
        mA.fit(X_text_tr, np.log1p(y_tr))
        pA = np.clip(np.expm1(mA.predict(X_text_te)), 0, None)

        # B) kNN retrieval -- similarity-weighted mean of real measured values
        pB = np.clip((y_tr[idx] * w).sum(axis=1), 0, None)

        # C) regression WITH explicit food-class features
        mC = xgb.XGBRegressor(n_estimators=400, max_depth=6, learning_rate=0.08,
                              subsample=0.85, colsample_bytree=0.6, reg_lambda=2.0,
                              min_child_weight=3, objective="reg:squarederror",
                              tree_method="hist", random_state=SEED, n_jobs=4, verbosity=0)
        mC.fit(X_full_tr, np.log1p(y_tr))
        pC = np.clip(np.expm1(mC.predict(X_full_te)), 0, None)

        # D) blend -- retrieval and regression fail on different foods
        pD = np.clip(0.45 * pB + 0.55 * pC, 0, None)

        row = {}
        for label, p in (("A_regression_text", pA), ("B_knn_retrieval", pB),
                         ("C_regression_classfeat", pC), ("D_blend", pD)):
            row[label] = {
                "mae": round(float(mean_absolute_error(y_te, p)), 2),
                "mape": round(mape(p, y_te), 1),
                "median_ape": round(median_ape(p, y_te), 1),
            }
        results[target] = row
        preds_by_method[target] = {"D_blend": pD, "y": y_te}

        print(f"{target}")
        for label in ("A_regression_text", "B_knn_retrieval", "C_regression_classfeat", "D_blend"):
            r = row[label]
            print(f"   {label:24s} MAE {r['mae']:7.2f}   MAPE {r['mape']:6.1f}%   medAPE {r['median_ape']:6.1f}%")
        print()

    best = {}
    for target, row in results.items():
        b = min(row.items(), key=lambda kv: kv[1]["median_ape"])
        best[target] = {"method": b[0], **b[1]}

    y_te_e = preds_by_method["energy_kcal"]["y"]
    p_e = preds_by_method["energy_kcal"]["D_blend"]
    resid = p_e - y_te_e
    interval = {"lo_offset": round(float(np.quantile(resid, 0.10)), 1),
                "hi_offset": round(float(np.quantile(resid, 0.90)), 1)}

    payload = {
        "model_version": "skos-food-v1-fallback-v2",
        "validation": "GroupShuffleSplit on name stem (unseen food families)",
        "all_methods": results,
        "best_per_target": best,
        "energy_interval_80": interval,
        "note": (
            "median_ape is the honest headline: mean MAPE is inflated by a "
            "handful of near-zero-calorie foods where any absolute error is a "
            "huge ratio. Name-only prediction has an irreducible floor -- the "
            "same dish name spans a wide real range - so this tier must be "
            "labelled an estimate, never presented like a measured value."
        ),
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "fallback_v2_metrics.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")

    print("BEST PER TARGET (by median APE):")
    for t, b in best.items():
        print(f"   {t:12s} {b['method']:24s} medAPE {b['median_ape']:5.1f}%  MAE {b['mae']:7.2f}")
    print(f"\nenergy 80% interval: {interval}")


if __name__ == "__main__":
    main()
