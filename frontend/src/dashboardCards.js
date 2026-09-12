/**
 * HOME DASHBOARD CARDS — the one list both screens read.
 *
 * The customiser in Profile and the Home screen used to have no
 * relationship at all. Profile offered eight cards (water, sleep, SK
 * Coach and adherence among them), saved the order and the hidden set to
 * `dashboard_preferences`, showed "Dashboard saved" -- and Home never
 * read that row. Four of the eight cards did not exist on Home in any
 * form, and the four that did ignored the setting completely. Hiding
 * "Water" removed a card that was never there; hiding "Fuel today"
 * removed nothing. The screen was a working form attached to nothing.
 *
 * So the catalogue lives here, in one module, and is the single source
 * for both: Profile can only offer what Home can actually render,
 * because it is reading the same list Home lays itself out from.
 *
 * WHAT IS NOT IN HERE, deliberately: the greeting/hero band. A person
 * cannot hide the header of the page they are on -- there would be no
 * way back to the customiser from a blank screen, and "customise" does
 * not mean "be able to end up with nothing".
 */

/** id, label, and the one-line description shown in the customiser. */
export const DASH_CARDS = [
  { key: 'workout',   label: "Today's workout", desc: 'Your session for today and the button that starts it' },
  { key: 'fuel',      label: 'Calories & macros', desc: 'Calories left today, with protein, carbs and fat' },
  { key: 'burn',      label: "Today's burn", desc: 'Energy out — move, exercise and step rings' },
  { key: 'goal',      label: 'Goal progress', desc: 'How far along you are, start to target' },
  { key: 'crowd',     label: 'Gym right now', desc: 'Live headcount, or your weight trend when the gym has no feed' },
  { key: 'community', label: 'Community', desc: 'What your gym has been doing this week' },
];

export const DASH_KEYS = DASH_CARDS.map((c) => c.key);
export const DEFAULT_ORDER = DASH_KEYS;

export const dashLabel = (key) => DASH_CARDS.find((c) => c.key === key)?.label || key;

/**
 * Turns whatever is stored into a usable layout.
 *
 * Storage is not trusted to be current: a saved order can name a card
 * that no longer exists (the old 'water'/'sleep'/'coach'/'adherence'
 * keys are in real rows today) and can be missing a card added since it
 * was saved. Unknown keys are dropped and new ones are appended in their
 * catalogue position, so a preference saved a year ago still produces a
 * complete, correctly ordered screen rather than a partial one.
 */
export function resolveDashboard(order, hidden) {
  const known = new Set(DASH_KEYS);
  const seen = new Set();
  // De-duplicated as well as filtered: a stored order that names the same
  // card twice would otherwise render it twice, with two React children
  // sharing one key -- and the second copy silently reusing the first's
  // state. Nothing in the editor can produce that today, but the column
  // is free-form JSON and the screen has to survive whatever is in it.
  const wanted = (Array.isArray(order) ? order : []).filter((k) => {
    if (!known.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // Anything the stored order never knew about keeps its catalogue order,
  // inserted after what was explicitly arranged.
  const full = [...wanted, ...DASH_KEYS.filter((k) => !seen.has(k))];
  const hiddenSet = new Set((Array.isArray(hidden) ? hidden : []).filter((k) => known.has(k)));
  return {
    order: full,
    hidden: hiddenSet,
    visible: full.filter((k) => !hiddenSet.has(k)),
    isVisible: (key) => !hiddenSet.has(key),
  };
}

/** Reads the two JSON-encoded columns the API returns, safely. */
export function parseDashboardPrefs(prefs) {
  const parse = (s, fallback) => {
    try {
      const v = JSON.parse(s ?? 'null');
      return Array.isArray(v) ? v : fallback;
    } catch { return fallback; }
  };
  return {
    order: parse(prefs?.order_list, []),
    hidden: parse(prefs?.hidden, []),
  };
}
