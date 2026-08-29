// ============================================================
// /api/insights -- AI coach insights per client. Unlike alerts.js
// (staff-wide within an org), this route uses resolveClient(), which
// restricts a TRAINER to only the clients actually assigned to them --
// so the interesting boundary here is narrower than plain org isolation:
// same-org-but-not-my-client must still be denied. Zero prior test
// coverage existed for this live, frontend-wired route before this file.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import express from 'express';
import { config } from '../src/config.js';
import { resetRateLimits } from '../src/rateLimit.js';

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

const idp = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const makeToken = (userId, role, orgId) => jwt.sign({ sub: userId, role, org: orgId, name: 'Test', email: 't@test.com' }, config.jwtSecret, { expiresIn: '1h' });

async function seedOrg(db, suffix) {
  const orgId = idp('org'); const trainerId = idp('usr'); const ownerId = idp('usr'); const clientUserId = idp('usr'); const clientId = idp('cli');
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [orgId, `Org ${suffix}`, `org-${suffix}-${orgId}`, '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'TRAINER', 'Trainer', 1, ?)`, [trainerId, orgId, `t-${orgId}@test.com`, 'x', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'GYM_OWNER', 'Owner', 1, ?)`, [ownerId, orgId, `o-${orgId}@test.com`, 'x', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', 'Client', 1, ?)`, [clientUserId, orgId, `c-${orgId}@test.com`, 'x', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, trainer_id, goal, created_at) VALUES (?, ?, ?, ?, ?, ?)', [clientId, clientUserId, orgId, trainerId, 'FAT_LOSS', '2026-01-01T00:00:00Z']);
  return { orgId, trainerId, ownerId, clientUserId, clientId };
}

async function insertInsight(db, { orgId, clientId, trainerId, status = 'pending' }) {
  const insightId = idp('ins');
  await db.run(
    `INSERT INTO coach_insights (id, org_id, client_id, trainer_id, type, summary, recommendation, status, created_at)
     VALUES (?, ?, ?, ?, 'progress', 'Test summary', 'Test recommendation', ?, ?)`,
    [insightId, orgId, clientId, trainerId, status, '2026-01-01T00:00:00Z']);
  return insightId;
}

async function startApi(db) {
  const insightRoutes = (await import('../src/routes/insights.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/insights', insightRoutes(db));
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, { token, body } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/insights${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close };
}

test('GET /api/insights/clients/:id rejects an unauthenticated request', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const { call, close } = await startApi(db); t.after(() => close());
  const r = await call('GET', `/clients/${a.clientId}`);
  assert.equal(r.status, 401);
});

test('GET /api/insights/clients/:id rejects a CLIENT role entirely (staff-only router)', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const { call, close } = await startApi(db); t.after(() => close());
  const r = await call('GET', `/clients/${a.clientId}`, { token: makeToken(a.clientUserId, 'CLIENT', a.orgId) });
  assert.equal(r.status, 403);
});

test('GET /api/insights/clients/:id rejects a trainer from a different org (cross-org)', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const b = await seedOrg(db, 'b');
  const { call, close } = await startApi(db); t.after(() => close());
  const r = await call('GET', `/clients/${a.clientId}`, { token: makeToken(b.trainerId, 'TRAINER', b.orgId) });
  assert.equal(r.status, 403);
});

test('GET /api/insights/clients/:id rejects a same-org trainer who is not this client\'s assigned trainer (cross-user)', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const otherTrainerId = idp('usr');
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'TRAINER', 'Other Trainer', 1, ?)`, [otherTrainerId, a.orgId, `other-${a.orgId}@test.com`, 'x', '2026-01-01T00:00:00Z']);
  const { call, close } = await startApi(db); t.after(() => close());
  const r = await call('GET', `/clients/${a.clientId}`, { token: makeToken(otherTrainerId, 'TRAINER', a.orgId) });
  assert.equal(r.status, 403, 'insights are per-assigned-client, unlike alerts');
});

test('GET /api/insights/clients/:id allows the assigned trainer and the owner', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  await insertInsight(db, { orgId: a.orgId, clientId: a.clientId, trainerId: a.trainerId });
  const { call, close } = await startApi(db); t.after(() => close());

  const asTrainer = await call('GET', `/clients/${a.clientId}`, { token: makeToken(a.trainerId, 'TRAINER', a.orgId) });
  assert.equal(asTrainer.status, 200);
  assert.equal(asTrainer.json.insights.length, 1);

  const asOwner = await call('GET', `/clients/${a.clientId}`, { token: makeToken(a.ownerId, 'GYM_OWNER', a.orgId) });
  assert.equal(asOwner.status, 200);
  assert.equal(asOwner.json.insights.length, 1);
});

test('GET /api/insights/clients/:id 404s for a nonexistent client', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const { call, close } = await startApi(db); t.after(() => close());
  const r = await call('GET', '/clients/does_not_exist', { token: makeToken(a.trainerId, 'TRAINER', a.orgId) });
  assert.equal(r.status, 404);
});

test('POST /api/insights/clients/:id/analyze persists a pending insight scoped to the right org/client', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const { call, close } = await startApi(db); t.after(() => close());

  const r = await call('POST', `/clients/${a.clientId}/analyze`, { token: makeToken(a.trainerId, 'TRAINER', a.orgId) });
  assert.equal(r.status, 201);
  assert.equal(r.json.insight.status, 'pending');
  const row = await db.q1('SELECT * FROM coach_insights WHERE id = ?', [r.json.insight.id]);
  assert.equal(row.org_id, a.orgId);
  assert.equal(row.client_id, a.clientId);
  assert.equal(row.trainer_id, a.trainerId);
});

test('POST /api/insights/clients/:id/analyze rejects a trainer who does not own this client', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const otherTrainerId = idp('usr');
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'TRAINER', 'Other Trainer', 1, ?)`, [otherTrainerId, a.orgId, `other-${a.orgId}@test.com`, 'x', '2026-01-01T00:00:00Z']);
  const { call, close } = await startApi(db); t.after(() => close());
  const r = await call('POST', `/clients/${a.clientId}/analyze`, { token: makeToken(otherTrainerId, 'TRAINER', a.orgId) });
  assert.equal(r.status, 403);
  const rows = await db.q('SELECT * FROM coach_insights WHERE client_id = ?', [a.clientId]);
  assert.equal(rows.length, 0, 'a rejected analyze call must never persist an insight');
});

test('POST /api/insights/:id/action rejects acting on another org\'s insight', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const b = await seedOrg(db, 'b');
  const insightId = await insertInsight(db, { orgId: b.orgId, clientId: b.clientId, trainerId: b.trainerId });
  const { call, close } = await startApi(db); t.after(() => close());
  const r = await call('POST', `/${insightId}/action`, { token: makeToken(a.trainerId, 'TRAINER', a.orgId), body: { action: 'accept' } });
  assert.equal(r.status, 403);
  const row = await db.q1('SELECT status FROM coach_insights WHERE id = ?', [insightId]);
  assert.equal(row.status, 'pending');
});

test('POST /api/insights/:id/action accept/modify/dismiss all mutate correctly', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const { call, close } = await startApi(db); t.after(() => close());

  const accepted = await insertInsight(db, { orgId: a.orgId, clientId: a.clientId, trainerId: a.trainerId });
  let r = await call('POST', `/${accepted}/action`, { token: makeToken(a.trainerId, 'TRAINER', a.orgId), body: { action: 'accept' } });
  assert.equal(r.status, 200);
  assert.equal((await db.q1('SELECT status FROM coach_insights WHERE id = ?', [accepted])).status, 'accepted');

  const modified = await insertInsight(db, { orgId: a.orgId, clientId: a.clientId, trainerId: a.trainerId });
  r = await call('POST', `/${modified}/action`, { token: makeToken(a.trainerId, 'TRAINER', a.orgId), body: { action: 'modify', summary: 'Edited summary' } });
  assert.equal(r.status, 200);
  const modRow = await db.q1('SELECT * FROM coach_insights WHERE id = ?', [modified]);
  assert.equal(modRow.status, 'modified');
  assert.equal(modRow.summary, 'Edited summary');

  const dismissed = await insertInsight(db, { orgId: a.orgId, clientId: a.clientId, trainerId: a.trainerId });
  r = await call('POST', `/${dismissed}/action`, { token: makeToken(a.trainerId, 'TRAINER', a.orgId), body: { action: 'dismiss' } });
  assert.equal(r.status, 200);
  assert.equal((await db.q1('SELECT status FROM coach_insights WHERE id = ?', [dismissed])).status, 'dismissed');
});

test('POST /api/insights/:id/action rejects an invalid action value (schema-validated)', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const insightId = await insertInsight(db, { orgId: a.orgId, clientId: a.clientId, trainerId: a.trainerId });
  const { call, close } = await startApi(db); t.after(() => close());
  const r = await call('POST', `/${insightId}/action`, { token: makeToken(a.trainerId, 'TRAINER', a.orgId), body: { action: 'nonsense' } });
  assert.equal(r.status, 422);
});
