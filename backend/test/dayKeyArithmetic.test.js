// ============================================================
// NEIGHBOURING DAYS ARE CALENDAR ARITHMETIC, NOT CLOCK ARITHMETIC.
//
// The recurring mistake in this codebase is taking `new Date()`, adding a
// day, and reading it back with toISOString() -- which answers in UTC. A
// gym's day and the UTC day differ for part of every day outside UTC, so
// that lands on the wrong neighbour exactly when the local clock is in
// the hours that cross UTC midnight.
//
// shiftDayKey works on the day key itself, so it cannot inherit a
// timezone it was never given.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, shiftDayKey } from '../src/utils/time.js';

test('shiftDayKey steps the calendar in both directions', () => {
  assert.equal(shiftDayKey('2026-09-25', 1), '2026-09-26');
  assert.equal(shiftDayKey('2026-09-25', -1), '2026-09-24');
  assert.equal(shiftDayKey('2026-09-25', 0), '2026-09-25');
});

test('it crosses month, year and leap-day boundaries', () => {
  assert.equal(shiftDayKey('2026-09-30', 1), '2026-10-01');
  assert.equal(shiftDayKey('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftDayKey('2028-02-28', 1), '2028-02-29', '2028 is a leap year');
  assert.equal(shiftDayKey('2027-02-28', 1), '2027-03-01', '2027 is not');
});

test('a junk key gives null rather than a wrong date', () => {
  assert.equal(shiftDayKey('not-a-date', 1), null);
  assert.equal(shiftDayKey(null, 1), null);
});

test("the evening reminder's tomorrow is the gym's tomorrow", () => {
  /* 21:00 in New York on 2026-09-25 is 01:00 UTC on the 26th -- inside
     the 18:00-23:00 send window, and already a different UTC date. The
     old code asked the clock and got the 27th; nothing is scheduled then,
     so the reminder simply never arrived. */
  const nowTs = new Date('2026-09-26T01:00:00Z');
  const tz = 'America/New_York';
  const today = dayKey(nowTs, tz);
  assert.equal(today, '2026-09-25', 'precondition: locally it is still the 25th');

  assert.equal(shiftDayKey(today, 1), '2026-09-26', 'the workout the member is being reminded about');

  const clockAnswer = (() => {
    const d = new Date(nowTs);
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  })();
  assert.equal(clockAnswer, '2026-09-27', 'which is the day the old code pointed at');
});

test('east of UTC it agrees with the local calendar too', () => {
  const nowTs = new Date('2026-09-25T14:00:00Z');   // 19:30 in Kolkata
  const today = dayKey(nowTs, 'Asia/Kolkata');
  assert.equal(today, '2026-09-25');
  assert.equal(shiftDayKey(today, 1), '2026-09-26');
});
