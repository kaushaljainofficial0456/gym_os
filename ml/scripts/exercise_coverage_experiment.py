"""
EXPERIMENT: how accurately could we estimate an exercise the model has
NEVER SEEN, using only coarse category attributes?

WHY THIS MATTERS: skos-cal-v1 has trained corrections for exactly 8
exercises. A real app needs ~100. Today, exercise #9 onward falls back to
baseline-only (zero correction). The question is whether we can do better
than that WITHOUT inventing numbers.

--- FIRST ATTEMPT FAILED, AND THE FAILURE IS ITSELF THE KEY FINDING ---
The obvious approach -- predict from muscle_group + movement_pattern +
compound_or_isolation -- produced numerically exploded results (1e14%
MAPE). Diagnosis: `muscle_group` has 6 distinct values across only 8
exercises, and 5 of those 6 appear in exactly ONE exercise. So holding out
BENCH_PRESS removes "chest" from training entirely; the model has zero
information about it, the one-hot design matrix goes singular, and
unregularised OLS coefficients explode.

TRANSLATION: at n=8 exercises, muscle_group is a PROXY FOR EXERCISE
IDENTITY, not a generalisable attribute. It cannot help predict a new
exercise, because every new exercise brings a new muscle_group level.

Only attributes with MULTIPLE exercises per level can generalise:
  compound_or_isolation -> compound (5 exercises), isolation (3)
  body_region (derived)  -> upper (5), lower (3)
Those survive holding one exercise out. This experiment uses those, plus
Ridge regularisation so a near-singular fold degrades gracefully instead
of exploding.

METHOD -- nested Leave-One-EXERCISE-Out x Leave-One-Participant-Out:
  train on: all rows EXCEPT exercise E and EXCEPT participant P
  predict:  rows where exercise == E and participant == P
  -> the model has never seen that exercise NOR that person.

THIS SCRIPT DOES NOT MODIFY model_v1.json OR ANY V1 ARTIFACT.
"""
from pathlib import Path
import sys

SRC_DIR = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_DIR))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from sklearn.linear_model import Ridge  # noqa: E402
from sklearn.preprocessing import OneHotEncoder  # noqa: E402

from models.exploratory_correction_v0 import build_feature_frame  # noqa: E402

# Muscle groups -> coarse body region. This is the ONLY grouping in the
# current ontology with enough exercises per level to survive holding one out.
BODY_REGION = {
    "chest": "upper", "upper_chest": "upper", "lats": "upper",
    "biceps": "upper", "triceps": "upper", "quads": "lower",
}

COARSE_FEATURES = ["body_region", "compound_or_isolation", "mapped_intensity_rating"]
COARSE_PLUS_PATTERN = COARSE_FEATURES + ["movement_pattern"]
EXERCISE_KNOWN_FEATURES = ["exercise_canonical_id", "muscle_group", "compound_or_isolation", "mapped_intensity_rating"]

RIDGE_ALPHA = 1.0


def run(df: pd.DataFrame, feature_cols, use_correction: bool) -> pd.DataFrame:
    rows = []
    for held_ex in sorted(df["exercise_canonical_id"].unique()):
        for held_p in sorted(df["participant_group_id"].unique()):
            test = df[(df["exercise_canonical_id"] == held_ex) & (df["participant_group_id"] == held_p)]
            if len(test) == 0:
                continue
            if not use_correction:
                pred = test["predicted_kcal_min"].to_numpy()
            else:
                train = df[(df["exercise_canonical_id"] != held_ex) & (df["participant_group_id"] != held_p)]
                enc = OneHotEncoder(handle_unknown="ignore", sparse_output=False)
                Xtr = enc.fit_transform(train[feature_cols].astype(str))
                Xte = enc.transform(test[feature_cols].astype(str))
                model = Ridge(alpha=RIDGE_ALPHA).fit(Xtr, train["residual"].to_numpy())
                pred = test["predicted_kcal_min"].to_numpy() + model.predict(Xte)
            pred = np.maximum(pred, 0.1)  # same non-negative floor the deployed model applies
            measured = test["measured_kcal_min"].to_numpy()
            abs_err = np.abs(pred - measured)
            rows.append({"exercise": held_ex, "participant": held_p, "n": len(test),
                          "mae": abs_err.mean(), "mape": (abs_err / measured * 100).mean()})
    return pd.DataFrame(rows)


def summarise(res):
    return {"MAE": round(float(np.average(res["mae"], weights=res["n"])), 3),
            "MAPE": round(float(np.average(res["mape"], weights=res["n"])), 2)}


def main():
    df = build_feature_frame()
    df["body_region"] = df["muscle_group"].map(BODY_REGION)
    assert df["body_region"].notna().all(), "unmapped muscle group"

    print("=" * 80)
    print("EXPERIMENT: estimating an exercise the model has NEVER seen")
    print("Nested leave-one-exercise-out x leave-one-participant-out, Ridge(alpha=1.0)")
    print(f"{df['exercise_canonical_id'].nunique()} exercises, "
          f"{df['participant_group_id'].nunique()} participants, {len(df)} rows")
    print("=" * 80)
    print()

    approaches = {
        "A. BASELINE_ONLY   (what V1 does today for unknown exercises)": (None, False),
        "B. COARSE_CATEGORY (upper/lower + compound/isolation + tier)": (COARSE_FEATURES, True),
        "C. COARSE+PATTERN  (adds movement_pattern)": (COARSE_PLUS_PATTERN, True),
        "D. EXERCISE_KNOWN  (upper bound - impossible for a new exercise)": (EXERCISE_KNOWN_FEATURES, True),
    }

    results, per_exercise = {}, {}
    for label, (cols, use_corr) in approaches.items():
        res = run(df, cols, use_corr)
        results[label] = summarise(res)
        per_exercise[label] = res.groupby("exercise").apply(
            lambda g: np.average(g["mape"], weights=g["n"]), include_groups=False).round(1)

    print(f"{'approach':<64}{'MAE':<9}{'MAPE'}")
    print("-" * 80)
    for label, m in results.items():
        print(f"{label:<64}{m['MAE']:<9}{m['MAPE']}%")

    print()
    print("PER-EXERCISE MAPE when that exercise is held out entirely:")
    print()
    comp = pd.DataFrame(per_exercise)
    comp.columns = ["A_baseline", "B_coarse", "C_coarse_pat", "D_known"]
    comp["best_for_unseen"] = comp[["A_baseline", "B_coarse", "C_coarse_pat"]].idxmin(axis=1)
    print(comp.to_string())

    a = results["A. BASELINE_ONLY   (what V1 does today for unknown exercises)"]["MAPE"]
    b = results["B. COARSE_CATEGORY (upper/lower + compound/isolation + tier)"]["MAPE"]
    c = results["C. COARSE+PATTERN  (adds movement_pattern)"]["MAPE"]
    d = results["D. EXERCISE_KNOWN  (upper bound - impossible for a new exercise)"]["MAPE"]

    print()
    print("=" * 80)
    print(f"Current fallback (baseline-only):        {a}%")
    print(f"Best coarse-category approach:           {min(b, c)}%")
    print(f"Fully-trained exercise (V1's 8):         {d}%   <- for reference, not achievable for a new exercise")
    delta = a - min(b, c)
    verdict = "WORTH DOING" if delta > 2 else ("MARGINAL" if delta > 0 else "NOT WORTH DOING")
    print(f"\nImprovement over current fallback: {delta:+.1f} points  ->  {verdict}")
    n_better = int((comp["best_for_unseen"] != "A_baseline").sum())
    print(f"Coarse categories beat baseline-only on {n_better}/{len(comp)} held-out exercises")
    print("=" * 80)


if __name__ == "__main__":
    main()
