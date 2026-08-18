import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { Spinner, ErrorState, Bar, Ring } from '../../components/UI.jsx';
import ExerciseAnim from '../../components/exerciseSVG.jsx';
import MuscleMap, { regionForMuscle } from '../../components/MuscleMap.jsx';
import { Pressable } from '../../design/index.js';
const TunnelBackdrop = lazy(() => import('../../components/TunnelBackdrop.jsx'));

const REGION_IDS = new Set(['chest', 'shoulders', 'biceps', 'forearms', 'core', 'quads', 'calves', 'traps', 'triceps', 'lats', 'lower_back', 'glutes', 'hamstrings']);

export default function Workout() {
  const nav = useNavigate();
  const today = useFetch(() => api('/tracking/me/today'));
  const week = useFetch(() => api('/tracking/me/week'));
  const hist = useFetch(() => api('/tracking/me/workouts'));
  const perms = useFetch(() => api('/me/permissions'));
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [muscleFilter, setMuscleFilter] = useState(null);
  const [exState, setExState] = useState(null);
  const [toast, setToast] = useState('');
  // build-my-workout — one-shot "save today's session" modal (uses /me/workouts)
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderName, setBuilderName] = useState('');
  const [builderExs, setBuilderExs] = useState([]); // {exercise_id, name, muscle, sets, reps, weight}
  const [libList, setLibList] = useState(null);
  const [libSearch, setLibSearch] = useState('');
  const [savingBuilder, setSavingBuilder] = useState(false);
  const [selectedLibEx, setSelectedLibEx] = useState(null); // exercise selected in Build Today detail view
  const [justAdded, setJustAdded] = useState(null); // exercise ID just added — triggers confirmation animation
  // personal workout planner — reusable workouts + weekly schedule (uses /me/planner)
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [planner, setPlanner] = useState(null); // { workouts, schedule }
  const [planForm, setPlanForm] = useState(null); // { id: null|workoutId, name, notes, exercises } when creating/editing
  const [savingPlan, setSavingPlan] = useState(false);
  const [mode, setMode] = useState('browse'); // browse | execute | summary
  const [result, setResult] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [starting, setStarting] = useState(false);

  // execution state
  const [startedAt, setStartedAt] = useState(0);
  /* Per-set checklist. exSets[exerciseId] = [{ reps, weight, done }, ...],
     seeded from the prescription when the session starts. This replaced the
     old exProgress/execInputs pair, which tracked only a COUNT of finished
     sets plus one shared reps/weight box -- so every set of an exercise was
     logged with identical numbers and there was no way to correct set 2
     after the fact. */
  const [exSets, setExSets] = useState({});
  const [openEx, setOpenEx] = useState(null);   // accordion: one exercise open
  const [infoEx, setInfoEx] = useState(null);   // main-page info panel
  const [burn, setBurn] = useState(null);   // skos-cal-v1 estimate + interval
  const [elapsed, setElapsed] = useState(0); // ticking elapsed seconds during execute mode
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

  // session elapsed timer — ticks every second during execute mode
  useEffect(() => {
    if (mode !== 'execute' || !startedAt) return;
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const h = setInterval(tick, 1000);
    return () => clearInterval(h);
  }, [mode, startedAt]);

  // ---- restore from started_at (refresh-while-active) ----
  useEffect(() => {
    // Only restore if: still in browse mode, workout exists, has started_at, and is NOT completed
    if (mode !== 'browse' || !workout?.started_at || workout?.status === 'completed') return;
    // Workout was already started server-side but user refreshed — restore execution state
    setExSets(buildSets(state));
    setOpenEx(state[0]?.id ?? null);
    setElapsed(0);
    // Reconstruct elapsed time from server started_at
    setStartedAt(Date.parse(workout.started_at));
    setMode('execute');
  }, [workout?.started_at]); // intentionally runs once on mount when started_at exists

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
      setToast(`${w.name} is today's session`);
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
  const totalSets = Object.values(exSets).reduce((n, rows) => n + rows.length, 0)
    || state.reduce((n, e) => n + (Number(e.sets) || 0), 0);
  const doneSets = Object.values(exSets).reduce((n, rows) => n + rows.filter((r) => r.done).length, 0);

  const startWorkout = async () => {
    if (starting) return; // prevent duplicate clicks
    setStarting(true);
    try {
      // Notify backend: workout has started (server records started_at)
      // POST /api/workouts/:id/start — no body; server is authoritative for timing.
      const res = await api(`/workouts/${workout.id}/start`, { method: 'POST' });
      // If workout was already completed, do not enter execute mode
      if (res.already_completed) {
        setStarting(false);
        today.reload();
        return;
      }
    } catch (e) {
      setStarting(false);
      setToast(e.message || 'Could not start workout');
      return;
    }
    // API succeeded — proceed with local timer/UI
    setExSets(buildSets(state));
    setOpenEx(state[0]?.id ?? null);
    setElapsed(0);
    setStartedAt(Date.now());
    setMode('execute');
    setStarting(false);
  };


  /** Seed one editable row per prescribed set. */
  const buildSets = (list) => Object.fromEntries(list.map((e) => [
    e.id,
    Array.from({ length: Math.max(1, Number(e.sets) || 1) }, () => ({
      reps: parseFloat(e.reps) || 0,
      weight: parseFloat(e.weight) || 0,
      done: false,
    })),
  ]));

  const patchSet = (exId, i, field, value) => setExSets((prev) => {
    const rows = [...(prev[exId] || [])];
    if (!rows[i]) return prev;
    rows[i] = { ...rows[i], [field]: value };
    return { ...prev, [exId]: rows };
  });

  const toggleSet = (exId, i) => setExSets((prev) => {
    const rows = [...(prev[exId] || [])];
    if (!rows[i]) return prev;
    rows[i] = { ...rows[i], done: !rows[i].done };
    const next = { ...prev, [exId]: rows };
    // Auto-advance to the next unfinished exercise once this one is fully
    // ticked, so the next thing to do is already open rather than requiring
    // a tap on a screen the user is holding at arm's length.
    if (rows.every((r) => r.done)) {
      const following = state.find((e) => {
        const rs = next[e.id] || [];
        return e.id !== exId && (rs.length === 0 || rs.some((r) => !r.done));
      });
      setOpenEx(following ? following.id : null);
    }
    return next;
  });


  // Build per-set logs from actual captured inputs (what was entered when each set was completed).
  const finishWorkout = async () => {
    setSubmitting(true);
    try {
      /* Only TICKED sets are logged, with the numbers actually typed for
         each one. The previous version logged N identical sets from a single
         shared input box, so a session where the last set dropped from 60 kg
         to 50 kg was recorded as three sets at 60 -- inflating both volume
         and the burn estimate derived from it. */
      const logs = state.map((e) => {
        const rows = (exSets[e.id] || []).filter((r) => r.done);
        if (!rows.length) return null;
        return {
          exercise_id: e.id,
          sets: rows.map((r, i) => ({
            set_number: i + 1,
            actual_reps: Number(r.reps) || 0,
            actual_weight: Number(r.weight) || 0,
          })),
        };
      }).filter(Boolean);
      if (!logs.length) {
        // The API requires at least one logged set. Ending an empty session
        // should return to browse, not surface a validation error.
        setSubmitting(false);
        setMode('browse');
        setToast('Session ended — no sets were logged');
        return;
      }
      const res = await api(`/workouts/${workout.id}/complete`, { method: 'POST', body: JSON.stringify({ logs }) });
      const volume = logs.reduce((s, l) => s + l.sets.reduce((a, st) => a + (st.actual_reps * st.actual_weight), 0), 0);
      // duration_min is server-authoritative (completed_at − started_at).
      // Fall back to local timer only if backend did not compute it.
      const durationMin = res.duration_min ?? Math.max(1, Math.round((Date.now() - startedAt) / 60000));
      setResult({ prs: res.prs || [], volume, durationMin, exercises: state.length, calorie: res.calorie || null });
      setMode('summary');

      /* Calorie burn (skos-cal-v1). Deliberately AFTER setMode:
         the summary must render immediately on a finished session, so this
         is a progressive enhancement rather than something the user waits
         on. A failure here leaves `burn` null and the summary simply omits
         the figure -- it never blocks or errors the completion itself,
         which is already saved server-side by this point. */
      /* NOTE the prefix: the intelligence router is mounted at `/api/intel`
         in backend/src/index.js, NOT `/api/intelligence`. This originally
         called `/intelligence/workout-burn`, which 404s -- and because the
         burn fetch is deliberately fire-and-forget so it can never break a
         completed session, the failure was SILENT: the summary simply never
         showed a calorie figure and nothing surfaced to say why. */
      api('/intel/workout-burn', {
        method: 'POST',
        body: JSON.stringify({
          duration_minutes: durationMin,
          exercises: logs.map((l) => ({
            name: (state.find((e) => e.id === l.exercise_id) || {}).name,
            sets: l.sets.map((st) => ({
              actual_reps: st.actual_reps,
              actual_weight: st.actual_weight,
              completed: 1,
            })),
          })),
        }),
      })
        .then(setBurn)
        .catch(() => setBurn(null));   // 422 = model declined; show nothing
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
      <div className="space-y-5 pb-2">

        {/* ── 1. THIS WEEK ── */}
        {weekRows.length > 0 && (
          <div className="card p-4 anim-fadeUp" style={{ animationDelay: '0ms' }}>
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
                    className={`rounded-xl border px-1 py-2 text-center transition-all active:scale-95 ${isToday ? 'border-gold/60 bg-gold/10 shadow-lg shadow-ember/10' : isRest ? 'border-line bg-white/[.02] opacity-60' : 'border-line bg-white/[.02] hover:bg-white/[.05]'}`}>
                    <div className={`text-[8px] uppercase tracking-wider font-grotesk ${isToday ? 'text-gold' : 'text-mute'}`}>{d.label}</div>
                    <div className={`text-[9px] font-grotesk font-semibold mt-0.5 leading-tight truncate ${isToday ? 'text-gold' : isRest ? 'text-faint' : 'text-ink'}`}>
                      {isRest ? 'Rest' : d.name.split(' ').slice(0, 2).join(' ')}
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="text-[10px] text-faint mt-2.5">Tap a day to preview its session.</div>
          </div>
        )}

        {/* ── 2. MY WORKOUT — 3 action cards ── */}
        <div className="anim-fadeUp" style={{ animationDelay: '60ms' }}>
          <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk mb-2.5">My workout</div>
          <div className="grid grid-cols-3 gap-2.5">
            {/* My Workouts (planner) */}
            <button onClick={openPlanner}
              className="card card-hover p-4 flex flex-col items-center gap-2.5 text-center active:scale-[.97] transition-all">
              <div className="w-11 h-11 rounded-2xl bg-gold/10 border border-gold/25 grid place-items-center" style={{ color: 'var(--accent)' }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/></svg></div>
              <span className="font-grotesk text-[11px] font-semibold leading-tight">My<br/>Workout</span>
            </button>
            {/* Build Today */}
            <button onClick={() => {
              if (!libList) api('/workouts/exercises').then((r) => setLibList(r.exercises || [])).catch(() => setToast('Could not load the exercise library'));
              setSelectedLibEx(null);
              setBuilderOpen(true);
            }}
              className="card card-hover p-4 flex flex-col items-center gap-2.5 text-center active:scale-[.97] transition-all">
              <div className="w-11 h-11 rounded-2xl bg-ember/10 border border-ember/25 grid place-items-center" style={{ color: 'var(--accent)' }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></div>
              <span className="font-grotesk text-[11px] font-semibold leading-tight">Build<br/>Today</span>
            </button>
            {/* My PR */}
            <button onClick={() => nav('/app/client/progress')}
              className="card card-hover p-4 flex flex-col items-center gap-2.5 text-center active:scale-[.97] transition-all">
              <div className="w-11 h-11 rounded-2xl bg-good/10 border border-good/25 grid place-items-center" style={{ color: 'var(--good)' }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9a6 6 0 0 0 12 0V4H6zM9 21h6M12 15v6"/></svg></div>
              <span className="font-grotesk text-[11px] font-semibold leading-tight">My<br/>PR</span>
            </button>
          </div>
          {locked && (
            <div className="text-[10px] text-faint mt-2 font-grotesk">Your gym has locked workout creation — follow your coach's plan.</div>
          )}
        </div>

        {/* ── 3. TODAY'S TRAINING ── */}
        {workout ? (
          <div className="anim-fadeUp" style={{ animationDelay: '120ms' }}>
            <div className="flex items-start justify-between gap-3 mb-2">
              <div>
                <div className="kicker">Today's training</div>
                <h1 className="font-grotesk font-bold text-2xl leading-tight">{workout.name}</h1>
              </div>
              <button data-start-workout className="btn-primary shrink-0 !px-4 !py-2.5 !text-xs active:scale-95" onClick={startWorkout} disabled={!exercises.length || starting}>
                {starting ? 'Starting…' : 'START SESSION'}
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2.5 mt-3">
              {[
                /* "Est. burn" removed. It was a static number attached to the
                   PLAN, computed before a single set was lifted, so it could
                   not reflect what the user actually did -- and it sat next
                   to two counts that are facts, which lent it credibility it
                   had not earned. The real figure now comes from skos-cal-v1
                   AFTER the session, as a range, on the summary screen.
                   Estimated duration replaces it: also a prediction, but an
                   honest one, and the thing a user actually plans around. */
                ['Exercises', meta.exerciseCount || exercises.length],
                ['Total sets', meta.totalSets || exercises.reduce((s, e) => s + (e.sets || 0), 0)],
                ['Approx. time', meta.estMinutes ? `${meta.estMinutes} min` : '—']
              ].map(([l, v]) => (
                <div key={l} className="card !p-3 text-center">
                  <div className="font-grotesk font-bold text-lg">{v}</div>
                  <div className="text-[9px] uppercase tracking-wider text-mute font-grotesk mt-0.5">{l}</div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="card p-10 text-center anim-fadeUp" style={{ animationDelay: '120ms' }}>
            
            <div className="font-grotesk font-bold text-lg">Rest day</div>
            <div className="text-xs text-mute mt-1.5 max-w-xs mx-auto">No session scheduled for today. Recovery is training too — fuel well and sleep 8 hours.</div>
            <div className="mt-4 text-[10px] uppercase tracking-widest text-gold font-grotesk">Next session appears here tomorrow</div>
          </div>
        )}

        {/* ── 4. TODAY'S EXERCISES ── */}
        {state.length > 0 && (
          <div className="anim-fadeUp" style={{ animationDelay: '180ms' }}>
            <div className="kicker">Today's exercises</div>
            <div className="space-y-2">
              {state.map((ex, i) => (
                /* The tick used to live here. It was the WRONG place for it:
                   marking an exercise done from the plan screen records no
                   reps, no weight and no sets -- it just greys the row out,
                   while the real logging happens in the session. Two ways to
                   "complete" an exercise, only one of which produces data,
                   is a trap. Completion now belongs to the session; this
                   screen answers "what am I doing, and how?" instead. */
                <div key={ex.id}
                  className="card anim-fadeUp transition-colors duration-200"
                  style={{ animationDelay: `${200 + i * 40}ms` }}>
                  <div className="p-3.5 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold truncate" style={{ color: 'var(--ink)' }}>{ex.name}</span>
                        {equipMap[ex.id]?.missing?.length > 0 && (
                          <span className="chip border-warn/40 text-warn bg-warn/10 !px-1.5 !py-0 text-[9px] shrink-0" title={`Needs: ${equipMap[ex.id].required.join(', ')}`}>⚠ equipment</span>
                        )}
                      </div>
                      <div className="text-[11px] mt-0.5" style={{ color: 'var(--mute)' }}>
                        {ex.sets} sets · {ex.reps} reps{ex.weight ? ` · ${ex.weight}` : ''}
                      </div>
                    </div>
                    <button
                      aria-label={`About ${ex.name}`}
                      aria-expanded={infoEx === ex.id}
                      onClick={() => setInfoEx(infoEx === ex.id ? null : ex.id)}
                      className="w-8 h-8 rounded-full border grid place-items-center shrink-0 transition-all active:scale-90"
                      style={infoEx === ex.id
                        ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' }
                        : { borderColor: 'var(--line)', color: 'var(--mute)' }}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                           strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" />
                      </svg>
                    </button>
                  </div>

                  {infoEx === ex.id && (
                    <div className="px-3.5 pb-3.5 -mt-1 space-y-2">
                      <div className="h-px" style={{ background: 'var(--line)' }} />
                      <div className="flex flex-wrap gap-1.5 pt-0.5">
                        {[ex.primary_muscle, ex.equipment, ex.difficulty]
                          .filter(Boolean)
                          .map((t) => (
                            <span key={t} className="text-[9px] uppercase tracking-[.1em] px-1.5 py-0.5 rounded"
                                  style={{ color: 'var(--mute)', border: '1px solid var(--line)' }}>
                              {String(t).replace(/_/g, ' ')}
                            </span>
                          ))}
                      </div>
                      {/* Coaching cues come from the exercise library and are
                          already in this payload -- no extra request. Falls
                          back to a truthful line rather than inventing form
                          advice, which would be worse than saying nothing. */}
                      <p className="text-[11px] leading-relaxed" style={{ color: 'var(--mute)' }}>
                        {ex.cues || ex.notes
                          || `${ex.sets} sets of ${ex.reps} reps${ex.rest_sec ? `, about ${ex.rest_sec}s rest between sets` : ''}. Your coach has not added form notes for this one yet.`}
                      </p>
                      {ex.secondary_muscles && (
                        <p className="text-[10px]" style={{ color: 'var(--faint)' }}>
                          Also works: {String(ex.secondary_muscles).replace(/_/g, ' ')}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── 5. RECENT SESSIONS ── */}
        {!!hist.data?.workouts?.length && (
          <div className="card p-4 anim-fadeUp" style={{ animationDelay: '260ms' }}>
            <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk mb-2.5">Recent sessions</div>
            <div className="space-y-1.5">
              {hist.data.workouts.filter((w) => w.id !== workout?.id).slice(0, 5).map((w) => (
                <div key={w.id} className="flex items-center justify-between text-xs border-b border-line/50 last:border-0 py-2">
                  <span className="font-grotesk font-semibold truncate">{w.name}</span>
                  <span className="text-mute shrink-0 ml-2">{w.scheduled_date}</span>
                  <span className={`chip border shrink-0 ml-2 ${w.status === 'completed' ? 'text-good border-good/40 bg-good/10' : 'text-warn border-warn/40 bg-warn/10'}`}>{w.status === 'completed' ? 'DONE' : w.status.toUpperCase()}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ═══════════ BUILD TODAY MODAL ═══════════ */}
        {builderOpen && (
          <div className="fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm grid place-items-center p-4 anim-fadeIn">
            <div className="card w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden anim-scaleIn">
              <div className="p-4 border-b border-line/60 flex items-center justify-between">
                <div>
                  <div className="font-grotesk font-bold">Build my workout</div>
                  <div className="text-[10px] text-mute">Picks any exercises — saves as today's session</div>
                </div>
                <button className="text-mute hover:text-ink text-lg active:scale-90" onClick={() => { setBuilderOpen(false); setSelectedLibEx(null); setJustAdded(null); }} aria-label="Close">✕</button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                <input className="input" placeholder="Workout name (e.g. My Upper Day)" value={builderName} onChange={(e) => setBuilderName(e.target.value)} />

                {/* ── keyed wrapper for smooth content transitions ── */}
                <div key={selectedLibEx?.id || '__library__'} className="anim-slideUp">
                {selectedLibEx ? (
                  /* ── exercise detail view with animation + muscle map ── */
                  <div className="space-y-3">
                    <button onClick={() => setSelectedLibEx(null)} className="btn !text-xs !py-1.5 active:scale-95">← Back to library</button>

                    <div className="anim-slideUp" style={{ animationDelay: '50ms' }}>
                      <ExerciseAnim anim={selectedLibEx.animation_key || 'fallback'} muscle={selectedLibEx.primary_muscle} label="" />
                    </div>

                    <div className="anim-slideUp" style={{ animationDelay: '100ms' }}>
                      <div className="font-grotesk font-bold text-lg">{selectedLibEx.name}</div>
                      <div className="flex items-center gap-2 text-[11px] text-mute flex-wrap mt-1">
                        {selectedLibEx.primary_muscle && <span className="chip border-line !px-1.5 !py-0 text-[9px]">{selectedLibEx.primary_muscle}</span>}
                        {selectedLibEx.secondary_muscles && <span className="chip border-line !px-1.5 !py-0 text-[9px]">{selectedLibEx.secondary_muscles}</span>}
                        {selectedLibEx.equipment && <span className="chip border-line !px-1.5 !py-0 text-[9px]">{selectedLibEx.equipment}</span>}
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2 anim-slideUp" style={{ animationDelay: '150ms' }}>
                      {[
                        ['Primary', selectedLibEx.primary_muscle || '—'],
                        ['Secondary', (selectedLibEx.secondary_muscles || '—').replace(/,/g, ' · ')],
                        ['Equipment', selectedLibEx.equipment || '—']
                      ].map(([l, v]) => (
                        <div key={l} className="rounded-xl bg-white/[.03] border border-line px-2 py-2 text-center">
                          <div className="text-[8px] uppercase tracking-wider text-mute font-grotesk">{l}</div>
                          <div className="text-[10px] font-grotesk font-semibold mt-0.5 leading-tight">{v}</div>
                        </div>
                      ))}
                    </div>

                    {selectedLibEx.cues && (
                      <div className="rounded-xl border border-gold/25 bg-gold/5 px-3 py-2.5 text-[11px] leading-relaxed anim-slideUp" style={{ animationDelay: '200ms' }}>
                        <span className="text-gold font-grotesk font-semibold mr-1.5">FORM CUE</span>{selectedLibEx.cues}
                      </div>
                    )}

                    {/* Muscle map for selected exercise */}
                    <div className="card p-3 flex justify-center anim-slideUp" style={{ animationDelay: '250ms' }}>
                      <MuscleMap
                        activeMuscles={[selectedLibEx.primary_muscle]}
                        selected={selectedLibEx.primary_muscle}
                        size={140}
                      />
                    </div>

                    <div className="anim-slideUp" style={{ animationDelay: '300ms' }}>
                      <button className={`btn-primary w-full active:scale-[.97] ${justAdded === selectedLibEx.id ? 'anim-confirmPulse' : ''}`}
                        disabled={builderExs.some((b) => b.exercise_id === selectedLibEx.id)}
                        onClick={() => {
                          setJustAdded(selectedLibEx.id);
                          setTimeout(() => setJustAdded(null), 500);
                          setBuilderExs((b) => [...b, { exercise_id: selectedLibEx.id, name: selectedLibEx.name, muscle: selectedLibEx.primary_muscle, sets: 3, reps: '10', weight: 'BW' }]);
                          setTimeout(() => setSelectedLibEx(null), 350);
                        }}>
                        {builderExs.some((b) => b.exercise_id === selectedLibEx.id) ? 'Already added ✓' : '+ Add to today\'s workout'}
                      </button>
                    </div>
                  </div>
                ) : (
                  /* ── search + exercise library list ── */
                  <div className="space-y-2.5">
                    <input className="input" placeholder="Search exercises by name or muscle…" value={libSearch} onChange={(e) => setLibSearch(e.target.value)} />
                    <div className="space-y-1.5">
                    {(libList || []).filter((x) => !libSearch || (x.name + ' ' + (x.primary_muscle || '')).toLowerCase().includes(libSearch.toLowerCase())).slice(0, 30).map((x, i) => {
                      const added = builderExs.some((b) => b.exercise_id === x.id);
                      return (
                        <button key={x.id}
                          className={`w-full flex items-center gap-2 rounded-xl border bg-white/[.02] px-3 py-2.5 text-left transition-all active:scale-[.98] anim-fadeUp ${added ? 'border-line/40 opacity-50' : 'border-line hover:border-gold/30'}`}
                          style={{ animationDelay: `${40 + i * 25}ms` }}
                          onClick={() => setSelectedLibEx(x)}>
                          <span className="flex-1 min-w-0">
                            <span className="block text-[13px] font-grotesk font-semibold truncate">{x.name}</span>
                            <span className="text-[10px] text-mute">{x.primary_muscle || ''}{x.equipment ? ` · ${x.equipment}` : ''}</span>
                          </span>
                          {added && <span className="text-[10px] text-good shrink-0 anim-checkBounce">✓</span>}
                        </button>
                      );
                    })}
                    </div>
                  </div>
                )}
                </div>

                {/* ── MY SESSION — exercises added ── */}
                {!!builderExs.length && (
                  <div className="space-y-2 pt-1">
                    <div className="text-[10px] text-faint font-grotesk uppercase tracking-wider">MY SESSION</div>
                    {builderExs.map((b, i) => (
                      <div key={b.exercise_id} className="rounded-xl border border-gold/25 bg-gold/5 p-3 anim-slideUp">
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="font-grotesk text-[13px] font-semibold truncate">{i + 1}. {b.name}</span>
                          <button className="text-[10px] text-bad/80 hover:text-bad shrink-0 active:scale-90" onClick={() => setBuilderExs((x) => x.filter((_, j) => j !== i))}>Remove</button>
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
                <button className="btn-primary w-full active:scale-[.97]"
                  disabled={savingBuilder || !builderName.trim() || !builderExs.length}
                  onClick={async () => {
                    setSavingBuilder(true);
                    try {
                      await api('/me/workouts', { method: 'POST', body: JSON.stringify({ name: builderName, exercises: builderExs.map((b) => ({ exercise_id: b.exercise_id, sets: b.sets, reps: b.reps, weight: b.weight })) }) });
                      setBuilderOpen(false); setBuilderName(''); setBuilderExs([]); setSelectedLibEx(null); setJustAdded(null);
                      setToast('Your workout is scheduled for today');
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

        {/* ═══════════ PERSONAL WORKOUT PLANNER MODAL ═══════════ */}
        {plannerOpen && (
          <div className="fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm grid place-items-center p-4 anim-fadeIn">
            <div className="card w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden anim-scaleIn">
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

        {/* ═══════════ THIS-WEEK DAY PREVIEW MODAL ═══════════ */}
        {weekDay && (
          <div className="fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm grid place-items-center p-4 anim-fadeIn" role="dialog" aria-modal="true" aria-label={`${weekDay.label} — ${weekDay.name}`}>
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
                    </div>
                    <div className="text-[11px] text-mute mt-1">{ex.sets} × {ex.reps} · {ex.weight}</div>
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

        {toast && <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-full bg-panel border border-gold/40 font-grotesk text-xs shadow-card">{toast}</div>}
      </div>
    );
  }

  // ================= execute mode =================
  if (mode === 'execute') {
    /* EXECUTE MODE — one session clock, one checklist.
       Rebuilt to the brief: no per-set timer and no rest countdown, a single
       elapsed clock from START to END, every exercise for the day visible at
       once, each expanding into editable sets that get ticked off. */
    const pct = totalSets ? Math.round((doneSets / totalSets) * 100) : 0;

    return (
      <div className="space-y-3 pb-28">

        {/* ── the ONE session clock ── */}
        <div className="card p-4 sticky top-2 z-20">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-[.18em]" style={{ color: 'var(--faint)' }}>Session</div>
              <div className="font-black tabular-nums leading-none mt-1" style={{ fontSize: 30, color: 'var(--ink)' }}>
                {String(Math.floor(elapsed / 60)).padStart(2, '0')}:{String(elapsed % 60).padStart(2, '0')}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-[.18em]" style={{ color: 'var(--faint)' }}>Sets done</div>
              <div className="font-black tabular-nums leading-none mt-1" style={{ fontSize: 22, color: 'var(--accent)' }}>
                {doneSets}<span className="text-[13px]" style={{ color: 'var(--mute)' }}>/{totalSets}</span>
              </div>
            </div>
          </div>
          <div className="h-1.5 rounded-full overflow-hidden mt-3" style={{ background: 'var(--line)' }}>
            <div className="h-full rounded-full transition-all duration-500"
                 style={{ width: `${pct}%`, background: 'var(--accent-grad)' }} />
          </div>
        </div>

        {/* ── every exercise for today; tap to expand ── */}
        {state.map((ex) => {
          const sets = exSets[ex.id] || [];
          const doneCount = sets.filter((x) => x.done).length;
          const complete = sets.length > 0 && doneCount === sets.length;
          const open = openEx === ex.id;
          return (
            <div key={ex.id} className="card overflow-hidden transition-colors duration-300"
                 style={complete ? {
                   /* Completed exercises go green, tinted from the status
                      token so it holds in both themes.

                      backgroundColor, NOT the `background` shorthand: a
                      shorthand containing var() becomes a pending
                      substitution, which left .card's own
                      `background-color: var(--panel)` winning and the card
                      stubbornly grey. The longhand applies cleanly. */
                   backgroundColor: 'rgb(var(--good-rgb) / .10)',
                   borderColor: 'rgb(var(--good-rgb) / .45)',
                 } : undefined}>
              <button
                onClick={() => setOpenEx(open ? null : ex.id)}
                className="w-full flex items-center gap-3 p-3.5 text-left"
                aria-expanded={open}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-[14px] truncate" style={{ color: 'var(--ink)' }}>{ex.name}</span>
                    {complete && (
                      <span className="text-[9px] font-bold uppercase tracking-[.12em] px-1.5 py-0.5 rounded shrink-0"
                            style={{ color: 'var(--good)', border: '1px solid rgb(var(--good-rgb) / .5)' }}>
                        Completed
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] mt-0.5" style={{ color: 'var(--mute)' }}>
                    {doneCount}/{sets.length} sets{ex.reps ? ` · ${ex.reps} reps` : ''}
                  </div>
                </div>
                <span className="text-[15px] leading-none shrink-0" style={{ color: 'var(--faint)' }}>
                  {open ? '−' : '+'}
                </span>
              </button>

              {open && (
                <div className="px-3.5 pb-3.5 space-y-1.5">
                  <div className="grid grid-cols-[26px_1fr_1fr_38px] gap-2 px-1 text-[9px] uppercase tracking-[.12em]"
                       style={{ color: 'var(--faint)' }}>
                    <span>Set</span><span>Reps</span><span>Kg</span><span className="text-right">Done</span>
                  </div>
                  {sets.map((st, i) => (
                    <div key={i}
                         className="grid grid-cols-[26px_1fr_1fr_38px] gap-2 items-center rounded-lg px-1 py-1"
                         style={st.done ? { backgroundColor: 'rgb(var(--good-rgb) / .08)' } : undefined}>
                      <span className="text-[12px] tabular-nums" style={{ color: 'var(--mute)' }}>{i + 1}</span>
                      {/* Editable mid-workout: what was prescribed and what
                          actually got lifted routinely differ, and the logged
                          number has to be the real one. */}
                      <input type="number" inputMode="numeric" className="input !py-1.5 !text-[13px] tabular-nums"
                             value={st.reps} aria-label={`Set ${i + 1} reps`}
                             onChange={(e) => patchSet(ex.id, i, 'reps', e.target.value)} />
                      <input type="number" inputMode="decimal" step="0.5" className="input !py-1.5 !text-[13px] tabular-nums"
                             value={st.weight} aria-label={`Set ${i + 1} weight in kg`}
                             onChange={(e) => patchSet(ex.id, i, 'weight', e.target.value)} />
                      <button
                        onClick={() => toggleSet(ex.id, i)}
                        aria-label={`Mark set ${i + 1} ${st.done ? 'not done' : 'done'}`}
                        aria-pressed={st.done}
                        className="justify-self-end w-7 h-7 rounded-lg border grid place-items-center transition-all active:scale-90"
                        style={st.done
                          ? { backgroundColor: 'var(--good)', borderColor: 'var(--good)', color: 'var(--bg)' }
                          : { borderColor: 'var(--line)', color: 'var(--faint)' }}>
                        {st.done && (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                               strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M20 6 9 17l-5-5" />
                          </svg>
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {/* ── END SESSION ── */}
        <div className="fixed inset-x-0 bottom-0 z-30 px-4 pb-4 pt-3"
             style={{ background: 'linear-gradient(to top, var(--bg) 65%, transparent)' }}>
          <Pressable
            onClick={() => finishWorkout()}
            disabled={submitting}
            className="btn-primary w-full !py-4 text-[13px] font-bold tracking-[.02em]">
            {submitting ? 'Saving…' : doneSets === 0 ? 'End session' : `End session · ${doneSets} sets`}
          </Pressable>
        </div>

      </div>
    );
  }


  // ================= summary =================
  return (
    <div className="space-y-4">
      <div className="card relative overflow-hidden anim-pop">
        <div className="absolute inset-0" aria-hidden="true"><Suspense fallback={null}><TunnelBackdrop /></Suspense></div>
        {/* Scrim over the 3D.

            The previous one was `from-bg/55 via-bg/25 to-bg/80` -- a vertical
            fade whose WEAKEST point (25%) sat exactly in the middle, which is
            precisely where the heading and the stat tiles are. So the type
            was fighting the busiest, brightest part of the animation with the
            least protection, and in light mode a pale veil over a bright
            scene washed the text out almost completely.

            Now radial and centred: densest behind the content, thinning
            toward the corners so the 3D still reads as depth at the edges
            instead of being flatly covered. `--bg-rgb` means one rule serves
            both themes -- it veils toward peach in light and charcoal in
            dark, rather than always darkening.

            The blur is doing real work: softening high-frequency detail
            behind text is what makes it legible without needing a heavier,
            duller veil. */}
        <div className="absolute inset-0 pointer-events-none" aria-hidden="true"
             style={{
               background: 'radial-gradient(130% 95% at 50% 42%, rgb(var(--bg-rgb) / .93) 0%, rgb(var(--bg-rgb) / .82) 42%, rgb(var(--bg-rgb) / .55) 100%)',
               backdropFilter: 'blur(3px)',
               WebkitBackdropFilter: 'blur(3px)',
             }} />
        <div className="relative p-6 text-center">
          <div className="w-12 h-12 mx-auto rounded-full grid place-items-center anim-pop"
               style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent)' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)"
                 strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </div>
          <h1 className="font-grotesk font-bold text-2xl mt-3">Workout complete</h1>
          <div className="text-xs text-mute mt-1">{workout?.name}</div>
          <div className="grid grid-cols-3 gap-2 mt-5">
            {[
              ['Duration', result?.durationMin != null ? `${result.durationMin} min` : '—'],
              ['Volume', result?.volume ? `${Math.round(result.volume).toLocaleString()} kg` : '—'],
              ['Exercises', result?.exercises || '—']
            ].map(([l, v]) => (
              <div key={l} className="rounded-xl px-2 py-3"
                   style={{
                     /* Was bg-white/[.04]: a white wash, which on the peach
                        light theme reads as a grey smudge and gives the text
                        almost no separation from the animation behind it.
                        A panel-tinted tile with a real border sits correctly
                        on both grounds. */
                     background: 'rgb(var(--panel-rgb) / .72)',
                     border: '1px solid var(--line)',
                   }}>
                <div className="font-black text-base tabular-nums" style={{ color: 'var(--ink)' }}>{v}</div>
                <div className="text-[8px] uppercase tracking-[.14em] mt-0.5" style={{ color: 'var(--faint)' }}>{l}</div>
              </div>
            ))}
          </div>
          {/* Calorie burn. Shown as a RANGE, not a single figure.
              skos-cal-v1's interval is genuinely about +-70% of its point
              estimate, so "597 kcal" would claim a precision the model
              explicitly does not have. The range is the honest headline;
              the point estimate is the smaller number inside it. */}
          {burn && (
            <div className="mt-4 rounded-xl border px-4 py-3 text-left"
                 style={{ borderColor: 'var(--line)', background: 'var(--accent-soft)' }}>
              <div className="flex items-baseline justify-between gap-3">
                <div className="text-[10px] uppercase tracking-[.16em]" style={{ color: 'var(--faint)' }}>
                  Calories burned
                </div>
                <div className="text-[9px]" style={{ color: 'var(--faint)' }}>
                  {burn.model_version}
                </div>
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="font-black text-[24px] tabular-nums tracking-[-.02em]"
                      style={{ color: 'var(--ink)' }}>
                  {burn.lower_kcal}–{burn.upper_kcal}
                </span>
                <span className="text-[12px]" style={{ color: 'var(--mute)' }}>kcal</span>
              </div>
              <div className="mt-0.5 text-[11px]" style={{ color: 'var(--mute)' }}>
                best estimate ≈{burn.kcal} kcal
              </div>
              {/* The model's own caveats, surfaced rather than swallowed. An
                  estimate it has flagged as shaky must not read as clean. */}
              {!!burn.notes?.length && (
                <ul className="mt-2 space-y-1">
                  {burn.notes.map((n) => (
                    <li key={n} className="text-[10px] leading-snug" style={{ color: 'var(--faint)' }}>
                      {n}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {!!result?.prs?.length && (
            <div className="mt-4 rounded-xl border border-gold/30 bg-gold/10 px-4 py-3">
              <div className="text-[10px] uppercase tracking-widest text-gold font-grotesk mb-1.5">New personal records</div>
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
          {/* The legacy calorie block was here. Removed: it duplicated the
              skos-cal-v1 range shown above with a bare point estimate plus a
              "provider: ..." debug line, so the same session reported two
              different-looking calorie figures a few pixels apart. One
              honest range beats two numbers that disagree. */}

          <button className="btn w-full mt-5" onClick={() => { setMode('browse'); setResult(null); setExProgress({}); setSetLog({}); setElapsed(0); }}>Done</button>
        </div>
      </div>
    </div>
  );
}
