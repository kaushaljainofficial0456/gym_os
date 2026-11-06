/**
 * MEMBER CHECK-INS -- who came in on a given day, marked by the desk.
 * Opens on today with every member listed, so marking someone is one tap;
 * it used to need a "Load" press and then showed only members who already
 * had a mark, which on a new day was nobody.
 */
import { useMemo, useState } from 'react';
import { api } from '../../api.js';
import { useFetch, localDateKey } from '../../utils.js';
import { Avatar, Card, ErrorState, Skeleton } from '../UI.jsx';

export default function MemberCheckins() {
  const [date, setDate] = useState(localDateKey());
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState('');
  const list = useFetch(() => api(`/admin/attendance?date=${date}`), [date]);
  const rows = list.data?.attendance || [];
  const present = rows.filter((r) => r.present === true).length;
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? rows.filter((r) => r.client_name?.toLowerCase().includes(needle)) : rows;
  }, [rows, q]);

  const mark = async (r, value) => {
    setBusy(r.client_id); setErr('');
    try {
      await api('/admin/attendance', { method: 'POST', body: JSON.stringify({ client_id: r.client_id, present: value, date }) });
      list.reload({ silent: true });
    } catch (e) { setErr(e.message || 'Could not save that.'); }
    setBusy(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="text-[13px] font-semibold" style={{ color: 'var(--mute)' }}>Checked in</div>
          <div className="text-[30px] font-extrabold tabular-nums leading-tight" style={{ color: 'var(--ink)' }}>
            {present}<span className="text-[16px] font-bold" style={{ color: 'var(--faint)' }}> of {rows.length}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input className="input !w-auto" type="search" placeholder="Find a member" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a member" />
          <input className="input !w-auto" type="date" max={localDateKey()} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Day" />
        </div>
      </div>

      {err && <div className="field-error" role="alert">{err}</div>}
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : list.loading ? (
        <Card className="p-5"><Skeleton lines={5} /></Card>
      ) : !rows.length ? (
        <Card className="p-6 text-center text-[15px] font-semibold" style={{ color: 'var(--mute)' }}>No members yet.</Card>
      ) : (
        <Card className="!p-0 overflow-hidden">
          {shown.map((r, i) => (
            <div key={r.client_id} className="flex items-center gap-3 px-4 sm:px-5 py-3" style={i ? { borderTop: '1px solid var(--line)' } : undefined}>
              <Avatar name={r.client_name} size={38} />
              <div className="flex-1 min-w-0 text-[15px] font-bold truncate" style={{ color: 'var(--ink)' }}>{r.client_name}</div>
              <div className="segmented !w-auto shrink-0" role="group" aria-label={`${r.client_name}: attendance`}>
                <button type="button" className="segmented-item !px-3.5 !min-h-[38px]" aria-pressed={r.present === true} disabled={busy === r.client_id}
                  onClick={() => mark(r, true)}
                  style={r.present === true ? { background: 'rgb(var(--good-rgb) / .22)', color: 'var(--ink)', fontWeight: 800 } : undefined}>
                  {r.present === true ? '✓ Present' : 'Present'}
                </button>
                <button type="button" className="segmented-item !px-3.5 !min-h-[38px]" aria-pressed={r.present === false} disabled={busy === r.client_id}
                  onClick={() => mark(r, false)}
                  style={r.present === false ? { background: 'rgb(var(--bad-rgb) / .18)', color: 'var(--ink)', fontWeight: 800 } : undefined}>
                  {r.present === false ? '✕ Absent' : 'Absent'}
                </button>
              </div>
            </div>
          ))}
          {!shown.length && <div className="px-5 py-5 text-[14px]" style={{ color: 'var(--mute)' }}>Nobody matches “{q}”.</div>}
        </Card>
      )}
    </div>
  );
}
