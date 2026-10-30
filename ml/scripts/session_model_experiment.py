"""
Whole-session calorie model experiment (calorie overhaul, phases 4-7).

Question: does any candidate beat the deployed baseline
(skos-cal-baseline-v2: Compendium session MET by reported effort, net of
resting) at predicting MEASURED whole-session energy, rest included?

Data: ml/data/processed/session_calorimetry_arms_v0.csv -- published
group means per protocol arm, each row with its source and derivation.
No participant-level session data exists in any source we may use, so
every number here is an arm mean and n is tiny. Read the verdict in that
light.

Target: NET kcal per kg per minute, i.e. (gross MET - 1) * 3.5 / 200.
Resting is taken as the standard 1 MET because these papers do not report
height/age per arm, so Mifflin-St Jeor cannot be applied honestly.

Validation: leave-one-STUDY-out. Arms from one study share participants,
so leaving out one arm at a time would leak the cohort.

Gates (fixed before running; see docs/CALORIE_OVERHAUL_REPORT.md s7):
  G1 LOSO mean absolute % error on net kcal <= 0.80 x baseline's
  G2 no study's error worse than baseline's by more than 10 points
  G3 fitted on >= 3 independent studies holding every feature it uses
  G4 every prediction physiologically bounded (1.5 <= gross MET <= 12)
A candidate becomes the default only if it passes all four.

Run: python -I ml/scripts/session_model_experiment.py
"""
import csv
import os
import sys
import warnings

import numpy as np

warnings.filterwarnings('ignore')
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', 'data', 'processed', 'session_calorimetry_arms_v0.csv')
OUT = os.path.join(HERE, '..', 'data', 'processed', 'session_model_experiment_v0.csv')

# Effort a member would most plausibly report for each protocol -- needed
# because the deployed baseline keys off reported effort. Debatable by
# construction, so a sensitivity run ('all moderate') is reported too.
EFFORT = {
    'joao2021_60': 'moderate', 'joao2021_75': 'moderate', 'joao2021_90': 'hard',
    'rustaden2020_pump': 'moderate', 'rustaden2020_heavy': 'hard',
    'benito2016_machine': 'hard', 'benito2016_free': 'hard', 'benito2016_combined': 'hard',
    'pmc5801711': 'moderate', 'pmc5801710': 'moderate',
}
BASELINE_V2 = {'light': 3.0, 'moderate': 3.5, 'hard': 6.0}  # calorieModel.js INTENSITY_MET
V1_TIER = {'light': 3.0, 'moderate': 4.5, 'hard': 6.0}      # model_v1.json baseline.met_by_tier


def net_rate(gross_met):
    return (gross_met - 1.0) * 3.5 / 200  # kcal / kg / min


def load():
    rows = []
    with open(DATA, newline='') as f:
        for r in csv.DictReader(f):
            if r['usable_for_fit'] not in ('yes', 'yes_rate_only', 'validation_only'):
                continue
            r['met'] = float(r['vo2_ml_kg_min_incl_rest']) / 3.5
            r['sets_per_min'] = (float(r['total_sets']) / float(r['session_min'])
                                 if r['total_sets'] and r['session_min'] else None)
            r['reps_per_min'] = (float(r['total_reps']) / float(r['session_min'])
                                 if r['total_reps'] and r['session_min'] else None)
            rows.append(r)
    return rows


def ape(pred_met, true_met):
    return abs(net_rate(pred_met) - net_rate(true_met)) / net_rate(true_met) * 100


def loso(rows, predict):
    """predict(train_rows, test_row) -> gross MET or None (cannot predict)."""
    out = {}
    for r in rows:
        train = [t for t in rows if t['study_id'] != r['study_id']]
        out[r['arm_id']] = predict(train, r)
    return out


def study_mean_met(train):
    # Equal weight per study, so a three-arm study does not dominate.
    by = {}
    for t in train:
        by.setdefault(t['study_id'], []).append(t['met'])
    return float(np.mean([np.mean(v) for v in by.values()]))


def fit_density(train):
    pts = [(t['sets_per_min'], t['met']) for t in train if t['sets_per_min'] is not None]
    studies = {t['study_id'] for t in train if t['sets_per_min'] is not None}
    if len(studies) < 2:
        return None  # a slope across one cohort is not identifiable
    x, y = np.array(pts).T
    b, a = np.polyfit(x, y, 1)
    return a, b


def tree_model(kind):
    def predict(train, r):
        feats = [t for t in train if t['sets_per_min'] is not None]
        if r['sets_per_min'] is None or len({t['study_id'] for t in feats}) < 2:
            return None
        X = np.array([[t['sets_per_min'], t['reps_per_min'] or 0] for t in feats])
        y = np.array([t['met'] for t in feats])
        if kind == 'xgboost':
            from xgboost import XGBRegressor
            m = XGBRegressor(n_estimators=50, max_depth=2, verbosity=0)
        elif kind == 'lightgbm':
            from lightgbm import LGBMRegressor
            m = LGBMRegressor(n_estimators=50, min_child_samples=1, verbose=-1)
        elif kind == 'catboost':
            from catboost import CatBoostRegressor
            m = CatBoostRegressor(iterations=50, depth=2, verbose=0)
        else:
            from sklearn.linear_model import Ridge
            m = Ridge(alpha=1.0)
        m.fit(X, y)
        return float(m.predict(np.array([[r['sets_per_min'], r['reps_per_min'] or 0]]))[0])
    return predict


CANDIDATES = {
    'baseline_v2 (deployed)': lambda tr, r: BASELINE_V2[EFFORT[r['arm_id']]],
    'baseline_v2 all-moderate': lambda tr, r: BASELINE_V2['moderate'],
    'v1 tiers (unmapped exercises)': lambda tr, r: V1_TIER[EFFORT[r['arm_id']]],
    'constant session MET (LOSO)': lambda tr, r: study_mean_met(tr),
    'density: MET = a + b*sets/min': lambda tr, r: (
        None if r['sets_per_min'] is None or fit_density(tr) is None
        else fit_density(tr)[0] + fit_density(tr)[1] * r['sets_per_min']),
    # 'hard' only earns the vigorous MET when the session was dense (a set
    # started at least every ~80 s, i.e. circuit-like); heavy straight sets
    # with long rests stay at the ordinary-session MET. Not fit to outcomes:
    # any cut-off between the two observed clusters (0.41 and 1.03 sets/min)
    # gives the same predictions. Uncovered where set counts are unknown.
    'density-gated effort tier': lambda tr, r: (
        None if r['sets_per_min'] is None
        else BASELINE_V2['hard'] if EFFORT[r['arm_id']] == 'hard' and r['sets_per_min'] >= 0.75
        else BASELINE_V2['moderate'] if EFFORT[r['arm_id']] == 'hard'
        else BASELINE_V2[EFFORT[r['arm_id']]]),
    'ridge (sets/min, reps/min)': tree_model('ridge'),
    'xgboost': tree_model('xgboost'),
    'lightgbm': tree_model('lightgbm'),
    'catboost': tree_model('catboost'),
}


def main():
    rows = load()
    print(f'{len(rows)} arms from {len({r["study_id"] for r in rows})} studies\n')
    print(f'{"arm":<22}{"measured MET":>13}{"sets/min":>10}')
    for r in rows:
        spm = f'{r["sets_per_min"]:.2f}' if r['sets_per_min'] else '-'
        print(f'{r["arm_id"]:<22}{r["met"]:>13.2f}{spm:>10}')

    results, preds_all = {}, []
    for name, fn in CANDIDATES.items():
        preds = loso(rows, fn)
        errs = {a: ape(p, next(r['met'] for r in rows if r['arm_id'] == a))
                for a, p in preds.items() if p is not None}
        by_study = {}
        for r in rows:
            if r['arm_id'] in errs:
                by_study.setdefault(r['study_id'], []).append(errs[r['arm_id']])
        results[name] = dict(
            covered=len(errs), mape=np.mean(list(errs.values())) if errs else float('nan'),
            by_study={s: float(np.mean(v)) for s, v in by_study.items()},
            n_fit_studies=len({r['study_id'] for r in rows if r['sets_per_min'] is not None})
            if 'sets' in name or name in ('xgboost', 'lightgbm', 'catboost') else
            len({r['study_id'] for r in rows}),
            bounded=all(1.5 <= p <= 12 for p in preds.values() if p is not None))
        for a, p in preds.items():
            preds_all.append((name, a, p))

    base = results['baseline_v2 (deployed)']
    print(f'\nLOSO net-kcal mean absolute % error (arms covered / {len(rows)})')
    print(f'{"candidate":<34}{"covered":>8}{"MAPE":>8}   per study')
    for name, res in results.items():
        per = ', '.join(f'{s} {e:.0f}' for s, e in res['by_study'].items())
        print(f'{name:<34}{res["covered"]:>8}{res["mape"]:>8.1f}   {per}')

    print('\nGATES vs baseline_v2 (deployed), on the arms each candidate covers')
    for name, res in results.items():
        if name.startswith('baseline_v2 (deployed)'):
            continue
        common = [s for s in res['by_study'] if s in base['by_study']]
        base_mape = np.mean([e for s in common for e in [base['by_study'][s]]]) if common else float('nan')
        cand_mape = np.mean([res['by_study'][s] for s in common]) if common else float('nan')
        g1 = cand_mape <= 0.8 * base_mape
        g2 = all(res['by_study'][s] <= base['by_study'][s] + 10 for s in common)
        g3 = res['n_fit_studies'] >= 3 and res['covered'] == len(rows)
        g4 = res['bounded']
        verdict = 'PASS' if all([g1, g2, g3, g4]) else 'FAIL'
        print(f'{name:<34} G1 {"y" if g1 else "n"}  G2 {"y" if g2 else "n"}  '
              f'G3 {"y" if g3 else "n"}  G4 {"y" if g4 else "n"}  -> {verdict}'
              f'   (study-mean MAPE {cand_mape:.1f} vs baseline {base_mape:.1f})')

    with open(OUT, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['candidate', 'arm_id', 'pred_gross_met'])
        for name, a, p in preds_all:
            w.writerow([name, a, '' if p is None else round(p, 3)])
    print(f'\npredictions -> {os.path.relpath(OUT)}')


if __name__ == '__main__':
    sys.exit(main())
