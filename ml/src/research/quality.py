"""
Dataset quality report and distribution-shift checks.

Counts are of INDEPENDENT units: people (by cross-study key when a site
supplies one), studies, sites and sessions. Synthetic fixture studies are
reported separately and never counted as evidence.
"""
import numpy as np
import pandas as pd

from .schema import CRITERION_TIERS, EXERCISE_CATEGORIES, TABLES
from .validate import errors


def missingness(ds):
    out = {}
    for table, frame in ds.items():
        if table not in TABLES or not len(frame):
            continue
        out[table] = {c['name']: float(frame[c['name']].isna().mean()) if c['name'] in frame else 1.0 for c in TABLES[table]}
    return out


def quality_report(ds, issues, sessions):
    """`sessions` is features.build_session_table(...) output."""
    real = sessions[~sessions['is_synthetic']] if len(sessions) else sessions
    with_target = real[real['target_net_kcal'].notna()] if len(real) else real
    studies = ds['studies']
    meas = ds['measurements']
    crit = meas[meas['tier'].isin(CRITERION_TIERS)]
    rep = {
        'independent_people': int(with_target['person_key'].nunique()) if len(with_target) else 0,
        'participant_ids': int(with_target['participant_id'].nunique()) if len(with_target) else 0,
        'studies': int(with_target['study_id'].nunique()) if len(with_target) else 0,
        'sites': int(studies[studies['study_id'].isin(with_target.get('study_id', []))]['site'].nunique()) if len(with_target) else 0,
        'sessions_total': int(len(real)),
        'sessions_with_criterion_target': int(len(with_target)),
        'sessions_net_from_measured_resting': int((with_target['resting_source'] == 'measured').sum()) if len(with_target) else 0,
        'synthetic_sessions_excluded': int(sessions['is_synthetic'].sum()) if len(sessions) else 0,
        'sex': with_target.groupby('sex')['person_key'].nunique().to_dict() if len(with_target) else {},
        'training_status': with_target.groupby('training_status')['person_key'].nunique().to_dict() if len(with_target) else {},
        'age_bands': (pd.cut(with_target['age_years'], [0, 30, 45, 60, 120], labels=['<30', '30-44', '45-59', '60+'])
                      .value_counts().sort_index().to_dict()) if len(with_target) else {},
        'session_kinds': with_target['session_kind'].value_counts().to_dict() if len(with_target) else {},
        'exercise_coverage_sessions': {c: int((with_target[f'share_{c}'] > 0).sum()) for c in EXERCISE_CATEGORIES} if len(with_target) else {},
        'measurement_tiers': meas['tier'].value_counts().to_dict(),
        'criterion_qc': crit['qc_status'].value_counts().to_dict(),
        'errors': len(errors(issues)),
        'warnings': len([i for i in issues if i.severity == 'warning']),
        'error_rules': pd.Series([i.rule for i in errors(issues)]).value_counts().to_dict() if errors(issues) else {},
        'missingness': missingness(ds),
    }
    dup = with_target.groupby('person_key')['study_id'].nunique() if len(with_target) else pd.Series(dtype=int)
    rep['people_in_more_than_one_study'] = int((dup > 1).sum())
    return rep


def psi(reference, current, bins=10):
    """Population stability index of one numeric feature. Bins come from the
    reference's quantiles. < 0.1 little shift, 0.1-0.25 moderate, > 0.25 large."""
    ref = pd.Series(reference).dropna().astype(float)
    cur = pd.Series(current).dropna().astype(float)
    if len(ref) < bins or not len(cur):
        return None
    edges = np.unique(np.quantile(ref, np.linspace(0, 1, bins + 1)))
    if len(edges) < 3:
        return None
    edges[0], edges[-1] = -np.inf, np.inf
    r = np.histogram(ref, edges)[0] / len(ref)
    c = np.histogram(cur, edges)[0] / len(cur)
    r, c = np.clip(r, 1e-4, None), np.clip(c, 1e-4, None)
    return float(np.sum((c - r) * np.log(c / r)))


SHIFT_FEATURES = ('age_years', 'body_mass_kg', 'duration_min', 'sets', 'sets_per_min', 'mean_rest_s', 'relative_volume')


def distribution_shift(research_sessions, app_sessions, features=SHIFT_FEATURES):
    """PSI per feature between the research sample (reference) and app
    sessions -- where the population the model would serve differs from the
    population it was measured on. App sessions come from an aggregate,
    de-identified export; this function never reads the production DB."""
    out = {}
    for f in features:
        if f in research_sessions and f in app_sessions:
            v = psi(research_sessions[f], app_sessions[f])
            out[f] = None if v is None else dict(psi=round(v, 3), level='large' if v > 0.25 else 'moderate' if v > 0.1 else 'small')
    return out
