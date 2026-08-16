"""
PHASE B/D of the V2 master prompt — build the canonical V2 dataset from
CURRENTLY AVAILABLE legitimate data only.

IMPORTANT, stated plainly: as of this run, "currently available" means
the SAME reis2017 + reis2019 + brunelli2019 data already used for V1.
Rustaden 2020 and Joao 2021's participant-level data are not yet in hand
(request/confirmation pending); Benito 2016's individual data is
permanently unavailable (Spanish law). No new independent participant
enters this file by this script — see V2_DATA_ACQUISITION_REPORT.md for
why, and V2_VALIDATION_REPORT.md for what that means for training.

This script's purpose right now is INFRASTRUCTURE, not new data: prove
the V2 canonical-schema pipeline works end-to-end against real data,
ready to ingest Rustaden/Joao/future data the moment it's actually
acquired, without needing to redesign the schema at that point.
"""
from pathlib import Path
import sys

SRC_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SRC_DIR))

import pandas as pd  # noqa: E402
from ontology.exercise_map import get_attributes  # noqa: E402
from baseline.deployed_baseline_benchmark import build_eval_frame, INTENSITY_MAP  # noqa: E402
from v2.schema import ALL_FIELDS, PROVENANCE_FIELDS, validate_row_provenance  # noqa: E402

OUT_PATH = Path(__file__).resolve().parents[2] / "data" / "processed" / "v2_training_dataset.csv"
UNIFIED_PATH = Path(__file__).resolve().parents[2] / "data" / "processed" / "unified_observations_v0.csv"

# Provenance facts — established and verified in DATA_PROVENANCE.md, not
# invented here. Referenced, not re-derived, to avoid two sources of truth.
STUDY_PROVENANCE = {
    "reis2017": {
        "measurement_method": "indirect_calorimetry_breath_by_breath",
        "measurement_device": "COSMED K4b2",
        "license": "CC BY 4.0",
        "source": "https://doi.org/10.1371/journal.pone.0181311",
        "original_paper": "Reis VM, Garrido ND, Vianna J, Sousa AC, Alves JV, Marques MC (2017), PLOS ONE",
        "data_quality_tier": "GOLD",
        "sex": "male",
        "age_cohort_mean": 27.5,
        "body_weight_cohort_mean_kg": 78.67,
        "training_status": "mixed",  # per DATA_AUDIT.md: "trained or newly-sedentary"
    },
    "reis2019": {
        "measurement_method": "indirect_calorimetry_breath_by_breath",
        "measurement_device": "COSMED K4b2",
        "license": "CC BY 4.0",
        "source": "https://doi.org/10.1371/journal.pone.0221284",
        "original_paper": "Reis VM, Vianna JM, Barbosa TM, Garrido N, Vilaca Alves J, Carneiro AL, Aidar FJ, Novaes J (2019), PLOS ONE",
        "data_quality_tier": "GOLD",
        "sex": "male",
        "age_cohort_mean": 27.5,
        "body_weight_cohort_mean_kg": 78.67,
        "training_status": "mixed",
    },
    "brunelli2019": {
        "measurement_method": "indirect_calorimetry_breath_by_breath",
        "measurement_device": "Oxycon (portable gas analyzer)",
        "license": "CC BY 4.0",
        "source": "https://doi.org/10.1371/journal.pone.0224801",
        "original_paper": "Brunelli DT, Finardi EAR, Bonfante ILP, Gaspari AF, Sardeli AV, Souza TMF, Chacon-Mikahil MP, Cavaglieri CR (2019), PLOS ONE",
        "data_quality_tier": "GOLD",
        "sex": "male",
        "age_cohort_mean": 22.0,
        "body_weight_cohort_mean_kg": 71.8,
        "training_status": "untrained",  # 12 months no RT prior to study
    },
}


def build_rate_rows() -> pd.DataFrame:
    """reis2017 + reis2019 rate-form rows (kcal/min) — the ONLY rows V1
    itself was trained/evaluated on. Reuses build_eval_frame() rather than
    re-deriving the yellow/blue-block logic a second time."""
    ev = build_eval_frame()
    rows = []
    for _, r in ev.iterrows():
        prov = STUDY_PROVENANCE[r["dataset_id"]]
        attrs = get_attributes(r["exercise_canonical_id"])
        rows.append({
            "study_id": r["dataset_id"],
            "dataset_id": r["dataset_id"],
            "participant_id": r["participant_group_id"],
            "measurement_method": prov["measurement_method"],
            "measurement_device": prov["measurement_device"],
            "license": prov["license"],
            "source": prov["source"],
            "original_paper": prov["original_paper"],
            "data_quality_tier": prov["data_quality_tier"],
            "sex": prov["sex"],
            "age": None,
            "age_cohort_mean": prov["age_cohort_mean"],
            "body_weight_kg": None,  # NOT available individually — this is the exact V1 gap, carried forward honestly, not patched
            "body_weight_cohort_mean_kg": prov["body_weight_cohort_mean_kg"],
            "height_cm": None,
            "training_status": prov["training_status"],
            "exercise_id": r["exercise_canonical_id"],
            "exercise_type": attrs.get("movement_pattern"),
            "muscle_group": attrs.get("muscle_group"),
            "compound_or_isolation": attrs.get("compound_or_isolation"),
            "movement_pattern": attrs.get("movement_pattern"),
            "sets": None,  # continuous bout, not set-structured
            "reps": None,
            "load_kg": None,  # only %1RM known, not absolute kg
            "total_volume_kg": None,
            "duration_minutes": None,  # protocol-level only (4-5min/26-56s), not logged per row
            "intensity_pct_1rm": r["intensity_pct_1rm"],
            "intensity_tier": INTENSITY_MAP.get(int(r["intensity_pct_1rm"])),
            "density": None,
            "measured_kcal": None,
            "measured_kcal_min": r["measured_kcal_min"],
            "data_role": "primary_training_target",  # this IS what V1 was trained on
        })
    return pd.DataFrame(rows)


def build_brunelli_confirmatory_rows() -> pd.DataFrame:
    """Brunelli2019's absolute-kcal 'total' rows. Included in the canonical
    dataset for completeness/provenance, but flagged data_role=confirmatory_only
    — same treatment V1 already gave it (Section: 'not used to fit V1'),
    carried forward rather than re-litigated. Its target unit (absolute kcal
    over a to-failure protocol) is not compatible with the rate-based
    residual target used below."""
    unified = pd.read_csv(UNIFIED_PATH)
    b = unified[
        (unified["dataset_id"] == "brunelli2019")
        & (unified["metric_type"] == "energy_expenditure_absolute")
        & (unified["metric_subtype"] == "total")
    ]
    prov = STUDY_PROVENANCE["brunelli2019"]
    rows = []
    for _, r in b.iterrows():
        attrs = get_attributes(r["exercise_canonical_id"])
        rows.append({
            "study_id": "brunelli2019",
            "dataset_id": "brunelli2019",
            "participant_id": r["participant_group_id"],
            "measurement_method": prov["measurement_method"],
            "measurement_device": prov["measurement_device"],
            "license": prov["license"],
            "source": prov["source"],
            "original_paper": prov["original_paper"],
            "data_quality_tier": prov["data_quality_tier"],
            "sex": prov["sex"],
            "age": None,
            "age_cohort_mean": prov["age_cohort_mean"],
            "body_weight_kg": None,
            "body_weight_cohort_mean_kg": prov["body_weight_cohort_mean_kg"],
            "height_cm": None,
            "training_status": prov["training_status"],
            "exercise_id": r["exercise_canonical_id"],
            "exercise_type": attrs.get("movement_pattern"),
            "muscle_group": attrs.get("muscle_group"),
            "compound_or_isolation": attrs.get("compound_or_isolation"),
            "movement_pattern": attrs.get("movement_pattern"),
            "sets": 3,
            "reps": None,  # to-failure, uncounted
            "load_kg": None,
            "total_volume_kg": None,
            "duration_minutes": None,  # variable, not logged per set
            "intensity_pct_1rm": r["intensity_value"] if pd.notna(r["intensity_value"]) else None,
            "intensity_tier": None,
            "density": None,
            "measured_kcal": r["value"],
            "measured_kcal_min": None,
            "data_role": "confirmatory_only_incompatible_unit",
        })
    return pd.DataFrame(rows)


def main():
    rate_rows = build_rate_rows()
    brunelli_rows = build_brunelli_confirmatory_rows()
    full = pd.concat([rate_rows, brunelli_rows], ignore_index=True)

    # Enforce Section 5: every row must carry full provenance, no exceptions.
    bad = full.apply(lambda row: validate_row_provenance(row.to_dict()), axis=1)
    n_bad = (bad.apply(len) > 0).sum()
    if n_bad:
        raise ValueError(f"{n_bad} rows failed provenance validation — refusing to write an incomplete file")

    # Column order matches schema.ALL_FIELDS + the data_role bookkeeping column
    ordered_cols = ALL_FIELDS + ["data_role"]
    full = full[ordered_cols]

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    full.to_csv(OUT_PATH, index=False)

    print(f"Wrote {OUT_PATH} — {len(full)} rows")
    print(f"  primary_training_target rows: {(full['data_role'] == 'primary_training_target').sum()}")
    print(f"  confirmatory_only rows: {(full['data_role'] == 'confirmatory_only_incompatible_unit').sum()}")
    print(f"  unique participants (all rows): {full['participant_id'].nunique()}")
    print(f"  unique participants (primary_training_target only): {full[full['data_role']=='primary_training_target']['participant_id'].nunique()}")
    print()
    print("body_weight_kg (individual) populated for any row:", full["body_weight_kg"].notna().any())
    print("  -> confirms: still no individual body weight anywhere in currently-available data")


if __name__ == "__main__":
    main()
