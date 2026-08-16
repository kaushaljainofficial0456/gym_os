"""Add the Adeel/Peng (Taipei Medical University) research cluster to the V2 registry,
AND compute an independent cross-check of its measured METs against V1's baseline
assumptions and the reis-lab 80%1RM values.

All numbers below are transcribed directly from the published tables, not estimated.
Source: Adeel et al. 2021, Appl. Sci. 11(18):8773, CC BY 4.0, Table 2 + Table 5.
"""
import csv

# ---- Transcribed from Adeel 2021 Appl Sci 8773, Table 2 (baseline characteristics) ----
GROUP_WEIGHT_KG = {"untrained": 53.32, "trained": 81.68}

# ---- Transcribed from Table 5 ("During Exercise" MET column, mean +/- SD) ----
MEASURED_MET_DURING_EXERCISE = {
    "shoulder_press": {"untrained": 1.30, "trained": 2.02},
    "deadlift":       {"untrained": 2.71, "trained": 3.13},
    "squat":          {"untrained": 2.70, "trained": 3.42},
}

# V1's deployed baseline MET assumptions (model_v1.json baseline.met_by_tier)
V1_BASELINE_MET = {"light": 3.0, "moderate": 4.5, "hard": 6.0}


def met_to_kcal_min(met, weight_kg):
    return met * 3.5 * weight_kg / 200


print("=" * 78)
print("INDEPENDENT CROSS-CHECK: Adeel 2021 (Taiwan) measured METs vs V1 assumptions")
print("60% 1RM dumbbell exercises, Cortex Metalyzer 3B, n=11 (5 untrained / 6 trained)")
print("=" * 78)
print()
print(f"{'exercise':<18}{'group':<12}{'measured_MET':<14}{'-> kcal/min':<14}{'V1 hard-tier kcal/min at same bw'}")
for ex, groups in MEASURED_MET_DURING_EXERCISE.items():
    for grp, met in groups.items():
        bw = GROUP_WEIGHT_KG[grp]
        measured = met_to_kcal_min(met, bw)
        v1_hard = met_to_kcal_min(V1_BASELINE_MET["hard"], bw)
        print(f"{ex:<18}{grp:<12}{met:<14.2f}{measured:<14.2f}{v1_hard:.2f}")

print()
print("V1 baseline MET assumptions:", V1_BASELINE_MET)
print()
print("Measured MET range across all 6 cells:",
      f"{min(m for g in MEASURED_MET_DURING_EXERCISE.values() for m in g.values()):.2f}",
      "-",
      f"{max(m for g in MEASURED_MET_DURING_EXERCISE.values() for m in g.values()):.2f}")
print()
print("For comparison, reis2017's measured BARBELL_SQUAT at 80%1RM (from our own")
print("v2_training_dataset.csv): mean 35.94 kcal/min at cohort weight 78.67kg")
print(f"  -> that is {35.94 / (3.5*78.67/200):.1f} METs")
print()
print("INTERPRETATION (stated carefully, not overclaimed):")
print("  These two studies measured DIFFERENT things and are not directly contradictory:")
print("  - reis2017's 80%1RM condition = a single 26-56s bout to exhaustion (peak effort only)")
print("  - Adeel's = MET averaged across 30s sets at 60%1RM within a full set/rest structure")
print("  But the gap (26 METs vs 2.7-3.4 METs) is independent, third-party evidence that")
print("  short max-effort bout rates CANNOT be extrapolated across a real session --")
print("  exactly the failure mode V1_PRE_INTEGRATION_AUDIT.md #3/#4/#5 identified and")
print("  the 20 kcal/min plausibility cap was added to prevent.")
print()

# ---- Add to registry ----
new_row = {
 "dataset_name":"Adeel et al. 2021 + 2022 (Taipei Medical University cluster) — SAME COHORT, see leakage note",
 "platform":"Journal articles (Applied Sciences 2021 + IJERPH 2022), both fully open access",
 "URL":"https://doi.org/10.3390/app11188773 (2021) and https://doi.org/10.3390/ijerph19042233 (2022)",
 "license":"CC BY 4.0 — explicitly stated in both articles, commercially usable",
 "commercial_use_status":"ALLOWED (CC BY 4.0) — the only new SILVER candidate found with a confirmed commercial-compatible license",
 "participant_count":"11 analysed (12 recruited, 1 excluded): 5 untrained + 6 trained. NOT 22 — the two papers report the SAME 11 people.",
 "row_count":"0 individual rows. Both papers report group means +/- SD only. Table 5 (2021) gives 6 aggregate cells: 3 exercises x 2 groups.",
 "participant_id_available":"No — group-level reporting only in the 2021 paper. The 2022 IJERPH paper's Table 2 appears to list per-participant demographics (age/sex/height/weight/BMI/1RM loads) but NOT per-participant VO2/MET/EE outcomes.",
 "age_available":"Group means only (untrained 22.00+/-2.00y, trained 25.83+/-3.66y); inclusion range 20-40y",
 "sex_available":"YES and notably favourable: untrained group is 0 male / 5 female; trained group 4 male / 2 female. 7 of 11 participants are women.",
 "weight_available":"Group means only (untrained 53.32+/-3.38kg, trained 81.68+/-19.48kg). NOT individual in the 2021 paper.",
 "exercise_available":"Yes — 3 dumbbell exercises: shoulder press, deadlift, squat. DEADLIFT is a compound free-weight lift absent from V1's trained set entirely.",
 "sets_available":"Yes — 3 sets of 10 reps, fixed protocol","reps_available":"Yes — 10 reps/set, 1.5s up / 1.5s down cadence, metronome-controlled",
 "load_available":"Yes — 60% of individually-tested 1RM; group-mean absolute loads given per exercise (e.g. squat 16.00+/-2.74kg untrained vs 32.33+/-3.76kg trained)",
 "duration_available":"Yes — highly detailed: 30s per set, 2min rest between sets, 8min between exercises, 52min30s total session",
 "intensity_available":"Yes — 60% 1RM, a single well-defined intensity (no light/moderate/hard variation)",
 "heart_rate_available":"Yes — group means during exercise and rest, per exercise",
 "energy_expenditure_available":"Yes — as METs (convertible to kcal/min via group-mean body weight)",
 "energy_expenditure_unit":"METs (group mean +/- SD), during-exercise and during-rest reported separately",
 "measurement_method":"Indirect calorimetry, breath-by-breath, mask; raw data exported from the analyser to Excel (so individual-level data DOES exist, it is simply not published)",
 "indirect_calorimetry":"Yes — named device: Cortex Metalyzer 3B (Cortex, Leipzig, Germany)",
 "multi_exercise":"Yes — 3 exercises within one ~52min session, with realistic set/rest structure",
 "ground_truth_quality":"SILVER",
 "recommended_role":"(a) IMMEDIATE: use the aggregate METs as an independent validation reference — it is third-party evidence supporting V1's plausibility cap (see cross-check above). (b) OUTREACH: request individual-level Cortex exports from corresponding author Chih-Wei Peng (cwpeng@tmu.edu.tw). Note their Data Availability Statement says data is 'all available in the article', so a raw-data request may well be declined — but the paper states raw analyser data was exported to Excel, so it demonstrably exists.",
 "reason":"Real named calorimetry device, CC BY 4.0, women-majority sample, untrained AND trained groups, compound free-weight exercises including deadlift, realistic multi-exercise session structure with documented sets/reps/load/cadence/rest. Fails GOLD solely because published data is aggregate group means, not participant-level rows.",
 "data_leakage_risk":"CRITICAL FINDING — the 2021 Appl Sci paper and the 2022 IJERPH paper are the SAME 11 PARTICIPANTS, not 22. Evidence: identical ClinicalTrials.gov registration (NCT04532905), identical IRB number (N202004023), identical recruitment window (Dec 2020-May 2021), identical n (12 recruited/1 excluded/11 analysed, 5 untrained + 6 trained), identical exercises and device. A third paper by the same group (Appl Sci 11:6687, 'Energy Expenditure during Acute Weight Training Exercises', n=10, bent-over row/deadlift/lunge) is very likely the same trial too — UNVERIFIED, MDPI blocked direct access. Treat the entire Adeel/Peng output as ONE cohort of ~11-12 people. This is the same class of error the reis2017/reis2019 numeric-identity check caught in V1.",
}

with open("data/dataset_registry.csv", "r", newline="", encoding="utf-8") as f:
    reader = csv.DictReader(f)
    fieldnames = reader.fieldnames
    existing_rows = list(reader)

with open("data/dataset_registry.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=fieldnames)
    w.writeheader()
    w.writerows(existing_rows + [new_row])

print(f"Registry now has {len(existing_rows) + 1} rows (1 added)")
