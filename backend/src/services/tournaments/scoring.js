// ============================================================
// TOURNAMENTS: turning recorded attempts into places. Pure functions, no
// database, so the rules that decide who won can be tested exhaustively.
//
// A competitor's score is their BEST valid attempt. Ties share a place and
// the next place is skipped (1, 2, 2, 4), the convention in nearly every
// sport, because awarding a tie to whoever happened to be entered first
// would be inventing a result. The one exception: on a lifted weight the
// lighter lifter takes the higher place, as in powerlifting.
// ============================================================
import { METRICS, pointsForRank } from './catalog.js';

export const higherWins = (metric) => METRICS[metric]?.higherWins !== false;

const round = (n, dp = 2) => {
  const f = 10 ** dp;
  return Math.round(Number(n) * f) / f;
};

/** 75.5 -> "1:15.5" */
export function formatTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s - h * 3600 - m * 60;
  const sec = Number.isInteger(round(rest, 1)) ? String(round(rest, 1)).padStart(2, '0') : round(rest, 1).toFixed(1).padStart(4, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** A score in words, for this metric. */
export function formatScore(metric, value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const v = Number(value);
  switch (metric) {
    case 'time_high':
    case 'time_low': return formatTime(v);
    case 'weight': return `${round(v, 2)} kg`;
    case 'distance': return v >= 1000 ? `${round(v / 1000, 2)} km` : `${round(v, 1)} m`;
    case 'wins': return `${round(v, 0)} ${round(v, 0) === 1 ? 'win' : 'wins'}`;
    default: return `${round(v, 0)} ${round(v, 0) === 1 ? 'rep' : 'reps'}`;
  }
}

function bestAttempt(metric, attempts) {
  const valid = attempts.filter((a) => a.valid !== 0 && a.valid !== false);
  if (!valid.length) return null;
  const better = higherWins(metric) ? Math.max : Math.min;
  return better(...valid.map((a) => Number(a.value)));
}

/**
 * Places for one competition.
 * subjects: [{ id, name, gym_label, user_id, body_weight, members? }]
 * results:  [{ subject_id, attempt, value, valid, self_recorded }]
 * Everyone comes back, ranked or not: someone with no valid attempt has
 * rank null, and is shown as not scored rather than as last.
 */
export function computeStandings(event, subjects, results) {
  const bySubject = new Map();
  for (const r of results) {
    if (!bySubject.has(r.subject_id)) bySubject.set(r.subject_id, []);
    bySubject.get(r.subject_id).push(r);
  }
  const rows = subjects.map((s) => {
    const attempts = (bySubject.get(s.id) || []).slice().sort((a, b) => a.attempt - b.attempt);
    return {
      ...s,
      attempts: attempts.map((a) => ({ attempt: a.attempt, value: Number(a.value), valid: a.valid !== 0 && a.valid !== false })),
      best: bestAttempt(event.metric, attempts),
      self_recorded: attempts.some((a) => a.self_recorded === 1 || a.self_recorded === true),
    };
  });
  const dir = higherWins(event.metric) ? -1 : 1;
  const lighterFirst = event.metric === 'weight';
  const cmp = (a, b) => {
    if (a.best !== b.best) return dir * (a.best - b.best);
    if (lighterFirst && a.body_weight && b.body_weight) return a.body_weight - b.body_weight;
    return 0;
  };
  const scored = rows.filter((r) => r.best != null).sort(cmp);
  scored.forEach((row, i) => {
    row.rank = i > 0 && cmp(scored[i - 1], row) === 0 ? scored[i - 1].rank : i + 1;
  });
  const unscored = rows.filter((r) => r.best == null)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((r) => ({ ...r, rank: null }));
  const leader = scored[0]?.best ?? null;
  return [...scored, ...unscored].map((r) => ({
    ...r,
    display: formatScore(event.metric, r.best),
    winner: r.rank != null && r.rank <= (event.win_positions || 3),
    gap: r.best == null || leader == null ? null : round(Math.abs(leader - r.best)),
  }));
}

/** What each person collected across the competitions, ranked overall. */
export function computeOverall(events, standingsByEvent, entrants) {
  const totals = new Map(entrants.map((e) => [e.id, {
    id: e.id, name: e.name, gym_label: e.gym_label, user_id: e.user_id,
    points: 0, gold: 0, silver: 0, bronze: 0, finals: 0,
  }]));
  const credit = (entrantId, rank) => {
    const t = totals.get(entrantId);
    if (!t) return;
    t.finals += 1;
    t.points += pointsForRank(rank);
    if (rank === 1) t.gold += 1;
    if (rank === 2) t.silver += 1;
    if (rank === 3) t.bronze += 1;
  };
  for (const ev of events) {
    for (const row of standingsByEvent[ev.id] || []) {
      if (row.rank == null) continue;
      // Everyone on a team shares the team's place.
      if (row.members) row.members.forEach((m) => credit(m.id, row.rank));
      else credit(row.id, row.rank);
    }
  }
  const ranked = [...totals.values()].filter((t) => t.finals > 0).sort((a, b) => (
    b.points - a.points || b.gold - a.gold || b.silver - a.silver || b.bronze - a.bronze
  ));
  const same = (a, b) => a.points === b.points && a.gold === b.gold && a.silver === b.silver && a.bronze === b.bronze;
  ranked.forEach((row, i) => { row.rank = i > 0 && same(ranked[i - 1], row) ? ranked[i - 1].rank : i + 1; });
  return ranked;
}

/** Gym against gym: the same points, summed by gym. Needs two gyms to mean anything. */
export function computeGymWar(overall) {
  const gyms = new Map();
  for (const p of overall) {
    const label = p.gym_label || 'Independent';
    if (!gyms.has(label)) gyms.set(label, { gym: label, points: 0, gold: 0, silver: 0, bronze: 0, athletes: 0 });
    const g = gyms.get(label);
    g.points += p.points; g.gold += p.gold; g.silver += p.silver; g.bronze += p.bronze; g.athletes += 1;
  }
  const rows = [...gyms.values()].sort((a, b) => b.points - a.points || b.gold - a.gold);
  return rows.length >= 2 ? rows : [];
}
