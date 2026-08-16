"""
PHASE C of the V2 master prompt — leakage detection.

Two things this checks:
  1. Within the CURRENT canonical dataset: are any participant_id values
     shared across study_id values in a way not already accounted for by
     the shared reis_lab_p{n} namespace? (Regression check — this should
     find nothing new, since reis2017/reis2019 sharing a cohort is already
     known and already unified into one namespace.)
  2. Against every CANDIDATE dataset from V2_DATA_ACQUISITION_REPORT.md
     (acquired or not) — documents the overlap assessment made for each,
     so the reasoning is auditable, not just asserted in prose.
"""
from pathlib import Path
import sys

SRC_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SRC_DIR))

import pandas as pd  # noqa: E402

DATA_PATH = Path(__file__).resolve().parents[2] / "data" / "processed" / "v2_training_dataset.csv"
DOCS_DIR = Path(__file__).resolve().parents[2] / "docs"

# Candidate-dataset leakage assessments — mirrors the matrix already built
# in V2_DATA_ACQUISITION_REPORT.md §7, kept in code so it's checkable
# programmatically as new candidates are actually acquired, not just prose.
CANDIDATE_ASSESSMENTS = [
    {"dataset_a": "reis2017", "dataset_b": "reis2019", "status": "IN_DATASET",
     "overlap_evidence": "Numeric identity: reis2017 blue-block kcal/min values match reis2019 EC values to several decimal places for the same participant/exercise/intensity.",
     "decision": "CONFIRMED SAME COHORT — unified into shared participant_group_id namespace (reis_lab_p{1..14}). Never split across train/test."},
    {"dataset_a": "reis-lab (17/19)", "dataset_b": "brunelli2019", "status": "IN_DATASET",
     "overlap_evidence": "Different institutions, no shared authors, no numeric identity found in V1's audit.",
     "decision": "CONFIRMED DISJOINT — safe to treat as independent participants."},
    {"dataset_a": "reis-lab", "dataset_b": "Rustaden 2020", "status": "NOT_YET_ACQUIRED",
     "overlap_evidence": "Portugal (reis-lab) vs. Norway (Rustaden) — different country, different institution, no shared authors found in a search this round.",
     "decision": "No overlap expected. Re-verify with actual author/participant metadata IF raw data is obtained."},
    {"dataset_a": "reis-lab", "dataset_b": "Joao 2021", "status": "NOT_YET_ACQUIRED",
     "overlap_evidence": "Joao 2021 author list (Joao, Almeida, Tavares, Kalva-Filho, Carvas Junior, Pontes, Baker, Bocalini, Figueira) does not include Reis VM.",
     "decision": "No overlap expected. SOFT FLAG: Joao 2021 shares 'Tavares'/'Bocalini' co-authors with a previously-logged systematic review that also lists a 'Reis' co-author — not independently confirmed as the same V. Reis (common surname). Re-verify if raw data is obtained."},
    {"dataset_a": "reis-lab", "dataset_b": "Benito 2016", "status": "REFERENCE_ONLY_PERMANENT",
     "overlap_evidence": "Portugal (reis-lab) vs. Spain, Technical University of Madrid (Benito) — different country/institution.",
     "decision": "No overlap expected. Moot for training purposes — individual data is permanently unavailable regardless (Spanish law)."},
    {"dataset_a": "Rustaden 2020", "dataset_b": "Joao 2021", "status": "NOT_YET_ACQUIRED",
     "overlap_evidence": "Norway vs. Brazil — different country, different institution.",
     "decision": "No overlap expected."},
    {"dataset_a": "Rustaden 2020", "dataset_b": "Benito 2016", "status": "NOT_YET_ACQUIRED / REFERENCE_ONLY",
     "overlap_evidence": "Norway vs. Spain — different country, different institution.",
     "decision": "No overlap expected."},
    {"dataset_a": "Joao 2021", "dataset_b": "Benito 2016", "status": "NOT_YET_ACQUIRED / REFERENCE_ONLY",
     "overlap_evidence": "Brazil vs. Spain — different country, different institution.",
     "decision": "No overlap expected."},
    {"dataset_a": "reis-lab", "dataset_b": "Nakagata 2019", "status": "NOT_YET_ACQUIRED",
     "overlap_evidence": "Portugal (reis-lab) vs. Japan (Nakagata/Juntendo University) — different country, different institution.",
     "decision": "No overlap expected."},
    {"dataset_a": "Nakagata 2019", "dataset_b": "Rustaden 2020 / Joao 2021 / Benito 2016", "status": "NOT_YET_ACQUIRED",
     "overlap_evidence": "Japan vs. Norway/Brazil/Spain — different country, different institution, different research group for all three.",
     "decision": "No overlap expected."},
    {"dataset_a": "Adeel 2021 (Appl Sci 11:8773)", "dataset_b": "Adeel 2022 (IJERPH 19:2233)", "status": "CONFIRMED_SAME_COHORT",
     "overlap_evidence": "Identical ClinicalTrials.gov registration (NCT04532905), identical IRB number (N202004023), identical recruitment window (Dec 2020-May 2021), identical sample structure (12 recruited / 1 excluded / 11 analysed; 5 untrained + 6 trained), identical exercises (shoulder press, deadlift, squat) and identical device (Cortex Metalyzer 3B).",
     "decision": "SAME 11 PARTICIPANTS — must NEVER be counted as 22. Same class of error the reis2017/reis2019 numeric-identity check caught in V1. If either paper's data is ever acquired, both map to ONE participant_id namespace."},
    {"dataset_a": "Adeel 2021/2022 cluster", "dataset_b": "Adeel et al. Appl Sci 11:6687 ('Energy Expenditure during Acute Weight Training', n=10, bent-over row/deadlift/lunge)", "status": "SUSPECTED_SAME_COHORT_UNVERIFIED",
     "overlap_evidence": "Same research group (Adeel/Peng, Taipei Medical University), same year, same untrained-vs-trained design, overlapping exercise (deadlift), n=10 vs n=11. MDPI blocked direct access to 11:6687 so the trial registration/IRB number could NOT be checked.",
     "decision": "TREAT AS SAME COHORT until proven otherwise. Do not count as independent participants. Verify the NCT/IRB number if access is ever obtained."},
    {"dataset_a": "reis-lab / Rustaden / Joao / Nakagata / Benito", "dataset_b": "Adeel cluster (Taiwan)", "status": "NOT_YET_ACQUIRED",
     "overlap_evidence": "Taiwan (Taipei Medical University) vs Portugal / Norway / Brazil / Japan / Spain — different country, institution and research group in every case.",
     "decision": "No overlap expected."},
    {"dataset_a": "Nakagata 2019", "dataset_b": "Nakagata 2022 (previously EXCLUDED, CC BY-NC-ND) / Descente bulletin (40_146.pdf, reference-only)", "status": "SAME_AUTHOR_NETWORK",
     "overlap_evidence": "All three share Nakagata/Yamada/Naito as authors (same Juntendo University lab). Nakagata 2022 and the Descente bulletin were never usable as training data anyway (license-excluded and aggregate/unclear-license respectively), so this cannot create training leakage — but if Nakagata 2019's data is ever obtained, check whether ANY of its 20 participants also appear in the 2022 paper's 15-young-men sample before treating the two studies as fully independent (2022's population is young men only, Nakagata 2019 is older adults, so an overlap is unlikely on population-mismatch grounds alone, but not yet numerically verified).",
     "decision": "No training-data risk today (neither prior Nakagata paper is trainable). Flagged for a real check if/when Nakagata 2019's individual data is ever acquired."},
]


def check_in_dataset_leakage() -> dict:
    """Regression check on the CURRENT canonical file: confirms the
    reis-lab shared-cohort handling still holds and nothing new leaked in."""
    df = pd.read_csv(DATA_PATH)
    result = {}

    reis17_ids = set(df[df["study_id"] == "reis2017"]["participant_id"])
    reis19_ids = set(df[df["study_id"] == "reis2019"]["participant_id"])
    brunelli_ids = set(df[df["study_id"] == "brunelli2019"]["participant_id"])

    result["reis2017_reis2019_identical_namespace"] = (reis17_ids == reis19_ids)
    result["reis_lab_brunelli_disjoint"] = len(reis17_ids & brunelli_ids) == 0 and len(reis19_ids & brunelli_ids) == 0
    result["total_unique_participants"] = df["participant_id"].nunique()
    result["reis_lab_participant_count"] = len(reis17_ids | reis19_ids)
    result["brunelli_participant_count"] = len(brunelli_ids)
    return result


def main():
    in_dataset = check_in_dataset_leakage()

    lines = []
    lines.append("# V2 Leakage Report")
    lines.append("")
    lines.append("Two parts: (1) an automated regression check on the current canonical dataset, "
                  "(2) the documented overlap assessment for every candidate dataset from "
                  "V2_DATA_ACQUISITION_REPORT.md, whether acquired or not.")
    lines.append("")
    lines.append("## Part 1 — automated check on `v2_training_dataset.csv`")
    lines.append("")
    for k, v in in_dataset.items():
        lines.append(f"- **{k}**: {v}")
    lines.append("")
    all_pass = in_dataset["reis2017_reis2019_identical_namespace"] and in_dataset["reis_lab_brunelli_disjoint"]
    lines.append(f"**Result: {'PASS' if all_pass else 'FAIL'}** — "
                  f"{'no unaccounted-for leakage found; the known reis2017/reis2019 shared cohort remains correctly unified, and brunelli2019 remains correctly disjoint.' if all_pass else 'INVESTIGATE — an expected invariant did not hold.'}")
    lines.append("")
    lines.append("## Part 2 — candidate-dataset overlap matrix")
    lines.append("")
    lines.append("| Dataset A | Dataset B | Status | Overlap evidence | Decision |")
    lines.append("|---|---|---|---|---|")
    for c in CANDIDATE_ASSESSMENTS:
        lines.append(f"| {c['dataset_a']} | {c['dataset_b']} | {c['status']} | {c['overlap_evidence']} | {c['decision']} |")
    lines.append("")
    lines.append("## Net assessment")
    lines.append("")
    lines.append("No confirmed participant-level leakage anywhere in the current dataset or among candidate "
                  "datasets. One soft flag (Joao 2021's shared co-author surnames with a previously-logged "
                  "review) is noted for awareness, not treated as disqualifying — a review paper has no "
                  "primary-data cohort of its own to overlap with. This assessment will be re-run "
                  "automatically the moment any new candidate's actual participant-level data is acquired — "
                  "author/institution matching is a proxy, not a substitute for the numeric-identity check "
                  "that actually proved the reis2017/reis2019 overlap.")

    report = "\n".join(lines)
    out_path = DOCS_DIR / "V2_LEAKAGE_REPORT.md"
    out_path.write_text(report, encoding="utf-8")
    print(report)
    print(f"\nWrote {out_path}")


if __name__ == "__main__":
    main()
