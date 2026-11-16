// Adapter-level load test: OLD (one pooled round trip, no tenant context --
// what db.q did before this change) vs NEW (db.js scoped(): checkout, BEGIN +
// set_config, statement, COMMIT -- RLS enforced on a NOBYPASSRLS role).
// Usage: node bench-load.mjs <worktree> <port> <label> [poolMax] [seconds] [levels]
const [root, port, label, poolMaxArg, secsArg, levelsArg] = process.argv.slice(2);
const { createPgDb, runWithOrg } = await import(`file:///${root.replace(/\\/g, '/')}/backend/src/db.js`);
const POOL = Number(poolMaxArg || 5); const SECS = Number(secsArg || 8);
const LEVELS = (levelsArg || '2,10,25,50').split(',').map(Number);
const url = `postgres://bench_app:benchpw@127.0.0.1:${port}/skos_bench`;
const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
// Representative request shapes.
const MEMBER = (g, m) => [ // member home: 5 statements
  ['SELECT * FROM clients WHERE user_id = ?', [`bu${g}_${m}`]],
  ['SELECT date, weight FROM weight_logs WHERE client_id = ? ORDER BY date DESC LIMIT 7', [`bc${g}_${m}`]],
  ["SELECT id, name, scheduled_date FROM workouts WHERE client_id = ? AND status = 'completed' ORDER BY scheduled_date DESC LIMIT 5", [`bc${g}_${m}`]],
  ['SELECT * FROM payments WHERE client_id = ? ORDER BY paid_at DESC LIMIT 1', [`bc${g}_${m}`]],
  ['SELECT count(*) AS n FROM attendance WHERE client_id = ? AND date >= ?', [`bc${g}_${m}`, '2026-10-16']],
];
const OWNER = (g) => [ // owner dashboard: 4 statements
  ["SELECT count(*) AS n FROM clients WHERE org_id = ? AND status = 'ON_TRACK'", [`bg${g}`]],
  ['SELECT coalesce(sum(amount),0) AS s FROM payments WHERE org_id = ? AND paid_at >= ?', [`bg${g}`, '2026-10-16']],
  ['SELECT count(*) AS n FROM attendance WHERE org_id = ? AND date = ?', [`bg${g}`, '2026-11-14']],
  ['SELECT id, status FROM clients WHERE org_id = ? ORDER BY created_at DESC LIMIT 20', [`bg${g}`]],
];
const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : NaN);
async function run(mode, gyms) {
  // OLD baseline = today's production: no context, fail-open policies, so
  // every row is visible. Modelled with a role RLS does not filter, so it
  // does the same row work. NEW = the NOBYPASSRLS runtime role, enforced.
  const connectionString = mode === 'old' ? url.replace('bench_app:benchpw', 'postgres:postgres') : url;
  const db = await createPgDb({ connectionString, max: POOL, mode: 'enforce' });
  const pool = db.raw;
  await Promise.all(Array.from({ length: POOL }, () => pool.query('SELECT 1')));
  const lat = []; let errors = 0; let stmts = 0; let maxWaiting = 0; let wrong = 0; let firstErr = null;
  const stopAt = performance.now() + SECS * 1000;
  const sampler = setInterval(() => { maxWaiting = Math.max(maxWaiting, pool.waitingCount); }, 5);
  await Promise.all(Array.from({ length: gyms }, async (_, gi) => {
    const g = gi + 1; let k = 0;
    while (performance.now() < stopAt) {
      const m = (k++ % 200) + 1;
      const owner = k % 5 === 0;
      const work = owner ? OWNER(g) : MEMBER(g, m);
      const t0 = performance.now();
      try {
        if (mode === 'old') {
          for (const [sql, p] of work) { await pool.query(toPg(sql), p); stmts++; }
        } else if (mode === 'new-tx') {
          await runWithOrg(`bg${g}`, () => db.tx(async (tx) => {
            for (const [sql, p] of work) {
              const r = await tx.q(sql, p); stmts++;
              if (!owner && sql.startsWith('SELECT * FROM clients') && r.length !== 1) wrong++;
            }
          }));
        } else {
          await runWithOrg(`bg${g}`, async () => {
            for (const [sql, p] of work) {
              const r = await db.q(sql, p); stmts++;
              if (!owner && sql.startsWith('SELECT * FROM clients') && r.length !== 1) wrong++;
              if (owner && sql.includes('count(*) AS n FROM clients') && Number(r[0].n) !== 200) wrong++;
            }
          });
        }
        lat.push(performance.now() - t0);
      } catch (e) { errors++; firstErr = firstErr || e.message; }
    }
  }));
  clearInterval(sampler);
  await pool.end();
  lat.sort((a, b) => a - b);
  return { label, mode, gyms, pool: POOL, requests: lat.length, rps: +(lat.length / SECS).toFixed(1), stmtPerSec: +(stmts / SECS).toFixed(0),
    p50: +pct(lat, 0.5).toFixed(2), p95: +pct(lat, 0.95).toFixed(2), p99: +pct(lat, 0.99).toFixed(2), errors, firstErr, maxPoolWaiting: maxWaiting, wrongRows: wrong };
}
for (const gyms of LEVELS) {
  for (const mode of (process.env.MODES || 'old,new').split(',')) console.log(JSON.stringify(await run(mode, gyms)));
}
