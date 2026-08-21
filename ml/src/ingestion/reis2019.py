"""
Ingest Reis et al. 2019, PLOS ONE (DOI 10.1371/journal.pone.0221284) —
"Are wearable heart rate measurements accurate to estimate aerobic energy
cost during low-intensity resistance exercise?". CC BY 4.0.
Source: ml/data/external/reis2019_pone.0221284.s001.xlsx

RAW SCHEMA: one sheet per exercise (8 sheets), each with columns:
  subject, EC 12%, HR 12%, EC 16%, HR 16%, EC 20%, HR 20%, EC 24%, HR 24%,
  Predicted EC at 24%
EC = directly reported energy cost, kcal/min (matches the paper's stated
units and magnitude — no unit ambiguity here, unlike reis2017). HR = heart
rate, bpm. "Predicted EC at 24%" is the paper's own HR-based regression
estimate for the 24% condition — captured as a separate metric_type for
reference/benchmarking, never mixed into the measured EC target.

LEAKAGE NOTE: local participant indices here (1..17ish) line up with
reis2017's — cross-checked numerically in reis2017.py's docstring. Both
files are assigned to the same participant_group_id namespace
("reis_lab_p{n}") in harmonize.py so no split ever separates them.
"""
from pathlib import Path
import pandas as pd

from ontology.exercise_map import to_canonical

RAW_PATH = Path(__file__).resolve().parents[2] / "data" / "external" / "reis2019_pone.0221284.s001.xlsx"

SHEETS = [
    "lat pull down", "bench press", "triceps", "biceps",
    "leg press", "leg extension", "inclined bench press", "half squat",
]
INTENSITIES = [12, 16, 20, 24]


def load() -> pd.DataFrame:
    out = []
    for sheet_name in SHEETS:
        df = pd.read_excel(RAW_PATH, sheet_name=sheet_name)
        df = df.dropna(subset=["subject"])
        canonical = to_canonical(sheet_name)

        for _, row in df.iterrows():
            pid = int(row["subject"])
            for pct in INTENSITIES:
                ec_col, hr_col = f"EC {pct}%", f"HR {pct}%"
                ec_val = row.get(ec_col)
                hr_val = row.get(hr_col)
                if pd.notna(ec_val):
                    out.append({
                        "dataset_id": "reis2019",
                        "participant_group_id": f"reis_lab_p{pid}",
                        "local_participant_id": pid,
                        "exercise_canonical_id": canonical,
                        "exercise_original_label": sheet_name,
                        "condition_type": "pct_1rm",
                        "intensity_value": pct,
                        "metric_type": "energy_cost_rate",
                        "metric_subtype": None,
                        "value": float(ec_val),
                        "unit": "kcal_min",
                        "is_directly_measured": True,
                        "is_group_mean_derived": False,
                        "source_sheet": sheet_name,
                        "notes": "Directly reported EC — preferred over reis2017's group-mean-derived blue block for the same participant/exercise/intensity.",
                    })
                if pd.notna(hr_val):
                    out.append({
                        "dataset_id": "reis2019",
                        "participant_group_id": f"reis_lab_p{pid}",
                        "local_participant_id": pid,
                        "exercise_canonical_id": canonical,
                        "exercise_original_label": sheet_name,
                        "condition_type": "pct_1rm",
                        "intensity_value": pct,
                        "metric_type": "heart_rate",
                        "metric_subtype": None,
                        "value": float(hr_val),
                        "unit": "bpm",
                        "is_directly_measured": True,
                        "is_group_mean_derived": False,
                        "source_sheet": sheet_name,
                        "notes": None,
                    })
            pred = row.get("Predicted EC at 24%")
            if pd.notna(pred):
                out.append({
                    "dataset_id": "reis2019",
                    "participant_group_id": f"reis_lab_p{pid}",
                    "local_participant_id": pid,
                    "exercise_canonical_id": canonical,
                    "exercise_original_label": sheet_name,
                    "condition_type": "pct_1rm",
                    "intensity_value": 24,
                    "metric_type": "predicted_energy_cost_from_hr",
                    "metric_subtype": None,
                    "value": float(pred),
                    "unit": "kcal_min",
                    "is_directly_measured": False,
                    "is_group_mean_derived": False,
                    "source_sheet": sheet_name,
                    "notes": "Study's own HR-based regression prediction — reference/benchmark only, never a training target.",
                })
    return pd.DataFrame(out)


if __name__ == "__main__":
    df = load()
    print(df.shape)
    print(df["metric_type"].value_counts())
    print(df["exercise_canonical_id"].value_counts())
