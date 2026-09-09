// ============================================================
// DEDUPLICATION ENGINE (spec §30/§70/§71).
//
// Two distinct jobs, kept separate on purpose:
//   1. EXACT idempotency -- the same provider record arriving twice
//      (a re-sync, a replayed webhook) must produce ONE row, not two.
//      Enforced primarily by the DB's own UNIQUE(user_id, provider,
//      provider_record_id) index (schema.sql) -- upsertHealthRecord()
//      below is what turns a unique-constraint hit into an UPDATE
//      instead of a thrown error.
//   2. FUZZY fingerprinting for records with NO stable provider id (some
//      sample-level data, e.g. a raw HR reading, never has one) -- a
//      deterministic fingerprint so the SAME sample re-ingested twice
//      (e.g. two overlapping incremental-sync windows) still collapses
//      to one row.
//
// Cross-PROVIDER dedup (WHOOP and Apple Health both reporting the same
// physical workout, spec §9) is NOT this file's job -- that's the
// WorkoutMatchingEngine (matching.js) deciding two DIFFERENT records
// belong to the same canonical_workout. This file only prevents the
// SAME record from being written twice.
// ============================================================
import { id, now } from '../../ids.js';

/** A stable fingerprint for a record with no provider_record_id --
 *  bucketed to the nearest minute (raw millisecond timestamps from two
 *  sync passes over the same sample can jitter by a few ms and must
 *  still collapse to one fingerprint). Pure function, no DB. */
export function fingerprintRecord(record) {
  const startBucket = record.start_time ? Math.floor(Date.parse(record.start_time) / 60000) : 'x';
  const endBucket = record.end_time ? Math.floor(Date.parse(record.end_time) / 60000) : 'x';
  const energy = record.active_kcal != null ? Math.round(record.active_kcal) : 'x';
  return [record.provider, record.data_type, record.activity_type || 'x', startBucket, endBucket, energy].join(':');
}

/** Upserts one normalized record for a user. Returns { id, inserted }.
 *  `record` is a CanonicalHealthRecordInput (see baseProvider.js's
 *  header) -- provider/data_type/start_time are required; everything
 *  else is optional and NULL when absent (spec §11: "NULL means
 *  unavailable, never coerced to zero"). Soft-deletes/updates (spec
 *  §71): if the provider marks a record deleted on a later sync, the
 *  caller passes `record.deleted = true` and this sets deleted_at
 *  rather than removing the row, preserving the audit trail. */
export async function upsertHealthRecord(db, { userId, orgId, connectionId = null }, record) {
  const dedupKey = record.provider_record_id || fingerprintRecord(record);
  const existing = await db.q1(
    'SELECT id FROM health_records WHERE user_id = ? AND provider = ? AND provider_record_id = ?',
    [userId, record.provider, dedupKey]
  );
  const nowIso = now();

  if (record.deleted) {
    if (existing) await db.run('UPDATE health_records SET deleted_at = ?, updated_at = ? WHERE id = ?', [nowIso, nowIso, existing.id]);
    return { id: existing?.id || null, inserted: false, deleted: true };
  }

  const cols = {
    provider: record.provider, provider_record_id: dedupKey, connection_id: connectionId,
    data_type: record.data_type, activity_type: record.activity_type ?? null,
    start_time: record.start_time, end_time: record.end_time ?? null,
    duration_seconds: record.duration_seconds ?? null,
    active_kcal: record.active_kcal ?? null, total_kcal: record.total_kcal ?? null, resting_kcal: record.resting_kcal ?? null,
    heart_rate_avg: record.heart_rate_avg ?? null, heart_rate_min: record.heart_rate_min ?? null, heart_rate_max: record.heart_rate_max ?? null,
    steps: record.steps ?? null, distance_m: record.distance_m ?? null,
    hrv_ms: record.hrv_ms ?? null, resting_hr: record.resting_hr ?? null,
    respiratory_rate: record.respiratory_rate ?? null, spo2_pct: record.spo2_pct ?? null,
    body_temperature_c: record.body_temperature_c ?? null, vo2max: record.vo2max ?? null,
    sleep_duration_seconds: record.sleep_duration_seconds ?? null, sleep_stages_json: record.sleep_stages_json ?? null,
    source_score: record.source_score ?? null, source_metric: record.source_metric ?? null,
    auto_detected: record.auto_detected ? 1 : 0, user_entered: record.user_entered ? 1 : 0,
    source_confidence: record.source_confidence ?? null,
    data_quality: record.data_quality || 'good', data_quality_reason: record.data_quality_reason ?? null,
    skos_workout_id: record.skos_workout_id ?? null,
  };

  if (existing) {
    const sets = Object.keys(cols).map((k) => `${k} = ?`).join(', ');
    await db.run(`UPDATE health_records SET ${sets}, deleted_at = NULL, updated_at = ?, synced_at = ? WHERE id = ?`,
      [...Object.values(cols), nowIso, nowIso, existing.id]);
    return { id: existing.id, inserted: false };
  }

  const recordId = id('hrec');
  const fields = ['id', 'user_id', 'org_id', ...Object.keys(cols), 'synced_at', 'created_at', 'updated_at'];
  const values = [recordId, userId, orgId, ...Object.values(cols), nowIso, nowIso, nowIso];
  await db.run(`INSERT INTO health_records (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`, values);
  return { id: recordId, inserted: true };
}
