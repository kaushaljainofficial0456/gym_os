"""
PHASE G — V2 residual-model training code.

ARCHITECTURE (exactly as specified):
    baseline_prediction  ->  V1 CORRECTION (frozen model_v1.json)  ->  v1_prediction
    v1_residual = measured_ground_truth - v1_prediction              <- V2's target
    v2_residual_prediction = f(features)                              <- what V2 learns
    final_v2_prediction = v1_prediction + v2_residual_prediction

This module is CODE, reviewed and smoke-tested, not a trained production
model. `fit_and_save_v2_model()` at the bottom is guarded and will refuse
to run against the current data — see its docstring. Nothing in this file
writes to ml/models/skos-cal-v2/ when imported or when __main__ runs;
that only happens if someone deliberately calls the guarded function AND
the independent-participant check passes.
"""
from pathlib import Path
import sys

SRC_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SRC_DIR))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from sklearn.linear_model import LinearRegression  # noqa: E402
from sklearn.ensemble import RandomForestRegressor  # noqa: E402
from sklearn.model_selection import LeaveOneGroupOut  # noqa: E402
from sklearn.preprocessing import OneHotEncoder  # noqa: E402

from v2.schema import validate_no_target_leakage  # noqa: E402

DATA_PATH = Path(__file__).resolve().parents[2] / "data" / "processed" / "v2_with_v1_predictions.csv"

# ============================================================
# FEATURE SPEC — Section 12 of the master prompt, cross-checked against
# what's ACTUALLY populated in the current canonical dataset vs. what a
# real production inference call could provide. Two lists, deliberately
# kept separate so nobody accidentally trains against a feature that
# doesn't exist at inference time.
# ============================================================

# Features usable RIGHT NOW, with the CURRENT data (reis-lab only). This
# is the only list this module will actually train against until new
# data arrives — and it's worth being honest about what it reduces to:
FEATURES_CURRENTLY_AVAILABLE = [
    "v1_prediction_kcal_min",   # V1's own output — the residual architecture's core input
    "exercise_id",               # categorical
    "muscle_group",               # categorical
    "compound_or_isolation",      # categorical
    "movement_pattern",           # categorical
    "intensity_tier",             # categorical (light/moderate/hard)
]
# NOTE, stated plainly: this is almost exactly the feature set V1's own
# Model E already used (exercise x intensity + muscle_group/compound).
# There is no NEW information in the current data beyond what V1 already
# exploited — reinforcing why Phase G can't produce a meaningfully
# different result without new data. Not a design flaw in this module;
# an honest description of the current data's actual information content.

# Features the INTENDED V2 architecture wants, populated only once new
# datasets (Rustaden/Joao/future) actually provide them. Do not use these
# until schema.py's DATA_FIELDS shows real (non-null) values.
FEATURES_INTENDED_ONCE_NEW_DATA_ARRIVES = FEATURES_CURRENTLY_AVAILABLE + [
    "body_weight_kg",        # REAL individual weight — V1's single biggest gap (Section 13)
    "sex",                    # real per-participant, not cohort-constant (Rustaden=100% women changes this from a constant to a real signal)
    "age",                    # real individual age
    "training_status",        # real signal once populations with actual variation exist (Joao=trained-only, current data=mixed)
    "duration_minutes",        # REAL per-session duration — current reis-lab data only has protocol-level constants, not true per-row variation
    "sets", "reps", "total_volume_kg",   # multi-exercise session structure — absent entirely in current single-bout data
    "density",                  # volume/time — needs duration+volume together, neither reliably available yet
]

TARGET_COLUMN = "v1_residual"  # = measured_kcal_min - v1_prediction_kcal_min, already computed by v1_frozen_benchmark.py

CATEGORICAL_FEATURES = ["exercise_id", "muscle_group", "compound_or_isolation", "movement_pattern", "intensity_tier"]
NUMERIC_FEATURES = ["v1_prediction_kcal_min"]


def load_training_frame() -> pd.DataFrame:
    df = pd.read_csv(DATA_PATH)
    df = df[df["data_role"] == "primary_training_target"].copy()
    df = df.dropna(subset=[TARGET_COLUMN] + FEATURES_CURRENTLY_AVAILABLE)
    return df


def _design_matrix(df: pd.DataFrame, encoder: OneHotEncoder, fit: bool) -> np.ndarray:
    cats = df[CATEGORICAL_FEATURES].astype(str)
    if fit:
        cat_arr = encoder.fit_transform(cats)
    else:
        cat_arr = encoder.transform(cats)
    num_arr = df[NUMERIC_FEATURES].to_numpy(dtype=float)
    return np.hstack([cat_arr, num_arr])


# Pluggable model registry — Section 14/15's comparison table. XGBoost/
# LightGBM/CatBoost are NOT installed (requirements.txt deliberately
# excludes them, same discipline as V1 — "only if simpler models fail
# AND n justifies it"). Listed here as documented-not-installed so the
# comparison table's shape is ready; adding them later is a one-line
# registry entry once real justification exists, not a redesign.
MODEL_REGISTRY = {
    "V2_Linear": lambda: LinearRegression(),
    "V2_RandomForest": lambda: RandomForestRegressor(n_estimators=200, max_depth=4, min_samples_leaf=5, random_state=0),
    # "V2_XGBoost": NOT INSTALLED — requirements.txt excludes it pending real justification
    # "V2_LightGBM": NOT INSTALLED — same
    # "V2_CatBoost": NOT INSTALLED — same
}


def metrics(measured: np.ndarray, predicted: np.ndarray) -> dict:
    err = predicted - measured
    abs_err = np.abs(err)
    mae = abs_err.mean()
    rmse = np.sqrt((err ** 2).mean())
    mape = (abs_err / measured * 100).mean()
    ss_res = (err ** 2).sum()
    ss_tot = ((measured - measured.mean()) ** 2).sum()
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else float("nan")
    return {"MAE": round(float(mae), 3), "RMSE": round(float(rmse), 3), "MAPE": round(float(mape), 2), "R2": round(float(r2), 3)}


def lopo_evaluate(df: pd.DataFrame, model_name: str) -> pd.DataFrame:
    """Participant-grouped Leave-One-Out — no participant ever appears in
    both train and test within a fold. This is the CV strategy for every
    model in MODEL_REGISTRY, current data or future."""
    # Hard guard: refuse to run if any target-leaking column snuck into
    # the feature list (Section 2's rule, enforced in code not just prose).
    offenders = validate_no_target_leakage(CATEGORICAL_FEATURES + NUMERIC_FEATURES)
    if offenders:
        raise ValueError(f"Target leakage detected in feature list: {offenders} — refusing to train")

    groups = df["participant_id"].to_numpy()
    logo = LeaveOneGroupOut()
    rows = []
    model_fn = MODEL_REGISTRY[model_name]

    for train_idx, test_idx in logo.split(df, groups=groups):
        train, test = df.iloc[train_idx], df.iloc[test_idx]
        enc = OneHotEncoder(handle_unknown="ignore", sparse_output=False)
        X_train = _design_matrix(train, enc, fit=True)
        X_test = _design_matrix(test, enc, fit=False)

        model = model_fn()
        model.fit(X_train, train[TARGET_COLUMN].to_numpy())
        pred_residual = model.predict(X_test)

        final_v2_pred = test["v1_prediction_kcal_min"].to_numpy() + pred_residual
        measured = test["measured_kcal_min"].to_numpy()

        held_out_participant = test["participant_id"].iloc[0]
        rows.append({
            "held_out_participant": held_out_participant,
            "model": model_name,
            "n": len(test),
            "mae": np.abs(final_v2_pred - measured).mean(),
            "mape": (np.abs(final_v2_pred - measured) / measured * 100).mean(),
            "bias": (final_v2_pred - measured).mean(),
        })
    return pd.DataFrame(rows)


def smoke_test_on_current_data() -> dict:
    """Proves the Phase G code path is correct — LOPO splitting works,
    features build cleanly, no leakage, models fit and predict, metrics
    compute sanely. Runs on the ONLY data currently available: the
    identical 14 reis-lab participants V1 already used.

    THIS IS NOT A V2 RESULT. Running LOPO on the same population V1 was
    already validated on cannot demonstrate improved generalization —
    there is no new held-out population here. Reported explicitly as a
    code-verification smoke test, exactly like the Phase E/F pipeline
    check, never as a V2 accuracy claim.
    """
    df = load_training_frame()
    results = {}
    for model_name in MODEL_REGISTRY:
        res = lopo_evaluate(df, model_name)
        # Weighted mean of per-fold MAE/MAPE/bias (weighted by fold size),
        # consistent with V1's own reporting style in exploratory_correction_v0.py.
        agg = {
            "MAE": round(float(np.average(res["mae"], weights=res["n"])), 3),
            "MAPE": round(float(np.average(res["mape"], weights=res["n"])), 2),
            "bias": round(float(np.average(res["bias"], weights=res["n"])), 3),
        }
        results[model_name] = agg
    return results


def fit_and_save_v2_model(independent_participant_count: int, authorized: bool = False):
    """GUARDED — this is the only function in this module that could ever
    write a production V2 artifact, and it refuses to unless BOTH:
      1. authorized=True is passed explicitly (not a default), AND
      2. independent_participant_count > 0 (i.e. at least one participant
         from a study OTHER than the existing reis-lab 14 is in the
         training frame).
    As of this write, calling this with the real current data would fail
    check 2 — there are 0 independent participants. That's not a bug,
    it's the whole point of this guard.
    """
    if not authorized:
        raise RuntimeError("fit_and_save_v2_model() requires authorized=True — refusing to run silently")
    if independent_participant_count <= 0:
        raise RuntimeError(
            "REFUSED: 0 independent participants beyond the existing V1 cohort. "
            "Training and saving a 'V2' model on the identical 14 people V1 already "
            "used would misrepresent what V2 is. See V2_VALIDATION_REPORT.md."
        )
    raise NotImplementedError(
        "Export path intentionally not implemented yet — write this only once the guard "
        "above can legitimately pass, at which point mirror export_model_v1.py's pattern "
        "(plain JSON lookup/coefficients artifact, no framework dependency at inference time)."
    )


if __name__ == "__main__":
    print("=== Phase G smoke test — code-path verification ONLY, NOT a V2 result ===")
    print(f"Feature set in use (current data): {FEATURES_CURRENTLY_AVAILABLE}")
    print(f"Feature set intended once new data arrives: {FEATURES_INTENDED_ONCE_NEW_DATA_ARRIVES}")
    print()
    results = smoke_test_on_current_data()
    df = load_training_frame()
    for name, m in results.items():
        print(f"{name}: MAE={m['MAE']}  MAPE={m['MAPE']}%  bias={m['bias']}")
    print()
    print("Reference — frozen V1 alone (from baseline_and_v1_lopo_benchmark.py, in-sample): MAPE 18.36%")
    print("Reference — V1's own genuinely out-of-sample LOPO MAPE (VALIDATION_REPORT.md): 19.1%")
    print()
    print("These V2-code MAPE numbers are computed via genuine LOPO on the SAME 14 participants V1 used —")
    print("technically out-of-sample within this population, but NOT a demonstration of improved")
    print("generalization to anyone new, because there is no one new in this run. Not a V2 result.")
    print()
    print(f"Independent participants beyond the V1 cohort in this run: 0")
    try:
        fit_and_save_v2_model(independent_participant_count=0, authorized=True)
    except RuntimeError as e:
        print(f"fit_and_save_v2_model() correctly refused: {e}")
