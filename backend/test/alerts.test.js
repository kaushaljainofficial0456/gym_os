// ============================================================
// /api/alerts -- at-risk client alerts, visible to any trainer/owner in
// the org (not scoped to "your own assigned clients" the way insights/
// reports are -- an at-risk signal is meant to be actionable by whoever
// on staff sees it first). This suite locks in that model and the
// boundaries that DO apply: auth, role, org isolation, and input
// validation. Zero prior test coverage existed for this live, frontend-
// wired route before this file.
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

async function seedOrgWithClient(db, suffix) {
  const orgId = idp('org'); const trainerId = idp('usr'); const clientUserId = idp('usr'); const clientId = idp('cli');
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [orgId, `Org ${suffix}`, `org-${suffix}-${orgId}`, '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'TRAINER', 'Trainer', 1, ?)`, [trainerId, orgId, `t-${orgId}@test.com`, 'x', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', 'Client', 1, ?)`, [clientUserId, orgId, `c-${orgId}@test.com`, 'x', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, trainer_id, goal, created_at) VALUES (?, ?, ?, ?, ?, ?)', [clientId, clientUserId, orgId, trainerId, 'FAT_LOSS', '2026-01-01T00:00:00Z']);
  return { orgId, trainerId, clientUserId, clientId };
}

async function insertAlert(db, { orgId, clientId, status = 'open', type = 'NO_WORKOUT' }) {
  const alertId = idp('alert');
  await db.run(
    `INSERT INTO alerts (id, org_id, client_id, type, severity, title, status, created_at) VALUES (?, ?, ?, ?, 'medium', 'Test alert', ?, ?)`,
    [alertId, orgId, clientId, type, status, '2026-01-01T00:00:00Z']);
  return alertId;
}

async function startApi(db) {
  const alertRoutes = (await import('../src/routes/alerts.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/alerts', alertRoutes(db));
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, { token, body } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/alerts${p}`, {
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

test('GET /api/alerts rejects an unauthenticated request', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { call, close } = await startApi(db); t.after(() => close());
  const r = await call('GET', '/');
  assert.equal(r.status, 401);
});

test('GET /api/alerts rejects a CLIENT (alerts are staff-only)', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId, clientUserId } = await seedOrgWithClient(db, 'a');
  const { call, close } = await startApi(db); t.after(() => close());
  const r = await call('GET', '/', { token: makeToken(clientUserId, 'CLIENT', orgId) });
  assert.equal(r.status, 403);
});

test('GET /api/alerts only ever returns this org\'s alerts, never another org\'s', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrgWithClient(db, 'a');
  const b = await seedOrgWithClient(db, 'b');
  await insertAlert(db, { orgId: a.orgId, clientId: a.clientId });
  await insertAlert(db, { orgId: b.orgId, clientId: b.clientId });
  const { call, close } = await startApi(db); t.after(() => close());

  const r = await call('GET', '/', { token: makeToken(a.trainerId, 'TRAINER', a.orgId) });
  assert.equal(r.status, 200);
  assert.equal(r.json.alerts.length, 1);
  assert.equal(r.json.alerts[0].org_id, a.orgId);
});

test('GET /api/alerts?status= filters correctly', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrgWithClient(db, 'a');
  await insertAlert(db, { orgId: a.orgId, clientId: a.clientId, status: 'open', type: 'NO_WORKOUT' });
  await insertAlert(db, { orgId: a.orgId, clientId: a.clientId, status: 'dismissed', type: 'PLATEAU' });
  const { call, close } = await startApi(db); t.after(() => close());

  const r = await call('GET', '/?status=dismissed', { token: makeToken(a.trainerId, 'TRAINER', a.orgId) });
  assert.equal(r.status, 200);
  assert.equal(r.json.alerts.length, 1);
  assert.equal(r.json.alerts[0].status, 'dismissed');
});

test('POST /api/alerts/:id/action rejects acting on another org\'s alert', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrgWithClient(db, 'a');
  const b = await seedOrgWithClient(db, 'b');
  const alertId = await insertAlert(db, { orgId: b.orgId, clientId: b.clientId });
  const { call, close } = await startApi(db); t.after(() => close());

  const r = await call('POST', `/${alertId}/action`, { token: makeToken(a.trainerId, 'TRAINER', a.orgId), body: { action: 'dismiss' } });
  assert.equal(r.status, 403);
  const row = await db.q1('SELECT status FROM alerts WHERE id = ?', [alertId]);
  assert.equal(row.status, 'open', 'a rejected cross-org action must never mutate the row');
});

test('POST /api/alerts/:id/action lets any same-org trainer act, even on a client assigned to someone else', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrgWithClient(db, 'a');
  // A second trainer in the SAME org, not assigned to this client.
  const otherTrainerId = idp('usr');
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'TRAINER', 'Other Trainer', 1, ?)`, [otherTrainerId, a.orgId, `other-${a.orgId}@test.com`, 'x', '2026-01-01T00:00:00Z']);
  const alertId = await insertAlert(db, { orgId: a.orgId, clientId: a.clientId });
  const { call, close } = await startApi(db); t.after(() => close());

  const r = await call('POST', `/${alertId}/action`, { token: makeToken(otherTrainerId, 'TRAINER', a.orgId), body: { action: 'follow_up' } });
  assert.equal(r.status, 200, 'alerts are staff-wide within an org by design, unlike per-client-assignment resources');
  const row = await db.q1('SELECT status FROM alerts WHERE id = ?', [alertId]);
  assert.equal(row.status, 'followed_up');
});

test('POST /api/alerts/:id/action lets SUPER_ADMIN act across orgs', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrgWithClient(db, 'a');
  const alertId = await insertAlert(db, { orgId: a.orgId, clientId: a.clientId });
  const { call, close } = await startApi(db); t.after(() => close());
  const r = await call('POST', `/${alertId}/action`, { token: makeToken('platform_admin', 'SUPER_ADMIN', 'unrelated_org'), body: { action: 'dismiss' } });
  assert.equal(r.status, 200);
});

test('POST /api/alerts/:id/action 404s for a nonexistent alert', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrgWithClient(db, 'a');
  const { call, close } = await startApi(db); t.after(() => close());
  const r = await call('POST', '/does_not_exist/action', { token: makeToken(a.trainerId, 'TRAINER', a.orgId), body: { action: 'dismiss' } });
  assert.equal(r.status, 404);
});

test('POST /api/alerts/:id/action rejects an invalid action value (schema-validated)', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrgWithClient(db, 'a');
  const alertId = await insertAlert(db, { orgId: a.orgId, clientId: a.clientId });
  const { call, close } = await startApi(db); t.after(() => close());
  const r = await call('POST', `/${alertId}/action`, { token: makeToken(a.trainerId, 'TRAINER', a.orgId), body: { action: 'delete_everything' } });
  assert.equal(r.status, 422);
  const row = await db.q1('SELECT status FROM alerts WHERE id = ?', [alertId]);
  assert.equal(row.status, 'open');
});
