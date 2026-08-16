# V2 Leakage Report

Two parts: (1) an automated regression check on the current canonical dataset, (2) the documented overlap assessment for every candidate dataset from V2_DATA_ACQUISITION_REPORT.md, whether acquired or not.

## Part 1 — automated check on `v2_training_dataset.csv`

- **reis2017_reis2019_identical_namespace**: True
- **reis_lab_brunelli_disjoint**: True
- **total_unique_participants**: 25
- **reis_lab_participant_count**: 14
- **brunelli_participant_count**: 11

**Result: PASS** — no unaccounted-for leakage found; the known reis2017/reis2019 shared cohort remains correctly unified, and brunelli2019 remains correctly disjoint.

## Part 2 — candidate-dataset overlap matrix

| Dataset A | Dataset B | Status | Overlap evidence | Decision |
|---|---|---|---|---|
| reis2017 | reis2019 | IN_DATASET | Numeric identity: reis2017 blue-block kcal/min values match reis2019 EC values to several decimal places for the same participant/exercise/intensity. | CONFIRMED SAME COHORT — unified into shared participant_group_id namespace (reis_lab_p{1..14}). Never split across train/test. |
| reis-lab (17/19) | brunelli2019 | IN_DATASET | Different institutions, no shared authors, no numeric identity found in V1's audit. | CONFIRMED DISJOINT — safe to treat as independent participants. |
| reis-lab | Rustaden 2020 | NOT_YET_ACQUIRED | Portugal (reis-lab) vs. Norway (Rustaden) — different country, different institution, no shared authors found in a search this round. | No overlap expected. Re-verify with actual author/participant metadata IF raw data is obtained. |
| reis-lab | Joao 2021 | NOT_YET_ACQUIRED | Joao 2021 author list (Joao, Almeida, Tavares, Kalva-Filho, Carvas Junior, Pontes, Baker, Bocalini, Figueira) does not include Reis VM. | No overlap expected. SOFT FLAG: Joao 2021 shares 'Tavares'/'Bocalini' co-authors with a previously-logged systematic review that also lists a 'Reis' co-author — not independently confirmed as the same V. Reis (common surname). Re-verify if raw data is obtained. |
| reis-lab | Benito 2016 | REFERENCE_ONLY_PERMANENT | Portugal (reis-lab) vs. Spain, Technical University of Madrid (Benito) — different country/institution. | No overlap expected. Moot for training purposes — individual data is permanently unavailable regardless (Spanish law). |
| Rustaden 2020 | Joao 2021 | NOT_YET_ACQUIRED | Norway vs. Brazil — different country, different institution. | No overlap expected. |
| Rustaden 2020 | Benito 2016 | NOT_YET_ACQUIRED / REFERENCE_ONLY | Norway vs. Spain — different country, different institution. | No overlap expected. |
| Joao 2021 | Benito 2016 | NOT_YET_ACQUIRED / REFERENCE_ONLY | Brazil vs. Spain — different country, different institution. | No overlap expected. |
| reis-lab | Nakagata 2019 | NOT_YET_ACQUIRED | Portugal (reis-lab) vs. Japan (Nakagata/Juntendo University) — different country, different institution. | No overlap expected. |
| Nakagata 2019 | Rustaden 2020 / Joao 2021 / Benito 2016 | NOT_YET_ACQUIRED | Japan vs. Norway/Brazil/Spain — different country, different institution, different research group for all three. | No overlap expected. |
| Adeel 2021 (Appl Sci 11:8773) | Adeel 2022 (IJERPH 19:2233) | CONFIRMED_SAME_COHORT | Identical ClinicalTrials.gov registration (NCT04532905), identical IRB number (N202004023), identical recruitment window (Dec 2020-May 2021), identical sample structure (12 recruited / 1 excluded / 11 analysed; 5 untrained + 6 trained), identical exercises (shoulder press, deadlift, squat) and identical device (Cortex Metalyzer 3B). | SAME 11 PARTICIPANTS — must NEVER be counted as 22. Same class of error the reis2017/reis2019 numeric-identity check caught in V1. If either paper's data is ever acquired, both map to ONE participant_id namespace. |
| Adeel 2021/2022 cluster | Adeel et al. Appl Sci 11:6687 ('Energy Expenditure during Acute Weight Training', n=10, bent-over row/deadlift/lunge) | SUSPECTED_SAME_COHORT_UNVERIFIED | Same research group (Adeel/Peng, Taipei Medical University), same year, same untrained-vs-trained design, overlapping exercise (deadlift), n=10 vs n=11. MDPI blocked direct access to 11:6687 so the trial registration/IRB number could NOT be checked. | TREAT AS SAME COHORT until proven otherwise. Do not count as independent participants. Verify the NCT/IRB number if access is ever obtained. |
| reis-lab / Rustaden / Joao / Nakagata / Benito | Adeel cluster (Taiwan) | NOT_YET_ACQUIRED | Taiwan (Taipei Medical University) vs Portugal / Norway / Brazil / Japan / Spain — different country, institution and research group in every case. | No overlap expected. |
| Nakagata 2019 | Nakagata 2022 (previously EXCLUDED, CC BY-NC-ND) / Descente bulletin (40_146.pdf, reference-only) | SAME_AUTHOR_NETWORK | All three share Nakagata/Yamada/Naito as authors (same Juntendo University lab). Nakagata 2022 and the Descente bulletin were never usable as training data anyway (license-excluded and aggregate/unclear-license respectively), so this cannot create training leakage — but if Nakagata 2019's data is ever obtained, check whether ANY of its 20 participants also appear in the 2022 paper's 15-young-men sample before treating the two studies as fully independent (2022's population is young men only, Nakagata 2019 is older adults, so an overlap is unlikely on population-mismatch grounds alone, but not yet numerically verified). | No training-data risk today (neither prior Nakagata paper is trainable). Flagged for a real check if/when Nakagata 2019's individual data is ever acquired. |

## Net assessment

No confirmed participant-level leakage anywhere in the current dataset or among candidate datasets. One soft flag (Joao 2021's shared co-author surnames with a previously-logged review) is noted for awareness, not treated as disqualifying — a review paper has no primary-data cohort of its own to overlap with. This assessment will be re-run automatically the moment any new candidate's actual participant-level data is acquired — author/institution matching is a proxy, not a substitute for the numeric-identity check that actually proved the reis2017/reis2019 overlap.