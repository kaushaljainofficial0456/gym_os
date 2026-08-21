"""
EXPLORATORY correction-model comparison — Phase 5 first pass.

Labeled exploratory deliberately: n=25 participants total, and this script
only uses the 14-person reis-lab subset (the only rows with a clean, unit-
consistent kcal/min RATE target — see deployed_baseline_benchmark.py for
why brunelli2019 is excluded from rate-based comparisons). Nothing here is
a production candidate; it's the first honest read on whether ANY
correction beats the deployed baseline, per Section 8/35's rule: don't
assume ML (or even a simple correction) is better — test it.

VALIDATION: Leave-One-Participant-Out (LOPO), 14 folds. This is the
correct choice at this sample size — a single held-out split would waste
too much of an already-small dataset, and LOPO still never lets a
participant's rows appear in both train and test within a fold.

THE FEATURE-AVAILABILITY GAP (the real finding of this script): this
research data's intensity signal is %1RM. Production's calorie contract
has NO %1RM field — it has `relative_load` (avg load_kg / body_weight_kg),
a DIFFERENT quantity, and this data doesn't include absolute load in kg or
1RM in kg, only %1RM, so relative_load cannot even be back-derived. The
only intensity signal genuinely shared with production is the coarse
3-tier `intensity_rating` (light/moderate/hard) this pipeline maps %1RM
into (see deployed_baseline_benchmark.py). So two variants are compared:

  Variant A ("research-best"): exercise attributes + raw %1RM.
      Upper bound on what this data can teach us. NOT deployable —
      production never has %1RM.
  Variant B ("deployment-realistic"): exercise attributes + the coarse
      intensity_rating tier only — no %1RM. This is what a production
      model could actually consume today.

The gap between A and B's performance is a concrete, evidence-based
recommendation for Kaushal: whether an %1RM-like or relative_load feature
is worth adding to a future calorie-contract schema version.
"""
from pathlib import Path
import sys

SRC_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SRC_DIR))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from sklearn.linear_model import LinearRegression  # noqa: E402
from sklearn.ensemble import RandomForestRegressor  # noqa: E402
from sklearn.model_selection import LeaveOneGroupOut  # noqa: E402
from sklearn.preprocessing import OneHotEncoder  # noqa: E402

from ontology.exercise_map import get_attributes  # noqa: E402
from baseline.deployed_baseline_benchmark import build_eval_frame  # noqa: E402

DOCS_DIR = Path(__file__).resolve().parents[2] / "docs"
OUT_DIR = Path(__file__).resolve().parents[2] / "data" / "processed"


def build_feature_frame() -> pd.DataFrame:
    ev = build_eval_frame()  # dataset_id, participant_group_id, exercise_canonical_id,
                              # intensity_pct_1rm, mapped_intensity_rating, measured_kcal_min,
                              # predicted_kcal_min (deployed baseline), error, ...
    attrs = ev["exercise_canonical_id"].apply(get_attributes).apply(pd.Series)
    df = pd.concat([ev.reset_index(drop=True), attrs.reset_index(drop=True)], axis=1)
    df["residual"] = df["measured_kcal_min"] - df["predicted_kcal_min"]  # ML CORRECTION TARGET (Section 8)
    return df


def _design_matrix(df: pd.DataFrame, variant: str, encoder: OneHotEncoder, fit: bool):
    cat_cols = ["exercise_canonical_id", "muscle_group", "compound_or_isolation"]
    if variant == "A_research_best":
        cat_cols = cat_cols + ["mapped_intensity_rating"]
        num = df[["intensity_pct_1rm"]].to_numpy(dtype=float)
    elif variant == "B_deployment_realistic":
        cat_cols = cat_cols + ["mapped_intensity_rating"]
        num = np.empty((len(df), 0))
    else:
        raise ValueError(variant)

    cats = df[cat_cols].astype(str)
    if fit:
        cat_arr = encoder.fit_transform(cats)
    else:
        cat_arr = encoder.transform(cats)
    return np.hstack([cat_arr, num]) if num.shape[1] else cat_arr


def lopo_eval(df: pd.DataFrame, variant: str, model_name: str):
    """Leave-One-Participant-Out. Returns per-fold + aggregate errors for:
       MODEL A: baseline alone
       MODEL C: baseline + per-exercise mean-residual correction (learned on train folds only)
       MODEL C2: baseline + linear regression on residual
       MODEL D: RandomForest direct correction (small, shallow — overfitting sanity check)
    """
    groups = df["participant_group_id"].to_numpy()
    logo = LeaveOneGroupOut()
    rows = []

    for train_idx, test_idx in logo.split(df, groups=groups):
        train, test = df.iloc[train_idx], df.iloc[test_idx]

        # --- Model A: baseline alone (no correction) ---
        pred_A = test["predicted_kcal_min"].to_numpy()

        # --- Model C: per-exercise mean-residual correction, learned on TRAIN folds only ---
        mean_resid_by_ex = train.groupby("exercise_canonical_id")["residual"].mean()
        overall_mean_resid = train["residual"].mean()  # fallback for an exercise unseen in train (shouldn't happen with LOPO here, but defensive)
        corr_C = test["exercise_canonical_id"].map(mean_resid_by_ex).fillna(overall_mean_resid).to_numpy()
        pred_C = pred_A + corr_C

        # --- Model C2: linear regression on residual ---
        enc = OneHotEncoder(handle_unknown="ignore", sparse_output=False)
        X_train = _design_matrix(train, variant, enc, fit=True)
        X_test = _design_matrix(test, variant, enc, fit=False)
        lr = LinearRegression().fit(X_train, train["residual"].to_numpy())
        pred_C2 = pred_A + lr.predict(X_test)

        # --- Model D: RandomForest DIRECT prediction of measured value (not baseline+correction) ---
        rf = RandomForestRegressor(n_estimators=200, max_depth=4, min_samples_leaf=5, random_state=0)
        rf.fit(X_train, train["measured_kcal_min"].to_numpy())
        pred_D = rf.predict(X_test)

        measured = test["measured_kcal_min"].to_numpy()
        held_out_participant = test["participant_group_id"].iloc[0]
        for name, pred in [("A_baseline", pred_A), ("C_mean_residual", pred_C),
                            ("C2_linear_residual", pred_C2), ("D_random_forest_direct", pred_D)]:
            abs_err = np.abs(pred - measured)
            rows.append({
                "held_out_participant": held_out_participant,
                "model": name,
                "n": len(test),
                "mae": abs_err.mean(),
                "mape": (abs_err / measured * 100).mean(),
                "bias": (pred - measured).mean(),
            })
    return pd.DataFrame(rows)


def main():
    df = build_feature_frame()
    df.to_csv(OUT_DIR / "exploratory_features_v0.csv", index=False)

    lines = []
    lines.append("EXPLORATORY MODEL COMPARISON — Leave-One-Participant-Out, reis-lab (n=14)")
    lines.append("=" * 78)
    lines.append(f"Rows: {len(df)}  |  Participants: {df['participant_group_id'].nunique()}  |  Exercises: {df['exercise_canonical_id'].nunique()}")
    lines.append("")

    for variant in ["A_research_best", "B_deployment_realistic"]:
        lines.append(f"### Feature variant: {variant} ###")
        res = lopo_eval(df, variant, variant)
        summary = res.groupby("model").apply(
            lambda g: pd.Series({
                "mean_MAE": np.average(g["mae"], weights=g["n"]),
                "mean_MAPE": np.average(g["mape"], weights=g["n"]),
                "mean_bias": np.average(g["bias"], weights=g["n"]),
            }), include_groups=False
        ).round(2)
        # order models logically
        order = ["A_baseline", "C_mean_residual", "C2_linear_residual", "D_random_forest_direct"]
        summary = summary.reindex(order)
        lines.append(summary.to_string())
        lines.append("")
        res.to_csv(OUT_DIR / f"exploratory_lopo_results_{variant}_v0.csv", index=False)

    report = "\n".join(lines)
    print(report)
    out_path = DOCS_DIR / "_exploratory_model_comparison_v0.txt"
    out_path.write_text(report, encoding="utf-8")
    print(f"\nWrote {out_path}")


if __name__ == "__main__":
    main()
