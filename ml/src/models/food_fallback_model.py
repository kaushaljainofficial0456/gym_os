"""
skos-food-v1 TIER 3: ML fallback for foods absent from every source.

WHERE THIS IS ALLOWED TO RUN:
Only when tiers 1 and 2 both fail -- no exact match, no alias match, no
compositional breakdown. For anything the database actually contains, a
measured value is used and this model is never consulted. Predicting
"paneer" when a lab measured paneer would be strictly worse.

Real motivating cases: "jalebi", "vindaloo", "rogan josh" -- verified
absent from IFCT, INDB, USDA FDC and Open Food Facts. Today the app can
only say nothing. A calibrated estimate with an honest error bar is more
useful than silence, PROVIDED it is labelled as an estimate.

WHY NAME-TEXT FEATURES:
The only thing available for an unknown food is what the user typed. So
the model learns from character n-grams and word tokens of the food name
-- "halwa"/"ladoo"/"barfi" share sugar-and-ghee structure; "curry"/"sabzi"
share a lower-density profile. This is genuinely learnable structure, not
a proxy for identity, because it must generalise to names never seen.

VALIDATION IS GROUPED BY NAME STEM, NOT RANDOM:
A random split would put "Potato samosa" in train and "Vegetable samosa"
in test and report a flattering score that says nothing about performance
on a genuinely new dish. Splitting on the leading token forces the model
to predict food families it has never seen -- the actual deployment
condition. This is the same reasoning as leave-one-participant-out in
skos-cal-v1: validate against the shift you will actually face.
"""
import json
import re
import unicodedata
from pathlib import Path

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.model_selection import GroupShuffleSplit
from sklearn.metrics import mean_absolute_error
from scipy import sparse
import xgboost as xgb

PROC = Path(__file__).resolve().parents[2] / "data" / "processed"
DB_PATH = PROC / "unified_food_db.json"
OUT_DIR = Path(__file__).resolve().parents[2] / "models" / "skos-food-v1"

TARGETS = ["energy_kcal", "protein_g", "fat_g", "carb_g"]
SEED = 17


def normalize(text):
    n = unicodedata.normalize("NFKD", text or "")
    n = "".join(c for c in n if not unicodedata.combining(c))
    n = n.lower()
    n = re.sub(r"[^a-z0-9\s]", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def load_training_rows():
    db = json.loads(DB_PATH.read_text(encoding="utf-8"))
    rows = []
    for f in db:
        if f.get("data_quality_flag"):
            continue  # never train on values we already know are inconsistent
        if any(f.get(t) is None for t in TARGETS):
            continue
        name = normalize(f.get("food_name"))
        if not name:
            continue
        # An implausible row would teach the model implausible structure.
        if not (0 < f["energy_kcal"] <= 900):
            continue
        rows.append({
            "name": name,
            "group": name.split()[0],          # family stem for grouped split
            **{t: float(f[t]) for t in TARGETS},
        })
    return rows


def featurize(names, word_vec=None, char_vec=None, fit=False):
    if fit:
        word_vec = TfidfVectorizer(analyzer="word", ngram_range=(1, 2), min_df=2, sublinear_tf=True)
        char_vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), min_df=3, sublinear_tf=True)
        Xw = word_vec.fit_transform(names)
        Xc = char_vec.fit_transform(names)
    else:
        Xw = word_vec.transform(names)
        Xc = char_vec.transform(names)
    return sparse.hstack([Xw, Xc]).tocsr(), word_vec, char_vec


def baseline_mae(y_train, y_test):
    """Predicting the training median for everything. Any model that
    cannot beat this is not learning anything worth shipping."""
    med = np.median(y_train)
    return mean_absolute_error(y_test, np.full_like(y_test, med))


def main():
    rows = load_training_rows()
    print(f"Training rows (clean, complete macro panel): {len(rows)}")

    names = [r["name"] for r in rows]
    groups = np.array([r["group"] for r in rows])
    print(f"Distinct name-stem groups: {len(set(groups))}")

    splitter = GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=SEED)
    train_idx, test_idx = next(splitter.split(names, groups=groups))
    print(f"  train {len(train_idx)}  test {len(test_idx)} (no name-stem appears in both)")

    names_tr = [names[i] for i in train_idx]
    names_te = [names[i] for i in test_idx]
    X_tr, wv, cv = featurize(names_tr, fit=True)
    X_te, _, _ = featurize(names_te, wv, cv)
    print(f"  feature dim: {X_tr.shape[1]}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    report = {}
    boosters = {}

    for target in TARGETS:
        y = np.array([r[target] for r in rows], dtype=float)
        y_tr, y_te = y[train_idx], y[test_idx]

        # Trained on log1p(target) with squared error rather than
        # objective="reg:absoluteerror". Two reasons:
        #   * absoluteerror uses adaptive tree updates in XGBoost and was
        #     ~20x slower here for no measured accuracy gain.
        #   * nutrient targets are right-skewed and strictly non-negative
        #     (oils ~900 kcal, lettuce ~15). Learning in log space makes the
        #     loss proportional rather than absolute, so a 30-kcal miss on
        #     lettuce is penalised as heavily as a 300-kcal miss on oil --
        #     which is the behaviour that actually matters for a food logger.
        # Predictions are transformed back with expm1 before scoring, so all
        # reported metrics remain in real kcal/gram units.
        model = xgb.XGBRegressor(
            n_estimators=400, max_depth=6, learning_rate=0.08,
            subsample=0.85, colsample_bytree=0.6,
            reg_lambda=2.0, min_child_weight=3,
            objective="reg:squarederror",
            tree_method="hist",
            random_state=SEED, n_jobs=4, verbosity=0,
        )
        model.fit(X_tr, np.log1p(y_tr))
        pred = np.clip(np.expm1(model.predict(X_te)), 0, None)

        mae = mean_absolute_error(y_te, pred)
        base = baseline_mae(y_tr, y_te)
        nonzero = y_te > 1
        mape = float(np.mean(np.abs(pred[nonzero] - y_te[nonzero]) / y_te[nonzero]) * 100)
        report[target] = {
            "mae": round(float(mae), 2),
            "median_baseline_mae": round(float(base), 2),
            "improvement_vs_baseline_pct": round(100 * (base - mae) / base, 1),
            "mape_pct": round(mape, 1),
        }
        boosters[target] = model
        print(f"  {target:12s} MAE {mae:7.2f}  (median-baseline {base:7.2f}, "
              f"{report[target]['improvement_vs_baseline_pct']:+5.1f}%)  MAPE {mape:5.1f}%")

    # Residual quantiles -> honest interval, from grouped-holdout errors only.
    y_e = np.array([r["energy_kcal"] for r in rows], dtype=float)[test_idx]
    pred_e = np.clip(np.expm1(boosters["energy_kcal"].predict(X_te)), 0, None)
    resid = pred_e - y_e
    report["energy_kcal"]["interval_80"] = {
        "lo_offset": round(float(np.quantile(resid, 0.10)), 1),
        "hi_offset": round(float(np.quantile(resid, 0.90)), 1),
    }

    meta = {
        "model_version": "skos-food-v1-fallback",
        "tier": 3,
        "usage_rule": (
            "ONLY for foods with no exact, alias, or compositional match. "
            "Never overrides a measured database value."
        ),
        "trained_rows": len(rows),
        "validation": "GroupShuffleSplit on leading name token (unseen food families)",
        "metrics": report,
    }
    (OUT_DIR / "fallback_metrics.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"\nWrote metrics -> {OUT_DIR / 'fallback_metrics.json'}")

    print("\nSanity predictions on foods ABSENT from every source:")
    probes = ["jalebi", "vindaloo", "rogan josh", "gulab jamun", "misal pav", "pani puri"]
    Xp, _, _ = featurize([normalize(p) for p in probes], wv, cv)
    preds = {t: np.clip(np.expm1(boosters[t].predict(Xp)), 0, None) for t in TARGETS}
    for i, p in enumerate(probes):
        print(f"  {p:14s} {preds['energy_kcal'][i]:6.0f} kcal | "
              f"P{preds['protein_g'][i]:5.1f} F{preds['fat_g'][i]:5.1f} C{preds['carb_g'][i]:5.1f}")


if __name__ == "__main__":
    main()
