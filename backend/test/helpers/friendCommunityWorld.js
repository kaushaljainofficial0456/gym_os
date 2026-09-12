// ============================================================
// A world for the friend-community suites.
//
// Four gyms' worth of people, because "cross-gym" is the whole point:
// Rahul and Neha train at one gym, Sambhav and Priya at another, Kaushal
// and Vikram at a third, and Arjun trains alone with no gym at all.
//
// Sessions are logged the way the app logs them -- workout row, prescribed
// exercises, per-set logs, and records evaluated by the REAL PR engine.
// Nothing here writes a personal_records row by hand, so every PR assertion
// is an assertion about the engine's own output.
//
// Health data is seeded for everyone, so "never exposed" is tested against
// rows that genuinely exist rather than against an empty table.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import express from 'express';
import { config } from '../../src/config.js';
import { evaluatePRs } from '../../src/services/personalRecords.js';
import { todayKey } from '../../src/utils/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..', '..');
const schema = fs.readFileSync(path.join(root, 'database', 'schema.sql'), 'utf8');

// requireAuth resolves the org timezone from the real dev database, where
// these fixture orgs do not exist -- so every request falls back to
// DEFAULT_TZ. Seeding against the same zone keeps day boundaries aligned.
export const TZ = 'Asia/Kolkata';
export const TS = '2026-01-01T00:00:00.000Z';

export const EXERCISES = { ex_bench: 'Bench Press', ex_squat: 'Squat', ex_row: 'Barbell Row' };

// Health sentinels. Deliberately odd values, so a scan can tell them apart
// from a real training number and no lift weight or volume in these suites
// can collide with one.
export const SENTINELS = {
  bodyWeight: 87.3,
  sleepHours: 7.25,
  sleepScore: 88.5,
  recoveryScore: 71.25,
  workoutKcal: 612.5,
};

export const PEOPLE = {
  rahul: { org: 'org_a', name: 'Rahul Mehta' },
  neha: { org: 'org_a', name: 'Neha Shah' },
  sambhav: { org: 'org_b', name: 'Sambhav Jain' },
  priya: { org: 'org_b', name: 'Priya Nair' },
  kaushal: { org: 'org_c', name: 'Kaushal Rao' },
  vikram: { org: 'org_c', name: 'Vikram Das' },
  arjun: { org: 'org_ind', name: 'Arjun Sethi' },
};

export const uid = (key) => `u_${key}`;
export const cid = (key) => `c_${key}`;
export const today = () => todayKey(TZ);
export const dayShift = (key, days) => {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
export const daysAgo = (n) => dayShift(today(), -n);

export async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(schema);
  // Columns scripts/init-db.js adds through its guarded MIGRATIONS list,
  // which this lightweight in-memory database does not run. notify() writes
  // both, and reaction de-duplication reads data_json.
  raw.exec('ALTER TABLE notifications ADD COLUMN data_json TEXT');
  raw.exec("ALTER TABLE notifications ADD COLUMN channel TEXT NOT NULL DEFAULT 'in_app'");
  // The gym community sits behind a platform feature flag that init-db seeds
  // at 100%; without it the gym half of these tests would assert against a
  // switched-off feature.
  raw.exec(
    'INSERT INTO feature_flags (id, key, name, enabled, rollout_percentage, enabled_org_ids_json, created_at, updated_at) '
    + `VALUES ('flag_community', 'community', 'Gym Community', 1, 100, '[]', '${TS}', '${TS}')`);

  const mk = () => ({
    driver: 'sqlite',
    async q(sql, p = []) { const st = raw.prepare(sql); return p.length ? st.all(...p) : st.all(); },
    async q1(sql, p = []) { const rows = await mk().q(sql, p); return rows[0] || null; },
    async run(sql, p = []) {
      const st = raw.prepare(sql);
      const r = p.length ? st.run(...p) : st.run();
      return { changes: Number(r.changes) };
    },
    exec(sql) { raw.exec(sql); },
    async tx(fn) {
      raw.exec('BEGIN');
      try { const out = await fn(mk()); raw.exec('COMMIT'); return out; } catch (e) {
        try { raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      }
    },
    raw,
  });
  return mk();
}

export async function seedWorld(db) {
  for (const [orgId, name, slug, type] of [
    ['org_a', 'Iron Temple', 'iron-temple', 'gym'],
    ['org_b', 'Pulse Studio', 'pulse-studio', 'gym'],
    ['org_c', 'Northside Barbell', 'northside-barbell', 'gym'],
    ['org_ind', 'Independent Clients', 'independent', 'independent'],
  ]) {
    await db.run('INSERT INTO organizations (id, name, slug, type, timezone, created_at) VALUES (?,?,?,?,?,?)',
      [orgId, name, slug, type, TZ, TS]);
    const gym = type === 'gym' ? 1 : 0;
    await db.run(
      'INSERT INTO gym_settings (org_id, community_enabled, community_leaderboard_enabled, crowd_enabled, updated_at) VALUES (?,?,?,?,?)',
      [orgId, gym, gym, gym, TS]);
  }

  for (const [key, person] of Object.entries(PEOPLE)) {
    await db.run(
      'INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) '
      + "VALUES (?,?,?,'x','CLIENT',?,1,?)",
      [uid(key), person.org, `${key}@test.in`, person.name, TS]);
    await db.run(
      'INSERT INTO clients (id, user_id, org_id, goal, current_weight, height_cm, age, created_at) '
      + "VALUES (?,?,?,'GENERAL',?,?,?,?)",
      [cid(key), uid(key), person.org, SENTINELS.bodyWeight, 178, 29, TS]);
  }

  // A staff account: no client profile, so no workouts, records or streaks.
  await db.run(
    'INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) '
    + "VALUES ('u_coach','org_a','coach@test.in','x','TRAINER','Coach Dev',1,?)", [TS]);

  // Rahul and Neha opted in to their gym's community; nobody else did.
  for (const key of ['rahul', 'neha']) {
    await db.run('INSERT INTO community_members (client_id, org_id, enabled, updated_at) VALUES (?,?,1,?)',
      [cid(key), PEOPLE[key].org, TS]);
  }

  for (const [exerciseId, name] of Object.entries(EXERCISES)) {
    await db.run(
      'INSERT INTO exercise_library (id, name, primary_muscle, equipment, movement, ex_type, is_global) '
      + "VALUES (?,?,'CHEST','BARBELL','horizontal_push','compound',1)", [exerciseId, name]);
  }

  const day = today();
  for (const key of Object.keys(PEOPLE)) {
    await db.run('INSERT INTO weight_logs (id, client_id, date, weight, created_at) VALUES (?,?,?,?,?)',
      [`wt_${key}`, cid(key), day, SENTINELS.bodyWeight, TS]);
    await db.run('INSERT INTO sleep_logs (id, client_id, date, duration_h, target_h) VALUES (?,?,?,?,8)',
      [`sl_${key}`, cid(key), day, SENTINELS.sleepHours]);
    await db.run(
      'INSERT INTO health_daily_summaries (id, user_id, org_id, date, sleep_score, recovery_score, computed_at, created_at, updated_at) '
      + 'VALUES (?,?,?,?,?,?,?,?,?)',
      [`hd_${key}`, uid(key), PEOPLE[key].org, day, SENTINELS.sleepScore, SENTINELS.recoveryScore, TS, TS, TS]);
  }
}

let sessionSeq = 0;

export async function completeSession(db, person, {
  date, name = 'Push Day', durationMin = 58,
  lifts = [{ exercise: 'ex_bench', weight: 60, reps: 8, sets: 3 }],
} = {}) {
  sessionSeq += 1;
  const workoutId = `w_${person}_${sessionSeq}`;
  await db.run(
    'INSERT INTO workouts (id, org_id, client_id, name, scheduled_date, status, source, '
    + 'duration_min, estimated_active_kcal, completed_at, created_at) '
    + "VALUES (?,?,?,?,?,'completed','program',?,?,?,?)",
    [workoutId, PEOPLE[person].org, cid(person), name, date, durationMin,
      SENTINELS.workoutKcal, `${date}T18:30:00.000Z`, TS]);

  let position = 0;
  for (const lift of lifts) {
    position += 1;
    await db.run(
      'INSERT INTO workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec) '
      + 'VALUES (?,?,?,?,?,?,?,?,90)',
      [`we_${workoutId}_${position}`, workoutId, lift.exercise, position,
        EXERCISES[lift.exercise], lift.sets, String(lift.reps), String(lift.weight)]);

    const sets = Array.from({ length: lift.sets }, () => ({
      actual_weight: lift.weight, actual_reps: lift.reps, completed: 1,
    }));
    // eslint-disable-next-line no-await-in-loop
    const prs = await evaluatePRs(db, cid(person), lift.exercise, sets, date);

    const logId = `wl_${workoutId}_${position}`;
    await db.run(
      'INSERT INTO workout_logs (id, client_id, workout_id, exercise_id, date, sets_done, reps, weight, is_pr, created_at) '
      + 'VALUES (?,?,?,?,?,?,?,?,?,?)',
      [logId, cid(person), workoutId, lift.exercise, date, lift.sets, lift.reps, lift.weight, prs.length ? 1 : 0, TS]);
    for (let s = 1; s <= lift.sets; s += 1) {
      // eslint-disable-next-line no-await-in-loop
      await db.run(
        'INSERT INTO exercise_set_logs (id, workout_log_id, client_id, exercise_id, set_number, actual_reps, actual_weight, completed) '
        + 'VALUES (?,?,?,?,?,?,?,1)',
        [`sl_${logId}_${s}`, logId, cid(person), lift.exercise, s, lift.reps, lift.weight]);
    }
  }
  return workoutId;
}

export async function startApi() {
  const db = await memDb();
  await seedWorld(db);
  const [communities, community, communityInvite, notifications] = await Promise.all([
    import('../../src/routes/communities.js'),
    import('../../src/routes/community.js'),
    import('../../src/routes/communityInvite.js'),
    import('../../src/routes/notifications.js'),
  ]);
  const app = express();
  app.use(express.json());
  app.use('/api/communities', communities.default(db));
  app.use('/api/community', community.default(db));
  app.use('/api/community-invite', communityInvite.default(db));
  app.use('/api/notifications', notifications.default(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const tokenFor = (key) => {
    if (key === 'coach') {
      return jwt.sign({ sub: 'u_coach', role: 'TRAINER', org: 'org_a', name: 'Coach Dev' }, config.jwtSecret, { expiresIn: '1h' });
    }
    const person = PEOPLE[key];
    return jwt.sign({ sub: uid(key), role: 'CLIENT', org: person.org, name: person.name }, config.jwtSecret, { expiresIn: '1h' });
  };

  // `who === null` sends no Authorization header at all.
  const call = async (method, p, body, who) => {
    const res = await fetch(base + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(who === null ? {} : { Authorization: `Bearer ${tokenFor(who || 'rahul')}` }),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, json };
  };

  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, close, tokenFor };
}

export async function makeCommunity(call, owner = 'rahul', name = 'Beast Squad') {
  const res = await call('POST', '/api/communities', { name }, owner);
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

/** Generate a code as `owner` and have `person` redeem it. */
export async function joinViaCode(call, communityId, owner, person) {
  const made = await call('POST', `/api/communities/${communityId}/codes`, {}, owner);
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const joined = await call('POST', '/api/communities/join', { code: made.json.code }, person);
  assert.equal(joined.status, 201, JSON.stringify(joined.json));
  return made.json.code;
}
