# Data Quality Audit — v0

Answers below are checked against the actual raw files (see `src/ingestion/*.py` for exact parsing logic and `_build_report_v0.txt` for live counts), not against paper abstracts. "—" means not applicable to that dataset's design.

| # | Question | reis2017 | reis2019 | brunelli2019 |
|---|---|---|---|---|
| 1 | Energy expenditure actually measured? | Yes (VO2, direct) | Yes (EC, direct) | Yes (indirect calorimetry, direct) |
| 2 | How measured? | Breath-by-breath, COSMED K4b2 | Breath-by-breath, COSMED K4b2 | Portable gas analyzer (Oxycon), breath-by-breath |
| 3 | VO2 available? | Yes (relative, ml/kg/min) | No (only derived EC in kcal/min) | No (only derived kcal) |
| 4 | VCO2 available? | No | No | No |
| 5 | kcal/min available? | Only as a group-mean-derived value (excluded — see provenance) | Yes, directly | No (values are absolute kcal per bout, not a rate) |
| 6 | Total kcal available? | No | No | Yes (exercise / EPOC / total, per condition) |
| 7 | Exercise duration available? | Yes, per protocol (4–5 min / 26–56s), not per-participant-varying | Yes, per protocol (4×4min) | Yes, per protocol (3 sets to failure — variable actual duration, not logged per participant) |
| 8 | Participant weight available? | Cohort mean only, no per-participant value | Cohort mean only | Cohort mean only |
| 9 | Age available? | Cohort mean only | Cohort mean only | Cohort mean only |
| 10 | Sex available? | Yes (100% male, cohort-level) | Yes (100% male) | Yes (100% male) |
| 11 | Height available? | No | No | No |
| 12 | Body composition available? | Cohort mean body-fat% only (11.4±4.1%), no per-participant | No | No |
| 13 | Load available? | Yes (%1RM) | Yes (%1RM) | Yes (%1RM, load-to-failure) |
| 14 | Reps available? | No (fixed-duration bout, not rep-counted) | No | No (to-failure sets — rep count not in the raw file) |
| 15 | Sets available? | — (single continuous bout per intensity) | — | Yes (3 sets, condition-level) |
| 16 | Exercise identity available? | Yes, 8 exercises | Yes, 8 exercises | Yes, 1 exercise |
| 17 | Intensity / %1RM available? | Yes (12/16/20/24/80%) | Yes (12/16/20/24%) | Yes (30%/80%) |
| 18 | Rest duration available? | — | — | Yes (1.5 min between sets, protocol-level) |
| 19 | Heart rate available? | No | Yes | No |
| 20 | Raw observations available? | Yes, per-participant per-intensity | Yes, per-participant per-intensity | Yes, per-participant per-condition |
| 21 | Repeated measurements available? | Yes (5 intensities/participant/exercise) | Yes (4 intensities/participant/exercise) | Yes (3 conditions × multiple lactate timepoints/participant) |
| 22 | Participants identifiable across sessions? | Yes, via local index — and CONFIRMED identifiable across reis2017↔reis2019 (see provenance) | Yes | Yes, within-file only |
| 23 | Commercially usable? | Yes, CC BY 4.0 | Yes, CC BY 4.0 | Yes, CC BY 4.0 |

---

## Real participant / session / observation counts (from the actual build, not estimated)

- **Unique participants after resolving the reis2017↔reis2019 overlap: 25** (14 shared cohort + 11 Brunelli). This supersedes the ~230-participant estimate from the earlier abstract-level audit — that number trusted search-summary text ("58 males", "56 males") over what the downloadable files actually contain.
- **Total harmonized observation rows: 2,069** (after dropping 441 confirmed duplicate rows).
- **Studies: 3.**
- **Exercises covered: 8 distinct canonical exercises** (LEG_EXTENSION, TRICEPS_EXTENSION, BARBELL_SQUAT [half-squat variant — see ontology notes], BENCH_PRESS, LAT_PULLDOWN, BICEP_CURL, LEG_PRESS, INCLINE_BENCH_PRESS).
- **Population: 100% male, 20s–30s, all "trained" or newly-sedentary — no women, no adolescents/older adults, no wide age spread anywhere in this data.**

## Missingness (real, computed from the unified table)

`intensity_value` missing in 6.4% of rows (expected — `heart_rate`/`blood_lactate` rows without a clean intensity mapping in some conditions). `metric_subtype` missing in 80.9% of rows (expected — only `energy_expenditure_absolute` and `blood_lactate` rows use it; the majority-share metric types don't need a subtype). No missingness in any identity, exercise, or value column. Full column-by-column numbers are in `_build_report_v0.txt`, regenerated on every pipeline run.

## Is this sufficient for modeling?

**Not yet, and this is a stronger "not yet" than before I opened the files.** 25 participants, 100% male, 100% in their 20s–30s, is enough to:
- Characterize MET-baseline error with real numbers (Phase 3) — worth doing now.
- Run a first-pass, clearly-labeled *preliminary* ML-correction experiment — but any result must be reported as exploratory, not production-grade, given n=25.

It is **not** enough to:
- Make any claim about generalization to women, other age groups, or untrained/beginner populations (SK OS explicitly serves a broader population than this).
- Justify a tree-ensemble model (Random Forest / XGBoost / LightGBM / CatBoost) over a simple linear correction — with this few participants, a complex model's "better" training fit is much more likely to be overfitting noise than real signal. The MET+linear-correction comparison (Model C) is the realistic ceiling worth testing first.
- Cover compound multi-exercise sessions the way SK OS actually logs workouts — every exercise here was tested in isolation, one at a time, not as part of a real multi-exercise training session.

## What would change this assessment
Any of: the Rustaden data (adds female participants), the paywalled studies (adds mixed-sex/wider-age/compound-lift coverage), or the Compendium's official MET table (needed for Phase 3 regardless of participant count). None of these are blocked on this pipeline — they're independent inputs that get folded in if/when they arrive.
