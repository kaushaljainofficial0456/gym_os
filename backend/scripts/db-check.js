// ============================================================
// DEPLOY PREFLIGHT: does production actually have the database objects
// this build's code depends on?
//
// WHY THIS EXISTS
// ---------------
// community_members and community_workout_shares shipped in schema.sql but
// were never applied to the production database. Vercel builds and deploys
// application code; it does not run migrations (see api/index.js: "getDb()
// just opens a pg Pool, it doesn't run migrations"). So the code went live
// against a database that did not have its tables and /api/community/*
// returned 500 for three days -- 61 logged "relation ... does not exist"
// errors against real users -- while every test stayed green, because the
// test suite rebuilds a SQLite database from schema.sql on every run and can
// therefore never observe what PRODUCTION is missing.
//
// This script closes that gap by failing the DEPLOY instead of the user.
//
// WHY NOT JUST RUN THE MIGRATION IN THE BUILD
// -------------------------------------------
// Deliberately rejected. DATABASE_URL is configured for BOTH the Production
// and Preview environments, so a build-step migration would let any preview
// deployment -- including one from an unreviewed branch -- run DDL against
// the production database. Vercel also builds concurrently, so two pushes
// would race the same DDL. Migrations stay an explicit, operator-run step
// (`npm run db:init`, which is idempotent); this script only VERIFIES, and
// never writes.
//
// CONTRACT
//   exit 0  schema satisfied, or intentionally skipped (no DATABASE_URL /
//           database unreachable -- a transient network fault must not brick
//           every deploy; the app's own /api/ready surfaces that case)
//   exit 1  connected successfully AND required objects are missing
//
// The required set is DERIVED from the same two sources init-db.js applies --
// schema.sql's CREATE TABLE blocks and init-db.js's MIGRATIONS array -- so it
// stays correct as the schema evolves. It is not a hardcoded snapshot.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');

// ---- Parse schema.sql into { table: [columns] } ----
// Line-oriented on purpose. A regex over the whole file gets this wrong: some
// blocks close with a leading space (" );") and some lines declare several
// columns at once ("calories REAL, protein REAL, carbs REAL, fat REAL,").
export function parseSchema(sql) {
  const tables = {};
  let current = null;
  let buf = [];
  // Split on \r?\n, not '\n'. On a CRLF checkout (core.autocrlf=true, the
  // Windows default) a trailing \r survives, and JS treats \r as a line
  // terminator that '.' will not match -- so /--.*$/ silently stops matching
  // and every inline comment leaks into the column list, taking the commas
  // inside it along too. Caught by validating this parser against the live
  // database rather than trusting it.
  for (const raw of sql.split(/\r?\n/)) {
    const line = raw.replace(/--.*$/, '');
    const start = line.match(/^\s*CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(/i);
    if (start) { current = start[1]; buf = []; continue; }
    if (!current) continue;
    if (/^\s*\)\s*;?\s*$/.test(line)) {
      tables[current] = splitColumns(buf.join('\n'));
      current = null;
      buf = [];
      continue;
    }
    buf.push(line);
  }
  return tables;
}

// Split a CREATE TABLE body on commas at paren-depth 0, then take the leading
// identifier of each part. Skips table-level constraints.
function splitColumns(body) {
  const parts = [];
  let depth = 0;
  let tok = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(tok); tok = ''; } else tok += ch;
  }
  parts.push(tok);
  const cols = [];
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    if (/^(PRIMARY KEY|FOREIGN KEY|UNIQUE|CHECK|CONSTRAINT)\b/i.test(t)) continue;
    const m = t.match(/^([A-Za-z_]\w*)\s+/);
    if (m) cols.push(m[1]);
  }
  return cols;
}

// ---- Merge init-db.js's guarded ADD COLUMN migrations ----
export function mergeMigrations(tables, initSrc) {
  const block = initSrc.match(/const MIGRATIONS = \[([\s\S]*?)\n\];/);
  if (!block) return tables;
  const entry = /\[\s*'([^']+)'\s*,\s*'([^']+)'\s*,/g;
  let m;
  while ((m = entry.exec(block[1])) !== null) {
    const [, table, col] = m;
    if (tables[table] && !tables[table].includes(col)) tables[table].push(col);
  }
  return tables;
}

export function buildRequired() {
  const schema = fs.readFileSync(path.join(root, 'database', 'schema.sql'), 'utf8');
  const init = fs.readFileSync(path.join(root, 'backend', 'scripts', 'init-db.js'), 'utf8');
  return mergeMigrations(parseSchema(schema), init);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('[db:check] DATABASE_URL not set — skipping (local/SQLite development).');
    return 0;
  }

  const required = buildRequired();
  const tableNames = Object.keys(required);

  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10_000 });

  let rows;
  try {
    const res = await pool.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'`);
    rows = res.rows;
  } catch (err) {
    // Unreachable database: warn, do not block. A transient network fault
    // during a build must not take the whole deploy pipeline down.
    console.warn(`[db:check] SKIPPED — could not reach the database (${err.code || err.message}).`);
    await pool.end().catch(() => {});
    return 0;
  }

  // WHICH database did we just verify? A passing check that doesn't say this
  // is how a preview deployment silently validated itself against the
  // PRODUCTION database for days: DATABASE_URL was a single Vercel variable
  // scoped to both environments, and nothing in the build output made that
  // visible. neon.timeline_id is unique per Neon branch, so printing it turns
  // "verified against the live database" into "verified against WHICH one".
  // These are identifiers, never credentials -- no host, user, or password.
  let ident = null;
  try {
    const res = await pool.query(
      `SELECT current_user, current_database() AS db,
              current_setting('neon.timeline_id', true) AS timeline,
              (SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public') AS tables`);
    ident = res.rows[0];
  } catch { /* identity is diagnostic only -- never block a deploy on it */ }

  const identLine = ident
    ? `user=${ident.current_user} db=${ident.db} neon.timeline_id=${ident.timeline ?? 'n/a'} tables=${ident.tables}`
    : 'identity unavailable';

  const actual = new Map();
  for (const r of rows) {
    if (!actual.has(r.table_name)) actual.set(r.table_name, new Set());
    actual.get(r.table_name).add(r.column_name);
  }

  const missingTables = [];
  const missingColumns = [];
  for (const t of tableNames) {
    if (!actual.has(t)) { missingTables.push(t); continue; }
    const have = actual.get(t);
    for (const c of required[t]) if (!have.has(c)) missingColumns.push(`${t}.${c}`);
  }

  await pool.end().catch(() => {});

  if (!missingTables.length && !missingColumns.length) {
    console.log(`[db:check] OK — ${tableNames.length} tables verified against the live database.`);
    console.log(`[db:check] target: ${identLine}`);
    return 0;
  }

  console.error('[db:check] FAILED — the database is missing objects this code requires.');
  if (missingTables.length) console.error(`  missing tables (${missingTables.length}): ${missingTables.join(', ')}`);
  if (missingColumns.length) console.error(`  missing columns (${missingColumns.length}): ${missingColumns.join(', ')}`);
  console.error('');
  console.error('  Deploying now would repeat the community_members outage: application');
  console.error('  code live against a database that cannot satisfy its queries.');
  console.error('  Run the migration against this database first:  npm run db:init');

  // Diagnostic only -- no secrets. When the objects genuinely seem to be
  // missing but a migration was just run, the three usual causes are: this
  // role's search_path doesn't reach the schema they were created in, this
  // role is different from the one the migration ran as (so information_
  // schema's own privilege filtering hides them), or DATABASE_URL resolves
  // to a different database/branch entirely than whatever a human just
  // migrated by hand. to_regclass is privilege-independent (unlike
  // information_schema), so comparing the two pinpoints which one it is.
  try {
    const diagPool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10_000 });
    const diag = await diagPool.query(
      `SELECT current_user, current_database(), current_schema(), current_setting('search_path') AS search_path,
              to_regclass('public.${missingTables[0] || tableNames[0]}') AS via_to_regclass,
              (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public') AS visible_table_count,
              current_setting('neon.timeline_id', true) AS neon_timeline_id,
              current_setting('neon.tenant_id', true)   AS neon_tenant_id,
              (SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public') AS unfiltered_table_count,
              (SELECT count(*) FROM pg_catalog.pg_default_acl) AS default_acl_rules`);
    const d = diag.rows[0];
    console.error('');
    console.error('  [db:check] diagnostic (identifiers only -- no connection string, password or token):');
    console.error(`    current_user=${d.current_user} current_database=${d.current_database} current_schema=${d.current_schema}`);
    console.error(`    search_path=${d.search_path}`);
    console.error(`    to_regclass('public.${missingTables[0] || tableNames[0]}')=${d.via_to_regclass === null ? 'NULL (genuinely absent, or not visible to this role)' : d.via_to_regclass}`);
    console.error(`    information_schema.tables sees ${d.visible_table_count} tables in schema 'public' for this role`);
    // pg_tables is NOT privilege-filtered, unlike information_schema: comparing
    // the two separates "role can't see it" from "it isn't there". neon.timeline_id
    // is unique per Neon BRANCH, so it identifies which branch this URL resolves
    // to without revealing any part of the credential. pg_default_acl is non-zero
    // only where an ALTER DEFAULT PRIVILEGES was actually run.
    console.error(`    pg_tables (unfiltered) sees ${d.unfiltered_table_count} tables in schema 'public'`);
    console.error(`    neon.timeline_id=${d.neon_timeline_id ?? 'unavailable'}  neon.tenant_id=${d.neon_tenant_id ?? 'unavailable'}`);
    console.error(`    pg_default_acl rules present: ${d.default_acl_rules}`);
    await diagPool.end().catch(() => {});
  } catch (diagErr) {
    console.error(`  [db:check] diagnostic query itself failed: ${diagErr.code || diagErr.message}`);
  }

  return 1;
}

// Only self-execute when run directly, so the parser can be unit-tested.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => { console.error('[db:check] unexpected error:', err); process.exit(1); });
}
