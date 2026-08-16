import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { Spinner, ErrorState, Bar, Ring } from '../../components/UI.jsx';
import ExerciseAnim from '../../components/exerciseSVG.jsx';
import MuscleMap, { regionForMuscle } from '../../components/MuscleMap.jsx';
const TunnelBackdrop = lazy(() => import('../../components/TunnelBackdrop.jsx'));

const REGION_IDS = new Set(['chest', 'shoulders', 'biceps', 'forearms', 'core', 'quads', 'calves', 'traps', 'triceps', 'lats', 'lower_back', 'glutes', 'hamstrings']);

export default function Workout() {
  const today = useFetch(() => api('/tracking/me/today'));
  const week = useFetch(() => api('/tracking/me/week'));
  const hist = useFetch(() => api('/tracking/me/workouts'));
  const perms = useFetch(() => api('/me/permissions'));
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [muscleFilter, setMuscleFilter] = useState(null);
  const [exState, setExState] = useState(null);
  const [toast, setToast] = useState('');
  // build-my-workout
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderName, setBuilderName] = useState('');
  const [builderExs, setBuilderExs] = useState([]); // {exercise_id, name, muscle, sets, reps, weight}
  const [libList, setLibList] = useState(null);
  const [libSearch, setLibSearch] = useState('');
  const [savingBuilder, setSavingBuilder] = useState(false);
  // personal workout planner (reusable workouts + weekly schedule)
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [planner, setPlanner] = useState(null); // { workouts, schedule }
  const [planForm, setPlanForm] = useState(null); // { id: null|workoutId, name, notes, exercises } when creating/editing
  const [savingPlan, setSavingPlan] = useState(false);
  const [mode, setMode] = useState('browse'); // browse | execute | summary
  const [result, setResult] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // execution state
  const [exProgress, setExProgress] = useState({});
  const [execInputs, setExecInputs] = useState({}); // exId -> { reps, weight, rir }
  const [rest, setRest] = useState(null); // { seconds, total }
  const [startedAt, setStartedAt] = useState(0);
  // this week preview
  const [weekDay, setWeekDay] = useState(null); // { label, name, focus, exercises }
  const [weekDayIdx, setWeekDayIdx] = useState(0);

  const session = today.data;
  const workout = session?.workout || null;
  const exercises = workout?.exercises || [];
  const state = exState || exercises;
  const selected = state[Math.min(selectedIdx, Math.max(0, state.length - 1))];

  const focus = session?.focus || [];
  const meta = session?.meta || {};
  const suggestions = session?.suggestions || [];

  const equipMap = useMemo(() => Object.fromEntries((session?.equipment || []).map((e) => [e.exercise_id, e])), [session]);
  const muscles = useMemo(() => [...new Set(exercises.map((e) => e.primary_muscle).filter(Boolean))], [exercises]);
  const filtered = useMemo(() => {
    if (!muscleFilter) return exercises;
    if (REGION_IDS.has(muscleFilter)) return exercises.filter((e) => regionForMuscle(e.primary_muscle) === muscleFilter);
    return exercises.filter((e) => e.primary_muscle === muscleFilter);
  }, [exercises, muscleFilter]);

  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(''), 2400);
    return () => clearTimeout(h);
  }, [toast]);

  // rest timer countdown
  useEffect(() => {
    if (!rest) return;
    if (rest.seconds <= 0) { setRest(null); return; }
    const h = setTimeout(() => setRest((r) => (r ? { ...r, seconds: r.seconds - 1 } : null)), 1000);
    return () => clearTimeout(h);
  }, [rest]);

  // ---- personal workout planner helpers ----
  const loadPlanner = async () => {
    try { setPlanner(await api('/me/planner')); }
    catch (e) { setToast(e.message || 'Could not load your workouts'); }
  };

  const openPlanner = async () => {
    setPlannerOpen(true);
    if (!planner) await loadPlanner();
  };

  const savePlan = async () => {
    if (!planForm?.name?.trim() || !planForm?.exercises?.length) return;
    setSavingPlan(true);
    try {
      const body = { name: planForm.name, notes: planForm.notes, exercises: planForm.exercises.map((e) => ({
        exercise_id: e.exercise_id, name: e.name, sets: e.sets, reps: e.reps, weight: e.weight, rest_sec: e.rest_sec
      })) };
      if (planForm.id) await api(`/me/planner/workouts/${planForm.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/me/planner/workouts', { method: 'POST', body: JSON.stringify(body) });
      setPlanForm(null);
      setToast(planForm.id ? 'Workout updated' : 'Workout saved to My Workouts');
      await loadPlanner();
    } catch (e) { setToast(e.message || 'Could not save workout'); }
    setSavingPlan(false);
  };

  const duplicatePlan = async (w) => {
    try {
      await api(`/me/planner/workouts/${w.id}/duplicate`, { method: 'POST' });
      setToast('Workout duplicated');
      await loadPlanner();
    } catch (e) { setToast(e.message); }
  };

  const deletePlan = async (w) => {
    if (!window.confirm(`Delete "${w.name}"?`)) return;
    try {
      await api(`/me/planner/workouts/${w.id}`, { method: 'DELETE' });
      setToast('Workout deleted');
      await loadPlanner();
    } catch (e) { setToast(e.message); }
  };

  const setDayWorkout = async (dow, wid) => {
    const sched = planner?.schedule || [];
    const cur = sched.find((s) => s.day_of_week === dow);
    const next = wid === cur?.workout_id ? null : wid;
    try {
      const map = {};
      for (let d = 0; d <= 6; d++) {
        const s = sched.find((x) => x.day_of_week === d);
        map[d] = d === dow ? next : (s?.workout_id || null);
      }
      await api('/me/planner/schedule', { method: 'PUT', body: JSON.stringify({ schedule: map }) });
      await loadPlanner();
      setToast(next ? 'Assigned to your week' : 'Rest day');
    } catch (e) { setToast(e.message || 'Could not update schedule'); }
  };

  const startPlanToday = async (w) => {
    try {
      await api('/me/workouts', { method: 'POST', body: JSON.stringify({
        name: w.name,
        exercises: (w.exercises || []).map((e) => ({ exercise_id: e.exercise_id, sets: e.sets, reps: e.reps, weight: e.weight, rest_sec: e.rest_sec }))
      }) });
      setPlannerOpen(false);
      setToast(`${w.name} is today's session 🔥`);
      today.reload(); hist.reload();
    } catch (e) { setToast(e.message || 'Could not schedule today'); }
  };

  const locked = perms.data?.workout_mode === 'prescribed';
  const canBuild = !locked && (perms.data?.can_create_workout !== false);

  // today's dow in training_days convention: 1=Mon..6=Sat,0=Sun
  const todayDow = (() => {
    const d = new Date();
    const js = d.getDay(); // 0=Sun
    return js === 0 ? 0 : js; // training_days: Mon=1..Sat=6, Sun=0
  })();
  const weekRows = week.data?.week || [];

  if (today.loading || week.loading || hist.loading || perms.loading) return <Spinner label="Loading your session…" />;
  if (today.error) return <ErrorState error={today.error} onRetry={today.reload} />;

  const toggleEx = async (ex) => {
    const next = !ex.done;
    setExState(state.map((x) => (x.id === ex.id ? { ...x, done: next } : x)));
    try { await api(`/workouts/${workout.id}/exercises/${ex.id}`, { method: 'PATCH' }); } catch { today.reload(); }
  };

  // ---- execution ----
  const totalSets = state.reduce((s, e) => s + (e.sets || 0), 0);
  const doneSets = Object.values(exProgress).reduce((s, n) => s + n, 0);
  const currentEx = state.find((e) => (exProgress[e.id] || 0) < (e.sets || 0)) || null;

  const startWorkout = () => {
    setExProgress(Object.fromEntries(state.map((e) => [e.id, 0])));
    setExecInputs(Object.fromEntries(state.map((e) => [e.id, {
      reps: parseFloat(e.reps) || 0,
      weight: parseFloat(e.weight) || 0,
      rir: null
    }])));
    setStartedAt(Date.now());
    setMode('execute');
  };

  const patchInput = (exId, k, v) => setExecInputs((inp) => ({ ...inp, [exId]: { ...(inp[exId] || {}), [k]: v } }));

  const completeSet = () => {
    if (!currentEx) return;
    const next = { ...exProgress, [currentEx.id]: (exProgress[currentEx.id] || 0) + 1 };
    setExProgress(next);
    const remainingAfter = state.filter((e) => (next[e.id] || 0) < (e.sets || 0)).length;
    if (remainingAfter > 0) {
      setRest({ seconds: currentEx.rest_sec || 90, total: currentEx.rest_sec || 90 });
    } else {
      finishWorkout(next);
    }
  };

  // Build per-set logs from actual captured inputs (what was entered when each set was completed).
  const finishWorkout = async (progress) => {
    setSubmitting(true);
    try {
      const logs = state.filter((e) => (progress[e.id] || 0) > 0).map((e) => {
        const inp = execInputs[e.id] || { reps: parseFloat(e.reps) || 0, weight: parseFloat(e.weight) || 0, rir: null };
        const n = progress[e.id] || 0;
        return {
          exercise_id: e.id,
          sets: Array.from({ length: n }, (_, i) => ({
            set_number: i + 1,
            actual_reps: Number(inp.reps) || 0,
            actual_weight: Number(inp.weight) || 0,
            rir: inp.rir ? Number(inp.rir) : undefined
          }))
        };
      });
      const { prs } = await api(`/workouts/${workout.id}/complete`, { method: 'POST', body: JSON.stringify({ logs }) });
      const volume = logs.reduce((s, l) => s + l.sets.reduce((a, st) => a + (st.actual_reps * st.actual_weight), 0), 0);
      const durationMin = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
      setResult({ prs: prs || [], volume, durationMin, exercises: state.length });
      setMode('summary');
      today.reload(); hist.reload();
    } catch (e) {
      setToast(e.message || 'Could not log workout');
      setMode('browse');
    }
    setSubmitting(false);
  };

  // ================= browse mode =================
  if (mode === 'browse') {
    return (
      <div className="space-y-4 pb-2">
        {/* header */}
        {workout ? (
          <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="kicker">Today's training</div>
                <h1 className="font-grotesk font-bold text-2xl leading-tight">{workout.name}</h1>
                <div className="text-xs text-mute mt-1">{focus.map((f) => f.muscle).join(' · ')}</div>
              </div>
              <span className="chip border-gold/30 text-gold shrink-0">{meta.estMinutes || '—'} min</span>
            </div>

            {/* session meta strip */}
            <div className="grid grid-cols-3 gap-2.5">
              {[
                ['Exercises', meta.exerciseCount], ['Total sets', meta.totalSets], ['Est. burn', `~${meta.estKcal} kcal`]
              ].map(([l, v]) => (
                <div key={l} className="card !p-3 text-center">
                  <div className="font-grotesk font-bold text-lg">{v}</div>
                  <div className="text-[9px] uppercase tracking-wider text-mute font-grotesk mt-0.5">{l}</div>
                </div>
              ))}
            </div>

            {/* muscle focus */}
            {focus.length > 1 && (
              <div className="card p-4">
                <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk mb-3">Today's focus</div>
                <div className="space-y-2.5">
                  {focus.slice(0, 5).map((f, i) => (
                    <Bar key={f.muscle} label={f.muscle} value={f.count} max={focus[0].count}
                      color={i === 0 ? 'linear-gradient(92deg,#087F7B,#12B8B0)' : 'linear-gradient(92deg,rgba(18,184,176,.35),rgba(18,184,176,.18))'}
                      right={`${f.count}${f.count > 1 ? ' ex' : ' ex'}`} height="h-1.5" />
                  ))}
                </div>
              </div>
            )}

            {/* filter chips */}
            <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-4 px-4">
              <button onClick={() => setMuscleFilter(null)}
                className={`chip border shrink-0 transition-all ${!muscleFilter ? 'bg-gradient-to-r from-ember to-gold text-bg border-transparent shadow-md shadow-ember/25' : 'border-line text-mute'}`}>
                All
              </button>
              {muscles.map((m) => (
                <button key={m} onClick={() => setMuscleFilter(muscleFilter === m ? null : m)}
                  className={`chip border shrink-0 transition-all ${muscleFilter === m ? 'bg-gradient-to-r from-ember to-gold text-bg border-transparent shadow-md shadow-ember/25' : 'border-line text-mute'}`}>
                  {m}
                </button>
              ))}
            </div>

            {/* muscle map */}
            <div className="card p-4 flex flex-col sm:flex-row items-center gap-4">
              <MuscleMap
                activeMuscles={exercises.map((e) => e.primary_muscle)}
                selected={REGION_IDS.has(muscleFilter) ? muscleFilter : (selected?.primary_muscle || null)}
                onSelect={(rid) => setMuscleFilter(muscleFilter === rid ? null : rid)}
                size={Math.min(220, typeof window !== 'undefined' ? Math.min(window.innerWidth - 80, 220) : 220)}
              />
              <div className="flex-1 text-center sm:text-left">
                <div className="font-grotesk font-semibold text-sm">Tap a muscle to filter</div>
                <div className="text-[11px] text-mute mt-1 leading-relaxed">Today's targets light up automatically. Front & back toggle to explore.</div>
                <div className="mt-3 flex flex-wrap gap-1.5 justify-center sm:justify-start">
                  {focus.slice(0, 6).map((f) => (
                    <button key={f.muscle} onClick={() => setMuscleFilter(muscleFilter === f.muscle ? null : f.muscle)}
                      className="chip border border-ember/30 text-ember bg-ember/10 hover:bg-ember/20 transition-colors">
                      {f.muscle}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* exercise list */}
            <div className="space-y-2">
              {filtered.map((ex, i) => (
                <div key={ex.id}
                  className={`card p-3.5 flex items-center gap-3 transition-all ${selectedIdx === i && !muscleFilter ? 'border-gold/50 shadow-lg shadow-ember/10' : ''}`}>
                  <button onClick={() => { setSelectedIdx(i); setMuscleFilter(null); }} className="flex-1 min-w-0 text-left">
                    <div className="flex items-center gap-2">
                      <span className="font-grotesk text-sm font-semibold truncate">{ex.name}</span>
                      {ex.primary_muscle && <span className="chip border-line !px-1.5 !py-0 text-[9px] shrink-0">{ex.primary_muscle}</span>}
                      {equipMap[ex.id]?.missing?.length > 0 && <span className="chip border-warn/40 text-warn bg-warn/10 !px-1.5 !py-0 text-[9px] shrink-0" title={`Needs: ${equipMap[ex.id].required.join(', ')}`}>⚠ equipment</span>}
                    </div>
                    <div className="text-[11px] text-mute mt-0.5">{ex.sets} × {ex.reps} · {ex.weight} · rest {ex.rest_sec}s</div>
                  </button>
                  <button aria-label={`Mark ${ex.name} done`} onClick={() => toggleEx(ex)}
                    className={`w-8 h-8 rounded-xl border grid place-items-center text-sm transition-all ${ex.done ? 'bg-gradient-to-br from-ember to-gold text-bg border-transparent shadow-lg shadow-ember/30' : 'border-line text-faint hover:border-gold/50'}`}>
                    {ex.done ? '✓' : ''}
                  </button>
                </div>
              ))}
              {!filtered.length && (
                <div className="card p-6 text-center text-xs text-mute">No exercises target this muscle today — tap another.</div>
              )}
            </div>

            {/* selected exercise detail */}
            {selected && (
              <div className="card p-4">
                <div className="flex justify-between items-center mb-2">
                  <span className="font-grotesk font-semibold text-sm">{selected.name}</span>
                  <span className="text-[10px] text-mute uppercase tracking-wider font-grotesk">{selected.sets}×{selected.reps} · {selected.weight}</span>
                </div>
                <ExerciseAnim anim={selected.animation_key || 'fallback'} muscle={selected.primary_muscle} label={`${selected.sets}×${selected.reps} · ${selected.weight}`} />
                <div className="grid grid-cols-3 gap-2 mt-3 text-center">
                  {[
                    ['Primary', selected.primary_muscle || '—'],
                    ['Secondary', (selected.secondary_muscles || '—').replace(/,/g, ' · ')],
                    ['Equipment', selected.equipment || '—']
                  ].map(([l, v]) => (
                    <div key={l} className="rounded-xl bg-white/[.03] border border-line px-2 py-2">
                      <div className="text-[8px] uppercase tracking-wider text-mute font-grotesk">{l}</div>
                      <div className="text-[10px] font-grotesk font-semibold mt-0.5 leading-tight">{v}</div>
                    </div>
                  ))}
                </div>
                {selected.cues && <div className="mt-3 rounded-xl border border-gold/25 bg-gold/5 px-3 py-2.5 text-[11px] leading-relaxed"><span className="text-gold font-grotesk font-semibold mr-1.5">FORM CUE</span>{selected.cues}</div>}
                {equipMap[selected.id]?.missing?.length > 0 && (
                  <div className="mt-3 rounded-xl border border-warn/30 bg-warn/5 px-3 py-2.5 text-[11px]">
                    <div className="flex items-center gap-2">
                      <span className="text-warn font-grotesk font-semibold">⚠ EQUIPMENT NOT AVAILABLE</span>
                    </div>
                    <div className="text-mute mt-1">Your profile doesn't list: <span className="text-ink font-semibold">{equipMap[selected.id].missing.join(', ')}</span>. Check with your coach or swap:</div>
                    {equipMap[selected.id].alternatives?.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {equipMap[selected.id].alternatives.map((a) => (
                          <span key={a.id} className="chip border-cyanx/30 text-cyanx bg-cyanx/10" title={a.reason}>{a.name}</span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {(() => {
                  const sug = suggestions.find((s) => s.exercise_id === selected.id);
                  if (!sug) return null;
                  return (
                    <div className="mt-2.5 rounded-xl border border-cyanx/25 bg-cyanx/5 px-3 py-2.5 text-[11px]">
                      <span className="text-cyanx font-grotesk font-semibold mr-1.5">NEXT TARGET</span>
                      {sug.suggested.weight > 0
                        ? `${sug.suggested.weight} kg × ${sug.suggested.reps}` + (sug.increment ? ` (+${sug.increment} kg)` : '')
                        : `${sug.suggested.reps} reps`}
                      <span className="text-mute block mt-0.5 text-[10px]">Based on your last session · {sug.rationale}</span>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* start CTA */}
            <button data-start-workout className="btn-primary w-full !py-4 text-sm" onClick={startWorkout} disabled={!exercises.length}>
              🔥 START WORKOUT — {meta.totalSets || 0} sets
            </button>
          </>
        ) : (
          <div className="card p-10 text-center">
            <div className="text-4xl mb-3">🛌</div>
            <div className="font-grotesk font-bold text-lg">Rest day</div>
            <div className="text-xs text-mute mt-1.5 max-w-xs mx-auto">No session scheduled for today. Recovery is training too — fuel well and sleep 8 hours.</div>
            <div className="mt-4 text-[10px] uppercase tracking-widest text-gold font-grotesk">Next session appears here tomorrow</div>
          </div>
        )}

        {/* this week — full program at a glance */}
        {weekRows.length > 0 && (
          <div className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk">This week · {week.data?.program?.name || 'Your plan'}</div>
              <span className="chip border-gold/30 text-gold !text-[9px]">{weekRows.filter((d) => d.name !== 'Rest').length} training days</span>
            </div>
            <div className="grid grid-cols-7 gap-1.5">
              {weekRows.map((d, i) => {
                const isToday = d.day_of_week === todayDow;
                const isRest = d.name === 'Rest';
                return (
                  <button key={d.day_of_week} onClick={() => { setWeekDay(d); setWeekDayIdx(i); }}
                    className={`rounded-xl border px-1 py-2 text-center transition-all ${isToday ? 'border-gold/60 bg-gold/10 shadow-lg shadow-ember/10' : isRest ? 'border-line bg-white/[.02] opacity-60' : 'border-line bg-white/[.02] hover:bg-white/[.05]'}`}>
                    <div className={`text-[8px] uppercase tracking-wider font-grotesk ${isToday ? 'text-gold' : 'text-mute'}`}>{d.label}</div>
                    <div className={`text-[9px] font-grotesk font-semibold mt-0.5 leading-tight truncate ${isToday ? 'text-gold' : isRest ? 'text-faint' : 'text-ink'}`}>
                      {isRest ? 'Rest' : d.name.split(' ').slice(0, 2).join(' ')}
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="text-[10px] text-faint mt-2.5">Tap a day to preview its session — Legs, Back, Core and everything else at a glance.</div>
          </div>
        )}

        {/* build my workout — client owns their own session */}
        <div className="card p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk">My workout</div>
              {locked ? (
                <div className="text-[11px] text-faint mt-0.5">Your gym has locked workout creation — follow your coach's plan. 🔒</div>
              ) : (
                <div className="text-[11px] text-faint mt-0.5">Build today's session yourself, or manage your reusable workouts & weekly plan.</div>
              )}
            </div>
            {!locked && (
              <div className="flex gap-2 shrink-0">
                <button className="btn shrink-0 !px-3 !py-2.5 !text-xs" onClick={openPlanner}>My workouts</button>
                <button className="btn-primary shrink-0 !px-3 !py-2.5 !text-xs" onClick={async () => {
                  if (!libList) api('/workouts/exercises').then((r) => setLibList(r.exercises || [])).catch(() => setToast('Could not load the exercise library'));
                  setBuilderOpen(true);
                }}>Build today</button>
              </div>
            )}
          </div>
        </div>

        {/* build-my-workout modal */}
        {builderOpen && (
          <div className="fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm grid place-items-center p-4">
            <div className="card w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden">
              <div className="p-4 border-b border-line/60 flex items-center justify-between">
                <div>
                  <div className="font-grotesk font-bold">Build my workout</div>
                  <div className="text-[10px] text-mute">Picks any exercises — saves as today's session</div>
                </div>
                <button className="text-mute hover:text-ink text-lg" onClick={() => setBuilderOpen(false)} aria-label="Close">✕</button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                <input className="input" placeholder="Workout name (e.g. My Upper Day)" value={builderName} onChange={(e) => setBuilderName(e.target.value)} />
                <input className="input" placeholder="Search exercises by name or muscle…" value={libSearch} onChange={(e) => setLibSearch(e.target.value)} />
                {(libList || []).filter((x) => !libSearch || (x.name + ' ' + (x.primary_muscle || '')).toLowerCase().includes(libSearch.toLowerCase())).slice(0, 30).map((x) => {
                  const added = builderExs.some((b) => b.exercise_id === x.id);
                  return (
                    <div key={x.id} className="flex items-center gap-2 rounded-xl border border-line bg-white/[.02] px-3 py-2">
                      <span className="flex-1 min-w-0">
                        <span className="block text-[13px] font-grotesk font-semibold truncate">{x.name}</span>
                        <span className="text-[10px] text-mute">{x.primary_muscle || ''}{x.equipment ? ` · ${x.equipment}` : ''}</span>
                      </span>
                      <button className={`btn !py-1 !px-2.5 !text-[10px] shrink-0 ${added ? 'opacity-40' : ''}`} disabled={added} onClick={() =>
                        setBuilderExs((b) => [...b, { exercise_id: x.id, name: x.name, muscle: x.primary_muscle, sets: 3, reps: '10', weight: 'BW' }])}>
                        {added ? 'Added' : '+ Add'}
                      </button>
                    </div>
                  );
                })}
                {!!builderExs.length && (
                  <div className="space-y-2 pt-1">
                    <div className="text-[10px] text-faint font-grotesk uppercase tracking-wider">MY SESSION</div>
                    {builderExs.map((b, i) => (
                      <div key={b.exercise_id} className="rounded-xl border border-gold/25 bg-gold/5 p-3">
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="font-grotesk text-[13px] font-semibold truncate">{i + 1}. {b.name}</span>
                          <button className="text-[10px] text-bad/80 hover:text-bad shrink-0" onClick={() => setBuilderExs((x) => x.filter((_, j) => j !== i))}>Remove</button>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          <input type="number" className="input !py-1.5 !text-xs" aria-label="Sets" value={b.sets} onChange={(e) => setBuilderExs((x) => x.map((y, j) => j === i ? { ...y, sets: e.target.value } : y))} />
                          <input className="input !py-1.5 !text-xs" aria-label="Reps" value={b.reps} onChange={(e) => setBuilderExs((x) => x.map((y, j) => j === i ? { ...y, reps: e.target.value } : y))} />
                          <input className="input !py-1.5 !text-xs" aria-label="Weight" value={b.weight} onChange={(e) => setBuilderExs((x) => x.map((y, j) => j === i ? { ...y, weight: e.target.value } : y))} />
                        </div>
                        <div className="text-[9px] text-faint mt-1 font-grotesk">sets · reps · weight</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="p-4 border-t border-line/60">
                <button className="btn-primary w-full" disabled={savingBuilder || !builderName.trim() || !builderExs.length} onClick={async () => {
                  setSavingBuilder(true);
                  try {
                    await api('/me/workouts', { method: 'POST', body: JSON.stringify({ name: builderName, exercises: builderExs.map((b) => ({ exercise_id: b.exercise_id, sets: b.sets, reps: b.reps, weight: b.weight })) }) });
                    setBuilderOpen(false); setBuilderName(''); setBuilderExs([]);
                    setToast('Your workout is scheduled for today 🔥');
                    today.reload(); hist.reload();
                  } catch (e) { setToast(e.message); }
                  setSavingBuilder(false);
                }}>
                  {savingBuilder ? 'Saving…' : 'Save as today\'s session'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* personal workout planner modal */}
        {plannerOpen && (
          <div className="fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm grid place-items-center p-4">
            <div className="card w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden">
              <div className="p-4 border-b border-line/60 flex items-center justify-between">
                <div>
                  <div className="font-grotesk font-bold">My workouts</div>
                  <div className="text-[10px] text-mute">Reusable sessions + your weekly plan</div>
                </div>
                <button className="text-mute hover:text-ink text-lg" onClick={() => setPlannerOpen(false)} aria-label="Close">✕</button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {/* weekly schedule */}
                <div>
                  <div className="text-[10px] text-faint font-grotesk uppercase tracking-wider mb-2">MY WEEK — tap a day to assign</div>
                  <div className="grid grid-cols-7 gap-1.5">
                    {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, dow) => {
                      const s = (planner?.schedule || []).find((x) => x.day_of_week === dow);
                      const w = planner?.workouts?.find((x) => x.id === s?.workout_id);
                      const dayWorkouts = planner?.workouts || [];
                      const nextId = w ? null : (dayWorkouts.length ? dayWorkouts[(dayWorkouts.findIndex((x) => x.id === s?.workout_id) + 1) % dayWorkouts.length].id : null);
                      return (
                        <button key={dow} onClick={() => dayWorkouts.length && setDayWorkout(dow, nextId)}
                          className={`rounded-xl border px-1 py-2 text-center transition-all ${w ? 'border-gold/40 bg-gold/10' : 'border-line bg-white/[.02]'}`}>
                          <div className="text-[8px] uppercase tracking-wider text-mute font-grotesk">{d}</div>
                          <div className={`text-[9px] font-grotesk font-semibold mt-0.5 leading-tight ${w ? 'text-gold' : 'text-faint'}`}>
                            {w ? w.name.split(' ').slice(0, 2).join(' ') : 'Rest'}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* plan form (create / edit) */}
                {planForm ? (
                  <div className="rounded-xl border border-gold/30 bg-gold/5 p-3 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <div className="text-[10px] text-gold font-grotesk uppercase tracking-wider">{planForm.id ? 'Edit workout' : 'New workout'}</div>
                      <button className="text-[10px] text-mute" onClick={() => setPlanForm(null)}>← Back</button>
                    </div>
                    <input className="input" placeholder="Workout name (e.g. Push A, Legs, My Upper Day)" value={planForm.name || ''} onChange={(e) => setPlanForm((f) => ({ ...f, name: e.target.value }))} />
                    <input className="input" placeholder="Search exercises…" value={planForm.search || ''} onChange={(e) => setPlanForm((f) => ({ ...f, search: e.target.value }))} />
                    <div className="max-h-36 overflow-y-auto space-y-1.5 pr-1">
                      {(libList || []).filter((x) => !planForm.search || (x.name + ' ' + (x.primary_muscle || '')).toLowerCase().includes(planForm.search.toLowerCase())).slice(0, 20).map((x) => {
                        const added = (planForm.exercises || []).some((b) => b.exercise_id === x.id);
                        return (
                          <button key={x.id} disabled={added} onClick={() => setPlanForm((f) => ({ ...f, exercises: [...(f.exercises || []), { exercise_id: x.id, name: x.name, muscle: x.primary_muscle, sets: 3, reps: '10', weight: 'BW', rest_sec: 90 }] }))}
                            className={`w-full flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left ${added ? 'border-line opacity-40' : 'border-line bg-white/[.02]'}`}>
                            <span className="min-w-0">
                              <span className="block text-[12px] font-grotesk font-semibold truncate">{x.name}</span>
                              <span className="text-[9px] text-mute">{x.primary_muscle || ''}{x.equipment ? ` · ${x.equipment}` : ''}</span>
                            </span>
                            <span className="text-[10px] text-gold shrink-0">{added ? '✓' : '+ Add'}</span>
                          </button>
                        );
                      })}
                    </div>
                    {(planForm.exercises || []).map((b, i) => (
                      <div key={b.exercise_id} className="rounded-lg border border-line bg-bg/50 p-2.5">
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="font-grotesk text-[12px] font-semibold truncate">{i + 1}. {b.name}</span>
                          <button className="text-[10px] text-bad/80 hover:text-bad shrink-0" onClick={() => setPlanForm((f) => ({ ...f, exercises: f.exercises.filter((_, j) => j !== i) }))}>Remove</button>
                        </div>
                        <div className="grid grid-cols-4 gap-1.5">
                          <input type="number" className="input !py-1 !text-[10px]" aria-label="Sets" value={b.sets} onChange={(e) => setPlanForm((f) => ({ ...f, exercises: f.exercises.map((y, j) => j === i ? { ...y, sets: e.target.value } : y) }))} />
                          <input className="input !py-1 !text-[10px]" aria-label="Reps" value={b.reps} onChange={(e) => setPlanForm((f) => ({ ...f, exercises: f.exercises.map((y, j) => j === i ? { ...y, reps: e.target.value } : y) }))} />
                          <input className="input !py-1 !text-[10px]" aria-label="Weight" value={b.weight} onChange={(e) => setPlanForm((f) => ({ ...f, exercises: f.exercises.map((y, j) => j === i ? { ...y, weight: e.target.value } : y) }))} />
                          <input type="number" className="input !py-1 !text-[10px]" aria-label="Rest sec" value={b.rest_sec} onChange={(e) => setPlanForm((f) => ({ ...f, exercises: f.exercises.map((y, j) => j === i ? { ...y, rest_sec: e.target.value } : y) }))} />
                        </div>
                        <div className="text-[8px] text-faint mt-1 font-grotesk">sets · reps · weight · rest(s)</div>
                      </div>
                    ))}
                    <button className="btn-primary w-full !py-2.5 !text-xs" disabled={savingPlan || !planForm?.name?.trim() || !planForm?.exercises?.length} onClick={savePlan}>
                      {savingPlan ? 'Saving…' : (planForm.id ? 'Save changes' : 'Create workout')}
                    </button>
                  </div>
                ) : (
                  <>
                    <button className="btn-primary w-full !py-2.5 !text-xs" onClick={() => {
                      if (!libList) api('/workouts/exercises').then((r) => setLibList(r.exercises || [])).catch(() => setToast('Could not load the exercise library'));
                      setPlanForm({ id: null, name: '', exercises: [], search: '' });
                    }}>+ Create new workout</button>

                    {/* my reusable workouts */}
                    <div className="space-y-2">
                      {planner?.workouts?.length === 0 && (
                        <div className="card !p-6 text-center">
                          <div className="text-2xl mb-1.5">🏋️</div>
                          <div className="text-xs text-mute">No saved workouts yet — create one, then assign it to your week.</div>
                        </div>
                      )}
                      {(planner?.workouts || []).map((w) => (
                        <div key={w.id} className="rounded-xl border border-line bg-white/[.02] p-3">
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="font-grotesk text-[13px] font-semibold truncate">{w.name}</div>
                              <div className="text-[10px] text-mute">{(w.exercises || []).length} exercises · {((w.exercises || []).reduce((s, e) => s + (e.sets || 0), 0))} sets</div>
                            </div>
                            <div className="flex gap-1 shrink-0">
                              <button className="btn !px-2 !py-1 !text-[10px]" onClick={() => { setPlanForm({ id: w.id, name: w.name, exercises: (w.exercises || []).map((e) => ({ exercise_id: e.exercise_id, name: e.name, sets: e.sets, reps: e.reps, weight: e.weight, rest_sec: e.rest_sec })), search: '' }); }}>Edit</button>
                              <button className="btn !px-2 !py-1 !text-[10px]" onClick={() => duplicatePlan(w)}>Copy</button>
                              <button className="btn !px-2 !py-1 !text-[10px] text-bad" onClick={() => deletePlan(w)}>Del</button>
                            </div>
                          </div>
                          <button className="btn w-full !py-1.5 !text-[10px] mt-2 border-gold/30 text-gold" onClick={() => startPlanToday(w)}>▶ Do today</button>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* this-week day preview modal */}
        {weekDay && (
          <div className="fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm grid place-items-center p-4" role="dialog" aria-modal="true" aria-label={`${weekDay.label} — ${weekDay.name}`}>
            <div className="card w-full max-w-md max-h-[85vh] flex flex-col overflow-hidden anim-scaleIn">
              <div className="p-4 border-b border-line/60 flex items-start justify-between gap-3">
                <div>
                  <div className="kicker">{weekDay.label}{weekDay.day_of_week === todayDow ? ' · today' : ''}</div>
                  <div className="font-grotesk font-bold text-lg leading-tight">{weekDay.name}</div>
                  {weekDay.focus && <div className="text-[10px] text-mute mt-1 font-grotesk">{weekDay.focus}</div>}
                </div>
                <button className="btn-ghost !text-mute shrink-0" onClick={() => setWeekDay(null)} aria-label="Close">✕</button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-2">
                {weekDay.exercises?.length ? weekDay.exercises.map((ex, i) => (
                  <div key={i} className="rounded-xl border border-line bg-white/[.02] p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-grotesk text-[13px] font-semibold truncate">{ex.name}</span>
                      <span className="chip border-line !px-1.5 !py-0 text-[9px] shrink-0">{ex.primary_muscle || '—'}</span>
                    </div>
                    <div className="text-[11px] text-mute mt-1">{ex.sets} × {ex.reps} · {ex.weight} · rest {ex.rest_sec}s</div>
                  </div>
                )) : (
                  <div className="text-center py-10 text-mute text-sm">Rest day — no exercises scheduled.</div>
                )}
              </div>
              <div className="p-4 border-t border-line/60 flex gap-2">
                <button className="btn flex-1" onClick={() => setWeekDay(null)}>Close</button>
                {weekDay.day_of_week === todayDow && !!workout && (
                  <button className="btn-primary flex-1" onClick={() => { setWeekDay(null); document.querySelector('[data-start-workout]')?.click(); }}>Start today</button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* history */}
        {!!hist.data?.workouts?.length && (
          <div className="card p-4 mt-1">
            <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk mb-2.5">Recent sessions</div>
            <div className="space-y-1.5">
              {hist.data.workouts.filter((w) => w.id !== workout?.id).slice(0, 5).map((w) => (
                <div key={w.id} className="flex items-center justify-between text-xs border-b border-line/50 last:border-0 py-2">
                  <span className="font-grotesk font-semibold">{w.name}</span>
                  <span className="text-mute">{w.scheduled_date}</span>
                  <span className={`chip border ${w.status === 'completed' ? 'text-good border-good/40 bg-good/10' : 'text-warn border-warn/40 bg-warn/10'}`}>{w.status === 'completed' ? 'DONE' : w.status.toUpperCase()}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {toast && <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-full bg-panel border border-gold/40 font-grotesk text-xs shadow-card">{toast}</div>}
      </div>
    );
  }

  // ================= execute mode =================
  if (mode === 'execute') {
    const pct = totalSets ? Math.round((doneSets / totalSets) * 100) : 0;
    const setNum = currentEx ? (exProgress[currentEx.id] || 0) + 1 : 0;
    return (
      <div className="space-y-4 pb-2">
        {/* progress */}
        <div className="card p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk">Workout progress</div>
            <div className="font-grotesk font-bold text-sm text-gold">{doneSets}/{totalSets} sets</div>
          </div>
          <div className="h-2 rounded-full bg-white/8 overflow-hidden">
            <div className="h-full rounded-full bg-gradient-to-r from-ember to-gold transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-3 flex gap-1.5 flex-wrap">
            {state.map((e) => (
              <span key={e.id} className={`chip border !px-2 !py-0.5 text-[9px] ${(exProgress[e.id] || 0) >= e.sets ? 'text-good border-good/40 bg-good/10' : e.id === currentEx?.id ? 'text-gold border-gold/40 bg-gold/10' : 'text-mute'}`}>
                {e.name.split(' ').slice(0, 2).join(' ')} {exProgress[e.id] || 0}/{e.sets}
              </span>
            ))}
          </div>
        </div>

        {currentEx ? (
          <div className="card p-5 text-center">
            <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk mb-1">Now performing</div>
            <h2 className="font-grotesk font-bold text-2xl">{currentEx.name}</h2>
            <div className="flex items-center justify-center gap-3 mt-1.5 text-[11px] text-mute">
              <span>{currentEx.sets} × {currentEx.reps}</span><span className="text-faint">·</span><span>{currentEx.weight}</span>
            </div>

            <ExerciseAnim anim={currentEx.animation_key || 'fallback'} muscle={currentEx.primary_muscle} label="" size="lg" />

            <div className="flex items-center justify-center gap-4 mt-2">
              <Ring value={setNum} max={currentEx.sets} size={84} stroke={8} color="url(#ringGrad)"
                label={<span className="font-grotesk font-bold text-lg">{setNum}</span>}
                sub={<span className="text-[8px] text-mute">of {currentEx.sets} sets</span>} />
              <div className="text-left text-[11px] text-mute space-y-1.5">
                <label className="block">
                  <span className="text-[9px] uppercase tracking-wider text-faint font-grotesk">Actual reps</span>
                  <input type="number" min="0" max="200" className="input !py-1 !px-2 text-xs w-20 mt-0.5"
                    value={execInputs[currentEx.id]?.reps ?? (parseFloat(currentEx.reps) || 0)}
                    onChange={(e) => patchInput(currentEx.id, 'reps', e.target.value)} aria-label="Actual reps" />
                </label>
                <label className="block">
                  <span className="text-[9px] uppercase tracking-wider text-faint font-grotesk">Weight kg</span>
                  <input type="number" min="0" step="0.5" className="input !py-1 !px-2 text-xs w-20 mt-0.5"
                    value={execInputs[currentEx.id]?.weight ?? (parseFloat(currentEx.weight) || 0)}
                    onChange={(e) => patchInput(currentEx.id, 'weight', e.target.value)} aria-label="Actual weight" />
                </label>
                <label className="block">
                  <span className="text-[9px] uppercase tracking-wider text-faint font-grotesk">RIR (optional)</span>
                  <input type="number" min="0" max="5" placeholder="—" className="input !py-1 !px-2 text-xs w-20 mt-0.5"
                    value={execInputs[currentEx.id]?.rir ?? ''}
                    onChange={(e) => patchInput(currentEx.id, 'rir', e.target.value === '' ? null : e.target.value)} aria-label="Reps in reserve (optional)" />
                </label>
              </div>
            </div>
            <div className="text-[9px] text-mute mt-1.5">Rest between sets: {currentEx.rest_sec}s · adjust actual reps/weight per set before completing</div>

            <button className="btn-primary w-full !py-4 mt-5 text-sm" onClick={completeSet} disabled={submitting}>
              ✓ COMPLETE SET {setNum}/{currentEx.sets}
            </button>
          </div>
        ) : (
          <div className="card p-8 text-center">
            <div className="text-3xl mb-2">💪</div>
            <div className="font-grotesk font-bold text-lg">All sets done!</div>
            <button className="btn-primary w-full !py-4 mt-4" onClick={() => { setExProgress({}); setMode('summary'); finishWorkout(Object.fromEntries(state.map((e) => [e.id, e.sets]))); }} disabled={submitting}>
              {submitting ? 'Logging…' : 'Finish & log workout'}
            </button>
          </div>
        )}

        {/* rest timer overlay */}
        {rest && (
          <div className="fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm grid place-items-center p-6">
            <div className="card p-8 w-full max-w-xs text-center">
              <div className="text-[10px] uppercase tracking-[.2em] text-mute font-grotesk mb-3">Rest</div>
              <div className="relative w-36 h-36 mx-auto">
                <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
                  <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="7" />
                  <circle cx="50" cy="50" r="42" fill="none" stroke="#35D7FF" strokeWidth="7" strokeLinecap="round"
                    strokeDasharray={2 * Math.PI * 42}
                    strokeDashoffset={2 * Math.PI * 42 * (1 - (rest.seconds / rest.total))}
                    style={{ transition: 'stroke-dashoffset 1s linear', filter: 'drop-shadow(0 0 6px rgba(53,215,255,.5))' }} />
                </svg>
                <div className="absolute inset-0 grid place-items-center">
                  <span className="font-grotesk font-bold text-4xl tabular-nums text-cyanx">{String(Math.floor(rest.seconds / 60)).padStart(2, '0')}:{String(rest.seconds % 60).padStart(2, '0')}</span>
                </div>
              </div>
              <div className="flex items-center justify-center gap-2 mt-6">
                <button className="btn !py-2 !px-3 !text-xs" onClick={() => setRest({ ...rest, seconds: Math.max(0, rest.seconds - 30) })}>−30s</button>
                <button className="btn !py-2 !px-3 !text-xs" onClick={() => setRest({ ...rest, seconds: rest.seconds + 30 })}>+30s</button>
                <button className="btn-primary !py-2 !px-4 !text-xs" onClick={() => setRest(null)}>Skip</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ================= summary =================
  return (
    <div className="space-y-4">
      <div className="card relative overflow-hidden anim-pop">
        <div className="absolute inset-0" aria-hidden="true"><Suspense fallback={null}><TunnelBackdrop /></Suspense></div>
        <div className="absolute inset-0 bg-gradient-to-b from-bg/55 via-bg/25 to-bg/80 pointer-events-none" aria-hidden="true" />
        <div className="relative p-6 text-center">
          <div className="w-14 h-14 mx-auto rounded-full bg-good/15 border border-good/40 grid place-items-center text-2xl anim-pop">🏆</div>
          <h1 className="font-grotesk font-bold text-2xl mt-3">Workout complete</h1>
          <div className="text-xs text-mute mt-1">{workout?.name}</div>
          <div className="grid grid-cols-3 gap-2 mt-5">
            {[
              ['Duration', `${result?.durationMin || '—'} min`],
              ['Volume', result?.volume ? `${Math.round(result.volume).toLocaleString()} kg` : '—'],
              ['Exercises', result?.exercises || '—']
            ].map(([l, v]) => (
              <div key={l} className="rounded-xl bg-white/[.04] border border-line px-2 py-3">
                <div className="font-grotesk font-bold text-base">{v}</div>
                <div className="text-[8px] uppercase tracking-wider text-mute font-grotesk mt-0.5">{l}</div>
              </div>
            ))}
          </div>
          {!!result?.prs?.length && (
            <div className="mt-4 rounded-xl border border-gold/30 bg-gold/10 px-4 py-3">
              <div className="text-[10px] uppercase tracking-widest text-gold font-grotesk mb-1.5">🎉 New personal records</div>
              {result.prs.map((p) => (
                <div key={p.name + p.records?.map(r => r.type).join() || ''} className="text-sm font-grotesk">
                  <span className="font-bold">{p.name}</span>
                  {p.records?.map((r) => (
                    <span key={r.type} className="block text-xs text-ink/80 mt-0.5">
                      {r.label}: <span className="text-gold font-semibold">{r.value}{r.type === 'est_1rm' ? ' kg' : r.type === 'heaviest_weight' ? ' kg' : r.type === 'best_volume' ? ' kg' : ''}</span>
                      {r.previous !== null && <span className="text-mute"> (prev {r.previous})</span>}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}
          <button className="btn w-full mt-5" onClick={() => { setMode('browse'); setResult(null); setExProgress({}); }}>Done</button>
        </div>
      </div>
    </div>
  );
}
