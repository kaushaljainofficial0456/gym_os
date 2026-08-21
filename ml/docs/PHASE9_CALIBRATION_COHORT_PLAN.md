# Phase 9 — Calibration Cohort Plan (design doc, not started)

Not gated on anything except a go/no-go decision — this scopes the *only* realistic path to beating v1's 19.1% MAPE, since n=14 literature participants is a hard ceiling (documented in `VALIDATION_REPORT.md`). Nothing here has run yet; no data collection, no commitments made to users or partners.

## Why this is necessary, not optional, if we want v2 to be meaningfully better

Three things v1 structurally cannot fix with more literature search (already close to exhausted, see `DATA_PROVENANCE.md`):
1. All source data is young/mostly-male/isolated-exercise-protocol — not SK OS's actual user population (mixed age, mixed sex, multi-exercise real sessions, real gym equipment variety).
2. n=14 is too thin to trust any further model complexity — adding SK OS's own users is the only way to grow n without overfitting to the existing cohort.
3. v1 has zero validation against the *actual deployed pipeline* end-to-end (production duration logging, real `exercise_id`s, real intensity-rating behavior) — everything so far is validated against clean research protocols.

## Core design constraint: no fabricated ground truth

Same rule as everything else in this project (Section 20/36) — a calibration cohort is worthless if the "ground truth" is itself estimated or self-reported. Real ground truth for resistance training energy expenditure means indirect calorimetry (portable metabolic cart) or an equivalent validated method — not step-counter/wearable calorie estimates, which are exactly what we're trying to beat.

## Realistic options, ranked

1. **University exercise-physiology lab partnership (recommended).** SK OS provides real gym members as subjects + the app's logged session data in parallel; the lab provides the portable calorimetry equipment and measurement protocol they already have (same method as Reis/Brunelli/Phillips studies). Mutual benefit: they get a publishable dataset in a population most existing studies lack (real gym-goers, not undergrad volunteers), we get real ground truth in our own population. This is how nearly all the source data we've used originated — proven feasible, not speculative.
2. **Contract a sports-science lab/consultant** for a smaller paid study (e.g., 20-30 sessions) using the same protocol. Faster to start, costs money, no publication angle to offer in exchange.
3. **Rent portable indirect calorimetry equipment directly** and run it in-house with a hired exercise physiologist to administer it correctly. Highest control, highest cost/complexity, not recommended as a first move.

Option 1 is the recommended starting point — cheapest, and the existing literature proves labs are willing to do exactly this kind of study.

## What "success" looks like (measurable, not vague)

- Target: a calibration-cohort LOPO/held-out MAPE that beats v1's 19.1% on SK OS's own user population, OR at minimum matches it while covering a population v1 wasn't validated on (older users, women, multi-exercise sessions) — either outcome is real progress, not just the first one.
- Minimum viable n: informed by the literature figures already in hand — the existing 14-person reis-lab cohort produced a usable linear correction; something in the same range (15-25 sessions with real physiological diversity) is a reasonable initial target, not a guess plucked from nowhere. Revisit once a partner lab's own feasible sample size is known.

## Data handling, decided in advance (per `ML_DATA_REQUIREMENTS.md` §3)

- `user_id` exported only for cross-referencing to the physical measurement session, never used as a training feature.
- `is_synthesized` must be `false` and verified for every session used — a single mislabeled legacy/synthetic row silently entering this dataset would poison the exact thing this phase exists to fix.
- Participants must be a distinct pool from anyone whose data trains v1 — no shared-cohort leakage risk like the reis2017/reis2019 case (which we only caught by numeric proof; take the lesson and design against it in advance this time — track lab-assigned participant IDs from day one).
- Consent/IRB-equivalent process handled by the partner lab (standard for any human-subjects measurement study) — SK OS's role is data-sharing agreement + recruitment access, not running the ethics review itself.

## Candidate partner labs (India, scoped 2026-08-16 — starting list, not exhaustive)

- **Sri Ramachandra Centre for Sports Science (SRCSS), Chennai** — private medical university, exercise physiology labs explicitly equipped with a Metamax VO2 gas analyzer (breath-by-breath indirect calorimetry — the exact method used in the Reis/Brunelli/Phillips studies our v1 model is built on), treadmill, LODE cycle ergometer, blood lactate analysis. Strongest fit found so far: right equipment, right method, a medical-university setting used to running human-subjects studies.
- **Netaji Subhas National Institute of Sports (NSNIS), Patiala** — government institute under the Sports Authority of India, dedicated Department of Exercise Physiology. Likely more athlete-performance-oriented than general-population gym-goers, but worth a scoping conversation given its scale and mandate.
- Not yet searched: LNIPE Gwalior, AIIMS/JIPMER sports medicine centres, and private-university kinesiology departments (Manipal, etc.) — worth a second pass if the two above don't pan out.

**Source:** [Sri Ramachandra SRCSS](https://www.sriramachandra.sport/exercise_physiology.html), [NSNIS Patiala – Department of Exercise Physiology](https://nsnis.org/sports-sciences/department-of-exercise-physiology/).

## What SK OS needs to provide

- Access to willing gym members as subjects (recruitment, not selection — avoid convenience-sampling only the most active/fittest users, which would just reproduce the existing "young, fit, male" skew from the literature).
- The app's real session logs for the exact sessions measured, timestamped precisely enough to align with the calorimetry recording.
- A decision on budget/timeline once a partner is identified — not something to pre-guess here.

## Explicit non-goals for this phase

- Not a marketing/PR study — framed and run as a measurement study first; any product messaging is a secondary output, not the design driver (keeps the protocol scientifically honest rather than optimized for a headline number).
- Not a replacement for eventual real-user beta feedback — this produces training/validation data, not user-satisfaction data.

## Status: design complete, execution blocked on lab selection

**Update (2026-08-16):** this plan is no longer the only Phase 9 artifact. Since it was written:

- **`PHASE9_STUDY_PROTOCOL.md`** — the full study protocol a partner lab can actually evaluate and cost. Sample size derived empirically (bootstrapped from V1's own per-participant LOPO residuals, `scripts/phase9_sample_size_analysis.py`): **20 participants minimum, 30 target**. Stratified recruitment targets, measurement sequence, equipment spec, backend export requirements, and a pre-specified analysis plan.
- **`src/v2/calibration_cohort_ingestion.py`** — the ingestion module, with arrival-validation checks written and unit-tested *now* (12 tests) rather than hastily when data lands: individual body weight present, named device, realistic session durations, n≥20, women ≥30%, no namespace collision with V1's cohorts, and lab↔app session alignment with a clock-drift bound.

**Why this data would be GOLD when all five published candidates are only SILVER:** every one of Rustaden / João / Nakagata / Benito / Adeel publishes group means without individual body weight. This study records it by design — along with separately-measured resting EE (resolving the gross-vs-net question, audit #2) and whole-session gas collection including rest periods (resolving the duration-extrapolation defect, audit #3).

**Update 2 (2026-08-16): the paid lab-partnership route is not fundable.** See **`PHASE9_ZERO_BUDGET_ALTERNATIVES.md`** — the protocol itself is unaffected (a student researcher needs the same protocol a paid lab would), but the route changes from *buying lab time* to *supplying the missing half of someone else's research project*. Recommended path is now an **MPT Sports Physiotherapy student dissertation collaboration** — those programmes require a dissertation, cover VO2/metabolic assessment, and already own the equipment; what they lack is participants and a defined question, both of which SK OS has. Sri Ramachandra is the first target: it runs an MPT Sports Physiotherapy programme *and* has the Metamax analyser identified above.

Everything below about equipment, ground-truth standards, and leakage design still applies unchanged — the evidence bar does not move because the budget did.
