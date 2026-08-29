// ============================================================
// /api/reports -- weekly progress reports, gated the same way as
// insights.js (resolveClient: per-assigned-client, not just per-org).
// Zero prior test coverage existed for this live, frontend-wired route.
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

async function startApi(db) {
  const reportRoutes = (await import('../src/routes/reports.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/reports', reportRoutes(db));
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, { token } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/reports${p}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    let json = null; try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close };
}

test('GET /api/reports/clients/:id/weekly-report rejects an unauthenticated request', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const { call, close } = await startApi(db); t.after(() => close());
  const r = await call('GET', `/clients/${a.clientId}/weekly-report`);
  assert.equal(r.status, 401);
});

test('GET /api/reports/clients/:id/weekly-report rejects a CLIENT role entirely', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const { call, close } = await startApi(db); t.after(() => close());
  const r = await call('GET', `/clients/${a.clientId}/weekly-report`, { token: makeToken(a.clientUserId, 'CLIENT', a.orgId) });
  assert.equal(r.status, 403);
});

test('GET /api/reports/clients/:id/weekly-report rejects a trainer from a different org', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const b = await seedOrg(db, 'b');
  const { call, close } = await startApi(db); t.after(() => close());
  const r = await call('GET', `/clients/${a.clientId}/weekly-report`, { token: makeToken(b.trainerId, 'TRAINER', b.orgId) });
  assert.equal(r.status, 403);
});

test('GET /api/reports/clients/:id/weekly-report rejects a same-org trainer who does not own this client', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const otherTrainerId = idp('usr');
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'TRAINER', 'Other', 1, ?)`, [otherTrainerId, a.orgId, `other-${a.orgId}@test.com`, 'x', '2026-01-01T00:00:00Z']);
  const { call, close } = await startApi(db); t.after(() => close());
  const r = await call('GET', `/clients/${a.clientId}/weekly-report`, { token: makeToken(otherTrainerId, 'TRAINER', a.orgId) });
  assert.equal(r.status, 403);
});

test('GET /api/reports/clients/:id/weekly-report returns a real report for the assigned trainer and the owner', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const { call, close } = await startApi(db); t.after(() => close());

  const asTrainer = await call('GET', `/clients/${a.clientId}/weekly-report`, { token: makeToken(a.trainerId, 'TRAINER', a.orgId) });
  assert.equal(asTrainer.status, 200);
  assert.equal(asTrainer.json.report.clientId, a.clientId);
  assert.equal(asTrainer.json.report.period.days, 7);

  const asOwner = await call('GET', `/clients/${a.clientId}/weekly-report`, { token: makeToken(a.ownerId, 'GYM_OWNER', a.orgId) });
  assert.equal(asOwner.status, 200);
});

test('GET /api/reports/clients/:id/weekly-report 404s for a nonexistent client', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const { call, close } = await startApi(db); t.after(() => close());
  const r = await call('GET', '/clients/does_not_exist/weekly-report', { token: makeToken(a.trainerId, 'TRAINER', a.orgId) });
  assert.equal(r.status, 404);
});

test('POST /api/reports/clients/:id/weekly-report/send rejects a trainer who does not own this client, and persists nothing', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const otherTrainerId = idp('usr');
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'TRAINER', 'Other', 1, ?)`, [otherTrainerId, a.orgId, `other-${a.orgId}@test.com`, 'x', '2026-01-01T00:00:00Z']);
  const { call, close } = await startApi(db); t.after(() => close());

  const r = await call('POST', `/clients/${a.clientId}/weekly-report/send`, { token: makeToken(otherTrainerId, 'TRAINER', a.orgId) });
  assert.equal(r.status, 403);
  const notifs = await db.q(`SELECT * FROM notifications WHERE client_id = ?`, [a.clientId]);
  const msgs = await db.q(`SELECT * FROM messages WHERE client_id = ?`, [a.clientId]);
  assert.equal(notifs.length, 0, 'a rejected send must never persist a notification');
  assert.equal(msgs.length, 0, 'a rejected send must never persist a message');
});

test('POST /api/reports/clients/:id/weekly-report/send persists a notification and a message for the assigned trainer', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const { call, close } = await startApi(db); t.after(() => close());

  const r = await call('POST', `/clients/${a.clientId}/weekly-report/send`, { token: makeToken(a.trainerId, 'TRAINER', a.orgId) });
  assert.equal(r.status, 201);
  assert.equal(r.json.ok, true);

  const notif = await db.q1(`SELECT * FROM notifications WHERE client_id = ? AND type = 'weekly_report'`, [a.clientId]);
  assert.ok(notif);
  assert.equal(notif.org_id, a.orgId);
  assert.equal(notif.user_id, a.clientUserId);

  const msg = await db.q1(`SELECT * FROM messages WHERE client_id = ?`, [a.clientId]);
  assert.ok(msg);
  assert.equal(msg.from_user, a.trainerId);
  assert.equal(msg.to_user, a.clientUserId);
});
