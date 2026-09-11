/**
 * TRAINING HISTORY — every session, not the last five.
 *
 * The Workout page's "Recent sessions" card showed five rows and stopped.
 * There was no route to anything older, so a member six months in could
 * see 2% of their own training. This is the rest of it.
 *
 * WHAT MAKES A HISTORY ROW WORTH TAPPING. The old rows carried a name, a
 * raw ISO date and a status chip -- nothing that distinguishes one "Leg
 * Day" from the four other "Leg Day"s above it. Each row here states what
 * the session actually WAS: how long, how many working sets, how much was
 * moved. That is also what makes the list scannable: you find the session
 * you are looking for by its size, not by re-reading the same name.
 *
 * Dates are grouped into months and written for humans. Nothing here
 * re-derives a number -- duration, sets and volume all come from the
 * tracking endpoint, which computes them from the set logs.
 */
import { useState, useCallback, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { ErrorState, PageSkeleton } from '../../components/UI.jsx';

const PAGE = 25;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Tue 10 Sep" — a date a person reads, rather than 2026-09-10. Parsed at
 *  noon UTC so a timezone offset can never shift the calendar day. */
function dayLabel(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)}`;
}

function monthLabel(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return 'Earlier';
  const now = new Date();
  const sameYear = d.getUTCFullYear() === now.getFullYear();
  return sameYear ? MONTHS[d.getUTCMonth()] : `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const fmtVolume = (kg) => {
  const n = Number(kg) || 0;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k kg`;
  return `${Math.round(n)} kg`;
};

const FILTERS = [['all', 'All'], ['completed', 'Completed'], ['missed', 'Not done']];

export default function SessionHistory() {
  const nav = useNavigate();
  const [rows, setRows] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('all');

  const fetchPage = useCallback(async (off) => {
    const res = await api(`/tracking/me/workouts?limit=${PAGE}&offset=${off}`);
    return res;
  }, []);

  useEffect(() => {
    let alive = true;
    fetchPage(0)
      .then((res) => {
        if (!alive) return;
        setRows(res.workouts || []);
        setHasMore(!!res.hasMore);
        setOffset((res.workouts || []).length);
      })
      .catch((e) => { if (alive) { setErr(e.message || 'Could not load your history'); setRows([]); } });
    return () => { alive = false; };
  }, [fetchPage]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const res = await fetchPage(offset);
      // Offset pagination can repeat a row if something was inserted
      // between pages; ids are the guard.
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...(res.workouts || []).filter((r) => !seen.has(r.id))];
      });
      setHasMore(!!res.hasMore);
      setOffset((o) => o + (res.workouts || []).length);
    } catch (e) {
      setErr(e.message || 'Could not load more');
    }
    setLoadingMore(false);
  };

  const shown = useMemo(() => {
    const list = rows || [];
    if (filter === 'completed') return list.filter((w) => w.status === 'completed');
    if (filter === 'missed') return list.filter((w) => w.status !== 'completed');
    return list;
  }, [rows, filter]);

  // Month headers, in the order the rows already arrive (newest first).
  const grouped = useMemo(() => {
    const out = [];
    let current = null;
    for (const w of shown) {
      const m = monthLabel(w.scheduled_date);
      if (m !== current) { out.push({ month: m, items: [] }); current = m; }
      out[out.length - 1].items.push(w);
    }
    return out;
  }, [shown]);

  const completedCount = (rows || []).filter((w) => w.status === 'completed').length;

  if (rows === null) return <PageSkeleton />;
  if (err && !rows.length) return <ErrorState message={err} onRetry={() => window.location.reload()} />;

  return (
    <div className="pb-24">
      <header className="mb-4">
        <button
          type="button"
          onClick={() => nav('/app/client/workout')}
          className="text-[11.5px] mb-2 rounded-lg"
          style={{ minHeight: 32, color: 'var(--mute)' }}
        >
          ← Workout
        </button>
        <h1 className="font-black leading-tight" style={{ fontSize: 24, color: 'var(--ink)' }}>
          Training history
        </h1>
        <div className="text-[12px] mt-1" style={{ color: 'var(--mute)' }}>
          {completedCount} completed{hasMore ? ' so far' : ''}
          {rows.length !== completedCount && ` · ${rows.length - completedCount} not done`}
        </div>
      </header>

      <div className="flex gap-1.5 mb-4" role="tablist" aria-label="Filter sessions">
        {FILTERS.map(([key, label]) => {
          const on = filter === key;
          return (
            <button
              key={key}
              role="tab"
              aria-selected={on}
              onClick={() => setFilter(key)}
              className="flex-1 rounded-xl text-[11.5px] font-semibold"
              style={{
                minHeight: 38,
                background: on ? 'var(--accent-soft)' : 'transparent',
                border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
                color: on ? 'var(--accent)' : 'var(--mute)',
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {shown.length === 0 ? (
        <div className="rounded-2xl p-6 text-center" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
          <div className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
            {filter === 'all' ? 'No sessions yet' : 'Nothing matches that filter'}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {grouped.map((g) => (
            <section key={g.month}>
              <h2 className="text-[10.5px] uppercase tracking-[.14em] font-bold mb-2 px-0.5" style={{ color: 'var(--mute)' }}>
                {g.month}
              </h2>
              <div className="space-y-1.5">
                {g.items.map((w) => <SessionRow key={w.id} w={w} onOpen={() => nav(`/app/client/day/${w.scheduled_date}`)} />)}
              </div>
            </section>
          ))}
        </div>
      )}

      {hasMore && (
        <button
          type="button"
          onClick={loadMore}
          disabled={loadingMore}
          className="w-full mt-4 rounded-xl text-[12.5px] font-semibold"
          style={{ minHeight: 46, border: '1px solid var(--line)', color: 'var(--mute)' }}
        >
          {loadingMore ? 'Loading…' : 'Load older sessions'}
        </button>
      )}
      {err && rows.length > 0 && (
        <div className="text-[11.5px] mt-3 text-center" style={{ color: 'var(--bad)' }}>{err}</div>
      )}
    </div>
  );
}

/** One session. The metrics row is the point: it is what tells two
 *  identically-named sessions apart. Only figures the session actually
 *  has are rendered -- a "0 kg" on a bodyweight day would be a false
 *  statement about the session rather than a missing value. */
export function SessionRow({ w, onOpen, compact = false }) {
  const done = w.status === 'completed';
  const metrics = [
    // A rounded 0 min reads as a bug; below a minute the duration is
    // not a fact worth stating.
    w.duration_min && Math.round(w.duration_min) >= 1 ? `${Math.round(w.duration_min)} min` : null,
    w.completed_sets ? `${w.completed_sets} ${w.completed_sets === 1 ? 'set' : 'sets'}` : null,
    w.volume_kg ? fmtVolume(w.volume_kg) : null,
    !w.completed_sets && w.exercises?.length
      ? `${w.exercises.length} ${w.exercises.length === 1 ? 'exercise' : 'exercises'}` : null,
  ].filter(Boolean);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full flex items-center gap-3 rounded-xl px-3 text-left transition-transform active:scale-[.99]"
      style={{
        minHeight: compact ? 52 : 58,
        background: 'var(--panel)',
        border: '1px solid var(--line)',
      }}
    >
      {/* A status rail rather than a chip in the flow: it colours the row
          without competing with the name for horizontal space, which is
          what pushed the old layout's date into a different position on
          every row. */}
      <span
        aria-hidden="true"
        className="shrink-0 rounded-full"
        style={{ width: 3, height: compact ? 26 : 30, background: done ? 'var(--good)' : 'var(--line)' }}
      />
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] font-semibold truncate" style={{ color: 'var(--ink)' }}>
          {w.name}
        </span>
        <span className="block text-[10.5px] mt-0.5 truncate" style={{ color: 'var(--mute)' }}>
          {metrics.length ? metrics.join(' · ') : (done ? 'Completed' : 'Not completed')}
        </span>
      </span>
      {/* Fixed-width, right-aligned, tabular: the dates line up as a
          column instead of floating wherever the name ended. */}
      <span
        className="shrink-0 text-[11px] tabular-nums text-right"
        style={{ color: done ? 'var(--mute)' : 'var(--faint)', width: 76 }}
      >
        {dayLabel(w.scheduled_date)}
      </span>
    </button>
  );
}
