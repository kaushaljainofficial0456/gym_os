// ============================================================
// "USUALLY BUSIEST 6-8 PM" HAS TO COME FROM THE GYM'S OWN DAYS.
//
// It did not. The client crowd screen carried a hard-coded 24-element
// array, and derived from it: the hourly chart, the peak hour, the quiet
// hours, the average head-count and the advice on when to visit. Every gym
// in the product was shown the same invented day -- including a
// recommendation to train at midnight -- beneath a footer reading "Live
// data from the gym access system".
//
// The backend already had the real events. These tests cover the engine
// that reads them, and in particular the two ways a real one still goes
// wrong: computing a "typical day" from too few days, and letting a day
// that is only half over define the evening.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crowdHistory, computeOccupancy, MIN_DAYS_FOR_TYPICAL } from '../src/services/occupancy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const ts = '2026-01-01T00:00:00Z';
const TZ = 'UTC';

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

let seq = 0;
async function gym(db, { clients = 6 } = {}) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Gym', 'gym', ts]);
  await db.run('INSERT INTO gym_settings (org_id, crowd_capacity, crowd_enabled) VALUES (?,?,?)', ['o1', 100, 1]);
  for (let i = 0; i < clients; i += 1) {
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                  VALUES (?,'o1',?,'x','CLIENT',?,1,?)`, [`u${i}`, `u${i}@x.in`, `C${i}`, ts]);
    await db.run('INSERT INTO clients (id, user_id, org_id, created_at) VALUES (?,?,?,?)', [`c${i}`, `u${i}`, 'o1', ts]);
  }
  return db;
}

const ev = (db, clientId, day, hhmm, direction) => db.run(
  'INSERT INTO attendance_events (id, org_id, client_id, ts, direction) VALUES (?,?,?,?,?)',
  [`e${seq += 1}`, 'o1', clientId, `${day}T${hhmm}:00.000Z`, direction]);

const dayKeyUTC = (offsetDays) => new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10);

/** One ordinary evening-peaked day: 4 people in at 18:00, out at 20:00. */
async function busyEvening(db, day, people = 4) {
  for (let i = 0; i < people; i += 1) {
    await ev(db, `c${i}`, day, '18:10', 'entry');
    await ev(db, `c${i}`, day, '20:10', 'exit');
  }
}

test('too little history says so instead of drawing a curve', async () => {
  // The failure mode this replaces was a curve that was always available
  // because it was never real. Two days is not a typical day.
  const db = await memDb();
  await gym(db);
  await busyEvening(db, dayKeyUTC(1));
  await busyEvening(db, dayKeyUTC(2));

  const h = await crowdHistory(db, 'o1', TZ);
  assert.equal(h.sufficient, false);
  assert.equal(h.daysOfHistory, 2);
  assert.equal(h.daysRequired, MIN_DAYS_FOR_TYPICAL);
  assert.equal(h.typicalByHour, null, 'no curve is offered at all');
  assert.equal(h.busiestHours, null);
});

test('with enough history the busiest window is the real one', async () => {
  const db = await memDb();
  await gym(db);
  for (let d = 1; d <= 10; d += 1) await busyEvening(db, dayKeyUTC(d));

  const h = await crowdHistory(db, 'o1', TZ);
  assert.equal(h.sufficient, true);
  assert.equal(h.daysOfHistory, 10);
  assert.equal(h.busiestHours.startHour, 18, 'the 18:00-20:00 block is where everyone actually was');
  assert.equal(h.busiestHours.average, 4);
  assert.equal(h.typicalByHour.length, 24);
  assert.equal(h.typicalByHour[18].count, 4);
  assert.equal(h.typicalByHour[3].count, 0, 'nobody is there at 3am and the curve says so');
});

test('today is excluded from "typical" — a half-finished day is not a day', async () => {
  // Including it would drag every evening hour toward zero each morning and
  // walk the apparent peak backwards through the day.
  const db = await memDb();
  await gym(db);
  for (let d = 1; d <= 8; d += 1) await busyEvening(db, dayKeyUTC(d));
  // Today: one person, early, nobody since.
  await ev(db, 'c0', dayKeyUTC(0), '06:00', 'entry');

  const h = await crowdHistory(db, 'o1', TZ);
  assert.equal(h.daysOfHistory, 8, "today is not counted toward the typical day");
  assert.equal(h.typicalByHour[18].count, 4, 'the evening peak is untouched by this morning');
  assert.equal(h.todayByHour[6].count, 1, "but today's own curve is still reported separately");
});

test('an hour with no events inherits the standing occupancy', async () => {
  // 30 people inside and nobody moving for an hour is a busy hour. Counting
  // only the hours that happen to contain a scan reports it as empty.
  const db = await memDb();
  await gym(db);
  for (let d = 1; d <= 8; d += 1) {
    await ev(db, 'c0', dayKeyUTC(d), '10:00', 'entry');
    await ev(db, 'c1', dayKeyUTC(d), '10:05', 'entry');
    await ev(db, 'c0', dayKeyUTC(d), '14:00', 'exit');
    await ev(db, 'c1', dayKeyUTC(d), '14:05', 'exit');
  }

  const h = await crowdHistory(db, 'o1', TZ);
  for (const hour of [11, 12, 13]) {
    assert.equal(h.typicalByHour[hour].count, 2, `hour ${hour} had two people in the building`);
  }
});

test('the quiet-hours recommendation never points at a closed gym', async () => {
  // 3am is not a quiet time, it is a locked door. The old screen's advice
  // was literally "try visiting around 12 AM".
  const db = await memDb();
  await gym(db);
  for (let d = 1; d <= 8; d += 1) {
    await ev(db, 'c0', dayKeyUTC(d), '07:00', 'entry');   // quiet morning
    await ev(db, 'c0', dayKeyUTC(d), '09:00', 'exit');
    await busyEvening(db, dayKeyUTC(d));
  }

  const h = await crowdHistory(db, 'o1', TZ);
  assert.ok(h.quietestHours, 'a quiet window is offered');
  assert.ok(h.quietestHours.startHour >= 7 && h.quietestHours.startHour <= 19,
    `recommended ${h.quietestHours.startHour}:00, which is outside the hours the gym is used`);
  assert.ok(h.quietestHours.average < h.busiestHours.average);
});

test('duplicate scans do not inflate the typical curve', async () => {
  const db = await memDb();
  await gym(db);
  for (let d = 1; d <= 8; d += 1) {
    await ev(db, 'c0', dayKeyUTC(d), '18:00', 'entry');
    await ev(db, 'c0', dayKeyUTC(d), '18:01', 'entry');   // scanned twice
    await ev(db, 'c0', dayKeyUTC(d), '18:02', 'entry');
    await ev(db, 'c0', dayKeyUTC(d), '20:00', 'exit');
    await ev(db, 'c0', dayKeyUTC(d), '20:01', 'exit');    // and out twice
  }

  const h = await crowdHistory(db, 'o1', TZ);
  assert.equal(h.typicalByHour[18].count, 1, 'one person is one person however often they scan');
  assert.equal(h.typicalByHour[21].count, 0);
});

test('weekday averages count only the days that actually occurred', async () => {
  const db = await memDb();
  await gym(db);
  for (let d = 1; d <= 14; d += 1) await busyEvening(db, dayKeyUTC(d));

  const h = await crowdHistory(db, 'o1', TZ);
  assert.equal(h.byWeekday.length, 7);
  const seen = h.byWeekday.filter((w) => w.days > 0);
  assert.equal(seen.length, 7, 'two weeks covers every weekday');
  for (const w of seen) assert.equal(w.averagePeak, 4);
  // A weekday with no data reports null, never a zero that reads as "empty gym".
  const db2 = await memDb();
  await gym(db2);
  for (let d = 1; d <= 8; d += 1) await busyEvening(db2, dayKeyUTC(d));
  const h2 = await crowdHistory(db2, 'o1', TZ);
  for (const w of h2.byWeekday) {
    assert.ok(w.days > 0 ? w.averagePeak !== null : w.averagePeak === null);
  }
});

test('an empty gym returns an honest empty shape, not an error', async () => {
  const db = await memDb();
  await gym(db);
  const h = await crowdHistory(db, 'o1', TZ);
  assert.equal(h.sufficient, false);
  assert.equal(h.daysOfHistory, 0);
  assert.equal(h.todayByHour.length, 24);
  assert.ok(h.todayByHour.every((x) => x.count === 0));
});

// ---------------------------------------------------------------
test('the live snapshot carries its own freshness and refuses to fake a percentage', async () => {
  const db = await memDb();
  await gym(db);
  const today = dayKeyUTC(0);
  /* Events from the last couple of minutes, not from 09:00. Freshness now
     measures the age of the newest EVENT as well as of the calculation
     (see getFreshness): this test used to seed 09:00 scans and assert
     "live" at whatever hour it ran, which is exactly the claim that fix
     removed -- a count whose newest scan is hours old is not live, however
     recently we did the arithmetic. Clamped to today so a run just after
     midnight still lands both scans in today's window. */
  const dayStart = Date.parse(`${today}T00:00:00.000Z`);
  const recent = (msAgo) => new Date(Math.max(Date.now() - msAgo, dayStart)).toISOString();
  await db.run('INSERT INTO attendance_events (id, org_id, client_id, ts, direction) VALUES (?,?,?,?,?)',
    [`e${seq += 1}`, 'o1', 'c0', recent(120_000), 'entry']);
  await db.run('INSERT INTO attendance_events (id, org_id, client_id, ts, direction) VALUES (?,?,?,?,?)',
    [`e${seq += 1}`, 'o1', 'c1', recent(60_000), 'entry']);

  const withCap = await computeOccupancy(db, 'o1', TZ, { crowd_enabled: 1, crowd_capacity: 100 });
  assert.equal(withCap.current, 2);
  assert.equal(withCap.crowd.occupancyPercentage, 2);
  assert.equal(withCap.crowd.status, 'quiet');
  assert.ok(withCap.freshness.isLive, 'recent scans, just calculated: genuinely live');
  assert.ok(withCap.lastEventAt.startsWith(today));

  // The same gym with no capacity configured must not produce a percentage.
  const noCap = await computeOccupancy(db, 'o1', TZ, { crowd_enabled: 1, crowd_capacity: 0 });
  assert.equal(noCap.crowd.status, 'no_capacity');
  assert.equal(noCap.crowd.occupancyPercentage, null);
});

test('hiding the head-count hides it in EVERY field, not just the pretty one', async () => {
  /* Caught live, in my own implementation. getCrowdStatus correctly nulled
     its occupancyCount -- and `current`, `peak`, `average` and byHour sat
     next to it in the same response body carrying the identical number.
     A setting enforced in one field of five is not a setting; it is a
     component declining to render something anyone can read out of the
     network tab. */
  const db = await memDb();
  await gym(db);
  const today = dayKeyUTC(0);
  for (let i = 0; i < 4; i += 1) await ev(db, `c${i}`, today, '09:00', 'entry');

  const settings = { crowd_enabled: 1, crowd_capacity: 200 };
  const shown = await computeOccupancy(db, 'o1', TZ, settings);
  assert.equal(shown.current, 4, 'the owner path still sees real counts');
  assert.equal(shown.peak, 4);
  assert.ok(Array.isArray(shown.byHour));

  const hidden = await computeOccupancy(db, 'o1', TZ, settings, { showExactCount: false });
  assert.equal(hidden.crowd.occupancyCount, null);
  assert.equal(hidden.current, null, 'the legacy top-level count is gated too');
  assert.equal(hidden.peak, null);
  assert.equal(hidden.average, null);
  assert.equal(hidden.byHour, null, 'the per-hour series carries the same number');

  // How busy it is is still reported -- that is the part members are meant
  // to see, and removing it would leave the card with nothing to say.
  // 4 people in a 200-capacity gym is 2%, deliberately: the count and the
  // percentage have to be different numbers for the sniff below to mean
  // anything.
  assert.equal(hidden.crowd.occupancyPercentage, 2);
  assert.equal(hidden.crowd.status, 'quiet');

  // And nothing anywhere in the payload spells the head-count out. Broad on
  // purpose -- it is meant to catch a FUTURE field that carries the number,
  // not just the ones enumerated above.
  assert.ok(!/(^|[^\d.])4([^\d.]|$)/.test(JSON.stringify(hidden.crowd)),
    `head-count leaked into the status payload: ${JSON.stringify(hidden.crowd)}`);
});
