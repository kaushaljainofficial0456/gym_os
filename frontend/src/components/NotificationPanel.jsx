// ============================================================
// NOTIFICATION PANEL — dropdown notification center.
// Shows recent notifications grouped by TODAY / EARLIER.
// Uses existing Gym OS design tokens and card styling.
// ============================================================
import { Spinner } from './UI.jsx';

const TYPE_ICONS = {
  water_reminder: '💧',
  workout_reminder: '💪',
  tomorrow_workout: '💪',
  rest_day: '🌙',
  daily_summary: '📊',
  nutrition_reminder: '🍽️',
  incomplete_workout: '🏋️',
  message: '💬',
  weekly_report: '📈',
  workout_update: '💪',
  nutrition_update: '🍽️',
  default: '🔔',
};

function timeAgo(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now - d;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  } catch {
    return '';
  }
}

function isToday(dateStr) {
  if (!dateStr) return false;
  try {
    const d = new Date(dateStr);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  } catch {
    return false;
  }
}

export default function NotificationPanel({ notifications = [], loading, onMarkAllRead, onClick, onClose }) {
  const unread = notifications.filter((n) => !n.read);
  const read = notifications.filter((n) => n.read);

  return (
    <div
      className="w-[340px] max-h-[480px] rounded-2xl border overflow-hidden flex flex-col"
      style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--line)' }}>
        <div className="flex items-center gap-2">
          <span className="font-grotesk text-sm font-bold" style={{ color: 'var(--ink)' }}>Notifications</span>
          {unread.length > 0 && (
            <span
              className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
              style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
            >
              {unread.length} new
            </span>
          )}
        </div>
        {unread.length > 0 && (
          <button
            onClick={onMarkAllRead}
            className="text-[10px] font-medium transition-colors"
            style={{ color: 'var(--accent)' }}
          >
            Mark all read
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto" style={{ maxHeight: '400px' }}>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner />
          </div>
        ) : notifications.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
            <span className="text-2xl mb-2">🔔</span>
            <span className="font-grotesk text-xs" style={{ color: 'var(--faint)' }}>
              No notifications yet
            </span>
            <span className="text-[10px] mt-1" style={{ color: 'var(--faint)' }}>
              We'll keep you updated on your fitness journey
            </span>
          </div>
        ) : (
          <>
            {unread.length > 0 && (
              <div>
                <div className="px-4 py-1.5">
                  <span className="text-[9px] font-grotesk uppercase tracking-[.14em] font-medium" style={{ color: 'var(--faint)' }}>
                    New
                  </span>
                </div>
                {unread.map((n) => (
                  <NotificationRow key={n.id} notif={n} onClick={onClick} />
                ))}
              </div>
            )}
            {read.length > 0 && (
              <div>
                {unread.length > 0 && (
                  <div className="px-4 py-1.5" style={{ borderTop: '1px solid var(--line)' }}>
                    <span className="text-[9px] font-grotesk uppercase tracking-[.14em] font-medium" style={{ color: 'var(--faint)' }}>
                      Earlier
                    </span>
                  </div>
                )}
                {read.map((n) => (
                  <NotificationRow key={n.id} notif={n} onClick={onClick} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function NotificationRow({ notif, onClick }) {
  const icon = TYPE_ICONS[notif.type] || TYPE_ICONS.default;
  const unread = !notif.read;

  return (
    <button
      onClick={() => onClick(notif)}
      className="w-full flex items-start gap-3 px-4 py-3 text-left transition-colors"
      style={{
        background: unread ? 'rgba(128,128,128,.04)' : 'transparent',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(128,128,128,.06)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = unread ? 'rgba(128,128,128,.04)' : 'transparent'; }}
    >
      {/* Icon */}
      <div className="flex-shrink-0 mt-0.5">
        <span className="text-base leading-none">{icon}</span>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span
            className="font-grotesk text-[11.5px] font-semibold truncate"
            style={{ color: 'var(--ink)' }}
          >
            {notif.title}
          </span>
          {unread && (
            <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
          )}
        </div>
        {notif.body && (
          <p className="text-[10.5px] mt-0.5 line-clamp-2 leading-relaxed" style={{ color: 'var(--mute)' }}>
            {notif.body}
          </p>
        )}
        <span className="text-[9px] mt-1 block" style={{ color: 'var(--faint)' }}>
          {timeAgo(notif.created_at)}
        </span>
      </div>
    </button>
  );
}
