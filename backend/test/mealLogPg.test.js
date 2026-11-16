// ============================================================
// MEAL LOGGING ON POSTGRESQL — provenance, idempotency and tenant isolation
// on the production engine (services/nutrition/mealLogWriter.js).
//
// SQLite cannot prove the two properties that matter most here:
//   1. CONCURRENT duplicates of one request race on meal_log_requests'
//      primary key; exactly one wins and the others get its stored
//      response (the 23505 path SQLite never takes).
//   2. Row-level security: under the app role, one gym can neither read
//      another gym's meal_log_requests nor write a request row for a client
//      that is not theirs.
//
// Self-skips without TEST_DATABASE_URL, like the other *Pg tests. Uses a
// throwaway NOBYPASSRLS role and cleans up everything it creates.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { translateSql } from '../src/db.js';
import { writeMealLogs } from '../src/services/nutrition/mealLogWriter.js';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PG_URL = process.env.TEST_DATABASE_URL || '';
const skip = PG_URL ? false : 'set TEST_DATABASE_URL to run the PostgreSQL integration suite';

const TAG = 'pgtest_meal_' + Math.random().toString(36).slice(2, 8);
const ROLE = `${TAG}_app`;
const ORG = { A: `${TAG}_orgA`, B: `${TAG}_orgB` };
const CLIENT = { A: `${TAG}_cA`, B: `${TAG}_cB` };
const NOW = '2026-11-15T00:00:00Z';

let pool = null;
async function connect() {
  if (pool) return pool;
  const { default: pg } = await import('pg');
  pool = new pg.Pool({ connectionString: PG_URL, max: 8, connectionTimeoutMillis: 15_000 });
  return pool;
}

/** The app's db interface (src/db.js shape), with every transaction run as
 *  the NOBYPASSRLS app role and app.org_id set -- exactly as production. */
function appDb(orgId) {
  const run = async (fn) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL ROLE ${ROLE}`);
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    } finally { c.release(); }
  };
  const one = (sql, params) => run((c) => c.query(translateSql(sql), params));
  return {
    driver: 'postgres',
    q: async (sql, params = []) => (await one(sql, params)).rows,
    q1: async (sql, params = []) => (await one(sql, params)).rows[0] || null,
    run: async (sql, params = []) => ({ changes: (await one(sql, params)).rowCount ?? 0 }),
    tx: (fn) => run((c) => fn({
      driver: 'postgres',
      q: async (sql, params = []) => (await c.query(translateSql(sql), params)).rows,
      q1: async (sql, params = []) => (await c.query(translateSql(sql), params)).rows[0] || null,
      run: async (sql, params = []) => ({ changes: (await c.query(translateSql(sql), params)).rowCount ?? 0 }),
    })),
  };
}

const item = (over = {}) => ({ name: 'Dal', calories: 200, protein: 10, carbs: 25, fat: 6, quantity: 1, unit: 'katori', source: 'manual', ...over });

test('meal logging on PostgreSQL', { skip, concurrency: false }, async (t) => {
  const p = await connect();

  await t.test('init-db applies the nutrition migrations cleanly', async () => {
    const { stdout } = await execFileAsync(process.execPath, [path.join(root, 'backend', 'scripts', 'init-db.js')],
      { env: { ...process.env, DATABASE_URL: PG_URL, NODE_ENV: 'development' }, cwd: root });
    assert.match(stdout, /Schema applied to PostgreSQL/);
    const cols = await p.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'meal_logs'`);
    const have = new Set(cols.rows.map((r) => r.column_name));
    for (const c of ['nutrition_source', 'source_id', 'grams', 'fiber', 'sugar', 'sodium', 'confidence', 'request_id']) {
      assert.ok(have.has(c), `meal_logs.${c}`);
    }
    const rls = await p.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'meal_log_requests'`);
    assert.deepEqual(rls.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
  });

  await t.test('seed two gyms and the app role', async () => {
    await p.query(`CREATE ROLE ${ROLE} NOLOGIN NOBYPASSRLS`);
    await p.query(`GRANT ${ROLE} TO CURRENT_USER`);
    await p.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
    await p.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
    for (const k of ['A', 'B']) {
      await p.query(`INSERT INTO organizations (id,name,slug,type,currency,timezone,created_at) VALUES ($1,$2,$3,'gym','INR','Asia/Kolkata',$4)`, [ORG[k], `Gym ${k}`, `${ORG[k]}-slug`, NOW]);
      await p.query(`INSERT INTO users (id,org_id,email,password_hash,role,name,active,created_at) VALUES ($1,$2,$3,'x','CLIENT',$4,1,$5)`, [`${TAG}_u${k}`, ORG[k], `${TAG}_${k}@t.test`, `Client ${k}`, NOW]);
      await p.query(`INSERT INTO clients (id,user_id,org_id,goal,created_at) VALUES ($1,$2,$3,'GENERAL',$4)`, [CLIENT[k], `${TAG}_u${k}`, ORG[k], NOW]);
    }
  });

  await t.test('a logged item is stored with its provenance class', async () => {
    const db = appDb(ORG.A);
    const { response } = await writeMealLogs(db, { clientId: CLIENT.A, date: '2026-11-15', slot: 'lunch', items: [item(), item({ name: 'AI curry', source: 'ai_estimated', ai_provider: 'groq' })] });
    const rows = await p.query(`SELECT name, nutrition_source, request_id FROM meal_logs WHERE id = ANY($1::text[]) ORDER BY name`, [response.ids]);
    assert.deepEqual(rows.rows.map((r) => [r.name, r.nutrition_source]), [['AI curry', 'ai_estimate'], ['Dal', 'user_provided']]);
    assert.ok(rows.rows.every((r) => r.request_id === response.request_id));
  });

  await t.test('CONCURRENT duplicates of one request log exactly once', async () => {
    const db = appDb(ORG.A);
    const body = { clientId: CLIENT.A, date: '2026-11-15', slot: 'dinner', items: [item({ name: 'Concurrent roti' })], requestId: `${TAG}_req_concurrent` };
    const results = await Promise.all(Array.from({ length: 6 }, () => writeMealLogs(db, body)));
    assert.equal(results.filter((r) => !r.replayed).length, 1, 'exactly one request did the write');
    const ids = new Set(results.map((r) => r.response.ids.join(',')));
    assert.equal(ids.size, 1, 'every caller got the same stored response');
    const n = await p.query(`SELECT count(*)::int AS n FROM meal_logs WHERE client_id = $1 AND name = 'Concurrent roti'`, [CLIENT.A]);
    assert.equal(n.rows[0].n, 1);
  });

  await t.test('RLS: gym B cannot read gym A\'s meal-log requests', async () => {
    const asB = appDb(ORG.B);
    const seen = await asB.q('SELECT request_id FROM meal_log_requests WHERE client_id = ?', [CLIENT.A]);
    assert.deepEqual(seen, []);
    const asA = appDb(ORG.A);
    assert.ok((await asA.q('SELECT request_id FROM meal_log_requests WHERE client_id = ?', [CLIENT.A])).length >= 2);
  });

  await t.test('RLS: gym B cannot write a log for gym A\'s client', async () => {
    const asB = appDb(ORG.B);
    await assert.rejects(
      () => writeMealLogs(asB, { clientId: CLIENT.A, date: '2026-11-15', slot: 'snack', items: [item({ name: 'Intruder' })] }),
      /row-level security|violates/i);
    const n = await p.query(`SELECT count(*)::int AS n FROM meal_logs WHERE name = 'Intruder'`);
    assert.equal(n.rows[0].n, 0, 'nothing was written');
  });

  await t.test('RLS: a person\'s corrections are recorded with the log and invisible to another gym', async () => {
    const asA = appDb(ORG.A);
    const proposed = { source_id: 'recipe:dal_home', name: 'Dal', grams: 150, qty: 1, unit: 'katori', calories: 131, assumed: true, matched_from: 'dal' };
    const { response } = await writeMealLogs(asA, {
      clientId: CLIENT.A, orgId: ORG.A, userId: `${TAG}_uA`, date: '2026-11-15', slot: 'lunch',
      items: [item({ name: 'Dal makhani', source_id: 'indb:ASC160', grams: 150, proposed })],
    });
    const mine = await asA.q('SELECT kind, phrase, meal_log_id FROM nutrition_corrections WHERE client_id = ?', [CLIENT.A]);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].kind, 'food_swap');
    assert.equal(mine[0].meal_log_id, response.ids[0]);
    const asB = appDb(ORG.B);
    assert.deepEqual(await asB.q('SELECT id FROM nutrition_corrections WHERE client_id = ?', [CLIENT.A]), [], 'gym B sees none of gym A\'s corrections');
    await assert.rejects(
      () => asB.run(`INSERT INTO nutrition_corrections (id, org_id, client_id, phrase, kind, original_json, corrected_json, source, created_at)
                     VALUES (?,?,?,?,?,?,?,?,?)`, [`${TAG}_ncor_x`, ORG.A, CLIENT.A, 'dal', 'food_swap', '{}', '{}', 'plate', NOW]),
      /row-level security|violates/i, 'gym B cannot write a correction for gym A\'s client');
    const rls = await p.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'nutrition_corrections'`);
    assert.deepEqual(rls.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
  });

  await t.after(async () => {
    try {
      await p.query(`DELETE FROM nutrition_corrections WHERE client_id = ANY($1::text[])`, [Object.values(CLIENT)]);
      await p.query(`DELETE FROM meal_logs WHERE client_id = ANY($1::text[])`, [Object.values(CLIENT)]);
      await p.query(`DELETE FROM meal_log_requests WHERE client_id = ANY($1::text[])`, [Object.values(CLIENT)]);
      await p.query(`DELETE FROM clients WHERE id = ANY($1::text[])`, [Object.values(CLIENT)]);
      await p.query(`DELETE FROM users WHERE org_id = ANY($1::text[])`, [Object.values(ORG)]);
      await p.query(`DELETE FROM organizations WHERE id = ANY($1::text[])`, [Object.values(ORG)]);
      await p.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${ROLE}`);
      await p.query(`REVOKE ALL ON SCHEMA public FROM ${ROLE}`);
      await p.query(`DROP ROLE IF EXISTS ${ROLE}`);
    } finally {
      await pool.end();
    }
  });
});
