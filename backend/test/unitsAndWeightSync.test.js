// ============================================================
// TWO BUGS THAT BOTH SHOWED UP AS "THE APP DISAGREES WITH ITSELF".
//
// 1. GENERATED PROSE IGNORED THE UNIT PREFERENCE. Every screen formats
//    weights from the canonical kilograms the API returns, so switching
//    to imperial moved the whole product at once -- except the Progress
//    insights, which arrive as finished English with the unit baked into
//    the string on the server. A reader in pounds saw "165.3 lb" in the
//    page header and "now 87.4 kg" in the sentence directly under it.
//
// 2. THE PROFILE'S WEIGHT AND THE PROGRESS SERIES WERE TWO STORES WITH
//    NO PATH BETWEEN THEM. PUT /me/profile wrote clients.current_weight;
//    Progress reads weight_logs. Editing the profile therefore moved one
//    and not the other, and the two screens reported different weights
//    for the same person on the same afternoon -- 75 kg on one, 87.4 kg
//    on the other, each correct about its own source.
//
// Both are tested here because both are the same failure in the end: a
// number the product states twice, from two places, that can drift.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unitsFor, weightValue, formatWeight, formatWeightDelta, KG_PER_LB } from '../src/units.js';
import { getProgressIntel } from '../src/services/progress/progressIntel.js';
// The same day key the route writes with. Computing "today" independently
// here is how a test passes in UTC and fails everywhere east of it: the
// server's local date can already be tomorrow while toISOString() is not.
import { dayKey } from '../src/utils/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const ts = '2026-01-01T00:00:00Z';

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(schema);
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, p = []) { const st = raw.prepare(sql); return p.length ? st.all(...p) : st.all(); },
    async q1(sql, p = []) { const rows = await mk().q(sql, p); return rows[0] || null; },
    async run(sql, p = []) { const st = raw.prepare(sql); const r = p.length ? st.run(...p) : st.run(); return { changes: Number(r.changes) }; },
    raw,
  });
  return mk();
}

function dayKeyOffset(daysAgo) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

async function seedClientWithWeights(db, { unitSystem }) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Gym', 'gym', ts]);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                VALUES ('u1','o1','c@a.in','x','CLIENT','Client',1,?)`, [ts]);
  await db.run(`INSERT INTO clients (id, user_id, org_id, current_weight, start_weight, target_weight, created_at)
                VALUES ('c1','u1','o1',80,90,75,?)`, [ts]);
  if (unitSystem) {
    await db.run('INSERT INTO client_profiles (client_id, unit_system) VALUES (?, ?)', ['c1', unitSystem]);
  }
  // A falling series long enough for the trend engine to call it a trend.
  const points = [[84, 90], [70, 88.5], [56, 86], [42, 84], [28, 82.5], [14, 81], [0, 80]];
  points.forEach(([ago, kg], i) => {
    db.run('INSERT INTO weight_logs (id, client_id, date, weight, source, created_at) VALUES (?,?,?,?,?,?)',
      [`wl${i}`, 'c1', dayKeyOffset(ago), kg, 'manual', ts]);
  });
}

/* ---------------- the conversion module itself ---------------- */

test('server weight formatting matches the client definition exactly', () => {
  // Same exact constant on both sides of the wire, or the same stored
  // number renders as two different figures depending on who drew it.
  assert.equal(KG_PER_LB, 0.45359237);
  assert.equal(formatWeight(75, 'imperial'), '165.3 lb');
  assert.equal(formatWeight(75, 'metric'), '75 kg');
});

test('absence is stated as absence, never as zero', () => {
  // Number(null) is 0, so an unguarded formatter reports that a client
  // with no weight recorded weighs nothing -- a claim, not a gap.
  assert.equal(weightValue(null, 'metric'), null);
  assert.equal(weightValue('', 'imperial'), null);
  assert.equal(formatWeight(undefined, 'metric'), null);
});

test('a delta keeps its sign through conversion', () => {
  // Dropping the minus turns a loss into a gain at a glance, and every
  // weight insight in the product is one of these.
  assert.equal(formatWeightDelta(-4.5, 'metric'), '-4.5 kg');
  assert.equal(formatWeightDelta(-4.5, 'imperial'), '-9.9 lb');
  assert.equal(formatWeightDelta(2, 'metric'), '+2 kg');
});

test('an unknown preference falls back to metric rather than throwing', () => {
  assert.equal(unitsFor(undefined).weightUnit, 'kg');
  assert.equal(unitsFor('klingon').w(75), '75 kg');
  assert.equal(unitsFor('imperial').weightUnit, 'lb');
});

/* ---------------- the insights that carry the unit ---------------- */

test('progress insights are written in the client\'s own unit', async () => {
  const db = await memDb();
  await seedClientWithWeights(db, { unitSystem: 'imperial' });

  const intel = await getProgressIntel(db, { userId: 'u1', clientId: 'c1', days: 90 });
  const weightInsight = intel.insights.find((i) => i.metric === 'weight');
  assert.ok(weightInsight, 'a falling 7-point series should produce a weight insight');

  // The whole point: no kilogram may appear in a sentence shown to a
  // reader who asked for pounds.
  const prose = intel.insights.map((i) => `${i.title} ${i.description}`).join(' | ');
  assert.ok(!/\bkg\b/.test(prose), `insight prose still says kg: ${prose}`);
  assert.ok(/\blb\b/.test(prose), `insight prose never says lb: ${prose}`);
  assert.match(weightInsight.description, /176\.4 lb/);   // 80 kg, now
});

test('metric clients still read kilograms', async () => {
  const db = await memDb();
  await seedClientWithWeights(db, { unitSystem: 'metric' });
  const intel = await getProgressIntel(db, { userId: 'u1', clientId: 'c1', days: 90 });
  const prose = intel.insights.map((i) => i.description).join(' | ');
  assert.ok(/\bkg\b/.test(prose), prose);
  assert.ok(!/\blb\b/.test(prose), prose);
});

test('a client with no profile row gets metric, not an error', async () => {
  // Trainers and owners have no client_profiles row at all, and a client
  // predating the column has none either.
  const db = await memDb();
  await seedClientWithWeights(db, { unitSystem: null });
  const intel = await getProgressIntel(db, { userId: 'u1', clientId: 'c1', days: 90 });
  assert.ok(intel.insights.length > 0);
  assert.ok(/\bkg\b/.test(intel.insights.map((i) => i.description).join(' ')));
});

test('the canonical numbers on the response never convert', async () => {
  // Only PROSE is rendered in the reader's unit. If the data itself
  // converted, the client -- which formats every figure it draws --
  // would convert a second time and show pounds-of-pounds.
  const db = await memDb();
  await seedClientWithWeights(db, { unitSystem: 'imperial' });
  const intel = await getProgressIntel(db, { userId: 'u1', clientId: 'c1', days: 90 });
  assert.equal(intel.weight.analysis.current, 80, 'analysis must stay in kg');
  const series = intel.weight.series;
  assert.equal(series[series.length - 1].value, 80, 'series must stay in kg');
});

/* ---------------- the profile weight reaching the series ---------------- */

test('saving a weight on the profile appends it to the weight series', async (t) => {
  const express = (await import('express')).default;
  const jwt = (await import('jsonwebtoken')).default;
  const { config } = await import('../src/config.js');
  const meRoutes = (await import('../src/routes/me.js')).default;

  const db = await memDb();
  await seedClientWithWeights(db, { unitSystem: 'metric' });

  const app = express();
  app.use(express.json());
  app.use('/api/me', meRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const port = server.address().port;

  const token = jwt.sign({ sub: 'u1', role: 'CLIENT', org: 'o1', name: 'Client', email: 'c@a.in' }, config.jwtSecret);
  const put = (body) => fetch(`http://127.0.0.1:${port}/api/me/profile`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

  const before = await db.q('SELECT date, weight FROM weight_logs WHERE client_id = ? ORDER BY date', ['c1']);
  const res = await put({ current_weight: 77.5 });
  assert.equal(res.status, 200);

  const after = await db.q('SELECT date, weight FROM weight_logs WHERE client_id = ? ORDER BY date', ['c1']);
  const today = dayKey();
  const todayRows = after.filter((r) => r.date === today);
  assert.equal(todayRows.length, 1, 'exactly one row for today');
  assert.equal(todayRows[0].weight, 77.5);

  // And the two stores now agree, which is the whole point.
  const client = await db.q1('SELECT current_weight FROM clients WHERE id = ?', ['c1']);
  assert.equal(client.current_weight, 77.5);
  const intel = await getProgressIntel(db, { userId: 'u1', clientId: 'c1', days: 90 });
  assert.equal(intel.weight.analysis.current, 77.5,
    'Progress must report the same weight the profile just saved');

  // Saving again the same day REPLACES today's reading rather than
  // stacking a second row for one date -- a person correcting a typo has
  // not weighed themselves twice.
  await put({ current_weight: 76 });
  const after2 = await db.q('SELECT date, weight FROM weight_logs WHERE client_id = ? AND date = ?', ['c1', today]);
  assert.equal(after2.length, 1, 'a correction replaces today, it does not stack a second reading');
  assert.equal(after2[0].weight, 76);
  assert.equal(before.length + 1, (await db.q('SELECT id FROM weight_logs WHERE client_id = ?', ['c1'])).length,
    'two saves in one day add exactly one row in total');
});

test('a profile save that does not touch weight leaves the series alone', async (t) => {
  const express = (await import('express')).default;
  const jwt = (await import('jsonwebtoken')).default;
  const { config } = await import('../src/config.js');
  const meRoutes = (await import('../src/routes/me.js')).default;

  const db = await memDb();
  await seedClientWithWeights(db, { unitSystem: 'metric' });
  const app = express();
  app.use(express.json());
  app.use('/api/me', meRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const port = server.address().port;
  const token = jwt.sign({ sub: 'u1', role: 'CLIENT', org: 'o1', name: 'Client', email: 'c@a.in' }, config.jwtSecret);

  const before = (await db.q('SELECT id FROM weight_logs WHERE client_id = ?', ['c1'])).length;
  const res = await fetch(`http://127.0.0.1:${port}/api/me/profile`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ unit_system: 'imperial' }),
  });
  assert.equal(res.status, 200);
  const after = (await db.q('SELECT id FROM weight_logs WHERE client_id = ?', ['c1'])).length;
  assert.equal(after, before, 'changing a display unit is not a weigh-in');
});
