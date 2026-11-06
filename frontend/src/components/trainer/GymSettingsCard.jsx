/**
 * GYM SETTINGS -- the gym's name, its sign-up code, the live-crowd switch,
 * what clients may change in their workouts, and the community. Lives on
 * Setup & billing; it used to sit in the middle of the Payments page,
 * between the revenue chart and the payments table, where nobody looking
 * for it would think to check.
 *
 * Every field has a visible label: they were placeholders, which vanish
 * the moment you type, leaving a column of unlabelled boxes.
 */
import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useFetch } from '../../utils.js';
import { Card, ErrorState } from '../UI.jsx';
import Select from '../Select.jsx';

const MODE_HELP = {
  hybrid: 'You prescribe; clients can personalise.',
  prescribed: 'You control every workout.',
  custom: 'Clients build their own workouts.',
};

function Toggle({ checked, onChange, label }) {
  return (
    <label className="flex items-center gap-3 min-h-[44px] cursor-pointer text-[14.5px]" style={{ color: 'var(--ink)' }}>
      <input type="checkbox" className="w-[20px] h-[20px] shrink-0 accent-[var(--accent)]" checked={!!checked} onChange={(e) => onChange(e.target.checked ? 1 : 0)} />
      {label}
    </label>
  );
}

export default function GymSettingsCard() {
  const { user } = useAuth();
  const settings = useFetch(() => api('/admin/settings'));
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => { if (settings.data?.settings) setForm((f) => f || settings.data.settings); }, [settings.data]);
  useEffect(() => { if (!note) return undefined; const h = setTimeout(() => setNote(''), 2600); return () => clearTimeout(h); }, [note]);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  // orgSlug from /auth/login, org_slug from /auth/me after a refresh: the
  // API is not consistently camelCased, so both are read.
  const code = user?.orgSlug || user?.org_slug;

  const save = async () => {
    setSaving(true);
    try {
      await api('/admin/settings', { method: 'PUT', body: JSON.stringify({ ...form, crowd_capacity: Number(form.crowd_capacity) || 150 }) });
      setNote('Saved');
      settings.reload({ silent: true });
    } catch (e) { setNote(e.message || 'Could not save'); }
    setSaving(false);
  };

  return (
    <Card className="p-5 sm:p-6">
      <h2 className="ws-section-title">Gym settings</h2>
      {settings.error ? <div className="mt-3"><ErrorState error={settings.error} onRetry={settings.reload} /></div> : null}

      {code && (
        <div className="mt-4 rounded-2xl p-4 flex items-center justify-between flex-wrap gap-3" style={{ border: '1px solid var(--line)', background: 'rgb(var(--tint-rgb) / .03)' }}>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold" style={{ color: 'var(--mute)' }}>Gym code for client sign-up</div>
            <div className="text-[20px] font-extrabold tracking-tight mt-0.5" style={{ color: 'var(--ink)' }}>{code}</div>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => { navigator.clipboard?.writeText(code); setNote('Gym code copied'); }}>Copy code</button>
        </div>
      )}

      {form && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5 mt-5">
          <div className="space-y-4">
            <label className="block">
              <span className="field-label">Gym name</span>
              <input className="input mt-1.5" value={form.brand_name || ''} onChange={(e) => set('brand_name')(e.target.value)} />
            </label>
            <label className="block">
              <span className="field-label">Tagline</span>
              <input className="input mt-1.5" placeholder="Train hard, recover smarter" value={form.tagline || ''} onChange={(e) => set('tagline')(e.target.value)} />
            </label>
            <label className="block">
              <span className="field-label">Gym capacity (people)</span>
              <input className="input mt-1.5" type="number" min={1} value={form.crowd_capacity ?? ''} onChange={(e) => set('crowd_capacity')(e.target.value)} />
            </label>
            <Toggle checked={form.crowd_enabled} onChange={set('crowd_enabled')} label="Show members how busy the gym is" />
          </div>

          <div className="space-y-4">
            <label className="block">
              <span className="field-label">New clients' workouts</span>
              <span className="block mt-1.5">
                <Select aria-label="New clients' workouts" value={form.workout_mode_default} onChange={set('workout_mode_default')}
                  options={[['hybrid', 'Hybrid'], ['prescribed', 'Prescribed'], ['custom', 'Custom']].map(([value, label]) => ({ value, label, hint: MODE_HELP[value] }))} />
              </span>
              <span className="block text-[13px] mt-1.5" style={{ color: 'var(--mute)' }}>{MODE_HELP[form.workout_mode_default] || ''}</span>
            </label>
            <div>
              <Toggle checked={form.allow_substitute} onChange={set('allow_substitute')} label="Clients may swap exercises" />
              <Toggle checked={form.allow_add_exercise} onChange={set('allow_add_exercise')} label="Clients may add exercises" />
              <Toggle checked={form.allow_edit_targets} onChange={set('allow_edit_targets')} label="Clients may change sets, reps and weight" />
              <Toggle checked={form.community_enabled} onChange={set('community_enabled')} label="Gym community" />
              <Toggle checked={form.community_leaderboard_enabled} onChange={set('community_leaderboard_enabled')} label="Leaderboards" />
            </div>
          </div>

          <div className="md:col-span-2 flex items-center gap-3 flex-wrap">
            <button type="button" className="btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save settings'}</button>
            {note && <span role="status" className="text-[14px] font-semibold" style={{ color: 'var(--mute)' }}>{note}</span>}
          </div>
        </div>
      )}
    </Card>
  );
}
