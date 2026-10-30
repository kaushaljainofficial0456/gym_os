"""
Stage-2 validation of whole-session calorie estimates.

Reads ml/data/processed/session_calorimetry_arms_v1.csv (published arm
means with a provenance level per row) and answers four questions without
fitting anything new:

  1. How does the deployed baseline do, per study, with error AND bias?
  2. Is the density-gated effort tier's advantage robust to the cut-off,
     to the disputed Benito figures, and to dropping any one study/arm?
  3. Which features does the evidence actually separate (within a study),
     and which are confounded (only differ between studies)?
  4. What can the candidates claim once every evaluation reports how many
     independent studies and sessions it rests on?

Every rule below was designed after looking at these same arms, so every
score here is IN-SAMPLE. Nothing in this script measures generalisation.

Run: python -I ml/scripts/session_validation_stage2.py
"""
import csv
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', 'data', 'processed', 'session_calorimetry_arms_v1.csv')
OUT = os.path.join(HERE, '..', 'data', 'processed', 'session_validation_stage2_v1.csv')

MET = {'light': 3.0, 'moderate': 3.5, 'hard': 6.0}  # calorieModel.js INTENSITY_MET (deployed)
V1_MET = {'light': 3.0, 'moderate': 4.5, 'hard': 6.0}


def net(gross_met):
    """Net-of-resting kcal per kg per minute, resting = 1 MET (the papers
    give no per-arm height/age, so Mifflin-St Jeor cannot be applied)."""
    return (gross_met - 1.0) * 3.5 / 200


def load(scenario):
    rows = []
    with open(DATA, newline='') as f:
        for r in csv.DictReader(f):
            if r['usable_for_scoring'] not in ('yes', 'rate_only', 'validation_only'):
                continue
            if scenario.get('resistance_only') and r['resistance_only'] != 'yes':
                continue
            if r['study_id'] in scenario.get('drop_studies', ()):
                continue
            if r['arm_id'] in scenario.get('drop_arms', ()):
                continue
            vo2 = float(r['vo2_alt'] if scenario.get('alt_vo2') and r['vo2_alt'] else r['vo2_ml_kg_min_incl_rest'])
            minutes = r['session_min_alt'] if scenario.get('alt_minutes') and r['session_min_alt'] else r['session_min']
            r['met'] = vo2 / 3.5
            r['spm'] = float(r['total_sets']) / float(minutes) if r['total_sets'] and minutes else None
            rows.append(r)
    return rows


def baseline(r, _cut=None):
    return MET[r['analyst_effort_label']]


def all_moderate(r, _cut=None):
    return MET['moderate']


def v1_tiers(r, _cut=None):
    return V1_MET[r['analyst_effort_label']]


def gated(r, cut=0.75):
    """'hard' earns 6.0 only for a dense session; unscorable without sets."""
    if r['spm'] is None:
        return None
    if r['analyst_effort_label'] == 'hard':
        return MET['hard'] if r['spm'] >= cut else MET['moderate']
    return MET[r['analyst_effort_label']]


def score(rows, model, cut=None):
    """Per-arm signed % error on net kcal; aggregated per study first so a
    three-arm study counts once."""
    per_arm = {}
    for r in rows:
        p = model(r, cut) if cut is not None else model(r)
        if p is None:
            continue
        per_arm[r['arm_id']] = (net(p) - net(r['met'])) / net(r['met']) * 100
    studies = {}
    for r in rows:
        if r['arm_id'] in per_arm:
            studies.setdefault(r['study_id'], []).append(per_arm[r['arm_id']])
    if not studies:
        return dict(n_studies=0, n_arms=0, mape=np.nan, bias=np.nan, per_study={}, per_arm=per_arm)
    s_abs = [np.mean(np.abs(v)) for v in studies.values()]
    s_sig = [np.mean(v) for v in studies.values()]
    return dict(n_studies=len(studies), n_arms=len(per_arm), mape=float(np.mean(s_abs)),
                bias=float(np.mean(s_sig)), per_study={k: float(np.mean(np.abs(v))) for k, v in studies.items()},
                per_arm=per_arm)


def fmt(res):
    return f'{res["n_studies"]} st / {res["n_arms"]} arms  MAPE {res["mape"]:6.1f}  bias {res["bias"]:+6.1f}'


SCENARIOS = {
    'primary (abstract VO2, 23.25 min, resistance-only)': dict(resistance_only=True),
    'v0 values (earlier transcription, incl. combined)': dict(alt_vo2=True),
    'Benito duration per abstract (45.25 min)': dict(resistance_only=True, alt_minutes=True),
    'drop Benito': dict(resistance_only=True, drop_studies=('benito2016',)),
    'drop Joao': dict(resistance_only=True, drop_studies=('joao2021',)),
    'drop arm joao2021_90 only': dict(resistance_only=True, drop_arms=('joao2021_90',)),
}

rows_out = []


def main():
    prim = load(SCENARIOS['primary (abstract VO2, 23.25 min, resistance-only)'])

    print('=' * 92)
    print('1. ARMS (primary scenario).  L0 = unverified transcription, L1 = design confirmed by abstract')
    print('=' * 92)
    print(f'{"arm":<22}{"study":<16}{"n":>4}{"MET":>7}{"sets/min":>10}{"effort*":>10}  design/value')
    for r in prim:
        spm = f'{r["spm"]:.2f}' if r['spm'] else '-'
        print(f'{r["arm_id"]:<22}{r["study_id"]:<16}{r["n"] or "?":>4}{r["met"]:>7.2f}{spm:>10}'
              f'{r["analyst_effort_label"]:>10}  {r["design_verification"]}/{r["value_verification"]}')
    print('* effort is the label an analyst assigned to the protocol, NOT what participants reported.')

    print('\n' + '=' * 92)
    print('2. BASELINE COMPARISON — every evaluation states its studies and arms (in-sample, no fitting)')
    print('=' * 92)
    for sname, sc in SCENARIOS.items():
        rows = load(sc)
        print(f'\n[{sname}]')
        for mname, m in (('baseline_v2 (deployed)', baseline), ('all moderate', all_moderate),
                         ('v1 tier METs', v1_tiers), ('density-gated (0.75)', gated)):
            res = score(rows, m, 0.75) if m is gated else score(rows, m)
            print(f'  {mname:<30}{fmt(res)}   ' + ', '.join(f'{k} {v:.0f}' for k, v in res['per_study'].items()))
            rows_out.append([sname, mname, '', res['n_studies'], res['n_arms'], round(res['mape'], 2), round(res['bias'], 2)])
        # like-for-like: baseline on exactly the arms the gated rule can score
        g = score(rows, gated, 0.75)
        sub = [r for r in rows if r['arm_id'] in g['per_arm']]
        b = score(sub, baseline)
        print(f'  {"baseline, same arms as gated":<30}{fmt(b)}')
        diff = [a for a in g['per_arm'] if abs(g['per_arm'][a] - b['per_arm'][a]) > 1e-9]
        print(f'  arms where gated differs from baseline: {diff or "none"}')

    print('\n' + '=' * 92)
    print('3. THRESHOLD SENSITIVITY — density-gated rule vs baseline on the same arms')
    print('=' * 92)
    cuts = np.round(np.arange(0.30, 1.31, 0.05), 2)
    for sname in ('primary (abstract VO2, 23.25 min, resistance-only)', 'Benito duration per abstract (45.25 min)',
                  'drop Benito', 'drop arm joao2021_90 only'):
        rows = load(SCENARIOS[sname])
        print(f'\n[{sname}]')
        line = []
        for c in cuts:
            g = score(rows, gated, c)
            sub = [r for r in rows if r['arm_id'] in g['per_arm']]
            b = score(sub, baseline)
            line.append(f'{c:.2f}:{g["mape"]:.0f}/{b["mape"]:.0f}')
            rows_out.append([sname, 'density-gated', c, g['n_studies'], g['n_arms'], round(g['mape'], 2), round(g['bias'], 2)])
        for i in range(0, len(line), 7):
            print('  ' + '  '.join(line[i:i + 7]))
        print('  (cut: gated MAPE / baseline MAPE)')

    print('\n' + '=' * 92)
    print('4. FEATURE SEPARABILITY — which features vary WITHIN a study (testable) vs only between studies')
    print('=' * 92)
    feats = {
        'external load (%1RM)': {'joao2021': 'varies 60/75/90', 'benito2016': 'fixed 70% 15RM', 'rustaden2020': 'between groups'},
        'rest between sets': {'joao2021': 'fixed 120 s', 'benito2016': 'fixed 15 s', 'rustaden2020': 'not transcribed'},
        'density (sets/min)': {'joao2021': '0.36-0.41 (narrow)', 'benito2016': 'fixed 1.03', 'rustaden2020': 'unknown'},
        'reported effort': {'joao2021': 'not used', 'benito2016': 'not used', 'rustaden2020': 'not used'},
        'exercise mode': {'joao2021': 'machines', 'benito2016': 'machine vs free weight', 'rustaden2020': 'class vs heavy'},
    }
    for f, d in feats.items():
        print(f'  {f:<22}' + ' | '.join(f'{k}: {v}' for k, v in d.items()))
    j = {r['arm_id']: r for r in prim if r['study_id'] == 'joao2021'}
    print('\n  Within Joao (same men, load 60 -> 90% 1RM, rest fixed): MET '
          + ' -> '.join(f'{j[a]["met"]:.2f}' for a in ('joao2021_60', 'joao2021_75', 'joao2021_90'))
          + f'; duration 44 -> 116 min.')
    bm = {r['arm_id']: r['met'] for r in prim if r['study_id'] == 'benito2016'}
    print(f'  Within Benito (same people, same density): machine {bm["benito2016_machine"]:.2f} vs free weight '
          f'{bm["benito2016_free"]:.2f} MET -> exercise mode alone moves the rate ~{(bm["benito2016_free"] / bm["benito2016_machine"] - 1) * 100:.0f}%.')
    print('  Density and rest differ only BETWEEN Joao and Benito, together with sex mix, mode, cadence and lab:')
    print('  their effect on rate is confounded and cannot be attributed to density alone from these data.')

    with open(OUT, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['scenario', 'model', 'cut', 'n_studies', 'n_arms', 'mape_net_pct', 'bias_net_pct'])
        w.writerows(rows_out)
    print(f'\nwrote {os.path.relpath(OUT)}')


if __name__ == '__main__':
    main()
