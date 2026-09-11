/**
 * COMMUNITY LEADERBOARD — podium + ranked rows, switchable by metric.
 *
 * FAIRNESS IS THE DESIGN CONSTRAINT HERE, not an afterthought:
 *
 *  - The metric is always named on screen ("This week · Workouts"). A
 *    member must never have to guess why they are ranked where they are,
 *    and there is deliberately no blended "community score" to hide it.
 *  - Only metrics with actual data get a tab. An empty Volume board
 *    invites the reading that nobody lifts anything.
 *  - The list shows the top of the board and then the viewer's own row.
 *    It does NOT render a long descending tail with the viewer near the
 *    bottom of it, which is the layout that turns a leaderboard into a
 *    public ranking of who is doing worst.
 */
import { useMemo } from 'react';
import { Avatar } from '../UI.jsx';
import { fmt, fmtVolume, HUE } from './CommunityPieces.jsx';

const TOP_N = 10;

/** Medal tones, used as a thin accent rather than an emoji trophy -- the
 *  brief asks for athletic, not a children's game. */
const PODIUM_TONE = ['var(--m-strength)', 'color-mix(in srgb, var(--ink) 45%, transparent)', 'color-mix(in srgb, var(--ink) 30%, transparent)'];

const METRIC_LABEL = {
  completedWorkouts: 'Workouts',
  volume: 'Volume',
  streak: 'Streaks',
};

/** The board takes the colour of whatever it is currently ranking, so
 *  switching metric is visible at a glance and not only in the label. */
const METRIC_HUE = {
  completedWorkouts: HUE.workouts,
  volume: HUE.recovery,
  streak: HUE.streak,
};

const PERIOD_LABEL = { day: 'Today', week: 'This week', month: 'This month' };

export function formatMetric(metric, value) {
  if (metric === 'volume') return `${fmtVolume(value)} kg`;
  if (metric === 'streak') return `${fmt(value)} ${value === 1 ? 'day' : 'days'}`;
  return `${fmt(value)} ${value === 1 ? 'workout' : 'workouts'}`;
}

export default function Leaderboard({
  boards, metric, onMetricChange, period, you, onSelectMember,
}) {
  // A tab per metric that actually has someone on it. Hiding an empty
  // board is not hiding bad news -- an empty board says nothing true.
  const available = useMemo(
    () => ['completedWorkouts', 'volume', 'streak']
      .filter((m) => (boards?.[m] || []).some((e) => e.value > 0)),
    [boards]);

  const active = available.includes(metric) ? metric : available[0];
  const hue = METRIC_HUE[active] || HUE.workouts;
  const rows = active ? (boards[active] || []).filter((e) => e.value > 0) : [];

  if (!rows.length) {
    return (
      <div className="rounded-2xl p-5 text-center" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
        <div className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>No rankings yet</div>
        <div className="text-[11.5px] mt-1" style={{ color: 'var(--mute)' }}>
          Rankings appear once members log workouts {period === 'day' ? 'today' : `this ${period}`}.
        </div>
      </div>
    );
  }

  const podium = rows.slice(0, 3);
  const rest = rows.slice(3, TOP_N);
  const youRow = rows.find((r) => r.clientId === you);
  // Only pinned when the viewer is outside the visible slice -- otherwise
  // their row would appear twice.
  const youOutside = youRow && rows.indexOf(youRow) >= TOP_N;

  return (
    <div className="rounded-2xl p-3.5" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
      {/* The metric is stated, always. */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-[11px] font-bold uppercase tracking-[.14em]" style={{ color: 'var(--mute)' }}>
          {PERIOD_LABEL[period] || 'This week'} · {METRIC_LABEL[active]}
        </h2>
      </div>

      {available.length > 1 && (
        <div className="flex gap-1.5 mb-3.5" role="tablist" aria-label="Leaderboard metric">
          {available.map((m) => {
            const on = m === active;
            return (
              <button
                key={m}
                role="tab"
                aria-selected={on}
                onClick={() => onMetricChange(m)}
                className="flex-1 rounded-lg text-[11.5px] font-semibold transition-colors"
                style={{
                  minHeight: 34,
                  background: on ? (METRIC_HUE[m] || HUE.workouts).bg : 'transparent',
                  border: `1px solid ${on ? (METRIC_HUE[m] || HUE.workouts).fg : 'var(--line)'}`,
                  color: on ? (METRIC_HUE[m] || HUE.workouts).fg : 'var(--mute)',
                }}
              >
                {METRIC_LABEL[m]}
              </button>
            );
          })}
        </div>
      )}

      {/* Podium: 2 · 1 · 3, the tallest in the middle. */}
      {podium.length >= 3 && (
        <div className="flex items-end justify-center gap-2 mb-4">
          {[podium[1], podium[0], podium[2]].map((entry, i) => {
            const place = [2, 1, 3][i];
            const isWinner = place === 1;
            const isYou = entry.clientId === you;
            return (
              <button
                key={entry.clientId}
                type="button"
                onClick={() => onSelectMember?.(entry)}
                className="flex-1 flex flex-col items-center gap-1.5 rounded-xl py-2.5 px-1 transition-transform active:scale-[.97]"
                style={{
                  background: isYou ? hue.bg : 'transparent',
                  border: `1px solid ${isYou ? hue.fg : 'transparent'}`,
                }}
              >
                <div style={{ transform: isWinner ? 'scale(1.12)' : 'none' }}>
                  <Avatar name={entry.name} size={isWinner ? 46 : 38} />
                </div>
                <div
                  className="text-[10px] font-black tabular-nums"
                  style={{ color: PODIUM_TONE[place - 1] }}
                >
                  {place}
                </div>
                <div className="text-[11px] font-semibold truncate w-full text-center" style={{ color: 'var(--ink)' }}>
                  {isYou ? 'You' : entry.name}
                </div>
                <div className="text-[10px] tabular-nums font-semibold" style={{ color: hue.fg }}>
                  {formatMetric(active, entry.value)}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <ol className="space-y-1">
        {(podium.length >= 3 ? rest : rows.slice(0, TOP_N)).map((entry) => (
          <Row
            key={entry.clientId}
            entry={entry}
            metric={active}
            hue={hue}
            isYou={entry.clientId === you}
            onClick={() => onSelectMember?.(entry)}
          />
        ))}
      </ol>

      {youOutside && (
        <>
          <div className="my-2 text-center text-[10px]" style={{ color: 'var(--faint)' }}>···</div>
          <Row entry={youRow} metric={active} hue={hue} isYou onClick={() => onSelectMember?.(youRow)} />
        </>
      )}
    </div>
  );
}

function Row({ entry, metric, hue, isYou, onClick }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="w-full flex items-center gap-2.5 rounded-xl px-2.5 text-left transition-transform active:scale-[.99]"
        style={{
          minHeight: 46,
          background: isYou ? hue.bg : 'transparent',
          border: `1px solid ${isYou ? hue.fg : 'transparent'}`,
        }}
      >
        <span className="tabular-nums text-[11.5px] font-semibold w-6 shrink-0" style={{ color: 'var(--faint)' }}>
          {entry.rank}
        </span>
        <Avatar name={entry.name} size={28} />
        <span className="flex-1 min-w-0 truncate text-[12.5px] font-medium" style={{ color: 'var(--ink)' }}>
          {isYou ? 'You' : entry.name}
        </span>
        <span className="tabular-nums text-[12px] font-bold shrink-0 whitespace-nowrap" style={{ color: isYou ? hue.fg : 'var(--ink)' }}>
          {formatMetric(metric, entry.value)}
        </span>
      </button>
    </li>
  );
}
