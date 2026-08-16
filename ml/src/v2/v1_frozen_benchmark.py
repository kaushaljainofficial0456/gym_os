"""
PHASE F of the V2 master prompt — run the FROZEN V1 model against the V2
canonical dataset. V1 is never retrained here — this script only READS
model_v1.json (the shipped artifact) and applies its formula, exactly the
way mlEstimate.reference.js does at inference time. If this script ever
writes to ml/models/skos-cal-v1/, that's a bug — it doesn't, by design
(no write path to that directory exists anywhere below).

CAVEAT, disclosed not hidden: v1_prediction needs body_weight_kg. The
canonical dataset has no INDIVIDUAL body weight anywhere (V1's own known
gap, Section 13 of the master prompt). To compute v1_prediction at all,
this substitutes each study's cohort-mean weight — the exact same
substitution V1's own training/eval scripts already made
(deployed_baseline_benchmark.py's COHORT_MEAN_WEIGHT_KG). Not a new
assumption; carrying forward the one V1 already used, so this benchmark
is apples-to-apples with V1's own published numbers.
"""
from pathlib import Path
import sys
import json

SRC_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SRC_DIR))

import pandas as pd  # noqa: E402

DATA_PATH = Path(__file__).resolve().parents[2] / "data" / "processed" / "v2_training_dataset.csv"
MODEL_V1_PATH = Path(__file__).resolve().parents[2] / "models" / "skos-cal-v1" / "model_v1.json"
OUT_PATH = Path(__file__).resolve().parents[2] / "data" / "processed" / "v2_with_v1_predictions.csv"


def v1_predict_rate(model: dict, exercise_id: str, tier: str, body_weight_kg: float) -> tuple[float, bool]:
    """Reimplements mlEstimate's core rate calculation for a SINGLE known
    exercise (no multi-exercise blending needed here — V2's rows are all
    single-exercise research bouts, same as V1's own training regime).
    Returns (active_rate_kcal_min, was_capped)."""
    met = model["baseline"]["met_by_tier"][tier]
    baseline_rate = met * 3.5 * body_weight_kg / 200

    corr_table = model["correction_kcal_per_min_by_exercise_and_tier"]
    if exercise_id in corr_table:
        correction = corr_table[exercise_id][tier]
    else:
        correction = 0.0  # unmapped exercise -> baseline only, matches V1's own documented fallback

    raw_active = max(0.0, baseline_rate + correction)
    cap = model.get("plausibility_guardrails", {}).get("max_active_rate_kcal_min")
    if cap is not None and raw_active > cap:
        return cap, True
    return raw_active, False


def main():
    model = json.loads(MODEL_V1_PATH.read_text(encoding="utf-8"))
    df = pd.read_csv(DATA_PATH)

    df["v1_prediction_kcal_min"] = None
    df["v1_prediction_capped"] = False
    df["v1_body_weight_source"] = None

    rate_mask = df["data_role"] == "primary_training_target"
    for idx, row in df[rate_mask].iterrows():
        bw = row["body_weight_kg"] if pd.notna(row["body_weight_kg"]) else row["body_weight_cohort_mean_kg"]
        bw_source = "individual" if pd.notna(row["body_weight_kg"]) else "cohort_mean_substitution"
        tier = row["intensity_tier"]
        if pd.isna(tier) or pd.isna(bw):
            continue
        pred, capped = v1_predict_rate(model, row["exercise_id"], tier, bw)
        df.at[idx, "v1_prediction_kcal_min"] = pred
        df.at[idx, "v1_prediction_capped"] = capped
        df.at[idx, "v1_body_weight_source"] = bw_source

    # Section 11: residual target, ONLY for rows with a real measured_kcal_min
    # and a valid v1_prediction. Brunelli's confirmatory rows are excluded
    # here (incompatible unit — same reasoning V1 itself used).
    df["v1_residual"] = None
    valid = rate_mask & df["v1_prediction_kcal_min"].notna() & df["measured_kcal_min"].notna()
    df.loc[valid, "v1_residual"] = df.loc[valid, "measured_kcal_min"] - df.loc[valid, "v1_prediction_kcal_min"]

    df.to_csv(OUT_PATH, index=False)

    n_scored = valid.sum()
    print(f"Wrote {OUT_PATH}")
    print(f"Rows with a v1_prediction + residual computed: {n_scored} / {rate_mask.sum()} rate rows")
    print(f"Rows capped by the plausibility guardrail: {int(df['v1_prediction_capped'].sum())}")
    print(f"Body weight source used: {df.loc[valid, 'v1_body_weight_source'].value_counts().to_dict()}")
    print()
    print("Sanity check — recomputed V1-vs-measured MAPE on this run (should match VALIDATION_REPORT.md's documented in-sample-equivalent numbers, since V1 IS THE SAME MODEL applied to THE SAME data):")
    sub = df.loc[valid]
    mape = (sub["v1_residual"].abs() / sub["measured_kcal_min"] * 100).mean()
    print(f"  MAPE (V1 point prediction vs measured, this canonical dataset): {mape:.1f}%")
    print("  NOTE: this is NOT out-of-sample (no LOPO here — V1's coefficients were already fit including these participants). "
          "It reproduces V1's TRAINING-FIT error, not its validated 19.1% LOPO number. Reported as a pipeline-consistency "
          "check, not a new accuracy claim.")


if __name__ == "__main__":
    main()
