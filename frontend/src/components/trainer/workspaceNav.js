/**
 * WHERE EVERYTHING LIVES IN THE OWNER & TRAINER WORKSPACE -- one list,
 * read by the desktop sidebar, the phone tab bar, the More page and the
 * dashboard shortcuts, so a page can never be reachable from one of them
 * and missing from another.
 *
 * Grouped by the job an owner is doing, not by how the code is split:
 * people and money together, coaching together, the building together.
 * Labels say what is there ("Payments", "Setup & billing"), not what the
 * code calls it ("Business", "Enterprise").
 *
 * `tint` is the section's hue, borrowed from the client app's metric
 * palette: Clients is always slate blue, Payments always sage, wherever
 * they appear, so a place is recognised before its label is read.
 * Icons are names from components/Icon.jsx.
 */

/* The client app's six metric hues (theme.css --m-*), so the owner side
   speaks the same visual language: muted, never neon. */
const hue = (name) => ({ '--t': `var(--m-${name})`, '--tb': `var(--m-${name}-bg)` });
export const TINT = {
  accent: { '--t': 'var(--ink)', '--tb': 'rgb(var(--tint-rgb) / .07)' },
  blue: hue('recovery'),
  green: hue('body'),
  orange: hue('strength'),
  red: hue('energy'),
  pink: hue('nutrition'),
  purple: hue('training'),
  indigo: hue('training'),
  teal: hue('recovery'),
  cyan: hue('recovery'),
  mint: hue('body'),
  gold: hue('strength'),
  brown: hue('strength'),
  gray: { '--t': 'var(--mute)', '--tb': 'rgb(var(--tint-rgb) / .06)' },
  graphite: { '--t': 'var(--mute)', '--tb': 'rgb(var(--tint-rgb) / .06)' },
};
/** Spread onto a .ws-tile's style. */
export const tileStyle = (tint) => (tint && typeof tint === 'object' ? tint : TINT.accent);

const HOME = { to: '/app/trainer', end: true, label: 'Home', icon: 'home', tint: TINT.accent };
const CLIENTS = { to: '/app/trainer/clients', label: 'Clients', icon: 'users', tint: TINT.blue };
const PAYMENTS = { to: '/app/trainer/business', label: 'Payments', icon: 'card', tint: TINT.green };
const WORKOUTS = { to: '/app/trainer/workouts', label: 'Workouts', icon: 'strength', tint: TINT.indigo };
const NUTRITION = { to: '/app/trainer/nutrition', label: 'Nutrition', icon: 'plate', tint: TINT.mint };
const REPORTS = { to: '/app/trainer/reports', label: 'Client reports', icon: 'doc', tint: TINT.cyan };
const ALERTS = { to: '/app/trainer/alerts', label: 'Alerts', icon: 'bell', tint: TINT.red };
const MESSAGES = { to: '/app/trainer/messages', label: 'Messages', icon: 'chat', tint: TINT.teal, badgeKey: 'messages' };
const TOURNAMENTS = { to: '/app/trainer/tournaments', label: 'Tournaments', icon: 'trophy', tint: TINT.gold };

export function workspaceSections(isOwner) {
  if (!isOwner) {
    return [
      { items: [HOME] },
      { title: 'Coaching', items: [CLIENTS, WORKOUTS, NUTRITION, REPORTS, ALERTS, MESSAGES] },
      { title: 'More', items: [TOURNAMENTS, { to: '/app/trainer/attendance', label: 'My attendance', icon: 'calendar', tint: TINT.orange }] },
    ];
  }
  return [
    { items: [HOME] },
    {
      title: 'Members & money',
      items: [CLIENTS, PAYMENTS, { to: '/app/trainer/attendance', label: 'Attendance', icon: 'calendar', tint: TINT.orange }],
    },
    { title: 'Coaching', items: [WORKOUTS, NUTRITION, REPORTS, ALERTS, MESSAGES] },
    {
      title: 'Your gym',
      items: [
        { to: '/app/trainer/trainers', label: 'Trainers', icon: 'whistle', tint: TINT.purple },
        { to: '/app/trainer/crowd', label: 'Live crowd', icon: 'body', tint: TINT.pink },
        { to: '/app/trainer/access', label: 'Access control', icon: 'shield', tint: TINT.graphite },
        { to: '/app/trainer/analytics', label: 'Analytics', icon: 'chart', tint: TINT.brown },
        TOURNAMENTS,
      ],
    },
    {
      title: 'Account',
      items: [
        // On Home and on Setup & billing; left off the sidebar to keep it on one screen.
        { to: '/app/trainer/enterprise/qr', label: 'Join QR codes', icon: 'qr', tint: TINT.graphite, sidebar: false },
        { to: '/app/trainer/enterprise', label: 'Setup & billing', icon: 'settings', tint: TINT.gray, end: true },
      ],
    },
  ];
}

/** The phone tab bar: the four places visited most, and More for the rest. */
export function workspaceTabs(isOwner) {
  const more = { to: '/app/trainer/more', label: 'More', icon: 'grid' };
  return isOwner
    ? [HOME, CLIENTS, PAYMENTS, MESSAGES, more]
    : [HOME, CLIENTS, WORKOUTS, MESSAGES, more];
}

/**
 * Dashboard shortcuts: the things an owner does most, one tap from Home.
 * Each goes straight INTO the action where the page supports it (the
 * `?new=1` style params open that page's form), not just to the page.
 */
export function quickActions(isOwner) {
  if (!isOwner) {
    return [
      { to: '/app/trainer/clients?new=1', label: 'Add client', icon: 'plus', tint: TINT.blue },
      { to: '/app/trainer/workouts?new=1', label: 'New workout', icon: 'strength', tint: TINT.indigo },
      { to: '/app/trainer/nutrition?new=1', label: 'New meal plan', icon: 'plate', tint: TINT.mint },
      { to: '/app/trainer/messages', label: 'Messages', icon: 'chat', tint: TINT.teal, badgeKey: 'messages' },
      { to: '/app/trainer/alerts', label: 'Alerts', icon: 'bell', tint: TINT.red },
      { to: '/app/trainer/attendance', label: 'My attendance', icon: 'calendar', tint: TINT.orange },
    ];
  }
  return [
    { to: '/app/trainer/clients?new=1', label: 'Add client', icon: 'plus', tint: TINT.blue },
    { to: '/app/trainer/business?record=1', label: 'Record payment', icon: 'receipt', tint: TINT.green },
    { to: '/app/trainer/attendance', label: 'Attendance', icon: 'calendar', tint: TINT.orange },
    { to: '/app/trainer/messages', label: 'Messages', icon: 'chat', tint: TINT.teal, badgeKey: 'messages' },
    { to: '/app/trainer/workouts?new=1', label: 'New workout', icon: 'strength', tint: TINT.indigo },
    { to: '/app/trainer/nutrition?new=1', label: 'New meal plan', icon: 'plate', tint: TINT.mint },
    { to: '/app/trainer/enterprise/qr?for=trainer', label: 'Invite trainer', icon: 'whistle', tint: TINT.purple },
    { to: '/app/trainer/enterprise/qr', label: 'Join QR codes', icon: 'qr', tint: TINT.graphite },
  ];
}
