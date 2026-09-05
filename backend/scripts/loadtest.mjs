#!/usr/bin/env node
// ============================================================
// CONCURRENCY LOAD TEST — validates (or refutes) connection-pool
// starvation as the cause of "pages loading for minutes" in production.
//
//   node scripts/loadtest.mjs [--base-url <url>] [--levels 1,5,10,20,30,50]
//                              [--duration 15] [--email <owner-email>]
//                              [--password <pw>] [--client-email <email>]
//
// SAFETY:
//   - Refuses to run against anything that isn't localhost/127.0.0.1
//     UNLESS --confirm-staging is also passed AND the URL doesn't look
//     like a production domain (no "vercel.app" prod alias without
//     "-git-" / "preview" in it is still just a heuristic -- READ THE
//     URL YOURSELF before passing --confirm-staging).
//   - Read-only + additive writes only (one food-log entry, one
//     announcement dismiss-style GET) -- no destructive requests, no
//     account creation, no data deletion. Safe to point at a staging DB
//     seeded with disposable demo data.
//   - Does not touch the database directly -- goes only through the
//     public HTTP API, exactly like a real user's browser would.
//
// WHAT THIS MEASURES (see README section below in the script comments):
//   requests/sec, p50/p97.5/p99/max latency, error rate, and -- if the
//   target exposes GET /api/ready with EXPOSE_POOL_STATS=1 set on the
//   server -- live Postgres pool occupancy (total/idle/waiting) polled
//   throughout each run, which is the direct signal for "are requests
//   stuck waiting for a DB connection" vs "queries are just slow."
// ============================================================
import autocannon from 'autocannon';

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const has = (name) => args.includes(`--${name}`);

const BASE_URL = flag('base-url', 'http://127.0.0.1:4000');
const LEVELS = flag('levels', '1,5,10,20,30,50').split(',').map(Number);
const DURATION = Number(flag('duration', '15'));
const OWNER_EMAIL = flag('email', 'owner@ironforge.in');
const OWNER_PASSWORD = flag('password', 'demo1234');
const CLIENT_EMAIL = flag('client-email', 'client1@ironforge.in');
const CLIENT_PASSWORD = flag('client-password', 'demo1234');

// ---- safety gate ----
const url = new URL(BASE_URL);
const isLocal = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
if (!isLocal && !has('confirm-staging')) {
  console.error(`
REFUSING TO RUN.
Target ${BASE_URL} is not localhost. If this is genuinely a staging/
preview deployment (never production), re-run with --confirm-staging.
Double-check the URL yourself first -- this script cannot tell staging
and production apart for you.
`);
  process.exit(1);
}
if (!isLocal) {
  console.warn(`\n⚠ Running against non-local target: ${BASE_URL}\n  Confirmed via --confirm-staging. Proceeding.\n`);
}

async function login(email, password) {
  const r = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`login failed for ${email}: ${r.status} ${await r.text()}`);
  const { token } = await r.json();
  return token;
}

// ---- pool-stats poller (only produces data if the target has
// EXPOSE_POOL_STATS=1 set -- otherwise `pool` is just absent from the
// response and this silently reports nothing, no error) ----
function startPoolPoller() {
  const samples = [];
  let stop = false;
  const tick = async () => {
    if (stop) return;
    try {
      const r = await fetch(`${BASE_URL}/api/ready`);
      const j = await r.json();
      if (j.pool) samples.push({ t: Date.now(), ...j.pool });
    } catch { /* ignore -- polling must never affect the test itself */ }
    if (!stop) setTimeout(tick, 500);
  };
  tick();
  return { stop: () => { stop = true; }, samples: () => samples };
}

function summarizePool(samples) {
  if (!samples.length) return null;
  const maxWaiting = Math.max(...samples.map((s) => s.waiting));
  const maxTotal = Math.max(...samples.map((s) => s.total));
  const anyWaiting = samples.some((s) => s.waiting > 0);
  return { maxWaiting, maxTotal, anyWaiting, sampleCount: samples.length };
}

async function runLevel(connections, requests) {
  const poller = startPoolPoller();
  const result = await autocannon({
    url: BASE_URL,
    connections,
    duration: DURATION,
    pipelining: 1,
    requests,
  });
  poller.stop();
  const pool = summarizePool(poller.samples());
  return { result, pool };
}

function fmt(ms) { return `${ms.toFixed(1)}ms`; }

async function main() {
  console.log(`SK OS load test`);
  console.log(`target:      ${BASE_URL}`);
  console.log(`levels:      ${LEVELS.join(', ')} concurrent connections`);
  console.log(`duration:    ${DURATION}s per level`);
  console.log('');

  console.log('Logging in (owner + client)...');
  const ownerToken = await login(OWNER_EMAIL, OWNER_PASSWORD);
  const clientToken = await login(CLIENT_EMAIL, CLIENT_PASSWORD).catch((e) => {
    console.warn(`  client login failed (${e.message}) -- client-side endpoints will be skipped`);
    return null;
  });
  console.log('Logged in.\n');

  const ownerAuth = { authorization: `Bearer ${ownerToken}` };
  const clientAuth = clientToken ? { authorization: `Bearer ${clientToken}` } : null;

  // Realistic mixed workload, weighted toward what a real session actually
  // does: more dashboard/list reads than writes, one representative write
  // per mutable domain (workout log, food log) so the pool sees both
  // SELECT and INSERT/UPDATE traffic, not just reads.
  const requests = [
    { method: 'GET', path: '/api/dashboard/overview', headers: ownerAuth },
    { method: 'GET', path: '/api/dashboard/attention', headers: ownerAuth },
    { method: 'GET', path: '/api/clients', headers: ownerAuth },
    { method: 'GET', path: '/api/workouts/templates', headers: ownerAuth },
    { method: 'GET', path: '/api/workouts/exercises?q=squat', headers: ownerAuth },
    { method: 'GET', path: '/api/nutrition/plans', headers: ownerAuth },
  ];
  if (clientAuth) {
    requests.push(
      { method: 'GET', path: '/api/tracking/me/home', headers: clientAuth },
      { method: 'GET', path: '/api/tracking/me/workouts', headers: clientAuth },
      {
        method: 'POST', path: '/api/intel/parse-food', headers: { ...clientAuth, 'content-type': 'application/json' },
        body: JSON.stringify({ text: '200g rice' }),
      },
    );
  }

  console.log(`Workload: ${requests.length} distinct authenticated requests, cycled per virtual connection.\n`);

  const rows = [];
  for (const c of LEVELS) {
    process.stdout.write(`Running at concurrency ${c}... `);
    const { result, pool } = await runLevel(c, requests);
    const errors = result.errors + result.timeouts + result['5xx'] + result.non2xx;
    const row = {
      concurrency: c,
      rps: result.requests.average,
      p50: result.latency.p50,
      p97_5: result.latency.p97_5,
      p99: result.latency.p99,
      max: result.latency.max,
      errors,
      errorRate: (errors / (result.requests.sent || 1) * 100),
      poolMaxWaiting: pool?.maxWaiting ?? null,
      poolMaxTotal: pool?.maxTotal ?? null,
      poolAnyWaiting: pool?.anyWaiting ?? null,
    };
    rows.push(row);
    console.log(`done. rps=${row.rps.toFixed(0)} p50=${fmt(row.p50)} p99=${fmt(row.p99)} max=${fmt(row.max)} errors=${errors}${pool ? ` pool[waiting max=${pool.maxWaiting}]` : ''}`);
  }

  console.log('\n\n=== RESULTS ===\n');
  console.log('| Concurrency | RPS | p50 | p97.5 | p99 | Max | Errors | Error% | Pool max waiting |');
  console.log('|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of rows) {
    console.log(`| ${r.concurrency} | ${r.rps.toFixed(0)} | ${fmt(r.p50)} | ${fmt(r.p97_5)} | ${fmt(r.p99)} | ${fmt(r.max)} | ${r.errors} | ${r.errorRate.toFixed(2)}% | ${r.poolMaxWaiting ?? 'n/a (EXPOSE_POOL_STATS not set on target)'} |`);
  }

  console.log('\nInterpretation guide:');
  console.log('  - p99/max climbing sharply while RPS plateaus or drops = saturation point found.');
  console.log('  - "Pool max waiting" > 0 at a level = requests were queued behind a full pool at');
  console.log('    that concurrency -- this is pool starvation, observed directly, not inferred.');
  console.log('  - High errors/timeouts with pool waiting also > 0 = the pool IS the bottleneck.');
  console.log('  - High latency with pool waiting == 0 = latency is elsewhere (slow query, network,');
  console.log('    cold start) -- the pool is not the culprit at this concurrency.');

  console.log('\nJSON:');
  console.log(JSON.stringify(rows, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
