"""
Session table for modelling: one row per session, built only from rows that
passed validation and whose participant consented to the requested use.

Features are kept as SEPARATE quantities -- work time, rest time, density,
composition, load, body size -- because stage 2 showed they are not
interchangeable (docs/CALORIE_OVERHAUL_REPORT.md s5). The target is net
kcal from a criterion measurement; wearable and user figures are carried as
comparison columns, never as targets.
"""
import pandas as pd

from .energy import anaerobic_kcal, gross_kcal_from_gas, mifflin_st_jeor_kcal_per_min, session_components
from .schema import CRITERION_TIERS, EXERCISE_CATEGORIES
from .validate import errors

USES = {'research': 'research_analysis', 'training': 'commercial_model_training'}


def _ts(v):
    return pd.to_datetime(v, utc=True)


def eligible_participants(ds, use):
    """Participants with active consent covering `use` ('research' | 'training')."""
    scope = USES[use]
    c = ds['consents']
    active = c[c['withdrawn_at'].isna() | (c['withdrawn_at'].astype(str).str.strip() == '')] if 'withdrawn_at' in c else c
    ok = active[active['scopes'].astype(str).str.split('|').apply(lambda s: scope in [x.strip() for x in s])]
    return set(ok['participant_id'])


def build_session_table(ds, issues, use='research'):
    bad = {(i.table, i.key) for i in errors(issues)}
    bad_sessions = {k for t, k in bad if t == 'sessions'} | {k.split('/')[0] for t, k in bad if t == 'sets'}
    bad_parts = {k for t, k in bad if t == 'participants'}
    bad_meas = {k for t, k in bad if t == 'measurements'}
    allowed = eligible_participants(ds, use) - bad_parts
    synthetic = set(ds['studies'].loc[ds['studies']['is_synthetic'].astype(int) == 1, 'study_id'])

    parts = ds['participants'].set_index('participant_id')
    studies = ds['studies'].set_index('study_id')
    sets = ds['sets']
    meas = ds['measurements']
    rows = []
    for _, s in ds['sessions'].iterrows():
        sid = s['session_id']
        if sid in bad_sessions or s['participant_id'] not in allowed:
            continue
        p = parts.loc[s['participant_id']]
        start, end = _ts(s['started_at']), _ts(s['ended_at'])
        minutes = (end - start).total_seconds() / 60
        work = sets[(sets['session_id'] == sid) & (~sets['is_warmup'].astype(bool))].copy()
        work['secs'] = (pd.to_datetime(work['set_ended_at'], utc=True) - pd.to_datetime(work['set_started_at'], utc=True)).dt.total_seconds()
        work_min = work['secs'].sum() / 60
        row = dict(
            session_id=sid, study_id=s['study_id'], participant_id=s['participant_id'],
            person_key=p.get('cross_study_key') if isinstance(p.get('cross_study_key'), str) and p.get('cross_study_key') else s['participant_id'],
            is_synthetic=s['study_id'] in synthetic,
            age_years=float(p['age_years']), sex=p['sex'], height_cm=float(p['height_cm']),
            training_status=p.get('training_status'), body_mass_kg=float(s['body_mass_kg']),
            session_rpe=s.get('session_rpe'), session_kind=s['session_kind'],
            duration_min=minutes, work_min=work_min, rest_min=max(0.0, minutes - work_min),
            work_fraction=work_min / minutes if minutes else None,
            sets=len(work), sets_per_min=len(work) / minutes if minutes else None,
            reps=float(work['reps'].sum()), volume_kg=float((work['reps'] * work['load_kg']).sum()),
        )
        row['mean_rest_s'] = (row['rest_min'] * 60 / (len(work) - 1)) if len(work) > 1 else None
        row['relative_volume'] = row['volume_kg'] / row['body_mass_kg']
        for cat in EXERCISE_CATEGORIES:
            row[f'share_{cat}'] = float((work['exercise_category'] == cat).mean()) if len(work) else 0.0

        own = meas[(meas['session_id'] == sid) & (~meas['measurement_id'].isin(bad_meas))]
        crit = own[own['tier'].isin(CRITERION_TIERS) & (own['qc_status'] == 'pass')]
        sess_m = crit[crit['interval'] == 'session']
        base_m = crit[crit['interval'] == 'resting_baseline']
        # Targets (docs/CALORIE_ENERGY_DEFINITIONS.md). target_net_kcal is
        # the product definition -- aerobic net + anaerobic during the
        # session -- and is None unless BOTH were measured; it is never
        # replaced by the aerobic part alone. Post-exercise energy is kept
        # as its own column and is not part of the product target.
        for c in ('target_net_kcal', 'target_gross_kcal', 'target_aerobic_net_kcal', 'target_aerobic_gross_kcal',
                  'target_anaerobic_kcal', 'target_post_exercise_kcal', 'resting_source', 'criterion_tier',
                  'measured_resting_kcal_min', 'session_rer', 'rer_above_1'):
            row[c] = None
        if len(sess_m) == 1:
            m = sess_m.iloc[0]
            measured_rest = None
            if len(base_m):
                b = base_m.iloc[0]
                bmin = (_ts(b['interval_end']) - _ts(b['interval_start'])).total_seconds() / 60
                measured_rest = gross_kcal_from_gas(float(b['vo2_l']), float(b['vco2_l'])) / bmin
            predicted = mifflin_st_jeor_kcal_per_min(row['body_mass_kg'], row['height_cm'], row['age_years'], row['sex'])
            study = studies.loc[s['study_id']]
            anaerobic = None
            if pd.notna(m.get('lactate_pre_mmol')) and pd.notna(m.get('lactate_post_mmol')) and pd.notna(study.get('lactate_o2_equiv_ml_per_kg_per_mmol')):
                anaerobic, _ = anaerobic_kcal(float(m['lactate_pre_mmol']), float(m['lactate_post_mmol']), row['body_mass_kg'],
                                              float(study['lactate_o2_equiv_ml_per_kg_per_mmol']), float(study['lactate_kcal_per_l_o2']),
                                              study['lactate_conversion_source'])
            rec = crit[crit['interval'] == 'recovery_epoc']
            rec_kw = {}
            if len(rec):
                r = rec.iloc[0]
                rec_kw = dict(recovery_vo2_l=float(r['vo2_l']), recovery_vco2_l=float(r['vco2_l']),
                              recovery_minutes=(_ts(r['interval_end']) - _ts(r['interval_start'])).total_seconds() / 60)
            comp = session_components(session_vo2_l=float(m['vo2_l']), session_vco2_l=float(m['vco2_l']), session_minutes=minutes,
                                      resting_kcal_per_min=measured_rest, predicted_resting_kcal_per_min=predicted,
                                      anaerobic=anaerobic, **rec_kw)
            row.update(target_net_kcal=comp['workout_net'], target_gross_kcal=comp['workout_gross'],
                       target_aerobic_net_kcal=comp['aerobic_net'], target_aerobic_gross_kcal=comp['aerobic_gross'],
                       target_anaerobic_kcal=comp['anaerobic'], target_post_exercise_kcal=comp['post_exercise'],
                       resting_source=comp['resting_source'], criterion_tier=m['tier'], measured_resting_kcal_min=measured_rest,
                       session_rer=comp['session_rer'], rer_above_1=comp['rer_above_1'])
        for tier in ('wearable_estimate', 'user_reported', 'model_estimate'):
            other = own[(own['tier'] == tier) & (own['interval'] == 'session')]
            row[f'{tier}_kcal'] = float(other['gross_kcal'].iloc[0]) if len(other) and pd.notna(other['gross_kcal'].iloc[0]) else None
            row[f'{tier}_kind'] = other['reported_kcal_kind'].iloc[0] if len(other) else None
        rows.append(row)
    return pd.DataFrame(rows)
