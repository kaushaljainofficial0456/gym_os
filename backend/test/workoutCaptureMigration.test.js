// init-db.js migration for workout data capture, on an existing database:
// new columns appear, legacy planned rest is relabelled (not rewritten),
// and historical calorie values are untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('existing workouts keep their calorie values; legacy rest is labelled as planned', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'barbell-capture-'));
  const dbPath = path.join(dir, 'old.db');
  const env = { ...process.env, SQLITE_PATH: dbPath, DATABASE_URL: '', NODE_ENV: 'development' };
  try {
    await execFileAsync(process.execPath, ['scripts/init-db.js'], { cwd: backend, env });
    const { DatabaseSync } = await import('node:sqlite');
    let db = new DatabaseSync(dbPath);
    db.exec(`INSERT INTO organizations (id, name, slug, created_at) VALUES ('o1','Org','org','2026-01-01T00:00:00Z')`);
    db.exec(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('u1','o1','a@b.c','x','CLIENT','A',1,'2026-01-01T00:00:00Z')`);
    db.exec(`INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES ('c1','u1','o1','GENERAL','2026-01-01T00:00:00Z')`);
    db.exec(`INSERT INTO workouts (id, org_id, client_id, name, scheduled_date, status, created_at, duration_min,
               estimated_active_kcal, lower_kcal, upper_kcal, model_version, schema_version, calorie_provider, calorie_estimated_at)
             VALUES ('w1','o1','c1','Old','2026-05-01','completed','2026-05-01T00:00:00Z',52,
               287,215,359,'skos-cal-baseline-v1','0.1','baseline','2026-05-01T19:00:00Z')`);
    db.exec(`INSERT INTO workout_logs (id, client_id, workout_id, date, sets_done, created_at) VALUES ('l1','c1','w1','2026-05-01',2,'2026-05-01T00:00:00Z')`);
    db.exec(`INSERT INTO exercise_set_logs (id, workout_log_id, client_id, set_number, actual_reps, actual_weight, rest_seconds, completed, is_synthesized)
             VALUES ('s1','l1','c1',1,10,60,90,1,0), ('s2','l1','c1',2,10,60,NULL,1,0)`);
    // Recreate the pre-change shape for these rows: the new columns did not exist.
    for (const c of ['prescribed_rest_seconds', 'set_started_at', 'set_completed_at', 'actual_rest_seconds', 'tick_interval_seconds', 'timing_flags', 'reported_rir']) {
      db.exec(`ALTER TABLE exercise_set_logs DROP COLUMN ${c}`);
    }
    for (const c of ['session_timing_json', 'calorie_features_json']) db.exec(`ALTER TABLE workouts DROP COLUMN ${c}`);
    const before = db.prepare('SELECT * FROM workouts WHERE id = ?').get('w1');
    db.close();

    await execFileAsync(process.execPath, ['scripts/init-db.js'], { cwd: backend, env });
    await execFileAsync(process.execPath, ['scripts/init-db.js'], { cwd: backend, env }); // idempotent
    db = new DatabaseSync(dbPath);
    const after = db.prepare('SELECT * FROM workouts WHERE id = ?').get('w1');
    for (const k of ['estimated_active_kcal', 'lower_kcal', 'upper_kcal', 'model_version', 'schema_version', 'calorie_provider', 'calorie_estimated_at', 'duration_min']) {
      assert.equal(after[k], before[k], `${k} preserved`);
    }
    assert.equal(after.session_timing_json, null, 'no timing invented for old sessions');
    assert.equal(after.calorie_features_json, null);
    const s1 = db.prepare('SELECT * FROM exercise_set_logs WHERE id = ?').get('s1');
    assert.equal(s1.prescribed_rest_seconds, 90, 'planned rest now labelled as planned');
    assert.equal(s1.rest_seconds, 90, 'legacy column itself left as it was');
    assert.equal(s1.actual_rest_seconds, null, 'never promoted to actual rest');
    assert.equal(db.prepare('SELECT prescribed_rest_seconds FROM exercise_set_logs WHERE id = ?').get('s2').prescribed_rest_seconds, null);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
