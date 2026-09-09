// ============================================================
// NOTIFICATION BELL — header bell icon with unread count badge.
// Clicking opens the NotificationPanel.
// Uses existing design tokens and icon patterns from ClientLayout.
// ============================================================
import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import NotificationPanel from './NotificationPanel.jsx';

export default function NotificationBell() {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef(null);
  const bellRef = useRef(null);

  // Poll unread count every 60 seconds
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const data = await api('/notifications/unread-count');
        if (active && data?.unreadCount != null) setUnreadCount(data.unreadCount);
      } catch {}
    };
    poll();
    const iv = setInterval(poll, 60000);
    return () => { active = false; clearInterval(iv); };
  }, []);

  // Trigger notification generation on mount (and every 5 minutes)
  useEffect(() => {
    let active = true;
    const generate = async () => {
      try {
        const data = await api('/notifications/generate', { method: 'POST' });
        if (active && data?.notifications?.length) {
          setUnreadCount((c) => c + data.notifications.length);
          // If panel is open, prepend new notifications
          if (open) {
            setNotifications((prev) => [...data.notifications, ...prev]);
          }
        }
      } catch {}
    };
    generate();
    const iv = setInterval(generate, 5 * 60 * 1000);
    return () => { active = false; clearInterval(iv); };
  }, []);

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target) && bellRef.current && !bellRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = useCallback(async () => {
    if (!open) {
      // Load notifications
      setLoading(true);
      try {
        const data = await api('/notifications?limit=30');
        setNotifications(data?.notifications || []);
        if (data?.unreadCount != null) setUnreadCount(data.unreadCount);
      } catch {}
      setLoading(false);
    }
    setOpen((v) => !v);
  }, [open]);

  const handleMarkAllRead = useCallback(async () => {
    try {
      await api('/notifications/read-all', { method: 'POST' });
      setUnreadCount(0);
      setNotifications((prev) => prev.map((n) => ({ ...n, read: 1 })));
    } catch {}
  }, []);

  const handleMarkRead = useCallback(async (notifId) => {
    try {
      await api(`/notifications/${notifId}/read`, { method: 'PATCH' });
      setUnreadCount((c) => Math.max(0, c - 1));
      setNotifications((prev) => prev.map((n) => n.id === notifId ? { ...n, read: 1 } : n));
    } catch {}
  }, []);

  const handleClick = useCallback((notif) => {
    // Mark as read
    if (!notif.read) handleMarkRead(notif.id);
    // Navigate based on type
    setOpen(false);
    switch (notif.type) {
      case 'workout_reminder':
      case 'incomplete_workout':
        nav('/app/client/workout');
        break;
      case 'water_reminder':
        nav('/app/client');
        break;
      case 'nutrition_reminder':
        nav('/app/client/nutrition');
        break;
      case 'daily_summary':
      case 'rest_day':
      case 'tomorrow_workout':
        nav('/app/client');
        break;
      default:
        break;
    }
  }, [nav, handleMarkRead]);

  return (
    <div className="relative">
      <button
        ref={bellRef}
        onClick={toggle}
        className="relative flex items-center gap-1.5 py-1.5 px-2 rounded-xl transition-colors"
        style={{ color: open ? 'var(--ink)' : 'var(--mute)' }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(128,128,128,.08)'; e.currentTarget.style.color = 'var(--ink)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = open ? 'rgba(128,128,128,.06)' : 'transparent'; e.currentTarget.style.color = open ? 'var(--ink)' : 'var(--mute)'; }}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        aria-expanded={open}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 flex items-center justify-center rounded-full text-[9px] font-bold px-1"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div ref={panelRef} className="absolute right-0 top-full mt-2 z-50 anim-scaleIn">
          <NotificationPanel
            notifications={notifications}
            loading={loading}
            onMarkAllRead={handleMarkAllRead}
            onClick={handleClick}
            onClose={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
