/**
 * MEMBERS TABLE — the owner's roster, made usable past about thirty rows.
 *
 * WHAT THIS REPLACES. Every member the gym has ever had, rendered in one
 * unbroken alphabetical table with no search, no filter, no sort and no
 * empty state. That is serviceable for a studio with twenty members and
 * useless for the 200-member gym this product is sold to: the two
 * questions an owner actually opens this screen to answer -- "who is
 * overdue" and "whose plan runs out this week" -- both required reading
 * every row.
 *
 * So the filters are those questions, not a generic column-sorter:
 * payment state and membership lifecycle are the two axes that decide
 * whether somebody needs chasing.
 *
 * ON DATES. The old cell printed end_date.slice(5) -- "09-12", no year,
 * and ambiguous between September 12th and December 9th depending on who
 * is reading. Renewal dates are money, so they are spelled out, and the
 * urgent ones say how long is left rather than making the reader subtract
 * today's date from a string.
 */
import { useMemo, useState } from 'react';
import { Empty } from '../UI.jsx';
import { GOAL_LABEL } from '../../utils.js';

const PAYMENT_FILTERS = [
  ['', 'All'],
  ['overdue', 'Overdue'],
  ['due', 'Due'],
  ['paid', 'Paid'],
];

/* Every state the membership lifecycle graph can be in. The list is
   deliberately exhaustive: a state missing from here renders as neutral
   grey, which would quietly disguise SUSPENDED and REFUND_PENDING -- two
   states that specifically mean somebody needs to act. */
const MEMBERSHIP_TONE = {
  ACTIVE: { color: 'var(--good)', bg: 'rgb(var(--good-rgb) / .12)' },
  PAUSED: { color: 'var(--warn)', bg: 'rgb(var(--warn-rgb) / .12)' },
  SUSPENDED: { color: 'var(--warn)', bg: 'rgb(var(--warn-rgb) / .12)' },
  REFUND_PENDING: { color: 'var(--warn)', bg: 'rgb(var(--warn-rgb) / .12)' },
  EXPIRED: { color: 'var(--bad)', bg: 'rgb(var(--bad-rgb) / .12)' },
  CANCELLED: { color: 'var(--mute)', bg: 'transparent' },
  REFUNDED: { color: 'var(--mute)', bg: 'transparent' },
};

const PAYMENT_TONE = {
  paid: { color: 'var(--good)', bg: 'rgb(var(--good-rgb) / .12)' },
  overdue: { color: 'var(--bad)', bg: 'rgb(var(--bad-rgb) / .12)' },
  due: { color: 'var(--warn)', bg: 'rgb(var(--warn-rgb) / .12)' },
};

/** Days from today to an ISO date. Negative means it already passed. */
function daysUntil(iso) {
  if (!iso) return null;
  const then = Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((then - today) / 86400000);
}

/** "12 Sep 2026", plus urgency when the date is close or past. */
function renewalLabel(iso) {
  if (!iso) return { text: '—', urgent: false, muted: true };
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return { text: '—', urgent: false, muted: true };
  const text = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const n = daysUntil(iso);
  if (n == null) return { text, urgent: false };
  if (n < 0) return { text, note: `${Math.abs(n)}d overdue`, urgent: true };
  if (n === 0) return { text, note: 'today', urgent: true };
  if (n <= 7) return { text, note: `in ${n}d`, urgent: true };
  return { text, urgent: false };
}

export default function MembersTable({ members = [], renderActions }) {
  const [query, setQuery] = useState('');
  const [payment, setPayment] = useState('');
  const [sort, setSort] = useState('name');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = members;
    if (q) {
      rows = rows.filter((m) => [m.name, m.plan_name, GOAL_LABEL[m.goal] || m.goal]
        .filter(Boolean).join(' ').toLowerCase().includes(q));
    }
    if (payment) rows = rows.filter((m) => (m.payment_status || '') === payment);

    const out = [...rows];
    if (sort === 'renewal') {
      // Soonest first, and members with no renewal date last -- they are
      // not "due in 1970", they simply have no subscription.
      out.sort((a, b) => {
        const x = daysUntil(a.end_date); const y = daysUntil(b.end_date);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return x - y;
      });
    } else if (sort === 'status') {
      const rank = { overdue: 0, due: 1, paid: 2 };
      out.sort((a, b) => (rank[a.payment_status] ?? 9) - (rank[b.payment_status] ?? 9)
        || String(a.name || '').localeCompare(String(b.name || '')));
    } else {
      out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    }
    return out;
  }, [members, query, payment, sort]);

  // How many need chasing, stated before the table rather than discovered
  // by scrolling it.
  const overdue = useMemo(() => members.filter((m) => m.payment_status === 'overdue').length, [members]);
  const dueSoon = useMemo(() => members.filter((m) => {
    const n = daysUntil(m.end_date);
    return n != null && n >= 0 && n <= 7;
  }).length, [members]);

  if (!members.length) {
    return <Empty title="No members yet" hint="Members appear here once they are added to the gym." />;
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search members or plans"
          aria-label="Search members or plans"
          className="input text-[13px]"
          style={{ minHeight: 40, maxWidth: 240 }}
        />
        <div className="flex gap-1.5 flex-wrap">
          {PAYMENT_FILTERS.map(([value, label]) => (
            <Chip key={label} on={payment === value} onClick={() => setPayment(value)}>{label}</Chip>
          ))}
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          aria-label="Sort members"
          className="input text-[12px] ml-auto"
          style={{ minHeight: 40, maxWidth: 170 }}
        >
          <option value="name">Sort: Name</option>
          <option value="renewal">Sort: Renewal date</option>
          <option value="status">Sort: Payment status</option>
        </select>
      </div>

      {(overdue > 0 || dueSoon > 0) && (
        <div className="flex flex-wrap gap-3 mb-3 text-[11.5px]">
          {overdue > 0 && (
            <button type="button" onClick={() => setPayment('overdue')} className="font-semibold" style={{ color: 'var(--bad)' }}>
              {overdue} overdue
            </button>
          )}
          {dueSoon > 0 && (
            <button type="button" onClick={() => setSort('renewal')} className="font-semibold" style={{ color: 'var(--warn)' }}>
              {dueSoon} renewing within 7 days
            </button>
          )}
        </div>
      )}

      <div className="text-[11px] mb-2" style={{ color: 'var(--mute)' }}>
        {shown.length === members.length
          ? `${members.length} members`
          : `${shown.length} of ${members.length} members`}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider font-grotesk"
              style={{ color: 'var(--mute)', borderBottom: '1px solid var(--line)' }}>
              <th className="py-2.5 pr-3 font-semibold">Member</th>
              <th className="py-2.5 pr-3 font-semibold">Goal</th>
              <th className="py-2.5 pr-3 font-semibold">Weight</th>
              <th className="py-2.5 pr-3 font-semibold">Plan</th>
              <th className="py-2.5 pr-3 font-semibold">Renews</th>
              <th className="py-2.5 pr-3 font-semibold">Payment</th>
              <th className="py-2.5 pr-3 font-semibold">Membership</th>
              <th className="py-2.5 pr-3 font-semibold" />
            </tr>
          </thead>
          <tbody>
            {shown.map((m) => {
              const renew = renewalLabel(m.end_date);
              return (
                <tr key={m.id} style={{ borderBottom: '1px solid rgb(var(--line-rgb, 128 128 128) / .3)' }}>
                  <td className="py-2.5 pr-3 font-grotesk font-semibold" style={{ color: 'var(--ink)' }}>{m.name}</td>
                  <td className="py-2.5 pr-3 text-xs" style={{ color: 'var(--mute)' }}>
                    {GOAL_LABEL[m.goal] || String(m.goal || '').replace(/_/g, ' ') || '—'}
                  </td>
                  <td className="py-2.5 pr-3 text-xs tabular-nums">{m.current_weight ? `${m.current_weight} kg` : '—'}</td>
                  <td className="py-2.5 pr-3 text-xs">{m.plan_name || '—'}</td>
                  <td className="py-2.5 pr-3 text-xs tabular-nums whitespace-nowrap">
                    <span style={{ color: renew.muted ? 'var(--faint)' : 'var(--ink)' }}>{renew.text}</span>
                    {renew.note && (
                      <span className="ml-1.5 font-semibold" style={{ color: renew.urgent ? 'var(--bad)' : 'var(--mute)' }}>
                        {renew.note}
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 pr-3">
                    <Tag tone={PAYMENT_TONE[m.payment_status]}>{(m.payment_status || '—').toUpperCase()}</Tag>
                  </td>
                  <td className="py-2.5 pr-3">
                    {m.lifecycle_status
                      ? <Tag tone={MEMBERSHIP_TONE[m.lifecycle_status]}>{m.lifecycle_status}</Tag>
                      : <span className="text-xs" style={{ color: 'var(--faint)' }}>—</span>}
                  </td>
                  <td className="py-2.5 pr-3">{renderActions?.(m)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {!shown.length && (
          <div className="py-10 text-center">
            <div className="text-[12.5px] font-semibold" style={{ color: 'var(--ink)' }}>No members match this filter</div>
            <button
              type="button"
              onClick={() => { setQuery(''); setPayment(''); }}
              className="text-[11.5px] mt-1.5 font-semibold"
              style={{ color: 'var(--accent)' }}
            >
              Clear filters
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Tag({ children, tone }) {
  const t = tone || { color: 'var(--mute)', bg: 'transparent' };
  return (
    <span
      className="inline-block rounded-md px-2 py-0.5 text-[10px] font-bold tracking-wide"
      style={{ color: t.color, background: t.bg, border: `1px solid ${t.color === 'var(--mute)' ? 'var(--line)' : t.color}` }}
    >{children}</span>
  );
}

function Chip({ children, on, onClick }) {
  return (
    <button
      type="button" onClick={onClick} aria-pressed={on}
      className="rounded-lg px-2.5 text-[11px] font-semibold shrink-0"
      style={{
        minHeight: 32,
        background: on ? 'var(--accent-soft)' : 'transparent',
        border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
        color: on ? 'var(--accent)' : 'var(--mute)',
      }}
    >{children}</button>
  );
}
