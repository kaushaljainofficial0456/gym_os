// ============================================================
// TOURNAMENTS: the part people screenshot. Turns results into comparisons
// with real things, and a line about how it went, in two moods.
//
// Everything here is deterministic: the same result always gets the same
// line, so a screenshot and a reload agree, and no AI call is needed. The
// jokes are about the performance, never the person's body.
// ============================================================
import { formatScore, higherWins } from './scoring.js';

const DEFAULT_BODY_KG = 70;

const THINGS = {
  mass: [
    { kg: 30, one: 'full LPG cylinder', many: 'full LPG cylinders', icon: 'flame' },
    { kg: 195, one: 'Royal Enfield', many: 'Royal Enfields', icon: 'bike' },
    { kg: 350, one: 'auto-rickshaw', many: 'auto-rickshaws', icon: 'car' },
    { kg: 480, one: 'grand piano', many: 'grand pianos', icon: 'piano' },
    { kg: 900, one: 'hatchback', many: 'hatchbacks', icon: 'car' },
    { kg: 4_000, one: 'Asian elephant', many: 'Asian elephants', icon: 'mountain' },
    { kg: 12_000, one: 'city bus', many: 'city buses', icon: 'bus' },
    { kg: 150_000, one: 'blue whale', many: 'blue whales', icon: 'rocket' },
  ],
  height: [
    { m: 2.5, one: 'room height', many: 'room heights', icon: 'target' },
    { m: 15, one: 'five-storey building', many: 'five-storey buildings', icon: 'mountain' },
    { m: 73, one: 'Qutub Minar', many: 'Qutub Minars', icon: 'mountain' },
    { m: 330, one: 'Eiffel Tower', many: 'Eiffel Towers', icon: 'mountain' },
    { m: 828, one: 'Burj Khalifa', many: 'Burj Khalifas', icon: 'mountain' },
    { m: 8_849, one: 'Mount Everest', many: 'Mount Everests', icon: 'mountain' },
  ],
  time: [
    { sec: 180, one: 'three-minute song', many: 'three-minute songs', icon: 'music' },
    { sec: 300, one: 'chai break', many: 'chai breaks', icon: 'flame' },
    { sec: 5_400, one: 'T20 innings', many: 'T20 innings', icon: 'target' },
    { sec: 10_800, one: 'three-hour film', many: 'three-hour films', icon: 'film' },
  ],
  distance: [
    { m: 20, one: 'cricket pitch', many: 'cricket pitches', icon: 'target' },
    { m: 50, one: 'Olympic pool length', many: 'Olympic pool lengths', icon: 'footprints' },
    { m: 105, one: 'football pitch', many: 'football pitches', icon: 'footprints' },
    { m: 400, one: 'running-track lap', many: 'running-track laps', icon: 'footprints' },
  ],
};

// What one rep of a movement costs: the share of body weight moved, and how far.
const REP_WORK = {
  squats: { share: 0.85, m: 0.5 },
  push_ups: { share: 0.65, m: 0.35 },
  pull_ups: { share: 1, m: 0.6 },
  burpees: { share: 0.7, m: 0.5 },
  sit_ups: { share: 0.4, m: 0.3 },
};

/** The biggest thing `amount` still covers, or the smallest as a fraction. */
function nearest(table, key, amount) {
  const hit = [...table].reverse().find((t) => amount >= t[key]) || table[0];
  const n = amount / hit[key];
  const count = n >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
  return { count, label: count === 1 ? hit.one : hit.many, icon: hit.icon };
}

/** Real-world equivalents of `value` in this event. `scale` words the sentence. */
export function compare(event, value, { bodyWeight, group = false } = {}) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return [];
  const who = group ? 'Together' : 'You';
  const out = [];
  // Too small to picture is not a comparison: nobody wants "0 songs".
  const say = (verb, thing) => { if (thing.count >= 0.1) out.push({ icon: thing.icon, text: `${who} ${verb} ${thing.count} ${thing.label}` }); };
  const body = Number(bodyWeight) > 0 ? Number(bodyWeight) : DEFAULT_BODY_KG;
  if (event.metric === 'weight') {
    say('lifted', nearest(THINGS.mass, 'kg', v));
  } else if (event.metric === 'time_high') {
    if (v < 90) out.push({ icon: 'flame', text: `${Math.round(v)} seconds of shaking. Every one of them counted` });
    else say('held on for', nearest(THINGS.time, 'sec', v));
  } else if (event.metric === 'time_low') {
    if (v < 60) out.push({ icon: 'rocket', text: `${Math.round(v)} seconds. A blink, by gym standards` });
    else say('took', nearest(THINGS.time, 'sec', v));
  } else if (event.metric === 'distance') {
    say('covered', nearest(THINGS.distance, 'm', v));
  } else if (event.metric === 'reps') {
    const work = REP_WORK[event.kind];
    if (work) {
      say('moved', nearest(THINGS.mass, 'kg', v * body * work.share));
      say('climbed', nearest(THINGS.height, 'm', v * work.m));
    } else {
      say('moved', nearest(THINGS.mass, 'kg', v * body * 0.6));
    }
  }
  return out;
}

const LINES = {
  gold: {
    friendly: ['Nobody came close. Frame this one.', 'That was a clinic. Well earned.', 'Top of the board, and you made it look calm.'],
    savage: ['You made the rest of the field look like a warm-up set.', 'Everyone else was competing for second. They knew it.', 'Save some for the rest of us next time.'],
  },
  podium: {
    friendly: ['On the podium. That is a real result.', 'A medal is a medal, and this one was earned.', 'So close to the top you could smell the chalk.'],
    savage: ['First place sends its regards.', 'Close. Which is what we tell everyone who lost.', 'Great result. For someone who did not win.'],
  },
  upper: {
    friendly: ['Top half of the field. Solid work.', 'You beat most of the room today.', 'A strong showing. The podium is in reach.'],
    savage: ['Beat most people. Remember who you did not beat.', 'Respectable. Your rivals are not losing sleep yet.', 'Good enough to brag, not enough to stop training.'],
  },
  lower: {
    friendly: ['You showed up and put a number on the board. That counts.', 'Every champion has a day like this in their history.', 'Now you know the number to beat.'],
    savage: ['The leaderboard has seen you. It was not impressed.', 'Bold strategy, saving your best for next time.', 'Your warm-up set called. It wants a rematch.'],
  },
  last: {
    friendly: ['Someone has to set the baseline. Thank you for your service.', 'Last today means the most room to climb.', 'You finished. Most people never sign up.'],
    savage: ['Someone had to hold the leaderboard up from the bottom.', 'On the bright side, there is only one direction from here.', 'Bottom of the board, top of the comeback list.'],
  },
  none: {
    friendly: ['No score recorded this time. There is always the next one.'],
    savage: ['You entered, and that is where the story ends.'],
  },
};

function pick(list, seed) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return list[Math.abs(h) % list.length];
}

function tierOf(rank, field) {
  if (rank == null) return 'none';
  if (rank === 1) return 'gold';
  if (rank <= 3 && field > 3) return 'podium';
  if (field > 1 && rank === field) return 'last';
  return rank <= Math.ceil(field / 2) ? 'upper' : 'lower';
}

export const linesFor = (rank, field, seed) => {
  const tier = tierOf(rank, field);
  return { tier, friendly: pick(LINES[tier].friendly, seed), savage: pick(LINES[tier].savage, seed) };
};

const median = (values) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** The whole competition at a glance. */
export function eventSummary(event, standings) {
  const scored = standings.filter((r) => r.rank != null);
  const values = scored.map((r) => r.best);
  const total = values.reduce((a, b) => a + b, 0);
  const avg = values.length ? total / values.length : null;
  const top = scored[0] || null;
  const weightsKnown = scored.filter((r) => r.body_weight > 0);
  const relative = event.metric === 'weight' && weightsKnown.length
    ? [...weightsKnown].sort((a, b) => b.best / b.body_weight - a.best / a.body_weight)[0]
    : null;
  return {
    entered: standings.length,
    scored: scored.length,
    best: top ? top.best : null,
    best_display: formatScore(event.metric, top?.best),
    average: avg,
    average_display: formatScore(event.metric, avg),
    median_display: formatScore(event.metric, median(values)),
    total,
    total_display: formatScore(event.metric, total),
    pound_for_pound: relative ? { name: relative.name, ratio: Math.round((relative.best / relative.body_weight) * 100) / 100 } : null,
    comparisons: compare(event, total, { group: true }),
  };
}

/** One person's competition, against the field. */
export function personalEvent(event, standings, row, seedId) {
  const scored = standings.filter((r) => r.rank != null);
  const field = scored.length;
  const beat = row.rank == null ? 0 : scored.filter((r) => r.rank > row.rank).length;
  const percentile = field > 1 && row.rank != null ? Math.round((beat / (field - 1)) * 100) : (row.rank === 1 ? 100 : 0);
  const stats = eventSummary(event, standings);
  const dir = higherWins(event.metric) ? 1 : -1;
  const ahead = row.rank && row.rank > 1
    ? scored.filter((r) => r.rank < row.rank).slice(-1)[0]
    : null;
  const vsAverage = row.best != null && stats.average
    ? Math.round((((row.best - stats.average) * dir) / stats.average) * 100)
    : null;
  return {
    event_id: event.id,
    name: event.name,
    kind: event.kind,
    metric: event.metric,
    rank: row.rank,
    field,
    medal: row.rank === 1 ? 'gold' : row.rank === 2 ? 'silver' : row.rank === 3 ? 'bronze' : null,
    winner: !!row.winner,
    score: row.best,
    display: row.display,
    percentile,
    beat,
    vs_average: vsAverage,
    average_display: stats.average_display,
    best_display: stats.best_display,
    gap_to_winner: row.gap == null ? null : formatScore(event.metric, row.gap),
    next_target: ahead ? {
      name: ahead.name,
      gap: formatScore(event.metric, Math.abs(ahead.best - row.best)),
      place: ahead.rank,
    } : null,
    lines: linesFor(row.rank, field, `${seedId}:${event.id}`),
    comparisons: compare(event, row.best, { bodyWeight: row.body_weight }),
  };
}

/** One person's whole tournament. */
export function personalTournament(entrant, personalEvents, overall) {
  const mine = overall.find((o) => o.id === entrant.id) || null;
  const scored = personalEvents.filter((e) => e.rank != null);
  const sorted = [...scored].sort((a, b) => b.percentile - a.percentile);
  return {
    entrant_id: entrant.id,
    name: entrant.name,
    rank: mine?.rank ?? null,
    of: overall.length,
    points: mine?.points ?? 0,
    gold: mine?.gold ?? 0,
    silver: mine?.silver ?? 0,
    bronze: mine?.bronze ?? 0,
    best_event: sorted[0] ? { name: sorted[0].name, percentile: sorted[0].percentile } : null,
    work_on: sorted.length > 1 ? { name: sorted[sorted.length - 1].name, percentile: sorted[sorted.length - 1].percentile } : null,
    average_percentile: scored.length ? Math.round(scored.reduce((a, e) => a + e.percentile, 0) / scored.length) : null,
    radar: personalEvents.map((e) => ({ name: e.name, value: e.percentile })),
    lines: linesFor(mine?.rank ?? null, overall.length, entrant.id),
    events: personalEvents,
  };
}
