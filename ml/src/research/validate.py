"""
Validation rules for the calorimetry research dataset.

`validate(ds)` takes {table_name: pandas.DataFrame} and returns a list of
Issue. Severity 'error' means the row must not be used; 'warning' means it
may be used but the problem is recorded in the quality report.

Rules are deliberately strict: a research row that cannot show where it
came from, who consented to what, or that its timing and gas exchange are
physically coherent is excluded rather than repaired.
"""
import re
from dataclasses import dataclass

import pandas as pd

from .energy import RER_PLAUSIBLE, gross_kcal_from_gas
from .schema import CRITERION_TIERS, FORBIDDEN_COLUMNS, TABLE_KEYS, TABLES

PSEUDONYM = re.compile(r'^P-[A-Z0-9]{6,16}$')
BOUNDARY_TOLERANCE_S = 60       # session interval vs first/last working set
MAX_SET_SECONDS = 600
MIN_SECONDS_PER_REP = 0.5
SESSION_MINUTES = (5, 240)
MIN_RESTING_BASELINE_MIN = 5
WEIR_TOLERANCE = 0.02


@dataclass(frozen=True)
class Issue:
    table: str
    key: str
    rule: str
    severity: str
    message: str


def _ts(v):
    return pd.to_datetime(v, utc=True, errors='coerce')


def _blank(v):
    return v is None or (isinstance(v, float) and pd.isna(v)) or (isinstance(v, str) and not v.strip()) or v is pd.NaT


def _key(table, row):
    return '/'.join(str(row.get(k)) for k in TABLE_KEYS[table])


def _columns(ds, out):
    for table, frame in ds.items():
        if table not in TABLES:
            out.append(Issue(table, '-', 'unknown_table', 'error', f'unexpected table {table}'))
            continue
        bad = [c for c in frame.columns if c.lower() in FORBIDDEN_COLUMNS]
        for c in bad:
            out.append(Issue(table, '-', 'direct_identifier', 'error', f'column "{c}" is a direct identifier and must not be in this dataset'))
        spec = {c['name']: c for c in TABLES[table]}
        for c in frame.columns:
            if c not in spec and c.lower() not in FORBIDDEN_COLUMNS:
                out.append(Issue(table, '-', 'unknown_column', 'warning', f'column "{c}" is not in the schema'))
        dupes = frame.duplicated(subset=[k for k in TABLE_KEYS[table] if k in frame.columns], keep=False)
        for _, row in frame[dupes].iterrows():
            out.append(Issue(table, _key(table, row), 'duplicate_key', 'error', 'duplicate primary key'))
        for _, row in frame.iterrows():
            key = _key(table, row)
            for name, c in spec.items():
                v = row.get(name)
                if _blank(v):
                    if c['required']:
                        out.append(Issue(table, key, 'required', 'error', f'{name} is required'))
                    continue
                if c['kind'] == 'enum' and v not in c['allowed']:
                    out.append(Issue(table, key, 'enum', 'error', f'{name}={v!r} not in {c["allowed"]}'))
                if c['kind'] == 'list':
                    vals = [s.strip() for s in str(v).split('|') if s.strip()]
                    for s in vals:
                        if s not in c['allowed']:
                            out.append(Issue(table, key, 'enum', 'error', f'{name} contains {s!r}'))
                if c['kind'] == 'pseudonym' and not PSEUDONYM.match(str(v)):
                    out.append(Issue(table, key, 'pseudonym_format', 'error', f'{name} must look like P-XXXXXX (random code), got {v!r}'))
                if c['kind'] in ('int', 'float'):
                    try:
                        x = float(v)
                    except (TypeError, ValueError):
                        out.append(Issue(table, key, 'type', 'error', f'{name}={v!r} is not numeric'))
                        continue
                    if (c['lo'] is not None and x < c['lo']) or (c['hi'] is not None and x > c['hi']):
                        out.append(Issue(table, key, 'range', 'error', f'{name}={x} outside [{c["lo"]}, {c["hi"]}]'))
                if c['kind'] in ('date', 'datetime') and _ts(v) is pd.NaT:
                    out.append(Issue(table, key, 'type', 'error', f'{name}={v!r} is not a timestamp'))


def _consent(ds, out):
    consents = ds.get('consents', pd.DataFrame())
    for _, p in ds.get('participants', pd.DataFrame()).iterrows():
        rows = consents[(consents.get('participant_id') == p['participant_id'])] if len(consents) else consents
        active = [r for _, r in rows.iterrows() if _blank(r.get('withdrawn_at'))]
        if not len(rows):
            out.append(Issue('participants', p['participant_id'], 'no_consent', 'error', 'no consent record'))
        elif not active:
            out.append(Issue('participants', p['participant_id'], 'consent_withdrawn', 'error', 'consent withdrawn: exclude and delete'))
        elif not any('collection' in str(r.get('scopes', '')).split('|') for r in active):
            out.append(Issue('participants', p['participant_id'], 'consent_scope', 'error', 'consent does not cover collection'))


def _references(ds, out):
    studies = set(ds.get('studies', pd.DataFrame()).get('study_id', pd.Series(dtype=str)))
    parts = ds.get('participants', pd.DataFrame())
    part_study = dict(zip(parts.get('participant_id', []), parts.get('study_id', [])))
    for _, p in parts.iterrows():
        if p.get('study_id') not in studies:
            out.append(Issue('participants', p['participant_id'], 'unknown_study', 'error', 'study_id not in studies'))
    for _, s in ds.get('sessions', pd.DataFrame()).iterrows():
        pid = s.get('participant_id')
        if pid not in part_study:
            out.append(Issue('sessions', s['session_id'], 'unknown_participant', 'error', 'participant not in participants'))
        elif part_study[pid] != s.get('study_id'):
            out.append(Issue('sessions', s['session_id'], 'study_mismatch', 'error', "session's study differs from its participant's"))


def _timing(ds, out):
    sessions = ds.get('sessions', pd.DataFrame())
    sets = ds.get('sets', pd.DataFrame())
    for _, s in sessions.iterrows():
        sid = s['session_id']
        start, end = _ts(s.get('started_at')), _ts(s.get('ended_at'))
        if start is pd.NaT or end is pd.NaT:
            continue
        minutes = (end - start).total_seconds() / 60
        if not (SESSION_MINUTES[0] <= minutes <= SESSION_MINUTES[1]):
            out.append(Issue('sessions', sid, 'session_duration', 'error', f'session lasts {minutes:.1f} min'))
        own = sets[sets['session_id'] == sid] if len(sets) else sets
        work = own[~own['is_warmup'].astype(bool)] if len(own) else own
        if not len(work):
            out.append(Issue('sessions', sid, 'no_working_sets', 'error', 'session has no working sets'))
            continue
        spans = []
        for _, r in work.iterrows():
            a, b = _ts(r['set_started_at']), _ts(r['set_ended_at'])
            k = f'{sid}/{r["set_index"]}'
            if a is pd.NaT or b is pd.NaT:
                continue
            secs = (b - a).total_seconds()
            if secs <= 0:
                out.append(Issue('sets', k, 'set_order', 'error', 'set ends before it starts'))
                continue
            if secs > MAX_SET_SECONDS:
                out.append(Issue('sets', k, 'set_duration', 'error', f'set lasts {secs:.0f} s'))
            if float(r['reps']) > 0 and secs < float(r['reps']) * MIN_SECONDS_PER_REP:
                out.append(Issue('sets', k, 'rep_speed', 'error', f'{r["reps"]} reps in {secs:.0f} s'))
            if (a - start).total_seconds() < -BOUNDARY_TOLERANCE_S or (b - end).total_seconds() > BOUNDARY_TOLERANCE_S:
                out.append(Issue('sets', k, 'outside_session', 'error', 'working set outside the session window'))
            spans.append((a, b, k, int(r['set_index'])))
        spans.sort()
        for (a1, b1, k1, i1), (a2, b2, k2, i2) in zip(spans, spans[1:]):
            if a2 < b1:
                out.append(Issue('sets', k2, 'overlapping_sets', 'error', f'overlaps {k1}'))
            if i2 < i1:
                out.append(Issue('sets', k2, 'index_order', 'warning', 'set_index does not follow time order'))


def _measurements(ds, out):
    meas = ds.get('measurements', pd.DataFrame())
    devices = ds.get('devices', pd.DataFrame())
    dev_tier = dict(zip(devices.get('device_id', []), devices.get('tier', [])))
    sessions = ds.get('sessions', pd.DataFrame())
    sess = {r['session_id']: r for _, r in sessions.iterrows()}
    for _, m in meas.iterrows():
        k = m['measurement_id']
        tier = m.get('tier')
        if m.get('device_id') not in dev_tier:
            out.append(Issue('measurements', k, 'unknown_device', 'error', 'device not in devices'))
        elif dev_tier[m['device_id']] != tier:
            out.append(Issue('measurements', k, 'tier_mismatch', 'error', f'device tier {dev_tier[m["device_id"]]} != measurement tier {tier}'))
        if m.get('session_id') not in sess:
            out.append(Issue('measurements', k, 'unknown_session', 'error', 'session not in sessions'))
            continue
        a, b = _ts(m.get('interval_start')), _ts(m.get('interval_end'))
        if a is pd.NaT or b is pd.NaT or b <= a:
            out.append(Issue('measurements', k, 'interval_order', 'error', 'interval_end must follow interval_start'))
            continue
        s = sess[m['session_id']]
        if m.get('interval') == 'session':
            ss, se = _ts(s['started_at']), _ts(s['ended_at'])
            if (a - ss).total_seconds() > BOUNDARY_TOLERANCE_S or (se - b).total_seconds() > BOUNDARY_TOLERANCE_S:
                out.append(Issue('measurements', k, 'partial_coverage', 'error', 'session measurement does not cover the whole session'))
        if m.get('interval') == 'resting_baseline' and (b - a).total_seconds() / 60 < MIN_RESTING_BASELINE_MIN:
            out.append(Issue('measurements', k, 'short_baseline', 'warning', f'resting baseline under {MIN_RESTING_BASELINE_MIN} min'))
        if tier in CRITERION_TIERS:
            vo2, vco2 = m.get('vo2_l'), m.get('vco2_l')
            if _blank(vo2) or _blank(vco2):
                out.append(Issue('measurements', k, 'criterion_gas', 'error', 'criterion measurement needs VO2 and VCO2'))
            else:
                r = float(vco2) / float(vo2)
                if not (RER_PLAUSIBLE[0] <= r <= RER_PLAUSIBLE[1]):
                    out.append(Issue('measurements', k, 'rer', 'error', f'RER {r:.2f} outside {RER_PLAUSIBLE}'))
                if not _blank(m.get('gross_kcal')):
                    weir = gross_kcal_from_gas(float(vo2), float(vco2))
                    if abs(float(m['gross_kcal']) - weir) > WEIR_TOLERANCE * weir:
                        out.append(Issue('measurements', k, 'weir_mismatch', 'error', f'gross_kcal {m["gross_kcal"]} vs Weir {weir:.1f}'))
            cal = _ts(m.get('calibrated_at'))
            if cal is pd.NaT:
                out.append(Issue('measurements', k, 'calibration', 'error', 'criterion measurement without a calibration time'))
            elif cal > a or (a - cal).total_seconds() > 6 * 3600:
                out.append(Issue('measurements', k, 'calibration', 'error', 'calibration must be within 6 h before the interval'))
            if m.get('qc_status') != 'pass':
                out.append(Issue('measurements', k, 'qc', 'warning', f'criterion QC status {m.get("qc_status")}: not ground truth'))
        else:
            if _blank(m.get('reported_kcal_kind')):
                out.append(Issue('measurements', k, 'kcal_kind', 'error', 'non-criterion figure must say whether it is gross or net'))


def validate(ds):
    out = []
    _columns(ds, out)
    _references(ds, out)
    _consent(ds, out)
    _timing(ds, out)
    _measurements(ds, out)
    return out


def errors(issues):
    return [i for i in issues if i.severity == 'error']
