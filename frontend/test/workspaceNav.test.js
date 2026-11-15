import { describe, it, expect } from 'vitest';
import { matchPath } from 'react-router-dom';
import {
  OWNER_HUBS, hubForPath, tabPageForPath, workspaceTabs, everythingGroups, quickActions,
} from '../src/components/trainer/workspaceNav.js';

/* Every page an owner could open from the sidebar before it was cut down
   to eight sections. The simpler sidebar may move a page; it must never
   drop one. */
const OWNER_PAGES_BEFORE = [
  '/app/trainer/clients', '/app/trainer/business', '/app/trainer/attendance', '/app/trainer/communication',
  '/app/trainer/workouts', '/app/trainer/nutrition', '/app/trainer/reports', '/app/trainer/alerts',
  '/app/trainer/messages', '/app/trainer/trainers', '/app/trainer/crowd', '/app/trainer/access',
  '/app/trainer/analytics', '/app/trainer/tournaments', '/app/trainer/enterprise/qr', '/app/trainer/enterprise',
];

const allPages = OWNER_HUBS.flatMap((h) => h.pages.map((p) => p.to));

describe('owner navigation: eight sections, nothing lost', () => {
  it('is Members, Payments, Messages, Coaching, Trainers, Reports and Settings (plus Home)', () => {
    expect(OWNER_HUBS.map((h) => h.label)).toEqual(['Members', 'Payments', 'Messages', 'Coaching', 'Trainers', 'Reports', 'Settings']);
  });

  it('keeps every page the old sidebar had, each in exactly one section', () => {
    for (const to of OWNER_PAGES_BEFORE) {
      expect(allPages.filter((p) => p === to), to).toHaveLength(1);
    }
  });

  it('opens each section on its first page', () => {
    for (const hub of OWNER_HUBS) expect(hub.to).toBe(hub.pages[0].to);
  });

  it('keeps a section lit on its deeper screens', () => {
    expect(hubForPath('/app/trainer/clients/42')?.key).toBe('members');
    expect(hubForPath('/app/trainer/crowd')?.key).toBe('members');
    expect(hubForPath('/app/trainer/tournaments/abc')?.key).toBe('coaching');
    expect(hubForPath('/app/trainer/enterprise/billing')?.key).toBe('settings');
    expect(hubForPath('/app/trainer/enterprise/qr')?.key).toBe('settings');
    expect(hubForPath('/app/trainer')).toBeNull();
    expect(hubForPath('/app/trainer/more')).toBeNull();
  });

  it('shows section tabs on a section\'s own pages only', () => {
    expect(tabPageForPath('/app/trainer/attendance')?.page.label).toBe('Attendance');
    expect(tabPageForPath('/app/trainer/enterprise')?.page.label).toBe('Setup & billing');
    expect(tabPageForPath('/app/trainer/enterprise/qr')?.page.label).toBe('Join QR codes');
    expect(tabPageForPath('/app/trainer/clients/42')).toBeNull();
    expect(tabPageForPath('/app/trainer/tournaments/abc')).toBeNull();
  });
});

describe('owner phone tab bar', () => {
  const lit = (pathname) => workspaceTabs(true)
    .filter((t) => (t.match || [t.to]).some((path) => matchPath({ path, end: t.end ?? true }, pathname)))
    .map((t) => t.label);

  it('is Home, Members, Payments and More', () => {
    expect(workspaceTabs(true).map((t) => t.label)).toEqual(['Home', 'Members', 'Payments', 'More']);
  });

  it('lights exactly one tab on every owner page', () => {
    for (const to of [...OWNER_PAGES_BEFORE, '/app/trainer', '/app/trainer/more']) {
      expect(lit(to), to).toHaveLength(1);
    }
    expect(lit('/app/trainer/crowd')).toEqual(['Members']);
    expect(lit('/app/trainer/workouts')).toEqual(['More']);
  });

  it('leaves a trainer\'s tab bar as it was', () => {
    expect(workspaceTabs(false).map((t) => t.label)).toEqual(['Home', 'Clients', 'Workouts', 'Messages', 'More']);
  });
});

describe('More and "+ New"', () => {
  it('lists every owner page on More', () => {
    const listed = everythingGroups().flatMap((g) => g.items.map((it) => it.to));
    expect([...listed].sort()).toEqual([...allPages].sort());
  });

  it('keeps every shortcut Home used to show as a tile', () => {
    const targets = quickActions(true).map((a) => a.to);
    for (const to of [
      '/app/trainer/clients?new=1', '/app/trainer/business?record=1', '/app/trainer/attendance', '/app/trainer/messages',
      '/app/trainer/communication', '/app/trainer/workouts?new=1', '/app/trainer/nutrition?new=1', '/app/trainer/enterprise/qr?for=trainer',
    ]) expect(targets, to).toContain(to);
  });
});
