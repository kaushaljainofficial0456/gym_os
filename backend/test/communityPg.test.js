// ============================================================
// COMMUNITY — PostgreSQL / RLS INTEGRATION TESTS
//
// WHY THIS FILE EXISTS
// --------------------
// Every other community test runs on SQLite. SQLite has no row-level
// security, so the entire tenant-isolation layer -- the thing that stops one
// gym reading another gym's data -- was asserted only by reading rls.sql and
// hoping. A policy file containing the right text proves nothing about what
// PostgreSQL actually enforces.
//
// These tests run the REAL init-db.js against a REAL PostgreSQL database,
// then attempt cross-tenant reads/writes/updates/deletes as a role that does
// NOT have BYPASSRLS, and assert the database refuses them.
//
// HOW TO RUN
//   TEST_DATABASE_URL='postgres://user:pw@host/db' npm test
// or just the file:
//   TEST_DATABASE_URL='...' node --test backend/test/communityPg.test.js
//
// Without TEST_DATABASE_URL every test here SKIPS, so the default suite stays
// fast and dependency-free. Point it at a scratch database or a throwaway
// branch -- NEVER production: this file runs the schema migration and creates
// and drops its own organisations.
//
// WHY A DEDICATED ROLE
// --------------------
// RLS is not enforced for a role with BYPASSRLS, and managed-Postgres owner
// roles (Neon's neondb_owner among them) have it. Connecting as the owner and
// "checking RLS" would pass no matter how broken the policies were. So the
// suite creates its own NOBYPASSRLS role and does every tenant assertion
// under SET LOCAL ROLE. The owner can always assume a role it just created,
// which also sidesteps needing the production app role's credentials.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');

const PG_URL = process.env.TEST_DATABASE_URL || '';
const skip = PG_URL ? false : 'set TEST_DATABASE_URL to run the PostgreSQL integration suite';

// Namespaced so a failed run can never collide with, or be mistaken for,
// real data -- and so cleanup can find everything it created.
const TAG = 'pgtest_' + Math.random().toString(36).slice(2, 8);
const ORG_A = `${TAG}_orgA`;
const ORG_B = `${TAG}_orgB`;
const ROLE = `${TAG}_app`;

let pool = null;

async function connect() {
  if (pool) return pool;
  const { default: pg } = await import('pg');
  pool = new pg.Pool({ connectionString: PG_URL, max: 4, connectionTimeoutMillis: 15_000 });
  return pool;
}

// Runs a callback on one connection with the restricted role active for the
// duration of a transaction, optionally with an app.org_id set -- exactly how
// db.js engages RLS in the application (SET LOCAL inside db.tx).
async function asTenant(orgId, fn) {
  const p = await connect();
  const c = await p.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE ${ROLE}`);
    if (orgId) await c.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
    return await fn(c);
  } finally {
    try { await c.query('ROLLBACK'); } catch { /* connection already unusable */ }
    c.release();
  }
}

test('community PostgreSQL integration', { skip, concurrency: false }, async (t) => {
  const p = await connect();

  await t.test('repository migration initialises PostgreSQL cleanly', async () => {
    // The REAL migration entry point, not hand-written DDL. If init-db.js
    // cannot build this schema on PostgreSQL, that is the production drift
    // bug that caused the original outage -- caught here instead of by users.
    const { stdout } = await execFileAsync(
      process.execPath, [path.join(root, 'backend', 'scripts', 'init-db.js')],
      { env: { ...process.env, DATABASE_URL: PG_URL, NODE_ENV: 'development' }, cwd: root });
    assert.match(stdout, /Schema applied to PostgreSQL/, 'init-db.js reported success');
  });

  await t.test('community tables, columns and indexes exist after migration', async () => {
    const tables = ['community_members', 'community_workout_shares'];
    for (const tbl of tables) {
      const r = await p.query(`SELECT to_regclass($1) AS t`, [`public.${tbl}`]);
      assert.ok(r.rows[0].t, `${tbl} exists`);
    }
    const cols = await p.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name = ANY($1::text[])`, [tables]);
    const have = new Set(cols.rows.map(r => `${r.table_name}.${r.column_name}`));
    for (const c of ['community_members.client_id', 'community_members.org_id',
                     'community_members.enabled', 'community_workout_shares.org_id',
                     'community_workout_shares.payload', 'community_workout_shares.created_at']) {
      assert.ok(have.has(c), `${c} exists`);
    }
    const idx = await p.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename = ANY($1::text[])`, [tables]);
    const names = idx.rows.map(r => r.indexname);
    assert.ok(names.includes('idx_cws_org_feed'), 'feed index present (org_id, created_at)');
    assert.ok(names.includes('idx_community_members_org'), 'membership index present');
    // The index the leaderboard/streak queries depend on.
    const wi = await p.query(`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='workouts'`);
    assert.ok(wi.rows.map(r => r.indexname).includes('idx_workouts_client_status_date'),
      'composite workouts index present');
  });

  await t.test('RLS is enabled AND forced on both community tables, with a policy', async () => {
    const r = await p.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*)::int FROM pg_policies pol WHERE pol.tablename = c.relname) AS policies
         FROM pg_class c
        WHERE c.relkind='r' AND c.relname IN ('community_members','community_workout_shares')`);
    assert.equal(r.rows.length, 2, 'both tables present');
    for (const row of r.rows) {
      assert.equal(row.relrowsecurity, true, `${row.relname}: RLS enabled`);
      // FORCE matters: without it the table owner bypasses its own policies.
      assert.equal(row.relforcerowsecurity, true, `${row.relname}: RLS forced`);
      assert.ok(row.policies > 0, `${row.relname}: has at least one policy`);
    }
  });

  await t.test('fixture: two organisations with their own clients', async () => {
    await p.query(`CREATE ROLE ${ROLE} NOLOGIN NOBYPASSRLS`);
    // PostgreSQL 16+ gives the creator ADMIN OPTION on a new role but not
    // membership in it, and SET ROLE needs membership -- so this GRANT is
    // required or every tenant assertion below dies on "permission denied to
    // set role". Granting a role we just created to ourselves also avoids
    // needing the production application role's password.
    await p.query(`GRANT ${ROLE} TO CURRENT_USER`);
    await p.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
    await p.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
    const bypass = await p.query(`SELECT rolbypassrls FROM pg_roles WHERE rolname=$1`, [ROLE]);
    assert.equal(bypass.rows[0].rolbypassrls, false,
      'the test role must NOT bypass RLS or every assertion below is vacuous');

    const now = new Date().toISOString();
    for (const [org, slug] of [[ORG_A, `${TAG}-a`], [ORG_B, `${TAG}-b`]]) {
      await p.query(
        `INSERT INTO organizations (id,name,slug,type,currency,timezone,created_at)
         VALUES ($1,$2,$3,'gym','INR','Asia/Kolkata',$4)`, [org, org, slug, now]);
      await p.query(
        `INSERT INTO users (id,org_id,email,password_hash,role,name,active,created_at)
         VALUES ($1,$2,$3,'x','CLIENT',$4,1,$5)`,
        [`${org}_u`, org, `${org}@test.invalid`, `${org} user`, now]);
      await p.query(
        `INSERT INTO clients (id,user_id,org_id,goal,created_at) VALUES ($1,$2,$3,'GENERAL',$4)`,
        [`${org}_c`, `${org}_u`, org, now]);
      await p.query(
        `INSERT INTO community_members (client_id,org_id,enabled,updated_at) VALUES ($1,$2,1,$3)`,
        [`${org}_c`, org, now]);
      await p.query(
        `INSERT INTO workouts (id,org_id,client_id,name,scheduled_date,status,source,created_at)
         VALUES ($1,$2,$3,'W',$4,'completed','program',$5)`,
        [`${org}_w`, org, `${org}_c`, now.slice(0, 10), now]);
      await p.query(
        `INSERT INTO community_workout_shares (id,org_id,client_id,workout_id,workout_name,payload,created_at)
         VALUES ($1,$2,$3,$4,'W','[]',$5)`, [`${org}_s`, org, `${org}_c`, `${org}_w`, now]);
    }
    const n = await p.query(`SELECT count(*)::int n FROM community_workout_shares WHERE org_id IN ($1,$2)`, [ORG_A, ORG_B]);
    assert.equal(n.rows[0].n, 2, 'one share per org seeded');
  });

  await t.test('READ: a tenant sees only its own community rows', async () => {
    await asTenant(ORG_A, async (c) => {
      const m = await c.query(`SELECT org_id FROM community_members WHERE org_id IN ($1,$2)`, [ORG_A, ORG_B]);
      assert.deepEqual([...new Set(m.rows.map(r => r.org_id))], [ORG_A], 'membership rows scoped to org A');
      const s = await c.query(`SELECT org_id FROM community_workout_shares WHERE org_id IN ($1,$2)`, [ORG_A, ORG_B]);
      assert.deepEqual([...new Set(s.rows.map(r => r.org_id))], [ORG_A], 'shares scoped to org A');
      // The specific attack: name org B's share id directly.
      const direct = await c.query(`SELECT id FROM community_workout_shares WHERE id = $1`, [`${ORG_B}_s`]);
      assert.equal(direct.rowCount, 0, "org B's share is invisible even when addressed by id");
    });
    await asTenant(ORG_B, async (c) => {
      const s = await c.query(`SELECT org_id FROM community_workout_shares WHERE org_id IN ($1,$2)`, [ORG_A, ORG_B]);
      assert.deepEqual([...new Set(s.rows.map(r => r.org_id))], [ORG_B], 'isolation holds in the other direction');
    });
  });

  await t.test('INSERT: a tenant cannot write a row belonging to another org', async () => {
    await asTenant(ORG_A, async (c) => {
      await assert.rejects(
        () => c.query(
          `INSERT INTO community_workout_shares (id,org_id,client_id,workout_id,workout_name,payload,created_at)
           VALUES ($1,$2,$3,$4,'X','[]',$5)`,
          [`${TAG}_evil`, ORG_B, `${ORG_B}_c`, `${ORG_B}_w`, new Date().toISOString()]),
        /row-level security/i,
        'WITH CHECK rejects an insert stamped with another org');
    });
    const leaked = await p.query(`SELECT count(*)::int n FROM community_workout_shares WHERE id=$1`, [`${TAG}_evil`]);
    assert.equal(leaked.rows[0].n, 0, 'nothing was written');
  });

  await t.test('UPDATE / DELETE: a tenant cannot modify another org rows', async () => {
    await asTenant(ORG_A, async (c) => {
      const upd = await c.query(
        `UPDATE community_workout_shares SET workout_name='hacked' WHERE id=$1`, [`${ORG_B}_s`]);
      assert.equal(upd.rowCount, 0, "update matches none of org B's rows");
      const del = await c.query(`DELETE FROM community_workout_shares WHERE id=$1`, [`${ORG_B}_s`]);
      assert.equal(del.rowCount, 0, "delete matches none of org B's rows");
      const mdel = await c.query(`DELETE FROM community_members WHERE client_id=$1`, [`${ORG_B}_c`]);
      assert.equal(mdel.rowCount, 0, "org B's membership cannot be revoked by org A");
    });
    const survived = await p.query(
      `SELECT workout_name FROM community_workout_shares WHERE id=$1`, [`${ORG_B}_s`]);
    assert.equal(survived.rows[0].workout_name, 'W', "org B's share is untouched");
    const stillMember = await p.query(
      `SELECT count(*)::int n FROM community_members WHERE client_id=$1`, [`${ORG_B}_c`]);
    assert.equal(stillMember.rows[0].n, 1, "org B's membership survived");
  });

  await t.test('LEADERBOARD shape: cross-org members never join in', async () => {
    // Mirrors computeCompleted()'s join, run under org A's context.
    await asTenant(ORG_A, async (c) => {
      const r = await c.query(
        `SELECT DISTINCT cm.org_id
           FROM community_members cm
           JOIN clients cl ON cl.id = cm.client_id
           JOIN workouts w ON w.client_id = cl.id
          WHERE cm.enabled = 1 AND w.status = 'completed'
            AND cm.org_id IN ($1,$2)`, [ORG_A, ORG_B]);
      assert.deepEqual(r.rows.map(x => x.org_id), [ORG_A],
        'a leaderboard query cannot surface another org through joins');
    });
  });

  await t.test('same-org operations still work (RLS is not just blocking everything)', async () => {
    await asTenant(ORG_A, async (c) => {
      const now = new Date().toISOString();
      const ins = await c.query(
        `INSERT INTO community_workout_shares (id,org_id,client_id,workout_id,workout_name,payload,created_at)
         VALUES ($1,$2,$3,$4,'Legit','[]',$5) RETURNING id`,
        [`${TAG}_ok`, ORG_A, `${ORG_A}_c`, `${ORG_A}_w`, now]);
      assert.equal(ins.rowCount, 1, 'a tenant can insert into its OWN org');
      const upd = await c.query(
        `UPDATE community_workout_shares SET workout_name='Renamed' WHERE id=$1`, [`${TAG}_ok`]);
      assert.equal(upd.rowCount, 1, 'and update it');
      const del = await c.query(`DELETE FROM community_workout_shares WHERE id=$1`, [`${TAG}_ok`]);
      assert.equal(del.rowCount, 1, 'and delete it');
    });
  });

  await t.test('unset app.org_id keeps the application working (the path the app uses)', async () => {
    // community.js reads via db.q()/db.run(), never db.tx(), so app.org_id is
    // never set for these tables. The policy's "unset => visible" branch is
    // what keeps the feature working; assert it explicitly so a future policy
    // tightening cannot silently reintroduce the original 500s.
    await asTenant(null, async (c) => {
      const r = await c.query(`SELECT count(*)::int n FROM community_workout_shares WHERE org_id IN ($1,$2)`, [ORG_A, ORG_B]);
      assert.equal(r.rows[0].n, 2, 'with no org context the app role still reads both orgs');
    });
  });

  await t.after(async () => {
    // Repeatable: remove everything this run created, in FK order.
    try {
      await p.query(`DELETE FROM community_workout_shares WHERE org_id IN ($1,$2)`, [ORG_A, ORG_B]);
      await p.query(`DELETE FROM community_members WHERE org_id IN ($1,$2)`, [ORG_A, ORG_B]);
      await p.query(`DELETE FROM workouts WHERE org_id IN ($1,$2)`, [ORG_A, ORG_B]);
      await p.query(`DELETE FROM clients WHERE org_id IN ($1,$2)`, [ORG_A, ORG_B]);
      await p.query(`DELETE FROM users WHERE org_id IN ($1,$2)`, [ORG_A, ORG_B]);
      await p.query(`DELETE FROM organizations WHERE id IN ($1,$2)`, [ORG_A, ORG_B]);
      await p.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${ROLE}`);
      await p.query(`REVOKE ALL ON SCHEMA public FROM ${ROLE}`);
      await p.query(`DROP ROLE IF EXISTS ${ROLE}`);
    } finally {
      await p.end().catch(() => {});
      pool = null;
    }
  });
});
