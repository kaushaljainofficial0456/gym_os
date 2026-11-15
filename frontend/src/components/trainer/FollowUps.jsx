/**
 * CLIENTS WHO NEED A WORD FROM THEIR COACH, WITH WHY.
 *
 * A trainer's Home shows it as its own card. An owner's Home opens it in
 * place, under the to-do "N clients to follow up" (`bare`: rows only,
 * inside that card), so the list is one tap away without taking the page.
 *
 * Rendered plainly: it used to fade in only once scrolled into view, so
 * it sat as an empty card in any capture and for anyone who never
 * scrolled that far.
 */
import { Link } from 'react-router-dom';
import { fmt1, kg1 } from '../../utils.js';
import { Card, ErrorState, StatusChip, Avatar } from '../UI.jsx';

export const goalLabel = (g) => String(g || '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

function Rows({ clients, limit }) {
  return clients.slice(0, limit).map((c, i) => (
    <Link key={c.clientId} to={`/app/trainer/clients/${c.clientId}`}
      className="flex items-center gap-3.5 px-4 sm:px-5 py-3.5 transition-colors hover:bg-[var(--bg2)]"
      style={i ? { borderTop: '1px solid var(--line)' } : undefined}>
      <Avatar name={c.name} size={42} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[15px] font-bold" style={{ color: 'var(--ink)' }}>{c.name}</span>
          <StatusChip status={c.status} />
        </div>
        <div className="text-[13px] mt-0.5 truncate" style={{ color: 'var(--mute)' }}>
          {c.rules.slice(0, 2).map((r) => r.title).join(' · ') || goalLabel(c.goal)}
        </div>
        <div className="text-[12.5px] mt-0.5 tabular-nums truncate" style={{ color: 'var(--faint)' }}>
          {goalLabel(c.goal)}
          {c.currentWeight != null && c.targetWeight != null ? ` · ${kg1(c.currentWeight)} → ${kg1(c.targetWeight)} kg`
            : c.currentWeight != null ? ` · ${kg1(c.currentWeight)} kg` : ''}
          {c.adherence == null ? '' : ` · ${fmt1(c.adherence)}% adherence`}
        </div>
      </div>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--faint)" strokeWidth="2.5"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0"><path d="m9 18 6-6-6-6" /></svg>
    </Link>
  ));
}

export default function FollowUps({ clients, error, onRetry, limit = 6, bare = false }) {
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (bare) return <Rows clients={clients} limit={limit} />;
  if (!clients.length) {
    return (
      <Card className="px-5 py-5">
        <div className="text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>Everyone is on track.</div>
      </Card>
    );
  }
  return (
    <Card className="!p-0 overflow-hidden">
      <Rows clients={clients} limit={limit} />
    </Card>
  );
}
