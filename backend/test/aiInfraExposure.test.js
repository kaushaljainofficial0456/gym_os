// ============================================================
// F-11 REGRESSION: GET /intel/coach/status and GET /intel/food-ai/status
// used to return full infrastructure/provider diagnostics (which AI
// vendors are configured, live availability, cooldown state, an internal
// Ollama base URL, daily usage counts) to ANY authenticated account,
// CLIENT included -- no frontend consumer of either route was found
// anywhere in the codebase, and a gym member has no legitimate reason to
// hold that reconnaissance. No secret VALUE ever leaked, but the
// configuration shape itself did.
//
// Fix: every authenticated caller still gets the one boolean a client-
// facing "AI Coach unavailable" banner would need; the full diagnostic
// payload is now GYM_OWNER/SUPER_ADMIN only.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import express from 'express';
import { config } from '../src/config.js';

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
    exec(sql) { db.exec(sql); },
    raw: db,
  };
}

async function seedOrgWithOwnerAndClient(db) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym', 'gym-o1', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('owner1', 'o1', 'owner@x.in', 'x', 'GYM_OWNER', 'Owner', 1, '2026-01-01T00:00:00Z')`);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('u1', 'o1', 'c1@x.in', 'x', 'CLIENT', 'Client', 1, '2026-01-01T00:00:00Z')`);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)', ['c1', 'u1', 'o1', 'FAT_LOSS', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO client_profiles (client_id, water_target_l, sleep_target_h) VALUES ('c1', 3, 8)`);
}

function tokenFor(user) {
  return jwt.sign({ sub: user.id, role: user.role, org: user.org_id, name: user.name }, config.jwtSecret, { expiresIn: '1h' });
}

async function startIntelApi(db) {
  const intelRoutes = (await import('../src/routes/intelligence.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/intel', intelRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, user) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { Authorization: `Bearer ${tokenFor(user)}` },
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close };
}

const CLIENT = { id: 'u1', role: 'CLIENT', org_id: 'o1' };
const OWNER = { id: 'owner1', role: 'GYM_OWNER', org_id: 'o1' };
const SUPER_ADMIN = { id: 'super1', role: 'SUPER_ADMIN', org_id: null };

test('GET /intel/coach/status: CLIENT gets only { ok, available }, no infra diagnostics', async (t) => {
  const db = await memDb();
  await seedOrgWithOwnerAndClient(db);
  const api = await startIntelApi(db);
  t.after(() => api.close());
  const r = await api.call('GET', '/intel/coach/status', CLIENT);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ['available', 'ok'], 'CLIENT response carries only ok/available -- no provider, ollamaBase, hasKey, or ollama ping detail');
  assert.equal(typeof r.json.available, 'boolean');
});

test('GET /intel/coach/status: GYM_OWNER still gets the full diagnostic payload', async (t) => {
  const db = await memDb();
  await seedOrgWithOwnerAndClient(db);
  const api = await startIntelApi(db);
  t.after(() => api.close());
  const r = await api.call('GET', '/intel/coach/status', OWNER);
  assert.equal(r.status, 200);
  assert.ok('provider' in r.json, 'owner keeps provider name');
  assert.ok('ollamaBase' in r.json, 'owner keeps the ollama base URL diagnostic');
  assert.ok('ollama' in r.json, 'owner keeps the live ping detail');
});

test('GET /intel/coach/status: SUPER_ADMIN also gets the full diagnostic payload', async (t) => {
  const db = await memDb();
  await seedOrgWithOwnerAndClient(db);
  const api = await startIntelApi(db);
  t.after(() => api.close());
  const r = await api.call('GET', '/intel/coach/status', SUPER_ADMIN);
  assert.equal(r.status, 200);
  assert.ok('provider' in r.json);
});

test('GET /intel/food-ai/status: CLIENT gets only { ok, available }, no provider chain/diagnostics', async (t) => {
  const db = await memDb();
  await seedOrgWithOwnerAndClient(db);
  const api = await startIntelApi(db);
  t.after(() => api.close());
  const r = await api.call('GET', '/intel/food-ai/status', CLIENT);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ['available', 'ok'], 'CLIENT response never carries chain, chainAvailability, dailyUsage, cooldownActive, or the diagnostics block');
  assert.equal(typeof r.json.available, 'boolean');
});

test('GET /intel/food-ai/status: GYM_OWNER still gets the full provider-chain diagnostics', async (t) => {
  const db = await memDb();
  await seedOrgWithOwnerAndClient(db);
  const api = await startIntelApi(db);
  t.after(() => api.close());
  const r = await api.call('GET', '/intel/food-ai/status', OWNER);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.chain), 'owner keeps the provider chain');
  assert.ok('chainAvailability' in r.json, 'owner keeps per-provider availability');
  assert.ok('diagnostics' in r.json, 'owner keeps the allowPaidAI/hasKey diagnostics block');
  assert.ok('hasKey' in r.json.diagnostics, 'diagnostics still never expose a key VALUE, only presence booleans');
});
