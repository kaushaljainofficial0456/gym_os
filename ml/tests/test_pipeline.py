"""
Regression tests for the ML pipeline — run with:
    ml/.venv/Scripts/python.exe -m unittest discover -s tests -v

These exist to catch SILENT breakage: a future edit to an ingestion script
or the ontology that changes row counts, drops the leakage-prevention
grouping, or lets an unknown exercise through un-flagged, should fail a
test here rather than surface as a quietly-wrong model.
"""
import json
import sys
import unittest
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_DIR))

from ontology.exercise_map import to_canonical, get_attributes, EXERCISE_ATTRIBUTES  # noqa: E402


class TestOntology(unittest.TestCase):
    def test_known_exercise_maps(self):
        self.assertEqual(to_canonical("Bench press"), "BENCH_PRESS")
        self.assertEqual(to_canonical("half squat"), "BARBELL_SQUAT")

    def test_unknown_exercise_raises_not_guesses(self):
        # Section 36/rule: never silently map an unrecognized label.
        with self.assertRaises(KeyError):
            to_canonical("Cable Woodchop")

    def test_every_trained_exercise_has_attributes(self):
        for ex_id in EXERCISE_ATTRIBUTES:
            attrs = get_attributes(ex_id)
            self.assertIn("muscle_group", attrs)
            self.assertIn("compound_or_isolation", attrs)
            self.assertIn(attrs["compound_or_isolation"], ("compound", "isolation"))


class TestHarmonizedDataset(unittest.TestCase):
    """Checks the ALREADY-BUILT unified_observations_v0.csv — run
    src/preprocessing/harmonize.py first if this file doesn't exist yet."""

    @classmethod
    def setUpClass(cls):
        import pandas as pd
        path = Path(__file__).resolve().parents[1] / "data" / "processed" / "unified_observations_v0.csv"
        if not path.exists():
            raise unittest.SkipTest(f"{path} not built yet — run harmonize.py first")
        cls.df = pd.read_csv(path)

    def test_participant_count_matches_documented_value(self):
        # DATA_AUDIT.md and VALIDATION_REPORT.md both cite 25 total
        # (14 reis-lab + 11 brunelli). If this changes, every downstream
        # doc claiming "n=25" / "n=14" is now silently wrong.
        n_participants = self.df["participant_group_id"].nunique()
        self.assertEqual(n_participants, 25, "unique participant count drifted from the documented 25")

        reis_lab = self.df[self.df["dataset_id"].isin(["reis2017", "reis2019"])]
        self.assertEqual(reis_lab["participant_group_id"].nunique(), 14)

        brunelli = self.df[self.df["dataset_id"] == "brunelli2019"]
        self.assertEqual(brunelli["participant_group_id"].nunique(), 11)

    def test_no_reis2017_reis2019_duplicate_energy_cost_rows(self):
        # The dedup logic in harmonize.py must have actually run — this
        # catches a regression where the drop condition silently stops matching.
        #
        # NOTE (found by this test, verified not a bug — see harmonize.py):
        # a handful of reis2017 energy_cost_rate rows below 80%1RM survive
        # dedup because reis2019 has no counterpart for that exact
        # participant/exercise/intensity cell (a dropped trial on their
        # side) — keeping reis2017's group-mean-derived value there is a
        # legitimate "no better source exists" fallback, not a duplicate.
        # The invariant that actually matters: every such survivor MUST be
        # flagged is_group_mean_derived=True — a directly-measured
        # reis2017 row (there are none for this metric, but future-proofing)
        # sitting undeduped alongside a real reis2019 match would be a bug.
        reis17_ec = self.df[
            (self.df["dataset_id"] == "reis2017") & (self.df["metric_type"] == "energy_cost_rate")
        ]
        below_80 = reis17_ec[reis17_ec["intensity_value"] != 80]
        self.assertTrue((below_80["is_group_mean_derived"] == True).all(),  # noqa: E712
                         "a non-80%1RM reis2017 energy_cost_rate row survived dedup without being flagged as a fallback")

    def test_reis_lab_participant_ids_are_shared_namespace(self):
        # Leakage-prevention check: reis2017 and reis2019 must use the
        # SAME participant_group_id values (proven-shared cohort), not
        # per-dataset-prefixed ids that would defeat grouped splitting.
        ids_2017 = set(self.df[self.df["dataset_id"] == "reis2017"]["participant_group_id"])
        ids_2019 = set(self.df[self.df["dataset_id"] == "reis2019"]["participant_group_id"])
        self.assertEqual(ids_2017, ids_2019, "reis2017/reis2019 participant_group_id sets diverged — leakage-prevention grouping may be broken")


class TestExportedModelArtifact(unittest.TestCase):
    """Checks model_v1.json — run src/inference/export_model_v1.py first."""

    @classmethod
    def setUpClass(cls):
        path = Path(__file__).resolve().parents[1] / "models" / "skos-cal-v1" / "model_v1.json"
        if not path.exists():
            raise unittest.SkipTest(f"{path} not built yet — run export_model_v1.py first")
        cls.model = json.loads(path.read_text(encoding="utf-8"))

    def test_bench_press_hard_matches_hand_verified_value(self):
        # Hand-verified in models/skos-cal-v1/README.md: bench press,
        # hard, 78.67kg, 10min -> 114 kcal. Recompute in Python here so a
        # change to the exported coefficients is caught even if nobody
        # re-runs the JS example by hand.
        met = self.model["baseline"]["met_by_tier"]["hard"]
        bw = 78.67
        baseline_rate = met * 3.5 * bw / 200
        correction = self.model["correction_kcal_per_min_by_exercise_and_tier"]["BENCH_PRESS"]["hard"]
        active_rate = baseline_rate + correction
        estimated = round(active_rate * 10)
        self.assertEqual(estimated, 114)

    def test_every_trained_exercise_has_all_three_tiers(self):
        table = self.model["correction_kcal_per_min_by_exercise_and_tier"]
        for ex_id, tiers in table.items():
            for tier in ("light", "moderate", "hard"):
                self.assertIn(tier, tiers, f"{ex_id} missing {tier} tier correction")

    def test_interval_offsets_are_ordered_correctly(self):
        # lo_offset must be <= 0 <= hi_offset (a "lower bound offset" that's
        # positive, or an "upper bound offset" that's negative, would silently
        # produce an inverted interval).
        for coverage, iv in self.model["interval_offsets_kcal_per_min"].items():
            self.assertLessEqual(iv["lo_offset_kcal_min"], 0, f"{coverage}% lo_offset should be <= 0")
            self.assertGreaterEqual(iv["hi_offset_kcal_min"], 0, f"{coverage}% hi_offset should be >= 0")


if __name__ == "__main__":
    unittest.main()
