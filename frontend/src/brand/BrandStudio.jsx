/**
 * BrandStudio -- where a gym owner makes the app their gym's own.
 *
 * Two colours (a preset to start from, or their exact ones), an optional
 * logo, and a live preview of the member app in both themes, rendered by
 * the same tokens the real app will use -- so what the owner sees here is
 * what every member, trainer and the owner will see after saving.
 *
 * Used twice: as a step of the owner's first-time setup
 * (EnterpriseOnboarding) and as the Branding page afterwards. Saving
 * refreshes the session, which re-themes the owner's own app at once;
 * members and trainers pick it up the next time their app loads.
 */
import { useId, useMemo, useRef, useState } from 'react';
import { Bell, Check, Dumbbell, Home, ImagePlus, LineChart, Menu, Moon, RotateCcw, Sun, Trash2, Utensils } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useTheme } from '../themeContext.jsx';
import { deriveBrand, previewStyle, PRESETS, DEFAULT_SECONDARY } from './brandTheme.js';
import { logoFromFile } from './logoFile.js';
import GymLockup from './GymLockup.jsx';
import GymMark from './GymMark.jsx';
import './brand-studio.css';

// The Barbell look itself, for previewing "no gym colours" while the page
// around the preview may already be in a gym's colours. Mirrors the key
// tokens of theme.css's :root (dark) and .light.
const BARBELL = {
  dark: {
    '--bg': '#0A0909', '--bg2': '#121011', '--panel': '#1A1717', '--panel2': '#241F20',
    '--ink': '#FFDFDD', '--mute': 'rgba(255,223,221,.68)', '--faint': 'rgba(255,223,221,.6)', '--line': 'rgba(255,223,221,.08)',
    '--accent': '#B4C2CE', '--accent-rgb': '180 194 206', '--accent-soft': 'rgba(180,194,206,.12)', '--tint-rgb': '255 223 221',
    '--cta-solid': '#262D33', '--cta-ink': '#E8EEF3', '--cta-edge': 'rgba(226,238,247,.15)',
    '--accent-grad': 'linear-gradient(135deg, #1F2429, #272E34)', '--accent-grad-shadow': '0 1px 0 rgba(255,223,221,.06) inset, 0 6px 18px -10px rgba(0,0,0,.85)',
    colorScheme: 'dark',
  },
  light: {
    '--bg': '#FAF5F3', '--bg2': '#F2EAE7', '--panel': '#FFFFFF', '--panel2': '#FBF6F4',
    '--ink': '#1E1714', '--mute': 'rgba(30,23,20,.72)', '--faint': 'rgba(30,23,20,.64)', '--line': '#EBDFDA',
    '--accent': '#8E2A3F', '--accent-rgb': '142 42 63', '--accent-soft': 'rgba(142,42,63,.10)', '--tint-rgb': '112 104 80',
    '--cta-solid': '#82263A', '--cta-ink': '#FDF6F7', '--cta-edge': 'rgba(36,10,16,.18)',
    '--accent-grad': 'linear-gradient(135deg, #6E1F30, #8E2A3F)', '--accent-grad-shadow': '0 4px 14px -4px rgba(142,42,63,.26)',
    colorScheme: 'light',
  },
};

const HEXISH = /^#?[0-9a-f]{6}$/i;
const toHex = (v) => (HEXISH.test(String(v || '').trim()) ? `#${String(v).trim().replace('#', '').toUpperCase()}` : null);

/** The member app's home screen, in miniature, in whatever tokens its
 *  container carries. Decorative: hidden from assistive tech, since the
 *  colour choices themselves are the accessible controls. */
function PreviewScreen({ brand }) {
  return (
    <div className="bs-screen" aria-hidden="true">
      <div className="bs-screen__head">
        <Menu size={16} strokeWidth={2} />
        <GymLockup brand={brand} markSize={20} className="bs-screen__lockup" />
        <Bell size={16} strokeWidth={2} />
      </div>
      <div className="bs-screen__hello">
        <span>Good evening</span>
        <small>3 workouts this week</small>
      </div>
      <div className="bs-card">
        <div className="bs-card__row">
          <div className="min-w-0">
            <span className="bs-eyebrow">Today · Push day</span>
            <span className="bs-title">Chest &amp; triceps</span>
          </div>
          <svg className="bs-ring" viewBox="0 0 44 44">
            <circle cx="22" cy="22" r="18" />
            <circle cx="22" cy="22" r="18" pathLength="100" strokeDasharray="67 100" />
            <text x="22" y="26" textAnchor="middle">67%</text>
          </svg>
        </div>
        <div className="bs-bar"><i style={{ width: '67%' }} /></div>
        <small className="bs-note">4 of 6 sets done</small>
        <span className="bs-cta">Start workout</span>
      </div>
      <div className="bs-chips">
        <span className="is-on">This week</span><span>Month</span><span>Year</span>
      </div>
      <div className="bs-tabs">
        <span className="is-on"><Home size={15} strokeWidth={2} /></span>
        <span><Dumbbell size={15} strokeWidth={2} /></span>
        <span><Utensils size={15} strokeWidth={2} /></span>
        <span><LineChart size={15} strokeWidth={2} /></span>
      </div>
    </div>
  );
}

function ColourRow({ label, hint, value, onChange }) {
  const id = useId();
  const [draft, setDraft] = useState(null);
  const shown = draft ?? (value || '');
  const bad = draft !== null && !toHex(draft);
  return (
    <div className="bs-colour">
      <label className="bs-swatch" style={{ background: value || 'transparent' }}>
        <input type="color" value={(value || '#000000').toLowerCase()} aria-label={`${label}: pick a colour`}
          onChange={(e) => { setDraft(null); onChange(e.target.value.toUpperCase()); }} />
      </label>
      <div className="bs-colour__text">
        <label htmlFor={id} className="bs-colour__label">{label}</label>
        <span className="bs-colour__hint">{hint}</span>
      </div>
      <input id={id} className={`input bs-hex${bad ? ' is-bad' : ''}`} value={shown} spellCheck={false} autoCapitalize="characters"
        inputMode="text" maxLength={7} placeholder="#F5C518" aria-invalid={bad || undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          const hex = toHex(e.target.value);
          if (hex) onChange(hex);
        }}
        onBlur={() => setDraft(null)} />
    </div>
  );
}

/**
 * @param initial  the gym's current brand ({ gymName, primary, secondary, logoUrl })
 * @param onSaved  called with the saved brand after the session refreshed
 * @param onSkip   optional: a "Skip for now" (first-time setup)
 * @param saveLabel the main button's words
 * @param layout   'stack' (narrow: preview on top) or 'split' (preview beside)
 */
export default function BrandStudio({ initial, gymName, onSaved, onSkip, saveLabel = 'Save', layout = 'stack' }) {
  const { refreshSession } = useAuth();
  const { resolved } = useTheme();
  const [primary, setPrimary] = useState(initial?.primary || null);
  const [secondary, setSecondary] = useState(initial?.secondary || null);
  const [logo, setLogo] = useState(initial?.logoUrl || null);     // a URL or a new data URL
  const [logoChanged, setLogoChanged] = useState(false);
  const [mode, setMode] = useState(resolved === 'light' ? 'light' : 'dark');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [logoErr, setLogoErr] = useState('');
  const fileRef = useRef(null);

  const name = initial?.gymName || gymName || 'Your gym';
  const theme = useMemo(() => deriveBrand({ primary, secondary }), [primary, secondary]);
  const style = theme ? previewStyle(theme, mode) : BARBELL[mode];
  const previewBrand = { gymName: name, logoUrl: logo };
  const presetOn = PRESETS.find((p) => p.primary === primary && p.secondary === secondary)?.id;
  const adjusted = theme && (theme.dark.textAdjusted || theme.light.textAdjusted);
  const dirty = primary !== (initial?.primary || null) || secondary !== (initial?.secondary || null) || logoChanged;

  const pickPreset = (p) => { setPrimary(p.primary); setSecondary(p.secondary); setErr(''); };
  const setMain = (hex) => { setPrimary(hex); if (!secondary) setSecondary(DEFAULT_SECONDARY); setErr(''); };
  const setSecond = (hex) => { setSecondary(hex); if (!primary) setPrimary('#F5C518'); setErr(''); };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setLogoErr('');
    try { setLogo(await logoFromFile(file)); setLogoChanged(true); } catch (ex) { setLogoErr(ex.message); }
  };

  const save = async () => {
    setBusy(true); setErr('');
    try {
      const body = { primary, secondary };
      if (logoChanged) body.logo = logo && logo.startsWith('data:') ? logo : null;
      const { branding } = await api('/branding', { method: 'PUT', body: JSON.stringify(body) });
      await refreshSession();
      setLogoChanged(false);
      onSaved?.(branding);
    } catch (ex) { setErr(ex.message || 'Could not save'); }
    finally { setBusy(false); }
  };

  const preview = (
    <div className="bs-preview">
      <div className="bs-modes" role="group" aria-label="Preview in">
        <button type="button" aria-pressed={mode === 'dark'} onClick={() => setMode('dark')}><Moon size={14} strokeWidth={2} aria-hidden="true" />Dark</button>
        <button type="button" aria-pressed={mode === 'light'} onClick={() => setMode('light')}><Sun size={14} strokeWidth={2} aria-hidden="true" />Light</button>
      </div>
      <div className="bs-frame" style={style}><PreviewScreen brand={previewBrand} /></div>
      <p className="bs-caption" aria-live="polite">
        {theme
          ? adjusted
            ? 'Your main colour is kept exactly on buttons. Where it is used as text, it is deepened or lifted just enough to stay readable.'
            : 'This is how your members, trainers and you will see the app.'
          : 'Barbell’s own look. Pick colours to make it your gym’s.'}
      </p>
    </div>
  );

  const controls = (
    <div className="bs-controls">
      <section aria-labelledby="bs-presets">
        <h3 id="bs-presets" className="bs-h">Start from a look</h3>
        <div className="bs-presets">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" className="bs-preset" aria-pressed={presetOn === p.id} onClick={() => pickPreset(p)}
              title={p.name}>
              <span className="bs-dot" style={{ '--a': p.primary, '--b': p.secondary }}>
                <span className="bs-dot__check"><Check size={14} strokeWidth={3} aria-hidden="true" /></span>
              </span>
              <span className="bs-preset__name">{p.name}</span>
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby="bs-exact">
        <h3 id="bs-exact" className="bs-h">Or your exact colours</h3>
        <ColourRow label="Main colour" hint="Buttons, highlights, progress" value={primary} onChange={setMain} />
        <ColourRow label="Second colour" hint="The background tone" value={secondary} onChange={setSecond} />
      </section>

      <section aria-labelledby="bs-logo">
        <h3 id="bs-logo" className="bs-h">Logo <span>optional</span></h3>
        <div className="bs-logo">
          <span style={style} className="bs-logo__mark"><GymMark brand={previewBrand} size={52} /></span>
          <div className="bs-logo__text">
            <span>{logo ? 'Your logo' : 'No logo yet — your initials stand in'}</span>
            <small>Square works best · PNG, JPG or WebP</small>
          </div>
          <div className="bs-logo__actions">
            <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()}>
              <ImagePlus size={15} strokeWidth={2} aria-hidden="true" />{logo ? 'Change' : 'Upload'}
            </button>
            {logo && (
              <button type="button" className="btn btn-sm btn-icon" aria-label="Remove logo" onClick={() => { setLogo(null); setLogoChanged(true); }}>
                <Trash2 size={15} strokeWidth={2} aria-hidden="true" />
              </button>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={onFile} />
        </div>
        {logoErr && <p className="bs-err" role="alert">{logoErr}</p>}
      </section>

      {err && <p className="bs-err" role="alert">{err}</p>}
      <div className="bs-actions">
        <button type="button" className="btn-primary btn-lg w-full" disabled={busy || (!dirty && !onSkip)} data-loading={busy || undefined} onClick={save}>
          {busy ? 'Saving…' : saveLabel}
        </button>
        <div className="bs-actions__row">
          {onSkip && <button type="button" className="auth-ghost bs-link" onClick={onSkip}>Skip for now</button>}
          {theme && (
            <button type="button" className="bs-link" onClick={() => { setPrimary(null); setSecondary(null); }}>
              <RotateCcw size={13} strokeWidth={2} aria-hidden="true" />Use Barbell’s look
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className={`bs bs--${layout}`}>
      {preview}
      {controls}
    </div>
  );
}
