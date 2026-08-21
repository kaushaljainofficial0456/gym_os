"""
Benchmark the ALREADY-DEPLOYED backend baseline formula
(backend/src/services/intelligence/calorieModel.js: baselineEstimate())
against the real measured research data in hand.

Deployed formula (rate form — duration cancels out, so this works even
for short/variable-duration bouts):
    predicted_kcal_per_min = MET[intensity_rating] * 3.5 * body_weight_kg / 200
    MET = {light: 3.0, moderate: 4.5, hard: 6.0}

WHY THE RATE FORM: the deployed formula's kcal/min form doesn't depend on
duration, so it can be compared directly against reis2017/reis2019's rate
measurements (kcal/min) without needing per-observation duration data —
which for a 26-56s max-effort bout wouldn't be a fair "steady-state rate"
comparison anyway.

INTENSITY MAPPING (documented approximation — the production formula keys
off intensity_rating derived from avg RIR, which this research data does
not have): %1RM -> {12,16 -> light, 20,24 -> moderate, 80 -> hard}. This
is a reasonable but NOT validated mapping — flagged, not hidden.

BODY WEIGHT: uses the SAME cohort-mean weight (78.67 kg) the source files
themselves used, deliberately — this isolates the MET-tier assumption as
the thing being tested, rather than conflating it with body-weight
resolution error.

SCOPE: reis2017 + reis2019 only (both have clean rate measurements).
brunelli2019 is excluded from this specific benchmark — its energy values
are absolute kcal over a to-failure protocol with no clean duration figure
to convert cleanly to a rate; testing the baseline against it would
require fabricating a duration, which this pipeline does not do.
"""
from pathlib import Path
import pandas as pd

DATA_PATH = Path(__file__).resolve().parents[2] / "data" / "processed" / "unified_observations_v0.csv"
DOCS_DIR = Path(__file__).resolve().parents[2] / "docs"

MET = {"light": 3.0, "moderate": 4.5, "hard": 6.0}
INTENSITY_MAP = {12: "light", 16: "light", 20: "moderate", 24: "moderate", 80: "hard"}
COHORT_MEAN_WEIGHT_KG = 78.67  # same value the reis-lab files themselves used


def predicted_rate(intensity_pct: int, body_weight_kg: float) -> float:
    tier = INTENSITY_MAP[intensity_pct]
    met = MET[tier]
    return met * 3.5 * body_weight_kg / 200


def build_eval_frame() -> pd.DataFrame:
    df = pd.read_csv(DATA_PATH)
    df = df[df["dataset_id"].isin(["reis2017", "reis2019"])]

    # Preferred measured rate per row:
    #  - reis2019 energy_cost_rate: directly measured, always preferred
    #  - reis2017 vo2_relative: converted via the SAME cohort-mean-weight
    #    method the source file used (ml/kg/min * kg / 1000 * 5 kcal/L O2),
    #    computed here explicitly rather than trusting the file's own
    #    blue-block cells (keeps the derivation auditable in this repo)
    rows = []
    for _, r in df.iterrows():
        if r["metric_type"] == "energy_cost_rate" and r["dataset_id"] == "reis2019":
            measured = r["value"]
            measured_source = "reis2019_directly_measured"
        elif r["metric_type"] == "vo2_relative" and r["dataset_id"] == "reis2017":
            measured = r["value"] * COHORT_MEAN_WEIGHT_KG / 1000 * 5.0
            measured_source = "reis2017_vo2_converted_cohort_mean_weight"
        else:
            continue
        intensity = int(r["intensity_value"])
        if intensity not in INTENSITY_MAP:
            continue
        pred = predicted_rate(intensity, COHORT_MEAN_WEIGHT_KG)
        rows.append({
            "dataset_id": r["dataset_id"],
            "participant_group_id": r["participant_group_id"],
            "exercise_canonical_id": r["exercise_canonical_id"],
            "intensity_pct_1rm": intensity,
            "mapped_intensity_rating": INTENSITY_MAP[intensity],
            "measured_kcal_min": measured,
            "measured_source": measured_source,
            "predicted_kcal_min": pred,
            "error": pred - measured,
            "abs_error": abs(pred - measured),
            "pct_error": abs(pred - measured) / measured * 100 if measured else None,
        })
    return pd.DataFrame(rows)


def main():
    ev = build_eval_frame()
    ev.to_csv(DOCS_DIR.parent / "data" / "processed" / "deployed_baseline_eval_v0.csv", index=False)

    lines = []
    lines.append("DEPLOYED BASELINE FORMULA — evaluation against measured research data")
    lines.append("=" * 72)
    lines.append(f"Formula: MET x 3.5 x body_weight_kg / 200  (rate form, kcal/min)")
    lines.append(f"Rows evaluated: {len(ev)}  (reis2017 + reis2019 only, see script docstring for why)")
    lines.append("")
    lines.append("-- OVERALL --")
    lines.append(f"MAE (kcal/min):  {ev['abs_error'].mean():.2f}")
    lines.append(f"MAPE:            {ev['pct_error'].mean():.1f}%")
    lines.append(f"Bias (pred-measured, mean signed error): {ev['error'].mean():+.2f} kcal/min")
    lines.append("")
    lines.append("-- BY MAPPED INTENSITY TIER --")
    g = ev.groupby("mapped_intensity_rating").agg(
        n=("abs_error", "size"),
        mae=("abs_error", "mean"),
        mape=("pct_error", "mean"),
        bias=("error", "mean"),
        mean_measured=("measured_kcal_min", "mean"),
        mean_predicted=("predicted_kcal_min", "mean"),
    ).round(2)
    lines.append(g.to_string())
    lines.append("")
    lines.append("-- BY EXERCISE --")
    g2 = ev.groupby("exercise_canonical_id").agg(
        n=("abs_error", "size"),
        mae=("abs_error", "mean"),
        mape=("pct_error", "mean"),
        bias=("error", "mean"),
    ).round(2).sort_values("mape")
    lines.append(g2.to_string())

    report = "\n".join(lines)
    print(report)
    out_path = DOCS_DIR / "_deployed_baseline_eval_report_v0.txt"
    out_path.write_text(report, encoding="utf-8")
    print(f"\nWrote {out_path}")


if __name__ == "__main__":
    main()
