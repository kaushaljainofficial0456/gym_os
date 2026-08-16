"""
Canonical V2 dataset schema — Section 7/5 of the V2 master prompt.

This defines the FULL set of fields V2 is designed to eventually use.
Any given source dataset populates only the subset it actually has —
missing fields stay null/None, never fabricated. `build_v2_dataset.py`
enforces this: it will not write a placeholder value for a field the
source doesn't provide.

Two field groups:
  PROVENANCE_FIELDS  — required on every row, no exceptions (Section 5)
  DATA_FIELDS        — the physiological/workout fields (Section 7),
                        each individually optional per-row
"""
from dataclasses import dataclass, field
from typing import Optional

# ---- Provenance (Section 5) — mandatory on every row ----
PROVENANCE_FIELDS = [
    "study_id",             # e.g. "reis2017", "rustaden2020" — stable short id
    "dataset_id",           # source file/artifact id (may equal study_id for single-file studies)
    "participant_id",       # MUST be in a leakage-safe shared namespace across studies of the same cohort
    "measurement_method",   # e.g. "indirect_calorimetry_breath_by_breath"
    "measurement_device",   # e.g. "COSMED K4b2" — named device, never blank if calorimetry is claimed
    "license",               # e.g. "CC BY 4.0"
    "source",                # URL/DOI
    "original_paper",        # citation string
    "data_quality_tier",     # GOLD | SILVER | AUXILIARY (AUXILIARY rows never carry an energy_expenditure target)
]

# ---- Data fields (Section 7) — each optional, populate only if the source has it ----
DATA_FIELDS = [
    "sex",                       # "male" | "female" | "mixed_cohort_only" (if only cohort-level sex ratio is known)
    "age",                       # individual age in years; if only cohort mean is known, leave null and use age_cohort_mean instead
    "age_cohort_mean",           # cohort mean age, when individual age isn't available (documented fallback, not a substitute for real per-row age)
    "body_weight_kg",            # INDIVIDUAL body weight — the field V1 was missing entirely
    "body_weight_cohort_mean_kg",# cohort mean, when individual weight isn't available
    "height_cm",
    "training_status",           # "trained" | "untrained" | "mixed" | None
    "exercise_id",                # canonical SK OS exercise id
    "exercise_type",
    "muscle_group",
    "compound_or_isolation",
    "movement_pattern",
    "sets",
    "reps",
    "load_kg",
    "total_volume_kg",
    "duration_minutes",
    "intensity_pct_1rm",
    "intensity_tier",             # light/moderate/hard, if mappable
    "density",                    # volume or work per minute, if derivable
    "measured_kcal",              # absolute kcal for the observation
    "measured_kcal_min",          # rate form, kcal/min
]

ALL_FIELDS = PROVENANCE_FIELDS + DATA_FIELDS


def validate_row_provenance(row: dict) -> list[str]:
    """Returns a list of missing/empty REQUIRED provenance fields for one row.
    Empty list = valid. Called on every row before it's allowed into
    v2_training_dataset.csv — a row failing this is rejected, not patched."""
    problems = []
    for f in PROVENANCE_FIELDS:
        if f not in row or row[f] in (None, ""):
            problems.append(f)
    return problems


def validate_no_target_leakage(feature_columns: list[str]) -> list[str]:
    """Section 2's hard rule: measured_kcal / measured_kcal_min / anything
    VO2-derived must NEVER appear in a feature list used to predict the
    residual. Returns any offending columns found (empty = safe)."""
    banned_substrings = ["measured_kcal", "vo2", "vco2", "energy_cost_rate", "residual", "v1_residual", "v2_residual"]
    offenders = []
    for col in feature_columns:
        low = col.lower()
        if any(b in low for b in banned_substrings):
            offenders.append(col)
    return offenders
