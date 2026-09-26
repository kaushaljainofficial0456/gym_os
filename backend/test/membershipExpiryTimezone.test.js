// ============================================================
// A MEMBERSHIP LAPSES ON THE GYM'S CALENDAR, NOT UTC'S.
//
// end_date is a local calendar date somebody typed into a form. Comparing
// it against the UTC date is wrong for part of every day in every
// timezone that is not UTC, and the direction that hurts is west of it: a
// member on the LAST day they paid for was told their membership had
// expired, because in UTC it was already tomorrow.
//
// These are pure-function tests with an injected clock, so they assert
// the boundary itself rather than whatever hour the suite happens to run.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveMembershipStatus } from '../src/services/enterprise/membershipLifecycle.js';
import { dayKey } from '../src/utils/time.js';

const member = (endDate, lifecycle = 'ACTIVE') => ({ end_date: endDate, lifecycle_status: lifecycle });

test('the last paid day is still ACTIVE in a gym west of UTC', () => {
  // 2026-09-24, 20:00 in New York = 2026-09-25 00:00 UTC. The member's
  // last day is the 24th and they are standing in the gym.
  const now = new Date('2026-09-25T00:00:00Z');
  const tz = 'America/New_York';
  assert.equal(dayKey(now, tz), '2026-09-24', 'precondition: local day is still the 24th');

  const status = effectiveMembershipStatus(member('2026-09-24'), { tz, today: dayKey(now, tz) });
  assert.equal(status, 'ACTIVE', 'the day they paid for is not over until it is over where they are');

  // The bug this replaced, stated as the UTC answer it used to give.
  const utcAnswer = effectiveMembershipStatus(member('2026-09-24'), { today: now.toISOString().slice(0, 10) });
  assert.equal(utcAnswer, 'EXPIRED', 'which is what the member used to be told');
});

test('it does lapse once the gym itself reaches the next day', () => {
  const now = new Date('2026-09-25T12:00:00Z');           // 08:00 in New York
  const tz = 'America/New_York';
  assert.equal(dayKey(now, tz), '2026-09-25');
  assert.equal(effectiveMembershipStatus(member('2026-09-24'), { tz, today: dayKey(now, tz) }), 'EXPIRED');
});

test('east of UTC a lapsed membership does not linger into the local morning', () => {
  // 2026-09-25, 02:00 in Kolkata = 2026-09-24 20:30 UTC. Locally it is
  // already the 25th, so a membership that ended on the 24th is over.
  const now = new Date('2026-09-24T20:30:00Z');
  const tz = 'Asia/Kolkata';
  assert.equal(dayKey(now, tz), '2026-09-25', 'precondition: local day has rolled over');

  assert.equal(effectiveMembershipStatus(member('2026-09-24'), { tz, today: dayKey(now, tz) }), 'EXPIRED');
  assert.equal(
    effectiveMembershipStatus(member('2026-09-24'), { today: now.toISOString().slice(0, 10) }), 'ACTIVE',
    'the UTC reading kept it alive for another five and a half hours');
});

test('a deliberate state outranks the calendar', () => {
  const opts = { tz: 'Asia/Kolkata', today: '2026-12-31' };
  for (const state of ['PAUSED', 'SUSPENDED', 'CANCELLED', 'REFUNDED', 'TRANSFERRED']) {
    assert.equal(effectiveMembershipStatus(member('2020-01-01', state), opts), state,
      `${state} is somebody's decision, not something the date may overwrite`);
  }
});

test('no end date means nothing to lapse against', () => {
  assert.equal(effectiveMembershipStatus(member(null), { tz: 'Asia/Kolkata' }), 'ACTIVE');
  assert.equal(effectiveMembershipStatus(null), null);
});

test('called with no options at all it still uses a real timezone, never UTC', () => {
  // The default must degrade to the configured gym timezone. A caller that
  // forgets the argument should not silently get the UTC bug back.
  const row = member(dayKey(new Date(), 'Asia/Kolkata'));   // ends today, locally
  assert.equal(effectiveMembershipStatus(row), 'ACTIVE');
});
