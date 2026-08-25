import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import SavingOverlay from './SavingOverlay.jsx';

/**
 * SHARE MEALS — select saved foods/meals, bundle them into one shareable
 * link (POST /me/share), then hand off to whatever the platform actually
 * offers: navigator.share() (native share sheet -- WhatsApp, Messages,
 * etc. all show up there on a device that supports it) or a clipboard-copy
 * fallback. No fake direct WhatsApp button -- the platform decides what's
 * available, per spec ("Do NOT fake a direct WhatsApp integration if the
 * platform doesn't provide one").
 */
export default function ShareMealsSheet({ open, onClose, t }) {
  const [meals, setMeals] = useState(null);
  const [foods, setFoods] = useState(null);
  const [selectedMeals, setSelectedMeals] = useState(() => new Set());
  const [selectedFoods, setSelectedFoods] = useState(() => new Set());
  const [stage, setStage] = useState(null); // null | 'sharing' | 'success' | 'error' -- drives the OVERLAY only, auto-clears
  const [shared, setShared] = useState(false); // persistent: "a link exists, show it" -- independent of the overlay's own lifetime
  const [shareUrl, setShareUrl] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelectedMeals(new Set()); setSelectedFoods(new Set()); setStage(null); setShared(false); setShareUrl(''); setCopied(false);
    api('/me/meals').then((r) => setMeals(r.meals || [])).catch(() => setMeals([]));
    api('/me/foods').then((r) => setFoods(r.mine || [])).catch(() => setFoods([]));
  }, [open]);

  if (!open) return null;

  const toggle = (set, setSet, id) => {
    const next = new Set(set);
    next.has(id) ? next.delete(id) : next.add(id);
    setSet(next);
  };

  const count = selectedMeals.size + selectedFoods.size;

  const doShare = async () => {
    setStage('sharing');
    try {
      const res = await api('/me/share', {
        method: 'POST',
        body: JSON.stringify({ meal_ids: [...selectedMeals], food_ids: [...selectedFoods] }),
      });
      const url = `${window.location.origin}/share/${res.id}`;
      setShareUrl(url);
      setShared(true);
      setStage('success');
      // Success beat stays visible on its own, then the overlay clears --
      // the share-link row underneath (copy/share-again) persists via
      // `shared`, independent of the overlay's own lifetime.
      setTimeout(async () => {
        setStage(null);
        if (navigator.share) {
          try { await navigator.share({ title: 'My meal on SK OS', text: 'Check out what I logged on SK OS', url }); }
          catch { /* user cancelled the native sheet -- not an error */ }
        }
      }, 900);
    } catch (e) {
      setStage('error');
      setTimeout(() => setStage(null), 1600);
    }
  };

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(shareUrl); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    catch { /* clipboard unavailable -- link is still visible/selectable in the input */ }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center sm:justify-center anim-fadeIn"
         style={{ background: 'rgb(var(--bg-rgb) / .72)', backdropFilter: 'blur(4px)' }}
         onClick={(e) => { if (e.target === e.currentTarget && !stage) onClose(); }}>
      <div className="card w-full sm:max-w-md max-h-[85vh] overflow-y-auto rounded-b-none sm:rounded-2xl anim-scaleIn">
        <div className="sticky top-0 z-10 px-4 pt-4 pb-3 flex items-center justify-between" style={{ background: 'var(--panel)' }}>
          <div className="text-[11px] uppercase tracking-[.18em]" style={{ color: 'var(--faint)' }}>Share Meals</div>
          <button onClick={onClose} aria-label="Close" style={{ color: 'var(--mute)' }}>✕</button>
        </div>

        <div className="px-4 pb-5 space-y-4">
          {meals === null || foods === null ? (
            <div className="space-y-2 py-4">
              {[0, 1, 2].map((i) => <div key={i} className="h-11 rounded-xl anim-pulse-soft" style={{ background: t.glass }} />)}
            </div>
          ) : (
            <>
              {meals.length > 0 && (
                <div>
                  <div className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold mb-2" style={{ color: t.mute }}>Saved Meals</div>
                  <div className="space-y-1.5">
                    {meals.map((m) => {
                      const sel = selectedMeals.has(m.id);
                      return (
                        <button key={m.id} onClick={() => toggle(selectedMeals, setSelectedMeals, m.id)}
                                className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-all"
                                style={{ background: sel ? t.accentDim : t.glass, border: `1px solid ${sel ? 'color-mix(in srgb, var(--accent) 30%, transparent)' : t.border}` }}>
                          <span className="w-5 h-5 rounded-md grid place-items-center shrink-0 transition-all" style={{ background: sel ? t.accent : 'transparent', border: `2px solid ${sel ? t.accent : t.border}` }}>
                            {sel && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent-contrast)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block font-grotesk text-sm font-semibold truncate" style={{ color: t.ink }}>{m.name}</span>
                            <span className="block font-grotesk text-[10px]" style={{ color: t.faint }}>{Math.round(m.calories || 0)} kcal</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {foods.length > 0 && (
                <div>
                  <div className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold mb-2" style={{ color: t.mute }}>Saved Foods</div>
                  <div className="space-y-1.5">
                    {foods.map((f) => {
                      const sel = selectedFoods.has(f.id);
                      return (
                        <button key={f.id} onClick={() => toggle(selectedFoods, setSelectedFoods, f.id)}
                                className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-all"
                                style={{ background: sel ? t.accentDim : t.glass, border: `1px solid ${sel ? 'color-mix(in srgb, var(--accent) 30%, transparent)' : t.border}` }}>
                          <span className="w-5 h-5 rounded-md grid place-items-center shrink-0 transition-all" style={{ background: sel ? t.accent : 'transparent', border: `2px solid ${sel ? t.accent : t.border}` }}>
                            {sel && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent-contrast)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block font-grotesk text-sm font-semibold truncate" style={{ color: t.ink }}>{f.name}</span>
                            <span className="block font-grotesk text-[10px]" style={{ color: t.faint }}>{f.serving || '100 g'} · {Math.round(f.calories || 0)} kcal</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {meals.length === 0 && foods.length === 0 && (
                <div className="text-center py-6 font-grotesk text-[12px]" style={{ color: t.mute }}>Save a food or meal first to share it</div>
              )}

              {shared && shareUrl && (
                <div className="rounded-xl p-3 flex items-center gap-2 anim-fadeIn" style={{ background: t.glass, border: `1px solid ${t.border}` }}>
                  <input readOnly value={shareUrl} className="flex-1 min-w-0 bg-transparent font-grotesk text-[11px] outline-none" style={{ color: t.mute }} onFocus={(e) => e.target.select()} />
                  <button onClick={copyLink} className="shrink-0 px-2.5 py-1.5 rounded-lg font-grotesk text-[10px] font-bold" style={{ background: t.accentDim, color: t.accent }}>
                    {copied ? 'Copied ✓' : 'Copy link'}
                  </button>
                </div>
              )}

              <button onClick={doShare} disabled={count === 0 || stage === 'sharing'}
                      className="w-full py-3 rounded-xl font-grotesk text-[13px] font-bold transition-all active:scale-[.98]"
                      style={{
                        background: count === 0 ? t.surface : t.accent,
                        color: count === 0 ? t.mute : 'var(--accent-contrast)',
                        border: `1px solid ${count === 0 ? t.border : t.accent}`,
                        opacity: count === 0 ? 0.6 : 1, cursor: count === 0 ? 'not-allowed' : 'pointer',
                      }}>
                {shared ? 'Share again' : `Share${count ? ` (${count})` : ''}`}
              </button>
            </>
          )}
        </div>
      </div>

      <SavingOverlay open={stage === 'sharing' || stage === 'success' || stage === 'error'}
                     stage={stage === 'sharing' ? 'saving' : stage === 'success' ? 'success' : 'error'}
                     label={stage === 'sharing' ? 'Sharing' : stage === 'success' ? 'Meal Shared' : 'Could not share'}
                     sublabel={stage === 'sharing' ? 'Preparing your meal…' : stage === 'success' ? 'Your meal is ready to share.' : 'Please try again'}
                     mode="overlay" />
    </div>
  );
}
