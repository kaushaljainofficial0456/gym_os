# Workout calorie estimation: overhaul report (stage 2)

Date: 2026-10-30. Branch: `calorie-overhaul` (not merged, not deployed).

Stage 2 replaces stage 1's conclusions where they differ. The main correction: the
density-gated rule's apparent gain rests on **one protocol arm of one study**, so it is
not evidence of better accuracy.

Definition held fixed throughout: `estimated_active_kcal` is energy **above resting** for
the session (contract §3).

## 1. Conclusions

1. **The evidence is insufficient to change the production estimator.** No candidate has
   been tested on data it was not designed from. The deployed `skos-cal-baseline-v2`
   stays, unchanged.
2. **The density-gated "hard" rule is not supported.**
   - Every gain over the baseline comes from a single arm (Joao 2021, 6×5 @ 90% 1RM).
     Remove that arm, or the Joao study, and the rule equals the baseline.
   - Its preferred cut-off (0.75 sets/min) depends on a disputed duration in Benito 2016.
     With the abstract's 45 min, the rule is *worse* than the baseline at 0.75.
3. **One finding is consistent across two independent studies:** a heavy-load session
   with normal rests ran at 3.2–3.4 MET (Joao 90%, Rustaden heavy). That is far below the
   6.0 the baseline uses for "hard".
   - But both "hard" labels were assigned by me, not reported by the participants, and the
     values are unverified transcriptions (§2).
   - It is a credible **hypothesis** that "hard" over-credits long-rest heavy sessions. It
     is not a validated correction.
4. **skos-cal-v1 (`ml` provider) is worse than the baseline in every scenario** (MAPE
   53–75% vs 23–51%). It stays opt-in and off in production.
5. **Wearable energy should not be trusted for resistance training by default.** Today it
   always wins when matched, at the highest confidence (0.95). See
   `docs/WEARABLE_CALORIE_VALIDATION_DESIGN.md`. A provenance-labelling bug was also found
   there (F2).

## 2. Verified dataset coverage

**Network constraint:** Europe PMC, PMC, PLOS, Frontiers, Crossref and doi.org are
unreachable from this cloud environment, so **no value could be checked against a
full-text table, and no page or table number could be confirmed**. Only a web search was
available, and it returns summaries of abstracts and full-text snippets, not the papers.

Verification levels used in `ml/data/processed/session_calorimetry_arms_v1.csv`:
- **L2** — value checked against the paper's table: **none**.
- **L1** — design or value confirmed by the abstract (via search results).
- **L0** — transcribed in the earlier local session, not re-checked.

| Study (DOI) | Arms | n | Design | Values | What changed in stage 2 |
|---|---|---|---|---|---|
| Joao 2021 (10.3389/fspor.2021.797604, CC BY) | 60/75/90% 1RM, 8 machine exercises | 15 men, same people in all arms | L1: abstract confirms 2×15 / 3×10 / 6×5 and that per-minute EE was highest at 60% | L0: total O2 (L) and session minutes | The paper's VO2 table conflicts with total O2/time. A search index lists a later erratum, which was not read. |
| Rustaden 2020 (10.3389/fphys.2020.00570, CC BY) | BodyPump, heavy RE | **10 and 8 different women** | L1: abstract confirms 302±67 and 289±69 kcal, loads lifted | L0: VO2 12.3 / 12.0, minutes 53 / 57.7 | **Between-subjects**, not one cohort (v0 was wrong). Set counts not transcribed. The abstract's 4.7 kcal/min implies about 64 min, not 53. |
| Benito 2016 (10.1371/journal.pone.0164349, CC BY 4.0) | machine, free weight, combined circuits | 29 (14 women), same people | L1: 3 laps × 8 exercises, 15 reps @ 70% 15RM, 45 s work / 15 s change | L1: VO2 **20.4 / 24.2 / 29.9** (abstract); L0: 20.9 / 24.4 / 31.2 (earlier transcription, source unknown) | **Duration dispute:** abstract "45min 15s" vs full text 23 min 15 s (about 24 × 60 s, which supports 23:15). The **combined arm includes aerobic exercise**, so it is excluded from the primary analysis. |
| PMC5801711 (CC BY-NC-ND) | one session | ? | L0 | L0 | Paper could not be re-identified. Validation-only, non-commercial. |
| PMC5801710 | one session | ? | L0 | L0 | Paper could not be re-identified. |
| PMC10553797 | rest-interval arms | ? | not found by search | L0 | Direction only. Never scored. |

Primary analysis set: **3 independent studies, 7 arms, 5 independent participant
groups** (Joao, Rustaden ×2, Benito). Only Joao and Benito report set counts.

## 3. Validation methodology

- **Target:** net kcal per kg per minute, with resting = 1 MET. Arms lack height and age,
  so Mifflin-St Jeor, which production uses, cannot be applied. This shifts every model
  equally.
- **No model below was fitted to these data.** The baseline is a published Compendium
  table. The gated rule and its cut-off were **designed after seeing these arms**, so
  every number here is **in-sample**. Leave-one-study-out cannot rescue that, because the
  design choice used all studies. Nothing here measures generalisation.
- **Aggregation:** error per arm, averaged within study, then across studies. A
  three-arm study counts once.
- **Every evaluation reports its number of studies and arms**
  (`ml/docs/_stage2_validation_output_v1.txt`).
- **Effort labels are analyst-assigned.** No source reports what participants would
  answer to the app's light/moderate/hard question.
- **Not re-run:** the fitted models from stage 1 (linear density, ridge, XGBoost, LightGBM,
  CatBoost). Only two studies report the needed features, so under study-grouped
  validation each fold trains on one study. They are **not identifiable**, and no score is
  reported for them.

## 4. Baseline comparison: error and bias

Net-kcal MAPE and mean signed bias (+ = over-estimate). Format: studies / arms.

| Scenario | baseline_v2 | all moderate | v1 tiers | density-gated 0.75 | baseline on gated's arms |
|---|---|---|---|---|---|
| **Primary** (abstract VO2, 23.25 min, resistance-only) | 3/7: 37.4, **+32.0** | 3/7: 21.8, −13.7 | 3/7: 53.4, +48.3 | 2/5: 10.1, +2.4 | 2/5: 29.4, +21.7 |
| v0 values (incl. combined, PMC refs) | 5/10: 34.1, +26.9 | 5/10: 24.2, +0.6 | 5/10: 63.7, +56.6 | 2/6: 14.3, −3.4 | 2/6: 33.6, +15.9 |
| Benito at 45.25 min | 3/7: 37.4, +32.0 | 3/7: 21.8, −13.7 | 3/7: 53.4, +48.3 | 2/5: **31.9**, −21.1 | 2/5: 29.4, +21.7 |
| Drop Benito | 2/5: 51.3, +51.0 | 2/5: 6.2, +6.0 | 2/5: 75.4, +75.4 | 1/3: 10.7 | 1/3: 49.4 |
| Drop Joao | 2/4: 31.4, +23.4 | 2/4: 27.4, −25.9 | 2/4: 41.0, +33.3 | 1/2: 9.5 | 1/2: 9.5 (identical) |
| Drop arm joao2021_90 | 3/6: 23.6, +18.3 | 3/6: 21.0, −14.5 | 3/6: 44.5, +39.3 | 2/4: 8.8 | 2/4: 8.8 (identical) |

Per-study baseline error (primary):

| Study | Baseline error | Direction |
|---|---|---|
| Joao | 49% | over: hard label on the 90% arm |
| Rustaden | 53% | over: hard label on the heavy arm |
| Benito | 10% | — |

**Bias is the actionable signal.** The baseline over-estimates in every scenario
(+18 to +51%), and nearly all of that comes from "hard" = 6.0 applied to long-rest sessions.

**Threshold sensitivity** (gated MAPE vs baseline MAPE on the same arms):

| Scenario | Cut-off range | Result |
|---|---|---|
| Primary | 0.45–1.00 | 10 vs 29 |
| Primary | ≤ 0.40 | 29 vs 29: identical |
| Primary | ≥ 1.05 | 32 vs 29: worse |
| Benito at 45.25 min | 0.45–0.50 | gains |
| Benito at 45.25 min | ≥ 0.55 | worse |
| Without joao2021_90 | ≤ 1.00 | never better than baseline |

**The cut-off is not identified by the data.** Any value between the two observed density
clusters gives the same result.

## 5. Feature separability

| Feature | Varies within a study? | What the data says |
|---|---|---|
| External load (%1RM) | Joao only | 60 → 90% with rest fixed: rate 3.33 → 3.16 MET (flat or slightly down). Total kcal rose because the session **took longer** (44 → 116 min). Load should not raise the per-minute rate. |
| Rest between sets | no (Joao 120 s, Benito 15 s) | Confounded with lab, sex mix, cadence, exercise mode. PMC10553797 (unverified) varies rest within one study and reports VO2 falling as rest grows, which is the expected direction. |
| Density (sets/min) | no (Joao 0.36–0.41, Benito 1.03) | Same confound as rest. Density and rest are two views of the same quantity, given set duration. |
| Exercise mode | Benito (machine vs free weight) | Same people, same density: free weight is about 19% higher. Mode is a real, separate effect. |
| Perceived effort | not reported in any scored arm | Adeel 2021 (in repo): trained lifters burn about 2× the energy at the same RPE. Effort is not a proxy for absolute cost. |

**These are separate features, not interchangeable predictors:**
- **Duration** carries the load-driven increase in total kcal.
- **Rest/density** should set the per-minute rate.
- **Effort** should at most modulate it.
- **Mode** is its own term.

The current baseline uses only effort to pick the rate, which collapses all of this into
the weakest proxy. But the available data **cannot estimate** the separate effects across
studies: density, rest and mode are confounded between the only two studies with set
counts. Any coefficients would be fitted to the lab, not the feature.

## 6. Limitations

- No L2-verified values. Every number used is an abstract value or an unverified
  transcription.
- Arm means, not individuals: 3 studies, 5 participant groups, 62 people in total (15 + 10 + 8 + 29).
  The scoring is in-sample by construction.
- Effort labels are analyst-assigned. Resting is assumed to be 1 MET. No older adults and
  no novices in session form.
- Indirect calorimetry misses part of the anaerobic cost (Benito reports 2–6%), which
  biases all ground truth slightly low.
- The PMC12307640 participant-level data stays excluded: CC BY-NC-ND, and its sheets
  contain participant names.

## 7. Production recommendations

1. **Do not change `estimateWorkoutCalories` or `INTENSITY_MET` now.**
2. Merge this branch's non-estimator fixes only after the blockers below are cleared:
   - removal of the ungated, gross `/intel/workout-burn` route;
   - reconciliation using dated body weight and canonical exercise IDs, with a test;
   - contract and handover docs.
3. **Wearables:** follow `docs/WEARABLE_CALORIE_VALIDATION_DESIGN.md`:
   - fix the F2 labelling bug in a separate change;
   - record device identity;
   - demote wearable strength-session energy to "corroborating" only once that design is
     approved.
4. **Collect what would settle the "hard" question:** BARBELL sessions with portable
   calorimetry, the full set log (which already gives density) and the member's own
   post-session effort answer. This is the Phase 9 cohort. **That**, not more public arm
   means, is the path to a validated change.

## 8. Remaining blockers

| # | Blocker | Owner action |
|---|---|---|
| B1 | Full texts unreachable: `www.ebi.ac.uk`, `europepmc.org`, `journals.plos.org`, `www.frontiersin.org`, `doi.org` | Allow them in the environment's network settings, or verify §2 locally. Resolve Benito's duration and VO2, Joao's O2 totals and the erratum, and Rustaden's set counts and duration. |
| B2 | API removal: `/intel/workout-burn` | The web client never called it (verified). **The Android app's 7 commits are not on GitHub and could not be checked.** Confirm it does not call this route before merging. |
| B3 | No participant-level session data | Phase 9 calibration cohort. |
| B4 | Wearable device identity not stored | Schema migration (owner sign-off). |
| B5 | Rustaden set counts | Needed before any density rule could reach 3 studies. |

## 9. Tests run on this branch

| Suite | Result |
|---|---|
| Backend `node --test` | 1,885 tests: 1,883 pass, 0 fail, 2 skipped |
| The 2 skipped (`communityPg`, `financialRls`) | They need `TEST_DATABASE_URL`. Run against a scratch local PostgreSQL 16: **22/22 pass** when run one at a time. Running both at once against one database makes them race on the shared migration (15 failures), which is an artefact of the parallel run. They do not touch calorie code. |
| Frontend `vitest` | 179/179 pass; production build succeeds |
| Playwright e2e (desktop; preinstalled Chromium instead of the configured Chrome channel) | **125/125 pass**. No e2e spec finishes a workout, so the calorie path is covered by backend route tests (`workoutCalorie`, `healthIntelligence`), not by e2e. |
| ML `pytest` | 136 pass |
| `skos-cal-v1` / `skos-food-v1` node tests | pass |

## 10. Branch audit vs `main`

`git diff origin/main...calorie-overhaul`. One earlier commit plus this stage. No file
outside the calorie, health, docs and ml scope is touched.

- **Deleted functionality:** `POST /intel/workout-burn` and `burnEstimator.js` only. No
  other importer existed, and the `ml/models/skos-cal-v1` files it loaded remain, still
  used by the `ml` provider and its tests. `frontend/HANDOVER_MANAVI.md` documented the
  route and is updated.
- **API compatibility:** all other routes are unchanged. Completion, effort and
  confirm-workout response shapes are untouched. Reconciliation now uses the weight logged
  nearest the workout day (completion's rule), so reconciled kcal can differ from before
  for members whose profile weight differs from their logged weight. That is the intended
  fix.
- **Estimator:** `calorieModel.js` is unchanged from `main`.

## 11. Reproduce

```
pip install -r ml/requirements-model.txt
python -I ml/scripts/session_validation_stage2.py   # stage 2 (this report)
python -I ml/scripts/session_model_experiment.py    # stage 1, superseded, kept for history
```
