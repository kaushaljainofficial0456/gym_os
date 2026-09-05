// ============================================================
// Candidate exercises for the library expansion (Checkpoint 2).
// This file is DATA ONLY — no DB writes. dedup.mjs consumes it to
// produce the duplicate/merge report; after sign-off the same list
// feeds seed.js + expand-exercise-library.mjs.
//
// Tuple-ish object per candidate:
//   key           stable animation_key slug (also the natural key for the migration)
//   name          canonical display name
//   primary       primary_muscle  (existing vocab + new: ADDUCTORS / ABDUCTORS / OBLIQUES)
//   secondary     "A, B, C" or "—"
//   equipment     existing vocab + new: TRX / RINGS / TRAP_BAR / SANDBAG / SLED / MEDICINE_BALL / PLYO_BOX / EZ_BAR
//   movement      horizontal_push|vertical_push|horizontal_pull|vertical_pull|squat|hinge|lunge|core|carry|isolation|mobility
//   difficulty    BEGINNER|INTERMEDIATE|ADVANCED
//   ci            'compound' | 'isolation'          (compound_or_isolation)  — optional, else derived
//   uni           true if unilateral                (is_unilateral)          — optional, default false
//   track         weight_reps|bodyweight_reps|weighted_bodyweight|time|distance_time — optional, else derived
//   reps          default_reps string               — optional, else derived
//   alts          [key,...]  curated alternatives    (exercise_relations 'alternative')
//   prog          [key,...]  harder variations       ('progression')
//   regr          [key,...]  easier variations       ('regression')
//   aliases       [str,...]  extra search aliases for THIS new exercise
//   hint          author's expected classification (the script decides independently)
// ============================================================

export const NEW_EQUIPMENT = ['TRX', 'RINGS', 'TRAP_BAR', 'SANDBAG', 'SLED', 'MEDICINE_BALL', 'PLYO_BOX', 'EZ_BAR'];
export const NEW_MUSCLES = [
  { id: 'adductors', name: 'ADDUCTORS', region: 'legs', view: 'front', min: 4, max: 8 },
  { id: 'abductors', name: 'ABDUCTORS', region: 'legs', view: 'back', min: 4, max: 8 },
  { id: 'obliques', name: 'OBLIQUES', region: 'core', view: 'front', min: 6, max: 12 },
];
// alias additions so normalizeMuscle() maps the new strings + the already-floating "OBLIQUES"
export const NEW_MUSCLE_ALIASES = { ADDUCTORS: 'adductors', ABDUCTOR: 'abductors', ABDUCTORS: 'abductors', 'INNER THIGH': 'adductors', 'OUTER THIGH': 'abductors', OBLIQUE: 'obliques', OBLIQUES: 'obliques' };

export const CANDIDATES = [
  // ---------- ADDUCTORS / ABDUCTORS (new muscle group — real gap) ----------
  { key: 'adductor_machine', name: 'Hip Adduction Machine', primary: 'ADDUCTORS', secondary: '—', equipment: 'MACHINE', movement: 'isolation', difficulty: 'BEGINNER', reps: '12-20', alts: ['cable_hip_adduction', 'copenhagen_plank'], hint: 'NEW' },
  { key: 'cable_hip_adduction', name: 'Cable Hip Adduction', primary: 'ADDUCTORS', secondary: '—', equipment: 'CABLE', movement: 'isolation', difficulty: 'BEGINNER', uni: true, reps: '12-20', alts: ['adductor_machine'], hint: 'NEW' },
  { key: 'copenhagen_plank', name: 'Copenhagen Plank', primary: 'ADDUCTORS', secondary: 'CORE, OBLIQUES', equipment: 'BODYWEIGHT', movement: 'core', difficulty: 'ADVANCED', track: 'time', reps: '20-40 sec', uni: true, regr: ['side_plank'], alts: ['adductor_machine'], hint: 'NEW' },
  { key: 'cossack_squat', name: 'Cossack Squat', primary: 'ADDUCTORS', secondary: 'QUADS, GLUTES', equipment: 'BODYWEIGHT', movement: 'lunge', difficulty: 'INTERMEDIATE', uni: true, track: 'bodyweight_reps', reps: '8-12', alts: ['lateral_lunge'], regr: ['lateral_lunge'], hint: 'NEW' },
  { key: 'abductor_machine', name: 'Hip Abduction Machine (Seated)', primary: 'ABDUCTORS', secondary: 'GLUTES', equipment: 'MACHINE', movement: 'isolation', difficulty: 'BEGINNER', reps: '12-20', hint: 'ALIAS→hip_abduction_machine' },
  { key: 'cable_hip_abduction', name: 'Cable Hip Abduction', primary: 'ABDUCTORS', secondary: 'GLUTES', equipment: 'CABLE', movement: 'isolation', difficulty: 'BEGINNER', uni: true, reps: '12-20', alts: ['hip_abduction_machine', 'band_walks'], hint: 'NEW' },

  // ---------- Machines (real gaps) ----------
  { key: 'pendulum_squat', name: 'Pendulum Squat', primary: 'QUADS', secondary: 'GLUTES', equipment: 'MACHINE', movement: 'squat', difficulty: 'INTERMEDIATE', ci: 'compound', reps: '8-12', alts: ['hack_squat', 'leg_press', 'smith_squat'], hint: 'NEW' },
  { key: 'reverse_hack_squat', name: 'Reverse Hack Squat', primary: 'GLUTES', secondary: 'QUADS, HAMSTRINGS', equipment: 'MACHINE', movement: 'squat', difficulty: 'INTERMEDIATE', ci: 'compound', reps: '8-12', alts: ['hack_squat', 'pendulum_squat'], hint: 'NEW' },
  { key: 'iso_lateral_chest_press', name: 'Iso-Lateral Chest Press', primary: 'CHEST', secondary: 'TRICEPS, FRONT DELTS', equipment: 'MACHINE', movement: 'horizontal_push', difficulty: 'BEGINNER', uni: true, ci: 'compound', reps: '8-12', alts: ['machine_chest_press', 'dumbbell_bench_press'], hint: 'NEW' },
  { key: 'iso_lateral_row', name: 'Iso-Lateral Row', primary: 'UPPER BACK', secondary: 'LATS, BICEPS', equipment: 'MACHINE', movement: 'horizontal_pull', difficulty: 'BEGINNER', uni: true, ci: 'compound', reps: '8-12', alts: ['chest_supported_row', 'seated_row', 'dumbbell_row'], hint: 'NEW' },
  { key: 'iso_lateral_pulldown', name: 'Iso-Lateral Pulldown', primary: 'LATS', secondary: 'BICEPS, UPPER BACK', equipment: 'MACHINE', movement: 'vertical_pull', difficulty: 'BEGINNER', uni: true, ci: 'compound', reps: '8-12', alts: ['lat_pulldown', 'single_arm_pulldown'], regr: ['assisted_pull_up'], hint: 'NEW' },
  { key: 'assisted_pull_up', name: 'Assisted Pull-Up (Machine)', primary: 'LATS', secondary: 'BICEPS, UPPER BACK', equipment: 'MACHINE', movement: 'vertical_pull', difficulty: 'BEGINNER', ci: 'compound', track: 'weight_reps', reps: '6-12', prog: ['pull_up', 'chin_up'], alts: ['lat_pulldown', 'band_lat_pulldown'], hint: 'NEW' },
  { key: 'assisted_dip', name: 'Assisted Dip (Machine)', primary: 'CHEST', secondary: 'TRICEPS, FRONT DELTS', equipment: 'MACHINE', movement: 'horizontal_push', difficulty: 'BEGINNER', ci: 'compound', track: 'weight_reps', reps: '6-12', prog: ['chest_dip', 'weighted_dip'], alts: ['machine_chest_press'], hint: 'NEW' },
  { key: 'converging_chest_press', name: 'Converging Chest Press Machine', primary: 'CHEST', secondary: 'TRICEPS, FRONT DELTS', equipment: 'MACHINE', movement: 'horizontal_push', difficulty: 'BEGINNER', hint: 'ALIAS→machine_chest_press' },
  { key: 'belt_squat', name: 'Belt Squat', primary: 'QUADS', secondary: 'GLUTES', equipment: 'MACHINE', movement: 'squat', difficulty: 'INTERMEDIATE', ci: 'compound', reps: '8-15', alts: ['hack_squat', 'leg_press', 'pendulum_squat'], hint: 'NEW' },
  { key: 'seal_row', name: 'Seal Row', primary: 'UPPER BACK', secondary: 'LATS, REAR DELTS', equipment: 'BARBELL', movement: 'horizontal_pull', difficulty: 'INTERMEDIATE', ci: 'compound', reps: '8-12', alts: ['chest_supported_row', 'pendlay_row'], hint: 'NEW' },
  { key: 'machine_crunch', name: 'Machine Crunch', primary: 'ABS', secondary: 'CORE', equipment: 'MACHINE', movement: 'core', difficulty: 'BEGINNER', reps: '12-20', alts: ['cable_crunch', 'reverse_crunch'], hint: 'NEW' },
  { key: 'glute_kickback_machine', name: 'Glute Kickback Machine', primary: 'GLUTES', secondary: 'HAMSTRINGS', equipment: 'MACHINE', movement: 'isolation', difficulty: 'BEGINNER', uni: true, reps: '10-15', alts: ['cable_kickback'], hint: 'NEW' },
  { key: 'hip_thrust_machine', name: 'Hip Thrust Machine', primary: 'GLUTES', secondary: 'HAMSTRINGS', equipment: 'MACHINE', movement: 'hinge', difficulty: 'BEGINNER', ci: 'compound', reps: '8-15', alts: ['hip_thrust', 'dumbbell_hip_thrust', 'smith_hip_thrust'], hint: 'NEW' },
  { key: 'seated_leg_press_horizontal', name: 'Seated Leg Press (Horizontal)', primary: 'QUADS', secondary: 'GLUTES, HAMSTRINGS', equipment: 'MACHINE', movement: 'squat', difficulty: 'BEGINNER', hint: 'ALIAS→leg_press' },

  // ---------- Smith machine variants ----------
  { key: 'smith_row', name: 'Smith Machine Row', primary: 'UPPER BACK', secondary: 'LATS, BICEPS', equipment: 'SMITH', movement: 'horizontal_pull', difficulty: 'BEGINNER', ci: 'compound', reps: '8-12', alts: ['barbell_row', 'pendlay_row'], hint: 'NEW' },
  { key: 'smith_hip_thrust', name: 'Smith Machine Hip Thrust', primary: 'GLUTES', secondary: 'HAMSTRINGS', equipment: 'SMITH', movement: 'hinge', difficulty: 'BEGINNER', ci: 'compound', reps: '8-15', alts: ['hip_thrust', 'dumbbell_hip_thrust'], hint: 'NEW' },
  { key: 'smith_calf_raise', name: 'Smith Machine Calf Raise', primary: 'CALVES', secondary: '—', equipment: 'SMITH', movement: 'isolation', difficulty: 'BEGINNER', reps: '10-20', hint: 'ALIAS→standing_calf_raise' },

  // ---------- Unilateral gaps ----------
  { key: 'single_arm_db_bench', name: 'Single-Arm Dumbbell Bench Press', primary: 'CHEST', secondary: 'TRICEPS, CORE', equipment: 'DUMBBELL', movement: 'horizontal_push', difficulty: 'INTERMEDIATE', uni: true, ci: 'compound', reps: '8-12', alts: ['dumbbell_bench_press'], hint: 'NEW' },
  { key: 'single_leg_press', name: 'Single-Leg Press', primary: 'QUADS', secondary: 'GLUTES, HAMSTRINGS', equipment: 'MACHINE', movement: 'squat', difficulty: 'BEGINNER', uni: true, ci: 'compound', reps: '10-15', alts: ['leg_press', 'bulgarian_split_squat'], hint: 'NEW' },
  { key: 'single_leg_extension', name: 'Single-Leg Extension', primary: 'QUADS', secondary: '—', equipment: 'MACHINE', movement: 'isolation', difficulty: 'BEGINNER', uni: true, reps: '10-15', alts: ['leg_extension'], hint: 'NEW' },
  { key: 'single_leg_curl', name: 'Single-Leg Curl', primary: 'HAMSTRINGS', secondary: '—', equipment: 'MACHINE', movement: 'isolation', difficulty: 'BEGINNER', uni: true, reps: '10-15', alts: ['seated_leg_curl', 'lying_leg_curl'], hint: 'NEW' },
  { key: 'b_stance_rdl', name: 'B-Stance Romanian Deadlift', primary: 'HAMSTRINGS', secondary: 'GLUTES', equipment: 'DUMBBELL', movement: 'hinge', difficulty: 'INTERMEDIATE', uni: true, ci: 'compound', reps: '8-12', alts: ['single_leg_rdl', 'romanian_deadlift'], regr: ['romanian_deadlift'], prog: ['single_leg_rdl'], aliases: ['staggered stance rdl', 'kickstand rdl', 'b stance romanian deadlift'], hint: 'NEW' },
  { key: 'single_arm_landmine_row', name: 'Single-Arm Landmine Row', primary: 'UPPER BACK', secondary: 'LATS, BICEPS', equipment: 'BARBELL', movement: 'horizontal_pull', difficulty: 'INTERMEDIATE', uni: true, ci: 'compound', reps: '8-12', alts: ['dumbbell_row', 'meadows_row'], aliases: ['landmine row', 'one arm landmine row'], hint: 'NEW' },
  { key: 'single_arm_db_ohp', name: 'Single-Arm Dumbbell Overhead Press', primary: 'SHOULDERS', secondary: 'TRICEPS, CORE', equipment: 'DUMBBELL', movement: 'vertical_push', difficulty: 'INTERMEDIATE', uni: true, ci: 'compound', reps: '8-12', alts: ['shoulder_press', 'db_shoulder_press'], hint: 'NEW' },
  { key: 'single_arm_cable_curl', name: 'Single-Arm Cable Curl', primary: 'BICEPS', secondary: 'FOREARMS', equipment: 'CABLE', movement: 'isolation', difficulty: 'BEGINNER', uni: true, reps: '10-15', alts: ['cable_curl', 'bayesian_curl'], hint: 'NEW' },
  { key: 'suitcase_deadlift', name: 'Suitcase Deadlift', primary: 'CORE', secondary: 'QUADS, GLUTES, FOREARMS', equipment: 'DUMBBELL', movement: 'hinge', difficulty: 'INTERMEDIATE', uni: true, ci: 'compound', reps: '6-10', alts: ['suitcase_carry', 'trap_bar_deadlift'], hint: 'NEW' },
  { key: 'single_leg_hip_thrust', name: 'Single-Leg Hip Thrust', primary: 'GLUTES', secondary: 'HAMSTRINGS', equipment: 'BODYWEIGHT', movement: 'hinge', difficulty: 'INTERMEDIATE', uni: true, track: 'bodyweight_reps', reps: '10-15', regr: ['single_leg_glute_bridge', 'glute_bridge'], prog: ['hip_thrust'], hint: 'NEW' },
  { key: 'single_arm_db_row', name: 'Single-Arm Dumbbell Row', primary: 'LATS', secondary: 'UPPER BACK, BICEPS', equipment: 'DUMBBELL', movement: 'horizontal_pull', difficulty: 'BEGINNER', hint: 'ALIAS→dumbbell_row' },
  { key: 'single_arm_triceps_pushdown', name: 'Single-Arm Triceps Pushdown', primary: 'TRICEPS', secondary: '—', equipment: 'CABLE', movement: 'isolation', difficulty: 'BEGINNER', hint: 'ALIAS→single_arm_pushdown' },
  { key: 'single_arm_lat_pulldown_machine', name: 'Single-Arm Lat Pulldown (Machine)', primary: 'LATS', secondary: 'BICEPS', equipment: 'MACHINE', movement: 'vertical_pull', difficulty: 'BEGINNER', hint: 'ALIAS→single_arm_pulldown' },

  // ---------- Dumbbell variants of barbell-only lifts ----------
  { key: 'db_z_press', name: 'Dumbbell Z Press', primary: 'SHOULDERS', secondary: 'TRICEPS, CORE', equipment: 'DUMBBELL', movement: 'vertical_push', difficulty: 'ADVANCED', ci: 'compound', reps: '6-10', alts: ['z_press', 'db_shoulder_press'], hint: 'NEW' },
  { key: 'db_floor_press', name: 'Dumbbell Floor Press', primary: 'CHEST', secondary: 'TRICEPS', equipment: 'DUMBBELL', movement: 'horizontal_push', difficulty: 'BEGINNER', ci: 'compound', reps: '8-12', alts: ['floor_press', 'dumbbell_bench_press'], hint: 'NEW' },
  { key: 'db_skull_crusher', name: 'Dumbbell Skull Crusher', primary: 'TRICEPS', secondary: '—', equipment: 'DUMBBELL', movement: 'isolation', difficulty: 'INTERMEDIATE', reps: '10-15', alts: ['skull_crusher', 'overhead_extension'], hint: 'NEW' },
  { key: 'db_preacher_curl', name: 'Dumbbell Preacher Curl', primary: 'BICEPS', secondary: 'FOREARMS', equipment: 'DUMBBELL', movement: 'isolation', difficulty: 'BEGINNER', uni: true, reps: '10-15', alts: ['preacher_curl', 'concentration_curl'], hint: 'NEW' },
  { key: 'incline_db_row', name: 'Incline Dumbbell Row', primary: 'UPPER BACK', secondary: 'LATS, BICEPS', equipment: 'DUMBBELL', movement: 'horizontal_pull', difficulty: 'BEGINNER', ci: 'compound', reps: '10-15', alts: ['chest_supported_row', 'dumbbell_row'], hint: 'NEW' },
  { key: 'zottman_curl', name: 'Zottman Curl', primary: 'BICEPS', secondary: 'FOREARMS', equipment: 'DUMBBELL', movement: 'isolation', difficulty: 'INTERMEDIATE', reps: '10-15', alts: ['hammer_curl', 'reverse_curl'], hint: 'NEW' },
  { key: 'pinwheel_curl', name: 'Pinwheel Curl', primary: 'BICEPS', secondary: 'FOREARMS', equipment: 'DUMBBELL', movement: 'isolation', difficulty: 'BEGINNER', hint: 'ALIAS→hammer_curl' },
  { key: 'db_front_squat_dup', name: 'Dumbbell Goblet Squat', primary: 'QUADS', secondary: 'GLUTES, CORE', equipment: 'DUMBBELL', movement: 'squat', difficulty: 'BEGINNER', hint: 'DUPLICATE→goblet_squat' },

  // ---------- Anti-rotation / anti-lateral-flexion / obliques (real gap) ----------
  { key: 'half_kneeling_pallof', name: 'Half-Kneeling Pallof Press', primary: 'OBLIQUES', secondary: 'CORE', equipment: 'CABLE', movement: 'core', difficulty: 'INTERMEDIATE', track: 'weight_reps', reps: '10-15', alts: ['pallof_press', 'band_pallof'], aliases: ['tall kneeling pallof press', 'kneeling pallof', 'pallof iso hold'], hint: 'NEW' },
  { key: 'landmine_rotation', name: 'Landmine Rotation', primary: 'OBLIQUES', secondary: 'CORE, SHOULDERS', equipment: 'BARBELL', movement: 'core', difficulty: 'INTERMEDIATE', track: 'weight_reps', reps: '8-12', alts: ['cable_woodchop', 'russian_twist'], aliases: ['landmine twist', 'landmine oblique twist'], hint: 'NEW' },
  { key: 'cable_woodchop', name: 'Cable Woodchopper', primary: 'OBLIQUES', secondary: 'CORE', equipment: 'CABLE', movement: 'core', difficulty: 'BEGINNER', track: 'weight_reps', reps: '10-15', alts: ['landmine_rotation', 'pallof_press'], aliases: ['cable chop', 'wood chopper', 'high to low chop', 'low to high chop', 'cable lift'], hint: 'NEW' },
  { key: 'bear_crawl', name: 'Bear Crawl', primary: 'CORE', secondary: 'SHOULDERS, QUADS', equipment: 'BODYWEIGHT', movement: 'carry', difficulty: 'BEGINNER', track: 'distance_time', reps: '20-40 m', alts: ['plank', 'dead_bug'], aliases: ['bear hold', 'bear plank'], hint: 'NEW' },
  { key: 'side_plank_rotation', name: 'Side Plank with Rotation', primary: 'OBLIQUES', secondary: 'CORE, SHOULDERS', equipment: 'BODYWEIGHT', movement: 'core', difficulty: 'INTERMEDIATE', track: 'bodyweight_reps', reps: '8-12', regr: ['side_plank'], hint: 'NEW' },
  { key: 'oblique_crunch', name: 'Oblique Crunch', primary: 'OBLIQUES', secondary: 'CORE', equipment: 'BODYWEIGHT', movement: 'core', difficulty: 'BEGINNER', track: 'bodyweight_reps', reps: '12-20', alts: ['bicycle_crunch', 'russian_twist'], hint: 'NEW' },
  { key: 'suitcase_hold', name: 'Suitcase Hold', primary: 'CORE', secondary: 'OBLIQUES, FOREARMS', equipment: 'DUMBBELL', movement: 'carry', difficulty: 'BEGINNER', hint: 'ALIAS→suitcase_carry' },

  // ---------- TRX ----------
  { key: 'trx_row', name: 'TRX Row', primary: 'UPPER BACK', secondary: 'LATS, BICEPS', equipment: 'TRX', movement: 'horizontal_pull', difficulty: 'BEGINNER', ci: 'compound', track: 'bodyweight_reps', reps: '8-15', alts: ['inverted_row', 'ring_row'], prog: ['pull_up'], aliases: ['suspension row', 'trx inverted row'], hint: 'NEW' },
  { key: 'trx_push_up', name: 'TRX Push-Up', primary: 'CHEST', secondary: 'TRICEPS, CORE', equipment: 'TRX', movement: 'horizontal_push', difficulty: 'INTERMEDIATE', ci: 'compound', track: 'bodyweight_reps', reps: '8-15', regr: ['push_up'], alts: ['ring_push_up'], hint: 'NEW' },
  { key: 'trx_fallout', name: 'TRX Fallout', primary: 'CORE', secondary: 'SHOULDERS, LATS', equipment: 'TRX', movement: 'core', difficulty: 'INTERMEDIATE', track: 'bodyweight_reps', reps: '8-12', alts: ['ab_wheel', 'plank'], regr: ['plank'], prog: ['ab_wheel'], aliases: ['trx body saw', 'suspension fallout'], hint: 'NEW' },
  { key: 'trx_hamstring_curl', name: 'TRX Hamstring Curl', primary: 'HAMSTRINGS', secondary: 'GLUTES, CORE', equipment: 'TRX', movement: 'hinge', difficulty: 'INTERMEDIATE', track: 'bodyweight_reps', reps: '10-15', alts: ['nordic_curl', 'lying_leg_curl'], aliases: ['suspension leg curl', 'trx leg curl'], hint: 'NEW' },
  { key: 'trx_pistol_squat', name: 'TRX Assisted Pistol Squat', primary: 'QUADS', secondary: 'GLUTES, CORE', equipment: 'TRX', movement: 'squat', difficulty: 'INTERMEDIATE', uni: true, track: 'bodyweight_reps', reps: '6-10', regr: ['split_squat'], prog: ['pistol_squat'], hint: 'NEW' },
  { key: 'trx_y_fly', name: 'TRX Y-Fly', primary: 'REAR DELTS', secondary: 'TRAPS, UPPER BACK', equipment: 'TRX', movement: 'horizontal_pull', difficulty: 'INTERMEDIATE', track: 'bodyweight_reps', reps: '10-15', alts: ['band_pull_apart', 'reverse_pec_deck'], hint: 'NEW' },

  // ---------- Gymnastic rings ----------
  { key: 'ring_row', name: 'Ring Row', primary: 'UPPER BACK', secondary: 'LATS, BICEPS', equipment: 'RINGS', movement: 'horizontal_pull', difficulty: 'BEGINNER', ci: 'compound', track: 'bodyweight_reps', reps: '8-15', alts: ['inverted_row', 'trx_row'], aliases: ['archer ring row', 'gymnastic ring row'], hint: 'NEW' },
  { key: 'ring_dip', name: 'Ring Dip', primary: 'CHEST', secondary: 'TRICEPS, FRONT DELTS', equipment: 'RINGS', movement: 'horizontal_push', difficulty: 'ADVANCED', ci: 'compound', track: 'bodyweight_reps', reps: '5-10', regr: ['chest_dip', 'bench_dip'], prog: ['ring_muscle_up'], hint: 'NEW' },
  { key: 'ring_push_up', name: 'Ring Push-Up', primary: 'CHEST', secondary: 'TRICEPS, CORE', equipment: 'RINGS', movement: 'horizontal_push', difficulty: 'INTERMEDIATE', ci: 'compound', track: 'bodyweight_reps', reps: '8-15', regr: ['push_up'], prog: ['ring_dip'], hint: 'NEW' },
  { key: 'ring_support_hold', name: 'Ring Support Hold', primary: 'SHOULDERS', secondary: 'TRICEPS, CORE', equipment: 'RINGS', movement: 'core', difficulty: 'INTERMEDIATE', track: 'time', reps: '15-30 sec', prog: ['ring_dip'], hint: 'NEW' },
  { key: 'ring_muscle_up', name: 'Ring Muscle-Up', primary: 'LATS', secondary: 'TRICEPS, CHEST, CORE', equipment: 'RINGS', movement: 'vertical_pull', difficulty: 'ADVANCED', ci: 'compound', track: 'bodyweight_reps', reps: '3-6', regr: ['pull_up', 'ring_dip'], hint: 'NEW' },

  // ---------- Sled ----------
  { key: 'sled_drag_forward', name: 'Forward Sled Drag', primary: 'QUADS', secondary: 'GLUTES, CALVES', equipment: 'SLED', movement: 'carry', difficulty: 'BEGINNER', ci: 'compound', track: 'distance_time', reps: '20-40 m', alts: ['sled_push'], hint: 'NEW' },
  { key: 'sled_backward_drag', name: 'Backward Sled Drag', primary: 'QUADS', secondary: 'GLUTES, CALVES', equipment: 'SLED', movement: 'carry', difficulty: 'BEGINNER', ci: 'compound', track: 'distance_time', reps: '20-40 m', alts: ['sled_push', 'leg_extension'], aliases: ['reverse sled drag', 'backward prowler drag'], hint: 'NEW' },
  { key: 'sled_row', name: 'Sled Row', primary: 'UPPER BACK', secondary: 'LATS, BICEPS', equipment: 'SLED', movement: 'horizontal_pull', difficulty: 'BEGINNER', hint: 'ALIAS→sled_pull' },

  // ---------- Sandbag ----------
  { key: 'sandbag_clean', name: 'Sandbag Clean', primary: 'FULL BODY', secondary: 'QUADS, GLUTES, TRAPS', equipment: 'SANDBAG', movement: 'hinge', difficulty: 'INTERMEDIATE', ci: 'compound', reps: '6-10', alts: ['power_clean', 'kettlebell_swing'], hint: 'NEW' },
  { key: 'sandbag_shouldering', name: 'Sandbag Shouldering', primary: 'FULL BODY', secondary: 'GLUTES, HAMSTRINGS, CORE', equipment: 'SANDBAG', movement: 'hinge', difficulty: 'INTERMEDIATE', ci: 'compound', reps: '5-10', alts: ['sandbag_clean', 'deadlift'], aliases: ['sandbag over shoulder', 'sandbag shoulder toss'], hint: 'NEW' },
  { key: 'sandbag_carry', name: 'Sandbag Bear-Hug Carry', primary: 'CORE', secondary: 'QUADS, GLUTES, TRAPS', equipment: 'SANDBAG', movement: 'carry', difficulty: 'BEGINNER', ci: 'compound', track: 'distance_time', reps: '20-40 m', alts: ['farmers_carry', 'suitcase_carry'], hint: 'NEW' },

  // ---------- Trap-bar ----------
  { key: 'trap_bar_deadlift', name: 'Trap-Bar Deadlift', primary: 'POSTERIOR CHAIN', secondary: 'QUADS, GLUTES, TRAPS', equipment: 'TRAP_BAR', movement: 'hinge', difficulty: 'INTERMEDIATE', ci: 'compound', reps: '5-8', alts: ['deadlift', 'sumo_deadlift'], regr: ['romanian_deadlift'], aliases: ['hex bar deadlift', 'trap bar deadlift'], hint: 'NEW' },
  { key: 'trap_bar_carry', name: 'Trap-Bar Carry', primary: 'CORE', secondary: 'FOREARMS, TRAPS, GLUTES', equipment: 'TRAP_BAR', movement: 'carry', difficulty: 'BEGINNER', ci: 'compound', track: 'distance_time', reps: '20-40 m', alts: ['farmers_carry', 'trap_bar_deadlift'], aliases: ['hex bar carry', 'farmer carry trap bar'], hint: 'NEW' },
  { key: 'trap_bar_jump', name: 'Trap-Bar Jump', primary: 'QUADS', secondary: 'GLUTES, CALVES', equipment: 'TRAP_BAR', movement: 'squat', difficulty: 'ADVANCED', ci: 'compound', reps: '3-6', alts: ['jump_squat', 'box_jump'], hint: 'NEW' },

  // ---------- Landmine ----------
  { key: 'landmine_squat_press', name: 'Landmine Squat-to-Press', primary: 'FULL BODY', secondary: 'QUADS, SHOULDERS, GLUTES', equipment: 'BARBELL', movement: 'squat', difficulty: 'INTERMEDIATE', ci: 'compound', reps: '8-12', alts: ['thruster', 'push_press'], aliases: ['landmine thruster'], hint: 'NEW' },
  { key: 'landmine_rdl', name: 'Landmine Romanian Deadlift', primary: 'HAMSTRINGS', secondary: 'GLUTES', equipment: 'BARBELL', movement: 'hinge', difficulty: 'INTERMEDIATE', ci: 'compound', reps: '8-12', alts: ['romanian_deadlift', 'single_leg_rdl'], hint: 'NEW' },

  // ---------- Medicine ball / plyo ----------
  { key: 'med_ball_rotational_throw', name: 'Medicine Ball Rotational Throw', primary: 'OBLIQUES', secondary: 'CORE, SHOULDERS', equipment: 'MEDICINE_BALL', movement: 'core', difficulty: 'INTERMEDIATE', track: 'weight_reps', reps: '6-10', alts: ['cable_woodchop', 'landmine_rotation'], aliases: ['med ball side throw', 'rotational wall throw'], hint: 'NEW' },
  { key: 'med_ball_chest_pass', name: 'Medicine Ball Chest Pass', primary: 'CHEST', secondary: 'TRICEPS, SHOULDERS', equipment: 'MEDICINE_BALL', movement: 'horizontal_push', difficulty: 'BEGINNER', track: 'weight_reps', reps: '6-10', alts: ['med_ball_slam', 'band_chest_press'], aliases: ['explosive chest pass', 'med ball push pass'], hint: 'NEW' },
  { key: 'broad_jump', name: 'Broad Jump', primary: 'QUADS', secondary: 'GLUTES, HAMSTRINGS', equipment: 'BODYWEIGHT', movement: 'squat', difficulty: 'INTERMEDIATE', track: 'bodyweight_reps', reps: '3-6', alts: ['jump_squat', 'box_jump'], aliases: ['standing long jump', 'horizontal jump'], hint: 'NEW' },
  { key: 'depth_jump', name: 'Depth Jump', primary: 'QUADS', secondary: 'GLUTES, CALVES', equipment: 'PLYO_BOX', movement: 'squat', difficulty: 'ADVANCED', track: 'bodyweight_reps', reps: '3-5', regr: ['box_jump'], alts: ['box_jump', 'jump_squat'], hint: 'NEW' },

  // ---------- Misc staples ----------
  { key: 'reverse_nordic', name: 'Reverse Nordic Curl', primary: 'QUADS', secondary: 'CORE', equipment: 'BODYWEIGHT', movement: 'isolation', difficulty: 'INTERMEDIATE', track: 'bodyweight_reps', reps: '6-12', alts: ['leg_extension', 'sissy_squat'], regr: ['sissy_squat'], aliases: ['reverse nordic', 'kneeling quad extension'], hint: 'NEW' },
  { key: 'jefferson_curl', name: 'Jefferson Curl', primary: 'LOWER BACK', secondary: 'HAMSTRINGS', equipment: 'DUMBBELL', movement: 'hinge', difficulty: 'INTERMEDIATE', reps: '6-10', alts: ['back_extension', 'good_morning'], hint: 'NEW' },
  { key: 'hip_airplane', name: 'Hip Airplane', primary: 'GLUTES', secondary: 'CORE, HAMSTRINGS', equipment: 'BODYWEIGHT', movement: 'hinge', difficulty: 'ADVANCED', uni: true, track: 'bodyweight_reps', reps: '5-10', alts: ['single_leg_rdl', 'bird_dog'], hint: 'NEW' },
  { key: 'kang_squat', name: 'Kang Squat', primary: 'HAMSTRINGS', secondary: 'GLUTES, QUADS', equipment: 'BARBELL', movement: 'hinge', difficulty: 'ADVANCED', ci: 'compound', reps: '6-10', alts: ['good_morning', 'romanian_deadlift'], hint: 'NEW' },
  { key: 'prone_trap_raise', name: 'Prone Trap-3 Raise', primary: 'TRAPS', secondary: 'REAR DELTS', equipment: 'DUMBBELL', movement: 'isolation', difficulty: 'BEGINNER', reps: '12-20', alts: ['cable_y_raise', 'rear_delt_fly'], aliases: ['prone y raise', 'lower trap raise', 'trap 3 raise'], hint: 'NEW' },
  { key: 'cable_y_raise', name: 'Cable Y-Raise', primary: 'TRAPS', secondary: 'REAR DELTS, SHOULDERS', equipment: 'CABLE', movement: 'isolation', difficulty: 'BEGINNER', reps: '12-20', alts: ['prone_trap_raise', 'face_pull'], hint: 'NEW' },
  { key: 'kroc_row', name: 'Kroc Row', primary: 'LATS', secondary: 'UPPER BACK, BICEPS, FOREARMS', equipment: 'DUMBBELL', movement: 'horizontal_pull', difficulty: 'ADVANCED', uni: true, ci: 'compound', reps: '15-25', alts: ['dumbbell_row', 'meadows_row'], aliases: ['heavy dumbbell row', 'high rep dumbbell row'], hint: 'NEW-borderline' },
  { key: 'wrist_extension', name: 'Wrist Extension', primary: 'FOREARMS', secondary: '—', equipment: 'DUMBBELL', movement: 'isolation', difficulty: 'BEGINNER', reps: '15-20', alts: ['wrist_curl', 'reverse_curl'], aliases: ['reverse wrist curl', 'wrist extensor curl'], hint: 'NEW' },
  { key: 'farmers_walk', name: "Farmer's Walk", primary: 'CORE', secondary: 'FOREARMS, TRAPS, GLUTES', equipment: 'DUMBBELL', movement: 'carry', difficulty: 'BEGINNER', hint: 'ALIAS→farmers_carry' },
  { key: 'jefferson_deadlift', name: 'Jefferson Deadlift', primary: 'GLUTES', secondary: 'QUADS, ADDUCTORS', equipment: 'BARBELL', movement: 'hinge', difficulty: 'ADVANCED', ci: 'compound', reps: '5-8', alts: ['deadlift', 'sumo_deadlift'], hint: 'NEW' },
  { key: 'hanging_knee_raise', name: 'Hanging Knee Raise', primary: 'ABS', secondary: 'CORE', equipment: 'BODYWEIGHT', movement: 'core', difficulty: 'BEGINNER', track: 'bodyweight_reps', reps: '10-20', prog: ['hanging_leg_raise', 'toes_to_bar'], hint: 'NEW' },
  { key: 'toes_to_bar', name: 'Toes-to-Bar', primary: 'ABS', secondary: 'CORE, LATS', equipment: 'PULL_UP_BAR', movement: 'core', difficulty: 'ADVANCED', track: 'bodyweight_reps', reps: '6-12', regr: ['hanging_leg_raise', 'hanging_knee_raise'], hint: 'NEW' },
  { key: 'deficit_push_up', name: 'Deficit Push-Up', primary: 'CHEST', secondary: 'TRICEPS, CORE', equipment: 'BODYWEIGHT', movement: 'horizontal_push', difficulty: 'INTERMEDIATE', track: 'bodyweight_reps', reps: '8-15', regr: ['push_up'], prog: ['archer_push_up', 'weighted_dip'], aliases: ['deep push up', 'push up on handles'], hint: 'NEW' },
  { key: 'archer_push_up', name: 'Archer Push-Up', primary: 'CHEST', secondary: 'TRICEPS, CORE', equipment: 'BODYWEIGHT', movement: 'horizontal_push', difficulty: 'ADVANCED', uni: true, track: 'bodyweight_reps', reps: '4-10', regr: ['push_up', 'deficit_push_up'], hint: 'NEW' },
  { key: 'cable_pullover', name: 'Cable Pullover', primary: 'LATS', secondary: 'CHEST, TRICEPS', equipment: 'CABLE', movement: 'vertical_pull', difficulty: 'BEGINNER', reps: '10-15', alts: ['db_pullover', 'straight_arm_pulldown'], hint: 'NEW' },
];
