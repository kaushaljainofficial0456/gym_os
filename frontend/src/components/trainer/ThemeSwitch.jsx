/**
 * THEME SWITCH — light, dark, or follow the device.
 *
 * The workspace had no way to change appearance at all. A client could
 * (Settings), an owner or trainer could not: the theme they got was
 * whichever their device implied on the day they first signed in, and
 * nothing on any of their screens offered a choice. A gym floor at 6am
 * and an office at 3pm are not the same lighting.
 *
 * THREE OPTIONS, NOT A FLIP. "System" is a real answer — it keeps
 * following the device when it changes at sunset, which a two-state
 * toggle cannot express, and it is what the context already stores.
 * A binary switch would quietly destroy that preference the first time
 * it was touched.
 *
 * The CHOICE is what is stored, never the resolution: saving 'dark' for
 * someone who picked 'system' on a dark device loses the preference the
 * moment their device switches.
 */
import { useTheme } from '../../themeContext.jsx';

const OPTIONS = [
  {
    key: 'light',
    label: 'Light',
    // 12px icons at 1.8 stroke read cleanly at this size without needing
    // a separate asset per theme.
    path: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  },
  {
    key: 'dark',
    label: 'Dark',
    path: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
  },
  {
    key: 'system',
    label: 'System',
    path: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  },
];

export default function ThemeSwitch({ compact = false }) {
  const { theme, resolved, setTheme } = useTheme();

  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-full p-0.5"
      role="radiogroup"
      aria-label="Appearance"
      style={{ background: 'var(--bg2)', border: '1px solid var(--line)' }}
    >
      {OPTIONS.map((o) => {
        const on = theme === o.key;
        return (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={on}
            /* The full name is in the accessible label even when the
               button shows only an icon — "Light" alone would not say
               what it does, and "System" needs the extra clause. */
            aria-label={o.key === 'system' ? `System appearance, currently ${resolved}` : `${o.label} appearance`}
            title={o.key === 'system' ? `System · currently ${resolved}` : o.label}
            onClick={() => setTheme(o.key)}
            className="inline-flex items-center justify-center gap-1.5 rounded-full transition-colors"
            style={{
              // 36px floor, same as every other control in this workspace.
              minHeight: 36,
              minWidth: 36,
              padding: compact ? '0 8px' : '0 10px',
              background: on ? 'var(--panel)' : 'transparent',
              color: on ? 'var(--ink)' : 'var(--mute)',
              boxShadow: on ? 'var(--e-1)' : 'none',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {o.path}
            </svg>
            {!compact && (
              <span className="font-grotesk text-[11px] font-semibold">{o.label}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
