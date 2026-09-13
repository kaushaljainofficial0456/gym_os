/**
 * ICON SET — replaces emoji used as UI icons.
 *
 * WHY THIS EXISTS: roughly 30 emoji were doing icon duty across Help,
 * Profile, Settings, the client nav and several trainer screens, stored as
 * `icon: '🏠'` in data structures and rendered as text. Emoji are the wrong
 * tool for a product icon in three concrete ways:
 *
 *   1. They render as a DIFFERENT PICTURE on every platform — Apple,
 *      Google, Windows and Samsung all ship their own artwork, so the
 *      interface literally looks different per device and none of it is
 *      yours.
 *   2. They cannot be colour-managed. An emoji ignores the palette
 *      entirely, so on a peach ground the UI is studded with unrelated
 *      saturated colours no designer chose.
 *   3. Their size and baseline are inconsistent, which is why the old call
 *      sites needed `text-xl`, `text-lg`, `text-2xl` and `text-sm` to make
 *      rows line up, and still drifted.
 *
 * These are stroke icons on a 24px grid using `currentColor`, so they
 * inherit the palette token of whatever they sit in and scale from one
 * `size` prop.
 *
 * DELIBERATELY SMALL: only the icons actually referenced. An icon library
 * would add a dependency and a bundle for the ~20 glyphs this app uses.
 */

const PATHS = {
  home: 'M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5',
  chart: 'M3 3v18h18M8 17V10M13 17V7M18 17v-4',
  trending: 'M3 17l6-6 4 4 7-7M15 8h6v6',
  strength: 'M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11',
  note: 'M4 4h11l5 5v11H4zM15 4v5h5M8 13h8M8 17h5',
  food: 'M4 11h16M6 11a6 6 0 0 1 12 0M9 11V7a3 3 0 0 1 6 0v4M5 15h14l-2 5H7z',
  numbers: 'M4 9h16M4 15h16M9 4l-1 16M16 4l-1 16',
  robot: 'M8 10h.01M16 10h.01M9 15h6M5 7h14v12H5zM12 4v3M8 19v2M16 19v2',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3 11v1h6v-1a6 6 0 0 0-3-11Z',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  ruler: 'M3 15 15 3l6 6L9 21zM8 8l2 2M11 5l2 2M5 11l2 2',
  clipboard: 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 3h6v4H9z',
  chat: 'M21 12a8 8 0 0 1-8 8H8l-5 3 1.5-5A8 8 0 1 1 21 12Z',
  lock: 'M6 11h12v10H6zM9 11V8a3 3 0 0 1 6 0v3',
  camera: 'M4 8h3l2-2h6l2 2h3v12H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z',
  doc: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6',
  alert: 'M12 3 2 20h20L12 3ZM12 9v5M12 17h.01',
  mic: 'M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3ZM6 11v1a6 6 0 0 0 12 0v-1M12 18v3M9 21h6',
  plate: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  empty: 'M6 8h12l-1 12H7zM9 8V5h6v3M10 12v4M14 12v4',
  check: 'M20 6 9 17l-5-5',
  film: 'M4 5h16v14H4zM4 10h16M4 15h16M9 5v14M15 5v14',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.07-.4.1-.8.1-1.2Z',
  users: 'M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM21 21v-2a4 4 0 0 0-3-3.87M15 3.13a4 4 0 0 1 0 7.75',

  /* Added to retire the last of the literal emoji -- community emblems,
     feed reactions, the notification prompt and the AI markers were still
     rendering 🔥 💪 👏 🔔 ✨, which is the same three problems the header
     of this file describes: different artwork per platform, unmanageable
     colour, and inconsistent baselines. */
  bolt: 'M13 2 4 14h6l-1 8 9-12h-6z',
  flame: 'M12 22a7 7 0 0 0 7-7c0-4-3-6-4.5-9.5C13 8 12 9 10 9.5 8 10 7 8.5 7 6.5 5.5 9 5 11.5 5 15a7 7 0 0 0 7 7Z',
  heart: 'M12 20s-7-4.35-7-9.5A4 4 0 0 1 12 8a4 4 0 0 1 7 2.5c0 5.15-7 9.5-7 9.5Z',
  clap: 'M8 13 5.5 10.5a1.8 1.8 0 0 1 2.5-2.5l2 2M11 6.5 9.5 5a1.8 1.8 0 0 1 2.5-2.5l4 4M14 5.5a1.8 1.8 0 0 1 2.5 2.5M9 20a6 6 0 0 0 8.5-1l2-2.5a1.8 1.8 0 0 0-2.5-2.5',
  bicep: 'M5 18v-5a4 4 0 0 1 4-4h3a4 4 0 0 0 4-4V4M16 9a5 5 0 0 1 3 4.5V20M5 20h14',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 16l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z',
  medal: 'M12 15a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM8.5 13.5 6 22l6-3 6 3-2.5-8.5',
  mountain: 'M3 20h18L14 6l-3.5 7-2-3L3 20Z',
  sunrise: 'M12 3v3M5.6 8.6 7 10M3 15h2M19 15h2M17 10l1.4-1.4M8 15a4 4 0 0 1 8 0M2 19h20',
  bike: 'M6.5 20a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM17.5 20a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM6.5 16.5 10 8h4l3.5 8.5M9 8h6M14.5 5.5h2',
  run: 'M13.5 5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM8 21l2.5-5 2-2-1-4L9 12l-2-1M13.5 10l3 1.5 1.5 4M11.5 10 10 7',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  calendar: 'M4 6h16v15H4zM4 10h16M8 3v4M16 3v4',
  pause: 'M9 5v14M15 5v14',
  play: 'M8 5l11 7-11 7z',
  card: 'M3 7h18v11H3zM3 11h18M7 15h3',
  body: 'M12 5a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM9 21v-5l-2-5 5-2 5 2-2 5v5M7 11l-2 3M17 11l2 3',
};

/**
 * `name` falls back to a neutral glyph rather than rendering nothing, so a
 * typo in a data table is visible in review instead of leaving a hole in
 * the layout at runtime.
 */
export default function Icon({ name, size = 18, className, strokeWidth = 1.75, ...rest }) {
  const d = PATHS[name] || PATHS.empty;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={d} />
    </svg>
  );
}

export const ICON_NAMES = Object.keys(PATHS);
