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

if (config.databaseUrl) {
  // PostgreSQL: run the same DDL through pg.
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
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
  // --- Guarded column migrations for existing databases (idempotent) ---
  const hasCol = (table, col) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return cols.some((c) => c.name === col);
  };
  const addCol = (table, col, ddl) => {
    if (!hasCol(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  addCol('foods', 'client_id', `client_id TEXT REFERENCES clients(id) ON DELETE CASCADE`);
  addCol('foods', 'serving', `serving TEXT`);
  addCol('foods', 'piece_g', `piece_g REAL`);
  addCol('foods', 'brand', `brand TEXT`);
  addCol('foods', 'fiber', `fiber REAL`);
  addCol('foods', 'sugar', `sugar REAL`);
  addCol('foods', 'sodium', `sodium REAL`);
  addCol('foods', 'source', `source TEXT NOT NULL DEFAULT 'USER_ENTERED'`);
  addCol('exercise_library', 'ex_type', `ex_type TEXT NOT NULL DEFAULT 'compound'`);
  addCol('workouts', 'source', `source TEXT NOT NULL DEFAULT 'program'`);
  addCol('progress_photos', 'storage_key', `storage_key TEXT`);
  addCol('progress_photos', 'storage', `storage TEXT NOT NULL DEFAULT 'data_url'`);
  addCol('workout_logs', 'created_at', `created_at TEXT`);
  // Backfill created_at for existing workout_logs (best-effort: date-based).
  db.exec(`UPDATE workout_logs SET created_at = date || 'T00:00:00Z' WHERE created_at IS NULL`);
  addCol('custom_metrics', 'type', `type TEXT NOT NULL DEFAULT 'number'`);
  addCol('meal_logs', 'quantity', `quantity REAL`);
  addCol('meal_logs', 'unit', `unit TEXT`);
  addCol('meal_logs', 'unit_type', `unit_type TEXT`);
  // Backfill per-set rows for existing aggregate workout_logs (idempotent).
  db.exec(`
    INSERT INTO exercise_set_logs (id, workout_log_id, client_id, exercise_id, set_number, prescribed_reps, actual_reps, prescribed_weight, actual_weight, rest_seconds, completed)
    SELECT 'stl_' || lower(hex(randomblob(8))), wl.id, wl.client_id, wl.exercise_id, s.n, wl.reps, wl.reps, wl.weight, wl.weight, NULL, 1
      FROM workout_logs wl
      JOIN (SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6) s ON s.n <= COALESCE(wl.sets_done, 1)
     WHERE NOT EXISTS (SELECT 1 FROM exercise_set_logs es WHERE es.workout_log_id = wl.id);
  `);
  db.close();
  console.log(`Schema applied to SQLite at ${dbPath}`);
}
