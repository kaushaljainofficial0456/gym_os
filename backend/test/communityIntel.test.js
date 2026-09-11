// ============================================================
// COMMUNITY 2.0 — the aggregate view of a gym.
//
// The properties pinned here are the ones whose failure is SILENT. A
// broken leaderboard is obvious the moment someone looks at it; the
// failures below all render as a perfectly plausible page:
//
//   PRIVACY        a client who never opted in must contribute to no
//                  count and appear in no list. If they leak in, the page
//                  still looks right -- it is just quietly publishing
//                  someone who never agreed to be published.
//
//   ISOLATION      one gym's numbers must never include another's. Again
//                  invisible: the totals just read high.
//
//   NO FABRICATION an empty community must return zeros and empty arrays,
//                  never sample rows. A page that invents activity to
//                  look busy is indistinguishable from a working one
//                  until someone tries to find the member it named.
//
//   DERIVED        challenge progress is COMPUTED from workouts, never
//                  stored. A stored counter looks correct on the day it
//                  is written and drifts forever after.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  communityPulse, memberPosition, activitySeries, recentPRs,
  weeklyRecap, memberDirectory, memberCount, previousRange,
  followMember, unfollowMember, followState, getPreferences, setPreferences,
} from '../src/services/communityIntel.js';
import {
  toggleReaction, reactionsFor, addComment, listComments, deleteComment,
  activeChallenges, createChallenge, targetExists, isValidReaction,
} from '../src/services/communitySocial.js';
import { periodRange, leaderboards } from '../src/services/community.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const TZ = 'Asia/Kolkata';

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  // Community sits behind a platform feature flag that scripts/init-db.js
  // seeds enabled at 100%. schema.sql alone creates the table but no rows,
  // so without this every settings lookup reports the feature OFF and the
  // aggregates return empty -- a test passing against a disabled feature
  // proves nothing. Mirrors community.test.js's own setup.
  db.exec(`INSERT INTO feature_flags (id, key, name, enabled, rollout_percentage, enabled_org_ids_json, created_at, updated_at)
           VALUES ('flag_test_community', 'community', 'Gym Community', 1, 100, '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, p = []) { const st = db.prepare(sql); return p.length ? st.all(...p) : st.all(); },
    async q1(sql, p = []) { const rows = await mk().q(sql, p); return rows[0] || null; },
    async run(sql, p = []) { const st = db.prepare(sql); const r = p.length ? st.run(...p) : st.run(); return { changes: Number(r.changes) }; },
    raw: db,
  });
  return mk();
}

const ts = '2026-01-01T00:00:00Z';
let seq = 0;
const uid = (p) => `${p}_${++seq}`;

async function makeOrg(db, orgId, name = 'Gym') {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)',
    [orgId, name, orgId, ts]);
  await db.run(
    `INSERT INTO gym_settings (org_id, community_enabled, community_leaderboard_enabled, updated_at)
     VALUES (?,1,1,?)`, [orgId, ts]);
}

/** A client, optionally opted in to the community. `joined: false` is the
 *  case most of these tests hinge on. */
async function makeMember(db, orgId, name, { joined = true } = {}) {
  const userId = uid('usr'); const clientId = uid('cli');
  await db.run(
    `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
     VALUES (?,?,?,?,'CLIENT',?,1,?)`, [userId, orgId, `${userId}@a.in`, 'x', name, ts]);
  await db.run(
    `INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?,?,?,'GENERAL',?)`,
    [clientId, userId, orgId, ts]);
  if (joined) {
    await db.run(
      'INSERT INTO community_members (client_id, org_id, enabled, updated_at) VALUES (?,?,1,?)',
      [clientId, orgId, ts]);
  }
  return { clientId, userId };
}

async function completeWorkout(db, orgId, clientId, date) {
  const wId = uid('wk');
  await db.run(
    `INSERT INTO workouts (id, client_id, org_id, name, scheduled_date, status, created_at)
     VALUES (?,?,?,?,?,'completed',?)`, [wId, clientId, orgId, 'Session', date, ts]);
  return wId;
}

async function makePR(db, clientId, exName, date, value) {
  let ex = await db.q1('SELECT id FROM exercise_library WHERE name = ?', [exName]);
  if (!ex) {
    const exId = uid('lib');
    await db.run(
      `INSERT INTO exercise_library (id, name, primary_muscle, equipment, movement, ex_type, is_global)
       VALUES (?,?,'CHEST','BARBELL','horizontal_push','compound',1)`, [exId, exName]);
    ex = { id: exId };
  }
  const prId = uid('pr');
  await db.run(
    `INSERT INTO personal_records (id, client_id, exercise_id, type, value, weight, reps, date, created_at)
     VALUES (?,?,?,'heaviest_weight',?,?,5,?,?)`,
    [prId, clientId, ex.id, value, value, date, ts]);
  return prId;
}

async function makePRTyped(db, clientId, exName, date, value, type) {
  let ex = await db.q1('SELECT id FROM exercise_library WHERE name = ?', [exName]);
  if (!ex) {
    const exId = uid('lib');
    await db.run(
      `INSERT INTO exercise_library (id, name, primary_muscle, equipment, movement, ex_type, is_global)
       VALUES (?,?,'CHEST','BARBELL','horizontal_push','compound',1)`, [exId, exName]);
    ex = { id: exId };
  }
  const prId = uid('pr');
  await db.run(
    `INSERT INTO personal_records (id, client_id, exercise_id, type, value, weight, reps, date, created_at)
     VALUES (?,?,?,?,?,?,5,?,?)`,
    [prId, clientId, ex.id, type, value, value, date, ts]);
  return prId;
}

const today = () => periodRange('day', TZ).start;

// ---------------- privacy ----------------

test('a client who has not joined contributes to nothing and appears nowhere', async () => {
  const db = await memDb();
  await makeOrg(db, 'o1');
  const joined = await makeMember(db, 'o1', 'Joined');
  const lurker = await makeMember(db, 'o1', 'Lurker', { joined: false });

  await completeWorkout(db, 'o1', joined.clientId, today());
  // The non-member trains just as hard -- and must still be invisible.
  await completeWorkout(db, 'o1', lurker.clientId, today());
  await makePR(db, lurker.clientId, 'Bench Press', today(), 100);

  const pulse = await communityPulse(db, 'o1', TZ);
  assert.equal(pulse.members, 1, 'only opted-in clients are members');
  assert.equal(pulse.activeToday, 1, "the non-member's workout is not counted");
  assert.equal(pulse.workoutsThisWeek, 1);
  assert.equal(pulse.prsThisWeek, 0, "the non-member's PR is not published");

  const dir = await memberDirectory(db, 'o1', TZ);
  assert.deepEqual(dir.map((m) => m.name), ['Joined'], 'a non-member is not discoverable');

  const prs = await recentPRs(db, 'o1');
  assert.equal(prs.length, 0, 'PR activity is members-only');
});

test('leaving the community retroactively removes you from it', async () => {
  const db = await memDb();
  await makeOrg(db, 'o1');
  const m = await makeMember(db, 'o1', 'Quitter');
  await completeWorkout(db, 'o1', m.clientId, today());
  await makePR(db, m.clientId, 'Squat', today(), 140);

  assert.equal((await communityPulse(db, 'o1', TZ)).activeToday, 1);

  // Opting out is a privacy control, not a display toggle: the history
  // stays in the member's own account but leaves the community view.
  await db.run('UPDATE community_members SET enabled = 0 WHERE client_id = ?', [m.clientId]);

  const pulse = await communityPulse(db, 'o1', TZ);
  assert.equal(pulse.members, 0);
  assert.equal(pulse.activeToday, 0);
  assert.equal(pulse.prsThisWeek, 0);
  assert.equal((await memberDirectory(db, 'o1', TZ)).length, 0);
  assert.equal((await recentPRs(db, 'o1')).length, 0);
});

test('one gym never sees another gym, even with identical activity', async () => {
  const db = await memDb();
  await makeOrg(db, 'o1', 'Gym One');
  await makeOrg(db, 'o2', 'Gym Two');
  const a = await makeMember(db, 'o1', 'Alpha');
  const b = await makeMember(db, 'o2', 'Beta');
  await completeWorkout(db, 'o1', a.clientId, today());
  await completeWorkout(db, 'o2', b.clientId, today());
  await completeWorkout(db, 'o2', b.clientId, today());

  const p1 = await communityPulse(db, 'o1', TZ);
  assert.equal(p1.members, 1);
  assert.equal(p1.workoutsThisWeek, 1, "gym two's workouts stay in gym two");
  assert.equal(await memberCount(db, 'o2'), 1);
  assert.deepEqual((await memberDirectory(db, 'o1', TZ)).map((m) => m.name), ['Alpha']);
});

// ---------------- no fabrication ----------------

test('an empty community reports emptiness rather than inventing activity', async () => {
  const db = await memDb();
  await makeOrg(db, 'o1');

  const pulse = await communityPulse(db, 'o1', TZ);
  assert.equal(pulse.members, 0);
  assert.equal(pulse.activeToday, 0);
  assert.equal(pulse.workoutsThisWeek, 0);
  assert.equal(pulse.prsThisWeek, 0);
  // Not 0 -- there is no denominator, and "0% participation" would be a
  // claim about a gym we have no members for.
  assert.equal(pulse.participation, null);

  assert.deepEqual(await recentPRs(db, 'o1'), []);
  assert.deepEqual(await memberDirectory(db, 'o1', TZ), []);
  const recap = await weeklyRecap(db, 'o1', TZ);
  assert.deepEqual(recap.mostImproved, []);
  assert.equal(recap.workouts, 0);
});

test('the activity series fills every day, so a quiet day is a real zero', async () => {
  const db = await memDb();
  await makeOrg(db, 'o1');
  const m = await makeMember(db, 'o1', 'A');
  await completeWorkout(db, 'o1', m.clientId, today());

  const series = await activitySeries(db, 'o1', TZ, 7);
  assert.equal(series.length, 7, 'a fixed-length window, not just the days with rows');
  assert.equal(series[series.length - 1].workouts, 1, 'today is last');
  assert.ok(series.slice(0, 6).every((d) => d.workouts === 0), 'untrained days are 0, not absent');
  // Ascending, unique dates -- a chart drawn from this cannot double-plot.
  const dates = series.map((d) => d.date);
  assert.deepEqual([...dates].sort(), dates);
  assert.equal(new Set(dates).size, 7);
});

// ---------------- position ----------------

test('rank agrees with the leaderboard beside it, and movement needs a prior week', async () => {
  const db = await memDb();
  await makeOrg(db, 'o1');
  const a = await makeMember(db, 'o1', 'A');
  const b = await makeMember(db, 'o1', 'B');
  const c = await makeMember(db, 'o1', 'C');
  const d = today();
  // A: 3, B: 3, C: 1  -> A and B are both #1, C is #3.
  await completeWorkout(db, 'o1', a.clientId, d);
  await completeWorkout(db, 'o1', a.clientId, d);
  await completeWorkout(db, 'o1', a.clientId, d);
  await completeWorkout(db, 'o1', b.clientId, d);
  await completeWorkout(db, 'o1', b.clientId, d);
  await completeWorkout(db, 'o1', b.clientId, d);
  await completeWorkout(db, 'o1', c.clientId, d);

  const posA = await memberPosition(db, 'o1', a.clientId, 'week', TZ);
  const posB = await memberPosition(db, 'o1', b.clientId, 'week', TZ);
  const posC = await memberPosition(db, 'o1', c.clientId, 'week', TZ);

  // "#N of M" sits directly above the board it describes, so it has to use
  // the board's own ordering -- value desc, client id as tiebreaker, every
  // member on a distinct rank (community.test.js pins that for the board).
  // Two tied members therefore take #1 and #2 in a stable order rather than
  // both reading #1 while the list beneath shows one of them at #2.
  const tied = [posA.rank, posB.rank].sort((x, y) => x - y);
  assert.deepEqual(tied, [1, 2], 'tied members occupy consecutive, distinct ranks');
  assert.equal(posC.rank, 3, 'the lower score comes after both of them');
  assert.equal(posA.members, 3);
  assert.equal(posA.workouts, 3);

  // The real guarantee: whatever rank the card shows, the board shows the
  // same one. This is the assertion that fails if either side changes its
  // ordering independently.
  const board = await leaderboards(db, 'o1', 'week', TZ);
  const rows = board.leaderboards.completedWorkouts;
  for (const [clientId, pos] of [[a.clientId, posA], [b.clientId, posB], [c.clientId, posC]]) {
    const row = rows.find((r) => r.clientId === clientId);
    assert.equal(pos.rank, row.rank, 'the position card and the leaderboard never disagree');
  }

  // Nobody trained last week, so there is no movement to claim.
  assert.equal(posA.rankDelta, null, 'no prior week means no "up N places"');
  assert.equal(posA.previousWorkouts, null);
});

test('previousRange returns the immediately preceding window of equal length', () => {
  const week = periodRange('week', TZ);
  const prev = previousRange(week, TZ);
  const gap = (Date.parse(`${week.start}T12:00:00Z`) - Date.parse(`${prev.end}T12:00:00Z`)) / 86400000;
  assert.equal(gap, 1, 'the previous week ends the day before this one starts');
  const len = (Date.parse(`${prev.end}T12:00:00Z`) - Date.parse(`${prev.start}T12:00:00Z`)) / 86400000;
  assert.equal(len, 6, 'seven inclusive days');
});

// ---------------- recap / most improved ----------------

test('most improved is measured against your own last week, not against the top member', async () => {
  const db = await memDb();
  await makeOrg(db, 'o1');
  const star = await makeMember(db, 'o1', 'Star');
  const riser = await makeMember(db, 'o1', 'Riser');
  const fresh = await makeMember(db, 'o1', 'Fresh');

  const week = periodRange('week', TZ);
  const prev = previousRange(week, TZ);

  // Star trains a lot both weeks -- consistently high, but not improving.
  for (let i = 0; i < 5; i += 1) await completeWorkout(db, 'o1', star.clientId, prev.start);
  for (let i = 0; i < 5; i += 1) await completeWorkout(db, 'o1', star.clientId, week.start);
  // Riser goes 1 -> 4.
  await completeWorkout(db, 'o1', riser.clientId, prev.start);
  for (let i = 0; i < 4; i += 1) await completeWorkout(db, 'o1', riser.clientId, week.start);
  // Fresh only exists this week: a newcomer's first workouts are not an
  // "improvement", or the category would just rank the newest joiners.
  for (let i = 0; i < 3; i += 1) await completeWorkout(db, 'o1', fresh.clientId, week.start);

  const recap = await weeklyRecap(db, 'o1', TZ);
  assert.equal(recap.mostImproved[0].name, 'Riser');
  assert.equal(recap.mostImproved[0].delta, 3);
  const named = recap.mostImproved.map((m) => m.name);
  assert.ok(!named.includes('Star'), 'staying flat at a high level is not improvement');
  assert.ok(!named.includes('Fresh'), 'a member with no previous week has nothing to improve on');
});

// ---------------- challenges ----------------

test('challenge progress is computed from real workouts, never stored', async () => {
  const db = await memDb();
  await makeOrg(db, 'o1');
  const m = await makeMember(db, 'o1', 'A');
  const week = periodRange('week', TZ);

  await createChallenge(db, {
    orgId: 'o1', name: 'Train 4 times', metric: 'workouts', goal: 4,
    scope: 'member', startDate: week.start, endDate: week.end,
  });

  let [ch] = await activeChallenges(db, { orgId: 'o1', clientId: m.clientId, today: today() });
  assert.equal(ch.yourValue, 0, 'no workouts means no progress, not a seeded head start');
  assert.equal(ch.complete, false);

  await completeWorkout(db, 'o1', m.clientId, week.start);
  await completeWorkout(db, 'o1', m.clientId, week.start);
  [ch] = await activeChallenges(db, { orgId: 'o1', clientId: m.clientId, today: today() });
  assert.equal(ch.yourValue, 2, 'progress follows the workouts table with no write of its own');
  assert.equal(ch.yourPercent, 50);

  // Deleting the workout must walk progress BACK. A stored counter would
  // still say 2 here -- this assertion is the whole reason progress is derived.
  const rows = await db.q('SELECT id FROM workouts WHERE client_id = ?', [m.clientId]);
  await db.run('DELETE FROM workouts WHERE id = ?', [rows[0].id]);
  [ch] = await activeChallenges(db, { orgId: 'o1', clientId: m.clientId, today: today() });
  assert.equal(ch.yourValue, 1, 'a deleted workout un-does its progress');
});

test('a challenge outside its window is not active, and participant counts are real', async () => {
  const db = await memDb();
  await makeOrg(db, 'o1');
  const a = await makeMember(db, 'o1', 'A');
  const b = await makeMember(db, 'o1', 'B');
  const week = periodRange('week', TZ);

  await createChallenge(db, {
    orgId: 'o1', name: 'Past', metric: 'workouts', goal: 1,
    scope: 'member', startDate: '2020-01-01', endDate: '2020-01-07',
  });
  assert.deepEqual(await activeChallenges(db, { orgId: 'o1', clientId: a.clientId, today: today() }), [],
    'a finished challenge does not linger on the page');

  await createChallenge(db, {
    orgId: 'o1', name: 'Now', metric: 'workouts', goal: 2,
    scope: 'member', startDate: week.start, endDate: week.end,
  });
  await completeWorkout(db, 'o1', a.clientId, week.start);
  await completeWorkout(db, 'o1', a.clientId, week.start);
  await completeWorkout(db, 'o1', b.clientId, week.start);

  const [ch] = await activeChallenges(db, { orgId: 'o1', clientId: a.clientId, today: today() });
  assert.equal(ch.membersParticipating, 2, 'both members have logged something');
  assert.equal(ch.membersCompleted, 1, 'only A reached the goal');
});

// ---------------- reactions & comments ----------------

test('a reaction toggles instead of stacking, however many times it is tapped', async () => {
  const db = await memDb();
  await makeOrg(db, 'o1');
  const a = await makeMember(db, 'o1', 'A');
  const prId = await makePR(db, a.clientId, 'Bench Press', today(), 100);

  const t = { orgId: 'o1', clientId: a.clientId, targetType: 'pr', targetId: prId, emoji: 'fire' };
  assert.equal((await toggleReaction(db, t)).reacted, true);
  assert.equal((await toggleReaction(db, t)).reacted, false, 'a second tap removes it');
  assert.equal((await toggleReaction(db, t)).reacted, true);

  const rows = await db.q('SELECT * FROM community_reactions WHERE target_id = ?', [prId]);
  assert.equal(rows.length, 1, 'one member, one reaction of a kind -- never a stack');

  const map = await reactionsFor(db, { orgId: 'o1', clientId: a.clientId, targets: [{ type: 'pr', id: prId }] });
  const entry = map.get(`pr:${prId}`);
  assert.equal(entry.counts.fire, 1);
  assert.equal(entry.total, 1);
  assert.deepEqual(entry.mine, ['fire'], "the viewer's own reaction comes back so the button can render active");
});

test('reactions cannot attach to another org, a non-member, or an invented id', async () => {
  const db = await memDb();
  await makeOrg(db, 'o1');
  await makeOrg(db, 'o2');
  const other = await makeMember(db, 'o2', 'Other');
  const lurker = await makeMember(db, 'o1', 'Lurker', { joined: false });

  const foreignPR = await makePR(db, other.clientId, 'Squat', today(), 150);
  const lurkerPR = await makePR(db, lurker.clientId, 'Deadlift', today(), 180);

  assert.equal(await targetExists(db, 'o1', 'pr', foreignPR), false,
    "another gym's record is not a target here -- its existence must not be confirmable");
  assert.equal(await targetExists(db, 'o1', 'pr', lurkerPR), false,
    'a non-member has no community presence to react to');
  assert.equal(await targetExists(db, 'o1', 'pr', 'pr_does_not_exist'), false);
  assert.equal(await targetExists(db, 'o2', 'pr', foreignPR), true, 'and it IS a target in its own gym');

  assert.equal(isValidReaction('fire'), true);
  assert.equal(isValidReaction('🚀'), false, 'the palette is closed, so counts never key on arbitrary text');
});

test('only the author can delete a comment', async () => {
  const db = await memDb();
  await makeOrg(db, 'o1');
  const a = await makeMember(db, 'o1', 'A');
  const b = await makeMember(db, 'o1', 'B');
  const prId = await makePR(db, a.clientId, 'Bench Press', today(), 100);

  const { id: commentId } = await addComment(db, {
    orgId: 'o1', clientId: a.clientId, targetType: 'pr', targetId: prId, body: 'Strong work',
  });

  assert.equal(await deleteComment(db, { orgId: 'o1', clientId: b.clientId, commentId }), false,
    'another member cannot delete it');
  assert.equal((await listComments(db, { orgId: 'o1', targetType: 'pr', targetId: prId })).length, 1);

  assert.equal(await deleteComment(db, { orgId: 'o1', clientId: a.clientId, commentId }), true);
  assert.equal((await listComments(db, { orgId: 'o1', targetType: 'pr', targetId: prId })).length, 0);
});

test('comments from members who left stop being shown', async () => {
  const db = await memDb();
  await makeOrg(db, 'o1');
  const a = await makeMember(db, 'o1', 'A');
  const b = await makeMember(db, 'o1', 'B');
  const prId = await makePR(db, a.clientId, 'Bench Press', today(), 100);
  await addComment(db, { orgId: 'o1', clientId: b.clientId, targetType: 'pr', targetId: prId, body: 'Nice' });

  assert.equal((await listComments(db, { orgId: 'o1', targetType: 'pr', targetId: prId })).length, 1);
  await db.run('UPDATE community_members SET enabled = 0 WHERE client_id = ?', [b.clientId]);
  assert.equal((await listComments(db, { orgId: 'o1', targetType: 'pr', targetId: prId })).length, 0,
    'leaving the community withdraws your posts from it');
});


// ---------------- PR feed: grouping, visibility, scope ----------------
//
// The failure that motivated all three: personal_records holds FOUR record
// types per exercise, so one good set writes up to four rows. Rendered one
// card per row, a single member's leg session filled the feed with eight
// cards -- and a 200-member gym would produce roughly 1,600 in a day.
// Grouping fixes the volume; visibility and scope decide whose records
// arrive at all.

test('a session that sets many records is ONE feed card, not one per record', async () => {
  const db = await memDb();
  await makeOrg(db, 'o1');
  const m = await makeMember(db, 'o1', 'Lifter');
  const d = today();

  // Exactly the shape from the report: one exercise, four record types,
  // plus a second exercise.
  for (const type of ['heaviest_weight', 'best_reps', 'est_1rm', 'best_volume']) {
    await makePRTyped(db, m.clientId, 'Leg Extension', d, 100, type);
  }
  await makePRTyped(db, m.clientId, 'Leg Press', d, 200, 'heaviest_weight');

  const feed = await recentPRs(db, 'o1', { viewerClientId: m.clientId });
  assert.equal(feed.length, 1, 'five records on one day collapse into a single card');
  assert.equal(feed[0].recordCount, 5);
  assert.equal(feed[0].exerciseCount, 2, 'four ways of measuring one lift is still one exercise');
  assert.equal(feed[0].memberName, 'Lifter');
});

test('separate days stay separate cards', async () => {
  const db = await memDb();
  await makeOrg(db, 'o1');
  const m = await makeMember(db, 'o1', 'Lifter');
  await makePRTyped(db, m.clientId, 'Bench Press', today(), 100, 'heaviest_weight');
  await makePRTyped(db, m.clientId, 'Squat', '2026-01-05', 140, 'heaviest_weight');

  const feed = await recentPRs(db, 'o1', { viewerClientId: m.clientId });
  assert.equal(feed.length, 2, 'grouping is per person PER DAY, not per person');
});

test('followers-only records reach followers and nobody else', async () => {
  const db = await memDb();
  await makeOrg(db, 'o1');
  const author = await makeMember(db, 'o1', 'Author');
  const fan = await makeMember(db, 'o1', 'Fan');
  const stranger = await makeMember(db, 'o1', 'Stranger');

  await makePRTyped(db, author.clientId, 'Bench Press', today(), 100, 'heaviest_weight');
  await setPreferences(db, author.clientId, { prVisibility: 'followers' });
  await followMember(db, { orgId: 'o1', followerId: fan.clientId, followingId: author.clientId });

  const seenByFan = await recentPRs(db, 'o1', { viewerClientId: fan.clientId });
  assert.equal(seenByFan.length, 1, 'a follower sees them');

  const seenByStranger = await recentPRs(db, 'o1', { viewerClientId: stranger.clientId });
  assert.equal(seenByStranger.length, 0, 'someone who does not follow does not');

  // The rule is enforced where the rows are read, so a restricted record
  // never travels to a client that would merely hide it.
  const seenByAuthor = await recentPRs(db, 'o1', { viewerClientId: author.clientId });
  assert.equal(seenByAuthor.length, 1, 'you always see your own');
});

test("'nobody' hides records from everyone except their owner", async () => {
  const db = await memDb();
  await makeOrg(db, 'o1');
  const author = await makeMember(db, 'o1', 'Private');
  const fan = await makeMember(db, 'o1', 'Fan');
  await makePRTyped(db, author.clientId, 'Squat', today(), 150, 'heaviest_weight');
  await setPreferences(db, author.clientId, { prVisibility: 'nobody' });
  // Following someone is not a way around their choice.
  await followMember(db, { orgId: 'o1', followerId: fan.clientId, followingId: author.clientId });

  assert.equal((await recentPRs(db, 'o1', { viewerClientId: fan.clientId })).length, 0,
    'following does not override "nobody"');
  assert.equal((await recentPRs(db, 'o1', { viewerClientId: author.clientId })).length, 1);
});

test("scope 'following' narrows the feed without changing what others share", async () => {
  const db = await memDb();
  await makeOrg(db, 'o1');
  const viewer = await makeMember(db, 'o1', 'Viewer');
  const followed = await makeMember(db, 'o1', 'Followed');
  const other = await makeMember(db, 'o1', 'Other');

  await makePRTyped(db, followed.clientId, 'Bench Press', today(), 100, 'heaviest_weight');
  await makePRTyped(db, other.clientId, 'Squat', today(), 140, 'heaviest_weight');
  await makePRTyped(db, viewer.clientId, 'Deadlift', today(), 180, 'heaviest_weight');
  await followMember(db, { orgId: 'o1', followerId: viewer.clientId, followingId: followed.clientId });

  const all = await recentPRs(db, 'o1', { viewerClientId: viewer.clientId, scope: 'all' });
  assert.equal(all.length, 3, 'everything public is available');

  const narrowed = await recentPRs(db, 'o1', { viewerClientId: viewer.clientId, scope: 'following' });
  const names = narrowed.map((g) => g.memberName).sort();
  assert.deepEqual(names, ['Followed', 'Viewer'], 'only people you follow, plus yourself');
  // Scope is the VIEWER's filter -- it must not alter what anyone shares.
  assert.equal((await recentPRs(db, 'o1', { viewerClientId: other.clientId, scope: 'all' })).length, 3);
});

test('following is idempotent, refuses self, and can be undone', async () => {
  const db = await memDb();
  await makeOrg(db, 'o1');
  const a = await makeMember(db, 'o1', 'A');
  const b = await makeMember(db, 'o1', 'B');

  await followMember(db, { orgId: 'o1', followerId: a.clientId, followingId: b.clientId });
  await followMember(db, { orgId: 'o1', followerId: a.clientId, followingId: b.clientId });
  let state = await followState(db, { orgId: 'o1', clientId: a.clientId });
  assert.equal(state.followingCount, 1, 'a second tap does not create a second edge');

  const self = await followMember(db, { orgId: 'o1', followerId: a.clientId, followingId: a.clientId });
  assert.equal(self.ok, false, 'you cannot follow yourself');

  const bState = await followState(db, { orgId: 'o1', clientId: b.clientId });
  assert.equal(bState.followerCount, 1, 'and B can see they have a follower');

  await unfollowMember(db, { followerId: a.clientId, followingId: b.clientId });
  state = await followState(db, { orgId: 'o1', clientId: a.clientId });
  assert.equal(state.followingCount, 0);
});

test('you cannot follow a non-member, or someone in another gym', async () => {
  const db = await memDb();
  await makeOrg(db, 'o1');
  await makeOrg(db, 'o2');
  const a = await makeMember(db, 'o1', 'A');
  const lurker = await makeMember(db, 'o1', 'Lurker', { joined: false });
  const foreign = await makeMember(db, 'o2', 'Foreign');

  assert.equal((await followMember(db, { orgId: 'o1', followerId: a.clientId, followingId: lurker.clientId })).ok, false);
  assert.equal((await followMember(db, { orgId: 'o1', followerId: a.clientId, followingId: foreign.clientId })).ok, false,
    "another gym's member is not followable, and the refusal does not confirm they exist");
  assert.equal((await followMember(db, { orgId: 'o1', followerId: a.clientId, followingId: 'cli_nope' })).ok, false);
});

test('preferences default to sharing, so the migration hides nobody', async () => {
  const db = await memDb();
  await makeOrg(db, 'o1');
  const m = await makeMember(db, 'o1', 'Existing');

  // makeMember inserts community_members WITHOUT naming these columns --
  // exactly what `ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT` leaves
  // on every row that existed before the migration. The defaults must
  // reproduce the behaviour those members already agreed to; defaulting
  // to 'followers' would silently un-share everyone on deploy day.
  const prefs = await getPreferences(db, m.clientId);
  assert.equal(prefs.prVisibility, 'everyone');
  assert.equal(prefs.feedScope, 'all');

  // And a client with no membership row at all still resolves rather than
  // throwing -- the feed must not 500 for someone mid-join.
  const none = await getPreferences(db, 'cli_does_not_exist');
  assert.equal(none.prVisibility, 'everyone');
  assert.equal(none.feedScope, 'all');
});

test('the database refuses a visibility value the API would never send', async () => {
  const db = await memDb();
  await makeOrg(db, 'o1');
  const m = await makeMember(db, 'o1', 'A');
  // Zod guards the route, but the CHECK constraint is the backstop: a
  // bad value reaching the column would make canSee() fall through to
  // "visible" and quietly publish someone.
  await assert.rejects(
    () => db.run("UPDATE community_members SET pr_visibility = 'public' WHERE client_id = ?", [m.clientId]),
    'an unknown visibility is rejected at the column, not silently stored');
});
