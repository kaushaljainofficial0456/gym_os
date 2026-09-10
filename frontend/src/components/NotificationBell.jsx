/**
 * NOTIFICATION BELL — header icon button + dropdown list, backed by the
 * real /api/notifications routes (see backend/src/routes/notifications.js).
 *
 * Distinct from ClientLayout's "Coach" button next to it: that opens the
 * AI Coach Brief drawer (a different feature that happens to also use a
 * bell-shaped glyph, pre-existing). This one is the actual notification
 * center -- unread count badge, a scrollable list, tap-to-mark-read.
 *
 * HONEST ABOUT WHAT'S EMPTY: nothing in this codebase currently schedules
 * reminder notifications (no cron/scheduler exists -- see
 * notifications.js's own file comment), so for most accounts this list is
 * genuinely empty today. That's the correct, non-fabricated state, not a
 * bug -- an owner-facing event (a message, a report) DOES already write
 * real rows via notify()/notifyOwners(), so a trainer account will see
 * real entries here.
 */
import { useEffect, useRef, useState } from 'react';
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

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const ref = useRef(null);

  const load = () => {
    setLoading(true);
    setErr('');
    api('/notifications?limit=20')
      .then((r) => { setNotifications(r.notifications || []); setUnreadCount(r.unread_count || 0); })
      .catch((e) => setErr(e.message || 'Could not load notifications'))
      .finally(() => setLoading(false));
  };

  // Unread count only, on mount -- cheap enough to always fetch (a single
  // indexed COUNT), so the badge is accurate the moment the layout renders,
  // without waiting for the user to open the dropdown.
  useEffect(() => {
    api('/notifications?limit=1').then((r) => setUnreadCount(r.unread_count || 0)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) load();
  };

  const markRead = async (n) => {
    if (n.read) return;
    // Optimistic -- flips locally immediately, rolls back only if the
    // request actually fails (rare: this is a same-origin, ownership-
    // scoped PATCH with nothing else that can reasonably reject it).
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
    const hadUnread = notifications.some((n) => !n.read);
    if (!hadUnread) return;
    setNotifications((prev) => prev.map((x) => ({ ...x, read: 1 })));
    setUnreadCount(0);
    try {
      await api('/notifications/read-all', { method: 'POST' });
    } catch {
      load(); // rollback by re-fetching real state rather than guessing it
    }
  };

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
        {unreadCount > 0 && (
          <span aria-hidden="true" className="absolute top-0.5 right-1 w-2 h-2 rounded-full"
            style={{ background: 'var(--accent)', boxShadow: '0 0 0 2px rgb(var(--bg-rgb))' }} />
        )}
      </button>

      {open && (
        <div role="menu" className="absolute right-0 top-full mt-1.5 w-72 max-h-[70vh] overflow-hidden flex flex-col anim-scaleIn z-50 card !p-0"
             style={{ borderRadius: 'var(--r-lg)', boxShadow: 'var(--e-3)' }}>
          <div className="flex items-center justify-between px-3.5 py-2.5" style={{ borderBottom: '1px solid var(--line)' }}>
            <span className="font-grotesk text-[12px] font-bold" style={{ color: 'var(--ink)' }}>Notifications</span>
            {unreadCount > 0 && (
              <button onClick={markAllRead} className="text-[10px] font-semibold underline-offset-2 hover:underline" style={{ color: 'var(--accent)' }}>
                Mark all read
              </button>
            )}
          </div>
          <div className="overflow-y-auto">
            {loading && (
              <div className="px-3.5 py-6 text-center text-[11px]" style={{ color: 'var(--faint)' }}>Loading…</div>
            )}
            {!loading && err && (
              <div className="px-3.5 py-6 text-center text-[11px]" style={{ color: 'var(--bad)' }}>{err}</div>
            )}
            {!loading && !err && notifications.length === 0 && (
              <div className="px-3.5 py-8 text-center">
                <div className="text-[12px] font-semibold" style={{ color: 'var(--ink)' }}>No notifications yet</div>
                <div className="text-[10.5px] mt-1" style={{ color: 'var(--faint)' }}>You'll see updates from your gym here.</div>
              </div>
            )}
            {!loading && !err && notifications.map((n) => (
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
        </div>
      )}
    </div>
  );
}
