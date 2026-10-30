// ============================================================
// Device identity and the migration that stores it
// (docs/WEARABLE_RECONCILIATION_DECISION.md).
//   - the native-bridge normalizers carry which device / app wrote a
//     record, when the bridge sends it, and never invent one;
//   - init-db.js adds the new provenance columns to a database whose
//     health tables predate them, without touching existing rows.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import appleHealth from '../src/services/health/providers/appleHealthProvider.js';
import healthConnect from '../src/services/health/providers/healthConnectProvider.js';
import { sourceIdentity } from '../src/services/health/providers/baseProvider.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backend = path.resolve(__dirname, '..');

test('Apple Health: device model and source bundle are carried when the bridge sends them', () => {
  const n = appleHealth.normalizeWorkout({
    uuid: 'a1', workoutActivityType: 'traditionalStrengthTraining', startDate: '2026-01-01T18:00:00Z', endDate: '2026-01-01T19:00:00Z',
    totalEnergyBurned: { unit: 'kcal', value: 312 },
    device: { manufacturer: 'Apple Inc.', model: 'Watch', name: 'Apple Watch' },
    sourceRevision: { source: { bundleIdentifier: 'com.apple.health.ABC' } },
  });
  assert.equal(n.source_device, 'Apple Inc. Watch');
  assert.equal(n.source_app, 'com.apple.health.ABC');
  const hr = appleHealth.normalizeQuantitySample({ uuid: 'q', quantityType: 'heartRate', startDate: '2026-01-01T18:00:00Z', endDate: '2026-01-01T18:01:00Z', quantity: { value: 120 }, sourceName: 'Strava' });
  assert.equal(hr.source_app, 'Strava');
  assert.equal(hr.source_device, null);
});

test('Apple Health: no device or source in the payload -> null, never guessed from the provider', () => {
  const n = appleHealth.normalizeWorkout({ uuid: 'a2', workoutActivityType: 'traditionalStrengthTraining', startDate: '2026-01-01T18:00:00Z', endDate: '2026-01-01T19:00:00Z' });
  assert.equal(n.source_device, null);
  assert.equal(n.source_app, null);
});

test('Health Connect: dataOrigin package and metadata device are carried', () => {
  const n = healthConnect.normalizeActiveCalories({
    metadata: { id: 'h1', dataOrigin: { packageName: 'com.samsung.android.wear.shealth' }, device: { manufacturer: 'Samsung', model: 'SM-R940' } },
    startTime: '2026-01-01T18:00:00Z', endTime: '2026-01-01T19:00:00Z', energy: { value: 250, unit: 'kilocalories' },
  });
  assert.equal(n.source_app, 'com.samsung.android.wear.shealth');
  assert.equal(n.source_device, 'Samsung SM-R940');
});

test('sourceIdentity trims, caps length and treats blanks as missing', () => {
  assert.deepEqual(sourceIdentity({ device: '  ', app: '' }), { source_device: null, source_app: null });
  assert.equal(sourceIdentity({ device: 'x'.repeat(500) }).source_device.length, 120);
});

test('init-db adds the provenance columns to existing health tables and keeps their rows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'barbell-migr-'));
  const dbPath = path.join(dir, 'old.db');
  const env = { ...process.env, SQLITE_PATH: dbPath, DATABASE_URL: '', NODE_ENV: 'development' };
  try {
    await execFileAsync(process.execPath, ['scripts/init-db.js'], { cwd: backend, env });
    const { DatabaseSync } = await import('node:sqlite');
    let db = new DatabaseSync(dbPath);
    // Recreate the pre-change shape: drop the new columns, keep a row.
    db.exec(`INSERT INTO organizations (id, name, slug, created_at) VALUES ('o1','Org','org','2026-01-01T00:00:00Z')`);
    db.exec(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('u1','o1','a@b.c','x','CLIENT','A',1,'2026-01-01T00:00:00Z')`);
    db.exec(`INSERT INTO health_canonical_workouts (id, user_id, org_id, start_time, end_time, primary_energy_source, active_kcal, created_at, updated_at)
             VALUES ('c1','u1','o1','2026-01-01T18:00:00Z','2026-01-01T19:00:00Z','whoop',327,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`);
    for (const c of ['source_device', 'source_app']) db.exec(`ALTER TABLE health_records DROP COLUMN ${c}`);
    for (const c of ['energy_basis', 'reconciliation_policy', 'wearable_active_kcal', 'wearable_provider', 'wearable_source_device',
      'wearable_source_app', 'wearable_measurement_type', 'wearable_coverage_ratio', 'disagreement_ratio', 'disagreement_flag']) {
      db.exec(`ALTER TABLE health_canonical_workouts DROP COLUMN ${c}`);
    }
    db.close();

    await execFileAsync(process.execPath, ['scripts/init-db.js'], { cwd: backend, env });
    db = new DatabaseSync(dbPath);
    const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(cols('health_records').includes('source_device'));
    assert.ok(cols('health_records').includes('source_app'));
    for (const c of ['energy_basis', 'wearable_active_kcal', 'wearable_source_device', 'disagreement_ratio', 'disagreement_flag']) {
      assert.ok(cols('health_canonical_workouts').includes(c), `${c} added`);
    }
    const row = db.prepare('SELECT * FROM health_canonical_workouts WHERE id = ?').get('c1');
    assert.equal(row.primary_energy_source, 'whoop', 'existing rows are not rewritten');
    assert.equal(row.active_kcal, 327);
    assert.equal(row.wearable_active_kcal, null, 'no back-filled provenance is invented');
    assert.equal(row.disagreement_flag, 0);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
