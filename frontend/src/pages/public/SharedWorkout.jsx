import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTheme } from '../../themeContext.jsx';
import { api, getStoredUser, setReturnTo } from '../../api.js';
import SavingOverlay from '../../components/nutrition/SavingOverlay.jsx';

/**
 * PUBLIC shared-workout preview — reachable without login (backend: GET
 * /api/workout-share/:id has no requireAuth). The recipient MUST see
 * this preview before anything is saved; nothing here writes to their
 * planner until they explicitly tap "Import" and choose a destination,
 * and that action DOES require auth.
 *
 * Flow:
 *   1. Preview the shared workout (no auth)
 *   2. Select exercises to import
 *   3. Choose destination (Today / My Workouts / Specific Day)
 *   4. Import (requires auth — redirects to login if needed)
 */
export default function SharedWorkout() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { theme } = useTheme();
  const dark = theme !== 'light';

  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [importStage, setImportStage] = useState('preview'); // preview | select | destination | importing | done
  const [selected, setSelected] = useState(() => new Set());
  const [selectAll, setSelectAll] = useState(true);
  const [destination, setDestination] = useState(null); // 'today' | 'planner' | 'planner_day'
  const [dayOfWeek, setDayOfWeek] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [importError, setImportError] = useState('');

  useEffect(() => {
    api(`/workout-share/${id}`).then(setData).catch((e) => setError(e.message || 'This shared workout link is invalid or has expired'));
  }, [id]);

  // F-05: the raw token is no longer readable client-side (httpOnly
  // cookie only) -- the stored USER object is the "am I logged in" signal
  // now; it's non-sensitive profile data, never a bearer credential.
  const authed = !!getStoredUser();
  const exercises = data?.workout?.exercises || [];

  useEffect(() => {
    if (exercises.length > 0 && importStage === 'preview') {
      setSelected(new Set(exercises.map((_, i) => i)));
      setSelectAll(true);
    }
  }, [exercises.length]);

  // Keep selectAll in sync
  useEffect(() => {
    if (selected.size === exercises.length && exercises.length > 0) {
      setSelectAll(true);
    } else {
      setSelectAll(false);
    }
  }, [selected.size, exercises.length]);

  const toggleSelect = (idx) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectAll) {
      setSelected(new Set());
      setSelectAll(false);
    } else {
      setSelected(new Set(exercises.map((_, i) => i)));
      setSelectAll(true);
    }
  };

  const startImport = () => {
    if (!authed) {
      setReturnTo(`/workout-share/${id}`);
      navigate('/login');
      return;
    }
    setImportStage('select');
  };

  const doImport = async (dest, dow) => {
    setImportStage('importing');
    setImportError('');
    try {
      const body = {
        exercise_indexes: [...selected].sort((a, b) => a - b),
        destination: dest,
      };
      if (dest === 'planner_day' && dow !== undefined) {
        body.day_of_week = dow;
      }
      const res = await api(`/me/workout-share/${id}/import`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setImportResult(res);
      setImportStage('done');
    } catch (e) {
      setImportError(e.message || 'Could not import workout');
      setImportStage('select');
    }
  };

  const bg = dark ? '#0a0a0a' : '#FBF6F1';
  const ink = dark ? '#F5F0EC' : '#241C16';
  const mute = dark ? 'rgba(245,240,236,.6)' : 'rgba(36,28,22,.6)';
  const cardBg = dark ? 'rgba(255,255,255,.04)' : '#fff';
  const border = dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.08)';
  const accent = '#FF6A3D';
  const faint = dark ? 'rgba(245,240,236,.35)' : 'rgba(36,28,22,.35)';

  // ---- ERROR STATE ----
  if (error) {
    return (
      <div className="min-h-screen grid place-items-center px-6" style={{ background: bg }}>
        <div className="text-center max-w-sm">
          <div className="text-3xl mb-3">🔗</div>
          <div className="font-bold text-lg mb-1" style={{ color: ink }}>Link not found</div>
          <div className="text-sm" style={{ color: mute }}>{error}</div>
        </div>
      </div>
    );
  }

  // ---- LOADING ----
  if (!data) {
    return (
      <div className="min-h-screen grid place-items-center" style={{ background: bg }}>
        <div className="w-10 h-10 rounded-full anim-pulse-soft" style={{ background: accent, opacity: 0.3 }} />
      </div>
    );
  }

  // ---- DONE STATE ----
  if (importStage === 'done') {
    return (
      <div className="min-h-screen px-4 py-8" style={{ background: bg }}>
        <div className="max-w-md mx-auto space-y-4">
          <div className="text-center py-12">
            <div className="w-16 h-16 mx-auto rounded-full grid place-items-center mb-4 anim-pop" style={{ background: `${accent}18`, border: `1px solid ${accent}` }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </div>
            <div className="font-black text-xl" style={{ color: ink }}>Added to your planner!</div>
            <div className="text-sm mt-1.5" style={{ color: mute }}>
              {importResult?.destination === 'today'
                ? `${data.workout?.name || 'Workout'} is ready for today`
                : importResult?.destination === 'planner_day'
                ? `${data.workout?.name || 'Workout'} added to your weekly plan`
                : `${data.workout?.name || 'Workout'} saved to My Workouts`
              }
            </div>
          </div>
          <button onClick={() => navigate('/app/client/workout')}
            className="w-full py-2.5 rounded-xl text-[12px] font-semibold"
            style={{ color: accent, border: `1px solid ${accent}` }}>
            Go to my workouts →
          </button>
        </div>
      </div>
    );
  }

  // ---- IMPORTING STATE ----
  if (importStage === 'importing') {
    return (
      <div className="min-h-screen px-4 py-8" style={{ background: bg }}>
        <div className="max-w-md mx-auto text-center py-12">
          <div className="w-10 h-10 mx-auto rounded-full anim-pulse-soft mb-4" style={{ background: accent, opacity: 0.3 }} />
          <div className="font-grotesk text-sm" style={{ color: mute }}>Importing to your planner…</div>
        </div>
      </div>
    );
  }

  // ---- EXERCISE SELECTION STATE ----
  if (importStage === 'select') {
    return (
      <div className="min-h-screen px-4 py-8" style={{ background: bg }}>
        <div className="max-w-md mx-auto space-y-4">
          <div className="text-center mb-2">
            <div className="text-[11px] uppercase tracking-[.18em] font-semibold" style={{ color: mute }}>Import Workout</div>
            <div className="font-black text-xl mt-1" style={{ color: ink }}>{data.workout?.name || 'Workout'}</div>
          </div>

          <div className="text-[11px] font-semibold" style={{ color: mute }}>
            {selected.size} of {exercises.length} exercises selected
          </div>

          {/* Select all */}
          <button onClick={toggleSelectAll}
            className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-all"
            style={{ background: selectAll ? `${accent}12` : 'transparent', border: `1px solid ${selectAll ? `${accent}40` : border}` }}>
            <span className="w-5 h-5 rounded-md grid place-items-center shrink-0 transition-all"
              style={{ background: selectAll ? accent : 'transparent', border: `2px solid ${selectAll ? accent : border}` }}>
              {selectAll && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}
            </span>
            <span className="font-grotesk text-[12px] font-semibold" style={{ color: ink }}>Select all</span>
          </button>

          {/* Exercise list with checkboxes */}
          {exercises.map((ex, i) => {
            const sel = selected.has(i);
            return (
              <button key={i} onClick={() => toggleSelect(i)}
                className="w-full rounded-xl px-3 py-3 text-left transition-all"
                style={{ background: cardBg, border: `1px solid ${sel ? `${accent}40` : border}`, boxShadow: '0 2px 12px rgba(0,0,0,0.05)' }}>
                <div className="flex items-center gap-3">
                  <span className="w-5 h-5 rounded-md grid place-items-center shrink-0 transition-all"
                    style={{ background: sel ? accent : 'transparent', border: `2px solid ${sel ? accent : border}` }}>
                    {sel && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-grotesk text-[13px] font-semibold truncate" style={{ color: ink }}>{ex.name}</div>
                    <div className="text-[11px] mt-0.5" style={{ color: mute }}>
                      {ex.sets} sets · {ex.reps} reps · {ex.weight}
                      {ex.rest_sec ? ` · ${ex.rest_sec}s rest` : ''}
                    </div>
                    {ex.tempo && <div className="text-[10px] mt-0.5" style={{ color: faint }}>Tempo: {ex.tempo}</div>}
                    {ex.notes && <div className="text-[10px] mt-0.5" style={{ color: faint }}>Notes: {ex.notes}</div>}
                  </div>
                </div>
              </button>
            );
          })}

          {importError && (
            <div className="text-center text-[12px] py-2" style={{ color: '#F87171' }}>{importError}</div>
          )}

          <button onClick={() => setImportStage('destination')}
            disabled={selected.size === 0}
            className="w-full py-3 rounded-xl text-[13px] font-bold transition-all active:scale-[.98]"
            style={{
              background: selected.size === 0 ? '#888' : accent,
              color: 'white',
              opacity: selected.size === 0 ? 0.5 : 1,
              cursor: selected.size === 0 ? 'not-allowed' : 'pointer',
            }}>
            Next · Choose destination
          </button>
          <button onClick={() => setImportStage('preview')} className="w-full py-2 text-[12px]" style={{ color: mute }}>
            ← Back to preview
          </button>
        </div>
      </div>
    );
  }

  // ---- DESTINATION SELECTION STATE ----
  if (importStage === 'destination') {
    const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    return (
      <div className="min-h-screen px-4 py-8" style={{ background: bg }}>
        <div className="max-w-md mx-auto space-y-4">
          <div className="text-center mb-2">
            <div className="text-[11px] uppercase tracking-[.18em] font-semibold" style={{ color: mute }}>Where do you want to add this?</div>
            <div className="font-black text-xl mt-1" style={{ color: ink }}>{data.workout?.name || 'Workout'}</div>
            <div className="text-[11px] mt-0.5" style={{ color: mute }}>{selected.size} exercises</div>
          </div>

          {/* Add for Today */}
          <button onClick={() => doImport('today')}
            className="w-full rounded-2xl px-5 py-4 text-left transition-all active:scale-[.98]"
            style={{ background: cardBg, border: `1px solid ${border}`, boxShadow: '0 2px 16px rgba(0,0,0,0.06)' }}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl grid place-items-center shrink-0" style={{ background: '#FEF3C7', border: '1px solid #F59E0B33' }}>
                <span className="text-lg">⚡</span>
              </div>
              <div>
                <div className="font-grotesk text-[14px] font-bold" style={{ color: ink }}>Add for Today</div>
                <div className="text-[11px] mt-0.5" style={{ color: mute }}>Creates today's workout session with these exercises</div>
              </div>
            </div>
          </button>

          {/* Add to My Workouts */}
          <button onClick={() => doImport('planner')}
            className="w-full rounded-2xl px-5 py-4 text-left transition-all active:scale-[.98]"
            style={{ background: cardBg, border: `1px solid ${border}`, boxShadow: '0 2px 16px rgba(0,0,0,0.06)' }}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl grid place-items-center shrink-0" style={{ background: '#DBEAFE', border: '1px solid #3B82F633' }}>
                <span className="text-lg">📋</span>
              </div>
              <div>
                <div className="font-grotesk text-[14px] font-bold" style={{ color: ink }}>Add to My Workouts</div>
                <div className="text-[11px] mt-0.5" style={{ color: mute }}>Saves as a reusable workout in your personal planner</div>
              </div>
            </div>
          </button>

          {/* Add to a Specific Day */}
          {!dayOfWeek && dayOfWeek !== 0 ? (
            <button onClick={() => setDayOfWeek('choose')}
              className="w-full rounded-2xl px-5 py-4 text-left transition-all active:scale-[.98]"
              style={{ background: cardBg, border: `1px solid ${border}`, boxShadow: '0 2px 16px rgba(0,0,0,0.06)' }}>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl grid place-items-center shrink-0" style={{ background: '#F3E8FF', border: '1px solid #8B5CF633' }}>
                  <span className="text-lg">📅</span>
                </div>
                <div>
                  <div className="font-grotesk text-[14px] font-bold" style={{ color: ink }}>Add to a Specific Day</div>
                  <div className="text-[11px] mt-0.5" style={{ color: mute }}>Save it and assign to a day of the week</div>
                </div>
              </div>
            </button>
          ) : dayOfWeek === 'choose' && (
            <div className="rounded-2xl px-5 py-4" style={{ background: cardBg, border: `1px solid ${border}` }}>
              <div className="font-grotesk text-[14px] font-bold mb-3" style={{ color: ink }}>Choose a day</div>
              <div className="grid grid-cols-7 gap-1.5">
                {DAYS.map((day, i) => (
                  <button key={i} onClick={() => doImport('planner_day', i)}
                    className="rounded-xl border px-1 py-2.5 text-center transition-all active:scale-95"
                    style={{ borderColor: border, background: 'transparent' }}>
                    <div className="text-[8px] uppercase tracking-wider font-grotesk" style={{ color: mute }}>{dayLabels[i]}</div>
                    <div className="text-[9px] font-grotesk font-semibold mt-0.5 leading-tight" style={{ color: ink }}>{day.slice(0, 3)}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {importError && (
            <div className="text-center text-[12px] py-2" style={{ color: '#F87171' }}>{importError}</div>
          )}

          <button onClick={() => setImportStage('select')} className="w-full py-2 text-[12px]" style={{ color: mute }}>
            ← Back to exercise selection
          </button>
        </div>
      </div>
    );
  }

  // ---- PREVIEW STATE (default) ----
  return (
    <div className="min-h-screen px-4 py-8" style={{ background: bg }}>
      <div className="max-w-md mx-auto space-y-4">
        <div className="text-center mb-2">
          <div className="text-[11px] uppercase tracking-[.18em] font-semibold" style={{ color: mute }}>
            {data.shared_by_name ? `Shared by ${data.shared_by_name}` : 'Shared workout'}
          </div>
          <div className="font-black text-2xl mt-1" style={{ color: ink }}>Workout Preview</div>
        </div>

        {/* Workout name + exercise count */}
        <div className="rounded-2xl p-5" style={{ background: cardBg, border: `1px solid ${border}`, boxShadow: '0 2px 20px rgba(0,0,0,0.08)' }}>
          <div className="flex items-center justify-between mb-3">
            <div className="font-bold text-lg uppercase tracking-wide" style={{ color: ink }}>{data.workout?.name || 'Workout'}</div>
            <span className="text-[9px] uppercase tracking-wider font-semibold px-2 py-1 rounded-full" style={{ background: `${accent}18`, color: accent }}>
              {exercises.length} exercises
            </span>
          </div>
          {data.workout?.notes && (
            <div className="text-[12px] mb-3 pb-3" style={{ color: mute, borderBottom: `1px solid ${border}` }}>
              {data.workout.notes}
            </div>
          )}

          {/* Exercise cards */}
          <div className="space-y-2">
            {exercises.map((ex, i) => (
              <div key={i} className="rounded-xl px-3 py-3 anim-fadeUp" style={{ background: dark ? 'rgba(255,255,255,.03)' : 'rgba(0,0,0,.02)', border: `1px solid ${border}`, animationDelay: `${i * 60}ms` }}>
                <div className="flex items-center justify-between gap-2">
                  <div className="font-grotesk text-[13px] font-semibold truncate" style={{ color: ink }}>{ex.name}</div>
                </div>
                <div className="text-[11px] mt-1" style={{ color: mute }}>
                  {ex.sets} sets · {ex.reps} reps · {ex.weight}
                </div>
                {ex.rest_sec && <div className="text-[10px] mt-0.5" style={{ color: faint }}>Rest: {ex.rest_sec}s</div>}
                {ex.tempo && <div className="text-[10px] mt-0.5" style={{ color: faint }}>Tempo: {ex.tempo}</div>}
                {ex.notes && <div className="text-[10px] mt-0.5" style={{ color: faint }}>Notes: {ex.notes}</div>}
              </div>
            ))}
          </div>
        </div>

        {/* Action buttons */}
        {authed ? (
          <>
            {importStage === 'preview' && (
              <button onClick={startImport} className="w-full py-3 rounded-xl text-[13px] font-bold text-white transition-transform active:scale-[.98]" style={{ background: accent }}>
                Add to My Workouts
              </button>
            )}
          </>
        ) : (
          <button onClick={() => { setReturnTo(`/workout-share/${id}`); navigate('/login'); }}
            className="w-full py-3 rounded-xl text-[13px] font-bold" style={{ background: `${accent}18`, color: accent }}>
            Sign in to add this workout to your planner
          </button>
        )}

        {authed && (
          <button onClick={() => navigate('/app/client/workout')} className="w-full py-2.5 rounded-xl text-[12px] font-semibold" style={{ color: mute, border: `1px solid ${border}` }}>
            Back to my workouts
          </button>
        )}
      </div>

      <SavingOverlay open={importStage === 'importing'} stage="saving" label="Importing" sublabel="Adding to your planner…" mode="overlay" />
    </div>
  );
}
