"""
Export the deployable artifact for skos-cal-v1: Model E (baseline MET
formula + exercise x intensity linear correction), retrained on ALL 14
reis-lab participants (LOPO was for validating the METHOD — Section 24's
"freeze the model" principle means the actual shipped artifact uses all
available data, with generalization already checked separately in
VALIDATION_REPORT.md, not re-checked here).

UNCERTAINTY: uses the CV+/Jackknife+ approach — the 1,001 residuals already
collected across all 14 leave-one-out folds (model_e_lopo_predictions_v0.csv)
are pooled as the calibration set. Each one was genuinely computed on a
participant that specific fold's model never saw, so pooling them is a
legitimate, standard way to calibrate the FINAL model's interval (this is
more data-efficient than an artificial extra train/calibration split,
which was used earlier specifically to PROVE the method isn't circular —
that proof is done; this step reuses its output).

OUTPUT: ml/models/skos-cal-v1/model_v1.json — a plain lookup-table +
coefficients artifact. No pickle, no framework dependency, so it can be
read by literally anything (JS included) without installing scikit-learn
in the backend. Portable per Section 34 (reproducibility).
"""
from pathlib import Path
import sys
import json
from datetime import datetime, timezone

SRC_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SRC_DIR))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from sklearn.linear_model import LinearRegression  # noqa: E402
from sklearn.preprocessing import OneHotEncoder  # noqa: E402

from ontology.exercise_map import EXERCISE_ATTRIBUTES, EXERCISE_VARIANT_NOTES  # noqa: E402
from models.exploratory_correction_v0 import build_feature_frame  # noqa: E402
from baseline.deployed_baseline_benchmark import MET, INTENSITY_MAP  # noqa: E402
from ingestion.reis2017 import COHORT_MEAN_WEIGHT_KG, COHORT_SD_WEIGHT_KG  # noqa: E402

MODELS_DIR = Path(__file__).resolve().parents[2] / "models" / "skos-cal-v1"
PROCESSED_DIR = Path(__file__).resolve().parents[2] / "data" / "processed"

MODEL_VERSION = "skos-cal-v1"
SCHEMA_VERSION = "0.2"  # matches calorie-model-contract.md


def main():
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    df = build_feature_frame()
    df["ex_x_intensity"] = df["exercise_canonical_id"] + "__" + df["mapped_intensity_rating"]

    cols = ["ex_x_intensity", "muscle_group", "compound_or_isolation"]
    enc = OneHotEncoder(handle_unknown="ignore", sparse_output=False)
    X = enc.fit_transform(df[cols].astype(str))
    lr = LinearRegression().fit(X, df["residual"])

    # Convert the fitted linear model into a flat lookup table: for every
    # exercise the pipeline knows about x every intensity tier, precompute
    # the correction value directly (muscle_group/compound_or_isolation are
    # deterministic per exercise, so the whole thing collapses to one
    # number per exercise x intensity pair — simpler to ship than shipping
    # a full one-hot encoder + coefficient vector to a JS runtime).
    correction_lookup = {}
    for ex_id, attrs in EXERCISE_ATTRIBUTES.items():
        correction_lookup[ex_id] = {}
        for tier in ["light", "moderate", "hard"]:
            row = pd.DataFrame([{
                "ex_x_intensity": f"{ex_id}__{tier}",
                "muscle_group": attrs["muscle_group"],
                "compound_or_isolation": attrs["compound_or_isolation"],
            }])
            x = enc.transform(row[cols].astype(str))
            correction_lookup[ex_id][tier] = round(float(lr.predict(x)[0]), 3)

    # Jackknife+ interval offsets — pooled genuine LOPO residuals.
    lopo_path = PROCESSED_DIR / "model_e_lopo_predictions_v0.csv"
    lopo = pd.read_csv(lopo_path)
    intervals = {}
    for target in [0.80, 0.90]:
        alpha = 1 - target
        lo_q = float(lopo["signed_error"].quantile(alpha / 2))
        hi_q = float(lopo["signed_error"].quantile(1 - alpha / 2))
        intervals[str(int(target * 100))] = {"lo_offset_kcal_min": round(lo_q, 3), "hi_offset_kcal_min": round(hi_q, 3)}

    # Merge the documented variant caveats (e.g. BARBELL_SQUAT = half-squat
    # protocol, not a free-weight full-depth squat) directly into the
    # exported artifact — V1_PRE_INTEGRATION_AUDIT.md #7 found this caveat
    # lived only in source docstrings/docs, invisible to anyone reading just
    # the shipped JSON. Purely additive metadata, no attribute values changed.
    exercise_attributes_with_notes = {}
    for ex_id, attrs in EXERCISE_ATTRIBUTES.items():
        entry = dict(attrs)
        entry["data_source_variant_note"] = EXERCISE_VARIANT_NOTES.get(ex_id)
        exercise_attributes_with_notes[ex_id] = entry

    artifact = {
        "model_version": MODEL_VERSION,
        "schema_version": SCHEMA_VERSION,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "trained_on": {
            "participants": int(df["participant_group_id"].nunique()),
            "rows": int(len(df)),
            "datasets": sorted(df["dataset_id"].unique().tolist()),
            "population": "100% male, ages ~20-35, isolated single-exercise lab protocols — see MODEL_CARD.md before trusting outside this population",
        },
        "baseline": {
            "formula": "MET[intensity_tier] * 3.5 * body_weight_kg / 200  (kcal/min rate)",
            "met_by_tier": MET,
        },
        "exercise_attributes": exercise_attributes_with_notes,
        "correction_kcal_per_min_by_exercise_and_tier": correction_lookup,
        "interval_offsets_kcal_per_min": intervals,
        "unmapped_exercise_fallback": {
            "note": "Any exercise_id not in exercise_attributes/correction table: apply the baseline formula with ZERO correction, and widen the interval — never silently guess a correction for an unknown exercise.",
            "widen_interval_factor": 1.5,
        },
        # ---- Added by V1_PRE_INTEGRATION_AUDIT.md fixes (2026-08-16) ----
        # Pure runtime safety metadata: no fitted coefficient above this
        # line was touched to add any of the below. See
        # docs/_v1_audit_fix_diff.txt for a byte-level proof the
        # correction/interval numbers are unchanged from the pre-fix
        # artifact.
        "body_weight_validity": {
            "reference_body_weight_kg": COHORT_MEAN_WEIGHT_KG,
            "reference_body_weight_sd_kg": COHORT_SD_WEIGHT_KG,
            "note": (
                "CRITICAL, not fully fixable without new data: the source studies never "
                "recorded individual participant body weight, only a cohort mean "
                f"({COHORT_MEAN_WEIGHT_KG}kg, SD {COHORT_SD_WEIGHT_KG}kg) — every training-time "
                "baseline prediction used this SAME constant weight for all 14 participants, "
                "so the correction terms cannot reflect any real body-weight scaling "
                "relationship, even in principle. Runtime should flag/widen when the actual "
                "user's body_weight_kg falls outside [flag_below_kg, flag_above_kg] below. "
                "A real fix requires new data with individual weights (Phase 9 calibration "
                "cohort), not a retrain on the existing data."
            ),
            "flag_below_kg": round(COHORT_MEAN_WEIGHT_KG - 2 * COHORT_SD_WEIGHT_KG, 1),
            "flag_above_kg": round(COHORT_MEAN_WEIGHT_KG + 2 * COHORT_SD_WEIGHT_KG, 1),
        },
        "plausibility_guardrails": {
            "min_active_rate_met": 1.30,
            "min_active_rate_rationale": (
                "Lowest resistance-exercise MET independently measured in any source we hold "
                "(Adeel et al. 2021, shoulder press, untrained group, Cortex Metalyzer 3B). "
                "Acts as a floor symmetric with max_active_rate_kcal_min: a negative correction "
                "must never drive the estimate below the least demanding resistance exercise "
                "ever measured. Does not trigger anywhere in the 45-125kg estimable range "
                "(verified) - it is insurance against unenumerated exercise/tier/weight "
                "combinations, not an active adjustment."
            ),
            "max_active_rate_kcal_min": 20.0,
            "rationale": (
                "Conservative sustained-rate ceiling (~20-24 kcal/min is roughly the range "
                "elite endurance athletes sustain at near-maximal aerobic power). Hard-tier "
                "(80%1RM) corrections were fit on 26-56 SECOND near-maximal single bouts (see "
                "DATA_AUDIT.md row 7), never validated as a sustainable per-minute rate. "
                "V1_PRE_INTEGRATION_AUDIT.md #3/#4/#5/#6: without this cap, BARBELL_SQUAT hard "
                "alone computes to 36.2 kcal/min at cohort-mean body weight. This is a safety "
                "net, not a scientific fix — it prevents physiologically-impossible numbers "
                "from reaching a user; it does not make the underlying rate accurate for long "
                "durations. Real fix needs real multi-set session data (Phase 9)."
            ),
        },
        # ---- Added 2026-08-17: hard gating bounds (free actions 2 & 3) ----
        # These convert two documented WARNINGS into REFUSALS. Outside these
        # bounds mlEstimate throws, and the caller's existing baseline-fallback
        # path handles it -- baseline is less accurate but never implausible,
        # whereas the correction demonstrably IS implausible out here
        # (SKOS_CALORIE_MODEL_VALIDATION_CALIBRATION_REPORT.md sections 3 and 4).
        # No fitted coefficient is involved; this is a scope restriction.
        # TWO-TIER SCOPE (2026-08-17, widened on product decision):
        #   validated_range -> full confidence; inside the evidence base.
        #   estimable_range -> hard gate; ML refuses beyond it and the caller's
        #                      baseline fallback takes over.
        # Between the two, ML still runs but confidence is downgraded and the
        # reason is surfaced -- the estimate stays physically plausible there,
        # it is simply outside what the evidence covers. Widening the OUTER
        # bound is a product call; the INNER bound stays evidence-anchored so
        # the distinction never gets lost.
        "validated_range": {
            "body_weight_kg": {
                "min": round(COHORT_MEAN_WEIGHT_KG - 2 * COHORT_SD_WEIGHT_KG, 1),
                "max": round(COHORT_MEAN_WEIGHT_KG + 2 * COHORT_SD_WEIGHT_KG, 1),
            },
            "duration_minutes": {"min": 1, "max": 120},
            "rationale": (
                "Body weight: training cohort mean +/- 2SD. Duration: 120min is the longest "
                "resistance session with ANY independent whole-session measurement behind it "
                "(Adeel 2021 116min; Joao 2021 116min). Inside these bounds the estimate sits "
                "within the evidence base."
            ),
        },
        "estimable_range": {
            "body_weight_kg": {
                "min": 45.0,
                "max": 125.0,
                "rationale": (
                    "Both bounds widened by product decision beyond the validated band. "
                    "Checked before accepting: at 45kg the WORST-CASE combination (most negative "
                    "correction, 60-min session) still implies 1.70-1.91 METs, which is ABOVE the "
                    "lowest resistance-exercise MET independently measured in any source we hold "
                    "(1.30, Adeel 2021 shoulder press, untrained). So 45kg output is low but "
                    "physiologically defensible. Below ~40kg it is not: the constant correction "
                    "dominates (-213% of net) and sessions clamp toward zero, which is why the "
                    "hard floor sits at 45 and not lower. On the upper side the correction's "
                    "relative influence SHRINKS as weight rises (-28% of net at 125kg vs -53% at "
                    "the 78.67kg fit weight), so plausibility is not the binding constraint there. "
                    "45-57.3kg and 100.1-125kg are allowed but confidence-downgraded."
                ),
            },
            "duration_minutes": {
                "min": 1,
                "max": 150.0,
                "rationale": (
                    "Extended to 150min by product decision to cover genuine long sessions "
                    "(2-2.5h powerlifting/bodybuilding work is real). 120-150min has NO external "
                    "corroboration -- the flat-rate assumption is least reliable there and most "
                    "likely to over-estimate, since rest accumulates. Allowed but "
                    "confidence-downgraded; beyond 150min ML refuses."
                ),
            },
        },
        "external_plausibility_envelope_kcal_min_per_kg": {
            "min": 0.0593,
            "max": 0.0665,
            "note": (
                "Independent whole-session measurements, normalised per kg so body weight cancels: "
                "Rustaden 2020 (0.0593), Benito 2016 (0.0603), Adeel 2021 (0.0598), Nakagata 2019 "
                "(0.0630-0.0665). Four labs, four countries. A session-level estimate outside this "
                "band is not necessarily wrong, but is outside everything independently measured -- "
                "used to downgrade confidence, never to alter the estimate. "
                "See scripts/external_plausibility_envelope.py."
            ),
        },
        "source_measured_bout_duration_minutes": {
            "hard": 1.0,
            "moderate": 5.0,
            "light": 5.0,
            "note": (
                "Longest continuous single-intensity bout actually measured in the source "
                "studies, per tier (DATA_AUDIT.md row 7: reis2017 4-5min/26-56s, reis2019 "
                "4x4min). 'hard' rounds the 26-56s 80%1RM bouts up to 1 minute, conservatively. "
                "Any session duration beyond this, for an exercise/tier combination present in "
                "the session, is extrapolation beyond what was directly measured — flagged via "
                "`note` and widened at runtime, not silently presented as equally certain."
            ),
        },
    }

    out_path = MODELS_DIR / "model_v1.json"
    out_path.write_text(json.dumps(artifact, indent=2), encoding="utf-8")
    print(f"Wrote {out_path}")
    print(json.dumps(artifact, indent=2)[:2000], "...")


if __name__ == "__main__":
    main()
