// ============================================================
// F-08 REGRESSION: routes/auth.js's failed-login brute-force counter
// now goes through the SAME pluggable store rateLimit.js's own
// middleware uses (getRateLimitStore()), instead of a bespoke
// always-in-memory Map -- so when Upstash is configured, this specific
// guard survives across serverless instances too. This test verifies
// the observable behavior is unchanged: 5 failed attempts per email+IP
// in 60s -> 429, reset immediately on a successful login, real end-to-
// end through the actual /api/auth/login route (not the internal
// helper functions directly, which are no longer exported).
// ============================================================
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import express from 'express';
import { resetRateLimits, resetToMemoryStore } from '../src/rateLimit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  return {
    driver: 'sqlite',
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await this.q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
  };
}

async function startApp(db) {
  const authRoutes = (await import('../src/routes/auth.js')).default;
  const app = express();
  app.use(express.json());
  // No IP-faking middleware needed: every request in a test comes from
  // this SAME test process to this SAME loopback server, so req.ip
  // (Express 5: a getter over req.socket.remoteAddress, not directly
  // assignable) is naturally identical across calls within one test --
  // exactly the "same IP" precondition these tests need.
  app.use('/api/auth', authRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close };
}

test.beforeEach(() => { resetRateLimits(); resetToMemoryStore(); });

test('5 failed logins for the same email+IP -> the 6th is 429, even with a correct password', async (t) => {
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym', 'gym-o1', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('u1', 'o1', 'brute@x.in', ?, 'CLIENT', 'X', 1, '2026-01-01T00:00:00Z')`,
    [await bcrypt.hash('correct-password', 10)]);
  const api = await startApp(db);
  t.after(() => api.close());

  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const r = await api.call('POST', '/api/auth/login', { email: 'brute@x.in', password: 'wrong-guess-' + i });
    statuses.push(r.status);
  }
  assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401], 'first 5 wrong-password attempts are ordinary 401s');
  assert.equal(statuses[5], 429, 'the 6th attempt in the window is rate-limited, regardless of password correctness');

  // Even the CORRECT password is blocked once the limit is hit -- this
  // is a brute-force guard, not a "only count wrong guesses forever" one.
  const stillBlocked = await api.call('POST', '/api/auth/login', { email: 'brute@x.in', password: 'correct-password' });
  assert.equal(stillBlocked.status, 429, 'still rate-limited even with the right password, until the window rolls over');
});

test('a successful login resets the failed-attempt counter for that email+IP', async (t) => {
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym', 'gym-o1', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('u1', 'o1', 'retry@x.in', ?, 'CLIENT', 'X', 1, '2026-01-01T00:00:00Z')`,
    [await bcrypt.hash('correct-password', 10)]);
  const api = await startApp(db);
  t.after(() => api.close());

  // 2 typos, then success -- must never be penalized.
  await api.call('POST', '/api/auth/login', { email: 'retry@x.in', password: 'typo1' });
  await api.call('POST', '/api/auth/login', { email: 'retry@x.in', password: 'typo2' });
  const success = await api.call('POST', '/api/auth/login', { email: 'retry@x.in', password: 'correct-password' });
  assert.equal(success.status, 200, 'a correct password after a couple of typos still succeeds');

  // And the counter is genuinely reset -- another 4 wrong guesses right
  // after (5 total across the whole test, but only 4 in a row post-reset)
  // must NOT trip the limiter, proving success cleared the prior count
  // rather than merely not incrementing it further.
  const afterReset = [];
  for (let i = 0; i < 4; i++) {
    const r = await api.call('POST', '/api/auth/login', { email: 'retry@x.in', password: 'wrong-again-' + i });
    afterReset.push(r.status);
  }
  assert.ok(afterReset.every((s) => s === 401), `all 4 post-success attempts are ordinary 401s, not 429 -- got ${JSON.stringify(afterReset)}`);
});

test('different emails at the same IP have independent counters', async (t) => {
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym', 'gym-o1', '2026-01-01T00:00:00Z']);
  for (const email of ['a@x.in', 'b@x.in']) {
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, 'o1', ?, ?, 'CLIENT', 'X', 1, '2026-01-01T00:00:00Z')`,
      [email, email, await bcrypt.hash('pw', 10)]);
  }
  const api = await startApp(db);
  t.after(() => api.close());

  for (let i = 0; i < 5; i++) await api.call('POST', '/api/auth/login', { email: 'a@x.in', password: 'wrong' });
  const aBlocked = await api.call('POST', '/api/auth/login', { email: 'a@x.in', password: 'wrong' });
  assert.equal(aBlocked.status, 429, 'a@x.in is now rate-limited');

  const bStillFine = await api.call('POST', '/api/auth/login', { email: 'b@x.in', password: 'wrong-once' });
  assert.equal(bStillFine.status, 401, 'b@x.in (same IP, different email) is a plain 401, not 429 -- counters are keyed per email+IP, not per IP alone');
});
