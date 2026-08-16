# Phase 9 — Calibration Cohort Study Protocol

**Status: protocol design, ready to send to a partner lab. No lab contacted, no data collected, no commitments made.**

This is the document a partner lab actually needs — a real protocol they can evaluate, critique, and cost, rather than a partnership pitch. Companion to `PHASE9_CALIBRATION_COHORT_PLAN.md` (the why/who) and `OUTREACH_DRAFT_LAB_PARTNERSHIP.md` (the approach email).

**Every major design decision below traces to a specific unresolved finding in `V1_PRE_INTEGRATION_AUDIT.md`.** This study is not "collect more data" — it is a targeted attempt to resolve five named defects that no amount of literature search can fix.

---

## 1. What this study exists to resolve

| Audit finding | Status after 5 rounds of literature search | How this study resolves it |
|---|---|---|
| **#2** — is `estimated_active_kcal` gross or net of resting? | Unresolved; needs a product/contract decision *and* a measurement | Measure resting EE separately per participant → both quantities computable, decision becomes empirical |
| **#3/#4/#5** — short-bout rates extrapolated across a full session produce impossible numbers | Independently corroborated (Adeel cluster, ~8x gap vs reis) but never *directly measured* over a real session | Measure continuously across the **entire session including rest periods** — the exact quantity production's `duration_minutes` refers to |
| **#13** — corrections cannot scale with body weight (source studies never recorded individual weights) | Unresolved. **Zero** of the 5 SILVER candidates publish individual body weight | Record individual body weight for every participant. This is non-negotiable. |
| **#9** — interval coverage validated only on isolated single-exercise bouts | Unresolved | Real multi-exercise sessions give the first genuine multi-exercise coverage test |
| **#8b** — %1RM→intensity-tier mapping never validated against real user behaviour | Unresolved | Participants log real `intensity_rating` in the app; actual loads recorded alongside |

Secondary but real: this is the first time SK OS's **actual production logging path** gets validated end-to-end against physical truth.

---

## 2. Design summary

**Type:** Cross-sectional criterion-validation study. Not an intervention trial — nobody is randomised to anything, nothing is being compared for efficacy. Participants train as they normally would; we measure what it costs.

**Primary outcome:** Measured energy expenditure (kcal) over a complete resistance-training session, via indirect calorimetry, paired with the SK OS app's own logged record of that same session.

**Primary analysis:** V1's predicted kcal vs. measured kcal for each session — MAE, MAPE, R², and bias, evaluated with participant-grouped cross-validation (never random splits).

**Explicitly NOT a goal:** producing a flattering accuracy number. If V1 performs badly on real users, that is the finding, and it is more valuable than a good number obtained by measuring something convenient.

---

## 3. Participants

### Sample size — derived, not assumed

Bootstrapped from V1's own 14 genuine leave-one-participant-out per-participant MAPEs (`ml/scripts/phase9_sample_size_analysis.py`, reproducible):

| Cohort n | 95% CI width on cohort MAPE | Verdict |
|---|---|---|
| 5 | ±3.1 pts | Too wide to conclude anything |
| 10 | ±2.1 pts | Detects only large differences |
| 15 | ±1.7 pts | Workable minimum |
| **20** | **±1.5 pts** | **Minimum viable** |
| **30** | **±1.3 pts** | **Target — returns flatten past here** |
| 50 | ±1.0 pts | Diminishing returns |

- **Minimum viable: 20 participants.** Below this, "V2 beats V1" cannot be distinguished from noise.
- **Target: 30 participants.** Where CI width stops improving materially, and enough to stratify (~6 per cell × 5 cells).
- **Sessions: ≥1 per participant, 2 where feasible.** A repeat session gives within-person variability — a quantity nothing in our current data can estimate at all.

**Stated limitation:** this bootstrap uses 14 young men doing isolated lab bouts. Real SK OS users will vary *more*, not less. **Treat 20/30 as a floor, not a target.** Re-run the analysis on the real cohort's own residuals after ~10 participants to check whether the assumption held.

### Stratified recruitment — deliberately NOT convenience sampling

The single biggest threat to this study's value is recruiting only the fittest, most enthusiastic gym members — that would reproduce exactly the young/fit/male skew that makes the existing literature unusable for SK OS. Target roughly equal cells:

| Stratum | Target n | Why (which gap it closes) |
|---|---|---|
| Women | ≥12 (40%) | V1 training data is 100% male. Largest single gap. |
| Age 40+ | ≥8 | V1 validated only on ~20-35y |
| Beginners (<6 months training) | ≥8 | V1's population is "trained or newly sedentary" |
| Experienced (>2 years) | ≥8 | Untested population |
| Body weight <60kg and >90kg | ≥5 each | V1's corrections don't scale with weight at all (#13); need real spread to detect it |

Cells overlap (one person can be a 45-year-old beginner woman) — these are minimums per stratum, not exclusive groups.

**Inclusion:** Active SK OS user, 18+, medically cleared for resistance exercise per the partner lab's standard screening.
**Exclusion:** Per partner lab's standard criteria (cardiovascular/metabolic contraindications, etc.) — the lab owns this, not SK OS.

---

## 4. Measurement protocol

### 4.1 The critical design decision: measure the WHOLE session

**Continuous gas collection from before the first set to after the last, including every inter-set and inter-exercise rest period.**

This is the single most important specification in this document. Every existing study either measured isolated bouts (reis) or exercise periods only (Adeel). Production's `duration_minutes` is **whole-session wall-clock time**, so that is what must be measured. Doing otherwise reproduces the exact mismatch that caused audit finding #3.

### 4.2 Session sequence

| Step | Duration | What's recorded | Resolves |
|---|---|---|---|
| 1. Anthropometry | — | Height, **individual body weight (kg)**, body composition if available | #13 |
| 2. Seated resting EE | 15 min (analyse final 10) | Resting VO₂/VCO₂ → resting kcal/min | **#2** |
| 3. Warm-up | As participant normally does | Logged, flagged as warm-up | — |
| 4. **Full training session** | Whatever the participant normally trains (target 30–90 min) | Continuous VO₂/VCO₂; HR; timestamps | **#3/#4/#5, #9** |
| 5. Post-session recovery | 15 min seated | Continuous VO₂/VCO₂ | EPOC (secondary) |

**Participants train their own normal session.** Do not prescribe a standardised workout — a prescribed protocol would measure the protocol, not SK OS's actual use case. Multi-exercise sessions are the point, not a complication.

### 4.3 Equipment

- **Portable metabolic system** (COSMED K5 / K4b2, Cortex MetaMax 3B, or lab equivalent) — must be portable; a stationary cart cannot follow someone around a gym floor.
- Calibrated before every session per manufacturer spec; calibration log retained as part of the data record.
- HR monitor (chest strap preferred over optical).
- **Energy computation:** Weir equation from VO₂ and VCO₂. Record the equation used — do not accept a device's built-in kcal output without knowing its formula (that is precisely the undocumented-methodology problem that disqualified every Kaggle/HF dataset).

### 4.4 Parallel app logging — validate the real path

The participant logs the session **in the SK OS app themselves, exactly as they normally would.** Not a researcher transcribing afterwards. This makes the study a test of the real production data path, including its imperfections (mislogged reps, forgotten sets, wrong intensity ratings) — which is what we actually need to know about.

**Clock synchronisation is mandatory.** Record device clock offset between the metabolic system and the phone at session start, to the second. Everything downstream depends on aligning two independent time series; an unrecorded offset silently corrupts the entire session.

---

## 5. Data SK OS must export per session

Extends `ML_DATA_REQUIREMENTS.md`. Per session:

**Identity/alignment**
- `calibration_participant_id` — lab-assigned, stable, **assigned from day one** (V1 only discovered the reis2017/reis2019 cohort overlap through post-hoc numeric proof; design against that rather than repeat it)
- `session_id`, `started_at`, `ended_at` (UTC, second precision), `clock_offset_seconds`

**Everything schema-0.2 already carries** — `body_weight_kg`, `duration_minutes`, `intensity_rating`, `exercises[]` with `exercise_id`, `sets`, `reps`, `load_kg`, `total_volume_kg`, `completed_sets`

**Study-specific additions**
- `is_synthesized` — must be `false` and **verified**, per `ML_DATA_REQUIREMENTS.md` item 2. One mislabelled synthetic row poisons the exact thing this phase exists to fix.
- `app_version`, `model_version_shown_to_user` (if any estimate was displayed)

**From the lab, per session**
- Time-series VO₂/VCO₂ (breath-by-breath or averaged, with averaging window stated)
- Resting EE (kcal/min), session EE (kcal, gross), recovery EE (kcal)
- Device, calibration log, energy-computation equation
- Participant demographics: age, sex, **individual body weight**, height, training experience

---

## 6. Analysis plan — pre-specified

Written before data exists, so the analysis can't drift toward a flattering result.

**Primary**
1. V1 predicted vs. measured session kcal. MAE, MAPE, R², bias. Grouped by participant.
2. **Gross vs. net comparison (#2):** compute both `session_gross_kcal` and `session_gross − (resting_rate × duration)`. Report V1's error against *both*. Whichever V1 matches better is empirical evidence for what `estimated_active_kcal` should mean — replacing a contract-negotiation question with a measurement.
3. **Duration relationship (#3):** regress error against session duration. If error grows with duration, the extrapolation defect is confirmed in the real population and the plausibility cap's necessity is proven rather than assumed.
4. **Body-weight relationship (#13):** regress error against body weight. A significant slope demonstrates the missing scaling term and — for the first time — provides the data to fit it.

**Secondary**
5. Subgroup performance: sex, age band, training status, body-weight band. Report **INSUFFICIENT DATA** wherever a cell is too small. Never manufacture a subgroup number.
6. Interval coverage: what fraction of measured values fall inside V1's 80%/90% intervals — the first genuine multi-exercise coverage test (#9).
7. `intensity_rating` validation (#8b): what %1RM do users' self-reported light/moderate/hard actually correspond to?

**Only if primary analysis justifies it:** fit the V2 residual model via `ml/src/v2/residual_model.py`, using participant-grouped CV. The Phase G guard (`fit_and_save_v2_model`) unlocks only when independent participants exist — which, after this study, they finally would.

**Stopping rule:** if V1 performs acceptably on real users, **do not ship a V2 just because data was collected.** The correct outcome may be "V1 validated, limitations documented, no new model needed."

---

## 7. Governance

- **Ethics/IRB:** owned by the partner lab. SK OS's role is recruitment access and data sharing, not running the ethics review.
- **Consent must explicitly cover** commercial use of derived models — otherwise this repeats the Benito 2016 problem, where excellent data is permanently unusable because consent didn't anticipate it. Get this right at the consent-form stage; it cannot be fixed afterwards.
- **Participant IDs:** lab-assigned, never SK OS `user_id`. `user_id` is used only to join the session record, never as a model feature.
- **Publication:** the lab should be free to publish. Their incentive is a dataset in a population the literature lacks — real gym members rather than undergraduate volunteers.

---

## 8. What SK OS must decide before this can start

1. **Which lab** — SRCSS Chennai (best equipment match found) or NSNIS Patiala. See `PHASE9_CALIBRATION_COHORT_PLAN.md`.
2. **Budget** — unknown until a lab quotes; portable calorimetry sessions are the main cost driver.
3. **Recruitment access** — which gyms, and how members are approached (stratified, not "whoever volunteers first").
4. **The `[N]` figure** in `OUTREACH_DRAFT_LAB_PARTNERSHIP.md` — real current gym/client count, needed before that email can go out.

None of these are technical blockers. The protocol is ready.
