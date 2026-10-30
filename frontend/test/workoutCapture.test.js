import { describe, it, expect } from 'vitest';
import { startSet, toggleSetDone, setReportedRir, setPayload, beginPause, endPause, pausesPayload } from '../src/workoutCapture.js';

const T = Date.parse('2026-11-02T18:00:00Z');

describe('set capture', () => {
  it('ticking stamps the completion time; unticking clears both stamps and RIR', () => {
    const started = startSet({ reps: 10, weight: 60, done: false }, T);
    const done = toggleSetDone(started, T + 40000);
    expect(done).toMatchObject({ done: true, startedAt: T, completedAt: T + 40000 });
    const withRir = setReportedRir(done, 2);
    expect(withRir.reportedRir).toBe(2);
    const undone = toggleSetDone(withRir, T + 50000);
    expect(undone).toEqual({ reps: 10, weight: 60, done: false });
  });

  it('a ticked set cannot be "started"; RIR only applies to ticked sets and must be 0-10', () => {
    const done = toggleSetDone({ done: false }, T);
    expect(startSet(done, T + 1)).toBe(done);
    expect(setReportedRir({ done: false }, 1)).toEqual({ done: false });
    expect(setReportedRir(done, 11).reportedRir).toBeNull();
    expect(setReportedRir(done, null).reportedRir).toBeNull();
  });

  it('payload sends only what was measured -- nothing guessed or zero-filled', () => {
    expect(setPayload({ reps: '8', weight: 50, done: true }, 0)).toEqual({ set_number: 1, actual_reps: 8, actual_weight: 50 });
    const full = setPayload({ reps: 10, weight: 60, done: true, startedAt: T, completedAt: T + 40000, reportedRir: 0 }, 2);
    expect(full).toEqual({
      set_number: 3, actual_reps: 10, actual_weight: 60,
      started_at: new Date(T).toISOString(), completed_at: new Date(T + 40000).toISOString(), reported_rir: 0,
    });
    // a start after the completion (clock moved) is not sent
    expect(setPayload({ reps: 1, weight: 1, startedAt: T + 1, completedAt: T }, 0).started_at).toBeUndefined();
  });
});

describe('pause intervals', () => {
  it('records each pause, ignores a double pause, closes an open one at the end', () => {
    let p = beginPause([], T);
    p = beginPause(p, T + 5000);           // already paused
    expect(p).toEqual([{ start: T, end: null }]);
    p = endPause(p, T + 60000);
    expect(p).toEqual([{ start: T, end: T + 60000 }]);
    expect(endPause(p, T + 70000)).toBe(p); // not paused
    p = beginPause(p, T + 120000);
    expect(pausesPayload(p, T + 130000)).toEqual([
      { started_at: new Date(T).toISOString(), ended_at: new Date(T + 60000).toISOString() },
      { started_at: new Date(T + 120000).toISOString(), ended_at: new Date(T + 130000).toISOString() },
    ]);
  });
});
