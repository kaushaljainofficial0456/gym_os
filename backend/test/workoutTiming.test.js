// Set-timing validation and derived rest/tick intervals (services/workoutTiming.js).
// Pure function: no DB. Covers incomplete data, missing timestamps,
// interrupted sessions, clock problems and timer anomalies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSessionTiming, pausedOverlapMs } from '../src/services/workoutTiming.js';

const T0 = Date.parse('2026-11-02T18:00:00Z');
const at = (sec) => new Date(T0 + sec * 1000).toISOString();
const win = (endSec) => ({ started_at: at(0), finished_at: at(endSec) });

// A straight-sets session: set k starts at 120k+30 s and ends 40 s later.
function straightSets(n, { withStart = true } = {}) {
  return Array.from({ length: n }, (_, k) => ({
    key: `ex#${k}`,
    started_at: withStart ? at(120 * k + 30) : undefined,
    completed_at: at(120 * k + 70),
  }));
}

test('complete timing: actual rest = previous completion -> this start; tick interval = completion -> completion', () => {
  const r = analyzeSessionTiming({ sets: straightSets(3), clientWindow: win(400), activeSeconds: 400 });
  const s1 = r.perSet.get('ex#1');
  assert.equal(r.perSet.get('ex#0').actual_rest_seconds, null, 'the first set has no preceding rest');
  assert.equal(s1.actual_rest_seconds, 80);          // 150 - 70
  assert.equal(s1.tick_interval_seconds, 120);
  assert.equal(s1.timing_flags, null);
  assert.equal(r.session.sets_with_actual_rest, 2);
  assert.deepEqual(r.session.flags, []);
});

test('no timestamps at all (older app, retroactive log): everything NULL, flagged, nothing guessed', () => {
  const r = analyzeSessionTiming({ sets: [{ key: 'a' }, { key: 'b' }], clientWindow: win(600), activeSeconds: 600 });
  for (const v of r.perSet.values()) {
    assert.equal(v.set_completed_at, null);
    assert.equal(v.actual_rest_seconds, null);
    assert.equal(v.tick_interval_seconds, null);
    assert.equal(v.timing_flags, 'no_completion_time');
  }
  assert.ok(r.session.flags.includes('no_set_timestamps'));
});

test('ticks without "start set" taps: tick intervals only, never a rest figure', () => {
  const r = analyzeSessionTiming({ sets: straightSets(3, { withStart: false }), clientWindow: win(400), activeSeconds: 400 });
  assert.equal(r.perSet.get('ex#1').tick_interval_seconds, 120);
  assert.equal(r.perSet.get('ex#1').actual_rest_seconds, null);
  assert.equal(r.session.sets_with_start_time, 0);
});

test('partial timestamps are flagged at session level', () => {
  const sets = straightSets(3);
  delete sets[1].completed_at;
  delete sets[1].started_at;
  const r = analyzeSessionTiming({ sets, clientWindow: win(400), activeSeconds: 400 });
  assert.ok(r.session.flags.includes('partial_set_timestamps'));
  // set 2's rest is measured from set 0's completion, the last one recorded
  assert.equal(r.perSet.get('ex#2').actual_rest_seconds, 270 - 70);
});

test('interrupted session: paused time is removed from rest and tick intervals', () => {
  const pauses = [{ started_at: at(80), ended_at: at(140) }]; // 60 s pause inside the rest before set 1
  const r = analyzeSessionTiming({ sets: straightSets(2), pauses, clientWindow: win(300), activeSeconds: 240 });
  const s1 = r.perSet.get('ex#1');
  assert.equal(s1.actual_rest_seconds, 20);        // 80 s gap - 60 s pause
  assert.equal(s1.tick_interval_seconds, 60);      // 120 s - 60 s pause
  assert.match(s1.timing_flags, /interval_excludes_pause/);
  assert.ok(r.session.flags.includes('interrupted'));
  assert.equal(r.session.paused_seconds, 60);
});

test('an unfinished pause is closed at the end of the window; a malformed one is dropped and flagged', () => {
  const r = analyzeSessionTiming({
    sets: straightSets(1), clientWindow: win(300), activeSeconds: 100,
    pauses: [{ started_at: at(200) }, { started_at: 'not a time' }],
  });
  assert.equal(r.session.paused_seconds, 100);
  assert.ok(r.session.flags.includes('pause_invalid'));
});

test('a long interruption: rest beyond 30 min is not reported as rest; a long pause is flagged', () => {
  const sets = [{ key: 'a', started_at: at(0), completed_at: at(40) }, { key: 'b', started_at: at(40 + 45 * 60), completed_at: at(80 + 45 * 60) }];
  const r = analyzeSessionTiming({ sets, clientWindow: win(100 + 45 * 60), activeSeconds: 100 + 45 * 60 });
  assert.equal(r.perSet.get('b').actual_rest_seconds, null);
  assert.match(r.perSet.get('b').timing_flags, /rest_exceeds_limit/);
  const p = analyzeSessionTiming({ sets, clientWindow: win(100 + 45 * 60), activeSeconds: 100,
    pauses: [{ started_at: at(60), ended_at: at(60 + 44 * 60) }] });
  assert.ok(p.session.flags.includes('long_pause'));
  assert.equal(p.perSet.get('b').actual_rest_seconds, 45 * 60 - 44 * 60, 'with the pause removed it is a normal rest again');
});

test('timer anomalies are flagged, never acted on: idle tail, idle head, impossible duration, missing duration', () => {
  const tail = analyzeSessionTiming({ sets: straightSets(2), clientWindow: win(190 + 20 * 60), activeSeconds: 190 + 20 * 60 });
  assert.ok(tail.session.flags.includes('idle_tail'), 'timer left running 20 min after the last set');
  const head = analyzeSessionTiming({
    sets: [{ key: 'a', started_at: at(25 * 60), completed_at: at(25 * 60 + 40) }], clientWindow: win(26 * 60), activeSeconds: 26 * 60,
  });
  assert.ok(head.session.flags.includes('idle_head'));
  const short = analyzeSessionTiming({ sets: straightSets(5), clientWindow: win(600), activeSeconds: 120 });
  assert.ok(short.session.flags.includes('duration_shorter_than_sets'), 'sets span ~8 min but the timer says 2');
  const zero = analyzeSessionTiming({ sets: straightSets(1), clientWindow: win(100), activeSeconds: 0 });
  assert.ok(zero.session.flags.includes('duration_missing_or_zero'));
  const huge = analyzeSessionTiming({ sets: straightSets(1), clientWindow: win(100), activeSeconds: 6 * 3600 });
  assert.ok(huge.session.flags.includes('duration_exceeds_limit'));
});

test('bad set timestamps are dropped with a reason, never repaired', () => {
  const sets = [
    { key: 'ok', started_at: at(0), completed_at: at(40) },
    { key: 'backwards', started_at: at(200), completed_at: at(150) },
    { key: 'long', started_at: at(300), completed_at: at(300 + 11 * 60) },
    { key: 'startOnly', started_at: at(1000) },
    { key: 'garbage', completed_at: 'yesterday' },
    { key: 'overlap', started_at: at(20), completed_at: at(60) },
  ];
  const r = analyzeSessionTiming({ sets, clientWindow: win(2000), activeSeconds: 2000 });
  assert.match(r.perSet.get('backwards').timing_flags, /started_after_completed/);
  assert.equal(r.perSet.get('backwards').set_started_at, null);
  assert.match(r.perSet.get('long').timing_flags, /set_too_long/);
  assert.match(r.perSet.get('startOnly').timing_flags, /start_without_completion/);
  assert.match(r.perSet.get('garbage').timing_flags, /completed_at_invalid/);
  assert.match(r.perSet.get('overlap').timing_flags, /overlaps_previous_set/);
  assert.equal(r.perSet.get('overlap').actual_rest_seconds, null);
});

test('phone clock off from the server: consistent with its own window, so kept', () => {
  const skew = 2 * 3600; // phone two hours ahead
  const sets = [{ key: 'a', started_at: at(skew), completed_at: at(skew + 40) }, { key: 'b', started_at: at(skew + 120), completed_at: at(skew + 160) }];
  const ok = analyzeSessionTiming({ sets, clientWindow: { started_at: at(skew - 10), finished_at: at(skew + 200) },
    serverWindow: { started_at: at(-10), completed_at: at(200) }, activeSeconds: 210 });
  assert.equal(ok.perSet.get('b').actual_rest_seconds, 80);
  assert.equal(ok.session.clock, 'client_window');
  // Without the phone's own window, the same timestamps fall outside the server's and are dropped.
  const noWindow = analyzeSessionTiming({ sets, serverWindow: { started_at: at(-10), completed_at: at(200) }, activeSeconds: 210 });
  assert.ok(noWindow.session.flags.includes('client_window_missing'));
  assert.match(noWindow.perSet.get('a').timing_flags, /completed_outside_session/);
  assert.equal(noWindow.perSet.get('b').actual_rest_seconds, null);
});

test('supersets: rest is measured from whichever set finished last, across exercises', () => {
  const sets = [
    { key: 'A#0', started_at: at(0), completed_at: at(30) },
    { key: 'B#0', started_at: at(45), completed_at: at(75) },
    { key: 'A#1', started_at: at(150), completed_at: at(180) },
  ];
  const r = analyzeSessionTiming({ sets, clientWindow: win(200), activeSeconds: 200 });
  assert.equal(r.perSet.get('B#0').actual_rest_seconds, 15);
  assert.equal(r.perSet.get('A#1').actual_rest_seconds, 75);
});

test('pausedOverlapMs', () => {
  const p = [{ start: 10, end: 20 }, { start: 30, end: 40 }];
  assert.equal(pausedOverlapMs(0, 100, p), 20);
  assert.equal(pausedOverlapMs(15, 35, p), 10);
  assert.equal(pausedOverlapMs(50, 60, p), 0);
});
