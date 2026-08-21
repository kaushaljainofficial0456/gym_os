// ============================================================
// Transaction-safety regression tests.
//
// Both POST /auth/setup-org and POST /clients used to do their related
// INSERTs as separate, un-transacted db.run() calls. A failure partway
// through (e.g. a duplicate email tripping the second/third insert) left
// a committed row with no matching counterpart:
//   - setup-org: an `organizations` row with no owner `users` row —
//     orphaned, unrecoverable except by hand, its slug permanently
//     unavailable to a retry.
//   - POST /clients: a `users` row (role=CLIENT) with no matching
//     `clients` row — an account that authenticates but 404s on every
//     client-portal endpoint, since those all resolve through `clients`.
// Both routes now wrap their related inserts in db.tx(), matching the
// pattern already used for workout completion (see workoutCalorie.test.js).
// These tests assert the rollback actually leaves no orphan behind, not
// just that the second request returns 409.
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

// Same shape as the harness in workoutCalorie.test.js — a real db.tx()
// (BEGIN/COMMIT/ROLLBACK), not a stub, so a rollback bug would actually
// surface here.
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
      try {
        const out = await fn(mk());
        db.exec('COMMIT');
        return out;
      } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
    raw: db
  });
  return mk();
}

const idp = (p) => p + '_' + Math.random().toString(36).slice(2, 10);

function tokenFor(user) {
  return jwt.sign({ sub: user.id, role: user.role, org: user.org_id, name: user.name }, config.jwtSecret, { expiresIn: '1h' });
}

async function startApi(db, routesPath, mountPath) {
  const routes = (await import(routesPath)).default;
  const app = express();
  app.use(express.json());
  app.use(mountPath, routes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, body, token) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`http://127.0.0.1:${port}${mountPath}${p}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close };
}

test('POST /auth/setup-org: duplicate-email failure leaves no orphaned organization row', async () => {
  const db = await memDb();
  const { call, close } = await startApi(db, '../src/routes/auth.js', '/auth');
  try {
    const first = await call('POST', '/setup-org', {
      orgName: 'Orphan Test Gym One', ownerName: 'Owner One',
      email: 'orphan-test@example.com', password: 'testpass123', type: 'gym'
    });
    assert.equal(first.status, 201, 'first org creation succeeds');

    const second = await call('POST', '/setup-org', {
      orgName: 'Orphan Test Gym Two', ownerName: 'Owner Two',
      email: 'orphan-test@example.com', password: 'testpass123', type: 'gym'
    });
    assert.equal(second.status, 409, 'duplicate email is rejected');

    const orgs = await db.q("SELECT name FROM organizations WHERE name LIKE 'Orphan Test Gym%'");
    assert.equal(orgs.length, 1, 'only the successful org exists — the rolled-back one left no row');
    assert.equal(orgs[0].name, 'Orphan Test Gym One');

    const owners = await db.q("SELECT id FROM users WHERE email = 'orphan-test@example.com'");
    assert.equal(owners.length, 1, 'exactly one owner user exists, matching the surviving org');
  } finally {
    await close();
  }
});

test('POST /clients: duplicate-email failure leaves no orphaned user row', async () => {
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)',
    ['o1', 'Gym A', 'gym-a', '2026-01-01T00:00:00Z']);
  const trainer = { id: idp('usr'), role: 'TRAINER', org_id: 'o1', name: 'Trainer A' };
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'TRAINER', ?, 1, ?)`,
    [trainer.id, 'o1', 't@a.in', 'x', trainer.name, '2026-01-01T00:00:00Z']);

  const { call, close } = await startApi(db, '../src/routes/clients.js', '/clients');
  try {
    const body = { name: 'Test Client', email: 'orphan-client@example.com', password: 'testpass123', goal: 'FAT_LOSS' };
    const first = await call('POST', '/', body, tokenFor(trainer));
    assert.equal(first.status, 201, 'first client creation succeeds');

    const second = await call('POST', '/', { ...body, name: 'Test Client Dupe' }, tokenFor(trainer));
    assert.equal(second.status, 409, 'duplicate email is rejected');

    const users = await db.q("SELECT id FROM users WHERE email = 'orphan-client@example.com'");
    assert.equal(users.length, 1, 'exactly one user exists for this email');

    const clients = await db.q('SELECT id FROM clients WHERE user_id = ?', [users[0].id]);
    assert.equal(clients.length, 1, 'the surviving user has a matching clients row — no orphaned account');
  } finally {
    await close();
  }
});
