// Spoken call-back times -> a moment the gym may call (services/followups/when.js).
// The clock is fixed: Thursday 12 November 2026, 2:30 PM in India; the gym
// calls 10:00-19:30, Monday to Saturday (closed Sundays).
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWhen, localToUtc, timeLabel } from '../src/services/followups/when.js';

const NOW = new Date('2026-11-12T09:00:00.000Z');           // 14:30 IST
const base = { now: NOW, tz: 'Asia/Kolkata', window: { start: 600, end: 1170 }, daysMask: '1111110' };
const when = (text, extra = {}) => resolveWhen({ ...base, text, ...extra });

test('tomorrow at 6 PM resolves to Friday 18:00 IST', () => {
  const r = when('Call me tomorrow at 6 PM');
  assert.equal(r.ok, true);
  assert.equal(r.dayKey, '2026-11-13');
  assert.equal(r.minutes, 18 * 60);
  assert.equal(r.at, '2026-11-13T12:30:00.000Z');
  assert.equal(r.label, 'tomorrow (Friday 13 November) at 6 PM');
});

test('next Monday with no time asks for a time on that day', () => {
  const r = when('Call me next Monday');
  assert.equal(r.ok, false);
  assert.equal(r.need, 'time');
  assert.equal(r.dayKey, '2026-11-16');
  assert.match(r.ask, /What time on Monday 16 November/);
  assert.match(r.ask, /10 AM and 7:30 PM/);
});

test('next Monday at 6 (no AM/PM) is the evening', () => {
  const r = when('next Monday', { time: null });
  assert.equal(r.ok, false);
  const r2 = when('next monday, 6 pm');
  assert.equal(r2.ok, true);
  assert.equal(r2.local, '2026-11-16 18:00');
  const r3 = when('Monday at 6');
  assert.equal(r3.local, '2026-11-16 18:00');
});

test('after five days asks for a time on Tuesday 17th', () => {
  const r = when('call me after five days');
  assert.equal(r.need, 'time');
  assert.equal(r.dayKey, '2026-11-17');
});

test('after three days lands on a Sunday: offers Monday instead', () => {
  const r = when('after three days please');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'day_closed');
  assert.equal(r.suggestion, '2026-11-16');
  assert.match(r.ask, /We do not call on Sundays/);
});

test('"in the evening" with no day means today, around 6 PM', () => {
  const r = when('Call me in the evening');
  assert.equal(r.ok, true);
  assert.equal(r.dayKey, '2026-11-12');
  assert.equal(r.minutes, 18 * 60);
  assert.equal(r.assumedDay, true);
  assert.equal(r.approximate, true);
  assert.equal(r.label, 'today (Thursday 12 November) at around 6 PM');
});

test('after 7 PM is 19:00, inside hours; after 8 PM is outside them', () => {
  assert.equal(when('call me after 7 PM').local, '2026-11-12 19:00');
  const late = when('after 8 pm');
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'outside_hours');
  assert.match(late.ask, /between 10 AM and 7:30 PM/);
});

test('on the 20th', () => {
  const r = when('call me on the 20th');
  assert.equal(r.need, 'time');
  assert.equal(r.dayKey, '2026-11-20');
  assert.equal(when('on the 20th at 11').local, '2026-11-20 11:00');
});

test('a day of the month already past this month means next month', () => {
  assert.equal(when('on the 5th at 11 am').local, '2026-12-05 11:00');
});

test('next week, next month and "after my vacation" are not dates: ask', () => {
  const nw = when('call me next week');
  assert.equal(nw.reason, 'vague_date');
  assert.equal(nw.ask, 'Which day next week suits you?');
  assert.equal(when('when I get back from vacation').reason, 'vague_date');
  assert.equal(when('maybe next month').reason, 'vague_date');
  assert.equal(when('later').reason, 'vague_date');
  assert.equal(when('').reason, 'no_date');
});

test('Monday next week is the Monday of the following calendar week', () => {
  assert.equal(when('monday next week at 11 am').local, '2026-11-16 11:00');
  assert.equal(when('friday next week at 11 am').local, '2026-11-20 11:00');
});

test('first day of next month', () => {
  assert.equal(when('first day of next month at 10 am').local, '2026-12-01 10:00');
  assert.equal(when('1st of next month, 4:30 pm').local, '2026-12-01 16:30');
});

test('a bare time already past today moves to the next open day', () => {
  const r = when('call me at 2');
  assert.equal(r.ok, true);
  assert.equal(r.local, '2026-11-13 14:00');
  assert.match(r.label, /^tomorrow/);
});

test('Hinglish: kal shaam 6 baje, parso subah 11 baje', () => {
  assert.equal(when('kal shaam 6 baje').local, '2026-11-13 18:00');
  assert.equal(when('parso subah 11 baje').local, '2026-11-14 11:00');
});

test('explicit dates: 20/11, 20 November, Nov 20', () => {
  assert.equal(when('20/11 at 10:30 am').local, '2026-11-20 10:30');
  assert.equal(when('20 November at 5 pm').local, '2026-11-20 17:00');
  assert.equal(when('Nov 20, half past five').local, '2026-11-20 17:30');
});

test('too far ahead, too soon, and the past are refused with a question', () => {
  assert.equal(when('in 90 days at 11 am').reason, 'too_far');
  assert.equal(when('today at 2:35 pm').reason, 'too_soon');
  assert.equal(when('today at 11 am').reason, 'past');
});

test('Sunday is closed; the member is offered Monday', () => {
  const r = when('Sunday at 11');
  assert.equal(r.reason, 'day_closed');
  assert.equal(r.suggestion, '2026-11-16');
});

test("the agent's own date and time fill only what the words did not say", () => {
  const r = when('the day we discussed', { date: '2026-11-18', time: '17:00' });
  assert.equal(r.ok, true);
  assert.equal(r.local, '2026-11-18 17:00');
  // The words win over the model's arithmetic.
  const w = when('next Monday at 6 pm', { date: '2026-11-17', time: '10:00' });
  assert.equal(w.local, '2026-11-16 18:00');
});

test('time ranges like 6-7 pm are a time, not a date', () => {
  const r = when('tomorrow between 6-7 pm');
  assert.equal(r.ok, true);
  assert.equal(r.dayKey, '2026-11-13');
});

test('daylight saving: local time converts on both sides of the change', () => {
  // Europe/London moves to BST at 01:00 UTC on 29 March 2026.
  assert.equal(localToUtc('2026-03-28', 18 * 60, 'Europe/London').toISOString(), '2026-03-28T18:00:00.000Z');
  assert.equal(localToUtc('2026-03-29', 18 * 60, 'Europe/London').toISOString(), '2026-03-29T17:00:00.000Z');
  assert.equal(localToUtc('2026-11-12', 18 * 60, 'Asia/Kolkata').toISOString(), '2026-11-12T12:30:00.000Z');
  const london = resolveWhen({ text: 'tomorrow at 6 pm', now: new Date('2026-03-28T12:00:00Z'), tz: 'Europe/London', window: { start: 540, end: 1260 }, daysMask: '1111111' });
  assert.equal(london.at, '2026-03-29T17:00:00.000Z');
});

test('time labels', () => {
  assert.equal(timeLabel(18 * 60), '6 PM');
  assert.equal(timeLabel(18 * 60 + 30), '6:30 PM');
  assert.equal(timeLabel(12 * 60), 'noon');
  assert.equal(timeLabel(10 * 60 + 5), '10:05 AM');
});
