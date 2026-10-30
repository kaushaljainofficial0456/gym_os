# Workout energy: definitions

Approved product decision (2026-10-30): **the calorie figure BARBELL displays is the net energy
attributable to the workout session, excluding post-exercise recovery expenditure.** This page
defines exactly what that means, in the app and in research. The research code is
`ml/src/research/energy.py`.

## 1. Time intervals

All intervals are bounded by timestamps; none is assumed.

| Interval | Starts | Ends | Notes |
|---|---|---|---|
| **Resting baseline** (research only) | after ≥ 5 min seated | ≥ 10 min later | gives the person's measured resting rate |
| **Session** | start of the first **working** set | end of the last working set | warm-up excluded; **rests between sets included** |
| **Post-exercise recovery** (research only) | end of the last working set | end of post-session measurement (20–60 min) | |

**In the app:**
- the session is the member's timer, minus paused time;
- with measured set timestamps, the first and last working sets are now recorded too
  (`docs/CALORIE_DATA_CAPTURE.md`).

## 2. Energy components of a session

| Component | What it is | Inside the displayed figure? |
|---|---|---|
| **Aerobic** | energy from oxygen uptake during the session window, during sets **and** in the rests between them (the oxygen repaid between sets is part of the session) | yes |
| **Anaerobic (glycolytic)** | energy supplied by glycolysis without oxygen during the session. It is **part of the workout's own cost**, released during the sets, not a separate afterburn. | yes |
| **Post-exercise** | elevated oxygen uptake after the last set (EPOC) | **no**. Measured and reported separately in research. |
| Resting | what the person would have used anyway over the same time | subtracted (net) |

**One limitation of this split.** Some of the cost of the *last* sets (phosphocreatine resynthesis,
lactate clearance) is repaid after the session and lands in the post-exercise component. The
product definition accepts that; research reports the post-exercise component so its size is
known.

## 3. Gross and net: exact formulas

### Research (criterion measurement)

```
aerobic_gross  [kcal] = 3.941 × VO₂ [L] + 1.106 × VCO₂ [L]        over the session window (abbreviated Weir)
resting_rate   [kcal/min] = Weir over the resting baseline ÷ baseline minutes   (MEASURED)
resting        [kcal] = resting_rate × session minutes
aerobic_net    [kcal] = aerobic_gross − resting
anaerobic      [kcal] = max(0, La_post − La_pre) [mmol/L]
                        × O₂-equivalent [mL O₂·kg⁻¹ per mmol/L] × body mass [kg] ÷ 1000
                        × kcal per L O₂
workout_gross  [kcal] = aerobic_gross + anaerobic
workout_net    [kcal] = aerobic_net + anaerobic          ← the displayed figure's target
post_exercise  [kcal] = Weir over the recovery window − resting_rate × recovery minutes   (separate)
```

**Rules:**
- **No net without a resting rate.** Net is defined only with a resting rate. A *measured*
  rate is required for a criterion value. A predicted rate (Mifflin-St Jeor) is allowed only as
  a labelled fallback (`resting_source = 'predicted'`).
- **Anaerobic conversion:** both the O₂-equivalent of lactate and kcal per L O₂ are **stated
  per study before analysis, with their source**. The code has no default. Published
  conventions exist, but their validity for resistance exercise is debated.
- **No target without lactate:** a session without pre/post lactate has **no workout_net
  target**. Its aerobic part alone is never substituted for it.
- **RER above 1.0** over the session (CO₂ from lactate buffering): Weir's VCO₂ term then
  over-counts. Such sessions are flagged for a sensitivity analysis and are not silently
  corrected.

### App (production estimate `skos-cal-baseline-v2`, unchanged)

```
gross_rate [kcal/min] = MET(effort) × 3.5 × body mass [kg] ÷ 200
resting    [kcal/min] = Mifflin-St Jeor BMR ÷ 1440   (needs weight, height, age, sex; else 1 MET = 3.5 × kg ÷ 200)
net        [kcal]     = (gross_rate − resting) × active minutes
```

This is an estimate of the same target, `workout_net`. How close it gets is what the research
measures.

## 4. How large is the anaerobic part? (scientific wording)

A 2024 systematic scoping review (Mitchell et al., *Sports Medicine*, 166 studies) reports that
the glycolytic contribution to resistance-exercise energy expenditure **can exceed 40% under
some training conditions**, depending on load, sets, repetitions and rest. It is **not** a
typical or average value, and **not a correction factor**:
- smaller shares are reported for light, high-repetition circuit work (e.g. 2–6% in Benito 2016);
- in one small study of single sets of five lifts, the share was about 31%.

BARBELL therefore:
- **never applies a fixed anaerobic percentage** to any figure;
- **measures** the anaerobic component per session in research;
- treats the anaerobic share as a quantity that depends on the protocol, to be estimated
  together with the rest of the model.

Sources:
- [Mitchell et al. 2024](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11393209/)
- [Knausenberger et al. 2014](https://wnus.usz.edu.pl/cejssm/an/issue/22/article/175)
