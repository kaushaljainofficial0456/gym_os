// ============================================================
// FINANCIAL/MEMBERSHIP TABLES — PostgreSQL / RLS INTEGRATION TESTS
//
// Same rationale and pattern as communityPg.test.js (read that file's
// header first): RLS text in rls.sql proves nothing about what
// PostgreSQL actually enforces, and SQLite has no RLS at all, so this
// is the ONLY place these policies are ever actually exercised. Covers
// the 20 tables that were added to rls.sql in this pass: 16 direct-
// org_id tables (representative sample tested below: invoices,
// payment_orders, refunds, gym_memberships, support_tickets), one
// nullable-org_id table (shared_meals), and three parent-scoped tables
// (payment_transactions, payment_events, support_messages).
//
//   TEST_DATABASE_URL='postgres://user:pw@host/db' npm test
// Without it, every test here SKIPS -- point it at a scratch database
// or throwaway branch, NEVER production.
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

const TAG = 'pgtest_fin_' + Math.random().toString(36).slice(2, 8);
const ORG_A = `${TAG}_orgA`;
const ORG_B = `${TAG}_orgB`;
const ROLE = `${TAG}_app`;

const NEW_RLS_TABLES = [
  'billing_quotes', 'branches', 'enrollment_tokens', 'gym_memberships', 'gym_onboarding',
  'invoices', 'membership_status_history', 'org_billing_state', 'org_capacity_purchases',
  'org_subscriptions', 'payment_accounts', 'payment_orders', 'reconciliation_issues',
  'refunds', 'risk_events', 'support_tickets', 'shared_meals',
  'payment_transactions', 'payment_events', 'support_messages',
];

let pool = null;
async function connect() {
  if (pool) return pool;
  const { default: pg } = await import('pg');
  pool = new pg.Pool({ connectionString: PG_URL, max: 4, connectionTimeoutMillis: 15_000 });
  return pool;
}

// Mirrors db.js's db.tx exactly: SET LOCAL ROLE + SET LOCAL app.org_id.
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

test('financial/membership PostgreSQL RLS integration', { skip, concurrency: false }, async (t) => {
  const p = await connect();

  await t.test('repository migration initialises PostgreSQL cleanly', async () => {
    const { stdout } = await execFileAsync(
      process.execPath, [path.join(root, 'backend', 'scripts', 'init-db.js')],
      { env: { ...process.env, DATABASE_URL: PG_URL, NODE_ENV: 'development' }, cwd: root });
    assert.match(stdout, /Schema applied to PostgreSQL/, 'init-db.js reported success');
  });

  await t.test('every newly-covered table has RLS enabled, forced, and at least one policy', async () => {
    const r = await p.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*)::int FROM pg_policies pol WHERE pol.tablename = c.relname) AS policies
         FROM pg_class c
        WHERE c.relkind='r' AND c.relname = ANY($1::text[])`, [NEW_RLS_TABLES]);
    const byName = Object.fromEntries(r.rows.map((row) => [row.relname, row]));
    for (const tbl of NEW_RLS_TABLES) {
      const row = byName[tbl];
      assert.ok(row, `${tbl}: table exists`);
      assert.equal(row.relrowsecurity, true, `${tbl}: RLS enabled`);
      assert.equal(row.relforcerowsecurity, true, `${tbl}: RLS forced (owner does not bypass)`);
      assert.ok(row.policies > 0, `${tbl}: has at least one policy`);
    }
  });

  await t.test('fixture: two organisations with a full financial/membership footprint each', async () => {
    await p.query(`CREATE ROLE ${ROLE} NOLOGIN NOBYPASSRLS`);
    await p.query(`GRANT ${ROLE} TO CURRENT_USER`);
    await p.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
    await p.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
    const bypass = await p.query(`SELECT rolbypassrls FROM pg_roles WHERE rolname=$1`, [ROLE]);
    assert.equal(bypass.rows[0].rolbypassrls, false, 'the test role must NOT bypass RLS');

    const nowIso = new Date().toISOString();
    for (const org of [ORG_A, ORG_B]) {
      await p.query(`INSERT INTO organizations (id,name,slug,type,currency,timezone,created_at) VALUES ($1,$2,$3,'gym','INR','Asia/Kolkata',$4)`,
        [org, org, `${org}-slug`, nowIso]);
      await p.query(`INSERT INTO users (id,org_id,email,password_hash,role,name,active,created_at) VALUES ($1,$2,$3,'x','GYM_OWNER',$4,1,$5)`,
        [`${org}_owner`, org, `${org}_owner@test.invalid`, `${org} owner`, nowIso]);
      await p.query(`INSERT INTO users (id,org_id,email,password_hash,role,name,active,created_at) VALUES ($1,$2,$3,'x','CLIENT',$4,1,$5)`,
        [`${org}_u`, org, `${org}@test.invalid`, `${org} client`, nowIso]);
      await p.query(`INSERT INTO clients (id,user_id,org_id,goal,created_at) VALUES ($1,$2,$3,'GENERAL',$4)`,
        [`${org}_c`, `${org}_u`, org, nowIso]);

      // bucket 1: direct org_id
      await p.query(`INSERT INTO gym_memberships (id,user_id,org_id,role,status,joined_at,created_at,updated_at) VALUES ($1,$2,$3,'CLIENT','ACTIVE',$4,$4,$4)`,
        [`${org}_gmem`, `${org}_u`, org, nowIso]);
      await p.query(`INSERT INTO support_tickets (id,org_id,created_by,category,priority,status,subject,created_at,updated_at) VALUES ($1,$2,$3,'BILLING','MEDIUM','OPEN','Test ticket',$4,$4)`,
        [`${org}_tkt`, org, `${org}_owner`, nowIso]);
      await p.query(`INSERT INTO payment_orders (id,subject_type,subject_id,org_id,client_id,amount,currency,provider,status,created_at,updated_at) VALUES ($1,'CLIENT_MEMBERSHIP',$2,$3,$4,100,'INR','mock','SUCCESS',$5,$5)`,
        [`${org}_pord`, `${org}_tok`, org, `${org}_c`, nowIso]);
      await p.query(`INSERT INTO invoices (id,invoice_number,order_id,org_id,subject_type,amount,currency,status,issued_at,created_at) VALUES ($1,$2,$3,$4,'CLIENT_MEMBERSHIP',100,'INR','ISSUED',$5,$5)`,
        [`${org}_inv`, `${org}_inv_num`, `${org}_pord`, org, nowIso]);
      await p.query(`INSERT INTO refunds (id,payment_order_id,org_id,client_id,type,amount,currency,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'FULL',100,'INR','REQUESTED',$5,$5)`,
        [`${org}_ref`, `${org}_pord`, org, `${org}_c`, nowIso]);

      // bucket 4: parent-scoped
      await p.query(`INSERT INTO payment_transactions (id,order_id,provider,amount,currency,status,created_at) VALUES ($1,$2,'mock',100,'INR','SUCCESS',$3)`,
        [`${org}_ptxn`, `${org}_pord`, nowIso]);
      await p.query(`INSERT INTO support_messages (id,ticket_id,author_id,body,internal,created_at) VALUES ($1,$2,$3,'Test message',0,$4)`,
        [`${org}_tmsg`, `${org}_tkt`, `${org}_owner`, nowIso]);

      // bucket 2: nullable org_id, global-when-null
      await p.query(`INSERT INTO shared_meals (id,org_id,client_id,shared_by_name,items_json,created_at) VALUES ($1,$2,$3,'Sender','[]',$4)`,
        [`${org}_shm`, org, `${org}_c`, nowIso]);
    }
    // One truly org-less share (e.g. sender's org was since deleted).
    await p.query(`INSERT INTO shared_meals (id,org_id,client_id,shared_by_name,items_json,created_at) VALUES ($1,NULL,NULL,'Ghost','[]',$2)`,
      [`${TAG}_shm_orphan`, nowIso]);
  });

  await t.test('READ: a tenant sees only its own rows across every bucket-1 table', async () => {
    for (const [table, idCol] of [['gym_memberships', 'id'], ['support_tickets', 'id'], ['payment_orders', 'id'], ['invoices', 'id'], ['refunds', 'id']]) {
      await asTenant(ORG_A, async (c) => {
        const r = await c.query(`SELECT org_id FROM ${table} WHERE org_id IN ($1,$2)`, [ORG_A, ORG_B]);
        assert.deepEqual([...new Set(r.rows.map((x) => x.org_id))], [ORG_A], `${table}: scoped to org A`);
        const direct = await c.query(`SELECT ${idCol} FROM ${table} WHERE ${idCol} = $1`, [`${ORG_B}_${table === 'gym_memberships' ? 'gmem' : table === 'support_tickets' ? 'tkt' : table === 'payment_orders' ? 'pord' : table === 'invoices' ? 'inv' : 'ref'}`]);
        assert.equal(direct.rowCount, 0, `${table}: org B's row is invisible even when addressed by id`);
      });
    }
  });

  await t.test('READ: parent-scoped tables (payment_transactions, support_messages) inherit isolation from their parent', async () => {
    await asTenant(ORG_A, async (c) => {
      const txns = await c.query(`SELECT id FROM payment_transactions WHERE id = $1`, [`${ORG_B}_ptxn`]);
      assert.equal(txns.rowCount, 0, "org B's payment_transactions row is invisible to org A");
      const msgs = await c.query(`SELECT id FROM support_messages WHERE id = $1`, [`${ORG_B}_tmsg`]);
      assert.equal(msgs.rowCount, 0, "org B's support_messages row is invisible to org A");
      const ownTxn = await c.query(`SELECT id FROM payment_transactions WHERE id = $1`, [`${ORG_A}_ptxn`]);
      assert.equal(ownTxn.rowCount, 1, "org A's own payment_transactions row is visible");
    });
  });

  await t.test('shared_meals: org-scoped rows are isolated, but a NULL-org row stays universally visible', async () => {
    await asTenant(ORG_A, async (c) => {
      const other = await c.query(`SELECT id FROM shared_meals WHERE id = $1`, [`${ORG_B}_shm`]);
      assert.equal(other.rowCount, 0, "org B's share is invisible to org A under an org-scoped transaction");
      const own = await c.query(`SELECT id FROM shared_meals WHERE id = $1`, [`${ORG_A}_shm`]);
      assert.equal(own.rowCount, 1, "org A's own share is visible");
      const orphan = await c.query(`SELECT id FROM shared_meals WHERE id = $1`, [`${TAG}_shm_orphan`]);
      assert.equal(orphan.rowCount, 1, 'a NULL-org share stays visible even under an org-scoped transaction (matches foods/exercise_library global-rows semantics)');
    });
  });

  await t.test('INSERT: a tenant cannot write a row stamped with another org (WITH CHECK)', async () => {
    await asTenant(ORG_A, async (c) => {
      await assert.rejects(
        () => c.query(
          `INSERT INTO support_tickets (id,org_id,created_by,category,priority,status,subject,created_at,updated_at) VALUES ($1,$2,$3,'BILLING','MEDIUM','OPEN','Evil',$4,$4)`,
          [`${TAG}_evil_tkt`, ORG_B, `${ORG_B}_owner`, new Date().toISOString()]),
        /row-level security/i, 'WITH CHECK rejects an insert stamped with another org');
    });
    const leaked = await p.query(`SELECT count(*)::int n FROM support_tickets WHERE id=$1`, [`${TAG}_evil_tkt`]);
    assert.equal(leaked.rows[0].n, 0, 'nothing was written');
  });

  await t.test('UPDATE / DELETE: a tenant cannot touch another org\'s rows', async () => {
    await asTenant(ORG_A, async (c) => {
      const upd = await c.query(`UPDATE invoices SET status='VOID' WHERE id=$1`, [`${ORG_B}_inv`]);
      assert.equal(upd.rowCount, 0, "org A cannot void org B's invoice");
      const del = await c.query(`DELETE FROM refunds WHERE id=$1`, [`${ORG_B}_ref`]);
      assert.equal(del.rowCount, 0, "org A cannot delete org B's refund");
    });
    const survived = await p.query(`SELECT status FROM invoices WHERE id=$1`, [`${ORG_B}_inv`]);
    assert.equal(survived.rows[0].status, 'ISSUED', "org B's invoice is untouched");
    const stillThere = await p.query(`SELECT count(*)::int n FROM refunds WHERE id=$1`, [`${ORG_B}_ref`]);
    assert.equal(stillThere.rows[0].n, 1, "org B's refund survived");
  });

  await t.test('same-org operations still work (RLS is not just blocking everything)', async () => {
    await asTenant(ORG_A, async (c) => {
      const upd = await c.query(`UPDATE support_tickets SET status='RESOLVED' WHERE id=$1`, [`${ORG_A}_tkt`]);
      assert.equal(upd.rowCount, 1, 'a tenant can update its OWN org\'s row');
      const ins = await c.query(
        `INSERT INTO support_messages (id,ticket_id,author_id,body,internal,created_at) VALUES ($1,$2,$3,'Follow-up',0,$4) RETURNING id`,
        [`${TAG}_ok_msg`, `${ORG_A}_tkt`, `${ORG_A}_owner`, new Date().toISOString()]);
      assert.equal(ins.rowCount, 1, 'and insert a parent-scoped child row referencing its own parent');
    });
  });

  await t.test('unset app.org_id keeps admin/reconciliation cross-org reads working (the path they use today)', async () => {
    // Every write into these tables today happens via plain db.run()/db.q()
    // outside any db.tx() (verified before writing these policies), so
    // app.org_id is never set for them -- the SAME "unset => visible" branch
    // that already keeps community.js and the admin console working for the
    // pre-existing RLS'd tables. Assert it explicitly so a future policy
    // tightening cannot silently break cross-org admin reads.
    await asTenant(null, async (c) => {
      const r = await c.query(`SELECT count(*)::int n FROM support_tickets WHERE org_id IN ($1,$2)`, [ORG_A, ORG_B]);
      assert.equal(r.rows[0].n, 2, 'with no org context, cross-org admin reads still see both orgs');
      const inv = await c.query(`SELECT count(*)::int n FROM invoices WHERE org_id IN ($1,$2)`, [ORG_A, ORG_B]);
      assert.equal(inv.rows[0].n, 2, 'same for invoices');
    });
  });

  await t.after(async () => {
    try {
      await p.query(`DELETE FROM support_messages WHERE ticket_id IN ($1,$2)`, [`${ORG_A}_tkt`, `${ORG_B}_tkt`]);
      await p.query(`DELETE FROM payment_transactions WHERE order_id IN ($1,$2)`, [`${ORG_A}_pord`, `${ORG_B}_pord`]);
      await p.query(`DELETE FROM refunds WHERE org_id IN ($1,$2)`, [ORG_A, ORG_B]);
      await p.query(`DELETE FROM invoices WHERE org_id IN ($1,$2)`, [ORG_A, ORG_B]);
      await p.query(`DELETE FROM payment_orders WHERE org_id IN ($1,$2)`, [ORG_A, ORG_B]);
      await p.query(`DELETE FROM support_tickets WHERE org_id IN ($1,$2)`, [ORG_A, ORG_B]);
      await p.query(`DELETE FROM gym_memberships WHERE org_id IN ($1,$2)`, [ORG_A, ORG_B]);
      await p.query(`DELETE FROM shared_meals WHERE org_id IN ($1,$2) OR id = $3`, [ORG_A, ORG_B, `${TAG}_shm_orphan`]);
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
