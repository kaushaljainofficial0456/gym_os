# Laboratory feasibility pilot: plan (pre-implementation)

Status: **plan for approval; nothing booked or run.** Companion to
`docs/CALORIMETRY_RESEARCH_PROTOCOL.md` (full protocol) and `docs/CALORIE_ENERGY_DEFINITIONS.md`.

> **What 20 participants can and cannot show.** This is a *feasibility* pilot. Twenty people
> will **not** establish generalisable model accuracy, and no calorie model, recalibration or
> accuracy claim will be based on it alone. It is below the pre-registered
> `baseline_calibration` gate (30 people). Its results are reported as estimates with wide
> uncertainty, for planning the main study.

## 1. Questions the pilot answers

1. Can the protocol be run cleanly in a real gym-style session?
   - analyser QC pass rate;
   - mask tolerance;
   - lactate sampling on time;
   - set-timestamp completeness from the BARBELL app, compared with the research assistant's
     tablet log.
2. How large are the aerobic, anaerobic and post-exercise components, and how variable, across
   heavy straight-set and dense sessions?
3. How biased is the production baseline (`skos-cal-baseline-v2`) per session type? This tests
   the stage-2 hypothesis that "hard" over-credits long-rest heavy sessions. The result is
   descriptive only.
4. How do participants' own wearables compare? Descriptive only.
5. What between- and within-person variability should the main study be sized for?

## 2. Participants

| Item | Plan |
|---|---|
| Number | 20 completers. Recruit about 24 to allow for drop-out. |
| Sex | at least 8 women and at least 8 men (stratified recruitment) |
| Age | 18–55. Older adults are deferred to the main study: different safety screening and a different resting baseline. |
| Training status | ≥ 6 months of regular resistance training. A mix of intermediate and trained, recorded. |
| Inclusion / exclusion | as in the protocol §4: PAR-Q+, no beta-blockers, no uncontrolled cardiovascular, metabolic or respiratory disease, not pregnant, no eating-disorder history, no current injury |
| Body composition | DXA or validated BIA if the partner lab has it; method recorded |
| Consent | separate scopes, as in the protocol §9 (research analysis; commercial model training; sharing) |

## 3. Visits

Three visits per person, at least 48 h apart:

1. **Familiarisation:** consent, screening, anthropometry, 10RM testing on the protocol
   exercises, and a mask and lactate-sampling trial run.
2. **Session A:** heavy straight sets.
3. **Session C:** dense session.

The order of A and C is randomised. Template B (hypertrophy) is added if the budget allows; it
is otherwise deferred to the main study.

## 4. Exercise protocols

All exercises are from the BARBELL exercise library, logged in the app and on the RA tablet.

| | Session A: heavy straight sets | Session C: dense |
|---|---|---|
| Exercises | back squat, bench press, barbell row, Romanian deadlift, overhead press | same five |
| Load | about 85% of the familiarisation-estimated 1RM | about 60% |
| Sets × reps | 4 × 5 | 3 × 12 |
| Rest | 180 s between sets, 3 min between exercises | 30 s between sets and exercises |

**Why these choices:**
- **Same exercises in both templates,** so density and load vary *within* person while
  exercise selection is held constant. Stage 2 showed these cannot be separated across studies.
- **Fixed rest** from a timer, so actual rest is controlled and its measurement in the app can
  be checked.

## 5. Measurements and timing

| When | Measurement |
|---|---|
| Before | 12 h fast from caffeine, 3 h from food (standard light meal), no training for 48 h |
| Arrival | body mass on a calibrated scale; analyser gas and volume calibration (logged) |
| −15 to 0 min | seated rest; the last 10 min with the analyser is the **resting baseline** |
| 0 | capillary lactate (**pre**) |
| Warm-up | standardised, excluded from the session window |
| Session | portable metabolic analyser continuously, breath by breath. Set start/end from the app and the RA tablet. Participant's own wearable and a chest-strap HR monitor worn. |
| +1, +3, +5 min after the last set | capillary lactate (**post** = peak) |
| +0 to +30 min | seated recovery with the analyser (**post-exercise** component) |
| +30 min | session RPE (CR-10); wearable's session figure exported, noting gross or active |
| Analyser | post-session drift check |

## 6. Equipment

| Item | Purpose | Source |
|---|---|---|
| Portable metabolic analyser measuring **VO₂ and VCO₂** (e.g. COSMED K5, Cortex MetaMax 3B), breath by breath | aerobic components | **partner lab's own.** Buying one is not part of the pilot. |
| Calibration gases, 3-L syringe, masks in several sizes, turbines/sensors | QC | partner lab consumables |
| Capillary blood lactate analyser (handheld, e.g. Lactate Pro 2, or a lab analyser such as a Biosen) with strips, lancets, sharps disposal | anaerobic component | partner lab, or bought |
| Chest-strap HR monitor (validated) | HR reference for later device work | partner lab or about one unit |
| Calibrated scale, stadiometer, DXA or BIA (if available) | person characteristics | partner lab |
| Tablet with the research timing form | reference set timestamps | BARBELL |
| Barbells, racks, plates | the sessions | partner lab or gym |

**Not suitable as the criterion:** analysers that measure VO₂ only, without VCO₂ (Weir needs
both), and consumer wearables.

## 7. Cost (structure, to be quoted)

The figures below are **planning placeholders, not quotes**. The only price found from a source
is lactate strips at about €2 per strip from one European retailer, before VAT. Every line must
be quoted by the partner.

| Line | Quantity | Basis |
|---|---|---|
| Lab and analyser time | about 60 visits (20 × 3) × about 2.5 h | partner's internal or commercial rate |
| Analyser consumables (masks, gas, sensors) | per session | partner quote |
| Lactate strips | 20 people × 2 sessions × 4 samples = 160, plus about 20% repeats | about €2/strip → about €400 (one retailer listing; verify) |
| Lactate meter (if the lab has none) | 1–2 | quote |
| Participant reimbursement | 24 recruited × 3 visits | per local ethics norms |
| Research assistant | about 200 h (sessions, data entry, QC) | local rate |
| DXA/BIA (optional) | 20 | partner rate |
| Ethics fee, insurance, open-access publication | — | institution-specific |

**Rule for an indicative total:** budget lab time plus RA hours as the dominant costs. Obtain
two lab quotes before approval. No figure in this document should be read as a quote.

## 8. Ethics and governance

- **Approval:** from the partner institution's human-research ethics committee before any
  recruitment. BARBELL is the funder and collaborator; the lab is the data controller for
  identifiable data.
- **Risks to address in the submission:**
  - maximal or near-maximal lifting (spotters, qualified supervision, safety bars);
  - capillary sampling (trained staff, sharps protocol);
  - mask use during heavy exertion;
  - exposure to calorie figures for people with disordered eating (excluded at screening);
  - data protection: pseudonymised data only to BARBELL; GDPR / India DPDP Act as applicable.
- **Pre-registration** (e.g. OSF) of the pilot's descriptive analysis before data collection.
- **Withdrawal** at any time without penalty; data handling on withdrawal as in the protocol §9.
- **Conflict of interest:** BARBELL is a commercial funder, declared in the protocol, consent
  form and publication. Results are reported whichever way they come out.

## 9. Analysis (descriptive, pre-registered)

- **Components:** per session, aerobic net, anaerobic, workout net and post-exercise, with means,
  SDs and the within-person difference between A and C.
- **Baseline comparison:** bias and limits of agreement of `skos-cal-baseline-v2` against
  workout net, per template. Reported with 95% CIs and **explicitly labelled as not
  generalisable**.
- **App data quality:** timestamp agreement between the app and the RA tablet; rest
  measurement error.
- **Variability:** between- and within-person SDs, used to size the main study.
- **Not done:** no model fitting, no recalibration, no accuracy claim.

## 10. Limitations

- **Twenty people, one site, two session types:** no generalisation to other people, gyms,
  programmes or exercises.
- **Healthy adults 18–55 with training experience:** novices and older adults are not represented.
- **The criterion itself is imperfect.** Lactate-based anaerobic estimates depend on a
  conversion convention, sampling timing and lactate kinetics. RER above 1 distorts Weir. The
  mask may alter breathing during heavy lifts.
- **Lab setting:** fixed rests and protocols are not members' real sessions. Template D (own
  programme) is deferred to the main study.
- **Wearable comparisons** cover only the devices participants happen to own.

## 11. Decision points after the pilot

- **Go / no-go for the main study,** with sample size from the observed variance.
- **Protocol amendments** (sampling times, templates).
- **No production change** is made from pilot data.

Source for the strip price: [one European retailer listing](https://shop.fleischhacker.biz/en/medical-products/laboratory-diagnostics/blood-analysis/38450/lactat-pro-2-teststreifen).
