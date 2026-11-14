/**
 * SUPERSETS AND DROP SETS, as plain data.
 *
 * A superset is a run of NEIGHBOURING exercises that share a group key
 * ({ exerciseId: key }). Neighbouring is the whole rule: there is no
 * "superset object" to keep in sync with the order, so reordering can
 * never leave a superset pointing at an exercise that moved away -- after
 * any change the groups are re-read from the order, and a key that no
 * longer has a neighbour simply stops counting.
 *
 * A drop set is a set row with `drop: true`: the same exercise again,
 * straight after a set, at a lighter weight. It is logged as a set like
 * any other, because it is one.
 */

const keyIn = (groups, id) => (groups && groups[id] ? String(groups[id]) : null);

function freshKey(groups) {
  const taken = new Set(Object.values(groups || {}).map(String));
  let n = 1;
  while (taken.has(`s${n}`)) n += 1;
  return `s${n}`;
}

/** Keep only keys shared with a neighbour; a key reused by two separate
 *  runs is split so each run is its own superset. */
export function normalizeGroups(order, groups = {}) {
  const out = {};
  const used = new Set();
  const taken = new Set(Object.values(groups || {}).map(String));
  let i = 0;
  while (i < order.length) {
    const g = keyIn(groups, order[i]);
    let j = i + 1;
    if (g) while (j < order.length && keyIn(groups, order[j]) === g) j += 1;
    if (g && j - i >= 2) {
      let key = g;
      if (used.has(key)) {
        let n = 1;
        while (taken.has(`s${n}`) || used.has(`s${n}`)) n += 1;
        key = `s${n}`;
      }
      used.add(key);
      for (let k = i; k < j; k += 1) out[order[k]] = key;
    }
    i = j;
  }
  return out;
}

/** Groups as they come from the server (exercise rows with superset_group). */
export function groupsFromExercises(list) {
  const order = (list || []).map((e) => e.id);
  const raw = Object.fromEntries((list || []).filter((e) => e.superset_group).map((e) => [e.id, String(e.superset_group)]));
  return normalizeGroups(order, raw);
}

/** Is the exercise at `i` done back to back with the one after it? */
export function isLinked(order, groups, i) {
  const a = keyIn(groups, order[i]);
  return !!a && a === keyIn(groups, order[i + 1]);
}

/** Link or unlink the exercise at `i` with the next one. */
export function toggleLink(order, groups = {}, i) {
  if (i < 0 || i >= order.length - 1) return normalizeGroups(order, groups);
  const next = { ...groups };
  if (isLinked(order, groups, i)) {
    // Split the run here: everything after `i` in it becomes its own run.
    const key = keyIn(groups, order[i]);
    const split = freshKey(groups);
    for (let k = i + 1; k < order.length && keyIn(groups, order[k]) === key; k += 1) next[order[k]] = split;
  } else {
    const a = keyIn(groups, order[i]);
    const b = keyIn(groups, order[i + 1]);
    const key = a || b || freshKey(groups);
    next[order[i]] = key;
    if (b && b !== key) {
      for (let k = i + 1; k < order.length && keyIn(groups, order[k]) === b; k += 1) next[order[k]] = key;
    } else {
      next[order[i + 1]] = key;
    }
  }
  return normalizeGroups(order, next);
}

/**
 * Groups after the exercise at `from` was moved to `to` (`order` is the
 * order AFTER the move). Dropped inside another superset, it joins it;
 * still beside its own, it stays; anywhere else it leaves its superset.
 */
export function groupsAfterMove(order, groups = {}, to) {
  const id = order[to];
  const own = keyIn(groups, id);
  const prev = keyIn(groups, order[to - 1]);
  const nextK = keyIn(groups, order[to + 1]);
  const next = { ...groups };
  if (prev && prev === nextK) next[id] = prev;
  else if (own && (own === prev || own === nextK)) next[id] = own;
  else delete next[id];
  return normalizeGroups(order, next);
}

/** Where an exercise sits in its superset: 'first' | 'middle' | 'last' | null. */
export function groupPosition(order, groups, i) {
  const g = keyIn(groups, order[i]);
  if (!g) return null;
  const before = keyIn(groups, order[i - 1]) === g;
  const after = keyIn(groups, order[i + 1]) === g;
  if (before && after) return 'middle';
  if (after) return 'first';
  if (before) return 'last';
  return null;
}

/** Every exercise in the same superset as `id`, in order (just `id` if none). */
export function groupMembers(order, groups, id) {
  const g = keyIn(groups, id);
  if (!g) return [id];
  const i = order.indexOf(id);
  let a = i;
  let b = i;
  while (a > 0 && keyIn(groups, order[a - 1]) === g) a -= 1;
  while (b < order.length - 1 && keyIn(groups, order[b + 1]) === g) b += 1;
  return order.slice(a, b + 1);
}

/* ── drop sets ─────────────────────────────────────────────────────── */

/** About 20% lighter, on a plate step: 2.5 kg from 20 kg up, 0.5 below. */
export function dropWeight(kg) {
  const w = Number(kg) || 0;
  if (w <= 0) return 0;
  const step = w >= 20 ? 2.5 : 0.5;
  return Math.max(step, Math.round((w * 0.8) / step) * step);
}

/**
 * Add a drop set straight after the set just finished: after the last
 * ticked row and any drops already chained to it, or at the end when
 * nothing is ticked yet. Its starting numbers come from the row before it.
 */
export function insertDropSet(rows = []) {
  if (!rows.length) return rows;
  let at = -1;
  rows.forEach((r, i) => { if (r.done) at = i; });
  if (at < 0) at = rows.length - 1;
  while (at + 1 < rows.length && rows[at + 1].drop) at += 1;
  const base = rows[at];
  const row = { reps: base.reps, weight: dropWeight(base.weight), done: false, drop: true };
  return [...rows.slice(0, at + 1), row, ...rows.slice(at + 1)];
}

/** What each row is called: working sets count 1, 2, 3...; a drop is 'D'. */
export function setLabels(rows = []) {
  let n = 0;
  return rows.map((r) => (r.drop ? 'D' : String((n += 1))));
}

/** The note logged with an exercise, so history can say how it was done. */
export function sessionNote({ partners = [], drops = 0 }) {
  const bits = [];
  if (partners.length) bits.push(`Superset with ${partners.join(' + ')}`);
  if (drops) bits.push(`${drops} drop ${drops === 1 ? 'set' : 'sets'}`);
  return bits.join(' · ').slice(0, 200) || undefined;
}
