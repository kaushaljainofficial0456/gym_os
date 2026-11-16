// ============================================================
// White-label branding: a gym's own two colours and logo.
//
// What must hold: only an owner sets them, only real hex colours are
// stored, the brand reaches everyone in that gym (and the join and
// sign-up screens) and nobody else -- an independent client never wears
// a gym's colours -- and the logo is served as an image, never as a page.
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
import { normalizeHex, gymDisplayName, parseLogo, brandingForOrg } from '../src/services/branding.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const T0 = '2026-01-01T00:00:00Z';

// A 1x1 PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG = `data:image/png;base64,${PNG_B64}`;

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  // gym_settings columns that exist only as init-db.js migrations (the
  // gym profile fields PUT /admin/settings writes).
  const initDb = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'init-db.js'), 'utf8');
  for (const m of initDb.matchAll(/\['gym_settings',\s*'([a-z_]+)',\s*`([^`]+)`\]/g)) {
    try { db.exec(`ALTER TABLE gym_settings ADD COLUMN ${m[2]}`); } catch { /* already in schema.sql */ }
  }
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await mk().q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
    exec(sql) { db.exec(sql); },
    async tx(fn) {
      db.exec('BEGIN');
      try { const out = await fn(mk()); db.exec('COMMIT'); return out; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
  });
  return mk();
}

// o1: Iron Forge (a gym) with owner, trainer, client.  ind: the
// independent pseudo-org with one solo client.
async function fixture() {
  const db = await memDb();
  await db.run(`INSERT INTO organizations (id, name, slug, type, created_at) VALUES ('o1', 'Iron Forge', 'ironforge', 'gym', ?)`, [T0]);
  await db.run(`INSERT INTO organizations (id, name, slug, type, created_at) VALUES ('ind', 'Independent Clients', 'independent', 'independent', ?)`, [T0]);
  for (const [uid, org, role] of [['u_own', 'o1', 'GYM_OWNER'], ['u_tr', 'o1', 'TRAINER'], ['u_cl', 'o1', 'CLIENT'], ['u_solo', 'ind', 'CLIENT']]) {
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, 'x', ?, ?, 1, ?)`, [uid, org, `${uid}@x.in`, role, uid, T0]);
  }
  return db;
}

const ROLE = { u_own: ['GYM_OWNER', 'o1'], u_tr: ['TRAINER', 'o1'], u_cl: ['CLIENT', 'o1'], u_solo: ['CLIENT', 'ind'] };
const tokenFor = (uid) => jwt.sign({ sub: uid, role: ROLE[uid][0], org: ROLE[uid][1], name: uid }, config.jwtSecret, { expiresIn: '1h' });

async function startApi(db) {
  resetRateLimits();
  const brandingRoutes = (await import('../src/routes/branding.js')).default;
  const adminRoutes = (await import('../src/routes/admin.js')).default;
  const app = express();
  app.set('db', db);
  app.use(express.json({ limit: '1mb' }));
  app.use('/branding', brandingRoutes(db));
  app.use('/admin', adminRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const { port } = server.address();
  const call = async (uid, method, url, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (uid) headers.Authorization = `Bearer ${tokenFor(uid)}`;
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const type = res.headers.get('content-type') || '';
    const out = { status: res.status, headers: res.headers };
    if (type.includes('json')) out.json = await res.json();
    else out.bytes = Buffer.from(await res.arrayBuffer());
    return out;
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close };
}

test('normalizeHex accepts #RRGGBB in any case, refuses everything else', () => {
  assert.equal(normalizeHex('#f5c518'), '#F5C518');
  assert.equal(normalizeHex('F5C518'), '#F5C518');
  assert.equal(normalizeHex(' #0b0b0c '), '#0B0B0C');
  for (const bad of ['#FFF', 'red', '#GGGGGG', '#F5C51', 'rgb(1,2,3)', '', null, 7, '#F5C518; background:url(x)']) {
    assert.equal(normalizeHex(bad), null, String(bad));
  }
});

test('the gym is called by its own name, never by the brand_name placeholder', () => {
  assert.equal(gymDisplayName('Iron Forge', 'SK OS'), 'Iron Forge');
  assert.equal(gymDisplayName('Iron Forge', 'Barbell'), 'Iron Forge');
  assert.equal(gymDisplayName('Iron Forge', null), 'Iron Forge');
  assert.equal(gymDisplayName('Iron Forge', 'Iron Forge Andheri'), 'Iron Forge Andheri');
});

test('parseLogo: PNG/JPEG/WebP only, no SVG, size-capped', () => {
  assert.equal(parseLogo(PNG).mime, 'image/png');
  assert.ok(parseLogo('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=').error);
  assert.ok(parseLogo('https://example.com/logo.png').error);
  const big = `data:image/png;base64,${Buffer.alloc(301 * 1024).toString('base64')}`;
  assert.match(parseLogo(big).error, /too large/);
});

test('only the owner sets the brand; trainers and members are refused', async (t) => {
  const db = await fixture();
  const api = await startApi(db);
  t.after(() => api.close());
  for (const uid of ['u_tr', 'u_cl']) {
    const r = await api.call(uid, 'PUT', '/branding', { primary: '#F5C518', secondary: '#0B0B0C' });
    assert.equal(r.status, 403, uid);
  }
  assert.equal((await api.call(null, 'PUT', '/branding', { primary: '#F5C518', secondary: '#0B0B0C' })).status, 401);
  const ok = await api.call('u_own', 'PUT', '/branding', { primary: '#f5c518', secondary: '#0b0b0c' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.branding.primary, '#F5C518');
  assert.equal(ok.json.branding.secondary, '#0B0B0C');
  assert.equal(ok.json.branding.gymName, 'Iron Forge');
  // The first gym_settings row is named after the gym, not 'SK OS'.
  const row = await db.q1('SELECT brand_name FROM gym_settings WHERE org_id = ?', ['o1']);
  assert.equal(row.brand_name, 'Iron Forge');
});

test('bad colours are refused, and it is two colours or none', async (t) => {
  const db = await fixture();
  const api = await startApi(db);
  t.after(() => api.close());
  const bad = await api.call('u_own', 'PUT', '/branding', { primary: 'yellow', secondary: '#000000' });
  assert.equal(bad.status, 422);
  const half = await api.call('u_own', 'PUT', '/branding', { primary: '#F5C518', secondary: null });
  assert.equal(half.status, 422);
  const extra = await api.call('u_own', 'PUT', '/branding', { primary: '#F5C518', secondary: '#000000', css: 'x' });
  assert.equal(extra.status, 422, 'unknown fields are refused');
  await api.call('u_own', 'PUT', '/branding', { primary: '#F5C518', secondary: '#000000' });
  const reset = await api.call('u_own', 'PUT', '/branding', { primary: null, secondary: null });
  assert.equal(reset.status, 200);
  assert.equal(reset.json.branding.primary, null, 'reset to the Barbell look');
  assert.equal(reset.json.branding.gymName, 'Iron Forge', 'still the gym, just not coloured');
});

test('everyone in the gym gets the brand; an independent client never does', async (t) => {
  const db = await fixture();
  const api = await startApi(db);
  t.after(() => api.close());
  await api.call('u_own', 'PUT', '/branding', { primary: '#F5C518', secondary: '#0B0B0C' });
  for (const uid of ['u_own', 'u_tr', 'u_cl']) {
    const r = await api.call(uid, 'GET', '/branding');
    assert.equal(r.json.branding.primary, '#F5C518', uid);
  }
  const solo = await api.call('u_solo', 'GET', '/branding');
  assert.equal(solo.json.branding, null);
  assert.equal(await brandingForOrg(db, 'ind'), null);
  assert.equal(await brandingForOrg(db, null), null);
});

test('a sign-up screen can read the brand by gym code; unknown and independent codes are not found', async (t) => {
  const db = await fixture();
  const api = await startApi(db);
  t.after(() => api.close());
  await api.call('u_own', 'PUT', '/branding', { primary: '#E11D48', secondary: '#FFFFFF' });
  const r = await api.call(null, 'GET', '/branding/gym/IronForge');
  assert.equal(r.status, 200);
  assert.deepEqual(
    { gymName: r.json.branding.gymName, primary: r.json.branding.primary, secondary: r.json.branding.secondary, code: r.json.branding.code },
    { gymName: 'Iron Forge', primary: '#E11D48', secondary: '#FFFFFF', code: 'ironforge' });
  assert.equal((await api.call(null, 'GET', '/branding/gym/nope')).status, 404);
  assert.equal((await api.call(null, 'GET', '/branding/gym/independent')).status, 404);
});

test('the logo: uploaded by the owner, served as an image with a versioned URL, and removable', async (t) => {
  const db = await fixture();
  const api = await startApi(db);
  t.after(() => api.close());
  const svg = await api.call('u_own', 'PUT', '/branding', { logo: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' });
  assert.equal(svg.status, 422, 'SVG is refused');

  const up = await api.call('u_own', 'PUT', '/branding', { primary: '#F5C518', secondary: '#0B0B0C', logo: PNG });
  assert.equal(up.status, 200);
  const url = up.json.branding.logoUrl;
  assert.match(url, /^\/api\/branding\/logo\/ironforge\?v=/);

  const img = await api.call(null, 'GET', url.replace('/api', ''));
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.match(img.headers.get('cache-control'), /immutable/);
  assert.deepEqual(img.bytes, Buffer.from(PNG_B64, 'base64'));

  // Changing only the colours keeps the logo.
  const recolour = await api.call('u_own', 'PUT', '/branding', { primary: '#22C55E', secondary: '#0B0B0C' });
  assert.ok(recolour.json.branding.logoUrl);

  const gone = await api.call('u_own', 'PUT', '/branding', { logo: null });
  assert.equal(gone.json.branding.logoUrl, null);
  assert.equal((await api.call(null, 'GET', '/branding/logo/ironforge')).status, 404);
});

test('saving gym settings leaves the brand alone, and the logo never travels through that screen', async (t) => {
  const db = await fixture();
  const api = await startApi(db);
  t.after(() => api.close());
  await api.call('u_own', 'PUT', '/branding', { primary: '#F5C518', secondary: '#0B0B0C', logo: PNG });
  const got = await api.call('u_own', 'GET', '/admin/settings');
  assert.equal(got.status, 200);
  assert.equal('brand_logo' in got.json.settings, false, 'the image is not a setting');
  assert.equal(got.json.settings.brand_primary, '#F5C518');
  // The settings screen sends back the whole object it was given.
  const put = await api.call('u_own', 'PUT', '/admin/settings', { ...got.json.settings, tagline: 'Lift heavy' });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  const after = await api.call('u_cl', 'GET', '/branding');
  assert.equal(after.json.branding.primary, '#F5C518');
  assert.ok(after.json.branding.logoUrl, 'logo kept');
  // ...and a client cannot recolour the gym through it either.
  await api.call('u_own', 'PUT', '/admin/settings', { brand_primary: '#000000' });
  assert.equal((await api.call('u_cl', 'GET', '/branding')).json.branding.primary, '#F5C518');
});
