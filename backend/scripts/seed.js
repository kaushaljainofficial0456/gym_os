// ============================================================
// DEMO SEED — IRONFORGE FITNESS
// Deterministic (seeded RNG) realistic data:
//   3 trainers, 25 clients with distinct situations
//   (progressing, plateau, missed workouts, excellent adherence,
//    poor nutrition, poor sleep, inactive), 8 weeks of workouts,
//   16 weeks of weight history, 7 days of meals/water/sleep,
//   subscriptions, payments, attendance, messages, AI insight.
// Run: npm run db:seed   (after npm run db:init)
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { id, now } from '../src/ids.js';
import { dayKey, daysAgo, addDays, weekDay } from '../src/utils/time.js';
import { snapshotAdherence, computeAdherence } from '../src/services/adherence.js';
import { seedMuscles, syncExerciseMuscles } from '../src/services/muscles.js';
import { evaluateOrg } from '../src/services/atRisk.js';
import { analyzeClientProgress } from '../src/services/aiCoach.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- deterministic RNG ----
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260810);
const jitter = (base, amt) => base + (rnd() - 0.5) * 2 * amt;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

// ---- exercise library ----
const EXERCISES = [
  ['bench_press', 'Bench Press', 'CHEST', 'CHEST, TRICEPS, FRONT DELTS', 'BARBELL', 'INTERMEDIATE'],
  ['incline_db_press', 'Incline Dumbbell Press', 'UPPER CHEST', 'FRONT DELTS, TRICEPS', 'DUMBBELL', 'INTERMEDIATE'],
  ['shoulder_press', 'Overhead Press', 'SHOULDERS', 'TRICEPS, UPPER CHEST', 'DUMBBELL', 'INTERMEDIATE'],
  ['lateral_raise', 'Lateral Raise', 'SIDE DELTS', 'TRAPS', 'DUMBBELL', 'BEGINNER'],
  ['triceps_pushdown', 'Triceps Pushdown', 'TRICEPS', '—', 'CABLE', 'BEGINNER'],
  ['lat_pulldown', 'Lat Pulldown', 'LATS', 'BICEPS, REAR DELTS', 'CABLE', 'BEGINNER'],
  ['seated_row', 'Seated Cable Row', 'UPPER BACK', 'LATS, BICEPS', 'CABLE', 'BEGINNER'],
  ['dumbbell_row', 'Dumbbell Row', 'LATS', 'UPPER BACK, BICEPS', 'DUMBBELL', 'BEGINNER'],
  ['bicep_curl', 'Bicep Curl', 'BICEPS', 'FOREARMS', 'DUMBBELL', 'BEGINNER'],
  ['squat', 'Back Squat', 'QUADS', 'GLUTES, CORE', 'BARBELL', 'INTERMEDIATE'],
  ['leg_press', 'Leg Press', 'QUADS', 'GLUTES, HAMSTRINGS', 'MACHINE', 'BEGINNER'],
  ['romanian_deadlift', 'Romanian Deadlift', 'HAMSTRINGS', 'GLUTES, LOWER BACK', 'BARBELL', 'INTERMEDIATE'],
  ['lunges', 'Walking Lunges', 'QUADS', 'GLUTES, CORE', 'DUMBBELL', 'BEGINNER'],
  ['deadlift', 'Deadlift', 'POSTERIOR CHAIN', 'LATS, CORE, TRAPS', 'BARBELL', 'ADVANCED'],
  ['hip_thrust', 'Hip Thrust', 'GLUTES', 'HAMSTRINGS', 'BARBELL', 'BEGINNER'],
  ['push_up', 'Push-up', 'CHEST', 'TRICEPS, CORE', 'BODYWEIGHT', 'BEGINNER'],
  ['plank', 'Plank', 'CORE', 'ABS, GLUTES', 'BODYWEIGHT', 'BEGINNER'],
  ['cable_crunch', 'Cable Crunch', 'ABS', 'CORE', 'CABLE', 'BEGINNER'],
  // --- expanded library (chest) ---
  ['dumbbell_bench_press', 'Dumbbell Bench Press', 'CHEST', 'TRICEPS, FRONT DELTS', 'DUMBBELL', 'BEGINNER'],
  ['dumbbell_fly', 'Dumbbell Fly', 'CHEST', 'FRONT DELTS', 'DUMBBELL', 'BEGINNER'],
  ['cable_fly', 'Cable Fly', 'CHEST', 'FRONT DELTS', 'CABLE', 'BEGINNER'],
  ['machine_chest_press', 'Machine Chest Press', 'CHEST', 'TRICEPS, FRONT DELTS', 'MACHINE', 'BEGINNER'],
  ['pec_deck', 'Pec Deck Fly', 'CHEST', 'FRONT DELTS', 'MACHINE', 'BEGINNER'],
  ['chest_dip', 'Chest Dip', 'CHEST', 'TRICEPS, FRONT DELTS', 'BODYWEIGHT', 'INTERMEDIATE'],
  // --- back ---
  ['barbell_row', 'Barbell Row', 'UPPER BACK', 'LATS, BICEPS, REAR DELTS', 'BARBELL', 'INTERMEDIATE'],
  ['t_bar_row', 'T-Bar Row', 'UPPER BACK', 'LATS, BICEPS', 'BARBELL', 'INTERMEDIATE'],
  ['pull_up', 'Pull-up', 'LATS', 'BICEPS, UPPER BACK', 'PULL_UP_BAR', 'INTERMEDIATE'],
  ['chin_up', 'Chin-up', 'LATS', 'BICEPS, UPPER BACK', 'PULL_UP_BAR', 'INTERMEDIATE'],
  ['straight_arm_pulldown', 'Straight-Arm Pulldown', 'LATS', 'TRICEPS, CORE', 'CABLE', 'BEGINNER'],
  ['band_pull_apart', 'Band Pull-Apart', 'REAR DELTS', 'TRAPS, ROTATOR CUFF', 'BANDS', 'BEGINNER'],
  ['band_row', 'Band Row', 'UPPER BACK', 'LATS, BICEPS', 'BANDS', 'BEGINNER'],
  // --- shoulders ---
  ['front_raise', 'Front Raise', 'FRONT DELTS', 'SIDE DELTS', 'DUMBBELL', 'BEGINNER'],
  ['rear_delt_fly', 'Rear Delt Fly', 'REAR DELTS', 'TRAPS', 'CABLE', 'BEGINNER'],
  ['face_pull', 'Face Pull', 'REAR DELTS', 'TRAPS, ROTATOR CUFF', 'CABLE', 'BEGINNER'],
  ['upright_row', 'Upright Row', 'SIDE DELTS', 'TRAPS', 'BARBELL', 'INTERMEDIATE'],
  ['machine_lateral_raise', 'Machine Lateral Raise', 'SIDE DELTS', 'TRAPS', 'MACHINE', 'BEGINNER'],
  ['dumbbell_snatch', 'Dumbbell Snatch', 'SHOULDERS', 'QUADS, CORE', 'DUMBBELL', 'ADVANCED'],
  // --- arms ---
  ['hammer_curl', 'Hammer Curl', 'BICEPS', 'FOREARMS, BRACHIALIS', 'DUMBBELL', 'BEGINNER'],
  ['preacher_curl', 'Preacher Curl', 'BICEPS', 'FOREARMS', 'BARBELL', 'INTERMEDIATE'],
  ['incline_curl', 'Incline Dumbbell Curl', 'BICEPS', 'FOREARMS', 'DUMBBELL', 'INTERMEDIATE'],
  ['skull_crusher', 'Skull Crusher', 'TRICEPS', '—', 'BARBELL', 'INTERMEDIATE'],
  ['overhead_extension', 'Overhead Triceps Extension', 'TRICEPS', '—', 'DUMBBELL', 'BEGINNER'],
  ['close_grip_bench', 'Close-Grip Bench Press', 'TRICEPS', 'CHEST, FRONT DELTS', 'BARBELL', 'INTERMEDIATE'],
  // --- legs ---
  ['front_squat', 'Front Squat', 'QUADS', 'CORE, GLUTES', 'BARBELL', 'ADVANCED'],
  ['smith_squat', 'Smith Machine Squat', 'QUADS', 'GLUTES, CORE', 'SMITH', 'BEGINNER'],
  ['leg_extension', 'Leg Extension', 'QUADS', '—', 'MACHINE', 'BEGINNER'],
  ['bulgarian_split_squat', 'Bulgarian Split Squat', 'QUADS', 'GLUTES, HAMSTRINGS', 'DUMBBELL', 'INTERMEDIATE'],
  ['step_up', 'Step-Up', 'QUADS', 'GLUTES', 'DUMBBELL', 'BEGINNER'],
  ['leg_curl', 'Leg Curl', 'HAMSTRINGS', '—', 'MACHINE', 'BEGINNER'],
  ['good_morning', 'Good Morning', 'HAMSTRINGS', 'LOWER BACK, GLUTES', 'BARBELL', 'ADVANCED'],
  ['glute_bridge', 'Glute Bridge', 'GLUTES', 'HAMSTRINGS, CORE', 'BODYWEIGHT', 'BEGINNER'],
  ['cable_kickback', 'Cable Glute Kickback', 'GLUTES', 'HAMSTRINGS', 'CABLE', 'BEGINNER'],
  ['kettlebell_swing', 'Kettlebell Swing', 'GLUTES', 'HAMSTRINGS, LOWER BACK, CORE', 'KETTLEBELL', 'INTERMEDIATE'],
  ['standing_calf_raise', 'Standing Calf Raise', 'CALVES', '—', 'MACHINE', 'BEGINNER'],
  ['seated_calf_raise', 'Seated Calf Raise', 'CALVES', '—', 'MACHINE', 'BEGINNER'],
  ['banded_squat', 'Banded Squat', 'QUADS', 'GLUTES, CORE', 'BANDS', 'BEGINNER'],
  // --- core / full body / cardio ---
  ['hanging_leg_raise', 'Hanging Leg Raise', 'ABS', 'CORE', 'BODYWEIGHT', 'INTERMEDIATE'],
  ['russian_twist', 'Russian Twist', 'ABS', 'OBLIQUES, CORE', 'BODYWEIGHT', 'BEGINNER'],
  ['ab_wheel', 'Ab Wheel Rollout', 'ABS', 'CORE, LATS', 'BODYWEIGHT', 'ADVANCED'],
  ['mountain_climbers', 'Mountain Climbers', 'CORE', 'QUADS, SHOULDERS', 'BODYWEIGHT', 'BEGINNER'],
  ['burpee', 'Burpee', 'FULL BODY', 'CORE, CHEST, QUADS', 'BODYWEIGHT', 'INTERMEDIATE'],
  ['farmers_carry', 'Farmer\'s Carry', 'CORE', 'FOREARMS, TRAPS, GLUTES', 'DUMBBELL', 'BEGINNER'],
  ['treadmill_run', 'Treadmill Run', 'CARDIO', 'CALVES, QUADS', 'TREADMILL', 'BEGINNER'],
  ['cycling', 'Stationary Cycling', 'CARDIO', 'QUADS, CALVES', 'BIKE', 'BEGINNER'],
  ['rowing_machine', 'Rowing Machine', 'CARDIO', 'UPPER BACK, LATS, QUADS', 'ROWING', 'BEGINNER'],
  // ================= PHASE: EXPANDED LIBRARY (200+) =================
  // --- chest ---
  ['incline_barbell_press', 'Incline Barbell Press', 'UPPER CHEST', 'FRONT DELTS, TRICEPS', 'BARBELL', 'INTERMEDIATE'],
  ['decline_barbell_press', 'Decline Barbell Press', 'LOWER CHEST', 'TRICEPS, FRONT DELTS', 'BARBELL', 'INTERMEDIATE'],
  ['decline_db_press', 'Decline Dumbbell Press', 'LOWER CHEST', 'TRICEPS, FRONT DELTS', 'DUMBBELL', 'INTERMEDIATE'],
  ['low_cable_fly', 'Low Cable Fly', 'UPPER CHEST', 'FRONT DELTS', 'CABLE', 'BEGINNER'],
  ['high_cable_fly', 'High Cable Fly', 'LOWER CHEST', 'FRONT DELTS', 'CABLE', 'BEGINNER'],
  ['machine_fly', 'Machine Fly', 'CHEST', 'FRONT DELTS', 'MACHINE', 'BEGINNER'],
  ['landmine_press', 'Landmine Press', 'CHEST', 'SHOULDERS, TRICEPS, CORE', 'BARBELL', 'INTERMEDIATE'],
  ['floor_press', 'Floor Press', 'CHEST', 'TRICEPS', 'BARBELL', 'INTERMEDIATE'],
  ['svend_press', 'Svend Press', 'CHEST', 'TRICEPS', 'DUMBBELL', 'BEGINNER'],
  ['db_pullover', 'Dumbbell Pullover', 'CHEST', 'LATS, TRICEPS', 'DUMBBELL', 'INTERMEDIATE'],
  ['weighted_dip', 'Weighted Dip', 'CHEST', 'TRICEPS, FRONT DELTS', 'BODYWEIGHT', 'ADVANCED'],
  ['incline_push_up', 'Incline Push-up', 'CHEST', 'TRICEPS, CORE', 'BODYWEIGHT', 'BEGINNER'],
  ['decline_push_up', 'Decline Push-up', 'UPPER CHEST', 'TRICEPS, CORE', 'BODYWEIGHT', 'INTERMEDIATE'],
  ['band_chest_press', 'Band Chest Press', 'CHEST', 'TRICEPS', 'BANDS', 'BEGINNER'],
  // --- back ---
  ['single_arm_cable_row', 'Single-Arm Cable Row', 'LATS', 'UPPER BACK, BICEPS', 'CABLE', 'BEGINNER'],
  ['chest_supported_row', 'Chest-Supported Row', 'UPPER BACK', 'LATS, BICEPS, REAR DELTS', 'MACHINE', 'BEGINNER'],
  ['inverted_row', 'Inverted Row', 'UPPER BACK', 'LATS, BICEPS', 'BODYWEIGHT', 'BEGINNER'],
  ['barbell_shrug', 'Barbell Shrug', 'TRAPS', 'FOREARMS', 'BARBELL', 'BEGINNER'],
  ['dumbbell_shrug', 'Dumbbell Shrug', 'TRAPS', 'FOREARMS', 'DUMBBELL', 'BEGINNER'],
  ['rack_pull', 'Rack Pull', 'UPPER BACK', 'TRAPS, GLUTES, HAMSTRINGS', 'BARBELL', 'INTERMEDIATE'],
  ['deficit_deadlift', 'Deficit Deadlift', 'POSTERIOR CHAIN', 'LATS, CORE, TRAPS', 'BARBELL', 'ADVANCED'],
  ['sumo_deadlift', 'Sumo Deadlift', 'GLUTES', 'QUADS, HAMSTRINGS, CORE', 'BARBELL', 'ADVANCED'],
  ['wide_grip_pulldown', 'Wide-Grip Lat Pulldown', 'LATS', 'REAR DELTS, BICEPS', 'CABLE', 'BEGINNER'],
  ['close_grip_pulldown', 'Close-Grip Pulldown', 'LATS', 'BICEPS', 'CABLE', 'BEGINNER'],
  ['single_arm_pulldown', 'Single-Arm Pulldown', 'LATS', 'BICEPS', 'CABLE', 'BEGINNER'],
  ['reverse_grip_pulldown', 'Reverse-Grip Pulldown', 'LATS', 'BICEPS', 'CABLE', 'INTERMEDIATE'],
  ['meadows_row', 'Meadows Row', 'LATS', 'UPPER BACK, BICEPS', 'BARBELL', 'ADVANCED'],
  ['pendlay_row', 'Pendlay Row', 'UPPER BACK', 'LATS, BICEPS, REAR DELTS', 'BARBELL', 'ADVANCED'],
  ['yates_row', 'Yates Row', 'LATS', 'UPPER BACK, BICEPS', 'BARBELL', 'INTERMEDIATE'],
  ['back_extension', 'Back Extension', 'LOWER BACK', 'GLUTES, HAMSTRINGS', 'BODYWEIGHT', 'BEGINNER'],
  ['reverse_hyper', 'Reverse Hyperextension', 'LOWER BACK', 'GLUTES, HAMSTRINGS', 'MACHINE', 'INTERMEDIATE'],
  ['band_lat_pulldown', 'Band Lat Pulldown', 'LATS', 'BICEPS', 'BANDS', 'BEGINNER'],
  // --- shoulders ---
  ['arnold_press', 'Arnold Press', 'SHOULDERS', 'TRICEPS, UPPER CHEST', 'DUMBBELL', 'INTERMEDIATE'],
  ['db_shoulder_press', 'Seated Dumbbell Shoulder Press', 'SHOULDERS', 'TRICEPS', 'DUMBBELL', 'BEGINNER'],
  ['machine_shoulder_press', 'Machine Shoulder Press', 'SHOULDERS', 'TRICEPS', 'MACHINE', 'BEGINNER'],
  ['smith_ohp', 'Smith Machine Overhead Press', 'SHOULDERS', 'TRICEPS', 'SMITH', 'INTERMEDIATE'],
  ['single_arm_lateral_raise', 'Single-Arm Lateral Raise', 'SIDE DELTS', 'TRAPS', 'DUMBBELL', 'BEGINNER'],
  ['cable_lateral_raise', 'Cable Lateral Raise', 'SIDE DELTS', 'TRAPS', 'CABLE', 'BEGINNER'],
  ['reverse_pec_deck', 'Reverse Pec Deck', 'REAR DELTS', 'TRAPS', 'MACHINE', 'BEGINNER'],
  ['db_rear_delt_row', 'Dumbbell Rear Delt Row', 'REAR DELTS', 'TRAPS, BICEPS', 'DUMBBELL', 'BEGINNER'],
  ['pike_push_up', 'Pike Push-up', 'SHOULDERS', 'TRICEPS, CHEST', 'BODYWEIGHT', 'INTERMEDIATE'],
  ['handstand_push_up', 'Handstand Push-up', 'SHOULDERS', 'TRICEPS', 'BODYWEIGHT', 'ADVANCED'],
  ['z_press', 'Z Press', 'SHOULDERS', 'CORE, TRICEPS', 'BARBELL', 'ADVANCED'],
  ['plate_raise', 'Plate Front Raise', 'FRONT DELTS', 'SIDE DELTS', 'BARBELL', 'BEGINNER'],
  ['band_lateral_raise', 'Band Lateral Raise', 'SIDE DELTS', 'TRAPS', 'BANDS', 'BEGINNER'],
  ['dumbbell_clean_press', 'Dumbbell Clean and Press', 'SHOULDERS', 'QUADS, GLUTES, TRICEPS', 'DUMBBELL', 'ADVANCED'],
  // --- biceps ---
  ['barbell_curl', 'Barbell Curl', 'BICEPS', 'FOREARMS', 'BARBELL', 'BEGINNER'],
  ['ez_bar_curl', 'EZ-Bar Curl', 'BICEPS', 'FOREARMS', 'BARBELL', 'BEGINNER'],
  ['cable_curl', 'Cable Curl', 'BICEPS', 'FOREARMS', 'CABLE', 'BEGINNER'],
  ['concentration_curl', 'Concentration Curl', 'BICEPS', 'FOREARMS', 'DUMBBELL', 'BEGINNER'],
  ['spider_curl', 'Spider Curl', 'BICEPS', 'FOREARMS', 'BARBELL', 'INTERMEDIATE'],
  ['drag_curl', 'Drag Curl', 'BICEPS', 'FOREARMS', 'BARBELL', 'INTERMEDIATE'],
  ['bayesian_curl', 'Bayesian Cable Curl', 'BICEPS', 'FOREARMS', 'CABLE', 'INTERMEDIATE'],
  ['reverse_curl', 'Reverse Curl', 'FOREARMS', 'BICEPS, BRACHIALIS', 'BARBELL', 'BEGINNER'],
  ['band_curl', 'Band Bicep Curl', 'BICEPS', 'FOREARMS', 'BANDS', 'BEGINNER'],
  // --- triceps ---
  ['cable_overhead_extension', 'Cable Overhead Extension', 'TRICEPS', '—', 'CABLE', 'BEGINNER'],
  ['db_kickback', 'Dumbbell Kickback', 'TRICEPS', '—', 'DUMBBELL', 'BEGINNER'],
  ['bench_dip', 'Bench Dip', 'TRICEPS', 'CHEST, FRONT DELTS', 'BODYWEIGHT', 'BEGINNER'],
  ['rope_pushdown', 'Rope Pushdown', 'TRICEPS', '—', 'CABLE', 'BEGINNER'],
  ['vbar_pushdown', 'V-Bar Pushdown', 'TRICEPS', '—', 'CABLE', 'BEGINNER'],
  ['single_arm_pushdown', 'Single-Arm Pushdown', 'TRICEPS', '—', 'CABLE', 'BEGINNER'],
  ['jm_press', 'JM Press', 'TRICEPS', 'CHEST', 'BARBELL', 'ADVANCED'],
  ['diamond_push_up', 'Diamond Push-up', 'TRICEPS', 'CHEST, CORE', 'BODYWEIGHT', 'INTERMEDIATE'],
  ['band_pushdown', 'Band Triceps Pushdown', 'TRICEPS', '—', 'BANDS', 'BEGINNER'],
  // --- forearms / grip ---
  ['plate_pinch', 'Plate Pinch', 'FOREARMS', '—', 'BARBELL', 'BEGINNER'],
  ['wrist_curl', 'Wrist Curl', 'FOREARMS', '—', 'BARBELL', 'BEGINNER'],
  ['dead_hang', 'Dead Hang', 'FOREARMS', 'LATS, TRAPS', 'PULL_UP_BAR', 'BEGINNER'],
  // --- quads ---
  ['hack_squat', 'Hack Squat', 'QUADS', 'GLUTES', 'MACHINE', 'INTERMEDIATE'],
  ['goblet_squat', 'Goblet Squat', 'QUADS', 'GLUTES, CORE', 'DUMBBELL', 'BEGINNER'],
  ['box_squat', 'Box Squat', 'QUADS', 'GLUTES, HAMSTRINGS', 'BARBELL', 'INTERMEDIATE'],
  ['sissy_squat', 'Sissy Squat', 'QUADS', 'CORE', 'BODYWEIGHT', 'INTERMEDIATE'],
  ['pistol_squat', 'Pistol Squat', 'QUADS', 'GLUTES, CORE', 'BODYWEIGHT', 'ADVANCED'],
  ['reverse_lunge', 'Reverse Lunge', 'QUADS', 'GLUTES, CORE', 'DUMBBELL', 'BEGINNER'],
  ['lateral_lunge', 'Lateral Lunge', 'QUADS', 'GLUTES, ADDUCTORS', 'DUMBBELL', 'BEGINNER'],
  ['split_squat', 'Split Squat', 'QUADS', 'GLUTES', 'BODYWEIGHT', 'BEGINNER'],
  ['squat_to_bench', 'Squat to Bench', 'QUADS', 'GLUTES, CORE', 'BODYWEIGHT', 'BEGINNER'],
  ['thruster', 'Dumbbell Thruster', 'QUADS', 'SHOULDERS, GLUTES, CORE', 'DUMBBELL', 'INTERMEDIATE'],
  ['wall_sit', 'Wall Sit', 'QUADS', 'CORE', 'BODYWEIGHT', 'BEGINNER'],
  ['narrow_stance_leg_press', 'Narrow-Stance Leg Press', 'QUADS', 'GLUTES', 'LEG_PRESS', 'BEGINNER'],
  // --- hamstrings ---
  ['nordic_curl', 'Nordic Curl', 'HAMSTRINGS', 'GLUTES, CORE', 'BODYWEIGHT', 'ADVANCED'],
  ['single_leg_rdl', 'Single-Leg Romanian Deadlift', 'HAMSTRINGS', 'GLUTES, CORE', 'DUMBBELL', 'INTERMEDIATE'],
  ['seated_leg_curl', 'Seated Leg Curl', 'HAMSTRINGS', '—', 'MACHINE', 'BEGINNER'],
  ['lying_leg_curl', 'Lying Leg Curl', 'HAMSTRINGS', '—', 'MACHINE', 'BEGINNER'],
  ['cable_pull_through', 'Cable Pull-Through', 'GLUTES', 'HAMSTRINGS', 'CABLE', 'INTERMEDIATE'],
  ['straight_leg_deadlift', 'Straight-Leg Deadlift', 'HAMSTRINGS', 'GLUTES, LOWER BACK', 'BARBELL', 'INTERMEDIATE'],
  ['glute_ham_raise', 'Glute-Ham Raise', 'HAMSTRINGS', 'GLUTES, LOWER BACK', 'MACHINE', 'ADVANCED'],
  // --- glutes ---
  ['banded_hip_thrust', 'Banded Hip Thrust', 'GLUTES', 'HAMSTRINGS, CORE', 'BANDS', 'BEGINNER'],
  ['single_leg_glute_bridge', 'Single-Leg Glute Bridge', 'GLUTES', 'HAMSTRINGS, CORE', 'BODYWEIGHT', 'BEGINNER'],
  ['frog_pump', 'Frog Pump', 'GLUTES', 'HAMSTRINGS', 'BODYWEIGHT', 'BEGINNER'],
  ['curtsy_lunge', 'Curtsy Lunge', 'GLUTES', 'QUADS, ADDUCTORS', 'DUMBBELL', 'BEGINNER'],
  ['hip_abduction_machine', 'Hip Abduction Machine', 'GLUTES', '—', 'MACHINE', 'BEGINNER'],
  ['band_walks', 'Lateral Band Walks', 'GLUTES', '—', 'BANDS', 'BEGINNER'],
  ['dumbbell_hip_thrust', 'Dumbbell Hip Thrust', 'GLUTES', 'HAMSTRINGS, CORE', 'DUMBBELL', 'BEGINNER'],
  // --- calves ---
  ['donkey_calf_raise', 'Donkey Calf Raise', 'CALVES', '—', 'MACHINE', 'BEGINNER'],
  ['calf_press_leg_press', 'Calf Press on Leg Press', 'CALVES', '—', 'LEG_PRESS', 'BEGINNER'],
  ['single_leg_calf_raise', 'Single-Leg Calf Raise', 'CALVES', '—', 'BODYWEIGHT', 'BEGINNER'],
  ['tibialis_raise', 'Tibialis Raise', 'CALVES', '—', 'BODYWEIGHT', 'BEGINNER'],
  // --- core / abs ---
  ['dead_bug', 'Dead Bug', 'CORE', 'ABS', 'BODYWEIGHT', 'BEGINNER'],
  ['bird_dog', 'Bird Dog', 'CORE', 'GLUTES, LOWER BACK', 'BODYWEIGHT', 'BEGINNER'],
  ['side_plank', 'Side Plank', 'CORE', 'OBLIQUES, GLUTES', 'BODYWEIGHT', 'BEGINNER'],
  ['hollow_body_hold', 'Hollow Body Hold', 'CORE', 'ABS, HIP FLEXORS', 'BODYWEIGHT', 'INTERMEDIATE'],
  ['reverse_crunch', 'Reverse Crunch', 'ABS', 'CORE', 'BODYWEIGHT', 'BEGINNER'],
  ['bicycle_crunch', 'Bicycle Crunch', 'ABS', 'OBLIQUES, CORE', 'BODYWEIGHT', 'BEGINNER'],
  ['v_up', 'V-Up', 'ABS', 'CORE, HIP FLEXORS', 'BODYWEIGHT', 'INTERMEDIATE'],
  ['windshield_wiper', 'Windshield Wiper', 'ABS', 'OBLIQUES, CORE', 'BODYWEIGHT', 'ADVANCED'],
  ['med_ball_slam', 'Medicine Ball Slam', 'CORE', 'LATS, SHOULDERS', 'BODYWEIGHT', 'BEGINNER'],
  ['pallof_press', 'Pallof Press', 'CORE', 'OBLIQUES', 'CABLE', 'INTERMEDIATE'],
  ['suitcase_carry', 'Suitcase Carry', 'CORE', 'OBLIQUES, FOREARMS, TRAPS', 'DUMBBELL', 'BEGINNER'],
  ['waiter_carry', 'Waiter Carry', 'CORE', 'SHOULDERS, FOREARMS', 'DUMBBELL', 'INTERMEDIATE'],
  ['dragon_flag', 'Dragon Flag', 'CORE', 'ABS, HIP FLEXORS', 'BODYWEIGHT', 'ADVANCED'],
  ['band_pallof', 'Band Pallof Press', 'CORE', 'OBLIQUES', 'BANDS', 'INTERMEDIATE'],
  // --- full body / conditioning ---
  ['power_clean', 'Power Clean', 'FULL BODY', 'QUADS, GLUTES, TRAPS, CORE', 'BARBELL', 'ADVANCED'],
  ['snatch', 'Barbell Snatch', 'FULL BODY', 'QUADS, GLUTES, SHOULDERS, CORE', 'BARBELL', 'ADVANCED'],
  ['clean_jerk', 'Clean and Jerk', 'FULL BODY', 'QUADS, GLUTES, SHOULDERS, CORE', 'BARBELL', 'ADVANCED'],
  ['devil_press', 'Devil Press', 'FULL BODY', 'SHOULDERS, CORE, QUADS', 'DUMBBELL', 'ADVANCED'],
  ['turkish_getup', 'Turkish Get-Up', 'FULL BODY', 'CORE, SHOULDERS, GLUTES', 'KETTLEBELL', 'ADVANCED'],
  ['battle_ropes', 'Battle Ropes', 'CARDIO', 'SHOULDERS, ARMS, CORE', 'BODYWEIGHT', 'INTERMEDIATE'],
  ['sled_push', 'Sled Push', 'FULL BODY', 'QUADS, GLUTES, CALVES', 'BODYWEIGHT', 'INTERMEDIATE'],
  ['sled_pull', 'Sled Pull', 'FULL BODY', 'LATS, TRAPS, CORE', 'BODYWEIGHT', 'INTERMEDIATE'],
  ['rope_climb', 'Rope Climb', 'LATS', 'FOREARMS, BICEPS, CORE', 'BODYWEIGHT', 'ADVANCED'],
  ['muscle_up', 'Muscle-Up', 'LATS', 'TRICEPS, CHEST, CORE', 'PULL_UP_BAR', 'ADVANCED'],
  ['box_jump', 'Box Jump', 'QUADS', 'GLUTES, CALVES', 'BODYWEIGHT', 'INTERMEDIATE'],
  ['jump_squat', 'Jump Squat', 'QUADS', 'GLUTES, CALVES', 'BODYWEIGHT', 'INTERMEDIATE'],
  ['lateral_box_step', 'Lateral Box Step-Up', 'QUADS', 'GLUTES, CORE', 'BODYWEIGHT', 'BEGINNER'],
  ['push_press', 'Push Press', 'SHOULDERS', 'QUADS, TRICEPS, CORE', 'BARBELL', 'INTERMEDIATE'],
  ['db_swing', 'Dumbbell Swing', 'GLUTES', 'HAMSTRINGS, LOWER BACK, CORE', 'DUMBBELL', 'INTERMEDIATE'],
  // --- cardio ---
  ['stair_climber', 'Stair Climber', 'CARDIO', 'QUADS, GLUTES, CALVES', 'MACHINE', 'BEGINNER'],
  ['elliptical', 'Elliptical', 'CARDIO', 'QUADS, GLUTES, CORE', 'MACHINE', 'BEGINNER'],
  ['assault_bike', 'Assault Bike', 'CARDIO', 'QUADS, CORE', 'BIKE', 'INTERMEDIATE'],
  ['ski_erg', 'Ski Erg', 'CARDIO', 'LATS, SHOULDERS, CORE', 'MACHINE', 'INTERMEDIATE'],
  ['jump_rope', 'Jump Rope', 'CARDIO', 'CALVES, CORE, FOREARMS', 'BODYWEIGHT', 'BEGINNER'],
  ['incline_walk', 'Incline Treadmill Walk', 'CARDIO', 'GLUTES, CALVES', 'TREADMILL', 'BEGINNER'],
  ['sprint_intervals', 'Sprint Intervals', 'CARDIO', 'QUADS, GLUTES, CALVES', 'TREADMILL', 'ADVANCED'],
  // --- mobility ---
  ['worlds_greatest_stretch', 'World Greatest Stretch', 'MOBILITY', 'HIPS, HAMSTRINGS, SPINE', 'BODYWEIGHT', 'BEGINNER'],
  ['couch_stretch', 'Couch Stretch', 'MOBILITY', 'HIP FLEXORS, QUADS', 'BODYWEIGHT', 'BEGINNER'],
  ['thoracic_rotation', 'Thoracic Rotation', 'MOBILITY', 'SPINE, SHOULDERS', 'BODYWEIGHT', 'BEGINNER'],
  ['cat_cow', 'Cat-Cow', 'MOBILITY', 'SPINE, CORE', 'BODYWEIGHT', 'BEGINNER'],
  ['deep_squat_hold', 'Deep Squat Hold', 'MOBILITY', 'QUADS, HIPS, CALVES', 'BODYWEIGHT', 'BEGINNER'],
  ['shoulder_dislocate', 'Band Shoulder Dislocate', 'MOBILITY', 'SHOULDERS, CHEST', 'BANDS', 'BEGINNER'],
  ['wall_slide', 'Wall Slide', 'MOBILITY', 'SHOULDERS, UPPER BACK', 'BODYWEIGHT', 'BEGINNER'],
  ['ankle_rocker', 'Ankle Rocker', 'MOBILITY', 'CALVES, ANKLES', 'BODYWEIGHT', 'BEGINNER'],
  ['pigeon_pose', 'Pigeon Pose', 'MOBILITY', 'GLUTES, HIPS', 'BODYWEIGHT', 'BEGINNER']
];

// base numeric weight per exercise for progressive logging
const BASE_W = {
  bench_press: 60, incline_db_press: 22.5, shoulder_press: 20, lateral_raise: 8,
  triceps_pushdown: 25, lat_pulldown: 60, seated_row: 50, dumbbell_row: 24,
  bicep_curl: 12, squat: 80, leg_press: 120, romanian_deadlift: 60, lunges: 10,
  deadlift: 80, hip_thrust: 60, push_up: 0, plank: 0, cable_crunch: 0,
  dumbbell_bench_press: 20, dumbbell_fly: 12, cable_fly: 15, machine_chest_press: 40, pec_deck: 40, chest_dip: 0,
  barbell_row: 50, t_bar_row: 40, pull_up: 0, chin_up: 0, straight_arm_pulldown: 30, band_pull_apart: 0, band_row: 0,
  front_raise: 8, rear_delt_fly: 10, face_pull: 25, upright_row: 25, machine_lateral_raise: 25, dumbbell_snatch: 12,
  hammer_curl: 12, preacher_curl: 30, incline_curl: 10, skull_crusher: 25, overhead_extension: 10, close_grip_bench: 50,
  front_squat: 60, smith_squat: 60, leg_extension: 40, bulgarian_split_squat: 15, step_up: 12, leg_curl: 40,
  good_morning: 40, glute_bridge: 0, cable_kickback: 15, kettlebell_swing: 16, standing_calf_raise: 60, seated_calf_raise: 40, banded_squat: 0,
  hanging_leg_raise: 0, russian_twist: 0, ab_wheel: 0, mountain_climbers: 0, burpee: 0, farmers_carry: 20,
  treadmill_run: 0, cycling: 0, rowing_machine: 0,
  incline_barbell_press: 50, decline_barbell_press: 55, decline_db_press: 20, low_cable_fly: 12,
  high_cable_fly: 12, machine_fly: 40, landmine_press: 30, floor_press: 50, svend_press: 10,
  db_pullover: 18, weighted_dip: 0, incline_push_up: 0, decline_push_up: 0, band_chest_press: 0,
  single_arm_cable_row: 25, chest_supported_row: 45, inverted_row: 0, barbell_shrug: 60,
  dumbbell_shrug: 25, rack_pull: 70, deficit_deadlift: 70, sumo_deadlift: 70, wide_grip_pulldown: 55,
  close_grip_pulldown: 55, single_arm_pulldown: 30, reverse_grip_pulldown: 55, meadows_row: 30,
  pendlay_row: 50, yates_row: 50, back_extension: 0, reverse_hyper: 0, band_lat_pulldown: 0,
  arnold_press: 15, db_shoulder_press: 18, machine_shoulder_press: 40, smith_ohp: 35,
  single_arm_lateral_raise: 6, cable_lateral_raise: 8, reverse_pec_deck: 40, db_rear_delt_row: 8,
  pike_push_up: 0, handstand_push_up: 0, z_press: 25, plate_raise: 10, band_lateral_raise: 0,
  dumbbell_clean_press: 14,
  barbell_curl: 25, ez_bar_curl: 25, cable_curl: 20, concentration_curl: 10, spider_curl: 20,
  drag_curl: 25, bayesian_curl: 15, reverse_curl: 20, band_curl: 0,
  cable_overhead_extension: 20, db_kickback: 8, bench_dip: 0, rope_pushdown: 25, vbar_pushdown: 30,
  single_arm_pushdown: 15, jm_press: 40, diamond_push_up: 0, band_pushdown: 0,
  plate_pinch: 10, wrist_curl: 15, dead_hang: 0,
  hack_squat: 80, goblet_squat: 20, box_squat: 50, sissy_squat: 0, pistol_squat: 0,
  reverse_lunge: 15, lateral_lunge: 12, split_squat: 0, squat_to_bench: 0, thruster: 15,
  wall_sit: 0, narrow_stance_leg_press: 100,
  nordic_curl: 0, single_leg_rdl: 12, seated_leg_curl: 40, lying_leg_curl: 40,
  cable_pull_through: 25, straight_leg_deadlift: 55, glute_ham_raise: 0,
  banded_hip_thrust: 0, single_leg_glute_bridge: 0, frog_pump: 0, curtsy_lunge: 12,
  hip_abduction_machine: 50, band_walks: 0, dumbbell_hip_thrust: 25,
  donkey_calf_raise: 60, calf_press_leg_press: 80, single_leg_calf_raise: 0, tibialis_raise: 0,
  dead_bug: 0, bird_dog: 0, side_plank: 0, hollow_body_hold: 0, reverse_crunch: 0,
  bicycle_crunch: 0, v_up: 0, windshield_wiper: 0, med_ball_slam: 8, pallof_press: 20,
  suitcase_carry: 20, waiter_carry: 15, dragon_flag: 0, band_pallof: 0,
  power_clean: 50, snatch: 40, clean_jerk: 50, devil_press: 15, turkish_getup: 16,
  battle_ropes: 0, sled_push: 60, sled_pull: 40, rope_climb: 0, muscle_up: 0, box_jump: 0,
  jump_squat: 0, lateral_box_step: 0, push_press: 40, db_swing: 15,
  stair_climber: 0, elliptical: 0, assault_bike: 0, ski_erg: 0, jump_rope: 0,
  incline_walk: 0, sprint_intervals: 0,
  worlds_greatest_stretch: 0, couch_stretch: 0, thoracic_rotation: 0, cat_cow: 0,
  deep_squat_hold: 0, shoulder_dislocate: 0, wall_slide: 0, ankle_rocker: 0, pigeon_pose: 0
};

const TEMPLATES = {
  'Push A': [
    ['bench_press', 4, '8', '60 kg', 120], ['incline_db_press', 3, '10', '22.5 kg', 90],
    ['shoulder_press', 4, '10', '20 kg', 90], ['lateral_raise', 3, '15', '8 kg', 60],
    ['triceps_pushdown', 3, '12', '25 kg', 60]
  ],
  'Pull A': [
    ['lat_pulldown', 4, '10', '60 kg', 90], ['seated_row', 3, '12', '50 kg', 90],
    ['dumbbell_row', 3, '10', '24 kg', 90], ['bicep_curl', 3, '12', '12 kg', 60]
  ],
  'Back A': [
    ['lat_pulldown', 4, '10', '60 kg', 90], ['barbell_row', 4, '8', '50 kg', 120],
    ['seated_row', 3, '12', '50 kg', 90], ['face_pull', 3, '15', '25 kg', 60],
    ['dead_hang', 3, '30 sec', 'BW', 60]
  ],
  'Legs A': [
    ['squat', 4, '8', '80 kg', 120], ['leg_press', 3, '12', '120 kg', 120],
    ['romanian_deadlift', 3, '10', '60 kg', 90], ['lunges', 3, '12', '10 kg', 90],
    ['plank', 3, '45 sec', 'BW', 60]
  ],
  'Full Body': [
    ['deadlift', 3, '5', '80 kg', 150], ['push_up', 3, '15', 'BW', 60],
    ['lat_pulldown', 3, '12', '55 kg', 90], ['hip_thrust', 3, '12', '60 kg', 90],
    ['cable_crunch', 3, '15', '30 kg', 60]
  ],
  'Core A': [
    ['plank', 3, '45 sec', 'BW', 45], ['cable_crunch', 3, '15', '30 kg', 60],
    ['hanging_leg_raise', 3, '12', 'BW', 60], ['russian_twist', 3, '20', 'BW', 45],
    ['dead_bug', 3, '10', 'BW', 45]
  ],
  'Legs B': [
    ['front_squat', 3, '8', '60 kg', 120], ['leg_press', 4, '12', '120 kg', 90],
    ['leg_curl', 3, '12', '40 kg', 60], ['standing_calf_raise', 3, '15', '60 kg', 45]
  ]
};

// ---- clients: name, age, sex, goal, startW, targetW, height, pattern ----
const PATTERNS = {
  normal:       { weightTrend: 'down', workoutRate: 0.92, mealRate: 0.88, proteinScale: 0.98, waterRate: 0.85, sleepRate: 0.95, checkin: true, loss: 7 },
  excellent:    { weightTrend: 'down', workoutRate: 1.0, mealRate: 0.98, proteinScale: 1.05, waterRate: 0.95, sleepRate: 1.04, checkin: true, loss: 9 },
  plateau:      { weightTrend: 'flat', workoutRate: 0.9, mealRate: 0.78, proteinScale: 0.92, waterRate: 0.8, sleepRate: 0.95, checkin: true, loss: 6.6 },
  missed:       { weightTrend: 'down', workoutRate: 0.4, mealRate: 0.8, proteinScale: 0.9, waterRate: 0.75, sleepRate: 0.9, checkin: false, loss: 5 },
  low_protein:  { weightTrend: 'down', workoutRate: 0.9, mealRate: 0.9, proteinScale: 0.55, waterRate: 0.8, sleepRate: 0.9, checkin: true, loss: 6 },
  poor_sleep:   { weightTrend: 'down', workoutRate: 0.88, mealRate: 0.82, proteinScale: 0.9, waterRate: 0.8, sleepRate: 0.72, checkin: true, loss: 5 },
  inactive:     { weightTrend: 'stale', workoutRate: 0.1, mealRate: 0.3, proteinScale: 0.7, waterRate: 0.5, sleepRate: 0.85, checkin: false, loss: 3 }
};

const CLIENTS = [
  // [name, age, sex, goal, start, target, height, pattern]
  ['Rahul Sharma', 27, 'M', 'FAT_LOSS', 94, 82, 175, 'plateau'],
  ['Priya Nair', 29, 'F', 'FAT_LOSS', 78, 66, 162, 'low_protein'],
  ['Aman Verma', 32, 'M', 'FAT_LOSS', 102, 88, 178, 'missed'],
  ['Neha Gupta', 24, 'F', 'RECOMP', 64, 58, 158, 'excellent'],
  ['Vikram Singh', 35, 'M', 'MUSCLE_GAIN', 72, 80, 172, 'excellent'],
  ['Sneha Reddy', 26, 'F', 'FAT_LOSS', 70, 60, 160, 'normal'],
  ['Arjun Nair', 30, 'M', 'STRENGTH', 84, 88, 176, 'normal'],
  ['Kavya Menon', 28, 'F', 'FAT_LOSS', 82, 70, 165, 'poor_sleep'],
  ['Rohan Joshi', 33, 'M', 'FAT_LOSS', 108, 90, 180, 'normal'],
  ['Isha Patel', 22, 'F', 'GENERAL', 58, 55, 155, 'excellent'],
  ['Karan Malhotra', 31, 'M', 'MUSCLE_GAIN', 68, 76, 170, 'normal'],
  ['Divya Sharma', 27, 'F', 'FAT_LOSS', 75, 63, 163, 'normal'],
  ['Suresh Iyer', 40, 'M', 'FAT_LOSS', 95, 82, 174, 'missed'],
  ['Ananya Das', 23, 'F', 'RECOMP', 62, 56, 157, 'normal'],
  ['Ravi Kumar', 29, 'M', 'MUSCLE_GAIN', 70, 78, 171, 'excellent'],
  ['Pooja Bansal', 30, 'F', 'FAT_LOSS', 88, 74, 166, 'plateau'],
  ['Manish Chauhan', 34, 'M', 'FAT_LOSS', 110, 92, 182, 'normal'],
  ['Shreya Kulkarni', 25, 'F', 'FAT_LOSS', 69, 59, 159, 'normal'],
  ['Deepak Yadav', 28, 'M', 'STRENGTH', 80, 85, 173, 'excellent'],
  ['Ritika Jain', 26, 'F', 'FAT_LOSS', 73, 62, 161, 'poor_sleep'],
  ['Nikhil Bose', 31, 'M', 'FAT_LOSS', 99, 85, 177, 'normal'],
  ['Tanvi Shah', 24, 'F', 'GENERAL', 56, 53, 154, 'excellent'],
  ['Akash Gill', 36, 'M', 'FAT_LOSS', 105, 90, 179, 'missed'],
  ['Meera Pillai', 29, 'F', 'FAT_LOSS', 79, 68, 164, 'normal'],
  ['Gaurav Tiwari', 27, 'M', 'FAT_LOSS', 97, 83, 176, 'inactive']
];

const TRAINERS = [
  ['trainer1@ironforge.in', 'Arjun Mehta', 'STRENGTH & HYPERTROPHY'],
  ['trainer2@ironforge.in', 'Kavya Iyer', 'FAT LOSS & NUTRITION'],
  ['trainer3@ironforge.in', 'Rohan Kapoor', 'SPORTS & CONDITIONING']
];

const PACKAGES = [
  ['Monthly', 1999, 30], ['Quarterly', 4999, 90], ['Transformation', 9999, 90]
];

const NUTRITION_TEMPLATES = [
  {
    name: 'Fat Loss · 2,550 kcal', calories: 2550, protein: 200, carbs: 235, fat: 90,
    meals: [
      ['breakfast', 'Masala Egg Omelette', '08:00', 590, 39, 58, 26, '2 whole + 3 whites · 2 multigrain roti · 200 ml milk'],
      ['lunch', 'Chicken Rice Bowl', '13:00', 600, 57, 63, 15, '150 g grilled chicken · 180 g brown rice · curd & salad'],
      ['post_workout', 'Whey + Banana', '19:15', 235, 26, 31, 2, '1 scoop whey · 1 banana'],
      ['dinner', 'Grilled Chicken & Sweet Potato', '20:45', 625, 67, 60, 13, '200 g chicken · 250 g sweet potato · sautéed veg'],
      ['before_bed', 'Paneer & Almonds', '23:00', 370, 26, 16, 25, '100 g paneer · 10 almonds · warm milk']
    ]
  },
  {
    name: 'Muscle Gain · 3,000 kcal', calories: 3000, protein: 197, carbs: 306, fat: 102,
    meals: [
      ['breakfast', 'Egg & Oats Bowl', '08:00', 620, 42, 62, 20, '3 eggs · 60 g oats · banana'],
      ['mid_morning', 'Peanut Butter Toast + Banana', '11:00', 380, 12, 48, 16, '2 multigrain toast · 1 tbsp peanut butter'],
      ['lunch', 'Chicken Biryani + Curd', '13:00', 640, 48, 78, 14, '150 g chicken · 1.5 cups rice · 100 g curd'],
      ['pre_workout', 'Rice Cakes + Whey', '17:00', 300, 25, 38, 4, '4 rice cakes · 1 scoop whey'],
      ['dinner', 'Paneer Bhurji + Roti', '20:30', 660, 40, 62, 26, '150 g paneer · 3 roti · onion-tomato'],
      ['before_bed', 'Casein + Almonds', '22:45', 400, 30, 18, 22, '1 scoop casein · 10 almonds']
    ]
  }
];

// movement pattern per exercise (drives weekly movement-pattern balance)
const MOVEMENT_BY_KEY = {
  bench_press: 'horizontal_push', incline_db_press: 'horizontal_push', shoulder_press: 'vertical_push',
  lateral_raise: 'isolation', triceps_pushdown: 'isolation', lat_pulldown: 'vertical_pull',
  seated_row: 'horizontal_pull', dumbbell_row: 'horizontal_pull', bicep_curl: 'isolation',
  squat: 'squat', leg_press: 'squat', romanian_deadlift: 'hinge', lunges: 'lunge',
  deadlift: 'hinge', hip_thrust: 'hinge', push_up: 'horizontal_push', plank: 'core', cable_crunch: 'core',
  dumbbell_bench_press: 'horizontal_push', dumbbell_fly: 'isolation', cable_fly: 'isolation',
  machine_chest_press: 'horizontal_push', pec_deck: 'isolation', chest_dip: 'horizontal_push',
  barbell_row: 'horizontal_pull', t_bar_row: 'horizontal_pull', pull_up: 'vertical_pull', chin_up: 'vertical_pull',
  straight_arm_pulldown: 'vertical_pull', band_pull_apart: 'horizontal_pull', band_row: 'horizontal_pull',
  front_raise: 'isolation', rear_delt_fly: 'isolation', face_pull: 'horizontal_pull', upright_row: 'vertical_pull',
  machine_lateral_raise: 'isolation', dumbbell_snatch: 'vertical_push',
  hammer_curl: 'isolation', preacher_curl: 'isolation', incline_curl: 'isolation', skull_crusher: 'isolation',
  overhead_extension: 'isolation', close_grip_bench: 'horizontal_push',
  front_squat: 'squat', smith_squat: 'squat', leg_extension: 'isolation', bulgarian_split_squat: 'lunge',
  step_up: 'lunge', leg_curl: 'isolation', good_morning: 'hinge', glute_bridge: 'hinge',
  cable_kickback: 'isolation', kettlebell_swing: 'hinge', standing_calf_raise: 'isolation',
  seated_calf_raise: 'isolation', banded_squat: 'squat',
  hanging_leg_raise: 'core', russian_twist: 'core', ab_wheel: 'core', mountain_climbers: 'core',
  burpee: 'carry', farmers_carry: 'carry', treadmill_run: 'carry', cycling: 'carry', rowing_machine: 'carry',
  incline_barbell_press: 'horizontal_push', decline_barbell_press: 'horizontal_push',
  decline_db_press: 'horizontal_push', low_cable_fly: 'isolation', high_cable_fly: 'isolation',
  machine_fly: 'isolation', landmine_press: 'vertical_push', floor_press: 'horizontal_push',
  svend_press: 'horizontal_push', db_pullover: 'vertical_pull', weighted_dip: 'horizontal_push',
  incline_push_up: 'horizontal_push', decline_push_up: 'horizontal_push', band_chest_press: 'horizontal_push',
  single_arm_cable_row: 'horizontal_pull', chest_supported_row: 'horizontal_pull', inverted_row: 'horizontal_pull',
  barbell_shrug: 'isolation', dumbbell_shrug: 'isolation', rack_pull: 'hinge', deficit_deadlift: 'hinge',
  sumo_deadlift: 'hinge', wide_grip_pulldown: 'vertical_pull', close_grip_pulldown: 'vertical_pull',
  single_arm_pulldown: 'vertical_pull', reverse_grip_pulldown: 'vertical_pull', meadows_row: 'horizontal_pull',
  pendlay_row: 'horizontal_pull', yates_row: 'horizontal_pull', back_extension: 'hinge',
  reverse_hyper: 'hinge', band_lat_pulldown: 'vertical_pull',
  arnold_press: 'vertical_push', db_shoulder_press: 'vertical_push', machine_shoulder_press: 'vertical_push',
  smith_ohp: 'vertical_push', single_arm_lateral_raise: 'isolation', cable_lateral_raise: 'isolation',
  reverse_pec_deck: 'isolation', db_rear_delt_row: 'horizontal_pull', pike_push_up: 'vertical_push',
  handstand_push_up: 'vertical_push', z_press: 'vertical_push', plate_raise: 'isolation',
  band_lateral_raise: 'isolation', dumbbell_clean_press: 'vertical_push',
  barbell_curl: 'isolation', ez_bar_curl: 'isolation', cable_curl: 'isolation', concentration_curl: 'isolation',
  spider_curl: 'isolation', drag_curl: 'isolation', bayesian_curl: 'isolation', reverse_curl: 'isolation',
  band_curl: 'isolation',
  cable_overhead_extension: 'isolation', db_kickback: 'isolation', bench_dip: 'isolation',
  rope_pushdown: 'isolation', vbar_pushdown: 'isolation', single_arm_pushdown: 'isolation',
  jm_press: 'horizontal_push', diamond_push_up: 'horizontal_push', band_pushdown: 'isolation',
  plate_pinch: 'carry', wrist_curl: 'isolation', dead_hang: 'vertical_pull',
  hack_squat: 'squat', goblet_squat: 'squat', box_squat: 'squat', sissy_squat: 'squat',
  pistol_squat: 'squat', reverse_lunge: 'lunge', lateral_lunge: 'lunge', split_squat: 'lunge',
  squat_to_bench: 'squat', thruster: 'squat', wall_sit: 'isolation', narrow_stance_leg_press: 'squat',
  nordic_curl: 'hinge', single_leg_rdl: 'hinge', seated_leg_curl: 'isolation', lying_leg_curl: 'isolation',
  cable_pull_through: 'hinge', straight_leg_deadlift: 'hinge', glute_ham_raise: 'hinge',
  banded_hip_thrust: 'hinge', single_leg_glute_bridge: 'hinge', frog_pump: 'hinge', curtsy_lunge: 'lunge',
  hip_abduction_machine: 'isolation', band_walks: 'isolation', dumbbell_hip_thrust: 'hinge',
  donkey_calf_raise: 'isolation', calf_press_leg_press: 'isolation', single_leg_calf_raise: 'isolation',
  tibialis_raise: 'isolation',
  dead_bug: 'core', bird_dog: 'core', side_plank: 'core', hollow_body_hold: 'core',
  reverse_crunch: 'core', bicycle_crunch: 'core', v_up: 'core', windshield_wiper: 'core',
  med_ball_slam: 'carry', pallof_press: 'core', suitcase_carry: 'carry', waiter_carry: 'carry',
  dragon_flag: 'core', band_pallof: 'core',
  power_clean: 'hinge', snatch: 'hinge', clean_jerk: 'hinge', devil_press: 'carry',
  turkish_getup: 'carry', battle_ropes: 'carry', sled_push: 'carry', sled_pull: 'carry',
  rope_climb: 'vertical_pull', muscle_up: 'vertical_pull', box_jump: 'squat', jump_squat: 'squat',
  lateral_box_step: 'lunge', push_press: 'vertical_push', db_swing: 'hinge',
  stair_climber: 'carry', elliptical: 'carry', assault_bike: 'carry', ski_erg: 'carry',
  jump_rope: 'carry', incline_walk: 'carry', sprint_intervals: 'carry',
  worlds_greatest_stretch: 'mobility', couch_stretch: 'mobility', thoracic_rotation: 'mobility',
  cat_cow: 'mobility', deep_squat_hold: 'mobility', shoulder_dislocate: 'mobility',
  wall_slide: 'mobility', ankle_rocker: 'mobility', pigeon_pose: 'mobility'
};

// exercise aliases for the intelligence search ("flat bench" -> Bench Press)
const EXERCISE_ALIASES = {
  bench_press: ['flat bench', 'barbell bench', 'bench', 'bench press'],
  squat: ['barbell squat', 'back squat', 'squats'],
  deadlift: ['conventional deadlift', 'barbell deadlift'],
  lat_pulldown: ['lat pull down', 'pulldown', 'pull down'],
  shoulder_press: ['overhead press', 'ohp', 'military press', 'db press'],
  bicep_curl: ['curl', 'barbell curl'],
  triceps_pushdown: ['pushdown', 'cable pushdown'],
  push_up: ['pushup', 'press up'],
  lunges: ['lunge', 'walking lunge'],
  hip_thrust: ['glute thrust', 'hip thrusts'],
  seated_row: ['cable row', 'seated cable row'],
  dumbbell_row: ['db row', 'one arm row'],
  pull_up: ['pullup', 'pull ups'],
  chin_up: ['chinup', 'chin ups'],
  romanian_deadlift: ['rdl', 'romanian deadlifts'],
  plank: ['front plank'],
  kettlebell_swing: ['kb swing', 'russian swing'],
  bulgarian_split_squat: ['bss', 'split squat'],
  leg_extension: ['leg extensions', 'quads extension'],
  leg_curl: ['hamstring curl', 'leg curls'],
  face_pull: ['face pulls'],
  hammer_curl: ['hammer curls', 'db hammer curl'],
  incline_barbell_press: ['incline bench press', 'incline press', 'incline bench'],
  decline_barbell_press: ['decline bench press', 'decline press'],
  dumbbell_bench_press: ['db bench', 'dumbbell press'],
  incline_db_press: ['incline db press', 'incline dumbbell'],
  goblet_squat: ['goblet squats'],
  hack_squat: ['hack squats'],
  front_squat: ['front squats'],
  sumo_deadlift: ['sumo deads'],
  rack_pull: ['rack pulls'],
  cable_fly: ['cable flies', 'chest fly'],
  machine_chest_press: ['chest press machine', 'machine press'],
  arnold_press: ['arnold presses'],
  reverse_pec_deck: ['rear delt machine', 'reverse fly machine'],
  barbell_row: ['bent over row', 'bent-over row'],
  pendlay_row: ['pendlay rows'],
  inverted_row: ['bodyweight row', 'horizontal row'],
  chest_supported_row: ['chest supported rows'],
  barbell_shrug: ['shrugs', 'barbell shrugs'],
  dumbbell_shrug: ['db shrugs'],
  nordic_curl: ['nordic hamstring curl'],
  single_leg_rdl: ['single leg rdl', 'one leg rdl'],
  cable_pull_through: ['pull through', 'pullthrough'],
  glute_bridge: ['hip bridge', 'glute bridges'],
  banded_squat: ['band squats'],
  box_jump: ['box jumps'],
  thruster: ['thrusters', 'db thruster'],
  push_press: ['push presses'],
  skull_crusher: ['skullcrushers', 'lying triceps extension'],
  close_grip_bench: ['close grip bench press'],
  overhead_extension: ['overhead triceps extension'],
  dead_hang: ['hang', 'passive hang'],
  wall_sit: ['wall sits'],
  side_plank: ['side planks'],
  dead_bug: ['dead bugs'],
  bird_dog: ['bird dogs'],
  pallof_press: ['pallof'],
  turkish_getup: ['tgu', 'turkish get up'],
  battle_ropes: ['battling ropes', 'ropes'],
  sled_push: ['sled'],
  jump_rope: ['skipping rope', 'skip rope'],
  stair_climber: ['stairs', 'stairmaster'],
  elliptical: ['cross trainer'],
  assault_bike: ['air bike'],
  rowing_machine: ['erg', 'rower'],
  worlds_greatest_stretch: ['wgs', 'worlds greatest'],
  couch_stretch: ['hip flexor stretch'],
  pigeon_pose: ['pigeon'],
  deep_squat_hold: ['squat hold'],
  shoulder_dislocate: ['dislocates', 'band dislocates']
};

const typeFor = (equip) => {
  const e = String(equip).toUpperCase();
  if (['TREADMILL', 'BIKE', 'ROWING'].includes(e)) return 'cardio';
  if (['MACHINE', 'SMITH', 'LEG_PRESS'].includes(e)) return 'machine';
  if (e === 'CABLE') return 'cable';
  if (['BODYWEIGHT', 'BANDS', 'PULL_UP_BAR'].includes(e)) return 'bodyweight';
  return 'free_weight';
};

async function main() {
  const noDemo = process.argv.includes('--no-demo');
  const db = await getDb();

  if (noDemo) {
    // ---- CLEAN MODE: reference data only (exercises, muscles, aliases) ----
    // Check if exercise library already exists.
    const exCount = await db.q1('SELECT COUNT(*) AS cnt FROM exercise_library');
    if (exCount && exCount.cnt > 0) {
      console.log('Reference data already present — skipping.');
      process.exit(0);
    }
    // Create a minimal org so exercise_library FK is satisfied.
    const orgId = id('org');
    await db.run('INSERT INTO organizations (id, name, slug, type, created_at) VALUES (?, ?, ?, ?, ?)',
      [orgId, 'CLEAN', 'clean-' + orgId.slice(-4), 'gym', now()]);

    // ---- exercise library (global) ----
    const typeFor = (equip) => {
      const e = String(equip).toUpperCase();
      if (['TREADMILL', 'BIKE', 'ROWING'].includes(e)) return 'cardio';
      if (['MACHINE', 'SMITH', 'LEG_PRESS'].includes(e)) return 'machine';
      if (e === 'CABLE') return 'cable';
      if (['BODYWEIGHT', 'BANDS', 'PULL_UP_BAR'].includes(e)) return 'bodyweight';
      return 'free_weight';
    };
    for (const [key, name, primary, secondary, equip, diff] of EXERCISES) {
      await db.run(
        `INSERT INTO exercise_library (id, org_id, name, primary_muscle, secondary_muscles, equipment, ex_type, movement, difficulty, animation_key, is_global)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [id('exl'), name, primary, secondary, equip, typeFor(equip), MOVEMENT_BY_KEY[key] || 'compound', diff, key]);
    }
    // exercise aliases
    for (const [key, aliases] of Object.entries(EXERCISE_ALIASES)) {
      const lib = await db.q1('SELECT id FROM exercise_library WHERE animation_key = ?', [key]);
      if (!lib) continue;
      for (const alias of aliases) {
        await db.run(
          'INSERT INTO exercise_aliases (id, org_id, exercise_id, alias) VALUES (?, NULL, ?, ?)',
          [id('exa'), lib.id, alias]);
      }
    }
    // ---- normalized muscle model ----
    await seedMuscles(db);
    await syncExerciseMuscles(db);

    console.log('Reference data seeded (exercises, muscles, aliases).');
    console.log('No demo users or sample data created.');
    await db.close?.();
    process.exit(0);
  }

  // ---- FULL SEED: demo data (backward-compatible) ----
  const existing = await db.q1('SELECT id FROM organizations WHERE slug = ?', ['ironforge-fitness']);
  if (existing) {
    console.error('IRONFORGE already seeded. Run `npm run db:reset` to reseed from scratch.');
    process.exit(1);
  }

  const orgId = id('org');
  await db.run('INSERT INTO organizations (id, name, slug, type, created_at) VALUES (?, ?, ?, ?, ?)',
    [orgId, 'IRONFORGE FITNESS', 'ironforge-fitness', 'gym', now()]);

  const pwHash = await hashPassword('demo1234');

  // ---- users: owner, trainers ----
  const ownerId = id('usr');
  await db.run(
    `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
     VALUES (?, ?, ?, ?, 'GYM_OWNER', 'Maya Kapoor', 1, ?)`,
    [ownerId, orgId, 'owner@ironforge.in', pwHash, now()]);

  const trainerIds = [];
  for (const [email, name, spec] of TRAINERS) {
    const uid = id('usr');
    await db.run(
      `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
       VALUES (?, ?, ?, ?, 'TRAINER', ?, 1, ?)`,
      [uid, orgId, email, pwHash, name, now()]);
    await db.run('INSERT INTO trainers (user_id, org_id, specialization, max_clients) VALUES (?, ?, ?, 50)',
      [uid, orgId, spec]);
    trainerIds.push(uid);
  }

  // ---- exercise library (global) ----
  for (const [key, name, primary, secondary, equip, diff] of EXERCISES) {
    await db.run(
      `INSERT INTO exercise_library (id, org_id, name, primary_muscle, secondary_muscles, equipment, ex_type, movement, difficulty, animation_key, is_global)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [id('exl'), name, primary, secondary, equip, typeFor(equip), MOVEMENT_BY_KEY[key] || 'compound', diff, key]);
  }
  // exercise aliases (intelligence search vocabulary)
  for (const [key, aliases] of Object.entries(EXERCISE_ALIASES)) {
    const lib = await db.q1('SELECT id FROM exercise_library WHERE animation_key = ?', [key]);
    if (!lib) continue;
    for (const alias of aliases) {
      await db.run(
        'INSERT INTO exercise_aliases (id, org_id, exercise_id, alias) VALUES (?, NULL, ?, ?)',
        [id('exa'), lib.id, alias]);
    }
  }
  const exByName = new Map();
  for (const row of await db.q('SELECT id, name, animation_key FROM exercise_library')) {
    exByName.set(row.name, row);
  }

  // ---- normalized muscle model ----
  await seedMuscles(db);
  await syncExerciseMuscles(db);

  // ---- workout templates ----
  const tmplIds = [];
  for (const [tname, exs] of Object.entries(TEMPLATES)) {
    const tId = id('wkt');
    await db.run(
      `INSERT INTO workout_templates (id, org_id, trainer_id, name, type, notes, is_global, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      [tId, orgId, trainerIds[0], tname, tname.split(' ')[0].toLowerCase(), null, now()]);
    for (let i = 0; i < exs.length; i++) {
      const [key, sets, reps, weight, rest] = exs[i];
      const lib = await db.q1('SELECT id FROM exercise_library WHERE animation_key = ?', [key]);
      await db.run(
        `INSERT INTO workout_exercises (id, workout_id, template_id, exercise_id, position, name, sets, reps, weight, rest_sec)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id('wxe'), tId, lib?.id || null, i, lib?.name || key, sets, reps, weight, rest]);
    }
    tmplIds.push({ name: tname, id: tId });
  }

  // ---- nutrition plan templates ----
  const planTemplateIds = [];
  for (const pt of NUTRITION_TEMPLATES) {
    const pId = id('nut');
    await db.run(
      `INSERT INTO nutrition_plans (id, org_id, trainer_id, client_id, name, calories, protein, carbs, fat, is_template, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 1, ?)`,
      [pId, orgId, trainerIds[0], pt.name, pt.calories, pt.protein, pt.carbs, pt.fat, now()]);
    for (let i = 0; i < pt.meals.length; i++) {
      const [slot, name, time, cal, p, c, f, foods] = pt.meals[i];
      await db.run(
        `INSERT INTO meals (id, plan_id, slot, name, time, calories, protein, carbs, fat, foods, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id('mea'), pId, slot, name, time, cal, p, c, f, foods, i]);
    }
    planTemplateIds.push(pId);
  }

  // ---- clients ----
  const clientIds = [];
  const today = new Date();
  const workoutDates = [];
  for (let i = 55; i >= 0; i--) {
    const d = daysAgo(i);
    const dow = weekDay(dayKey(d));
    if (dow === 1 || dow === 2 || dow === 4 || dow === 5) workoutDates.push(d);
  }

  for (let ci = 0; ci < CLIENTS.length; ci++) {
    const [name, age, sex, goal, startW, targetW, height, patternName] = CLIENTS[ci];
    const pat = PATTERNS[patternName];
    const trainerId = trainerIds[ci % trainerIds.length];
    const uid = id('usr');
    const cid = id('cli');
    const email = `client${ci + 1}@ironforge.in`;
    // stagger signup dates so "new clients" is a meaningful metric
    const signedUp = dayKey(daysAgo(15 + ci * 4));
    await db.run(
      `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
       VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
      [uid, orgId, email, pwHash, name, signedUp + 'T09:00:00Z']);

    // weight series: 16 weekly points
    const series = [];
    const weeks = 16;
    let w = startW;
    const loss = pat.loss * (goal === 'MUSCLE_GAIN' || goal === 'STRENGTH' ? -0.5 : 1);
    const plateauEnd = Math.round((startW - loss * 0.9) * 10) / 10; // ~87.4 for Rahul
    for (let k = 0; k < weeks; k++) {
      const progress = k / (weeks - 1);
      const target = startW - loss * progress;
      if (ci === 0) {
        // Rahul: clean 94 → 87.4 decline over 11 weeks, then a 28-day plateau at 87.4
        w = k <= 10 ? startW - (startW - 87.4) * (k / 10) : 87.4;
        w += jitter(0, k <= 10 ? 0.25 : 0.06);
      } else {
        w = target + jitter(0, 0.35);
        // plateau pattern: flat for the last 3 weeks
        if (pat.weightTrend === 'flat' && k >= weeks - 3) w = plateauEnd + jitter(0, 0.08);
        // stale (inactive): no logs recently
        if (pat.weightTrend === 'stale' && k < weeks - 2) w = target + jitter(0, 0.3);
      }
      const date = dayKey(addDays(today, -(weeks - 1 - k) * 7));
      series.push({ date, weight: Math.round(w * 10) / 10 });
    }
    const currentW = series[series.length - 1].weight;

    await db.run(
      `INSERT INTO clients (id, user_id, org_id, trainer_id, status, goal, start_weight, current_weight, target_weight, goal_date, height_cm, age, sex, last_checkin_at, created_at)
       VALUES (?, ?, ?, ?, 'ON_TRACK', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [cid, uid, orgId, trainerId, goal, startW, currentW, targetW,
       dayKey(addDays(today, 120)), height, age, sex,
       pat.checkin ? now() : dayKey(addDays(today, -10)), signedUp + 'T09:00:00Z']);

    const excl = ci === 1 ? 'paneer, eggs' : ci === 8 ? 'none' : null;
    // equipment profile + experience (varied so equipment checks and
    // substitution recommendations have real data to work with)
    const EQUIP_PROFILES = {
      3: ['dumbbells', 'bench', 'bands', 'bodyweight'],      // Neha — home set
      16: ['dumbbells', 'bench', 'bands', 'pull_up_bar', 'bodyweight'], // Manish — home
      19: ['dumbbells', 'bench', 'bodyweight'],               // Ritika — minimal
      7: ['dumbbells', 'cable', 'machine', 'bench', 'bodyweight'] // Kavya — no barbell
    };
    const equip = EQUIP_PROFILES[ci] || 'full_gym';
    const EXP = { 4: 'INTERMEDIATE', 14: 'ADVANCED', 17: 'ADVANCED', 19: 'BEGINNER' };
    await db.run(
      `INSERT INTO client_profiles (client_id, diet_type, cuisine, meals_per_day, sleep_target_h, water_target_l, food_exclusions, equipment, experience)
       VALUES (?, 'NON_VEG', 'INDIAN', 5, 8, 3, ?, ?, ?)`,
      [cid, excl, Array.isArray(equip) ? JSON.stringify(equip) : equip, EXP[ci] || 'INTERMEDIATE']);

    // ---- AI coach memory: structured long-term preferences (per client) ----
    const AI_MEMORY = {
      0: { equipment_pref: ['dumbbells'], disliked_exercises: ['barbell squats'], liked_foods: ['paneer', 'grilled chicken'], workout_duration: '40 min', training_time: 'morning' },
      4: { equipment_pref: ['dumbbells', 'bench', 'bands'], workout_duration: '30 min', training_time: 'evening' },
      7: { disliked_exercises: ['barbell squats'], workout_duration: '45 min' }
    };
    const mem = AI_MEMORY[ci];
    if (mem) {
      for (const [k, v] of Object.entries(mem)) {
        await db.run(
          `INSERT INTO ai_memory (id, org_id, client_id, key, value, source, updated_at)
           VALUES (?, ?, ?, ?, ?, 'seed', ?)`,
          [id('aim'), orgId, cid, k, JSON.stringify(v), now()]);
      }
    }

    for (const s of series) {
      await db.run('INSERT INTO weight_logs (id, client_id, date, weight, source, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id('wlg'), cid, s.date, s.weight, 'manual', s.date + 'T08:00:00Z']);
    }

    // measurements: 3 snapshots
    const mDates = [series[0].date, series[Math.floor(weeks / 2)].date, series[weeks - 1].date];
    for (let m = 0; m < 3; m++) {
      const wAt = series[m * 7]?.weight || series[weeks - 1].weight;
      await db.run(
        `INSERT INTO measurements (id, client_id, taken_at, weight, waist, chest, arms, thighs, hips, neck)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id('mea'), cid, mDates[m] + 'T09:00:00Z', wAt,
         Math.round(wAt * 0.9 * 2.54 * 10) / 10, Math.round((wAt * 0.5 + 12) * 10) / 10,
         Math.round((wAt * 0.12 + 6) * 10) / 10, Math.round((wAt * 0.22 + 10) * 10) / 10,
         Math.round((wAt * 0.32 + 8) * 10) / 10, Math.round((wAt * 0.14 + 5) * 10) / 10]);
    }

    // ---- nutrition plan (clone template) ----
    const tmpl = await db.q1('SELECT * FROM nutrition_plans WHERE id = ?', [planTemplateIds[goal === 'MUSCLE_GAIN' ? 1 : 0]]);
    const pId = id('nut');
    await db.run(
      `INSERT INTO nutrition_plans (id, org_id, trainer_id, client_id, name, calories, protein, carbs, fat, is_template, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [pId, orgId, trainerId, cid, tmpl.name, tmpl.calories, tmpl.protein, tmpl.carbs, tmpl.fat, now()]);
    const tmplMeals = await db.q('SELECT * FROM meals WHERE plan_id = ? ORDER BY position', [tmpl.id]);
    for (const m of tmplMeals) {
      await db.run(
        `INSERT INTO meals (id, plan_id, slot, name, time, calories, protein, carbs, fat, foods, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id('mea'), pId, m.slot, m.name, m.time, m.calories, m.protein, m.carbs, m.fat, m.foods, m.position]);
    }
    const planMeals = await db.q('SELECT * FROM meals WHERE plan_id = ?', [pId]);

    // ---- meals for last 7 days ----
    for (let d = 6; d >= 0; d--) {
      const date = dayKey(daysAgo(d));
      for (const meal of planMeals) {
        const eaten = rnd() < pat.mealRate;
        await db.run(
          `INSERT INTO meal_logs (id, client_id, meal_id, date, slot, name, calories, protein, carbs, fat, eaten, source, estimate)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'plan', 0)`,
          [id('mlg'), cid, meal.id, date, meal.slot, meal.name, meal.calories,
           Math.round(meal.protein * pat.proteinScale), meal.carbs, meal.fat, eaten ? 1 : 0]);
      }
    }

    // ---- workouts: schedule + logs ----
    // Program-driven clients (Rahul, Neha, Vikram) get today's session
    // materialized from their training program at runtime — skip the
    // seeded "today" row so the split drives the demo.
    const isProgramClient = ci === 0 || ci === 3 || ci === 4;
    for (let wi = 0; wi < workoutDates.length; wi++) {
      const d = workoutDates[wi];
      if (isProgramClient && dayKey(d) === dayKey(daysAgo(0))) continue;
      const tmpl = tmplIds[Math.floor(wi / 4) % tmplIds.length];
      const weekIdx = Math.floor(wi / 4);
      const wId = id('wko');
      // inactive: no workouts in the last 2+ weeks
      const isRecent = dayKey(d) >= dayKey(daysAgo(2));
      const completed = rnd() < pat.workoutRate && !(pat.weightTrend === 'stale' && isRecent);
      await db.run(
        `INSERT INTO workouts (id, org_id, template_id, client_id, trainer_id, name, day_label, scheduled_date, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [wId, orgId, tmpl.id, cid, trainerId, tmpl.name, tmpl.name, dayKey(d),
         completed ? 'completed' : 'missed', now()]);
      // copy template exercises into the assigned workout
      const tmplExs = await db.q('SELECT * FROM workout_exercises WHERE template_id = ?', [tmpl.id]);
      for (const ex of tmplExs) {
        await db.run(
          `INSERT INTO workout_exercises (id, workout_id, template_id, exercise_id, position, name, sets, reps, weight, rest_sec)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
          [id('wxe'), wId, ex.exercise_id, ex.position, ex.name, ex.sets, ex.reps, ex.weight, ex.rest_sec]);
      }
      if (completed) {
        const exs = await db.q('SELECT * FROM workout_exercises WHERE workout_id = ?', [wId]);
        for (const ex of exs) {
          const base = BASE_W[ex.exercise_id ? (await db.q1('SELECT animation_key FROM exercise_library WHERE id = ?', [ex.exercise_id]))?.animation_key : null] ?? 0;
          const wgt = base > 0 ? Math.round((base + 2.5 * Math.floor(weekIdx / 2)) * 2) / 2 : 0;
          await db.run(
            `INSERT INTO workout_logs (id, client_id, workout_id, exercise_id, date, sets_done, reps, weight, is_pr)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
            [id('wlg'), cid, wId, ex.exercise_id, dayKey(d), ex.sets, parseInt(ex.reps) || 0, wgt]);
        }
      }
    }

    // ---- water + sleep: 7 days ----
    for (let d = 6; d >= 0; d--) {
      const date = dayKey(daysAgo(d));
      const litres = Math.round(3 * pat.waterRate * (0.85 + rnd() * 0.3) * 10) / 10;
      await db.run('INSERT INTO water_logs (id, client_id, date, litres) VALUES (?, ?, ?, ?)',
        [id('wat'), cid, date, litres]);
      const dur = Math.round(8 * pat.sleepRate * (0.92 + rnd() * 0.16) * 10) / 10;
      await db.run(
        `INSERT INTO sleep_logs (id, client_id, date, bed_time, wake_time, duration_h, target_h, source)
         VALUES (?, ?, ?, '23:30', '07:00', ?, 8, 'manual')`,
        [id('slp'), cid, date, Math.min(dur, 9.5)]);
    }

    // ---- adherence history: 14 days around the computed score ----
    const ad = await computeAdherence(db, cid);
    for (let d = 13; d >= 0; d--) {
      const date = dayKey(daysAgo(d));
      await db.run(
        `INSERT INTO adherence_records (id, client_id, date, score, workout, nutrition, protein, water, sleep, checkin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id('adr'), cid, date, Math.max(0, Math.min(100, Math.round(ad.score + jitter(0, 6)))),
         ad.components.workout, ad.components.nutrition, ad.components.protein,
         ad.components.water, ad.components.sleep, ad.components.checkin]);
    }
    await snapshotAdherence(db, cid);

    clientIds.push(cid);
  }

  // ---- training programs (split-driven sessions) ----
  const tmplByName = new Map(tmplIds.map(t => [t.name, t.id]));
  const PROGRAMS = [
    // Rahul — fat loss, PPL 5 (Push/Pull/Legs/Upper/Lower)
    { client: clientIds[0], goal: 'FAT_LOSS', split: 'PPL_5', name: 'Push / Pull / Legs', daysPerWeek: 5, days: [
      [1, 'Push Day', 'CHEST, SHOULDERS, TRICEPS', 'Push A'],
      [2, 'Pull Day', 'BACK, BICEPS, REAR DELTS', 'Pull A'],
      [3, 'Leg Day', 'QUADS, HAMSTRINGS, GLUTES, CALVES', 'Legs A'],
      [5, 'Upper Body', 'CHEST, BACK, SHOULDERS, ARMS', 'Full Body'],
      [6, 'Lower Body', 'QUADS, HAMSTRINGS, GLUTES', 'Legs A']
    ] },
    // Neha — recomposition, full body 3
    { client: clientIds[3], goal: 'RECOMP', split: 'FULL_BODY_3', name: 'Full Body', daysPerWeek: 3, days: [
      [1, 'Full Body A', 'FULL BODY', 'Full Body'],
      [3, 'Full Body B', 'FULL BODY', 'Full Body'],
      [5, 'Full Body C', 'FULL BODY', 'Full Body']
    ] },
    // Vikram — muscle gain, PPL 4 (Push/Pull/Legs/Upper)
    { client: clientIds[4], goal: 'MUSCLE_GAIN', split: 'PPL_4', name: 'Push / Pull / Legs', daysPerWeek: 4, days: [
      [1, 'Push Day', 'CHEST, SHOULDERS, TRICEPS', 'Push A'],
      [2, 'Pull Day', 'BACK, BICEPS, REAR DELTS', 'Pull A'],
      [3, 'Leg Day', 'QUADS, HAMSTRINGS, GLUTES, CALVES', 'Legs A'],
      [5, 'Upper Body', 'CHEST, BACK, SHOULDERS, ARMS', 'Full Body']
    ] },
    // Arjun Nair — strength, custom split (squat/hinge focused)
    { client: clientIds[6], goal: 'STRENGTH', split: 'CUSTOM', name: 'Strength Block', daysPerWeek: 4, days: [
      [1, 'Squat Focus', 'QUADS, GLUTES, CORE', 'Legs A'],
      [3, 'Hinge Focus', 'HAMSTRINGS, GLUTES, BACK', 'Full Body'],
      [4, 'Press Focus', 'CHEST, SHOULDERS, TRICEPS', 'Push A'],
      [6, 'Pull Focus', 'BACK, BICEPS', 'Pull A']
    ] }
  ];
  for (const p of PROGRAMS) {
    const pId = id('tpr');
    await db.run(
      `INSERT INTO training_programs (id, org_id, client_id, trainer_id, name, split, goal, days_per_week, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [pId, orgId, p.client, trainerIds[0], p.name, p.split, p.goal, p.daysPerWeek, now()]);
    for (let i = 0; i < p.days.length; i++) {
      const [dow, name, focus, tmplName] = p.days[i];
      await db.run(
        `INSERT INTO training_days (id, program_id, day_of_week, name, focus_muscles, template_id, position)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id('tdy'), pId, dow, name, focus, tmplByName.get(tmplName) || null, i]);
    }
  }

  // ---- packages + subscriptions + payments ----
  const pkgIds = [];
  for (const [name, amount, days] of PACKAGES) {
    const pId = id('pkg');
    await db.run(
      `INSERT INTO packages (id, org_id, name, amount, currency, period_days) VALUES (?, ?, ?, ?, 'INR', ?)`,
      [pId, orgId, name, amount, days]);
    pkgIds.push(pId);
  }

  const allClients = await db.q('SELECT id FROM clients WHERE org_id = ?', [orgId]);
  for (let i = 0; i < allClients.length; i++) {
    const c = allClients[i];
    const pkg = pkgIds[i % pkgIds.length];
    const subId = id('sub');
    const startDaysAgo = 30 + Math.floor(rnd() * 300);
    const start = dayKey(daysAgo(startDaysAgo));
    const end = dayKey(addDays(new Date(start + 'T00:00:00Z'), PACKAGES[i % 3][2]));
    const isOverdue = i === 7 || i === 19;
    const status = isOverdue ? 'overdue' : 'active';
    const payStatus = isOverdue ? 'overdue' : 'paid';
    const pkgRow = await db.q1('SELECT * FROM packages WHERE id = ?', [pkg]);
    await db.run(
      `INSERT INTO subscriptions (id, org_id, client_id, package_id, plan_name, amount, currency, start_date, end_date, renewal_date, status, payment_status)
       VALUES (?, ?, ?, ?, ?, ?, 'INR', ?, ?, ?, ?, ?)`,
      [subId, orgId, c.id, pkg, pkgRow.name, pkgRow.amount, start, end, end, status, payStatus]);
    // monthly payments for the last 6 months (UTC-safe first-of-month)
    const nowD = new Date();
    for (let m = 0; m < 6; m++) {
      const paidAt = dayKey(new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth() - m, 1))) + 'T10:00:00Z';
      if (paidAt.slice(0, 10) <= dayKey()) {
        await db.run(
          `INSERT INTO payments (id, org_id, client_id, subscription_id, amount, currency, method, status, paid_at)
           VALUES (?, ?, ?, ?, ?, 'INR', 'UPI', 'paid', ?)`,
          [id('pay'), orgId, c.id, subId, pkgRow.amount, paidAt]);
      }
    }
  }

  // ---- attendance: last 30 weekdays ----
  const gymClients = allClients.slice(0, 20);
  for (let d = 29; d >= 0; d--) {
    const date = dayKey(daysAgo(d));
    const dow = weekDay(date);
    if (dow === 0 || dow === 6) continue;
    for (const c of gymClients) {
      if (rnd() < 0.82) {
        await db.run('INSERT INTO attendance (id, org_id, client_id, date, present) VALUES (?, ?, ?, ?, 1)',
          [id('att'), orgId, c.id, date]);
      }
    }
  }

  // ---- messages: trainer → a couple of clients ----
  const rahul = await db.q1(`SELECT c.*, u.id AS uid FROM clients c JOIN users u ON u.id = c.user_id WHERE c.org_id = ? AND u.name = 'Rahul Sharma'`, [orgId]);
  if (rahul) {
    await db.run(
      `INSERT INTO messages (id, org_id, from_user, to_user, client_id, type, body, channel, read, created_at)
       VALUES (?, ?, ?, ?, ?, 'message', ?, 'inapp', 0, ?)`,
      [id('msg'), orgId, trainerIds[1], rahul.uid, rahul.id,
       'Great week on the bench — 60→62.5 kg. Let\'s keep protein at 200g; the plateau will break with consistency.', daysAgo(2).toISOString()]);
    await db.run(
      `INSERT INTO messages (id, org_id, from_user, to_user, client_id, type, body, channel, read, created_at)
       VALUES (?, ?, ?, ?, ?, 'checkin_reminder', ?, 'inapp', 0, ?)`,
      [id('msg'), orgId, trainerIds[1], rahul.uid, rahul.id,
       'Reminder: log your weight + measurements today — Friday check-in.', daysAgo(0).toISOString()]);
  }

  // ---- AI insight for Rahul (from real data) ----
  if (rahul) {
    const insight = await analyzeClientProgress(db, rahul.id);
    if (insight) {
      await db.run(
        `INSERT INTO coach_insights (id, org_id, client_id, trainer_id, type, summary, recommendation, data_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        [id('ins'), orgId, rahul.id, trainerIds[1], insight.type, insight.summary,
         insight.recommendation, JSON.stringify(insight.data), now()]);
    }
  }

  // ---- gym settings (branding, crowd, default client permissions) ----
  await db.run(
    `INSERT INTO gym_settings (org_id, brand_name, tagline, crowd_capacity, crowd_enabled, workout_mode_default, allow_substitute, allow_add_exercise, allow_edit_targets, updated_at)
     VALUES (?, 'IRONFORGE FITNESS', 'Train smarter. Coach better. Prove progress.', 150, 1, 'hybrid', 1, 1, 1, ?)`,
    [orgId, now()]);

  // ---- GLOBAL food library (available to every org/client) — VERIFIED_DATABASE source ----
  // tuple: [name, unit, serving, kcal, protein, carbs, fat, category, cuisine]
  const GLOBAL_FOODS = [
    // --- Indian staples ---
    ['Roti', 'piece', '1 pc', 104, 3.5, 18, 1, 'staple', 'INDIAN'],
    ['Whole wheat chapati', 'piece', '1 pc', 120, 4, 21, 2, 'staple', 'INDIAN'],
    ['Rice (cooked)', 'bowl', '150 g', 206, 4.4, 45, 0.4, 'staple', 'INDIAN'],
    ['Brown rice', 'bowl', '150 g', 165, 4, 35, 1.3, 'staple', 'INDIAN'],
    ['Jeera rice', 'bowl', '150 g', 240, 4, 42, 6, 'staple', 'INDIAN'],
    ['Lemon rice', 'bowl', '150 g', 220, 4, 40, 5, 'staple', 'INDIAN'],
    ['Curd rice', 'bowl', '150 g', 180, 5, 30, 4, 'staple', 'INDIAN'],
    ['Pulao', 'bowl', '150 g', 260, 5, 44, 7, 'staple', 'INDIAN'],
    ['Biryani (chicken)', 'bowl', '300 g', 480, 30, 60, 14, 'main', 'INDIAN'],
    ['Dal', 'bowl', '150 g', 160, 9, 24, 4, 'protein', 'INDIAN'],
    ['Dal tadka', 'bowl', '150 g', 210, 9, 22, 10, 'protein', 'INDIAN'],
    ['Dal makhani', 'bowl', '150 g', 280, 12, 25, 15, 'protein', 'INDIAN'],
    ['Sambar', 'bowl', '150 g', 100, 5, 15, 3, 'staple', 'INDIAN'],
    ['Rasam', 'bowl', '150 g', 50, 2, 9, 0.5, 'staple', 'INDIAN'],
    ['Poha', 'bowl', '150 g', 250, 7, 40, 7, 'breakfast', 'INDIAN'],
    ['Upma', 'bowl', '150 g', 240, 6, 40, 7, 'breakfast', 'INDIAN'],
    ['Khichdi', 'bowl', '200 g', 220, 8, 40, 4, 'staple', 'INDIAN'],
    ['Idli', 'pair', '2 pcs', 116, 3, 23, 0.5, 'breakfast', 'INDIAN'],
    ['Dosa', 'piece', '1 pc', 168, 3.5, 30, 4, 'breakfast', 'INDIAN'],
    ['Uttapam', 'piece', '1 pc', 190, 4, 30, 6, 'breakfast', 'INDIAN'],
    ['Paratha (plain)', 'piece', '1 pc', 260, 5, 34, 12, 'staple', 'INDIAN'],
    ['Aloo paratha', 'piece', '1 pc', 310, 6, 40, 14, 'staple', 'INDIAN'],
    ['Samosa', 'piece', '1 pc', 260, 4, 28, 15, 'snack', 'INDIAN'],
    ['Kachori', 'piece', '1 pc', 220, 4, 26, 11, 'snack', 'INDIAN'],
    ['Pakora (mixed)', 'serving', '100 g', 260, 7, 24, 15, 'snack', 'INDIAN'],
    ['Medu vada', 'piece', '1 pc', 130, 3, 18, 5, 'snack', 'INDIAN'],
    ['Bhel puri', 'bowl', '150 g', 180, 4, 32, 5, 'snack', 'INDIAN'],
    // --- proteins ---
    ['Paneer', 'serving', '100 g', 265, 18, 4, 21, 'protein', 'INDIAN'],
    ['Paneer bhurji', 'serving', '100 g', 200, 12, 6, 14, 'protein', 'INDIAN'],
    ['Palak paneer', 'bowl', '200 g', 320, 15, 14, 24, 'main', 'INDIAN'],
    ['Chicken breast', 'serving', '150 g', 247, 46.5, 0, 5.4, 'protein', 'INTERNATIONAL'],
    ['Chicken thigh (skinless)', 'serving', '150 g', 315, 38, 0, 18, 'protein', 'INTERNATIONAL'],
    ['Chicken curry', 'bowl', '200 g', 320, 28, 10, 19, 'main', 'INDIAN'],
    ['Chicken tikka', 'serving', '150 g', 280, 32, 4, 15, 'protein', 'INDIAN'],
    ['Tandoori chicken', 'serving', '150 g', 240, 35, 2, 10, 'protein', 'INDIAN'],
    ['Egg', 'piece', '1 pc', 72, 6, 0.4, 4.8, 'protein', 'INTERNATIONAL'],
    ['Egg white', 'piece', '1 pc', 17, 3.6, 0.2, 0.1, 'protein', 'INTERNATIONAL'],
    ['Fish (rohu)', 'serving', '150 g', 155, 25, 0, 5.5, 'protein', 'INDIAN'],
    ['Salmon', 'serving', '150 g', 312, 33, 0, 19, 'protein', 'INTERNATIONAL'],
    ['Tuna (canned)', 'can', '100 g', 116, 26, 0, 1, 'protein', 'INTERNATIONAL'],
    ['Mutton curry', 'bowl', '200 g', 380, 30, 8, 25, 'main', 'INDIAN'],
    ['Prawns', 'serving', '100 g', 99, 24, 0, 0.3, 'protein', 'INDIAN'],
    ['Soya chunks', 'serving', '100 g', 345, 52, 33, 0.5, 'protein', 'INDIAN'],
    ['Tofu', 'serving', '100 g', 76, 8, 2, 4.8, 'protein', 'INTERNATIONAL'],
    ['Tempeh', 'serving', '100 g', 193, 19, 9, 11, 'protein', 'INTERNATIONAL'],
    ['Moong dal', 'bowl', '150 g', 160, 9, 27, 3, 'protein', 'INDIAN'],
    ['Toor dal', 'bowl', '150 g', 165, 9, 28, 3, 'protein', 'INDIAN'],
    ['Masoor dal', 'bowl', '150 g', 155, 11, 26, 1, 'protein', 'INDIAN'],
    ['Urad dal', 'bowl', '150 g', 170, 10, 28, 2, 'protein', 'INDIAN'],
    ['Chana', 'bowl', '100 g', 164, 9, 27, 5, 'protein', 'INDIAN'],
    ['Chole', 'bowl', '150 g', 240, 11, 35, 8, 'main', 'INDIAN'],
    ['Rajma', 'bowl', '150 g', 160, 10, 28, 1, 'protein', 'INDIAN'],
    ['Black beans', 'bowl', '150 g', 165, 10, 30, 0.7, 'protein', 'INTERNATIONAL'],
    ['Sprouts', 'bowl', '100 g', 70, 5, 13, 0.8, 'protein', 'INDIAN'],
    ['Hummus', 'serving', '50 g', 83, 4, 7, 4.8, 'protein', 'INTERNATIONAL'],
    // --- grains & carbs ---
    ['Oats', 'bowl', '50 g', 190, 7, 33, 3.4, 'breakfast', 'INTERNATIONAL'],
    ['Quinoa', 'bowl', '150 g', 180, 6.6, 31, 2.9, 'staple', 'INTERNATIONAL'],
    ['Couscous', 'bowl', '150 g', 168, 5.6, 35, 0.3, 'staple', 'INTERNATIONAL'],
    ['Barley', 'bowl', '150 g', 165, 5, 36, 1, 'staple', 'INTERNATIONAL'],
    ['Millets (ragi)', 'serving', '50 g', 164, 3.6, 36, 1.3, 'staple', 'INDIAN'],
    ['Jowar roti', 'piece', '1 pc', 100, 3, 20, 1, 'staple', 'INDIAN'],
    ['Bajra roti', 'piece', '1 pc', 105, 3.5, 21, 1, 'staple', 'INDIAN'],
    ['Sweet potato', 'serving', '150 g', 129, 2.6, 30, 0.2, 'staple', 'INTERNATIONAL'],
    ['Potato (boiled)', 'serving', '150 g', 116, 3, 26, 0.2, 'staple', 'INTERNATIONAL'],
    ['Pasta (cooked)', 'bowl', '150 g', 221, 7, 43, 1.3, 'staple', 'INTERNATIONAL'],
    ['Whole wheat bread', 'slice', '1 slice', 81, 4, 14, 1.1, 'staple', 'INTERNATIONAL'],
    ['White bread', 'slice', '1 slice', 80, 2.6, 15, 1, 'staple', 'INTERNATIONAL'],
    ['Bagel', 'piece', '1 pc', 289, 11, 56, 1.7, 'staple', 'INTERNATIONAL'],
    ['Tortilla', 'piece', '1 pc', 104, 2.8, 18, 2.7, 'staple', 'INTERNATIONAL'],
    ['Pita', 'piece', '1 pc', 165, 5.5, 33, 0.7, 'staple', 'INTERNATIONAL'],
    ['Popcorn (air-popped)', 'cup', '1 cup', 31, 1, 6, 0.4, 'snack', 'INTERNATIONAL'],
    // --- dairy ---
    ['Milk', 'glass', '200 ml', 122, 6.6, 9.6, 6.6, 'dairy', 'INDIAN'],
    ['Skim milk', 'glass', '200 ml', 68, 6.8, 10, 0.2, 'dairy', 'INDIAN'],
    ['Curd', 'bowl', '100 g', 60, 3, 4, 4, 'dairy', 'INDIAN'],
    ['Greek yogurt', 'cup', '100 g', 59, 10, 3.6, 0.4, 'dairy', 'INTERNATIONAL'],
    ['Buttermilk', 'glass', '200 ml', 80, 4, 8, 2, 'dairy', 'INDIAN'],
    ['Lassi (sweet)', 'glass', '200 ml', 180, 4, 28, 6, 'dairy', 'INDIAN'],
    ['Cheese', 'slice', '1 slice', 84, 5, 0.4, 7, 'dairy', 'INTERNATIONAL'],
    ['Cottage cheese', 'serving', '100 g', 98, 11, 3.4, 4.3, 'dairy', 'INTERNATIONAL'],
    ['Ghee', 'tsp', '1 tsp', 45, 0, 0, 5, 'dairy', 'INDIAN'],
    ['Butter', 'tsp', '1 tsp', 34, 0, 0, 3.8, 'dairy', 'INTERNATIONAL'],
    ['Cream (25%)', 'tbsp', '1 tbsp', 50, 0.3, 0.5, 5.3, 'dairy', 'INTERNATIONAL'],
    // --- fruits ---
    ['Banana', 'piece', '1 pc', 105, 1.3, 27, 0.4, 'fruit', 'INTERNATIONAL'],
    ['Apple', 'piece', '1 pc', 95, 0.5, 25, 0.3, 'fruit', 'INTERNATIONAL'],
    ['Orange', 'piece', '1 pc', 62, 1.2, 15, 0.2, 'fruit', 'INTERNATIONAL'],
    ['Grapes', 'cup', '1 cup', 104, 1.1, 27, 0.2, 'fruit', 'INTERNATIONAL'],
    ['Mango', 'piece', '1 pc', 150, 1.4, 40, 0.9, 'fruit', 'INDIAN'],
    ['Papaya', 'serving', '150 g', 65, 0.8, 16, 0.4, 'fruit', 'INDIAN'],
    ['Watermelon', 'serving', '150 g', 46, 0.9, 11, 0.2, 'fruit', 'INDIAN'],
    ['Pomegranate', 'piece', '1 pc', 234, 4.7, 52, 3.3, 'fruit', 'INDIAN'],
    ['Guava', 'piece', '1 pc', 68, 2.6, 14, 0.9, 'fruit', 'INDIAN'],
    ['Kiwi', 'piece', '1 pc', 42, 0.8, 10, 0.4, 'fruit', 'INTERNATIONAL'],
    ['Pineapple', 'serving', '100 g', 50, 0.5, 13, 0.1, 'fruit', 'INTERNATIONAL'],
    ['Pear', 'piece', '1 pc', 101, 0.6, 27, 0.2, 'fruit', 'INTERNATIONAL'],
    ['Strawberries', 'cup', '1 cup', 49, 1, 12, 0.5, 'fruit', 'INTERNATIONAL'],
    ['Dates', 'piece', '3 pcs', 75, 0.7, 20, 0, 'fruit', 'INDIAN'],
    ['Raisins', 'tbsp', '1 tbsp', 42, 0.4, 11, 0.1, 'fruit', 'INTERNATIONAL'],
    // --- vegetables ---
    ['Spinach (cooked)', 'bowl', '100 g', 23, 3, 3.8, 0.3, 'veggies', 'INTERNATIONAL'],
    ['Broccoli', 'bowl', '100 g', 34, 2.8, 7, 0.4, 'veggies', 'INTERNATIONAL'],
    ['Cauliflower', 'bowl', '100 g', 25, 1.9, 5, 0.3, 'veggies', 'INDIAN'],
    ['Cabbage', 'bowl', '100 g', 25, 1.3, 6, 0.1, 'veggies', 'INDIAN'],
    ['Carrot', 'piece', '1 pc', 25, 0.6, 6, 0.1, 'veggies', 'INDIAN'],
    ['Green beans', 'bowl', '100 g', 31, 1.8, 7, 0.2, 'veggies', 'INDIAN'],
    ['Peas', 'bowl', '100 g', 81, 5.4, 14, 0.4, 'veggies', 'INDIAN'],
    ['Potato (fried)', 'serving', '100 g', 312, 4, 36, 17, 'veggies', 'INTERNATIONAL'],
    ['Onion', 'piece', '1 pc', 44, 1.2, 10, 0.1, 'veggies', 'INDIAN'],
    ['Tomato', 'piece', '1 pc', 22, 1.1, 4.8, 0.2, 'veggies', 'INDIAN'],
    ['Cucumber', 'piece', '1 pc', 45, 2, 11, 0.3, 'veggies', 'INDIAN'],
    ['Capsicum (bell pepper)', 'piece', '1 pc', 25, 1, 6, 0.3, 'veggies', 'INDIAN'],
    ['Brinjal (eggplant)', 'bowl', '100 g', 25, 1, 6, 0.2, 'veggies', 'INDIAN'],
    ['Bottle gourd (lauki)', 'bowl', '100 g', 15, 0.6, 3.4, 0.1, 'veggies', 'INDIAN'],
    ['Pumpkin', 'bowl', '100 g', 26, 1, 6.5, 0.1, 'veggies', 'INDIAN'],
    ['Beetroot', 'serving', '100 g', 43, 1.6, 10, 0.2, 'veggies', 'INDIAN'],
    ['Mushrooms', 'bowl', '100 g', 22, 3.1, 3.3, 0.3, 'veggies', 'INTERNATIONAL'],
    ['Green salad', 'bowl', '100 g', 25, 1, 5, 0.2, 'veggies', 'INTERNATIONAL'],
    ['Avocado', 'piece', '1 pc', 240, 3, 12.8, 22, 'veggies', 'INTERNATIONAL'],
    // --- nuts & seeds ---
    ['Almonds', 'handful', '15 g', 87, 3.2, 3.2, 7.4, 'nuts', 'INTERNATIONAL'],
    ['Walnuts', 'handful', '15 g', 98, 2.3, 2, 9.8, 'nuts', 'INTERNATIONAL'],
    ['Peanuts (roasted)', 'handful', '15 g', 90, 4, 2.4, 7.6, 'nuts', 'INDIAN'],
    ['Cashews', 'handful', '15 g', 88, 2.7, 4.7, 6.9, 'nuts', 'INDIAN'],
    ['Pistachios', 'handful', '15 g', 84, 3.1, 4.3, 6.7, 'nuts', 'INTERNATIONAL'],
    ['Chia seeds', 'tbsp', '1 tbsp', 58, 2, 5, 3.6, 'nuts', 'INTERNATIONAL'],
    ['Flax seeds', 'tbsp', '1 tbsp', 55, 1.9, 3, 4.3, 'nuts', 'INTERNATIONAL'],
    ['Pumpkin seeds', 'tbsp', '1 tbsp', 60, 3, 1.5, 4.5, 'nuts', 'INTERNATIONAL'],
    ['Sunflower seeds', 'tbsp', '1 tbsp', 52, 1.8, 1.8, 4.5, 'nuts', 'INTERNATIONAL'],
    ['Sesame seeds (til)', 'tbsp', '1 tbsp', 52, 1.6, 2.1, 4.4, 'nuts', 'INDIAN'],
    // --- gym / packaged ---
    ['Whey protein', 'scoop', '1 scoop', 120, 24, 3, 2, 'supplement', 'INTERNATIONAL'],
    ['Protein bar', 'bar', '1 bar', 200, 20, 22, 7, 'supplement', 'INTERNATIONAL'],
    ['Granola', 'bowl', '50 g', 240, 5, 34, 9, 'breakfast', 'INTERNATIONAL'],
    ['Muesli', 'bowl', '50 g', 185, 5, 35, 3.5, 'breakfast', 'INTERNATIONAL'],
    ['Cornflakes', 'bowl', '30 g', 111, 2, 25, 0.1, 'breakfast', 'INTERNATIONAL'],
    ['Peanut butter', 'tbsp', '1 tbsp', 94, 4, 3, 8, 'snack', 'INTERNATIONAL'],
    ['Almond butter', 'tbsp', '1 tbsp', 98, 3.4, 3, 9, 'snack', 'INTERNATIONAL'],
    ['Jam', 'tbsp', '1 tbsp', 50, 0.1, 13, 0, 'snack', 'INTERNATIONAL'],
    ['Honey', 'tsp', '1 tsp', 21, 0, 5.8, 0, 'snack', 'INTERNATIONAL'],
    ['Digestive biscuits', 'piece', '2 pcs', 120, 1.7, 17, 5.1, 'snack', 'INTERNATIONAL'],
    ['Cream crackers', 'piece', '3 pcs', 135, 2.8, 20, 4.7, 'snack', 'INTERNATIONAL'],
    ['Khakhra', 'piece', '2 pcs', 110, 3.2, 19, 2.2, 'snack', 'INDIAN'],
    ['Roasted chana', 'handful', '15 g', 55, 3.4, 8, 1, 'snack', 'INDIAN'],
    ['Murmura (puffed rice)', 'bowl', '30 g', 110, 2.5, 24, 0.6, 'snack', 'INDIAN'],
    ['Potato chips', 'serving', '28 g', 152, 2, 15, 10, 'snack', 'INTERNATIONAL'],
    ['Instant noodles (cooked)', 'bowl', '250 g', 385, 8, 60, 14, 'staple', 'INTERNATIONAL'],
    ['Frozen peas', 'bowl', '100 g', 81, 5.4, 14, 0.4, 'veggies', 'INTERNATIONAL'],
    ['Canned beans', 'can', '150 g', 150, 10, 27, 0.6, 'protein', 'INTERNATIONAL'],
    // --- beverages ---
    ['Coconut water', 'glass', '250 ml', 45, 0.5, 9, 0.3, 'drink', 'INDIAN'],
    ['Orange juice', 'glass', '200 ml', 90, 1.4, 21, 0.4, 'drink', 'INTERNATIONAL'],
    ['Apple juice', 'glass', '200 ml', 92, 0.2, 23, 0.2, 'drink', 'INTERNATIONAL'],
    ['Smoothie (fruit)', 'glass', '250 ml', 180, 4, 40, 2, 'drink', 'INTERNATIONAL'],
    ['Green tea', 'cup', '1 cup', 2, 0, 0.5, 0, 'drink', 'INTERNATIONAL'],
    ['Black coffee', 'cup', '1 cup', 2, 0.3, 0, 0, 'drink', 'INTERNATIONAL'],
    ['Cold coffee', 'glass', '250 ml', 180, 5, 28, 6, 'drink', 'INDIAN'],
    ['Cola (soft drink)', 'glass', '330 ml', 139, 0, 35, 0, 'drink', 'INTERNATIONAL'],
    ['Lemonade', 'glass', '250 ml', 90, 0.1, 23, 0, 'drink', 'INDIAN'],
    ['Sports drink', 'bottle', '500 ml', 120, 0, 30, 0, 'drink', 'INTERNATIONAL']
  ];
  const FOOD_ALIASES = {
    'Paneer': ['cottage cheese', 'chhena', 'paneer (indian)'],
    'Roti': ['phulka', 'phulki', 'roti (wheat)'],
    'Whole wheat chapati': ['chapati', 'chapatti', 'phulka roti'],
    'Egg': ['eggs', 'whole egg', 'boiled egg'],
    'Chicken breast': ['chicken', 'grilled chicken', 'chicken breast fillet'],
    'Rice (cooked)': ['white rice', 'steamed rice', 'rice', 'plain rice'],
    'Dal': ['dal', 'lentils', 'lentil curry'],
    'Curd': ['dahi', 'yogurt', 'yoghurt'],
    'Oats': ['oatmeal', 'porridge', 'oats (rolled)'],
    'Milk': ['whole milk', 'toned milk', 'buffalo milk'],
    'Peanut butter': ['groundnut butter', 'pb'],
    'Sweet potato': ['shakarkand', 'sweet potatoes'],
    'Whey protein': ['protein shake', 'whey', 'whey shake', 'protien shake'],
    'Chana': ['chickpeas', 'chole', 'garbanzo beans', 'kabuli chana'],
    'Rajma': ['kidney beans', 'rajma chawal'],
    'Sprouts': ['moong sprouts', 'sprouted moong'],
    'Coconut water': ['nariyal pani', 'tender coconut water'],
    'Banana': ['kela', 'bananas'],
    'Apple': ['seb', 'apples'],
    'Almonds': ['badam', 'almond', 'badaam'],
    'Walnuts': ['akhrot', 'walnut'],
    'Cashews': ['kaju', 'cashew'],
    'Pistachios': ['pista', 'pistachio'],
    'Pomegranate': ['anar', 'pomegranates'],
    'Guava': ['amrood', 'guavas'],
    'Samosa': ['samosas'],
    'Idli': ['idlis', 'idly'],
    'Dosa': ['dosas', 'dosa plain'],
    'Buttermilk': ['chaas', 'chhach', 'mattha'],
    'Greek yogurt': ['greek yoghurt', 'strained yogurt'],
    'Tofu': ['bean curd', 'soy paneer'],
    'Soya chunks': ['soy chunks', 'textured vegetable protein', 'tvp'],
    'Mango': ['aam', 'mangoes'],
    'Papaya': ['papita', 'papayas'],
    'Watermelon': ['tarbooj', 'water melon'],
    'Honey': ['shahad', 'honey (natural)'],
    'Dates': ['khajoor', 'date'],
    'Green tea': ['green chai'],
    'Black coffee': ['coffee', 'black chai'],
    'Whole wheat bread': ['brown bread', 'wheat bread', 'multigrain bread'],
    'Protein bar': ['protein bars', 'nutrition bar'],
    'Granola': ['granola cereal'],
    'Poha': ['poha (flattened rice)', 'aval'],
    'Sambar': ['sambhar'],
    'Paratha (plain)': ['paratha', 'parantha'],
    'Potato (boiled)': ['aloo', 'boiled potato', 'potato'],
    'Peas': ['matar', 'green peas'],
    'Cauliflower': ['gobhi', 'phool gobhi'],
    'Spinach (cooked)': ['palak', 'saag', 'spinach'],
    'Brinjal (eggplant)': ['baingan', 'eggplant'],
    'Bottle gourd (lauki)': ['lauki', 'doodhi', 'bottle gourd'],
    'Pumpkin': ['kaddu', 'pumpkin (yellow)'],
    'Carrot': ['gajar', 'carrots'],
    'Tomato': ['tamatar', 'tomatoes'],
    'Onion': ['pyaaz', 'onions'],
    'Cucumber': ['kheera', 'cucumbers'],
    'Mushrooms': ['mushroom', 'button mushroom'],
    'Avocado': ['avacado', 'butter fruit'],
    'Salmon': ['rawas', 'salmon fish'],
    'Fish (rohu)': ['rohu', 'fish curry'],
    'Chicken tikka': ['tikka', 'chicken tikka pieces'],
    'Biryani (chicken)': ['chicken biryani', 'biryani']
  };
  // food-specific grams-per-piece (used by the unit engine when the
  // client logs "2 rotis" / "1 egg" — food metadata beats generic defaults)
  const PIECE_G = {
    'Roti': 35, 'Whole wheat chapati': 40, 'Dosa': 70, 'Uttapam': 80, 'Paratha (plain)': 120,
    'Aloo paratha': 130, 'Samosa': 50, 'Kachori': 35, 'Medu vada': 35, 'Jowar roti': 35,
    'Bajra roti': 35, 'Egg': 52, 'Egg white': 30, 'Banana': 118, 'Apple': 150, 'Orange': 130,
    'Mango': 200, 'Pomegranate': 155, 'Guava': 100, 'Kiwi': 75, 'Pear': 160, 'Strawberries': 12,
    'Dates': 8, 'Carrot': 70, 'Onion': 110, 'Tomato': 90, 'Cucumber': 150, 'Capsicum (bell pepper)': 120,
    'Avocado': 150, 'Bagel': 100, 'Tortilla': 60, 'Pita': 60, 'Whole wheat bread': 30, 'White bread': 28,
    'Cheese': 20, 'Digestive biscuits': 10, 'Cream crackers': 9, 'Khakhra': 8, 'Protein bar': 60,
    'Idli': 40, 'Biryani (chicken)': 300
  };
  for (const [name, unit, serving, cal, p, c, f, cat, cuisine] of GLOBAL_FOODS) {
    await db.run(
      `INSERT INTO foods (id, org_id, client_id, name, unit, serving, piece_g, calories, protein, carbs, fat, category, cuisine, source, is_global)
       VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'VERIFIED_DATABASE', 1)`,
      [id('food'), name, unit, serving, PIECE_G[name] ?? null, cal, p, c, f, cat, cuisine]);
    const aliases = FOOD_ALIASES[name] || [];
    for (const alias of aliases) {
      if (!alias) continue;
      const frow = await db.q1('SELECT id FROM foods WHERE name = ? AND is_global = 1', [name]);
      if (frow) {
        await db.run('INSERT INTO food_aliases (id, org_id, food_id, alias) VALUES (?, NULL, ?, ?)', [id('fal'), frow.id, alias]);
      }
    }
  }

  // ---- attendance events → live crowd (entries/exits through the day, never biometrics) ----
  const evDate = dayKey(new Date(), 'Asia/Kolkata');
  const members = await db.q('SELECT id FROM clients WHERE org_id = ?', [orgId]);
  if (members.length) {
    const events = [];
    for (let i = 0; i < 140; i++) { // 140 entries
      const c = members[Math.floor(rnd() * members.length)];
      const h = 5 + Math.floor(rnd() * 15); // 05:00–19:59
      events.push([id('ate'), orgId, c.id, `${evDate}T${String(h).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}:00`, 'entry']);
    }
    for (let i = 0; i < 28; i++) { // 28 exits → ~112 currently inside
      const c = members[Math.floor(rnd() * members.length)];
      const h = 8 + Math.floor(rnd() * 13);
      events.push([id('ate'), orgId, c.id, `${evDate}T${String(h).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}:00`, 'exit']);
    }
    for (const e of events) {
      await db.run('INSERT INTO attendance_events (id, org_id, client_id, ts, direction) VALUES (?, ?, ?, ?, ?)', e);
    }
  }

  // ---- Rahul's personal customization (metrics, my foods, my meals) ----
  if (rahul) {
    const mk = async (name, unit, frequency, target) => {
      const mId = id('mtr');
      await db.run(
        'INSERT INTO custom_metrics (id, org_id, client_id, name, unit, frequency, target, created_at) VALUES (?,?,?,?,?,?,?,?)',
        [mId, orgId, rahul.id, name, unit, frequency, target, now()]);
      return mId;
    };
    const addEntry = async (mId, value, daysBack, notes) => {
      await db.run(
        'INSERT INTO metric_entries (id, org_id, client_id, metric_id, value, date, notes, created_at) VALUES (?,?,?,?,?,?,?,?)',
        [id('men'), orgId, rahul.id, mId, value, daysAgo(daysBack).toISOString().slice(0, 10), notes || null, now()]);
    };
    const waist = await mk('Waist', 'cm', 'weekly', 90);
    for (const [i, v] of [[98, 21], [97.2, 14], [96, 7], [94.8, 0]].entries()) await addEntry(waist, v[0], v[1], i === 3 ? 'Friday check-in' : null);
    const steps = await mk('Daily Steps', 'steps', 'daily', 10000);
    for (const [i, v] of [7600, 10300, 8900, 12100, 9800, 11200, 8600].entries()) await addEntry(steps, v, 6 - i);
    const bench = await mk('Bench Press', 'kg', 'weekly', 80);
    for (const [i, v] of [60, 62.5, 65].entries()) await addEntry(bench, v, 14 - i * 7);
    // my foods
    await db.run(
      `INSERT INTO foods (id, org_id, client_id, name, unit, serving, calories, protein, carbs, fat, category, is_global)
       VALUES (?,?,?,?,?,?,?,?,?,?,'meal',0)`,
      [id('food'), orgId, rahul.id, 'Home-style Poha', 'bowl', '150 g', 250, 7, 40, 7]);
    await db.run(
      `INSERT INTO foods (id, org_id, client_id, name, unit, serving, calories, protein, carbs, fat, category, is_global)
       VALUES (?,?,?,?,?,?,?,?,?,?,'snack',0)`,
      [id('food'), orgId, rahul.id, 'Peanut Butter Toast', 'slice', '1 slice', 180, 6, 16, 11]);
    // my meal templates
    const mt1 = id('cmt');
    await db.run(
      `INSERT INTO client_meal_templates (id, org_id, client_id, slot, name, time, calories, protein, carbs, fat, foods, position)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0)`,
      [mt1, orgId, rahul.id, 'Meal 1', 'Morning oats + milk', '08:00', 320, 12, 48, 8, '50g oats · 200ml milk · banana']);
    const mt2 = id('cmt');
    await db.run(
      `INSERT INTO client_meal_templates (id, org_id, client_id, slot, name, time, calories, protein, carbs, fat, foods, position)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
      [mt2, orgId, rahul.id, 'Snack', 'Peanut butter toast', '17:00', 180, 6, 16, 11, '1 slice whole wheat · 1 tbsp peanut butter']);
    // meal items — compose breakfast from real foods (meal → foods → quantity → computed macros)
    const oats = await db.q1(`SELECT id, calories, protein, carbs, fat FROM foods WHERE name = 'Oats' AND is_global = 1 LIMIT 1`);
    if (oats) {
      await db.run(
        `INSERT INTO meal_items (id, meal_template_id, food_id, name, quantity, unit, calories, protein, carbs, fat, position)
         VALUES (?,?,?,?,?,?,?,?,?,?,0)`,
        [id('mi'), mt1, oats.id, 'Oats', 1, '50 g', oats.calories || 0, oats.protein || 0, oats.carbs || 0, oats.fat || 0]);
      // recompute the template totals from its items (meal → foods → computed macros)
      const totals = await db.q1(
        'SELECT SUM(calories) c, SUM(protein) p, SUM(carbs) ca, SUM(fat) f FROM meal_items WHERE meal_template_id = ?', [mt1]);
      await db.run('UPDATE client_meal_templates SET calories = ?, protein = ?, carbs = ?, fat = ? WHERE id = ?',
        [totals?.c || 0, totals?.p || 0, totals?.ca || 0, totals?.f || 0, mt1]);
    }
    // my reusable workouts + weekly schedule (the personal planner)
    const pickEx = async (names) => {
      const ph = names.map(() => '?').join(',');
      return db.q(`SELECT id, name, primary_muscle, equipment, animation_key FROM exercise_library WHERE name IN (${ph}) AND (is_global = 1 OR org_id = ?) LIMIT 6`, [...names, orgId]);
    };
    const mkWorkout = async (name, names) => {
      const wId = id('cw');
      await db.run('INSERT INTO client_workouts (id, org_id, client_id, name, created_at) VALUES (?,?,?,?,?)', [wId, orgId, rahul.id, name, now()]);
      const exs = await pickEx(names);
      for (const [i, ex] of exs.entries()) {
        const key = ex.animation_key;
        const base = key && BASE_W[key] != null ? BASE_W[key] : 0;
        const weight = base > 0 ? `${base} kg` : 'BW';
        const reps = ['plank', 'dead_hang'].includes(key) ? '45 sec' : key === 'russian_twist' ? '20' : '10';
        const rest = ['plank', 'dead_hang', 'dead_bug', 'russian_twist'].includes(key) ? 45 : 90;
        await db.run(
          `INSERT INTO client_workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [id('cwe'), wId, ex.id, i, ex.name, 3, reps, weight, rest]);
      }
      return wId;
    };
    const pushA = await mkWorkout('Push A', ['Bench Press', 'Overhead Press', 'Lateral Raise', 'Triceps Pushdown']);
    const pullA = await mkWorkout('Pull A', ['Lat Pulldown', 'Seated Cable Row', 'Bicep Curl', 'Dumbbell Row']);
    const legsA = await mkWorkout('Legs A', ['Back Squat', 'Leg Press', 'Romanian Deadlift', 'Hip Thrust']);
    const backA = await mkWorkout('Back A', ['Lat Pulldown', 'Barbell Row', 'Seated Cable Row', 'Face Pull', 'Dead Hang']);
    const coreA = await mkWorkout('Core A', ['Plank', 'Cable Crunch', 'Hanging Leg Raise', 'Russian Twist', 'Dead Bug']);
    const legsB = await mkWorkout('Legs B', ['Front Squat', 'Leg Press', 'Leg Curl', 'Standing Calf Raise']);
    // planner schedule: 0=Mon..6=Sun — every training day + dedicated back/core days
    const sched = [
      [0, pushA], [1, pullA], [2, legsA], [3, backA],
      [4, pushA], [5, legsB], [6, coreA]
    ];
    for (const [dow, wid] of sched) {
      if (wid) await db.run('INSERT INTO client_workout_schedule (client_id, day_of_week, workout_id) VALUES (?,?,?)', [rahul.id, dow, wid]);
    }
  }

  // ---- alerts from the rule engine ----
  await evaluateOrg(db, orgId);

  console.log('Seeded IRONFORGE FITNESS:');
  console.log(`  org: ${orgId}`);
  console.log(`  trainers: ${TRAINER_NAMES.length} (${trainerIds.join(', ')})`);
  console.log(`  clients: ${CLIENTS.length}`);
  console.log('  logins (password demo1234):');
  console.log('    owner@ironforge.in   — GYM_OWNER (Maya Kapoor)');
  for (const [email] of TRAINERS) console.log(`    ${email} — TRAINER`);
  console.log('    client1@ironforge.in — CLIENT (Rahul Sharma)');
  console.log('    client4@ironforge.in — CLIENT (Neha Gupta)');
}
const TRAINER_NAMES = TRAINERS.map(t => t[1]);
main().catch(e => { console.error(e); process.exit(1); });
