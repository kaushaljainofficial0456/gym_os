"""
Tests for Phase G's residual-model code and the future-dataset ingestion
interface. These check the CODE is correct, not that a V2 model exists —
several tests explicitly assert the export guard refuses to run, which is
the correct behavior right now, not a failure.
"""
import sys
import unittest
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_DIR))

from v2.residual_model import (  # noqa: E402
    FEATURES_CURRENTLY_AVAILABLE, CATEGORICAL_FEATURES, NUMERIC_FEATURES,
    TARGET_COLUMN, fit_and_save_v2_model, lopo_evaluate, load_training_frame,
)
from v2.ingestion_interface import PENDING_DATASETS, validate_and_report  # noqa: E402


class TestResidualModelFeatureSafety(unittest.TestCase):
    def test_no_target_column_in_feature_list(self):
        # Section 2's hard rule, re-asserted directly against the actual
        # feature lists this module will train on.
        self.assertNotIn(TARGET_COLUMN, CATEGORICAL_FEATURES + NUMERIC_FEATURES)
        self.assertNotIn("measured_kcal_min", CATEGORICAL_FEATURES + NUMERIC_FEATURES)
        self.assertNotIn("measured_kcal", CATEGORICAL_FEATURES + NUMERIC_FEATURES)

    def test_current_feature_set_is_subset_of_intended(self):
        from v2.residual_model import FEATURES_INTENDED_ONCE_NEW_DATA_ARRIVES
        self.assertTrue(set(FEATURES_CURRENTLY_AVAILABLE).issubset(set(FEATURES_INTENDED_ONCE_NEW_DATA_ARRIVES)))


class TestExportGuard(unittest.TestCase):
    def test_refuses_without_explicit_authorization(self):
        with self.assertRaises(RuntimeError):
            fit_and_save_v2_model(independent_participant_count=5)  # authorized defaults False

    def test_refuses_with_zero_independent_participants_even_if_authorized(self):
        with self.assertRaises(RuntimeError):
            fit_and_save_v2_model(independent_participant_count=0, authorized=True)

    def test_no_v2_model_artifact_exists_on_disk(self):
        # The single most important guardrail this whole phase exists to
        # enforce: nothing should have been saved yet.
        v2_dir = Path(__file__).resolve().parents[1] / "models" / "skos-cal-v2"
        if v2_dir.exists():
            model_files = list(v2_dir.glob("model_v2.*"))
            self.assertEqual(len(model_files), 0, "A V2 model artifact exists on disk — this should not happen until real independent data is acquired")


class TestLOPOCodePath(unittest.TestCase):
    """Proves the participant-grouped CV code is mechanically correct —
    NOT that its numbers represent a valid V2 result (they don't; see
    residual_model.py's own docstring)."""

    @classmethod
    def setUpClass(cls):
        try:
            cls.df = load_training_frame()
        except FileNotFoundError:
            raise unittest.SkipTest("v2_with_v1_predictions.csv not built yet — run v1_frozen_benchmark.py first")

    def test_no_participant_appears_in_both_train_and_test_within_a_fold(self):
        from sklearn.model_selection import LeaveOneGroupOut
        groups = self.df["participant_id"].to_numpy()
        logo = LeaveOneGroupOut()
        for train_idx, test_idx in logo.split(self.df, groups=groups):
            train_participants = set(self.df.iloc[train_idx]["participant_id"])
            test_participants = set(self.df.iloc[test_idx]["participant_id"])
            self.assertEqual(len(train_participants & test_participants), 0)

    def test_lopo_evaluate_runs_and_returns_one_row_per_fold(self):
        res = lopo_evaluate(self.df, "V2_Linear")
        n_participants = self.df["participant_id"].nunique()
        self.assertEqual(len(res), n_participants, "expected one result row per LOPO fold (one per participant)")


class TestIngestionInterface(unittest.TestCase):
    def test_pending_datasets_are_all_gold_or_silver_only(self):
        for module in PENDING_DATASETS:
            self.assertIn(module.GOLD_SILVER_STATUS, ("GOLD", "SILVER"),
                           f"{module.STUDY_ID} has status {module.GOLD_SILVER_STATUS} — AUXILIARY/EXCLUDE must never be registered as a pending training dataset")

    def test_pending_datasets_all_correctly_report_blocked(self):
        # Honest-state check: as of now, every pending module MUST report
        # blocked (not implemented) — if this ever flips true without a
        # real raw file behind it, that's exactly the fabrication these
        # tests exist to catch.
        for module in PENDING_DATASETS:
            report = validate_and_report(module)
            self.assertFalse(report["passed"], f"{module.STUDY_ID} reports passed=True — verify this isn't a fabricated/stubbed load()")

    def test_every_pending_dataset_states_what_file_is_needed(self):
        for module in PENDING_DATASETS:
            self.assertIsNotNone(module.RAW_FILE_REQUIRED)
            self.assertGreater(len(module.RAW_FILE_REQUIRED), 10)


class TestPhase9CalibrationIngestion(unittest.TestCase):
    """Tests for the Phase 9 arrival checks. Written BEFORE the data exists,
    deliberately — so the gate is proven correct while there is no pressure
    to let something through. Synthetic frames here are TEST FIXTURES for
    validation logic, never training data (they never touch the pipeline)."""

    @classmethod
    def setUpClass(cls):
        from v2.calibration_cohort_ingestion import CalibrationCohortV1
        cls.module = CalibrationCohortV1

    def _good_frame(self):
        import pandas as pd
        # 20 participants, 40% women, individual body weights, realistic durations
        rows = []
        for i in range(20):
            rows.append({
                "participant_id": f"skos_calib_p{i:03d}",
                "body_weight_kg": 55.0 + i * 2.0,
                "measurement_device": "COSMED K5",
                "duration_minutes": 45.0,
                "sex": "female" if i < 8 else "male",
            })
        return pd.DataFrame(rows)

    def test_load_refuses_until_real_data_exists(self):
        with self.assertRaises(NotImplementedError):
            self.module.load()

    def test_module_is_registered_as_gold_by_design(self):
        self.assertEqual(self.module.GOLD_SILVER_STATUS, "GOLD")
        self.assertIn("phase9", self.module.RAW_FILE_REQUIRED.lower())

    def test_gold_criteria_pass_on_a_conforming_frame(self):
        from v2.calibration_cohort_ingestion import verify_gold_criteria
        checks = verify_gold_criteria(self._good_frame())
        for name, (passed, detail) in checks.items():
            self.assertTrue(passed, f"{name} failed on a frame that should pass: {detail}")

    def test_missing_individual_body_weight_is_caught(self):
        # The single most important check — this is V1's biggest defect (#13).
        from v2.calibration_cohort_ingestion import verify_gold_criteria
        df = self._good_frame()
        df.loc[0, "body_weight_kg"] = None
        checks = verify_gold_criteria(df)
        self.assertFalse(checks["individual_body_weight_present"][0])

    def test_too_few_participants_is_caught(self):
        from v2.calibration_cohort_ingestion import verify_gold_criteria
        df = self._good_frame().head(10)
        checks = verify_gold_criteria(df)
        self.assertFalse(checks["minimum_viable_sample"][0])

    def test_all_male_cohort_is_caught(self):
        from v2.calibration_cohort_ingestion import verify_gold_criteria
        df = self._good_frame()
        df["sex"] = "male"
        checks = verify_gold_criteria(df)
        self.assertFalse(checks["women_represented"][0],
                          "an all-male cohort would repeat V1's defining limitation and must fail")

    def test_short_bout_sessions_are_caught(self):
        # Guards against accidentally reproducing the reis-lab isolated-bout
        # limitation instead of fixing it (audit #3).
        from v2.calibration_cohort_ingestion import verify_gold_criteria
        df = self._good_frame()
        df["duration_minutes"] = 4.0
        checks = verify_gold_criteria(df)
        self.assertFalse(checks["sessions_are_realistic_length"][0])

    def test_v1_cohort_namespace_collision_is_caught(self):
        from v2.calibration_cohort_ingestion import verify_no_v1_cohort_contamination
        df = self._good_frame()
        df.loc[0, "participant_id"] = "reis_lab_p1"
        passed, detail = verify_no_v1_cohort_contamination(df)
        self.assertFalse(passed, detail)

    def test_clean_namespace_passes_contamination_check(self):
        from v2.calibration_cohort_ingestion import verify_no_v1_cohort_contamination
        passed, _ = verify_no_v1_cohort_contamination(self._good_frame())
        self.assertTrue(passed)

    def test_session_alignment_catches_unmatched_sessions(self):
        import pandas as pd
        from v2.calibration_cohort_ingestion import verify_session_alignment
        lab = pd.DataFrame([{"calibration_participant_id": "p1", "session_id": "s1",
                              "started_at": "2026-09-01T10:00:00Z", "ended_at": "2026-09-01T10:45:00Z"}])
        app = pd.DataFrame([{"calibration_participant_id": "p1", "session_id": "s2",  # mismatched id
                              "started_at": "2026-09-01T10:00:00Z", "ended_at": "2026-09-01T10:45:00Z",
                              "clock_offset_seconds": 0}])
        result = verify_session_alignment(lab, app)
        self.assertFalse(result["passed"])
        self.assertTrue(any("only one file" in i for i in result["issues"]))

    def test_session_alignment_catches_excessive_clock_drift(self):
        import pandas as pd
        from v2.calibration_cohort_ingestion import verify_session_alignment
        lab = pd.DataFrame([{"calibration_participant_id": "p1", "session_id": "s1",
                              "started_at": "2026-09-01T10:00:00Z", "ended_at": "2026-09-01T10:45:00Z"}])
        app = pd.DataFrame([{"calibration_participant_id": "p1", "session_id": "s1",
                              "started_at": "2026-09-01T11:30:00Z",  # 90 min off, offset unrecorded
                              "ended_at": "2026-09-01T12:15:00Z", "clock_offset_seconds": 0}])
        result = verify_session_alignment(lab, app)
        self.assertFalse(result["passed"])
        self.assertTrue(any("drift" in i for i in result["issues"]))

    def test_session_alignment_passes_when_offset_is_recorded(self):
        import pandas as pd
        from v2.calibration_cohort_ingestion import verify_session_alignment
        lab = pd.DataFrame([{"calibration_participant_id": "p1", "session_id": "s1",
                              "started_at": "2026-09-01T10:00:30Z", "ended_at": "2026-09-01T10:45:00Z"}])
        app = pd.DataFrame([{"calibration_participant_id": "p1", "session_id": "s1",
                              "started_at": "2026-09-01T10:00:00Z", "ended_at": "2026-09-01T10:45:00Z",
                              "clock_offset_seconds": 30}])
        result = verify_session_alignment(lab, app)
        self.assertTrue(result["passed"], result["issues"])


if __name__ == "__main__":
    unittest.main()
