import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch, GOAL_LABEL, STATUS_META, cls } from '../../utils.js';
import { Card, Kicker, ErrorState, Modal, StatusChip, PageSkeleton } from '../../components/UI.jsx';

const STATUS_FILTERS = ['ALL', 'ON_TRACK', 'NEEDS_ATTENTION', 'AT_RISK', 'INACTIVE'];

/** MEMBERSHIP, IN WORDS. The roster showed how someone was TRAINING and
 *  nothing about whether they were paid up -- the first thing an owner
 *  scans for. "No membership" is stated rather than left blank, because
 *  blank reads as a loading bug and is genuinely different from lapsed. */
function MembershipPill({ membership }) {
  if (!membership) {
    return <span className="text-[11px]" style={{ color: 'var(--faint)' }}>No membership</span>;
  }
  const owing = ['pending', 'overdue', 'failed'].includes(membership.paymentStatus);
  const days = membership.endDate
    ? Math.round((Date.parse(`${membership.endDate}T00:00:00Z`) - Date.now()) / 86400000)
    : null;

  /* THE END DATE WINS OVER THE STATUS COLUMN.
     Nothing in this app expires a subscription on a schedule, so rows sit
     at status 'active' long after they have run out -- the seed has one
     that ended in April still marked active. Trusting the column would
     print "Active" in green next to a membership five months dead, which
     is the single most expensive thing this pill could get wrong. The
     date is a fact; the column is a stale opinion. */
  const lapsed = membership.status === 'active' && days != null && days < 0;
  const expiring = membership.status === 'active' && days != null && days >= 0 && days <= 30;

  const tone = owing || lapsed ? 'var(--bad)'
    : expiring ? 'var(--warn)'
      : membership.status === 'active' ? 'var(--good)' : 'var(--mute)';
  const label = owing
    ? (membership.paymentStatus === 'overdue' ? 'Overdue' : 'Payment due')
    : lapsed ? 'Lapsed'
      : expiring ? `Ends in ${days}d`
        : membership.status.charAt(0).toUpperCase() + membership.status.slice(1);

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: tone }} aria-hidden="true" />
      <span className="text-[11px] font-semibold" style={{ color: tone }}>{label}</span>
    </span>
  );
}

export default function Clients() {
  const { data, loading, error, reload } = useFetch(() => api('/clients'));
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('ALL');
  const [sort, setSort] = useState('status');
  const [trainerId, setTrainerId] = useState('ALL');
  const [money, setMoney] = useState('ALL');
  const [createOpen, setCreateOpen] = useState(false);

  /* The trainers who actually have clients here, built from the roster
     rather than fetched -- a filter listing coaches with nobody assigned
     is four options that all return an empty list. */
  const trainerOptions = useMemo(() => {
    const seen = new Map();
    for (const c of data?.clients || []) {
      if (c.trainerId && c.trainerName && !seen.has(c.trainerId)) seen.set(c.trainerId, c.trainerName);
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);

  /* THE SORT CONTROL DID NOTHING. `sort` was declared and bound to the
     select, and then never read -- this memo filtered and returned, so
     picking "Sort: Adherence" re-rendered the identical list. Four dead
     options on a roster screen, which is exactly where a trainer needs
     to ask "who is slipping" and sort by adherence to find out.

     Status order is by urgency, not alphabet: at-risk first, because the
     point of the default view is what needs doing. Nulls always sort to
     the END regardless of direction -- a client with no adherence data
     is not the worst performer, they are unmeasured, and letting them
     occupy the top of an ascending sort buries the people who actually
     need attention. */
  const filtered = useMemo(() => {
    let rows = data?.clients || [];
    // Email too: half of finding a client is having their address from a
    // payment or a message, not their exact spelling.
    if (q) {
      const needle = q.toLowerCase();
      rows = rows.filter((c) => (c.name || '').toLowerCase().includes(needle)
        || (c.email || '').toLowerCase().includes(needle));
    }
    if (status !== 'ALL') rows = rows.filter((c) => c.status === status);
    if (trainerId !== 'ALL') {
      rows = trainerId === 'NONE'
        ? rows.filter((c) => !c.trainerId)
        : rows.filter((c) => c.trainerId === trainerId);
    }
    if (money !== 'ALL') {
      rows = rows.filter((c) => {
        const m = c.membership;
        if (money === 'NONE') return !m;
        if (!m) return false;
        if (money === 'OWING') {
          if (['pending', 'overdue', 'failed'].includes(m.paymentStatus)) return true;
          // A membership past its end date is money to collect too, even
          // when the row still claims to be active -- see MembershipPill.
          return m.status === 'active' && m.endDate
            && Date.parse(`${m.endDate}T00:00:00Z`) < Date.now();
        }
        if (money === 'EXPIRING') {
          if (m.status !== 'active' || !m.endDate) return false;
          const days = (Date.parse(`${m.endDate}T00:00:00Z`) - Date.now()) / 86400000;
          return days >= 0 && days <= 30;
        }
        return true;
      });
    }

    const URGENCY = { AT_RISK: 0, NEEDS_ATTENTION: 1, ON_TRACK: 2, INACTIVE: 3 };
    const nullsLast = (a, b, pick, dir = 1) => {
      const x = pick(a); const y = pick(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x - y) * dir;
    };

    const out = [...rows];
    if (sort === 'name') {
      out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    } else if (sort === 'adherence') {
      // Ascending: the people slipping are the ones worth looking at.
      out.sort((a, b) => nullsLast(a, b, (c) => c.adherence, 1));
    } else if (sort === 'change') {
      out.sort((a, b) => nullsLast(a, b, (c) => c.change7, 1));
    } else {
      out.sort((a, b) => (URGENCY[a.status] ?? 9) - (URGENCY[b.status] ?? 9)
        || String(a.name || '').localeCompare(String(b.name || '')));
    }
    return out;
  }, [data, q, status, sort, trainerId, money]);

  if (loading) return <PageSkeleton variant="list" label="Loading clients" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between flex-wrap gap-3 anim-fadeUp">
        <div>
          <h1 className="font-grotesk font-bold text-2xl tracking-tight">Clients</h1>
          <p className="text-mute text-sm">{filtered.length} of {data.clients.length} shown</p>
        </div>
        <button className="btn-primary" onClick={() => setCreateOpen(true)} data-tour="trainer-clients-new">+ New client</button>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap gap-2 items-center">
          <input className="input flex-1 min-w-[200px] sm:!w-56 sm:flex-none"
                 placeholder="Search name or email…" aria-label="Search clients"
                 value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input !w-40" value={sort} aria-label="Sort clients" onChange={(e) => setSort(e.target.value)}>
            <option value="status">Sort: Status</option>
            <option value="name">Sort: Name</option>
            <option value="adherence">Sort: Adherence</option>
            <option value="change">Sort: Weight change</option>
          </select>

          {/* WHO COACHES THEM and WHERE THE MONEY STANDS -- the two things
              an owner filters a roster by, and neither existed. The
              trainer list is built from the roster itself, so it never
              offers a coach with nobody assigned. */}
          {trainerOptions.length > 0 && (
            <select className="input !w-44" value={trainerId} aria-label="Filter by trainer"
                    onChange={(e) => setTrainerId(e.target.value)}>
              <option value="ALL">Any trainer</option>
              {trainerOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              <option value="NONE">No trainer</option>
            </select>
          )}

          <select className="input !w-44" value={money} aria-label="Filter by membership"
                  onChange={(e) => setMoney(e.target.value)}>
            <option value="ALL">Any membership</option>
            <option value="OWING">Payment outstanding</option>
            <option value="EXPIRING">Expiring in 30 days</option>
            <option value="NONE">No membership</option>
          </select>
        </div>

        <div className="flex gap-1.5 flex-wrap">
          {STATUS_FILTERS.map((s) => (
            <button key={s} className={cls('chip', status === s && '!border-gold/50 !text-gold !bg-gold/10')}
              aria-pressed={status === s}
              onClick={() => setStatus(s)}>{s === 'ALL' ? 'All' : STATUS_META[s].label}</button>
          ))}
        </div>
      </div>

      {/* CARDS ON A PHONE, TABLE ON A DESKTOP. This was one table at
          min-width 820px inside a horizontal scroller, so on a 375px
          screen you read a roster by dragging it sideways, a column at a
          time, with the client's name scrolled off before you reached
          their status. A table is the right shape for comparing many rows
          at once and the wrong one for a screen that fits two columns. */}
      <div className="sm:hidden space-y-2" data-tour="trainer-clients-list">
        {filtered.map((c) => (
          <Link key={c.id} to={`/app/trainer/clients/${c.id}`}
                className="card p-3.5 block active:scale-[.99] transition-transform">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full grid place-items-center shrink-0 font-grotesk text-xs font-bold"
                   style={{ background: 'var(--bg2)', border: '1px solid var(--line)' }}>
                {c.name[0]}
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-grotesk font-semibold text-[13.5px] truncate">{c.name}</div>
                <div className="text-[10.5px] truncate" style={{ color: 'var(--faint)' }}>
                  {GOAL_LABEL[c.goal] || c.goal}{c.trainerName ? ` · ${c.trainerName}` : ' · Unassigned'}
                </div>
              </div>
              <StatusChip status={c.status} />
            </div>

            <div className="flex items-center justify-between gap-2 mt-3 pt-3" style={{ borderTop: '1px solid var(--line)' }}>
              <MembershipPill membership={c.membership} />
              <span className="text-[11px] tabular-nums" style={{ color: 'var(--mute)' }}>
                {c.adherence == null ? 'No adherence data' : `${Math.round(c.adherence)}% adherence`}
              </span>
            </div>
          </Link>
        ))}
        {!filtered.length && (
          <Card className="p-6 text-center">
            <div className="text-[12.5px] font-semibold" style={{ color: 'var(--ink)' }}>No clients match</div>
            <div className="text-[11px] mt-1" style={{ color: 'var(--faint)' }}>Try clearing a filter or searching differently.</div>
          </Card>
        )}
      </div>

      <Card className="p-0 overflow-hidden hidden sm:block">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm min-w-[820px]">
            <thead>
              <tr className="border-b border-line text-[10px] uppercase tracking-[.14em] text-mute font-grotesk">
                <th className="px-5 py-3.5">Client</th>
                <th className="px-3 py-3.5">Goal</th>
                <th className="px-3 py-3.5">Weight</th>
                <th className="px-3 py-3.5">Δ 7d</th>
                <th className="px-3 py-3.5">Adherence</th>
                <th className="px-3 py-3.5">Last workout</th>
                <th className="px-3 py-3.5">Last check-in</th>
                <th className="px-3 py-3.5">Trainer</th>
                <th className="px-3 py-3.5">Membership</th>
                <th className="px-3 py-3.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className="border-b border-line/50 hover:bg-tint/[.03] transition-colors">
                  <td className="px-5 py-3">
                    <Link to={`/app/trainer/clients/${c.id}`} className="flex items-center gap-3 group">
                      <div className="w-8 h-8 rounded-full grid place-items-center bg-gradient-to-br from-ember/30 to-gold/20 border border-line font-grotesk text-xs font-bold">
                        {c.name[0]}
                      </div>
                      <div>
                        <div className="font-grotesk font-semibold group-hover:text-gold transition-colors">{c.name}</div>
                        <div className="text-[11px] text-faint">{c.age ? `${c.age} yrs` : '—'} · {c.email}</div>
                      </div>
                    </Link>
                  </td>
                  <td className="px-3 py-3 text-xs text-mute font-grotesk">{GOAL_LABEL[c.goal] || c.goal}</td>
                  <td className="px-3 py-3 font-grotesk font-semibold">{c.currentWeight ?? '—'} <span className="text-[10px] text-faint">/ {c.targetWeight ?? '—'} kg</span></td>
                  <td className={cls('px-3 py-3 font-grotesk text-xs', (c.change7 ?? 0) < -0.1 ? 'text-cyanx' : (c.change7 ?? 0) > 0.1 ? 'text-bad' : 'text-mute')}>
                    {c.change7 === null ? '—' : `${c.change7 > 0 ? '+' : ''}${c.change7}`}
                  </td>
                  {/* An unmeasured client rendered "null%" above a bar
                      drawn at 0% -- indistinguishable from someone who
                      logged nothing all week. Absence is stated as
                      absence. The bar also takes the body metric hue
                      rather than the ember->gold gradient, which was two
                      brand colours the palette no longer uses. */}
                  <td className="px-3 py-3">
                    {c.adherence == null ? (
                      <span className="text-xs" style={{ color: 'var(--faint)' }}>No data</span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--line)' }}>
                          <div className="h-full rounded-full"
                            style={{ width: `${Math.min(100, c.adherence)}%`, background: 'var(--m-body)' }} />
                        </div>
                        <span className="font-grotesk text-xs tabular-nums">{Math.round(c.adherence)}%</span>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-3 text-xs text-mute font-grotesk">{c.lastWorkout || '—'}</td>
                  <td className="px-3 py-3 text-xs text-mute font-grotesk">{c.lastCheckin ? c.lastCheckin.slice(0, 10) : '—'}</td>
                  <td className="px-3 py-3 text-xs font-grotesk" style={{ color: c.trainerName ? 'var(--mute)' : 'var(--faint)' }}>
                    {c.trainerName || 'Unassigned'}
                  </td>
                  <td className="px-3 py-3"><MembershipPill membership={c.membership} /></td>
                  <td className="px-3 py-3"><StatusChip status={c.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filtered.length && (
            <div className="text-center py-12 text-mute text-sm">No clients match — try clearing filters.</div>
          )}
        </div>
      </Card>

      <CreateClient open={createOpen} onClose={() => setCreateOpen(false)} onDone={() => { setCreateOpen(false); reload({ silent: true }); }} />
    </div>
  );
}

function CreateClient({ open, onClose, onDone }) {
  const [form, setForm] = useState({ name: '', email: '', password: '', age: '', height_cm: '', goal: 'FAT_LOSS', start_weight: '', target_weight: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await api('/clients', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name, email: form.email, goal: form.goal,
          age: form.age ? Number(form.age) : undefined,
          height_cm: form.height_cm ? Number(form.height_cm) : undefined,
          password: form.password || undefined,
          start_weight: form.start_weight ? Number(form.start_weight) : undefined,
          target_weight: form.target_weight ? Number(form.target_weight) : undefined
        })
      });
      onDone();
    } catch (ex) {
      setErr(ex.message || 'Failed to create client');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add a new client">
      <form onSubmit={submit} className="space-y-3">
        <input className="input" placeholder="Full name" value={form.name} onChange={set('name')} required />
        <input className="input" type="email" placeholder="Email (login)" value={form.email} onChange={set('email')} required />
        <input className="input" type="password" placeholder="Password (min 6 chars)" value={form.password} onChange={set('password')} required minLength={6} />
        <div className="grid grid-cols-3 gap-2">
          <input className="input" type="number" placeholder="Age" value={form.age} onChange={set('age')} />
          <input className="input" type="number" placeholder="Height cm" value={form.height_cm} onChange={set('height_cm')} />
          <select className="input" value={form.goal} onChange={set('goal')}>
            {Object.entries(GOAL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <input className="input" type="number" placeholder="Start weight (kg)" value={form.start_weight} onChange={set('start_weight')} />
          <input className="input" type="number" placeholder="Target weight (kg)" value={form.target_weight} onChange={set('target_weight')} />
        </div>
        <div className="text-[11px] text-faint">Client can change their password from Settings after first login.</div>
        {err && <div className="text-xs text-bad bg-bad/10 border border-bad/30 rounded-xl px-3 py-2.5">{err}</div>}
        <button className="btn-primary w-full" disabled={busy}>{busy ? 'Creating…' : 'Create client'}</button>
      </form>
    </Modal>
  );
}
