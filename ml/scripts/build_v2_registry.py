import csv

rows = [
# ===== Existing V1 datasets, included for context/comparison =====
{
 "dataset_name":"Reis et al. 2017 (PLOS ONE)","platform":"Journal supplement (already in use, V1)","URL":"https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0181311",
 "license":"CC BY 4.0","commercial_use_status":"Allowed","participant_count":"14","row_count":"679",
 "participant_id_available":"Yes","age_available":"Cohort mean only","sex_available":"Yes (cohort-level)","weight_available":"Cohort mean only",
 "exercise_available":"Yes (8 exercises)","sets_available":"No (continuous bout)","reps_available":"No","load_available":"Yes (%1RM)",
 "duration_available":"Yes (protocol-level)","intensity_available":"Yes (%1RM)","heart_rate_available":"No",
 "energy_expenditure_available":"Yes","energy_expenditure_unit":"relative VO2 (ml/kg/min), rate","measurement_method":"COSMED K4b2 breath-by-breath",
 "indirect_calorimetry":"Yes","multi_exercise":"No (isolated single-exercise bouts)","ground_truth_quality":"GOLD",
 "recommended_role":"Already in use - V1 training data","reason":"Directly measured VO2, documented method, participant-level, CC BY 4.0.","data_leakage_risk":"Confirmed same cohort as reis2019 (numeric proof)"
},
{
 "dataset_name":"Reis et al. 2019 (PLOS ONE)","platform":"Journal supplement (already in use, V1)","URL":"https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0221284",
 "license":"CC BY 4.0","commercial_use_status":"Allowed","participant_count":"14 (same cohort as reis2017)","row_count":"994",
 "participant_id_available":"Yes","age_available":"Cohort mean only","sex_available":"Yes (cohort-level)","weight_available":"Cohort mean only",
 "exercise_available":"Yes (8 exercises)","sets_available":"No (continuous bout)","reps_available":"No","load_available":"Yes (%1RM)",
 "duration_available":"Yes (protocol-level)","intensity_available":"Yes (%1RM)","heart_rate_available":"Yes",
 "energy_expenditure_available":"Yes","energy_expenditure_unit":"kcal/min, directly reported","measurement_method":"COSMED K4b2 breath-by-breath",
 "indirect_calorimetry":"Yes","multi_exercise":"No (isolated single-exercise bouts)","ground_truth_quality":"GOLD",
 "recommended_role":"Already in use - V1 training data","reason":"Directly reported EC, cleanest units of the 3 V1 sources, CC BY 4.0.","data_leakage_risk":"Confirmed same cohort as reis2017 (numeric proof)"
},
{
 "dataset_name":"Brunelli et al. 2019 (PLOS ONE)","platform":"Journal supplement (already in use, V1)","URL":"https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0224801",
 "license":"CC BY 4.0","commercial_use_status":"Allowed","participant_count":"11","row_count":"396",
 "participant_id_available":"Yes","age_available":"Cohort mean only","sex_available":"Yes (cohort-level)","weight_available":"Cohort mean only",
 "exercise_available":"Yes (1: leg extension)","sets_available":"Yes (3, condition-level)","reps_available":"No (to failure)","load_available":"Yes (%1RM)",
 "duration_available":"Partial (protocol-level, not per-set)","intensity_available":"Yes (30%/80%1RM)","heart_rate_available":"No",
 "energy_expenditure_available":"Yes","energy_expenditure_unit":"absolute kcal (not a rate)","measurement_method":"Oxycon portable gas analyzer, breath-by-breath",
 "indirect_calorimetry":"Yes","multi_exercise":"No (single exercise)","ground_truth_quality":"GOLD",
 "recommended_role":"Already in use - V1 confirmatory check only (different target unit, not used to fit the model)","reason":"Directly measured, but absolute-kcal target incompatible with the rate-based model; used as independent validation instead.","data_leakage_risk":"Confirmed disjoint from reis-lab cohort"
},
# ===== Kaggle candidates, individually inspected this pass =====
{
 "dataset_name":"Gym Members Exercise Dataset","platform":"Kaggle (valakhorasani)","URL":"https://www.kaggle.com/datasets/valakhorasani/gym-members-exercise-dataset",
 "license":"Apache 2.0","commercial_use_status":"License permits it, but data quality disqualifies use","participant_count":"973","row_count":"973",
 "participant_id_available":"No","age_available":"Yes","sex_available":"Yes","weight_available":"Yes",
 "exercise_available":"Yes (Workout_Type: Cardio/Strength/Yoga/HIIT)","sets_available":"No","reps_available":"No","load_available":"No",
 "duration_available":"Yes (hours)","intensity_available":"No explicit tier (BPM only)","heart_rate_available":"Yes (Max/Avg/Resting BPM)",
 "energy_expenditure_available":"Yes","energy_expenditure_unit":"kcal per session (undocumented derivation)","measurement_method":"Not stated - page explicitly says data is generated",
 "indirect_calorimetry":"No","multi_exercise":"No (single workout type per row)","ground_truth_quality":"EXCLUDE",
 "recommended_role":"Do not use","reason":"Dataset page states outright the data is generated to reflect realistic exercise tracking scenarios, and explicitly says: please do not use this dataset for research purposes. Self-disclosed synthetic, explicitly discouraged from research use.","data_leakage_risk":"N/A (excluded)"
},
{
 "dataset_name":"Calories Burned During Exercise and Activities","platform":"Kaggle (aadhavvignesh)","URL":"https://www.kaggle.com/datasets/aadhavvignesh/calories-burned-during-exercise-and-activities",
 "license":"CC BY-SA 4.0","commercial_use_status":"License permits it, but data is not participant-level","participant_count":"0 (no participants - generic per-activity table)","row_count":"248 activities",
 "participant_id_available":"No","age_available":"No","sex_available":"No","weight_available":"No (4 generic weight brackets: 130/155/180/205 lb)",
 "exercise_available":"Yes (248 activity names, incl. some resistance categories)","sets_available":"No","reps_available":"No","load_available":"No",
 "duration_available":"Fixed 1 hour per row","intensity_available":"Encoded only in activity name (e.g. vigorous)","heart_rate_available":"No",
 "energy_expenditure_available":"Yes","energy_expenditure_unit":"kcal/hour by weight bracket","measurement_method":"Creator states dataset was compiled manually - no calorimetry, appears to be a manual recompilation of standard MET-style tables",
 "indirect_calorimetry":"No","multi_exercise":"No","ground_truth_quality":"EXCLUDE",
 "recommended_role":"Do not use","reason":"No participants, no calorimetry, manually compiled from unstated sources - undocumented calculation exactly as the exclusion rule describes.","data_leakage_risk":"N/A (excluded)"
},
{
 "dataset_name":"FitLife: Health & Fitness Tracking Dataset","platform":"Kaggle (jijagallery)","URL":"https://www.kaggle.com/datasets/jijagallery/fitlife-health-and-fitness-tracking-dataset",
 "license":"Not confirmed this pass","commercial_use_status":"Disqualified by data quality regardless of license","participant_count":"3000 (simulated)","row_count":"~1,095,000 (3000 x 365 days, not independently confirmed)",
 "participant_id_available":"Yes (participant_id)","age_available":"Yes","sex_available":"Yes","weight_available":"Yes",
 "exercise_available":"Yes (activity_type)","sets_available":"No","reps_available":"No","load_available":"No",
 "duration_available":"Yes (duration_minutes)","intensity_available":"Yes (Low/Medium/High, categorical)","heart_rate_available":"Yes (avg + resting)",
 "energy_expenditure_available":"Yes","energy_expenditure_unit":"calories_burned per activity (explicitly labeled Estimated)","measurement_method":"None - page states outright that FitLife360 is a synthetic dataset",
 "indirect_calorimetry":"No","multi_exercise":"No (one activity_type per row)","ground_truth_quality":"EXCLUDE",
 "recommended_role":"Do not use","reason":"Self-disclosed synthetic dataset, calorie field explicitly labeled an estimate, not a measurement.","data_leakage_risk":"N/A (excluded)"
},
{
 "dataset_name":"Gym Workout IMU Dataset","platform":"Kaggle (shakthisairam123)","URL":"https://www.kaggle.com/datasets/shakthisairam123/gym-workout-imu-dataset",
 "license":"MIT","commercial_use_status":"Allowed","participant_count":"Not stated (appears to be 1 - personal recording project)","row_count":"164 sets (raw IMU time-series files)",
 "participant_id_available":"No","age_available":"No","sex_available":"No","weight_available":"No",
 "exercise_available":"Yes (36 named strength exercises)","sets_available":"Yes (encoded in filename)","reps_available":"Yes (encoded in filename)","load_available":"Yes (encoded in filename)",
 "duration_available":"Yes (raw sensor timestamps, ~100Hz)","intensity_available":"No explicit tier","heart_rate_available":"No",
 "energy_expenditure_available":"No","energy_expenditure_unit":"N/A","measurement_method":"Apple Watch SE wrist IMU sensor, 100Hz - motion only, not physiological",
 "indirect_calorimetry":"No","multi_exercise":"No (one exercise per file)","ground_truth_quality":"AUXILIARY",
 "recommended_role":"Reference only - exercise-identity/rep-counting ideas, never as EE ground truth","reason":"Real, well-documented sets/reps/load/exercise-identity data, but zero calorie or physiological EE signal of any kind.","data_leakage_risk":"Low - unrelated to V1 cohorts, but effectively single-subject so adds no population diversity"
},
{
 "dataset_name":"Weight Lifting Exercises (Velloso et al. 2013)","platform":"Kaggle mirror (prashant111) of UCI ML Repository","URL":"https://www.kaggle.com/datasets/prashant111/weight-lifting-exercises",
 "license":"Unknown on the Kaggle mirror page","commercial_use_status":"Unresolved - check original UCI/paper license before any use","participant_count":"Reportedly 6 per the original 2013 paper (not independently re-confirmed from the Kaggle mirror content this session)","row_count":"Not confirmed this pass (large IMU time-series set, original study widely cited)",
 "participant_id_available":"Likely yes (per-subject IMU streams)","age_available":"Not confirmed","sex_available":"Not confirmed","weight_available":"Not confirmed",
 "exercise_available":"Yes (1: Unilateral Dumbbell Biceps Curl, 5 form-quality classes)","sets_available":"Yes (windowed)","reps_available":"Partial (10 reps per set, per protocol)","load_available":"Not clearly available",
 "duration_available":"Yes (1s time windows)","intensity_available":"No","heart_rate_available":"No",
 "energy_expenditure_available":"No","energy_expenditure_unit":"N/A","measurement_method":"4x IMU sensors (belt, arm, forearm, dumbbell) - motion/form classification, not physiological",
 "indirect_calorimetry":"No","multi_exercise":"No (single exercise)","ground_truth_quality":"AUXILIARY",
 "recommended_role":"Reference only - real peer-reviewed academic origin, but no EE data and license needs resolving before any use","reason":"Legitimate published research (Augmented Human 2013), real participants, but designed for form-quality classification, not energy expenditure - no calorie/VO2 column exists at all.","data_leakage_risk":"None expected - different research group/population than V1's Reis/Brunelli cohorts"
},
{
 "dataset_name":"721 Weight Training Workouts","platform":"Kaggle (joep89)","URL":"https://www.kaggle.com/datasets/joep89/weightlifting",
 "license":"Not confirmed this pass","commercial_use_status":"Unresolved","participant_count":"1 (single self-tracked individual, ~3 years of personal logs)","row_count":"721 workouts (exact set-level row count not confirmed)",
 "participant_id_available":"N/A (single person)","age_available":"No","sex_available":"No","weight_available":"Only the logger's own body weight, stated in the description, not per-row",
 "exercise_available":"Yes (many named exercises, self-logged, inconsistent naming per the author's own notes)","sets_available":"Yes","reps_available":"Yes","load_available":"Yes (lbs)",
 "duration_available":"No per-set duration","intensity_available":"No explicit tier (a 1RM proxy formula is included)","heart_rate_available":"No",
 "energy_expenditure_available":"No","energy_expenditure_unit":"N/A","measurement_method":"Self-logged via the Strong app - no physiological measurement of any kind",
 "indirect_calorimetry":"No","multi_exercise":"Yes (real multi-exercise sessions, PPL split)","ground_truth_quality":"AUXILIARY",
 "recommended_role":"Reference only - illustrates real multi-exercise session structure, never as EE ground truth","reason":"n=1, no calorie data, self-logged not measured - genuinely real but not generalizable and has no EE target at all.","data_leakage_risk":"None"
},
{
 "dataset_name":"Powerlifting Database (OpenPowerlifting)","platform":"Kaggle (open-powerlifting), CC0 public-domain source","URL":"https://www.kaggle.com/datasets/open-powerlifting/powerlifting-database",
 "license":"CC0: Public Domain","commercial_use_status":"Allowed (most permissive license found in this search)","participant_count":"~800,000 real competitive lifters","row_count":"~800,000+ (one competition-database snapshot, 41 columns)",
 "participant_id_available":"Yes (by name; not a stable anonymized ID)","age_available":"Yes","sex_available":"Yes","weight_available":"Yes (bodyweight class)",
 "exercise_available":"Yes (Squat/Bench/Deadlift only)","sets_available":"No (competition max attempts only)","reps_available":"No (1RM-style competition lifts)","load_available":"Yes (competition totals in kg/lb)",
 "duration_available":"No","intensity_available":"Implicit only (max-effort by definition)","heart_rate_available":"No",
 "energy_expenditure_available":"No","energy_expenditure_unit":"N/A","measurement_method":"Competition meet records - performance data, not physiological",
 "indirect_calorimetry":"No","multi_exercise":"No (one lift type per row)","ground_truth_quality":"AUXILIARY",
 "recommended_role":"Special reference use - real-world 1RM/load distributions by age/sex/bodyweight, directly relevant to resolving V1's open percent-1RM-to-intensity-tier mapping question (audit finding #8b), never as EE ground truth","reason":"No calorie/EE data exists in this dataset at all, but it is the largest, cleanest, most permissively-licensed real-lifter strength dataset found - valuable for a different, specific V1 gap, not for training the calorie model itself.","data_leakage_risk":"None expected"
},
# ===== Hugging Face candidates, individually inspected this pass =====
{
 "dataset_name":"calorie-burnt-15k","platform":"Hugging Face (mnemoraorg)","URL":"https://huggingface.co/datasets/mnemoraorg/calorie-burnt-15k",
 "license":"ECL-2.0 (Eclipse Public License 2.0)","commercial_use_status":"License permits it, but data quality disqualifies use","participant_count":"Not stated (User_ID field exists, count unconfirmed)","row_count":"15,000",
 "participant_id_available":"Yes (User_ID)","age_available":"Yes","sex_available":"Yes (Gender)","weight_available":"Yes",
 "exercise_available":"No (general 'exercise session', not resistance-specific)","sets_available":"No","reps_available":"No","load_available":"No",
 "duration_available":"Yes (minutes)","intensity_available":"No explicit tier","heart_rate_available":"Yes",
 "energy_expenditure_available":"Yes","energy_expenditure_unit":"Calories per session (unit/method undocumented)","measurement_method":"Not stated - dataset card provides no specifics on how calorie burn was calculated or measured",
 "indirect_calorimetry":"No","multi_exercise":"No","ground_truth_quality":"EXCLUDE",
 "recommended_role":"Do not use","reason":"Undocumented calorie methodology - exactly the no-specifics-provided EXCLUDE case, regardless of claimed real-human origin.","data_leakage_risk":"N/A (excluded)"
},
{
 "dataset_name":"fitness-tracker-dataset","platform":"Hugging Face (strova-ai)","URL":"https://huggingface.co/datasets/strova-ai/fitness-tracker-dataset",
 "license":"MIT","commercial_use_status":"Disqualified by data quality regardless of license","participant_count":"Not stated (synthetic - no real participants)","row_count":"Not confirmed this pass",
 "participant_id_available":"Not confirmed","age_available":"Yes","sex_available":"Yes","weight_available":"Yes",
 "exercise_available":"Yes (general activity: Lying/Walking/Running etc - not resistance-specific)","sets_available":"No","reps_available":"No","load_available":"No",
 "duration_available":"Not detailed","intensity_available":"Yes (intensity_karvonen - formula-derived, not measured)","heart_rate_available":"Yes",
 "energy_expenditure_available":"Yes","energy_expenditure_unit":"calories (formula-derived)","measurement_method":"Explicitly stated: all entries are fully synthetic, generated with Syncora.ai's synthetic data engine",
 "indirect_calorimetry":"No","multi_exercise":"No","ground_truth_quality":"EXCLUDE",
 "recommended_role":"Do not use","reason":"Self-disclosed 100% synthetic data; also not resistance-training specific.","data_leakage_risk":"N/A (excluded)"
},
{
 "dataset_name":"SmartFitnessNutritionAnalyticsDataset","platform":"Hugging Face (Idankhen)","URL":"https://huggingface.co/datasets/Idankhen/SmartFitnessNutritionAnalyticsDataset",
 "license":"Not confirmed this pass","commercial_use_status":"Unresolved - resolve before any use","participant_count":"Not stated","row_count":"20,000",
 "participant_id_available":"Not confirmed","age_available":"Yes","sex_available":"Yes","weight_available":"Yes",
 "exercise_available":"Yes (55 named exercises + Target Muscle Group + Equipment)","sets_available":"Yes","reps_available":"Yes","load_available":"Not clearly confirmed",
 "duration_available":"Yes (Session_Duration)","intensity_available":"Partial (Workout_Type, Experience_Level)","heart_rate_available":"Yes (Max/Avg/Resting BPM)",
 "energy_expenditure_available":"Yes","energy_expenditure_unit":"Calories_Burned plus a separate per-30-min figure (derivation undocumented in available content)","measurement_method":"Not stated in inspected content",
 "indirect_calorimetry":"No","multi_exercise":"Not confirmed (fields suggest per-exercise rows)","ground_truth_quality":"AUXILIARY",
 "recommended_role":"Reference only for exercise ontology (55 exercises x muscle group x equipment) - Calories_Burned column explicitly NOT to be treated as ground truth per the core rule","reason":"Richest resistance-training feature set found on either platform (sets/reps/exercise/muscle group/equipment), but the calorie methodology is undocumented and license is unresolved - exactly the case the user's instruction warned against treating as ground truth by column-name alone.","data_leakage_risk":"Unknown - source/authorship not established"
},
{
 "dataset_name":"workout-routine","platform":"Hugging Face (Varick)","URL":"https://huggingface.co/datasets/Varick/workout-routine",
 "license":"Not specified","commercial_use_status":"Unresolved","participant_count":"1 (appears to be a single logged individual)","row_count":"30",
 "participant_id_available":"No","age_available":"No","sex_available":"No","weight_available":"No (only session load, not body weight)",
 "exercise_available":"Yes (squat/bench/deadlift/pull-up - resistance-specific)","sets_available":"Yes","reps_available":"Yes","load_available":"Yes (kg)",
 "duration_available":"No","intensity_available":"Yes (RPE + Tempo, both self-reported/categorical)","heart_rate_available":"No",
 "energy_expenditure_available":"No","energy_expenditure_unit":"N/A","measurement_method":"Parsed from natural-language workout log text - no physiological measurement",
 "indirect_calorimetry":"No","multi_exercise":"Yes (multiple exercises represented)","ground_truth_quality":"AUXILIARY",
 "recommended_role":"Reference only - illustrates RPE/tempo-tagged logging format, far too small (n=30) for any modeling use","reason":"Real resistance-training-specific fields including RPE and tempo (directly relevant to the tempo problem flagged in V1), but no EE data and tiny sample.","data_leakage_risk":"None (unrelated, trivially small)"
},
]

fieldnames = ["dataset_name","platform","URL","license","commercial_use_status","participant_count","row_count",
"participant_id_available","age_available","sex_available","weight_available","exercise_available","sets_available",
"reps_available","load_available","duration_available","intensity_available","heart_rate_available",
"energy_expenditure_available","energy_expenditure_unit","measurement_method","indirect_calorimetry","multi_exercise",
"ground_truth_quality","recommended_role","reason","data_leakage_risk"]

with open("data/dataset_registry.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=fieldnames)
    w.writeheader()
    w.writerows(rows)

print(f"Wrote data/dataset_registry.csv - {len(rows)} rows")
