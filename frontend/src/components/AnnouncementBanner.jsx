import { useState, useEffect, useMemo } from 'react';
import { api } from '../api.js';
import { useFetch } from '../utils.js';
import { useAuth } from '../auth.jsx';

// Platform-wide notices authored in the Admin Console (SUPER_ADMIN only --
// see backend/src/services/platform/announcements.js). GET /me/announcements
// is the one route any authenticated role (owner/trainer/client) can reach;
// audience filtering happens server-side from the caller's own role, so
// whatever comes back here is already meant for this viewer.
//
// Dismissal is per-browser (localStorage), not per-account server state --
// these are transient notices ("maintenance at midnight"), not something
// that needs to follow a user across devices or reappear after a refresh
// once they've read it. Keyed by user id, not just the browser: a shared
// gym-reception device can have an owner and a trainer sign into the same
// browser, and one dismissing a notice must not hide it from the other.
function dismissedKey(userId) { return `sk_os_dismissed_announcements:${userId || 'anon'}`; }
function readDismissed(userId) {
  try { return new Set(JSON.parse(localStorage.getItem(dismissedKey(userId))) || []); }
  catch { return new Set(); }
}
function writeDismissed(userId, set) {
  try { localStorage.setItem(dismissedKey(userId), JSON.stringify([...set])); } catch { /* storage unavailable -- dismissal just won't persist */ }
}

const PRIORITY_STYLE = {
  URGENT: { border: 'var(--bad)', bg: 'rgba(var(--bad-rgb), .10)', dot: 'var(--bad)' },
  HIGH: { border: 'var(--warn)', bg: 'rgba(var(--warn-rgb), .10)', dot: 'var(--warn)' },
  NORMAL: { border: 'var(--accent)', bg: 'var(--accent-soft)', dot: 'var(--accent)' },
  LOW: { border: 'var(--line)', bg: 'var(--panel2)', dot: 'var(--faint)' },
};

export default function AnnouncementBanner() {
  const { user } = useAuth();
  const { data } = useFetch(() => api('/me/announcements'));
  const [dismissed, setDismissed] = useState(() => readDismissed(user?.id));

  // Re-read from storage under the new key when the signed-in user changes
  // (e.g. sign-out then a different account signs in on the same device).
  useEffect(() => { setDismissed(readDismissed(user?.id)); }, [user?.id]);

  const visible = useMemo(() => {
    const list = data?.announcements || [];
    return list.filter((a) => !dismissed.has(a.id));
  }, [data, dismissed]);

  if (!visible.length) return null;

  const dismiss = (id) => setDismissed((prev) => {
    const next = new Set(prev).add(id);
    writeDismissed(user?.id, next);
    return next;
  });

  return (
    <div className="flex flex-col gap-2 mb-4">
      {visible.map((a) => {
        const style = PRIORITY_STYLE[a.priority] || PRIORITY_STYLE.NORMAL;
        return (
          <div key={a.id}
            className="flex items-start gap-3 rounded-xl border px-3.5 py-2.5"
            style={{ borderColor: style.border, background: style.bg }}
            role="status">
            <span className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0" style={{ background: style.dot }} aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <div className="font-grotesk text-[12.5px] font-bold" style={{ color: 'var(--ink)' }}>{a.title}</div>
              <div className="text-[12px] mt-0.5" style={{ color: 'var(--mute)' }}>{a.message}</div>
            </div>
            <button
              onClick={() => dismiss(a.id)}
              aria-label="Dismiss announcement"
              className="shrink-0 w-6 h-6 grid place-items-center rounded-lg transition-colors"
              style={{ color: 'var(--faint)' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
