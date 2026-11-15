/**
 * WHERE EVERYTHING LIVES IN THE OWNER & TRAINER WORKSPACE -- one list,
 * read by the desktop sidebar, the phone tab bar, the section tabs, the
 * More page and the "+ New" menu, so a page can never be reachable from
 * one of them and missing from another.
 *
 * THE OWNER SEES EIGHT PLACES, NOT SIXTEEN. The owner sidebar used to list
 * every page under four headings, which is everything at once and nothing
 * at a glance. Now it is eight plain words (OWNER_HUBS) -- Home, Members,
 * Payments, Messages, Coaching, Trainers, Reports, Settings -- and each one
 * holds the pages that belong to it. Nothing was removed: a section with
 * more than one page shows them as tabs along its top (SectionTabs.jsx),
 * and More lists every page with a search box.
 *
 * Labels say what is there ("Payments", "Setup & billing"), not what the
 * code calls it ("Business", "Enterprise"). Page labels match each page's
 * own title, so the tab you tap is the heading you land on.
 *
 * `tint` is the page's hue, borrowed from the client app's metric palette:
 * Clients is always slate blue, Payments always sage, wherever they
 * appear, so a place is recognised before its label is read.
 * Icons are names from components/Icon.jsx.
 */
import { matchPath } from 'react-router-dom';

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
const WORKOUTS = { to: '/app/trainer/workouts', label: 'Workouts', icon: 'strength', tint: TINT.indigo };
const NUTRITION = { to: '/app/trainer/nutrition', label: 'Nutrition', icon: 'plate', tint: TINT.mint };
const REPORTS = { to: '/app/trainer/reports', label: 'Client reports', icon: 'doc', tint: TINT.cyan };
const ALERTS = { to: '/app/trainer/alerts', label: 'Alerts', icon: 'bell', tint: TINT.red };
const MESSAGES = { to: '/app/trainer/messages', label: 'Messages', icon: 'chat', tint: TINT.teal, badgeKey: 'messages' };
const TOURNAMENTS = { to: '/app/trainer/tournaments', label: 'Tournaments', icon: 'trophy', tint: TINT.gold };
const MORE = { to: '/app/trainer/more', label: 'More', icon: 'grid' };

/* ── THE OWNER'S EIGHT PLACES ──
   `pages` are the screens a section holds, in tab order; the first is
   where the section opens. `also` lists deeper routes (a client's profile,
   a tournament) that still belong to the section, so the sidebar keeps
   it lit there. `keywords` feed the search on More. */
const page = (to, label, icon, tint, extra = {}) => ({ to, label, icon, tint, ...extra });

export const OWNER_HUBS = [
  {
    key: 'members', label: 'Members', icon: 'users',
    pages: [
      page('/app/trainer/clients', 'Clients', 'users', TINT.blue, { also: ['/app/trainer/clients/:id'], keywords: 'members roster people add client' }),
      page('/app/trainer/attendance', 'Attendance', 'calendar', TINT.orange, { keywords: 'check in check-in present mark trainers roster' }),
      page('/app/trainer/crowd', 'Live crowd', 'body', TINT.pink, { keywords: 'occupancy inside now busy floor' }),
      page('/app/trainer/access', 'Access control', 'shield', TINT.graphite, { keywords: 'door biometric device essl entry gate' }),
    ],
  },
  {
    key: 'payments', label: 'Payments', icon: 'card',
    pages: [page('/app/trainer/business', 'Payments', 'card', TINT.green, { keywords: 'money fees dues collect membership plans revenue record payment' })],
  },
  {
    key: 'messages', label: 'Messages', icon: 'chat', badgeKey: 'messages',
    pages: [
      page('/app/trainer/messages', 'Messages', 'chat', TINT.teal, { badgeKey: 'messages', keywords: 'chat inbox conversation' }),
      page('/app/trainer/communication', 'AI Communication', 'phone', TINT.purple, { keywords: 'ai calls follow-ups follow up sms whatsapp renewal voice' }),
      page('/app/trainer/alerts', 'Alerts', 'bell', TINT.red, { keywords: 'notifications warnings' }),
    ],
  },
  {
    key: 'coaching', label: 'Coaching', icon: 'strength',
    pages: [
      page('/app/trainer/workouts', 'Workouts', 'strength', TINT.indigo, { keywords: 'programs templates exercises training' }),
      page('/app/trainer/nutrition', 'Nutrition', 'plate', TINT.mint, { keywords: 'diet meal plans food' }),
      page('/app/trainer/reports', 'Client reports', 'doc', TINT.cyan, { keywords: 'progress pdf share' }),
      page('/app/trainer/tournaments', 'Tournaments', 'trophy', TINT.gold, { also: ['/app/trainer/tournaments/*'], keywords: 'competition challenge event' }),
    ],
  },
  {
    key: 'trainers', label: 'Trainers', icon: 'whistle',
    pages: [page('/app/trainer/trainers', 'Trainers', 'whistle', TINT.purple, { keywords: 'staff coaches shifts team' })],
  },
  {
    key: 'reports', label: 'Reports', icon: 'chart',
    pages: [page('/app/trainer/analytics', 'Reports', 'chart', TINT.brown, { keywords: 'analytics revenue growth churn charts memberships check-ins' })],
  },
  {
    key: 'settings', label: 'Settings', icon: 'settings',
    pages: [
      page('/app/trainer/enterprise', 'Setup & billing', 'settings', TINT.gray, { also: ['/app/trainer/enterprise/billing', '/app/trainer/enterprise/onboarding'], keywords: 'subscription barbell plan billing receipts account' }),
      page('/app/trainer/enterprise/qr', 'Join QR codes', 'qr', TINT.graphite, { keywords: 'invite join qr code trainer member signup' }),
    ],
  },
].map((h) => ({ ...h, to: h.pages[0].to }));

/** Every route pattern a section answers to, for matchPath. */
const patternsOf = (hub) => hub.pages.flatMap((p) => [p.to, ...(p.also || [])]);
const matches = (patterns, pathname) => patterns.some((path) => !!matchPath({ path, end: true }, pathname));

/** The owner section the current route belongs to (null on Home and More). */
export function hubForPath(pathname) {
  return OWNER_HUBS.find((h) => matches(patternsOf(h), pathname)) || null;
}

/** The section's page this exact route is -- only top-level pages get tabs,
 *  not a client's profile or a tournament's detail screen. */
export function tabPageForPath(pathname) {
  for (const hub of OWNER_HUBS) {
    const p = hub.pages.find((pg) => matches([pg.to], pathname));
    if (p) return { hub, page: p };
  }
  return null;
}

/** Sidebar, trainer accounts only: unchanged groups of every page. */
export function workspaceSections(isOwner) {
  if (isOwner) return [{ items: [HOME, ...OWNER_HUBS] }];
  return [
    { items: [HOME] },
    { title: 'Coaching', items: [CLIENTS, WORKOUTS, NUTRITION, REPORTS, ALERTS, MESSAGES] },
    { title: 'More', items: [TOURNAMENTS, { to: '/app/trainer/attendance', label: 'My attendance', icon: 'calendar', tint: TINT.orange }] },
  ];
}

/**
 * The phone tab bar. An owner's has Home, Members, Payments and More, with
 * the "+ New" button beside it and Messages in the top bar; each tab stays
 * lit across its whole section (`match`), and More stands for every
 * section without a tab of its own, so the bar always says where you are.
 */
export function workspaceTabs(isOwner) {
  if (!isOwner) return [HOME, CLIENTS, WORKOUTS, MESSAGES, MORE];
  const [members, payments, ...rest] = OWNER_HUBS;
  return [
    HOME,
    { to: members.to, label: members.label, icon: members.icon, match: patternsOf(members) },
    { to: payments.to, label: payments.label, icon: payments.icon, match: patternsOf(payments) },
    { ...MORE, match: [MORE.to, ...rest.flatMap(patternsOf)] },
  ];
}

/**
 * More, for an owner: every page, grouped. Sections with several pages
 * keep their own name; the single-page ones (Payments, Trainers, Reports)
 * sit together under "Your gym".
 */
export function everythingGroups() {
  const groups = [];
  const single = [];
  for (const hub of OWNER_HUBS) {
    if (hub.pages.length > 1) groups.push({ title: hub.label, items: hub.pages });
    else single.push(hub.pages[0]);
  }
  const settings = groups.findIndex((g) => g.title === 'Settings');
  groups.splice(settings < 0 ? groups.length : settings, 0, { title: 'Your gym', items: single });
  return groups;
}

/**
 * Shortcuts. A trainer's sit as tiles on their Home; an owner's live in
 * the "+ New" menu (NewMenu.jsx). Each goes straight INTO the action where
 * the page supports it (the `?new=1` style params open that page's form),
 * not just to the page.
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
    { to: '/app/trainer/attendance', label: 'Mark attendance', icon: 'calendar', tint: TINT.orange },
    { to: '/app/trainer/messages', label: 'Send message', icon: 'chat', tint: TINT.teal },
    { to: '/app/trainer/communication', label: 'AI follow-ups', icon: 'phone', tint: TINT.purple },
    { to: '/app/trainer/workouts?new=1', label: 'New workout', icon: 'strength', tint: TINT.indigo },
    { to: '/app/trainer/nutrition?new=1', label: 'New meal plan', icon: 'plate', tint: TINT.mint },
    { to: '/app/trainer/enterprise/qr?for=trainer', label: 'Invite trainer', icon: 'whistle', tint: TINT.purple },
    { to: '/app/trainer/enterprise/qr', label: 'Join QR codes', icon: 'qr', tint: TINT.graphite },
  ];
}
