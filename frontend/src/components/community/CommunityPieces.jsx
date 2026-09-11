/**
 * COMMUNITY — the non-feed sections.
 *
 * Every component here renders ONLY what the backend actually returned.
 * There is no placeholder member, no sample streak and no "—" standing in
 * for a number we could have computed: where there is nothing to show,
 * the section removes itself (returns null) and the page closes up around
 * it. A community with three members should look like a real community of
 * three, not like a broken community of a hundred.
 */
import { useMemo, useState } from 'react';
import Ring from '../Ring.jsx';
import PeriodChart from '../PeriodChart.jsx';

const nf = new Intl.NumberFormat();
export const fmt = (n) => nf.format(Math.round(Number(n) || 0));

/** Volume gets tiring to read in full. 18,420 kg -> "18.4k kg". */
export const fmtVolume = (kg) => {
  const n = Number(kg) || 0;
  if (n >= 100000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return fmt(n);
};

/**
 * COLOUR ENCODES MEANING, it does not decorate.
 *
 * These are the same metric hues Progress uses, reused so a concept keeps
 * one colour across the whole product: records are bronze wherever they
 * appear, training volume is periwinkle, activity is coral. A member
 * learns the mapping once.
 *
 * Both halves of each pair come from theme.css and are redefined per
 * theme, so every one of these is legible on a light ground and a dark
 * one -- none of it is a hard-coded hex.
 */
export const HUE = {
  active:   { fg: 'var(--m-energy)',   bg: 'var(--m-energy-bg)' },
  workouts: { fg: 'var(--m-training)', bg: 'var(--m-training-bg)' },
  prs:      { fg: 'var(--m-strength)', bg: 'var(--m-strength-bg)' },
  part:     { fg: 'var(--m-body)',     bg: 'var(--m-body-bg)' },
  streak:   { fg: 'var(--m-energy)',   bg: 'var(--m-energy-bg)' },
  recovery: { fg: 'var(--m-recovery)', bg: 'var(--m-recovery-bg)' },
};

/** A challenge is coloured by WHAT IT MEASURES, so the bar itself tells
 *  you whether you are chasing sessions, kilos or records. */
export const challengeHue = (metric) =>
  (metric === 'prs' ? HUE.prs : metric === 'volume' ? HUE.recovery : HUE.workouts);

export function SectionTitle({ children, action }) {
  return (
    <div className="flex items-end justify-between gap-3 mb-2.5">
      <h2 className="text-[11px] font-bold uppercase tracking-[.14em]" style={{ color: 'var(--mute)' }}>
        {children}
      </h2>
      {action}
    </div>
  );
}

/* ══════════════ COMMUNITY PULSE ══════════════ */

/**
 * The four headline numbers. Each is an independent, checkable statement
 * rather than one blended "community score" -- a member should be able to
 * point at any figure and know exactly what was counted.
 */
export function CommunityPulse({ pulse, onOpenPRs, onOpenMembers }) {
  if (!pulse) return null;
  const items = [
    { key: 'active', label: 'active today', value: fmt(pulse.activeToday), hue: HUE.active, onClick: onOpenMembers },
    { key: 'workouts', label: 'workouts this week', value: fmt(pulse.workoutsThisWeek), hue: HUE.workouts },
    { key: 'prs', label: pulse.prsThisWeek === 1 ? 'PR this week' : 'PRs this week', value: fmt(pulse.prsThisWeek), hue: HUE.prs, onClick: pulse.prsThisWeek > 0 ? onOpenPRs : null },
    // participation is null (not 0) when there are no members to divide
    // by -- showing "0%" would be a claim, not a measurement.
    ...(pulse.participation != null
      ? [{ key: 'part', label: 'took part', value: `${pulse.participation}%`, hue: HUE.part }]
      : []),
  ];

  return (
    <div className="grid grid-cols-2 gap-2">
      {items.map((it) => {
        const Tag = it.onClick ? 'button' : 'div';
        return (
          <Tag
            key={it.key}
            {...(it.onClick ? { onClick: it.onClick, type: 'button' } : {})}
            className="rounded-2xl px-3.5 py-3 text-left transition-transform active:scale-[.98] relative overflow-hidden"
            style={{
              background: it.hue.bg,
              border: '1px solid var(--line)',
              minHeight: 76,
              cursor: it.onClick ? 'pointer' : 'default',
            }}
          >
            {/* A hairline of the metric's own colour. Interactive tiles get
                a slightly stronger one so "tappable" is visible without a
                separate affordance. */}
            <span
              aria-hidden="true"
              className="absolute left-0 top-0 bottom-0"
              style={{ width: 3, background: it.hue.fg, opacity: it.onClick ? 1 : 0.45 }}
            />
            <div className="font-black tabular-nums leading-none whitespace-nowrap" style={{ fontSize: 26, color: it.hue.fg }}>
              {it.value}
            </div>
            <div className="text-[10.5px] mt-1.5 leading-snug" style={{ color: 'var(--mute)' }}>
              {it.label}
            </div>
          </Tag>
        );
      })}
    </div>
  );
}

/* ══════════════ YOUR POSITION ══════════════ */

/**
 * Where the member stands, stated plainly and without judgement.
 *
 * Rank is shown as "#8 of 128" -- never as a percentile or a grade, and
 * never with language that implies falling behind. The one comparison
 * offered is against the member's OWN previous week, and only when such a
 * week exists.
 */
export function YourPosition({ position, streak }) {
  if (!position) return null;
  const { rank, members, rankDelta, workouts, previousWorkouts, volume, prs } = position;
  const unranked = rank == null;

  return (
    <div className="rounded-2xl p-4" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
      {/* flex-wrap, not a rigid two-up row: at a squeezed width the rank
          and the streak were rendering on top of each other rather than
          the streak dropping below. */}
      <div className="flex items-start justify-between gap-x-4 gap-y-2 flex-wrap">
        <div className="min-w-0">
          {unranked ? (
            // No workouts this period. This is the moment a leaderboard
            // most easily shames someone, so it says what to do next
            // instead of showing them an empty rank.
            <>
              <div className="font-black leading-none" style={{ fontSize: 22, color: 'var(--ink)' }}>
                Not on the board yet
              </div>
              <div className="text-[12px] mt-1.5" style={{ color: 'var(--mute)' }}>
                Log a workout this week to join {fmt(members)} {members === 1 ? 'member' : 'members'}.
              </div>
            </>
          ) : (
            <>
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="font-black leading-none tabular-nums" style={{ fontSize: 34, color: 'var(--ink)' }}>
                  #{rank}
                </span>
                <span className="text-[12px] whitespace-nowrap" style={{ color: 'var(--mute)' }}>
                  of {fmt(members)}
                </span>
              </div>
              {rankDelta != null && rankDelta !== 0 && (
                <div
                  className="text-[11px] mt-1.5 font-semibold"
                  style={{ color: rankDelta > 0 ? 'var(--good)' : 'var(--mute)' }}
                >
                  {rankDelta > 0
                    ? `Up ${rankDelta} ${rankDelta === 1 ? 'place' : 'places'} from last week`
                    /* Downward movement is stated neutrally and never
                       styled as a failure. */
                    : `${Math.abs(rankDelta)} ${Math.abs(rankDelta) === 1 ? 'place' : 'places'} from last week`}
                </div>
              )}
            </>
          )}
        </div>
        {streak > 0 && (
          <div className="text-right shrink-0">
            <div className="font-black tabular-nums leading-none" style={{ fontSize: 22, color: HUE.streak.fg }}>
              {streak}
            </div>
            <div className="text-[10px] uppercase tracking-[.12em] mt-1 whitespace-nowrap" style={{ color: 'var(--mute)' }}>
              day streak
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 mt-3.5 pt-3.5" style={{ borderTop: '1px solid var(--line)' }}>
        <Stat label="workouts" value={fmt(workouts)} />
        <Stat label="volume" value={volume > 0 ? `${fmtVolume(volume)} kg` : '—'} />
        <Stat label={prs === 1 ? 'PR' : 'PRs'} value={fmt(prs)} />
      </div>

      {previousWorkouts != null && workouts < previousWorkouts && (
        <div className="text-[11px] mt-3" style={{ color: 'var(--mute)' }}>
          {previousWorkouts - workouts === 1
            ? 'One more workout matches last week.'
            : `${previousWorkouts - workouts} more workouts matches last week.`}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="min-w-0">
      {/* whitespace-nowrap + truncate: "10.2k kg" broke after "10.2k" in a
          narrow column and the stray "kg" rendered over the label below.
          A number is one token -- clip it rather than wrap it. */}
      <div
        className="font-bold tabular-nums whitespace-nowrap truncate"
        style={{ fontSize: 15, color: 'var(--ink)' }}
        title={String(value)}
      >
        {value}
      </div>
      <div className="text-[10px] mt-0.5 truncate" style={{ color: 'var(--mute)' }}>{label}</div>
    </div>
  );
}

/* ══════════════ WEEKLY CONSISTENCY RING ══════════════ */

/**
 * The one ring on this page. Rings read as "completion", so using them for
 * several unrelated metrics would flatten the hierarchy and stop any of
 * them meaning anything.
 */
export function ConsistencyRing({ workouts, target }) {
  const goal = Number(target) > 0 ? Number(target) : null;
  if (!goal) return null;
  const pct = Math.min(1, workouts / goal);

  return (
    <div className="rounded-2xl p-4 flex items-center gap-4" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
      <Ring value={pct} size={78} stroke={7} color={HUE.workouts.fg}>
        <span className="font-black tabular-nums" style={{ fontSize: 17, color: HUE.workouts.fg }}>
          {Math.round(pct * 100)}%
        </span>
      </Ring>
      <div className="min-w-0">
        <div className="text-[11px] font-bold uppercase tracking-[.13em]" style={{ color: 'var(--mute)' }}>
          Weekly consistency
        </div>
        <div className="font-black mt-1 tabular-nums" style={{ fontSize: 20, color: 'var(--ink)' }}>
          {workouts} / {goal}
        </div>
        <div className="text-[11px] mt-0.5" style={{ color: 'var(--mute)' }}>
          {workouts >= goal
            ? 'Target met this week.'
            : `${goal - workouts} to go this week.`}
        </div>
      </div>
    </div>
  );
}

/* ══════════════ ACTIVITY CHART ══════════════ */

/** Community workouts per day. Reuses the same chart Progress uses, so
 *  the two pages read identically rather than inventing a second visual
 *  language for the same kind of data. */
export function ActivityChart({ series, todayKey }) {
  const [sel, setSel] = useState(null);
  const points = useMemo(
    () => (series || []).map((d) => ({ date: d.date, value: d.workouts })),
    [series]);
  const total = points.reduce((s, p) => s + p.value, 0);
  // A chart of nothing is decoration. Below this, the numbers above say
  // everything the chart could.
  if (total === 0) return null;

  const day = sel != null ? series[sel] : null;
  const dayLabel = day
    ? new Date(`${day.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
    : null;

  return (
    <div className="rounded-2xl p-3.5" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
      <SectionTitle>Community activity</SectionTitle>
      <PeriodChart
        points={points}
        color={HUE.workouts.fg}
        height={150}
        todayKey={todayKey}
        onSelect={setSel}
        ariaLabel={`Community workouts per day over the last ${points.length} days. Select a day for its detail.`}
      />
      {/* Tapping a day answers "what actually happened then" with the
          three figures that day really has -- not a tooltip repeating the
          bar's own height. */}
      {day ? (
        <div className="mt-3 pt-3 flex items-center justify-between gap-3" style={{ borderTop: '1px solid var(--line)' }}>
          <span className="text-[11.5px] font-semibold" style={{ color: 'var(--ink)' }}>{dayLabel}</span>
          <span className="text-[11.5px] tabular-nums flex gap-2.5">
            <span style={{ color: HUE.workouts.fg }}>{day.workouts} workouts</span>
            <span style={{ color: HUE.active.fg }}>{day.members} active</span>
            {day.prs > 0 && <span style={{ color: HUE.prs.fg }}>{day.prs} PRs</span>}
          </span>
        </div>
      ) : (
        <div className="mt-2 text-[10.5px]" style={{ color: 'var(--faint)' }}>
          Tap a day for its detail.
        </div>
      )}
    </div>
  );
}

/* ══════════════ CHALLENGES ══════════════ */

export function ChallengeCard({ challenge, onOpen }) {
  const c = challenge;
  const isCommunity = c.scope === 'community';
  const shownValue = isCommunity ? c.value : c.yourValue;
  const pct = isCommunity ? c.percent : c.yourPercent;
  const unit = c.metric === 'volume' ? 'kg' : c.metric === 'prs' ? 'PRs' : 'workouts';
  const hue = challengeHue(c.metric);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full text-left rounded-2xl p-3.5 transition-transform active:scale-[.99]"
      style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-bold text-[13.5px] truncate" style={{ color: 'var(--ink)' }}>{c.name}</div>
          <div className="text-[11px] mt-0.5" style={{ color: 'var(--mute)' }}>
            {isCommunity ? 'Everyone together' : 'Your goal'} · {c.metric === 'volume' ? fmtVolume(c.goal) : fmt(c.goal)} {unit}
          </div>
        </div>
        {c.complete && (
          <span className="text-[9px] font-bold uppercase tracking-[.12em] px-2 py-1 rounded-full shrink-0"
                style={{ background: hue.bg, color: hue.fg }}>
            Done
          </span>
        )}
      </div>

      <div className="mt-3 h-2 rounded-full overflow-hidden" style={{ background: hue.bg }}>
        <div
          className="h-full rounded-full"
          style={{
            width: `${pct}%`,
            background: hue.fg,
            transition: 'width .6s cubic-bezier(.22,.8,.3,1)',
          }}
        />
      </div>

      <div className="flex items-center justify-between mt-2 text-[11px]" style={{ color: 'var(--mute)' }}>
        <span className="tabular-nums">
          {c.metric === 'volume' ? fmtVolume(shownValue) : fmt(shownValue)} / {c.metric === 'volume' ? fmtVolume(c.goal) : fmt(c.goal)}
        </span>
        {/* Both halves are counted, never estimated from one another. */}
        {c.membersParticipating > 0 && (
          <span className="tabular-nums">
            {fmt(c.membersCompleted)} of {fmt(c.membersParticipating)} finished
          </span>
        )}
      </div>
    </button>
  );
}

/* ══════════════ STREAKS ══════════════ */

export function StreakBoard({ streaks, you, yourStreak }) {
  const top = (streaks || []).filter((s) => s.value > 0).slice(0, 3);
  if (!top.length && !yourStreak) return null;

  return (
    <div className="rounded-2xl p-3.5" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
      <SectionTitle>Streaks</SectionTitle>
      {top.length > 0 ? (
        <div className="space-y-1.5">
          {top.map((s) => {
            const isYou = s.clientId === you;
            return (
              <div
                key={s.clientId}
                className="flex items-center gap-2.5 rounded-xl px-2.5 py-2"
                style={{
                  background: isYou ? HUE.streak.bg : 'transparent',
                  border: `1px solid ${isYou ? HUE.streak.fg : 'transparent'}`,
                }}
              >
                <span className="tabular-nums text-[11px] w-5" style={{ color: 'var(--faint)' }}>{s.rank}</span>
                <span className="flex-1 min-w-0 truncate text-[12.5px]" style={{ color: 'var(--ink)' }}>
                  {isYou ? 'You' : s.name}
                </span>
                <span className="tabular-nums font-bold text-[12.5px]" style={{ color: HUE.streak.fg }}>
                  {s.value}d
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-[12px]" style={{ color: 'var(--mute)' }}>No active streaks this week.</div>
      )}
    </div>
  );
}

/* ══════════════ WEEKLY RECAP ══════════════ */

export function WeeklyRecap({ recap, you }) {
  if (!recap) return null;
  const hasAny = recap.workouts > 0 || recap.prs > 0 || recap.mostImproved.length > 0;
  if (!hasAny) return null;

  return (
    <div className="rounded-2xl p-3.5" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
      <SectionTitle>This week</SectionTitle>
      <div className="grid grid-cols-3 gap-2">
        <Stat label="workouts" value={fmt(recap.workouts)} />
        <Stat label={recap.prs === 1 ? 'PR' : 'PRs'} value={fmt(recap.prs)} />
        <Stat label={recap.activeMembers === 1 ? 'member active' : 'members active'} value={fmt(recap.activeMembers)} />
      </div>

      {/* Most improved exists so the board is winnable by someone other
          than whoever trains most. It is only rendered when a real
          improvement happened. */}
      {recap.mostImproved.length > 0 && (
        <div className="mt-3.5 pt-3.5" style={{ borderTop: '1px solid var(--line)' }}>
          <div className="text-[10px] uppercase tracking-[.13em] mb-2" style={{ color: 'var(--mute)' }}>
            Most improved
          </div>
          <div className="space-y-1.5">
            {recap.mostImproved.map((m) => (
              <div key={m.clientId} className="flex items-center justify-between gap-3">
                {/* The viewer is "You" everywhere else on this page; seeing
                    your own name in third person here reads as someone
                    else being praised. */}
                <span className="text-[12.5px] truncate" style={{ color: 'var(--ink)' }}>
                  {m.clientId === you ? 'You' : m.name}
                </span>
                <span className="text-[11.5px] tabular-nums font-semibold shrink-0" style={{ color: 'var(--good)' }}>
                  +{m.delta} vs last week
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════ YOU vs YOU ══════════════ */

/** The member's own last four weeks. Community should not be only about
 *  other people -- this is the one board a member always competes on
 *  fairly, because the only other competitor is themselves. */
export function YouVsYou({ trend }) {
  const rows = (trend || []).filter(Boolean);
  const [sel, setSel] = useState(null);
  if (rows.length < 2) return null;
  const anyActivity = rows.some((w) => w.workouts > 0 || w.prs > 0);
  if (!anyActivity) return null;

  const max = Math.max(...rows.map((w) => w.workouts), 1);
  const chosen = sel != null ? rows[sel] : null;

  return (
    <div className="rounded-2xl p-3.5" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
      <SectionTitle>Your last {rows.length} weeks</SectionTitle>
      <div className="flex items-end gap-2" style={{ height: 84 }}>
        {rows.map((w, i) => {
          const h = Math.max(4, (w.workouts / max) * 64);
          const isNow = i === rows.length - 1;
          const on = sel === i;
          return (
            <button
              key={w.start}
              type="button"
              onClick={() => setSel(on ? null : i)}
              aria-pressed={on}
              aria-label={`Week of ${w.start}: ${w.workouts} workouts, ${w.prs} PRs`}
              className="flex-1 flex flex-col items-center justify-end gap-1.5 rounded-md"
            >
              <span className="text-[10px] tabular-nums font-semibold" style={{ color: isNow || on ? 'var(--ink)' : 'var(--mute)' }}>
                {w.workouts}
              </span>
              <div
                className="w-full rounded-md"
                style={{
                  height: h,
                  // The current week is solid; a selected past week lights
                  // up so tapping through the history reads as exploring
                  // rather than as changing something.
                  background: isNow || on ? HUE.workouts.fg : HUE.workouts.bg,
                  outline: on ? `2px solid ${HUE.workouts.fg}` : 'none',
                  outlineOffset: 1,
                  transition: 'height .5s cubic-bezier(.22,.8,.3,1), background .2s',
                }}
              />
              <span className="text-[9px]" style={{ color: 'var(--faint)' }}>
                {isNow ? 'now' : `-${rows.length - 1 - i}w`}
              </span>
            </button>
          );
        })}
      </div>
      {chosen && (
        <div className="mt-2.5 pt-2.5 text-[11.5px] flex items-center justify-between" style={{ borderTop: '1px solid var(--line)', color: 'var(--mute)' }}>
          <span>Week of {chosen.start}</span>
          <span className="tabular-nums">
            <span style={{ color: HUE.workouts.fg }}>{chosen.workouts} workouts</span>
            {chosen.prs > 0 && <span style={{ color: HUE.prs.fg }}> · {chosen.prs} PRs</span>}
          </span>
        </div>
      )}
    </div>
  );
}

/* ══════════════ MOMENTS ══════════════ */

/**
 * One short, true sentence about right now, chosen from real aggregates.
 * Deliberately NOT a rotating set of motivational slogans: every line
 * here is a fact the member could verify on this same page.
 */
export function CommunityMoment({ pulse, busiestWeekday }) {
  const line = useMemo(() => {
    if (!pulse) return null;
    if (pulse.activeToday >= 3) {
      return `${pulse.activeToday} members have trained today.`;
    }
    if (pulse.prsThisWeek > 0) {
      return `${pulse.prsThisWeek} personal ${pulse.prsThisWeek === 1 ? 'record' : 'records'} set this week.`;
    }
    if (pulse.workoutsThisWeek > 0) {
      return `${pulse.workoutsThisWeek} ${pulse.workoutsThisWeek === 1 ? 'workout' : 'workouts'} logged this week.`;
    }
    if (busiestWeekday) {
      const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      return `${names[busiestWeekday.dow]} is this gym's busiest day.`;
    }
    return null;
  }, [pulse, busiestWeekday]);

  if (!line) return null;
  return (
    <div className="text-[12.5px] leading-relaxed px-1" style={{ color: 'var(--mute)' }}>
      {line}
    </div>
  );
}
