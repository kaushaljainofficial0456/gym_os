# V2 Data Acquisition Report

**Status: audit only. No training performed. No changes to `model_v1.json` or any V1 artifact. Stopping here for approval, per explicit instruction.**

`V2_DATA_QUALITY_RULES.md` applied as a hard requirement throughout — no candidate below was scored on a search-result summary alone; every GOLD/SILVER/AUXILIARY classification is backed by direct inspection of the primary source (paper full text or dataset card), and the one candidate that couldn't be verified is marked UNVERIFIED rather than guessed at.

## What changed since the Kaggle/HF-only pass

That pass (`V2_PUBLIC_DATASET_REGISTRY.md` round 1) found 0 GOLD/SILVER. This pass expanded to Zenodo, OSF, Figshare, Dryad, UCI, PMC/NIH, and direct journal search. Zenodo/Figshare/Dryad/OSF again returned nothing new (consistent with V1's earlier Zenodo/OSF sweep — PERSIST/WEEE/StrengthSense). **Direct journal search is what actually worked** — the same channel that produced all 3 of V1's original GOLD datasets. Found 3 genuine SILVER candidates and 1 unverifiable one.

## 4. GOLD/SILVER datasets — genuinely usable (with real, checkable caveats)

| Dataset | Tier | Participants | Population | Device | Multi-exercise | Duration | License | Data in hand? |
|---|---|---|---|---|---|---|---|---|
| reis2017 | GOLD | 14 | 100% male, 20s-30s | COSMED K4b2 | No | 26s-5min bouts | CC BY 4.0 | **Yes — already in V1** |
| reis2019 | GOLD | 14 (same cohort) | 100% male, 20s-30s | COSMED K4b2 | No | 4x4min bouts | CC BY 4.0 | **Yes — already in V1** |
| brunelli2019 | GOLD | 11 | 100% male, sedentary | Oxycon (portable) | No | 3 sets to failure | CC BY 4.0 | **Yes — already in V1 (confirmatory only)** |
| **Rustaden et al. 2020** | SILVER | 18 | **100% women**, overweight, mean 36y | Oxycon Pro Jaeger | **Yes (12 exercises, ~58min)** | Realistic session length | CC BY | **No — request to corresponding author, not yet made** |
| **João et al. 2021** | SILVER | 15 | 100% men, **trained (12+ months)** | COSMED Fitmate Pro | **Yes (8 exercises, 44-116min)** | **Longest realistic durations found in this whole search** | CC BY | **No — availability unconfirmed, needs follow-up** |
| **Benito et al. 2016** | SILVER | 29 | **Mixed sex (15M/14F)**, 18-28y | Oxycon Mobile | **Yes (3 protocols, 64min)** | Realistic session length | CC BY 4.0 | **No — legally blocked (Spanish law), permanent** |

**UPDATE:** a 4th SILVER candidate was found while awaiting replies to the first two outreach emails — **Nakagata et al. 2019** (Applied Physiology, Nutrition, and Metabolism, DOI 10.1139/apnm-2018-0882), found as an author-archived manuscript draft. 20 older adults (13 men, 7 women, ages 66-80, mean 70.8y), Minato Aeromonitor AE-300S indirect calorimetry, 4 bodyweight slow-tempo exercises (squat, knee push-up, crunch, heel-raise). **Uniquely closes both the women AND older-adults gaps simultaneously** — no other candidate found in this entire search does both at once. Data found is group-by-sex aggregate only (not individual rows), and license is unresolved since this is a pre-publication draft, not the citable licensed version. Corresponding author's email is printed directly in the document (takashi.nakagata@gmail.com) — a concrete outreach target, same as the other two.

**UPDATE 2 — deep repository sweep (Zenodo / OSF / Figshare / Dryad / UCI / PMC / Scientific Data / direct journal search):** found a 5th SILVER candidate, the **Adeel/Peng cluster** (Taipei Medical University) — **Adeel et al. 2021** (Appl. Sci. 11:8773) + **Adeel et al. 2022** (IJERPH 19:2233). **CC BY 4.0 — the only new candidate found anywhere with a confirmed commercially-compatible license.** 11 participants (5 untrained *all female*, 6 trained 4M/2F — **7 of 11 are women**), Cortex Metalyzer 3B, dumbbell shoulder press / deadlift / squat at 60% 1RM, fully documented sets/reps/cadence/rest, realistic 52-minute multi-exercise session. Closes gaps A (women), C (beginners), D (trained), F (compound free-weight, incl. **deadlift**, absent from V1 entirely) and G (multi-exercise).

**LEAKAGE-CRITICAL FINDING:** the 2021 and 2022 papers are **the same 11 people, not 22** — identical ClinicalTrials.gov registration (NCT04532905), identical IRB (N202004023), identical recruitment window, identical sample structure, exercises and device. A third paper by the same group (Appl. Sci. 11:6687) is *suspected* same-cohort but unverified (MDPI blocked access). This is the same class of error the reis2017/reis2019 numeric-identity check caught in V1 — logged in `V2_LEAKAGE_REPORT.md`.

**Immediate value even without raw data — an independent cross-check of the V1 audit.** Converting Adeel's published METs to kcal/min at their own group-mean body weights:

| Exercise | Untrained (53.3kg) | Trained (81.7kg) |
|---|---|---|
| Shoulder press | 1.30 MET → 1.21 kcal/min | 2.02 MET → 2.89 kcal/min |
| Deadlift | 2.71 MET → 2.53 kcal/min | 3.13 MET → 4.47 kcal/min |
| Squat | 2.70 MET → 2.52 kcal/min | 3.42 MET → 4.89 kcal/min |

Every measured value falls in the **1.3–3.4 MET** range — *below* V1's baseline "light" tier assumption of 3.0 MET, and far below its "hard" tier of 6.0 MET. Meanwhile reis2017's 80%1RM squat measures **26.1 METs**. These are not contradictory (reis measured a single 26–56s bout to exhaustion; Adeel averaged across 30s sets within a full set/rest structure) — but the ~8x gap is **independent, third-party evidence that short max-effort bout rates cannot be extrapolated across a real session**, precisely the failure mode `V1_PRE_INTEGRATION_AUDIT.md` #3/#4/#5 identified and the 20 kcal/min plausibility cap was added to prevent. That's a genuine validation win from this search even though it adds zero training rows. Reproducible via `ml/scripts/add_adeel_cluster.py`.

**None of the 5 SILVER candidates can become V2 training rows today.** All three are genuinely real, well-documented, indirect-calorimetry-measured studies — but none currently has downloadable participant-level data. This is reported as-is, not softened: the honest state of this search is 0 new GOLD, 3 real SILVER-but-not-yet-actionable, and the reasons differ (request-gated vs. unconfirmed vs. legally permanent) so they're not treated identically below.

## 5. AUXILIARY datasets

Same 6 as the Kaggle/HF pass — none provide an established energy-expenditure ground truth, each useful for a narrow, specific reason. Full detail in `V2_PUBLIC_DATASET_REGISTRY.md` §3; summarized:

| Dataset | Why it's kept | Never use for |
|---|---|---|
| Powerlifting Database (OpenPowerlifting) | Real 1RM/load distributions by age/sex/bodyweight (~800K lifters, CC0) — relevant to the open %1RM-to-intensity-tier mapping question | Any calorie/EE purpose — no such column exists |
| SmartFitnessNutritionAnalyticsDataset (HF) | Largest real-world exercise-name/muscle-group vocabulary found (55 exercises) | Calorie ground truth — methodology undocumented |
| Gym Workout IMU Dataset (Kaggle) | Real sets/reps/load/exercise-identity structure | EE — no calorie field exists at all |
| Weight Lifting Exercises / Velloso 2013 (Kaggle mirror) | Legitimate academic precedent, real IMU data | EE — designed for form classification, not energy cost |
| 721 Weight Training Workouts (Kaggle) | Real multi-exercise session structure | Any population-level use — n=1 |
| Varick/workout-routine (HF) | Directly touches the tempo/RPE gap | Any modeling use — n=30, single logger |

## 6. EXCLUDED datasets

| Dataset | Platform | Reason |
|---|---|---|
| Gym Members Exercise Dataset | Kaggle | Self-disclosed synthetic; page explicitly says "do not use for research purposes" |
| Calories Burned During Exercise and Activities | Kaggle | No participants, manually compiled, no calorimetry |
| FitLife Health & Fitness Tracking Dataset | Kaggle | Self-disclosed synthetic; calories explicitly labeled "Estimated" |
| calorie-burnt-15k | Hugging Face | Undocumented calorie methodology |
| fitness-tracker-dataset | Hugging Face | Self-disclosed "100% synthetic" |

## 7. Participant-level overlap / leakage matrix

| Pair | Shared participants? | Shared authors/institution? | Risk level | Evidence |
|---|---|---|---|---|
| reis2017 ↔ reis2019 | **Yes — confirmed identical cohort** | Yes (Reis VM et al., Portugal) | N/A — already unified into one `participant_group_id` namespace in V1 | Numeric proof: reis2017's blue-block values match reis2019's EC values to several decimal places, same participant/exercise/intensity |
| reis-lab (17/19) ↔ brunelli2019 | No | No — different institutions | None | Confirmed disjoint in V1 |
| reis-lab ↔ Rustaden 2020 | No expected overlap | No — Portugal vs. Norway, different research groups | None expected | Different country, different institution, no shared authors found |
| reis-lab ↔ Benito 2016 | No expected overlap | No — Portugal vs. Spain (Technical University of Madrid) | None expected | Different country, different institution, no shared authors found |
| reis-lab ↔ João 2021 | No expected overlap | **No direct author match**, but see below | Low — flagged for awareness | João 2021's author list (João, Almeida, Tavares, Kalva-Filho, Carvas Junior, Pontes, Baker, Bocalini, Figueira) does not include "Reis" |
| João 2021 ↔ earlier-logged systematic review (João/Rodriguez/Tavares/Reis/Bocalini, *Clinical Physiology and Functional Imaging*) | N/A — review has no primary-data cohort | **Yes — shares "João," "Tavares," "Bocalini"** | Low, not disqualifying | Same Brazilian exercise-science research network; the review's "Reis" co-author was **not independently confirmed** to be the same V. Reis as reis-lab (a common surname) — flagged honestly as unresolved, not asserted either way |
| Rustaden 2020 ↔ Benito 2016 ↔ João 2021 (pairwise) | No expected overlap | No — three different countries (Norway/Spain/Brazil) | None expected | Geographically and institutionally distinct |
| Any candidate ↔ any Kaggle/HF AUXILIARY/EXCLUDE dataset | N/A | N/A | None | Different data class entirely (consumer platforms vs. academic studies) |

**Net leakage assessment: no confirmed overlap found among any of the new candidates, and no confirmed overlap with the existing V1 cohort.** One soft flag (João 2021's shared co-author surnames with a previously-logged review) is noted for awareness, not treated as disqualifying, since it doesn't involve a shared primary-data participant pool.

## 8. Recommendation — what should actually enter V2 training

**Nothing enters V2 training today.** Per the hard requirement in `V2_DATA_QUALITY_RULES.md`, none of the 3 new SILVER candidates currently have downloadable participant-level data — training on them isn't an option yet, it's not a choice being deferred.

**Concrete next steps, ranked:**

1. **Request raw data from Rustaden et al.'s corresponding author.** This is the single best next move available: the paper states data is available on request, it's CC BY, and it closes 3 stated priority gaps at once (women, multi-exercise, realistic duration). If granted, this would be the first genuinely new GOLD-tier addition since V1 — a real second population, not just more of the same 14 people.
2. **Contact João et al. 2021's authors** to ask about supplementary/raw data availability — not confirmed either way in the published text. The 44-116 minute realistic session durations make this the most direct evidence available anywhere for actually validating (or fixing) the V1 audit's hard-tier duration-extrapolation problem, even as aggregate data alone.
3. **Treat Benito et al. 2016 as permanently reference-only** — don't spend further effort chasing raw access; Spanish data-protection law is stated as an absolute bar, not a formality. Its aggregate numbers remain useful the way Brunelli's did in V1 — an independent cross-check, not a training source.
4. **Do not pursue the MDPI study further without confirming access another way** (e.g., institutional subscription, or the user's own copy if available) — it's plausible-sounding but unverified, and per the hard-requirement rule, plausible isn't sufficient.
5. **Everything else stays exactly where V1 left it**: Phillips 2004/Robergs 2007 institutional access (your parallel search), Nakagata 2019, Rustaden's own earlier candidate-list ranking, and the Phase 9 calibration cohort remain the other live threads — none closed or opened further by this pass.

**Awaiting approval before any further action** — specifically: do you want outreach emails drafted for Rustaden/João (not sent, per the established pattern), and should I continue the academic-repository search into the still-open gaps (older adults — B — found nothing new this pass; individual body weight — E/I — no paper anywhere in this search reports it, reinforcing that Phase 9 real-user data is the only real path there)?
