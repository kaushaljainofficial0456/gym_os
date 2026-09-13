// ============================================================
// FRIEND COMMUNITIES — creation, membership, invitations, feed.
//   node --test backend/test/friendCommunities.test.js
//
// Consent and access are what this file guards. A friend community is
// private: nobody is added without accepting, removal sticks, a code is a
// revocable secret rather than a permanent door, and a non-member cannot
// even tell the community exists. Every one of those failures would render
// as a perfectly normal screen, which is why each has a test.
//
// Privacy of DATA (health, stats, cross-gym isolation) is the companion
// suite, friendCommunityPrivacy.test.js.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { resetRateLimits } from '../src/rateLimit.js';
import {
  startApi, makeCommunity, joinViaCode, completeSession,
  PEOPLE, cid, today, daysAgo,
} from './helpers/friendCommunityWorld.js';

test.beforeEach(() => { resetRateLimits(); });

// ---------------------------------------------------------------
// CREATING
// ---------------------------------------------------------------

test('creating a community makes you its owner, and it starts private and empty', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());

  const created = await call('POST', '/api/communities', {
    name: 'Beast Squad', description: 'Train hard. Stay consistent.', theme: 'ember', mark: '🔥',
  }, 'rahul');
  assert.equal(created.status, 201);

  const detail = await call('GET', `/api/communities/${created.json.id}`, undefined, 'rahul');
  assert.equal(detail.status, 200);
  const c = detail.json.community;
  assert.equal(c.type, 'friend');
  assert.equal(c.privacy, 'private');
  assert.equal(c.name, 'Beast Squad');
  assert.equal(c.memberCount, 1);
  assert.equal(c.you.role, 'owner');
  assert.equal(c.you.permissions.delete, true);
  // Sharing is the member's own decision, disclosed at this moment: stats on,
  // gym hidden.
  assert.equal(c.you.shareStats, true);
  assert.equal(c.you.showGym, false);

  const hub = await call('GET', '/api/communities', undefined, 'rahul');
  assert.equal(hub.json.communities.length, 1);
  assert.equal(hub.json.communities[0].memberCount, 1);
  assert.equal(hub.json.communities[0].workoutsThisWeek, 0, 'a brand-new community invents no activity');

  // The only thing in the feed is the fact it was created -- not a fake post.
  const feed = await call('GET', `/api/communities/${created.json.id}/feed`, undefined, 'rahul');
  assert.deepEqual(feed.json.events.map((e) => e.type), ['created']);
  assert.equal(feed.json.nextCursor, null);

  const rows = await db.q('SELECT type, privacy FROM communities');
  assert.deepEqual(rows.map((r) => [r.type, r.privacy]), [['friend', 'private']]);
});

test('a name has to be a name', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());

  const reject = async (name, why) => {
    const res = await call('POST', '/api/communities', { name }, 'rahul');
    assert.equal(res.status, 422, `${why}: ${JSON.stringify(res.json)}`);
  };
  await reject('', 'empty');
  await reject('   ', 'whitespace only');
  await reject('A', 'one character');
  await reject('x'.repeat(41), 'too long');
  await reject('🔥🔥', 'no letter or number');
  await reject('Beast​Squad', 'zero-width character');
  await reject('Beast‮Squad', 'bidi override');

  // Real names people actually use are fine, and whitespace is tidied rather
  // than rejected.
  const ok = await call('POST', '/api/communities', { name: '  Iron   Brothers (6 AM) 💪  ' }, 'rahul');
  assert.equal(ok.status, 201);
  const detail = await call('GET', `/api/communities/${ok.json.id}`, undefined, 'rahul');
  assert.equal(detail.json.community.name, 'Iron Brothers (6 AM) 💪');

  const badTheme = await call('POST', '/api/communities', { name: 'Sunday Lifters', theme: 'neon-pink' }, 'rahul');
  assert.equal(badTheme.status, 422);
  const badMark = await call('POST', '/api/communities', { name: 'Sunday Lifters', mark: '<script>' }, 'rahul');
  assert.equal(badMark.status, 422);
});

test('one person cannot own two communities with the same name, but two people can', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());

  await makeCommunity(call, 'rahul', 'Morning Lifters');
  const dupe = await call('POST', '/api/communities', { name: 'morning lifters' }, 'rahul');
  assert.equal(dupe.status, 409);
  assert.equal(dupe.json.reason, 'duplicate_name');

  // Two groups of friends may well both be called Morning Lifters.
  const other = await call('POST', '/api/communities', { name: 'Morning Lifters' }, 'sambhav');
  assert.equal(other.status, 201);
});

test('there is a limit on how many communities one account can own', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());

  for (let i = 0; i < 10; i += 1) {
    const res = await call('POST', '/api/communities', { name: `Crew ${i}` }, 'rahul');
    assert.equal(res.status, 201, JSON.stringify(res.json));
  }
  const tooMany = await call('POST', '/api/communities', { name: 'Crew 11' }, 'rahul');
  assert.equal(tooMany.status, 409);
  assert.equal(tooMany.json.reason, 'owned_limit');
});

test('communities are for member accounts, and for nobody who is not signed in', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());

  // A trainer has no workouts, records or streak of their own to share.
  const staffHub = await call('GET', '/api/communities', undefined, 'coach');
  assert.equal(staffHub.status, 403);
  assert.equal(staffHub.json.reason, 'no_client_profile');
  const staffCreate = await call('POST', '/api/communities', { name: 'Coaches' }, 'coach');
  assert.equal(staffCreate.status, 403);

  assert.equal((await call('GET', '/api/communities', undefined, null)).status, 401);
  assert.equal((await call('POST', '/api/communities', { name: 'Anon Crew' }, null)).status, 401);
});

test('a non-member cannot tell a private community from one that does not exist', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');

  for (const p of ['', '/overview', '/feed', '/members', '/leaderboards', '/challenges', '/invites']) {
    const res = await call('GET', `/api/communities/${id}${p}`, undefined, 'sambhav');
    assert.equal(res.status, 404, `GET ${p} leaked existence`);
    assert.equal(res.json.reason, 'not_found');
  }
  // Same answer for an id that was never real.
  const invented = await call('GET', '/api/communities/com_doesnotexist', undefined, 'sambhav');
  assert.equal(invented.status, 404);
  assert.equal(invented.json.reason, 'not_found');

  // And no writes either.
  assert.equal((await call('POST', `/api/communities/${id}/shares`, { workout_id: 'w1' }, 'sambhav')).status, 404);
  assert.equal((await call('POST', `/api/communities/${id}/leave`, {}, 'sambhav')).status, 404);
});

// ---------------------------------------------------------------
// INVITE CODES
// ---------------------------------------------------------------

test('an invite code is shown once and never stored in a form the database can hand back', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');

  const made = await call('POST', `/api/communities/${id}/codes`, { expires_in_days: 7, max_uses: 25 }, 'rahul');
  assert.equal(made.status, 201);
  assert.match(made.json.code, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/, 'readable, unambiguous alphabet');

  const row = await db.q1('SELECT * FROM community_invites WHERE id = ?', [made.json.id]);
  const stored = JSON.stringify(row);
  const normalized = made.json.code.replace('-', '');
  assert.ok(!stored.includes(made.json.code) && !stored.includes(normalized), 'raw code must not be stored');
  assert.equal(row.code_hash.length, 64, 'stored as a keyed hash');
  assert.equal(row.use_count, 0);

  // Listing invitations never re-reveals a code either.
  const list = await call('GET', `/api/communities/${id}/invites`, undefined, 'rahul');
  assert.equal(list.status, 200);
  assert.equal(list.json.codes.length, 1);
  assert.ok(!JSON.stringify(list.json).includes(normalized), 'the list must not contain the code');
  assert.equal(list.json.codes[0].useCount, 0);
  assert.equal(list.json.codes[0].maxUses, 25);
});

test('a code brings in a friend from another gym, and someone with no gym at all', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');

  await joinViaCode(call, id, 'rahul', 'sambhav'); // Pulse Studio
  await joinViaCode(call, id, 'rahul', 'kaushal'); // Northside Barbell
  await joinViaCode(call, id, 'rahul', 'arjun');   // no gym

  const members = await call('GET', `/api/communities/${id}/members`, undefined, 'rahul');
  assert.deepEqual(members.json.members.map((m) => m.name).sort(),
    ['Arjun Sethi', 'Kaushal Rao', 'Rahul Mehta', 'Sambhav Jain']);
  assert.deepEqual(members.json.members.map((m) => m.role).sort(), ['member', 'member', 'member', 'owner']);

  // Arjun has no gym community at all, and still has this one.
  const arjunHub = await call('GET', '/api/communities', undefined, 'arjun');
  assert.equal(arjunHub.json.gym.available, false, 'an independent client has no gym community');
  assert.equal(arjunHub.json.communities.length, 1);
  assert.equal(arjunHub.json.communities[0].name, 'Beast Squad');

  // Joining is announced in the feed as the fact it is.
  const feed = await call('GET', `/api/communities/${id}/feed`, undefined, 'rahul');
  assert.equal(feed.json.events.filter((e) => e.type === 'joined').length, 3);
});

test('a code can be typed the way people actually type it', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  const made = await call('POST', `/api/communities/${id}/codes`, {}, 'rahul');
  const code = made.json.code;

  const messy = ` ${code.toLowerCase().replace('-', ' ')} `;
  const joined = await call('POST', '/api/communities/join', { code: messy }, 'sambhav');
  assert.equal(joined.status, 201, JSON.stringify(joined.json));
});

test('opening an invite twice does not burn a second seat', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  const made = await call('POST', `/api/communities/${id}/codes`, { max_uses: 5 }, 'rahul');

  assert.equal((await call('POST', '/api/communities/join', { code: made.json.code }, 'sambhav')).status, 201);
  const again = await call('POST', '/api/communities/join', { code: made.json.code }, 'sambhav');
  assert.equal(again.status, 200);
  assert.equal(again.json.already, true);

  const row = await db.q1('SELECT use_count FROM community_invites WHERE id = ?', [made.json.id]);
  assert.equal(Number(row.use_count), 1, 'the second open must not consume a use');
});

test('an expired, revoked or used-up code admits nobody', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');

  const expired = await call('POST', `/api/communities/${id}/codes`, {}, 'rahul');
  await db.run("UPDATE community_invites SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [expired.json.id]);
  const onExpired = await call('POST', '/api/communities/join', { code: expired.json.code }, 'sambhav');
  assert.equal(onExpired.status, 410);
  assert.equal(onExpired.json.reason, 'expired');

  const revoked = await call('POST', `/api/communities/${id}/codes`, {}, 'rahul');
  const revokeRes = await call('DELETE', `/api/communities/${id}/invites/${revoked.json.id}`, undefined, 'rahul');
  assert.equal(revokeRes.status, 200);
  const onRevoked = await call('POST', '/api/communities/join', { code: revoked.json.code }, 'sambhav');
  assert.equal(onRevoked.status, 410);
  assert.equal(onRevoked.json.reason, 'revoked');

  const singleUse = await call('POST', `/api/communities/${id}/codes`, { max_uses: 1 }, 'rahul');
  assert.equal((await call('POST', '/api/communities/join', { code: singleUse.json.code }, 'sambhav')).status, 201);
  const second = await call('POST', '/api/communities/join', { code: singleUse.json.code }, 'kaushal');
  assert.equal(second.status, 409);
  assert.equal(second.json.reason, 'used_up');

  const nonsense = await call('POST', '/api/communities/join', { code: 'ZZZZ-ZZZZ' }, 'priya');
  assert.equal(nonsense.status, 404);
  assert.equal(nonsense.json.reason, 'invalid');
});

test('only owners and admins hand out codes, and there is a cap on live ones', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  await joinViaCode(call, id, 'rahul', 'sambhav');

  const asMember = await call('POST', `/api/communities/${id}/codes`, {}, 'sambhav');
  assert.equal(asMember.status, 403);
  assert.equal(asMember.json.reason, 'forbidden');
  assert.equal((await call('GET', `/api/communities/${id}/invites`, undefined, 'sambhav')).status, 403);

  // One code already exists from joinViaCode; four more reach the cap.
  for (let i = 0; i < 4; i += 1) {
    assert.equal((await call('POST', `/api/communities/${id}/codes`, {}, 'rahul')).status, 201);
  }
  const overCap = await call('POST', `/api/communities/${id}/codes`, {}, 'rahul');
  assert.equal(overCap.status, 409);
  assert.equal(overCap.json.reason, 'code_limit');

  const badExpiry = await call('POST', `/api/communities/${id}/codes`, { expires_in_days: 3650 }, 'rahul');
  assert.equal(badExpiry.status, 422);
});

test('the public preview says what the invitation is to, and nothing else', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul', 'Beast Squad');
  await joinViaCode(call, id, 'rahul', 'sambhav');
  const made = await call('POST', `/api/communities/${id}/codes`, {}, 'rahul');

  // No Authorization header at all: this is the link opened on a phone that
  // is not signed in.
  const preview = await call('GET', `/api/community-invite/${made.json.code}`, undefined, null);
  assert.equal(preview.status, 200);
  assert.equal(preview.json.state, 'valid');
  assert.equal(preview.json.community.name, 'Beast Squad');
  assert.equal(preview.json.community.memberCount, 2);
  const body = JSON.stringify(preview.json);
  assert.ok(!body.includes('Rahul'), 'no member or inviter names');
  assert.ok(!body.includes(id), 'no community id before joining');

  const garbage = await call('GET', '/api/community-invite/NOPE-NOPE', undefined, null);
  assert.equal(garbage.json.state, 'invalid');
  assert.equal(garbage.json.community, undefined);

  // Signed in, the preview also says whether you are already in.
  const mine = await call('GET', `/api/communities/join/${made.json.code}`, undefined, 'sambhav');
  assert.equal(mine.json.alreadyMember, true);
  assert.equal(mine.json.communityId, id);
});

test('code guessing is rate limited', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());

  let lastStatus = 0;
  for (let i = 0; i < 11; i += 1) {
    lastStatus = (await call('POST', '/api/communities/join', { code: 'ABCD-EFGH' }, 'sambhav')).status;
  }
  assert.equal(lastStatus, 429, 'the eleventh guess in a minute is refused');
});

// ---------------------------------------------------------------
// DIRECT INVITATIONS
// ---------------------------------------------------------------

test('you can only invite people you already share something with', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');

  // Neha is in Rahul's gym community, so she is findable.
  const found = await call('GET', `/api/communities/${id}/candidates?q=neh`, undefined, 'rahul');
  assert.equal(found.status, 200);
  assert.deepEqual(found.json.people.map((p) => p.name), ['Neha Shah']);
  assert.equal(found.json.people[0].via, 'Your gym');

  // Sambhav trains at another gym and shares nothing with Rahul yet: he is
  // not in the directory at all, and cannot be invited by id either.
  const stranger = await call('GET', `/api/communities/${id}/candidates?q=sambhav`, undefined, 'rahul');
  assert.deepEqual(stranger.json.people, []);
  const byId = await call('POST', `/api/communities/${id}/invites`, { client_id: cid('sambhav') }, 'rahul');
  assert.equal(byId.status, 404, 'an id that did not come from the search is refused');
  assert.equal(byId.json.reason, 'member_not_found');

  // A one-character search returns nothing rather than everybody.
  assert.deepEqual((await call('GET', `/api/communities/${id}/candidates?q=n`, undefined, 'rahul')).json.people, []);

  // Once they train together somewhere, he becomes findable for the next one.
  await joinViaCode(call, id, 'rahul', 'sambhav');
  const second = await makeCommunity(call, 'rahul', 'Sunday Lifters');
  const now = await call('GET', `/api/communities/${second}/candidates?q=sam`, undefined, 'rahul');
  assert.deepEqual(now.json.people.map((p) => p.name), ['Sambhav Jain']);
  assert.equal(now.json.people[0].via, 'Beast Squad');
});

test('an invitation has to be accepted, and the invitee is told about it', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');

  const invited = await call('POST', `/api/communities/${id}/invites`, { client_id: cid('neha') }, 'rahul');
  assert.equal(invited.status, 201);

  // Nothing has happened to Neha's membership yet.
  const members = await call('GET', `/api/communities/${id}/members`, undefined, 'rahul');
  assert.equal(members.json.members.length, 1);

  const notif = await db.q1("SELECT * FROM notifications WHERE user_id = 'u_neha' AND type = 'community_invite'");
  assert.ok(notif, 'the invitee is notified');
  assert.match(notif.title, /Rahul Mehta invited you to Beast Squad/);
  assert.match(notif.data_json, /"link":"\/app\/client\/community\?invite=/);

  const hub = await call('GET', '/api/communities', undefined, 'neha');
  assert.equal(hub.json.invites.length, 1);
  assert.equal(hub.json.invites[0].community.name, 'Beast Squad');
  assert.equal(hub.json.invites[0].inviterName, 'Rahul Mehta');

  const accepted = await call('POST', `/api/communities/invites/${invited.json.id}/accept`, {}, 'neha');
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.communityId, id);

  const after = await call('GET', `/api/communities/${id}/members`, undefined, 'rahul');
  assert.equal(after.json.members.length, 2);
  // And the inviter learns it was accepted.
  const back = await db.q1("SELECT * FROM notifications WHERE user_id = 'u_rahul' AND type = 'community_invite_accepted'");
  assert.match(back.title, /Neha Shah joined Beast Squad/);
});

test('declining leaves no membership, and says nothing to the inviter', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  const invited = await call('POST', `/api/communities/${id}/invites`, { client_id: cid('neha') }, 'rahul');

  const declined = await call('POST', `/api/communities/invites/${invited.json.id}/decline`, {}, 'neha');
  assert.equal(declined.status, 200);
  assert.equal((await call('GET', `/api/communities/${id}`, undefined, 'neha')).status, 404);

  // A private no stays private: no "Neha declined" notification exists.
  const told = await db.q("SELECT * FROM notifications WHERE user_id = 'u_rahul'");
  assert.deepEqual(told.filter((n) => /declin/i.test(n.title || '')), []);

  // And it cannot then be accepted.
  const late = await call('POST', `/api/communities/invites/${invited.json.id}/accept`, {}, 'neha');
  assert.equal(late.status, 409);
});

test('an invitation belongs to one person, does not stack, and expires', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  const invited = await call('POST', `/api/communities/${id}/invites`, { client_id: cid('neha') }, 'rahul');

  // Somebody else's invitation is "not found", never "forbidden" -- the
  // difference would confirm it exists.
  const notYours = await call('POST', `/api/communities/invites/${invited.json.id}/accept`, {}, 'priya');
  assert.equal(notYours.status, 404);

  const duplicate = await call('POST', `/api/communities/${id}/invites`, { client_id: cid('neha') }, 'rahul');
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.reason, 'already_invited');

  const self = await call('POST', `/api/communities/${id}/invites`, { client_id: cid('rahul') }, 'rahul');
  assert.equal(self.status, 422);

  await db.run("UPDATE community_invites SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [invited.json.id]);
  const stale = await call('POST', `/api/communities/invites/${invited.json.id}/accept`, {}, 'neha');
  assert.equal(stale.status, 410);
  assert.equal(stale.json.reason, 'expired');
  // An expired invitation is swept, so a fresh one can be sent.
  const fresh = await call('POST', `/api/communities/${id}/invites`, { client_id: cid('neha') }, 'rahul');
  assert.equal(fresh.status, 201);

  // Already a member? Say so plainly instead of sending a second invitation.
  await call('POST', `/api/communities/invites/${fresh.json.id}/accept`, {}, 'neha');
  const again = await call('POST', `/api/communities/${id}/invites`, { client_id: cid('neha') }, 'rahul');
  assert.equal(again.status, 409);
  assert.equal(again.json.reason, 'already_member');
});

// ---------------------------------------------------------------
// ROLES
// ---------------------------------------------------------------

test('a member can take part but cannot manage', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  await joinViaCode(call, id, 'rahul', 'sambhav');
  await joinViaCode(call, id, 'rahul', 'kaushal');

  const refused = [
    ['PATCH', `/api/communities/${id}`, { name: 'Hijacked' }],
    ['DELETE', `/api/communities/${id}`, { confirm_name: 'Beast Squad' }],
    ['POST', `/api/communities/${id}/invites`, { client_id: cid('priya') }],
    ['POST', `/api/communities/${id}/codes`, {}],
    ['DELETE', `/api/communities/${id}/members/${cid('kaushal')}`, undefined],
    ['PATCH', `/api/communities/${id}/members/${cid('kaushal')}`, { role: 'admin' }],
    ['POST', `/api/communities/${id}/transfer`, { client_id: cid('sambhav') }],
    ['POST', `/api/communities/${id}/challenges`, {
      name: 'Sneaky', metric: 'workouts', goal: 5, start_date: today(), end_date: today(),
    }],
  ];
  for (const [method, p, body] of refused) {
    const res = await call(method, p, body, 'sambhav');
    assert.equal(res.status, 403, `${method} ${p} should be refused for a member`);
  }

  // The community is unchanged.
  const detail = await call('GET', `/api/communities/${id}`, undefined, 'rahul');
  assert.equal(detail.json.community.name, 'Beast Squad');
  assert.equal(detail.json.community.you.permissions.invite, true);

  // A member's own settings are theirs to change.
  const mine = await call('PATCH', `/api/communities/${id}/me`, { muted: true, show_gym: true }, 'sambhav');
  assert.equal(mine.status, 200);
  assert.equal(mine.json.you.muted, true);
  assert.equal(mine.json.you.showGym, true);
});

test('an admin helps run the community without being able to take it over', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  await joinViaCode(call, id, 'rahul', 'sambhav');
  await joinViaCode(call, id, 'rahul', 'kaushal');
  await joinViaCode(call, id, 'rahul', 'priya');

  const promoted = await call('PATCH', `/api/communities/${id}/members/${cid('sambhav')}`, { role: 'admin' }, 'rahul');
  assert.equal(promoted.status, 200);
  const alsoAdmin = await call('PATCH', `/api/communities/${id}/members/${cid('kaushal')}`, { role: 'admin' }, 'rahul');
  assert.equal(alsoAdmin.status, 200);

  // Admins can invite and moderate members...
  assert.equal((await call('POST', `/api/communities/${id}/codes`, {}, 'sambhav')).status, 201);
  assert.equal((await call('DELETE', `/api/communities/${id}/members/${cid('priya')}`, undefined, 'sambhav')).status, 200);

  // ...but not remove a peer or the owner, and not edit or delete.
  const peer = await call('DELETE', `/api/communities/${id}/members/${cid('kaushal')}`, undefined, 'sambhav');
  assert.equal(peer.status, 403);
  const owner = await call('DELETE', `/api/communities/${id}/members/${cid('rahul')}`, undefined, 'sambhav');
  assert.equal(owner.status, 403);
  assert.equal((await call('PATCH', `/api/communities/${id}`, { name: 'Mine Now' }, 'sambhav')).status, 403);
  assert.equal((await call('POST', `/api/communities/${id}/transfer`, { client_id: cid('sambhav') }, 'sambhav')).status, 403);
});

test('the owner can promote, demote and hand the community over', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  await joinViaCode(call, id, 'rahul', 'sambhav');

  await call('PATCH', `/api/communities/${id}/members/${cid('sambhav')}`, { role: 'admin' }, 'rahul');
  await call('PATCH', `/api/communities/${id}/members/${cid('sambhav')}`, { role: 'member' }, 'rahul');
  const demoted = await call('GET', `/api/communities/${id}/members`, undefined, 'rahul');
  assert.equal(demoted.json.members.find((m) => m.clientId === cid('sambhav')).role, 'member');

  const handover = await call('POST', `/api/communities/${id}/transfer`, { client_id: cid('sambhav') }, 'rahul');
  assert.equal(handover.status, 200);

  // Exactly one owner, and it is the right one.
  const after = await call('GET', `/api/communities/${id}/members`, undefined, 'rahul');
  const roles = Object.fromEntries(after.json.members.map((m) => [m.clientId, m.role]));
  assert.equal(roles[cid('sambhav')], 'owner');
  assert.equal(roles[cid('rahul')], 'admin');
  assert.equal((await call('PATCH', `/api/communities/${id}`, { name: 'Beast Squad 2' }, 'sambhav')).status, 200);
  assert.equal((await call('PATCH', `/api/communities/${id}`, { name: 'No' }, 'rahul')).status, 403);
});

// ---------------------------------------------------------------
// LEAVING, REMOVING, DELETING
// ---------------------------------------------------------------

test('an owner cannot walk away from a community other people are in', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  await joinViaCode(call, id, 'rahul', 'sambhav');

  const refused = await call('POST', `/api/communities/${id}/leave`, {}, 'rahul');
  assert.equal(refused.status, 409);
  assert.equal(refused.json.reason, 'transfer_required');

  // Alone, leaving and deleting are the same act.
  const solo = await makeCommunity(call, 'neha', 'Solo Crew');
  const left = await call('POST', `/api/communities/${solo}/leave`, {}, 'neha');
  assert.equal(left.status, 200);
  assert.equal(left.json.deleted, true);
  assert.equal((await call('GET', `/api/communities/${solo}`, undefined, 'neha')).status, 404);
});

test('leaving takes your posts out of the community but not your training history', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  await joinViaCode(call, id, 'rahul', 'sambhav');
  const workoutId = await completeSession(db, 'sambhav', { date: today() });
  await call('POST', `/api/communities/${id}/shares`, { workout_id: workoutId, include_prs: true }, 'sambhav');

  const before = await call('GET', `/api/communities/${id}/feed`, undefined, 'rahul');
  assert.ok(before.json.events.some((e) => e.type === 'workout'));

  const left = await call('POST', `/api/communities/${id}/leave`, {}, 'sambhav');
  assert.equal(left.status, 200);

  const after = await call('GET', `/api/communities/${id}/feed`, undefined, 'rahul');
  assert.deepEqual(after.json.events.filter((e) => e.clientId === cid('sambhav')), []);
  assert.equal((await call('GET', `/api/communities/${id}`, undefined, 'sambhav')).status, 404);

  // The workout and its records are HIS, and are untouched.
  assert.ok(await db.q1('SELECT id FROM workouts WHERE id = ?', [workoutId]));
  const prs = await db.q('SELECT id FROM personal_records WHERE client_id = ?', [cid('sambhav')]);
  assert.ok(prs.length > 0, 'personal records survive leaving a community');
});

test('removal is immediate, sticks against invite codes, and is reversible only by a new invitation', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  const code = await joinViaCode(call, id, 'rahul', 'sambhav');
  const workoutId = await completeSession(db, 'sambhav', { date: today() });
  await call('POST', `/api/communities/${id}/shares`, { workout_id: workoutId }, 'sambhav');

  const removed = await call('DELETE', `/api/communities/${id}/members/${cid('sambhav')}`, undefined, 'rahul');
  assert.equal(removed.status, 200);
  assert.equal((await call('GET', `/api/communities/${id}/overview`, undefined, 'sambhav')).status, 404);

  const feed = await call('GET', `/api/communities/${id}/feed`, undefined, 'rahul');
  assert.deepEqual(feed.json.events.filter((e) => e.clientId === cid('sambhav')), []);

  // The same code cannot undo the removal.
  const back = await call('POST', '/api/communities/join', { code }, 'sambhav');
  assert.equal(back.status, 403);
  assert.equal(back.json.reason, 'removed');

  // A deliberate new invitation from an admin can.
  const invite = await call('POST', `/api/communities/${id}/invites`, { client_id: cid('sambhav') }, 'rahul');
  assert.equal(invite.status, 201, JSON.stringify(invite.json));
  assert.equal((await call('POST', `/api/communities/invites/${invite.json.id}/accept`, {}, 'sambhav')).status, 200);
  assert.equal((await call('GET', `/api/communities/${id}`, undefined, 'sambhav')).status, 200);
});

test('deleting a community needs its name typed, and takes nothing but the community', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  await joinViaCode(call, id, 'rahul', 'sambhav');
  const workoutId = await completeSession(db, 'sambhav', { date: today() });
  await call('POST', `/api/communities/${id}/shares`, { workout_id: workoutId, include_prs: true }, 'sambhav');
  await call('POST', `/api/communities/${id}/challenges`, {
    name: 'Twenty sessions', metric: 'workouts', goal: 20, scope: 'community',
    start_date: today(), end_date: today(),
  }, 'rahul');

  const wrong = await call('DELETE', `/api/communities/${id}`, { confirm_name: 'beast squd' }, 'rahul');
  assert.equal(wrong.status, 422);
  assert.equal(wrong.json.reason, 'confirm_mismatch');

  const gone = await call('DELETE', `/api/communities/${id}`, { confirm_name: 'Beast Squad' }, 'rahul');
  assert.equal(gone.status, 200);
  assert.equal((await call('GET', `/api/communities/${id}`, undefined, 'sambhav')).status, 404);

  // Community-owned rows are gone...
  for (const table of ['communities', 'community_memberships', 'community_events', 'community_invites', 'community_group_challenges']) {
    const rows = await db.q(`SELECT * FROM ${table}`);
    assert.deepEqual(rows, [], `${table} should be empty after the community is deleted`);
  }
  // ...and everything that belongs to the PEOPLE is untouched.
  assert.ok(await db.q1('SELECT id FROM workouts WHERE id = ?', [workoutId]));
  assert.equal((await db.q('SELECT id FROM clients')).length, Object.keys(PEOPLE).length);
  assert.ok((await db.q('SELECT id FROM personal_records')).length > 0);
});

// ---------------------------------------------------------------
// SHARING AND THE FEED
// ---------------------------------------------------------------

test('sharing is explicit, idempotent, and only ever your own finished session', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  await joinViaCode(call, id, 'rahul', 'sambhav');
  const workoutId = await completeSession(db, 'sambhav', {
    date: today(), name: 'Leg Day', lifts: [{ exercise: 'ex_squat', weight: 100, reps: 5, sets: 4 }],
  });

  // Being a member publishes nothing by itself.
  const quiet = await call('GET', `/api/communities/${id}/feed`, undefined, 'rahul');
  assert.deepEqual(quiet.json.events.filter((e) => ['workout', 'pr'].includes(e.type)), []);

  const shared = await call('POST', `/api/communities/${id}/shares`, {
    workout_id: workoutId, include_workout: true, include_prs: true,
  }, 'sambhav');
  assert.equal(shared.status, 201);

  const feed = await call('GET', `/api/communities/${id}/feed`, undefined, 'rahul');
  const workoutEvent = feed.json.events.find((e) => e.type === 'workout');
  const prEvent = feed.json.events.find((e) => e.type === 'pr');
  assert.equal(workoutEvent.payload.name, 'Leg Day');
  assert.equal(workoutEvent.payload.setCount, 4);
  assert.equal(workoutEvent.payload.volume, 2000, '100 kg x 5 x 4 sets');
  assert.equal(workoutEvent.payload.durationMin, 58);
  assert.ok(prEvent.payload.records.length > 0);
  assert.equal(prEvent.payload.records[0].exercise, 'Squat');

  // Sharing the same session twice is one post, not two.
  const again = await call('POST', `/api/communities/${id}/shares`, { workout_id: workoutId }, 'sambhav');
  assert.equal(again.status, 201);
  const after = await call('GET', `/api/communities/${id}/feed`, undefined, 'rahul');
  assert.equal(after.json.events.filter((e) => e.type === 'workout').length, 1);

  // Someone else's workout, and an unfinished one, are both simply not found.
  const notMine = await call('POST', `/api/communities/${id}/shares`, { workout_id: workoutId }, 'rahul');
  assert.equal(notMine.status, 404);
  await db.run(
    "INSERT INTO workouts (id, org_id, client_id, name, scheduled_date, status, source, created_at) "
    + "VALUES ('w_open','org_b',?,'Open Session',?,'assigned','program',?)",
    [cid('sambhav'), today(), '2026-01-01T00:00:00.000Z']);
  const unfinished = await call('POST', `/api/communities/${id}/shares`, { workout_id: 'w_open' }, 'sambhav');
  assert.equal(unfinished.status, 404);
});

test('sharing records when there are none says so instead of posting an empty celebration', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  // A second, lighter session sets no new records.
  await completeSession(db, 'rahul', { date: daysAgo(2), lifts: [{ exercise: 'ex_bench', weight: 80, reps: 5, sets: 3 }] });
  const lighter = await completeSession(db, 'rahul', {
    date: today(), lifts: [{ exercise: 'ex_bench', weight: 40, reps: 5, sets: 3 }],
  });

  const prOnly = await call('POST', `/api/communities/${id}/shares`, {
    workout_id: lighter, include_workout: false, include_prs: true,
  }, 'rahul');
  assert.equal(prOnly.status, 422);
  assert.equal(prOnly.json.reason, 'no_prs');

  const nothing = await call('POST', `/api/communities/${id}/shares`, {
    workout_id: lighter, include_workout: false, include_prs: false,
  }, 'rahul');
  assert.equal(nothing.status, 422);
  assert.equal(nothing.json.reason, 'nothing_to_share');
});

test('the share picker offers every completed session, not just self-made ones', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  // A session from a coach's program -- which is most of a gym member's
  // training, and exactly what the planner's own workout list leaves out.
  const workoutId = await completeSession(db, 'rahul', { date: today(), name: 'Coach Program Day' });

  const offered = await call('GET', `/api/communities/${id}/shareable-workouts`, undefined, 'rahul');
  assert.equal(offered.status, 200);
  assert.deepEqual(offered.json.workouts.map((w) => w.name), ['Coach Program Day']);
  assert.equal(offered.json.workouts[0].exerciseCount, 1);
  assert.equal(offered.json.workouts[0].sharedHere, false);

  await call('POST', `/api/communities/${id}/shares`, { workout_id: workoutId }, 'rahul');
  const after = await call('GET', `/api/communities/${id}/shareable-workouts`, undefined, 'rahul');
  assert.equal(after.json.workouts[0].sharedHere, true, 'a session already here cannot be posted twice');

  // It is the member's OWN list, and only for a community they are in.
  assert.equal((await call('GET', `/api/communities/${id}/shareable-workouts`, undefined, 'sambhav')).status, 404);
});

test('a friend can take a shared session into their own planner', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  await joinViaCode(call, id, 'rahul', 'sambhav');
  const workoutId = await completeSession(db, 'sambhav', {
    date: today(), name: 'Leg Day', lifts: [{ exercise: 'ex_squat', weight: 100, reps: 5, sets: 4 }],
  });
  await call('POST', `/api/communities/${id}/shares`, { workout_id: workoutId }, 'sambhav');
  const feed = await call('GET', `/api/communities/${id}/feed?filter=workouts`, undefined, 'rahul');
  const eventId = feed.json.events[0].id;

  const copied = await call('POST', `/api/communities/${id}/events/${eventId}/copy`, {}, 'rahul');
  assert.equal(copied.status, 201, JSON.stringify(copied.json));
  assert.equal(copied.json.exerciseCount, 1);

  // It lands in RAHUL's own planner, in his own gym, and takes nothing from
  // Sambhav's session with it.
  const planned = await db.q1('SELECT * FROM client_workouts WHERE client_id = ?', [cid('rahul')]);
  assert.equal(planned.name, 'Leg Day');
  assert.equal(planned.org_id, PEOPLE.rahul.org, "a copy belongs to the copier's own gym");
  const exercises = await db.q('SELECT name, sets FROM client_workout_exercises WHERE workout_id = ?', [planned.id]);
  assert.deepEqual(exercises.map((e) => e.name), ['Squat']);
  assert.ok(await db.q1('SELECT id FROM workouts WHERE id = ?', [workoutId]), "the original session is untouched");

  // Somebody outside the community cannot copy out of it.
  assert.equal((await call('POST', `/api/communities/${id}/events/${eventId}/copy`, {}, 'kaushal')).status, 404);
});

test('the feed pages without repeating or skipping, even when timestamps tie', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');

  // Written straight to the table so several can share one timestamp -- the
  // exact case offset pagination gets wrong.
  const tied = '2026-02-01T10:00:00.000Z';
  for (let i = 0; i < 24; i += 1) {
    await db.run(
      'INSERT INTO community_events (id, community_id, client_id, type, dedupe_key, payload, created_at) '
      + "VALUES (?,?,?,'workout',?,?,?)",
      [`cev_${String(i).padStart(2, '0')}`, id, cid('rahul'), `workout:w${i}`,
        JSON.stringify({ name: `Session ${i}` }), i < 6 ? tied : `2026-02-0${(i % 8) + 1}T1${i % 10}:00:00.000Z`]);
  }

  const seen = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const q = `/api/communities/${id}/feed?limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await call('GET', q, undefined, 'rahul');
    assert.equal(res.status, 200);
    seen.push(...res.json.events.map((e) => e.id));
    cursor = res.json.nextCursor;
    if (!cursor) break;
  }
  assert.equal(cursor, null, 'pagination terminates');
  assert.equal(new Set(seen).size, seen.length, 'no event appears twice');
  assert.equal(seen.length, 25, 'every event is returned exactly once (24 shares + the created event)');

  const bad = await call('GET', `/api/communities/${id}/feed?cursor=not-a-cursor`, undefined, 'rahul');
  assert.equal(bad.status, 422);
  assert.equal(bad.json.reason, 'bad_cursor');
});

test('feed filters return only their own kind', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  await joinViaCode(call, id, 'rahul', 'sambhav');
  const workoutId = await completeSession(db, 'sambhav', { date: today() });
  await call('POST', `/api/communities/${id}/shares`, { workout_id: workoutId, include_prs: true }, 'sambhav');

  const workouts = await call('GET', `/api/communities/${id}/feed?filter=workouts`, undefined, 'rahul');
  assert.deepEqual([...new Set(workouts.json.events.map((e) => e.type))], ['workout']);
  const prs = await call('GET', `/api/communities/${id}/feed?filter=prs`, undefined, 'rahul');
  assert.deepEqual([...new Set(prs.json.events.map((e) => e.type))], ['pr']);
  const people = await call('GET', `/api/communities/${id}/feed?filter=members`, undefined, 'rahul');
  assert.deepEqual([...new Set(people.json.events.map((e) => e.type))].sort(), ['created', 'joined']);
});

test('a deleted workout takes its post with it, and an author can unshare', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  await joinViaCode(call, id, 'rahul', 'sambhav');

  const keep = await completeSession(db, 'sambhav', { date: today() });
  const drop = await completeSession(db, 'sambhav', { date: daysAgo(1), name: 'Pull Day' });
  await call('POST', `/api/communities/${id}/shares`, { workout_id: keep }, 'sambhav');
  const shared = await call('POST', `/api/communities/${id}/shares`, { workout_id: drop }, 'sambhav');

  // Deleting the workout itself must not leave the feed celebrating a session
  // that no longer exists.
  await db.run('DELETE FROM workouts WHERE id = ?', [drop]);
  const feed = await call('GET', `/api/communities/${id}/feed`, undefined, 'rahul');
  assert.equal(feed.json.events.filter((e) => e.type === 'workout').length, 1);

  // The author can take their own post down.
  const kept = feed.json.events.find((e) => e.type === 'workout');
  const notYours = await call('DELETE', `/api/communities/${id}/events/${kept.id}`, undefined, 'kaushal');
  assert.equal(notYours.status, 404, 'a non-member cannot touch it at all');
  const removed = await call('DELETE', `/api/communities/${id}/events/${kept.id}`, undefined, 'sambhav');
  assert.equal(removed.status, 200);
  const after = await call('GET', `/api/communities/${id}/feed`, undefined, 'rahul');
  assert.deepEqual(after.json.events.filter((e) => e.type === 'workout'), []);
  assert.ok(await db.q1('SELECT id FROM workouts WHERE id = ?', [keep]), 'unsharing never deletes the workout');
  assert.ok(shared.json.workout.id);
});

test('reactions toggle, are counted once per person, and notify the author at most once', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  await joinViaCode(call, id, 'rahul', 'sambhav');
  await joinViaCode(call, id, 'rahul', 'kaushal');
  const workoutId = await completeSession(db, 'sambhav', { date: today() });
  await call('POST', `/api/communities/${id}/shares`, { workout_id: workoutId }, 'sambhav');
  const feed = await call('GET', `/api/communities/${id}/feed?filter=workouts`, undefined, 'rahul');
  const eventId = feed.json.events[0].id;

  const react = (who, emoji) => call('POST', `/api/communities/${id}/reactions`, { event_id: eventId, emoji }, who);
  assert.equal((await react('rahul', 'fire')).json.reacted, true);
  assert.equal((await react('rahul', 'fire')).json.reacted, false, 'tapping again removes it');
  await react('rahul', 'fire');
  await react('kaushal', 'fire');
  await react('kaushal', 'clap');

  const social = await call('POST', `/api/communities/${id}/social`, { event_ids: [eventId] }, 'rahul');
  const entry = social.json.social[eventId];
  assert.equal(entry.counts.fire, 2);
  assert.equal(entry.counts.clap, 1);
  assert.equal(entry.total, 3);
  assert.deepEqual(entry.mine, ['fire']);

  const invalid = await react('rahul', 'poop');
  assert.equal(invalid.status, 422);
  const missing = await call('POST', `/api/communities/${id}/reactions`, { event_id: 'cev_nope', emoji: 'fire' }, 'rahul');
  assert.equal(missing.status, 404);

  // Three reactions from two people, one unread notification.
  const notifs = await db.q("SELECT * FROM notifications WHERE user_id = 'u_sambhav' AND type = 'community_reaction'");
  assert.equal(notifs.length, 1, 'celebration is not a notification storm');
});

test('comments belong to their authors, and admins can moderate', async (t) => {
  const { call, close, db } = await startApi();
  t.after(() => close());
  const id = await makeCommunity(call, 'rahul');
  await joinViaCode(call, id, 'rahul', 'sambhav');
  await joinViaCode(call, id, 'rahul', 'kaushal');
  const workoutId = await completeSession(db, 'sambhav', { date: today() });
  await call('POST', `/api/communities/${id}/shares`, { workout_id: workoutId }, 'sambhav');
  const feed = await call('GET', `/api/communities/${id}/feed?filter=workouts`, undefined, 'rahul');
  const eventId = feed.json.events[0].id;

  const posted = await call('POST', `/api/communities/${id}/comments`, { event_id: eventId, body: '  Strong session 💪  ' }, 'kaushal');
  assert.equal(posted.status, 201);
  const empty = await call('POST', `/api/communities/${id}/comments`, { event_id: eventId, body: '   ' }, 'kaushal');
  assert.equal(empty.status, 422);

  const list = await call('GET', `/api/communities/${id}/comments?event_id=${eventId}`, undefined, 'sambhav');
  assert.equal(list.json.comments.length, 1);
  assert.equal(list.json.comments[0].body, 'Strong session 💪');
  assert.equal(list.json.comments[0].authorName, 'Kaushal Rao');

  const told = await db.q1("SELECT * FROM notifications WHERE user_id = 'u_sambhav' AND type = 'community_comment'");
  assert.match(told.title, /Kaushal Rao commented on your workout/);

  // Another member cannot delete it; the author and an admin can.
  const notYours = await call('DELETE', `/api/communities/${id}/comments/${posted.json.id}`, undefined, 'sambhav');
  assert.equal(notYours.status, 403);
  const asAuthor = await call('DELETE', `/api/communities/${id}/comments/${posted.json.id}`, undefined, 'kaushal');
  assert.equal(asAuthor.status, 200);

  const second = await call('POST', `/api/communities/${id}/comments`, { event_id: eventId, body: 'Nice work' }, 'kaushal');
  const moderated = await call('DELETE', `/api/communities/${id}/comments/${second.json.id}`, undefined, 'rahul');
  assert.equal(moderated.status, 200, 'the owner can moderate');
});
