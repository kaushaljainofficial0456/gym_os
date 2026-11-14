import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch, exerciseLabel } from '../../utils.js';
import { ErrorState, CheckIcon, Sheet, useConfirm } from '../../components/UI.jsx';
import { SessionRow } from './SessionHistory.jsx';
import ExerciseAnim from '../../components/exerciseSVG.jsx';
import { Pressable } from '../../design/index.js';
import {
  Activity, Bookmark, Check, ChevronLeft, HeartPulse, History, Info, ListPlus, Play, Plus, Trophy, X,
} from 'lucide-react';
import ShareWorkoutSheet from '../../components/workout/ShareWorkoutSheet.jsx';
import { TodayHero, WeekStrip, ToolGrid, PlanList, SectionLink, planWeight } from '../../components/workout/TodayView.jsx';
import { PlayerHeader, ExerciseCard, SortableExercises } from '../../components/workout/SessionView.jsx';
import WorkoutBuilder, { dayList, plannerToday } from '../../components/workout/WorkoutBuilder.jsx';
import SavedWorkouts from '../../components/workout/SavedWorkouts.jsx';
import ExerciseSearchList from '../../components/workout/ExerciseSearchList.jsx';
import { moveItem } from '../../components/workout/useDragSort.js';
import {
  groupMembers, groupsAfterMove, groupsFromExercises, insertDropSet, isLinked, normalizeGroups, sessionNote, toggleLink,
} from '../../components/workout/supersets.js';
import CardioLive, { CardioParamsForm } from '../../components/workout/CardioLive.jsx';
import '../../components/workout/workout.css';
import SessionRecap from '../../components/workout/SessionRecap.jsx';
import InfoDot from '../../components/InfoDot.jsx';
import ShareToCommunitiesSheet from '../../components/community/friend/ShareToCommunitiesSheet.jsx';
import { burnSourceLabel, isWearableSource } from '../../healthProviderLabels.js';
import LogPastWorkout from './LogPastWorkout.jsx';
import LogPastCardio from './LogPastCardio.jsx';
import { useUnits } from '../../unitsContext.jsx';
import {
  ACTIVITIES, activityName, activityFields, metFor,
} from '../../cardioActivities.js';


/**
 * Seed one editable row per prescribed set.
 *
 * Module scope, not a const inside the component: as a `const` arrow it
 * sat below the effect that restores an in-progress session, and a
 * `const` is in the temporal dead zone until its line executes -- so the
 * restore path threw "Cannot access 'buildSets' before initialization"
 * and the whole Workout page rendered blank. It closes over no state, so
 * there is no reason for it to live inside the component at all.
 */
/**
 * Rebuild the set checklist when a session is resumed.
 *
 * `fresh` is the plan (prescribed count, prescribed reps/weight), `draft`
 * is what was ticked and typed before the page went away.
 *
 * THE COUNT IS THE LARGER OF THE TWO, and that is the whole point. This
 * used to map over the PLAN's rows only, so sets the user added during
 * the session with "+ Add Set" -- which are saved into the draft like
 * everything else -- were silently dropped the moment the tab reloaded,
 * the phone locked, or they switched away and back. A fourth and fifth
 * set became three again, with the work logged into them gone. Reported
 * from the product as sets not increasing during a workout, while the
 * same thing worked in Log Past, which has no resume path to lose them.
 *
 * Taking the max keeps both halves honest: a plan edited to add sets
 * still grows, and sets the user added still survive.
 */
export function mergeDraftSets(fresh, draft) {
  return Object.fromEntries(Object.entries(fresh || {}).map(([exId, rows]) => {
    const saved = Array.isArray(draft?.[exId]) ? draft[exId] : [];
    const count = Math.max(rows.length, saved.length);
    const template = rows[rows.length - 1] || { reps: 0, weight: 0, done: false };
    const out = [];
    for (let i = 0; i < count; i += 1) {
      // Beyond the plan, a row carries the prescription's own numbers as
      // its starting point -- the same thing addSet() does live.
      const base = rows[i] || { ...template, done: false };
      out.push(saved[i] ? { ...base, ...saved[i] } : base);
    }
    return [exId, out];
  }));
}

/**
 * The session's exercises as the user left them: removed ones out, the
 * rest in the order they were dragged into. An exercise the saved order
 * does not know (added after it was saved) keeps its place at the end.
 */
export function sessionLayout(exercises, draft) {
  const removed = new Set(Array.isArray(draft?.__removed) ? draft.__removed : []);
  const pos = new Map((Array.isArray(draft?.__order) ? draft.__order : []).map((id, i) => [id, i]));
  return (exercises || [])
    .filter((e) => !removed.has(e.id))
    .map((e, i) => ({ e, k: pos.has(e.id) ? pos.get(e.id) : 1e6 + i }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.e);
}

function buildSets(list) {
  return Object.fromEntries((list || []).map((e) => [
    e.id,
    Array.from({ length: Math.max(1, Number(e.sets) || 1) }, () => ({
      reps: parseFloat(e.reps) || 0,
      weight: parseFloat(e.weight) || 0,
      done: false,
    })),
  ]));
}

/* ── localStorage active-session marker ──────────────────────────────

   The server's `started_at` can survive after a workout is completed or
   abandoned, so it must NOT be the sole evidence that this browser has
   an active session. A per-workout marker in localStorage is the local
   proof-of-life: it is created when the user starts a session and
   removed when they finish or dismiss it. */
const ACTIVE_SESSION_KEY = 'activeWorkoutSession';

function saveActiveSession(workoutId, startedAt) {
  try {
    localStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify({ workoutId, startedAt }));
  } catch { /* localStorage full or blocked — non-fatal */ }
}

function getActiveSession() {
  try {
    const raw = localStorage.getItem(ACTIVE_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.workoutId || !parsed.startedAt) return null;
    return parsed;
  } catch { return null; }
}

function clearActiveSession() {
  try {
    localStorage.removeItem(ACTIVE_SESSION_KEY);
  } catch { /* non-fatal */ }
}

/* ── Cardio helpers ───────────────────────────────────────────────
   MET values for common cardio exercises at different intensities.
   Used for client-side calorie estimation: kcal = MET × 3.5 × weight_kg / 200 × duration_min
   Based on Compendium of Physical Activities (Ainsworth et al.). */
/* The MET table, the parameter config and the effort heuristic that used
   to live here now come from src/cardioActivities.js.

   The heuristic was the reason: it summed incline, speed and resistance
   into one "effort score" and compared it to two magic thresholds, so a
   2% incline scored the same as a resistance level of 2, and walking at
   7 km/h and running at 7 km/h -- different activities -- came out
   identical. Walking, running and inclines now use the published ACSM
   metabolic equations, which respond continuously to real inputs;
   everything else uses Compendium MET values, because for badminton
   there is no equation to apply and inventing one would be less
   accurate, not more. Sharing the module is also what lets the
   past-workout logger offer the same activities. */



const cardioName = activityName;
const cardioExerciseConfig = activityFields;

/** Format a cardio item's parameters as a summary string. */
function cardioSummary(item) {
  const params = item?.segments?.length ? item.segments[item.segments.length - 1]?.params : item?.params;
  const parts = [];
  if (params?.incline) parts.push(`Incline ${params.incline}%`);
  if (params?.speed) parts.push(`${params.speed} km/h`);
  if (params?.resistance) parts.push(`Res ${params.resistance}`);
  if (params?.level) parts.push(`Level ${params.level}`);
  if (params?.distance) parts.push(`${params.distance} km`);
  if (params?.pace) parts.push(params.pace);
  return parts.join(' · ') || '';
}

/** Format params for a segment (used in segment breakdowns). */
function segmentParamsSummary(params) {
  if (!params) return '';
  const parts = [];
  if (params.incline) parts.push(`Incline ${params.incline}%`);
  if (params.speed) parts.push(`${params.speed} km/h`);
  if (params.resistance) parts.push(`Res ${params.resistance}`);
  if (params.level) parts.push(`Level ${params.level}`);
  if (params.distance) parts.push(`${params.distance} km`);
  if (params.pace) parts.push(params.pace);
  return parts.join(' · ') || '';
}


/** Calculate total calories for a completed cardio item from its segments.
    Each segment uses its own params + duration for calorie calc.
    The item must have segments[] with { durationSec, params }. */
function calcCardioItemCalories(item, bodyWeightKg) {
  if (!item?.segments?.length) return 0;
  return item.segments.reduce((sum, seg) => {
    const durMin = Math.max(0.1, (seg.durationSec || 0) / 60);
    const weight = Number(bodyWeightKg) || 70;
    // Body mass reaches metFor so the ergometer equations (watts -> oxygen
    // cost) can run; without it a ride with power entered fell back to the
    // generic effort table.
    const met = metFor(item.id, seg.params, item.effort, weight);
    return sum + Math.round(met * 3.5 * weight / 200 * durMin);
  }, 0);
}

/** Calculate in-progress calories for a running segment. */
function calcCurrentSegmentCalories(item, elapsedSec, bodyWeightKg) {
  if (!item || elapsedSec <= 0) return 0;
  const durMin = elapsedSec / 60;
  const weight = Number(bodyWeightKg) || 70;
  const met = metFor(item.id, item.currentParams, item.effort, weight);
  return Math.round(met * 3.5 * weight / 200 * durMin);
}

/** Calculate total calories for a cardio item (completed segments + in-progress). */
function calcItemTotalCalories(item, elapsedSec, bodyWeightKg) {
  const segCal = calcCardioItemCalories(item, bodyWeightKg);
  const curCal = calcCurrentSegmentCalories(item, elapsedSec, bodyWeightKg);
  return segCal + curCal;
}

/** Sum total cardio calories across all items. */
function calcAllCardioCalories(items, activeItem, activeElapsed, bodyWeightKg) {
  return items.reduce((sum, item) => {
    const isActive = activeItem?.id === item.id;
    return sum + calcItemTotalCalories(item, isActive ? activeElapsed : 0, bodyWeightKg);
  }, 0);
}

export default function Workout() {
  const u = useUnits();
  const nav = useNavigate();
  const today = useFetch(() => api('/tracking/me/today'));
  const week = useFetch(() => api('/tracking/me/week'));
  const hist = useFetch(() => api('/tracking/me/workouts'));
  const perms = useFetch(() => api('/me/permissions'));
  const [exState, setExState] = useState(null);
  const [toast, setToast] = useState('');
  /* The builder: { mode: 'new' | 'edit', initial, defaultWhen } while
     open, null when shut. It builds for today, for chosen weekdays, or
     just saves (components/workout/WorkoutBuilder.jsx). */
  const [builder, setBuilder] = useState(null);
  const [libList, setLibList] = useState(null);
  // in-session add-exercise picker (only visible during execute mode)
  const [addExOpen, setAddExOpen] = useState(false);
  const [addExSelected, setAddExSelected] = useState(null); // library exercise selected in detail view
  const [addExSaving, setAddExSaving] = useState(false);
  // Saved workouts -- reusable workouts and the days they repeat on (/me/planner).
  const [savedOpen, setSavedOpen] = useState(false);
  const [logPastOpen, setLogPastOpen] = useState(false);
  const [planner, setPlanner] = useState(null); // { workouts, schedule } -- schedule days are 0=Mon..6=Sun
  const [busyPlan, setBusyPlan] = useState(null); // id of the saved workout being made today's
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
  /* Supersets in the running session: { exerciseId: key }, neighbours
     sharing a key (components/workout/supersets.js). Seeded from the
     plan, changed with the link between two cards. */
  const [groups, setGroups] = useState({});
  // Exercises taken out of this session, so a refresh does not bring them back.
  const [removedIds, setRemovedIds] = useState([]);
  const dropHinted = useRef(false);
  const [infoEx, setInfoEx] = useState(null);   // main-page info panel
  const [burn, setBurn] = useState(null);   // skos-cal-v1 estimate + interval
  const [burnInput, setBurnInput] = useState(null); // { duration_minutes, exercises } captured at finish, sent once intensity is answered
  const [intensity, setIntensity] = useState(null);
  /* Declining the calorie estimate is a real answer, and it has to be
     distinguishable from not-yet-answered -- otherwise Skip would leave
     the summary permanently stuck on the question it just dismissed. */
  const [intensitySkipped, setIntensitySkipped] = useState(false);
  // SK OS Health Intelligence Engine -- best-effort, NEVER blocking. null
  // until (and unless) a background check finds real wearable evidence
  // for this exact session; the summary screen's own "Calories burned"
  // card above already renders instantly off `burn` regardless of this.
  // See checkWorkoutSource() below for why this is fire-and-forget.
  const [burnSource, setBurnSource] = useState(null);
  const [sharing, setSharing] = useState(false);
  const [shareToast, setShareToast] = useState(''); // 'light' | 'moderate' | 'hard' — post-session rating, required by the model
  // Workout link sharing (personal share, NOT community)
  const [shareSheetOpen, setShareSheetOpen] = useState(false);
  // The completed session, waiting for the member to pick which communities
  // (if any) it goes to.
  const [shareCommunitiesFor, setShareCommunitiesFor] = useState(null);
  const [shareSheetData, setShareSheetData] = useState(null); // { workoutId, workoutName, exercises } (see ml/docs/SESSION_INTENSITY_DESIGN_NOTE.md)
  const [burnLoading, setBurnLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0); // ticking elapsed seconds during execute mode
  const [pausedAt, setPausedAt] = useState(0); // timestamp when pause began (0 = not paused)
  const [accumulatedPausedMs, setAccumulatedPausedMs] = useState(0); // total paused time so far
  // this week preview
  const [weekDay, setWeekDay] = useState(null); // { label, name, focus, exercises }
  const [weekDayIdx, setWeekDayIdx] = useState(0);

  // ── cardio state (segment-aware) ──
  // items: [{ id, segments: [{ params, durationSec }], currentParams }]
  // activeId: id of exercise currently running (null if not active)
  // activeSegmentStart: Date.now() when the current segment started
  const [cardioItems, setCardioItems] = useState([]);
  const [cardioMode, setCardioMode] = useState('browse');      // browse | execute | summary
  const [cardioOpen, setCardioOpen] = useState(false);
  // Focus, Escape, scroll lock and drag-to-dismiss for this page's sheets
  // come from the shared Sheet (UI.jsx); each one's onClose does exactly
  // what its own close button does.
  const [confirm, confirmDialog] = useConfirm();
  const [cardioSearch, setCardioSearch] = useState('');
  const [cardioConfigItem, setCardioConfigItem] = useState(null);
  const [cardioActiveId, setCardioActiveId] = useState(null);  // which exercise is currently running
  const [cardioSegStart, setCardioSegStart] = useState(0);    // Date.now() when current segment started
  const [cardioElapsed, setCardioElapsed] = useState(0);      // total elapsed seconds for the active exercise
  const [cardioResult, setCardioResult] = useState(null);     // { totalCalories, items: [...] }
  const [logCardioOpen, setLogCardioOpen] = useState(false);
  const [clientWeight, setClientWeight] = useState(null);     // fetched from /me/profile for calorie calc

  const session = today.data;
  const workout = session?.workout || null;
  const exercises = workout?.exercises || [];
  const state = exState || exercises;

  const focus = session?.focus || [];
  const meta = session?.meta || {};
  const suggestions = session?.suggestions || [];

  const equipMap = useMemo(() => Object.fromEntries((session?.equipment || []).map((e) => [e.exercise_id, e])), [session]);
  // Last session's numbers and the next target, per exercise -- already in
  // /tracking/me/today, and until now never shown.
  const suggestionByEx = useMemo(() => Object.fromEntries((session?.suggestions || []).map((x) => [x.exercise_id, x])), [session]);

  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(''), 2400);
    return () => clearTimeout(h);
  }, [toast]);

  /* Persist the checklist as it changes.

     Debounced at 800 ms: ticking four sets in quick succession should cost
     one request, not four. Fire-and-forget on purpose -- a failed save must
     never interrupt someone mid-set, and the next tick retries implicitly
     by sending the whole checklist rather than a delta.

     Also persists accumulatedPausedMs so a page-refresh during a paused
     session can restore the correct active-duration baseline, and the
     session's own layout -- the order it was dragged into, what was
     removed, the supersets -- which is just as much the user's work. */
  useEffect(() => {
    if (mode !== 'execute' || !workout?.id) return undefined;
    const h = setTimeout(() => {
      // paused_ms is stored inside the progress blob so it survives
      // a page-refresh (the progress endpoint stores this as opaque JSON).
      api(`/workouts/${workout.id}/progress`, {
        method: 'PUT',
        body: JSON.stringify({
          progress: {
            ...exSets,
            __paused_ms: accumulatedPausedMs,
            __order: (exState || exercises).map((e) => e.id),
            __removed: removedIds,
            __groups: groups,
          },
        }),
      }).catch(() => {});
    }, 800);
    return () => clearTimeout(h);
  }, [exSets, accumulatedPausedMs, mode, workout?.id, exState, removedIds, groups]); // eslint-disable-line react-hooks/exhaustive-deps

  // session elapsed timer — ticks every second during execute mode
  // Paused time is excluded: the timer freezes visually and the
  // authoritative `elapsed` value stops advancing while paused.
  useEffect(() => {
    if (mode !== 'execute' || !startedAt || pausedAt) return;
    const tick = () => {
      const now = Date.now();
      const wallClockMs = now - startedAt;
      setElapsed(Math.floor((wallClockMs - accumulatedPausedMs) / 1000));
    };
    tick();
    const h = setInterval(tick, 1000);
    return () => clearInterval(h);
  }, [mode, startedAt, pausedAt, accumulatedPausedMs]);

  // ── cardio timer — ticks every second while an exercise is active ──
  useEffect(() => {
    if (cardioMode !== 'execute' || !cardioActiveId || !cardioSegStart) return;
    const tick = () => {
      // Total elapsed = sum of completed segments + current segment time
      const item = cardioItems.find((c) => c.id === cardioActiveId);
      const segTotal = (item?.segments || []).reduce((s, seg) => s + (seg.durationSec || 0), 0);
      const curSec = Math.floor((Date.now() - cardioSegStart) / 1000);
      setCardioElapsed(segTotal + curSec);
    };
    tick();
    const h = setInterval(tick, 1000);
    return () => clearInterval(h);
  }, [cardioMode, cardioActiveId, cardioSegStart, cardioItems.length]);

  // ── fetch client weight for cardio calorie calculation ──
  useEffect(() => {
    api('/me/profile').then((r) => {
      if (r.client?.current_weight) setClientWeight(Number(r.client.current_weight));
    }).catch(() => {});
  }, []);

  // ---- restore from started_at (refresh-while-active) ----
  // Requires a valid LOCAL active-session marker (localStorage) that
  // matches this specific workout. Without a marker, a stale server-side
  // `started_at` must NOT resurrect an old session.
  useEffect(() => {
    if (mode !== 'browse' || !workout) return;
    if (workout.status === 'completed') {
      // CASE 6: completed workout — never restore, clean up any stale marker
      clearActiveSession();
      return;
    }
    if (!workout.started_at) return;

    // Check for a valid local active-session marker
    const session = getActiveSession();
    if (!session || session.workoutId !== workout.id) {
      // CASE 5: no local marker or different workout — do NOT restore
      // CASE 7: marker is for a different workout — ignore it
      clearActiveSession();
      return;
    }
    // Valid local session found for this workout — proceed with restore
    // Workout was already started server-side but user refreshed — restore execution state
    /* Restore the SAVED ticks, not a blank checklist.
       started_at survives server-side, so before this the app happily
       restored an "in progress" session showing 0/16 sets -- every set the
       user had already ticked was gone. Losing logged work is worse than
       not restoring at all. */
    let restored = null;
    try {
      restored = workout.progress_json ? JSON.parse(workout.progress_json) : null;
    } catch {
      restored = null;   // corrupt draft: fall back to a fresh checklist
    }
    // Extract accumulated pause time stored inside the progress blob.
    // `restored` is a flat map: exercise IDs -> set arrays, plus the
    // sentinel key __paused_ms that we stashed during autosave.
    const restoredPausedMs = (restored?.__paused_ms || 0);
    const list = sessionLayout(exercises, restored);
    const fresh = buildSets(list);
    // Merge rather than trust the draft wholesale: the plan may have been
    // edited since. The per-set values come from the draft, and the COUNT
    // is whichever is larger -- see mergeDraftSets for why taking the
    // plan's count alone deleted sets the user had added.
    const merged = mergeDraftSets(fresh, restored);
    setExState(list);
    setRemovedIds(Array.isArray(restored?.__removed) ? restored.__removed.filter((x) => typeof x === 'string') : []);
    setGroups(restored?.__groups && typeof restored.__groups === 'object'
      ? normalizeGroups(list.map((e) => e.id), restored.__groups)
      : groupsFromExercises(list));
    setExSets(merged);
    const firstUnfinished = list.find((e) => (merged[e.id] || []).some((r) => !r.done));
    setOpenEx((firstUnfinished || list[0])?.id ?? null);
    // Restore accumulated paused time from the persisted draft
    setAccumulatedPausedMs(restoredPausedMs);
    setElapsed(0);
    // Reconstruct elapsed time from server started_at
    // Prefer the local session's startedAt (browser clock) over the server
    // timestamp so the timer reflects actual wall-clock time in this tab.
    setStartedAt(session.startedAt || Date.parse(workout.started_at));
    setMode('execute');
  }, [workout?.started_at, workout?.status]); // re-run when status changes (e.g. completed) to prevent stale restore

  // ---- personal workout planner helpers ----
  const loadPlanner = async () => {
    try { setPlanner(await api('/me/planner')); }
    catch (e) { setToast(e.message || 'Could not load your workouts'); }
  };

  const openSaved = async () => {
    setSavedOpen(true);
    await loadPlanner();
  };

  const reloadAll = () => {
    // silent: a bare reload() swaps this page for its skeleton while it
    // refetches, unmounting anything open (see utils.js's useFetch).
    today.reload({ silent: true }); week.reload({ silent: true }); hist.reload({ silent: true });
  };

  const duplicatePlan = async (w) => {
    try {
      await api(`/me/planner/workouts/${w.id}/duplicate`, { method: 'POST' });
      setToast(`Copied ${w.name}`);
      await loadPlanner();
    } catch (e) { setToast(e.message); }
  };

  const deletePlan = async (w) => {
    if (!(await confirm({ title: `Delete "${w.name}"?`, body: 'Its repeat days are cleared too. Sessions you already did stay in your history.', confirmLabel: 'Delete workout' }))) return;
    try {
      await api(`/me/planner/workouts/${w.id}`, { method: 'DELETE' });
      setToast('Workout deleted');
      await loadPlanner();
      week.reload({ silent: true });
    } catch (e) { setToast(e.message); }
  };

  /** One day chip on a saved workout. A day holds one workout, so turning
   *  a day on that another workout had moves it, and the toast says so. */
  const setPlanDays = async (w, days, day, turnedOn) => {
    const prior = (planner?.schedule || []).find((x) => x.day_of_week === day && x.workout_id !== w.id);
    const priorName = prior && (planner?.workouts || []).find((x) => x.id === prior.workout_id)?.name;
    // Optimistic: the chip flips under the thumb, the server confirms.
    setPlanner((p) => p && {
      ...p,
      schedule: [
        ...p.schedule.filter((x) => x.workout_id !== w.id && !days.includes(x.day_of_week)),
        ...days.map((d) => ({ day_of_week: d, workout_id: w.id })),
      ],
    });
    try {
      const r = await api(`/me/planner/workouts/${w.id}/days`, { method: 'PUT', body: JSON.stringify({ days }) });
      if (r?.schedule) setPlanner((p) => p && { ...p, schedule: r.schedule });
      const LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
      setToast(turnedOn
        ? (priorName ? `${LONG[day]} moved from ${priorName} to ${w.name}` : `${w.name} every ${LONG[day]}`)
        : `${w.name} is off ${LONG[day]}s`);
      week.reload({ silent: true });
      if (day === plannerToday()) today.reload({ silent: true });
    } catch (e) {
      setToast(e.message || 'Could not change the days');
      loadPlanner();
    }
  };

  const startPlanToday = async (w) => {
    if (busyPlan) return;
    setBusyPlan(w.id);
    try {
      await api('/me/workouts', { method: 'POST', body: JSON.stringify({
        name: w.name,
        exercises: (w.exercises || []).map((e) => ({ exercise_id: e.exercise_id, sets: e.sets, reps: e.reps, weight: e.weight, rest_sec: e.rest_sec, superset_group: e.superset_group || null })),
      }) });
      setSavedOpen(false);
      setToast(`${w.name} is today's workout`);
      reloadAll();
    } catch (e) { setToast(e.message || 'Could not make it today\u2019s workout'); }
    setBusyPlan(null);
  };

  const openBuilder = (opts = {}) => {
    if (!libList) loadLib();
    if (!planner) loadPlanner();
    setBuilder({ mode: 'new', initial: null, defaultWhen: 'today', ...opts });
  };
  const editPlan = (w, days) => {
    if (!libList) loadLib();
    setBuilder({ mode: 'edit', initial: { ...w, days }, defaultWhen: 'weekly' });
  };
  const loadLib = () => api('/workouts/exercises').then((r) => setLibList(r.exercises || [])).catch(() => setToast('Could not load the exercise library'));

  /** After the builder saves: say plainly what happened and where. */
  const builderSaved = ({ kind, name, days, res, keepCopy }) => {
    setBuilder(null);
    if (kind === 'edit') setToast(`${name} saved`);
    else if (kind === 'today') setToast(keepCopy ? `${name} is today's workout, and saved` : `${name} is today's workout`);
    else if (kind === 'weekly') {
      setToast(res?.today_workout_id ? `${name}: today, and every ${dayList(days)}`
        : res?.today_skipped === 'in_progress' ? `Saved for every ${dayList(days)}. Today's session already started, so it begins next time.`
          : `${name} every ${dayList(days)}`);
    } else setToast(`${name} saved. Find it in Saved workouts`);
    reloadAll();
    if (kind !== 'today' || keepCopy || planner) loadPlanner();
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
  /* The coach's program days in the saved-workout numbering (0=Mon..6=Sun;
     /me/week counts 1=Mon..0=Sun). A saved workout cannot take one: the
     program wins on its days, so offering them would only mislead. */
  const coachDays = new Set(weekRows.filter((d) => d.source === 'program').map((d) => (d.day_of_week + 6) % 7));

  /* Shaped like the screen it becomes rather than a centred spinner — this
     page is four stacked bands, so a spinner guarantees a hard layout jump
     the moment any one of the four fetches lands. */
  if (today.loading || week.loading || hist.loading || perms.loading) {
    return (
      <div className="space-y-5" aria-busy="true" aria-label="Loading your session">
        <div className="card p-4">
          <div className="skeleton-text" style={{ width: '45%' }} />
          <div className="grid grid-cols-7 gap-1.5 mt-3">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="skeleton" style={{ height: 44, borderRadius: 'var(--r-md)' }} />
            ))}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 96, borderRadius: 'var(--r-lg)' }} />
          ))}
        </div>
        <div>
          <div className="skeleton-title" style={{ width: '55%' }} />
          <div className="grid grid-cols-3 gap-2.5 mt-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="skeleton" style={{ height: 58, borderRadius: 'var(--r-lg)' }} />
            ))}
          </div>
          <div className="skeleton mt-3" style={{ height: 40, borderRadius: 'var(--r-pill)' }} />
        </div>
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => <div key={i} className="skeleton-row" />)}
        </div>
      </div>
    );
  }
  if (today.error) return <ErrorState error={today.error} onRetry={today.reload} />;

  const toggleEx = async (ex) => {
    const next = !ex.done;
    setExState(state.map((x) => (x.id === ex.id ? { ...x, done: next } : x)));
    try { await api(`/workouts/${workout.id}/exercises/${ex.id}`, { method: 'PATCH' }); } catch { today.reload({ silent: true }); }
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
        today.reload({ silent: true });
        return;
      }
    } catch (e) {
      setStarting(false);
      setToast(e.message || 'Could not start workout');
      return;
    }
    // API succeeded — proceed with local timer/UI
    setExSets(buildSets(state));
    setGroups(groupsFromExercises(state));
    setRemovedIds([]);
    setOpenEx(state[0]?.id ?? null);
    setElapsed(0);
    const now = Date.now();
    setStartedAt(now);
    setPausedAt(0);
    setAccumulatedPausedMs(0);
    setMode('execute');
    setStarting(false);
    saveActiveSession(workout.id, now);
  };



  const patchSet = (exId, i, field, value) => setExSets((prev) => {
    const rows = [...(prev[exId] || [])];
    if (!rows[i]) return prev;
    rows[i] = { ...rows[i], [field]: value };
    return { ...prev, [exId]: rows };
  });

  const toggleSet = (exId, i) => setExSets((prev) => {
    const rows = [...(prev[exId] || [])];
    if (!rows[i]) return prev;
    const ticking = !rows[i].done;
    rows[i] = { ...rows[i], done: ticking };
    const next = { ...prev, [exId]: rows };
    const unfinished = (id) => (next[id] || []).some((r) => !r.done);
    /* In a superset the next thing to do is the PARTNER's set, not this
       exercise's next one: open the next member that still has a set to
       do, going round. Only when the whole superset is done does it move
       on, like any finished exercise. */
    const ids = state.map((e) => e.id);
    const members = groupMembers(ids, groups, exId);
    if (ticking && members.length > 1) {
      const at = members.indexOf(exId);
      for (let k = 1; k <= members.length; k += 1) {
        const m = members[(at + k) % members.length];
        if (unfinished(m)) { setOpenEx(m); return next; }
      }
    }
    // Auto-advance to the next unfinished exercise once this one is fully
    // ticked, so the next thing to do is already open rather than requiring
    // a tap on a screen the user is holding at arm's length.
    if (rows.every((r) => r.done)) {
      const following = state.find((e) => !members.includes(e.id) && ((next[e.id] || []).length === 0 || unfinished(e.id)));
      setOpenEx(following ? following.id : null);
    }
    return next;
  });

  // ---- remove exercise from active session ----
  const removeExercise = (exId) => {
    const list = state.filter((e) => e.id !== exId);
    setExState(list);
    setRemovedIds((r) => (r.includes(exId) ? r : [...r, exId]));
    setGroups((g) => { const n = { ...g }; delete n[exId]; return normalizeGroups(list.map((e) => e.id), n); });
    setExSets((prev) => {
      const next = { ...prev };
      delete next[exId];
      return next;
    });
    // If the removed exercise was the open accordion, close it
    if (openEx === exId) setOpenEx(null);
  };

  // ---- reorder: the three-line handle, or the arrow keys on it ----
  const moveExercise = (from, to) => {
    const list = moveItem(state, from, to);
    setExState(list);
    setGroups((g) => groupsAfterMove(list.map((e) => e.id), g, to));
  };

  // ---- superset: the link between two cards ----
  const toggleSuperset = (i) => {
    const ids = state.map((e) => e.id);
    const next = toggleLink(ids, groups, i);
    setGroups(next);
    if (isLinked(ids, next, i)) {
      const names = groupMembers(ids, next, ids[i]).map((id) => exerciseLabel(state.find((e) => e.id === id)?.name || ''));
      setToast(`Superset: ${names.join(', then ')}. Rest after the round.`);
    }
  };

  // ---- drop set: a lighter set straight after the one just done ----
  const addDropSet = (exId) => {
    setExSets((prev) => ({ ...prev, [exId]: insertDropSet(prev[exId] || []) }));
    if (!dropHinted.current) {
      dropHinted.current = true;
      setToast('Drop set added: same move, about 20% lighter, no rest');
    }
  };

  // ---- add exercise during active session ----
  const addExerciseToSession = async (libEx) => {
    if (!workout?.id || addExSaving) return;
    setAddExSaving(true);
    try {
      const res = await api(`/workouts/${workout.id}/exercises`, {
        method: 'POST',
        body: JSON.stringify({
          exercise_id: libEx.id,
          name: libEx.name,
          sets: 3,
          reps: '10',
          weight: 'BW',
        }),
      });
      const newEx = res.exercise;
      // Add to state (exercises list)
      setExState((prev) => [...(prev || state), newEx]);
      // Seed sets in exSets
      setExSets((prev) => ({
        ...prev,
        [newEx.id]: Array.from({ length: Math.max(1, Number(newEx.sets) || 3) }, () => ({
          reps: parseFloat(newEx.reps) || 0,
          weight: parseFloat(newEx.weight) || 0,
          done: false,
        })),
      }));
      // Open the new exercise so user can start editing immediately
      setOpenEx(newEx.id);
      // Close the picker
      setAddExOpen(false);
      setAddExSelected(null);
      setToast(`${newEx.name} added`);
    } catch (e) {
      setToast(e.message || 'Could not add exercise');
    }
    setAddExSaving(false);
  };

  // ---- add set to an exercise ----
  const addSet = (exId) => {
    setExSets((prev) => {
      const rows = [...(prev[exId] || [])];
      if (!rows.length) return prev;
      const lastRow = rows[rows.length - 1];
      rows.push({
        reps: lastRow.reps,
        weight: lastRow.weight,
        done: false,
      });
      return { ...prev, [exId]: rows };
    });
  };

  // ---- remove a single set from an exercise ----
  const removeSet = (exId, i) => {
    setExSets((prev) => {
      const rows = [...(prev[exId] || [])];
      if (rows.length <= 1) return prev; // minimum 1 set
      rows.splice(i, 1);
      return { ...prev, [exId]: rows };
    });
  };

  // ---- pause / resume active session ----
  const pauseWorkout = () => {
    if (pausedAt) return; // already paused
    setPausedAt(Date.now());
  };

  const resumeWorkout = () => {
    if (!pausedAt) return; // not paused
    const pauseDuration = Date.now() - pausedAt;
    setAccumulatedPausedMs((prev) => prev + pauseDuration);
    setPausedAt(0);
  };


  // Build per-set logs from actual captured inputs (what was entered when each set was completed).
  const finishWorkout = async () => {
    setSubmitting(true);
    try {
      /* Only TICKED sets are logged, with the numbers actually typed for
         each one. The previous version logged N identical sets from a single
         shared input box, so a session where the last set dropped from 60 kg
         to 50 kg was recorded as three sets at 60 -- inflating both volume
         and the burn estimate derived from it. */
      const ids = state.map((e) => e.id);
      const logs = state.map((e) => {
        const rows = (exSets[e.id] || []).filter((r) => r.done);
        if (!rows.length) return null;
        // How it was done, for history: its superset partners and drops.
        const notes = sessionNote({
          partners: groupMembers(ids, groups, e.id).filter((id) => id !== e.id)
            .map((id) => exerciseLabel(state.find((x) => x.id === id)?.name || '')).filter(Boolean),
          drops: rows.filter((r) => r.drop).length,
        });
        return {
          exercise_id: e.id,
          ...(notes ? { notes } : {}),
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
        clearActiveSession();
        // Back to the plan as it is, not the session's reordered, trimmed copy.
        setExState(null); setGroups({}); setRemovedIds([]);
        setMode('browse');
        setToast('Session ended — no sets were logged');
        return;
      }
      // Compute active duration: wall-clock elapsed minus total paused time.
      // This ensures paused minutes never enter calorie calculations.
      const finalPausedMs = pausedAt ? accumulatedPausedMs + (Date.now() - pausedAt) : accumulatedPausedMs;
      const activeMs = Math.max(0, (Date.now() - startedAt) - finalPausedMs);
      const activeDurationSec = Math.round(activeMs / 1000);
      const res = await api(`/workouts/${workout.id}/complete`, {
        method: 'POST',
        body: JSON.stringify({
          logs,
          duration_seconds: activeDurationSec,
          paused_ms: Math.round(finalPausedMs),
        }),
      });
      const volume = logs.reduce((s, l) => s + l.sets.reduce((a, st) => a + (st.actual_reps * st.actual_weight), 0), 0);
      // duration_min is server-authoritative (completed_at − started_at,
      // minus paused time). Fall back to the local active duration --
      // activeMs above, which already subtracts finalPausedMs -- only if
      // the backend did not compute it; a raw Date.now()-startedAt fallback
      // would overcount by however long the session was paused.
      const durationMin = res.duration_min ?? Math.max(1, Math.round(activeMs / 60000));
      // name: workout.name is snapshotted HERE, not read live from
      // `workout` on the summary screen -- `workout` is derived from
      // `today.data`, and the `today.reload({ silent: true })` a few
      // lines below (needed so browse mode shows the NEXT session once the
      // user leaves this screen) replaces `today.data.workout` with
      // whatever /tracking/me/today resolves to next, while the summary
      // is still mounted and reading it live. Found live: completing
      // "Leg Day" showed a summary titled "Pull Day" -- the name of the
      // session that became "today's" AFTER this one was marked
      // completed, not the one actually just finished.
      // workoutId/exerciseList are likewise snapshotted for the same reason
      // as `name` above: the Share buttons below pass workout.id/exercises
      // (the live, about-to-be-swapped values) straight into the share
      // request/sheet -- without this, "Share Workout" from the summary
      // screen would share the NEXT session (id and all), not the one the
      // user just finished. `state` (not `exercises`) is the right source:
      // it's the exact same prescription array already used to build
      // `logs` above, i.e. what this completed session actually was.
      /* Per-exercise breakdown, snapshotted HERE for the same reason as
         `name` below: the recap screen charts it, and `state`/`exSets` are
         both cleared a few lines down so the session cannot be re-entered.
         Built from `logs` (what was actually ticked), not from the
         prescription -- an exercise abandoned mid-session must contribute
         what it did, not what it was told to.

         setsPlanned is the CHECKLIST length, not the prescribed count:
         sets added or removed during the session are part of what the
         member set out to do by the end, and using the prescription would
         let the completion ring read over 100%. */
      const breakdown = logs.map((l) => {
        const ex = state.find((e) => e.id === l.exercise_id) || {};
        return {
          id: l.exercise_id,
          name: ex.name,
          muscle: ex.primary_muscle || null,
          sets: l.sets.length,
          reps: l.sets.reduce((a, st) => a + st.actual_reps, 0),
          volume: l.sets.reduce((a, st) => a + st.actual_reps * st.actual_weight, 0),
        };
      });
      const setsPlanned = state.reduce((a, e) => a + (exSets[e.id] || []).length, 0);
      const setsDone = logs.reduce((a, l) => a + l.sets.length, 0);
      setResult({ name: workout.name, workoutId: workout.id, exerciseList: state, prs: res.prs || [], volume, durationMin, exercises: state.length, calorie: res.calorie || null, breakdown, setsPlanned, setsDone });
      setMode('summary');

      /* Calorie burn (skos-cal-v1) needs an intensity rating -- see
         ml/docs/SESSION_INTENSITY_DESIGN_NOTE.md: "session.intensity_rating
         selects the MET tier" and is a required, deliberately-cheap (one
         tap) input to the model, not optional context. Rather than firing
         the estimate immediately with no rating (which silently defaults to
         "moderate" for every session -- see skosCalV1.js's normalizeTier --
         quietly wrong for anyone whose actual effort wasn't moderate), the
         request payload is captured here and the summary screen asks the
         one question before sending it. Still fire-and-forget in spirit:
         a missing/declined estimate never blocks or errors the completed
         session, which is already saved server-side by this point. */
      /* NOTE the prefix: the intelligence router is mounted at `/api/intel`
         in backend/src/index.js, NOT `/api/intelligence`. This originally
         called `/intelligence/workout-burn`, which 404s -- and because the
         burn fetch is deliberately fire-and-forget so it can never break a
         completed session, the failure was SILENT: the summary simply never
         showed a calorie figure and nothing surfaced to say why. */
      setBurnInput({
        duration_minutes: durationMin,
        exercises: logs.map((l) => ({
          name: (state.find((e) => e.id === l.exercise_id) || {}).name,
          sets: l.sets.map((st) => ({
            actual_reps: st.actual_reps,
            actual_weight: st.actual_weight,
            completed: 1,
          })),
        })),
      });
      setBurn(null);
      setIntensity(null);
      setIntensitySkipped(false);
      today.reload({ silent: true }); hist.reload({ silent: true });
      // Clear local session state so the restore effect cannot
      // re-enter execute mode for a now-completed workout.
      // Clear local session marker and timer state on successful completion
      clearActiveSession();
      setStartedAt(0);
      setPausedAt(0);
      setAccumulatedPausedMs(0);
      setElapsed(0);
      setExState(null);
      setGroups({});
      setRemovedIds([]);

    } catch (e) {
      clearActiveSession();
      setToast(e.message || 'Could not log workout');
      setMode('browse');
    }
    setSubmitting(false);
  };

  // One tap, asked once per session on the summary screen -- the intensity
  // rating skos-cal-v1 needs (see the note in finishWorkout above). A
  // declined/failed estimate leaves `burn` null and the summary simply
  // omits the calorie figure, same as before this was wired up.
  /* The answer is saved WITH the session and the stored estimate is
     recomputed from it (POST /workouts/:id/effort), so the figure on this
     screen is the one history and the energy balance count. This used to
     ask a separate research model for a number and keep it only on screen,
     while the session itself stayed estimated as "moderate". */
  const pickIntensity = async (tier) => {
    if (!result?.workoutId || burnLoading) return;
    setIntensity(tier);
    setBurnLoading(true);
    try {
      const res = await api(`/workouts/${result.workoutId}/effort`, { method: 'POST', body: JSON.stringify({ effort: tier }) });
      const c = res?.calorie;
      setBurn(c ? {
        kcal: c.estimated_active_kcal,
        lower_kcal: c.lower_kcal,
        upper_kcal: c.upper_kcal,
        notes: c.note ? [c.note] : [],
        model_version: c.model_version,
      } : null);
      checkWorkoutSource(); // fire-and-forget -- see its own comment
    } catch {
      setBurn(null);
    }
    setBurnLoading(false);
  };

  // Best-effort source check (spec §45: "Detected automatically" /
  // "Recorded from Apple Watch" / "Estimated by SK OS"). Deliberately
  // NOT awaited by its one call site above -- the "Workout complete"
  // summary already renders instantly off `burn` (see that card's own
  // comment on why), and this must never make it wait on a
  // reconciliation pass. Runs in the background; if it resolves with
  // real wearable evidence for THIS exact session, upgrades the label
  // from the (already honest) default. If it fails, is slow, or finds
  // nothing better, the summary is unaffected -- no wearable is required
  // for a complete result (spec §87).
  const checkWorkoutSource = async () => {
    try {
      await api('/health/daily-intelligence?refresh=1');
      const today = new Date().toISOString().slice(0, 10);
      const { workouts: canon } = await api(`/health/workouts?date=${today}`);
      const match = canon?.find((c) => c.skos_workout_id === result?.workoutId);
      // Allowlist check (isWearableSource), not a denylist -- a
      // canonical workout's primary_energy_source is either one of the
      // ten real wearable provider keys, OR one of SK OS's OWN internal
      // calorie-model provider names ('baseline' | 'ml' | 'mock' -- see
      // calorieModel.js). A denylist of "not a wearable" names silently
      // mislabels any internal name it doesn't already know about --
      // caught live: 'baseline' briefly rendered as "baseline + SK OS"
      // instead of falling through to the correct default below.
      if (isWearableSource(match?.primary_energy_source)) {
        setBurnSource(burnSourceLabel({ providers: [match.primary_energy_source] }));
        // A device that measured the session beats any estimate: show what
        // it recorded, not the model's number under the device's name.
        if (Number(match.active_kcal) > 0) {
          setBurn((b) => ({ ...(b || {}), kcal: Math.round(match.active_kcal), lower_kcal: null, upper_kcal: null, notes: [], model_version: null, measured: true }));
        }
      }
    } catch { /* best-effort only -- the summary already has a real estimate without this */ }
  };

  // ---- cardio: start a cardio session ----
  const startCardio = () => {
    if (!cardioItems.length) return;
    const first = cardioItems[0];
    // Initialize segments array if not present, start first segment
    setCardioItems((prev) => prev.map((item, i) => {
      if (i !== 0) return { ...item, segments: item.segments || [] };
      return { ...item, segments: [], currentParams: { ...item.params } };
    }));
    setCardioActiveId(first.id);
    setCardioSegStart(Date.now());
    setCardioElapsed(0);
    setCardioMode('execute');
    setCardioResult(null);
  };

  // ---- cardio: adjust settings for active exercise ----
  // Creates a new segment: closes the current one at elapsed time,
  // starts a new segment with the updated params. Timer continues.
  const adjustCardioSettings = (newParams) => {
    if (!cardioActiveId) return;
    const now = Date.now();
    const segDurationSec = Math.floor((now - cardioSegStart) / 1000);
    setCardioItems((prev) => prev.map((item) => {
      if (item.id !== cardioActiveId) return item;
      const currentSeg = {
        params: { ...item.currentParams },
        durationSec: segDurationSec,
      };
      return {
        ...item,
        segments: [...(item.segments || []), currentSeg],
        currentParams: { ...newParams },
      };
    }));
    setCardioSegStart(now); // new segment starts now; timer continues
  };

  // ---- cardio: finish the active exercise ----
  const finishActiveCardioExercise = () => {
    if (!cardioActiveId) return;
    const now = Date.now();
    const segDurationSec = Math.floor((now - cardioSegStart) / 1000);
    // Close the final segment
    setCardioItems((prev) => prev.map((item) => {
      if (item.id !== cardioActiveId) return item;
      const finalSeg = {
        params: { ...item.currentParams },
        durationSec: segDurationSec,
      };
      return { ...item, segments: [...(item.segments || []), finalSeg] };
    }));
    // Find next unperformed exercise
    setCardioActiveId((activeId) => {
      const idx = cardioItems.findIndex((c) => c.id === activeId);
      const next = cardioItems[idx + 1];
      if (next) {
        // Start next exercise
        setCardioItems((prev) => prev.map((item) => {
          if (item.id !== next.id) return item;
          return { ...item, segments: [], currentParams: { ...item.params } };
        }));
        setCardioSegStart(now);
        return next.id;
      }
      return null; // no more exercises — will trigger summary
    });
  };

  // ---- cardio: end the entire cardio session (all exercises done) ----
  const endCardio = () => {
    // Close any active segment first
    if (cardioActiveId && cardioSegStart) {
      const now = Date.now();
      const segDurationSec = Math.floor((now - cardioSegStart) / 1000);
      setCardioItems((prev) => prev.map((item) => {
        if (item.id !== cardioActiveId) return item;
        const finalSeg = { params: { ...item.currentParams }, durationSec: segDurationSec };
        return { ...item, segments: [...(item.segments || []), finalSeg] };
      }));
    }
    const totalCalories = calcAllCardioCalories(cardioItems, null, 0, clientWeight);
    const finished = cardioItems.map((item) => ({
      ...item,
      calories: calcCardioItemCalories(item, clientWeight),
    }));
    setCardioResult({ totalCalories, items: finished });

    /* PERSIST IT. Until now a cardio session lived only in this component:
       you ran for forty minutes, saw a calorie summary, and it was gone.
       Nothing reached history, the day's burn, the streak or Progress.
       Fire-and-forget per bout -- a failed save must not swallow the
       summary the user is looking at, and each bout is independent. */
    finished.forEach((item) => {
      const seconds = (item.segments || []).reduce((sum, seg) => sum + (Number(seg.durationSec) || 0), 0);
      if (seconds < 30) return;          // a mis-tap, not a session
      api('/me/cardio', {
        method: 'POST',
        body: JSON.stringify({
          activity_id: item.id,
          activity_name: cardioName(item.id),
          duration_sec: Math.round(seconds),
          effort: item.effort || undefined,
          params: item.params || {},
          kcal: item.calories,
          source: 'live',
        }),
      }).catch(() => { /* advisory: the summary on screen is still true */ });
    });
    setCardioMode('summary');
    setCardioActiveId(null);
    setCardioSegStart(0);
    setCardioElapsed(0);
  };

  // ---- cardio: dismiss summary ----
  const dismissCardioSummary = () => {
    setCardioMode('browse');
    setCardioResult(null);
    setCardioItems([]);
  };

  // ---- cardio: computed calories for active exercise ----
  const activeCardioItem = cardioItems.find((c) => c.id === cardioActiveId);
  const activeCardioCals = activeCardioItem ? calcItemTotalCalories(activeCardioItem, cardioElapsed - (activeCardioItem.segments || []).reduce((s, seg) => s + seg.durationSec, 0), clientWeight) : 0;
  const totalCardioCals = calcAllCardioCalories(cardioItems, activeCardioItem, cardioElapsed - (activeCardioItem?.segments || []).reduce((s, seg) => s + seg.durationSec, 0), clientWeight);

  // ---- small view helpers (no hooks below the loading return) ----
  const openCardioPicker = () => { setCardioOpen(true); setCardioSearch(''); setCardioConfigItem(null); };
  const closeCardioPicker = () => { setCardioOpen(false); setCardioConfigItem(null); setCardioSearch(''); };
  const openAddExercise = () => {
    if (!libList) api('/workouts/exercises').then((r) => setLibList(r.exercises || [])).catch(() => setToast('Could not load exercises'));
    setAddExSelected(null);
    setAddExOpen(true);
  };
  const closeAddExercise = () => { setAddExOpen(false); setAddExSelected(null); };
  const shareToday = () => { setShareSheetData({ workoutId: workout.id, workoutName: workout.name, exercises }); setShareSheetOpen(true); };
  const askRemoveExercise = async (ex) => {
    if (await confirm({ title: `Remove ${exerciseLabel(ex.name)}?`, body: 'Sets you have ticked for it are not logged.', confirmLabel: 'Remove' })) removeExercise(ex.id);
  };
  const addCardioItem = (id, params) => {
    setCardioItems((prev) => [...prev, { id, params, segments: [], currentParams: { ...params } }]);
    setToast(`${cardioName(id)} added`);
  };
  const defaultParams = (id) => {
    const params = {};
    cardioExerciseConfig(id).forEach((field) => { if (field.placeholder && !field.optional) params[field.key] = field.placeholder; });
    return params;
  };

  /* Days of THIS week already trained, from history. scheduled_date is a
     gym-day string, read as local noon so no timezone can move it to the
     neighbouring weekday. */
  const doneDows = (() => {
    const out = new Set();
    const now = new Date();
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
    const mondayKey = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
    for (const w of hist.data?.workouts || []) {
      if (w.status !== 'completed' || !w.scheduled_date || w.scheduled_date < mondayKey) continue;
      out.add(new Date(`${w.scheduled_date}T12:00:00`).getDay());
    }
    if (workout?.status === 'completed') out.add(new Date().getDay());
    return out;
  })();

  const tools = [
    canBuild && { key: 'build', label: 'Build workout', icon: ListPlus, onClick: () => openBuilder() },
    canBuild && { key: 'saved', label: 'Saved workouts', icon: Bookmark, onClick: openSaved },
    { key: 'cardio', label: 'Cardio', icon: Activity, onClick: openCardioPicker },
    { key: 'past', label: 'Log past', icon: History, onClick: () => setLogPastOpen(true) },
    { key: 'pastCardio', label: 'Log cardio', icon: HeartPulse, onClick: () => setLogCardioOpen(true) },
    { key: 'prs', label: 'My PRs', icon: Trophy, onClick: () => nav('/app/client/progress?section=prs') },
  ].filter(Boolean);

  const activeCardioPanel = cardioMode === 'execute' && cardioActiveId && activeCardioItem && (
    <CardioLive
      name={cardioName(cardioActiveId)}
      elapsed={cardioElapsed}
      kcal={totalCardioCals}
      fields={cardioExerciseConfig(cardioActiveId)}
      currentParams={activeCardioItem.currentParams || {}}
      segments={activeCardioItem.segments || []}
      summarize={segmentParamsSummary}
      onAdjust={(p) => {
        const cur = activeCardioItem.currentParams || {};
        if (Object.keys(p).some((k) => String(p[k]) !== String(cur[k]))) {
          adjustCardioSettings(p);
          setToast('Settings updated — new segment started');
        }
      }}
      onEnd={endCardio}
    />
  );

  const toastEl = toast && <div className="toast anim-toast" role="status">{toast}</div>;

  // ---- every sheet this page can open, rendered in whichever mode is up ----
  const sheets = (
    <>
      {/* BUILD A WORKOUT -- for today, for chosen weekdays, or just saved. */}
      <WorkoutBuilder
        open={!!builder}
        onClose={() => setBuilder(null)}
        mode={builder?.mode}
        initial={builder?.initial}
        defaultWhen={builder?.defaultWhen}
        libList={libList}
        loadLib={loadLib}
        schedule={planner?.schedule || []}
        workouts={planner?.workouts || []}
        coachDays={coachDays}
        toast={setToast}
        onSaved={builderSaved}
      />

      <LogPastCardio
        open={logCardioOpen}
        onClose={() => setLogCardioOpen(false)}
        bodyWeightKg={clientWeight}
        toast={setToast}
        onSaved={() => { hist.reload({ silent: true }); today.reload({ silent: true }); }}
      />

      <LogPastWorkout
        open={logPastOpen}
        onClose={() => setLogPastOpen(false)}
        libList={libList}
        loadLib={() => api('/workouts/exercises').then((r) => setLibList(r.exercises || [])).catch(() => setToast('Could not load the exercise library'))}
        toast={setToast}
        onSaved={() => { today.reload({ silent: true }); hist.reload({ silent: true }); }}
      />

      {confirmDialog}

      {/* SAVED WORKOUTS -- reusable workouts and the days they repeat on. */}
      <SavedWorkouts
        open={savedOpen}
        onClose={() => setSavedOpen(false)}
        planner={planner}
        coachDays={coachDays}
        busyId={busyPlan}
        onNew={() => { setSavedOpen(false); openBuilder({ defaultWhen: 'later' }); }}
        onEdit={(w, days) => { setSavedOpen(false); editPlan(w, days); }}
        onDoToday={startPlanToday}
        onCopy={duplicatePlan}
        onDelete={deletePlan}
        onSetDays={setPlanDays}
      />

      {/* A DAY OF THIS WEEK */}
      <Sheet open={!!weekDay} onClose={() => setWeekDay(null)}
        title={weekDay ? weekDay.name : ''}
        sub={weekDay ? `${weekDay.label}${weekDay.day_of_week === todayDow ? ' · today' : ''}${weekDay.focus ? ` · ${weekDay.focus}` : ''}` : ''}
        footer={weekDay?.day_of_week === todayDow && !!workout && workout.status !== 'completed' ? (
          <button className="btn-primary btn-block" onClick={() => { setWeekDay(null); startWorkout(); }}>
            <Play size={15} strokeWidth={2.4} fill="currentColor" aria-hidden="true" />Start today
          </button>
        ) : null}>
        <div>
          {weekDay?.exercises?.length ? (
            <ol className="wk-card wk-plan">
              {weekDay.exercises.map((ex, i) => (
                <li key={i} className="wk-ex">
                  <div className="wk-ex__row">
                    <span className="wk-ex__n" aria-hidden="true">{i + 1}</span>
                    <div className="wk-ex__body">
                      <div className="wk-ex__name">{exerciseLabel(ex.name)}</div>
                      <div className="wk-ex__meta">{ex.sets} × {ex.reps}{planWeight(ex.weight, u) ? ` · ${planWeight(ex.weight, u)}` : ''}</div>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className="text-center py-10 text-[13px]" style={{ color: 'var(--mute)' }}>Rest day — nothing scheduled.</div>
          )}
        </div>
      </Sheet>

      {/* ADD CARDIO */}
      <Sheet open={cardioOpen} onClose={closeCardioPicker}
        title={cardioConfigItem ? cardioName(cardioConfigItem) : 'Add cardio'}
        sub={cardioConfigItem ? 'Set it up — you can change it while it runs' : 'Machines, running and sports'}>
        <div className="space-y-3">
          {cardioConfigItem ? (
            <>
              <button onClick={() => setCardioConfigItem(null)} className="btn btn-sm">
                <ChevronLeft size={14} strokeWidth={2} aria-hidden="true" />All activities
              </button>
              <CardioParamsForm
                idPrefix="cardio-new"
                fields={cardioExerciseConfig(cardioConfigItem)}
                initial={cardioItems.find((c) => c.id === cardioConfigItem)?.params || {}}
                submitLabel="Add to session"
                onSubmit={(params) => { addCardioItem(cardioConfigItem, params); closeCardioPicker(); }}
              />
            </>
          ) : (
            <>
              <input className="input" aria-label="Search cardio" placeholder="Search machines, running, sports…" value={cardioSearch} onChange={(e) => setCardioSearch(e.target.value)} autoFocus />
              <div className="wk-pick">
                {ACTIVITIES
                  .filter((a) => !cardioSearch || a.name.toLowerCase().includes(cardioSearch.toLowerCase()))
                  .map((a) => {
                    const added = cardioItems.some((c) => c.id === a.id);
                    return (
                      <div key={a.id} className="wk-pick__row" aria-disabled={added || undefined}>
                        <button className="flex-1 min-w-0 text-left" onClick={() => setCardioConfigItem(a.id)}>
                          <span className="wk-pick__name truncate">{cardioName(a.id)}</span>
                          <span className="wk-pick__meta">{added ? 'In your session' : cardioSummary({ params: defaultParams(a.id) }) || 'Set it up'}</span>
                        </button>
                        <button className="wk-iconbtn wk-iconbtn--sm" disabled={added}
                          aria-label={added ? `${cardioName(a.id)} added` : `Add ${cardioName(a.id)}`}
                          onClick={() => { if (!added) addCardioItem(a.id, defaultParams(a.id)); }}>
                          {added ? <Check size={15} strokeWidth={2.4} aria-hidden="true" style={{ color: 'var(--good)' }} /> : <Plus size={15} strokeWidth={2.2} aria-hidden="true" />}
                        </button>
                      </div>
                    );
                  })}
              </div>
            </>
          )}
        </div>
      </Sheet>

      {/* ADD AN EXERCISE, mid-session */}
      <Sheet open={addExOpen} onClose={closeAddExercise}
        title={addExSelected ? exerciseLabel(addExSelected.name) : 'Add exercise'}
        sub={addExSelected ? 'Added with 3 sets of 10 — change them as you go' : 'Search the exercise library'}
        footer={addExSelected ? (
          <button className="btn-primary btn-block" disabled={addExSaving} onClick={() => addExerciseToSession(addExSelected)}>
            {addExSaving ? 'Adding…' : 'Add to session'}
          </button>
        ) : null}>
        <div className="grid gap-3">
          {addExSelected ? (
            <>
              <button onClick={() => setAddExSelected(null)} className="btn btn-sm justify-self-start">
                <ChevronLeft size={14} strokeWidth={2} aria-hidden="true" />Back to search
              </button>
              <ExerciseAnim anim={addExSelected.animation_key || 'fallback'} muscle={addExSelected.primary_muscle} label="" />
              <div className="wk-chips">
                {[addExSelected.primary_muscle, addExSelected.equipment, addExSelected.difficulty].filter(Boolean).map((t) => (
                  <span key={t} className="wk-chip">{String(t).replace(/_/g, ' ').toLowerCase()}</span>
                ))}
              </div>
              {addExSelected.cues && (
                <div className="wk-hint"><Info size={15} strokeWidth={2} aria-hidden="true" /><span><b>Form cue</b> · {addExSelected.cues}</span></div>
              )}
            </>
          ) : (
            /* The builder's search: aliases ("DB curl"), muscle and
               equipment chips, and "+" to add without opening the detail. */
            <ExerciseSearchList
              fallback={libList}
              addedIds={new Set(state.map((e) => e.exercise_id).filter(Boolean))}
              onPick={setAddExSelected}
              onQuickAdd={(x) => { if (!addExSaving) addExerciseToSession(x); }}
            />
          )}
        </div>
      </Sheet>

      <ShareWorkoutSheet
        open={shareSheetOpen}
        onClose={() => setShareSheetOpen(false)}
        workoutId={shareSheetData?.workoutId}
        workoutName={shareSheetData?.workoutName}
        exercises={shareSheetData?.exercises || []}
        t={{}}
      />
    </>
  );

  // ================= browse mode =================
  if (mode === 'browse') {
    return (
      <div className="wk">
        <header>
          <h1 className="wk-title">Today&rsquo;s Training</h1>
          <div className="wk-subtitle">
            {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
            {week.data?.program?.name ? ` · ${week.data.program.name}` : ''}
          </div>
        </header>

        {activeCardioPanel}

        <TodayHero
          workout={workout}
          meta={meta}
          focus={focus}
          suggestions={suggestions}
          u={u}
          starting={starting}
          onStart={startWorkout}
          onShare={shareToday}
          onAddCardio={openCardioPicker}
          onBuild={canBuild ? () => openBuilder() : null}
          onSaved={canBuild ? openSaved : null}
        />

        <WeekStrip
          rows={weekRows}
          todayDow={todayDow}
          doneDows={doneDows}
          programName={null}
          onPick={(d, i) => { setWeekDay(d); setWeekDayIdx(i); }}
        />

        <ToolGrid tools={tools} />
        {locked && (
          <p className="text-[12px] -mt-2" style={{ color: 'var(--faint)' }}>Your gym follows your coach&rsquo;s plan, so building your own sessions is turned off.</p>
        )}

        {workout && (
          <PlanList
            exercises={state}
            groups={groupsFromExercises(state)}
            equipMap={equipMap}
            suggestionByEx={suggestionByEx}
            infoEx={infoEx}
            onToggleInfo={(id) => setInfoEx(infoEx === id ? null : id)}
            u={u}
          />
        )}

        {/* Cardio queued for a session, waiting for Start. */}
        {cardioMode === 'browse' && cardioItems.length > 0 && (
          <section aria-label="Cardio session">
            <div className="wk-head">
              <span className="wk-h">Cardio session</span>
              <button className="wk-head__link" onClick={openCardioPicker}>Add more</button>
            </div>
            <div className="wk-cardio-list">
              {cardioItems.map((item, i) => (
                <div key={`${item.id}${i}`} className="wk-card wk-cardio-item">
                  <Activity size={18} strokeWidth={1.8} aria-hidden="true" style={{ color: 'var(--accent)', flex: 'none' }} />
                  <div className="wk-cardio-item__body">
                    <div className="wk-cardio-item__name truncate">{cardioName(item.id)}</div>
                    <div className="wk-cardio-item__meta">{cardioSummary(item) || 'Ready'}</div>
                  </div>
                  <button className="wk-iconbtn wk-iconbtn--sm" aria-label={`Remove ${cardioName(item.id)}`}
                    onClick={() => setCardioItems((prev) => prev.filter((_, j) => j !== i))}>
                    <X size={15} strokeWidth={2} aria-hidden="true" />
                  </button>
                </div>
              ))}
              <button className="btn-primary btn-block" onClick={startCardio}>
                <Play size={15} strokeWidth={2.4} fill="currentColor" aria-hidden="true" />Start cardio
              </button>
            </div>
          </section>
        )}

        {cardioMode === 'summary' && cardioResult && (
          <section className="wk-card p-4" aria-label="Cardio complete">
            <div className="flex items-center justify-between mb-3">
              <span className="wk-kicker">Cardio complete</span>
              <span className="font-grotesk font-bold tabular-nums" style={{ color: 'var(--accent)' }}>{cardioResult.totalCalories} kcal</span>
            </div>
            <div className="space-y-2.5">
              {cardioResult.items.map((item, i) => {
                const totalDur = (item.segments || []).reduce((s, seg) => s + seg.durationSec, 0);
                return (
                  <div key={i} className="rounded-xl border p-3" style={{ borderColor: 'var(--line)' }}>
                    <div className="flex items-center justify-between">
                      <span className="text-[13.5px] font-semibold" style={{ color: 'var(--ink)' }}>{cardioName(item.id)}</span>
                      <span className="text-[12.5px] font-semibold tabular-nums" style={{ color: 'var(--mute)' }}>{item.calories} kcal · {Math.round(totalDur / 60)} min</span>
                    </div>
                    {(item.segments || []).length > 1 && (
                      <ol className="wk-segments mt-1.5">
                        {item.segments.map((seg, j) => (
                          <li key={j}>Segment {j + 1} · {Math.round(seg.durationSec / 60)} min · {segmentParamsSummary(seg.params)}</li>
                        ))}
                      </ol>
                    )}
                  </div>
                );
              })}
            </div>
            <button onClick={dismissCardioSummary} className="btn btn-block mt-3">Done</button>
          </section>
        )}

        {!!hist.data?.workouts?.length && (
          <section aria-label="Recent sessions">
            <div className="wk-head">
              <span className="wk-h">Recent sessions</span>
              <SectionLink label="History" onClick={() => nav('/app/client/history')} />
            </div>
            <div className="wk-card p-2 space-y-1">
              {hist.data.workouts.filter((w) => w.id !== workout?.id).slice(0, 5).map((w) => (
                <SessionRow key={w.id} w={w} compact onOpen={() => nav(`/app/client/day/${w.scheduled_date}`)} />
              ))}
            </div>
          </section>
        )}

        {sheets}
        {toastEl}
      </div>
    );
  }

  // ================= the session =================
  if (mode === 'execute') {
    return (
      <div className="wk-session">
        <PlayerHeader
          name={workout?.name}
          elapsed={elapsed}
          paused={!!pausedAt}
          doneSets={doneSets}
          totalSets={totalSets}
          onPause={pauseWorkout}
          onResume={resumeWorkout}
        />

        <SortableExercises
          items={state}
          groups={groups}
          onMove={moveExercise}
          onToggleLink={toggleSuperset}
          edges={{ top: 96, bottom: 150 }}
          renderItem={(ex, sortProps) => (
            <ExerciseCard
              {...sortProps}
              ex={ex}
              sets={exSets[ex.id] || []}
              open={openEx === ex.id}
              u={u}
              suggestion={suggestionByEx[ex.id]}
              onToggleOpen={() => setOpenEx(openEx === ex.id ? null : ex.id)}
              onPatch={(i, field, value) => patchSet(ex.id, i, field, value)}
              onToggleSet={(i) => toggleSet(ex.id, i)}
              onAddSet={() => addSet(ex.id)}
              onAddDrop={() => addDropSet(ex.id)}
              onRemoveLast={() => removeSet(ex.id, (exSets[ex.id] || []).length - 1)}
              onUseTarget={(target) => {
                // The coach's progression, applied to every set still to do;
                // ticked sets keep what was actually lifted.
                (exSets[ex.id] || []).forEach((st, i) => {
                  if (st.done) return;
                  patchSet(ex.id, i, 'weight', target.weight);
                  if (target.reps) patchSet(ex.id, i, 'reps', target.reps);
                });
              }}
              onRemove={() => askRemoveExercise(ex)}
            />
          )}
        />

        {activeCardioPanel}

        <button className="wk-ghost wk-add" onClick={openAddExercise}>
          <Plus size={16} strokeWidth={2.2} aria-hidden="true" />Add exercise
        </button>

        <div className="wk-endbar">
          <Pressable onClick={() => finishWorkout()} disabled={submitting} className="btn-primary btn-lg btn-block">
            {submitting ? 'Saving…' : doneSets === 0 ? 'End session' : `Finish · ${doneSets} ${doneSets === 1 ? 'set' : 'sets'}`}
          </Pressable>
        </div>

        {sheets}
        {toastEl}
      </div>
    );
  }

  // ================= cardio on its own =================
  if (cardioMode === 'execute' && cardioActiveId && activeCardioItem) {
    return (
      <div className="wk-session">
        {activeCardioPanel}
        {sheets}
        {toastEl}
      </div>
    );
  }

  // ================= summary =================
  /* Two steps, not one screen.

     The old summary asked for intensity in a small panel wedged between the
     stat tiles and the calorie card, on a screen that also carried the burn
     range, the model's caveats, a source line, a cardio panel, a totals
     panel and three full-width buttons. The question was the easiest thing
     on it to miss, and skipping it is what leaves a session with no calorie
     figure at all.

     Now the celebration and the three headline numbers render instantly
     (nothing is withheld to force an answer -- that was the original
     objection to asking first, and it still stands), the question is the
     only decision on that screen, and the charted recap follows the tap.
     Skip is a real answer and lands on the same recap, minus the estimate.

     The backdrop is a CSS glow: decoration on a screen that must paint
     the moment the last set is logged, so it costs no three.js download. */
  const askIntensity = !!result?.workoutId && !!burnInput && !intensity && !intensitySkipped;
  return (
    <div className="space-y-4">
      <SessionRecap
        result={result}
        askIntensity={askIntensity}
        onPickIntensity={pickIntensity}
        onSkipIntensity={() => setIntensitySkipped(true)}
        intensity={intensity}
        burn={burn}
        burnLoading={burnLoading}
        burnSource={burnSource}
        cardioResult={cardioResult}
        cardioName={cardioName}
        u={u}
        backdrop={<div className="wk-recap-glow" aria-hidden="true" />}
        onShareWorkout={() => {
          /* result.* rather than the live workout.* -- see finishWorkout:
             `workout` is swapped out from under this screen by today.reload()
             while the summary is still mounted, so the live values would
             share the NEXT session instead of the one just completed. */
          setShareSheetData({ workoutId: result.workoutId, workoutName: result.name, exercises: result.exerciseList || [] });
          setShareSheetOpen(true);
        }}
        onShareCommunities={() => setShareCommunitiesFor(result.workoutId)}
        onDone={() => {
          clearActiveSession(); setMode('browse'); setResult(null); setExSets({}); setElapsed(0);
          setPausedAt(0); setAccumulatedPausedMs(0); setStartedAt(0); setExState(null); setGroups({}); setRemovedIds([]);
          setBurn(null); setBurnInput(null); setIntensity(null); setIntensitySkipped(false);
          setBurnSource(null); setSharing(false); setShareToast('');
          setCardioMode('browse'); setCardioResult(null); setCardioItems([]);
          setCardioActiveId(null); setCardioSegStart(0); setCardioElapsed(0);
        }}
      />
      {shareToast && (
        <div className="toast anim-toast">
          <span className="text-good mr-2"><CheckIcon /></span>{shareToast}
        </div>
      )}
      <ShareWorkoutSheet
        open={shareSheetOpen}
        onClose={() => setShareSheetOpen(false)}
        workoutId={shareSheetData?.workoutId}
        workoutName={shareSheetData?.workoutName}
        exercises={shareSheetData?.exercises || []}
        t={{}}
      />
      {shareCommunitiesFor && (
        <ShareToCommunitiesSheet
          workoutId={shareCommunitiesFor}
          onClose={() => setShareCommunitiesFor(null)}
          toast={setShareToast}
        />
      )}
    </div>
  );
}
