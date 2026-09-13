// ============================================================
// THE LOGGING DAY — food eaten at 00:40 belongs to the night that just
// happened, not to the morning that has technically started.
//
// Keying meal logs on the calendar date meant a late dinner landed on
// tomorrow: the day you actually ate it closed under-counted, and the
// next day opened already spent before you had eaten anything. A tracker
// that does this is wrong about both days at once.
//
// The rule that matters most here is CONSISTENCY. If writing used the
// cutoff and reading used the calendar, a late meal would be stored
// against yesterday and then not appear in yesterday's totals either --
// strictly worse than the bug being fixed. So the resolver is shared and
// both sides go through it.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logDayKey, isBeforeDayStart, DEFAULT_DAY_START_HOUR } from '../src/utils/time.js';
import { clientLogDay, dayStartHour, invalidateDayStart } from '../src/services/logDay.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const ts = '2026-01-01T00:00:00Z';
const IST = 'Asia/Kolkata';

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

async function seed(db, { dayStart } = {}) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Gym', 'gym', ts]);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                VALUES ('u1','o1','a@x.in','x','CLIENT','C',1,?)`, [ts]);
  await db.run('INSERT INTO clients (id, user_id, org_id, created_at) VALUES (?,?,?,?)', ['c1', 'u1', 'o1', ts]);
  if (dayStart !== undefined) {
    await db.run('INSERT INTO client_profiles (client_id, day_start_hour) VALUES (?, ?)', ['c1', dayStart]);
  }
  invalidateDayStart('c1');
}

/* ---------------- the rule itself ---------------- */

test('a meal just after midnight counts to the day before', () => {
  // 2026-09-13T19:10Z is 00:40 on the 14th in IST.
  assert.equal(logDayKey(new Date('2026-09-13T19:10:00Z'), IST), '2026-09-13');
});

test('the boundary is the cutoff hour, read in the target timezone', () => {
  // 03:30 IST is still "last night"; 04:30 IST is the new day.
  assert.equal(logDayKey(new Date('2026-09-13T22:00:00Z'), IST), '2026-09-13');
  assert.equal(logDayKey(new Date('2026-09-13T23:00:00Z'), IST), '2026-09-14');
  // Shifting the UTC instant before formatting would move the boundary by
  // the zone's own offset -- a 4am rule silently becoming 9:30am in IST.
});

test('daytime is unaffected', () => {
  assert.equal(logDayKey(new Date('2026-09-14T07:30:00Z'), IST), '2026-09-14');   // 13:00 IST
  assert.equal(logDayKey(new Date('2026-09-14T14:00:00Z'), IST), '2026-09-14');   // 19:30 IST
});

test('a cutoff of 0 restores plain calendar days', () => {
  // Anyone who wants midnight to mean midnight can still have it.
  assert.equal(logDayKey(new Date('2026-09-13T19:10:00Z'), IST, 0), '2026-09-14');
});

test('the cutoff is clamped to a sane range', () => {
  // A 20-hour "day start" would put most of the day in yesterday.
  assert.equal(logDayKey(new Date('2026-09-14T07:30:00Z'), IST, 99), logDayKey(new Date('2026-09-14T07:30:00Z'), IST, 12));
  assert.equal(logDayKey(new Date('2026-09-14T07:30:00Z'), IST, -5), logDayKey(new Date('2026-09-14T07:30:00Z'), IST, 0));
});

test('a nonsense cutoff falls back to the default rather than throwing', () => {
  assert.equal(logDayKey(new Date('2026-09-13T19:10:00Z'), IST, undefined), '2026-09-13');
  assert.equal(logDayKey(new Date('2026-09-13T19:10:00Z'), IST, 'four'), '2026-09-13');
});

test('the UI can tell when a log is landing on yesterday', () => {
  assert.equal(isBeforeDayStart(new Date('2026-09-13T19:10:00Z'), IST), true);    // 00:40
  assert.equal(isBeforeDayStart(new Date('2026-09-14T07:30:00Z'), IST), false);   // 13:00
  assert.equal(isBeforeDayStart(new Date('2026-09-13T19:10:00Z'), IST, 0), false);
});

/* ---------------- the client's own preference ---------------- */

test('the cutoff comes from the client profile', async () => {
  const db = await memDb();
  await seed(db, { dayStart: 6 });
  assert.equal(await dayStartHour(db, 'c1'), 6);
  // 05:30 IST with a 6am cutoff is still the previous day.
  assert.equal(await clientLogDay(db, 'c1', IST, new Date('2026-09-14T00:00:00Z')), '2026-09-13');
});

test('a client with no profile row gets the default, not an error', async () => {
  const db = await memDb();
  await seed(db);                      // no client_profiles row at all
  assert.equal(await dayStartHour(db, 'c1'), DEFAULT_DAY_START_HOUR);
  assert.equal(await clientLogDay(db, 'c1', IST, new Date('2026-09-13T19:10:00Z')), '2026-09-13');
});

test('a lookup failure never blocks a write', async () => {
  // An un-migrated database is missing the column. Defaulting is correct;
  // failing the meal log over a preference lookup is not.
  const db = await memDb();
  await seed(db);
  await db.run('DROP TABLE client_profiles');
  invalidateDayStart('c1');
  assert.equal(await dayStartHour(db, 'c1'), DEFAULT_DAY_START_HOUR);
});

test('changing the preference takes effect once invalidated', async () => {
  const db = await memDb();
  await seed(db, { dayStart: 4 });
  const late = new Date('2026-09-14T00:00:00Z');            // 05:30 IST
  assert.equal(await clientLogDay(db, 'c1', IST, late), '2026-09-14');
  await db.run('UPDATE client_profiles SET day_start_hour = 6 WHERE client_id = ?', ['c1']);
  invalidateDayStart('c1');
  assert.equal(await clientLogDay(db, 'c1', IST, late), '2026-09-13');
});

test('changing the cutoff re-buckets history rather than rewriting it', async () => {
  // The stored row keeps the instant it happened; only which day it
  // counts against moves. That is what makes the setting safe to change.
  const db = await memDb();
  await seed(db, { dayStart: 4 });
  const when = new Date('2026-09-13T22:30:00Z');            // 04:00 IST on the 14th
  const underFour = await clientLogDay(db, 'c1', IST, when);
  await db.run('UPDATE client_profiles SET day_start_hour = 8 WHERE client_id = ?', ['c1']);
  invalidateDayStart('c1');
  const underEight = await clientLogDay(db, 'c1', IST, when);
  assert.equal(underFour, '2026-09-14');
  assert.equal(underEight, '2026-09-13');
});
