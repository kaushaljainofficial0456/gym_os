// ============================================================
// ROW-LEVEL SECURITY POSTURE CHECK -- read-only.
//
//   DATABASE_URL=<RUNTIME role url> node backend/scripts/rls-verify.js [--schema public] [--no-probe]
//
// Run it AS THE RUNTIME ROLE (skos_app), against staging and production,
// after every deploy that touches database/rls.sql or role grants. It only
// reads catalogs and runs SELECTs; it changes nothing.
//
//   exit 0  every check passed
//   exit 1  at least one check failed (the line says which and why)
//   exit 2  could not run (no DATABASE_URL, cannot connect)
//
// What it proves, and why each matters:
//   role       not superuser, not BYPASSRLS (either one switches RLS off),
//              cannot create roles or databases.
//   ownership  owns no table, and is not a member of any role that owns one
//              or bypasses RLS: an owner can ALTER TABLE ... DISABLE ROW
//              LEVEL SECURITY or DROP POLICY; a member can SET ROLE to it.
//   ddl        no CREATE on the schema: cannot add objects (a function,
//              a view owned by itself) to route around policies.
//   truncate   no TRUNCATE on any table: TRUNCATE is NOT subject to RLS, so
//              one call would empty every gym's rows at once.
//   coverage   every table with an org_id or client_id column has RLS
//              enabled AND forced AND at least one policy, unless it is on
//              the reviewed exemption list below (mirrors rls.sql).
//   fail-open  no policy keeps the old "app.org_id unset => every row" branch.
//   probe      a statement with no tenant/platform context sees no tenant
//              row in any protected table (skip with --no-probe on a very
//              large database; it is a SELECT ... LIMIT 1 per table).
// ============================================================
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Tables with an org_id/client_id column that are deliberately NOT under
 *  RLS -- the same reviewed list as the end of database/rls.sql. */
export const RLS_EXEMPT_TABLES = new Set([
  // per-user feedback on the shared food-estimation cache, keyed by the
  // authenticated member; reviewed in database/rls.sql's exemption list.
  'ai_food_feedback',
]);

/** Library tables whose NULL-org rows are shared reference data. */
export const RLS_GLOBAL_TABLES = new Set(['exercise_library', 'exercise_aliases', 'foods', 'food_aliases', 'shared_meals', 'shared_workouts']);

const FAIL_OPEN_RE = /nullif\(current_setting\('app\.org_id'::text, true\), ''::text\) IS NULL/i;

export async function verifyRls({ connectionString, schema = null, probe = true, log = console.log } = {}) {
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString });
  await c.connect();
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`); };
  try {
    const sch = schema || (await c.query('SELECT current_schema() AS s')).rows[0].s;
    const me = (await c.query(`SELECT current_user AS u, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
                                 FROM pg_roles WHERE rolname = current_user`)).rows[0];
    log(`Row-level security posture for role "${me.u}", schema "${sch}"`);

    check('role is not a superuser', !me.rolsuper);
    check('role does not have BYPASSRLS', !me.rolbypassrls);
    check('role cannot create roles, databases or replicate', !me.rolcreaterole && !me.rolcreatedb && !me.rolreplication,
      [me.rolcreaterole && 'CREATEROLE', me.rolcreatedb && 'CREATEDB', me.rolreplication && 'REPLICATION'].filter(Boolean).join(', '));

    const owned = (await c.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                   WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m') AND pg_get_userbyid(c.relowner) = current_user`, [sch])).rows;
    check('role owns no table or view', owned.length === 0, owned.map((r) => r.relname).slice(0, 10).join(', '));

    const dangerousMemberships = (await c.query(`
      SELECT r.rolname FROM pg_roles r
       WHERE r.rolname <> current_user AND pg_has_role(current_user, r.oid, 'MEMBER')
         AND (r.rolsuper OR r.rolbypassrls OR EXISTS (
               SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = $1 AND c.relowner = r.oid))`, [sch])).rows;
    check('role is not a member of an owner, superuser or BYPASSRLS role', dangerousMemberships.length === 0,
      dangerousMemberships.map((r) => r.rolname).join(', '));

    const schemaCreate = (await c.query(`SELECT has_schema_privilege(current_user, $1, 'CREATE') AS ok`, [sch])).rows[0].ok;
    check('role has no CREATE on the schema (no DDL)', !schemaCreate);

    const truncatable = (await c.query(`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind = 'r' AND has_table_privilege(current_user, c.oid, 'TRUNCATE')`, [sch])).rows;
    check('role has no TRUNCATE on any table (TRUNCATE ignores RLS)', truncatable.length === 0,
      truncatable.map((r) => r.relname).slice(0, 10).join(', '));

    const tables = (await c.query(`
      SELECT c.relname AS t, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
             EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname ~ '(^|_)(org|client)_id$' AND NOT a.attisdropped) AS tenant_col
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind = 'r'`, [sch])).rows;
    const uncovered = tables.filter((r) => r.tenant_col && !RLS_EXEMPT_TABLES.has(r.t) && !(r.rls && r.forced && r.policies > 0));
    check('every table with an org/client id column (org_id, client_id, sender_org_id, ...) has RLS enabled, forced and a policy', uncovered.length === 0,
      uncovered.map((r) => `${r.t}(rls=${r.rls},forced=${r.forced},policies=${r.policies})`).join(', '));
    const unforced = tables.filter((r) => r.policies > 0 && !(r.rls && r.forced));
    check('every table with a policy has RLS enabled and forced', unforced.length === 0, unforced.map((r) => r.t).join(', '));

    const pols = (await c.query(`
      SELECT c.relname AS t, p.polname, pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS w
        FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1`, [sch])).rows;
    const failOpen = pols.filter((p) => FAIL_OPEN_RE.test(p.q || '') || FAIL_OPEN_RE.test(p.w || ''));
    check('no policy treats a missing app.org_id as "every row"', failOpen.length === 0,
      failOpen.map((p) => `${p.t}.${p.polname}`).slice(0, 10).join(', '));
    check('policies are present', pols.length > 0, `${pols.length} policies`);

    if (probe) {
      const protectedTables = tables.filter((r) => r.rls && r.policies > 0).map((r) => r.t);
      const leaks = [];
      for (const t of protectedTables) {
        const where = RLS_GLOBAL_TABLES.has(t) ? 'WHERE org_id IS NOT NULL' : '';
        try {
          await c.query('BEGIN');
          // Both settings explicitly empty: exactly what db.js sends for a
          // statement with no context. Transaction-local, read-only.
          await c.query(`SELECT set_config('app.org_id', '', true), set_config('app.platform', '', true)`);
          await c.query(`SET LOCAL statement_timeout = '20s'`);
          await c.query('SET TRANSACTION READ ONLY');
          const r = await c.query(`SELECT 1 FROM ${pg.escapeIdentifier ? pg.escapeIdentifier(t) : `"${t}"`} ${where} LIMIT 1`);
          if (r.rowCount) leaks.push(t);
        } catch (e) {
          leaks.push(`${t}(error: ${String(e.message).slice(0, 60)})`);
        } finally {
          await c.query('ROLLBACK').catch(() => {});
        }
      }
      check(`no context sees no tenant rows (${protectedTables.length} tables probed)`, leaks.length === 0, leaks.slice(0, 10).join(', '));
    }
  } finally {
    await c.end().catch(() => {});
  }
  return { ok: results.every((r) => r.ok), results };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL (the RUNTIME role) is required.'); process.exit(2); }
  const args = process.argv.slice(2);
  const schema = args.includes('--schema') ? args[args.indexOf('--schema') + 1] : null;
  verifyRls({ connectionString: url, schema, probe: !args.includes('--no-probe') })
    .then(({ ok, results }) => {
      const failed = results.filter((r) => !r.ok).length;
      console.log(`\n=== RLS posture: ${results.length - failed}/${results.length} checks passed ===`);
      process.exit(ok ? 0 : 1);
    })
    .catch((e) => { console.error(`[rls-verify] could not run: ${e.message}`); process.exit(2); });
}
