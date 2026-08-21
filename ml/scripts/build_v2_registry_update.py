import csv

new_rows = [
{
 "dataset_name":"Rustaden et al. 2020 (Frontiers in Physiology)","platform":"Journal article (academic, not Kaggle/HF)","URL":"https://doi.org/10.3389/fphys.2020.00570",
 "license":"CC BY 4.0","commercial_use_status":"Paper text is CC BY; raw data availability separately gated (see below)","participant_count":"18 (10 BodyPump, 8 heavy-load)","row_count":"0 currently in hand - aggregate group means only in the published text",
 "participant_id_available":"Not currently - raw data is available on request to the corresponding author, not publicly downloadable","age_available":"Cohort mean only (36 +/- 10y)","sex_available":"Yes - 100% women","weight_available":"Cohort mean only (84 +/- 14kg)",
 "exercise_available":"Yes - 12 named exercises (squat, lunges, stiff-legged deadlift, forward rowing, bench press, dips, shoulder press, lateral raise, clean and press, overhead triceps press, biceps curl, sit-ups)","sets_available":"Yes (2-4 sets)","reps_available":"Yes (8RM)","load_available":"Yes (8RM load)",
 "duration_available":"Yes - 57.7 +/- 2.9 min, real multi-exercise session","intensity_available":"Yes (8RM, i.e. ~80% 1RM equivalent)","heart_rate_available":"Not confirmed from inspected content",
 "energy_expenditure_available":"Yes","energy_expenditure_unit":"kcal per session and kcal/min (289 +/- 69 kcal, 4.0 kcal/min for heavy load)","measurement_method":"Oxycon Pro Jaeger Instrument, Hans Rudolph mask, 30-second sampling, O2 x 5kcal",
 "indirect_calorimetry":"Yes - named device confirmed","multi_exercise":"Yes - real 12-exercise session, ~58 minutes","ground_truth_quality":"SILVER",
 "recommended_role":"TOP PRIORITY for outreach - request individual-level raw data from corresponding author. Closes 3 gaps at once: women (gap A), multi-exercise sessions (gap G), realistic longer duration (gap H).","reason":"Real named indirect-calorimetry device, documented protocol, genuine multi-exercise session at a realistic duration, 100% women (population V1 entirely lacks). Not GOLD only because participant-level data is not currently in hand - it exists but requires a data request, not yet made.","data_leakage_risk":"None expected - different country (Norway), different research group than reis-lab (Portugal) or Brunelli"
},
{
 "dataset_name":"Benito et al. 2016 (PLOS ONE, re-confirmed/enriched)","platform":"Journal supplement (already logged in V1 DATA_PROVENANCE.md, enriched this pass)","URL":"https://doi.org/10.1371/journal.pone.0164349",
 "license":"CC BY 4.0","commercial_use_status":"Paper text is CC BY; individual data is legally blocked, not merely request-gated","participant_count":"29 (15 men, 14 women)","row_count":"0 currently in hand and permanently unavailable per the paper's own Data Availability Statement",
 "participant_id_available":"No - explicitly barred: \"data would always be in possession of the Technical University of Madrid and therefore can not be made public, following Spanish law\"","age_available":"18-28y range stated","sex_available":"Yes - mixed sex (15M/14F)","weight_available":"Not individually available",
 "exercise_available":"Yes - 3 protocol variants: Circuit Machine (shoulder press machine, hack squat, seated cable row, leg press, seated chest press, leg curl, biceps curl machine, cable triceps extension), Free Weight (dumbbell shoulder press, barbell squat, barbell row, side split squat, bench press, split squat, barbell biceps curl, lying triceps extension), Combined Exercise (squat/running intervals)","sets_available":"Yes (3 sets of 8 exercises)","reps_available":"Yes (15 reps, 70% of 15RM)","load_available":"Yes (70% 15RM)",
 "duration_available":"Yes - 64 min including warm-up, real multi-exercise session","intensity_available":"Yes (70% of 15RM)","heart_rate_available":"Not confirmed from inspected content",
 "energy_expenditure_available":"Yes","energy_expenditure_unit":"kcal per session (group aggregate only)","measurement_method":"Jaeger Oxycon Mobile portable metabolic system",
 "indirect_calorimetry":"Yes - named device confirmed","multi_exercise":"Yes - three distinct real multi-exercise protocols, ~64 minutes each","ground_truth_quality":"SILVER",
 "recommended_role":"Reference/validation only - individual-level rows are permanently unobtainable, unlike Rustaden's request-gated data. Useful as an independent aggregate cross-check the same way Brunelli's data was used in V1.","reason":"Real device, real multi-exercise sessions, mixed-sex, matches several existing ontology exercises (squat/bench press/biceps curl/triceps extension/leg press) - but raw data access is categorically closed by Spanish data-protection law, not just ungranted.","data_leakage_risk":"None expected - different country (Spain, Technical University of Madrid), different research group than reis-lab or Rustaden"
},
{
 "dataset_name":"Joao et al. 2021 (Frontiers in Sports and Active Living)","platform":"Journal article (academic, not Kaggle/HF)","URL":"https://doi.org/10.3389/fspor.2021.797604",
 "license":"CC BY","commercial_use_status":"Paper text is CC BY; individual-level data availability not confirmed this pass","participant_count":"15 (all men, trained)","row_count":"Not confirmed - no supplementary data file found in inspected content",
 "participant_id_available":"Not confirmed - no data-availability statement or supplementary file identified this pass","age_available":"Cohort mean (22.87 +/- 2.61y)","sex_available":"100% men","weight_available":"Cohort mean only (83.60 +/- 9.76kg)",
 "exercise_available":"Yes - 8 named exercises (chest press, pec deck, squat, lat pulldown, biceps curl, triceps extension, hamstring curl, crunch machine) - 5 of 8 overlap directly with SK OS's existing trained ontology","sets_available":"Yes (2-6 sets depending on condition)","reps_available":"Yes (5-15 reps depending on condition)","load_available":"Yes (60%/75%/90% 1RM, three conditions)",
 "duration_available":"Yes - REALISTIC LONG DURATIONS: 44 min (60%1RM), 61.4 min (75%1RM), 116 min (90%1RM), all real multi-exercise sessions","intensity_available":"Yes - three full intensity conditions, not just light/moderate/hard buckets","heart_rate_available":"Not confirmed from inspected content",
 "energy_expenditure_available":"Yes","energy_expenditure_unit":"Not fully extracted this pass - VO2/kcal reported per the abstract, exact units need the full-text table","measurement_method":"COSMED Fitmate Pro gas analyzer, measured every 2 minutes",
 "indirect_calorimetry":"Yes - named COSMED device confirmed, same manufacturer family as the existing V1 reis-lab data (COSMED K4b2)","multi_exercise":"Yes - real 8-exercise sessions at 3 realistic durations up to 116 minutes","ground_truth_quality":"SILVER",
 "recommended_role":"HIGH PRIORITY for outreach - this is the closest thing found anywhere to directly answering V1's most critical open question (does a high-intensity multi-exercise session's measured cost over 44-116 real minutes match what the model assumes). Request full data/supplementary tables from corresponding author.","reason":"Real named device, trained population (closes gap D), realistic session durations up to 116 minutes (directly relevant to the V1 audit's duration-extrapolation finding), 5 of 8 exercises overlap the existing ontology. Not GOLD only because individual-level/raw data access wasn't confirmed as available this pass - needs a direct request.","data_leakage_risk":"Shares co-authors (Tavares, Bocalini) with a previously-logged systematic review (Joao/Rodriguez/Tavares/Reis/Bocalini, Clinical Physiology and Functional Imaging) - same Brazilian exercise-science research network. The review's 'Reis' co-author was NOT independently confirmed as the same V. Reis as reis2017/reis2019 (a very common Portuguese-language surname) - flagged for awareness, not a confirmed leakage risk, since a review paper has no primary-data cohort of its own to overlap with."
},
{
 "dataset_name":"Untrained vs. trained dumbbell EE study (MDPI Applied Sciences)","platform":"Journal article - SOURCE COULD NOT BE DIRECTLY ACCESSED THIS PASS","URL":"https://doi.org/10.3390/app11156687",
 "license":"NOT CONFIRMED - MDPI blocked both WebFetch and browser access this session (403)","commercial_use_status":"UNRESOLVED - cannot confirm without direct access","participant_count":"10 (5 untrained, 5 trained) per search-summary text only, not independently verified from the primary source","row_count":"Unknown",
 "participant_id_available":"Unknown","age_available":"Unknown","sex_available":"Unknown","weight_available":"Unknown",
 "exercise_available":"Reportedly bent-over row, deadlift, lunge (dumbbell) - per search summary only","sets_available":"Unknown","reps_available":"Unknown","load_available":"Unknown",
 "duration_available":"Unknown","intensity_available":"Unknown","heart_rate_available":"Reportedly yes, per search summary","energy_expenditure_available":"Reportedly yes (METs, EE, RER) per search summary","energy_expenditure_unit":"Unknown",
 "measurement_method":"UNCONFIRMED - search summary speculated 'COSMED equipment would be typical' but this is a guess, not a verified fact, and is explicitly NOT being treated as confirmed","indirect_calorimetry":"Reportedly yes, device NOT independently confirmed",
 "multi_exercise":"Reportedly yes (3 exercises per session)","ground_truth_quality":"UNVERIFIED - deliberately not assigned GOLD/SILVER/AUXILIARY/EXCLUDE",
 "recommended_role":"Follow-up required before any classification - directly relevant to the beginner-vs-trained gap (C/D) if confirmed, but per V2_DATA_QUALITY_RULES.md's hard requirement to verify the original source, this cannot be scored on search-summary text alone.","reason":"MDPI's site returned 403 to both automated fetch and browser navigation this session - genuinely could not verify. Logged transparently rather than guessed at, per the explicit instruction not to lower the bar.","data_leakage_risk":"Cannot be assessed without verified author/institution information"
},
]

with open("data/dataset_registry.csv", "r", newline="", encoding="utf-8") as f:
    reader = csv.DictReader(f)
    fieldnames = reader.fieldnames
    existing_rows = list(reader)

all_rows = existing_rows + new_rows
with open("data/dataset_registry.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=fieldnames)
    w.writeheader()
    w.writerows(all_rows)

print(f"Registry now has {len(all_rows)} total rows ({len(new_rows)} added this pass)")
