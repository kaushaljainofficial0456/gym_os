// Initialize the dev database from database/schema.sql.
//   node scripts/init-db.js          -> create tables (idempotent)
//   node scripts/init-db.js --force  -> drop the dev DB file first (full reset)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { id, now } from '../src/ids.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const schemaPath = path.join(root, 'database', 'schema.sql');
const dbPath = path.resolve(root, config.sqlitePath);

if (process.argv.includes('--force') && config.databaseUrl) {
  console.error('--force only applies to the SQLite dev database. Unset DATABASE_URL to use it.');
  process.exit(1);
}
if (process.argv.includes('--force')) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
  console.log(`Removed dev database at ${dbPath}`);
}

// ============================================================
// Guarded column migrations for existing databases (idempotent).
// The SAME list runs on SQLite (PRAGMA existence check) and
// PostgreSQL (ADD COLUMN IF NOT EXISTS). Existing data is never
// dropped or rewritten — new columns only.
// ============================================================
const MIGRATIONS = [
  ['foods', 'client_id', `client_id TEXT REFERENCES clients(id) ON DELETE CASCADE`],
  ['foods', 'serving', `serving TEXT`],
  ['foods', 'piece_g', `piece_g REAL`],
  ['foods', 'brand', `brand TEXT`],
  ['foods', 'fiber', `fiber REAL`],
  ['foods', 'sugar', `sugar REAL`],
  ['foods', 'sodium', `sodium REAL`],
  ['foods', 'source', `source TEXT NOT NULL DEFAULT 'USER_ENTERED'`],
    // --- skos-food-v1 provenance ---
  ['foods', 'source_id', `source_id TEXT`],
  ['foods', 'source_dataset', `source_dataset TEXT`],

  // --- skos-food-v1 retrieval quality ---
  ['foods', 'confidence', `confidence TEXT`],
  ['foods', 'data_quality_flag', `data_quality_flag TEXT`],

  // --- skos-food-v1 cooking state ---
  ['foods', 'cooking_state', `cooking_state TEXT`],
  ['foods', 'cooking_state_inferred', `cooking_state_inferred INTEGER`],

  // --- skos-food-v1 household portions ---
  ['foods', 'serving_description', `serving_description TEXT`],
  ['foods', 'serving_grams', `serving_grams REAL`],

  // --- skos-food-v1 micronutrients ---
  ['foods', 'calcium_mg', `calcium_mg REAL`],
  ['foods', 'iron_mg', `iron_mg REAL`],
  ['foods', 'potassium_mg', `potassium_mg REAL`],
  ['foods', 'magnesium_mg', `magnesium_mg REAL`],
  ['foods', 'zinc_mg', `zinc_mg REAL`],
  ['foods', 'phosphorus_mg', `phosphorus_mg REAL`],
  ['foods', 'vitamin_c_mg', `vitamin_c_mg REAL`],
  ['foods', 'folate_b9_ug', `folate_b9_ug REAL`],
  ['foods', 'vitamin_e_mg', `vitamin_e_mg REAL`],

  // --- skos-food-v1 fat quality ---
  ['foods', 'fa_saturated_mg', `fa_saturated_mg REAL`],
  ['foods', 'fa_monounsat_mg', `fa_monounsat_mg REAL`],
  ['foods', 'fa_polyunsat_mg', `fa_polyunsat_mg REAL`],

  // --- skos-food-v1 protein quality ---
  ['foods', 'aa_leucine_mg', `aa_leucine_mg REAL`],

  // --- messages table: channel + read columns may be missing from older DBs ---
  ['messages', 'channel', `channel TEXT NOT NULL DEFAULT 'inapp'`],
  ['messages', 'read', `read INTEGER NOT NULL DEFAULT 0`],

  ['exercise_library', 'ex_type', `ex_type TEXT NOT NULL DEFAULT 'compound'`],
  ['workouts', 'source', `source TEXT NOT NULL DEFAULT 'program'`],
  // in-flight per-set ticks (base schema has this already; guard is for pre-existing DBs)
  ['workouts', 'progress_json', `progress_json TEXT`],
  ['progress_photos', 'storage_key', `storage_key TEXT`],
  ['progress_photos', 'storage', `storage TEXT NOT NULL DEFAULT 'data_url'`],
  ['workout_logs', 'created_at', `created_at TEXT`],
  ['custom_metrics', 'type', `type TEXT NOT NULL DEFAULT 'number'`],
  ['meal_logs', 'quantity', `quantity REAL`],
  ['meal_logs', 'unit', `unit TEXT`],
  ['meal_logs', 'unit_type', `unit_type TEXT`],
  // --- custom meal template linkage for delete-cascade ---
  ['meal_logs', 'meal_template_id', `meal_template_id TEXT`],
  // --- client onboarding flag ---
  ['notifications', 'read', `read INTEGER NOT NULL DEFAULT 0`],
  // --- workout session timing + calorie persistence (cross-team contract) ---
  ['workouts', 'started_at', `started_at TEXT`],
  ['workouts', 'duration_min', `duration_min REAL`],
  ['workouts', 'estimated_active_kcal', `estimated_active_kcal REAL`],
  ['workouts', 'lower_kcal', `lower_kcal REAL`],
  ['workouts', 'upper_kcal', `upper_kcal REAL`],
  ['workouts', 'model_version', `model_version TEXT`],
  ['workouts', 'schema_version', `schema_version TEXT`],
  ['workouts', 'calorie_provider', `calorie_provider TEXT`],
  ['workouts', 'calorie_estimated_at', `calorie_estimated_at TEXT`],
  // --- legacy set provenance: 1 => derived from aggregate logs, not user-entered ---
  ['exercise_set_logs', 'is_synthesized', `is_synthesized INTEGER NOT NULL DEFAULT 0`],
  // --- client onboarding flag ---
  ['clients', 'onboarding_completed', `onboarding_completed INTEGER NOT NULL DEFAULT 0`],
  // Backfill: existing clients are already in the system, mark as onboarded
  // (new clients created after this migration will start at 0)

  // --- barcode scan cache (see backend/src/services/barcodeLookup.js) ---
  ['foods', 'barcode', `barcode TEXT`],
  ['foods', 'ingredients_text', `ingredients_text TEXT`],
  ['foods', 'image_url', `image_url TEXT`],

  // --- food-AI Tier 4 provenance on logged meals (see foodAI.js) ---
  ['meal_logs', 'ai_provider', `ai_provider TEXT`],
  ['meal_logs', 'ai_model', `ai_model TEXT`],
  ['meal_logs', 'ai_confidence', `ai_confidence TEXT`],

  // --- AI-estimated ingredients inside a custom meal (Customize My Meals'
  // AI fallback) -- distinguishes a "✨ AI Estimated" meal_item from a
  // "✓ Database" one. Default 'database' so every pre-existing row (all
  // resolved via the food model) is correctly labelled without a backfill. ---
  ['meal_items', 'source', `source TEXT NOT NULL DEFAULT 'database'`],
  ['meal_items', 'ai_confidence', `ai_confidence TEXT`],
  ['meal_items', 'ai_provider', `ai_provider TEXT`],
  ['meal_items', 'ai_model', `ai_model TEXT`],

  // --- shared AI food-estimate cache: community feedback + promotion ---
  ['ai_food_estimates', 'validation_status', `validation_status TEXT NOT NULL DEFAULT 'AI_ESTIMATED'`],
  ['ai_food_estimates', 'version', `version INTEGER NOT NULL DEFAULT 1`],

  // --- gym community: org-level feature toggles ---
  ['gym_settings', 'community_enabled', `community_enabled INTEGER NOT NULL DEFAULT 1`],
  ['gym_settings', 'community_leaderboard_enabled', `community_leaderboard_enabled INTEGER NOT NULL DEFAULT 1`],

  // --- Enterprise: gym-owner SaaS billing + QR enrollment ---
  // `packages` (a gym's OWN client-membership-plan catalog, e.g.
  // "Monthly -- Rs.1,500") is reused as-is for the Enterprise spec's
  // "membership_plans" -- it just needed a status so an owner can
  // archive a plan without deleting history that past client_memberships
  // (the existing `subscriptions` table) still reference.
  ['packages', 'status', `status TEXT NOT NULL DEFAULT 'active'`],
  // Trainer revocation -- no client-capacity/subscription equivalent for
  // trainers exists to derive this from (unlike clients, whose lifecycle
  // is read off their own subscriptions.status), so it needs its own
  // column. Revoking a trainer sets this to 'REVOKED', never deletes the
  // row -- see the Enterprise report for why (may rejoin, or another gym,
  // later).
  ['trainers', 'status', `status TEXT NOT NULL DEFAULT 'ACTIVE'`],
  // Enterprise notifications reuse the existing notifications table
  // (messages.js/reports.js already write to it) rather than a new one --
  // it just needed a structured payload column and a channel for future
  // (currently unimplemented) email/SMS delivery.
  ['notifications', 'data_json', `data_json TEXT`],
  ['notifications', 'channel', `channel TEXT NOT NULL DEFAULT 'in_app'`],
  // Atomic capacity-reservation counter added after the initial
  // Enterprise build -- see subscriptionLifecycle.js's
  // reserveCapacitySlot/releaseCapacitySlot and schema.sql's comment
  // on org_billing_state for why this exists (closes a real two-
  // simultaneous-client-joins race caught by
  // test/enterpriseFlow.test.js).
  ['org_billing_state', 'reserved_slots', `reserved_slots INTEGER NOT NULL DEFAULT 0`],
  // Hardening pass 2: a richer, explicit membership lifecycle state
  // ADDITIVE alongside the pre-existing `status` column -- every
  // existing route that filters on status IN ('active','overdue',
  // 'expired','cancelled') keeps working completely unchanged.
  // lifecycle_status is the new fine-grained source of truth
  // (membershipLifecycle.js keeps both columns in sync on every
  // transition); NULL on already-existing rows until the one-time
  // backfill below runs. No DEFAULT here on purpose -- a literal
  // default would apply to every pre-existing row regardless of its
  // actual (varying) coarse status, which is exactly wrong; see the
  // backfill UPDATE right after this array is applied.
  ['subscriptions', 'lifecycle_status', `lifecycle_status TEXT CHECK (lifecycle_status IN ('PENDING_PAYMENT','ACTIVE','PAUSED','SUSPENDED','EXPIRED','CANCELLED','REFUND_PENDING','REFUNDED','TRANSFERRED'))`],
  // Gym profile fields (spec: "GYM PROFILE CREATION") -- extend the
  // EXISTING gym_settings table (already the 1:1 org profile/settings
  // row, see GET/PUT /business/settings) rather than adding a new one.
  ['gym_settings', 'contact_email', `contact_email TEXT`],
  ['gym_settings', 'contact_phone', `contact_phone TEXT`],
  ['gym_settings', 'address', `address TEXT`],
  ['gym_settings', 'city', `city TEXT`],
  ['gym_settings', 'country', `country TEXT`],
  ['gym_settings', 'logo_url', `logo_url TEXT`],
  ['gym_settings', 'website', `website TEXT`],
  ['gym_settings', 'instagram_url', `instagram_url TEXT`],
  ['gym_settings', 'description', `description TEXT`],
  // Phase 2 -- multi-branch: optional, additive. A user's PRIMARY org
  // relationship (users.org_id) may also have a primary branch; NULL
  // for every existing row (single-branch orgs) until a branch is
  // actually created and assigned -- see gymMemberships.js.
  ['users', 'branch_id', `branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL`],
];

// Backfill per-set rows for existing aggregate workout_logs (idempotent).
// Synthesized rows are explicitly marked is_synthesized = 1 so ML training
// can exclude them — they are NOT user-entered per-set data.
function backfillSetLogs(exec, idExpr) {
  exec(`
    INSERT INTO exercise_set_logs (id, workout_log_id, client_id, exercise_id, set_number, prescribed_reps, actual_reps, prescribed_weight, actual_weight, rest_seconds, completed, is_synthesized)
    SELECT ${idExpr}, wl.id, wl.client_id, wl.exercise_id, s.n, wl.reps, wl.reps, wl.weight, wl.weight, NULL, 1, 1
      FROM workout_logs wl
      JOIN (SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6) s ON s.n <= COALESCE(wl.sets_done, 1)
     WHERE NOT EXISTS (SELECT 1 FROM exercise_set_logs es WHERE es.workout_log_id = wl.id);
  `);
}

// Seeds SK OS's OWN default package tiers + additional-client pricing
// rule -- CORE CONFIGURATION every environment needs (the package
// selection screen has nothing to show without it), NOT demo data, so
// this runs unconditionally here rather than in scripts/seed.js (which
// is skippable via --no-demo and never appropriate for production).
// Idempotent: only fires if sk_packages is completely empty, so an
// admin's later price changes (which insert a NEW versioned row, see
// pricing.js) are never overwritten by a later `npm run db:init`.
// The actual NUMBERS here are exactly the spec's own example values
// (75/Rs.12,000, 100/Rs.15,000, 200/Rs.24,000, Rs.155/additional client)
// -- seeded as INITIAL DATA an admin can change from the (future) Admin
// Console, never as a hardcoded business-logic constant anywhere in
// pricing.js itself.
async function seedDefaultPricing(exec) {
  const nowIso = now();
  const p75 = id('skpkg'), p100 = id('skpkg'), p200 = id('skpkg');
  const rule75 = id('skrule'), rule100 = id('skrule');
  const addon10 = id('skaddon'), addon25 = id('skaddon'), addon50 = id('skaddon');
  // Sequential and awaited on purpose: sk_pricing_rules/sk_capacity_addons
  // don't strictly FK-depend on insertion order under Postgres's default
  // read-committed isolation within one client, but keeping these
  // strictly sequential avoids any ambiguity about ordering across the
  // pool's connections.
  await exec(`
    INSERT INTO sk_packages (id, name, client_capacity, price, currency, duration_days, version, status, effective_from, created_at)
    SELECT * FROM (
      SELECT '${p75}' AS id, '75 Clients' AS name, 75 AS client_capacity, 12000 AS price, 'INR' AS currency, 365 AS duration_days, 1 AS version, 'active' AS status, '${nowIso}' AS effective_from, '${nowIso}' AS created_at
      UNION ALL SELECT '${p100}', '100 Clients', 100, 15000, 'INR', 365, 1, 'active', '${nowIso}', '${nowIso}'
      UNION ALL SELECT '${p200}', '200 Clients', 200, 24000, 'INR', 365, 1, 'active', '${nowIso}', '${nowIso}'
    ) seed
    WHERE NOT EXISTS (SELECT 1 FROM sk_packages);
  `);
  await exec(`
    INSERT INTO sk_pricing_rules (id, base_package_id, additional_client_rate, max_capacity, version, status, effective_from, created_at)
    SELECT * FROM (
      SELECT '${rule75}' AS id, '${p75}' AS base_package_id, 155 AS additional_client_rate, 100 AS max_capacity, 1 AS version, 'active' AS status, '${nowIso}' AS effective_from, '${nowIso}' AS created_at
      UNION ALL SELECT '${rule100}', '${p100}', 155, 200, 1, 'active', '${nowIso}', '${nowIso}'
    ) seed
    WHERE NOT EXISTS (SELECT 1 FROM sk_pricing_rules);
  `);
  await exec(`
    INSERT INTO sk_capacity_addons (id, increment, price, currency, version, status, effective_from, created_at)
    SELECT * FROM (
      SELECT '${addon10}' AS id, 10 AS increment, 1800 AS price, 'INR' AS currency, 1 AS version, 'active' AS status, '${nowIso}' AS effective_from, '${nowIso}' AS created_at
      UNION ALL SELECT '${addon25}', 25, 4200, 'INR', 1, 'active', '${nowIso}', '${nowIso}'
      UNION ALL SELECT '${addon50}', 50, 7750, 'INR', 1, 'active', '${nowIso}', '${nowIso}'
    ) seed
    WHERE NOT EXISTS (SELECT 1 FROM sk_capacity_addons);
  `);
}

// Seeds the 'community' feature flag ENABLED at 100% rollout -- this is
// the first real call site for isFeatureEnabled() (see
// services/community.js's getCommunitySettings), and community was
// already live/on for every gym before that flag existed. Seeding it
// pre-enabled means introducing the platform-level gate changes NO
// existing gym's behavior on deploy; a platform operator only sees an
// effect once they deliberately dial the rollout down (or add specific
// orgs to a reduced rollout) via the Admin Console's Feature Flags page.
// ON CONFLICT(key) DO NOTHING, not a UNION-ALL/WHERE-NOT-EXISTS dance
// like seedDefaultPricing above -- a single row with its own UNIQUE
// key is exactly what ON CONFLICT is for, and it's portable across
// both SQLite and Postgres here (already relied on elsewhere in this
// file, e.g. gym_onboarding's upsert).
async function seedDefaultFeatureFlags(exec) {
  const nowIso = now();
  await exec(`
    INSERT INTO feature_flags (id, key, name, description, enabled, rollout_percentage, enabled_org_ids_json, created_at, updated_at)
    VALUES ('${id('flag')}', 'community', 'Gym Community', 'Leaderboards, workout sharing, and copy-workout -- platform-wide rollout control, layered on top of each gym owner''s own community_enabled setting.', 1, 100, '[]', '${nowIso}', '${nowIso}')
    ON CONFLICT (key) DO NOTHING;
  `);
}

function applySqliteMigrations(db) {
  const hasCol = (table, col) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return cols.some((c) => c.name === col);
  };
  const addCol = (table, col, ddl) => {
    if (!hasCol(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  for (const [table, col, ddl] of MIGRATIONS) addCol(table, col, ddl);
    // --- skos-food-v1 indexes ---
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_foods_source_id
    ON foods(source_id)
    WHERE source_id IS NOT NULL
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_foods_cooking_state
    ON foods(cooking_state)
  `);
  // One cached row per physical product (see barcode migration above).
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_foods_barcode
    ON foods(barcode)
    WHERE barcode IS NOT NULL
  `);
  // Backfill created_at for existing workout_logs (best-effort: date-based).
  db.exec(`UPDATE workout_logs SET created_at = date || 'T00:00:00Z' WHERE created_at IS NULL`);
  backfillSetLogs((sql) => db.exec(sql), `'stl_' || lower(hex(randomblob(8)))`);
  // Backfill: existing clients already in the system are considered onboarded
  db.exec(`UPDATE clients SET onboarding_completed = 1 WHERE onboarding_completed = 0`);
  // One-time backfill of subscriptions.lifecycle_status from the
  // pre-existing coarse `status` column -- guarded by `WHERE
  // lifecycle_status IS NULL` so it's safe to run on every startup: a
  // row that has since gone through a REAL transition (PAUSED,
  // SUSPENDED, REFUND_PENDING, ...) already has a non-NULL value and is
  // never touched again by this line. 'overdue' has no better fine-
  // grained equivalent yet (payment_status already captures that
  // distinction) so it maps to ACTIVE, same as a normal active row.
  db.exec(`
    UPDATE subscriptions SET lifecycle_status = CASE status
      WHEN 'active' THEN 'ACTIVE' WHEN 'overdue' THEN 'ACTIVE'
      WHEN 'expired' THEN 'EXPIRED' WHEN 'cancelled' THEN 'CANCELLED'
      ELSE 'ACTIVE' END
    WHERE lifecycle_status IS NULL
  `);

  // ---- P1 indexes for production query performance ----
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ml_template ON meal_logs(meal_template_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_clients_trainer ON clients(trainer_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_clients_org ON clients(org_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_workouts_status ON workouts(client_id, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ml_eaten ON meal_logs(client_id, date, eaten)`);
  // Moved from schema.sql (see comment there): `read` is a guarded migration
  // column, so this index must run after the loop above, not before it.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read)`);
}

async function applyPgMigrations(pool) {
  // PostgreSQL supports ADD COLUMN IF NOT EXISTS natively — same idempotent
  // guard as the SQLite PRAGMA check. Never drops or rewrites data.
  for (const [table, col, ddl] of MIGRATIONS) {
    // Each ddl string already carries its column name (the same string SQLite
    // appends after "ADD COLUMN"), so never re-insert ${col} here — PG's
    // IF NOT EXISTS slot is: ADD COLUMN [IF NOT EXISTS] name type.
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${ddl}`);
  }
    await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_foods_source_id
    ON foods(source_id)
    WHERE source_id IS NOT NULL
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_foods_cooking_state
    ON foods(cooking_state)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_foods_barcode
    ON foods(barcode)
    WHERE barcode IS NOT NULL
  `);
  await pool.query(`UPDATE workout_logs SET created_at = date || 'T00:00:00Z' WHERE created_at IS NULL`);
  backfillSetLogs((sql) => pool.query(sql), `'stl_' || substr(md5(random()::text), 1, 10)`);
  // See the SQLite branch's identical backfill above for why this is
  // safe to run on every startup (guarded by IS NULL).
  await pool.query(`
    UPDATE subscriptions SET lifecycle_status = CASE status
      WHEN 'active' THEN 'ACTIVE' WHEN 'overdue' THEN 'ACTIVE'
      WHEN 'expired' THEN 'EXPIRED' WHEN 'cancelled' THEN 'CANCELLED'
      ELSE 'ACTIVE' END
    WHERE lifecycle_status IS NULL
  `);
  // ---- P1 indexes for production query performance ----
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ml_template ON meal_logs(meal_template_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_clients_trainer ON clients(trainer_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_clients_org ON clients(org_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_workouts_status ON workouts(client_id, status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ml_eaten ON meal_logs(client_id, date, eaten)`);
  // Moved from schema.sql (see comment there): `read` is a guarded migration
  // column, so this index must run after the loop above, not before it.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read)`);
}

if (config.databaseUrl) {
  // PostgreSQL: run the same DDL through pg.
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
  await applyPgMigrations(pool);
  await seedDefaultPricing((s) => pool.query(s));
  await seedDefaultFeatureFlags((s) => pool.query(s));
  // Defense-in-depth: Row-Level Security policies (PG only; idempotent).
  const rlsPath = path.join(root, 'database', 'rls.sql');
  if (fs.existsSync(rlsPath)) {
    await pool.query(fs.readFileSync(rlsPath, 'utf8'));
    console.log('RLS policies applied to PostgreSQL');
  }
  console.log('Schema applied to PostgreSQL');
  await pool.end();
} else {
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
  applySqliteMigrations(db);
  await seedDefaultPricing((s) => db.exec(s));
  await seedDefaultFeatureFlags((s) => db.exec(s));
  db.close();
  console.log(`Schema applied to SQLite at ${dbPath}`);
}
