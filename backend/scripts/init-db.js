// Initialize the dev database from database/schema.sql.
//   node scripts/init-db.js          -> create tables (idempotent)
//   node scripts/init-db.js --force  -> drop the dev DB file first (full reset)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';

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
  // --- gym community: org-level feature toggles ---
  ['gym_settings', 'community_enabled', `community_enabled INTEGER NOT NULL DEFAULT 1`],
  ['gym_settings', 'community_leaderboard_enabled', `community_leaderboard_enabled INTEGER NOT NULL DEFAULT 1`],
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
  db.close();
  console.log(`Schema applied to SQLite at ${dbPath}`);
}
