# Workout calorie estimation — overhaul report

Date: 2026-10-30. Scope: the 12-phase calorie overhaul. Definition held fixed throughout:
`estimated_active_kcal` is energy **above resting** for the session (contract §3).

## 1. Summary

- The deployed estimate (`skos-cal-baseline-v2`, Compendium session MET by reported effort,
  net of Mifflin-St Jeor resting) stays the default. No candidate passed the validation gates.
- `skos-cal-v1` (the `ml` provider) does worse than the baseline on whole sessions. It
  stays opt-in and must stay off in production.
- The main error is the **`hard` tier**. Heavy straight sets with normal rests use energy at
  the same rate as a moderate session, measured at 3.2–3.4 MET against the 6.0 the
  baseline uses. Only dense, circuit-style sessions reach 6–9 MET. What sets the energy rate
  is **work density** (how quickly sets follow each other), not effort.
- A density-gated tier cut the baseline's error from 34% to 14% on the arms it could
  score. It still fails because only two independent studies report set counts. One more
  such study, or Rustaden 2020's set counts, would let it be tested properly (§9).
- Fixed: the legacy route that bypassed the provider gate was removed, wearable
  reconciliation now uses the same body weight and exercise mapping as completion, and the
  stale contract text was corrected.

## 2. System audit (phase 1)

| Path | Calls `estimateWorkoutCalories`? | Notes |
|---|---|---|
| `POST /workouts/:id/complete` | yes | dated weight, canonical map, persisted |
| `POST /workouts/:id/effort` | yes | re-estimate after the post-session effort question |
| `POST /intel/confirm-workout` | yes | NL-logged sessions |
| `trainingProgram` preview | yes | `stage: 'preview'`, never persisted |
| `dailyIntelligence` reconciliation | yes | **was** using `clients.current_weight` and no canonical map — fixed |
| `POST /intel/workout-burn` | **no** (called skos-cal-v1 directly) | bypassed provider gate, returned gross kcal, no client called it — **removed** |

Provider default is `baseline` in every environment (`config.js`). The ml provider's output
is converted gross → net in `toNetOfResting`, and every provider passes `validateCalorieResult`.

## 3. Scientific evidence (phase 2)

- **Whole-session calorimetry, rest included,** is the right ground truth for a session
  figure. Single-exercise bouts (reis 2017/2019, the whole of v1's training data) measure
  something else: a 26–56 s set to failure is not a sustainable per-minute rate.
- **Ordinary gym sessions with about 2 min of rest:** 2.75–3.5 MET gross across four
  cohorts, two countries, both sexes (table §4). The Compendium code 02054 (3.5) fits.
- **Effort does not move the rate:** Joao 2021 ran the same 8 exercises at 60, 75 and 90%
  1RM with equal rests. Total time grew from 44 to 116 min, but the rate stayed at
  3.33 / 3.30 / 3.16 MET. A harder session costs more because it **lasts longer**, and
  duration is already measured.
- **Density moves the rate:** Benito 2016 used a circuit with 15 s rests and reached
  6.0–8.9 MET. PMC10553797 is one exercise with rest as the only variable: 60 → 180 s rest
  dropped squat VO2 from 19.0 to 12.9 ml/kg/min. The paper reports work rate r = .96 with
  VO2 and a weak link with RPE.
- **Perceived effort is a poor proxy for absolute cost:** Adeel 2021 found trained lifters
  burned about 2× the energy at the same RPE (`ml/docs/SESSION_INTENSITY_DESIGN_NOTE.md`).
- **Wearables over-read lifting** (PMC13120158/PMC13701894: calorimetry 141 kcal against
  Apple 299, Garmin 305, Galaxy 258, Fitbit 146 over 34 min). The reconciliation layer
  currently prefers wearable kcal when one covers the session (`reconciliation.js`). That
  trust ordering should be reviewed (§10, risk R3).
- **Lytle 2019 (MSSE)** gives net kcal from height, age, fat and lean mass, and training
  volume (R .773, SEE 28.5 kcal). The app has no body-composition data and the TV unit is
  unverified, so it **could not be evaluated** without inventing inputs. It is recorded as a
  reference, not a candidate.

## 4. Dataset audit (phase 3)

- v1's 1,001 rows are 560 unique cells: 441 are reis2017/reis2019 duplicates of the same
  14 men. They are single-exercise bouts at 12–24% and 80% 1RM, with no individual body
  weights and **zero whole sessions**. "Moderate" in v1 means 20–24% 1RM.
- v1's plausibility envelope uses Benito 2016 as 270 kcal / 64 min. Those 64 min include
  warm-up; the measured circuit lasts 23.25 min. The envelope is wrong low for circuits.
- New file `ml/data/processed/session_calorimetry_arms_v0.csv`: 18 published arm means
  (10 usable for scoring), each with source, licence, derivation and caveat. **No
  participant-level session data exists in any source we may train on.**
  - PMC12307640 has 29 participant-level rows but is CC BY-NC-ND and its sheets contain
    participant names. It is excluded until the licence is resolved, and the names must
    never be copied.
  - PMC5801711 is non-commercial and is used as a validation point only.
- **Verification status:** Europe PMC (`www.ebi.ac.uk`) is blocked in this cloud
  environment, so the values were transcribed in the earlier local session and could not
  be re-read here. Every row is marked `read_prior_session_pending_reverify`. Re-check them
  against the papers before any of them drives a production number.

## 5. Features (phase 4)

What the app actually records per session: duration (one timer, pauses removed), completed
sets/reps/load per exercise, exercise type, and body weight (dated), plus height, age and
sex when the profile has them, and post-session effort.

The useful feature is `sets_per_minute` (= `session.sets_per_minute` in contract 0.2,
already computed). Volume and relative load carry little signal in this data: Joao's three
arms hold total reps constant while load rises 60 → 90% and the rate does not move.
Tempo and time under tension cannot be captured today.

## 6. Candidates (phase 5)

Scored against the deployed baseline: baseline with every session treated as moderate;
v1's tier METs; a constant session MET; a linear density model; a density-gated effort
tier; and ridge, XGBoost, LightGBM and CatBoost on sets/min and reps/min.
`ml/scripts/session_model_experiment.py` (dependencies in `ml/requirements-model.txt`).

## 7. Validation (phase 6) — gates fixed before running

Target: net kcal/kg/min, with resting at 1 MET (the papers lack per-arm height and age).
Validation: leave-one-**study**-out, because arms of one study share participants.
- **G1** mean absolute % error ≤ 0.80 × baseline's
- **G2** no study more than 10 points worse than baseline
- **G3** fitted on ≥ 3 independent studies holding every feature it uses, and covers every arm
- **G4** all predictions within 1.5–12 gross MET

| Candidate | Arms scored | MAPE | Gates | Verdict |
|---|---|---|---|---|
| **baseline_v2 (deployed)** | 10 | 35.8 | — | reference |
| baseline, all moderate | 10 | 26.2 | G2 ✗ (Benito 59 vs 18) | fail |
| v1 tier METs | 10 | 58.3 | G1 ✗ G2 ✗ | fail |
| constant session MET | 10 | 50.1 | G1 ✗ G2 ✗ | fail |
| density-gated effort tier | 6 | **14.3** | G3 ✗ (2 studies) | fail — leading candidate |
| linear density / ridge / XGBoost / LightGBM / CatBoost | 0 | — | G3 ✗ | not identifiable: under LOSO only one study with set counts remains to fit on |

## 8. Error analysis (phase 7)

Baseline errors come almost entirely from `hard`:

| Arm | Measured gross MET | Baseline MET | Net error |
|---|---|---|---|
| Joao 6×5 @ 90% (hard) | 3.16 | 6.0 | +131% |
| Rustaden heavy (hard) | 3.43 | 6.0 | +106% |
| Benito circuits (hard) | 5.97–8.91 | 6.0 | −36% to +1% |
| Joao 60/75%, Rustaden pump (moderate) | 3.30–3.51 | 3.5 | ≤ 10% |

A member who reports "hard" after a heavy session with long rests is currently credited
with about twice the energy they used. That is the largest known bias in the shipped number.

## 9. Decision

1. Keep `skos-cal-baseline-v2` as the default. No production behaviour change from modelling.
2. Keep `ml` (skos-cal-v1) opt-in, dev/staging only. It fails every whole-session gate.
3. **Next experiment:** the density-gated tier. `hard` should get 6.0 only when the session
   averaged at least ~0.75 sets/min; otherwise it stays at 3.5. It needs set counts from a
   third independent study. Rustaden 2020's protocol tables are the quickest source once
   Europe PMC is reachable. If G1–G4 then pass, ship it as `skos-cal-baseline-v3` behind
   the existing provider gate. That needs no new inputs: `sets_per_minute` is already in
   the contract.
4. Longer term: participant-level whole-session data (the Phase 9 calibration cohort,
   `ml/docs/PHASE9_STUDY_PROTOCOL.md`) is the only route to a real model. No public dataset
   fills that gap.

## 10. Production architecture

Unchanged: one entry point (`estimateWorkoutCalories`) → provider gate → timeout → gross→net
(ml only) → `validateCalorieResult` → persistence by the backend only. With the legacy route
gone, this is the only path. Risks:
- **R1** `hard` over-credit (§8): known, documented in contract §7, fix gated on data.
- **R2** the band (±25% of the gross rate) is not calibrated.
- **R3** reconciliation prefers wearable kcal, which over-reads lifting by up to about 2×.
  This needs a separate review.

## 11. Changes in this branch

- `backend/src/routes/intelligence.js`, `backend/src/services/burnEstimator.js`: removed
  `POST /intel/workout-burn` (unused, ungated, gross).
- `backend/src/services/health/dailyIntelligence.js`: reconciliation uses
  `resolveBodyWeight` (the weight logged nearest the workout day) and the ml exercise
  canonicalization, matching completion.
- `backend/test/healthIntelligence.test.js`: regression test (fails before the fix).
- `docs/calorie-model-contract.md` §6–7: baseline-v2 formula, net-of-resting, ±25% band,
  `hard` caveat, single-path note.
- `ml/data/processed/session_calorimetry_arms_v0.csv`, `ml/scripts/session_model_experiment.py`,
  `ml/data/processed/session_model_experiment_v0.csv`, `ml/requirements-model.txt`.

## 12. Tests

`node --test` for the calorie, health, intelligence, reconciliation, workout-calorie and
energy-balance suites: all pass, including the new test. No test was weakened or removed.

## 13. Workout page

No UI change. The single timer and the one post-session effort question stay. When the
density gate ships, the effort answer will still be used; it will just stop raising the
rate for low-density sessions.

## 14. Limitations

The data is arm means, not individuals, from 5 studies: 10 scored arms, 3 of them sharing one
cohort. Resting is set to 1 MET for scoring. No women-only circuit data and no older adults
in session form. Values are pending re-verification (§4).

## 15. Reproduce

```
pip install -r ml/requirements-model.txt
python -I ml/scripts/session_model_experiment.py
cd backend && node --test test/healthIntelligence.test.js
```

## 16. Sources and licences

Joao 2021 (PMC8714826, CC BY); Rustaden 2020 (PMC7298122, CC BY); Benito 2016 (PMC5104360,
CC BY 4.0); PMC5801711 (CC BY-NC-ND, validation only); PMC5801710; PMC10553797 (direction
only); PMC13120158 / PMC13701894 (wearable comparison); PMC11164431 (sets-only, excluded);
Adeel 2021 (CC BY 4.0); Lytle 2019 MSSE (reference); 2024 Adult Compendium (Herrmann et al.).
Facts reported in papers are used; no paper text or participant data is copied.
