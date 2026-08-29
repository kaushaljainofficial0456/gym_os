// ============================================================
// Stroke-SVG icon set, 20px grid -- mirrors frontend/'s own Icon.jsx
// convention (never emoji as UI icons: no per-platform art drift, no
// color management, inconsistent baseline across renderers).
// ============================================================
const PATHS = {
  grid: 'M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z',
  gyms: 'M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11',
  payments: 'M3 7h18v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18M7 15h4',
  refunds: 'M3 12a9 9 0 1 0 3-6.7M3 5v6h6',
  reconciliation: 'M9 3v14M9 3 5 7M9 3l4 4M15 21V7M15 21l-4-4M15 21l4-4',
  support: 'M21 12a8 8 0 0 1-8 8H8l-5 3 1.5-5A8 8 0 1 1 21 12Z',
  food: 'M4 11h16M6 11a6 6 0 0 1 12 0M9 11V7a3 3 0 0 1 6 0v4M5 15h14l-2 5H7z',
  ml: 'M12 3a4 4 0 0 0-4 4v1a3 3 0 0 0-2 5v2a4 4 0 0 0 4 4h.5M12 3a4 4 0 0 1 4 4v1a3 3 0 0 1 2 5v2a4 4 0 0 1-4 4h-.5M9.5 19v1.5M14.5 19v1.5M8 9h.01M16 9h.01',
  risk: 'M12 3 2 20h20L12 3ZM12 9v5M12 17h.01',
  flag: 'M5 3v18M5 4h11l-2.5 4L16 12H5',
  megaphone: 'M3 11v2a2 2 0 0 0 2 2h1l3 5h2l-1-5h1l9 4V6l-9 4H6a2 2 0 0 0-2 2Z',
  health: 'M4 12a8 8 0 1 0 16 0 8 8 0 0 0-16 0ZM12 8v8M8 12h8',
  errors: 'M12 9v4M12 16.5h.01M10.3 3.9 2.5 18a1.6 1.6 0 0 0 1.4 2.4h16.2a1.6 1.6 0 0 0 1.4-2.4L13.7 3.9a1.6 1.6 0 0 0-2.8 1Z',
  audit: 'M9 3h6l1 3h3v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6h3zM9 11h6M9 15h6',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6 6 18',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  signOut: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.35-4.35',
  download: 'M12 3v13M7 11l5 5 5-5M4 21h16',
  check: 'M20 6 9 17l-5-5',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 3',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0',
  users: 'M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM21 21v-2a4 4 0 0 0-3-3.87M15 3.13a4 4 0 0 1 0 7.75',
  sparkle: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18',
  trend: 'M3 17l6-6 4 4 7-7M15 8h6v6',
  dumbbell: 'M6.5 8v8M17.5 8v8M3.5 10v4M20.5 10v4M6.5 12h11',
  bolt: 'M13 2 4 14h6l-1 8 9-12h-6l1-8Z',
};

export default function Icon({ name, size = 18, strokeWidth = 1.8 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] || PATHS.grid} />
    </svg>
  );
}
