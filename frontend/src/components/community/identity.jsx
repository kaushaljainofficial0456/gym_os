/**
 * COMMUNITY IDENTITY — what a community looks like before you know anything
 * about it.
 *
 * A friend community has no logo and no upload. It has a name, a colour and
 * an optional mark, and that is deliberate: asking eight friends to design a
 * badge before they can start training together is a worse product than
 * giving every group an identity that already looks finished.
 *
 * COLOUR COMES FROM THE SAME METRIC PALETTE the rest of the product uses
 * (theme.css), so every choice is legible on both the light and the dark
 * ground and none of it is a hard-coded hex. That is also why there are six
 * options rather than a colour picker -- a picker can produce a community
 * nobody can read.
 */

export const COMMUNITY_THEMES = {
  ember: { key: 'ember', label: 'Ember', fg: 'var(--m-energy)', bg: 'var(--m-energy-bg)' },
  violet: { key: 'violet', label: 'Violet', fg: 'var(--m-training)', bg: 'var(--m-training-bg)' },
  sage: { key: 'sage', label: 'Sage', fg: 'var(--m-body)', bg: 'var(--m-body-bg)' },
  ocean: { key: 'ocean', label: 'Ocean', fg: 'var(--m-recovery)', bg: 'var(--m-recovery-bg)' },
  champagne: { key: 'champagne', label: 'Champagne', fg: 'var(--m-strength)', bg: 'var(--m-strength-bg)' },
  steel: { key: 'steel', label: 'Steel', fg: 'var(--accent)', bg: 'var(--accent-soft)' },
};

export const THEME_KEYS = Object.keys(COMMUNITY_THEMES);
export const themeOf = (key) => COMMUNITY_THEMES[key] || COMMUNITY_THEMES.ember;

/** The gym community's own colour. Neutral on purpose: the gym is the place
 *  you train, the friend communities are the people you chose. */
export const GYM_THEME = { key: 'gym', label: 'Gym', fg: 'var(--accent)', bg: 'var(--accent-soft)' };

/** Up to two letters, from the first two words. "Beast Squad" -> BS. */
export function initialsOf(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const letters = words.slice(0, 2).map((w) => [...w][0]).join('');
  return letters.toUpperCase();
}

/**
 * The community's avatar: its mark if it has one, otherwise its initials, on
 * a gradient of its own colour.
 */
export function IdentityMark({ name, theme, mark, size = 44, className, style }) {
  const t = theme === 'gym' ? GYM_THEME : themeOf(theme);
  const fontSize = mark ? Math.round(size * 0.46) : Math.round(size * 0.36);
  return (
    <span
      aria-hidden="true"
      className={className}
      style={{
        width: size,
        height: size,
        display: 'grid',
        placeItems: 'center',
        flexShrink: 0,
        borderRadius: Math.max(10, Math.round(size * 0.28)),
        background: `linear-gradient(135deg, color-mix(in srgb, ${t.fg} 38%, transparent), color-mix(in srgb, ${t.fg} 10%, transparent))`,
        border: `1px solid color-mix(in srgb, ${t.fg} 34%, transparent)`,
        color: t.fg,
        fontWeight: 800,
        fontSize,
        letterSpacing: '.02em',
        lineHeight: 1,
        ...style,
      }}
    >
      {mark || initialsOf(name)}
    </span>
  );
}

/**
 * The first few members, overlapped. Initials only -- the same decision the
 * gym community's boards make: an avatar here would be a data URL per member
 * on a list that is meant to load instantly.
 */
export function MemberStack({ people = [], size = 26, max = 4, tone = 'var(--accent)' }) {
  const shown = people.slice(0, max);
  if (!shown.length) return null;
  const extra = people.length - shown.length;
  return (
    <div className="flex items-center" aria-hidden="true">
      {shown.map((p, i) => (
        <span
          key={p.clientId || p.name || i}
          className="grid place-items-center rounded-full font-bold"
          style={{
            width: size,
            height: size,
            fontSize: Math.round(size * 0.4),
            marginLeft: i === 0 ? 0 : -Math.round(size * 0.3),
            background: 'var(--panel2)',
            border: `1px solid color-mix(in srgb, ${tone} 30%, var(--line))`,
            color: 'var(--mute)',
            zIndex: shown.length - i,
          }}
        >
          {initialsOf(p.name)[0]}
        </span>
      ))}
      {extra > 0 && (
        <span
          className="text-[10.5px] tabular-nums"
          style={{ marginLeft: 6, color: 'var(--faint)' }}
        >
          +{extra}
        </span>
      )}
    </div>
  );
}

/** GYM / FRIENDS. Small, quiet, and always present: a member should never
 *  have to work out which kind of community they are looking at. */
export function TypeChip({ type, theme }) {
  const isGym = type === 'gym';
  const t = isGym ? GYM_THEME : themeOf(theme);
  return (
    <span
      className="text-[9px] font-bold uppercase tracking-[.14em] px-2 py-1 rounded-full shrink-0"
      style={{
        background: t.bg,
        color: t.fg,
        border: `1px solid color-mix(in srgb, ${t.fg} 26%, transparent)`,
      }}
    >
      {isGym ? 'Gym' : 'Friends'}
    </span>
  );
}
