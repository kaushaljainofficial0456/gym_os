/**
 * RESUMING A SESSION MUST NOT DELETE SETS THE USER ADDED.
 *
 * Sets added mid-workout with "+ Add Set" are saved into the draft like
 * every other tick. The resume path used to rebuild the checklist from
 * the PLAN's set count and overlay the draft onto it, so anything past
 * the prescription was dropped: a fourth and fifth set became three
 * again, taking the logged reps and weight with them. It only showed up
 * after a refresh, a phone lock, or switching tabs and back.
 */
import { describe, it, expect } from 'vitest';
import { mergeDraftSets } from '../src/pages/client/Workout.jsx';

const plan = (n, reps = 10, weight = 40) => Array.from({ length: n }, () => ({ reps, weight, done: false }));

describe('mergeDraftSets', () => {
  it('keeps sets the user added beyond the prescription', () => {
    const fresh = { ex1: plan(3) };
    const draft = { ex1: [
      { reps: 10, weight: 40, done: true },
      { reps: 10, weight: 42, done: true },
      { reps: 8, weight: 42, done: true },
      { reps: 8, weight: 45, done: true },   // added during the session
      { reps: 6, weight: 45, done: true },   // added during the session
    ] };
    const merged = mergeDraftSets(fresh, draft);
    expect(merged.ex1).toHaveLength(5);
    expect(merged.ex1[4]).toMatchObject({ reps: 6, weight: 45, done: true });
  });

  it('still grows when the PLAN gained sets while away', () => {
    const merged = mergeDraftSets({ ex1: plan(5) }, { ex1: [{ reps: 10, weight: 40, done: true }] });
    expect(merged.ex1).toHaveLength(5);
    expect(merged.ex1[0].done).toBe(true);
    expect(merged.ex1[4].done).toBe(false);
  });

  it('keeps what was ticked and typed', () => {
    const merged = mergeDraftSets({ ex1: plan(3) }, { ex1: [
      { reps: 12, weight: 47.5, done: true }, { reps: 10, weight: 47.5, done: true },
    ] });
    expect(merged.ex1[0]).toMatchObject({ reps: 12, weight: 47.5, done: true });
    expect(merged.ex1[1]).toMatchObject({ reps: 10, weight: 47.5, done: true });
    expect(merged.ex1[2].done).toBe(false);     // never reached
  });

  it('gives an added row the prescription numbers to start from', () => {
    // addSet() live copies the previous row; a restored extra row with no
    // saved values should not come back as 0 reps at 0 kg.
    const merged = mergeDraftSets({ ex1: plan(2, 8, 60) }, { ex1: [{}, {}, {}] });
    expect(merged.ex1).toHaveLength(3);
    expect(merged.ex1[2]).toMatchObject({ reps: 8, weight: 60 });
  });

  it('survives a missing, empty or corrupt draft', () => {
    expect(mergeDraftSets({ ex1: plan(3) }, null).ex1).toHaveLength(3);
    expect(mergeDraftSets({ ex1: plan(3) }, {}).ex1).toHaveLength(3);
    expect(mergeDraftSets({ ex1: plan(3) }, { ex1: 'nonsense' }).ex1).toHaveLength(3);
    expect(mergeDraftSets({}, { ex1: plan(2) })).toEqual({});
  });

  it('handles several exercises independently', () => {
    const merged = mergeDraftSets(
      { a: plan(3), b: plan(4) },
      { a: plan(6), b: plan(1) },
    );
    expect(merged.a).toHaveLength(6);
    expect(merged.b).toHaveLength(4);
  });
});
