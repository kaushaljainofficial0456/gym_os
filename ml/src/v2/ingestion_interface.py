"""
Data-ingestion INTERFACE for future V2 datasets (Rustaden 2020, Joao 2021,
and anything else that later passes the GOLD/SILVER bar in
V2_DATA_QUALITY_RULES.md). Defines the contract every new ingestion module
must satisfy before its rows can enter v2_training_dataset.csv — nothing
about this file, on its own, adds a single new participant.

HOW TO USE THIS ONCE A REAL RAW FILE ARRIVES (e.g. Rustaden's data lands
in ml/data/external/rustaden2020_raw.xlsx):
  1. Implement `load()` in the corresponding module below with real
     pandas logic reading that actual file — replacing the
     NotImplementedError, not adding fabricated rows.
  2. Run `validate_and_report(rows)` — it will not silently accept
     anything; it checks provenance completeness AND the leakage/quality
     gate before returning a verdict.
  3. Only after that passes does `build_v2_dataset.py` get extended to
     include the new source (a deliberate, visible code change, not an
     automatic merge).
"""
from pathlib import Path
import sys

SRC_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SRC_DIR))

import pandas as pd  # noqa: E402
from v2.schema import ALL_FIELDS, validate_row_provenance  # noqa: E402


class DatasetIngestionModule:
    """The contract. Every new-dataset ingestion module (rustaden2020.py,
    joao2021.py, future ones) must expose a `load()` function matching
    this shape: takes no arguments, returns a pandas DataFrame with
    exactly the columns in v2.schema.ALL_FIELDS (missing/unavailable
    fields as None — never fabricated), one row per observation.

    Required companion metadata (checked by validate_and_report):
      STUDY_ID: str
      GOLD_SILVER_STATUS: "GOLD" | "SILVER" — must match
        V2_DATA_ACQUISITION_REPORT.md's classification for this study;
        if that doc says SILVER because raw data wasn't confirmed, this
        module cannot claim GOLD just because a file eventually showed up
        — re-classify in the acquisition report first, deliberately.
      RAW_FILE_REQUIRED: the exact file this module needs to actually run
        (so "what's needed" stays concrete, not vague)
    """
    STUDY_ID: str = None
    GOLD_SILVER_STATUS: str = None
    RAW_FILE_REQUIRED: str = None

    @staticmethod
    def load() -> pd.DataFrame:
        raise NotImplementedError


def validate_and_report(module: type[DatasetIngestionModule]) -> dict:
    """Runs a candidate module's load() (if implemented) and checks the
    result against the hard requirements before it's allowed anywhere
    near v2_training_dataset.csv. Never patches a failing row — reports
    the failure so a human decides what to do."""
    report = {"study_id": module.STUDY_ID, "status": module.GOLD_SILVER_STATUS, "passed": False, "issues": []}

    if module.GOLD_SILVER_STATUS not in ("GOLD", "SILVER"):
        report["issues"].append(f"GOLD_SILVER_STATUS is {module.GOLD_SILVER_STATUS!r} — only GOLD/SILVER may enter training; AUXILIARY/EXCLUDE must never reach this function")
        return report

    try:
        rows = module.load()
    except NotImplementedError:
        report["issues"].append(f"load() not yet implemented — needs {module.RAW_FILE_REQUIRED}")
        return report

    missing_cols = set(ALL_FIELDS) - set(rows.columns)
    if missing_cols:
        report["issues"].append(f"missing required columns: {sorted(missing_cols)}")
        return report

    bad_rows = rows.apply(lambda r: validate_row_provenance(r.to_dict()), axis=1)
    n_bad = (bad_rows.apply(len) > 0).sum()
    if n_bad:
        report["issues"].append(f"{n_bad}/{len(rows)} rows failed provenance validation")
        return report

    report["passed"] = True
    report["row_count"] = len(rows)
    report["participant_count"] = rows["participant_id"].nunique()
    return report


class Rustaden2020(DatasetIngestionModule):
    """18 women (10 BodyPump, 8 heavy-load), Oxycon Pro Jaeger indirect
    calorimetry, real 12-exercise ~58-minute multi-exercise session.
    See V2_DATA_ACQUISITION_REPORT.md for full detail and why this is the
    #1 acquisition priority.
    """
    STUDY_ID = "rustaden2020"
    GOLD_SILVER_STATUS = "SILVER"  # becomes GOLD only once raw data is actually in hand and re-classified deliberately
    RAW_FILE_REQUIRED = "Participant-level raw data requested from the corresponding author (Rustaden et al., Frontiers in Physiology 2020, DOI 10.3389/fphys.2020.00570) — request SENT, awaiting response."

    @staticmethod
    def load() -> pd.DataFrame:
        raise NotImplementedError(
            "Rustaden 2020 raw data has not been obtained yet. Request sent to the corresponding "
            "author; awaiting a reply. Once received, implement this to read the actual file "
            "(format unknown until it arrives) and map its columns to v2.schema.ALL_FIELDS. "
            "Do not fabricate rows in the meantime."
        )


class Joao2021(DatasetIngestionModule):
    """15 trained men, COSMED Fitmate Pro, real 8-exercise sessions at
    44/61/116 minutes across 3 intensities. See
    V2_DATA_ACQUISITION_REPORT.md for full detail — this is the best
    available evidence anywhere in this search for validating V1's
    duration-extrapolation concern, if the authors can share the data.
    """
    STUDY_ID = "joao2021"
    GOLD_SILVER_STATUS = "SILVER"
    RAW_FILE_REQUIRED = "Supplementary/raw data availability not confirmed from the published text (Joao et al., Front Sports Act Living 2021, DOI 10.3389/fspor.2021.797604) — request SENT to the corresponding author, awaiting response."

    @staticmethod
    def load() -> pd.DataFrame:
        raise NotImplementedError(
            "Joao 2021 raw data has not been obtained yet. Request sent to the corresponding "
            "author asking whether it exists at all; awaiting a reply. "
            "Do not fabricate rows in the meantime."
        )


class Nakagata2019(DatasetIngestionModule):
    """20 older adults (13 men, 7 women, ages 66-80, mean 70.8y), Minato
    Aeromonitor AE-300S indirect calorimetry, 4 bodyweight slow-tempo
    exercises (squat, knee push-up, crunch, heel-raise). Found as an
    author-archived manuscript draft (University of Toronto repository),
    NOT the publisher's licensed version — license unresolved. Uniquely
    closes both the women AND older-adults gaps at once. Corresponding
    author's email is printed in the document itself
    (takashi.nakagata@gmail.com) — a concrete outreach target.
    """
    STUDY_ID = "nakagata2019"
    GOLD_SILVER_STATUS = "SILVER"
    RAW_FILE_REQUIRED = (
        "Individual-level data was not found anywhere in the draft manuscript inspected "
        "(only group-by-sex aggregate means in Table 1/2) - the published version may not "
        "have individual data either. Needs a direct request to Takashi Nakagata "
        "(corresponding author) for (a) individual-level raw data if it exists, and "
        "(b) clarification of the license/redistribution status of the final published article, "
        "DOI 10.1139/apnm-2018-0882 (Applied Physiology, Nutrition, and Metabolism)."
    )

    @staticmethod
    def load() -> pd.DataFrame:
        raise NotImplementedError(
            "Nakagata 2019 individual-level data has not been obtained (only aggregate "
            "group-by-sex means were found in the inspected draft). Not requested from the "
            "author yet. Do not fabricate rows in the meantime."
        )


class AdeelCluster(DatasetIngestionModule):
    """11 participants (5 untrained all-female, 6 trained 4M/2F), Cortex
    Metalyzer 3B, dumbbell shoulder press / deadlift / squat at 60% 1RM,
    realistic 52-minute multi-exercise session. CC BY 4.0 — the only new
    candidate with a confirmed commercially-compatible license.

    LEAKAGE-CRITICAL: Adeel 2021 (Appl Sci 11:8773) and Adeel 2022
    (IJERPH 19:2233) are the SAME 11 people (same NCT04532905, same IRB
    N202004023, same recruitment window) — never count them as 22. A
    third paper (Appl Sci 11:6687) is suspected same-cohort, unverified.

    Published data is aggregate group means only. Raw individual data
    demonstrably exists (the paper states Cortex analyser data was
    exported to Excel) but was not published.
    """
    STUDY_ID = "adeel_cluster"
    GOLD_SILVER_STATUS = "SILVER"
    RAW_FILE_REQUIRED = (
        "Individual-level Cortex Metalyzer 3B exports. NOT published — both papers report "
        "group means only. Request from corresponding author Chih-Wei Peng (cwpeng@tmu.edu.tw), "
        "Taipei Medical University. NOTE: their Data Availability Statement reads 'The data "
        "presented in this study are all available in the article', so a raw-data request may "
        "be declined — but the Methods section confirms raw analyser data was exported to Excel, "
        "so it exists. Also worth checking ClinicalTrials.gov NCT04532905 for posted results."
    )

    @staticmethod
    def load() -> pd.DataFrame:
        raise NotImplementedError(
            "Adeel cluster individual-level data has not been obtained (published tables are "
            "group means only). Not requested from the authors yet. If obtained, map BOTH the "
            "2021 and 2022 papers into a SINGLE participant_id namespace — they are the same "
            "11 people. Do not fabricate rows in the meantime."
        )


# Registry of everything known to be pending — extend this list as new
# candidates pass the GOLD/SILVER bar in future acquisition rounds.
PENDING_DATASETS = [Rustaden2020, Joao2021, Nakagata2019, AdeelCluster]


if __name__ == "__main__":
    print("=== V2 ingestion interface status ===\n")
    for module in PENDING_DATASETS:
        report = validate_and_report(module)
        print(f"{report['study_id']} ({report['status']}): {'READY' if report['passed'] else 'BLOCKED'}")
        for issue in report["issues"]:
            print(f"  - {issue}")
        print()
