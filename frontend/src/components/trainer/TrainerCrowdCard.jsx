/**
 * The gym right now, from a trainer's side of the floor.
 *
 * Two things a trainer plans around: how busy the floor is (for picking a
 * slot or a station) and which of THEIR clients are in. Nothing else.
 * Other people's clients, door names and access IDs are not a trainer's
 * business and the server does not send them.
 *
 * Both halves are the owner's to switch off (crowd_trainer_visible). When
 * they are off the card is simply not there -- a trainer is not told a
 * feature exists and they cannot see it.
 *
 * The crowd label, count and colour are decided on the server with the
 * owner's thresholds and privacy setting; this card only draws them.
 */
import { Link } from 'react-router-dom';
import InfoDot from '../InfoDot.jsx';

const TONE = {
  none: 'var(--faint)', info: 'var(--accent)', low: 'var(--good)',
  medium: 'var(--warn)', high: 'var(--gold)', critical: 'var(--bad)',
};

const since = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

export default function TrainerCrowdCard({ crowd, clients }) {
  const showCrowd = crowd?.enabled && crowd.crowd;
  const roster = clients?.enabled ? clients.clients || [] : null;
  if (!showCrowd && !roster) return null;

  const c = crowd?.crowd;
  const tone = TONE[c?.severity] || 'var(--accent)';
  const inside = (roster || []).filter((x) => x.insideNow);
  const cameToday = (roster || []).filter((x) => x.cameInToday).length;
  const fresh = crowd?.freshness;

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <div className="text-[10px] uppercase tracking-[.14em] font-grotesk" style={{ color: 'var(--faint)' }}>The gym now</div>
          <InfoDot label="the gym now" title="Where this comes from" size={26}>
            {crowd?.source === 'access_control'
              ? 'Counted from the door scanners. The label and colour use thresholds your gym owner set.'
              : 'Counted from the front-desk check-in log, since no door scanner is connected. It is only as current as the last check-in.'}
          </InfoDot>
        </div>
        {fresh && !fresh.isLive && showCrowd && (
          <span className="text-[10px]" style={{ color: 'var(--warn)' }}>{fresh.label}</span>
        )}
      </div>

      {showCrowd && (
        <div className="flex items-center gap-3 mt-2">
          <span className="rounded-full shrink-0" style={{ width: 10, height: 10, background: tone }} aria-hidden="true" />
          <div className="min-w-0">
            <div className="font-grotesk font-bold text-[17px]" style={{ color: tone }}>{c.label}</div>
            <div className="text-[11.5px]" style={{ color: 'var(--mute)' }}>
              {c.status === 'closed' && crowd.hours?.open ? `Opens at ${crowd.hours.open}` : c.description}
            </div>
          </div>
          {c.occupancyPercentage != null && c.status !== 'closed' && (
            <div className="ml-auto font-black text-[22px] tabular-nums" style={{ color: 'var(--ink)' }}>{c.occupancyPercentage}%</div>
          )}
        </div>
      )}

      {roster && (
        <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--line)' }}>
          <div className="flex items-baseline justify-between gap-2">
            <div className="text-[12px] font-grotesk font-semibold" style={{ color: 'var(--ink)' }}>
              {inside.length === 0 ? 'None of your clients are in' : `${inside.length} of your clients ${inside.length === 1 ? 'is' : 'are'} in`}
            </div>
            <div className="text-[10.5px] tabular-nums shrink-0" style={{ color: 'var(--faint)' }}>{cameToday} came in today</div>
          </div>
          {inside.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {inside.slice(0, 12).map((x) => (
                <Link key={x.id} to={`/app/trainer/clients/${x.id}`} className="inline-flex items-center gap-1.5 rounded-full px-2.5 text-[11.5px]"
                      style={{ minHeight: 30, border: '1px solid var(--line)', color: 'var(--ink)' }}>
                  <span className="rounded-full" style={{ width: 6, height: 6, background: 'var(--good)' }} aria-hidden="true" />
                  {x.name}
                  {x.insideSince && <span style={{ color: 'var(--faint)' }}>since {since(x.insideSince)}</span>}
                </Link>
              ))}
              {inside.length > 12 && <span className="text-[11px] self-center" style={{ color: 'var(--faint)' }}>+{inside.length - 12} more</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
