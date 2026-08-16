"""
Regression tests for the V2 pipeline infrastructure (schema, ingestion,
leakage check, frozen-V1 benchmark). Run with:
    ml/.venv/Scripts/python.exe -m unittest discover -s tests -v

These exist so the pipeline built ahead of new data arriving stays
correct — a future change that breaks provenance validation, silently
lets a fabricated field through, or drifts from V1's own published
numbers should fail here, not surface later as a quietly-wrong V2.
"""
import sys
import unittest
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_DIR))

from v2.schema import validate_row_provenance, validate_no_target_leakage, PROVENANCE_FIELDS  # noqa: E402


class TestSchema(unittest.TestCase):
    def test_complete_row_passes_provenance(self):
        row = {f: "x" for f in PROVENANCE_FIELDS}
        self.assertEqual(validate_row_provenance(row), [])

    def test_missing_field_is_caught(self):
        row = {f: "x" for f in PROVENANCE_FIELDS}
        del row["measurement_device"]
        problems = validate_row_provenance(row)
        self.assertIn("measurement_device", problems)

    def test_target_leakage_detector_catches_obvious_cases(self):
        offenders = validate_no_target_leakage(["body_weight_kg", "measured_kcal_min", "vo2_relative", "sets"])
        self.assertIn("measured_kcal_min", offenders)
        self.assertIn("vo2_relative", offenders)
        self.assertNotIn("body_weight_kg", offenders)
        self.assertNotIn("sets", offenders)


class TestV2CanonicalDataset(unittest.TestCase):
    """Checks the ALREADY-BUILT v2_training_dataset.csv — run
    src/v2/build_v2_dataset.py first if this file doesn't exist yet."""

    @classmethod
    def setUpClass(cls):
        import pandas as pd
        path = Path(__file__).resolve().parents[1] / "data" / "processed" / "v2_training_dataset.csv"
        if not path.exists():
            raise unittest.SkipTest(f"{path} not built yet — run build_v2_dataset.py first")
        cls.df = pd.read_csv(path)

    def test_every_row_has_full_provenance(self):
        for f in PROVENANCE_FIELDS:
            self.assertFalse(self.df[f].isna().any(), f"{f} has missing values — provenance must be complete on every row")

    def test_no_individual_body_weight_fabricated(self):
        # Honest-state check (Section 13 of the master prompt): as of this
        # dataset, NO source provides individual body weight. If this ever
        # flips true without a real new dataset behind it, that's exactly
        # the fabrication this test exists to catch.
        self.assertFalse(self.df["body_weight_kg"].notna().any(),
                          "body_weight_kg has values — if real, update this test and document the new source; if not, remove the fabricated data")

    def test_reis_lab_participant_count_unchanged(self):
        # Regression: this MUST still be exactly 14 until a genuinely new
        # dataset (Rustaden/Joao/other) is actually ingested.
        primary = self.df[self.df["data_role"] == "primary_training_target"]
        self.assertEqual(primary["participant_id"].nunique(), 14,
                          "participant count for the primary training target changed — was new data added, or is this a bug?")

    def test_brunelli_rows_flagged_confirmatory_not_primary(self):
        brunelli = self.df[self.df["study_id"] == "brunelli2019"]
        self.assertTrue((brunelli["data_role"] == "confirmatory_only_incompatible_unit").all(),
                         "brunelli2019 rows must stay flagged confirmatory-only, consistent with V1's own treatment")


class TestV1FrozenBenchmark(unittest.TestCase):
    """Checks v2_with_v1_predictions.csv — run
    src/v2/v1_frozen_benchmark.py first if this file doesn't exist yet."""

    @classmethod
    def setUpClass(cls):
        import pandas as pd
        path = Path(__file__).resolve().parents[1] / "data" / "processed" / "v2_with_v1_predictions.csv"
        if not path.exists():
            raise unittest.SkipTest(f"{path} not built yet — run v1_frozen_benchmark.py first")
        cls.df = pd.read_csv(path)

    def test_v1_json_artifact_unchanged_by_this_pipeline(self):
        import json
        model_path = Path(__file__).resolve().parents[1] / "models" / "skos-cal-v1" / "model_v1.json"
        model = json.loads(model_path.read_text(encoding="utf-8"))
        # Same invariant test_pipeline.py already checks — re-asserted here
        # so a V2-pipeline bug that accidentally touched V1 fails loudly.
        met = model["baseline"]["met_by_tier"]["hard"]
        bw = 78.67
        baseline_rate = met * 3.5 * bw / 200
        correction = model["correction_kcal_per_min_by_exercise_and_tier"]["BENCH_PRESS"]["hard"]
        active_rate = baseline_rate + correction
        self.assertEqual(round(active_rate * 10), 114, "model_v1.json's BENCH_PRESS/hard coefficients drifted — V1 must stay frozen")

    def test_v1_predictions_reproduce_published_ballpark(self):
        # Not exact (in-sample vs LOPO differ, documented in the benchmark
        # script) but must be in the right neighborhood, not wildly off.
        rate_rows = self.df[self.df["data_role"] == "primary_training_target"].dropna(subset=["v1_residual"])
        mape = (rate_rows["v1_residual"].abs() / rate_rows["measured_kcal_min"] * 100).mean()
        self.assertLess(mape, 25.0, "in-sample V1 MAPE through the new pipeline should be close to (usually better than) the published 19.1% LOPO figure")
        self.assertGreater(mape, 10.0, "suspiciously low — check for a bug that's leaking the target into the prediction")


if __name__ == "__main__":
    unittest.main()
