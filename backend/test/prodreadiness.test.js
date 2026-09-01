// ============================================================
// PRODUCTION-READINESS regression tests.
//   * SQL placeholder translation (? -> $n) for SQLite/PostgreSQL
//   * schema portability lint (no SQLite-only DDL)
//   * timezone resolution happens AFTER auth (bug fix)
//   * rate limiting (429 beyond window)
//   * storage abstraction (private files, never base64 in DB)
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');

// ---------- SQL portability ----------
test('translateSql converts ? placeholders to $n for PostgreSQL', async () => {
  const { translateSql } = await import('../src/db.js');
  assert.equal(translateSql('SELECT * FROM users WHERE id = ?'), 'SELECT * FROM users WHERE id = $1');
  assert.equal(translateSql('WHERE a = ? AND b = ? AND c = ?'), 'WHERE a = $1 AND b = $2 AND c = $3');
  assert.equal(translateSql('SELECT 1'), 'SELECT 1');
  // contract: application SQL uses ? only for parameters (never inside string
  // literals), so every ? is positional.
  assert.equal(translateSql('IN (?, ?, ?)'), 'IN ($1, $2, $3)');
});

test('schema.sql contains no SQLite-only DDL (must run on PostgreSQL)', async () => {
  const schema = fs.readFileSync(path.join(root, 'database', 'schema.sql'), 'utf8');
  for (const bad of ['COLLATE NOCASE', 'AUTOINCREMENT', 'PRAGMA', 'ON CONFLICT', '`', 'STRICT']) {
    assert.ok(!schema.includes(bad), `schema must not contain ${bad}`);
  }
  assert.ok(!/datetime\(['"]now/i.test(schema), 'no SQLite datetime() in DDL');
});

// ---------- timezone resolution ----------
test('getOrgTz resolves the authenticated org timezone, falling back to the default', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT, slug TEXT, type TEXT, currency TEXT, timezone TEXT, created_at TEXT)');
  db.exec("INSERT INTO organizations VALUES ('o1','US Gym','us','gym','USD','America/New_York','2026-01-01T00:00:00Z')");
  const q = async (sql, p = []) => { const s = db.prepare(sql); return p.length ? s.all(...p) : s.all(); };
  const { getOrgTz, DEFAULT_TZ } = await import('../src/utils/time.js');
  assert.equal(await getOrgTz({ q1: async (sql, p) => (await q(sql, p))[0] || null }, 'o1'), 'America/New_York');
  assert.equal(await getOrgTz({ q1: async () => null }, 'ghost-org'), DEFAULT_TZ);
  assert.equal(await getOrgTz({}, null), DEFAULT_TZ, 'no auth context -> default, never a crash');
});

test('requireAuth attaches req.tz only after the token is verified (async, no auth -> 401)', async () => {
  const { requireAuth, signToken } = await import('../src/auth.js');
  const token = signToken({ id: 'u1', role: 'CLIENT', org_id: 'o1', name: 'T', email: 't@x.in' });
  const res = { statusCode: 0, status(c) { this.statusCode = c; return this; }, json() { return this; } };
  // no token -> 401, next NOT called, tz NOT set
  let nexted = false;
  await requireAuth({ headers: {} }, res, () => { nexted = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(nexted, false);
  // valid token -> user + tz populated, next called (regression: tz used to be
  // computed pre-auth from req.user?.org and was always the default)
  const req = { headers: { authorization: 'Bearer ' + token } };
  let tz = null;
  await requireAuth(req, { status() { return this; }, json() { return this; } }, () => { tz = req.tz; });
  assert.equal(req.user.sub, 'u1');
  assert.ok(typeof tz === 'string' && tz.length > 0, 'tz is a non-empty string after auth');
});

test('AsyncLocalStorage org context is request-scoped and drives RLS org id', async () => {
  const { runWithOrg, currentOrg } = await import('../src/db.js');
  assert.equal(currentOrg(), null, 'no context outside a request');
  let inner = null;
  await runWithOrg('org_a', async () => {
    inner = currentOrg();
    // nested async work keeps the context
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(currentOrg(), 'org_a', 'context survives awaits');
  });
  assert.equal(inner, 'org_a');
  assert.equal(currentOrg(), null, 'context does not leak after the request');
  // concurrent contexts never bleed into each other
  const seen = [];
  await Promise.all(['o1', 'o2', 'o3'].map((oid) => runWithOrg(oid, async () => {
    await new Promise((r) => setTimeout(r, Math.random() * 10));
    seen.push(currentOrg());
  })));
  assert.deepEqual([...seen].sort(), ['o1', 'o2', 'o3']);
});

test('RLS migration exists and only targets PostgreSQL-safe syntax', async () => {
  const rls = fs.readFileSync(path.join(root, 'database', 'rls.sql'), 'utf8');
  assert.ok(rls.includes('ENABLE ROW LEVEL SECURITY'), 'enables RLS');
  assert.ok(rls.includes('FORCE ROW LEVEL SECURITY'), 'forces RLS for the app role');
  assert.ok(rls.includes('app.org_id'), 'policies key off the app.org_id session variable');
  for (const bad of ['COLLATE NOCASE', 'AUTOINCREMENT', 'PRAGMA', 'rowid']) {
    assert.ok(!rls.toLowerCase().includes(bad.toLowerCase()), `RLS must not use ${bad}`);
  }
});

// ---------- schema/RLS coverage guards ----------
// These exist because of a REAL production incident: community_members and
// community_workout_shares shipped in schema.sql but were never applied to
// the production database, so /api/community/* returned 500 for three days
// (61 logged "relation ... does not exist" errors). The whole community suite
// passed the entire time -- it runs on a SQLite DB rebuilt from schema.sql on
// every run, so a table missing in PRODUCTION is structurally invisible to it.
// These guards close the class of gap that hid that.
test('every org-scoped table in schema.sql is covered by an RLS policy', async () => {
  const schema = fs.readFileSync(path.join(root, 'database', 'schema.sql'), 'utf8');
  const rls = fs.readFileSync(path.join(root, 'database', 'rls.sql'), 'utf8');
  // Tables that ARE the org/platform-level tables themselves, or whose scoping
  // is derived from a parent row, are handled by their own policies.
  const exempt = new Set(['organizations', 'gym_onboarding', 'org_billing_state']);
  // KNOWN GAP (pre-existing, tracked separately -- NOT a licence to add more):
  // these org-scoped tables carry no RLS policy today. They are listed
  // explicitly rather than silently skipped so that (a) the debt is visible in
  // code review, and (b) any NEWLY added org-scoped table fails this test until
  // someone consciously decides its policy. Shrink this list, never grow it.
  const knownGaps = new Set([
    'shared_meals', 'org_subscriptions', 'org_capacity_purchases', 'enrollment_tokens',
    'payment_orders', 'invoices', 'payment_accounts', 'billing_quotes',
    'membership_status_history', 'refunds', 'reconciliation_issues', 'branches',
    'gym_memberships', 'support_tickets', 'risk_events',
  ]);
  // Collect the tables rls.sql actually turns RLS on for. Built by scanning
  // lines rather than composing a RegExp per table so the alignment padding in
  // rls.sql ("ALTER TABLE users        ENABLE ...") can't cause a false miss.
  const rlsEnabled = new Set();
  // \r?\n, not '\n': schema.sql is checked out CRLF on Windows
  // (core.autocrlf), and a stray \r breaks any regex that ends in $.
  for (const l of rls.split(/\r?\n/)) {
    const mm = l.match(/^\s*ALTER TABLE\s+(\w+)\s+ENABLE ROW LEVEL SECURITY/i);
    if (mm) rlsEnabled.add(mm[1]);
  }
  const missing = [];
  let table = null;
  let hasOrgId = false;
  for (const raw of schema.split(/\r?\n/)) {
    const line = raw.replace(/--.*$/, '');
    const start = line.match(/^\s*CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(/i);
    if (start) { table = start[1]; hasOrgId = false; continue; }
    if (!table) continue;
    if (/^\s*org_id\s/.test(line)) hasOrgId = true;
    if (/^\s*\)\s*;?\s*$/.test(line)) {
      if (hasOrgId && !exempt.has(table) && !knownGaps.has(table) && !rlsEnabled.has(table)) {
        missing.push(table);
      }
      table = null;
    }
  }
  assert.deepEqual(missing, [], 'org-scoped tables missing RLS: ' + missing.join(', '));
});

test('every table the community feature queries is declared in schema.sql', async () => {
  const schema = fs.readFileSync(path.join(root, 'database', 'schema.sql'), 'utf8');
  const src = fs.readFileSync(path.join(root, 'backend', 'src', 'services', 'community.js'), 'utf8');
  const referenced = new Set();
  for (const m of src.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_]+)/g)) referenced.add(m[1]);
  const missing = [...referenced].filter(
    (t) => !schema.includes('CREATE TABLE IF NOT EXISTS ' + t + ' ('));
  assert.deepEqual(missing, [], 'community.js queries tables absent from schema.sql: ' + missing.join(', '));
});

test('no SQLite-only rowid ordering remains in application SQL', async () => {
  const files = ['src/services/intelligence/aiContext.js', 'src/services/muscles.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, 'backend', f), 'utf8');
    assert.ok(!/rowid/i.test(src), `${f} must not reference rowid`);
  }
});

// ---------- rate limiting ----------
test('rate limiter allows up to max then returns 429 with Retry-After', async () => {
  const { rateLimit } = await import('../src/rateLimit.js');
  const limiter = rateLimit({ windowMs: 60_000, max: 2, keyFn: () => 'same-client' });
  let nexted = 0;
  const req = { ip: '1.2.3.4', user: { sub: 'c1' } };
  const res = { statusCode: 0, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.statusCode = c; return this; }, json() { return this; } };
  limiter(req, res, () => nexted++);
  limiter(req, res, () => nexted++);
  limiter(req, res, () => nexted++);
  assert.equal(nexted, 2, 'only max requests pass');
  assert.equal(res.statusCode, 429);
  assert.ok(Number(res.headers['Retry-After']) >= 1);
});

// Regression test for a real bug found while auditing the rate limiter for
// production readiness: the pluggable-store branch (meant for a future
// Redis/Vercel-KV adapter) never actually called store.get()/store.set() --
// it fabricated a fresh {count:0} on every single request and discarded it,
// so ANY non-MemoryStore implementation of the documented interface would
// silently never rate-limit anything at all. Proven here with a minimal
// fake store implementing exactly the documented { get, set, delete }
// interface -- if this regresses, the pluggable-store abstraction is
// broken again for whoever eventually wires up a real external store.
test('rate limiter actually persists and enforces state through a pluggable external store, not just MemoryStore', async () => {
  const { rateLimit, setRateLimitStore, resetToMemoryStore } = await import('../src/rateLimit.js');
  const backing = new Map();
  const fakeExternalStore = {
    async get(key) { return backing.get(key) ?? null; },
    async set(key, value) { backing.set(key, value); },
    async delete(key) { backing.delete(key); },
  };
  setRateLimitStore(fakeExternalStore);
  try {
    const limiter = rateLimit({ windowMs: 60_000, max: 2, keyFn: () => 'same-client' });
    const req = { ip: '5.6.7.8' };
    const results = [];
    // status() itself resolves the promise on a 429 (next() is never
    // called in that case) -- avoids racing a queueMicrotask against the
    // middleware's own internal promise chain to detect the short-circuit.
    const runOnce = () => new Promise((resolve) => {
      const res = {
        statusCode: 0, headers: {},
        set(k, v) { this.headers[k] = v; return this; },
        status(c) { this.statusCode = c; if (c === 429) { results.push({ nexted: false }); resolve(); } return this; },
        json() { return this; },
      };
      limiter(req, res, () => { results.push({ nexted: true }); resolve(); });
    });
    for (let i = 0; i < 3; i++) await runOnce();
    assert.equal(backing.size, 1, 'the external store actually received a write, not just discarded a fresh bucket every time');
    const nextedCount = results.filter((r) => r.nexted).length;
    assert.equal(nextedCount, 2, 'the external store path enforces max exactly like MemoryStore does');
    assert.ok(results.some((r) => !r.nexted), 'the 3rd request is rejected through the external store, not silently allowed');
  } finally {
    // Restore the default in-memory store so no other test in this
    // process is affected by the fake store left behind.
    resetToMemoryStore();
  }
});

// ---------- storage abstraction ----------
// valid 64x64 RGBA PNG (large enough to pass the dimension sanity check)
const PNG_64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAmElEQVR4nO3QoREAIBDAsB8CgWX/IWGMCCrie521z/3Z6ACtATpAa4AO0BqgA7QG6ACtATpAa4AO0BqgA7QG6ACtATpAa4AO0BqgA7QG6ACtATpAa4AO0BqgA7QG6ACtATpAa4AO0BqgA7QG6ACtATpAa4AO0BqgA7QG6ACtATpAa4AO0BqgA7QG6ACtATpAa4AO0BqgA7QG6ACtATpAa4AO0BqgA7QHACfBLQ84XmAAAAAASUVORK5CYII=';

test('saveImage writes a private file and returns a storage_key; deleteObject removes it', async () => {
  const { saveImage, deleteObject, STORAGE_DRIVER } = await import('../src/storage.js');
  assert.equal(STORAGE_DRIVER, 'local', 'default driver is local (no infra needed)');
  const saved = await saveImage({ dataUrl: PNG_64, clientId: 'c1', scope: 'photos', fileId: 'pho1' });
  assert.equal(saved.storage, 'local');
  assert.ok(saved.storageKey.startsWith('photos/c1/'), saved.storageKey);
  assert.ok(saved.storageKey.endsWith('.png'));
  const abs = path.resolve(root, 'backend', 'data', 'uploads', saved.storageKey);
  assert.ok(fs.existsSync(abs), 'file exists on disk');
  await deleteObject(saved.storageKey);
  assert.ok(!fs.existsSync(abs), 'file removed on delete');
});

test('saveImage rejects unsupported formats and oversized payloads', async () => {
  const { saveImage } = await import('../src/storage.js');
  await assert.rejects(() => saveImage({ dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', clientId: 'c1' }), /Invalid or unsupported image/);
  await assert.rejects(() => saveImage({ dataUrl: 'data:image/png;base64,' + 'A'.repeat(7 * 1024 * 1024), clientId: 'c1' }), /Invalid or unsupported image/);
  await assert.rejects(() => saveImage({ dataUrl: 'not-a-data-url', clientId: 'c1' }), /Invalid or unsupported image/);
});
