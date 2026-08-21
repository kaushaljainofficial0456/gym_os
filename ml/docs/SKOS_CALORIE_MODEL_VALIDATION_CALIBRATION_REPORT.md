# SK OS CALORIE MODEL — VALIDATION & CALIBRATION REPORT

**Scope:** model validation of `skos-cal-v1` as integrated at backend `46ee846` / ML integration `3999430` (branch `origin/backend`).
**Type:** read-only audit. No backend file, schema, RLS rule, branch or config was modified. No commits, merges or cherry-picks. ML remains opt-in via `CALORIE_MODEL_PROVIDER=ml`.

**Evidence labelling used throughout — every claim carries one:**

| Tag | Meaning |
|---|---|
| **[MEASURED]** | Computed this audit from data, or by executing the shipped code |
| **[REPO]** | Read directly from repository files at the named commits |
| **[ASSUMPTION]** | A modelling choice baked into the artifact, not established by evidence |
| **[INFERENCE]** | My reasoning from the above — argued, not measured |

---

## 1. Current model behavior

**[REPO]** The integration is a three-layer stack:

```
calorieModel.js  toMlInput()        canonicalizes opaque exercise ids
       |
       v
skosCalV1.js     mlEstimate()       GROSS kcal, per the frozen model logic
       |
       v
calorieModel.js  toNetOfResting()   subtracts 1-MET resting -> NET kcal
       |
       v
                 validateCalorieResult() -> baseline fallback on failure
```

**[MEASURED] Artifact integrity — PASS.** `skosCalV1.model.json` @46ee846 was compared field-by-field against `ml/models/skos-cal-v1/model_v1.json`. `correction_kcal_per_min_by_exercise_and_tier`, `interval_offsets_kcal_per_min`, `baseline`, `plausibility_guardrails`, `body_weight_validity` and `source_measured_bout_duration_minutes` are all **IDENTICAL**. `model_version` is `skos-cal-v1` on both. No coefficient drift.

**[MEASURED] Port fidelity — PASS.** Diffing `skosCalV1.js`'s `mlEstimate` against the ML reference implementation yields **four differences, all cosmetic**: three string literals naming `skosCalV1.model.json` instead of `model_v1.json`, plus one trailing newline. Zero calculation-logic differences. This is a genuine mechanical ESM port.

**[MEASURED] Gross to net conversion — correctly implemented.** `toNetOfResting()` computes `resting = 1.0 × 3.5 × bw / 200 × duration` and subtracts the **same absolute amount** from `estimated_active_kcal`, `lower_kcal` and `upper_kcal`. Because a constant shift applies equally to prediction and truth, both the *absolute* error and the *interval width* are preserved. Negative gross values are deliberately passed through unmodified so validation still catches them. This is a sound implementation of the contract's §3 definition, and it closes the open question from `V1_PRE_INTEGRATION_AUDIT.md` #2.

**[INFERENCE]** Layer separation is good engineering: canonicalization and net conversion sit outside the frozen model, keeping the ported file minimally-diffed and auditable. **I found no ML correctness bug in the integration.** The problems below are in the *model*, not the port.

---

## 2. Training-data coverage

**[REPO]** From `MODEL_CARD.md`, `DATA_AUDIT.md` and the artifact's own `trained_on` block:

| Property | Value |
|---|---|
| Participants | **14** (reis2017 + reis2019 — proven same cohort) |
| Observations | 1,001 |
| Sex | **100% male** |
| Age | ~20–35y (cohort mean 27.5 ± 4.9) |
| Body weight | **Cohort mean only: 78.67 kg — no individual weights exist** |
| Exercises | 8 |
| Session type | **100% isolated single-exercise bouts** |
| Bout duration | 4–5 min (12–24% 1RM); 26–56 s (80% 1RM) |
| Multi-exercise sessions | **Zero** |

**[MEASURED]** Against the app's own library: the seeded `exercise_library` contains **207 exercises**; roughly **6–8 map to the trained 8** (~4% coverage), and three of those are approximate (`incline_db_press` vs barbell; `triceps_pushdown` vs "triceps"; `squat` vs a *half-squat on a guided rig*).

---

## 3. Body-weight analysis

**[MEASURED] Scaling is exactly linear at 3.675 kcal/kg** (moderate, 60 min), confirmed across 40–150 kg. The algebra:

```
Net = (MET − 1) × 3.5 × bw/200 × dur   +   correction × dur
       \___________ scales with bw ___/     \__ CONSTANT __/
```

**[ASSUMPTION] Linear body-weight scaling is inherited from the ACSM MET formula, not validated by this project.** It is standard and physiologically defensible for weight-bearing work, but it was never tested here — it could not be, because no individual body weights exist in the training data.

**[MEASURED] CRITICAL — the correction term is a fixed kcal/min, so its relative influence swings ~10x across the body-weight range.** Bench press, moderate, 60 min:

| Body weight | Net kcal | Correction contribution | As % of net |
|---|---|---|---|
| 40 kg | 47 | −100 | **−213%** |
| 65 kg | 139 | −100 | −72% |
| **78.67 kg (fit weight)** | 188 | −100 | −53% |
| 100 kg | 267 | −100 | −38% |
| 150 kg | 451 | −100 | **−22%** |

**[INFERENCE]** The correction was fitted at one cohort weight. Applying it as a constant means a 40 kg user's estimate is dominated by a term calibrated for someone twice their size. There is no physiological basis for a body-weight-invariant correction; this is a data limitation (no individual weights) surfacing as a modelling defect.

**[MEASURED] Zero-clamping occurs at low body weight.** Worst case (BICEP_CURL, most negative moderate correction −2.203):

| bw | tier | gross | net | status |
|---|---|---|---|---|
| 30 kg | moderate | 10 | **0** | clamped to zero |
| 35 kg | moderate | 33 | **0** | clamped to zero |
| 40 kg | moderate | 57 | 15 | implausible for 60 min |
| 45 kg | moderate | 80 | 33 | implausible |

**[INFERENCE]** 30–35 kg is outside adult range, but **40–50 kg is not** — that covers real adult women, precisely the population with zero representation in training. A 60-minute workout returning 15 kcal is not a defensible output. These cases *are* flagged via `body_weight_validity` (57.3–100.1 kg), but a flag does not prevent a wrong number being displayed.

**Attribution:** training data (no individual weights) → model (constant correction). **Not** the integration layer.

---

## 4. Duration analysis

**[REPO]** Artifact's `source_measured_bout_duration_minutes`: `hard: 1, moderate: 5, light: 5`.

**[MEASURED]** Net kcal/min is **perfectly constant within a tier regardless of duration**:

| Tier | 5 min | 60 min | 180 min | Max × training bout |
|---|---|---|---|---|
| light | 2.60 | 2.73 | 2.73 | **36x** |
| moderate | 2.80 | 2.92 | 2.92 | **36x** |
| hard | 9.60 | 9.73 | 9.73 | **180x** |

**[ASSUMPTION]** Constant-rate extrapolation — `calories = rate × duration` — with no fatigue decay, no rest accumulation, no EPOC.

**[INFERENCE] This is the model's single largest scientific weakness.** The training bouts were continuous work; a real session's `duration_minutes` is wall-clock time *including all inter-set rest*. A 60-minute logged session might contain 15 minutes of actual work. Applying a continuous-work rate across wall-clock time is a systematic **over**-estimation, and it scales linearly with how much the user rests.

**Corroboration [MEASURED, external]:** the Adeel 2021 cluster (Taipei Medical University, CC BY 4.0, Cortex Metalyzer 3B) measured squat/deadlift/shoulder press at 60% 1RM within a realistic set/rest structure and found **1.3–3.4 METs** — while reis2017's 80% 1RM squat measures **26.1 METs**. Two independent labs, ~8x apart, because one measured a max-effort bout and the other measured within a full session structure. That gap is the extrapolation risk made concrete.

**Is the current warning sufficient? [INFERENCE] No.** The flag fires on essentially every real session (any workout > 5 min), so it carries no discriminating information — it marks the universal case, not the unusual one. It cannot distinguish a 15-minute session from a 3-hour one. **Note:** it is *correct* that the flag exists and it should not be removed; the limitation is that it belongs in the model card rather than as a per-session signal.

---

## 5. Multi-exercise analysis

**[MEASURED]** All cases executed against the shipped backend module (75 kg, 60 min, moderate unless noted).

**5a — Order invariance: PASS.** BENCH→SQUAT and SQUAT→BENCH both return exactly 386 kcal. Correct: volume-weighting is commutative.

**5b — Set count at fixed volume: PASS.** 2 sets/4000 kg and 10 sets/4000 kg both return 175 kcal. `sets` is used *only* as a fallback weighting basis when volume is unavailable — never as an independent driver. **[INFERENCE]** Defensible given the training data has no set counts, but it means the model cannot distinguish 2 heavy sets from 10 light ones at equal tonnage.

**5c — Exercise composition changes the estimate**, as designed: 1 known 175, 2 known 168, 4 known 162, 8 known 282 kcal. The jump at 8 is because that set includes the positively-corrected lower-body exercises, not because of the count itself.

**5d — CRITICAL: the estimate RISES as the model knows LESS.**

| Unknown volume share | Net estimate |
|---|---|
| 0% | 175 kcal |
| 25% | 200 kcal |
| 50% | 225 kcal |
| 75% | 250 kcal |
| **100%** | **275 kcal (+57%)** |

**[INFERENCE]** Mechanism: bench press carries a negative moderate correction (−1.672); unknown exercises get **zero** correction, which pulls the estimate back up toward raw baseline. The perverse consequence: **a user whose exercises the system recognises receives a lower estimate than one logging unrecognised exercises.** This is not a coding bug — zero-correction is the documented contract — but the *direction* is systematically wrong for the exercise types most likely to be unmapped.

**[ASSUMPTION]** Volume-weighted blending of per-exercise corrections across a session. **Never validated** — every source study measured one exercise at a time. `MODEL_CARD.md` states this openly.

**Verdict on this section's core question:** for multi-exercise sessions the model produces a **numerically valid but scientifically unvalidated** result. Order and set-count behaviour are correct; the blending assumption and the unknown-exercise direction are not evidenced.

---

## 6. Unknown-exercise analysis

**[REPO] PASS — no silent guessing.** `to_canonical()` raises `KeyError` on an unrecognised label rather than guessing; the runtime path applies zero correction and widens the interval proportionally to unknown volume share. Behaviour matches `unmapped_exercise_fallback` in the artifact. Confirmed by reading both the ontology and the shipped module.

**[MEASURED] But zero-correction is NOT a neutral choice:**

| Tier | Mean correction of known 8 | Median | Negative |
|---|---|---|---|
| light | +1.272 | +1.094 | 3/8 |
| moderate | +0.115 | −0.031 | 5/8 |
| **hard** | **+9.061** | +8.422 | **0/8** |

**[INFERENCE]** At **moderate**, zero sits near the mean (+0.115) — defensible. At **hard**, every known exercise has a positive correction averaging **+9.061 kcal/min**, so an unknown exercise at hard tier is under-corrected by roughly that amount — a large systematic **under**-estimate. Conversely, for upper-body isolation specifically (bicep curl / triceps / lat pulldown mean **−1.963** at moderate) — which is what most unmapped exercises actually are (lateral raise, face pull, shrug, straight-arm pulldown) — zero-correction **over**-estimates by ~2 kcal/min.

**Threshold recommendation:** **[INFERENCE, evidence-limited]** I decline to propose a numeric cut-off. The evidence supports the *direction* of the bias but not a defensible boundary — that would require measured data on unmapped exercises, which does not exist. What the evidence *does* support: **a session dominated by unknown exercises at hard tier is the least trustworthy combination in the entire model**, and is the strongest candidate for baseline-only treatment if a rule is wanted before data arrives.

---

## 7. Accuracy metrics

**[MEASURED]** From `model_e_lopo_predictions_v0.csv` — genuine leave-one-participant-out, out-of-sample, in **kcal/min GROSS**:

| Metric | Value |
|---|---|
| n | 1,001 |
| MAE | 1.353 kcal/min |
| RMSE | 2.206 kcal/min |
| Bias | **+0.002** (essentially unbiased) |
| MAPE | 19.10% |

**By exercise:**

| Exercise | n | MAE | RMSE | Bias | MAPE |
|---|---|---|---|---|---|
| BARBELL_SQUAT | 126 | 1.72 | 2.31 | +0.03 | 13.26% |
| BENCH_PRESS | 126 | 0.73 | 1.07 | +0.10 | 14.71% |
| LAT_PULLDOWN | 126 | 0.70 | 1.25 | −0.01 | 15.15% |
| BICEP_CURL | 125 | 0.84 | 1.11 | −0.09 | 19.24% |
| LEG_PRESS | 124 | 1.64 | 2.28 | +0.01 | 19.72% |
| TRICEPS_EXTENSION | 126 | 1.00 | 1.49 | −0.01 | 21.15% |
| INCLINE_BENCH_PRESS | 122 | 1.63 | 2.59 | −0.02 | 22.54% |
| **LEG_EXTENSION** | 126 | **2.56** | **3.94** | −0.00 | **27.17%** |

**By intensity tier:**

| Tier | n | MAE | RMSE | MAPE |
|---|---|---|---|---|
| light | 445 | 0.86 | 1.12 | 16.95% |
| moderate | 444 | 1.23 | 1.71 | 20.12% |
| **hard** | 112 | **3.78** | **5.19** | **23.63%** |

**Metrics that CANNOT be computed — stated rather than invented:**

| Requested | Why impossible |
|---|---|
| Error by body-weight range | **[REPO]** No individual body weights exist — one cohort mean (78.67 kg) for all 14 participants |
| Error by duration range | **[REPO]** Duration is protocol-level (4–5 min / 26–56 s), not per-observation — no variation to bin |
| Single vs multi-exercise | **[REPO]** 100% of rows are isolated single-exercise bouts; zero multi-exercise sessions exist |

**Insufficient evidence for production accuracy claims** on real SK OS sessions. The metrics above describe performance on 14 male participants doing isolated lab bouts, which is not the deployment population or the deployment task.

### 7.1 [MEASURED] The 19.1% figure does not transfer to the shipped output

The MAPE above was measured on **gross** kcal/min. The product reports **net**. A constant shift leaves absolute error unchanged but shrinks the denominator:

| Scenario | gross | net | net/gross | Implied MAPE on net |
|---|---|---|---|---|
| 75 kg, 60 min, hard | 663 | 584 | 0.88 | 21.7% |
| 100 kg, 45 min, moderate | 596 | 517 | 0.87 | 22.0% |
| 75 kg, 60 min, moderate | 254 | 175 | 0.69 | **27.7%** |
| 65 kg, 115 min, moderate | 369 | 238 | 0.64 | **29.6%** |
| 50 kg, 90 min, light | 172 | 93 | 0.54 | **35.3%** |

**[INFERENCE]** Any external accuracy claim must state roughly **22–35% on net output**, not 19.1%. The degradation is worst for light-intensity, long-duration, low-body-weight sessions — i.e. beginners and lighter users, the populations already least represented in training.

---

## 8. Calibration gaps

1. **[MEASURED]** Interval coverage was validated on gross single-exercise bouts only. The net conversion preserves interval *width* (correct), but `Math.max(0, …)` clamps `lower_kcal` — the lower bound hit 0 in most 60-minute test cases. An asymmetrically truncated interval no longer delivers its stated 90% coverage.
2. **[MEASURED]** No multi-exercise coverage test exists, or can exist, with current data.
3. **[REPO]** Interval width is global, not per-exercise, despite LEG_EXTENSION's RMSE (3.94) being ~5.6x LAT_PULLDOWN's (0.70).
4. **[MEASURED]** The duration-extrapolation flag fires on effectively every real session, so it cannot discriminate between mild and extreme extrapolation.
5. **[REPO/ASSUMPTION]** The %1RM-to-tier mapping (12–24% → light/moderate, 80% → hard) is an unvalidated approximation. Real "moderate" training is typically 60–80% 1RM — nothing like 20–24%.

---

## 9. Data required for stronger validation

Per-session, from real workouts once the `/start` integration lands. **No unnecessary PII** — no names, emails, dates of birth, addresses, or free-text notes.

**Identity / linkage**
- `session_id` (opaque), pseudonymous `participant_ref` (study-local, not `user_id`)
- `started_at`, `completed_at` (UTC, **server-authoritative**), `duration_min`

**Physiology (required)**
- `body_weight_kg` — **individual, not cohort** (the single most valuable missing field)
- `sex`, `age_band` (banded, e.g. 18–29 / 30–39 — not date of birth)
- Optional: `height_cm`, body-fat %

**Workout**
- Per exercise: `exercise_id`, canonical token (or explicit `null` if unmapped), `sets`, per-set `actual_reps`, `actual_weight`, `rir`, `completed`
- `total_volume_kg`, `workout_type`/template, `intensity_rating` as submitted
- `rest_seconds` (prescribed) — **[MEASURED]** currently `NOT NULL DEFAULT 90`; verify `SELECT COUNT(DISTINCT rest_sec) > 1` or it carries no information

**Reference measurement (the actual blocker)**
- `measured_kcal`, method, **named device**, calibration record, and whether the value is **gross or net** — without this, everything above is unlabelled data
- Separately-measured resting EE, so gross and net can both be derived rather than assumed

**Provenance:** `app_version`, `model_version`, `provider` used, and `is_synthesized = false` **verified**.

---

## 10. Scientific / technical limitations

1. **[REPO]** n=14, 100% male, ~20–35y — no women, no older adults, no beginners.
2. **[REPO]** Zero individual body weights, so body-weight scaling is assumed rather than learned.
3. **[REPO]** Zero multi-exercise sessions, so session blending is unvalidated.
4. **[ASSUMPTION]** Constant-rate duration extrapolation, up to 180x the measured bout.
5. **[REPO]** BARBELL_SQUAT was measured as a **half-squat on a guided rig**, not a free-weight back squat. The artifact carries `data_source_variant_note`, but the app's `squat` entry is "Back Squat".
6. **[MEASURED]** ~4% exercise-library coverage (8 of 207).
7. **[MEASURED]** Hard tier is the weakest everywhere: worst MAPE (23.63%), worst RMSE (5.19), largest corrections (up to +27.97 kcal/min), and **[REPO]** all 112 hard-tier rows come from a single source file (reis2017) with no independent cross-check.

---

## 11. Security / data-quality concerns

**[REPO]** No security defects found in the ML path. Reviewed and confirmed sound:
- ML is opt-in (`CALORIE_MODEL_PROVIDER=ml`); baseline is the default provider.
- The model is a pure function over a JSON lookup table — no `eval`, no network access, no filesystem access, no user-controlled code path.
- Timeout boundary and baseline fallback exist; output passes `validateCalorieResult()` before persistence.
- Organization isolation and RLS are untouched by this integration.

**Data-quality concerns (not security):**
1. **[MEASURED]** `exercise_set_logs.rest_seconds` is populated from *prescribed* `rest_sec` (`NOT NULL DEFAULT 90`), not measured rest. If trainers never customise it, the column is constant and carries zero information.
2. **[REPO]** In `finishWorkout` (frontend `Workout.jsx`), every set of an exercise receives the same `actual_reps`/`actual_weight` — one `execInputs` entry per exercise, not per set. Drop sets and ramping loads therefore collapse to a single value, despite the schema supporting per-set detail. This systematically distorts `total_volume_kg`, which is the model's blending weight.
3. **[REPO]** `is_synthesized` must be verified false for any row entering validation — one mislabelled legacy row would poison the calibration set.

---

## 12. Production-readiness verdict

# C — RESEARCH / EXPERIMENTAL

Not A. Not B.

**[INFERENCE]** I am deliberately placing this one tier *below* the "staging-only" expectation stated in the brief, and the reason is specific: **B (staging-only) implies the model is validated for its intended use and merely awaiting operational hardening. It is not.** The engineering genuinely is staging-quality — clean port, correct net conversion, sound fallback, no security issues. But the *model* has never been evaluated on:

- a single multi-exercise session (0 in training data)
- a single female participant (0 in training data)
- a single individual body weight (0 in training data)
- any session longer than 5 minutes (0 in training data)

Every real SK OS workout is all four of those simultaneously.

**[MEASURED]** The one real-world comparison available — a 115-minute, 65 kg, 10-exercise session — produced 525 kcal gross against a WHOOP reading of 794 kcal, with body-weight-scaled calorimetry literature suggesting ~445 kcal. Three sources, ~1.8x spread, and no ground truth to arbitrate between them.

This classification refers to the **model's evidence base**, not to integration quality. Keeping ML opt-in and default-off, as currently configured, is the correct posture and should not change.

---

## 13. Recommended next ML work

Ranked by evidence gained per unit of effort:

1. **Persist real sessions with server-authoritative duration** once `/start` lands. Costs nothing extra, and every session becomes a future validation row.
2. **Fix per-set logging** (concern 11.2) — `total_volume_kg` is the model's blending weight and is currently distorted for any non-uniform exercise.
3. **Track exercise-id usage distribution.** If real usage concentrates on 15–20 exercises, that becomes the ranked measurement priority list — turning "what should we measure" from a guess into data.
4. **Pursue any independent participant-level dataset.** Four author requests are outstanding (Rustaden, João, Nakagata, Adeel). Zero cost, uncertain return.
5. **Re-scope accuracy claims to net** (§7.1) wherever 19.1% currently appears in docs or UI copy.
6. **Do not retrain, tune, or add features** until independent data exists. There is nothing to fit against and nothing to validate on.

---

## 14. Exact blockers before production

| # | Blocker | Type | Resolvable how |
|---|---|---|---|
| 1 | Zero multi-exercise validation | Scientific | Calibration data |
| 2 | Zero individual body weights, so §3 defect is unfixable | Scientific | Calibration data |
| 3 | Duration extrapolation up to 180x, unvalidated | Scientific | Calibration data |
| 4 | No female / older / beginner representation | Scientific | Calibration data |
| 5 | Accuracy claim (19.1%) does not apply to net output | Documentation | **Fixable now** — restate as ~22–35% |
| 6 | Interval lower bound clamps to 0, breaking stated coverage | Model | Needs per-exercise recalibration |
| 7 | Unknown-exercise bias, severe at hard tier (~9 kcal/min) | Model | Needs measured data on unmapped exercises |
| 8 | Per-set logging distorts `total_volume_kg` | Engineering | **Fixable now** — frontend/backend |
| 9 | ~4% exercise-library coverage | Scientific | Calibration data |

**[INFERENCE]** Blockers 1–4 and 9 share one root cause and one resolution: **real measured energy expenditure on real SK OS sessions.** No amount of modelling, tuning, or literature search closes them — confirmed across five rounds of dataset search covering Kaggle, Hugging Face, Zenodo, OSF, Figshare, Dryad, UCI, PMC and direct journal supplements, which together yielded zero usable participant-level rows.

Blockers 5 and 8 are fixable immediately and are the only two I would action before new data exists.

---

**Audit ends.**

---

# ADDENDUM — REMEDIATION (2026-08-17)

Following the audit, all blockers that could be closed **without inventing evidence** were closed. `model_v1.json` and every fitted coefficient remain untouched; `backend/`, `database/` and `frontend/` were not modified.

## Fixed

| # | Blocker | What was done |
|---|---|---|
| **5** | 19.1% claim doesn't apply to net output | **CLOSED.** `MODEL_CARD.md` now carries a "read before quoting" banner plus a net-accuracy table (~22–35%). `HANDOFF_NOTE_FOR_KAUSHAL.md` and `ML_DATA_REQUIREMENTS.md` updated to label every figure GROSS and point to the net range. The gross/net contract question is marked **resolved** in the handoff note (the backend answered it). |
| **6** | Interval clamps at 0, silently breaking 90% coverage | **MITIGATED.** `displayEstimate.js` now detects lower-bound truncation and returns `full_range_coverage: "undefined (lower bound truncated at 0)"` with `full_range_coverage_valid: false`. A truncated band can no longer travel labelled "90%". *Not a full fix* — restoring true coverage needs per-exercise recalibration, which needs data. |
| **7** | Unknown-exercise bias, severe at hard tier | **MITIGATED, evidence-bound.** Confidence is downgraded when unknown-exercise share ≥25% **and** zero-correction lies outside the tier's observed correction range. That condition is computed **from the artifact at load time**, not hardcoded: at `hard`, observed corrections span +0.297 to +27.969, so zero is provably outside; at `light`/`moderate` zero is inside and the rule correctly does **not** fire. The user-facing reason names the direction ("likely UNDER-counted"). **No substitute correction value was invented** — the data cannot support one. |
| **8** | Per-set logging distorts `total_volume_kg` | **SPECIFIED, NOT APPLIED.** `BLOCKER8_PER_SET_LOGGING_PATCH.md` contains the exact fix with before/after code. Confirmed still present on `origin/ui-manavi` @ `4e09a9e`. Deliberately not patched from this branch: the file is owned by an active branch, and cross-branch edits would conflict with in-flight work. Worked example: a real ramping set (15×50, 11×65, 8×75, 5×80) logs as 1,600 kg instead of 2,465 kg — **35% under-reported**. |

## Not fixed — and cannot be, without measured data

| # | Blocker | Why it stays open |
|---|---|---|
| 1 | Zero multi-exercise validation | Requires measured energy expenditure on real multi-exercise sessions. None exists. |
| 2 | Zero individual body weights | The §3 constant-correction defect is a direct consequence. No dataset found in five search rounds contains individual weights. |
| 3 | Duration extrapolation up to 180× | Requires measurement across realistic session lengths. |
| 4 | No female / older / beginner representation | Requires a different cohort. |
| 9 | ~4% exercise-library coverage | Requires measuring more exercises. |

**These five share one root cause and one resolution: real measured energy expenditure on real SK OS sessions.** Any "fix" applied to them now would be fabrication, so none was attempted.

## Verification

- `ml/tests/` — **40/40 pass** (Python pipeline + V2 infrastructure)
- `ml/models/skos-cal-v1/mlEstimate.test.js` — **19/19 pass**, including 5 new regression tests covering blockers 6 and 7. One specifically asserts the hard-tier rule is derived from the artifact, so it stops firing automatically if a future retrain changes the correction ranges.
- `git status` confirms `model_v1.json`, `backend/`, `database/` and `frontend/` unmodified.

## Verdict after remediation: unchanged — **C (Research/Experimental)**

The four closable blockers were engineering and documentation defects. The five that remain are the ones that actually determine trustworthiness, and none of them moved. **ML must stay opt-in and default-off.**
