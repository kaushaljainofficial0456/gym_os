// ============================================================
// FOLLOW-UP SCHEDULES -- for one member and one automation: is a
// follow-up due today, and which one?
//
// Pure: facts in, a step out. No database, no clock (today is passed in
// as a gym-day key), so every rule is unit-tested against exact dates.
//
// Each automation is a series of STEPS inside a CYCLE:
//   - the cycle is the situation (this absence, this membership, this
//     unpaid bill), so a new situation starts a fresh series;
//   - a step is one contact day in that series ("7 days absent",
//     "3 days before the end", "4 days after it ended").
// The engine contacts a member at most once per step (with up to
// `per_day` call attempts that day). When the engine missed a step day
// (outside calling days, feature paused), the LATEST step that has come
// due is used -- the member gets one follow-up, never a burst of
// catch-ups.
// ============================================================

export const RULE_DEFAULTS = {
  missed_visits: { after_days: 7, repeat_every: 3, max_contacts: 3, snooze_days: 3 },
  membership_ending: { before: [7, 3, 1, 0], after_every: 2, after_max: 3, snooze_days: 2 },
  payment_due: { start_after: 0, every: 2, max_contacts: 4, snooze_days: 2 },
  onboarding: { after_days: 3, repeat_every: 4, max_contacts: 2, snooze_days: 3 },
  // A one-off message to a group on one day: a holiday closure, an event, an offer.
  announcement: { send_on: null, audience: 'active', expiring_days: 7, snooze_days: 1 },
};

export const AUDIENCES = ['all', 'active', 'expiring', 'expired'];
const AUDIENCE_LABEL = { all: 'every member', active: 'members with an active membership', expiring: 'members whose membership ends soon', expired: 'members whose membership ended recently' };

const int = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** Clamp an automation's schedule to safe, sensible bounds. */
export function normalizeConfig(kind, raw = {}) {
  const d = RULE_DEFAULTS[kind];
  if (!d) throw new Error(`unknown automation kind: ${kind}`);
  const r = raw && typeof raw === 'object' ? raw : {};
  if (kind === 'missed_visits') {
    return {
      after_days: int(r.after_days, 1, 90, d.after_days),
      repeat_every: int(r.repeat_every, 0, 30, d.repeat_every),
      max_contacts: int(r.max_contacts, 1, 20, d.max_contacts),
      snooze_days: int(r.snooze_days, 1, 14, d.snooze_days),
    };
  }
  if (kind === 'membership_ending') {
    const before = Array.isArray(r.before) ? r.before : d.before;
    const clean = [...new Set(before.map((x) => int(x, 0, 30, null)).filter((x) => x !== null))].sort((a, b) => b - a).slice(0, 8);
    return {
      before: clean,
      after_every: int(r.after_every, 0, 30, d.after_every),
      after_max: int(r.after_max, 0, 20, d.after_max),
      snooze_days: int(r.snooze_days, 1, 14, d.snooze_days),
    };
  }
  if (kind === 'announcement') {
    return {
      send_on: /^\d{4}-\d{2}-\d{2}$/.test(String(r.send_on || '')) ? String(r.send_on) : null,
      audience: AUDIENCES.includes(r.audience) ? r.audience : d.audience,
      expiring_days: int(r.expiring_days, 1, 60, d.expiring_days),
      snooze_days: int(r.snooze_days, 1, 14, d.snooze_days),
    };
  }
  if (kind === 'onboarding') {
    return {
      after_days: int(r.after_days, 1, 30, d.after_days),
      repeat_every: int(r.repeat_every, 0, 14, d.repeat_every),
      max_contacts: int(r.max_contacts, 1, 5, d.max_contacts),
      snooze_days: int(r.snooze_days, 1, 14, d.snooze_days),
    };
  }
  return {
    start_after: int(r.start_after, 0, 60, d.start_after),
    every: int(r.every, 0, 30, d.every),
    max_contacts: int(r.max_contacts, 1, 20, d.max_contacts),
    snooze_days: int(r.snooze_days, 1, 14, d.snooze_days),
  };
}

const KEY = /^\d{4}-\d{2}-\d{2}$/;
const toUtc = (key) => Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10));
/** Whole days from gym-day key `a` to `b` (b - a). */
export function daysBetweenKeys(a, b) {
  if (!KEY.test(String(a)) || !KEY.test(String(b))) return null;
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

/**
 * The step due today, or null.
 *
 * facts:
 *   lastVisitKey   latest gym-day the member visited (null: never)
 *   joinedKey      when they joined / their membership started
 *   membership     { id, startKey, endKey, status } -- the CURRENT one
 *                  (latest end date); null when they have none
 *   payment        { subscriptionId, sinceKey, amountDue } -- an unpaid
 *                  membership; null when nothing is owed
 *
 * Returns { cycleKey, stepKey, index, variables } -- variables feed the
 * message ({days_absent}, {end_date}, {amount_due}...).
 */
export function dueStep(kind, rawCfg, facts, todayKey) {
  const cfg = normalizeConfig(kind, rawCfg);
  const f = facts || {};
  if (kind === 'missed_visits') {
    const m = f.membership;
    // Only paying members are "not coming": a lapsed member is the
    // membership automation's business.
    if (!m || m.status === 'cancelled' || daysBetweenKeys(todayKey, m.endKey) === null || daysBetweenKeys(todayKey, m.endKey) < 0) return null;
    const base = f.lastVisitKey || f.joinedKey || m.startKey;
    const absent = daysBetweenKeys(base, todayKey);
    if (absent === null || absent < cfg.after_days) return null;
    const k = cfg.repeat_every > 0 ? Math.floor((absent - cfg.after_days) / cfg.repeat_every) : 0;
    if (k > cfg.max_contacts - 1) return null;
    const step = cfg.after_days + k * cfg.repeat_every;
    return { cycleKey: `v:${base}`, stepKey: `m${step}`, index: k, variables: { days_absent: absent } };
  }
  if (kind === 'membership_ending') {
    const m = f.membership;
    if (!m || m.status === 'cancelled') return null;
    const dte = daysBetweenKeys(todayKey, m.endKey);
    if (dte === null) return null;
    const vars = { end_date: m.endKey, days_left: dte };
    if (dte >= 0) {
      const crossed = cfg.before.filter((b) => b >= dte);
      if (!crossed.length) return null;
      const b = Math.min(...crossed);
      return { cycleKey: `s:${m.id}`, stepKey: `b${b}`, index: cfg.before.indexOf(b), variables: vars };
    }
    if (cfg.after_every <= 0 || cfg.after_max <= 0) return null;
    const k = Math.floor(-dte / cfg.after_every);
    if (k < 1 || k > cfg.after_max) return null;
    return { cycleKey: `s:${m.id}`, stepKey: `a${k * cfg.after_every}`, index: cfg.before.length + k - 1, variables: vars };
  }
  if (kind === 'payment_due') {
    const p = f.payment;
    if (!p || !(Number(p.amountDue) > 0)) return null;
    const d = daysBetweenKeys(p.sinceKey, todayKey);
    if (d === null || d < cfg.start_after) return null;
    const k = cfg.every > 0 ? Math.floor((d - cfg.start_after) / cfg.every) : 0;
    if (k > cfg.max_contacts - 1) return null;
    return { cycleKey: `p:${p.subscriptionId}`, stepKey: `p${cfg.start_after + k * cfg.every}`, index: k, variables: { amount_due: Number(p.amountDue) } };
  }
  if (kind === 'onboarding') {
    // A member who joined and has not come in once since. Visiting ends it.
    const m = f.membership;
    if (!m || m.status === 'cancelled') return null;
    const joined = f.joinedKey || m.startKey;
    if (f.lastVisitKey && joined && f.lastVisitKey >= joined) return null;
    const since = daysBetweenKeys(joined, todayKey);
    if (since === null || since < cfg.after_days) return null;
    const k = cfg.repeat_every > 0 ? Math.floor((since - cfg.after_days) / cfg.repeat_every) : 0;
    if (k > cfg.max_contacts - 1) return null;
    return { cycleKey: `j:${joined}`, stepKey: `o${cfg.after_days + k * cfg.repeat_every}`, index: k, variables: { days_since_joining: since } };
  }
  if (kind === 'announcement') {
    // Only on its day: an announcement is never sent late.
    if (!cfg.send_on || todayKey !== cfg.send_on) return null;
    const m = f.membership;
    const left = m ? daysBetweenKeys(todayKey, m.endKey) : null;
    const inAudience = cfg.audience === 'all'
      || (cfg.audience === 'active' && m && m.status !== 'cancelled' && left !== null && left >= 0)
      || (cfg.audience === 'expiring' && m && m.status !== 'cancelled' && left !== null && left >= 0 && left <= cfg.expiring_days)
      || (cfg.audience === 'expired' && m && left !== null && left < 0 && left >= -60);
    if (!inAudience) return null;
    return { cycleKey: `n:${cfg.send_on}`, stepKey: 'n0', index: 0, variables: m ? { end_date: m.endKey, days_left: left } : {} };
  }
  return null;
}

/**
 * The SITUATION a contact is about, regardless of which step is due today:
 * this absence, this membership coming to an end, this unpaid bill. A call
 * back booked during a contact stays wanted while its situation is the same,
 * and is dropped once it is gone (the member visited, renewed or paid) --
 * even on a day between two campaign steps. Null: nothing to follow up.
 */
export function situationKey(kind, rawCfg, facts, todayKey) {
  const cfg = normalizeConfig(kind, rawCfg);
  const f = facts || {};
  const m = f.membership;
  if (kind === 'missed_visits') {
    if (!m || m.status === 'cancelled') return null;
    const left = daysBetweenKeys(todayKey, m.endKey);
    if (left === null || left < 0) return null;
    return `v:${f.lastVisitKey || f.joinedKey || m.startKey}`;
  }
  if (kind === 'membership_ending') {
    if (!m || m.status === 'cancelled') return null;
    const left = daysBetweenKeys(todayKey, m.endKey);
    if (left === null || left > Math.max(7, ...cfg.before)) return null;          // renewed well ahead
    return `s:${m.id}`;
  }
  if (kind === 'payment_due') return f.payment && Number(f.payment.amountDue) > 0 ? `p:${f.payment.subscriptionId}` : null;
  if (kind === 'onboarding') {
    if (!m || m.status === 'cancelled') return null;
    const joined = f.joinedKey || m.startKey;
    if (f.lastVisitKey && joined && f.lastVisitKey >= joined) return null;
    return `j:${joined}`;
  }
  if (kind === 'announcement') return cfg.send_on ? `n:${cfg.send_on}` : null;
  return null;
}

/**
 * The automation in one plain sentence, for the owner's list. `t` is a
 * tiny formatter so the frontend and backend phrase it the same way.
 */
export function describeSchedule(kind, rawCfg) {
  const c = normalizeConfig(kind, rawCfg);
  const days = (n) => `${n} day${n === 1 ? '' : 's'}`;
  if (kind === 'announcement') {
    if (!c.send_on) return 'Pick the day to send it';
    const who = c.audience === 'expiring' ? `members whose membership ends within ${days(c.expiring_days)}` : AUDIENCE_LABEL[c.audience];
    return `Once, on ${c.send_on}, to ${who}`;
  }
  if (kind === 'missed_visits') {
    const then = c.repeat_every > 0 && c.max_contacts > 1 ? `, then every ${days(c.repeat_every)} (up to ${c.max_contacts} times)` : '';
    return `After ${days(c.after_days)} without a visit${then}`;
  }
  if (kind === 'membership_ending') {
    const nums = c.before.filter((b) => b > 0);
    const list = nums.length > 1 ? `${nums.slice(0, -1).join(', ')} and ${nums[nums.length - 1]}` : String(nums[0] ?? '');
    const parts = [];
    if (nums.length) parts.push(`${list} day${nums.length === 1 && nums[0] === 1 ? '' : 's'} before it ends`);
    if (c.before.includes(0)) parts.push('on the day');
    const before = parts.join(', and ');
    const after = c.after_every > 0 && c.after_max > 0 ? `then every ${days(c.after_every)} after (up to ${c.after_max} times)` : '';
    const out = [before, after].filter(Boolean).join('; ');
    return out ? out[0].toUpperCase() + out.slice(1) : 'No reminders set';
  }
  if (kind === 'onboarding') {
    const then = c.repeat_every > 0 && c.max_contacts > 1 ? `, then every ${days(c.repeat_every)} (up to ${c.max_contacts} times)` : '';
    return `${days(c.after_days)} after joining if they have not come in yet${then}`;
  }
  const start = c.start_after > 0 ? `${days(c.start_after)} after it's due` : 'From the day it is due';
  const then = c.every > 0 && c.max_contacts > 1 ? `, then every ${days(c.every)} (up to ${c.max_contacts} times)` : '';
  return `${start}${then}`;
}
