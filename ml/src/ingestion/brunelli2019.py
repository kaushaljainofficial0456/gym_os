"""
Ingest Brunelli et al. 2019, PLOS ONE (DOI 10.1371/journal.pone.0224801) —
"Acute low- compared to high-load resistance training to failure results in
greater energy expenditure during exercise in healthy young men". CC BY 4.0.
Source: ml/data/external/brunelli2019_pone.0224801.s001.xlsx

RAW SCHEMA: single sheet ("Plan1"), one row per participant (n=8, matching
the paper's completed-sample size), wide columns for 3 conditions
(control / 30% / 80% 1RM) x 2 measure families:
  * lactate_<condition>_<timepoint>   timepoint in {pre,3,5,7,60} minutes,
    unit mmol/L (blood lactate) — captured as a contextual/energy-system
    feature, not the primary target.
  * ee_<condition>_<component>        component in
    {rest, aerobic, anaerobic_lactic, anaerobic_alactic, exercise, epoc, total}
    unit kcal (absolute, over the ~3-sets-to-failure bout + measurement
    window — NOT a rate). Cross-validated against the paper's abstract:
    ee_control_epoc mean here (~75 kcal) matches the reported
    "75.8 +/- 7.6 Kcal" control EPOC almost exactly, confirming units/scale.

'exercise' component = active energy expenditure during the set(s) only.
'total' = exercise + epoc. These are DIFFERENT target definitions and are
kept as separate metric_subtype rows — never summed/averaged together,
per the active-vs-total-energy distinction.

Single exercise only: leg extension machine (LEG_EXTENSION).
"""
from pathlib import Path
import pandas as pd

from ontology.exercise_map import to_canonical

RAW_PATH = Path(__file__).resolve().parents[2] / "data" / "external" / "brunelli2019_pone.0224801.s001.xlsx"

CONDITIONS = {"control": None, "30%": 30, "80%": 80}
LACTATE_TIMEPOINTS = ["pre", "3", "5", "7", "60"]
EE_COMPONENTS = ["rest", "aerobic", "anaerobic_lactic", "anaerobic_alactic", "exercise", "epoc", "total"]

EXERCISE_LABEL = "leg extension"  # single exercise used throughout the study


def load() -> pd.DataFrame:
    df = pd.read_excel(RAW_PATH, sheet_name="Plan1")
    df = df.rename(columns={df.columns[0]: "participant"})
    # Trailing rows in the sheet are chart-helper labels ("EPOC_graph",
    # "Control", "RT30", "RT80"), not participants — keep only numeric ids.
    # 11 numeric rows survive, matching the paper's reported final n=11
    # (13 recruited, 2 dropped).
    df["participant"] = pd.to_numeric(df["participant"], errors="coerce")
    df = df.dropna(subset=["participant"])
    canonical = to_canonical(EXERCISE_LABEL)

    out = []
    for _, row in df.iterrows():
        pid = int(row["participant"])
        group_id = f"brunelli2019_p{pid}"

        for cond_label, pct in CONDITIONS.items():
            for tp in LACTATE_TIMEPOINTS:
                col = f"lactate_{cond_label.replace('%', '%')}_{tp}" if cond_label != "control" else f"lactate_control_{tp}"
                if cond_label != "control":
                    col = f"lactate_{cond_label}_{tp}"
                val = row.get(col)
                if pd.notna(val):
                    out.append({
                        "dataset_id": "brunelli2019",
                        "participant_group_id": group_id,
                        "local_participant_id": pid,
                        "exercise_canonical_id": canonical,
                        "exercise_original_label": EXERCISE_LABEL,
                        "condition_type": "load_condition_to_failure",
                        "intensity_value": pct,
                        "metric_type": "blood_lactate",
                        "metric_subtype": f"timepoint_min_{tp}",
                        "value": float(val),
                        "unit": "mmol_l",
                        "is_directly_measured": True,
                        "is_group_mean_derived": False,
                        "source_sheet": "Plan1",
                        "notes": None,
                    })
            for comp in EE_COMPONENTS:
                col = f"ee_{cond_label}_{comp}"
                val = row.get(col)
                if pd.notna(val):
                    out.append({
                        "dataset_id": "brunelli2019",
                        "participant_group_id": group_id,
                        "local_participant_id": pid,
                        "exercise_canonical_id": canonical,
                        "exercise_original_label": EXERCISE_LABEL,
                        "condition_type": "load_condition_to_failure",
                        "intensity_value": pct,
                        "metric_type": "energy_expenditure_absolute",
                        "metric_subtype": comp,  # rest|aerobic|anaerobic_lactic|anaerobic_alactic|exercise|epoc|total
                        "value": float(val),
                        "unit": "kcal",
                        "is_directly_measured": comp not in ("total",),  # total is a sum, not a direct measure
                        "is_group_mean_derived": False,
                        "source_sheet": "Plan1",
                        "notes": "3 sets to failure, 1.5min rest between sets — NOT a fixed-duration steady-state bout like the Reis studies.",
                    })
    return pd.DataFrame(out)


if __name__ == "__main__":
    df = load()
    print(df.shape)
    print(df["metric_type"].value_counts())
    print(df["metric_subtype"].value_counts())
