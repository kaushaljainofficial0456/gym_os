// ============================================================
// TOURNAMENTS: the day itself. Starting competitions, recording scores,
// and the results everyone reads afterwards.
//
// THE HOST'S WORD IS THE RECORD. Competitors never write a score; there is
// no route for it, not merely a hidden button. A host who is also competing
// cannot score themselves while another host is available, and if they run
// the tournament alone their score is permanently marked self-recorded on
// the board. Every correction lands in tournament_audit.
// ============================================================
import { id, now } from '../../ids.js';
import { notify } from '../enterprise/notifications.js';
import { METRICS } from './catalog.js';
import { computeStandings, computeOverall, computeGymWar, formatScore } from './scoring.js';
import { eventSummary, personalEvent, personalTournament } from './insights.js';
import { fail, isTrue, requireNotFinished } from './access.js';

const int = (v) => Number(v) || 0;

export async function loadEvent(db, tournamentId, eventId) {
  const event = await db.q1('SELECT * FROM tournament_events WHERE id=? AND tournament_id=?', [eventId, tournamentId]);
  if (!event) fail(404, 'no_event', 'Competition not found');
  return event;
}

/** Who is competing in an event: people, or teams with their members. */
async function subjectsFor(db, event) {
  const rows = await db.q(
    `SELECT p.id, p.user_id, p.name, p.gym_label, p.body_weight, en.team_id, tm.name AS team_name
       FROM tournament_entries en
       JOIN tournament_entrants p ON p.id = en.entrant_id AND p.status = 'active'
       LEFT JOIN tournament_teams tm ON tm.id = en.team_id
      WHERE en.event_id = ?`, [event.id]);
  if (!isTrue(event.is_team)) return rows;
  const teams = new Map();
  for (const r of rows) {
    if (!r.team_id) continue;
    if (!teams.has(r.team_id)) teams.set(r.team_id, { id: r.team_id, name: r.team_name, gym_label: r.gym_label, is_team: true, members: [] });
    teams.get(r.team_id).members.push({ id: r.id, user_id: r.user_id, name: r.name });
  }
  return [...teams.values()];
}

export async function standingsFor(db, event) {
  const [subjects, results] = await Promise.all([
    subjectsFor(db, event),
    db.q('SELECT subject_id, attempt, value, valid, self_recorded FROM tournament_results WHERE event_id=?', [event.id]),
  ]);
  return computeStandings(event, subjects, results);
}

const publicEvent = (e) => ({
  id: e.id, name: e.name, kind: e.kind, metric: e.metric, attempts: e.attempts, time_cap_sec: e.time_cap_sec,
  win_positions: e.win_positions, is_team: isTrue(e.is_team), status: e.status,
  started_at: e.started_at, finished_at: e.finished_at, unit: METRICS[e.metric]?.unit,
});

// Names, places and scores only: body weight is not the board's business.
const publicRow = (r, viewerId) => ({
  id: r.id, name: r.name, gym_label: r.gym_label, rank: r.rank, best: r.best, display: r.display, winner: r.winner,
  attempts: r.attempts, self_recorded: r.self_recorded, is_team: !!r.is_team,
  members: r.members?.map((m) => ({ id: m.id, name: m.name })),
  is_me: viewerId ? (r.user_id === viewerId || !!r.members?.some((m) => m.user_id === viewerId)) : false,
});

export async function board(db, event, viewerId) {
  const standings = await standingsFor(db, event);
  return { event: publicEvent(event), rows: standings.map((r) => publicRow(r, viewerId)) };
}

export async function startEvent(db, ctx, event) {
  requireNotFinished(ctx.t);
  if (event.status === 'live') return;
  const stamp = now();
  await db.run(`UPDATE tournament_events SET status='live', started_at=COALESCE(started_at, ?), finished_at=NULL WHERE id=?`, [stamp, event.id]);
  // The first competition to start is the tournament starting: registration
  // and the deadline to leave are over from here on.
  if (ctx.t.status === 'upcoming') {
    await db.run(`UPDATE tournaments SET status='live', started_at=?, updated_at=? WHERE id=?`, [stamp, stamp, ctx.t.id]);
  }
  await writeAudit(db, ctx, 'event_started', event.name);
}

async function writeAudit(db, ctx, action, detail) {
  await db.run(
    'INSERT INTO tournament_audit (id, tournament_id, actor_id, action, detail, created_at) VALUES (?,?,?,?,?,?)',
    [id('tau'), ctx.t.id, ctx.viewer.id, action, detail, now()]).catch(() => {});
}

const LIMIT_WORDS = { reps: 'reps', time_high: 'seconds', time_low: 'seconds', weight: 'kg', distance: 'metres', wins: 'wins' };

/** Records one attempt. Hosts only, and never for yourself if someone else can. */
export async function recordResult(db, ctx, event, { subject_id: subjectId, attempt = 1, value, valid = true }) {
  requireNotFinished(ctx.t);
  if (event.status !== 'live') fail(409, 'not_live', 'Start this competition before recording scores');
  const max = METRICS[event.metric].max;
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0 || v > max) fail(422, 'bad_value', `Enter a number from 0 to ${max} ${LIMIT_WORDS[event.metric]}`);
  if (attempt < 1 || attempt > event.attempts) fail(422, 'bad_attempt', `This competition has ${event.attempts} attempt${event.attempts === 1 ? '' : 's'}`);
  const subjects = await subjectsFor(db, event);
  const subject = subjects.find((s) => s.id === subjectId);
  if (!subject) fail(404, 'not_competing', 'They are not in this competition');
  const isSelf = subject.user_id === ctx.viewer.id || !!subject.members?.some((m) => m.user_id === ctx.viewer.id);
  if (isSelf) {
    const others = int((await db.q1(
      `SELECT COUNT(*) AS n FROM tournament_hosts WHERE tournament_id=? AND status='accepted' AND user_id <> ?`,
      [ctx.t.id, ctx.viewer.id]))?.n);
    if (others > 0) fail(403, 'own_score', 'Another host has to record your own score');
  }
  const previous = await db.q1('SELECT value, valid FROM tournament_results WHERE event_id=? AND subject_id=? AND attempt=?', [event.id, subjectId, attempt]);
  const stamp = now();
  await db.run(
    `INSERT INTO tournament_results (id, event_id, subject_id, attempt, value, valid, self_recorded, recorded_by, recorded_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT (event_id, subject_id, attempt) DO UPDATE SET
       value=excluded.value, valid=excluded.valid, self_recorded=excluded.self_recorded,
       recorded_by=excluded.recorded_by, recorded_at=excluded.recorded_at`,
    [id('trs'), event.id, subjectId, attempt, v, valid ? 1 : 0, isSelf ? 1 : 0, ctx.viewer.id, stamp]);
  // A live counter sends each tap; only a real change of a finished score
  // is worth a line, or the log would be every rep of every set.
  if (previous && !['reps', 'wins'].includes(event.metric) && (Number(previous.value) !== v || isTrue(previous.valid) !== !!valid)) {
    await writeAudit(db, ctx, 'score_corrected',
      `${event.name}: ${subject.name}, attempt ${attempt}: ${formatScore(event.metric, previous.value)} to ${formatScore(event.metric, v)}`);
  }
}

export async function clearResult(db, ctx, event, subjectId, attempt) {
  requireNotFinished(ctx.t);
  if (event.status !== 'live') fail(409, 'not_live', 'This competition is not running');
  const res = await db.run('DELETE FROM tournament_results WHERE event_id=? AND subject_id=? AND attempt=?', [event.id, subjectId, attempt]);
  if (res?.changes) await writeAudit(db, ctx, 'score_cleared', event.name);
}

const PLACE_WORD = { 1: 'gold', 2: 'silver', 3: 'bronze' };

export async function finishEvent(db, ctx, event) {
  requireNotFinished(ctx.t);
  if (event.status !== 'live') fail(409, 'not_live', 'This competition is not running');
  await db.run(`UPDATE tournament_events SET status='completed', finished_at=? WHERE id=?`, [now(), event.id]);
  await writeAudit(db, ctx, 'event_finished', event.name);
  const standings = await standingsFor(db, { ...event, status: 'completed' });
  for (const row of standings) {
    const people = row.members || [row];
    for (const person of people) {
      if (!person.user_id) continue;
      const u = await db.q1('SELECT role, org_id FROM users WHERE id=?', [person.user_id]);
      if (!u) continue;
      const base = u.role === 'CLIENT' ? '/app/client' : '/app/trainer';
      const place = PLACE_WORD[row.rank];
      await notify(db, {
        orgId: u.org_id || ctx.t.host_org_id,
        userId: person.user_id,
        type: 'tournament_result',
        title: place ? `You took ${place} in ${event.name}!` : `${event.name} results are in`,
        body: row.rank ? `Place ${row.rank} with ${row.display}` : ctx.t.name,
        data: { link: `${base}/tournaments/${ctx.t.id}/results`, tournamentId: ctx.t.id },
      });
    }
  }
}

export async function reopenEvent(db, ctx, event) {
  requireNotFinished(ctx.t);
  if (event.status !== 'completed') fail(409, 'not_finished', 'This competition has not finished');
  await db.run(`UPDATE tournament_events SET status='live', finished_at=NULL WHERE id=?`, [event.id]);
  await writeAudit(db, ctx, 'event_reopened', event.name);
}

export async function finishTournament(db, ctx) {
  requireNotFinished(ctx.t);
  const events = await db.q('SELECT name, status FROM tournament_events WHERE tournament_id=?', [ctx.t.id]);
  const open = events.filter((e) => e.status !== 'completed');
  if (open.length) fail(409, 'events_open', `Finish ${open.map((e) => e.name).join(', ')} first`);
  const stamp = now();
  await db.run(`UPDATE tournaments SET status='completed', completed_at=?, updated_at=? WHERE id=?`, [stamp, stamp, ctx.t.id]);
  await writeAudit(db, ctx, 'finished', null);
  const people = await db.q(
    `SELECT p.user_id, u.role, u.org_id FROM tournament_entrants p JOIN users u ON u.id = p.user_id
      WHERE p.tournament_id=? AND p.status='active'`, [ctx.t.id]);
  for (const p of people) {
    const base = p.role === 'CLIENT' ? '/app/client' : '/app/trainer';
    await notify(db, {
      orgId: p.org_id || ctx.t.host_org_id,
      userId: p.user_id,
      type: 'tournament_finished',
      title: `${ctx.t.name}: your results are ready`,
      body: 'Your full report is in, with places and analytics.',
      data: { link: `${base}/tournaments/${ctx.t.id}/results`, tournamentId: ctx.t.id },
    });
  }
}

/** The whole story of a tournament, plus this person's own part in it. */
export async function results(db, t, { viewerId = null, entrantId = null } = {}) {
  const events = await db.q('SELECT * FROM tournament_events WHERE tournament_id=? ORDER BY position', [t.id]);
  const entrants = await db.q(
    `SELECT id, user_id, name, gym_label, body_weight FROM tournament_entrants WHERE tournament_id=? AND status='active'`, [t.id]);
  const standingsByEvent = {};
  for (const ev of events) standingsByEvent[ev.id] = await standingsFor(db, ev);
  const overall = computeOverall(events, standingsByEvent, entrants);
  const gymWar = computeGymWar(overall);

  const eventReports = events.map((ev) => {
    const rows = standingsByEvent[ev.id];
    return { ...publicEvent(ev), rows: rows.map((r) => publicRow(r, viewerId)), summary: eventSummary(ev, rows) };
  });

  const me = viewerId
    ? entrants.find((e) => e.user_id === viewerId)
    : entrants.find((e) => e.id === entrantId);
  let personal = null;
  if (me) {
    const mine = [];
    for (const ev of events) {
      const row = standingsByEvent[ev.id].find((r) => r.id === me.id || r.members?.some((m) => m.id === me.id));
      if (row) mine.push(personalEvent(ev, standingsByEvent[ev.id], { ...row, body_weight: me.body_weight }, me.id));
    }
    personal = personalTournament(me, mine, overall);
  }

  return {
    tournament: {
      id: t.id, name: t.name, tagline: t.tagline, theme: t.theme, status: t.status, venue: t.venue,
      overall_positions: t.overall_positions, completed_at: t.completed_at, prize: t.prize,
    },
    totals: {
      athletes: entrants.length,
      competitions: events.length,
      finished: events.filter((e) => e.status === 'completed').length,
      gyms: new Set(entrants.map((e) => e.gym_label || 'Independent')).size,
      scores: eventReports.reduce((a, e) => a + e.summary.scored, 0),
    },
    overall: overall.map((o) => ({
      ...o, is_me: me ? o.id === me.id : false, winner: o.rank <= t.overall_positions,
    })),
    gym_war: gymWar,
    events: eventReports,
    personal,
  };
}

/** A person's medals across every finished tournament, for their trophy shelf. */
export async function trophyShelf(db, viewerId) {
  const rows = await db.q(
    `SELECT t.id, t.name, t.completed_at FROM tournaments t
       JOIN tournament_entrants p ON p.tournament_id = t.id
      WHERE p.user_id=? AND p.status='active' AND t.status='completed'
      ORDER BY t.completed_at DESC LIMIT 20`, [viewerId]);
  const shelf = { played: 0, gold: 0, silver: 0, bronze: 0, titles: 0, history: [] };
  for (const t of rows) {
    const full = await db.q1('SELECT * FROM tournaments WHERE id=?', [t.id]);
    const report = await results(db, full, { viewerId });
    const p = report.personal;
    shelf.played += 1;
    if (!p) continue;
    shelf.gold += p.gold; shelf.silver += p.silver; shelf.bronze += p.bronze;
    if (p.rank === 1) shelf.titles += 1;
    shelf.history.push({ id: t.id, name: t.name, rank: p.rank, of: p.of, completed_at: t.completed_at });
  }
  return shelf;
}
