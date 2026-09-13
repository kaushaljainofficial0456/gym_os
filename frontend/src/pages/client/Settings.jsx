import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth.jsx';
import Icon from '../../components/Icon.jsx';
import { useCookieConsent } from '../../components/CookieConsent.jsx';
import { api } from '../../api.js';
import { useTheme } from '../../themeContext.jsx';
import { useUnits } from '../../unitsContext.jsx';
import { Toast } from '../../components/UI.jsx';

const SETTINGS_SECTIONS = [
  {
    id: 'account',
    label: 'Account Information',
    icon: 'user',
    fields: [
      { key: 'name', label: 'Name', type: 'text', placeholder: 'Your full name', autoComplete: 'name' },
      { key: 'email', label: 'Email', type: 'email', placeholder: 'your@email.com', readOnly: true, autoComplete: 'email' },
      { key: 'phone', label: 'Phone Number', type: 'tel', placeholder: '+91 XXXXX XXXXX', autoComplete: 'tel' },
    ]
  },
  {
    id: 'security',
    label: 'Security',
    icon: 'lock',
    fields: [
      /* autoComplete matters on a password form: without it a manager
         cannot tell the current field from the new one, and offers to
         overwrite the saved entry with whatever is in the first box. */
      { key: 'current_password', label: 'Current Password', type: 'password', placeholder: '••••••••', autoComplete: 'current-password' },
      { key: 'new_password', label: 'New Password', type: 'password', placeholder: '••••••••', autoComplete: 'new-password' },
      { key: 'confirm_password', label: 'Confirm New Password', type: 'password', placeholder: '••••••••', autoComplete: 'new-password' },
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
    <div className="space-y-6">
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

      {/* GROUPED, because eight peer cards in one column is a list, not a
          structure: nothing told you that Appearance and Units are the
          same kind of thing as each other and a different kind of thing
          from your password. The groups are the three questions people
          actually arrive with -- who am I, how should the app behave,
          what does it know about me. */}
      <Group title="Account" hint="Who you are and how you sign in.">
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
                    autoComplete={field.autoComplete}
                    onChange={(e) => setFormState((s) => ({ ...s, [field.key]: e.target.value }))}
                  />
                  {field.readOnly && (
                    <span className="text-[9px] mt-0.5 block" style={{ color: 'var(--faint)' }}>This field cannot be changed here</span>
                  )}
                </label>
              ))}
            </div>

            {/* THE BUTTON BELONGS TO THE FIELDS ABOVE IT. "Change
                Password" used to live in a card of its own, one card
                below the password fields and directly under an unrelated
                block -- so the only control that acted on those three
                inputs appeared to belong to something else. */}
            {section.id === 'security' ? (
              <>
                <button className="btn-primary w-full mt-4" onClick={handlePassword} disabled={busy}>
                  {busy ? 'Saving…' : 'Change password'}
                </button>
                <div className="text-[9px] mt-2 text-center" style={{ color: 'var(--faint)' }}>
                  Password changes require your current password for verification
                </div>
              </>
            ) : (
              <button className="btn-primary w-full mt-4" onClick={() => handleSave(section.label)} disabled={busy}>
                Save changes
              </button>
            )}
          </div>
        ))}

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
      </Group>

      <Group title="Preferences" hint="How Barbell looks and what it tells you.">
        <AppearanceCard />
        <UnitsCard />
        <NotificationSettingsCard />
      </Group>

      <Group title="Data & connections" hint="What Barbell reads, stores and remembers.">
        <PrivacyCard />
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
        <CookieSettingsCard />
      </Group>
    </div>
  );
}

/**
 * One labelled group of setting cards.
 *
 * The heading is a real landmark, not a decoration: it is the thing a
 * person scans for when they already know what they want to change, and
 * an h2 gives screen readers the same shortcut the eye gets.
 */
function Group({ title, hint, children }) {
  return (
    <section className="space-y-3">
      <div className="px-0.5">
        <h2 className="font-grotesk text-[10.5px] uppercase tracking-[.16em] font-bold" style={{ color: 'var(--accent)' }}>
          {title}
        </h2>
        {hint && <p className="text-[11px] mt-0.5" style={{ color: 'var(--faint)' }}>{hint}</p>}
      </div>
      {children}
    </section>
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

/**
 * UNITS — display preference, not a data migration.
 *
 * Switching this changes what is drawn and how typed input is read. Every
 * weight stays stored in kilograms and every length in centimetres, so
 * the underlying numbers are byte-identical before and after and nothing
 * can drift by round-tripping through a display unit. Said plainly on
 * screen, because "will this change my history?" is the obvious worry and
 * the honest answer is no.
 */
function UnitsCard() {
  const { system, setSystem, fmtWeight, fmtHeight } = useUnits();
  const [err, setErr] = useState('');
  const OPTIONS = [
    ['metric', 'Metric', 'kg · cm'],
    ['imperial', 'Imperial', 'lb · ft/in'],
  ];
  return (
    <div className="card p-4">
      <div className="font-grotesk text-[10.5px] uppercase tracking-[.14em] font-medium mb-3" style={{ color: 'var(--mute)' }}>
        Units
      </div>
      <div role="radiogroup" aria-label="Measurement units" className="grid grid-cols-2 gap-2">
        {OPTIONS.map(([value, label, hint]) => {
          const on = system === value;
          return (
            <button
              key={value} type="button" role="radio" aria-checked={on}
              onClick={async () => {
                setErr('');
                try { await setSystem(value); } catch (e) { setErr(e.message || "Couldn't save that"); }
              }}
              className="rounded-xl px-2 py-2.5 text-center"
              style={{
                background: on ? 'var(--accent-soft)' : 'transparent',
                border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
                color: on ? 'var(--accent)' : 'var(--mute)',
                minHeight: 56,
              }}
            >
              <div className="text-[12.5px] font-semibold">{label}</div>
              <div className="text-[9.5px] mt-0.5" style={{ color: 'var(--faint)' }}>{hint}</div>
            </button>
          );
        })}
      </div>
      {/* A live example beats an abstract label: it shows the exact
          formatting the rest of the app will use. */}
      <div className="text-[11px] mt-2.5" style={{ color: 'var(--mute)' }}>
        Weights show as <strong style={{ color: 'var(--ink)' }}>{fmtWeight(75)}</strong>,
        height as <strong style={{ color: 'var(--ink)' }}>{fmtHeight(175)}</strong>.
        Your recorded data is unchanged — only how it is displayed.
      </div>
      {err && <div className="text-[11.5px] mt-2" role="alert" style={{ color: 'var(--bad)' }}>{err}</div>}
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

/**
 * PRIVACY — who can see what, from the screen people look for it on.
 *
 * Both of these settings already existed and already worked. They lived
 * only inside the Community page, which is the one place a person is not
 * looking when the question in their head is "what is this app sharing
 * about me". Settings is where that question gets asked.
 *
 * ONLY REAL SETTINGS APPEAR HERE. There is no toggle for sleep, recovery,
 * heart rate, bodyweight or nutrition sharing, because none of that is
 * ever put into a community payload in the first place -- a switch
 * implying it could be would be a worse answer than the sentence below
 * it, which states the actual behaviour.
 */
function PrivacyCard() {
  const [prefs, setPrefs] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState(null);

  useEffect(() => {
    let alive = true;
    api('/community/preferences')
      .then((p) => { if (alive) setPrefs(p); })
      .catch((e) => { if (alive) setErr(e.message); });
    api('/community/membership')
      .then((m) => { if (alive) setJoined(m?.joined ?? null); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const save = async (patch, optimistic) => {
    const before = prefs;
    setPrefs((p) => ({ ...p, ...optimistic }));
    setBusy(true);
    setErr('');
    try {
      // snake_case: this endpoint reads it, even though GET answers in
      // camelCase. Sending the shape it returns changes nothing.
      await api('/community/preferences', { method: 'PUT', body: JSON.stringify(patch) });
    } catch (e) {
      setPrefs(before);            // never show a setting that is not stored
      setErr(e.message || 'Could not save that');
    }
    setBusy(false);
  };

  const PR_OPTIONS = [
    ['everyone', 'Everyone at the gym', 'Your personal records appear in the gym feed and leaderboards.'],
    ['followers', 'Only my followers', 'People who follow you see your records; nobody else does.'],
    ['nobody', 'Nobody', 'Your records stay private. You still see them yourself.'],
  ];

  return (
    <div className="card p-5">
      <div className="flex items-center gap-2.5 mb-1">
        <span className="shrink-0" style={{ color: 'var(--accent)' }}><Icon name="lock" size={18} /></span>
        <span className="font-grotesk font-bold text-sm" style={{ color: 'var(--ink)' }}>Privacy</span>
      </div>
      <p className="text-[11px] mb-3" style={{ color: 'var(--mute)' }}>
        What other people at your gym can see.
      </p>

      {!prefs && !err && <div className="text-[11px]" style={{ color: 'var(--faint)' }}>Loading…</div>}
      {err && <div className="text-[11px] mb-2" style={{ color: 'var(--bad)' }} role="alert">{err}</div>}

      {prefs && (
        <>
          <div className="font-grotesk text-[10px] uppercase tracking-[.12em] mb-1.5" style={{ color: 'var(--faint)' }}>
            Who sees my personal records
          </div>
          <div className="space-y-1.5">
            {PR_OPTIONS.map(([value, label, hint]) => {
              const on = prefs.prVisibility === value;
              return (
                <button
                  key={value}
                  type="button"
                  disabled={busy}
                  aria-pressed={on}
                  onClick={() => save({ pr_visibility: value }, { prVisibility: value })}
                  className="w-full text-left rounded-xl px-3 py-2.5 transition-colors"
                  style={{
                    border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
                    background: on ? 'var(--bg2)' : 'transparent',
                  }}
                >
                  <div className="text-[12.5px] font-semibold" style={{ color: 'var(--ink)' }}>{label}</div>
                  <div className="text-[10.5px] leading-snug mt-0.5" style={{ color: 'var(--faint)' }}>{hint}</div>
                </button>
              );
            })}
          </div>

          <div className="font-grotesk text-[10px] uppercase tracking-[.12em] mt-4 mb-1.5" style={{ color: 'var(--faint)' }}>
            My feed
          </div>
          <div className="flex gap-1.5">
            {[['all', 'Everyone'], ['following', 'Only people I follow']].map(([value, label]) => {
              const on = prefs.feedScope === value;
              return (
                <button
                  key={value}
                  type="button"
                  disabled={busy}
                  aria-pressed={on}
                  onClick={() => save({ feed_scope: value }, { feedScope: value })}
                  className="flex-1 rounded-lg py-2 text-[11.5px] font-semibold transition-colors"
                  style={{
                    border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
                    background: on ? 'var(--bg2)' : 'transparent',
                    color: on ? 'var(--ink)' : 'var(--mute)',
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <p className="text-[10px] mt-1.5" style={{ color: 'var(--faint)' }}>
            This changes what you see, not what others see of you.
          </p>
        </>
      )}

      {/* The statement of what is NEVER shared. It is a sentence rather
          than a row of switched-off toggles because there is nothing to
          switch: this data is not put into a community payload at all. */}
      <div className="mt-4 pt-3" style={{ borderTop: '1px solid var(--line)' }}>
        <div className="text-[11px] leading-snug" style={{ color: 'var(--mute)' }}>
          Your weight, measurements, food log, sleep, recovery and anything from a connected
          device are <strong style={{ color: 'var(--ink)' }}>never</strong> shared with your gym's
          community — only your workouts, personal records and streaks, and only as set above.
        </div>
        {joined === false && (
          <div className="text-[11px] mt-2" style={{ color: 'var(--faint)' }}>
            You are not currently in your gym's community.
          </div>
        )}
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
