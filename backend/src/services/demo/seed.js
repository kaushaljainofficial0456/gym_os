// ============================================================
// CANONICAL DEMO TENANT SEED -- "BeFitter", owned by Kirthi.
//
// Builds a REAL gym: normal organizations/users/clients/workouts/
// nutrition_plans/community rows that every existing route in this
// codebase already reads. There is no demo branch inside the product --
// the owner dashboard's "87 members" is a COUNT over 87 real client rows,
// the leaderboard sorts real workout_logs, and the revenue chart sums
// real payments. That is the whole design: if a number here were
// fabricated, the prospect would be looking at a brochure, not the
// product (spec 31).
//
// REPRODUCIBLE, NOT RANDOM: every value comes from a seeded PRNG with a
// fixed seed, so the same roster, the same weights and the same
// leaderboard order come back every time this runs. "Reset Demo Data"
// (spec 29) is therefore literally re-running this function -- there is
// no separate restore path that could drift from what the seeder
// produces.
//
// DATES ARE RELATIVE TO TODAY on purpose. A demo seeded in March must not
// show a prospect in September an attendance chart that stops six months
// ago, so history is generated backwards from the current date. That is
// the one thing about the output that legitimately changes between runs.
//
// SAFETY: every write in this file is keyed to an organization row
// carrying is_demo = 1, and resetDemoTenant() refuses to delete anything
// from an org that does not. A real customer's gym cannot be reached by
// this code even if it were called with their slug.
// ============================================================
import { id, now, dateKey } from '../../ids.js';
import { hashPassword } from '../../auth.js';
import { evaluateClients } from '../atRisk.js';
import { DEMO_PERSONAS, DEMO_EMAIL_DOMAIN } from './personas.js';
import {
  MALE_FIRST_NAMES, FEMALE_FIRST_NAMES, SURNAMES, DEMO_TRAINERS,
  COMMUNITY_POSTS, COMMUNITY_COMMENTS,
} from './names.js';

export const DEMO_ORG_SLUG = 'befitter-demo';
export const DEMO_GYM_NAME = 'BeFitter';
export const DEMO_OWNER_NAME = 'Kirthi';
const MEMBER_COUNT = 87;

// ---------- deterministic randomness ----------
// mulberry32: small, fast, and -- the only property that matters here --
// identical on every platform and every run for a given seed. Math.random
// would make "reset to canonical seed" a lie.
function makeRng(seed = 0x5ec0de) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const between = (rng, lo, hi) => lo + rng() * (hi - lo);
const intBetween = (rng, lo, hi) => Math.floor(between(rng, lo, hi + 1));
const round1 = (n) => Math.round(n * 10) / 10;

// ---------- date helpers ----------
const DAY_MS = 86_400_000;
const daysAgo = (n, base = Date.now()) => new Date(base - n * DAY_MS);
const isoDaysAgo = (n, base = Date.now()) => daysAgo(n, base).toISOString();
const keyDaysAgo = (n, base = Date.now()) => dateKey(daysAgo(n, base));

/** Chunked multi-row INSERT. The alternative -- one db.run() per row --
 *  is ~40,000 round trips against Neon for a full seed, which turns a
 *  few seconds into several minutes and makes "Reset Demo Data" feel
 *  broken. Chunked so no single statement approaches PostgreSQL's
 *  65,535-parameter ceiling. Placeholders stay `?`; db.js's translateSql
 *  rewrites them to $n for PG, so this works unchanged on both drivers. */
async function insertMany(db, table, columns, rows) {
  if (!rows.length) return;
  const cols = columns.join(', ');
  const perRow = columns.length;
  const maxRowsPerStatement = Math.max(1, Math.floor(800 / perRow));
  for (let i = 0; i < rows.length; i += maxRowsPerStatement) {
    const chunk = rows.slice(i, i + maxRowsPerStatement);
    const values = chunk.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
    const params = chunk.flat();
    await db.run(`INSERT INTO ${table} (${cols}) VALUES ${values}`, params);
  }
}

/** Delete, tolerating a table that does not exist on this database yet.
 *  The demo tables are applied by init-db.js like everything else, but a
 *  reset must not abort halfway through because one optional feature's
 *  table (say health_records) was never created on a lean deployment. */
async function safeDelete(db, sql, params) {
  try { await db.run(sql, params); } catch { /* table absent on this deployment */ }
}

// ============================================================
// THE GLOBAL EXERCISE LIBRARY the demo's workouts point at.
//
// Uses whatever global library already exists (npm run db:seed installs a
// large one). On a database that only ever got db:init, the library is
// empty and the demo would have workouts referencing nothing -- so this
// installs a small global set itself, keyed by animation_key so it can
// never double-insert alongside the real seeder's rows.
// ============================================================
const FALLBACK_EXERCISES = [
  ['Barbell Back Squat', 'quads', 'glutes,hamstrings', 'barbell', 'squat', 'INTERMEDIATE', 'barbell_back_squat'],
  ['Barbell Deadlift', 'hamstrings', 'glutes,back', 'barbell', 'hinge', 'INTERMEDIATE', 'barbell_deadlift'],
  ['Barbell Bench Press', 'chest', 'triceps,shoulders', 'barbell', 'horizontal_push', 'INTERMEDIATE', 'barbell_bench_press'],
  ['Overhead Press', 'shoulders', 'triceps', 'barbell', 'vertical_push', 'INTERMEDIATE', 'overhead_press'],
  ['Barbell Row', 'back', 'biceps', 'barbell', 'horizontal_pull', 'INTERMEDIATE', 'barbell_row'],
  ['Lat Pulldown', 'back', 'biceps', 'machine', 'vertical_pull', 'BEGINNER', 'lat_pulldown'],
  ['Dumbbell Shoulder Press', 'shoulders', 'triceps', 'dumbbell', 'vertical_push', 'BEGINNER', 'db_shoulder_press'],
  ['Dumbbell Bench Press', 'chest', 'triceps', 'dumbbell', 'horizontal_push', 'BEGINNER', 'db_bench_press'],
  ['Romanian Deadlift', 'hamstrings', 'glutes', 'barbell', 'hinge', 'INTERMEDIATE', 'romanian_deadlift'],
  ['Walking Lunge', 'quads', 'glutes', 'dumbbell', 'lunge', 'BEGINNER', 'walking_lunge'],
  ['Leg Press', 'quads', 'glutes', 'machine', 'squat', 'BEGINNER', 'leg_press'],
  ['Seated Cable Row', 'back', 'biceps', 'cable', 'horizontal_pull', 'BEGINNER', 'seated_cable_row'],
  ['Pull-up', 'back', 'biceps', 'bodyweight', 'vertical_pull', 'ADVANCED', 'pull_up'],
  ['Push-up', 'chest', 'triceps', 'bodyweight', 'horizontal_push', 'BEGINNER', 'push_up'],
  ['Plank', 'core', '', 'bodyweight', 'core', 'BEGINNER', 'plank'],
  ['Bicep Curl', 'biceps', '', 'dumbbell', 'isolation', 'BEGINNER', 'bicep_curl'],
  ['Triceps Rope Pushdown', 'triceps', '', 'cable', 'isolation', 'BEGINNER', 'triceps_pushdown'],
  ['Lateral Raise', 'shoulders', '', 'dumbbell', 'isolation', 'BEGINNER', 'lateral_raise'],
  ['Hip Thrust', 'glutes', 'hamstrings', 'barbell', 'hinge', 'BEGINNER', 'hip_thrust'],
  ['Treadmill Intervals', 'cardio', '', 'machine', 'core', 'BEGINNER', 'treadmill_intervals'],
];

async function ensureExerciseLibrary(db) {
  const existing = await db.q(
    'SELECT id, name, animation_key, primary_muscle FROM exercise_library WHERE is_global = 1 OR org_id IS NULL');
  if (existing.length >= 12) return existing;
  const rows = [];
  const byKey = new Map(existing.map((e) => [e.animation_key, e]));
  for (const [name, primary, secondary, equip, movement, difficulty, key] of FALLBACK_EXERCISES) {
    if (byKey.has(key)) continue;
    rows.push([id('exl'), null, name, primary, secondary || null, equip,
      equip === 'bodyweight' ? 'bodyweight' : equip === 'machine' ? 'machine' : 'compound',
      movement, difficulty, key, 1]);
  }
  await insertMany(db, 'exercise_library',
    ['id', 'org_id', 'name', 'primary_muscle', 'secondary_muscles', 'equipment', 'ex_type', 'movement', 'difficulty', 'animation_key', 'is_global'],
    rows);
  return db.q('SELECT id, name, animation_key, primary_muscle FROM exercise_library WHERE is_global = 1 OR org_id IS NULL');
}

// ============================================================
// PROGRAMS + PLANS -- the catalogue a prospect browses.
// ============================================================
const WORKOUT_PROGRAMS = [
  { name: 'Beginner Fat Loss', type: 'full_body', difficulty: 'BEGINNER', notes: '3 days a week. Full body, machine-led, built to be repeatable rather than impressive.',
    picks: ['leg_press', 'db_bench_press', 'lat_pulldown', 'walking_lunge', 'plank', 'treadmill_intervals'] },
  { name: 'Intermediate Strength', type: 'full_body', difficulty: 'INTERMEDIATE', notes: '4 days. Barbell-centred, linear progression on the main lifts.',
    picks: ['barbell_back_squat', 'barbell_bench_press', 'barbell_row', 'overhead_press', 'romanian_deadlift'] },
  { name: 'Hypertrophy Program', type: 'push', difficulty: 'INTERMEDIATE', notes: '5 days. Higher volume, shorter rests, accessory-heavy.',
    picks: ['db_bench_press', 'db_shoulder_press', 'lateral_raise', 'triceps_pushdown', 'seated_cable_row', 'bicep_curl'] },
  { name: 'Weight Loss — 8 Week Program', type: 'full_body', difficulty: 'BEGINNER', notes: 'Circuit-style, conditioning finisher every session.',
    picks: ['leg_press', 'push_up', 'seated_cable_row', 'walking_lunge', 'treadmill_intervals', 'plank'] },
  { name: 'Muscle Building', type: 'pull', difficulty: 'INTERMEDIATE', notes: '4 days. Progressive overload on compounds, 8–12 rep accessories.',
    picks: ['barbell_deadlift', 'pull_up', 'barbell_row', 'bicep_curl', 'lat_pulldown'] },
  { name: 'Full Body Beginner', type: 'full_body', difficulty: 'BEGINNER', notes: 'The first 8 weeks for anyone new to the floor.',
    picks: ['leg_press', 'db_bench_press', 'lat_pulldown', 'plank', 'walking_lunge'] },
  { name: 'Upper/Lower Split', type: 'custom', difficulty: 'INTERMEDIATE', notes: '4 days, alternating. Good fit for members training around work.',
    picks: ['barbell_bench_press', 'barbell_row', 'barbell_back_squat', 'romanian_deadlift', 'lateral_raise'] },
  { name: 'Push Pull Legs', type: 'legs', difficulty: 'ADVANCED', notes: '6 days for members who are in most days anyway.',
    picks: ['barbell_back_squat', 'overhead_press', 'pull_up', 'hip_thrust', 'triceps_pushdown', 'bicep_curl'] },
];

// A plan's calories/protein/carbs/fat are NOT written here -- they are
// summed from its own meals by totalsFor() below.
//
// Found live: hand-maintaining both let them drift, and the drift is not
// cosmetic. adherence.js scores protein as "protein eaten / plan.protein
// x 7 days", so a plan declaring 120 g whose meals only add up to 80 g
// capped its members at 67% protein adherence NO MATTER WHAT THEY ATE --
// which fires a high-severity LOW_PROTEIN rule and marks a diligent
// member AT_RISK. Four of the five plans below were out by between 4%
// and 33%. Deriving the totals makes that class of mistake impossible
// rather than merely fixed, and it is also what the member's own
// Nutrition screen needs: a daily target you cannot hit by eating your
// whole plan is not a target.
const NUTRITION_PLANS = [
  { name: 'Fat Loss — 1800 kcal', meals: [
    ['breakfast', 'Masala oats with egg whites', '07:30', 380, 28, 45, 9, '50g oats, 4 egg whites, onion, tomato'],
    ['lunch', 'Dal, brown rice, salad', '13:00', 520, 26, 72, 12, '1 katori dal, 120g brown rice, cucumber salad'],
    ['pre_workout', 'Banana + black coffee', '17:30', 120, 2, 27, 1, '1 banana, 1 black coffee'],
    ['dinner', 'Grilled chicken, sautéed vegetables', '20:30', 560, 55, 22, 24, '180g chicken breast, mixed vegetables'],
    ['before_bed', 'Curd', '22:30', 220, 29, 14, 9, '200g low-fat curd'],
  ] },
  { name: 'Muscle Gain — 2400 kcal', meals: [
    ['breakfast', 'Paratha, eggs, milk', '07:30', 560, 32, 56, 22, '2 paratha, 3 eggs, 200ml milk'],
    ['lunch', 'Chicken curry, rice, roti', '13:00', 760, 52, 88, 22, '150g chicken, 150g rice, 2 roti'],
    ['post_workout', 'Whey + banana', '18:30', 300, 28, 38, 3, '1 scoop whey, 1 banana'],
    ['dinner', 'Paneer bhurji, roti, dal', '21:00', 620, 42, 52, 26, '150g paneer, 2 roti, 1 katori dal'],
    ['before_bed', 'Milk with almonds', '23:00', 160, 10, 10, 8, '150ml milk, 8 almonds'],
  ] },
  { name: 'Balanced Fitness — 2100 kcal', meals: [
    ['breakfast', 'Poha with peanuts + eggs', '08:00', 470, 26, 56, 16, '1 bowl poha, 2 eggs'],
    ['lunch', 'Rajma, rice, curd', '13:30', 640, 30, 90, 16, '1 katori rajma, 140g rice, 100g curd'],
    ['pre_workout', 'Apple + peanut butter', '17:00', 230, 7, 28, 11, '1 apple, 1 tbsp peanut butter'],
    ['dinner', 'Fish curry, roti, salad', '20:30', 580, 48, 38, 22, '180g fish, 2 roti'],
    ['before_bed', 'Curd', '22:30', 180, 22, 12, 7, '150g curd'],
  ] },
  { name: 'Beginner Weight Loss', meals: [
    ['breakfast', 'Idli with sambar', '08:00', 340, 14, 58, 6, '3 idli, sambar'],
    ['lunch', 'Roti, sabzi, dal', '13:00', 520, 24, 68, 14, '2 roti, mixed vegetable, 1 katori dal'],
    ['dinner', 'Egg curry with salad', '20:00', 480, 34, 22, 26, '3 eggs, onion-tomato gravy'],
    ['before_bed', 'Buttermilk', '22:00', 120, 8, 10, 5, '250ml buttermilk'],
  ] },
  { name: 'High Protein Vegetarian', meals: [
    ['breakfast', 'Paneer bhurji with toast', '07:30', 480, 34, 36, 22, '120g paneer, 2 slices toast'],
    ['lunch', 'Soya chunk curry, rice', '13:00', 620, 48, 72, 14, '60g soya chunks, 130g rice'],
    ['post_workout', 'Whey + curd', '18:30', 290, 40, 18, 6, '1 scoop whey, 150g curd'],
    ['dinner', 'Chana masala, 2 roti', '20:30', 610, 38, 68, 16, '1 katori chana, 2 roti'],
  ] },
];

// Plan lengths are not decoration: "Expiring Soon" on the owner
// dashboard counts active subscriptions renewing within 30 days, so the
// mix of plan durations IS that number. A monthly-only roster makes
// every member expire soon (measured: 54 of 87), which reads as a gym in
// crisis rather than a healthy one -- and the Monthly/Quarterly/
// Half-Yearly/Annual spread below is closer to how Indian gyms actually
// sell anyway. The resulting figures (~76 active, ~13 expiring, ~1.8L a
// month) come out of this mix arithmetically; none of them is written
// down anywhere.
/** A plan's daily targets, summed from the meals that make it up. One
 *  definition, so the plan row, the meal rows and every adherence
 *  calculation that divides by them are all reading the same arithmetic. */
function totalsFor(plan) {
  return plan.meals.reduce((t, [, , , kcal, pro, carb, fat]) => ({
    calories: t.calories + kcal, protein: t.protein + pro,
    carbs: t.carbs + carb, fat: t.fat + fat,
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
}

const MEMBERSHIP_PACKAGES = [
  { name: 'Monthly', amount: 2500, periodDays: 30, features: 'Floor access, group classes, app' },
  { name: 'Quarterly', amount: 6750, periodDays: 90, features: 'Floor access, group classes, app, one PT session a month' },
  { name: 'Half-Yearly', amount: 12500, periodDays: 180, features: 'Everything in Quarterly, plus monthly body composition' },
  { name: 'Annual', amount: 24000, periodDays: 365, features: 'Everything, plus quarterly body composition and a nutrition review' },
];

const GOALS = ['FAT_LOSS', 'MUSCLE_GAIN', 'RECOMP', 'STRENGTH', 'GENERAL'];
const GOAL_LABEL = { FAT_LOSS: 'Fat Loss', MUSCLE_GAIN: 'Muscle Gain', RECOMP: 'Recomposition', STRENGTH: 'Strength', GENERAL: 'General Fitness' };

// Typical working weight (kg) by exercise, used to make logged sets read
// like a real gym rather than uniform noise. Scaled per member by a
// strength factor so the leaderboard has a believable spread.
const BASE_LOAD = {
  barbell_back_squat: 70, barbell_deadlift: 90, barbell_bench_press: 55, overhead_press: 35,
  barbell_row: 50, lat_pulldown: 45, db_shoulder_press: 16, db_bench_press: 22,
  romanian_deadlift: 60, walking_lunge: 14, leg_press: 110, seated_cable_row: 45,
  pull_up: 0, push_up: 0, plank: 0, bicep_curl: 12, triceps_pushdown: 25,
  lateral_raise: 8, hip_thrust: 65, treadmill_intervals: 0,
};

/** Find the demo org, or null. Never matches an org that is not flagged
 *  is_demo -- a real gym that happened to take the slug could not be
 *  returned from here even by accident.
 *
 *  Returns null rather than throwing when `is_demo` does not exist yet:
 *  that column arrives with init-db.js's guarded migrations, so on a
 *  database that has not been migrated the query is a SQL error, not an
 *  empty result. Null is the honest answer there -- a tenant that cannot
 *  be stored cannot exist -- and it degrades the admin console into
 *  "the demo tenant has not been created yet, run npm run seed:demo",
 *  which is both true and the actual next step, instead of a 500. */
export async function findDemoOrg(db, slug = DEMO_ORG_SLUG) {
  try {
    return await db.q1('SELECT * FROM organizations WHERE slug = ? AND is_demo = 1', [slug]);
  } catch {
    return null;
  }
}

/** Ids of every demo tenant, for callers that need to EXCLUDE them from a
 *  platform-wide aggregate. Returns [] when the column is absent, which is
 *  correct: an unmigrated database has no demo tenants to exclude.
 *
 *  Exists so those callers can filter by id instead of writing `is_demo`
 *  into their own SQL -- one query here can fail softly, whereas the
 *  column named inside a six-way aggregate query takes the whole
 *  dashboard down with it. */
export async function listDemoOrgIds(db) {
  try {
    const rows = await db.q('SELECT id FROM organizations WHERE is_demo = 1');
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

/** Wipe the demo tenant's content, keeping the organization row itself.
 *
 *  Keeping the org row is load-bearing, not tidiness: demo_sessions rows
 *  point at it with ON DELETE CASCADE, so dropping and recreating the org
 *  would silently destroy the founder's record of every demo ever run.
 *
 *  REFUSES any org without is_demo = 1. This function issues unguarded
 *  DELETEs against a dozen tables; the flag check is the thing standing
 *  between it and a customer's data, so it throws rather than returning
 *  quietly -- a caller that reaches here with the wrong org has a bug
 *  that must not be swallowed. */
export async function resetDemoTenant(db, orgId) {
  const org = await db.q1('SELECT id, is_demo FROM organizations WHERE id = ?', [orgId]);
  if (!org) throw new Error('demo_org_not_found');
  if (!Number(org.is_demo)) throw new Error('refusing_to_reset_a_non_demo_org');

  // Order matters where a foreign key has no ON DELETE action. clients
  // must go before users (clients.trainer_id -> users(id) with no
  // cascade), and both take most child tables down with them.
  await safeDelete(db, 'DELETE FROM community_challenges WHERE org_id = ?', [orgId]);
  await safeDelete(db, 'DELETE FROM attendance WHERE org_id = ?', [orgId]);
  await safeDelete(db, 'DELETE FROM payments WHERE org_id = ?', [orgId]);
  await safeDelete(db, 'DELETE FROM subscriptions WHERE org_id = ?', [orgId]);
  await safeDelete(db, 'DELETE FROM workouts WHERE org_id = ?', [orgId]);
  await safeDelete(db, 'DELETE FROM clients WHERE org_id = ?', [orgId]);
  await safeDelete(db, 'DELETE FROM nutrition_plans WHERE org_id = ?', [orgId]);
  await safeDelete(db, 'DELETE FROM workout_templates WHERE org_id = ?', [orgId]);
  await safeDelete(db, 'DELETE FROM packages WHERE org_id = ?', [orgId]);
  await safeDelete(db, 'DELETE FROM notifications WHERE org_id = ?', [orgId]);
  await safeDelete(db, 'DELETE FROM messages WHERE org_id = ?', [orgId]);
  await safeDelete(db, 'DELETE FROM alerts WHERE org_id = ?', [orgId]);
  await safeDelete(db, 'DELETE FROM events WHERE org_id = ?', [orgId]);
  await safeDelete(db, 'DELETE FROM trainers WHERE org_id = ?', [orgId]);
  await safeDelete(db, 'DELETE FROM users WHERE org_id = ?', [orgId]);
  await safeDelete(db, 'DELETE FROM exercise_library WHERE org_id = ?', [orgId]);
}

/**
 * Build (or rebuild) the BeFitter demo tenant.
 *
 * @returns {Promise<{orgId: string, counts: object}>}
 */
export async function seedDemoTenant(db, { log = () => {} } = {}) {
  const rng = makeRng(0x8EF17E12);
  const nowIso = now();
  const today = dateKey();
  const base = Date.now();

  // ---- 1. The organization ----
  let org = await db.q1('SELECT * FROM organizations WHERE slug = ?', [DEMO_ORG_SLUG]);
  if (org && !Number(org.is_demo)) {
    // The slug exists but is not flagged a demo. Refuse rather than
    // adopt it: silently taking over an org somebody else created is
    // exactly the failure mode the is_demo flag exists to prevent.
    throw new Error('slug_taken_by_non_demo_org');
  }
  if (!org) {
    const orgId = id('org');
    await db.run(
      `INSERT INTO organizations (id, name, slug, type, currency, timezone, is_demo, created_at)
       VALUES (?, ?, ?, 'gym', 'INR', 'Asia/Kolkata', 1, ?)`,
      [orgId, DEMO_GYM_NAME, DEMO_ORG_SLUG, isoDaysAgo(420, base)]);
    org = await db.q1('SELECT * FROM organizations WHERE id = ?', [orgId]);
    log(`  + created demo org ${org.id}`);
  } else {
    await resetDemoTenant(db, org.id);
    log(`  = reset existing demo org ${org.id}`);
  }
  const orgId = org.id;

  // ---- 2. Gym settings + billing state ----
  // ACTIVE billing matters: requireAuth blocks every request for a
  // SUSPENDED org (see auth.js), so a demo tenant left in any other
  // state would 403 the moment the prospect signed in.
  const settings = await db.q1('SELECT org_id FROM gym_settings WHERE org_id = ?', [orgId]);
  // crowd_capacity is how many people FIT, not how many are on the books.
  // 87 members produce a peak of roughly a dozen at once, so a capacity of
  // 120 rendered the live "Gym now" gauge as a permanently-empty room --
  // 7/120 reads as a failing gym rather than a normal Wednesday. 40 is the
  // floor space a gym this size actually has, and makes the same traffic
  // read as the busy-and-quiet cycle it is.
  const settingsCols = [DEMO_GYM_NAME, 'Train with people who show up.', 40, nowIso, orgId];
  if (settings) {
    await db.run(
      `UPDATE gym_settings SET brand_name = ?, tagline = ?, crowd_capacity = ?, crowd_enabled = 1,
         community_enabled = 1, community_leaderboard_enabled = 1, updated_at = ? WHERE org_id = ?`, settingsCols);
  } else {
    await db.run(
      `INSERT INTO gym_settings (org_id, brand_name, tagline, crowd_capacity, crowd_enabled,
         workout_mode_default, allow_substitute, allow_add_exercise, allow_edit_targets,
         community_enabled, community_leaderboard_enabled, updated_at)
       VALUES (?, ?, ?, ?, 1, 'hybrid', 1, 1, 1, 1, 1, ?)`,
      [orgId, DEMO_GYM_NAME, 'Train with people who show up.', 40, nowIso]);
  }
  const billing = await db.q1('SELECT org_id FROM org_billing_state WHERE org_id = ?', [orgId]);
  if (billing) await db.run(`UPDATE org_billing_state SET status = 'ACTIVE', updated_at = ? WHERE org_id = ?`, [nowIso, orgId]);
  else await db.run(`INSERT INTO org_billing_state (org_id, status, updated_at) VALUES (?, 'ACTIVE', ?)`, [orgId, nowIso]);

  // ---- 3. People ----
  // ONE bcrypt call for all 92 accounts, not 92. Every demo account gets
  // the same hash of a throwaway random string: no password on earth
  // verifies against it, so POST /auth/login can never authenticate as a
  // demo identity -- the only way in is a founder-approved session (see
  // routes/demo.js). Hashing each separately would cost ~25 seconds at
  // BCRYPT_COST 12 and buy nothing, because none of them is a secret
  // anybody holds.
  const unusablePasswordHash = await hashPassword(`demo-no-login-${id('nop')}-${id('nop')}`);

  const ownerId = id('usr');
  await db.run(
    `INSERT INTO users (id, org_id, email, password_hash, role, name, phone, active, email_verified, terms_accepted_at, terms_version, created_at)
     VALUES (?, ?, ?, ?, 'GYM_OWNER', ?, ?, 1, 1, ?, '1.0', ?)`,
    [ownerId, orgId, DEMO_PERSONAS.OWNER.email, unusablePasswordHash, DEMO_OWNER_NAME, '+91 98450 11223',
      isoDaysAgo(420, base), isoDaysAgo(420, base)]);

  const trainers = [];
  for (const t of DEMO_TRAINERS) {
    const uid = id('usr');
    await db.run(
      `INSERT INTO users (id, org_id, email, password_hash, role, name, phone, active, email_verified, terms_accepted_at, terms_version, created_at)
       VALUES (?, ?, ?, ?, 'TRAINER', ?, ?, 1, 1, ?, '1.0', ?)`,
      [uid, orgId, t.email, unusablePasswordHash, t.name, `+91 9${intBetween(rng, 100000000, 899999999)}`,
        isoDaysAgo(intBetween(rng, 200, 400), base), isoDaysAgo(intBetween(rng, 200, 400), base)]);
    await db.run(
      'INSERT INTO trainers (user_id, org_id, specialization, bio, max_clients) VALUES (?, ?, ?, ?, ?)',
      [uid, orgId, t.specialization, t.bio, t.maxClients]);
    trainers.push({ ...t, id: uid });
  }

  // ---- 4. Membership packages ----
  const packages = MEMBERSHIP_PACKAGES.map((p) => ({ ...p, id: id('pkg') }));
  await insertMany(db, 'packages', ['id', 'org_id', 'name', 'amount', 'currency', 'period_days', 'features'],
    packages.map((p) => [p.id, orgId, p.name, p.amount, 'INR', p.periodDays, p.features]));

  // ---- 5. Members ----
  // The roster is generated first, in full, then written table by table
  // in batches -- 87 members x ~12 tables as individual inserts would be
  // ~1,000 round trips before a single workout log exists.
  const exercises = await ensureExerciseLibrary(db);
  // ---- Resolving a programme's movements against WHATEVER library this
  // database happens to have ----
  //
  // FALLBACK_EXERCISES' animation_key values are only guaranteed to exist
  // when this seeder installed the library itself. A database seeded by
  // scripts/seed.js has its own, larger library with its own keys --
  // production has 209 global exercises, of which only 12 of the 20 keys
  // below match ('bench_press', not 'barbell_bench_press'; 'seated_row',
  // not 'seated_cable_row').
  //
  // The first version of this fell back to `exercises[0]` for every
  // unmatched key, which meant eight different movements all resolved to
  // the SAME exercise row. That is wrong twice over: every workout would
  // show the same lift, and -- the failure that actually surfaced it --
  // personal_records carries UNIQUE (client_id, exercise_id, type), so a
  // programme containing two unmatched movements tried to write the same
  // PR row twice and aborted the whole seed with a constraint violation.
  // It never showed up locally, because locally this seeder had installed
  // the library and every key matched.
  //
  // So resolution now tries three things in order, and the third one
  // guarantees DISTINCTNESS rather than just returning something:
  //   1. exact animation_key
  //   2. the exercise's own name (FALLBACK_EXERCISES carries it, and a
  //      library built by any seeder spells 'Barbell Bench Press' the same)
  //   3. the next library entry not already claimed by another key
  const exByKey = new Map(exercises.filter((e) => e.animation_key).map((e) => [e.animation_key, e]));
  const exByName = new Map(exercises.filter((e) => e.name).map((e) => [e.name.toLowerCase(), e]));
  const nameForKey = new Map(FALLBACK_EXERCISES.map(([name, , , , , , key]) => [key, name]));
  const resolveEx = (() => {
    const resolved = new Map();   // key -> exercise
    const claimed = new Set();    // exercise ids already standing for some key
    let cursor = 0;
    return (key) => {
      if (resolved.has(key)) return resolved.get(key);
      let ex = exByKey.get(key);
      if (!ex) {
        const name = nameForKey.get(key);
        if (name) ex = exByName.get(name.toLowerCase());
      }
      if (!ex) {
        while (cursor < exercises.length && claimed.has(exercises[cursor].id)) cursor++;
        ex = exercises[cursor] || null;
      }
      if (ex) claimed.add(ex.id);
      resolved.set(key, ex || null);
      return ex || null;
    };
  })();

  const usedNames = new Set();
  const members = [];
  for (let i = 0; i < MEMBER_COUNT; i++) {
    const sex = rng() < 0.56 ? 'M' : 'F';
    let name;
    let guard = 0;
    do {
      const first = pick(rng, sex === 'M' ? MALE_FIRST_NAMES : FEMALE_FIRST_NAMES);
      name = `${first} ${pick(rng, SURNAMES)}`;
    } while (usedNames.has(name) && ++guard < 50);
    usedNames.add(name);

    const goal = pick(rng, GOALS);
    const age = intBetween(rng, 19, 54);
    const heightCm = sex === 'M' ? intBetween(rng, 165, 186) : intBetween(rng, 150, 172);
    const startWeight = round1(sex === 'M' ? between(rng, 68, 102) : between(rng, 52, 86));
    // Progress runs the right way for the goal: a fat-loss member trends
    // down, a muscle-gain member trends up. A roster where everybody is
    // losing weight reads as generated data.
    const delta = goal === 'MUSCLE_GAIN' ? between(rng, 0.8, 4.5)
      : goal === 'STRENGTH' ? between(rng, -0.5, 2.5)
        : -between(rng, 0.5, 6.2);
    const currentWeight = round1(startWeight + delta);
    const targetWeight = round1(goal === 'MUSCLE_GAIN' ? startWeight + between(rng, 5, 9) : startWeight - between(rng, 6, 12));
    const joinedDaysAgo = intBetween(rng, 12, 400);
    const trainer = trainers[i % trainers.length];
    const pkg = (() => {
      const r = rng();
      return r < 0.10 ? packages[0] : r < 0.45 ? packages[1] : r < 0.75 ? packages[2] : packages[3];
    })();
    // ---- ENGAGEMENT TIER ----
    // Explicit bands, not a continuous fudge, because the product DERIVES
    // each member's status from their actual logs at request time
    // (services/atRisk.js) rather than reading clients.status -- and those
    // rules have hard thresholds: protein under 60% or nutrition under 45%
    // is a HIGH-severity rule, and one high rule makes a member AT_RISK.
    //
    // Found live: an earlier version drove logging from one blended
    // "consistency" number, which put most members just under those
    // thresholds and rendered an owner dashboard reading "At risk 87" out
    // of 87. A gym in total crisis is not a demo anybody buys from. The
    // bands below are chosen so the rules land where they are meant to:
    //
    //   ON_TRACK          nutrition & protein comfortably above the floors
    //   NEEDS_ATTENTION   protein in the 60-70 band -> one MEDIUM rule
    //   AT_RISK           nutrition under 45 -> one HIGH rule
    //
    // Roughly 70% / 18% / 12%, which is what a reasonably well-run gym
    // actually looks like.
    const engagement = rng();
    const status = engagement > 0.90 ? 'AT_RISK' : engagement > 0.72 ? 'NEEDS_ATTENTION' : 'ON_TRACK';
    members.push({
      idx: i,
      userId: id('usr'), clientId: id('cli'), name, sex, age, heightCm,
      startWeight, currentWeight, targetWeight, goal, joinedDaysAgo, trainer, pkg, status,
      // 0..1 -- drives attendance frequency, session spacing and
      // leaderboard rank.
      consistency: status === 'AT_RISK' ? between(rng, 0.10, 0.30)
        : status === 'NEEDS_ATTENTION' ? between(rng, 0.46, 0.66) : between(rng, 0.68, 0.96),
      // The share of planned meals this member actually ticks off. Kept
      // SEPARATE from `consistency` on purpose: the rules read nutrition
      // and protein against their own thresholds, so this is the number
      // that decides which side of them a member lands, and it should be
      // legible here rather than implied by arithmetic three steps away.
      // The ON_TRACK floor sits at 0.84, not at the 0.70 rule threshold:
      // this is a per-meal probability over ~35 draws a week, so the
      // realised rate scatters by several points either side of it, and a
      // floor set ON the threshold puts half of those members under it.
      nutritionRate: status === 'AT_RISK' ? between(rng, 0.10, 0.40)
        : status === 'NEEDS_ATTENTION' ? between(rng, 0.62, 0.68) : between(rng, 0.84, 0.99),
      strength: between(rng, 0.62, 1.38),
      program: WORKOUT_PROGRAMS[i % WORKOUT_PROGRAMS.length],
      plan: NUTRITION_PLANS[i % NUTRITION_PLANS.length],
    });
  }

  // Aarav Sharma is the persona the role switcher lands on -- pin him to
  // slot 0 so the member the prospect sees is the member the pre-demo
  // screen promised, with a full history rather than whatever the PRNG
  // happened to produce.
  const memberPersona = DEMO_PERSONAS.MEMBER;
  members[0] = {
    ...members[0],
    name: memberPersona.name, sex: 'M', age: 27, heightCm: 178,
    startWeight: 88.2, currentWeight: 84.0, targetWeight: 78, goal: 'FAT_LOSS',
    joinedDaysAgo: 216, status: 'ON_TRACK', consistency: 0.82, nutritionRate: 0.88, strength: 1.12,
    trainer: trainers[0], pkg: packages[1],
    program: WORKOUT_PROGRAMS[1], plan: NUTRITION_PLANS[0],
  };

  // firstname.lastname@befitter.demo, with a number appended ONLY on a
  // genuine collision -- an index on every address ("anjali.naidu52@")
  // reads as generated data at a glance, and the member list is the first
  // screen a prospect scrolls.
  //
  // The domain stays .demo, which is reserved and unroutable: these are
  // fictional people, and a plausible-looking gmail address assembled
  // from a common Indian name would stand a real chance of belonging to
  // an actual person. An address that provably cannot receive mail is the
  // correct trade for a slightly less lifelike one.
  const usedEmails = new Set();
  const emailFor = (m, i) => {
    if (i === 0) return memberPersona.email;
    const local = m.name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '');
    let candidate = `${local}@${DEMO_EMAIL_DOMAIN}`;
    let n = 2;
    while (usedEmails.has(candidate)) candidate = `${local}${n++}@${DEMO_EMAIL_DOMAIN}`;
    usedEmails.add(candidate);
    return candidate;
  };

  await insertMany(db, 'users',
    ['id', 'org_id', 'email', 'password_hash', 'role', 'name', 'phone', 'active', 'email_verified', 'terms_accepted_at', 'terms_version', 'created_at'],
    members.map((m, i) => [m.userId, orgId, emailFor(m, i), unusablePasswordHash, 'CLIENT', m.name,
      `+91 ${pick(rng, ['98', '99', '97', '96', '81', '73', '70'])}${String(intBetween(rng, 10000000, 99999999))}`, 1, 1,
      isoDaysAgo(m.joinedDaysAgo, base), '1.0', isoDaysAgo(m.joinedDaysAgo, base)]));

  await insertMany(db, 'clients',
    ['id', 'user_id', 'org_id', 'trainer_id', 'status', 'goal', 'start_weight', 'current_weight', 'target_weight',
      'goal_date', 'height_cm', 'age', 'sex', 'last_checkin_at', 'onboarding_completed', 'created_at'],
    members.map((m) => [m.clientId, m.userId, orgId, m.trainer.id, m.status, m.goal,
      m.startWeight, m.currentWeight, m.targetWeight,
      dateKey(new Date(base + intBetween(rng, 30, 150) * DAY_MS)), m.heightCm, m.age, m.sex,
      // Check-in recency by tier. adherence.js scores this as a hard
      // 100/0 on "is there a check-in inside the 7-day window", and it
      // feeds a MEDIUM rule, so an ON_TRACK member has to be inside the
      // window or the product will disagree with their stored status.
      isoDaysAgo(m.status === 'ON_TRACK' ? intBetween(rng, 0, 4)
        : m.status === 'NEEDS_ATTENTION' ? intBetween(rng, 2, 8)
          : intBetween(rng, 9, 30), base),
      1, isoDaysAgo(m.joinedDaysAgo, base)]));

  await insertMany(db, 'client_profiles',
    ['client_id', 'diet_type', 'meals_per_day', 'sleep_target_h', 'water_target_l', 'experience', 'equipment', 'cuisine', 'unit_system', 'notes'],
    members.map((m) => [m.clientId,
      pick(rng, ['VEG', 'NON_VEG', 'VEG', 'EGGETARIAN', 'NON_VEG']),
      intBetween(rng, 3, 5), pick(rng, [7, 7.5, 8, 8]), pick(rng, [2.5, 3, 3, 3.5]),
      m.strength > 1.15 ? 'ADVANCED' : m.strength > 0.9 ? 'INTERMEDIATE' : 'BEGINNER',
      'full_gym', 'Indian', 'metric',
      m.status === 'AT_RISK' ? 'Has not checked in for a few weeks — follow up.' : null]));

  await insertMany(db, 'goals',
    ['id', 'client_id', 'goal_type', 'start_weight', 'target_weight', 'target_date', 'status', 'created_at'],
    members.map((m) => [id('gol'), m.clientId, m.goal, m.startWeight, m.targetWeight,
      dateKey(new Date(base + intBetween(rng, 30, 150) * DAY_MS)), 'ACTIVE', isoDaysAgo(m.joinedDaysAgo, base)]));

  // ---- 6. Memberships, renewals and money ----
  // Renewal dates are derived from each member's own join date and plan
  // length, so "expiring soon" on the owner dashboard is a real count
  // over real dates rather than a number written into a fixture.
  const subs = [];
  const paymentRows = [];
  const subRows = [];
  let expiringSoon = 0;
  let activeCount = 0;
  for (const m of members) {
    const period = m.pkg.periodDays;
    // How far into the current cycle this member is.
    const cyclesElapsed = Math.floor(m.joinedDaysAgo / period);
    const cycleStartDaysAgo = m.joinedDaysAgo - cyclesElapsed * period;
    const endDaysAhead = period - cycleStartDaysAgo;
    // Around a dozen members have lapsed -- a gym with 100% collection is
    // not a gym any owner will recognise, and the "overdue" tile on the
    // Business page needs something real behind it.
    const lapsed = m.status === 'AT_RISK' && rng() < 0.6;
    const status = lapsed ? (rng() < 0.5 ? 'overdue' : 'expired') : 'active';
    if (status === 'active') activeCount++;
    const endDate = dateKey(new Date(base + endDaysAhead * DAY_MS));
    if (status === 'active' && endDaysAhead <= 30) expiringSoon++;
    const subId = id('sub');
    subRows.push([subId, orgId, m.clientId, m.pkg.id, m.pkg.name, m.pkg.amount, 'INR',
      keyDaysAgo(cycleStartDaysAgo, base), endDate, endDate, status, status === 'active' ? 'paid' : 'overdue']);
    subs.push({ id: subId, member: m, status });

    // One payment per completed cycle, back to the start of the revenue
    // trend window the Business page renders (6 months).
    for (let c = cyclesElapsed; c >= 0; c--) {
      const paidDaysAgo = m.joinedDaysAgo - (cyclesElapsed - c) * period;
      if (paidDaysAgo > 190) continue;
      if (lapsed && paidDaysAgo < period) continue; // the renewal they missed
      paymentRows.push([id('pay'), orgId, m.clientId, subId, m.pkg.amount, 'INR',
        pick(rng, ['upi', 'card', 'cash', 'upi', 'upi']), 'paid', isoDaysAgo(paidDaysAgo, base), null]);
    }
  }
  await insertMany(db, 'subscriptions',
    ['id', 'org_id', 'client_id', 'package_id', 'plan_name', 'amount', 'currency', 'start_date', 'end_date', 'renewal_date', 'status', 'payment_status'],
    subRows);
  await insertMany(db, 'payments',
    ['id', 'org_id', 'client_id', 'subscription_id', 'amount', 'currency', 'method', 'status', 'paid_at', 'external_ref'],
    paymentRows);

  // ---- 7. Attendance ----
  // 90 days of floor traffic. Weekends are busier, Sundays quieter --
  // the weekly bar chart on the owner dashboard should have the shape an
  // owner recognises, not a flat line.
  const attendanceRows = [];
  const DOW_WEIGHT = [1.0, 1.05, 0.92, 1.02, 1.08, 1.18, 0.62]; // Mon..Sun
  let todayAttendance = 0;
  for (let d = 89; d >= 0; d--) {
    const day = daysAgo(d, base);
    const dow = (day.getUTCDay() + 6) % 7; // 0 = Monday
    const key = dateKey(day);
    for (const m of members) {
      if (m.joinedDaysAgo < d) continue;
      const p = m.consistency * DOW_WEIGHT[dow] * 0.74;
      if (rng() < p) {
        attendanceRows.push([id('att'), orgId, m.clientId, key, 1]);
        if (d === 0) todayAttendance++;
      }
    }
  }
  await insertMany(db, 'attendance', ['id', 'org_id', 'client_id', 'date', 'present'], attendanceRows);

  // ---- 7b. Turnstile events: who is in the building, right now ----
  // The `attendance` rows above are one-per-member-per-day and answer
  // "did they come in". They do NOT answer "how busy is it at 4pm", which
  // is a different feature with a different table: services/occupancy.js
  // replays entry/exit pairs out of attendance_events to drive the
  // member's "Gym now" card and the owner's by-hour occupancy chart.
  //
  // Seeding only `attendance` left both of those reading a flat zero --
  // "GYM NOW 0 / 120 · Quiet" on a gym with 87 members, at four in the
  // afternoon. Found by opening the member view rather than by reading
  // the schema, which is the only way that kind of gap shows up.
  //
  // Two peaks, because gyms have two: before work and after it. Sessions
  // are ~70 minutes; anyone whose session has not ended by "now" is still
  // counted inside, which is what makes the live number move through the
  // day instead of being a fixed figure.
  const eventRows = [];
  const hourNow = new Date(base).getUTCHours() + new Date(base).getUTCMinutes() / 60;
  // Arrival weighting across a gym's day, in the GYM'S OWN local hours
  // (the demo tenant is seeded Asia/Kolkata). Two peaks, because gyms
  // have two: before work and after it.
  const ARRIVAL_CURVE_LOCAL = [
    [6, 0.09], [7, 0.14], [8, 0.10], [9, 0.05], [10, 0.05], [11, 0.04],
    [12, 0.045], [13, 0.04], [14, 0.045], [15, 0.05], [16, 0.06],
    [17, 0.08], [18, 0.12], [19, 0.08], [20, 0.04], [21, 0.01],
  ];
  // attendance_events.ts is stored as a UTC ISO string, so a local hour
  // has to be converted before it is written -- writing 06:00 as 06:00Z
  // would put the "before work" peak at 11:30am for an Asia/Kolkata gym,
  // and leave a mid-afternoon visitor's events in the future.
  // IST is UTC+5:30 with no DST, so a fixed offset is exact here rather
  // than an approximation.
  const DEMO_TZ_OFFSET_H = 5.5;
  const toUtcHour = (localHour) => localHour - DEMO_TZ_OFFSET_H;
  const pickArrivalHourUtc = () => {
    let r = rng();
    for (const [hour, weight] of ARRIVAL_CURVE_LOCAL) {
      r -= weight;
      if (r <= 0) return toUtcHour(hour + rng());
    }
    return toUtcHour(18 + rng());
  };
  // Today plus the two days before it: enough for the occupancy view to
  // have something to compare against without writing a month of
  // turnstile traffic nobody looks at.
  for (let d = 2; d >= 0; d--) {
    const dayStart = new Date(base - d * DAY_MS);
    const key = dateKey(dayStart);
    const attendedToday = new Set(
      attendanceRows.filter((a) => a[3] === key).map((a) => a[2]));
    for (const m of members) {
      if (!attendedToday.has(m.clientId)) continue;
      const arrival = pickArrivalHourUtc();
      const stayH = between(rng, 0.7, 1.6);
      const mkTs = (h) => {
        const t = new Date(dayStart);
        t.setUTCHours(Math.floor(h), Math.round((h % 1) * 60), 0, 0);
        return t.toISOString();
      };
      // Today only: someone who has not arrived yet has no event at all
      // (they are still to come), and someone mid-session has an entry
      // with no exit -- which is precisely what occupancy.js counts as
      // "inside right now".
      if (d === 0 && arrival > hourNow) continue;
      eventRows.push([id('ate'), orgId, m.clientId, mkTs(arrival), 'entry']);
      const departure = arrival + stayH;
      // 22:30 local is the last possible exit -- in UTC terms, 17:00.
      if (d > 0 || departure <= hourNow) {
        eventRows.push([id('ate'), orgId, m.clientId, mkTs(Math.min(departure, toUtcHour(22.5))), 'exit']);
      }
    }
  }
  // Chronological: occupancy.js replays these in order and treats an exit
  // it has not seen an entry for as a no-op, so order is not cosmetic.
  eventRows.sort((a, b) => a[3].localeCompare(b[3]));
  await insertMany(db, 'attendance_events', ['id', 'org_id', 'client_id', 'ts', 'direction'], eventRows);

  // ---- 8. Programs, plans, and what each member is actually on ----
  const templateRows = [];
  const templateExRows = [];
  const programs = WORKOUT_PROGRAMS.map((p, i) => ({ ...p, id: id('wtp'), trainer: trainers[i % trainers.length] }));
  for (const p of programs) {
    templateRows.push([p.id, orgId, p.trainer.id, p.name, p.type, p.notes, 0, isoDaysAgo(intBetween(rng, 40, 260), base)]);
    p.picks.forEach((key, position) => {
      const ex = resolveEx(key);
      templateExRows.push([id('wex'), null, p.id, ex?.id || null, position, ex?.name || key,
        p.difficulty === 'BEGINNER' ? 3 : 4,
        key === 'plank' ? '45 sec' : key === 'treadmill_intervals' ? '12 min' : p.difficulty === 'BEGINNER' ? '10-12' : '6-10',
        BASE_LOAD[key] ? String(Math.round(BASE_LOAD[key])) : 'BW',
        p.difficulty === 'BEGINNER' ? 60 : 120, null, null, 0]);
    });
  }
  await insertMany(db, 'workout_templates',
    ['id', 'org_id', 'trainer_id', 'name', 'type', 'notes', 'is_global', 'created_at'], templateRows);
  await insertMany(db, 'workout_exercises',
    ['id', 'workout_id', 'template_id', 'exercise_id', 'position', 'name', 'sets', 'reps', 'weight', 'rest_sec', 'tempo', 'notes', 'done'],
    templateExRows);

  // Nutrition: one reusable template per plan, plus a per-member assigned
  // copy so the member's own Nutrition tab has something of their own.
  const planTemplates = NUTRITION_PLANS.map((p, i) => ({
    ...p, ...totalsFor(p), id: id('nut'), trainer: trainers[(i + 3) % trainers.length],
  }));
  const planRows = [];
  const mealRows = [];
  for (const p of planTemplates) {
    planRows.push([p.id, orgId, p.trainer.id, null, p.name, p.calories, p.protein, p.carbs, p.fat, 1, isoDaysAgo(intBetween(rng, 40, 220), base)]);
    p.meals.forEach(([slot, mname, time, kcal, pro, carb, fat, foods], position) => {
      mealRows.push([id('mel'), p.id, slot, mname, time, kcal, pro, carb, fat, foods, position]);
    });
  }
  for (const m of members) {
    const src = planTemplates[NUTRITION_PLANS.indexOf(m.plan)];
    const assignedId = id('nut');
    m.assignedPlanId = assignedId;
    planRows.push([assignedId, orgId, m.trainer.id, m.clientId, src.name, src.calories, src.protein, src.carbs, src.fat, 0, isoDaysAgo(Math.min(m.joinedDaysAgo, intBetween(rng, 5, 90)), base)]);
    // The generated meal ids are KEPT, not discarded. meal_logs.meal_id
    // has to point at the planned meal it fulfils -- that join
    // (`${date}|${meal_id}`) is exactly how services/adherence.js decides
    // whether a planned meal was eaten. Logging a meal with a null
    // meal_id records food but fulfils nothing, so nutrition adherence
    // computes as 0% for a member who ate every meal on their plan.
    m.planMeals = src.meals.map(([slot, mname, time, kcal, pro, carb, fat, foods], position) => {
      const mealId = id('mel');
      mealRows.push([mealId, assignedId, slot, mname, time, kcal, pro, carb, fat, foods, position]);
      return { id: mealId, slot, name: mname, kcal, pro, carb, fat };
    });
  }
  await insertMany(db, 'nutrition_plans',
    ['id', 'org_id', 'trainer_id', 'client_id', 'name', 'calories', 'protein', 'carbs', 'fat', 'is_template', 'created_at'], planRows);
  await insertMany(db, 'meals',
    ['id', 'plan_id', 'slot', 'name', 'time', 'calories', 'protein', 'carbs', 'fat', 'foods', 'position'], mealRows);

  // ---- 9. Training history ----
  // Assigned sessions (past ones completed, the next few still ahead),
  // the per-exercise logs behind them, per-set detail for the most recent
  // sessions, and the personal records those sets produced.
  const workoutRows = [];
  const workoutExRows = [];
  const logRows = [];
  const setRows = [];
  const prRows = [];
  const SESSION_WINDOW = 56;
  for (const m of members) {
    const program = programs[WORKOUT_PROGRAMS.indexOf(m.program)];
    const picks = program.picks;
    // Sessions land every 2-3 days, scaled by how consistent this member is.
    const gap = m.consistency > 0.7 ? 2 : m.consistency > 0.45 ? 3 : 5;
    const history = [];
    for (let d = Math.min(SESSION_WINDOW, m.joinedDaysAgo); d >= -6; d -= gap) history.push(d);

    history.forEach((d, sessionIdx) => {
      const isFuture = d < 0;
      // +0.30, not +0.18: workout adherence is completed/scheduled over a
      // 7-day window that holds only ~3 sessions, so ONE extra miss drops a
      // member from 100% to 67% and two drops them to 33% -- past the 40%
      // line that makes it a high-severity rule and the member AT_RISK.
      // The margin has to leave a committed member room to miss one
      // session without the product deciding they are in trouble.
      const missed = !isFuture && rng() > m.consistency + 0.30;
      const wid = id('wkt');
      const scheduled = dateKey(new Date(base - d * DAY_MS));
      const startedAt = isFuture ? null : new Date(base - d * DAY_MS - intBetween(rng, 0, 8) * 3600_000).toISOString();
      const durationMin = missed || isFuture ? null : intBetween(rng, 38, 78);
      workoutRows.push([wid, orgId, program.id, m.clientId, m.trainer.id, program.name,
        `Session ${sessionIdx + 1}`, scheduled,
        isFuture ? 'assigned' : missed ? 'missed' : 'completed',
        missed || isFuture ? null : startedAt, null,
        missed || isFuture ? null : new Date(Date.parse(startedAt) + durationMin * 60_000).toISOString(),
        durationMin, null, null, null, null, null, null, null,
        'program', null, isoDaysAgo(Math.max(d, 0) + 1, base)]);

      picks.forEach((key, position) => {
        const ex = resolveEx(key);
        const load = BASE_LOAD[key] ? Math.round(BASE_LOAD[key] * m.strength * (1 + sessionIdx * 0.006) / 2.5) * 2.5 : 0;
        const sets = m.program.difficulty === 'BEGINNER' ? 3 : 4;
        const reps = key === 'plank' ? '45 sec' : key === 'treadmill_intervals' ? '12 min' : m.program.difficulty === 'BEGINNER' ? '10-12' : '6-10';
        workoutExRows.push([id('wex'), wid, null, ex?.id || null, position, ex?.name || key, sets, reps,
          load ? String(load) : 'BW', m.program.difficulty === 'BEGINNER' ? 60 : 120, null, null, missed || isFuture ? 0 : 1]);

        if (missed || isFuture || !ex) return;
        const repsDone = key === 'plank' || key === 'treadmill_intervals' ? 1 : intBetween(rng, 6, 12);
        const logId = id('wlg');
        logRows.push([logId, m.clientId, wid, ex.id, scheduled, sets, repsDone, load || null,
          intBetween(rng, 0, 3), null, 0, new Date(base - d * DAY_MS).toISOString()]);
        // Per-set detail only for the most recent handful of sessions:
        // enough that any member profile the prospect opens has real set
        // data on its latest workouts, without writing a quarter of a
        // million rows nobody will scroll to.
        if (sessionIdx >= history.length - 6) {
          for (let s = 1; s <= sets; s++) {
            setRows.push([id('stl'), logId, m.clientId, ex.id, s, Number(String(reps).split('-')[0]) || repsDone,
              Math.max(1, repsDone - (s > 2 ? 1 : 0)), load || null, load || null,
              m.program.difficulty === 'BEGINNER' ? 60 : 120, intBetween(rng, 0, 3), 1, 0]);
          }
        }
      });
    });

    // Personal records on this member's four heaviest movements.
    const prKeys = picks.filter((k) => BASE_LOAD[k] > 0).slice(0, 4);
    for (const key of prKeys) {
      const ex = resolveEx(key);
      if (!ex) continue;
      const best = Math.round(BASE_LOAD[key] * m.strength * 1.18 / 2.5) * 2.5;
      const prev = best - pick(rng, [2.5, 5, 5, 7.5]);
      prRows.push([id('prc'), m.clientId, ex.id, 'heaviest_weight', best, best, intBetween(rng, 3, 6),
        keyDaysAgo(intBetween(rng, 1, 40), base), isoDaysAgo(intBetween(rng, 1, 40), base), prev, prev, intBetween(rng, 3, 6)]);
    }
  }
  await insertMany(db, 'workouts',
    ['id', 'org_id', 'template_id', 'client_id', 'trainer_id', 'name', 'day_label', 'scheduled_date', 'status',
      'started_at', 'progress_json', 'completed_at', 'duration_min', 'estimated_active_kcal', 'lower_kcal', 'upper_kcal',
      'model_version', 'schema_version', 'calorie_provider', 'calorie_estimated_at', 'source', 'notes', 'created_at'],
    workoutRows);
  await insertMany(db, 'workout_exercises',
    ['id', 'workout_id', 'template_id', 'exercise_id', 'position', 'name', 'sets', 'reps', 'weight', 'rest_sec', 'tempo', 'notes', 'done'],
    workoutExRows);
  await insertMany(db, 'workout_logs',
    ['id', 'client_id', 'workout_id', 'exercise_id', 'date', 'sets_done', 'reps', 'weight', 'rir', 'notes', 'is_pr', 'created_at'],
    logRows);
  await insertMany(db, 'exercise_set_logs',
    ['id', 'workout_log_id', 'client_id', 'exercise_id', 'set_number', 'prescribed_reps', 'actual_reps',
      'prescribed_weight', 'actual_weight', 'rest_seconds', 'rir', 'completed', 'is_synthesized'],
    setRows);
  // personal_records carries UNIQUE (client_id, exercise_id, type). The
  // resolver above already guarantees one exercise per movement, so this
  // should never drop anything -- it is here so that a future library
  // whose shape nobody anticipated degrades into slightly fewer PRs rather
  // than a failed seed. Cheap insurance on the one table whose constraint
  // can abort the whole rebuild.
  await insertMany(db, 'personal_records',
    ['id', 'client_id', 'exercise_id', 'type', 'value', 'weight', 'reps', 'date', 'created_at', 'previous_value', 'previous_weight', 'previous_reps'],
    dedupeByKey(prRows, (r) => `${r[1]}|${r[2]}|${r[3]}`));

  // ---- 10. Body metrics, food logs, daily habits ----
  const weightRows = [];
  const measurementRows = [];
  const mealLogRows = [];
  const waterRows = [];
  const sleepRows = [];
  const adherenceRows = [];
  for (const m of members) {
    const span = Math.min(m.joinedDaysAgo, 112);
    const steps = Math.max(2, Math.floor(span / 7));
    for (let w = steps; w >= 0; w--) {
      const d = Math.min(span, w * 7);
      const t = 1 - d / Math.max(span, 1);
      const weight = round1(m.startWeight + (m.currentWeight - m.startWeight) * t + between(rng, -0.4, 0.4));
      weightRows.push([id('wgt'), m.clientId, keyDaysAgo(d, base), weight, 'manual', isoDaysAgo(d, base)]);
    }
    for (const d of [Math.min(span, 84), Math.min(span, 56), Math.min(span, 28), 2]) {
      const t = 1 - d / Math.max(span, 1);
      measurementRows.push([id('mea'), m.clientId, isoDaysAgo(d, base),
        round1(m.startWeight + (m.currentWeight - m.startWeight) * t),
        round1(between(rng, 74, 104) - t * 5), round1(between(rng, 88, 112)),
        round1(between(rng, 28, 40)), round1(between(rng, 48, 64)),
        round1(between(rng, 88, 108)), round1(between(rng, 33, 42))]);
    }
    // EVERY day in the window gets a row for every planned meal, with
    // `eaten` carrying the signal. Skipping whole days instead would make
    // the denominator (meals x 7, fixed by the adherence window) disagree
    // with what was written, so a member's nutrition score would depend on
    // how many days happened to be generated rather than on how well they
    // ate -- and the member's own Nutrition tab would show gaps on days
    // they were in the gym.
    for (let d = 13; d >= 0; d--) {
      if (m.joinedDaysAgo < d) continue;
      const key = keyDaysAgo(d, base);
      for (const meal of (m.planMeals || [])) {
        const eaten = rng() < m.nutritionRate ? 1 : 0;
        mealLogRows.push([id('mlg'), m.clientId, meal.id, key, meal.slot, meal.name,
          Math.round(meal.kcal * between(rng, 0.9, 1.1)), Math.round(meal.pro * between(rng, 0.92, 1.08)),
          Math.round(meal.carb * between(rng, 0.9, 1.1)), Math.round(meal.fat * between(rng, 0.9, 1.1)),
          eaten, 'plan', 0, null, null, null, null]);
      }
      waterRows.push([id('wtr'), m.clientId, key, round1(between(rng, 2.1, 3.6))]);
      sleepRows.push([id('slp'), m.clientId, key, null, null, round1(between(rng, 6.2, 8.4)), 8, 'manual']);
    }
    for (let d = 29; d >= 0; d--) {
      if (m.joinedDaysAgo < d) continue;
      const score = Math.max(12, Math.min(99, Math.round(m.consistency * 100 + between(rng, -18, 14))));
      adherenceRows.push([id('adh'), m.clientId, keyDaysAgo(d, base), score,
        Math.round(score * between(rng, 0.85, 1.12)), Math.round(score * between(rng, 0.8, 1.15)),
        Math.round(score * between(rng, 0.8, 1.18)), Math.round(score * between(rng, 0.7, 1.2)),
        Math.round(score * between(rng, 0.75, 1.15)), Math.round(score * between(rng, 0.8, 1.2)), null]);
    }
  }
  await insertMany(db, 'weight_logs', ['id', 'client_id', 'date', 'weight', 'source', 'created_at'], weightRows);
  await insertMany(db, 'measurements', ['id', 'client_id', 'taken_at', 'weight', 'waist', 'chest', 'arms', 'thighs', 'hips', 'neck'], measurementRows);
  await insertMany(db, 'meal_logs',
    ['id', 'client_id', 'meal_id', 'date', 'slot', 'name', 'calories', 'protein', 'carbs', 'fat', 'eaten', 'source', 'estimate', 'quantity', 'unit', 'unit_type', 'meal_template_id'],
    mealLogRows);
  await insertMany(db, 'water_logs', ['id', 'client_id', 'date', 'litres'], waterRows);
  await insertMany(db, 'sleep_logs', ['id', 'client_id', 'date', 'bed_time', 'wake_time', 'duration_h', 'target_h', 'source'], sleepRows);
  await insertMany(db, 'adherence_records',
    ['id', 'client_id', 'date', 'score', 'workout', 'nutrition', 'protein', 'water', 'sleep', 'checkin', 'detail_json'], adherenceRows);

  // ---- 11. Community ----
  // Opt-in is per-member (community_members.enabled), so the community
  // is populated but not universal -- which is what an owner will see
  // after rolling it out to a real gym.
  const communityMembers = members.filter((m) => m.consistency > 0.34);
  await insertMany(db, 'community_members', ['client_id', 'org_id', 'enabled', 'pr_visibility', 'feed_scope', 'updated_at'],
    communityMembers.map((m) => [m.clientId, orgId, 1, 'everyone', 'all', isoDaysAgo(intBetween(rng, 1, 90), base)]));

  const shareRows = [];
  const reactionRows = [];
  const commentRows = [];
  const sharers = communityMembers.slice(0, 40);
  sharers.forEach((m, i) => {
    const shareCount = m.consistency > 0.7 ? 3 : 1;
    for (let s = 0; s < shareCount; s++) {
      const shareId = id('cws');
      const d = intBetween(rng, 0, 21);
      const workoutName = m.program.name;
      shareRows.push([shareId, orgId, m.clientId, null, workoutName,
        JSON.stringify({ note: COMMUNITY_POSTS[(i * 3 + s) % COMMUNITY_POSTS.length], exercises: m.program.picks.length, durationMin: intBetween(rng, 40, 75) }),
        'everyone', isoDaysAgo(d, base)]);
      const reactors = communityMembers.filter(() => rng() < 0.16).slice(0, 9);
      for (const r of reactors) {
        if (r.clientId === m.clientId) continue;
        reactionRows.push([id('crx'), orgId, 'share', shareId, r.clientId, pick(rng, ['💪', '🔥', '👏', '💪', '🔥']), isoDaysAgo(Math.max(0, d - 1), base)]);
      }
      const commenters = communityMembers.filter(() => rng() < 0.06).slice(0, 3);
      for (const c of commenters) {
        if (c.clientId === m.clientId) continue;
        commentRows.push([id('cmt'), orgId, 'share', shareId, c.clientId, pick(rng, COMMUNITY_COMMENTS), isoDaysAgo(Math.max(0, d - 1), base)]);
      }
    }
  });
  // workout_id is NOT NULL on community_workout_shares -- point each
  // share at one of the sharer's own completed sessions rather than
  // inventing an id, so opening a share from the feed lands on a real
  // workout the way it does in production.
  const completedByClient = new Map();
  for (const w of workoutRows) {
    if (w[8] !== 'completed') continue;
    if (!completedByClient.has(w[3])) completedByClient.set(w[3], w[0]);
  }
  const resolvedShares = shareRows
    .map((r) => { r[3] = completedByClient.get(r[2]) || null; return r; })
    .filter((r) => r[3]);
  const keptShareIds = new Set(resolvedShares.map((r) => r[0]));
  await insertMany(db, 'community_workout_shares',
    ['id', 'org_id', 'client_id', 'workout_id', 'workout_name', 'payload', 'visibility', 'created_at'], resolvedShares);
  await insertMany(db, 'community_reactions', ['id', 'org_id', 'target_type', 'target_id', 'client_id', 'emoji', 'created_at'],
    dedupeReactions(reactionRows.filter((r) => keptShareIds.has(r[3]))));
  await insertMany(db, 'community_comments', ['id', 'org_id', 'target_type', 'target_id', 'client_id', 'body', 'created_at'],
    commentRows.filter((r) => keptShareIds.has(r[3])));

  // Follows: a sparse graph, so "following" feeds are not empty and not
  // everyone-follows-everyone either.
  const followRows = [];
  const followSeen = new Set();
  for (const m of communityMembers) {
    const n = intBetween(rng, 2, 7);
    for (let f = 0; f < n; f++) {
      const other = pick(rng, communityMembers);
      if (other.clientId === m.clientId) continue;
      const k = `${m.clientId}|${other.clientId}`;
      if (followSeen.has(k)) continue;
      followSeen.add(k);
      followRows.push([m.clientId, other.clientId, orgId, isoDaysAgo(intBetween(rng, 1, 120), base)]);
    }
  }
  await insertMany(db, 'community_follows', ['follower_id', 'following_id', 'org_id', 'created_at'], followRows);

  // Goals are calibrated against what this seed's OWN data actually
  // produces over each challenge's window, so every board shows real
  // partial progress. Measured, not guessed -- the first pass shipped a
  // community volume goal of 18,000 kg against 1.6 MILLION kg of seeded
  // lifting, so the board read "DONE · 1602k / 18.0k", and a member
  // workout goal of 32 over a 21-day window nobody could reach, which
  // read "0 of 75 finished". Both are the specific kind of artifact that
  // tells a prospect they are looking at a fixture rather than a gym.
  //
  // Columns: name, description, metric, goal, scope, startedDaysAgo, lengthDays.
  const challengeRows = [
    ['BeFitter Transformation Challenge', 'Eight weeks. Log every session, post your week-one and week-eight photos.', 'workouts', 16, 'member', 21, 35],
    ['BeFitter Strength Club', 'Add 10 kg to any main lift before the end of the quarter.', 'prs', 5, 'member', 40, 50],
    ['BeFitter Beginners', 'Your first 20 sessions. The only target that matters at the start.', 'workouts', 20, 'member', 10, 60],
    ["BeFitter Women's Fitness", 'Total volume moved, tracked together.', 'volume', 2500000, 'community', 14, 45],
    ['Weekly Challenge', 'Most sessions logged this week.', 'workouts', 5, 'member', 4, 3],
  ].map(([name, description, metric, goal, scope, startedDaysAgo, lengthDays]) => [
    id('chl'), orgId, name, description, metric, goal, scope,
    keyDaysAgo(startedDaysAgo, base), dateKey(new Date(base + (lengthDays - startedDaysAgo) * DAY_MS)),
    ownerId, isoDaysAgo(startedDaysAgo, base),
  ]);
  await insertMany(db, 'community_challenges',
    ['id', 'org_id', 'name', 'description', 'metric', 'goal', 'scope', 'start_date', 'end_date', 'created_by', 'created_at'],
    challengeRows);

  // ---- 12. Reconcile stored status with what the product derives ----
  // clients.status is a stored column, but most of the app does NOT read
  // it -- the dashboards, the "attention required" list and the alerts
  // all re-derive a member's status from their actual logs at request
  // time (services/atRisk.js). Two sources for one fact will disagree,
  // and a demo where the roster chip says "On track" beside a dashboard
  // counting that same member as at risk is exactly the kind of seam the
  // prospect is not supposed to find.
  //
  // So the seeder generates the DATA, then asks the product itself what
  // that data means and stores that answer. The rules stay the single
  // definition of "at risk"; nothing here re-implements them, which is
  // also why this cannot drift if those thresholds are ever changed.
  const seededClients = await db.q('SELECT * FROM clients WHERE org_id = ?', [orgId]);
  const evaluated = await evaluateClients(db, seededClients);
  const derivedMix = {};
  for (const c of seededClients) {
    const derived = evaluated.get(c.id)?.status || c.status;
    derivedMix[derived] = (derivedMix[derived] || 0) + 1;
    if (derived !== c.status) {
      await db.run('UPDATE clients SET status = ? WHERE id = ?', [derived, c.id]);
    }
  }

  const counts = {
    members: members.length, trainers: trainers.length, packages: packages.length,
    onTrack: derivedMix.ON_TRACK || 0,
    needsAttention: derivedMix.NEEDS_ATTENTION || 0,
    atRisk: derivedMix.AT_RISK || 0,
    subscriptions: subRows.length, activeSubscriptions: activeCount, expiringSoon,
    payments: paymentRows.length, attendance: attendanceRows.length, todayAttendance,
    attendanceEvents: eventRows.length,
    inGymNow: eventRows.filter((e) => e[4] === 'entry' && e[3].slice(0, 10) === today).length
      - eventRows.filter((e) => e[4] === 'exit' && e[3].slice(0, 10) === today).length,
    workoutPrograms: programs.length, workouts: workoutRows.length, workoutLogs: logRows.length,
    setLogs: setRows.length, personalRecords: prRows.length,
    nutritionPlans: planRows.length, meals: mealRows.length, mealLogs: mealLogRows.length,
    communityMembers: communityMembers.length, communityShares: resolvedShares.length,
    communityComments: commentRows.filter((r) => keptShareIds.has(r[3])).length,
    challenges: challengeRows.length,
    weightLogs: weightRows.length, adherenceRecords: adherenceRows.length,
  };
  log(`  + seeded ${counts.members} members, ${counts.attendance} attendance rows, ${counts.workoutLogs} workout logs`);
  return { orgId, ownerId, counts, today };
}

/** Drop rows whose key has already been seen, preserving order. Used for
 *  the tables that carry a UNIQUE constraint the generator could otherwise
 *  collide on. */
function dedupeByKey(rows, keyOf) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = keyOf(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** community_reactions carries UNIQUE (target_type, target_id, client_id,
 *  emoji). The generator above can produce the same member reacting with
 *  the same emoji to the same share twice; dropping the duplicates here
 *  keeps that a seeding detail rather than a constraint violation that
 *  aborts the whole reset. */
function dedupeReactions(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = `${r[2]}|${r[3]}|${r[4]}|${r[5]}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}
