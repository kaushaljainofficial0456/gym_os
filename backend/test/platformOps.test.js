// ============================================================
// Phase 3c: feature flags, platform announcements, error center /
// system health, and CSV data export -- all confirmed a complete
// blank slate before this pass (see each service file's own header).
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { resetRateLimits } from '../src/rateLimit.js';
import { hashPassword } from '../src/auth.js';
import { id, now } from '../src/ids.js';
import { track } from '../src/services/events.js';
import {
  listFeatureFlags, getFeatureFlag, createFeatureFlag, updateFeatureFlag, deleteFeatureFlag, isFeatureEnabled,
} from '../src/services/platform/featureFlags.js';
import {
  listAnnouncements, listActiveAnnouncements, createAnnouncement, updateAnnouncement, deleteAnnouncement,
} from '../src/services/platform/announcements.js';
import { listPlatformErrors, getSystemHealth } from '../src/services/platform/systemHealth.js';
import { toCsv } from '../src/services/platform/csv.js';

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
    async tx(fn) {
      db.exec('BEGIN');
      try { const out = await fn(mk()); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
    raw: db,
  });
  return mk();
}

async function seedOrg(db, orgId = 'o1') {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [orgId, 'Gym', 'gym-' + orgId, now()]);
}

test.beforeEach(() => { resetRateLimits(); });

// ---------------------------------------------------------------
// FEATURE FLAGS -- unit level
// ---------------------------------------------------------------

test('createFeatureFlag: defaults to disabled, 100% rollout, empty allow-list', async () => {
  const db = await memDb();
  const result = await createFeatureFlag(db, { key: 'new_dashboard', name: 'New Dashboard' });
  assert.equal(result.ok, true);
  const flag = await getFeatureFlag(db, { key: 'new_dashboard' });
  assert.equal(flag.enabled, 0);
  assert.equal(flag.rollout_percentage, 100);
  assert.deepEqual(flag.enabled_org_ids, []);
});

test('createFeatureFlag: a duplicate key is rejected, not silently overwritten', async () => {
  const db = await memDb();
  await createFeatureFlag(db, { key: 'dup', name: 'First' });
  const second = await createFeatureFlag(db, { key: 'dup', name: 'Second' });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'key_already_exists');
  const rows = await listFeatureFlags(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'First');
});

test('isFeatureEnabled: a flag disabled globally is always false regardless of rollout/org', async () => {
  const db = await memDb();
  const { id: flagId } = await createFeatureFlag(db, { key: 'off_flag', name: 'Off' });
  await updateFeatureFlag(db, { id: flagId, rolloutPercentage: 100, enabledOrgIds: ['o1'] });
  assert.equal(await isFeatureEnabled(db, 'off_flag', { orgId: 'o1' }), false);
});

test('isFeatureEnabled: an org on the explicit allow-list is always true, even at 0% rollout', async () => {
  const db = await memDb();
  const { id: flagId } = await createFeatureFlag(db, { key: 'allow_list_flag', name: 'Allow list' });
  await updateFeatureFlag(db, { id: flagId, enabled: true, rolloutPercentage: 0, enabledOrgIds: ['o1'] });
  assert.equal(await isFeatureEnabled(db, 'allow_list_flag', { orgId: 'o1' }), true, 'allow-listed org must win over a 0% rollout');
  assert.equal(await isFeatureEnabled(db, 'allow_list_flag', { orgId: 'o2' }), false, 'a non-allow-listed org still gets 0%');
});

test('isFeatureEnabled: 100% rollout is true for any org, 0% is false for any org', async () => {
  const db = await memDb();
  const { id: flagId } = await createFeatureFlag(db, { key: 'rollout_flag', name: 'Rollout' });
  await updateFeatureFlag(db, { id: flagId, enabled: true, rolloutPercentage: 100 });
  assert.equal(await isFeatureEnabled(db, 'rollout_flag', { orgId: 'anything' }), true);
  await updateFeatureFlag(db, { id: flagId, rolloutPercentage: 0 });
  assert.equal(await isFeatureEnabled(db, 'rollout_flag', { orgId: 'anything' }), false);
});

test('isFeatureEnabled: a partial rollout is deterministic -- same org+key always gets the same answer', async () => {
  const db = await memDb();
  const { id: flagId } = await createFeatureFlag(db, { key: 'partial_flag', name: 'Partial' });
  await updateFeatureFlag(db, { id: flagId, enabled: true, rolloutPercentage: 50 });
  const first = await isFeatureEnabled(db, 'partial_flag', { orgId: 'stable-org' });
  for (let i = 0; i < 5; i++) {
    assert.equal(await isFeatureEnabled(db, 'partial_flag', { orgId: 'stable-org' }), first, 'repeated evaluation must not flip-flop');
  }
});

test('isFeatureEnabled: enabled but no orgId context and rollout < 100 is false (only an allow-list or 100% applies)', async () => {
  const db = await memDb();
  const { id: flagId } = await createFeatureFlag(db, { key: 'no_context_flag', name: 'No context' });
  await updateFeatureFlag(db, { id: flagId, enabled: true, rolloutPercentage: 50 });
  assert.equal(await isFeatureEnabled(db, 'no_context_flag', {}), false);
});

test('isFeatureEnabled: an unknown key is false, never throws', async () => {
  const db = await memDb();
  assert.equal(await isFeatureEnabled(db, 'never_created', { orgId: 'o1' }), false);
});

test('deleteFeatureFlag: removes it; a second delete returns false', async () => {
  const db = await memDb();
  const { id: flagId } = await createFeatureFlag(db, { key: 'gone', name: 'Gone' });
  assert.equal(await deleteFeatureFlag(db, { id: flagId }), true);
  assert.equal(await deleteFeatureFlag(db, { id: flagId }), false);
  assert.equal(await getFeatureFlag(db, { key: 'gone' }), null);
});

// ---------------------------------------------------------------
// ANNOUNCEMENTS -- unit level
// ---------------------------------------------------------------

test('listActiveAnnouncements: open-ended (no start/end) is always active', async () => {
  const db = await memDb();
  await createAnnouncement(db, { title: 'Welcome', message: 'Hello platform' });
  const active = await listActiveAnnouncements(db, {});
  assert.equal(active.length, 1);
  assert.equal(active[0].title, 'Welcome');
});

test('listActiveAnnouncements: a future starts_at excludes it; a past ends_at excludes it', async () => {
  const db = await memDb();
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();
  await createAnnouncement(db, { title: 'Future', message: 'Not yet', startsAt: future });
  await createAnnouncement(db, { title: 'Expired', message: 'Already over', endsAt: past });
  const active = await listActiveAnnouncements(db, {});
  assert.equal(active.length, 0);
});

test('listActiveAnnouncements: a window currently open (starts_at in past, ends_at in future) is active', async () => {
  const db = await memDb();
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const future = new Date(Date.now() + 86_400_000).toISOString();
  await createAnnouncement(db, { title: 'Live now', message: 'Currently running', startsAt: past, endsAt: future });
  const active = await listActiveAnnouncements(db, {});
  assert.equal(active.length, 1);
});

test('listActiveAnnouncements: audience matching -- ALL always matches, a specific audience only matches itself or ALL', async () => {
  const db = await memDb();
  await createAnnouncement(db, { title: 'Everyone', message: 'x', audience: 'ALL' });
  await createAnnouncement(db, { title: 'Owners only', message: 'x', audience: 'OWNERS' });
  await createAnnouncement(db, { title: 'Trainers only', message: 'x', audience: 'TRAINERS' });

  const forOwners = await listActiveAnnouncements(db, { audience: 'OWNERS' });
  assert.deepEqual(forOwners.map((a) => a.title).sort(), ['Everyone', 'Owners only']);

  const forClients = await listActiveAnnouncements(db, { audience: 'CLIENTS' });
  assert.deepEqual(forClients.map((a) => a.title), ['Everyone']);
});

test('listActiveAnnouncements: ordered URGENT > HIGH > NORMAL > LOW', async () => {
  const db = await memDb();
  await createAnnouncement(db, { title: 'Low', message: 'x', priority: 'LOW' });
  await createAnnouncement(db, { title: 'Urgent', message: 'x', priority: 'URGENT' });
  await createAnnouncement(db, { title: 'Normal', message: 'x', priority: 'NORMAL' });
  await createAnnouncement(db, { title: 'High', message: 'x', priority: 'HIGH' });
  const active = await listActiveAnnouncements(db, {});
  assert.deepEqual(active.map((a) => a.title), ['Urgent', 'High', 'Normal', 'Low']);
});

test('updateAnnouncement: partial update leaves unspecified fields intact; unknown id returns null', async () => {
  const db = await memDb();
  const annId = await createAnnouncement(db, { title: 'Original', message: 'Body', priority: 'LOW' });
  const updated = await updateAnnouncement(db, { id: annId, priority: 'URGENT' });
  assert.equal(updated.title, 'Original');
  assert.equal(updated.priority, 'URGENT');
  assert.equal(await updateAnnouncement(db, { id: 'nope' }), null);
});

test('deleteAnnouncement: removes it from listAnnouncements', async () => {
  const db = await memDb();
  const annId = await createAnnouncement(db, { title: 'Temp', message: 'x' });
  assert.equal((await listAnnouncements(db)).length, 1);
  assert.equal(await deleteAnnouncement(db, { id: annId }), true);
  assert.equal((await listAnnouncements(db)).length, 0);
});

// ---------------------------------------------------------------
// SYSTEM HEALTH / ERROR CENTER -- unit level
// ---------------------------------------------------------------

test('getSystemHealth: a healthy in-memory DB reports database.healthy true with a real latency number', async () => {
  const db = await memDb();
  const health = await getSystemHealth(db);
  assert.equal(health.database.healthy, true);
  assert.equal(typeof health.database.latencyMs, 'number');
  assert.ok('provider' in health.payments);
  assert.ok('chain' in health.ai);
  assert.equal(health.email.provider, 'mock');
});

test('listPlatformErrors: only returns client_error/server_error events, newest first, filterable by type', async () => {
  const db = await memDb();
  await seedOrg(db);
  await track(db, { type: 'server_error', orgId: 'o1', data: { message: 'boom' } });
  await new Promise((r) => setTimeout(r, 2));
  await track(db, { type: 'client_error', orgId: 'o1', data: { message: 'oops' } });
  await track(db, { type: 'food_ai_cache_hit', orgId: 'o1', data: {} }); // must never show up here

  const all = await listPlatformErrors(db, {});
  assert.equal(all.length, 2);
  assert.equal(all[0].type, 'client_error', 'newest first');

  const onlyServer = await listPlatformErrors(db, { type: 'server_error' });
  assert.equal(onlyServer.length, 1);
  assert.equal(onlyServer[0].message, 'boom');
});

// ---------------------------------------------------------------
// CSV -- unit level
// ---------------------------------------------------------------

test('toCsv: escapes commas, quotes, and newlines; supports computed column values', async () => {
  const rows = [{ name: 'Simple', note: 'a, b' }, { name: 'Quote "test"', note: 'line1\nline2' }];
  const csv = toCsv(rows, [
    { header: 'name', value: 'name' },
    { header: 'note', value: 'note' },
    { header: 'upper', value: (r) => r.name.toUpperCase() },
  ]);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'name,note,upper');
  assert.ok(csv.includes('"a, b"'));
  assert.ok(csv.includes('"Quote ""test"""'));
  assert.ok(csv.includes('SIMPLE'));
});

test('toCsv: a null/undefined value renders as an empty field, never the literal "null"', async () => {
  const csv = toCsv([{ x: null }, { x: undefined }], [{ header: 'x', value: 'x' }]);
  assert.equal(csv, 'x\n\n\n');
});

// ---------------------------------------------------------------
// ROUTE-LEVEL
// ---------------------------------------------------------------

async function startApp(db) {
  const authRoutes = (await import('../src/routes/auth.js')).default;
  const consoleRoutes = (await import('../src/routes/console.js')).default;
  const meRoutes = (await import('../src/routes/me.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes(db));
  app.use('/api/console', consoleRoutes(db));
  app.use('/api/me', meRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, body, token) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/csv')) {
      return { status: res.status, contentType, text: await res.text() };
    }
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close };
}

async function createSuperAdmin(db, api, email = 'admin@sk-os.test') {
  const userId = id('usr');
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, NULL, ?, ?, 'SUPER_ADMIN', ?, 1, ?)`,
    [userId, email, await hashPassword('adminpass1'), 'Platform Admin', now()]);
  const login = await api.call('POST', '/api/auth/login', { email, password: 'adminpass1' });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return { token: login.json.token, userId };
}

async function createOrgUser(db, api, { orgId, role, email, password = 'userpass1' }) {
  const userId = id('usr');
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    [userId, orgId, email, await hashPassword(password), role, `${role} user`, now()]);
  const login = await api.call('POST', '/api/auth/login', { email, password });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return { token: login.json.token, userId };
}

test('feature flags: full CRUD via HTTP, audited, duplicate key rejected', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const admin = await createSuperAdmin(db, api);

  const create = await api.call('POST', '/api/console/features', { key: 'beta_ui', name: 'Beta UI' }, admin.token);
  assert.equal(create.status, 201);
  const flagId = create.json.id;

  const dupe = await api.call('POST', '/api/console/features', { key: 'beta_ui', name: 'Again' }, admin.token);
  assert.equal(dupe.status, 409);

  const update = await api.call('POST', `/api/console/features/${flagId}`, { enabled: true, rolloutPercentage: 25 }, admin.token);
  assert.equal(update.status, 200);
  assert.equal(update.json.flag.enabled, 1);
  assert.equal(update.json.flag.rollout_percentage, 25);

  const missingUpdate = await api.call('POST', '/api/console/features/does-not-exist', { enabled: true }, admin.token);
  assert.equal(missingUpdate.status, 404);

  const list = await api.call('GET', '/api/console/features', undefined, admin.token);
  assert.equal(list.json.flags.length, 1);

  const del = await api.call('DELETE', `/api/console/features/${flagId}`, undefined, admin.token);
  assert.equal(del.status, 200);
  const listAfter = await api.call('GET', '/api/console/features', undefined, admin.token);
  assert.equal(listAfter.json.flags.length, 0);

  const audit = await api.call('GET', '/api/console/audit', undefined, admin.token);
  assert.ok(audit.json.logs.some((l) => l.action === 'feature_flag_created'));
  assert.ok(audit.json.logs.some((l) => l.action === 'feature_flag_updated'));
  assert.ok(audit.json.logs.some((l) => l.action === 'feature_flag_deleted'));
});

test('feature flag key format is validated -- rejects uppercase/spaces', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const admin = await createSuperAdmin(db, api);
  const bad = await api.call('POST', '/api/console/features', { key: 'Bad Key!', name: 'Bad' }, admin.token);
  assert.equal(bad.status, 422);
});

test('announcements: full CRUD via HTTP including the active-preview endpoint', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const admin = await createSuperAdmin(db, api);

  const create = await api.call('POST', '/api/console/announcements', { title: 'Maintenance', message: 'Downtime at midnight', audience: 'OWNERS', priority: 'HIGH' }, admin.token);
  assert.equal(create.status, 201);
  const annId = create.json.id;

  const active = await api.call('GET', '/api/console/announcements/active?audience=OWNERS', undefined, admin.token);
  assert.equal(active.json.announcements.length, 1);

  const activeForClients = await api.call('GET', '/api/console/announcements/active?audience=CLIENTS', undefined, admin.token);
  assert.equal(activeForClients.json.announcements.length, 0);

  const update = await api.call('POST', `/api/console/announcements/${annId}`, { priority: 'URGENT' }, admin.token);
  assert.equal(update.status, 200);
  assert.equal(update.json.announcement.priority, 'URGENT');

  const del = await api.call('DELETE', `/api/console/announcements/${annId}`, undefined, admin.token);
  assert.equal(del.status, 200);
  const listAfter = await api.call('GET', '/api/console/announcements', undefined, admin.token);
  assert.equal(listAfter.json.announcements.length, 0);

  const audit = await api.call('GET', '/api/console/audit', undefined, admin.token);
  assert.ok(audit.json.logs.some((l) => l.action === 'announcement_created'));
  assert.ok(audit.json.logs.some((l) => l.action === 'announcement_updated'));
  assert.ok(audit.json.logs.some((l) => l.action === 'announcement_deleted'));
});

test('GET /api/me/announcements: the only announcement path a non-SUPER_ADMIN role can reach, audience derived from the caller\'s own role', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const admin = await createSuperAdmin(db, api);
  await seedOrg(db, 'org1');
  const owner = await createOrgUser(db, api, { orgId: 'org1', role: 'GYM_OWNER', email: 'owner@sk-os.test' });
  const trainer = await createOrgUser(db, api, { orgId: 'org1', role: 'TRAINER', email: 'trainer@sk-os.test' });
  const client = await createOrgUser(db, api, { orgId: 'org1', role: 'CLIENT', email: 'client@sk-os.test' });

  await api.call('POST', '/api/console/announcements', { title: 'For owners', message: 'Owner-only notice', audience: 'OWNERS' }, admin.token);
  await api.call('POST', '/api/console/announcements', { title: 'For everyone', message: 'Platform-wide notice', audience: 'ALL' }, admin.token);

  const ownerView = await api.call('GET', '/api/me/announcements', undefined, owner.token);
  assert.equal(ownerView.status, 200);
  assert.equal(ownerView.json.announcements.length, 2, 'owner sees the OWNERS-only notice plus the ALL notice');

  const trainerView = await api.call('GET', '/api/me/announcements', undefined, trainer.token);
  assert.equal(trainerView.json.announcements.length, 1, 'trainer does not see the OWNERS-only notice');
  assert.equal(trainerView.json.announcements[0].title, 'For everyone');

  const clientView = await api.call('GET', '/api/me/announcements', undefined, client.token);
  assert.equal(clientView.json.announcements.length, 1, 'client does not see the OWNERS-only notice');

  const noAuth = await api.call('GET', '/api/me/announcements', undefined, undefined);
  assert.equal(noAuth.status, 401, 'still requires authentication -- not a fully public route');
});

test('GET /api/console/system/health + /system/errors via HTTP', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  await seedOrg(db);
  await track(db, { type: 'server_error', orgId: 'o1', data: { message: 'kaboom' } });
  const admin = await createSuperAdmin(db, api);

  const health = await api.call('GET', '/api/console/system/health', undefined, admin.token);
  assert.equal(health.status, 200);
  assert.equal(health.json.database.healthy, true);

  const errors = await api.call('GET', '/api/console/system/errors?type=server_error', undefined, admin.token);
  assert.equal(errors.status, 200);
  assert.equal(errors.json.errors.length, 1);
  assert.equal(errors.json.errors[0].orgName, 'Gym');
});

test('GET /api/console/export/gyms returns a CSV attachment and writes an audit entry', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  await seedOrg(db);
  const admin = await createSuperAdmin(db, api);

  const csv = await api.call('GET', '/api/console/export/gyms', undefined, admin.token);
  assert.equal(csv.status, 200);
  assert.ok(csv.contentType.includes('text/csv'));
  assert.ok(csv.text.startsWith('id,name,slug,billing_status,client_count,trainer_count,created_at'));
  assert.ok(csv.text.includes('Gym'));

  const audit = await api.call('GET', '/api/console/audit', undefined, admin.token);
  assert.ok(audit.json.logs.some((l) => l.action === 'data_export'));
});

test('every new console route rejects a non-SUPER_ADMIN caller', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  await seedOrg(db);
  const ownerId = id('usr');
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, 'o1', ?, ?, 'GYM_OWNER', 'Owner', 1, ?)`,
    [ownerId, 'owner@test.com', await hashPassword('ownerpass1'), now()]);
  const login = await api.call('POST', '/api/auth/login', { email: 'owner@test.com', password: 'ownerpass1' });
  const ownerToken = login.json.token;

  for (const p of ['/api/console/features', '/api/console/announcements', '/api/console/system/health', '/api/console/export/gyms']) {
    const res = await api.call('GET', p, undefined, ownerToken);
    assert.equal(res.status, 403, `${p} must reject a GYM_OWNER`);
  }
});
