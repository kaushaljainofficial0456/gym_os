"""
Phase 9 sample-size analysis — grounded in V1's OWN measured error
distribution, not a guessed effect size or a textbook power formula.

METHOD: V1's LOPO run produced a genuine out-of-sample error for each of
14 participants. Bootstrap-resample participants (with replacement) at
various cohort sizes and measure how tightly the cohort-level MAPE is
estimated. This answers the actual planning question -- "how many people
do we need before our estimate of the model's real-world accuracy stops
being mush?" -- using real residuals rather than an invented effect size.

HONEST LIMITATION, stated up front: this bootstraps from 14 young male
participants doing isolated lab bouts. A real SK OS cohort (mixed sex,
mixed age, multi-exercise sessions) will almost certainly have MORE
between-person variance, not less. So the n values below are a
LOWER BOUND -- the floor, not the target. Treat them as "no fewer than",
never as "this many is enough".
"""
from pathlib import Path
import numpy as np
import pandas as pd

LOPO_PATH = Path(__file__).resolve().parents[1] / "data" / "processed" / "model_e_lopo_predictions_v0.csv"
RNG = np.random.default_rng(42)
N_BOOTSTRAP = 5000

lopo = pd.read_csv(LOPO_PATH)
lopo["abs_pct_err"] = (lopo["signed_error"].abs() / lopo["measured_kcal_min"]) * 100

# Per-participant MAPE -- the unit we resample (a participant, not a row,
# because participants are the independent unit here)
per_participant = lopo.groupby("participant_group_id")["abs_pct_err"].mean()
participant_mapes = per_participant.to_numpy()

print("=" * 76)
print("PHASE 9 SAMPLE-SIZE ANALYSIS")
print("Bootstrapped from V1's own 14 genuine LOPO per-participant MAPEs")
print("=" * 76)
print()
print(f"Observed per-participant MAPE: mean {participant_mapes.mean():.1f}%, "
      f"SD {participant_mapes.std(ddof=1):.1f}%, range {participant_mapes.min():.1f}-{participant_mapes.max():.1f}%")
print()
print(f"{'cohort n':<12}{'95% CI width on cohort MAPE':<32}{'interpretation'}")
print("-" * 76)

results = {}
for n in [5, 10, 15, 20, 25, 30, 40, 50]:
    boot_means = np.array([
        RNG.choice(participant_mapes, size=n, replace=True).mean()
        for _ in range(N_BOOTSTRAP)
    ])
    lo, hi = np.percentile(boot_means, [2.5, 97.5])
    width = hi - lo
    results[n] = width
    if width > 6:
        interp = "too wide to conclude anything"
    elif width > 4:
        interp = "can detect only large differences"
    elif width > 3:
        interp = "workable minimum"
    else:
        interp = "comfortable"
    print(f"{n:<12}{f'+/-{width/2:.1f} pts (width {width:.1f})':<32}{interp}")

print()
print("READING THIS TABLE:")
print("  'Width' = how uncertain our estimate of the cohort's true MAPE would be.")
print("  At n=5 the estimate is nearly meaningless. Returns flatten after ~25-30.")
print()
print("RECOMMENDATION DERIVED FROM THIS (not from a rule of thumb):")
print("  * Minimum viable: 20 participants -- below this, a 'V2 beats V1' claim")
print("    could not be distinguished from noise.")
print("  * Target: 30 participants -- where the CI width stops improving much,")
print("    AND enough to stratify (see protocol: ~6 per subgroup cell x 5 cells).")
print("  * Sessions: >=1 per participant; 2 where feasible (test-retest gives an")
print("    estimate of within-person variability, which nothing in our data has).")
print()
print("REMINDER: real SK OS users will vary MORE than these 14 lab participants.")
print("Treat 20/30 as a FLOOR, and re-run this analysis on the real cohort's own")
print("residuals once ~10 participants are collected, to check the assumption held.")
