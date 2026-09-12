// ============================================================
// F-05 REGRESSION (backend half): the httpOnly cookie is now the sole
// browser authentication mechanism -- these tests cover the two backend
// pieces this required:
//   1. POST /auth/logout actually clears the cookie server-side (it
//      never existed before this fix -- clearAuthCookie() was defined
//      but never called anywhere).
//   2. GET /auth/me (and any cookie-only request generally) authenticates
//      via the cookie alone, no Authorization header needed.
//   3. clientError.js's tryDecodeUser() falls back to the cookie too, so
//      ErrorBoundary.jsx's credentials-only fetch keeps enriching crash
//      reports with org/user context.
//
// The frontend half (api.js no longer reading/writing a token,
// AskSK.jsx/ErrorBoundary.jsx no longer reading localStorage directly)
// has no automated test suite of its own -- verified by build + live
// browser walkthrough instead (login, authenticated navigation, logout,
// session-expired handling), see the security verification report for
// that evidence.
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
  };
}

// Minimal cookie-jar fetch helper: captures Set-Cookie from a response and
// replays it on the next request, mirroring what a real browser does --
// none of this suite's other harnesses need this (they auth via a Bearer
// header built straight from a signed JWT), but a cookie-auth test
// genuinely needs to role-play the browser's own cookie storage.
function makeCookieJar() {
  let cookies = {};
  // The raw Set-Cookie line each cookie name was last seen on. The stored
  // name=value above is all the auth tests need, but whether a browser
  // actually DROPS a cookie is decided by the clearing line's attributes,
  // not its value -- so that line has to be kept to be asserted on.
  const rawLines = {};
  // Every Set-Cookie line from the MOST RECENT response. logout now sends
  // two for sk_token (the current '/' clear and the legacy '/api' one), so
  // "the raw line for this cookie" is no longer singular -- a test that
  // wants one has to say which path it means.
  let lastLines = [];
  return {
    capture(res) {
      const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : (res.headers.raw?.()['set-cookie'] || []);
      if (setCookie.length) lastLines = setCookie;
      for (const line of setCookie) {
        const [pair] = line.split(';');
        const eq = pair.indexOf('=');
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        rawLines[name] = line;
        // An expired/cleared cookie (Expires in the past, empty value) --
        // model it as removed rather than stored, matching real browsers.
        if (/expires=thu, 01 jan 1970/i.test(line) || value === '') delete cookies[name];
        else cookies[name] = value;
      }
    },
    header() {
      const pairs = Object.entries(cookies).map(([k, v]) => `${k}=${v}`);
      return pairs.length ? pairs.join('; ') : undefined;
    },
    has(name) { return name in cookies; },
    rawFor(name) { return rawLines[name] || null; },
    // The Set-Cookie line for `name` scoped to `path`, from the last response.
    rawForPath(name, path) {
      return lastLines.find((line) => {
        if (!line.startsWith(name + '=')) return false;
        const attr = line.split(';').map((a) => a.trim()).find((a) => /^path=/i.test(a));
        return (attr ? attr.slice(5) : '/') === path;
      }) || null;
    },
  };
}

async function startAuthApi(db) {
  const authRoutes = (await import('../src/routes/auth.js')).default;
  const app = express();
  app.use((req, _res, next) => {
    req.cookies = {};
    const raw = req.headers.cookie || '';
    for (const part of raw.split(';')) {
      const [k, ...rest] = part.split('=');
      if (k?.trim()) req.cookies[k.trim()] = decodeURIComponent(rest.join('='));
    }
    next();
  });
  app.use(express.json());
  app.use('/api/auth', authRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const jar = makeCookieJar();
  // `cookieOverride` lets a test supply the exact Cookie header itself. The
  // shared jar above is deliberately path-unaware (it stores by name only),
  // which is fine for every other test here but cannot represent two
  // same-named cookies under different paths -- precisely the situation the
  // legacy-path regression below exists to cover.
  const call = async (method, p, body, cookieOverride) => {
    const cookie = cookieOverride !== undefined ? cookieOverride : jar.header();
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    jar.capture(res);
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close, jar, port };
}

async function seedOrgAndOwner(db) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym', 'gym-o1', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('u1', 'o1', 'owner@x.in', ?, 'GYM_OWNER', 'Owner', 1, '2026-01-01T00:00:00Z')`,
    [await (await import('bcryptjs')).default.hash('password123', 10)]);
}

test('login sets the httpOnly cookie, and a cookie-only request (no Authorization header) authenticates via it', async (t) => {
  const db = await memDb();
  await seedOrgAndOwner(db);
  const api = await startAuthApi(db);
  t.after(() => api.close());

  const login = await api.call('POST', '/api/auth/login', { email: 'owner@x.in', password: 'password123' });
  assert.equal(login.status, 200);
  assert.ok(api.jar.has('sk_token'), 'login response set the sk_token cookie');

  const me = await api.call('GET', '/api/auth/me');
  assert.equal(me.status, 200, 'cookie alone (no Authorization header sent) authenticates the request');
  assert.equal(me.json.user.email, 'owner@x.in');
});

test('POST /auth/logout clears the cookie -- a subsequent request is unauthenticated', async (t) => {
  const db = await memDb();
  await seedOrgAndOwner(db);
  const api = await startAuthApi(db);
  t.after(() => api.close());

  await api.call('POST', '/api/auth/login', { email: 'owner@x.in', password: 'password123' });
  assert.ok(api.jar.has('sk_token'), 'sanity: logged in, cookie present');

  const logout = await api.call('POST', '/api/auth/logout');
  assert.equal(logout.status, 200);
  assert.equal(logout.json.ok, true);
  assert.equal(api.jar.has('sk_token'), false, 'the cookie jar no longer holds sk_token after the Set-Cookie clear response');

  const meAfter = await api.call('GET', '/api/auth/me');
  assert.equal(meAfter.status, 401, 'a request after logout is genuinely unauthenticated, not just locally forgotten');
});

// The two tests above prove the SERVER sends a clearing Set-Cookie. They
// cannot prove a real browser honours it: fetch (and this file's jar) drop
// a cookie on the expiry alone, while browsers additionally require the
// clearing line's attributes to match the ones the cookie was stored with,
// and will otherwise keep it. clearAuthCookie() used to pass `path` only --
// no httpOnly/secure/sameSite -- which is exactly that mismatch, and one of
// two reasons "Sign out" left users still signed in (the other being the
// frontend cancelling the logout request by navigating on the same tick;
// see api.js's clearSession).
test("the logout Set-Cookie repeats every attribute sk_token was set with -- a browser only removes a cookie on an attribute match", async (t) => {
  const db = await memDb();
  await seedOrgAndOwner(db);
  const api = await startAuthApi(db);
  t.after(() => api.close());

  await api.call('POST', '/api/auth/login', { email: 'owner@x.in', password: 'password123' });
  const setLine = api.jar.rawForPath('sk_token', '/');
  assert.ok(setLine, 'sanity: login sent a Set-Cookie for sk_token at path=/');

  await api.call('POST', '/api/auth/logout');
  // Compare like with like: logout deliberately sends TWO sk_token clears
  // (the current '/' one and the legacy '/api' one -- see clearAuthCookie).
  // The attribute-match rule is per cookie, and the cookie login created is
  // the '/'-scoped one, so that is the clear this has to be measured against.
  const clearLine = api.jar.rawForPath('sk_token', '/');
  assert.ok(clearLine && clearLine !== setLine, 'sanity: logout sent its own path=/ Set-Cookie for sk_token');

  const legacyClear = api.jar.rawForPath('sk_token', '/api');
  assert.ok(legacyClear, 'logout also sends a clear for the legacy path=/api cookie');

  // Everything but the value and the lifetime -- expires/max-age are the
  // attributes that DO differ by design (that difference is the deletion)
  // and the ones a client is specified to exclude when matching.
  const attrs = (line) => line.split(';').slice(1)
    .map((a) => a.trim().toLowerCase())
    .filter((a) => !a.startsWith('expires=') && !a.startsWith('max-age='))
    .sort();

  assert.deepEqual(attrs(clearLine), attrs(setLine),
    `logout's cookie attributes must match login's exactly.
  set:   ${setLine}
  clear: ${clearLine}`);
});

test('POST /auth/logout succeeds even with no session at all (idempotent, never requires auth)', async (t) => {
  const db = await memDb();
  const api = await startAuthApi(db);
  t.after(() => api.close());
  const logout = await api.call('POST', '/api/auth/logout');
  assert.equal(logout.status, 200, 'logging out with nothing to log out of still succeeds cleanly');
  assert.equal(logout.json.ok, true);
});

test('clientError.js: tryDecodeUser falls back to the sk_token cookie when no Authorization header is sent', async (t) => {
  const db = await memDb();
  await seedOrgAndOwner(db);
  const authApi = await startAuthApi(db);
  const login = await authApi.call('POST', '/api/auth/login', { email: 'owner@x.in', password: 'password123' });
  assert.equal(login.status, 200);
  await authApi.close();

  const clientErrorRoutes = (await import('../src/routes/clientError.js')).default;
  const app = express();
  app.use((req, _res, next) => {
    req.cookies = {};
    const raw = req.headers.cookie || '';
    for (const part of raw.split(';')) {
      const [k, ...rest] = part.split('=');
      if (k?.trim()) req.cookies[k.trim()] = decodeURIComponent(rest.join('='));
    }
    next();
  });
  app.use(express.json());
  app.use('/api/client-error', clientErrorRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));

  const res = await fetch(`http://127.0.0.1:${port}/api/client-error`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authApi.jar.header() },
    body: JSON.stringify({ message: 'test crash' }),
  });
  assert.equal(res.status, 204);

  const event = await db.q1(`SELECT * FROM events WHERE type = 'client_error' ORDER BY created_at DESC LIMIT 1`);
  assert.ok(event, 'the crash report was recorded');
  assert.equal(event.user_id, 'u1', 'org/user context was resolved from the COOKIE, not an Authorization header (none was sent)');
  assert.equal(event.org_id, 'o1');
});

// ---- LEGACY COOKIE PATH REGRESSION ----
// A minimal path-AWARE cookie jar, modelling what a browser actually does:
// a cookie's identity is (name, domain, path), and a Set-Cookie can only
// delete an entry whose path matches exactly. The shared jar in this file
// stores by name alone and therefore cannot represent this situation at
// all -- which is exactly why the original logout fix looked fully verified
// while production stayed broken.
function pathAwareJar() {
  const store = new Map(); // `${name} ${path}` -> value
  const key = (name, path) => `${name} ${path}`;
  return {
    set(name, value, path) { store.set(key(name, path), value); },
    // Apply a response's Set-Cookie lines the way a browser would.
    applySetCookie(res) {
      const lines = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const line of lines) {
        const [pair, ...attrs] = line.split(';');
        const eq = pair.indexOf('=');
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        const pathAttr = attrs.map((a) => a.trim()).find((a) => /^path=/i.test(a));
        const path = pathAttr ? pathAttr.slice(5) : '/';
        const expired = /expires=thu, 01 jan 1970/i.test(line) || value === '';
        if (expired) store.delete(key(name, path));
        else store.set(key(name, path), value);
      }
    },
    // RFC 6265 5.4: only cookies whose path matches the request path are
    // sent, longest path first.
    headerFor(requestPath) {
      const matches = [];
      for (const [k, v] of store) {
        const [name, path] = k.split(' ');
        if (requestPath === path || requestPath.startsWith(path.endsWith('/') ? path : path + '/')) {
          matches.push({ name, path, v });
        }
      }
      matches.sort((a, b) => b.path.length - a.path.length);
      return matches.map((m) => `${m.name}=${m.v}`).join('; ');
    },
    paths(name) {
      return [...store.keys()].filter((k) => k.split(' ')[0] === name)
        .map((k) => k.split(' ')[1]).sort();
    },
  };
}

test('logout clears the LEGACY path=/api sk_token too, not just path=/ -- the real production failure', async (t) => {
  const db = await memDb();
  await seedOrgAndOwner(db);
  const api = await startAuthApi(db);
  t.after(() => api.close());

  const login = await api.call('POST', '/api/auth/login', { email: 'owner@x.in', password: 'password123' });
  assert.equal(login.status, 200);
  const token = login.json.token;
  assert.ok(token, 'sanity: login returned a token');

  // The browser of a user who last signed in BEFORE c257290 (2026-09-11):
  // the current '/'-scoped cookie, plus the legacy '/api'-scoped one that
  // release left behind, both carrying a still-valid JWT.
  const jar = pathAwareJar();
  jar.set('sk_token', token, '/');
  jar.set('sk_token', token, '/api');
  assert.deepEqual(jar.paths('sk_token'), ['/', '/api'], 'sanity: both cookies present before logout');

  // Click Sign out. Both cookies match /api/auth/logout, so both are sent.
  const logoutRes = await fetch(`http://127.0.0.1:${api.port}/api/auth/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: jar.headerFor('/api/auth/logout') },
  });
  assert.equal(logoutRes.status, 200);
  jar.applySetCookie(logoutRes);

  assert.deepEqual(jar.paths('sk_token'), [],
    `logout must clear sk_token under BOTH paths; still present at: ${JSON.stringify(jar.paths('sk_token'))}`);

  // The end the user actually cares about: the session is really over.
  const after = await api.call('GET', '/api/auth/me', undefined, jar.headerFor('/api/auth/me'));
  assert.equal(after.status, 401,
    'after logout no sk_token survives under any path, so /auth/me is genuinely unauthenticated');
});

test('a surviving legacy path=/api cookie WOULD keep the session alive -- proves the test above is not vacuous', async (t) => {
  const db = await memDb();
  await seedOrgAndOwner(db);
  const api = await startAuthApi(db);
  t.after(() => api.close());

  const login = await api.call('POST', '/api/auth/login', { email: 'owner@x.in', password: 'password123' });
  const token = login.json.token;

  // Send ONLY the legacy cookie, i.e. exactly what the browser was left
  // holding when logout cleared '/' alone. requireAuth cannot tell which
  // path a cookie arrived under -- the Cookie header does not carry paths --
  // so it authenticates it happily. This is the mechanism of the bug, and it
  // is why clearing the legacy path server-side is the only available fix.
  const me = await api.call('GET', '/api/auth/me', undefined, `sk_token=${token}`);
  assert.equal(me.status, 200, 'a legacy-path cookie is indistinguishable to the server -- it authenticates');
  assert.equal(me.json.user.email, 'owner@x.in');
});
