// ============================================================
// Business-logic tests for Physique OS. Runs against an in-memory
// SQLite built from the real schema — no server or fixtures needed.
//   node --test backend/test
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    exec(sql) { db.exec(sql); },
    raw: db
  };
}

const idp = (p) => 'id_' + Math.random().toString(36).slice(2, 10);

// ---------- program validation ----------
test('program validation rejects bad programs', async () => {
  const { validateProgram } = await import('../src/services/programValidation.js');
  const good = validateProgram({ name: 'PPL', split: 'PPL_5', days: [
    { day_of_week: 1, name: 'Push', template_id: 'wkt_1' },
    { day_of_week: 2, name: 'Pull', template_id: 'wkt_2' }
  ] });
  assert.equal(good.ok, true);
  assert.ok(validateProgram({ name: '', split: 'PPL_5', days: [] }).errors.length > 0, 'empty name + no days rejected');
  assert.ok(validateProgram({ name: 'X', split: 'NOPE', days: [{ day_of_week: 1, name: 'P', template_id: 't' }] }).errors.some(e => e.includes('split')));
  const dup = validateProgram({ name: 'X', split: 'PPL_5', days: [
    { day_of_week: 3, name: 'A', template_id: 't' },
    { day_of_week: 3, name: 'B', template_id: 't2' }
  ] });
  assert.ok(dup.errors.some(e => e.includes('unique')), 'duplicate days rejected');
  assert.ok(validateProgram({ name: 'X', split: 'PPL_5', days: [{ day_of_week: 9, name: 'A', template_id: 't' }] }).errors.some(e => e.includes('0-6')));
});

// ---------- muscle normalization ----------
test('muscle normalization maps legacy strings to canonical muscles', async () => {
  const { normalizeMuscle } = await import('../src/services/muscles.js');
  assert.equal(normalizeMuscle('CHEST'), 'chest');
  assert.equal(normalizeMuscle('UPPER CHEST'), 'upper_chest');
  assert.equal(normalizeMuscle('FRONT DELTS'), 'shoulders');
  assert.equal(normalizeMuscle('POSTERIOR CHAIN'), 'posterior_chain');
  assert.equal(normalizeMuscle('—'), null);
});

// ---------- equipment ----------
test('equipment checks and alternatives respect client profile', async () => {
  const { requiredItems, parseAvailable, checkExercises } = await import('../src/services/equipment.js');
  assert.deepEqual(requiredItems('BARBELL'), ['barbell']);
  assert.deepEqual(requiredItems('DUMBBELL'), ['dumbbells']);
  assert.ok(parseAvailable('full_gym').has('machine'));
  const issues = checkExercises(
    [{ id: 'e1', name: 'Bench Press', equipment: 'BARBELL' }],
    JSON.stringify(['dumbbells', 'bench'])
  );
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0].missing, ['barbell']);
  const ok = checkExercises([{ id: 'e2', name: 'Curl', equipment: 'DUMBBELL' }], JSON.stringify(['dumbbells']));
  assert.equal(ok.length, 0);
});

// ---------- PR candidates ----------
test('PR candidates are computed only from completed sets', async () => {
  const { computePRCandidates } = await import('../src/services/personalRecords.js');
  const c = computePRCandidates([
    { actual_weight: 60, actual_reps: 8, completed: 1 },
    { actual_weight: 60, actual_reps: 9, completed: 1 },
    { actual_weight: 0, actual_reps: 0, completed: 0 },
    { actual_weight: 100, actual_reps: 5, completed: 0 }
  ]);
  assert.equal(c.heaviest_weight.value, 60);
  assert.equal(c.best_reps.reps, 9);
  assert.ok(c.est_1rm.value > 60 && c.est_1rm.value < 80, 'Epley 1RM in plausible range');
  assert.equal(c.best_volume.value, 60 * 9);
  assert.equal(computePRCandidates([{ actual_weight: 0, actual_reps: 0, completed: 1 }]), null);
});

test('PR detection upserts records and reports previous values', async () => {
  const db = await memDb();
  const { evaluatePRs } = await import('../src/services/personalRecords.js');
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Org', 'org', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, org_id, goal, created_at) VALUES (?, ?, ?, ?)', ['c1', 'o1', 'FAT_LOSS', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO exercise_library (id, name, primary_muscle, equipment, is_global) VALUES (?, ?, ?, ?, 1)', ['ex1', 'Bench Press', 'CHEST', 'BARBELL']);
  const first = await evaluatePRs(db, 'c1', 'ex1', [{ actual_weight: 60, actual_reps: 8, completed: 1 }], '2026-08-10');
  assert.ok(first.some(r => r.type === 'heaviest_weight' && r.value === 60));
  const again = await evaluatePRs(db, 'c1', 'ex1', [{ actual_weight: 55, actual_reps: 8, completed: 1 }], '2026-08-11');
  assert.equal(again.length, 0, 'no PR for lighter session');
  const better = await evaluatePRs(db, 'c1', 'ex1', [{ actual_weight: 62.5, actual_reps: 8, completed: 1 }], '2026-08-12');
  const hw = better.find(r => r.type === 'heaviest_weight');
  assert.ok(hw && hw.value === 62.5 && hw.previous === 60, 'reports previous best');
});

test('PR detection respects existing workout history as baseline', async () => {
  const db = await memDb();
  const { evaluatePRs } = await import('../src/services/personalRecords.js');
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Org', 'org', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, org_id, goal, created_at) VALUES (?, ?, ?, ?)', ['c1', 'o1', 'FAT_LOSS', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO exercise_library (id, name, primary_muscle, equipment, is_global) VALUES (?, ?, ?, ?, 1)', ['ex1', 'Bench Press', 'CHEST', 'BARBELL']);
  // historical best: 65kg x 8
  await db.run('INSERT INTO workout_logs (id, client_id, exercise_id, date, sets_done, reps, weight) VALUES (?, ?, ?, ?, ?, ?, ?)', ['wl1', 'c1', 'ex1', '2026-08-03', 4, 8, 65]);
  // lighter session must NOT be a PR
  const none = await evaluatePRs(db, 'c1', 'ex1', [{ actual_weight: 60, actual_reps: 8, completed: 1 }], '2026-08-10');
  assert.equal(none.length, 0, 'no PR below historical best');
  // heavier session -> PR with previous from history
  const pr = await evaluatePRs(db, 'c1', 'ex1', [{ actual_weight: 67.5, actual_reps: 8, completed: 1 }], '2026-08-12');
  const hw = pr.find(r => r.type === 'heaviest_weight');
  assert.ok(hw && hw.value === 67.5 && hw.previous === 65, 'PR vs historical baseline');
});

// ---------- progressive overload (set-aware) ----------
test('progressive overload suggests weight only when sets hit target', async () => {
  const db = await memDb();
  const { suggestNextTarget } = await import('../src/services/progressiveOverload.js');
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Org', 'org', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, org_id, goal, created_at) VALUES (?, ?, ?, ?)', ['c1', 'o1', 'FAT_LOSS', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO exercise_library (id, name, primary_muscle, equipment, is_global) VALUES (?, ?, ?, ?, 1)', ['ex1', 'Bench Press', 'CHEST', 'BARBELL']);
  const seedSession = async (date, weight, reps, sets) => {
    await db.run(`INSERT INTO workout_logs (id, client_id, exercise_id, date, sets_done, reps, weight) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [idp('wl'), 'c1', 'ex1', date, sets, reps, weight]);
    const wl = await db.q1('SELECT id FROM workout_logs WHERE client_id = ? AND exercise_id = ? AND date = ?', ['c1', 'ex1', date]);
    for (let i = 1; i <= sets; i++) {
      await db.run(`INSERT INTO exercise_set_logs (id, workout_log_id, client_id, exercise_id, set_number, actual_reps, actual_weight, completed) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        [idp('st'), wl.id, 'c1', 'ex1', i, reps, weight]);
    }
  };
  await seedSession('2026-08-03', 60, 8, 4); // prev session 60x8
  const hold = await suggestNextTarget(db, 'c1', 'ex1', { prescribedReps: 8, prescribedSets: 4 });
  assert.equal(hold.progress, false, 'first session -> hold (no prior baseline)');
  await seedSession('2026-08-10', 60, 8, 4); // hit target again
  const up = await suggestNextTarget(db, 'c1', 'ex1', { prescribedReps: 8, prescribedSets: 4 });
  assert.ok(up.progress, 'matched prev + hit reps -> progress');
  assert.ok(up.suggested.weight > 60, 'weight increases');
  await seedSession('2026-08-17', 60, 6, 4); // reps fell short
  const rep = await suggestNextTarget(db, 'c1', 'ex1', { prescribedReps: 8, prescribedSets: 4 });
  assert.equal(rep.progress, false);
  assert.ok(rep.suggested.weight === 60, 'weight held');
  assert.ok(rep.suggested.reps > 6, 'reps bumped');
});

// ---------- alert dedup + resolution ----------
test('alert evaluation is idempotent and resolves cleared conditions', async () => {
  const db = await memDb();
  const { evaluateOrg, evaluateClient } = await import('../src/services/atRisk.js');
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Org', 'org', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u1', 'o1', 'c@x.in', 'x', 'Rahul', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, last_checkin_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', ['c1', 'u1', 'o1', 'FAT_LOSS', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO client_profiles (client_id, diet_type, cuisine) VALUES (?, ?, ?)', ['c1', 'NON_VEG', 'INDIAN']);

  await evaluateOrg(db, 'o1', 'u1');
  await evaluateOrg(db, 'o1', 'u1'); // run again
  const open = await db.q(`SELECT type FROM alerts WHERE client_id = ? AND status = 'open'`, ['c1']);
  const types = open.map(a => a.type);
  assert.ok(types.includes('MISSED_CHECKIN'));
  // dedup: only ONE alert per type
  for (const t of types) {
    const n = await db.q1('SELECT COUNT(*) AS n FROM alerts WHERE client_id = ? AND type = ? AND status = ?', ['c1', t, 'open']);
    assert.equal(n.n, 1, `no duplicate ${t}`);
  }
  // resolve: client checks in -> condition clears (use relative date so test doesn't go stale)
  const { daysAgoIso } = await import('../src/utils/time.js');
  const recentCheckin = daysAgoIso(1) + 'T08:00:00Z';
  await db.run('UPDATE clients SET last_checkin_at = ? WHERE id = ?', [recentCheckin, 'c1']);
  await evaluateOrg(db, 'o1', 'u1');
  const resolved = await db.q1(`SELECT COUNT(*) AS n FROM alerts WHERE client_id = ? AND type = 'MISSED_CHECKIN' AND status = 'resolved'`, ['c1']);
  assert.equal(resolved.n, 1, 'cleared condition -> resolved');
});

// ---------- timezone day boundaries ----------
test('day boundaries respect the org timezone (Asia/Kolkata default)', async () => {
  const { dayKey } = await import('../src/utils/time.js');
  // 00:30 IST on Aug 11 == 19:00 UTC Aug 10 -> IST day is Aug 11, UTC day is Aug 10
  const instant = new Date('2026-08-10T19:00:00Z');
  assert.equal(dayKey(instant, 'Asia/Kolkata'), '2026-08-11');
  assert.equal(dayKey(instant, 'UTC'), '2026-08-10');
  // 23:30 IST Aug 10 == 18:00 UTC Aug 10 -> same IST day
  assert.equal(dayKey(new Date('2026-08-10T18:00:00Z'), 'Asia/Kolkata'), '2026-08-10');
});

// ---------- tenant isolation ----------
test('resolveClient blocks cross-org access at the resolver level', async () => {
  const db = await memDb();
  const { resolveClient } = await import('../src/auth.js');
  for (const [oid, slug] of [['o1', 'a'], ['o2', 'b']]) {
    await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [oid, 'Org ' + oid, slug, '2026-01-01T00:00:00Z']);
  }
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'TRAINER', ?, 1, ?)`, ['t1', 'o1', 't@a.in', 'x', 'T1', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`, ['u1', 'o1', 'c@a.in', 'x', 'C1', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, trainer_id, goal, created_at) VALUES (?, ?, ?, ?, ?, ?)', ['c1', 'u1', 'o1', 't1', 'FAT_LOSS', '2026-01-01T00:00:00Z']);

  const res = () => { const r = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; return r; };

  const own = res();
  const ok = await resolveClient(db, { user: { role: 'TRAINER', org: 'o1', sub: 't1' } }, own, 'c1');
  assert.ok(ok && ok.id === 'c1' && own.statusCode === 0, 'same-org trainer allowed');

  const other = res();
  const denied = await resolveClient(db, { user: { role: 'TRAINER', org: 'o2', sub: 't1' } }, other, 'c1');
  assert.equal(denied, null);
  assert.equal(other.statusCode, 403, 'cross-org denied');
});
