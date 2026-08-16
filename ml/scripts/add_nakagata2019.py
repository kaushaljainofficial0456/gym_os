import csv

new_row = {
 "dataset_name":"Nakagata et al. 2019 (Applied Physiology, Nutrition, and Metabolism)",
 "platform":"Journal article - found as an author-archived manuscript DRAFT via a University of Toronto institutional repository, not the publisher's final licensed version",
 "URL":"https://cdnsciencepub.com/doi/10.1139/apnm-2018-0882",
 "license":"UNRESOLVED - this is a pre-publication draft (manuscript ID apnm-2018-0882.R1), not the citable published version. No license statement appears on the draft itself. APNM/Canadian Science Publishing's actual open-access policy for the final version has not been checked.",
 "commercial_use_status":"UNRESOLVED pending license check or direct author permission",
 "participant_count":"20 (13 men, 7 women)",
 "row_count":"0 individual rows - aggregate group-by-sex means only (2 sex groups x 4 exercises = 8 aggregate cells)",
 "participant_id_available":"No - Table 1/2 report group (by sex) means +/- SD only, not per-participant values",
 "age_available":"Individual range stated (66-80y); group means by sex (men 71.6+/-5.4y, women 69.3+/-3.3y) - not individual",
 "sex_available":"Yes - real mixed sex, 13 men / 7 women",
 "weight_available":"Group mean by sex only (men 63.7+/-7.7kg, women 51.3+/-4.1kg) - NOT individual, same gap as V1's own data",
 "exercise_available":"Yes - 4 bodyweight slow-tempo exercises (squat, knee push-up, crunch, heel-raise), NONE overlap with the existing 8-exercise trained ontology",
 "sets_available":"Fixed protocol (3 sets), not individually varying","reps_available":"Fixed protocol (10 reps/set, 3s concentric/3s eccentric), not individually varying","load_available":"N/A - bodyweight only, no external load",
 "duration_available":"Fixed protocol-level (4 min per exercise: 1min x3 sets + 30s rest x2), not per-row varying","intensity_available":"Yes - METs reported directly (2.0-3.8 METs range) instead of %1RM, since bodyweight exercise has no %1RM concept",
 "heart_rate_available":"Yes - reported by exercise x sex group","energy_expenditure_available":"Yes",
 "energy_expenditure_unit":"kcal/min (aggregate mean+/-SD by exercise x sex group)",
 "measurement_method":"Indirect calorimetry, face mask, breath-by-breath, REE measured over 30min rest then during/after exercise",
 "indirect_calorimetry":"Yes - named device confirmed: Minato Aeromonitor AE-300S (Minato Medical Science, Osaka, Japan), a real, validated calorimeter (cites its own validation studies)",
 "multi_exercise":"No - 4 exercises tested individually/separately, not as one combined multi-exercise session",
 "ground_truth_quality":"SILVER",
 "recommended_role":"HIGH VALUE for outreach - uniquely closes BOTH the women (gap A) AND older-adults (gap B) demographic gaps simultaneously, more directly than any other single candidate found in this whole search. Corresponding author's email is printed directly in the document (takashi.nakagata@gmail.com / tanakaga@juntendo.ac.jp) - a concrete, actionable contact, same as Rustaden/Joao. Even if raw individual data isn't obtainable, the aggregate EE-by-sex numbers for 4 new bodyweight exercises are a useful independent reference the way Vianna/Reis-2011-review were used in V1.",
 "reason":"Real named calorimetry device, documented methodology, genuine mixed-sex older-adult population - but data found is aggregate-by-sex only (not individual rows) and this specific copy is an author-archived pre-publication draft with unresolved license status, not the citable licensed publication.",
 "data_leakage_risk":"Same author network (Nakagata/Yamada/Naito) as two previously-logged candidates: jscr-36-1290 (Nakagata 2022, CC BY-NC-ND, excluded) and the Descente Sports Science bulletin (40_146.pdf, license unclear). Neither of those ever provided usable training data, so this is not a participant-overlap risk for training purposes - flagged for awareness only, consistent with how the Joao/Tavares/Bocalini network overlap was handled.",
}

with open("data/dataset_registry.csv", "r", newline="", encoding="utf-8") as f:
    reader = csv.DictReader(f)
    fieldnames = reader.fieldnames
    existing_rows = list(reader)

all_rows = existing_rows + [new_row]
with open("data/dataset_registry.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=fieldnames)
    w.writeheader()
    w.writerows(all_rows)

print(f"Registry now has {len(all_rows)} total rows (1 added)")
