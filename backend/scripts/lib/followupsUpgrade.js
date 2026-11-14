// ============================================================
// AI COMMUNICATION 2.0 -- bringing an EXISTING database up to the new shape.
//
// A fresh database (tests, and production, where no followup_* table exists
// yet) gets everything from database/schema.sql. A database that already ran
// the first version of AI Communication needs three things, in this order:
//
//   1. prepare*  (BEFORE schema.sql runs) -- add the new columns to followup
//      tables that already exist, so schema.sql's new indexes on them
//      (callback_id, scheduled_for) can be created. Tables that do not exist
//      yet are left to schema.sql.
//   2. schema.sql -- creates the new tables and indexes.
//   3. upgrade*  (AFTER) -- widen two CHECK constraints: followup_rules.kind
//      gains 'announcement', followup_callbacks.status gains the scheduled
//      call-back states. SQLite cannot alter a CHECK, so the table is rebuilt
//      (same procedure as couponRedemptionsUpgrade.js); Postgres swaps the
//      constraint in place.
//
// Every step is idempotent and never drops a row.
// ============================================================

export const FOLLOWUP_NEW_COLUMNS = [
  ['followup_settings', 'keep_transcripts', 'keep_transcripts INTEGER NOT NULL DEFAULT 1'],
  ['followup_settings', 'transcript_days', 'transcript_days INTEGER NOT NULL DEFAULT 90'],
  ['followup_agents', 'tone', "tone TEXT NOT NULL DEFAULT 'warm'"],
  ['followup_agents', 'max_minutes', 'max_minutes INTEGER NOT NULL DEFAULT 3'],
  ['followup_agents', 'allow_callbacks', 'allow_callbacks INTEGER NOT NULL DEFAULT 1'],
  ['followup_agents', 'allow_handover', 'allow_handover INTEGER NOT NULL DEFAULT 1'],
  ['followup_agents', 'answer_plans', 'answer_plans INTEGER NOT NULL DEFAULT 1'],
  ['followup_rules', 'purpose', "purpose TEXT NOT NULL DEFAULT 'service'"],
  ['followup_rules', 'recording_id', 'recording_id TEXT'],
  ['followup_member_prefs', 'promo_consent', 'promo_consent TEXT'],
  ['followup_member_prefs', 'promo_opted_out_at', 'promo_opted_out_at TEXT'],
  ['followup_jobs', 'callback_id', 'callback_id TEXT'],
  ['followup_callbacks', 'mode', "mode TEXT NOT NULL DEFAULT 'human'"],
  ['followup_callbacks', 'scheduled_for', 'scheduled_for TEXT'],
  ['followup_callbacks', 'scheduled_local', 'scheduled_local TEXT'],
  ['followup_callbacks', 'timezone', 'timezone TEXT'],
  ['followup_callbacks', 'conversation_id', 'conversation_id TEXT'],
  ['followup_callbacks', 'context', 'context TEXT'],
  ['followup_callbacks', 'agent_id', 'agent_id TEXT'],
  ['followup_callbacks', 'recording_id', 'recording_id TEXT'],
  ['followup_callbacks', 'script_group_id', 'script_group_id TEXT'],
  ['followup_callbacks', 'language', 'language TEXT'],
  ['followup_callbacks', 'source', 'source TEXT'],
  ['followup_callbacks', 'attempts', 'attempts INTEGER NOT NULL DEFAULT 0'],
  ['followup_callbacks', 'max_attempts', 'max_attempts INTEGER NOT NULL DEFAULT 2'],
  ['followup_callbacks', 'last_job_id', 'last_job_id TEXT'],
  ['followup_callbacks', 'last_error', 'last_error TEXT'],
  ['followup_callbacks', 'events_json', 'events_json TEXT'],
  ['followup_callbacks', 'completed_at', 'completed_at TEXT'],
];

const KINDS = "'missed_visits','membership_ending','payment_due','onboarding','announcement'";
const CB_STATUSES = "'new','assigned','in_progress','completed','unreachable','cancelled','scheduled','processing','failed','expired'";

/* ---------------- SQLite ---------------- */

const sqliteHasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const sqliteCols = (db, t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));

export function prepareFollowupsSqlite(db) {
  let added = 0;
  for (const [table, col, ddl] of FOLLOWUP_NEW_COLUMNS) {
    if (!sqliteHasTable(db, table) || sqliteCols(db, table).has(col)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    added += 1;
  }
  return added;
}

/** The body of `CREATE TABLE IF NOT EXISTS <table> ( ... );` in schema.sql. */
function tableBody(schemaSql, table) {
  const start = schemaSql.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (start < 0) throw new Error(`schema.sql has no ${table}`);
  const open = schemaSql.indexOf('(', start);
  let depth = 0;
  for (let i = open; i < schemaSql.length; i++) {
    if (schemaSql[i] === '(') depth += 1;
    else if (schemaSql[i] === ')') { depth -= 1; if (depth === 0) return schemaSql.slice(open + 1, i); }
  }
  throw new Error(`unbalanced ${table} in schema.sql`);
}

function rebuildSqlite(db, schemaSql, table) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const tmp = `${table}_upgrade`;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    try {
      db.exec(`DROP TABLE IF EXISTS ${tmp}`);
      db.exec(`CREATE TABLE ${tmp} (${tableBody(schemaSql, table)})`);
      const fresh = sqliteCols(db, tmp);
      const keep = cols.filter((n) => fresh.has(n)).join(', ');
      db.exec(`INSERT INTO ${tmp} (${keep}) SELECT ${keep} FROM ${table}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
      const broken = db.prepare(`PRAGMA foreign_key_check(${table})`).all();
      if (broken.length) throw new Error(`${table} upgrade: ${broken.length} row(s) fail a foreign key`);
      const re = new RegExp(`CREATE (UNIQUE )?INDEX IF NOT EXISTS \\w+ ON ${table}\\([^)]*\\)[^;]*;`, 'g');
      for (const stmt of schemaSql.match(re) || []) db.exec(stmt);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/** Widen the two CHECKs on an old SQLite database. Returns the tables rebuilt. */
export function upgradeFollowupsSqlite(db, schemaSql) {
  const done = [];
  const createSql = (t) => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)?.sql || '';
  if (sqliteHasTable(db, 'followup_rules') && !createSql('followup_rules').includes("'announcement'")) { rebuildSqlite(db, schemaSql, 'followup_rules'); done.push('followup_rules'); }
  if (sqliteHasTable(db, 'followup_callbacks') && !createSql('followup_callbacks').includes("'scheduled'")) { rebuildSqlite(db, schemaSql, 'followup_callbacks'); done.push('followup_callbacks'); }
  return done;
}

/* ---------------- PostgreSQL ---------------- */

export async function prepareFollowupsPg(query) {
  for (const [table, , ddl] of FOLLOWUP_NEW_COLUMNS) {
    await query(`DO $$ BEGIN
      IF to_regclass('public.${table}') IS NOT NULL THEN
        EXECUTE 'ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${ddl.replace(/'/g, "''")}';
      END IF;
    END $$;`);
  }
}

/**
 * Replace the kind / status CHECKs with the wider ones. The constraint name
 * is looked up rather than assumed, so a database whose constraint was named
 * differently is still upgraded; one already carrying the new values is left.
 */
export async function upgradeFollowupsPg(query) {
  const swap = (table, column, values, marker) => `DO $$
    DECLARE c record;
    BEGIN
      IF to_regclass('public.${table}') IS NULL THEN RETURN; END IF;
      FOR c IN SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
                WHERE conrelid = 'public.${table}'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%${column}%' LOOP
        IF position('${marker}' in c.def) = 0 THEN
          EXECUTE format('ALTER TABLE ${table} DROP CONSTRAINT %I', c.conname);
        END IF;
      END LOOP;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.${table}'::regclass AND contype = 'c'
                      AND pg_get_constraintdef(oid) LIKE '%${column}%' AND position('${marker}' in pg_get_constraintdef(oid)) > 0) THEN
        EXECUTE 'ALTER TABLE ${table} ADD CONSTRAINT ${table}_${column}_check CHECK (${column} IN (${values.replace(/'/g, "''")}))';
      END IF;
    END $$;`;
  await query(swap('followup_rules', 'kind', KINDS, 'announcement'));
  await query(swap('followup_callbacks', 'status', CB_STATUSES, 'scheduled'));
}
