// ============================================================
// FRIEND COMMUNITIES — privacy, cross-gym isolation, and the numbers.
//   node --test backend/test/friendCommunityPrivacy.test.js
//
// These are the failures that look like a working product:
//
//   HEALTH DATA   sleep, recovery, body weight, calories and nutrition
//                 exist for every person in this fixture. If any of them
//                 ever reaches a community response, the page still looks
//                 right -- it is just publishing someone's health record.
//   COUNTED ONLY  a member who stops sharing stats must leave every total,
//                 board, challenge and milestone in the same moment.
//   CROSS-GYM     four people from three gyms and no gym train together
//                 here; none of that may open a door in anyone's gym.
//   HONEST MATHS  every figure is recomputed from rows, so a rank, a
//                 streak and a challenge can never disagree with each other.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetRateLimits } from '../src/rateLimit.js';
import { periodRange } from '../src/services/community.js';
import {
  startApi, makeCommunity, joinViaCode, completeSession,
  SENTINELS, PEOPLE, cid, today, daysAgo, TZ,
} from './helpers/friendCommunityWorld.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');

test.beforeEach(() => { resetRateLimits(); });

// ---------------------------------------------------------------
// HEALTH DATA
// ---------------------------------------------------------------

// Keys no community response may ever carry. `weight` and `reps` are
// deliberately NOT here: a lifted load is the whole point of a PR card.
// What is forbidden is the health record -- what someone weighs, how they
// slept, what they ate, how recovered they are.
const FORBIDDEN_KEYS = [
  /sleep/i, /recovery/i, /hrv/i, /heart/i, /strain/i, /readiness/i,
  /kcal/i, /calorie/i, /energy/i, /protein/i, /carb/i, /nutrition/i, /water/i,
  /body_?weight/i, /current_weight/i, /target_weight/i, /start_weight/i,
  /height/i, /^age$/i, /^sex$/i, /medical/i, /injur/i, /email/i, /phone/i, /password/i,
];
const FORBIDDEN_VALUES = Object.values(SENTINELS);

function scanForHealthData(value, where, path = '$', found = []) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanForHealthData(v, where, `${path}[${i}]`, found));
  } else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.some((re) => re.test(key))) found.push(`${where} ${path}.${key} (key)`);
      scanForHealthData(v, where, `${path}.${key}`, found);
    }
  } else if (typeof value === 'number' && FORBIDDEN_VALUES.includes(value)) {
    found.push(`${where} ${path} = ${value} (health value)`);
  }
  return found;
}

test('health data never reaches a community, on any surface', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());

  const id = await makeCommunity(call, 'rahul');
  await joinViaCode(call, id, 'rahul', 'sambhav');
  await joinViaCode(call, id, 'rahul', 'arjun');
  const workoutId = await completeSession(db, 'sambhav', { date: today() });
  await call('POST', `/api/communities/${id}/shares`, { workout_id: workoutId, include_prs: true }, 'sambhav');
  await call('POST', `/api/communities/${id}/challenges`, {
    name: 'Ten sessions', metric: 'workouts', goal: 10, scope: 'community',
    start_date: today(), end_date: today(),
  }, 'rahul');
  const feed = await call('GET', `/api/communities/${id}/feed`, undefined, 'rahul');
  const eventId = feed.json.events.find((e) => e.type === 'pr').id;
  await call('POST', `/api/communities/${id}/comments`, { event_id: eventId, body: 'Huge' }, 'rahul');
  const code = await call('POST', `/api/communities/${id}/codes`, {}, 'rahul');

  const surfaces = [
    ['hub', 'GET', '/api/communities'],
    ['detail', 'GET', `/api/communities/${id}`],
    ['overview', 'GET', `/api/communities/${id}/overview`],
    ['leaderboards', 'GET', `/api/communities/${id}/leaderboards`],
    ['feed', 'GET', `/api/communities/${id}/feed`],
    ['members', 'GET', `/api/communities/${id}/members`],
    ['profile', 'GET', `/api/communities/${id}/members/${cid('sambhav')}`],
    ['challenges', 'GET', `/api/communities/${id}/challenges`],
    ['comments', 'GET', `/api/communities/${id}/comments?event_id=${eventId}`],
    ['invites', 'GET', `/api/communities/${id}/invites`],
    ['candidates', 'GET', `/api/communities/${id}/candidates?q=ne`],
    ['share-targets', 'GET', `/api/communities/share-targets?workout_id=${workoutId}`],
    ['join preview', 'GET', `/api/communities/join/${code.json.code}`],
  ];

  const leaks = [];
  for (const [label, method, url] of surfaces) {
    const who = label === 'share-targets' ? 'sambhav' : 'rahul';
    const res = await call(method, url, undefined, who);
    assert.equal(res.status, 200, `${label} -> ${JSON.stringify(res.json)}`);
    scanForHealthData(res.json, label, '$', leaks);
  }
  assert.deepEqual(leaks, [], `health data leaked: ${leaks.join(', ')}`);

  // The rows really are there to leak -- this test would pass trivially
  // against an empty database.
  const health = await db.q1('SELECT weight FROM weight_logs WHERE client_id = ?', [cid('sambhav')]);
  assert.equal(health.weight, SENTINELS.bodyWeight);
});

// ---------------------------------------------------------------
// SHARING STATS IS A CHOICE
// ---------------------------------------------------------------

test('a member who stops sharing stats leaves every total, but stays a member', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  await joinViaCode(call, id, 'rahul', 'sambhav');
  await completeSession(db, 'rahul', { date: today() });
  await completeSession(db, 'sambhav', { date: today() });
  await completeSession(db, 'sambhav', { date: today(), name: 'Evening' });

  const before = await call('GET', `/api/communities/${id}/overview?period=day`, undefined, 'rahul');
  assert.equal(before.json.pulse.members, 2);
  assert.equal(before.json.pulse.workoutsThisWeek >= 3, true);
  assert.equal(before.json.position.rank, 2, 'Rahul is behind Sambhav on workouts today');

  const off = await call('PATCH', `/api/communities/${id}/me`, { share_stats: false }, 'sambhav');
  assert.equal(off.json.you.shareStats, false);

  const after = await call('GET', `/api/communities/${id}/overview?period=day`, undefined, 'rahul');
  assert.equal(after.json.pulse.members, 1, 'the counted community is now one person');
  assert.equal(after.json.pulse.activeToday, 1);
  assert.equal(after.json.position.rank, 1);

  const boards = await call('GET', `/api/communities/${id}/leaderboards?period=day`, undefined, 'rahul');
  for (const [metric, board] of Object.entries(boards.json.leaderboards)) {
    assert.ok(!board.some((e) => e.clientId === cid('sambhav')), `${metric} still ranks a member who opted out`);
  }

  // He is still a member, listed by name and role, with no zeros standing in
  // for numbers he chose not to share.
  const members = await call('GET', `/api/communities/${id}/members`, undefined, 'rahul');
  const him = members.json.members.find((m) => m.clientId === cid('sambhav'));
  assert.equal(him.name, 'Sambhav Jain');
  assert.equal(him.sharesStats, false);
  assert.equal(him.stats, null);

  const profile = await call('GET', `/api/communities/${id}/members/${cid('sambhav')}`, undefined, 'rahul');
  assert.equal(profile.json.stats, null);
  assert.deepEqual(profile.json.milestones, []);

  // And he can turn it back on himself.
  await call('PATCH', `/api/communities/${id}/me`, { share_stats: true }, 'sambhav');
  const restored = await call('GET', `/api/communities/${id}/overview?period=day`, undefined, 'rahul');
  assert.equal(restored.json.pulse.members, 2);
});

test('the gym someone trains at is hidden until they choose to show it', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  await joinViaCode(call, id, 'rahul', 'sambhav');
  await joinViaCode(call, id, 'rahul', 'arjun');

  const hidden = await call('GET', `/api/communities/${id}/members`, undefined, 'rahul');
  assert.deepEqual(hidden.json.members.map((m) => m.gym), [null, null, null]);

  await call('PATCH', `/api/communities/${id}/me`, { show_gym: true }, 'sambhav');
  await call('PATCH', `/api/communities/${id}/me`, { show_gym: true }, 'arjun');

  const shown = await call('GET', `/api/communities/${id}/members`, undefined, 'rahul');
  const byId = Object.fromEntries(shown.json.members.map((m) => [m.clientId, m.gym]));
  assert.equal(byId[cid('sambhav')], 'Pulse Studio', 'a cross-gym member can show where they train');
  assert.equal(byId[cid('rahul')], null, 'and it stays off for everyone who did not');
  assert.equal(byId[cid('arjun')], null, 'someone with no gym has nothing to show');
});

// ---------------------------------------------------------------
// CROSS-GYM
// ---------------------------------------------------------------

test('a friend community grants nothing inside any gym', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');       // Rahul: Iron Temple
  await joinViaCode(call, id, 'rahul', 'sambhav');     // Sambhav: Pulse Studio
  await joinViaCode(call, id, 'rahul', 'kaushal');     // Kaushal: Northside
  await joinViaCode(call, id, 'rahul', 'arjun');       // Arjun: no gym

  // They see each other here.
  const members = await call('GET', `/api/communities/${id}/members`, undefined, 'sambhav');
  assert.equal(members.json.members.length, 4);

  // Joining a friend community does not opt anyone into a gym community.
  const sambhavGym = await call('GET', '/api/community/membership', undefined, 'sambhav');
  assert.equal(sambhavGym.json.membership.enabled, 0);
  assert.equal(sambhavGym.json.gym.name, 'Pulse Studio', 'his gym is still his own gym');

  // And it opens nothing in anyone else's gym: every gym surface refuses.
  for (const p of ['/feed', '/leaderboards', '/overview', '/members', '/prs']) {
    const res = await call('GET', `/api/community${p}`, undefined, 'sambhav');
    assert.equal(res.status, 403, `gym ${p} should refuse a non-member of that gym`);
  }

  // Rahul's gym community shows only his own gym's people -- never the
  // friends he trains with elsewhere.
  await completeSession(db, 'sambhav', { date: today() });
  const gymBoards = await call('GET', '/api/community/leaderboards?period=day', undefined, 'rahul');
  assert.equal(gymBoards.status, 200);
  const gymIds = Object.values(gymBoards.json.leaderboards).flat().map((e) => e.clientId);
  assert.ok(!gymIds.includes(cid('sambhav')), "another gym's member appeared on this gym's board");
  assert.ok(!gymIds.includes(cid('arjun')));
});

test('a share into a friend community never appears in a gym feed, and the reverse', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  await joinViaCode(call, id, 'rahul', 'sambhav');

  // Sambhav is in his own gym's community too.
  assert.equal((await call('PUT', '/api/community/membership', { enabled: true }, 'sambhav')).status, 200);
  assert.equal((await call('PUT', '/api/community/membership', { enabled: true }, 'priya')).status, 200);

  const friendOnly = await completeSession(db, 'sambhav', { date: today(), name: 'Friends Only' });
  const gymOnly = await completeSession(db, 'sambhav', { date: today(), name: 'Gym Only' });
  await call('POST', `/api/communities/${id}/shares`, { workout_id: friendOnly }, 'sambhav');
  await call('POST', '/api/community/shares', { workout_id: gymOnly }, 'sambhav');

  // His gym sees only what he sent to his gym.
  const gymFeed = await call('GET', '/api/community/feed', undefined, 'priya');
  assert.deepEqual(gymFeed.json.shares.map((s) => s.workoutName), ['Gym Only']);

  // The community sees only what he sent to the community.
  const friendFeed = await call('GET', `/api/communities/${id}/feed?filter=workouts`, undefined, 'rahul');
  assert.deepEqual(friendFeed.json.events.map((e) => e.payload.name), ['Friends Only']);

  // Rahul, in a different gym entirely, sees nothing of Sambhav's gym.
  const rahulGymFeed = await call('GET', '/api/community/feed', undefined, 'rahul');
  assert.deepEqual(rahulGymFeed.json.shares, []);
});

test('leaving the gym community does not touch a friend community', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  await joinViaCode(call, id, 'rahul', 'sambhav');
  await completeSession(db, 'rahul', { date: today() });

  assert.equal((await call('PUT', '/api/community/membership', { enabled: false }, 'rahul')).status, 200);

  const overview = await call('GET', `/api/communities/${id}/overview?period=day`, undefined, 'rahul');
  assert.equal(overview.status, 200);
  assert.equal(overview.json.pulse.members, 2);
  assert.equal(overview.json.position.workouts, 1, 'his own activity still counts with his friends');

  const hub = await call('GET', '/api/communities', undefined, 'rahul');
  assert.equal(hub.json.gym.available, true);
  assert.equal(hub.json.gym.joined, false, 'the gym card reflects the gym, not the friend community');
  assert.equal(hub.json.communities.length, 1);
});

// ---------------------------------------------------------------
// THE NUMBERS
// ---------------------------------------------------------------

test('an empty community reports emptiness rather than inventing activity', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');

  const overview = await call('GET', `/api/communities/${id}/overview`, undefined, 'rahul');
  const { pulse, activity, milestones, streaks, recap } = overview.json;
  assert.equal(pulse.members, 1);
  assert.equal(pulse.workoutsThisWeek, 0);
  assert.equal(pulse.prsThisWeek, 0);
  assert.equal(pulse.activeToday, 0);
  assert.equal(activity.length, 28);
  assert.deepEqual([...new Set(activity.map((d) => d.workouts))], [0], 'every day is a real zero');
  assert.deepEqual(streaks, []);
  assert.equal(overview.json.yourStreak, 0);
  assert.deepEqual(recap.mostImproved, []);
  assert.equal(milestones.workouts.value, 0);
  assert.equal(milestones.workouts.reached, null, 'no milestone is awarded for doing nothing');
  assert.equal(milestones.workouts.next, 10);

  const boards = await call('GET', `/api/communities/${id}/leaderboards`, undefined, 'rahul');
  for (const board of Object.values(boards.json.leaderboards)) assert.deepEqual(board, []);
});

test('boards rank by their own metric, exclude nothing-to-show, and tie-break the same way twice', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  await joinViaCode(call, id, 'rahul', 'sambhav');
  await joinViaCode(call, id, 'rahul', 'kaushal');
  await joinViaCode(call, id, 'rahul', 'priya'); // trains nothing today

  // Sambhav: two sessions today, heavier. Kaushal: two sessions, lighter.
  // Rahul: one session.
  await completeSession(db, 'sambhav', { date: today(), lifts: [{ exercise: 'ex_squat', weight: 100, reps: 5, sets: 4 }] });
  await completeSession(db, 'sambhav', { date: today(), name: 'PM', lifts: [{ exercise: 'ex_bench', weight: 60, reps: 5, sets: 3 }] });
  await completeSession(db, 'kaushal', { date: today(), lifts: [{ exercise: 'ex_squat', weight: 50, reps: 5, sets: 4 }] });
  await completeSession(db, 'kaushal', { date: today(), name: 'PM', lifts: [{ exercise: 'ex_bench', weight: 30, reps: 5, sets: 3 }] });
  await completeSession(db, 'rahul', { date: today(), lifts: [{ exercise: 'ex_bench', weight: 70, reps: 5, sets: 3 }] });

  const res = await call('GET', `/api/communities/${id}/leaderboards?period=day`, undefined, 'rahul');
  const { leaderboards: boards, definitions } = res.json;

  // Two people tied on two workouts: ordered by a stable key rather than by
  // whichever row the planner happened to return first.
  assert.deepEqual(boards.completedWorkouts.map((e) => [e.name, e.value]), [
    ['Kaushal Rao', 2], ['Sambhav Jain', 2], ['Rahul Mehta', 1],
  ]);
  // Two people on two workouts: ranked by client id, and the same way every
  // time -- an unstable tie-break is how a board flickers between refreshes.
  const again = await call('GET', `/api/communities/${id}/leaderboards?period=day`, undefined, 'rahul');
  assert.deepEqual(again.json.leaderboards.completedWorkouts, boards.completedWorkouts);
  assert.deepEqual(boards.completedWorkouts.map((e) => e.rank), [1, 2, 3]);

  // Active days: two sessions in one day is one day of showing up.
  assert.deepEqual(boards.activeDays.map((e) => [e.name, e.value]), [
    ['Kaushal Rao', 1], ['Rahul Mehta', 1], ['Sambhav Jain', 1],
  ]);

  // Volume: 100x5x4 + 60x5x3 = 2900 ; 50x5x4 + 30x5x3 = 1450 ; 70x5x3 = 1050
  assert.deepEqual(boards.volume.map((e) => [e.name, e.value]), [
    ['Sambhav Jain', 2900], ['Kaushal Rao', 1450], ['Rahul Mehta', 1050],
  ]);

  // Nobody appears on a board with nothing on it.
  for (const board of Object.values(boards)) {
    assert.ok(!board.some((e) => e.clientId === cid('priya')), 'a member with no activity was ranked');
  }

  // Every metric explains itself.
  assert.deepEqual(Object.keys(definitions).sort(), ['activeDays', 'completedWorkouts', 'prs', 'streak', 'volume']);
});

test('your position agrees with the board it sits above', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  await joinViaCode(call, id, 'rahul', 'sambhav');
  await joinViaCode(call, id, 'rahul', 'kaushal');
  await completeSession(db, 'sambhav', { date: today() });
  await completeSession(db, 'sambhav', { date: today(), name: 'PM' });
  await completeSession(db, 'kaushal', { date: today() });
  await completeSession(db, 'rahul', { date: today() });

  for (const person of ['rahul', 'sambhav', 'kaushal']) {
    const overview = await call('GET', `/api/communities/${id}/overview?period=day`, undefined, person);
    const boards = await call('GET', `/api/communities/${id}/leaderboards?period=day`, undefined, person);
    const onBoard = boards.json.leaderboards.completedWorkouts.find((e) => e.clientId === cid(person));
    assert.equal(overview.json.position.rank, onBoard.rank, `${person}: rank disagrees with the board`);
    assert.equal(overview.json.position.workouts, onBoard.value, `${person}: workout count disagrees`);
    assert.equal(overview.json.position.members, 3);
  }
});

test('most improved is measured against your own last week, not against the top', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  await joinViaCode(call, id, 'rahul', 'sambhav');
  await joinViaCode(call, id, 'rahul', 'kaushal');

  // Exactly seven days back is always the previous week, whatever day it is.
  const lastWeek = daysAgo(7);
  await completeSession(db, 'kaushal', { date: lastWeek });
  await completeSession(db, 'kaushal', { date: today() });
  await completeSession(db, 'kaushal', { date: today(), name: 'PM' });
  // Sambhav trains far more in total, but no more than he did last week.
  await completeSession(db, 'sambhav', { date: lastWeek });
  await completeSession(db, 'sambhav', { date: lastWeek, name: 'PM' });
  await completeSession(db, 'sambhav', { date: today() });

  const overview = await call('GET', `/api/communities/${id}/overview`, undefined, 'rahul');
  assert.deepEqual(overview.json.recap.mostImproved.map((m) => [m.name, m.delta]), [['Kaushal Rao', 1]]);
});

test('you-vs-you is your own four weeks and nobody else in it', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  await joinViaCode(call, id, 'rahul', 'sambhav');
  await completeSession(db, 'rahul', { date: today() });
  await completeSession(db, 'sambhav', { date: today() });
  await completeSession(db, 'sambhav', { date: today(), name: 'PM' });

  const mine = await call('GET', `/api/communities/${id}/overview`, undefined, 'rahul');
  assert.equal(mine.json.trend.length, 4);
  assert.equal(mine.json.trend[3].workouts, 1, "this week is only the viewer's own sessions");
  const week = periodRange('week', TZ);
  assert.equal(mine.json.trend[3].start, week.start);
});

test('milestones count what the group did together, only after each person joined', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  // Backdate the community so there is a "before you joined" window at all.
  // The owner joined when the community was founded, so backdate both -- or
  // "before you joined" would exclude the founder's own history as well.
  const founded = `${daysAgo(20)}T00:00:00.000Z`;
  await db.run('UPDATE communities SET created_at = ? WHERE id = ?', [founded, id]);
  await db.run("UPDATE community_memberships SET joined_at = ? WHERE community_id = ? AND role = 'owner'", [founded, id]);
  await joinViaCode(call, id, 'rahul', 'sambhav');

  // Sambhav trained while the community existed but before he was in it...
  await completeSession(db, 'sambhav', { date: daysAgo(10) });
  await completeSession(db, 'sambhav', { date: daysAgo(9) });
  // ...and once since joining.
  await completeSession(db, 'sambhav', { date: today() });
  await completeSession(db, 'rahul', { date: daysAgo(5) });

  const overview = await call('GET', `/api/communities/${id}/overview`, undefined, 'rahul');
  assert.equal(overview.json.milestones.workouts.value, 2,
    'only sessions from after each member joined count as done together');
  assert.equal(overview.json.milestones.workouts.reached, null);
  assert.equal(overview.json.milestones.workouts.next, 10);
  assert.equal(overview.json.milestones.workouts.toNext, 8);
});

test('a personal record carries the record it replaced, all the way to the feed', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');

  await completeSession(db, 'rahul', { date: daysAgo(3), lifts: [{ exercise: 'ex_bench', weight: 60, reps: 5, sets: 3 }] });
  const bigger = await completeSession(db, 'rahul', {
    date: today(), lifts: [{ exercise: 'ex_bench', weight: 70, reps: 5, sets: 3 }],
  });

  const heaviest = await db.q1(
    "SELECT * FROM personal_records WHERE client_id = ? AND type = 'heaviest_weight'", [cid('rahul')]);
  assert.equal(heaviest.value, 70);
  assert.equal(heaviest.previous_value, 60, 'the PR engine persists what it beat');
  assert.equal(heaviest.previous_weight, 60);
  assert.equal(heaviest.previous_reps, 5);

  await call('POST', `/api/communities/${id}/shares`, { workout_id: bigger, include_workout: false, include_prs: true }, 'rahul');
  const feed = await call('GET', `/api/communities/${id}/feed?filter=prs`, undefined, 'rahul');
  const record = feed.json.events[0].payload.records.find((r) => r.type === 'heaviest_weight');
  assert.equal(record.exercise, 'Bench Press');
  assert.equal(record.value, 70);
  assert.equal(record.previousValue, 60, '"+10 kg" is a stored fact, not a recalculation');
});

test("a member's profile shows training facts and what the viewer may actually do", async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  await joinViaCode(call, id, 'rahul', 'sambhav');
  await joinViaCode(call, id, 'rahul', 'kaushal');
  const workoutId = await completeSession(db, 'sambhav', { date: today() });
  await call('POST', `/api/communities/${id}/shares`, { workout_id: workoutId, include_prs: true }, 'sambhav');

  const asOwner = await call('GET', `/api/communities/${id}/members/${cid('sambhav')}`, undefined, 'rahul');
  assert.equal(asOwner.status, 200);
  assert.equal(asOwner.json.name, 'Sambhav Jain');
  assert.equal(asOwner.json.role, 'member');
  assert.equal(asOwner.json.stats.workoutsThisMonth >= 1, true);
  assert.equal(asOwner.json.stats.streak, 1);
  assert.equal(asOwner.json.recentShares.length, 2, 'only what he shared into THIS community');
  assert.deepEqual(asOwner.json.milestones, [{ key: 'first_pr', label: 'First personal record', kind: 'prs' }]);
  assert.deepEqual(asOwner.json.actions, { remove: true, makeAdmin: true, makeMember: false, transfer: true });

  // A fellow member may look, but not act.
  const asMember = await call('GET', `/api/communities/${id}/members/${cid('sambhav')}`, undefined, 'kaushal');
  assert.deepEqual(asMember.json.actions, { remove: false, makeAdmin: false, makeMember: false, transfer: false });

  // Somebody who is not in the community cannot look at all.
  assert.equal((await call('GET', `/api/communities/${id}/members/${cid('sambhav')}`, undefined, 'priya')).status, 404);
  // And a member who is not in this community is not a profile here.
  assert.equal((await call('GET', `/api/communities/${id}/members/${cid('priya')}`, undefined, 'rahul')).status, 404);
});

// ---------------------------------------------------------------
// CHALLENGES
// ---------------------------------------------------------------

test('challenge progress is computed from real sessions, never stored', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  await joinViaCode(call, id, 'rahul', 'sambhav');
  await joinViaCode(call, id, 'rahul', 'kaushal');

  const made = await call('POST', `/api/communities/${id}/challenges`, {
    name: 'Six sessions together', description: 'Everyone in.', metric: 'workouts', goal: 6,
    scope: 'community', start_date: today(), end_date: today(),
  }, 'rahul');
  assert.equal(made.status, 201);

  const empty = await call('GET', `/api/communities/${id}/challenges`, undefined, 'rahul');
  assert.equal(empty.json.active[0].value, 0);
  assert.equal(empty.json.active[0].percent, 0);
  assert.equal(empty.json.active[0].membersParticipating, 0);

  await completeSession(db, 'rahul', { date: today() });
  await completeSession(db, 'sambhav', { date: today() });
  await completeSession(db, 'sambhav', { date: today(), name: 'PM' });

  const live = await call('GET', `/api/communities/${id}/challenges`, undefined, 'sambhav');
  const challenge = live.json.active[0];
  assert.equal(challenge.value, 3, 'three sessions across the community');
  assert.equal(challenge.yourValue, 2);
  assert.equal(challenge.percent, 50);
  assert.equal(challenge.complete, false);
  assert.equal(challenge.membersParticipating, 2);

  // Deleting a session moves the number back down -- nothing is stored.
  const session = await db.q1("SELECT id FROM workouts WHERE client_id = ? AND name = 'PM'", [cid('sambhav')]);
  await db.run('DELETE FROM workouts WHERE id = ?', [session.id]);
  const after = await call('GET', `/api/communities/${id}/challenges`, undefined, 'sambhav');
  assert.equal(after.json.active[0].value, 2);

  const detail = await call('GET', `/api/communities/${id}/challenges/${made.json.id}`, undefined, 'rahul');
  assert.deepEqual(detail.json.standings.map((s) => [s.name, s.value, s.rank]), [
    ['Rahul Mehta', 1, 1], ['Sambhav Jain', 1, 2],
  ]);
  assert.equal(detail.json.participants, 2);
});

test('a challenge counts only current, sharing members', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  await joinViaCode(call, id, 'rahul', 'sambhav');
  await joinViaCode(call, id, 'rahul', 'kaushal');
  await call('POST', `/api/communities/${id}/challenges`, {
    name: 'Show up', metric: 'active_days', goal: 1, scope: 'community',
    start_date: today(), end_date: today(),
  }, 'rahul');
  await completeSession(db, 'sambhav', { date: today() });
  await completeSession(db, 'kaushal', { date: today() });

  const both = await call('GET', `/api/communities/${id}/challenges`, undefined, 'rahul');
  assert.equal(both.json.active[0].value, 2);

  await call('PATCH', `/api/communities/${id}/me`, { share_stats: false }, 'sambhav');
  const oneOptedOut = await call('GET', `/api/communities/${id}/challenges`, undefined, 'rahul');
  assert.equal(oneOptedOut.json.active[0].value, 1, 'opting out of stats leaves the challenge too');

  await call('POST', `/api/communities/${id}/leave`, {}, 'kaushal');
  const gone = await call('GET', `/api/communities/${id}/challenges`, undefined, 'rahul');
  assert.equal(gone.json.active[0].value, 0, 'someone who left stops counting');
  assert.equal(gone.json.active[0].membersParticipating, 0);
});

test('challenges are checkable, dated and staff-free', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  await joinViaCode(call, id, 'rahul', 'sambhav');

  const bad = async (body, why) => {
    const res = await call('POST', `/api/communities/${id}/challenges`, {
      name: 'Test', metric: 'workouts', goal: 5, start_date: today(), end_date: today(), ...body,
    }, 'rahul');
    assert.equal(res.status, 422, `${why}: ${JSON.stringify(res.json)}`);
  };
  await bad({ metric: 'vibes' }, 'a metric nothing can measure');
  await bad({ goal: 0 }, 'a goal of zero');
  await bad({ goal: 4.5 }, 'half a workout');
  await bad({ start_date: daysAgo(3) }, 'starting in the past');
  await bad({ end_date: daysAgo(1) }, 'ending before it starts');
  await bad({ end_date: dayShiftLocal(today(), 120) }, 'running for a third of a year');
  await bad({ name: 'x' }, 'a one-character name');

  // Volume takes a decimal goal; sessions do not.
  const volume = await call('POST', `/api/communities/${id}/challenges`, {
    name: 'Ten tonnes', metric: 'volume', goal: 10000.5, start_date: today(), end_date: today(),
  }, 'rahul');
  assert.equal(volume.status, 201);

  const asMember = await call('DELETE', `/api/communities/${id}/challenges/${volume.json.id}`, undefined, 'sambhav');
  assert.equal(asMember.status, 403);
  assert.equal((await call('DELETE', `/api/communities/${id}/challenges/${volume.json.id}`, undefined, 'rahul')).status, 200);
});

function dayShiftLocal(key, days) {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

test('a new challenge notifies the members who want to hear about it', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  await joinViaCode(call, id, 'rahul', 'sambhav');
  await joinViaCode(call, id, 'rahul', 'kaushal');
  await call('PATCH', `/api/communities/${id}/me`, { muted: true }, 'kaushal');

  await call('POST', `/api/communities/${id}/challenges`, {
    name: 'Twenty workouts', metric: 'workouts', goal: 20, scope: 'community',
    start_date: today(), end_date: today(),
  }, 'rahul');

  const told = await db.q("SELECT user_id FROM notifications WHERE type = 'community_challenge'");
  assert.deepEqual(told.map((n) => n.user_id), ['u_sambhav'],
    'the creator does not notify themselves, and a muted member is left alone');
});

// ---------------------------------------------------------------
// SHARE DESTINATIONS
// ---------------------------------------------------------------

test('the share picker lists every destination and preselects none', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const first = await makeCommunity(call, 'rahul', 'Beast Squad');
  const second = await makeCommunity(call, 'rahul', 'Sunday Lifters');
  const workoutId = await completeSession(db, 'rahul', { date: today() });

  const targets = await call('GET', `/api/communities/share-targets?workout_id=${workoutId}`, undefined, 'rahul');
  assert.equal(targets.status, 200);
  assert.equal(targets.json.gym.available, true);
  assert.equal(targets.json.gym.joined, true);
  assert.equal(targets.json.gym.shared, false);
  assert.deepEqual(targets.json.communities.map((c) => [c.name, c.sharedWorkout, c.sharedPrs]), [
    ['Beast Squad', false, false], ['Sunday Lifters', false, false],
  ]);
  assert.equal(targets.json.prCount > 0, true, 'it knows whether there are records to offer');

  // After sharing to one, only that one says so.
  await call('POST', `/api/communities/${first}/shares`, { workout_id: workoutId, include_prs: true }, 'rahul');
  const after = await call('GET', `/api/communities/share-targets?workout_id=${workoutId}`, undefined, 'rahul');
  assert.deepEqual(after.json.communities.map((c) => [c.name, c.sharedWorkout, c.sharedPrs]), [
    ['Beast Squad', true, true], ['Sunday Lifters', false, false],
  ]);
  assert.equal(after.json.gym.shared, false, 'sharing with friends never posts to the gym');

  // An independent client has no gym destination at all.
  await joinViaCode(call, second, 'rahul', 'arjun');
  const arjunWorkout = await completeSession(db, 'arjun', { date: today() });
  const arjunTargets = await call('GET', `/api/communities/share-targets?workout_id=${arjunWorkout}`, undefined, 'arjun');
  assert.equal(arjunTargets.json.gym.available, false);
  assert.deepEqual(arjunTargets.json.communities.map((c) => c.name), ['Sunday Lifters']);

  const notMine = await call('GET', `/api/communities/share-targets?workout_id=${workoutId}`, undefined, 'arjun');
  assert.equal(notMine.status, 404);
});

// ---------------------------------------------------------------
// SCHEMA
// ---------------------------------------------------------------

test('every table the friend-community services query is declared in schema.sql', async () => {
  const schema = fs.readFileSync(path.join(root, 'database', 'schema.sql'), 'utf8');
  const dir = path.join(root, 'backend', 'src', 'services', 'friendCommunities');
  const referenced = new Set();
  for (const file of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    // Only the SQL: every query in these services lives in a template
    // literal, while the prose around them contains the words FROM and INTO
    // too -- a scan that reads those goes looking for a table called "the".
    for (const sql of src.match(/`[^`]*`/g) || []) {
      for (const m of sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_]+)/g)) referenced.add(m[1]);
    }
  }
  const missing = [...referenced].filter((t) => !schema.includes(`CREATE TABLE IF NOT EXISTS ${t} (`));
  assert.deepEqual(missing, [], `tables absent from schema.sql: ${missing.join(', ')}`);
  assert.ok(referenced.has('community_memberships') && referenced.has('community_events'), 'sanity: the scan found tables');
});

test('the friend-community tables carry no org_id, because they span gyms', async () => {
  const schema = fs.readFileSync(path.join(root, 'database', 'schema.sql'), 'utf8');
  const tables = ['communities', 'community_memberships', 'community_invites', 'community_events',
    'community_event_reactions', 'community_event_comments', 'community_group_challenges'];
  for (const table of tables) {
    const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
    assert.ok(start > -1, `${table} missing from schema.sql`);
    const body = schema.slice(start, schema.indexOf('\n);', start));
    assert.ok(!/^\s*org_id\s/m.test(body),
      `${table} has an org_id: a cross-gym table cannot belong to one tenant (and would then need an RLS policy)`);
  }
});
