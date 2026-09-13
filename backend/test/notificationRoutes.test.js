import { test } from 'node:test';
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
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await mk().q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
    exec(sql) { db.exec(sql); },
    async tx(fn) {
      db.exec('BEGIN');
      try { const out = await fn(mk()); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
    raw: db
  });
  return mk();
}

function tokenFor(user) {
  return jwt.sign({ sub: user.id, role: user.role, org: user.org_id, name: user.name }, config.jwtSecret, { expiresIn: '1h' });
}

const idp = (p) => 'id_' + Math.random().toString(36).slice(2, 10);

let db, server, port, auth, client;

test.before(async () => {
  db = await memDb();

  const orgId = idp('org');
  const trainerId = idp('usr');
  const clientId = idp('usr');
  const cId = idp('cli');

  await db.run(`INSERT INTO organizations (id, name, slug, type, timezone, created_at) VALUES (?, ?, ?, 'gym', 'Asia/Kolkata', datetime('now'))`,
    [orgId, 'Test Gym', 'test-gym']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, created_at) VALUES (?, ?, ?, ?, 'TRAINER', 'Trainer', datetime('now'))`,
    [trainerId, orgId, 'trainer@test.com', 'hash']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, created_at) VALUES (?, ?, ?, ?, 'CLIENT', 'Client', datetime('now'))`,
    [clientId, orgId, 'client@test.com', 'hash']);
  await db.run(`INSERT INTO clients (id, user_id, org_id, trainer_id, created_at) VALUES (?, ?, ?, ?, datetime('now'))`,
    [cId, clientId, orgId, trainerId]);

  const user = { id: clientId, role: 'CLIENT', org_id: orgId, name: 'Client' };
  auth = tokenFor(user);
  client = { id: cId, user_id: clientId };

  const notifRoutes = (await import('../src/routes/notifications.js')).default;
  const app = express();
  app.use(express.json());
  // Mock auth
  app.use((req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try { req.user = jwt.verify(token, config.jwtSecret); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  });
  app.use('/api/notifications', notifRoutes(db));

  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  port = server.address().port;
});

test.after(async () => {
  if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
  if (db?.close) await db.close();
});

async function req(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

test('GET /api/notifications returns empty list', async () => {
  const { status, json } = await req('GET', '/api/notifications');
  assert.equal(status, 200);
  assert.ok(Array.isArray(json.notifications));
  assert.equal(typeof json.unreadCount, 'number');
});

test('GET /api/notifications/unread-count returns 0', async () => {
  const { status, json } = await req('GET', '/api/notifications/unread-count');
  assert.equal(status, 200);
  assert.equal(json.unreadCount, 0);
});

test('GET /api/notifications/preferences returns defaults', async () => {
  const { status, json } = await req('GET', '/api/notifications/preferences');
  assert.equal(status, 200);
  assert.ok(json.preferences);
  assert.equal(json.preferences.enabled, 1);
  assert.equal(json.preferences.water_reminders, 1);
  assert.equal(json.preferences.water_interval_h, 2);
});

test('PATCH /api/notifications/preferences updates a field', async () => {
  const { status, json } = await req('PATCH', '/api/notifications/preferences', { water_reminders: 0 });
  assert.equal(status, 200);
  assert.equal(json.preferences.water_reminders, 0);
  assert.equal(json.preferences.workout_reminders, 1);
});

test('POST /api/notifications/read-all works', async () => {
  const { status, json } = await req('POST', '/api/notifications/read-all');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
});

test('POST /api/notifications/generate runs without error', async () => {
  await req('PATCH', '/api/notifications/preferences', { water_reminders: 1 });
  const { status, json } = await req('POST', '/api/notifications/generate');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.ok(Array.isArray(json.notifications));
});

test('PATCH /api/notifications/:id/read on non-existent id is a no-op', async () => {
  const { status, json } = await req('PATCH', '/api/notifications/fake_id/read');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
});
