// ============================================================
// DEMO SEED — BADASS BUILDERS (temporary, isolated Community test gym)
//
// Creates ONE new, fully isolated organization for testing the Community
// feature with real friends/testers, using the exact same architecture
// every other gym on this platform uses:
//   - organizations / users / clients / client_profiles / trainers — the
//     same tables and columns real signup creates.
//   - workout_logs (legacy aggregate history) seeded directly, exactly the
//     way seed.js seeds IRONFORGE's own demo clients. personal_records is
//     deliberately left EMPTY: it is not a seed-time input anywhere in this
//     codebase (grep seed.js — it never touches that table either) because
//     evaluatePRs()'s historyBaseline() already bridges real workout_logs
//     history into a correct PR the moment a client completes a NEW real
//     workout. Hand-writing personal_records rows here would bypass that
//     derivation, which is exactly what the existing convention avoids.
//   - community_members / community_workout_shares — populated by calling
//     the REAL service functions (setMembership, shareWorkout) from
//     services/community.js, not by hand-inserting rows. This is the one
//     piece with real derivation logic (payload snapshotting), so it goes
//     through the same code every client's own "Share" button calls.
//
// IMPORTANT — what THIS demo's "Community" actually is: this codebase's
// Community feature is opt-in workout-SHARING + leaderboards (streak /
// volume / completed-workout-count), org-scoped, privacy-first (default
// OFF). There is no likes/comments/reactions/follows system anywhere in
// the schema or service layer — this seed does not invent one.
//
// IDEMPOTENT: guarded on the 'badass-builders-demo' org slug, the exact
// same pattern seed.js itself uses for 'ironforge-fitness' ("already
// seeded, refuse and exit 0"). Running this twice creates nothing extra.
//
// Run:  node backend/scripts/seed-badass-builders.js
//   or: npm run db:seed:badass-builders
// ============================================================
import { getDb } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { id, now } from '../src/ids.js';
import { dayKey, daysAgo } from '../src/utils/time.js';
import { snapshotAdherence } from '../src/services/adherence.js';
import { setMembership, shareWorkout } from '../src/services/community.js';

const SLUG = 'badass-builders-demo';
const ORG_NAME = 'Badass Builders';

// ---- deterministic RNG (same generator seed.js uses, different seed so the
// two demo gyms' "random" data can never collide) ----
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260911);
const jitter = (base, amt) => Math.round((base + (rnd() - 0.5) * 2 * amt) * 10) / 10;

// Exercise keys already seeded GLOBALLY (is_global=1, org_id=NULL) by the
// first `npm run db:seed`/`db:init` on this database — the exercise library
// is shared across every org, so this demo reuses it rather than creating
// duplicate rows. If a fresh, never-seeded database runs THIS script first
// (no Ironforge seed yet), the lookup below simply finds nothing for that
// key and the exercise is skipped for that client — clients still get
// created correctly, just with a thinner workout history.
const EXERCISE_KEYS = [
  'bench_press', 'squat', 'deadlift', 'shoulder_press', 'lat_pulldown',
  'dumbbell_row', 'bicep_curl', 'leg_press', 'hip_thrust', 'push_up',
  'plank', 'romanian_deadlift', 'lateral_raise', 'seated_row', 'lunges',
];

// name, email, age, sex, goal, startWeight, targetWeight, heightCm,
// [exercise keys this client trains], weight series (kg, oldest -> newest)
const CLIENTS = [
  ['Aarav Mehta', 'aarav@badassbuilders.demo', 28, 'M', 'FAT_LOSS', 82, 78, 175,
    ['bench_press', 'squat', 'deadlift', 'plank'], [82, 81, 80.5, 79.8]],
  ['Rohan Sharma', 'rohan@badassbuilders.demo', 25, 'M', 'MUSCLE_GAIN', 74, 80, 178,
    ['bench_press', 'shoulder_press', 'bicep_curl', 'lat_pulldown'], [74, 75, 73.8, 73.2]],
  ['Arjun Kapoor', 'arjun@badassbuilders.demo', 31, 'M', 'STRENGTH', 88, 92, 180,
    ['squat', 'deadlift', 'bench_press', 'romanian_deadlift'], [88, 88.4, 88.9, 89.3]],
  ['Kabir Singh', 'kabir@badassbuilders.demo', 24, 'M', 'GENERAL', 70, 70, 172,
    ['push_up', 'lunges', 'seated_row', 'plank'], [70, 69.8, 70.1, 69.9]],
  ['Vihaan Patel', 'vihaan@badassbuilders.demo', 29, 'M', 'FAT_LOSS', 95, 85, 176,
    ['leg_press', 'lat_pulldown', 'hip_thrust', 'bench_press'], [95, 93.5, 92.8, 91.6]],
  ['Aditya Rao', 'aditya@badassbuilders.demo', 27, 'M', 'MUSCLE_GAIN', 68, 76, 170,
    ['deadlift', 'shoulder_press', 'lateral_raise', 'bicep_curl'], [68, 68.6, 69.2, 69.9]],
];

const MEALS = [
  ['breakfast', 'Oats with banana and peanut butter', 420, 18, 55, 14],
  ['lunch', 'Grilled chicken, rice and dal', 650, 45, 70, 16],
  ['dinner', 'Paneer bhurji with roti', 540, 28, 48, 22],
  ['snack', 'Greek yogurt with almonds', 220, 16, 12, 11],
];

async function main() {
  const db = await getDb();

  const existing = await db.q1('SELECT id FROM organizations WHERE slug = ?', [SLUG]);
  if (existing) {
    console.log(`Badass Builders already seeded (org ${existing.id}, slug '${SLUG}'). Nothing to do.`);
    console.log('This script is idempotent by design — re-running it never creates duplicate users or data.');
    process.exit(0);
  }

  const orgId = id('org');
  await db.run(
    `INSERT INTO organizations (id, name, slug, type, created_at) VALUES (?, ?, ?, 'gym', ?)`,
    [orgId, ORG_NAME, SLUG, now()]);
  await db.run(
    `INSERT INTO gym_settings (org_id, brand_name, tagline, updated_at) VALUES (?, ?, ?, ?)`,
    [orgId, ORG_NAME, 'Temporary demo workspace — Community feature testing', now()]);

  // ---- owner ----
  const ownerId = id('usr');
  await db.run(
    `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
     VALUES (?, ?, ?, ?, 'GYM_OWNER', 'Badass Owner', 1, ?)`,
    [ownerId, orgId, 'owner@badassbuilders.demo', await hashPassword('Badass123'), now()]);

  // ---- trainer ----
  const trainerId = id('usr');
  await db.run(
    `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
     VALUES (?, ?, ?, ?, 'TRAINER', 'Demo Trainer', 1, ?)`,
    [trainerId, orgId, 'trainer@badassbuilders.demo', await hashPassword('Trainer123'), now()]);
  await db.run(
    `INSERT INTO trainers (user_id, org_id, specialization, max_clients) VALUES (?, ?, 'GENERAL FITNESS', 50)`,
    [trainerId, orgId]);

  // Resolve the shared global exercise library once.
  const exByKey = new Map();
  for (const key of EXERCISE_KEYS) {
    const row = await db.q1('SELECT id, name FROM exercise_library WHERE animation_key = ? AND is_global = 1', [key]);
    if (row) exByKey.set(key, row);
  }

  const clientIds = [];
  let firstCompletedWorkoutId = null; // used later to demonstrate a community share

  for (const [name, email, age, sex, goal, startW, targetW, height, exerciseKeys, weights] of CLIENTS) {
    const uid = id('usr');
    const cid = id('cli');
    const signedUp = dayKey(daysAgo(30));
    await db.run(
      `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
       VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
      [uid, orgId, email, await hashPassword('Demo123'), name, signedUp + 'T09:00:00Z']);

    const currentW = weights[weights.length - 1];
    await db.run(
      `INSERT INTO clients
         (id, user_id, org_id, trainer_id, status, goal, start_weight, current_weight, target_weight,
          goal_date, height_cm, age, sex, last_checkin_at, onboarding_completed, created_at)
       VALUES (?, ?, ?, ?, 'ON_TRACK', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [cid, uid, orgId, trainerId, goal, startW, currentW, targetW,
       dayKey(daysAgo(-90)), height, age, sex, now(), signedUp + 'T09:00:00Z']);

    await db.run(
      `INSERT INTO client_profiles (client_id, diet_type, cuisine, meals_per_day, sleep_target_h, water_target_l, equipment, experience)
       VALUES (?, 'NON_VEG', 'INDIAN', 4, 8, 3, 'full_gym', 'INTERMEDIATE')`,
      [cid]);

    clientIds.push({ cid, uid, name, email });

    // ---- weight history: one entry per week, ending ~3 days ago ----
    const weekSpacing = 7;
    for (let i = 0; i < weights.length; i++) {
      const daysBack = (weights.length - 1 - i) * weekSpacing + 3;
      await db.run(
        `INSERT INTO weight_logs (id, client_id, date, weight, source, created_at) VALUES (?, ?, ?, ?, 'manual', ?)`,
        [id('wlg'), cid, dayKey(daysAgo(daysBack)), weights[i], now()]);
    }
    await db.run('UPDATE clients SET current_weight = ? WHERE id = ?', [currentW, cid]);

    // ---- workout history: 6 sessions over the last 3 weeks, varied
    // exercises/weights per client so no two clients' history is identical.
    // workout_logs (legacy aggregate) is what evaluatePRs()'s
    // historyBaseline() reads — seeded directly here, matching the exact
    // convention seed.js itself uses for Ironforge's clients. personal_records
    // is deliberately NOT written here (see file header).
    const sessionCount = 6;
    let lastCompletedWorkoutId = null;
    for (let s = 0; s < sessionCount; s++) {
      const daysBack = (sessionCount - 1 - s) * 3 + 1; // every ~3 days, most recent yesterday
      const date = dayKey(daysAgo(daysBack));
      const wId = id('wko');
      const isLast = s === sessionCount - 1;
      await db.run(
        `INSERT INTO workouts (id, org_id, template_id, client_id, trainer_id, name, day_label, scheduled_date, status, completed_at, duration_min, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`,
        [wId, orgId, cid, trainerId, `${name.split(' ')[0]}'s session ${s + 1}`, 'Demo Session', date,
         date + 'T18:30:00Z', 45 + Math.round(rnd() * 20), now()]);

      for (const key of exerciseKeys) {
        const ex = exByKey.get(key);
        if (!ex) continue;
        const wxId = id('wxe');
        const sets = 3;
        const reps = 6 + Math.floor(rnd() * 6);
        // Progressive overload across sessions: later sessions are a little
        // heavier, with natural jitter — realistic, not identical every time.
        const baseWeight = { bench_press: 50, squat: 60, deadlift: 70, shoulder_press: 30,
          lat_pulldown: 45, dumbbell_row: 20, bicep_curl: 12, leg_press: 90, hip_thrust: 55,
          push_up: 0, plank: 0, romanian_deadlift: 55, lateral_raise: 8, seated_row: 40, lunges: 15,
        }[key] ?? 20;
        const weight = baseWeight > 0 ? Math.max(0, jitter(baseWeight + s * 1.5, 2)) : 0;
        await db.run(
          `INSERT INTO workout_exercises (id, workout_id, template_id, exercise_id, position, name, sets, reps, weight, rest_sec)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 90)`,
          [wxId, wId, ex.id, exerciseKeys.indexOf(key), ex.name, sets, String(reps), weight > 0 ? `${weight}kg` : 'BW']);
        await db.run(
          `INSERT INTO workout_logs (id, client_id, workout_id, exercise_id, date, sets_done, reps, weight, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id('wlg'), cid, wId, ex.id, date, sets, reps, weight, now()]);
      }
      lastCompletedWorkoutId = wId;
      if (!firstCompletedWorkoutId) firstCompletedWorkoutId = wId;
      if (isLast) lastCompletedWorkoutId = wId;
    }

    // ---- nutrition: custom-logged meals for the last 4 days ----
    for (let d = 3; d >= 0; d--) {
      const date = dayKey(daysAgo(d));
      for (const [slot, mealName, cal, protein, carbs, fat] of MEALS) {
        const eaten = rnd() < 0.75;
        await db.run(
          `INSERT INTO meal_logs (id, client_id, meal_id, date, slot, name, calories, protein, carbs, fat, eaten, source, estimate)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 0)`,
          [id('mlg'), cid, date, slot, mealName, cal, protein, carbs, fat, eaten ? 1 : 0]);
      }
    }

    // ---- attendance: check-ins on workout days + a couple of extra visits ----
    for (let d = 0; d < 18; d++) {
      if (rnd() < 0.55) {
        await db.run('INSERT INTO attendance (id, org_id, client_id, date, present) VALUES (?, ?, ?, ?, 1)',
          [id('att'), orgId, cid, dayKey(daysAgo(d))]);
      }
    }

    // ---- adherence snapshot (real computation, existing service) ----
    await snapshotAdherence(db, cid);

    // ---- community: opt in via the real service function ----
    await setMembership(db, cid, orgId, true);

    // stash for the sharing pass below
    CLIENTS[CLIENTS.findIndex((c) => c[1] === email)].lastWorkoutId = lastCompletedWorkoutId;
  }

  // ---- community feed: share a few real completed workouts, via the
  // actual shareWorkout() service (payload snapshot, not a hand-rolled row) ----
  let sharesCreated = 0;
  for (let i = 0; i < clientIds.length; i += 2) { // every other client shares — realistic, not everyone posts
    const { cid, name } = clientIds[i];
    const wId = CLIENTS[i].lastWorkoutId;
    if (!wId) continue;
    const result = await shareWorkout(db, { clientId: cid, orgId, workoutId: wId });
    if (result) {
      sharesCreated++;
      console.log(`  shared: ${name} -> "${result.workoutName}"`);
    }
  }

  console.log('');
  console.log(`Badass Builders demo gym created.`);
  console.log(`  org: ${orgId} (slug: ${SLUG})`);
  console.log(`  owner: owner@badassbuilders.demo`);
  console.log(`  trainer: trainer@badassbuilders.demo`);
  console.log(`  clients: ${clientIds.length}`);
  console.log(`  community shares created: ${sharesCreated}`);
  console.log('  password: Badass123 (owner) / Trainer123 (trainer) / Demo123 (all clients)');

  await db.close?.();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
