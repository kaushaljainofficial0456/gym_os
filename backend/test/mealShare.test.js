// ============================================================
// F-12a: shared-MEAL link creation, expiry, and revocation.
// (Public-preview security for GET /api/share/:id itself is already
// covered by share.test.js -- this file covers the authenticated
// POST /me/share creation + DELETE /me/share/:id revoke pair, and the
// expiry interaction between them, mirroring workoutShare.test.js's
// equivalent coverage for shared_workouts.)
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import jwt from 'jsonwebtoken';
import { resetRateLimits } from '../src/rateLimit.js';
import { id, now } from '../src/ids.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const JWT_SECRET = 'test-secret-meal-share';

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
    async tx(fn) {
      db.exec('BEGIN');
      const tx = {
        async q(sql, p = []) { return db.prepare(sql).all(...p); },
        async q1(sql, p = []) { const r = db.prepare(sql).all(...p); return r[0] || null; },
        async run(sql, p = []) { const r = db.prepare(sql).run(...p); return { changes: Number(r.changes) }; },
      };
      try { const result = await fn(tx); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    raw: db,
  };
}

function signToken(user) { return jwt.sign(user, JWT_SECRET, { expiresIn: '1h' }); }

async function seedOrgClient(db, suffix = '1') {
  const orgId = `org_${suffix}`;
  const clientId = `cl_${suffix}`;
  const userId = `usr_${suffix}`;
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [orgId, `Org ${suffix}`, `org-${suffix}`, now()]);
  await db.run('INSERT INTO users (id, org_id, email, password_hash, role, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [userId, orgId, `user${suffix}@test.com`, 'hash', 'CLIENT', `User ${suffix}`, now()]);
  await db.run('INSERT INTO clients (id, user_id, org_id, created_at) VALUES (?, ?, ?, ?)', [clientId, userId, orgId, now()]);
  return { orgId, clientId, userId };
}

async function seedSavedFood(db, clientId, orgId, name = 'Paneer Tikka') {
  const foodId = id('food');
  await db.run(
    `INSERT INTO foods (id, org_id, client_id, name, serving, calories, protein, carbs, fat, source, is_global)
     VALUES (?,?,?,?,?,?,?,?,?,'USER_ENTERED',0)`,
    [foodId, orgId, clientId, name, '150 g', 300, 22, 8, 20]);
  return foodId;
}

async function startApi(db) {
  const meRoutes = (await import('../src/routes/me.js')).default;
  const shareRoutes = (await import('../src/routes/share.js')).default;
  const configMod = await import('../src/config.js');
  configMod.config.jwtSecret = JWT_SECRET;

  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use((_req, _res, next) => {
    if (!_req.cookies) {
      _req.cookies = {};
      const raw = _req.headers.cookie || '';
      for (const part of raw.split(';')) {
        const [k, ...rest] = part.split('=');
        if (k) _req.cookies[k.trim()] = decodeURIComponent(rest.join('='));
      }
    }
    next();
  });
  app.use('/api/me', meRoutes(db));
  app.use('/api/share', shareRoutes(db));
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;

  const authedCall = async (userId, p, opts = {}) => {
    const token = signToken({ sub: userId, role: 'CLIENT', org: opts.org || 'org_1' });
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
    });
    let json = null; try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };
  const publicCall = async (p, opts = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, opts);
    let json = null; try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { authedCall, publicCall, close };
}

test('POST /me/share creates a link with a ~30-day expiry, viewable via the public route', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId, clientId, userId } = await seedOrgClient(db, 'm1');
  const foodId = await seedSavedFood(db, clientId, orgId);
  const { authedCall, publicCall, close } = await startApi(db); t.after(() => close());

  const share = await authedCall(userId, '/api/me/share', { method: 'POST', body: JSON.stringify({ food_ids: [foodId] }) });
  assert.equal(share.status, 201);
  assert.ok(share.json.expires_at);
  const daysAhead = (Date.parse(share.json.expires_at) - Date.now()) / (24 * 60 * 60_000);
  assert.ok(daysAhead > 29 && daysAhead < 31, `expected ~30-day TTL, got ${daysAhead.toFixed(1)}`);

  const preview = await publicCall(`/api/share/${share.json.id}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.json.items.length, 1);
});

test('an expired meal share link 404s on both the public preview and POST /me/share/:id/save', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId, clientId, userId } = await seedOrgClient(db, 'm2');
  const foodId = await seedSavedFood(db, clientId, orgId);
  const { authedCall, publicCall, close } = await startApi(db); t.after(() => close());

  const share = await authedCall(userId, '/api/me/share', { method: 'POST', body: JSON.stringify({ food_ids: [foodId] }) });
  await db.run('UPDATE shared_meals SET expires_at = ? WHERE id = ?', ['2020-01-01T00:00:00.000Z', share.json.id]);

  const preview = await publicCall(`/api/share/${share.json.id}`);
  assert.equal(preview.status, 404);
  assert.equal(preview.json.error, 'This shared link is invalid or has expired');

  const { userId: saverId } = await seedOrgClient(db, 'm2saver');
  const save = await authedCall(saverId, `/api/me/share/${share.json.id}/save`, { method: 'POST', body: JSON.stringify({ item_index: 0 }) });
  assert.equal(save.status, 404);
  assert.equal(save.json.error, 'This shared link is invalid or has expired');
});

test('a legacy shared_meals row with expires_at = NULL still works (never expires, not already expired)', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId, clientId } = await seedOrgClient(db, 'm3');
  const shareId = id('shr');
  await db.run(
    `INSERT INTO shared_meals (id, org_id, client_id, shared_by_name, items_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    [shareId, orgId, clientId, 'Legacy Sender', JSON.stringify([{ type: 'food', name: 'Old Item', quantity: 1, unit: '1', calories: 100, protein: 1, carbs: 1, fat: 1, components: null }]), now()]);
  const { publicCall, close } = await startApi(db); t.after(() => close());

  const preview = await publicCall(`/api/share/${shareId}`);
  assert.equal(preview.status, 200);
});

test('the sender can revoke their own meal share link, making it immediately unreachable', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId, clientId, userId } = await seedOrgClient(db, 'm4');
  const foodId = await seedSavedFood(db, clientId, orgId);
  const { authedCall, publicCall, close } = await startApi(db); t.after(() => close());

  const share = await authedCall(userId, '/api/me/share', { method: 'POST', body: JSON.stringify({ food_ids: [foodId] }) });
  const revoke = await authedCall(userId, `/api/me/share/${share.json.id}`, { method: 'DELETE' });
  assert.equal(revoke.status, 200);
  assert.deepEqual(revoke.json, { ok: true });

  const preview = await publicCall(`/api/share/${share.json.id}`);
  assert.equal(preview.status, 404);
});

test('revoking a meal share link is scoped to the sender -- another client cannot revoke it', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { orgId, clientId, userId } = await seedOrgClient(db, 'm5owner');
  const { userId: attackerId } = await seedOrgClient(db, 'm5attacker');
  const foodId = await seedSavedFood(db, clientId, orgId);
  const { authedCall, publicCall, close } = await startApi(db); t.after(() => close());

  const share = await authedCall(userId, '/api/me/share', { method: 'POST', body: JSON.stringify({ food_ids: [foodId] }) });
  const attackerRevoke = await authedCall(attackerId, `/api/me/share/${share.json.id}`, { method: 'DELETE' });
  assert.equal(attackerRevoke.status, 404);

  const stillWorks = await publicCall(`/api/share/${share.json.id}`);
  assert.equal(stillWorks.status, 200, 'the real owner\'s link must survive an unauthorized revoke attempt');
});

test('DELETE on a nonexistent meal share id returns a clean 404', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const { userId } = await seedOrgClient(db, 'm6');
  const { authedCall, close } = await startApi(db); t.after(() => close());

  const r = await authedCall(userId, '/api/me/share/shr_doesnotexist', { method: 'DELETE' });
  assert.equal(r.status, 404);
});
