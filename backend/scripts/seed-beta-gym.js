// ============================================================
// SEED A BETA-TEST GYM — "Bastards of Weightlifting"
//
//   node scripts/seed-beta-gym.js [--password <pw>] [--capacity 25] [--force]
//
// Creates a fully ACTIVE gym that real people can join by scanning a QR,
// with a ZERO-RUPEE membership plan so nobody is asked to pay during a
// beta. Everything it writes is a normal row the app already understands
// -- there is no "beta mode" flag and no special-casing anywhere in the
// product. The only thing that makes this gym free is that its membership
// plan costs 0, which enrollment.js now handles as a first-class case.
//
// IDEMPOTENT: re-running updates the existing gym rather than creating a
// second one. Safe against production. It never touches another org.
//
// WHAT IT SETS UP
//   organizations        the gym itself (type 'gym')
//   users                the owner account, with a password you choose
//   gym_settings         branding + crowd/community switches on
//   sk_packages          the SK OS tier this gym sits on (reuses an
//                        existing one when the pricing seed has run)
//   org_subscriptions    ACTIVE, with the client capacity you asked for
//   org_billing_state    ACTIVE -- without this every QR join is refused
//                        with gym_not_active
//   packages             "Beta Access", 0 INR -- the free membership plan
//                        a client QR points at
//   trainers             one trainer account, so the roster isn't empty
// ============================================================
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { id, now } from '../src/ids.js';

const args = process.argv.slice(2);
const argVal = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const GYM_NAME = argVal('--name', 'Bastards of Weightlifting');
const SLUG = argVal('--slug', 'bastards-of-weightlifting');
const CAPACITY = Number(argVal('--capacity', '25'));
const OWNER_EMAIL = argVal('--email', 'owner@bastardsofweightlifting.com');
const OWNER_PASSWORD = argVal('--password', 'Bastards@2026');
const TRAINER_EMAIL = argVal('--trainer-email', 'coach@bastardsofweightlifting.com');

const db = await getDb();
const nowIso = now();
const driver = db.driver || (config.databaseUrl ? 'postgres' : 'sqlite');

console.log(`[seed-beta-gym] db: ${driver}`);
console.log(`[seed-beta-gym] gym: ${GYM_NAME} (capacity ${CAPACITY})`);

// ---- 1. The org ----
let org = await db.q1('SELECT * FROM organizations WHERE slug = ?', [SLUG]);
if (!org) {
  const orgId = id('org');
  await db.run(
    `INSERT INTO organizations (id, name, slug, type, created_at) VALUES (?, ?, ?, 'gym', ?)`,
    [orgId, GYM_NAME, SLUG, nowIso]);
  org = await db.q1('SELECT * FROM organizations WHERE slug = ?', [SLUG]);
  console.log(`  + created org ${org.id}`);
} else {
  await db.run('UPDATE organizations SET name = ? WHERE id = ?', [GYM_NAME, org.id]);
  console.log(`  = org already exists (${org.id}) — updating in place`);
}
const orgId = org.id;

// ---- 2. Owner account ----
const pwHash = await hashPassword(OWNER_PASSWORD);
let owner = await db.q1('SELECT * FROM users WHERE email = ?', [OWNER_EMAIL]);
if (!owner) {
  const ownerId = id('usr');
  await db.run(
    `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
     VALUES (?, ?, ?, ?, 'GYM_OWNER', ?, 1, ?)`,
    [ownerId, orgId, OWNER_EMAIL, pwHash, 'Gym Owner', nowIso]);
  console.log(`  + created owner ${OWNER_EMAIL}`);
} else {
  // Re-running resets the password, which is the point: this is a shared
  // beta account and forgetting it should not mean rebuilding the gym.
  await db.run('UPDATE users SET password_hash = ?, org_id = ?, role = ?, active = 1 WHERE id = ?',
    [pwHash, orgId, 'GYM_OWNER', owner.id]);
  console.log(`  = owner exists — password reset to the one given`);
}
owner = await db.q1('SELECT * FROM users WHERE email = ?', [OWNER_EMAIL]);

// ---- 3. Gym settings ----
const settings = await db.q1('SELECT org_id FROM gym_settings WHERE org_id = ?', [orgId]);
if (!settings) {
  await db.run(
    `INSERT INTO gym_settings (org_id, brand_name, tagline, crowd_capacity, crowd_enabled,
       workout_mode_default, allow_substitute, allow_add_exercise, allow_edit_targets,
       community_enabled, community_leaderboard_enabled, updated_at)
     VALUES (?, ?, ?, ?, 1, 'hybrid', 1, 1, 1, 1, 1, ?)`,
    [orgId, GYM_NAME, 'Lift heavy. Log everything.', CAPACITY, nowIso]);
  console.log('  + gym settings (community + crowd enabled)');
} else {
  await db.run('UPDATE gym_settings SET brand_name = ?, crowd_capacity = ?, community_enabled = 1, crowd_enabled = 1, updated_at = ? WHERE org_id = ?',
    [GYM_NAME, CAPACITY, nowIso, orgId]);
  console.log('  = gym settings updated');
}

// ---- 4. SK OS tier + ACTIVE subscription ----
// Reuses whatever pricing tier already exists rather than inventing one,
// so this gym shows up in the platform's own reporting like any other.
let skPackage = await db.q1(`SELECT * FROM sk_packages WHERE status = 'active' ORDER BY client_capacity LIMIT 1`);
if (!skPackage) {
  const pid = id('skp');
  await db.run(
    `INSERT INTO sk_packages (id, name, client_capacity, price, currency, duration_days, version, status, effective_from, created_at)
     VALUES (?, 'Beta Tier', ?, 0, 'INR', 365, 1, 'active', ?, ?)`,
    [pid, CAPACITY, nowIso, nowIso]);
  skPackage = await db.q1('SELECT * FROM sk_packages WHERE id = ?', [pid]);
  console.log('  + created an SK OS pricing tier (none existed)');
}

const existingSub = await db.q1(`SELECT * FROM org_subscriptions WHERE org_id = ? AND status = 'ACTIVE'`, [orgId]);
const endDate = new Date(Date.now() + 365 * 86_400_000).toISOString();
if (!existingSub) {
  await db.run(
    `INSERT INTO org_subscriptions (id, org_id, package_id, client_capacity, price, currency, status, start_date, end_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 'INR', 'ACTIVE', ?, ?, ?, ?)`,
    [id('osub'), orgId, skPackage.id, CAPACITY, nowIso, endDate, nowIso, nowIso]);
  console.log(`  + ACTIVE subscription, ${CAPACITY} client slots`);
} else {
  await db.run('UPDATE org_subscriptions SET client_capacity = ?, end_date = ?, updated_at = ? WHERE id = ?',
    [CAPACITY, endDate, nowIso, existingSub.id]);
  console.log(`  = subscription capacity set to ${CAPACITY}`);
}

// Without an ACTIVE billing state every QR join is refused outright
// (enrollment.js checks it before anything else).
const billing = await db.q1('SELECT * FROM org_billing_state WHERE org_id = ?', [orgId]);
if (!billing) {
  await db.run(`INSERT INTO org_billing_state (org_id, status, reserved_slots, updated_at) VALUES (?, 'ACTIVE', 0, ?)`, [orgId, nowIso]);
} else {
  // reserved_slots is reset too: a half-finished join from an earlier
  // test run would otherwise permanently hold a slot.
  await db.run(`UPDATE org_billing_state SET status = 'ACTIVE', reserved_slots = 0, updated_at = ? WHERE org_id = ?`, [nowIso, orgId]);
}
console.log('  = billing state ACTIVE, reservations cleared');

// ---- 5. The FREE membership plan ----
// 0 INR is the whole mechanism: enrollment.js treats a zero-amount plan as
// a free membership and activates it straight from the scan, with no
// payment order and no provider involved.
const freePlan = await db.q1(`SELECT * FROM packages WHERE org_id = ? AND amount = 0`, [orgId]);
let planId;
if (!freePlan) {
  planId = id('pkg');
  await db.run(
    `INSERT INTO packages (id, org_id, name, amount, currency, period_days, features) VALUES (?, ?, 'Beta Access', 0, 'INR', 365, ?)`,
    [planId, orgId, 'Free beta membership — full access, no payment']);
  console.log('  + free membership plan "Beta Access" (0 INR, 365 days)');
} else {
  planId = freePlan.id;
  console.log('  = free membership plan already present');
}

// ---- 6. A trainer, so the roster isn't empty ----
let trainerUser = await db.q1('SELECT * FROM users WHERE email = ?', [TRAINER_EMAIL]);
if (!trainerUser) {
  const tuid = id('usr');
  await db.run(
    `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
     VALUES (?, ?, ?, ?, 'TRAINER', 'Head Coach', 1, ?)`,
    [tuid, orgId, TRAINER_EMAIL, pwHash, nowIso]);
  trainerUser = await db.q1('SELECT * FROM users WHERE email = ?', [TRAINER_EMAIL]);
}
const trainerRow = await db.q1('SELECT * FROM trainers WHERE user_id = ?', [trainerUser.id]);
if (!trainerRow) {
  await db.run(`INSERT INTO trainers (user_id, org_id, specialization, max_clients) VALUES (?, ?, 'Strength', ?)`,
    [trainerUser.id, orgId, CAPACITY]);
  console.log('  + trainer account');
} else {
  await db.run('UPDATE users SET password_hash = ?, active = 1 WHERE id = ?', [pwHash, trainerUser.id]);
  console.log('  = trainer exists — password reset');
}

const clientCount = await db.q1('SELECT COUNT(*) AS n FROM clients WHERE org_id = ?', [orgId]);

console.log('');
console.log('─────────────────────────────────────────────');
console.log(` ${GYM_NAME}`);
console.log('─────────────────────────────────────────────');
console.log(` Owner login    ${OWNER_EMAIL}`);
console.log(` Password       ${OWNER_PASSWORD}`);
console.log('');
console.log(` Trainer login  ${TRAINER_EMAIL}`);
console.log(` Password       ${OWNER_PASSWORD}  (same)`);
console.log('');
console.log(` Capacity       ${CAPACITY} clients   (currently ${Number(clientCount?.n) || 0} joined)`);
console.log(` Membership     Beta Access — 0 INR, 365 days`);
console.log('─────────────────────────────────────────────');
console.log('');
console.log(' To add your friends:');
console.log('  1. Sign in as the owner and generate a CLIENT QR');
console.log('     (it will offer the "Beta Access" plan).');
console.log('  2. They create a normal SK OS account with NO gym code.');
console.log('  3. They scan the QR. They are a member immediately —');
console.log('     no payment screen, because the plan costs nothing.');
console.log('');
console.log(' Each QR is single-use, so generate one per person.');
console.log('');

process.exit(0);
