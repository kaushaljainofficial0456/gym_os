# BARBELL calorimetry research protocol (v1.0 draft)

Purpose: build a proprietary, consented, criterion-measured dataset of real resistance-training
sessions, so that BARBELL's calorie estimate can be calibrated and validated on what it is
actually used for: whole gym sessions, rests included.

Status: **draft for an ethics committee and a partner lab.**
- Nothing in it has been run and no data exists yet.
- The data infrastructure is built and tested: `ml/src/research/`, `ml/scripts/research_dataset_report.py`.
- **Ground truth is indirect calorimetry. Smartwatch calories are never ground truth.** They are
  recorded only to be evaluated.

## 1. What counts as what

| Tier (`measurement_tier`) | Example | Use |
|---|---|---|
| `criterion_lab` | stationary metabolic cart, calibrated per session | **ground truth** when QC passes |
| `criterion_portable` | validated portable analyser (COSMED K5, Cortex MetaMax 3B), calibrated per session | **ground truth** when QC passes |
| `wearable_estimate` | Apple Watch / Garmin / WHOOP kcal | compared against ground truth; never a target |
| `user_reported` | session RPE, recalled duration | feature or comparison only |
| `model_estimate` | BARBELL's estimate at the time | compared against ground truth |

**Energy definitions** (identical to the app):
- **gross:** gas-exchange energy by the abbreviated Weir equation (3.941·VO₂ + 1.106·VCO₂, litres).
- **net:** gross minus the participant's **measured** seated resting rate × session minutes.
- A net value computed from a predicted resting rate is allowed, but is labelled `predicted`
  (`ml/src/research/energy.py`).

**Known limit of the criterion:** indirect calorimetry misses the anaerobic (glycolytic) share
of lifting.
- **Size:** a 2024 systematic scoping review (Mitchell et al., Sports Med) puts it at possibly
  over 40%, depending on training variables. Benito 2016's 2–6% was for light circuit work only.
- **Pending amendment** (`docs/CALORIE_ENGINE_PROPOSAL.md` §3.3): add 30–60 min post-session
  calorimetry and pre/post capillary blood lactate, so EPOC and the anaerobic share are measured
  as separate components.

## 2. What is captured (schema: `ml/src/research/schema.py`)

| Table | Key contents |
|---|---|
| `studies` | site, protocol version, **ethics reference (required)**, licence, synthetic flag |
| `participants` | **pseudonym `P-XXXXXX`**, optional salted cross-study key, age (years, not birth date), sex, height, training status/years, optional body composition + method |
| `consents` | version, date, scopes (`collection`, `research_analysis`, `commercial_model_training`, `data_sharing_partner`, `retention_extended`), withdrawal date |
| `devices` | tier, make/model, firmware, published validation reference |
| `sessions` | date, **body mass measured that day**, session kind (straight sets / supersets / circuit / mixed), first and last working-set times, session RPE (CR-10, asked 30 min after), fasting hours, caffeine |
| `sets` | exercise name and category, warm-up flag, reps, external load, **set start and end timestamps**, RIR, set RPE |
| `measurements` | device, tier, interval (`resting_baseline` / `session` / `recovery_epoc`), interval times, VO₂ and VCO₂ totals, gross kcal, what a non-criterion figure claims to be (gross / net), mean HR, calibration time, QC status |

Rest duration and density are **derived** from set timestamps, never typed in.

**Not collectable here:**
- direct identifiers: name, email, phone, address, birth date, national ID, app user ID;
- any column with one of these names is rejected by the validator.

## 3. Validation rules (enforced by `ml/src/research/validate.py`)

An **error** excludes the row; a **warning** is reported.

**Identity and consent**
- **Identity:** pseudonym format, no direct-identifier columns, unique keys.
- **Consent:** an active consent covering `collection` is required. A withdrawal excludes all
  of that person's data. Commercial model training additionally requires
  `commercial_model_training` scope (`features.eligible_participants`).
- **References:** every session's participant exists and belongs to the same study.

**Session and set timing**
- **Session:** 5–240 min, at least one working set.
- **Sets:** start before end, ≤ 600 s each, ≥ 0.5 s per rep.
- **Set window:** working sets inside the session window (±60 s).
- **Set order:** no overlapping sets; set index follows time (warning).

**Criterion measurements**
- **Gas:** VO₂ and VCO₂ both present; RER 0.67–1.30; stated gross kcal within 2% of Weir.
- **Calibration:** within 6 h before the interval.
- **Device:** device tier matches the measurement tier.
- **Coverage:** the session measurement covers the whole session (±60 s).
- **Resting baseline:** ≥ 5 min (warning).
- **QC:** QC not `pass` is a warning, and that measurement is not ground truth.

**Non-criterion figures** must say whether they are gross or net-active.

## 4. Inclusion and exclusion

**Participants**
- **Include:** 18–70 years, cleared by PAR-Q+ (or physician clearance where it requires one),
  at least 3 months of resistance-training experience, able to wear a mask for 90 min.
- **Exclude:**
  - pregnancy;
  - beta-blockers or other drugs that alter heart rate or metabolism;
  - uncontrolled cardiovascular, metabolic or respiratory disease;
  - acute injury;
  - eating-disorder history.
  The last exclusion is a calorie study, so the exposure to calorie figures must be
  considered in the ethics submission.

**Sessions**
- **Include:** a criterion session measurement with QC `pass`, full coverage, no validation
  errors, and a measured resting baseline (preferred; otherwise labelled `predicted`).
- **Exclude:** sessions with mask leaks, analyser drift beyond the manufacturer's
  tolerance on post-session check, or protocol deviations recorded by staff.

**Studies:** an ethics reference and a licence permitting BARBELL's intended use are
required. Public or third-party data enters only with those, and never at participant level
without consent scope.

## 5. Collection workflow (one visit, about 2 h)

1. **Before the visit.** Screening and consent, done by the site. The site assigns the
   pseudonym, and **the key linking pseudonym to person never leaves the site**. Instructions:
   - no training for 48 h;
   - no caffeine for 6 h;
   - a standard light meal 3 h before.
2. **Arrival.** Measure body mass (calibrated scale, light clothing) and height. Calibrate
   the analyser: gas 2-point, flow/volume syringe. Fit the wearable(s) the participant owns,
   and record make, model and firmware.
3. **Resting baseline.** 15 min seated; the last 10 min is the `resting_baseline` interval.
4. **Warm-up.** Standardised, recorded as warm-up sets and excluded from the session window.
5. **Session.** The participant does a **real BARBELL session** logged in the app (their
   programme, or one of the protocol templates in §6). A research assistant timestamps each
   set's start and end on a tablet form that writes the `sets` table directly; the app's own
   log is kept for comparison. The analyser runs continuously.
6. **After.**
   - 10 min seated recovery (`recovery_epoc`, recorded but not part of the session target);
   - post-session analyser drift check;
   - session RPE asked at 30 min;
   - the wearable's session figure is exported as reported, stating whether it is gross or
     active.
7. **Data hand-off.** The site exports the seven CSVs from the templates. BARBELL runs
   `python -I ml/scripts/research_dataset_report.py <dir>`. Errors go back to the site.
   Nothing is fixed silently.

## 6. Session templates (so density, rest and composition vary within people)

Each participant does **two sessions on separate days**, ideally three, in randomised order:

| Template | Purpose |
|---|---|
| A. Heavy straight sets (4–6 compound exercises, 3–5 × 4–6, 2–3 min rest) | the "hard but slow" case stage 2 flagged |
| B. Hypertrophy (6–8 exercises, 3 × 8–12, 60–90 s rest) | the typical member session |
| C. Dense / superset or circuit (same exercises as B, 15–30 s transitions) | the high-density case |
| D. Their own programme | real-world composition |

Varying the template **within** a person is what separates density, rest, load and effort.
Stage 2 showed they cannot be separated across studies.

## 7. Partnerships and budget

**Who to approach**

1. **University sports-science or exercise-physiology departments with a metabolic cart or
   portable analyser.** Most have one for teaching and research.
   - The offer: a co-authored, pre-registered study; BARBELL funds participant
     reimbursement, consumables and a research assistant; the lab owns the equipment and the
     ethics process.
   - This is the cheapest credible route. A Master's or PhD student project is a natural fit.
2. **Clinical exercise-physiology or sports-medicine clinics** that already run VO₂ tests
   commercially. Pay per session; ethics through a university partner.
3. **Buying equipment:** only after a pilot shows the protocol works. The figures below are
   indicative only, from vendor and secondary sources; obtain quotes.

| Option | Indicative cost | Notes |
|---|---|---|
| COSMED K5 / Cortex MetaMax 3B | about $35–50k (vendor-affiliated source) | best-validated portable analysers; a lab partner usually already has one |
| PNOE | price not found | one 2025 validation against K5 during walking (n = 21, moderate agreement); not validated for lifting |
| VO2 Master Pro | historically < $5k (2020 study); now listed "< $10k" | measures VO₂ only. **Not criterion** for this protocol: Weir needs VCO₂ |
| Consumables (masks, calibration gas, sensors) | budget per session with the partner | |

**Low-budget pilot (phase 0).** One university partner, its existing analyser.
- **Sample:** 20 participants (≥ 8 women) × 2 sessions (templates A and C) = 40 sessions.
- **Pays for:**
  - participant reimbursement;
  - a part-time research assistant;
  - consumables;
  - open-access publication fees.
- **Answers:**
  1. Does the protocol produce clean data (QC pass rate, set-timing completeness)?
  2. What is the baseline's bias on templates A vs C, the stage-2 hypothesis?
  3. How do participants' own wearables compare?
- **Gate:** it falls short of `baseline_calibration` (30 people). It is a feasibility pilot
  and is reported as such.

**Phase 1:** about 60 people × 3 sessions across 2 sites. That reaches `model_comparison`
(§8). **Phase 2:** 150+ people across 3+ sites, before any tree model is considered.

## 8. Leakage and evidence rules

- **Unit of independence:** the **person**. A site-supplied salted `cross_study_key` links
  one person across studies without identifying them.
- **Splits:** splits are person-grouped, and leave-one-study-out removes a held-out study's
  people from training. Both are asserted in code (`splits.py`).
- **Pre-registered gates** (`models.GATES`) must pass before any comparison runs:

  | Level | People | Sessions | Studies | Per sex |
  |---|---|---|---|---|
  | `baseline_calibration` | 30 | 60 | 1 | 10 |
  | `model_comparison` | 60 | 200 | 2 | 25 |
  | `tree_models` | 150 | 600 | 3 | 60 |

- **Synthetic data never opens a gate.** Test fixtures are flagged and excluded from every
  count.
- **Distribution shift:** the research sample is compared with de-identified aggregates of
  app sessions (population stability index per feature, `quality.distribution_shift`). A
  large shift limits which app sessions a result may be claimed for.

## 9. Privacy, consent and retention

- The site holds the key; BARBELL receives only pseudonymous rows.
- **Consent wording** must name each scope separately. Commercial model training and sharing
  with partners are separate opt-ins.
- **Withdrawal:** the person's rows are excluded on the next validation run, and deleted
  from BARBELL storage within 30 days.
- **Storage:** research data is stored apart from the production database, access-restricted,
  and never joined to app accounts. App-side comparison uses only the participant's own
  exported session log.
- **Retention:** as consented (default: until study end + 5 years for published research);
  the `retention_extended` scope covers longer.
- **Law:** check with counsel under the participant's jurisdiction (e.g. GDPR special-category
  health data, India DPDP Act). This protocol does not replace that review.

## 10. Deliverables per study

- Validated dataset with zero errors.
- Quality report: independent people, studies, sessions, exercise coverage, missingness,
  QC distribution, consent coverage, shift.
- Pre-registered analysis per `docs/CALORIE_MODEL_RESEARCH_PLAN.md`.
- A publication. Results are reported whichever way they come out.

**Sources (equipment, validation):**
- [VO2 Master vs COSMED K5](https://vo2master.com/blog/vo2-master-vs-cosmed-k5/) (vendor)
- [VO2 Master vs PNOE](https://vo2master.com/blog/vo2-master-vs-pnoe/) (vendor)
- [PNOE validation, JFMK 2025](https://research.polyu.edu.hk/en/publications/assessing-the-validity-and-reliability-of-the-pnoe-for-measuring-/)
- [COSMED K5 accuracy](https://accedacris.ulpgc.es/bitstream/10553/55489/2/Accuracy_Precision_COSMED_K5.pdf)
- [VO2 Master 2020 study](https://pmc.ncbi.nlm.nih.gov/articles/PMC7523887)
