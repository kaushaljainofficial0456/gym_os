# Data Provenance Registry — v0

Generated from direct inspection of raw files, not abstracts. Regenerate `_build_report_v0.txt` via `python src/preprocessing/harmonize.py` to reproduce the counts below.

---

## dataset_id: `reis2017`

| Field | Value |
|---|---|
| study_name | Energy cost of isolated resistance exercises across low- to high-intensities |
| authors | Reis VM, Garrido ND, Vianna J, Sousa AC, Alves JV, Marques MC |
| publication_year | 2017 |
| DOI | 10.1371/journal.pone.0181311 |
| source_url | https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0181311 |
| license | CC BY 4.0 |
| commercial_use_allowed | Yes |
| raw_file | `data/external/reis2017_pone.0181311.s001.xlsx` (31,770 bytes, verified Excel 2007+, downloaded directly from PLOS's storage) |
| measurement_method | Breath-by-breath open-circuit gas analysis, COSMED K4b2 |
| participant_count (verified from raw file) | **14** — every one of the 8 exercise sheets has exactly 14 numbered participants (verified row-by-row; the paper-abstract phrase "58 males, 14–17 per exercise" does NOT match what's in the downloadable S1 file) |
| sex_distribution | 100% male (per paper text; not encoded in the raw file itself) |
| age_range | 27.5 ± 4.9 y (cohort mean±SD, paper text only — no per-participant age in the file) |
| body_weight_range | 78.67 ± 10.7 kg (cohort mean±SD, paper text only — no per-participant weight in the file) |
| exercise_count | 8 (half squat, leg press, leg extension, bench press, incline bench press, lat pulldown, triceps extension, biceps curl) |
| intensity_range | 12/16/20/24/80 %1RM |
| measurement_duration | 4–5 min constant-intensity bouts (12–24%); 26–56 s to exhaustion (80%) |
| ground_truth_definition | Relative VO2 (ml·kg⁻¹·min⁻¹), directly measured |
| raw_or_derived | Raw (the file's own "yellow" block). The file ALSO contains a "blue" block presented as kcal/min — see Data Quirk below; that block is NOT treated as raw/authoritative here. |
| quality_tier | Silver/Gold |
| limitations | No per-participant weight/age — only cohort mean. Male-only. Isolated single-exercise bouts, not multi-exercise sessions. |

**Data quirk found on inspection (undocumented in the paper text or search abstracts):** each sheet contains two color-coded 14-row blocks. Yellow = raw relative VO2. Blue = the same values converted to kcal/min — but using the **cohort mean body weight (78.67 kg) uniformly**, not each participant's own weight (verified: the yellow/blue ratio is a constant 2.542 in every row/sheet checked; 1000/(2.542×5) = 78.68 kg, matching the paper's reported mean exactly). The blue block is therefore a **group-level approximation**, not an individually accurate label, and is excluded from the harmonized dataset in favor of reis2019's directly-measured equivalent (see cross-dataset note below).

---

## dataset_id: `reis2019`

| Field | Value |
|---|---|
| study_name | Are wearable heart rate measurements accurate to estimate aerobic energy cost during low-intensity resistance exercise? |
| authors | Reis VM, Vianna JM, Barbosa TM, Garrido N, Vilaça Alves J, Carneiro AL, Aidar FJ, Novaes J |
| publication_year | 2019 |
| DOI | 10.1371/journal.pone.0221284 |
| source_url | https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0221284 |
| license | CC BY 4.0 |
| commercial_use_allowed | Yes |
| raw_file | `data/external/reis2019_pone.0221284.s001.xlsx` (28,719 bytes, verified Excel 2007+) |
| measurement_method | VO2 via COSMED K4b2; HR via Polar V800 |
| participant_count (verified from raw file) | **14** — every one of the 8 exercise sheets has exactly 14 numbered subjects |
| sex_distribution | 100% male (paper text) |
| age_range | 27.5 ± 4.9 y (paper text only) |
| body_weight_range | 78.67 ± 10.7 kg (paper text only) |
| exercise_count | 8 (same list as reis2017) |
| intensity_range | 12/16/20/24 %1RM (no 80% condition here) |
| measurement_duration | 4×4-min constant-intensity bouts |
| ground_truth_definition | Directly reported energy cost (EC), kcal/min |
| raw_or_derived | Raw (EC and HR both directly reported, no ambiguity — cross-checked against the paper's stated 3–10 kcal/min range) |
| quality_tier | Gold (cleanest units of the three files) |
| limitations | Same population limits as reis2017; no 80%1RM condition. |

**Cross-dataset finding — participant overlap with reis2017 (CONFIRMED, not assumed):** reis2017's blue-block kcal/min values match reis2019's directly-reported EC values to several decimal places for the same participant index, exercise, and intensity (e.g., bench press 12%1RM, participant 1: reis2017 blue = 4.861806, reis2019 EC = 4.861806). This is not demographic similarity — it's numeric identity. **reis2017 and reis2019 share the same 14-person cohort.** Both are assigned to the shared `participant_group_id` namespace `reis_lab_p{1..14}` in the harmonized dataset, and no train/validation/test split may ever separate rows sharing a `participant_group_id`.

---

## dataset_id: `brunelli2019`

| Field | Value |
|---|---|
| study_name | Acute low- compared to high-load resistance training to failure results in greater energy expenditure during exercise in healthy young men |
| authors | Brunelli DT, Finardi EAR, Bonfante ILP, Gáspari AF, Sardeli AV, Souza TMF, Chacon-Mikahil MP, Cavaglieri CR |
| publication_year | 2019 |
| DOI | 10.1371/journal.pone.0224801 |
| source_url | https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0224801 |
| license | CC BY 4.0 |
| commercial_use_allowed | Yes |
| raw_file | `data/external/brunelli2019_pone.0224801.s001.xlsx` (14,329 bytes, verified Excel 2007+) |
| measurement_method | Portable gas analyzer (Oxycon), breath-by-breath; blood lactate sampling |
| participant_count (verified from raw file) | **11** — confirmed by filtering out 6 non-numeric trailing chart-label rows ("EPOC_graph", "Control", "RT30", "RT80") that pandas would otherwise choke on; matches the paper's stated final n=11 (13 recruited, 2 dropped) |
| sex_distribution | 100% male |
| age_range | 22 ± 3 y |
| body_weight_range | 71.8 ± 7.7 kg |
| exercise_count | 1 (leg extension machine only) |
| intensity_range | 30% / 80% 1RM (to failure) + control (no exercise) |
| measurement_duration | 3 sets to failure, 1.5 min rest between sets |
| ground_truth_definition | Absolute kcal — reported separately for rest / aerobic / anaerobic-lactic / anaerobic-alactic / exercise (active) / EPOC / total. NOT a rate — do not divide by session duration and treat as kcal/min without re-deriving. |
| raw_or_derived | Raw, with `total` being an in-file sum of `exercise + epoc` (documented, not a separate measurement) |
| quality_tier | Silver/Gold |
| limitations | Small n=11. Single isolated exercise. Untrained/sedentary population (12 months no resistance training) — do not assume this generalizes to trained lifters. |

**Cross-check:** `ee_control_epoc` mean across the 11 rows ≈ 75 kcal, matching the paper's abstract-reported control EPOC of "75.8 ± 7.6 Kcal" almost exactly — confirms unit/scale interpretation is correct.

---

## Academia.edu bundle (2026-08-16) — 37 papers screened, findings logged

User purchased a $1 Academia.edu "PDF pack" and shared the files directly. Screened for relevance against our inclusion criteria; full text read on the 10 most promising. None contain new individual-level rows (all report group means only), but several are genuinely useful as reference/cross-check points, and one is explicitly excluded on license grounds — logged below rather than silently used or silently dropped.

**New reference sources (aggregate data, not training rows — same treatment as the Lytle 2019 formula):**
- **Vianna et al. 2011, J. Human Kinetics** ("Aerobic and Anaerobic Energy During Resistance Exercise at 80% 1RM") — CC BY 3.0. Confirms the *same 14-person reis-lab cohort* (contact `jvianna@acessa.com` matches), adds aerobic/anaerobic energy-source breakdown at 80%1RM for bench/half-squat/triceps/lat-pulldown — e.g. half squat is 87.4% anaerobic vs. bench press 77.7%. Useful physiological context, not new participants.
- **Vianna et al. 2011, J. Human Kinetics** ("Can Energy Cost During Low-Intensity Resistance Exercise be Predicted by the OMNI-RES Scale?") — CC BY 3.0. n=17 from the same lab (possibly the pre-attrition recruitment pool for the n=14 cohort — flagged, not confirmed identical). Adds real per-bout **duration in seconds** for each exercise×intensity combination — a number we didn't have and had been approximating.
- **Phillips & Ziuraitis 2004, JSCR** ("Energy Cost of Single-Set Resistance Training in Older Adults") — 10 participants (5M/5F), **mean age 73.1±5.5y** — the only older-adult population found in this whole search. Full demographics + measured kcal/MET by sex via CosMed K4b2. License: standard JSCR/NSCA copyright, same restricted status as Robergs 2007 — usable as a reference point we already have access to (via this bundle), but not clearable for the same "commercial training data" bucket as the CC BY sources without resolving that license question.
- **Reis, Júnior, Zajac, Oliveira 2011, J. Human Kinetics** ("Energy Cost of Resistance Exercises: an Update") — CC BY 3.0, review/opinion piece by the same reis-lab group. Valuable as literature triangulation: cites specific numbers from Scott 2006/2009/2011 (anaerobic EC breakdowns we don't have direct access to otherwise) and states explicitly that total EC in resistance exercise can reach "up to 40 kcal·min⁻¹" in high-muscle-mass exercises at high intensity — useful sanity bound for our model's outputs.
- **João, Rodriguez, Tavares, Reis, Bocalini et al.** ("Can Intensity in Strength Training Change Caloric Expenditure? Systematic Review and Meta-Analysis," *Clinical Physiology and Functional Imaging*, Wiley) — a systematic review whose Table 2 tabulates measured EE from **12 additional studies** we don't have direct access to (Almeida 2011, Aniceto 2013, Cesar 2013, Farinatti 2009/2011, Heden 2011, Hunter 2003, Kelleher 2010, Kirk 2009, Melanson 2005, Mookerjee 2016, Ratamess 2007/2014), each with sample size, protocol, and measured kcal. **License unclear** — this is a Wiley "Accepted Article" preprint with no visible OA license marking, obtained via a shared-PDF platform, not a confirmed CC license. Marked **RESEARCH/PROTOTYPE ONLY** — fine to use for sanity-checking our model's outputs against the broader published literature, not treated as commercially-cleared. The review's own headline finding is itself useful context: after correcting for publication bias, training **intensity does not significantly predict energy expenditure** in their meta-analysis (p=0.18) — a caution against over-trusting intensity as the dominant feature, consistent with our own finding that intensity tier alone doesn't explain everything either.

**Explicitly excluded:**
- **Escobar, Morales, VanDusseldorp 2017** ("Metabolic profile of a crossfit training bout," *J. Human Sport & Exercise*) — **CC BY-NC-ND** (Non-Commercial). Explicitly incompatible with a commercial production pipeline regardless of data quality — excluded on license grounds alone, not read further for data purposes. Also not pure resistance training (box jumps + burpees + thrusters), which would have been a secondary reason.
- **Washburn et al. 2012** ("Resistance training volume, energy balance and weight management," *Contemp Clin Trials*) — this is a **trial protocol/design paper**, not a results paper — no measured energy-expenditure data exists in it to extract. NIH Public Access manuscript (no license conflict), just not applicable.

**Not individually read (27 remaining titles):** based on titles, these skew toward resting-metabolic-rate prediction equations, body-composition methodology, and general dietary/energy-balance topics rather than workout-specific energy expenditure — lower expected relevance than the 10 read in full. Available to screen further on request rather than reading all 37 speculatively.

## User-provided PDF batch (2026-08-15/16) — 5 papers, all read in full, none change the trained model

User sourced these 5 directly (separately from the Academia.edu bundle) and sent by file path. All read in full; none are individual-level, commercially-licensed data, so **`model_v1.json` / the 19.1% MAPE result are unchanged** — logged here as reference/context findings only, consistent with every prior batch.

- **Phillips & Ziuraitis 2003, JSCR 17(2):350-355** ("Energy Cost of the ACSM Single-set Resistance Training Protocol") — genuinely new, distinct from the already-known Phillips & Ziuraitis **2004** (older adults, 73.1±5.5y): this is the companion paper on **12 young adults** (6M/6F, mean age 26.7±3.8y), same single-set-to-15RM design, 8 machine exercises. Table 3: 135.2±16.6 kcal total (men), 81.7±11.1 kcal (women), MET 3.9±0.4/4.2±0.6. Aggregate-only, standard JSCR/NSCA copyright — same restricted-license bucket as Robergs 2007 and Phillips 2004 (older adults). Reference-only.
- **Nakagata, Yamada, Naito 2022, JSCR 36(5):1290-1296** (`jscr-36-1290.pdf`) — **not** the 2019 older-adults paper originally prioritized (#4 in the user's table) — this is candidate #6, a different, later paper. 15 young men (21-29y), 3 bodyweight exercises (heel-raise/squat/push-up) across 6 rep-frequencies via a "Different Frequency Accumulation Method." Energy cost per rep: heel-raise 0.13±0.04, squat 0.50±0.14, push-up 0.77±0.20 kcal. **License: CC BY-NC-ND 4.0 — explicitly Non-Commercial/No-Derivatives, excluded from the commercial pipeline** on the same grounds as the Escobar CrossFit paper. Scientifically the most relevant find in this batch (bodyweight + real per-rep energy cost) but license-blocked.
- **Hunter, Wetzstein, Fields, Brown, Bamman 2000, J Appl Physiol 89:977-984** — 15 older adults (8F/7M, 61-77y), but this is a **26-week chronic training study** measuring REE/TEE/AEE via doubly-labeled water, not an acute single-session measurement. The paper states outright it did not measure the energy cost of the training sessions for this cohort — it used estimates from a different, unpublished sample. **No usable per-session calorie data for our purposes**, despite matching the desired older-adult population. Closed out, not useful.
- **Nakagata, Naito, Yamada, デサントスポーツ科学 Vol. 40, pp.146-154** (`40_146.pdf`, initially failed to read — `pdftoppm` error on the first attempt, succeeded on retry) — a **third, distinct** Nakagata paper (not the 2019 APNM paper, not the 2022 JSCR paper above): a Japanese-language bulletin from the Ishimoto Memorial Descente Sports Science Promotion Foundation. 8 young men (23.4±1.8y), 6 bodyweight exercises with **slow tempo** (3s up/3s down: squat, push-up, lunge, heel-raise, hip-lift, crunch) vs. EE-matched treadmill walking. Result: 3.5±0.6 kcal/min, 3.1±0.3 METs during exercise (statistically indistinguishable from matched walking), but significantly higher 30-min post-exercise recovery EE (40.6±3.9 vs 37.6±3.2 kcal, p=0.029) — a real, citable finding that slow-tempo bodyweight RT produces a small but measurable extra afterburn vs. cardio at the same in-exercise EE. Aggregate-only (n=8), no CC license stated anywhere in the document (Japanese foundation bulletin, not a normal open-access journal) — treated as **RESEARCH/REFERENCE ONLY**, same as the standard-copyright JSCR papers. None of its 6 exercises map onto our trained 8-exercise ontology.
- **Mitchell et al. 2024, Sports Med** (`s40279-024-02047-8.pdf`) — confirmed by DOI to be the same systematic review already logged in `VALIDATION_REPORT.md` (wearable MAPE 15-57% benchmark). No new content beyond what's already cited.

**Net effect on the pipeline: none of these 5 add a usable training row** — 3 are aggregate-only + standard-copyright (Phillips 2003, the Descente bulletin), 1 is aggregate-only + explicitly non-commercial-licensed (Nakagata 2022), 1 doesn't measure what we need at all (Hunter 2000). Their value is as physiological context/reference: the "slow tempo ≈ moderate intensity, close to walking, but higher afterburn" pattern now shows up independently in *two* separate Nakagata papers (2022 and this bulletin), which is a real, reinforced finding worth keeping in mind for a future tempo-aware feature — just not trainable today given the license/aggregation constraints.

## Datasets found but NOT usable as training rows (checked, documented, excluded)

Searched systematically beyond the original 3: the Mitchell et al. 2024 review's citations, general web search across 2016-2025, and open-data repositories (Zenodo, OSF). Result — nothing new qualifies as individual-level, commercially-licensed, resistance-training energy-expenditure data:

- **Benito et al. 2016, PLOS ONE** (DOI 10.1371/journal.pone.0164349, CC BY 4.0) — 29 participants (15M/14F, ages 18-28), circuit/free-weight/combined training, indirect calorimetry. Mixed-sex and otherwise a strong candidate, BUT: the paper states individual-level data legally cannot be released ("data would always be in possession of the Technical University of Madrid and therefore can not be made public, following Spanish law"). Only published aggregate group means/SDs are usable — as a validation reference point, not as training rows. Not yet extracted into the pipeline; flagged here so it isn't silently forgotten.
- **PERSIST (Zenodo 7437230)** — 12 male participants, resistance training (flywheel squats), but ground truth is RPE only — no VO2/kcal measurement at all. Also restricted to "scientific use only," commercial status unclear. Excluded: wrong target variable, unclear license.
- **WEEE (Zenodo 6420886)** — CC BY 4.0, commercial-OK, real indirect-calorimeter ground truth, but confirmed (via the dataset's own paper) to cover only resting/cycling/running — no resistance training. Excluded: wrong activity type.
- **StrengthSense (Zenodo, 2025)** — CC BY 4.0, 29 participants, strength-demanding activities — but ground truth is joint-angle/activity-recognition via video, not calorimetry. No energy-expenditure label at all. Excluded: wrong target variable.

**Conclusion:** the 25-participant, 3-study dataset is not a temporary starting point waiting on an easy search win — it appears to be close to the actual ceiling of what's freely available and licensed for commercial use, for this specific exercise type and measurement method. Growing it further realistically requires either the paywalled studies (declined) or new measurement (the calibration-cohort idea, Phase 9/Section 26).

## Unified output

`data/processed/unified_observations_v0.csv` — 2,069 rows, built by `src/preprocessing/harmonize.py`. Every row retains `dataset_id`, `participant_group_id` (the leakage-safe grouping key), `exercise_canonical_id` + original label, condition/intensity, `metric_type`/`metric_subtype`, `value` + `unit`, and `is_directly_measured` / `is_group_mean_derived` flags. 441 rows from reis2017 were dropped as confirmed duplicates of reis2019 measurements (logged separately in `reis2017_dropped_duplicate_rows.csv`, not silently discarded).

**Real unique participant count across all 3 datasets: 25** (14 shared Reis-lab cohort + 11 Brunelli — see sufficiency note in DATA_AUDIT.md). This is materially smaller than the ~230 estimated in the earlier abstract-level audit, precisely because that estimate trusted search-summary text over the actual files.
