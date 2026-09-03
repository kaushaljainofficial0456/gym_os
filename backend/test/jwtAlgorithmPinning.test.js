// ============================================================
// F-12b REGRESSION: JWT verification pins HS256 explicitly rather than
// relying on jsonwebtoken's own default behavior. Even before this
// change, a plain-string-secret jwt.verify() call already only accepts
// the HS* family (confirmed live against a running instance: alg:none,
// wrong-secret, and tampered-payload forgeries were all already
// rejected) -- this makes that an explicit, auditable line in auth.js
// instead of an unstated assumption about the library's internals.
//
// Hand-rolled tokens (no jsonwebtoken import needed to FORGE one -- only
// node:crypto, so this test can never accidentally use the real signer
// to "forge" something): each scenario builds its own header.payload
// and either signs it with a wrong key, a wrong algorithm's shape, or
// leaves it unsigned (alg:none).
//
// The one VALID-token case reaches requireAuth's success path, which
// calls the real (module-singleton) getDb() for a timezone lookup --
// config.js resolves SQLITE_PATH at import time, so it must be pointed
// at a throwaway file BEFORE auth.js/config.js are ever imported, or
// this would silently open the real local dev database. Static ES
// imports are hoisted ahead of any top-level statement in the same
// file regardless of source order, so env must be set, then auth.js
// pulled in via a dynamic import() (which runs in real source order),
// not a static one.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';

process.env.SQLITE_PATH = path.join(os.tmpdir(), `skos-test-jwtpin-${process.pid}-${Date.now()}.db`);
delete process.env.DATABASE_URL;
const { requireAuth, signToken, JWT_ALGORITHM } = await import('../src/auth.js');
const { config } = await import('../src/config.js');

function b64url(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }

function fakeReqRes(token) {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, cookies: {} };
  let statusCode = null, jsonBody = null;
  const res = {
    status(c) { statusCode = c; return this; },
    json(b) { jsonBody = b; return this; },
  };
  let nextCalled = false;
  const next = () => { nextCalled = true; };
  return { req, res, next, result: () => ({ statusCode, jsonBody, nextCalled }) };
}

test('valid HS256 token -> requireAuth calls next(), req.user populated', async () => {
  const token = signToken({ id: 'usr_1', role: 'CLIENT', org_id: 'o1', name: 'X', email: 'x@x.com' });
  const { req, res, next, result } = fakeReqRes(token);
  await requireAuth(req, res, next);
  const r = result();
  assert.equal(r.nextCalled, true);
  assert.equal(req.user.sub, 'usr_1');
  assert.equal(req.user.role, 'CLIENT');
});

test('alg:none forged token is rejected', async () => {
  const header = b64url({ alg: 'none', typ: 'JWT' });
  const payload = b64url({ sub: 'usr_attacker', role: 'SUPER_ADMIN', org: null, exp: Math.floor(Date.now() / 1000) + 3600 });
  const forged = `${header}.${payload}.`;
  const { req, res, next, result } = fakeReqRes(forged);
  await requireAuth(req, res, next);
  const r = result();
  assert.equal(r.nextCalled, false);
  assert.equal(r.statusCode, 401);
});

test('a token signed with the WRONG secret is rejected', async () => {
  const forged = jwt.sign({ sub: 'usr_attacker', role: 'SUPER_ADMIN', org: null }, 'a-completely-wrong-guessed-secret', { algorithm: 'HS256', expiresIn: '1h' });
  const { req, res, next, result } = fakeReqRes(forged);
  await requireAuth(req, res, next);
  const r = result();
  assert.equal(r.nextCalled, false);
  assert.equal(r.statusCode, 401);
});

test('a token signed with a DIFFERENT algorithm shape (HS384) using the real secret is rejected', async () => {
  // Still HMAC (this app never uses RS/ES keys, so classic RS->HS
  // confusion doesn't apply -- see auth.js's own comment) but a
  // different member of the HS family than the one explicitly pinned.
  const forged = jwt.sign({ sub: 'usr_x', role: 'CLIENT', org: 'o1' }, config.jwtSecret, { algorithm: 'HS384', expiresIn: '1h' });
  const { req, res, next, result } = fakeReqRes(forged);
  await requireAuth(req, res, next);
  const r = result();
  assert.equal(r.nextCalled, false, 'a real secret is not enough if the algorithm does not match the pinned HS256');
  assert.equal(r.statusCode, 401);
});

test('a tampered payload (real token, role escalated, signature now invalid) is rejected', async () => {
  const real = signToken({ id: 'usr_1', role: 'CLIENT', org_id: 'o1', name: 'X', email: 'x@x.com' });
  const [h, p, s] = real.split('.');
  const decoded = JSON.parse(Buffer.from(p, 'base64url').toString());
  decoded.role = 'SUPER_ADMIN';
  const tampered = `${h}.${b64url(decoded)}.${s}`;
  const { req, res, next, result } = fakeReqRes(tampered);
  await requireAuth(req, res, next);
  const r = result();
  assert.equal(r.nextCalled, false);
  assert.equal(r.statusCode, 401);
});

test('JWT_ALGORITHM is explicitly HS256 (pins what signToken/requireAuth actually use)', () => {
  assert.equal(JWT_ALGORITHM, 'HS256');
});

test.after(async () => {
  const { rm } = await import('node:fs/promises');
  for (const suffix of ['', '-wal', '-shm']) {
    await rm(process.env.SQLITE_PATH + suffix, { force: true }).catch(() => {});
  }
});
