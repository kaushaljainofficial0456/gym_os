/**
 * QUICK ADD — the foods you already eat, one tap each.
 *
 * WHY THIS IS THE WHOLE POINT OF THE PAGE. Most people eat a small set of
 * things on rotation: the same breakfast five mornings a week, the same
 * two lunches. Logging that porridge cost a sheet, a search, a portion
 * decision and a confirm — every single morning, for a food the app had
 * already recorded forty times. That friction is why food logging gets
 * abandoned in week two, and no amount of styling fixes it.
 *
 * Saved Foods existed, but you had to curate it first: work done up front
 * for a benefit you cannot yet see, which is the definition of a feature
 * nobody sets up. This needs no curation at all — eat something twice and
 * it appears here, most-eaten first.
 *
 * IT LOGS THE PORTION YOU LAST ACTUALLY ATE, not a standard serving, so
 * the tap is a real record rather than a rounded guess you then have to
 * go and correct. And it is undoable, because a one-tap write with no way
 * back is a trap rather than a shortcut.
 */
import { useEffect, useState } from 'react';
import { api } from '../../api.js';

export default function QuickAddStrip({ t, onLog, onLogged, refreshKey }) {
  const [foods, setFoods] = useState(null);
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    let alive = true;
    api('/me/nutrition/frequent?limit=10')
      .then((r) => { if (alive) setFoods(r.foods || []); })
      .catch(() => { if (alive) setFoods([]); });
    return () => { alive = false; };
  }, [refreshKey]);

  // Nothing to offer yet is not an empty state worth drawing. A brand new
  // user has eaten nothing twice, and a row of placeholders explaining
  // that would be noise on the screen they are trying to use.
  if (!foods || !foods.length) return null;

  const add = async (f) => {
    setBusy(f.name);
    try {
      await onLog({
        name: f.name,
        calories: f.calories,
        protein: f.protein,
        carbs: f.carbs,
        fat: f.fat,
        // The ORIGINAL entry's provenance, carried forward. Re-logging a
        // food whose numbers came from an AI estimate does not make them
        // measured, and logEntry derives the `estimate` flag from exactly
        // this field.
        source: f.source || 'manual',
        quantity: f.quantity ?? undefined,
        unit: f.unit ?? undefined,
        unitType: f.unitType ?? undefined,
      });
      onLogged?.(f);
    } finally {
      setBusy(null);
    }
  };

  const portion = (f) => {
    if (f.quantity && f.unit) {
      const q = Number(f.quantity);
      return `${Number.isInteger(q) ? q : q.toFixed(1)} ${f.unit}`;
    }
    return `${f.times}×`;
  };

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <span className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold"
              style={{ color: t.mute }}>Quick add</span>
        <span className="text-[10px]" style={{ color: t.faint }}>What you eat most</span>
      </div>

      {/* A horizontal rail, so a long list costs width rather than pushing
          the rest of the page down. */}
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" style={{ scrollbarWidth: 'none' }}>
        {foods.map((f) => (
          <button
            key={f.name}
            type="button"
            onClick={() => add(f)}
            disabled={busy === f.name}
            aria-label={`Log ${f.name}, ${f.calories} calories`}
            className="shrink-0 rounded-2xl px-3 py-2.5 text-left transition-transform active:scale-95 disabled:opacity-50"
            style={{
              background: t.glass,
              border: `1px solid ${t.border}`,
              minWidth: 108,
              maxWidth: 150,
              minHeight: 62,
            }}
          >
            <div className="font-grotesk text-[12px] font-bold truncate" style={{ color: t.ink }}>
              {busy === f.name ? 'Logging…' : f.name}
            </div>
            <div className="flex items-baseline gap-1 mt-1">
              <span className="font-grotesk text-[13px] font-black tabular-nums" style={{ color: t.accent }}>
                {f.calories}
              </span>
              <span className="text-[9.5px]" style={{ color: t.faint }}>kcal · {portion(f)}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
