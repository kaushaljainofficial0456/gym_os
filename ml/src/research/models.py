"""
Candidate estimators and the gate that decides whether comparing them is
allowed at all.

Nothing here is fitted to real data yet: there is none. The harness exists
so that when criterion sessions arrive, the comparison is run the same
pre-registered way (docs/CALORIE_MODEL_RESEARCH_PLAN.md), and so that it
REFUSES to rank models on too little data -- the failure mode of every
earlier round.

Target everywhere: net kcal for the session (gross minus resting), the same
quantity the app stores as estimated_active_kcal.
"""
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .energy import mifflin_st_jeor_kcal_per_min
from .splits import leave_one_study_out, person_folds

# Pre-registered minimum evidence per comparison level. Counted on real
# (non-synthetic) sessions with a criterion target only.
GATES = {
    # Calibrate the production baseline: is it biased, and by how much?
    'baseline_calibration': dict(people=30, sessions=60, studies=1, per_sex_people=10),
    # Compare baseline vs hierarchical regression (~10 fixed effects).
    'model_comparison': dict(people=60, sessions=200, studies=2, per_sex_people=25),
    # Add tree ensembles: need far more data to beat a structured model honestly.
    'tree_models': dict(people=150, sessions=600, studies=3, per_sex_people=60),
}


@dataclass
class GateResult:
    level: str
    passed: bool
    counts: dict
    shortfalls: list


def check_gate(sessions, level):
    req = GATES[level]
    real = sessions[(~sessions['is_synthetic']) & sessions['target_net_kcal'].notna()]
    counts = dict(people=int(real['person_key'].nunique()), sessions=int(len(real)), studies=int(real['study_id'].nunique()))
    by_sex = real.groupby('sex')['person_key'].nunique()
    counts['per_sex_people'] = int(min(by_sex.get('female', 0), by_sex.get('male', 0)))
    short = [f'{k}: have {counts[k]}, need {v}' for k, v in req.items() if counts[k] < v]
    return GateResult(level, not short, counts, short)


class EvidenceGateError(RuntimeError):
    pass


# ---- candidates ---------------------------------------------------------
RPE_TO_TIER = ((3, 'light'), (6, 'moderate'), (10, 'hard'))
PRODUCTION_MET = {'light': 3.0, 'moderate': 3.5, 'hard': 6.0}  # calorieModel.js INTENSITY_MET


def production_baseline(train, test):
    """The deployed formula, unfitted: Compendium MET by effort, net of
    Mifflin-St Jeor. Session RPE (CR-10) stands in for the app's effort
    question -- an approximation, recorded as such."""
    def tier(rpe):
        if rpe is None or pd.isna(rpe):
            return 'moderate'
        return next(t for cut, t in RPE_TO_TIER if float(rpe) <= cut)
    out = []
    for _, r in test.iterrows():
        gross_min = PRODUCTION_MET[tier(r['session_rpe'])] * 3.5 * r['body_mass_kg'] / 200
        rest_min = mifflin_st_jeor_kcal_per_min(r['body_mass_kg'], r['height_cm'], r['age_years'], r['sex']) or r['body_mass_kg'] * 3.5 / 200
        out.append(max(0.0, (gross_min - rest_min) * r['duration_min']))
    return np.array(out)


def _tier(rpe):
    if rpe is None or pd.isna(rpe):
        return 'moderate'
    return next(t for cut, t in RPE_TO_TIER if float(rpe) <= cut)


def calibrated_baseline(train, test):
    """The production structure with one multiplicative factor per effort
    tier, fitted on the training people only: the smallest change that
    could reach production. A tier absent from training keeps factor 1."""
    factors = {}
    base_tr = production_baseline(None, train)
    tiers_tr = train['session_rpe'].map(_tier).to_numpy()
    y = train['target_net_kcal'].to_numpy()
    for t in PRODUCTION_MET:
        m = tiers_tr == t
        factors[t] = float(y[m].sum() / base_tr[m].sum()) if m.any() and base_tr[m].sum() > 0 else 1.0
    tiers_te = test['session_rpe'].map(_tier).to_numpy()
    return production_baseline(None, test) * np.array([factors[t] for t in tiers_te])


# Separate terms for the seven components in the research plan. Expressed as
# a net RATE (kcal/min) so session length enters once, by multiplication.
FIXED_EFFECTS = ['body_mass_kg', 'age_years', 'is_female', 'work_fraction', 'sets_per_min',
                 'share_compound_lower', 'share_isolation_upper', 'share_isolation_lower', 'mean_load_per_kg']


def _design(frame):
    d = frame.copy()
    d['is_female'] = (d['sex'] == 'female').astype(float)
    d['mean_load_per_kg'] = d['volume_kg'] / d['reps'].replace(0, np.nan) / d['body_mass_kg']
    d['mean_load_per_kg'] = d['mean_load_per_kg'].fillna(0)
    d['net_rate'] = d['target_net_kcal'] / d['duration_min']
    return d


def hierarchical_regression(train, test):
    """Mixed model: net rate ~ fixed effects + random intercept per person.
    Predicts new people from fixed effects only (no peeking at their
    intercept)."""
    import statsmodels.formula.api as smf
    tr, te = _design(train), _design(test)
    # A feature that never varies in the training folds (e.g. no lower-body
    # isolation work anywhere) carries no information and makes the design
    # singular -- drop it rather than let the fit fail or invent a slope.
    # Likewise a feature fully determined by others (composition shares
    # that always sum to 1): keep features only while they add rank.
    used, cols = [], [np.ones(len(tr))]
    for f in FIXED_EFFECTS:
        trial = np.column_stack(cols + [tr[f].to_numpy(dtype=float)])
        if tr[f].nunique() > 1 and np.linalg.matrix_rank(trial) == trial.shape[1]:
            used.append(f)
            cols.append(tr[f].to_numpy(dtype=float))
    formula = 'net_rate ~ ' + (' + '.join(used) if used else '1')
    try:
        fit = smf.mixedlm(formula, tr, groups=tr['person_key']).fit(reml=True, method='lbfgs')
        hierarchical_regression.last_fit = 'mixedlm'
    except np.linalg.LinAlgError:
        # Between-person variance estimated at exactly zero: the mixed
        # model's estimate is then the ordinary least-squares fit.
        fit = smf.ols(formula, tr).fit()
        hierarchical_regression.last_fit = 'ols_zero_person_variance'
    return np.clip(fit.predict(te).to_numpy(), 0, None) * te['duration_min'].to_numpy()


def gradient_boosting(train, test):
    from lightgbm import LGBMRegressor
    tr, te = _design(train), _design(test)
    m = LGBMRegressor(n_estimators=300, learning_rate=0.03, num_leaves=8, min_child_samples=20, verbose=-1)
    m.fit(tr[FIXED_EFFECTS], tr['net_rate'])
    return np.clip(m.predict(te[FIXED_EFFECTS]), 0, None) * te['duration_min'].to_numpy()


CANDIDATES = {
    'production_baseline': ('baseline_calibration', production_baseline),
    'calibrated_baseline': ('baseline_calibration', calibrated_baseline),
    'hierarchical_regression': ('model_comparison', hierarchical_regression),
    'gradient_boosting': ('tree_models', gradient_boosting),
}


def metrics(y, p):
    err = p - y
    return dict(n=int(len(y)), mae_kcal=float(np.mean(np.abs(err))), bias_kcal=float(np.mean(err)),
                mape_pct=float(np.mean(np.abs(err) / y) * 100), bias_pct=float(np.mean(err / y) * 100))


def evaluate(sessions, candidates=CANDIDATES, folds=5, allow_synthetic=False):
    """Person-grouped CV and leave-one-study-out for every candidate whose
    gate passes. With allow_synthetic=True (tests only) gates are evaluated
    on synthetic rows and every result is marked evidence=False."""
    data = sessions[sessions['target_net_kcal'].notna()].reset_index(drop=True)
    if not allow_synthetic:
        data = data[~data['is_synthetic']].reset_index(drop=True)
    gate_view = data.assign(is_synthetic=False) if allow_synthetic else data
    results = {}
    for name, (level, fn) in candidates.items():
        gate = check_gate(gate_view, level)
        if not gate.passed:
            results[name] = dict(ran=False, gate=level, shortfalls=gate.shortfalls, counts=gate.counts)
            continue
        cv_pred = np.full(len(data), np.nan)
        for tr, te in person_folds(data, k=folds):
            cv_pred[te] = fn(data.loc[tr], data.loc[te])
        loso = {}
        if data['study_id'].nunique() >= 2:
            for study, tr, te in leave_one_study_out(data):
                if len(tr):
                    loso[study] = metrics(data.loc[te, 'target_net_kcal'].to_numpy(), fn(data.loc[tr], data.loc[te]))
        results[name] = dict(ran=True, gate=level, counts=gate.counts,
                             person_cv=metrics(data['target_net_kcal'].to_numpy(), cv_pred),
                             leave_one_study_out=loso, evidence=not allow_synthetic)
    return results
