import { useState, useEffect } from 'react';
import { useAuth } from '../../auth.jsx';
import { useCookieConsent } from '../../components/CookieConsent.jsx';
import { api } from '../../api.js';

const SETTINGS_SECTIONS = [
  {
    id: 'account',
    label: 'Account Information',
    icon: '👤',
    fields: [
      { key: 'name', label: 'Name', type: 'text', placeholder: 'Your full name' },
      { key: 'email', label: 'Email', type: 'email', placeholder: 'your@email.com', readOnly: true },
      { key: 'phone', label: 'Phone Number', type: 'tel', placeholder: '+91 XXXXX XXXXX' },
    ]
  },
  {
    id: 'security',
    label: 'Security',
    icon: '🔒',
    fields: [
      { key: 'current_password', label: 'Current Password', type: 'password', placeholder: '••••••••' },
      { key: 'new_password', label: 'New Password', type: 'password', placeholder: '••••••••' },
      { key: 'confirm_password', label: 'Confirm New Password', type: 'password', placeholder: '••••••••' },
    ]
  }
];

export default function Settings() {
  const { user } = useAuth();
  const [toast, setToast] = useState('');
  const [formState, setFormState] = useState({
    name: user?.name || '',
    email: user?.email || '',
    phone: '',
  });

  const [busy, setBusy] = useState(false);

  const handleSave = async (section) => {
    if (section === 'Account Information') {
      setBusy(true);
      try {
        await api('/me/profile', { method: 'PUT', body: JSON.stringify({ name: formState.name }) });
        setToast('Account information saved ✓');
      } catch (e) { setToast(e.message || 'Save failed'); }
      setBusy(false);
    } else {
      setToast(`${section} settings saved ✓`);
    }
    setTimeout(() => setToast(''), 2400);
  };

  const handlePassword = async () => {
    if (!formState.current_password || !formState.new_password) {
      setToast('Please fill in both password fields');
      return;
    }
    if (formState.new_password !== formState.confirm_password) {
      setToast('New passwords do not match');
      return;
    }
    if (formState.new_password.length < 6) {
      setToast('New password must be at least 6 characters');
      return;
    }
    setBusy(true);
    try {
      await api('/auth/change-password', { method: 'POST', body: JSON.stringify({ current_password: formState.current_password, new_password: formState.new_password }) });
      setToast('Password changed successfully ✓');
      setFormState(s => ({ ...s, current_password: '', new_password: '', confirm_password: '' }));
    } catch (e) { setToast(e.message || 'Password change failed'); }
    setBusy(false);
    setTimeout(() => setToast(''), 2400);
  };

  return (
    <div className="space-y-5">
      {toast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 rounded-xl border border-gold/40 px-4 py-2 text-sm shadow-card anim-fadeUp"
          style={{ background: 'var(--panel)', color: 'var(--ink)' }}>
          {toast}
        </div>
      )}

      <div>
        <h1 className="font-display font-bold text-2xl tracking-tight" style={{ color: 'var(--ink)' }}>Settings</h1>
        <div className="text-xs mt-0.5" style={{ color: 'var(--mute)' }}>Manage your account and preferences</div>
      </div>

      {SETTINGS_SECTIONS.map((section) => (
        <div key={section.id} data-tour={`settings-${section.id}`} className="card p-5">
          <div className="flex items-center gap-2.5 mb-4">
            <span className="text-lg">{section.icon}</span>
            <span className="font-grotesk font-bold text-sm" style={{ color: 'var(--ink)' }}>{section.label}</span>
          </div>

          <div className="space-y-3">
            {section.fields.map((field) => (
              <label key={field.key} className="block">
                <span className="text-[10.5px] font-grotesk uppercase tracking-wider font-medium" style={{ color: 'var(--faint)' }}>{field.label}</span>
                <input
                  type={field.type}
                  className="input mt-1"
                  placeholder={field.placeholder}
                  value={formState[field.key] || ''}
                  readOnly={field.readOnly}
                  onChange={(e) => setFormState((s) => ({ ...s, [field.key]: e.target.value }))}
                />
                {field.readOnly && (
                  <span className="text-[9px] mt-0.5 block" style={{ color: 'var(--faint)' }}>This field cannot be changed here</span>
                )}
              </label>
            ))}
          </div>

          {section.id !== 'security' && (
            <button
              className="btn-primary w-full mt-4"
              onClick={() => handleSave(section.label)}
            >
              Save {section.label}
            </button>
          )}
        </div>
      ))}

      <div className="card p-5">
        <button
          className="btn-primary w-full"
          onClick={handlePassword}
          disabled={busy}
        >
          {busy ? 'Saving...' : 'Change Password'}
        </button>
        <div className="text-[9px] mt-2 text-center" style={{ color: 'var(--faint)' }}>
          Password changes require your current password for verification
        </div>
      </div>

      <div className="card p-5">
        <div className="font-grotesk text-[10.5px] uppercase tracking-[.14em] font-medium mb-3" style={{ color: 'var(--mute)' }}>Account Details</div>
        <div className="space-y-2.5">
          <div className="flex justify-between items-center text-sm">
            <span style={{ color: 'var(--mute)' }}>Account type</span>
            <span className="font-grotesk font-semibold" style={{ color: 'var(--ink)' }}>Client</span>
          </div>
          <div className="flex justify-between items-center text-sm">
            <span style={{ color: 'var(--mute)' }}>Status</span>
            <span className="chip border-good/40 text-good !text-[10px]">Active</span>
          </div>
        </div>
      </div>

      <NotificationSettingsCard />
      <CookieSettingsCard />
    </div>
  );
}

function NotificationSettingsCard() {
  const [prefs, setPrefs] = useState(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');

  useEffect(() => {
    api('/notifications/preferences').then((d) => setPrefs(d?.preferences)).catch(() => {});
  }, []);

  const update = async (key, value) => {
    setSaving(true);
    try {
      const d = await api('/notifications/preferences', {
        method: 'PATCH',
        body: JSON.stringify({ [key]: value }),
      });
      setPrefs(d?.preferences);
      setToast('Saved ✓');
      setTimeout(() => setToast(''), 2000);
    } catch (e) { setToast('Failed to save'); setTimeout(() => setToast(''), 2000); }
    setSaving(false);
  };

  if (!prefs) return null;

  const Toggle = ({ label, checked, onChange }) => (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-sm" style={{ color: 'var(--ink)' }}>{label}</span>
      <button
        onClick={() => onChange(!checked)}
        className="relative w-10 h-[22px] rounded-full transition-colors"
        style={{ background: checked ? 'var(--accent)' : 'var(--line)' }}
        disabled={saving}
      >
        <span
          className="absolute top-[3px] w-4 h-4 rounded-full bg-white shadow-sm transition-transform"
          style={{ transform: checked ? 'translateX(22px)' : 'translateX(3px)' }}
        />
      </button>
    </div>
  );

  return (
    <div className="card p-5">
      {toast && (
        <div className="text-[10px] text-center mb-2 font-medium" style={{ color: 'var(--good)' }}>{toast}</div>
      )}
      <div className="flex items-center gap-2.5 mb-3">
        <span className="text-lg">🔔</span>
        <span className="font-grotesk font-bold text-sm" style={{ color: 'var(--ink)' }}>Notifications</span>
      </div>

      <div className="space-y-0.5">
        <Toggle label="All notifications" checked={!!prefs.enabled} onChange={(v) => update('enabled', v ? 1 : 0)} />

        {prefs.enabled ? (
          <>
            <div className="my-2" style={{ borderTop: '1px solid var(--line)' }} />
            <Toggle label="Workout reminders" checked={!!prefs.workout_reminders} onChange={(v) => update('workout_reminders', v ? 1 : 0)} />
            <Toggle label="Water reminders" checked={!!prefs.water_reminders} onChange={(v) => update('water_reminders', v ? 1 : 0)} />
            {prefs.water_reminders ? (
              <div className="flex items-center justify-between py-1.5 pl-4">
                <span className="text-xs" style={{ color: 'var(--faint)' }}>Every</span>
                <select
                  className="input !py-1 !px-2 text-xs w-24"
                  value={prefs.water_interval_h || 2}
                  onChange={(e) => update('water_interval_h', parseFloat(e.target.value))}
                  disabled={saving}
                >
                  <option value={1}>1 hour</option>
                  <option value={2}>2 hours</option>
                  <option value={3}>3 hours</option>
                </select>
              </div>
            ) : null}
            <Toggle label="Nutrition reminders" checked={!!prefs.nutrition_reminders} onChange={(v) => update('nutrition_reminders', v ? 1 : 0)} />
            <Toggle label="Daily summary" checked={!!prefs.daily_summary} onChange={(v) => update('daily_summary', v ? 1 : 0)} />
            {prefs.daily_summary ? (
              <div className="flex items-center justify-between py-1.5 pl-4">
                <span className="text-xs" style={{ color: 'var(--faint)' }}>At</span>
                <input
                  type="time"
                  className="input !py-1 !px-2 text-xs w-24"
                  value={prefs.daily_summary_time || '23:30'}
                  onChange={(e) => update('daily_summary_time', e.target.value)}
                  disabled={saving}
                />
              </div>
            ) : null}
            <Toggle label="Tomorrow's workout" checked={!!prefs.tomorrow_workout} onChange={(v) => update('tomorrow_workout', v ? 1 : 0)} />
            <Toggle label="Rest-day reminders" checked={!!prefs.rest_day_reminders} onChange={(v) => update('rest_day_reminders', v ? 1 : 0)} />
            <Toggle label="Incomplete workout" checked={!!prefs.incomplete_workout} onChange={(v) => update('incomplete_workout', v ? 1 : 0)} />

            <div className="my-2" style={{ borderTop: '1px solid var(--line)' }} />
            <div className="flex items-center justify-between py-1.5">
              <span className="text-sm" style={{ color: 'var(--ink)' }}>Quiet hours</span>
              <div className="flex items-center gap-1.5">
                <input
                  type="time"
                  className="input !py-1 !px-1.5 text-[10px] w-20"
                  value={prefs.quiet_hours_start || '23:45'}
                  onChange={(e) => update('quiet_hours_start', e.target.value)}
                  disabled={saving}
                />
                <span className="text-[10px]" style={{ color: 'var(--faint)' }}>to</span>
                <input
                  type="time"
                  className="input !py-1 !px-1.5 text-[10px] w-20"
                  value={prefs.quiet_hours_end || '07:00'}
                  onChange={(e) => update('quiet_hours_end', e.target.value)}
                  disabled={saving}
                />
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function CookieSettingsCard() {
  const { openPreferences, categories } = useCookieConsent();
  return (
    <div className="card p-5">
      <div className="font-grotesk text-[10.5px] uppercase tracking-[.14em] font-medium mb-3" style={{ color: 'var(--mute)' }}>Privacy &amp; Cookies</div>
      <div className="space-y-2.5 text-sm mb-4">
        <div className="flex justify-between items-center">
          <span style={{ color: 'var(--mute)' }}>Essential cookies</span>
          <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>Always on</span>
        </div>
        {['preferences', 'analytics', 'marketing'].map((cat) => (
          <div key={cat} className="flex justify-between items-center">
            <span style={{ color: 'var(--mute)' }}>{cat.charAt(0).toUpperCase() + cat.slice(1)}</span>
            <span className={`text-[10px] font-semibold ${categories[cat] ? 'text-[var(--good)]' : 'text-[var(--faint)]'}`}>
              {categories[cat] ? 'On' : 'Off'}
            </span>
          </div>
        ))}
      </div>
      <button onClick={openPreferences} className="btn w-full text-xs">
        Manage cookie preferences
      </button>
    </div>
  );
}
