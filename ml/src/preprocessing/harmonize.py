"""
Combine reis2017 + reis2019 + brunelli2019 into one unified, tidy
observation table with full provenance preserved per row.

DEDUP LOGIC FOR THE REIS LAB (2017 + 2019 share a cohort — see
reis2017.py docstring for the numeric proof):
  * For (participant_group_id, exercise, intensity) combinations present
    in BOTH files as a directly-measured energy_cost_rate: reis2019's
    value is kept (directly reported), reis2017's group-mean-derived
    equivalent is DROPPED (flagged, not silently discarded — see the
    dropped-rows log written alongside the output).
  * reis2017's raw vo2_relative rows are always kept (reis2019 has no VO2
    column at all) — including the 80% 1RM condition, which reis2019
    never tested. This is the unique contribution of the 2017 file.
  * reis2019's heart_rate and predicted_energy_cost_from_hr rows are
    always kept (reis2017 has neither).
Net effect: no numeric value is double-counted, but no unique measurement
from either file is thrown away.

EDGE CASE (found by tests/test_pipeline.py, verified not a bug): 7 rows
below 80%1RM survive from reis2017 because reis2019 has no counterpart for
that exact participant/exercise/intensity cell (a dropped trial on their
side). Keeping reis2017's group-mean-derived value there is a legitimate
"no better source exists" fallback — all 7 are correctly flagged
is_group_mean_derived=True, never silently presented as directly measured.

OUTPUT: ml/data/processed/unified_observations_v0.csv
Every row keeps: dataset_id, participant_group_id (leakage-safe grouping
key), exercise_canonical_id + original label, condition/intensity,
metric_type/subtype, value + unit, and measurement-provenance flags.
Nothing is imputed, fabricated, or silently unit-converted here.
"""
import sys
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SRC_DIR))

import pandas as pd  # noqa: E402
from ingestion import reis2017, reis2019, brunelli2019  # noqa: E402

OUT_DIR = Path(__file__).resolve().parents[2] / "data" / "processed"
DOCS_DIR = Path(__file__).resolve().parents[2] / "docs"


def build_unified() -> tuple[pd.DataFrame, pd.DataFrame]:
    df17 = reis2017.load()
    df19 = reis2019.load()
    dfb = brunelli2019.load()

    # ---- dedup: drop reis2017's group-mean-derived energy_cost_rate rows
    # wherever reis2019 has a directly-measured equivalent for the same
    # (participant_group_id, exercise, intensity) ----
    key_cols = ["participant_group_id", "exercise_canonical_id", "intensity_value"]
    reis19_ec_keys = set(
        map(tuple, df19.loc[df19["metric_type"] == "energy_cost_rate", key_cols].values)
    )

    is_derived_dup = (
        (df17["metric_type"] == "energy_cost_rate")
        & df17[key_cols].apply(tuple, axis=1).isin(reis19_ec_keys)
    )
    dropped = df17[is_derived_dup].copy()
    dropped["drop_reason"] = "superseded by reis2019 directly-measured EC for same participant/exercise/intensity"
    df17_kept = df17[~is_derived_dup].copy()

    unified = pd.concat([df17_kept, df19, dfb], ignore_index=True)
    unified.insert(0, "observation_id", [f"obs_{i:06d}" for i in range(len(unified))])

    return unified, dropped


def write_report(unified: pd.DataFrame, dropped: pd.DataFrame) -> str:
    lines = []
    lines.append("UNIFIED DATASET — build report (auto-generated, real counts, not estimated)")
    lines.append("=" * 70)
    lines.append(f"Total observation rows: {len(unified)}")
    lines.append(f"Rows dropped as Reis-lab duplicates (2017 vs 2019): {len(dropped)}")
    lines.append("")
    lines.append("-- by dataset_id --")
    lines.append(unified["dataset_id"].value_counts().to_string())
    lines.append("")
    lines.append("-- unique participant_group_id count by dataset_id --")
    lines.append(unified.groupby("dataset_id")["participant_group_id"].nunique().to_string())
    lines.append("")
    lines.append("-- unique participant_group_id count OVERALL (leakage-safe grouping key) --")
    lines.append(str(unified["participant_group_id"].nunique()))
    lines.append("")
    lines.append("-- by exercise_canonical_id --")
    lines.append(unified["exercise_canonical_id"].value_counts().to_string())
    lines.append("")
    lines.append("-- by metric_type --")
    lines.append(unified["metric_type"].value_counts().to_string())
    lines.append("")
    lines.append("-- missingness by column --")
    lines.append(unified.isna().mean().round(3).to_string())
    lines.append("")
    lines.append("-- directly measured vs derived --")
    lines.append(unified["is_directly_measured"].value_counts().to_string())
    return "\n".join(lines)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    DOCS_DIR.mkdir(parents=True, exist_ok=True)

    unified, dropped = build_unified()

    unified_path = OUT_DIR / "unified_observations_v0.csv"
    dropped_path = OUT_DIR / "reis2017_dropped_duplicate_rows.csv"
    report_path = DOCS_DIR / "_build_report_v0.txt"

    unified.to_csv(unified_path, index=False)
    dropped.to_csv(dropped_path, index=False)

    report = write_report(unified, dropped)
    report_path.write_text(report, encoding="utf-8")

    print(report)
    print()
    print(f"Wrote {len(unified)} rows -> {unified_path}")
    print(f"Wrote {len(dropped)} dropped-duplicate rows -> {dropped_path}")
    print(f"Wrote build report -> {report_path}")


if __name__ == "__main__":
    main()
