// ============================================================
// REMEDIATION: session revocation via a per-user token epoch.
//
// Closes the residual risk routes/auth.js's /reset-password used to
// document explicitly: a stateless JWT issued before a password
// reset/change kept working on every OTHER device until its natural 7-day
// expiry, because there was no server-side concept of "this token is no
// longer current" -- only the resetting browser's own cookie was cleared.
//
// Three layers are tested here, cheapest/most isolated first:
//   1. getUserEpochCached/invalidateUserEpochCache against a plain db
//      object -- no Express, no singleton, no subprocess needed (these
//      two functions take `db` as an explicit parameter).
//   2. signToken's `epoch` claim -- pure sign/verify round trip.
//   3. The REAL requireAuth() middleware, calling the REAL getDb()
//      singleton -- which reads config.sqlitePath (SQLITE_PATH env var)
//      at module-load time, exactly like paymentProductionGate.test.js's
//      own subprocess convention. A subprocess is required here (not just
//      for isolation hygiene): the whole point of this layer is proving
//      the ACTUAL production code path (the same getDb() every real
//      request goes through) rejects a stale-epoch token, which an
//      injected/mocked db would not prove.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import jwt from 'jsonwebtoken';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..').replace(/\\/g, '/');
const authPath = path.resolve(__dirname, '..', 'src', 'auth.js').replace(/\\/g, '/');
const schemaPath = path.resolve(__dirname, '..', '..', 'database', 'schema.sql').replace(/\\/g, '/');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const { readFileSync } = await import('node:fs');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8'));
  return {
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const stmt = db.prepare(sql); const rows = params.length ? stmt.all(...params) : stmt.all(); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
  };
}

async function insertUser(db, { id, tokenEpoch = 0 }) {
  await db.run(
    `INSERT INTO organizations (id, name, slug, created_at) VALUES ('org_1','Gym','gym-1','2026-01-01T00:00:00Z')
     ON CONFLICT(id) DO NOTHING`, []);
  await db.run(
    `INSERT INTO users (id, org_id, email, password_hash, role, name, active, token_epoch, created_at)
     VALUES (?, 'org_1', ?, 'x', 'TRAINER', 'Test User', 1, ?, '2026-01-01T00:00:00Z')`,
    [id, id + '@example.com', tokenEpoch]);
}

// ---------------------------------------------------------------
// Layer 1: the cache itself, against a plain db object directly.
// ---------------------------------------------------------------
test('getUserEpochCached: caches within the TTL, invalidateUserEpochCache forces a fresh read', async () => {
  const { getUserEpochCached, invalidateUserEpochCache } = await import(`file://${authPath}`);
  const db = await memDb();
  await insertUser(db, { id: 'usr_cache1', tokenEpoch: 0 });

  const first = await getUserEpochCached(db, 'usr_cache1');
  assert.equal(first, 0);

  // Change the DB row directly (bypassing the app's own invalidation call)
  // to prove the cache -- not a fresh read -- is what's answering next.
  await db.run('UPDATE users SET token_epoch = 5 WHERE id = ?', ['usr_cache1']);
  const stillCached = await getUserEpochCached(db, 'usr_cache1');
  assert.equal(stillCached, 0, 'a cache hit within the TTL must not re-read the DB');

  invalidateUserEpochCache('usr_cache1');
  const fresh = await getUserEpochCached(db, 'usr_cache1');
  assert.equal(fresh, 5, 'after invalidation, the next read must reflect the real current value');
});

test('getUserEpochCached: an unknown user id resolves to epoch 0, never throws', async () => {
  const { getUserEpochCached } = await import(`file://${authPath}`);
  const db = await memDb();
  const epoch = await getUserEpochCached(db, 'usr_does_not_exist');
  assert.equal(epoch, 0);
});

// ---------------------------------------------------------------
// Layer 2: signToken's epoch claim -- pure sign/verify.
// ---------------------------------------------------------------
test('signToken: carries the user\'s token_epoch as the `epoch` claim; defaults to 0 when absent', async () => {
  const { signToken } = await import(`file://${authPath}`);
  const { config } = await import(`file://${path.resolve(__dirname, '..', 'src', 'config.js').replace(/\\/g, '/')}`);

  const t1 = signToken({ id: 'u1', role: 'CLIENT', org_id: 'o1', name: 'A', email: 'a@x.com', token_epoch: 3 });
  const d1 = jwt.verify(t1, config.jwtSecret, { algorithms: ['HS256'] });
  assert.equal(d1.epoch, 3);

  const t2 = signToken({ id: 'u2', role: 'CLIENT', org_id: 'o1', name: 'B', email: 'b@x.com' }); // no token_epoch field
  const d2 = jwt.verify(t2, config.jwtSecret, { algorithms: ['HS256'] });
  assert.equal(d2.epoch, 0);
});

// ---------------------------------------------------------------
// Layer 3: the real requireAuth() + the real getDb() singleton, in a
// fresh subprocess pointed at a throwaway SQLite file via SQLITE_PATH.
// ---------------------------------------------------------------
const SCRATCH_SQLITE = path.join(os.tmpdir(), `skos-test-sessionepoch-${process.pid}-${Date.now()}.db`).replace(/\\/g, '/');

function runProbe(code) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { PATH: process.env.PATH, SQLITE_PATH: SCRATCH_SQLITE },
    encoding: 'utf8', timeout: 15000,
  });
  return { status: child.status, stdout: child.stdout || '', stderr: child.stderr || '' };
}

test('requireAuth: a token signed at the user\'s current epoch is accepted; after the epoch is bumped, the SAME token is rejected (401) -- proves cross-device revocation end to end against the real getDb() singleton', () => {
  const r = runProbe(`
    import fs from 'node:fs';
    import path from 'node:path';
    const { DatabaseSync } = await import('node:sqlite');

    // Pre-create the scratch SQLite file WITH the schema applied, before
    // getDb() (imported below) ever opens it -- createSqlite() only opens
    // a file, it does not run schema.sql itself (that's init-db.js's job).
    const schema = fs.readFileSync('${schemaPath}', 'utf8');
    const seed = new DatabaseSync('${SCRATCH_SQLITE}');
    seed.exec('PRAGMA foreign_keys = ON;');
    seed.exec(schema);
    seed.exec("INSERT INTO organizations (id, name, slug, created_at) VALUES ('org_1','Gym','gym-1','2026-01-01T00:00:00Z')");
    seed.exec("INSERT INTO users (id, org_id, email, password_hash, role, name, active, token_epoch, created_at) VALUES ('usr_probe','org_1','probe\\@example.com','x','TRAINER','Probe','1',0,'2026-01-01T00:00:00Z')");
    seed.close();

    const { requireAuth, signToken } = await import('file://${authPath}');
    const token = signToken({ id: 'usr_probe', role: 'TRAINER', org_id: 'org_1', name: 'Probe', email: 'probe@example.com', token_epoch: 0 });

    function fakeReqRes(bearerToken) {
      const req = { headers: { authorization: 'Bearer ' + bearerToken }, cookies: {} };
      const res = { _status: 200, statusCode: 200, status(c) { this._status = c; return this; }, json(body) { this._body = body; return this; } };
      return { req, res };
    }

    // 1) BEFORE any epoch bump: the token must be accepted.
    const before = fakeReqRes(token);
    let beforeNextCalled = false;
    await requireAuth(before.req, before.res, () => { beforeNextCalled = true; });

    // 2) Bump the epoch directly in the DB (simulating /change-password,
    //    /reset-password or /logout-everywhere), WITHOUT re-signing --
    //    the whole point is that the OLD token must now be rejected.
    const bump = new DatabaseSync('${SCRATCH_SQLITE}');
    bump.exec("UPDATE users SET token_epoch = token_epoch + 1 WHERE id = 'usr_probe'");
    bump.close();

    // 3) AFTER the bump: the SAME (now-stale) token must be rejected.
    //    Note: this subprocess's in-memory epoch cache never saw the old
    //    value for this user (step 1 populated it with the CURRENT epoch
    //    at that time), so this also exercises the real cache-miss path,
    //    not just cold-start behavior.
    const { invalidateUserEpochCache } = await import('file://${authPath}');
    invalidateUserEpochCache('usr_probe'); // same call /change-password etc. make
    const after = fakeReqRes(token);
    let afterNextCalled = false;
    await requireAuth(after.req, after.res, () => { afterNextCalled = true; });

    console.log(JSON.stringify({
      beforeNextCalled, beforeStatus: before.res._status,
      afterNextCalled, afterStatus: after.res._status, afterBody: after.res._body,
    }));
  `);
  assert.equal(r.status, 0, `subprocess should exit cleanly; stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.beforeNextCalled, true, 'a token at the current epoch must be accepted (next() called)');
  assert.equal(out.afterNextCalled, false, 'a token at a STALE epoch must never be accepted (next() must not be called)');
  assert.equal(out.afterStatus, 401);
  assert.match(out.afterBody?.error || '', /invalid or expired/i);
});

test.after(async () => {
  const { rm } = await import('node:fs/promises');
  for (const suffix of ['', '-wal', '-shm']) {
    await rm(SCRATCH_SQLITE + suffix, { force: true }).catch(() => {});
  }
});
