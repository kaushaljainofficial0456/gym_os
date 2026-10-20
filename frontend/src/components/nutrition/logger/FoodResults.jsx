/**
 * Search-as-you-type for one food by name.
 *
 * While typing, the top TWO matches show straight away: usually the right
 * one is first, and two rows keep the screen calm. The → button (or Enter)
 * shows every match, with "Estimate with AI" at the bottom for when none of
 * them is it. A full meal ("2 roti and dal") is not searched at all -- it
 * goes to the meal reader instead (see looksLikeMeal).
 */
import { useEffect, useState } from 'react';
import { api } from '../../../api.js';
import { looksLikeMeal } from './plate.js';

export const PEEK = 2;

export function useFoodSearch(text, { enabled = true, max = 8 } = {}) {
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => {
    const q = String(text || '').trim();
    if (!enabled || q.length < 2 || looksLikeMeal(q)) {
      setResults([]); setQuery(''); setSearching(false);
      return undefined;
    }
    let live = true;
    setSearching(true);
    const h = setTimeout(async () => {
      try {
        const r = await api(`/me/foods/search?q=${encodeURIComponent(q)}`);
        if (live) { setResults((r.foods || []).filter((f) => f.trustworthy !== false).slice(0, max)); setQuery(q); }
      } catch {
        if (live) setResults([]);
      } finally {
        if (live) setSearching(false);
      }
    }, 180);
    return () => { live = false; clearTimeout(h); };
  }, [text, enabled, max]);
  return { results, searching, query };
}

const Glyph = ({ d, size = 14, sw = 2 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const PLUS = 'M12 5v14M5 12h14';
const SPARK = 'M12 3l1.8 4.6L18 9.4l-4.2 1.8L12 16l-1.8-4.8L6 9.4l4.2-1.8Z';

function Spinner() {
  return <span className="w-4 h-4 rounded-full border-2 animate-spin" style={{ borderColor: 'currentColor', borderTopColor: 'transparent' }} aria-hidden="true" />;
}

export default function FoodResults({ results, query, searching, showAll, onShowAll, onPick, onAI, aiBusy }) {
  if (!query && !searching) return null;
  const visible = showAll ? results : results.slice(0, PEEK);
  const more = results.length - visible.length;
  const nothing = !searching && results.length === 0;
  const row = (i) => ({ borderTop: i ? '1px solid var(--line)' : 'none' });

  return (
    <ul className="mt-2 rounded-2xl overflow-hidden" style={{ border: '1px solid var(--line)', background: 'var(--panel)' }}
        aria-label={showAll ? 'All matches' : 'Top matches'}>
      {visible.map((f, i) => {
        const def = (f.portions || []).find((p) => p.default && p.grams > 0);
        const kcal = def ? Math.round((f.calories * def.grams) / 100) : Math.round(f.calories);
        return (
          <li key={f.source_id || f.id || `${f.name}-${i}`} style={row(i)}>
            <button type="button" onClick={() => onPick(f)} className="w-full flex items-center gap-3 px-3.5 py-2.5 text-left">
              <span className="min-w-0 flex-1">
                <span className="block font-grotesk text-[13.5px] font-semibold truncate" style={{ color: 'var(--ink)' }}>{f.name}</span>
                <span className="block font-grotesk text-[11px] truncate" style={{ color: 'var(--mute)' }}>
                  {def ? (/^\d/.test(def.label) ? def.label : `1 ${String(def.label).toLowerCase()}`) : '100 g'} · {kcal} kcal{f.brand ? ` · ${f.brand}` : ''}
                </span>
              </span>
              <span className="w-7 h-7 shrink-0 rounded-lg grid place-items-center" style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}><Glyph d={PLUS} /></span>
            </button>
          </li>
        );
      })}
      {searching && !results.length && (
        <li className="px-3.5 py-2.5 font-grotesk text-[12px]" style={{ color: 'var(--faint)' }}>Searching…</li>
      )}
      {!showAll && more > 0 && (
        <li style={row(visible.length)}>
          <button type="button" onClick={onShowAll} className="w-full px-3.5 py-2 text-left font-grotesk text-[12px] font-semibold" style={{ color: 'var(--mute)' }}>
            {more} more →
          </button>
        </li>
      )}
      {(showAll || nothing) && onAI && (
        <li style={row(visible.length || (searching ? 1 : 0))}>
          <button type="button" disabled={aiBusy} onClick={() => onAI(query)} className="w-full flex items-center gap-3 px-3.5 py-2.5 text-left">
            <span className="w-7 h-7 shrink-0 rounded-lg grid place-items-center" style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}>
              {aiBusy ? <Spinner /> : <Glyph d={SPARK} />}
            </span>
            <span className="min-w-0 flex-1 font-grotesk text-[13px] font-semibold truncate" style={{ color: 'var(--ink)' }}>
              {nothing ? `No match — estimate “${query}” with AI` : `Estimate “${query}” with AI`}
            </span>
          </button>
        </li>
      )}
    </ul>
  );
}
