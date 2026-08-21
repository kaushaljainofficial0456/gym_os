"""
ZERO-COST partial validation for blockers 1, 3 and 4.

We cannot train on aggregate published data (no participant-level rows).
But we CAN use it as an EXTERNAL PLAUSIBILITY ENVELOPE: independent
whole-session measurements from other labs, normalised per kg, that V1's
output should fall inside. This does not make V1 correct -- it tells us
whether V1 is in the right postcode, which is exactly what blockers 1
and 3 ask and what we currently cannot answer at all.

Every number below is transcribed from a paper already logged in
DATA_PROVENANCE.md / V2_DATA_ACQUISITION_REPORT.md. Nothing is invented.
"""
# --- whole-session measurements (multi-exercise, incl. rest periods) ---
WHOLE_SESSION = [
    # label, kcal, minutes, mean body weight kg, population
    ("Rustaden 2020 (Oxycon)",        289, 58,   84, "18 women, overweight, heavy-load 12-exercise"),
    ("Benito 2016 (Oxycon Mobile)",   270, 64,   70, "29 mixed-sex 18-28y, circuit"),
]
# --- exercise-period-only measurements (EXCLUDE rest -> upper bound on session rate) ---
EXERCISE_PERIOD = [
    ("Adeel 2021 untrained (Cortex)", 2.70, 53.32, "5 untrained women, squat 60%1RM"),
    ("Adeel 2021 trained (Cortex)",   3.42, 81.68, "6 trained, squat 60%1RM"),
    ("Nakagata 2019 older men",       3.8,  63.7,  "13 men 66-80y, bodyweight squat"),
    ("Nakagata 2019 older women",     3.6,  51.3,  "7 women 66-80y, bodyweight squat"),
]

print("="*78); print("EXTERNAL PLAUSIBILITY ENVELOPE — independent whole-session measurements"); print("="*78)
print(f"\n{'source':<34}{'kcal/min':>9}{'per kg':>10}   population")
rates=[]
for lbl,kcal,mins,bw,pop in WHOLE_SESSION:
    r=kcal/mins; pk=r/bw; rates.append(pk)
    print(f"{lbl:<34}{r:>9.2f}{pk:>10.4f}   {pop}")
print(f"\n  WHOLE-SESSION envelope: {min(rates):.4f} - {max(rates):.4f} kcal/min/kg")

print(f"\n{'exercise-period only (upper bound)':<34}{'kcal/min':>9}{'per kg':>10}   population")
ep=[]
for lbl,met,bw,pop in EXERCISE_PERIOD:
    r=met*3.5*bw/200; pk=r/bw; ep.append(pk)
    print(f"{lbl:<34}{r:>9.2f}{pk:>10.4f}   {pop}")
print(f"\n  EXERCISE-PERIOD envelope: {min(ep):.4f} - {max(ep):.4f} kcal/min/kg")
print("  (these EXCLUDE rest, so a whole session must sit BELOW them)")

lo, hi = min(rates), max(ep)
print(f"\n  => COMBINED plausible whole-session band: {lo:.4f} - {hi:.4f} kcal/min/kg")

# --- now check V1 (GROSS, since the literature values are gross) ---
import json
M=json.load(open('models/skos-cal-v1/model_v1.json'))
MET=M['baseline']['met_by_tier']; CORR=M['correction_kcal_per_min_by_exercise_and_tier']
print("\n"+"="*78); print("V1 GROSS OUTPUT vs THAT ENVELOPE (per kg, so body weight cancels)"); print("="*78)
print(f"\n{'tier':<10}{'exercise':<22}{'kcal/min/kg @75kg':>19}   verdict")
bw=75; out_of_band=0; total=0
for tier in ['light','moderate','hard']:
    for ex in ['BENCH_PRESS','BARBELL_SQUAT','BICEP_CURL']:
        rate=MET[tier]*3.5*bw/200 + CORR[ex][tier]
        rate=min(rate, M['plausibility_guardrails']['max_active_rate_kcal_min'])
        pk=rate/bw; total+=1
        v = "OK" if lo<=pk<=hi else ("*** ABOVE band ***" if pk>hi else "*** BELOW band ***")
        if v!="OK": out_of_band+=1
        print(f"{tier:<10}{ex:<22}{pk:>19.4f}   {v}")
print(f"\n  {out_of_band}/{total} tested combinations fall OUTSIDE the externally-measured band.")
