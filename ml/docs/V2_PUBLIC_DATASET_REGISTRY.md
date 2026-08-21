# V2 Public Dataset Registry — Kaggle + Hugging Face + academic repository discovery

> **UPDATE (round 2): academic/journal-repository search added.** Round 1 (below) covered Kaggle + Hugging Face only and found 0 GOLD/SILVER. Round 2 expanded to Zenodo, OSF, Figshare, Dryad, UCI, PMC/NIH, and direct journal supplementary files, and found **3 real SILVER candidates** — see `V2_DATA_ACQUISITION_REPORT.md` for the full synthesis, leakage matrix, and recommendation. This file remains the Kaggle/HF-specific narrative; the round-2 academic candidates are summarized at the bottom and fully detailed in the acquisition report.

**No training performed. No merging performed. No changes to `model_v1.json`, `mlEstimate.reference.js`, or any V1 artifact.** This is a discovery/audit pass only, per the explicit instruction.

Full field-by-field data (27 columns per candidate, matching the requested schema) is in **`ml/data/dataset_registry.csv`** — this document is the narrative companion. Classification rules are in `V2_DATA_QUALITY_RULES.md`, applied consistently below.

## Method

Searched Kaggle and Hugging Face for datasets touching the 13 requested dimensions (resistance training, energy expenditure, indirect calorimetry/VO2, participant-level data, body weight, age, sex, exercise identity, sets/reps/load, duration, intensity, heart rate, multi-exercise sessions). Every candidate below marked "individually inspected" was actually opened and read — Kaggle dataset pages via a real browser render (their pages are JS-rendered; a plain fetch only returns the title, confirmed the hard way), Hugging Face dataset cards via direct fetch (their cards are static markdown, fetch works directly).

## Headline finding, stated plainly

**Neither Kaggle nor Hugging Face has anything resembling the reis2017/reis2019/brunelli2019 GOLD-tier data this project already has.** Zero candidates found on either platform report indirect calorimetry, a named metabolic-cart device, or any documented physiological measurement method for their calorie columns. This matches the pattern already established in `DATA_PROVENANCE.md` when Zenodo/OSF were searched for V1 (PERSIST/WEEE/StrengthSense — all excluded for the same class of reasons). Real calorimetry data lives in journal supplementary files, not on consumer ML data platforms — that pattern held again here, checked directly rather than assumed.

## Candidates individually inspected

### Kaggle

**Gym Members Exercise Dataset** (valakhorasani) — **EXCLUDE.** 973 rows, Apache 2.0, has age/sex/weight/HR/Workout_Type(incl. "Strength")/Calories_Burned. Disqualified on the dataset's own words: *"The data is generated to reflect realistic exercise tracking scenarios... please do not use this dataset for research purposes."* Self-disclosed synthetic and explicitly discouraged from research use — about as clear an EXCLUDE signal as exists.

**Calories Burned During Exercise and Activities** (aadhavvignesh) — **EXCLUDE.** 248 generic activity rows (not participants), CC BY-SA 4.0. Creator states it was "compiled manually" — no calorimetry, no participants, reads as a manual recompilation of standard MET-style tables from unstated sources.

**FitLife: Health & Fitness Tracking Dataset** (jijagallery) — **EXCLUDE.** 3,000 simulated participants. Page states outright: *"FitLife360 is a synthetic dataset."* `calories_burned` is explicitly labeled an estimate, not a measurement.

**Gym Workout IMU Dataset** (shakthisairam123) — **AUXILIARY.** 164 real recorded sets, 36 named strength exercises, sets/reps/load encoded per file, MIT license. Real wrist-IMU sensor data, genuinely useful for exercise-identity/motion-pattern ideas — but zero calorie or physiological data of any kind, and appears to be a single person's personal recording project (no participant diversity).

**Weight Lifting Exercises** (prashant111, mirroring the Velloso et al. 2013 UCI dataset) — **AUXILIARY.** Legitimate peer-reviewed academic origin (Augmented Human '13 conference), real IMU sensor data for classifying bicep-curl form quality — but no calorie/VO2 data exists in it at all; it answers a completely different question (form correctness, not energy cost). License shows "Unknown" on the Kaggle mirror specifically — would need the original UCI source's license confirmed before any use.

**721 Weight Training Workouts** (joep89) — **AUXILIARY, low value.** A single person's ~3-year Strong-app export. Real multi-exercise session structure (push-pull-legs split) is a nice illustration, but n=1, no demographic variation, no calorie data at all.

**Powerlifting Database** (OpenPowerlifting, via Kaggle) — **AUXILIARY, but a genuinely useful one for a different problem.** ~800,000 real competitive lifters, CC0 public domain (most permissive license found in this whole search), real Squat/Bench/Deadlift competition maxes by age/sex/bodyweight class. **No calorie or EE data exists in this dataset at all** — but it's directly relevant to an *already-flagged* V1 gap: `V1_PRE_INTEGRATION_AUDIT.md` finding #8b noted that the %1RM buckets in the research training data (12-24% = "light/moderate") don't obviously correspond to what real lifters call light/moderate/hard. This dataset could help characterize what real-world load distributions actually look like by population segment — a scoping idea, not an energy-expenditure fix.

### Hugging Face

**mnemoraorg/calorie-burnt-15k** — **EXCLUDE.** 15,000 rows, ECL-2.0 license, has age/sex/weight/duration/HR. Dataset card provides *"no specifics on how calorie burn was calculated or measured."* Undocumented methodology, not resistance-training specific.

**strova-ai/fitness-tracker-dataset** — **EXCLUDE.** MIT license. Card states explicitly: *"All entries are fully synthetic, generated with Syncora.ai's synthetic data engine."* Calorie/intensity values are Karvonen-formula-derived from heart rate, not measured. Not resistance-training specific (general activities: Lying/Walking/Running).

**Idankhen/SmartFitnessNutritionAnalyticsDataset** — **AUXILIARY.** 20,000 rows, the richest resistance-training feature set found on either platform this pass: 55 named exercises, Sets, Reps, Target Muscle Group (36 values), Equipment. But `Calories_Burned`'s derivation is undocumented in everything inspected, and license wasn't confirmable from the card content retrieved — **per the user's explicit instruction, this column is not treated as ground truth just because it exists.** Worth keeping in mind purely as an exercise-ontology reference (SK OS's own ontology currently covers 8 exercises; this suggests a much larger real-world vocabulary) — not as training data.

**Varick/workout-routine** — **AUXILIARY, trivial size.** Only 30 rows, appears to be one person's log. Genuinely resistance-specific (squat/bench/deadlift/pull-up) and notably includes RPE and Tempo — directly relevant to the "tempo problem" flagged repeatedly in V1's docs (Nakagata's slow-tempo findings) — but far too small for any modeling use and has no calorie data at all. License unspecified.

## Candidates found via search, not yet individually inspected

Time-boxed this pass to the 11 candidates above, which cover the clear pattern. These titles surfaced in search but weren't opened — listed here so they aren't silently dropped, available to inspect on request:
- Kaggle: "Exercise and Fitness Metrics Dataset" (aakashjoshi123), "Fitness Tracker Dataset" (nadeemajeedch), "Calories Burning Dataset" (sparkyxt), "Gym Exercise Dataset" (niharika41298), "Health and fitness dataset" (evan65549)
- Hugging Face: "TinTinDo/Datasets" (small, columns suggest a toy/tutorial dataset per the search snippet — Duration/Pulse/Calorie_Burnage/Hours_Work/Hours_Sleep — low expected value)

Based on every title-matched pattern seen in the 11 inspected candidates (self-described synthetic, or undocumented "Calories_Burned" column with no methodology), these are unlikely to change the headline finding — but that's an expectation, not a substitute for actually checking them if useful.

---

## 1. GOLD candidates

**None found on Kaggle or Hugging Face.** The only GOLD-tier data available to this project remains the 3 already in use (reis2017, reis2019, brunelli2019 — included in `dataset_registry.csv` for reference/comparison, unchanged from V1).

## 2. SILVER candidates

**None found.**

## 3. AUXILIARY candidates

6 found, none usable as EE ground truth, each useful for a narrow, specific reason:
1. Powerlifting Database (OpenPowerlifting) — real-world load distributions, relevant to the %1RM-tier-mapping question.
2. SmartFitnessNutritionAnalyticsDataset — largest real-world exercise-name/muscle-group/equipment vocabulary found.
3. Gym Workout IMU Dataset — real sets/reps/load/exercise-identity structure.
4. Weight Lifting Exercises (Velloso 2013) — legitimate academic precedent for IMU-based exercise classification, if that direction is ever pursued.
5. Varick/workout-routine — smallest, but directly touches the tempo/RPE gap.
6. 721 Weight Training Workouts — real multi-exercise session structure, single-subject.

## 4. EXCLUDED candidates

5 found and excluded, all for a documented, specific reason (never "looked low quality," always a concrete disqualifying fact):
1. Gym Members Exercise Dataset — self-disclosed synthetic, explicitly discourages research use.
2. Calories Burned During Exercise and Activities — no participants, manually compiled, no calorimetry.
3. FitLife Health & Fitness Tracking Dataset — self-disclosed synthetic, calories explicitly "estimated."
4. calorie-burnt-15k (HF) — undocumented calorie methodology.
5. fitness-tracker-dataset (HF) — self-disclosed 100% synthetic.

## 5. Top 10 datasets worth acquiring next

**Honest framing first: none of the above 11 Kaggle/HF candidates are worth "acquiring" for the calorie model itself — 0 GOLD, 0 SILVER.** A padded top-10 drawn only from this platform search would misrepresent what's actually available. This list combines what's genuinely worth pursuing next, ranked by real expected value, spanning both this search and what was already known before it:

1. **Phillips 2004 (older adults, JSCR) raw/institutional-access data** — still the single highest-value target; closes the older-adult population gap directly. (User's own parallel search, not Kaggle/HF.)
2. **Robergs 2007 raw data** — same institutional-access category, same reasoning.
3. **Phase 9 calibration cohort (SRCSS/NSNIS partnership)** — the only path to real multi-exercise session data and body-weight scaling, neither of which any public dataset (Kaggle, HF, or otherwise) can provide.
4. **Nakagata 2019 (APNM, older adults)** — still not obtained; the specific paper `40_146.pdf` turned out not to be.
5. **Rustaden 2020** — from the user's own candidate table, not yet pursued.
6. **OpenPowerlifting database** (this search) — free, CC0, already identified — worth actually pulling to characterize real %1RM/load distributions by population segment, addressing audit finding #8b. Low effort, real (if narrow) value.
7. **SmartFitnessNutritionAnalyticsDataset** (this search) — worth a closer look specifically for its exercise-name/muscle-group vocabulary, to see if SK OS's 8-exercise ontology should expand — again, never for the calorie column.
8. **Re-attempt the declined paywalled-study outreach** (Scott 2019 mixed-sex study, flagged previously) — still sitting there if reconsidered.
9. **Any future institutional/university dataset from the Phase 9 lab partnership**, once one exists.
10. **A second, later Kaggle/HF sweep** — not because this one was incomplete, but because both platforms add new datasets constantly; worth a periodic re-check (e.g. quarterly) rather than treating this as a closed question forever.

Items 1, 2, 4, 5, 8 are the user's own parallel search or previously-identified leads, not new to this pass — included so this "top 10" is an honest priority ranking, not just a re-listing of today's search results padded to look complete.

---

## Round 2 addendum — academic repositories (Zenodo/OSF/Figshare/Dryad/UCI/PMC + direct journal search)

Full detail, leakage matrix, and recommendation in **`V2_DATA_ACQUISITION_REPORT.md`**. Headline: Zenodo/Figshare/Dryad/OSF searches for resistance-training indirect-calorimetry data returned nothing new (same result as V1's earlier Zenodo/OSF sweep) — but **direct journal search found 3 real SILVER candidates**, all with named indirect-calorimetry devices and documented methodology, none currently holding downloadable individual-level data:

1. **Rustaden et al. 2020** (Frontiers in Physiology) — 18 women, Oxycon Pro Jaeger, real 12-exercise ~58-minute session. Closes the women + multi-exercise + realistic-duration gaps simultaneously. Raw data "available on request."
2. **João et al. 2021** (Frontiers in Sports and Active Living) — 15 trained men, COSMED Fitmate Pro, real 8-exercise sessions at 44/61/**116 minutes** across 3 intensities. Directly relevant to the V1 audit's duration-extrapolation finding.
3. **Benito et al. 2016** (PLOS ONE, previously logged, now enriched with full exercise/session detail) — 29 mixed-sex participants, Oxycon Mobile, 3 real multi-exercise protocols. Individual data is *legally* blocked (Spanish law), not just request-gated — permanent reference-only status confirmed.

One candidate (an MDPI untrained-vs-trained comparison study) could not be independently verified — MDPI blocked both automated fetch and browser access — and is logged as **UNVERIFIED**, not guessed at, per the hard requirement to verify original sources.
