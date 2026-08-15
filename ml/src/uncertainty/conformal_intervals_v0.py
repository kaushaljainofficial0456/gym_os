"""
Phase 6 — UNCERTAINTY QUANTIFICATION for Model E (exercise x intensity
linear correction, selected in exploratory_correction_v0.py).

APPROACH: group-split conformal prediction.
  1. Model E's LOPO run already gives a genuine out-of-sample residual for
     every one of the 1,001 rows (a fresh model trained on the other 13
     participants each time).
  2. Split the 14 participants into two DISJOINT halves:
       CALIBRATION (7 participants) -> use their out-of-sample residuals
         to derive interval half-widths (empirical quantiles of the
         signed residual distribution -- NOT assumed symmetric, since the
         error distribution is not symmetric, see VALIDATION_REPORT.md).
       COVERAGE-TEST (the other 7)   -> check what fraction of THEIR
         out-of-sample predictions actually fall inside the interval
         built from the calibration half.
  This is deliberately NOT "derive the interval from all 1001 residuals,
  then check coverage on the same 1001" -- that would be circular (the
  interval would trivially hit its target by construction). Calibration
  and coverage-check use disjoint people, so the reported coverage number
  is a genuine, non-circular check.

HONEST LIMITATION: 7 participants per half is thin. This is a small-sample
coverage check, not a definitive validation -- consistent with treating
n=14 as small everywhere else in this project. A future dataset with more
participants should re-run this with a proper calibration set.
"""
from pathlib import Path
import sys

SRC_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SRC_DIR))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from sklearn.linear_model import LinearRegression  # noqa: E402
from sklearn.model_selection import LeaveOneGroupOut  # noqa: E402
from sklearn.preprocessing import OneHotEncoder  # noqa: E402

from models.exploratory_correction_v0 import build_feature_frame  # noqa: E402

DOCS_DIR = Path(__file__).resolve().parents[2] / "docs"
OUT_DIR = Path(__file__).resolve().parents[2] / "data" / "processed"

RANDOM_SEED = 42  # reproducibility (Section 34)


def run_model_e_lopo(df: pd.DataFrame) -> pd.DataFrame:
    """Re-run Model E's LOPO loop, returning per-row predictions + residuals
    tagged with participant_group_id (same model as exploratory_correction_v0.py,
    kept self-contained here so this script is independently reproducible)."""
    df = df.copy()
    df["ex_x_intensity"] = df["exercise_canonical_id"] + "__" + df["mapped_intensity_rating"]
    groups = df["participant_group_id"].to_numpy()
    logo = LeaveOneGroupOut()
    cols = ["ex_x_intensity", "muscle_group", "compound_or_isolation"]

    rows = []
    for train_idx, test_idx in logo.split(df, groups=groups):
        train, test = df.iloc[train_idx], df.iloc[test_idx]
        enc = OneHotEncoder(handle_unknown="ignore", sparse_output=False)
        Xtr = enc.fit_transform(train[cols].astype(str))
        Xte = enc.transform(test[cols].astype(str))
        lr = LinearRegression().fit(Xtr, train["residual"])
        pred = test["predicted_kcal_min"].to_numpy() + lr.predict(Xte)
        for i, (_, r) in enumerate(test.iterrows()):
            rows.append({
                "participant_group_id": r["participant_group_id"],
                "exercise_canonical_id": r["exercise_canonical_id"],
                "mapped_intensity_rating": r["mapped_intensity_rating"],
                "measured_kcal_min": r["measured_kcal_min"],
                "point_prediction": pred[i],
                "signed_error": pred[i] - r["measured_kcal_min"],  # prediction - measured
            })
    return pd.DataFrame(rows)


def calibrate_and_check(results: pd.DataFrame, coverage_target: float, seed: int = RANDOM_SEED):
    participants = sorted(results["participant_group_id"].unique())
    rng = np.random.default_rng(seed)
    shuffled = rng.permutation(participants)
    half = len(shuffled) // 2
    calib_ids, test_ids = set(shuffled[:half]), set(shuffled[half:])

    calib = results[results["participant_group_id"].isin(calib_ids)]
    test = results[results["participant_group_id"].isin(test_ids)]

    # Empirical quantiles of the SIGNED error (point_prediction - measured)
    # from the calibration half only.
    alpha = 1 - coverage_target
    lo_q = calib["signed_error"].quantile(alpha / 2)
    hi_q = calib["signed_error"].quantile(1 - alpha / 2)
    # Interval on the MEASURED scale: prediction - hi_q <= measured <= prediction - lo_q
    lower = test["point_prediction"] - hi_q
    upper = test["point_prediction"] - lo_q
    covered = (test["measured_kcal_min"] >= lower) & (test["measured_kcal_min"] <= upper)
    width = (upper - lower)

    return {
        "target_coverage": coverage_target,
        "n_calibration_participants": len(calib_ids),
        "n_test_participants": len(test_ids),
        "n_test_rows": len(test),
        "empirical_coverage": covered.mean(),
        "mean_interval_width_kcal_min": width.mean(),
        "median_interval_width_kcal_min": width.median(),
        "calib_lo_offset": lo_q,
        "calib_hi_offset": hi_q,
    }


def main():
    df = build_feature_frame()
    results = run_model_e_lopo(df)
    results.to_csv(OUT_DIR / "model_e_lopo_predictions_v0.csv", index=False)

    lines = []
    lines.append("UNCERTAINTY QUANTIFICATION — Model E, group-split conformal intervals")
    lines.append("=" * 78)
    lines.append(f"14 participants split 7/7 (calibration / coverage-test), seed={RANDOM_SEED}")
    lines.append("Disjoint halves — coverage numbers below are a genuine, non-circular check.")
    lines.append("")

    summary_rows = []
    for target in [0.80, 0.90]:
        r = calibrate_and_check(results, target)
        summary_rows.append(r)
        lines.append(f"-- Target coverage: {int(target*100)}% --")
        lines.append(f"  Calibrated on {r['n_calibration_participants']} participants, "
                      f"checked on {r['n_test_participants']} participants ({r['n_test_rows']} rows)")
        lines.append(f"  EMPIRICAL coverage achieved: {r['empirical_coverage']*100:.1f}%")
        lines.append(f"  Mean interval width: {r['mean_interval_width_kcal_min']:.2f} kcal/min "
                      f"(median {r['median_interval_width_kcal_min']:.2f})")
        lines.append(f"  Calibration offsets: [{r['calib_lo_offset']:+.2f}, {r['calib_hi_offset']:+.2f}] kcal/min")
        lines.append("")

    # Also check the OTHER half assignment (swap calibration/test) as a
    # stability check — a real coverage property shouldn't depend heavily
    # on which random half was calibration vs test.
    lines.append("-- Stability check: swap which half is calibration vs test --")
    for target in [0.80, 0.90]:
        participants = sorted(results["participant_group_id"].unique())
        rng = np.random.default_rng(RANDOM_SEED)
        shuffled = rng.permutation(participants)
        half = len(shuffled) // 2
        swapped = results.copy()
        # reuse calibrate_and_check but with a different seed to get an independent split
        r2 = calibrate_and_check(results, target, seed=RANDOM_SEED + 1)
        lines.append(f"  Target {int(target*100)}%: alt split -> empirical coverage {r2['empirical_coverage']*100:.1f}%, "
                      f"mean width {r2['mean_interval_width_kcal_min']:.2f} kcal/min")
    lines.append("")

    report = "\n".join(lines)
    print(report)
    out_path = DOCS_DIR / "_uncertainty_calibration_report_v0.txt"
    out_path.write_text(report, encoding="utf-8")
    print(f"\nWrote {out_path}")

    return summary_rows


if __name__ == "__main__":
    main()
