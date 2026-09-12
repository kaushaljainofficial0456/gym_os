/**
 * TRAINERS — the owner's staff list.
 *
 * WHAT DID NOT EXIST BEFORE. Anything. A gym owner could see members,
 * revenue, packages and attendance, but had no view of the people doing
 * the actual coaching: no list, no roster sizes, no capacity. The two
 * questions that decide every new client — "who has room" and "who is
 * carrying too many" — were answerable only by opening clients one at a
 * time and reading the trainer field off each one.
 *
 * SO THE PAGE IS ABOUT LOAD, NOT ABOUT PROFILES. Names and emails are
 * the least interesting thing here; the ratio of clients to capacity is
 * what the owner is here to act on, so it gets the ring.
 *
 * CAPACITY WITH NO CEILING IS NOT ZERO. A trainer whose max_clients has
 * never been set shows "no limit set", not an empty ring implying they
 * are wide open — the app does not know, and guessing on this one leads
 * to overloading a real person.
 */
import { useMemo, useState } from 'react';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { Card, Kicker, Ring, ErrorState, Empty, PageSkeleton, Avatar } from '../../components/UI.jsx';

/** Load bands. Deliberately conservative: "at capacity" starts before
 *  100%, because a trainer at 95% has effectively no room for the next
 *  person walking through the door. */
function loadTone(pct) {
  if (pct == null) return { color: 'var(--mute)', label: 'No limit set' };
  if (pct >= 95) return { color: 'var(--m-energy)', label: 'At capacity' };
  if (pct >= 75) return { color: 'var(--m-strength)', label: 'Filling up' };
  return { color: 'var(--m-body)', label: 'Has room' };
}

export default function Trainers() {
  const { data, loading, error, reload } = useFetch(() => api('/admin/trainers'));
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('load');

  const trainers = data?.trainers || [];

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = trainers;
    if (q) {
      rows = rows.filter((t) => [t.name, t.email, t.specialization]
        .filter(Boolean).join(' ').toLowerCase().includes(q));
    }
    const out = [...rows];
    if (sort === 'name') {
      out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    } else if (sort === 'clients') {
      out.sort((a, b) => b.activeClientCount - a.activeClientCount);
    } else {
      // Busiest first. A trainer with no ceiling set has an unknown load
      // and sorts last -- not as though they were empty.
      out.sort((a, b) => {
        if (a.loadPct == null && b.loadPct == null) return 0;
        if (a.loadPct == null) return 1;
        if (b.loadPct == null) return -1;
        return b.loadPct - a.loadPct;
      });
    }
    return out;
  }, [trainers, query, sort]);

  const totals = useMemo(() => ({
    coaching: trainers.reduce((n, t) => n + t.activeClientCount, 0),
    atCapacity: trainers.filter((t) => t.loadPct != null && t.loadPct >= 95).length,
    noLimit: trainers.filter((t) => t.loadPct == null).length,
  }), [trainers]);

  if (loading) return <PageSkeleton variant="list" label="Loading trainers" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  return (
    <div className="space-y-5 pb-8">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-grotesk font-bold text-2xl tracking-tight">Trainers</h1>
          <p className="text-mute text-sm">
            {trainers.length} {trainers.length === 1 ? 'trainer' : 'trainers'} · {totals.coaching} clients coached
          </p>
        </div>
      </div>

      {/* The two facts worth acting on, stated before the list. Both are
          links into the list rather than dead numbers. */}
      {(data?.unassigned > 0 || totals.atCapacity > 0) && (
        <div className="flex flex-wrap gap-2">
          {data?.unassigned > 0 && (
            <div
              className="rounded-xl px-3 py-2 text-[12px]"
              style={{ background: 'rgb(var(--bad-rgb) / .10)', border: '1px solid var(--bad)', color: 'var(--bad)' }}
            >
              <strong className="tabular-nums">{data.unassigned}</strong>{' '}
              {data.unassigned === 1 ? 'client has' : 'clients have'} no trainer assigned
            </div>
          )}
          {totals.atCapacity > 0 && (
            <div
              className="rounded-xl px-3 py-2 text-[12px]"
              style={{ background: 'rgb(var(--warn-rgb) / .10)', border: '1px solid var(--warn)', color: 'var(--warn)' }}
            >
              <strong className="tabular-nums">{totals.atCapacity}</strong> at capacity
            </div>
          )}
        </div>
      )}

      {trainers.length === 0 ? (
        <Empty
          title="No trainers yet"
          hint="Trainers appear here once they join your gym with the trainer enrollment code."
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search trainers"
              aria-label="Search trainers"
              className="input text-[13px]"
              style={{ minHeight: 40, maxWidth: 240 }}
            />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              aria-label="Sort trainers"
              className="input text-[12px] ml-auto"
              style={{ minHeight: 40, maxWidth: 180 }}
            >
              <option value="load">Sort: Busiest</option>
              <option value="clients">Sort: Most clients</option>
              <option value="name">Sort: Name</option>
            </select>
          </div>

          <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {shown.map((t) => <TrainerCard key={t.id} t={t} />)}
          </div>

          {!shown.length && (
            <div className="py-10 text-center">
              <div className="text-[12.5px] font-semibold" style={{ color: 'var(--ink)' }}>
                No trainers match “{query.trim()}”
              </div>
              <button
                type="button" onClick={() => setQuery('')}
                className="text-[11.5px] mt-1.5 font-semibold" style={{ color: 'var(--accent)' }}
              >
                Clear search
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TrainerCard({ t }) {
  const tone = loadTone(t.loadPct);
  return (
    <Card className="!p-4">
      <div className="flex items-start gap-3">
        <Avatar name={t.name} src={t.avatar} size="w-11 h-11" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-grotesk font-semibold text-[14px] truncate" style={{ color: 'var(--ink)' }}>
              {t.name}
            </span>
            {/* An inactive trainer still holds clients, which is exactly
                why it must be visible here rather than filtered away. */}
            {!t.active && (
              <span className="rounded-md px-1.5 py-0.5 text-[9.5px] font-bold"
                style={{ color: 'var(--mute)', border: '1px solid var(--line)' }}>INACTIVE</span>
            )}
          </div>
          <div className="text-[11px] truncate" style={{ color: 'var(--faint)' }}>{t.email}</div>
          {t.specialization && (
            <div className="text-[11px] mt-1 truncate" style={{ color: 'var(--mute)' }}>{t.specialization}</div>
          )}
        </div>

        <div className="shrink-0">
          <Ring
            value={t.loadPct ?? 0}
            max={100}
            size={64}
            stroke={7}
            color={t.loadPct == null ? 'var(--line)' : tone.color}
            label={t.loadPct == null ? '—' : `${t.loadPct}%`}
          />
        </div>
      </div>

      <div className="flex items-center justify-between mt-3 pt-3" style={{ borderTop: '1px solid var(--line)' }}>
        <span className="text-[11.5px] tabular-nums" style={{ color: 'var(--mute)' }}>
          <strong style={{ color: 'var(--ink)' }}>{t.activeClientCount}</strong>
          {t.maxClients > 0 ? ` of ${t.maxClients}` : ''} active
          {/* Inactive clients are counted separately rather than folded
              in: they are on the books but not being coached, and
              conflating the two overstates real load. */}
          {t.clientCount > t.activeClientCount && (
            <span style={{ color: 'var(--faint)' }}> · {t.clientCount - t.activeClientCount} inactive</span>
          )}
        </span>
        <span className="text-[10.5px] font-semibold" style={{ color: tone.color }}>{tone.label}</span>
      </div>
    </Card>
  );
}
