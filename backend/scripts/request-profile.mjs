// ============================================================
// REQUEST PROFILE -- database round trips and response time for the
// requests each main screen makes on first load.
//
//   node backend/scripts/request-profile.mjs [--rtt=8] [--runs=3] [--json=out.json]
//
// Why round trips: production runs on Vercel functions talking to Neon
// over the network, so every query is a network round trip. Locally the
// database is an in-process SQLite file and costs microseconds, which
// hides exactly the cost users feel. This script counts every statement a
// request issues (including the ones middleware runs before the route)
// and adds a simulated round-trip delay (--rtt, milliseconds, default 8)
// to each one, so "this request waits on 12 sequential queries" shows up
// as time, the way it does in production.
//
// The numbers are a MODEL, not a production measurement: they show how
// many round trips a request makes and how that scales with latency. Use
// them to compare two versions of the code on the same machine.
//
// Safety: builds a throwaway SQLite database in the OS temp directory
// (init-db + the deterministic demo seed), never reads .env, and refuses
// to run if DATABASE_URL is set.
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.env.DATABASE_URL) {
  console.error('request-profile: DATABASE_URL is set. This script only runs against a throwaway SQLite database; unset it.');
  process.exit(1);
}

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const RTT = Number(arg('rtt', 8));
const RUNS = Number(arg('runs', 3));
const JSON_OUT = arg('json', null);
// --trace=/tracking/me/home prints every statement that request issues, in
// order, with its start offset -- the quickest way to see a sequential chain.
const TRACE = arg('trace', null);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skos-profile-'));
const dbFile = path.join(tmpDir, 'profile.db');
const env = { ...process.env, SQLITE_PATH: dbFile, NODE_ENV: 'development' };
delete env.DATABASE_URL;

console.log(`[profile] throwaway database: ${dbFile}`);
execFileSync(process.execPath, [path.join(root, 'backend/scripts/init-db.js')], { env, cwd: tmpDir, stdio: 'ignore' });
execFileSync(process.execPath, [path.join(root, 'backend/scripts/seed.js')], { env, cwd: tmpDir, stdio: 'ignore' });

process.env.SQLITE_PATH = dbFile;
process.env.NODE_ENV = 'development';
const { getDb } = await import('../src/db.js');
const { buildApp } = await import('../src/index.js');
const { resetRateLimits } = await import('../src/rateLimit.js');

const db = await getDb();
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
let queries = 0;
let trace = null;
const counted = (target, name) => {
  const orig = target[name].bind(target);
  target[name] = async (...a) => {
    queries += 1;
    if (trace && !trace.done) trace.push([Math.round(performance.now() - trace.t0), String(a[0]).replace(/\s+/g, ' ').trim().slice(0, 110)]);
    await sleep(RTT);
    return orig(...a);
  };
};
// q1 delegates to q on the SQLite driver, so wrapping q and run counts each
// statement once. Transactions get the same treatment on their own handle.
counted(db, 'q');
counted(db, 'run');
const origTx = db.tx.bind(db);
db.tx = (fn, opts) => origTx(async (txDb) => {
  counted(txDb, 'q');
  counted(txDb, 'run');
  return fn(txDb);
}, opts);

const app = await buildApp();
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;

async function login(email) {
  resetRateLimits();
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'demo1234' }),
  });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  if (!res.ok || !cookie) throw new Error(`login failed for ${email}: ${res.status}`);
  return cookie;
}

// The requests each screen makes on first load, read from the page
// components (useFetch calls and the layout around them).
const SCREENS = {
  CLIENT: {
    email: 'client1@ironforge.in',
    screens: {
      'Client shell + Home': ['/auth/me', '/me/profile', '/tracking/me/home', '/intel/coach/brief', '/intel/coach/weekly',
        '/me/dashboard', '/communities', '/health/daily-intelligence', '/me/crowd'],
      Workout: ['/tracking/me/today', '/tracking/me/week', '/tracking/me/workouts', '/me/permissions'],
      Nutrition: ['/me/nutrition/balance'],
      Progress: ['/tracking/me/progress/intel?days=30', '/tracking/me/progress'],
      Community: ['/community/membership', '/community/overview?period=week', '/community/leaderboards?period=week',
        '/community/challenges', '/community/feed?limit=10&offset=0&scope=gym'],
    },
  },
  GYM_OWNER: {
    email: 'owner@ironforge.in',
    screens: {
      'Owner shell + Dashboard': ['/auth/me', '/me/profile', '/dashboard/overview', '/dashboard/attention', '/dashboard/pulse', '/messages/unread'],
      Clients: ['/clients'],
      Business: ['/admin/overview', '/admin/members', '/enterprise/payment-account'],
    },
  },
  TRAINER: {
    email: 'trainer1@ironforge.in',
    screens: {
      'Trainer shell + Dashboard': ['/auth/me', '/me/profile', '/dashboard/trainer', '/dashboard/adherence-trend', '/trainer/crowd', '/trainer/crowd/clients', '/messages/unread'],
    },
  },
};

async function timed(cookie, p) {
  queries = 0;
  const t0 = performance.now();
  if (TRACE && p === TRACE && !trace) { trace = []; trace.t0 = t0; }
  const res = await fetch(base + p, { headers: { cookie } });
  await res.arrayBuffer();
  if (trace && !trace.done) {
    trace.done = true;
    console.log(`\n[trace] ${p}`);
    for (const [at, sql] of trace) console.log(`  +${String(at).padStart(4)}ms  ${sql}`);
  }
  return { status: res.status, ms: performance.now() - t0, queries };
}

const results = { rttMs: RTT, runs: RUNS, endpoints: {}, screens: {} };
for (const [role, spec] of Object.entries(SCREENS)) {
  const cookie = await login(spec.email);
  for (const [screen, paths] of Object.entries(spec.screens)) {
    // Sequential pass: exact statement count per request.
    for (const p of paths) {
      const samples = [];
      for (let i = 0; i < RUNS; i += 1) samples.push(await timed(cookie, p));
      const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
      results.endpoints[`${role} ${p}`] = {
        status: samples[0].status,
        queriesFirst: samples[0].queries,
        queriesWarm: samples[samples.length - 1].queries,
        msMedian: Math.round(ms[Math.floor(ms.length / 2)]),
      };
    }
    // Parallel pass: what the browser does on that screen -- every request
    // at once; the screen is ready when the slowest one answers.
    const walls = [];
    for (let i = 0; i < RUNS; i += 1) {
      const t0 = performance.now();
      await Promise.all(paths.map((p) => fetch(base + p, { headers: { cookie } }).then((r) => r.arrayBuffer())));
      walls.push(performance.now() - t0);
    }
    walls.sort((a, b) => a - b);
    results.screens[`${role} ${screen}`] = { requests: paths.length, msMedian: Math.round(walls[Math.floor(walls.length / 2)]) };
  }
}

server.close();
const pad = (s, n) => String(s).padEnd(n);
console.log(`\nSimulated DB round trip: ${RTT} ms per statement; ${RUNS} runs each (median).`);
console.log('\n' + pad('endpoint', 62) + pad('status', 8) + pad('queries(1st)', 14) + pad('queries(warm)', 15) + 'ms');
for (const [k, v] of Object.entries(results.endpoints)) {
  console.log(pad(k, 62) + pad(v.status, 8) + pad(v.queriesFirst, 14) + pad(v.queriesWarm, 15) + v.msMedian);
}
console.log('\n' + pad('screen (requests in parallel)', 50) + pad('requests', 10) + 'ms');
for (const [k, v] of Object.entries(results.screens)) console.log(pad(k, 50) + pad(v.requests, 10) + v.msMedian);
const totalWarm = Object.values(results.endpoints).reduce((s, v) => s + v.queriesWarm, 0);
console.log(`\nTotal statements across all profiled requests (warm): ${totalWarm}`);
results.totalQueriesWarm = totalWarm;
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
try { db.raw.close(); } catch { /* already closed */ }
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows may still hold the file; the OS temp dir is cleaned eventually */ }
process.exit(0);
