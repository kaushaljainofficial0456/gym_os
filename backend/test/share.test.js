// ============================================================
// GET /api/share/:id -- public preview of a shared meals/foods link.
//
// This is the one deliberately unauthenticated GET in the app (see
// share.js's own header comment: a recipient may not have an account yet,
// so viewing must never be gated behind login). The security contract
// here isn't "require auth" -- it's: the id is the only thing standing
// between a viewer and the data, so it must be unguessable; the response
// must never leak which org/client owns the link; a wrong/missing/
// malformed id must fail safely and identically; and the route must be
// rate-limited like every other unauthenticated write-adjacent surface
// in this app (see clientError.js, the sibling public route).
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { resetRateLimits } from '../src/rateLimit.js';
import { id, now } from '../src/ids.js';

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
    raw: db,
  };
}

async function seedOrgAndClient(db, suffix = '1') {
  const orgId = `org_${suffix}`;
  const clientId = `cl_${suffix}`;
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [orgId, `Org ${suffix}`, `org-${suffix}`, now()]);
  await db.run(
    `INSERT INTO clients (id, org_id, created_at) VALUES (?, ?, ?)`,
    [clientId, orgId, now()],
  );
  return { orgId, clientId };
}

async function insertShare(db, { orgId, clientId, sharedByName = 'Rahul Sharma', items }) {
  const shareId = id('shr');
  await db.run(
    `INSERT INTO shared_meals (id, org_id, client_id, shared_by_name, items_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [shareId, orgId, clientId, sharedByName, JSON.stringify(items), now()],
  );
  return shareId;
}

async function startApi(db) {
  const shareRoutes = (await import('../src/routes/share.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/share', shareRoutes(db));
  app.use((req, res) => res.status(404).json({ error: 'Not found' })); // mirror index.js's real catch-all
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (shareId, { method = 'GET' } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/share/${shareId}`, { method });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close };
}

const SAMPLE_ITEMS = [
  { type: 'food', name: 'Paneer Tikka', quantity: 1, unit: '150 g', calories: 300, protein: 22, carbs: 8, fat: 20, components: null },
];

test('GET /api/share/:id returns the shared items with no auth, for a fresh unauthenticated request', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId, clientId } = await seedOrgAndClient(db);
  const shareId = await insertShare(db, { orgId, clientId, items: SAMPLE_ITEMS });
  const { call, close } = await startApi(db); t.after(() => close());

  const r = await call(shareId);
  assert.equal(r.status, 200);
  assert.equal(r.json.id, shareId);
  assert.equal(r.json.shared_by_name, 'Rahul Sharma');
  assert.ok(r.json.created_at);
  assert.deepEqual(r.json.items, SAMPLE_ITEMS);
});

test('GET /api/share/:id never leaks which org/client owns the link', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId, clientId } = await seedOrgAndClient(db);
  const shareId = await insertShare(db, { orgId, clientId, items: SAMPLE_ITEMS });
  const { call, close } = await startApi(db); t.after(() => close());

  const r = await call(shareId);
  assert.equal(r.status, 200);
  const keys = Object.keys(r.json);
  assert.ok(!keys.includes('org_id'), 'org_id must never appear in a public response');
  assert.ok(!keys.includes('client_id'), 'client_id must never appear in a public response');
  assert.deepEqual(keys.sort(), ['created_at', 'id', 'items', 'shared_by_name'], 'response is an explicit whitelist, not a raw row spread');
});

test('GET /api/share/:id is viewable identically regardless of which org created it (public-by-design, not an IDOR)', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId: orgA, clientId: clientA } = await seedOrgAndClient(db, 'a');
  const { orgId: orgB, clientId: clientB } = await seedOrgAndClient(db, 'b');
  const shareFromA = await insertShare(db, { orgId: orgA, clientId: clientA, sharedByName: 'Org A Client', items: SAMPLE_ITEMS });
  const { call, close } = await startApi(db); t.after(() => close());

  // A completely unrelated org/client's viewer (in practice, an anonymous
  // browser) can still preview org A's share -- that's the whole point of
  // a link, not an authorization bypass. Confirms the route never applies
  // an accidental org filter that would make legitimate sharing flaky.
  const r = await call(shareFromA);
  assert.equal(r.status, 200);
  assert.equal(r.json.shared_by_name, 'Org A Client');
  void orgB; void clientB;
});

test('GET /api/share/:id returns a generic 404 for a nonexistent id, never distinguishing "never existed" from "deleted"', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { call, close } = await startApi(db); t.after(() => close());

  const r = await call('shr_doesnotexist000');
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'This shared link is invalid or has expired');
});

test('GET /api/share/:id fails safely (404, no crash, no leak) for SQL-injection-shaped, empty-lookalike, and oversized ids', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { call, close } = await startApi(db); t.after(() => close());

  const attempts = [
    "' OR '1'='1",
    "shr_x'; DROP TABLE shared_meals; --",
    '../../etc/passwd',
    'a'.repeat(5000),
    '%00',
    '<script>alert(1)</script>',
  ];
  for (const attempt of attempts) {
    const r = await call(encodeURIComponent(attempt));
    assert.equal(r.status, 404, `expected a clean 404 for id=${JSON.stringify(attempt)}, got ${r.status}`);
    assert.equal(r.json?.error, 'This shared link is invalid or has expired');
  }
  // The table must still exist and be untouched -- proves the injection
  // attempt above was never executed as SQL.
  const stillThere = await db.q('SELECT name FROM sqlite_master WHERE type = ? AND name = ?', ['table', 'shared_meals']);
  assert.equal(stillThere.length, 1, 'shared_meals table must survive an injection attempt unharmed');
});

test('GET /api/share/:id rejects unexpected HTTP methods the same way as any unmatched route', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId, clientId } = await seedOrgAndClient(db);
  const shareId = await insertShare(db, { orgId, clientId, items: SAMPLE_ITEMS });
  const { call, close } = await startApi(db); t.after(() => close());

  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const r = await call(shareId, { method });
    assert.equal(r.status, 404, `${method} /api/share/:id must not be handled as a GET`);
  }
});

test('GET /api/share/:id survives a link whose items_json is corrupt, returning an empty items array rather than 500ing', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId, clientId } = await seedOrgAndClient(db);
  const shareId = id('shr');
  await db.run(
    `INSERT INTO shared_meals (id, org_id, client_id, shared_by_name, items_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [shareId, orgId, clientId, 'Broken Link', '{not valid json', now()],
  );
  const { call, close } = await startApi(db); t.after(() => close());

  const r = await call(shareId);
  assert.equal(r.status, 200, 'a corrupt stored payload must degrade gracefully, never 500');
  assert.deepEqual(r.json.items, []);
});

test('GET /api/share/:id is rate-limited by IP so a scripted flood cannot hammer the lookup unbounded', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId, clientId } = await seedOrgAndClient(db);
  const shareId = await insertShare(db, { orgId, clientId, items: SAMPLE_ITEMS });
  const { call, close } = await startApi(db); t.after(() => close());

  const statuses = [];
  for (let i = 0; i < 65; i++) {
    statuses.push((await call(shareId)).status);
  }
  assert.ok(statuses.includes(429), `expected at least one 429 in a 65-request burst against a 60/min limit, got: ${statuses.filter((s) => s !== 200).join(',') || 'none'}`);
  assert.ok(statuses.slice(0, 60).every((s) => s === 200), 'the first 60 requests (at the configured limit) must all succeed');
});
