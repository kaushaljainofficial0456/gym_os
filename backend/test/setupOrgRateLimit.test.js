// ============================================================
// REMEDIATION: POST /auth/setup-org abuse gate.
//
// This route is public and unauthenticated by design (the "Enterprise"
// self-serve signup entry point -- see its own header comment in
// routes/auth.js for why SETUP_SECRET defaults to unset/open). Before
// this change the only backstop was a flat 10/min-per-IP ceiling, wide
// enough to let a sustained script create thousands of orgs a day from
// one IP. Now two independently-namespaced limiters are stacked: a
// tighter burst ceiling (5/min) and a hard daily ceiling (20/day) --
// see rateLimit.js's own comment on why stacking multiple rateLimit()
// instances on one route is safe (each gets its own counter namespace).
//
// Both limiters run BEFORE validate() in the middleware chain, so an
// intentionally-invalid body is enough to exercise the counting logic
// without needing a fully valid org-creation payload per request.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { resetRateLimits } from '../src/rateLimit.js';

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8'));
  return {
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const stmt = db.prepare(sql); const rows = params.length ? stmt.all(...params) : stmt.all(); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
    async tx(fn) {
      db.exec('BEGIN');
      try { const out = await fn(this); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
  };
}

async function startApp() {
  const authRoutes = (await import('../src/routes/auth.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes(await memDb()));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// Deliberately invalid body (fails zod validation) -- fine, since both
// rate limiters run BEFORE validate() and we're only proving the counting
// behavior, not a successful org creation.
const INVALID_BODY = JSON.stringify({});

test('POST /auth/setup-org: burst ceiling -- 5 requests/min from one IP succeed past the limiter (422 = reached validate()), the 6th is 429', async () => {
  resetRateLimits();
  const { server, base } = await startApp();
  try {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${base}/api/auth/setup-org`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: INVALID_BODY });
      statuses.push(res.status);
    }
    assert.ok(statuses.slice(0, 5).every((s) => s !== 429), `first 5 requests must all pass the rate limiter: ${statuses}`);
    assert.equal(statuses[5], 429, `the 6th request in the same minute must be rate-limited: ${statuses}`);
  } finally {
    server.closeAllConnections?.(); server.close();
  }
});

test('POST /auth/setup-org: a 429 response carries Retry-After', async () => {
  resetRateLimits();
  const { server, base } = await startApp();
  try {
    for (let i = 0; i < 5; i++) {
      await fetch(`${base}/api/auth/setup-org`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: INVALID_BODY });
    }
    const res = await fetch(`${base}/api/auth/setup-org`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: INVALID_BODY });
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) > 0);
  } finally {
    server.closeAllConnections?.(); server.close();
  }
});
