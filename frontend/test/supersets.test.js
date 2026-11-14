/**
 * Supersets are runs of neighbouring exercises sharing a key, so reordering
 * can never leave one pointing at an exercise that moved away. Drop sets
 * are lighter rows added straight after the set just finished.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeGroups, toggleLink, isLinked, groupsAfterMove, groupPosition, groupMembers,
  groupsFromExercises, dropWeight, insertDropSet, setLabels, sessionNote,
} from '../src/components/workout/supersets.js';
import { moveItem } from '../src/components/workout/useDragSort.js';

const order = ['a', 'b', 'c', 'd'];

describe('superset groups', () => {
  it('links two neighbours, then a third onto the same superset', () => {
    let g = toggleLink(order, {}, 0);
    expect(isLinked(order, g, 0)).toBe(true);
    expect(g.a).toBe(g.b);
    g = toggleLink(order, g, 1);
    expect(groupMembers(order, g, 'c')).toEqual(['a', 'b', 'c']);
    expect(groupPosition(order, g, 1)).toBe('middle');
  });

  it('unlinking splits the superset at that point', () => {
    let g = toggleLink(order, {}, 0);
    g = toggleLink(order, g, 1);
    g = toggleLink(order, g, 0);           // a | b-c
    expect(g.a).toBeUndefined();
    expect(isLinked(order, g, 1)).toBe(true);
  });

  it('a lone key does not count as a superset', () => {
    expect(normalizeGroups(order, { a: 'x', c: 'x' })).toEqual({});
  });

  it('one key used by two separate runs becomes two supersets', () => {
    const g = normalizeGroups(['a', 'b', 'c', 'd', 'e'], { a: 'x', b: 'x', d: 'x', e: 'x' });
    expect(g.a).toBe(g.b);
    expect(g.d).toBe(g.e);
    expect(g.a).not.toBe(g.d);
  });

  it('joining two supersets with a link merges them', () => {
    const g = toggleLink(order, { a: 'p', b: 'p', c: 'q', d: 'q' }, 1);
    expect(new Set(Object.values(g)).size).toBe(1);
  });

  it('moving an exercise out of its superset unlinks it; the other half stands alone', () => {
    const g0 = { a: 'p', b: 'p' };
    const moved = moveItem(order, 0, 3);    // b c d a
    const g = groupsAfterMove(moved, g0, 3);
    expect(g).toEqual({});
  });

  it('reordering inside a superset keeps it', () => {
    const g0 = { a: 'p', b: 'p' };
    const moved = moveItem(order, 0, 1);    // b a c d
    expect(groupsAfterMove(moved, g0, 1)).toEqual({ a: 'p', b: 'p' });
  });

  it('dropping an exercise into the middle of a superset makes it part of it', () => {
    const g0 = { b: 'p', c: 'p' };
    const moved = moveItem(order, 3, 2);    // a b d c
    const g = groupsAfterMove(moved, g0, 2);
    expect(groupMembers(moved, g, 'd')).toEqual(['b', 'd', 'c']);
  });

  it('reads groups off server rows', () => {
    const g = groupsFromExercises([{ id: 'a', superset_group: 'x' }, { id: 'b', superset_group: 'x' }, { id: 'c', superset_group: null }]);
    expect(g).toEqual({ a: 'x', b: 'x' });
  });
});

describe('drop sets', () => {
  it('is about 20% lighter on a plate step', () => {
    expect(dropWeight(100)).toBe(80);
    expect(dropWeight(60)).toBe(47.5);
    expect(dropWeight(12)).toBe(9.5);
    expect(dropWeight(0)).toBe(0);
  });

  it('goes straight after the last finished set, after any drops already chained to it', () => {
    const rows = [
      { reps: 10, weight: 60, done: true },
      { reps: 10, weight: 60, done: false },
    ];
    const once = insertDropSet(rows);
    expect(once[1]).toMatchObject({ drop: true, weight: 47.5, reps: 10, done: false });
    const twice = insertDropSet(once);
    expect(twice[2]).toMatchObject({ drop: true, weight: 37.5 });
    expect(twice[3]).toMatchObject({ weight: 60, done: false });
  });

  it('goes at the end when nothing is ticked yet', () => {
    const rows = [{ reps: 8, weight: 40, done: false }, { reps: 8, weight: 40, done: false }];
    expect(insertDropSet(rows)[2]).toMatchObject({ drop: true, weight: 32.5 });
  });

  it('labels working sets by number and drops as D', () => {
    expect(setLabels([{}, { drop: true }, {}, { drop: true }])).toEqual(['1', 'D', '2', 'D']);
  });

  it('writes a short note for history', () => {
    expect(sessionNote({ partners: ['Row'], drops: 2 })).toBe('Superset with Row · 2 drop sets');
    expect(sessionNote({})).toBeUndefined();
  });
});
