import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth.jsx';
import Icon from '../../components/Icon.jsx';
import { useCookieConsent } from '../../components/CookieConsent.jsx';
import { api } from '../../api.js';
import { useTheme } from '../../themeContext.jsx';
import { Toast } from '../../components/UI.jsx';

const SETTINGS_SECTIONS = [
  {
    id: 'account',
    label: 'Account Information',
    icon: 'user',
    fields: [
      { key: 'name', label: 'Name', type: 'text', placeholder: 'Your full name' },
      { key: 'email', label: 'Email', type: 'email', placeholder: 'your@email.com', readOnly: true },
      { key: 'phone', label: 'Phone Number', type: 'tel', placeholder: '+91 XXXXX XXXXX' },
    ]
  },
  {
    id: 'security',
    label: 'Security',
    icon: 'lock',
    fields: [
      { key: 'current_password', label: 'Current Password', type: 'password', placeholder: '••••••••' },
      { key: 'new_password', label: 'New Password', type: 'password', placeholder: '••••••••' },
      { key: 'confirm_password', label: 'Confirm New Password', type: 'password', placeholder: '••••••••' },
    ]
  }
];

export default function Settings() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [toast, setToast] = useState('');
  const [formState, setFormState] = useState({
    name: user?.name || '',
    email: user?.email || '',
    // Was hardcoded to '' -- /auth/me now returns phone (see auth.js), so
    // an existing number actually shows here instead of looking cleared
    // every time this page loads.
    phone: user?.phone || '',
  });

  const [busy, setBusy] = useState(false);

  const handleSave = async (section) => {
    if (section === 'Account Information') {
      setBusy(true);
      try {
        // Was only ever sending `name` -- the Phone Number field accepted
        // typing and showed "saved ✓" on submit, but the value was never
        // included in the request body, so it silently went nowhere (see
        // PUT /me/profile in me.js, which likewise never read `phone`
        // until now).
        await api('/me/profile', { method: 'PUT', body: JSON.stringify({ name: formState.name, phone: formState.phone }) });
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
            <span className="shrink-0" style={{ color: 'var(--accent)' }}><Icon name={section.icon} size={18} /></span>
            <span className="font-grotesk font-bold text-sm" style={{ color: 'var(--ink)' }}>{section.label}</span>
          </div>

          <div className="space-y-3">
            {section.fields.map((field) => (
              <label key={field.key} className="block">
                <span className="text-[10.5px] font-grotesk uppercase tracking-wider font-medium" style={{ color: 'var(--faint)' }}>{field.label}</span>
                <input
                  type={field.type}
                  className="input mt-1.5"
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

      <div className="card p-5">
        <div className="flex items-center gap-2.5 mb-1">
          <span className="shrink-0" style={{ color: 'var(--accent)' }}><Icon name="trending" size={18} /></span>
          <span className="font-grotesk font-bold text-sm" style={{ color: 'var(--ink)' }}>Health Intelligence</span>
        </div>
        <p className="text-[11px] mb-3" style={{ color: 'var(--mute)' }}>
          Connect a wearable so Barbell can combine it with your logged workouts for a more complete burn estimate.
        </p>
        <button className="btn w-full" onClick={() => nav('/app/client/health')}>Connected devices</button>
      </div>

      <AppearanceCard />
      <NotificationSettingsCard />
      <CookieSettingsCard />
    </div>
  );
}

/**
 * APPEARANCE — theme lived on the Profile page, not in Settings.
 *
 * Somebody looking for the theme switch goes to Settings; it was a
 * toggle buried in the Profile header instead, and Settings -- the
 * screen literally subtitled "Manage your account and preferences" --
 * had no appearance section at all.
 *
 * Three choices rather than a two-state switch, because "System" is a
 * real preference and not having it forces a decision the OS has already
 * made. The choice persists as the CHOICE (see themeContext): storing
 * the resolved value would silently convert "System" into whichever
 * appearance happened to be active at the time.
 */
function AppearanceCard() {
  const { theme, resolved, systemTheme, setTheme } = useTheme();
  const OPTIONS = [
    ['system', 'System', 'Follows your device'],
    ['light', 'Light', null],
    ['dark', 'Dark', null],
  ];
  return (
    <div className="card p-4">
      <div className="font-grotesk text-[10.5px] uppercase tracking-[.14em] font-medium mb-3" style={{ color: 'var(--mute)' }}>
        Appearance
      </div>
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-2">
        {OPTIONS.map(([value, label, hint]) => {
          const on = theme === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setTheme(value)}
              className="rounded-xl px-2 py-2.5 text-center"
              style={{
                background: on ? 'var(--accent-soft)' : 'transparent',
                border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
                color: on ? 'var(--accent)' : 'var(--mute)',
                minHeight: 56,
              }}
            >
              <div className="text-[12.5px] font-semibold">{label}</div>
              {hint && <div className="text-[9.5px] mt-0.5" style={{ color: 'var(--faint)' }}>{hint}</div>}
            </button>
          );
        })}
      </div>
      {/* Says what "System" currently resolves to, so the choice is not
          a guess about what the device is going to do. */}
      {theme === 'system' && (
        <div className="text-[11px] mt-2.5" style={{ color: 'var(--mute)' }}>
          Your device is set to <strong style={{ color: 'var(--ink)' }}>{systemTheme}</strong> right now.
        </div>
      )}
      {theme !== 'system' && (
        <div className="text-[11px] mt-2.5" style={{ color: 'var(--mute)' }}>
          Showing the {resolved} theme on every device you sign in on.
        </div>
      )}
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
    // Optimistic, so a toggle responds under the finger instead of after a
    // round trip. Reverted from the server's own response either way.
    setPrefs((p) => ({ ...p, [key]: value }));
    try {
      const d = await api('/notifications/preferences', {
        method: 'PATCH',
        body: JSON.stringify({ [key]: value }),
      });
      setPrefs(d?.preferences);
      setToast('Saved');
    } catch {
      setToast("Couldn't save that");
      try {
        const d = await api('/notifications/preferences');
        setPrefs(d?.preferences);
      } catch { /* leave the optimistic value rather than blanking the form */ }
    }
    setSaving(false);
  };

  if (!prefs) return null;

  /* GROUPED, and every row says what it actually does.
     The previous version was nine identically-weighted toggles with no
     explanation: "Incomplete workout" and "Tomorrow's workout" are not
     self-describing, and a flat list gives no clue which of them matter.
     Three groups matching the parts of the product a person already
     knows, one sentence each. */
  const GROUPS = [
    {
      title: 'Training',
      items: [
        ['workout_reminders', 'Workout reminder', 'On days you have a session scheduled.'],
        ['tomorrow_workout', "Tomorrow's session", 'An evening heads-up about what is next.'],
        ['incomplete_workout', 'Unfinished session', 'If you start a workout and never finish it.'],
        ['rest_day_reminders', 'Rest days', 'A nudge to actually rest when one is scheduled.'],
      ],
    },
    {
      title: 'Nutrition',
      items: [
        ['nutrition_reminders', 'Meal logging', 'If the day is going by with nothing logged.'],
        ['water_reminders', 'Water', 'Through the day, at the spacing you choose.'],
      ],
    },
    {
      title: 'Summary',
      items: [
        ['daily_summary', 'Daily recap', 'One message at the end of the day with how it went.'],
      ],
    },
  ];

  return (
    <div className="card p-5">
      <div className="flex items-center gap-2.5 mb-1">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        <span className="font-grotesk font-bold text-sm" style={{ color: 'var(--ink)' }}>Notifications</span>
      </div>

      {/* HONEST ABOUT DELIVERY. None of the reminders below are actually
          sent: this codebase has no scheduler and no push/email provider
          (see backend/src/routes/notifications.js's own header). Letting
          someone tune nine switches that produce silence, and then wonder
          why nothing arrives, is a worse experience than a cluttered
          screen. The preferences are real and are stored, so they apply
          the day delivery ships -- which is exactly what this says. */}
      <div
        className="rounded-xl px-3 py-2.5 mb-4 mt-2.5 text-[11.5px] leading-relaxed"
        style={{ background: 'var(--accent-soft)', border: '1px solid var(--line)', color: 'var(--mute)' }}
      >
        Scheduled reminders are not being sent yet. Your choices here are saved and will
        apply as soon as they are. Updates from your coach and your gym already appear in
        the bell at the top of the screen.
      </div>

      <ToggleRow
        label="All notifications"
        hint={prefs.enabled ? 'Reminders are on.' : 'Everything below is paused.'}
        checked={!!prefs.enabled}
        onChange={(v) => update('enabled', v ? 1 : 0)}
        disabled={saving}
        emphasis
      />

      {/* !! matters: prefs.enabled is the NUMBER 0 or 1, and `0 && x`
          evaluates to 0 -- which React renders as a literal "0" on the
          page rather than nothing. */}
      {!!prefs.enabled && (
        <div className="mt-1">
          {GROUPS.map((g) => (
            <div key={g.title} className="mt-3.5">
              <div className="text-[10px] uppercase tracking-[.14em] font-semibold mb-1" style={{ color: 'var(--faint)' }}>
                {g.title}
              </div>
              {g.items.map(([key, label, hint]) => (
                <div key={key}>
                  <ToggleRow
                    label={label}
                    hint={hint}
                    checked={!!prefs[key]}
                    onChange={(v) => update(key, v ? 1 : 0)}
                    disabled={saving}
                  />
                  {/* The dependent control sits INSIDE its own row's block
                      and only when its parent is on, so enabling a toggle
                      does not shuffle unrelated rows down the page. */}
                  {key === 'water_reminders' && prefs.water_reminders ? (
                    <div className="flex items-center justify-between pb-2.5 pl-1">
                      <span className="text-[11.5px]" style={{ color: 'var(--mute)' }}>Remind me every</span>
                      <select
                        className="input !py-1.5 !px-2 text-[12px]"
                        style={{ width: 104, minHeight: 38 }}
                        value={prefs.water_interval_h || 2}
                        onChange={(e) => update('water_interval_h', parseFloat(e.target.value))}
                        disabled={saving}
                        aria-label="Water reminder interval"
                      >
                        <option value={1}>1 hour</option>
                        <option value={2}>2 hours</option>
                        <option value={3}>3 hours</option>
                      </select>
                    </div>
                  ) : null}
                  {key === 'daily_summary' && prefs.daily_summary ? (
                    <div className="flex items-center justify-between pb-2.5 pl-1">
                      <span className="text-[11.5px]" style={{ color: 'var(--mute)' }}>Send it at</span>
                      <input
                        type="time"
                        className="input !py-1.5 !px-2 text-[12px]"
                        style={{ width: 104, minHeight: 38 }}
                        value={prefs.daily_summary_time || '23:30'}
                        onChange={(e) => update('daily_summary_time', e.target.value)}
                        disabled={saving}
                        aria-label="Daily recap time"
                      />
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ))}

          <div className="mt-4 pt-3.5" style={{ borderTop: '1px solid var(--line)' }}>
            <div className="text-[10px] uppercase tracking-[.14em] font-semibold mb-1.5" style={{ color: 'var(--faint)' }}>
              Quiet hours
            </div>
            <div className="text-[11.5px] mb-2" style={{ color: 'var(--mute)' }}>
              Nothing is sent between these times, whatever is switched on above.
            </div>
            <div className="flex items-center gap-2">
              <input
                type="time"
                className="input !py-1.5 !px-2 text-[12px] flex-1"
                style={{ minHeight: 42 }}
                value={prefs.quiet_hours_start || '23:45'}
                onChange={(e) => update('quiet_hours_start', e.target.value)}
                disabled={saving}
                aria-label="Quiet hours start"
              />
              <span className="text-[11px] shrink-0" style={{ color: 'var(--faint)' }}>to</span>
              <input
                type="time"
                className="input !py-1.5 !px-2 text-[12px] flex-1"
                style={{ minHeight: 42 }}
                value={prefs.quiet_hours_end || '07:00'}
                onChange={(e) => update('quiet_hours_end', e.target.value)}
                disabled={saving}
                aria-label="Quiet hours end"
              />
            </div>
          </div>
        </div>
      )}

      <Toast message={toast} onDone={() => setToast('')} />
    </div>
  );
}

/** A settings row: label, one line of plain English, and a switch that is
 *  a real 44px target. The old switch was 22px tall -- half the minimum
 *  for a finger, on the one control on the screen that exists to be
 *  tapped. */
function ToggleRow({ label, hint, checked, onChange, disabled, emphasis = false }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      disabled={disabled}
      role="switch"
      aria-checked={checked}
      className="w-full flex items-center justify-between gap-3 text-left"
      style={{ minHeight: 46, paddingTop: 4, paddingBottom: 4 }}
    >
      <span className="min-w-0 flex-1">
        <span
          className="block truncate"
          style={{ fontSize: emphasis ? 14 : 13, fontWeight: emphasis ? 700 : 550, color: 'var(--ink)' }}
        >
          {label}
        </span>
        {hint && (
          <span className="block text-[11px] mt-0.5 leading-snug" style={{ color: 'var(--mute)' }}>
            {hint}
          </span>
        )}
      </span>
      <span
        aria-hidden="true"
        className="relative shrink-0 rounded-full transition-colors"
        style={{ width: 42, height: 24, background: checked ? 'var(--accent)' : 'var(--line)' }}
      >
        <span
          className="absolute rounded-full transition-transform"
          style={{
            top: 3, left: 3, width: 18, height: 18,
            background: checked ? 'var(--accent-contrast)' : 'var(--panel)',
            transform: checked ? 'translateX(18px)' : 'translateX(0)',
            boxShadow: '0 1px 2px rgba(0,0,0,.3)',
          }}
        />
      </span>
    </button>
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
