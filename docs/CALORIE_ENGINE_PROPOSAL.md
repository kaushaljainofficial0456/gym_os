# Proposal: an exercise-aware, session-level calorie engine for BARBELL

Status: **proposal for review. Nothing in it is implemented.**
- The production estimator (`skos-cal-baseline-v2`) stays the default and is the baseline every
  proposal is measured against.
- No merge or deployment without approval.

Every statement is tagged:
- **[FACT]** — verified in our own code or data in this repo.
- **[EVIDENCE]** — published research. Strength is noted; full texts were mostly unreachable
  from this environment, so most of it was read from abstracts and summaries.
- **[ASSUMPTION]** — something we rely on without having verified it.
- **[HYPOTHESIS]** — something we propose to test.

---

## 1. Audit: how a strength workout's calories are calculated today

### 1.1 The path [FACT]

1. **During the session** (`frontend/src/pages/client/Workout.jsx`) the member ticks sets,
   typing reps and weight for each. Nothing else is recorded per set:
   - no set start/end time;
   - no RIR/RPE;
   - no rest timer.

   One timer runs for the whole session; pauses are subtracted.
2. **Finish** → `POST /workouts/:id/complete` with:
   - per-exercise ticked sets `{actual_reps, actual_weight}`;
   - `duration_seconds` = wall-clock time since start minus paused time;
   - `paused_ms`.
3. **Backend** (`backend/src/routes/workouts.js`):
   - stores sets in `exercise_set_logs`;
   - sets `duration_min` from `duration_seconds`;
   - resolves body weight: weight log nearest the day → profile current → start → target
     weight → none;
   - builds the contract-0.2 input (`buildWorkoutCalorieInput`).
4. **Estimate** (`calorieModel.js`, `baselineEstimate`):

   ```
   MET        = {light 3.0, moderate 3.5, hard 6.0}[effort]       (2024 Compendium session codes)
   gross/min  = MET × 3.5 × body_mass_kg ÷ 200
   resting/min= Mifflin-St Jeor BMR ÷ 1440   (needs weight, height, age, sex; else 1 MET)
   net kcal   = (gross/min − resting/min) × active minutes
   band       = same with gross/min × 0.75 and × 1.25                (not a calibrated interval)
   ```

   - **Effort at completion** is inferred from set RIR. The live UI sends no RIR, so this is
     **always "moderate"**.
   - **The summary then asks** "light / moderate / hard?". The answer is saved and the estimate
     recomputed (`POST /workouts/:id/effort`).
5. **Missing duration** (retroactive logs): minutes = max(15, sets × (1.6 + rest/60)), with rest
   defaulting to 90 s.
6. **Storage and reuse.** The result goes in `workouts.estimated_active_kcal` with its range,
   model version and provider. Daily energy balance and history read it from there. Wearable
   reconciliation keeps it primary for strength sessions
   (`docs/WEARABLE_RECONCILIATION_DECISION.md`).

### 1.2 Worked examples [FACT, computed with the production code]

78 kg, 178 cm, 30-year-old man, 45 active minutes:

| Case | Net kcal [band] |
|---|---|
| answered "moderate" | 160 [107–214] |
| answered "hard" | **314** [222–406] |
| answered "light" | 130 [84–176] |
| moderate, no height/age in profile (1-MET resting) | 154 |
| moderate, no weight anywhere (70 kg default) | 138 |
| 18 sets × 10 reps at **60 kg** vs at **140 kg**, same 45 min | **160 vs 160** |
| no timed duration, 18 sets → estimated 56 min | 200 |

### 1.3 What the estimate actually depends on [FACT]

| Input | Collected? | Affects the number? |
|---|---|---|
| Active duration | yes (timer minus pauses) | **yes, linearly** |
| Body mass | yes (dated weight log or profile) | yes, roughly linearly |
| Height, age, sex | if the profile has them | yes, via resting energy only |
| Post-session effort answer | if the member answers | **yes: "hard" ≈ 2× "moderate"** |
| Exercise identity, muscle group, movement, equipment | yes (exercise library) | **no** |
| Sets, reps, external load | yes | **no** (only through the missing-duration fallback) |
| Rest between sets | **no**: never measured | — |
| Density (sets per minute) | computable from sets and duration | **no** |
| RIR / set RPE | schema has it; the live UI does not ask | no (inferred effort is always "moderate") |
| Heart rate | only via wearable integrations, for reconciliation | **no** |
| Individual metabolism | no | no |

### 1.4 Defects and gaps found

- **A1 [FACT]: `exercise_set_logs.rest_seconds` holds the *prescribed* rest**
  (`workout_exercises.rest_sec`), copied onto every set, not the rest actually taken. Any future
  analysis reading it as real rest would be wrong. It should be renamed or nulled, and real rest
  captured (§5).
- **A2 [FACT]: the effort tier is the only exercise-sensitive input, and it is a single tap after
  the session.** Stage 2 found it is a poor proxy: heavy long-rest sessions measured near
  "moderate" rates [EVIDENCE, weak: 2 studies, unverified values]. Trained lifters burn about 2×
  more at the same RPE [EVIDENCE: Adeel 2021, in repo].
- **A3 [FACT]: duration includes everything between start and finish except pauses** (warm-ups,
  chatting, phone breaks). The MET was chosen for whole sessions with rests, so this is
  *consistent* with the formula's assumption. But a member who leaves the timer running inflates
  the figure linearly.
- **A4 [FACT]: no EPOC and no anaerobic share.** The figure covers active minutes only. Whether it
  *should* is a definition question (§3.3).
- **A5 [FACT]: the ±25% band is not calibrated.** The API now says so (`reliability_reasons`).

---

## 2. What the science says about resistance-training energy expenditure

| # | Statement | Tag / strength |
|---|---|---|
| S1 | A set's energy is supplied aerobically during the set, anaerobically (glycolysis), and repaid as elevated O₂ uptake after the set. In one study of five lifts, during-set O₂ was ~18%, anaerobic ~31% and post-set O₂ ~51% of each set's cost. | [EVIDENCE] small lab studies, Scott group ([Knausenberger et al. 2014](https://wnus.usz.edu.pl/cejssm/an/issue/22/article/175)) |
| S2 | Indirect calorimetry alone likely **underestimates** resistance-exercise cost because it misses the glycolytic part, which may exceed 40% depending on training variables. Best current practice is calorimetry during and after exercise **plus** pre/post blood lactate. No accepted standard exists. | [EVIDENCE] systematic scoping review, 166 studies ([Mitchell et al. 2024, Sports Med](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11393209/)) |
| S3 | Per-set cost tracks mechanical work (load × displacement × reps) within an exercise, with a different slope per exercise. At equal work, time under tension also matters. | [EVIDENCE] small studies ([Knausenberger 2014](https://wnus.usz.edu.pl/cejssm/an/issue/22/article/175); a 2012 bench-press cadence study, [APNM](https://www.ingentaconnect.com/content/cndscipub/apnm/2012/00000037/00000002/art00008;jsessionid=1ipm1cq0jdhlc.x-ic-live-03)) |
| S4 | Larger active muscle mass → higher cost. | [EVIDENCE] review-level statement ([Adeel 2021, Appl Sci](https://www.mdpi.com/2076-3417/11/18/8773/html)); no validated muscle-mass equation found |
| S5 | Whole-session rate is driven by density / work rate. In one study, longer rests lowered session VO₂ (work rate r = .96 with VO₂; RPE weak). | [EVIDENCE] stage 2; values unverified (PMC10553797) |
| S6 | Heavier loads at matched reps mostly lengthen the session rather than raise its per-minute rate. | [EVIDENCE] one study (Joao 2021), unverified values; **[HYPOTHESIS]** in general |
| S7 | Published session-level prediction equations explain modest variance (e.g. R² 0.61 for one 75% 1RM protocol; R² 0.54 and 0.16 in trained women). None generalises across protocols. | [EVIDENCE] ([João 2020, Cogent Med](https://doaj.org/article/6c04ebb1ea6843cfb1534794fdb88e3f); [AUT thesis](https://openrepository.aut.ac.nz/items/40f63332-ea15-4909-a6bc-1b1fbfa9574f)) |
| S8 | Lytle 2019: net kcal from height, age, fat mass, lean mass and training volume (R .773, SEE 28.5 kcal), for one protocol. Needs body composition. | [EVIDENCE] one study; volume unit unverified |
| S9 | The HR–VO₂ slope during weightlifting is about **half** that of running/cycling. HR therefore **overstates** metabolic demand in lifting if aerobic calibrations are used. Low-intensity sets in trained young men were estimated within 10% from HR. | [EVIDENCE] older lab study ([PubMed 2072844](https://pubmed.ncbi.nlm.nih.gov/2072844/)); [Reis 2019, PLoS ONE](https://ideas.repec.org/a/plo/pone00/0221284.html) |
| S10 | Consumer wrist devices disagree widely on lifting sessions, in both directions. | [EVIDENCE] weak/unverified (stage 2) |
| S11 | Individual differences: trained vs untrained differ ~2× at the same relative load. Body size and lean mass explain part of the between-person variance. | [EVIDENCE] Adeel 2021; Lytle 2019 |

**What follows for BARBELL:**
1. Sets × reps × load alone **cannot** determine energy. They describe mechanical work, which is
   only one driver (S1, S3) and is converted with exercise- and person-specific efficiency we
   do not know.
2. **Time structure** (work vs rest, density) carries information the current formula ignores
   (S5).
3. HR is promising only with **lifting-specific, ideally individual,** calibration (S9).
4. Even the lab criterion is uncertain by a large, protocol-dependent margin (S2). Accuracy
   claims must state which criterion they are against.

---

## 3. Proposed architecture

### 3.1 Principles
- **Same output contract** as today: net kcal plus range plus `basis` / `reliability`. Same
  provider gate, validation and fallback. The baseline stays the default.
- **Structure from physiology; numbers from measurement.** Every coefficient is estimated from
  criterion data with stated uncertainty. **No coefficient is hand-set.**
- **Partial pooling.** Exercises borrow strength from their movement pattern and muscle group;
  people borrow from the population until their own measurements justify departing from it.
- **Shadow before live.** A candidate computes alongside the baseline, logged but not shown,
  until it passes the decision rule.

### 3.2 Engine components

```
net session energy  =  Σ_sets  E_set(exercise, load, reps, set time, person)       [work]
                     +  Σ_rests E_rec(rest length, preceding set cost, person)        [recovery between sets]
                     (+ E_post(session) : only if the definition in §3.3 includes it)
```

| # | Component | Proposed form [HYPOTHESIS until fitted] | Inputs | Where its numbers come from |
|---|---|---|---|---|
| 1 | User characteristics | body mass, fat-free mass when measured, age, sex, training status scale per-person level and rates | profile, weight log | criterion data (population fixed effects) |
| 2 | Exercise type and muscles | exercise-specific cost per unit work, **hierarchically pooled** exercise → movement pattern → muscle-group class (S3, S4) | exercise library (`movement`, `primary_muscle`, `ex_type`, `equipment`) | criterion data: per-set or per-session costs by exercise |
| 3 | Sets, reps, load | mechanical-work proxy = reps × load × exercise displacement factor; for bodyweight exercises, reps × body-mass fraction moved | set logs; displacement and body-fraction factors per exercise from biomechanics literature, flagged as assumptions | literature (displacement) + criterion fit |
| 4 | Rest | recovery energy as a function of rest length and the preceding set's cost (S1: about half a set's cost is post-set O₂) | **set timestamps (not collected yet)** | criterion data |
| 5 | Duration and density | not a separate multiplier: they *emerge* from summing components 3–4 over the real time structure. Reported as features for diagnostics. | set timestamps + session timer | — |
| 6 | Intensity / effort | RIR or set RPE as a per-set modifier of cost (proximity to failure); post-session effort kept as a **candidate** feature whose value is tested, not assumed (A2, S11) | per-set RIR (optional UI), effort answer | criterion data |
| 7 | Heart rate | optional evidence term, **device-validated only**, with a lifting-specific HR→VO₂ relation (S9). Individual calibration when a person has paired HR + VO₂. | wearable HR stream with device identity (now stored) | criterion data per device and per person |
| 8 | Individual differences | person-level random effects (level and slope), updated by Bayesian shrinkage **only from that person's criterion measurements** (or a validated HR calibration). Without them the person gets the population estimate and a wider interval. | lab or validated field tests | the person's own measurements |

**Fallbacks when inputs are missing:**
- No set timestamps → components 4–5 fall back to session-level time (as today).
- No exercise mapping → movement-pattern or class-level cost.
- No HR → component 7 is skipped.

Each fallback widens the interval. None invents a value.

**Uncertainty:**
- **Intervals:** split-conformal prediction intervals from person-grouped out-of-fold residuals,
  stratified by input completeness (timestamps or not, HR or not, mapped exercise or not).
- **Ranges shown to members:** only intervals that reach their stated coverage are displayed as
  such.

### 3.3 Definition decision (needed before any data collection)

What should "calories burned in the workout" include? [FACT: today, active minutes only; S1/S2
say this omits a large share.]

| Option | Includes | Criterion needed |
|---|---|---|
| A (today) | O₂-based energy during the session (sets + rests), minus resting | indirect calorimetry during the session |
| B | A + EPOC (elevated O₂ after the session) | + 30–60 min post-session calorimetry |
| C | B + anaerobic glycolytic estimate | + pre/post blood lactate (capillary) |

**Recommendation:** collect A, B and C components separately in the lab study, but keep **A as
the product definition** until the study shows how large and how predictable B and C are.
Changing the definition would change every member's numbers and energy balance, so it is a
product decision.

### 3.4 Candidates the engine would be compared with (all against the baseline)

| ID | Candidate | Fitted? | Lab inputs needed at prediction time? |
|---|---|---|---|
| B0 | production baseline | no | no |
| B1 | baseline with one calibration factor per effort tier | yes, 3 params | no |
| L1 | Lytle 2019 equation | published | **yes** (fat/lean mass) |
| J1 | João 2020 regression (75% 1RM protocol only) | published | no; out of range for most sessions |
| E1 | structured engine, components 1–6, population effects | yes | no |
| E2 | E1 + device-validated HR | yes | no (needs a validated device) |
| E3 | E1/E2 + personal effects from the person's own measurements | yes | one lab or validated field test per person |
| G1 | gradient-boosted trees on E1's features | yes | no; only at the 150-person gate |

---

## 4. Evaluation framework

The framework is already pre-registered in `docs/CALORIE_MODEL_RESEARCH_PLAN.md` and
implemented in `ml/src/research/models.py`. This section extends it.

- **Criterion:** definition A from §3.3, plus B and C reported separately.
- **Units of independence:** person, then site. Person-grouped 5-fold CV and leave-one-study-out
  are both enforced in code.

**Metrics, every candidate versus B0, on the same sessions:**
- MAE and mean bias (kcal and %);
- Bland–Altman limits of agreement;
- MAPE;
- **within-person** error across a person's sessions (does it track *changes* for the same
  person, the thing a member actually sees week to week?);
- **rank correlation within person** (does it order their sessions correctly?);
- interval coverage;
- **energy-balance impact**: the error in weekly net intake–expenditure from session error alone.

**Breakdowns:** sex, age band, training status, session template (heavy / hypertrophy / dense /
own), exercise class, input completeness.

**Gates (existing):**

| Level | People | Sessions | Studies |
|---|---|---|---|
| `baseline_calibration` | 30 | 60 | 1 |
| `model_comparison` | 60 | 200 | 2 |
| `tree_models` | 150 | 600 | 3 |

Below a gate, the harness refuses to run that comparison.

**Production decision rule (existing, unchanged), all under leave-one-study-out:**
- MAE ≤ 0.85 × B0, with the paired bootstrap CI over people excluding 0;
- |bias| ≤ 10% overall and per template;
- no subgroup more than 10% worse than B0;
- interval coverage within 5 points of nominal.

**Personalization rule:** E3 replaces E1 for a person only if, in held-out sessions of people
with personal data, within-person MAE improves with a CI excluding 0.

**Without lab data:** only *internal* checks are possible:
- sensitivity of each candidate to each input;
- consistency between members' logged sessions and the inputs the candidate needs;
- distribution shift between app sessions and the research sample.

**None of these measure accuracy, and they will not be reported as accuracy.**

---

## 5. Data: what the app can collect and what needs a lab

| Data | Status | Effort |
|---|---|---|
| Active duration, body mass (dated), height/age/sex, exercise identity and library metadata, sets/reps/load, post-session effort | **collected now** | — |
| **Set start/end timestamps** (gives real rest, work time, density) | app change: record the tick time of each set; optionally a "start set" tap | small UI + schema |
| **Actual rest** | derived from timestamps; fix A1 (prescribed rest stored as actual) | small |
| Per-set RIR or RPE | optional quick picker on tick | small UI; adoption uncertain |
| Exercise displacement / body-fraction factors | library metadata from biomechanics literature, flagged as assumptions | research + data |
| Heart-rate stream during the session | via wearable integrations, device identity now stored; needs the native bridges (iOS/Android) to forward HR samples | depends on the Android/iOS apps |
| Body composition (fat-free mass) | user-entered from DXA/BIA: low quality unless measured; record method | small, optional |
| **O₂ uptake / CO₂ output, resting rate, EPOC** | **lab only** (portable or stationary analyser) | partner lab |
| **Blood lactate** | **lab only** (capillary analyser) | partner lab |
| Individual HR–VO₂ calibration | lab, or a validated field protocol with an analyser | partner lab |
| Device validation for lifting | lab, per device model | partner lab |

**Accuracy claims:** none can be made from app data alone. App data shapes the population model,
supplies distribution-shift checks, and makes every member session usable as a *prediction
target* once a model is validated. App data is never ground truth.

---

## 6. Roadmap

### Phase 0: now, no lab data. Improves inputs, not the formula.

These make the existing formula's inputs truer. They add no multipliers and change no
coefficient:

1. **Fix A1:** stop writing prescribed rest into `exercise_set_logs.rest_seconds`. Store it as
   `prescribed_rest_seconds` or null it.
2. **Capture set tick timestamps** (and optional "start set"). This enables rest, density and
   work-time features for every future session.
3. **Raise input completeness** where the formula already depends on it:
   - prompt for height/age/sex when missing (otherwise 1-MET resting is used);
   - prompt a body-weight log when the latest is older than N weeks (otherwise a stale or
     default 70 kg is used);
   - measure how often members answer the effort question and keep the answer optional.
4. **Duration hygiene:** surface "timer still running?" when a session's active time is far
   beyond its sets' plausible time. Never auto-trim.
5. **Shadow logging:** compute E1's *features*, not estimates, for every session, for
   distribution checks and study design.
6. **Optional per-set RIR** picker, behind a flag, to measure adoption before relying on it.

### Phase 1: pilot, 20 people, 1 lab, about 40 sessions

- **Criterion:** O₂ during the session, plus EPOC and lactate.
- **Learn:**
  - how biased B0 is per template (tests the "hard over-credits long-rest sessions" hypothesis);
  - how large B and C are relative to A;
  - whether set timestamps and RIR are captured reliably.
- **Possible outcome:** B1 (per-tier calibration) **if and only if** it meets the decision rule
  at the `baseline_calibration` gate. That gate needs 30 people, so the pilot alone cannot
  ship it.

### Phase 2: 60+ people, 2 sites, at least 200 sessions

- Fit E1. Compare it with B0/B1/L1/J1 under the decision rule.
- Calibrate intervals.
- If E1 passes, ship it behind the provider gate in shadow mode, then live.

### Phase 3: HR and personalization

- Validate specific devices for lifting.
- E2 with a lifting-specific HR relation.
- E3 personal effects for members with a lab or field calibration (could become a gym-partner
  service).

### Phase 4: 150+ people, 3+ sites

- G1 only if E-models plateau.
- Continuous monitoring of distribution shift between members and the research sample.

---

## 7. Limitations (stated up front)

- **No ground truth exists today.** Until Phase 1 reports, no proposal can be shown to be more
  accurate than B0, and none will be described as such.
- **Even the best criterion is uncertain** for resistance exercise (S2). Accuracy will be quoted
  against a named criterion definition.
- **Personalization** without the person's own measurements is limited to what body size,
  composition, sex, age and training status explain. Most individual difference (S11) needs
  measurement.
- **Exercise coverage:** the library has many exercises; a study will measure a few dozen.
  Unmeasured exercises rely on pooling by movement pattern, with wider intervals.
- **Literature:** most of it was read at abstract level here. Values marked unverified must be
  checked against full texts before use.

## 8. Decisions requested

1. **Approve Phase 0** items 1–6, or a subset. They change no displayed number.
2. **Product definition of workout calories:** A (today), B or C (§3.3). The recommendation is to
   keep A and measure B and C.
3. **Approve the partner-lab route and pilot** in `docs/CALORIMETRY_RESEARCH_PROTOCOL.md`. Note:
   the protocol must be amended to add **blood lactate and post-session O₂** (S2); it currently
   lists gas exchange only.
4. **Whether to build the E1 engine code now in shadow mode** (structure only, no fitted
   numbers), or wait for Phase 1 data.
