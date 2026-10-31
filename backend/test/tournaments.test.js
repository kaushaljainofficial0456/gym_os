// ============================================================
// TOURNAMENTS. The rules that make a competition worth entering:
//   * only hosts write scores, and a competing host cannot score themselves
//     while another host can
//   * hidden tournaments stay hidden (staff-only, gym-only, demo)
//   * deadlines and capacity hold
//   * the ranking is right, including ties
//   * the QR page gives away a scoreboard and nothing else
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeStandings, computeOverall, computeGymWar, formatScore, formatTime } from '../src/services/tournaments/scoring.js';
import { compare, linesFor, personalEvent } from '../src/services/tournaments/insights.js';
import { canSee } from '../src/services/tournaments/access.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const initDb = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'init-db.js'), 'utf8');
const ts = '2026-01-01T00:00:00Z';
const hour = 3_600_000;
const future = (h) => new Date(Date.now() + h * hour).toISOString();

async function startApi() {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(schema);
  for (const m of initDb.matchAll(/\['(users|organizations|notifications)',\s*'[a-z_]+',\s*`([^`]+)`\]/g)) {
    try { raw.exec(`ALTER TABLE ${m[1]} ADD COLUMN ${m[2]}`); } catch { /* already in schema.sql */ }
  }
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, p = []) { const st = raw.prepare(sql); return p.length ? st.all(...p) : st.all(); },
    async q1(sql, p = []) { const rows = await mk().q(sql, p); return rows[0] || null; },
    async run(sql, p = []) { const st = raw.prepare(sql); const r = p.length ? st.run(...p) : st.run(); return { changes: Number(r.changes) }; },
    async tx(fn) {
      raw.exec('BEGIN');
      try { const out = await fn(mk()); raw.exec('COMMIT'); return out; } catch (e) { try { raw.exec('ROLLBACK'); } catch {} throw e; }
    },
  });
  const db = mk();
  const express = (await import('express')).default;
  const jwt = (await import('jsonwebtoken')).default;
  const { config } = await import('../src/config.js');
  const routes = await import('../src/routes/tournaments.js');
  const { resetRateLimits } = await import('../src/rateLimit.js');
  resetRateLimits();

  for (const [o, name, type, demo] of [['gymA', 'Iron Gym', 'gym', 0], ['gymB', 'Steel Gym', 'gym', 0], ['ind', 'Independent Clients', 'independent', 0], ['demo', 'Demo Gym', 'gym', 1]]) {
    await db.run('INSERT INTO organizations (id, name, slug, type, is_demo, created_at) VALUES (?,?,?,?,?,?)', [o, name, o, type, demo, ts]);
  }
  const people = [
    ['owner', 'gymA', 'GYM_OWNER', 'Maya Owner'], ['coach', 'gymA', 'TRAINER', 'Arjun Coach'], ['ria', 'gymA', 'CLIENT', 'Ria Member'],
    ['sam', 'gymA', 'CLIENT', 'Sam Member'], ['zoe', 'gymB', 'CLIENT', 'Zoe Other'], ['ivy', 'ind', 'CLIENT', 'Ivy Solo'],
    ['dee', 'demo', 'CLIENT', 'Dee Demo'],
  ];
  for (const [u, org, role, name] of people) {
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?,?,?,'x',?,?,1,?)`, [u, org, `${u}@x.in`, role, name, ts]);
  }
  const app = express();
  app.set('db', db);
  app.use(express.json());
  app.use('/api/tournaments', routes.default(db));
  app.use('/api/tournaments-public', routes.tournamentPublicRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const roleOf = Object.fromEntries(people.map((p) => [p[0], p[2]]));
  const orgOf = Object.fromEntries(people.map((p) => [p[0], p[1]]));
  const call = async (as, method, url, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (as) headers.Authorization = `Bearer ${jwt.sign({ sub: as, role: roleOf[as], org: orgOf[as] }, config.jwtSecret)}`;
    const res = await fetch(`http://127.0.0.1:${port}/api${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, close };
}

const events = [{ kind: 'squats' }, { kind: 'plank' }];
async function make(api, as = 'owner', extra = {}) {
  const res = await api.call(as, 'POST', '/tournaments', { name: 'Gym Wars', reach: 'everyone', events, ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const t = await api.call(as, 'GET', `/tournaments/${res.json.id}`);
  return t.json;
}

// ─── ranking ─────────────────────────────────────────────────────────

const ev = (metric, extra = {}) => ({ id: 'e', metric, win_positions: 3, ...extra });
const who = (...ids) => ids.map((id) => ({ id, name: id }));
const scores = (o) => Object.entries(o).map(([subject_id, value]) => ({ subject_id, attempt: 1, value, valid: 1 }));

test('most reps wins; ties share a place and skip the next', () => {
  const rows = computeStandings(ev('reps'), who('a', 'b', 'c', 'd'), scores({ a: 50, b: 40, c: 40, d: 10 }));
  assert.deepEqual(rows.map((r) => [r.id, r.rank]), [['a', 1], ['b', 2], ['c', 2], ['d', 4]]);
});

test('fastest time wins when lower is better', () => {
  const rows = computeStandings(ev('time_low'), who('a', 'b'), scores({ a: 12.4, b: 11.9 }));
  assert.equal(rows[0].id, 'b');
  assert.equal(rows[0].rank, 1);
});

test('the best valid attempt counts; a no-rep never does', () => {
  const rows = computeStandings(ev('weight', { attempts: 3 }), who('a'), [
    { subject_id: 'a', attempt: 1, value: 100, valid: 1 },
    { subject_id: 'a', attempt: 2, value: 120, valid: 1 },
    { subject_id: 'a', attempt: 3, value: 140, valid: 0 },
  ]);
  assert.equal(rows[0].best, 120);
});

test('a tied lift goes to the lighter lifter; a tied rep count stays tied', () => {
  const lifters = [{ id: 'heavy', name: 'H', body_weight: 90 }, { id: 'light', name: 'L', body_weight: 70 }];
  const lift = computeStandings(ev('weight'), lifters, scores({ heavy: 150, light: 150 }));
  assert.deepEqual(lift.map((r) => [r.id, r.rank]), [['light', 1], ['heavy', 2]]);
  const reps = computeStandings(ev('reps'), lifters, scores({ heavy: 30, light: 30 }));
  assert.deepEqual(reps.map((r) => r.rank), [1, 1]);
});

test('no score means no place, not last place', () => {
  const rows = computeStandings(ev('reps'), who('a', 'b'), scores({ a: 5 }));
  const b = rows.find((r) => r.id === 'b');
  assert.equal(b.rank, null);
  assert.equal(b.winner, false);
  assert.equal(b.display, '—');
});

test('the host decides how many places win', () => {
  const rows = computeStandings(ev('reps', { win_positions: 1 }), who('a', 'b'), scores({ a: 9, b: 8 }));
  assert.deepEqual(rows.map((r) => r.winner), [true, false]);
});

test('overall table sums places; a team shares its place; gym war needs two gyms', () => {
  const entrants = [{ id: 'a', name: 'A', gym_label: 'Iron' }, { id: 'b', name: 'B', gym_label: 'Steel' }, { id: 'c', name: 'C', gym_label: 'Steel' }];
  const overall = computeOverall([{ id: 'e1' }, { id: 'e2' }], {
    e1: [{ id: 'a', rank: 1 }, { id: 'b', rank: 2 }],
    e2: [{ id: 'team', rank: 1, members: [{ id: 'b' }, { id: 'c' }] }],
  }, entrants);
  assert.deepEqual(overall.map((o) => [o.id, o.points, o.rank]), [['b', 17, 1], ['a', 10, 2], ['c', 10, 2]]);
  assert.deepEqual(computeGymWar(overall).map((g) => [g.gym, g.points]), [['Steel', 27], ['Iron', 10]]);
  assert.deepEqual(computeGymWar([overall[0]]), []);
});

test('scores read like scores', () => {
  assert.equal(formatTime(75.5), '1:15.5');
  assert.equal(formatScore('time_high', 3725), '1:02:05');
  assert.equal(formatScore('reps', 1), '1 rep');
  assert.equal(formatScore('wins', 2), '2 wins');
  assert.equal(formatScore('distance', 1500), '1.5 km');
});

test('comparisons are to real things, and lines are stable', () => {
  const lift = compare({ metric: 'weight', kind: 'deadlift' }, 200);
  assert.match(lift[0].text, /You lifted 1 Royal Enfield/);
  const climbs = compare({ metric: 'reps', kind: 'pull_ups' }, 130, { bodyWeight: 80, group: true });
  assert.ok(climbs.some((c) => /Together climbed 1\.1 Qutub Minars/.test(c.text)), JSON.stringify(climbs));
  assert.deepEqual(linesFor(1, 8, 'seed'), linesFor(1, 8, 'seed'));
  assert.equal(linesFor(8, 8, 's').tier, 'last');
  assert.equal(linesFor(null, 8, 's').tier, 'none');
});

test('a comparison too small to picture is not made', () => {
  const short = compare({ metric: 'time_high', kind: 'plank' }, 4.6);
  assert.equal(short.length, 1);
  assert.ok(!/\b0 /.test(short[0].text), short[0].text);
  assert.match(compare({ metric: 'time_high', kind: 'plank' }, 400)[0].text, /held on for 1\.3 chai breaks/);
  assert.deepEqual(compare({ metric: 'distance' }, 0.5), []);
});

test('a personal report says what the next place would take', () => {
  const event = ev('reps', { name: 'Squats', kind: 'squats' });
  const rows = computeStandings(event, who('a', 'b', 'c'), scores({ a: 50, b: 40, c: 30 }));
  const mine = personalEvent(event, rows, rows.find((r) => r.id === 'c'), 'c');
  assert.equal(mine.rank, 3);
  assert.equal(mine.percentile, 0);
  assert.equal(mine.next_target.gap, '10 reps');
  assert.equal(mine.next_target.place, 2);
  assert.equal(mine.medal, 'bronze');
  assert.equal(mine.gap_to_winner, '20 reps');
});

// ─── who can see what ────────────────────────────────────────────────

test('anyone can host: a client can create a tournament and is its main host', async (t) => {
  const api = await startApi(); t.after(api.close);
  const d = await make(api, 'ria');
  assert.equal(d.you.is_prime, true);
  assert.equal(d.events.length, 2);
  assert.ok(d.code);
});

test('staff-only: invisible to clients, listed for staff, and a client cannot create one', async (t) => {
  const api = await startApi(); t.after(api.close);
  const d = await make(api, 'owner', { audience: 'staff' });
  assert.equal((await api.call('ria', 'GET', `/tournaments/${d.id}`)).status, 404);
  assert.ok(!(await api.call('ria', 'GET', '/tournaments')).json.discover.some((x) => x.id === d.id));
  assert.ok((await api.call('coach', 'GET', '/tournaments')).json.discover.some((x) => x.id === d.id));
  assert.equal((await api.call('ria', 'POST', '/tournaments', { name: 'Nope', audience: 'staff', events })).status, 403);
  assert.equal((await api.call(null, 'GET', `/tournaments-public/${d.code}`)).status, 404, 'no back door through the public page');
});

test('gym-only: invisible to other gyms; open reach: visible across gyms', async (t) => {
  const api = await startApi(); t.after(api.close);
  const gym = await make(api, 'owner', { reach: 'gym' });
  const open = await make(api, 'owner', { reach: 'everyone', name: 'Open Wars' });
  assert.equal((await api.call('zoe', 'GET', `/tournaments/${gym.id}`)).status, 404);
  const list = (await api.call('zoe', 'GET', '/tournaments')).json.discover.map((x) => x.id);
  assert.ok(list.includes(open.id));
  assert.ok(!list.includes(gym.id));
});

test('a host with no gym cannot make a gym-only tournament nobody could see', async (t) => {
  const api = await startApi(); t.after(api.close);
  const d = await make(api, 'ivy', { reach: 'gym' });
  assert.equal(d.reach, 'everyone');
  assert.equal((await api.call('zoe', 'GET', `/tournaments/${d.id}`)).status, 200);
});

test('demo gyms are sealed in both directions', async (t) => {
  const api = await startApi(); t.after(api.close);
  const demo = await make(api, 'owner', { reach: 'everyone' });
  await api.db.run(`UPDATE tournaments SET host_org_id='demo' WHERE id=?`, [demo.id]);
  assert.equal((await api.call('zoe', 'GET', `/tournaments/${demo.id}`)).status, 404);
  assert.equal((await api.call(null, 'GET', `/tournaments-public/${demo.code}`)).status, 404);
  assert.equal((await api.call('zoe', 'GET', '/tournaments/people?q=dee')).json.people.length, 0);
  const real = { audience: 'everyone', reach: 'everyone', visibility: 'public', host_org_id: 'gymA', host_is_demo: 0 };
  assert.equal(canSee(real, { id: 'dee', org_id: 'demo', isStaff: false, isDemo: true }), false);
});

// ─── joining ─────────────────────────────────────────────────────────

test('public: join directly. Private: ask, and the host decides', async (t) => {
  const api = await startApi(); t.after(api.close);
  const open = await make(api);
  const joined = await api.call('ria', 'POST', `/tournaments/${open.id}/join`, { event_ids: [open.events[0].id] });
  assert.equal(joined.json.status, 'active');

  const closed = await make(api, 'owner', { visibility: 'private' });
  const asked = await api.call('sam', 'POST', `/tournaments/${closed.id}/join`, { event_ids: [closed.events[0].id] });
  assert.equal(asked.json.status, 'pending');
  const view = (await api.call('owner', 'GET', `/tournaments/${closed.id}`)).json;
  assert.equal(view.requests.length, 1);
  assert.equal(view.people.length, 0);
  const after = await api.call('owner', 'POST', `/tournaments/${closed.id}/entrants/${view.requests[0].id}/decision`, { accept: true });
  assert.equal(after.json.people.length, 1);
  const note = await api.db.q1(`SELECT title FROM notifications WHERE user_id='sam' AND type='tournament_request_reply'`);
  assert.match(note.title, /You're in/);
});

test('scanning the host\'s QR skips the private request', async (t) => {
  const api = await startApi(); t.after(api.close);
  const d = await make(api, 'owner', { visibility: 'private' });
  const res = await api.call('ria', 'POST', `/tournaments/${d.id}/join`, { event_ids: [d.events[0].id], code: d.code });
  assert.equal(res.json.status, 'active');
  const wrong = await api.call('sam', 'POST', `/tournaments/${d.id}/join`, { event_ids: [d.events[0].id], code: 'WRONG22' });
  assert.equal(wrong.json.status, 'pending');
});

test('a QR lets a visitor into a gym-only tournament, but never a staff-only one', async (t) => {
  const api = await startApi(); t.after(api.close);
  const gym = await make(api, 'owner', { reach: 'gym' });
  assert.equal((await api.call('zoe', 'POST', `/tournaments/${gym.id}/join`, { event_ids: [gym.events[0].id] })).status, 404);
  const scanned = await api.call('zoe', 'POST', `/tournaments/${gym.id}/join`, { event_ids: [gym.events[0].id], code: gym.code });
  assert.equal(scanned.json.status, 'active');
  assert.equal((await api.call('zoe', 'GET', `/tournaments/${gym.id}`)).status, 200);
  const staff = await make(api, 'owner', { audience: 'staff' });
  const refused = await api.call('ria', 'POST', `/tournaments/${staff.id}/join`, { event_ids: [staff.events[0].id], code: staff.code });
  assert.equal(refused.status, 404);
});

test('the pulse counts only what this person can see', async (t) => {
  const api = await startApi(); t.after(api.close);
  await make(api, 'owner', { audience: 'staff' });
  await make(api, 'owner', { reach: 'gym' });
  const open = await make(api, 'owner', { reach: 'everyone', name: 'Open Wars' });
  await api.call('owner', 'POST', `/tournaments/${open.id}/hosts`, { user_id: 'zoe' });
  const zoe = (await api.call('zoe', 'GET', '/tournaments/pulse')).json;
  assert.equal(zoe.upcoming, 1);
  assert.equal(zoe.invites, 1);
  assert.equal(zoe.next.id, open.id);
  assert.equal((await api.call('coach', 'GET', '/tournaments/pulse')).json.upcoming, 3);
});

test('a competition\'s own QR works, and leads to that competition', async (t) => {
  const api = await startApi(); t.after(api.close);
  const d = await make(api);
  const page = await api.call(null, 'GET', `/tournaments-public/${d.events[1].code}`);
  assert.equal(page.status, 200);
  assert.equal(page.json.matched_event_id, d.events[1].id);
});

test('registration deadline stops joining, but a host can still add someone', async (t) => {
  const api = await startApi(); t.after(api.close);
  const d = await make(api);
  await api.db.run('UPDATE tournaments SET registration_closes_at=? WHERE id=?', [future(-1), d.id]);
  const late = await api.call('ria', 'POST', `/tournaments/${d.id}/join`, { event_ids: [d.events[0].id] });
  assert.equal(late.status, 409);
  const byHost = await api.call('owner', 'POST', `/tournaments/${d.id}/entrants`, { people: [{ name: 'Walk In', event_ids: [d.events[0].id] }] });
  assert.equal(byHost.status, 200);
  assert.equal(byHost.json.people.length, 1);
});

test('registration has not opened yet', async (t) => {
  const api = await startApi(); t.after(api.close);
  const d = await make(api, 'owner', { registration_opens_at: future(5) });
  assert.equal((await api.call('ria', 'POST', `/tournaments/${d.id}/join`, { event_ids: [d.events[0].id] })).status, 409);
});

test('after the leaving deadline a competitor is locked in', async (t) => {
  const api = await startApi(); t.after(api.close);
  const d = await make(api);
  await api.call('ria', 'POST', `/tournaments/${d.id}/join`, { event_ids: [d.events[0].id] });
  await api.db.run('UPDATE tournaments SET withdraw_closes_at=? WHERE id=?', [future(-1), d.id]);
  assert.equal((await api.call('ria', 'POST', `/tournaments/${d.id}/leave`, {})).status, 409);
  await api.db.run('UPDATE tournaments SET withdraw_closes_at=? WHERE id=?', [future(1), d.id]);
  const out = await api.call('ria', 'POST', `/tournaments/${d.id}/leave`, {});
  assert.equal(out.status, 200);
  assert.equal(out.json.people.length, 0);
});

test('capacity holds for the tournament, for a competition, and when accepting a request', async (t) => {
  const api = await startApi(); t.after(api.close);
  const d = await make(api, 'owner', { capacity: 1 });
  await api.call('ria', 'POST', `/tournaments/${d.id}/join`, { event_ids: [d.events[0].id] });
  assert.equal((await api.call('sam', 'POST', `/tournaments/${d.id}/join`, { event_ids: [d.events[0].id] })).status, 409);

  const p = await make(api, 'owner', { visibility: 'private', capacity: 1 });
  await api.call('ria', 'POST', `/tournaments/${p.id}/join`, { event_ids: [p.events[0].id] });
  await api.call('sam', 'POST', `/tournaments/${p.id}/join`, { event_ids: [p.events[0].id] });
  const reqs = (await api.call('owner', 'GET', `/tournaments/${p.id}`)).json.requests;
  assert.equal((await api.call('owner', 'POST', `/tournaments/${p.id}/entrants/${reqs[0].id}/decision`, { accept: true })).status, 200);
  assert.equal((await api.call('owner', 'POST', `/tournaments/${p.id}/entrants/${reqs[1].id}/decision`, { accept: true })).status, 409);

  const e = await make(api, 'owner', { events: [{ kind: 'squats', capacity: 1 }] });
  await api.call('ria', 'POST', `/tournaments/${e.id}/join`, { event_ids: [e.events[0].id] });
  const full = await api.call('sam', 'POST', `/tournaments/${e.id}/join`, { event_ids: [e.events[0].id] });
  assert.equal(full.status, 409);
  assert.match(full.json.error, /Squats is full/);
});

test('dates have to make sense', async (t) => {
  const api = await startApi(); t.after(api.close);
  const res = await api.call('owner', 'POST', '/tournaments', { name: 'Bad', events, registration_closes_at: future(10), starts_at: future(1) });
  assert.equal(res.status, 422);
});

// ─── recording ───────────────────────────────────────────────────────

async function live(api, extra) {
  const d = await make(api, 'owner', extra);
  const eventId = d.events[0].id;
  await api.call('ria', 'POST', `/tournaments/${d.id}/join`, { event_ids: [eventId] });
  await api.call('sam', 'POST', `/tournaments/${d.id}/join`, { event_ids: [eventId] });
  const started = await api.call('owner', 'POST', `/tournaments/${d.id}/events/${eventId}/start`);
  assert.equal(started.status, 200);
  const view = started.json;
  const id = (name) => view.people.find((p) => p.name.startsWith(name)).id;
  return { d, eventId, id, url: `/tournaments/${d.id}/events/${eventId}/results` };
}

test('competitors cannot record scores, for themselves or anyone else', async (t) => {
  const api = await startApi(); t.after(api.close);
  const { url, id } = await live(api);
  assert.equal((await api.call('ria', 'PUT', url, { subject_id: id('Ria'), value: 999 })).status, 403);
  assert.equal((await api.call('ria', 'PUT', url, { subject_id: id('Sam'), value: 1 })).status, 403);
  assert.equal((await api.call('zoe', 'PUT', url, { subject_id: id('Ria'), value: 999 })).status, 403);
  assert.equal(Number((await api.db.q1('SELECT COUNT(*) AS n FROM tournament_results')).n), 0);
});

test('a pending co-host has no power until they accept', async (t) => {
  const api = await startApi(); t.after(api.close);
  const { d, url, id } = await live(api);
  await api.call('owner', 'POST', `/tournaments/${d.id}/hosts`, { user_id: 'zoe' });
  assert.equal((await api.call('zoe', 'PUT', url, { subject_id: id('Ria'), value: 10 })).status, 403);
  const note = await api.db.q1(`SELECT title FROM notifications WHERE user_id='zoe' AND type='tournament_cohost_invite'`);
  assert.match(note.title, /wants you to co-host/);
  assert.equal((await api.call('zoe', 'POST', `/tournaments/${d.id}/hosts/respond`, { accept: true })).status, 200);
  assert.equal((await api.call('zoe', 'PUT', url, { subject_id: id('Ria'), value: 10 })).status, 200);
});

test('only the main host invites co-hosts or cancels', async (t) => {
  const api = await startApi(); t.after(api.close);
  const d = await make(api);
  await api.call('owner', 'POST', `/tournaments/${d.id}/hosts`, { user_id: 'coach' });
  await api.call('coach', 'POST', `/tournaments/${d.id}/hosts/respond`, { accept: true });
  assert.equal((await api.call('coach', 'POST', `/tournaments/${d.id}/hosts`, { user_id: 'ria' })).status, 403);
  assert.equal((await api.call('coach', 'DELETE', `/tournaments/${d.id}`)).status, 403);
  assert.equal((await api.call('owner', 'DELETE', `/tournaments/${d.id}`)).status, 200);
});

test('a client cannot co-host a staff-only tournament', async (t) => {
  const api = await startApi(); t.after(api.close);
  const d = await make(api, 'owner', { audience: 'staff' });
  assert.equal((await api.call('owner', 'POST', `/tournaments/${d.id}/hosts`, { user_id: 'ria' })).status, 422);
});

test('a competing host cannot score themselves if another host can', async (t) => {
  const api = await startApi(); t.after(api.close);
  const d = await make(api);
  const eventId = d.events[0].id;
  await api.call('owner', 'POST', `/tournaments/${d.id}/hosts`, { user_id: 'coach' });
  await api.call('coach', 'POST', `/tournaments/${d.id}/hosts/respond`, { accept: true });
  await api.call('owner', 'POST', `/tournaments/${d.id}/join`, { event_ids: [eventId] });
  const view = (await api.call('owner', 'POST', `/tournaments/${d.id}/events/${eventId}/start`)).json;
  const me = view.people[0].id;
  const url = `/tournaments/${d.id}/events/${eventId}/results`;
  const own = await api.call('owner', 'PUT', url, { subject_id: me, value: 100 });
  assert.equal(own.status, 403);
  assert.match(own.json.error, /Another host/);
  const byCohost = await api.call('coach', 'PUT', url, { subject_id: me, value: 40 });
  assert.equal(byCohost.status, 200);
  assert.equal(byCohost.json.rows[0].self_recorded, false);
});

test('a host running it alone can score themselves, and the board says so', async (t) => {
  const api = await startApi(); t.after(api.close);
  const d = await make(api);
  const eventId = d.events[0].id;
  await api.call('owner', 'POST', `/tournaments/${d.id}/join`, { event_ids: [eventId] });
  const view = (await api.call('owner', 'POST', `/tournaments/${d.id}/events/${eventId}/start`)).json;
  const res = await api.call('owner', 'PUT', `/tournaments/${d.id}/events/${eventId}/results`, { subject_id: view.people[0].id, value: 40 });
  assert.equal(res.status, 200);
  assert.equal(res.json.rows[0].self_recorded, true);
});

test('scores need a running competition, a real person and a sane number', async (t) => {
  const api = await startApi(); t.after(api.close);
  const { d, url, id, eventId } = await live(api);
  assert.equal((await api.call('owner', 'PUT', url, { subject_id: 'nobody', value: 1 })).status, 404);
  assert.equal((await api.call('owner', 'PUT', url, { subject_id: id('Ria'), value: -1 })).status, 422);
  assert.equal((await api.call('owner', 'PUT', url, { subject_id: id('Ria'), value: 1e9 })).status, 422);
  assert.equal((await api.call('owner', 'PUT', url, { subject_id: id('Ria'), value: 5, attempt: 2 })).status, 422);
  await api.call('owner', 'POST', `/tournaments/${d.id}/events/${eventId}/finish`);
  assert.equal((await api.call('owner', 'PUT', url, { subject_id: id('Ria'), value: 5 })).status, 409, 'finished is locked');
});

test('a corrected score leaves a trace', async (t) => {
  const api = await startApi(); t.after(api.close);
  const d = await make(api, 'owner', { events: [{ kind: 'plank' }] });
  const eventId = d.events[0].id;
  await api.call('ria', 'POST', `/tournaments/${d.id}/join`, { event_ids: [eventId] });
  const view = (await api.call('owner', 'POST', `/tournaments/${d.id}/events/${eventId}/start`)).json;
  const url = `/tournaments/${d.id}/events/${eventId}/results`;
  await api.call('owner', 'PUT', url, { subject_id: view.people[0].id, value: 60 });
  await api.call('owner', 'PUT', url, { subject_id: view.people[0].id, value: 90 });
  const log = (await api.call('owner', 'GET', `/tournaments/${d.id}/audit`)).json.entries;
  assert.ok(log.some((e) => e.action === 'score_corrected' && /1:00 to 1:30/.test(e.detail)), JSON.stringify(log));
  assert.equal((await api.call('ria', 'GET', `/tournaments/${d.id}/audit`)).status, 403);
});

test('starting a competition starts the tournament and ends registration', async (t) => {
  const api = await startApi(); t.after(api.close);
  const { d } = await live(api);
  const view = (await api.call('zoe', 'GET', `/tournaments/${d.id}`)).json;
  assert.equal(view.status, 'live');
  assert.equal(view.you.can_join, false);
  assert.equal((await api.call('zoe', 'POST', `/tournaments/${d.id}/join`, { event_ids: [d.events[0].id] })).status, 409);
});

test('team events: teams are formed on joining and score as one', async (t) => {
  const api = await startApi(); t.after(api.close);
  const d = await make(api, 'owner', { events: [{ kind: 'tug_of_war' }] });
  const eventId = d.events[0].id;
  await api.call('ria', 'POST', `/tournaments/${d.id}/join`, { event_ids: [eventId], teams: { [eventId]: 'Titans' } });
  await api.call('sam', 'POST', `/tournaments/${d.id}/join`, { event_ids: [eventId], teams: { [eventId]: 'titans' } });
  await api.call('zoe', 'POST', `/tournaments/${d.id}/join`, { event_ids: [eventId], teams: { [eventId]: 'Wolves' } });
  await api.call('owner', 'POST', `/tournaments/${d.id}/events/${eventId}/start`);
  const b = (await api.call('owner', 'GET', `/tournaments/${d.id}/events/${eventId}/board`)).json;
  assert.equal(b.rows.length, 2);
  const titans = b.rows.find((r) => r.name === 'Titans');
  assert.equal(titans.members.length, 2);
  await api.call('owner', 'PUT', `/tournaments/${d.id}/events/${eventId}/results`, { subject_id: titans.id, value: 3 });
  await api.call('owner', 'POST', `/tournaments/${d.id}/events/${eventId}/finish`);
  await api.call('owner', 'POST', `/tournaments/${d.id}/finish`);
  const report = (await api.call('ria', 'GET', `/tournaments/${d.id}/results`)).json;
  assert.equal(report.personal.gold, 1, 'each member shares the team medal');
});

// ─── results ─────────────────────────────────────────────────────────

test('end to end: finish, tell everyone, and give each person their own report', async (t) => {
  const api = await startApi(); t.after(api.close);
  const { d, url, id, eventId } = await live(api, { events: [{ kind: 'squats', win_positions: 1 }, { kind: 'plank' }] });
  await api.call('owner', 'PUT', url, { subject_id: id('Ria'), value: 50 });
  await api.call('owner', 'PUT', url, { subject_id: id('Sam'), value: 30 });
  assert.equal((await api.call('owner', 'POST', `/tournaments/${d.id}/finish`)).status, 409, 'competitions still open');
  await api.call('owner', 'POST', `/tournaments/${d.id}/events/${eventId}/finish`);
  const plank = d.events[1].id;
  await api.call('owner', 'POST', `/tournaments/${d.id}/events/${plank}/start`);
  await api.call('owner', 'POST', `/tournaments/${d.id}/events/${plank}/finish`);
  assert.equal((await api.call('owner', 'POST', `/tournaments/${d.id}/finish`)).status, 200);

  const ria = (await api.call('ria', 'GET', `/tournaments/${d.id}/results`)).json;
  assert.equal(ria.personal.rank, 1);
  assert.equal(ria.personal.events[0].medal, 'gold');
  assert.equal(ria.personal.events[0].lines.tier, 'gold');
  assert.ok(ria.personal.lines.savage);
  assert.equal(ria.overall[0].is_me, true);
  const sam = (await api.call('sam', 'GET', `/tournaments/${d.id}/results`)).json;
  assert.equal(sam.personal.events[0].next_target.gap, '20 reps');
  const watcher = (await api.call('zoe', 'GET', `/tournaments/${d.id}/results`)).json;
  assert.equal(watcher.personal, null);
  assert.equal(watcher.events[0].rows[0].name, 'Ria Member', 'everyone can see the winners');

  const told = await api.db.q1(`SELECT title FROM notifications WHERE user_id='ria' AND type='tournament_result'`);
  assert.match(told.title, /You took gold in Squats/);
  assert.equal((await api.call('ria', 'GET', '/tournaments/trophies')).json.titles, 1);
  assert.equal((await api.call('owner', 'PATCH', `/tournaments/${d.id}`, { name: 'Changed' })).status, 409, 'history is final');
});

// ─── the QR page ─────────────────────────────────────────────────────

test('a guest can join from the QR, read their report, then claim it with an account', async (t) => {
  const api = await startApi(); t.after(api.close);
  const d = await make(api);
  const eventId = d.events[0].id;
  const page = await api.call(null, 'GET', `/tournaments-public/${d.code}`);
  assert.equal(page.status, 200);
  assert.equal(page.json.can_join, true);
  const joined = await api.call(null, 'POST', `/tournaments-public/${d.code}/join`, { name: 'Walk In', event_ids: [eventId] });
  assert.equal(joined.status, 201);
  const view = (await api.call('owner', 'POST', `/tournaments/${d.id}/events/${eventId}/start`)).json;
  await api.call('owner', 'PUT', `/tournaments/${d.id}/events/${eventId}/results`, { subject_id: view.people[0].id, value: 20 });
  const mine = await api.call(null, 'POST', `/tournaments-public/${d.code}/me`, { key: joined.json.key });
  assert.equal(mine.json.personal.events[0].rank, 1);
  assert.equal((await api.call(null, 'POST', `/tournaments-public/${d.code}/me`, { key: 'not-the-right-key-at-all' })).status, 404);
  assert.equal((await api.call('zoe', 'POST', `/tournaments/${d.id}/claim`, { key: joined.json.key })).status, 200);
  const claimed = (await api.call('zoe', 'GET', `/tournaments/${d.id}/results`)).json;
  assert.equal(claimed.personal.events[0].rank, 1);
  assert.equal((await api.call('ria', 'POST', `/tournaments/${d.id}/claim`, { key: joined.json.key })).status, 404, 'a key works once');
});

test('the public page leaks nothing a wall scoreboard would not show', async (t) => {
  const api = await startApi(); t.after(api.close);
  const d = await make(api);
  await api.call('ria', 'POST', `/tournaments/${d.id}/join`, { event_ids: [d.events[0].id], body_weight: 61 });
  const page = JSON.stringify((await api.call(null, 'GET', `/tournaments-public/${d.code}`)).json);
  assert.ok(page.includes('Ria Member'));
  for (const secret of ['ria@x.in', 'guest_key', 'password', 'body_weight', '"61']) {
    assert.ok(!page.includes(secret), `leaked ${secret}`);
  }
});

test('a cancelled tournament is gone from its QR', async (t) => {
  const api = await startApi(); t.after(api.close);
  const d = await make(api);
  await api.call('owner', 'DELETE', `/tournaments/${d.id}`);
  assert.equal((await api.call(null, 'GET', `/tournaments-public/${d.code}`)).status, 404);
});

test('rotating the code kills the old QR', async (t) => {
  const api = await startApi(); t.after(api.close);
  const d = await make(api);
  const after = (await api.call('owner', 'POST', `/tournaments/${d.id}/rotate-codes`)).json;
  assert.notEqual(after.code, d.code);
  assert.equal((await api.call(null, 'GET', `/tournaments-public/${d.code}`)).status, 404);
});

// ─── finding people ──────────────────────────────────────────────────

test('search: by name or username, labelled by relationship, no contact details', async (t) => {
  const api = await startApi(); t.after(api.close);
  await api.db.run(`UPDATE users SET username='zoe.lifts' WHERE id='zoe'`);
  const people = (await api.call('owner', 'GET', '/tournaments/people?q=member')).json.people;
  assert.ok(people.every((p) => p.relation === 'same_gym' && p.relation_label === 'Same gym'), JSON.stringify(people));
  const byHandle = (await api.call('owner', 'GET', '/tournaments/people?q=@zoe.l')).json.people;
  assert.equal(byHandle[0].relation, 'other_gym');
  assert.equal((await api.call('owner', 'GET', '/tournaments/people?q=ivy')).json.people[0].relation, 'independent');
  assert.ok(!JSON.stringify(people).includes('@x.in'));
  assert.equal((await api.call('owner', 'GET', '/tournaments/people?q=a')).json.people.length, 0, 'one letter is not a search');
});

test('search: the opt-out holds across gyms; inside your own gym the roster is known', async (t) => {
  const api = await startApi(); t.after(api.close);
  await api.db.run(`UPDATE users SET findable=0 WHERE id='ria'`);
  assert.equal((await api.call('zoe', 'GET', '/tournaments/people?q=ria')).json.people.length, 0);
  assert.equal((await api.call('owner', 'GET', '/tournaments/people?q=ria')).json.people.length, 1);
});

test('a username can be set, must be valid, and must be free', async (t) => {
  const api = await startApi(); t.after(api.close);
  assert.equal((await api.call('ria', 'PATCH', '/tournaments/identity', { username: 'Ria.Lifts' })).status, 200);
  assert.equal((await api.call('sam', 'PATCH', '/tournaments/identity', { username: 'ria.lifts' })).status, 409);
  assert.equal((await api.call('sam', 'PATCH', '/tournaments/identity', { username: 'no spaces!' })).status, 422);
  const hub = (await api.call('sam', 'GET', '/tournaments')).json;
  assert.match(hub.me.username, /^sammember\d{4}$/, 'a first visit gets one automatically');
});
