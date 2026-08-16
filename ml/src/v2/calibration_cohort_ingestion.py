"""
PHASE 9 — ingestion module for SK OS's own calibration-cohort data.

This is the module that will finally unlock Phase G training. It follows
the same contract as every other candidate dataset (see
ingestion_interface.py), with one crucial difference: unlike Rustaden /
Joao / Nakagata / Adeel, this data does not exist yet because nobody has
published it -- it does not exist because WE HAVE NOT COLLECTED IT YET.
That makes it the only pending dataset whose arrival we actually control.

Study design: docs/PHASE9_STUDY_PROTOCOL.md

WHY THIS DATASET WOULD BE GOLD (unlike all 5 published SILVER candidates):
  * Individual body weight per participant       -> resolves audit #13
  * Resting EE measured separately               -> resolves audit #2
  * Whole-session gas collection incl. rest      -> resolves audit #3/#4/#5
  * Real multi-exercise sessions                 -> resolves audit #9
  * Participant-level rows by construction       -> the thing every
                                                    published candidate lacks
  * Consent explicitly covering commercial use   -> avoids the Benito 2016
                                                    permanent-blocker trap

NOTHING BELOW FABRICATES DATA. load() raises until a real export exists.
The validation logic, however, is written and tested NOW -- so that when
data does arrive it is checked hard on arrival, rather than checked
hastily under pressure to finally start training.
"""
from pathlib import Path
import sys

SRC_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SRC_DIR))

import pandas as pd  # noqa: E402
from v2.schema import ALL_FIELDS  # noqa: E402
from v2.ingestion_interface import DatasetIngestionModule  # noqa: E402

RAW_DIR = Path(__file__).resolve().parents[2] / "data" / "external"
EXPECTED_LAB_FILE = RAW_DIR / "phase9_lab_measurements.csv"
EXPECTED_APP_FILE = RAW_DIR / "phase9_app_sessions.csv"


class CalibrationCohortV1(DatasetIngestionModule):
    """SK OS's own calibration cohort. See PHASE9_STUDY_PROTOCOL.md."""

    STUDY_ID = "skos_calibration_v1"
    GOLD_SILVER_STATUS = "GOLD"  # by design -- but see verify_gold_criteria(); the label
                                  # is only honest if the data actually meets it on arrival
    RAW_FILE_REQUIRED = (
        f"TWO files, joined on (calibration_participant_id, session_id):\n"
        f"  1. {EXPECTED_LAB_FILE.name} -- from the partner lab: per-session measured "
        f"resting EE, session EE (gross kcal), recovery EE, device, calibration log, "
        f"energy-computation equation, participant demographics incl. INDIVIDUAL BODY WEIGHT.\n"
        f"  2. {EXPECTED_APP_FILE.name} -- from the SK OS backend: the app's own logged "
        f"record of the same sessions (schema-0.2 fields + started_at/ended_at/clock_offset_seconds "
        f"+ verified is_synthesized=false).\n"
        f"Neither file exists yet. Study not yet started -- awaiting lab partner selection."
    )

    @staticmethod
    def load() -> pd.DataFrame:
        if not EXPECTED_LAB_FILE.exists() or not EXPECTED_APP_FILE.exists():
            raise NotImplementedError(
                "Phase 9 calibration data has not been collected yet. No lab partner "
                "selected, no sessions measured. Do NOT stub this with placeholder rows -- "
                "the entire point of this dataset is that it is real. "
                "See docs/PHASE9_STUDY_PROTOCOL.md."
            )
        raise NotImplementedError(
            "Raw files detected, but the mapping logic is deliberately unwritten: the exact "
            "column layout depends on what the partner lab's system exports, which is unknown "
            "until a lab is selected. Implement the mapping to v2.schema.ALL_FIELDS here, then "
            "run verify_gold_criteria() and the alignment checks below BEFORE the rows are "
            "allowed anywhere near training."
        )


# ---------------------------------------------------------------------------
# Arrival checks. Written now, deliberately, while there is no pressure to
# let anything through. Each maps to an audit finding or a V1 lesson.
# ---------------------------------------------------------------------------

def verify_gold_criteria(df: pd.DataFrame) -> dict:
    """Does this data ACTUALLY meet GOLD, or did something degrade during
    collection? Claiming GOLD in the class attribute above does not make it
    so -- this checks. Returns {check_name: (passed, detail)}."""
    checks = {}

    has_individual_bw = df["body_weight_kg"].notna().all() if "body_weight_kg" in df else False
    checks["individual_body_weight_present"] = (
        bool(has_individual_bw),
        "Audit #13: every row needs a REAL individual body weight. A cohort-mean fallback "
        "here would silently recreate V1's single biggest defect."
    )

    has_device = (
        "measurement_device" in df
        and df["measurement_device"].notna().all()
        and (df["measurement_device"].astype(str).str.strip() != "").all()
    )
    checks["named_device_on_every_row"] = (
        bool(has_device),
        "A named calorimetry device is what separates GOLD from an undocumented "
        "Calories_Burned column."
    )

    if "duration_minutes" in df and df["duration_minutes"].notna().any():
        med = float(df["duration_minutes"].median())
        realistic = med >= 20
        checks["sessions_are_realistic_length"] = (
            bool(realistic),
            f"Median session {med:.1f} min. Audit #3 is about REAL session durations; "
            f"if these are short isolated bouts we have reproduced the reis-lab limitation "
            f"rather than fixed it."
        )
    else:
        checks["sessions_are_realistic_length"] = (False, "duration_minutes missing entirely")

    n_participants = df["participant_id"].nunique() if "participant_id" in df else 0
    checks["minimum_viable_sample"] = (
        n_participants >= 20,
        f"{n_participants} participants. Protocol §3: 20 is the floor below which "
        f"'V2 beats V1' cannot be distinguished from noise; 30 is the target."
    )

    if "sex" in df:
        sexes = df.groupby("participant_id")["sex"].first()
        n_women = int((sexes.astype(str).str.lower() == "female").sum())
        frac = n_women / max(len(sexes), 1)
        checks["women_represented"] = (
            frac >= 0.30,
            f"{n_women}/{len(sexes)} participants are women ({frac:.0%}). V1 was 100% male; "
            f"protocol targets >=40%. Below ~30% no meaningful sex subgroup analysis is possible."
        )
    else:
        checks["women_represented"] = (False, "sex column missing")

    return checks


def verify_no_v1_cohort_contamination(df: pd.DataFrame) -> tuple[bool, str]:
    """Calibration participants must be disjoint from V1's reis-lab cohort.
    Trivially true for real SK OS users, but checked explicitly because V1's
    hardest-won lesson was that a shared cohort can hide in plain sight
    (reis2017/reis2019 were only caught by numeric identity, not by name)."""
    if "participant_id" not in df:
        return False, "participant_id column missing"
    ids = set(df["participant_id"].astype(str))
    reis_like = {i for i in ids if i.startswith("reis_lab_p")}
    brunelli_like = {i for i in ids if i.startswith("brunelli2019_p")}
    clashes = reis_like | brunelli_like
    if clashes:
        return False, f"participant_id namespace collides with existing V1 cohorts: {sorted(clashes)[:5]}"
    return True, f"{len(ids)} calibration participant ids, all disjoint from V1 cohort namespaces"


def verify_session_alignment(lab_df: pd.DataFrame, app_df: pd.DataFrame, max_drift_seconds: int = 120) -> dict:
    """The lab's clock and the phone's clock are independent. Protocol §4.4
    requires recording the offset; this checks it was actually applied and
    that each lab session matches exactly one app session.

    A silent misalignment here would pair one person's physiology with
    another session's workout log -- producing confident, completely wrong
    training rows. Worth failing loudly over.
    """
    result = {"passed": False, "issues": []}

    required_lab = {"calibration_participant_id", "session_id", "started_at", "ended_at"}
    required_app = {"calibration_participant_id", "session_id", "started_at", "ended_at", "clock_offset_seconds"}
    if not required_lab.issubset(lab_df.columns):
        result["issues"].append(f"lab file missing: {sorted(required_lab - set(lab_df.columns))}")
    if not required_app.issubset(app_df.columns):
        result["issues"].append(f"app file missing: {sorted(required_app - set(app_df.columns))}")
    if result["issues"]:
        return result

    key = ["calibration_participant_id", "session_id"]
    merged = lab_df.merge(app_df, on=key, how="outer", suffixes=("_lab", "_app"), indicator=True)

    unmatched = merged[merged["_merge"] != "both"]
    if len(unmatched):
        result["issues"].append(
            f"{len(unmatched)} sessions present in only one file -- every lab session must have "
            f"exactly one app session and vice versa"
        )

    both = merged[merged["_merge"] == "both"].copy()
    if len(both):
        lab_start = pd.to_datetime(both["started_at_lab"], utc=True, errors="coerce")
        app_start = pd.to_datetime(both["started_at_app"], utc=True, errors="coerce")
        offset = pd.to_numeric(both["clock_offset_seconds"], errors="coerce").fillna(0)
        drift = (lab_start - app_start).dt.total_seconds().abs() - offset.abs()
        bad = both[drift.abs() > max_drift_seconds]
        if len(bad):
            result["issues"].append(
                f"{len(bad)} sessions exceed {max_drift_seconds}s residual clock drift after "
                f"applying the recorded offset -- investigate before use, do not silently accept"
            )

    result["passed"] = not result["issues"]
    return result


if __name__ == "__main__":
    print("=== Phase 9 calibration-cohort ingestion status ===\n")
    print(f"Study ID:        {CalibrationCohortV1.STUDY_ID}")
    print(f"Intended tier:   {CalibrationCohortV1.GOLD_SILVER_STATUS} (verified on arrival, not assumed)")
    print(f"Lab file:        {EXPECTED_LAB_FILE}  [{'PRESENT' if EXPECTED_LAB_FILE.exists() else 'NOT COLLECTED'}]")
    print(f"App file:        {EXPECTED_APP_FILE}  [{'PRESENT' if EXPECTED_APP_FILE.exists() else 'NOT COLLECTED'}]")
    print()
    try:
        CalibrationCohortV1.load()
    except NotImplementedError as e:
        print(f"load() correctly refuses:\n  {e}")
    print()
    print("Arrival checks implemented and unit-tested (tests/test_v2_residual_model.py):")
    print("  - verify_gold_criteria()             individual body weight, named device,")
    print("                                        realistic durations, n>=20, women >=30%")
    print("  - verify_no_v1_cohort_contamination() namespace disjointness from reis/brunelli")
    print("  - verify_session_alignment()          lab<->app 1:1 match, clock-drift bound")
