import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTheme } from '../../themeContext.jsx';
import { api, getToken, setReturnTo } from '../../api.js';
import SavingOverlay from '../../components/nutrition/SavingOverlay.jsx';

const r1 = (n) => Math.round((n || 0) * 10) / 10;

/**
 * PUBLIC shared-meal preview -- reachable without login (backend: GET
 * /api/share/:id has no requireAuth, see backend/src/routes/share.js).
 * The recipient MUST see this preview before anything is saved; nothing
 * here writes to their diet until they explicitly tap "Save to My Diet"
 * on a specific item, and that action DOES require auth (a not-logged-in
 * visitor is offered a sign-in link, never silently blocked or silently
 * saved on their behalf once they do log in).
 */
export default function SharedMeal() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { theme } = useTheme();
  const dark = theme !== 'light';
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [saveState, setSaveState] = useState({}); // index -> 'saving' | 'saved' | 'error'

  useEffect(() => {
    api(`/share/${id}`).then(setData).catch((e) => setError(e.message || 'This shared link is invalid or has expired'));
  }, [id]);

  const authed = !!getToken();

  const save = async (index) => {
    setSaveState((s) => ({ ...s, [index]: 'saving' }));
    try {
      const r = await api(`/me/share/${id}/save`, { method: 'POST', body: JSON.stringify({ item_index: index }) });
      setSaveState((s) => ({ ...s, [index]: r.duplicate ? 'duplicate' : 'saved' }));
    } catch {
      setSaveState((s) => ({ ...s, [index]: 'error' }));
      setTimeout(() => setSaveState((s) => ({ ...s, [index]: null })), 1800);
    }
  };

  const bg = dark ? '#0a0a0a' : '#FBF6F1';
  const ink = dark ? '#F5F0EC' : '#241C16';
  const mute = dark ? 'rgba(245,240,236,.6)' : 'rgba(36,28,22,.6)';
  const cardBg = dark ? 'rgba(255,255,255,.04)' : '#fff';
  const border = dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.08)';
  const accent = '#FF6A3D';

  if (error) {
    return (
      <div className="min-h-screen grid place-items-center px-6" style={{ background: bg }}>
        <div className="text-center max-w-sm">
          <div className="text-3xl mb-3"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'inline-block' }}><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></svg></div>
          <div className="font-bold text-lg mb-1" style={{ color: ink }}>Link not found</div>
          <div className="text-sm" style={{ color: mute }}>{error}</div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen grid place-items-center" style={{ background: bg }}>
        <div className="w-10 h-10 rounded-full anim-pulse-soft" style={{ background: accent, opacity: 0.3 }} />
      </div>
    );
  }

  return (
    <div className="min-h-screen px-4 py-8" style={{ background: bg }}>
      <div className="max-w-md mx-auto space-y-4">
        <div className="text-center mb-2">
          <div className="text-[11px] uppercase tracking-[.18em] font-semibold" style={{ color: mute }}>
            {data.shared_by_name ? `Shared by ${data.shared_by_name}` : 'Shared meal'}
          </div>
          <div className="font-black text-2xl mt-1" style={{ color: ink }}>Meal Preview</div>
        </div>

        {data.items.map((item, i) => {
          const state = saveState[i];
          return (
            <div key={i} className="rounded-3xl p-5 anim-fadeUp" style={{ background: cardBg, border: `1px solid ${border}`, boxShadow: '0 2px 20px rgba(0,0,0,0.08)', animationDelay: `${i * 80}ms` }}>
              <div className="flex items-center justify-between mb-3">
                <div className="font-bold text-base uppercase tracking-wide" style={{ color: ink }}>{item.name}</div>
                <span className="text-[9px] uppercase tracking-wider font-semibold px-2 py-1 rounded-full" style={{ background: `${accent}18`, color: accent }}>{item.type}</span>
              </div>

              {item.components?.length > 0 && (
                <div className="space-y-1 mb-3 pb-3" style={{ borderBottom: `1px solid ${border}` }}>
                  {item.components.map((c, ci) => (
                    <div key={ci} className="flex items-center justify-between text-[12px]">
                      <span style={{ color: mute }}>{c.name}</span>
                      {/* c.unit is the ingredient's own descriptive serving
                          ("100 g", "1 bowl"), not a bare suffix -- c.quantity
                          is how many of THAT. "1 x 100 g" reads correctly for
                          any unit type; concatenating them directly read as
                          the nonsensical "1 100 g". */}
                      <span className="tabular-nums font-medium" style={{ color: ink }}>{c.quantity} × {c.unit || 'serving'}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-4 gap-2 text-center">
                {[['Calories', Math.round(item.calories), 'kcal'], ['Protein', r1(item.protein), 'g'], ['Carbs', r1(item.carbs), 'g'], ['Fat', r1(item.fat), 'g']].map(([label, val, unit]) => (
                  <div key={label}>
                    <div className="text-[9px] uppercase tracking-wider" style={{ color: mute }}>{label}</div>
                    <div className="font-bold text-sm tabular-nums" style={{ color: ink }}>{val}<span className="text-[9px] font-normal" style={{ color: mute }}>{unit}</span></div>
                  </div>
                ))}
              </div>

              <div className="mt-4">
                {!authed ? (
                  <button onClick={() => { setReturnTo(`/share/${id}`); navigate('/login'); }} className="w-full py-2.5 rounded-xl text-[12px] font-bold" style={{ background: `${accent}18`, color: accent }}>
                    Sign in to save this to your diet
                  </button>
                ) : state === 'saved' || state === 'duplicate' ? (
                  <div className="w-full py-2.5 rounded-xl text-center text-[12px] font-bold" style={{ background: `${accent}18`, color: accent }}>
                    {state === 'duplicate' ? 'Saved as a new copy ✓' : 'Saved to My Diet ✓'}
                  </div>
                ) : (
                  <button onClick={() => save(i)} disabled={state === 'saving'} className="w-full py-2.5 rounded-xl text-[12px] font-bold text-white transition-transform active:scale-[.98]" style={{ background: accent, opacity: state === 'saving' ? 0.7 : 1 }}>
                    {state === 'saving' ? 'Saving…' : 'Save to My Diet'}
                  </button>
                )}
                {state === 'error' && <div className="text-center text-[11px] mt-1.5" style={{ color: '#F87171' }}>Could not save — try again</div>}
              </div>
            </div>
          );
        })}

        {authed && (
          <button onClick={() => navigate('/app/client/nutrition')} className="w-full py-2.5 rounded-xl text-[12px] font-semibold" style={{ color: mute, border: `1px solid ${border}` }}>
            Back to my nutrition
          </button>
        )}
      </div>

      <SavingOverlay open={Object.values(saveState).includes('saving')} stage="saving" label="Saving" sublabel="Adding to your diet…" mode="overlay" />
    </div>
  );
}
