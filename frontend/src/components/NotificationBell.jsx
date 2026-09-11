/**
 * NOTIFICATION BELL — the single place anything wants your attention.
 *
 * WHY THIS MERGED. The header carried TWO bell-shaped buttons: this one,
 * and a "Coach" button opening the AI brief drawer. The old comment here
 * argued they were "genuinely different features" that the text label
 * kept distinguishable. They are different features, but that is an
 * argument about the code, not about the person reading the header: two
 * bells side by side means "which bell do I press?", every time. One bell
 * now owns everything that wants attention, and the DIFFERENCE between
 * kinds is expressed inside the panel, where there is room to say it.
 *
 * SEGREGATION, NOT SEPARATION. The coach brief sits pinned at the top
 * because it is advice addressed to you personally; everything else is a
 * stream of events grouped by recency. The filter chips only appear when
 * there is actually more than one kind present -- a chip row over three
 * notifications is chrome pretending to be a feature.
 *
 * HONEST ABOUT WHAT'S EMPTY: nothing in this codebase schedules reminder
 * notifications (no cron exists -- see notifications.js), so for a client
 * account this list is often genuinely empty. That is the correct state,
 * not a bug; owner-facing events DO write real rows via notify().
 */
import { useEffect, useRef, useState, useMemo } from 'react';
import { api } from '../api.js';

function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

/** Recency buckets. People look for "what happened since I last looked",
 *  not for a notification's type taxonomy. */
function bucketOf(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'Earlier';
  const days = (Date.now() - then) / 86400000;
  if (days < 1) return 'Today';
  if (days < 7) return 'This week';
  return 'Earlier';
}

const BUCKETS = ['Today', 'This week', 'Earlier'];

export default function NotificationBell({
  hasBrief = false, briefPriority = false, onOpenCoach,
}) {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [onlyUnread, setOnlyUnread] = useState(false);
  const ref = useRef(null);

  const load = () => {
    setLoading(true);
    setErr('');
    api('/notifications?limit=30')
      .then((r) => { setNotifications(r.notifications || []); setUnreadCount(r.unread_count || 0); })
      .catch((e) => setErr(e.message || 'Could not load notifications'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    api('/notifications?limit=1').then((r) => setUnreadCount(r.unread_count || 0)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) load();
  };

  const markRead = async (n) => {
    if (n.read) return;
    setNotifications((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: 1 } : x)));
    setUnreadCount((c) => Math.max(0, c - 1));
    try {
      await api(`/notifications/${n.id}/read`, { method: 'PATCH' });
    } catch {
      setNotifications((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: 0 } : x)));
      setUnreadCount((c) => c + 1);
    }
  };

  const markAllRead = async () => {
    if (!notifications.some((n) => !n.read)) return;
    setNotifications((prev) => prev.map((x) => ({ ...x, read: 1 })));
    setUnreadCount(0);
    try {
      await api('/notifications/read-all', { method: 'POST' });
    } catch {
      load();
    }
  };

  const shown = useMemo(
    () => (onlyUnread ? notifications.filter((n) => !n.read) : notifications),
    [notifications, onlyUnread]);

  const grouped = useMemo(() => {
    const m = new Map(BUCKETS.map((b) => [b, []]));
    for (const n of shown) m.get(bucketOf(n.created_at))?.push(n);
    return BUCKETS.map((b) => [b, m.get(b)]).filter(([, list]) => list.length);
  }, [shown]);

  // One dot for anything wanting attention, from either source -- the
  // whole point of merging is that you check one thing.
  const attention = unreadCount > 0 || (hasBrief && briefPriority);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={toggle}
        className="chrome-btn relative !px-2.5 !py-1.5"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={unreadCount > 0 ? `Notifications — ${unreadCount} unread` : 'Notifications'}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {attention && (
          <span aria-hidden="true" className="absolute top-0.5 right-1 rounded-full"
            style={{
              minWidth: unreadCount > 0 ? 15 : 8, height: unreadCount > 0 ? 15 : 8,
              background: 'var(--accent)', color: 'var(--accent-contrast)',
              boxShadow: '0 0 0 2px rgb(var(--bg-rgb))',
              fontSize: 9, lineHeight: '15px', fontWeight: 700, textAlign: 'center',
              padding: unreadCount > 9 ? '0 3px' : 0,
            }}>
            {unreadCount > 0 ? (unreadCount > 9 ? '9+' : unreadCount) : ''}
          </span>
        )}
      </button>

      {open && (
        <div role="menu"
             className="absolute right-0 top-full mt-1.5 w-[19rem] max-h-[72vh] overflow-hidden flex flex-col anim-scaleIn z-50 card !p-0"
             style={{ borderRadius: 'var(--r-lg)', boxShadow: 'var(--e-3)' }}>

          <div className="flex items-center justify-between px-3.5 py-2.5 shrink-0" style={{ borderBottom: '1px solid var(--line)' }}>
            <span className="font-grotesk text-[12.5px] font-bold" style={{ color: 'var(--ink)' }}>Notifications</span>
            {unreadCount > 0 && (
              <button onClick={markAllRead}
                      className="text-[10.5px] font-semibold rounded-lg px-2"
                      style={{ minHeight: 28, color: 'var(--accent)' }}>
                Mark all read
              </button>
            )}
          </div>

          <div className="overflow-y-auto">
            {/* The coach brief, pinned. It is advice addressed to you, not
                an event in a stream, so it keeps its own place at the top
                rather than being sorted in among gym updates. */}
            {onOpenCoach && (
              <button
                role="menuitem"
                onClick={() => { setOpen(false); onOpenCoach(); }}
                className="w-full text-left px-3.5 py-3 flex items-center gap-2.5 transition-colors"
                style={{ borderBottom: '1px solid var(--line)', background: briefPriority ? 'var(--accent-soft)' : 'transparent' }}
              >
                <span aria-hidden="true" className="shrink-0 grid place-items-center rounded-lg"
                      style={{ width: 30, height: 30, background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2a7 7 0 0 0-4 12.7V17a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2.3A7 7 0 0 0 12 2zM9 22h6" />
                  </svg>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-semibold" style={{ color: 'var(--ink)' }}>Coach brief</span>
                  <span className="block text-[10.5px] mt-0.5" style={{ color: 'var(--mute)' }}>
                    {hasBrief ? (briefPriority ? 'New guidance for you' : 'Your latest guidance') : 'Nothing new right now'}
                  </span>
                </span>
                {briefPriority && (
                  <span aria-hidden="true" className="w-2 h-2 rounded-full shrink-0" style={{ background: 'var(--accent)' }} />
                )}
              </button>
            )}

            {/* Unread filter only when it would actually do something. */}
            {notifications.length > 4 && unreadCount > 0 && (
              <div className="px-3.5 py-2" style={{ borderBottom: '1px solid var(--line)' }}>
                <button
                  onClick={() => setOnlyUnread((v) => !v)}
                  aria-pressed={onlyUnread}
                  className="rounded-lg px-2.5 text-[10.5px] font-semibold"
                  style={{
                    minHeight: 30,
                    background: onlyUnread ? 'var(--accent-soft)' : 'transparent',
                    border: `1px solid ${onlyUnread ? 'var(--accent)' : 'var(--line)'}`,
                    color: onlyUnread ? 'var(--accent)' : 'var(--mute)',
                  }}
                >
                  Unread only · {unreadCount}
                </button>
              </div>
            )}

            {loading && (
              <div className="px-3.5 py-6 text-center text-[11px]" style={{ color: 'var(--faint)' }}>Loading…</div>
            )}
            {!loading && err && (
              <div className="px-3.5 py-6 text-center text-[11px]" style={{ color: 'var(--bad)' }}>{err}</div>
            )}
            {!loading && !err && shown.length === 0 && (
              <div className="px-3.5 py-7 text-center">
                <div className="text-[12px] font-semibold" style={{ color: 'var(--ink)' }}>
                  {onlyUnread ? 'Nothing unread' : 'You’re all caught up'}
                </div>
                <div className="text-[10.5px] mt-1 leading-relaxed" style={{ color: 'var(--faint)' }}>
                  {onlyUnread ? 'Everything here has been read.' : 'Updates from your gym and your coach appear here.'}
                </div>
              </div>
            )}

            {!loading && !err && grouped.map(([bucket, list]) => (
              <div key={bucket}>
                <div className="px-3.5 pt-2.5 pb-1 text-[9.5px] uppercase tracking-[.14em] font-semibold"
                     style={{ color: 'var(--faint)' }}>
                  {bucket}
                </div>
                {list.map((n) => (
                  <button
                    key={n.id}
                    role="menuitem"
                    onClick={() => markRead(n)}
                    className="w-full text-left px-3.5 py-2.5 flex items-start gap-2.5 transition-colors"
                    style={{ borderBottom: '1px solid var(--line)', background: n.read ? 'transparent' : 'var(--accent-soft)' }}
                  >
                    <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full shrink-0 mt-1.5"
                      style={{ background: n.read ? 'transparent' : 'var(--accent)' }} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] font-semibold truncate" style={{ color: 'var(--ink)' }}>{n.title}</div>
                      {n.body && <div className="text-[10.5px] mt-0.5 line-clamp-2" style={{ color: 'var(--mute)' }}>{n.body}</div>}
                      <div className="text-[9.5px] mt-1" style={{ color: 'var(--faint)' }}>{timeAgo(n.created_at)}</div>
                    </div>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
