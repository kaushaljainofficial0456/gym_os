// ============================================================
// QR enrollment tokens -- generation, verification, atomic single-use
// consumption, revocation. The concurrent-double-consumption test is
// the one the spec explicitly calls out ("Two clients scanning same QR
// simultaneously... must remain consistent").
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  issueEnrollmentToken, verifyEnrollmentToken, consumeEnrollmentToken, revokeEnrollmentToken,
} from '../src/services/enterprise/enrollmentToken.js';

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

async function seedOrgAndOwner(db) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym A', 'gym-a', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'GYM_OWNER', ?, 1, ?)`,
    ['owner1', 'o1', 'owner@a.in', 'x', 'Owner A', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['newclient1', 'o1', 'nc1@a.in', 'x', 'New Client', '2026-01-01T00:00:00Z']);
}

test('issueEnrollmentToken -> verifyEnrollmentToken: a freshly issued token verifies successfully without being consumed', async () => {
  const db = await memDb();
  await seedOrgAndOwner(db);
  const issued = await issueEnrollmentToken(db, { orgId: 'o1', createdBy: 'owner1', purpose: 'CLIENT' });
  assert.ok(issued.payload.startsWith('enr_'));
  assert.ok(issued.payload.includes('.'));

  const verified = await verifyEnrollmentToken(db, issued.payload, { expectedPurpose: 'CLIENT' });
  assert.equal(verified.ok, true);
  assert.equal(verified.token.status, 'AVAILABLE', 'preview verification must never itself consume the token');

  const row = await db.q1('SELECT * FROM enrollment_tokens WHERE id = ?', [issued.id]);
  assert.equal(row.status, 'AVAILABLE');
  assert.notEqual(row.token_hash, issued.payload.split('.')[1], 'the raw secret must never be stored as-is, only its hash');
});

test('the QR itself carries no sensitive data -- only an opaque id.secret pair', async () => {
  const db = await memDb();
  await seedOrgAndOwner(db);
  await db.run(`INSERT INTO packages (id, org_id, name, amount, currency, period_days) VALUES (?, ?, ?, ?, ?, ?)`,
    ['plan_secret_pricing', 'o1', 'Monthly', 1500, 'INR', 30]);
  const issued = await issueEnrollmentToken(db, { orgId: 'o1', createdBy: 'owner1', purpose: 'CLIENT', membershipPlanId: 'plan_secret_pricing' });
  assert.ok(!issued.payload.includes('o1'), 'org id must not appear in the QR payload');
  assert.ok(!issued.payload.includes('plan_secret_pricing'), 'membership plan id must not appear in the QR payload');
  assert.ok(!issued.payload.includes('CLIENT'), 'purpose must not appear in the QR payload');
});

test('consumeEnrollmentToken: a valid token is consumed exactly once, then rejected on reuse', async () => {
  const db = await memDb();
  await seedOrgAndOwner(db);
  const issued = await issueEnrollmentToken(db, { orgId: 'o1', createdBy: 'owner1', purpose: 'CLIENT' });

  const first = await consumeEnrollmentToken(db, issued.payload, { expectedPurpose: 'CLIENT', consumedBy: 'newclient1' });
  assert.equal(first.ok, true);
  assert.equal(first.token.id, issued.id);

  const second = await consumeEnrollmentToken(db, issued.payload, { expectedPurpose: 'CLIENT', consumedBy: 'newclient1' });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already_consumed', 'a QR can NEVER be reused');

  const row = await db.q1('SELECT * FROM enrollment_tokens WHERE id = ?', [issued.id]);
  assert.equal(row.status, 'CONSUMED');
  assert.equal(row.consumed_by, 'newclient1');
});

test('consumeEnrollmentToken: TWO SIMULTANEOUS consumption attempts on the same token -- only one wins, ever', async () => {
  const db = await memDb();
  await seedOrgAndOwner(db);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['newclient2', 'o1', 'nc2@a.in', 'x', 'New Client 2', '2026-01-01T00:00:00Z']);
  const issued = await issueEnrollmentToken(db, { orgId: 'o1', createdBy: 'owner1', purpose: 'CLIENT' });

  // Two "simultaneous" scans -- Promise.all against the SAME in-memory
  // DB genuinely races these at the JS-event-loop-interleaving level.
  const [a, b] = await Promise.all([
    consumeEnrollmentToken(db, issued.payload, { expectedPurpose: 'CLIENT', consumedBy: 'newclient1' }),
    consumeEnrollmentToken(db, issued.payload, { expectedPurpose: 'CLIENT', consumedBy: 'newclient2' }),
  ]);
  const outcomes = [a, b];
  const winners = outcomes.filter((o) => o.ok);
  const losers = outcomes.filter((o) => !o.ok);
  assert.equal(winners.length, 1, 'exactly one of the two simultaneous scans must win, never zero, never both');
  assert.equal(losers.length, 1);
  assert.equal(losers[0].reason, 'already_consumed');

  const row = await db.q1('SELECT * FROM enrollment_tokens WHERE id = ?', [issued.id]);
  assert.equal(row.status, 'CONSUMED');
  assert.ok(['newclient1', 'newclient2'].includes(row.consumed_by), 'consumed_by reflects exactly the one winner');
});

test('verifyEnrollmentToken: wrong secret for a real token id is rejected, not treated as a lookup failure it can bypass', async () => {
  const db = await memDb();
  await seedOrgAndOwner(db);
  const issued = await issueEnrollmentToken(db, { orgId: 'o1', createdBy: 'owner1', purpose: 'CLIENT' });
  const tampered = issued.id + '.' + 'x'.repeat(43); // right shape, wrong secret
  const r = await verifyEnrollmentToken(db, tampered);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid_secret');
});

test('verifyEnrollmentToken: malformed payloads are rejected gracefully, never throw', async () => {
  const db = await memDb();
  for (const bad of ['', 'not-a-token', 'enr_abc', 'enr_abc.', '.secretonly', 123, null, undefined, {}]) {
    const r = await verifyEnrollmentToken(db, bad);
    assert.equal(r.ok, false);
  }
});

test('verifyEnrollmentToken: purpose mismatch is rejected (a TRAINER QR cannot be consumed as a CLIENT enrollment)', async () => {
  const db = await memDb();
  await seedOrgAndOwner(db);
  const issued = await issueEnrollmentToken(db, { orgId: 'o1', createdBy: 'owner1', purpose: 'TRAINER' });
  const r = await verifyEnrollmentToken(db, issued.payload, { expectedPurpose: 'CLIENT' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'wrong_purpose');
});

test('verifyEnrollmentToken: an expired token is rejected even though its secret is correct', async () => {
  const db = await memDb();
  await seedOrgAndOwner(db);
  const issued = await issueEnrollmentToken(db, { orgId: 'o1', createdBy: 'owner1', purpose: 'CLIENT', ttlMs: -1000 }); // already expired
  const r = await verifyEnrollmentToken(db, issued.payload);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expired');
});

test('revokeEnrollmentToken: an AVAILABLE token can be revoked and is then unusable', async () => {
  const db = await memDb();
  await seedOrgAndOwner(db);
  const issued = await issueEnrollmentToken(db, { orgId: 'o1', createdBy: 'owner1', purpose: 'CLIENT' });
  const revoked = await revokeEnrollmentToken(db, { orgId: 'o1', tokenId: issued.id });
  assert.equal(revoked, true);
  const r = await verifyEnrollmentToken(db, issued.payload);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'revoked');
});

test('revokeEnrollmentToken: an already-CONSUMED token cannot be revoked (never un-does a real enrollment)', async () => {
  const db = await memDb();
  await seedOrgAndOwner(db);
  const issued = await issueEnrollmentToken(db, { orgId: 'o1', createdBy: 'owner1', purpose: 'CLIENT' });
  await consumeEnrollmentToken(db, issued.payload, { expectedPurpose: 'CLIENT', consumedBy: 'newclient1' });
  const revoked = await revokeEnrollmentToken(db, { orgId: 'o1', tokenId: issued.id });
  assert.equal(revoked, false);
  const row = await db.q1('SELECT * FROM enrollment_tokens WHERE id = ?', [issued.id]);
  assert.equal(row.status, 'CONSUMED', 'must stay CONSUMED, not flip back or to REVOKED');
});

test('revokeEnrollmentToken: cannot revoke another org\'s token', async () => {
  const db = await memDb();
  await seedOrgAndOwner(db);
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o2', 'Gym B', 'gym-b', '2026-01-01T00:00:00Z']);
  const issued = await issueEnrollmentToken(db, { orgId: 'o1', createdBy: 'owner1', purpose: 'CLIENT' });
  const revoked = await revokeEnrollmentToken(db, { orgId: 'o2', tokenId: issued.id });
  assert.equal(revoked, false);
  const row = await db.q1('SELECT * FROM enrollment_tokens WHERE id = ?', [issued.id]);
  assert.equal(row.status, 'AVAILABLE', 'untouched by a cross-org revoke attempt');
});
