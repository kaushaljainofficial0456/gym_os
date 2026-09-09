// ============================================================
// DB-integration tests for upsertHealthRecord (backend/src/services/health/dedup.js)
// -- idempotency (spec §70/TEST 8) and soft-delete (spec §71) against a
// real (in-memory) SQLite DB, same setup pattern as foodValidationApi.test.js.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertHealthRecord, fingerprintRecord } from '../src/services/health/dedup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  const mk = () => ({
    async q(sql, params = []) { return db.prepare(sql).all(...params); },
    async q1(sql, params = []) { const rows = await mk().q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const res = db.prepare(sql).run(...params); return { changes: Number(res.changes) }; },
  });
  return mk();
}

async function seedUser(db) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Org', 'org', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?,?,?,?,'CLIENT',?,1,?)`,
    ['u1', 'o1', 'c@test.com', 'x', 'C', '2026-01-01T00:00:00Z']);
  return { userId: 'u1', orgId: 'o1' };
}

test('TEST 8 -- the same provider record arriving twice produces ONE row, not two', async () => {
  const db = await memDb();
  const { userId, orgId } = await seedUser(db);
  const record = { provider: 'apple_health', provider_record_id: 'ext-123', data_type: 'workout', activity_type: 'running', start_time: '2026-01-01T07:00:00Z', end_time: '2026-01-01T07:30:00Z', active_kcal: 300 };
  const first = await upsertHealthRecord(db, { userId, orgId }, record);
  const second = await upsertHealthRecord(db, { userId, orgId }, { ...record, active_kcal: 305 }); // provider corrected the figure slightly on re-sync
  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(first.id, second.id);
  const rows = await db.q('SELECT * FROM health_records WHERE user_id = ?', [userId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].active_kcal, 305, 'the update must overwrite the stale value');
});

test('records with no provider_record_id fall back to a fingerprint, still deduplicated on exact re-ingestion', async () => {
  const db = await memDb();
  const { userId, orgId } = await seedUser(db);
  const sample = { provider: 'apple_health', data_type: 'heart_rate', start_time: '2026-01-01T07:00:00Z', end_time: '2026-01-01T07:01:00Z', heart_rate_avg: 140 };
  await upsertHealthRecord(db, { userId, orgId }, sample);
  await upsertHealthRecord(db, { userId, orgId }, { ...sample }); // same window re-synced
  const rows = await db.q('SELECT * FROM health_records WHERE user_id = ? AND data_type = ?', [userId, 'heart_rate']);
  assert.equal(rows.length, 1);
  assert.equal(fingerprintRecord(sample), fingerprintRecord({ ...sample }));
});

test('a soft-deleted record is marked deleted_at, never hard-removed (spec §71 audit trail)', async () => {
  const db = await memDb();
  const { userId, orgId } = await seedUser(db);
  const record = { provider: 'whoop', provider_record_id: 'w-1', data_type: 'workout', start_time: '2026-01-01T18:00:00Z', end_time: '2026-01-01T18:30:00Z', active_kcal: 200 };
  await upsertHealthRecord(db, { userId, orgId }, record);
  const result = await upsertHealthRecord(db, { userId, orgId }, { ...record, deleted: true });
  assert.equal(result.deleted, true);
  const row = await db.q1('SELECT * FROM health_records WHERE id = ?', [result.id]);
  assert.ok(row, 'row must still exist');
  assert.ok(row.deleted_at, 'deleted_at must be set');
});

test('missing data never gets coerced into a zero-value row (spec TEST 12): unrelated field stays NULL', async () => {
  const db = await memDb();
  const { userId, orgId } = await seedUser(db);
  const record = { provider: 'oura', provider_record_id: 'o-1', data_type: 'workout', start_time: '2026-01-01T07:00:00Z', end_time: '2026-01-01T07:30:00Z', active_kcal: 200 };
  // steps was never reported for this record -- must stay NULL, not 0.
  await upsertHealthRecord(db, { userId, orgId }, record);
  const row = await db.q1('SELECT * FROM health_records WHERE provider_record_id = ?', ['o-1']);
  assert.equal(row.steps, null);
  assert.equal(row.heart_rate_avg, null);
});
