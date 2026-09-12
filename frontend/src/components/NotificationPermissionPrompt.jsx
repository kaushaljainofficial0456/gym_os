// ============================================================
// NOTIFICATION PERMISSION PROMPT — custom Gym OS modal shown
// after first successful login. Uses the REAL browser
// Notification.requestPermission() API when the user clicks
// "Allow Notifications".
//
// Prompting is gated on THREE conditions:
//   1. Browser Notification API is available (not all browsers).
//   2. Browser permission is not already 'granted' or 'denied'
//      (if already decided, we respect it and never re-prompt).
//   3. The user has not already been prompted in a previous
//      session (checked via the backend `notification_preferences`
//      table's `prompted_at` field, and as a fallback, localStorage).
//
// The prompt NEVER blocks the user from entering the app.
// ============================================================
import { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';

const STORAGE_KEY = 'notif_prompt_seen';

// Check if the browser supports the Notification API
function browserSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

// Check if the browser permission is already decided
function browserPermissionStatus() {
  if (!browserSupported()) return 'unavailable';
  return Notification.permission; // 'granted' | 'denied' | 'default'
}

export default function NotificationPermissionPrompt() {
  const [showPrompt, setShowPrompt] = useState(false);
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      // Gate 1: browser must support Notification API
      if (!browserSupported()) return;

      // Gate 2: browser permission already decided — don't prompt
      const browserStatus = browserPermissionStatus();
      if (browserStatus === 'granted' || browserStatus === 'denied') return;

      // Gate 3: check if user was already prompted in a previous session
      // Try the backend first (most reliable), fall back to localStorage
      try {
        const data = await api('/notifications/preferences');
        const prefs = data?.preferences;
        if (prefs?.prompted_at) return; // already prompted before
      } catch {
        // Backend might fail if table doesn't exist yet — fall back to localStorage
      }

      // localStorage fallback
      try {
        if (localStorage.getItem(STORAGE_KEY)) return;
      } catch {
        // storage unavailable — continue to show prompt
      }

      if (!cancelled) setShowPrompt(true);
    }

    check();
    return () => { cancelled = true; };
  }, []);

  const handleAllow = useCallback(async () => {
    setProcessing(true);
    try {
      // Use the REAL browser Notification API
      const result = await Notification.requestPermission();

      // Save the browser permission state to the backend
      try {
        await api('/notifications/preferences', {
          method: 'PATCH',
          body: JSON.stringify({
            browser_permission: result,
            prompted_at: new Date().toISOString(),
          }),
        });
      } catch {
        // Non-fatal: backend save failed, but we still got the browser result
      }

      // Mark as seen in localStorage as fallback
      try {
        localStorage.setItem(STORAGE_KEY, Date.now().toString());
      } catch {
        // storage unavailable — non-fatal
      }
    } catch {
      // requestPermission threw — mark as prompted so we don't re-prompt
      try {
        await api('/notifications/preferences', {
          method: 'PATCH',
          body: JSON.stringify({
            browser_permission: 'denied',
            prompted_at: new Date().toISOString(),
          }),
        });
      } catch {
        // non-fatal
      }
      try { localStorage.setItem(STORAGE_KEY, Date.now().toString()); } catch {}
    } finally {
      setProcessing(false);
      setShowPrompt(false);
    }
  }, []);

  const handleNotNow = useCallback(async () => {
    // Save the "not now" choice so we don't re-prompt on every login
    try {
      await api('/notifications/preferences', {
        method: 'PATCH',
        body: JSON.stringify({
          prompted_at: new Date().toISOString(),
        }),
      });
    } catch {
      // non-fatal
    }
    try {
      localStorage.setItem(STORAGE_KEY, Date.now().toString());
    } catch {}
    setShowPrompt(false);
  }, []);

  if (!showPrompt) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center px-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 anim-fadeIn"
        style={{ background: 'rgba(0,0,0,.4)', backdropFilter: 'blur(4px)' }}
        onClick={handleNotNow}
      />

      {/* Card */}
      <div
        className="relative w-full max-w-sm rounded-3xl border p-6 text-center anim-scaleIn"
        style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}
      >
        {/* Icon */}
        <div
          className="w-14 h-14 mx-auto mb-4 rounded-2xl grid place-items-center text-2xl"
          style={{ background: 'var(--accent-soft)' }}
        >
          🔔
        </div>

        {/* Title */}
        <h2
          className="font-grotesk font-bold text-lg mb-2"
          style={{ color: 'var(--ink)' }}
        >
          Stay on track with Gym OS
        </h2>

        {/* Description */}
        <p
          className="text-sm leading-relaxed mb-6"
          style={{ color: 'var(--mute)' }}
        >
          Allow notifications for workout reminders, important updates, and other alerts.
        </p>

        {/* Buttons */}
        <div className="space-y-2.5">
          <button
            onClick={handleAllow}
            disabled={processing}
            className="btn-primary w-full !py-3 !rounded-xl"
          >
            {processing ? 'Enabling…' : 'Allow Notifications'}
          </button>
          <button
            onClick={handleNotNow}
            disabled={processing}
            className="w-full py-2.5 rounded-xl text-sm font-medium transition-colors"
            style={{ color: 'var(--mute)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(128,128,128,.06)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            Not Now
          </button>
        </div>
      </div>
    </div>
  );
}
