/**
 * MEMBERSHIP & ATTENDANCE — the relationship the gym actually runs on.
 *
 * The client detail screen had seven tabs about how someone TRAINS and
 * not one about what they pay, when their membership ends, whether they
 * are behind, or how often they have come in. All of it already in the
 * database; none of it reachable from the one screen built for looking
 * at a single person. An owner chasing a renewal had to leave the client
 * entirely and go hunting in Business.
 *
 * PAYMENTS ARE OWNER-ONLY, and the SERVER decides that — it returns
 * `payments: null` to a trainer rather than an empty list, so this screen
 * can tell "no payments recorded" apart from "not yours to see" and say
 * whichever is true. A trainer still gets membership dates and
 * attendance, both of which legitimately change how you coach someone.
 *
 * LAPSED IS A DATE, NOT A COLUMN. Nothing in this app expires a
 * subscription on a schedule, so rows sit at status 'active' long after
 * they have run out. This says how long ago it ended rather than
 * repeating the label the row is still carrying.
 */
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { Card, Kicker, ErrorState } from '../UI.jsx';

const money = (n, currency = 'INR') => {
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 })
      .format(Number(n) || 0);
  } catch { return `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`; }
};

const prettyDate = (key) => (key
  ? new Date(`${String(key).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  : '—');

const shortDate = (key) => (key
  ? new Date(`${String(key).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  : '');

export default function MembershipTab({ clientId }) {
  const { data, loading, error, reload } = useFetch(() => api(`/clients/${clientId}/account`), [clientId]);

  if (loading) {
    return (
      <Card className="p-5">
        <div className="skeleton h-4 w-1/3" />
        <div className="skeleton h-3 w-2/3 mt-3" />
        <div className="skeleton h-3 w-1/2 mt-2" />
      </Card>
    );
  }
  if (error) return <ErrorState error={error} onRetry={reload} />;

  const m = data.membership;
  const att = data.attendance;
  const days = m && m.end_date
    ? Math.round((Date.parse(`${m.end_date}T00:00:00Z`) - Date.now()) / 86400000)
    : null;

  const owing = m && ['overdue', 'failed', 'pending'].includes(m.payment_status);
  const tone = !m ? 'var(--mute)'
    : (m.lapsed || owing) ? 'var(--bad)'
      : (days != null && days <= 30) ? 'var(--warn)' : 'var(--good)';

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <Kicker>Membership</Kicker>

        {!m ? (
          <div className="mt-3">
            <div className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>No membership on record</div>
            <div className="text-[11.5px] mt-1" style={{ color: 'var(--faint)' }}>
              This client has never had a plan. Add one from the Business screen.
            </div>
          </div>
        ) : (
          <>
            <div className="mt-3 flex items-baseline justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="font-grotesk text-[19px] font-black" style={{ color: 'var(--ink)' }}>{m.plan_name}</div>
                <div className="text-[11.5px] mt-0.5" style={{ color: 'var(--mute)' }}>
                  {money(m.amount, m.currency)} · {prettyDate(m.start_date)} → {prettyDate(m.end_date)}
                </div>
              </div>
              {/* The status WORD, outlined rather than filled — this is a
                  statement of fact, not an alert to shout. */}
              <span className="rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-[.06em] shrink-0"
                    style={{ color: tone, border: `1px solid ${tone}` }}>
                {m.effectiveStatus}
              </span>
            </div>

            <div className="mt-3 pt-3 text-[12px] leading-snug"
                 style={{ borderTop: '1px solid var(--line)', color: 'var(--mute)' }}>
              {m.lapsed ? (
                <>
                  Ended <strong style={{ color: 'var(--bad)' }}>{Math.abs(days)} days ago</strong>. The plan still
                  reads “active” because nothing expires it automatically — this is a renewal to chase.
                </>
              ) : days != null && days >= 0 ? (
                <>Ends in <strong style={{ color: days <= 30 ? 'var(--warn)' : 'var(--ink)' }}>{days} days</strong>.</>
              ) : (
                'No end date recorded.'
              )}
              {owing && (
                <> Payment is <strong style={{ color: 'var(--bad)' }}>{m.payment_status}</strong>.</>
              )}
            </div>
          </>
        )}

        {data.history && data.history.length > 0 && (
          <div className="mt-4 pt-3" style={{ borderTop: '1px solid var(--line)' }}>
            <div className="text-[9.5px] font-bold uppercase tracking-[.1em] mb-2" style={{ color: 'var(--faint)' }}>
              Earlier plans
            </div>
            {data.history.map((h) => (
              <div key={h.id} className="flex items-baseline justify-between gap-2 py-1 text-[11.5px]">
                <span style={{ color: 'var(--mute)' }}>{h.plan_name}</span>
                <span className="tabular-nums" style={{ color: 'var(--faint)' }}>
                  {prettyDate(h.start_date)} → {prettyDate(h.end_date)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-5">
        <Kicker>Attendance</Kicker>
        <div className="grid grid-cols-3 gap-4 mt-3">
          <div className="min-w-0">
            <div className="text-[9.5px] font-bold uppercase tracking-[.1em]" style={{ color: 'var(--faint)' }}>Last 90 days</div>
            <div className="font-grotesk text-[22px] font-black tabular-nums mt-1" style={{ color: 'var(--ink)' }}>{att.last90}</div>
          </div>
          <div className="min-w-0">
            <div className="text-[9.5px] font-bold uppercase tracking-[.1em]" style={{ color: 'var(--faint)' }}>All time</div>
            <div className="font-grotesk text-[22px] font-black tabular-nums mt-1" style={{ color: 'var(--ink)' }}>{att.allTime}</div>
          </div>
          <div className="min-w-0">
            <div className="text-[9.5px] font-bold uppercase tracking-[.1em]" style={{ color: 'var(--faint)' }}>Last visit</div>
            <div className="font-grotesk text-[13px] font-bold mt-2" style={{ color: 'var(--ink)' }}>
              {att.lastVisit ? prettyDate(att.lastVisit) : 'Never'}
            </div>
          </div>
        </div>

        {att.recentDates.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {att.recentDates.slice(0, 24).map((d) => (
              <span key={d} className="rounded-md px-2 py-1 text-[10.5px] tabular-nums"
                    style={{ background: 'var(--bg2)', color: 'var(--mute)', border: '1px solid var(--line)' }}>
                {shortDate(d)}
              </span>
            ))}
          </div>
        ) : (
          <div className="mt-4 text-[11.5px]" style={{ color: 'var(--faint)' }}>
            No check-ins recorded in the last 90 days.
          </div>
        )}
      </Card>

      {/* `payments === null` means the server declined to share them, which
          is a different statement from an empty list — and saying the wrong
          one of those to a trainer reads as a broken screen. */}
      {data.payments === null ? (
        <Card className="p-5">
          <Kicker>Payments</Kicker>
          <div className="text-[11.5px] mt-2" style={{ color: 'var(--faint)' }}>
            Payment history is visible to the gym owner only.
          </div>
        </Card>
      ) : (
        <Card className="!p-0 overflow-hidden">
          <div className="px-5 pt-5 pb-2"><Kicker>Payments</Kicker></div>
          {data.payments.length ? (
            <div style={{ borderTop: '1px solid var(--line)' }}>
              {data.payments.map((p) => (
                <div key={p.id} className="px-5 py-3 flex items-center justify-between gap-3"
                     style={{ borderBottom: '1px solid var(--line)' }}>
                  <div className="min-w-0">
                    <div className="text-[12.5px] font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>
                      {money(p.amount, p.currency)}
                    </div>
                    <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--faint)' }}>
                      {prettyDate(p.paid_at)}{p.method ? ` · ${p.method}` : ''}
                    </div>
                  </div>
                  {/* The word, not just a colour: a failed payment must not
                      be distinguishable by hue alone. */}
                  <span className="text-[11px] font-bold uppercase tracking-[.05em] shrink-0"
                        style={{ color: p.status === 'paid' ? 'var(--good)' : 'var(--bad)' }}>
                    {p.status}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-5 pb-5 text-[11.5px]" style={{ color: 'var(--faint)' }}>
              No payments recorded for this client yet.
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
