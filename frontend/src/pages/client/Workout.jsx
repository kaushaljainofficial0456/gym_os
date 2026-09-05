import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { Spinner, ErrorState, Bar, Ring } from '../../components/UI.jsx';
import MuscleMap, { regionForMuscle } from '../../components/MuscleMap.jsx';
import { Pressable } from '../../design/index.js';
const TunnelBackdrop = lazy(() => import('../../components/TunnelBackdrop.jsx'));
import ShareWorkoutSheet from '../../components/workout/ShareWorkoutSheet.jsx';

const REGION_IDS = new Set(['chest', 'shoulders', 'biceps', 'forearms', 'core', 'quads', 'calves', 'traps', 'triceps', 'lats', 'lower_back', 'glutes', 'hamstrings']);

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

// Progressive-discovery filters for the exercise picker. Region maps to the
// backend muscles.region model; equipment is a compact subset of the library's
// equipment vocabulary (functional kit like TRX/rings stays searchable by name).
const PICKER_REGIONS = [['', 'All'], ['chest', 'Chest'], ['back', 'Back'], ['shoulders', 'Shoulders'], ['arms', 'Arms'], ['legs', 'Legs'], ['core', 'Core']];
const PICKER_EQUIP = [['', 'All'], ['barbell', 'Barbell'], ['dumbbell', 'Dumbbell'], ['machine', 'Machine'], ['cable', 'Cable'], ['bodyweight', 'Bodyweight'], ['kettlebell', 'Kettlebell'], ['bands', 'Bands']];

function ChipRow({ options, value, onChange, label }) {
  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-0.5 px-0.5" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" onClick={() => onChange(v === value ? '' : v)}
          className={`chip shrink-0 !text-[10px] !px-2 !py-0.5 border transition-colors ${value === v ? 'border-gold/50 text-gold bg-gold/10' : 'border-line text-mute hover:text-ink'}`}>
          {text}
        </button>
      ))}
    </div>
  );
}

/**
 * The one exercise picker ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â search + region/equipment chips + result list.
 * Used by BOTH the "Build my workout" modal and the personal planner form so
 * they share the exact same alias-aware search (GET /workouts/exercises).
 * No text/filters => shows `fallback` (the cached full library).
 */
function ExerciseSearchList({ fallback, addedIds, onPick, dense }) {
  const [q, setQ] = useState('');
  const [region, setRegion] = useState('');
  const [equip, setEquip] = useState('');
  const [results, setResults] = useState(null); // null => show fallback
  const [loading, setLoading] = useState(false);
  const cache = useRef(new Map());

  useEffect(() => {
    const active = q.trim() || region || equip;
    if (!active) { setResults(null); setLoading(false); return undefined; }
    const key = `${q.trim().toLowerCase()}|${region}|${equip}`;
    if (cache.current.has(key)) { setResults(cache.current.get(key)); return undefined; }
    setLoading(true);
    const h = setTimeout(async () => {
      try {
        const p = new URLSearchParams();
        if (q.trim()) p.set('q', q.trim());
        if (region) p.set('region', region);
        if (equip) p.set('equipment', equip);
        const r = await api(`/workouts/exercises?${p.toString()}`);
        const list = r.exercises || [];
        cache.current.set(key, list);
        setResults(list);
      } catch { setResults([]); } finally { setLoading(false); }
    }, 250);
    return () => clearTimeout(h);
  }, [q, region, equip]);

  const list = results ?? (fallback || []);
  return (
    <div className="space-y-2">
      <input className="input" placeholder="Search exercisesÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ (e.g. DB curl, incline)" value={q} onChange={(e) => setQ(e.target.value)} />
      <ChipRow options={PICKER_REGIONS} value={region} onChange={setRegion} label="Filter by muscle group" />
      <ChipRow options={PICKER_EQUIP} value={equip} onChange={setEquip} label="Filter by equipment" />
      <div className={`space-y-1.5 ${dense ? 'max-h-40 overflow-y-auto pr-1' : ''}`}>
        {loading && <div className="text-[10px] text-mute px-1 py-1">SearchingÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦</div>}
        {!loading && !list.length && <div className="text-[11px] text-mute px-1 py-3 text-center">No exercises match ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â try fewer filters.</div>}
        {list.slice(0, 40).map((x) => {
          const added = addedIds?.has(x.id);
          return (
            <button key={x.id} type="button" disabled={added} onClick={() => onPick(x)}
              className={`w-full flex items-center justify-between gap-2 rounded-xl border bg-white/[.02] px-3 py-2.5 text-left transition-all active:scale-[.98] ${added ? 'border-line/40 opacity-50' : 'border-line hover:border-gold/30'}`}>
              <span className="min-w-0">
                <span className="block text-[13px] font-grotesk font-semibold truncate">{x.name}</span>
                <span className="text-[10px] text-mute">{x.primary_muscle || ''}{x.equipment ? ` Ãƒâ€šÃ‚Â· ${x.equipment}` : ''}</span>
              </span>
              {added && <span className="text-[10px] text-good shrink-0">ÃƒÂ¢Ã…â€œÃ¢â‚¬Å“</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ localStorage active-session marker ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

   The server's `started_at` can survive after a workout is completed or
   abandoned, so it must NOT be the sole evidence that this browser has
   an active session. A per-workout marker in localStorage is the local
   proof-of-life: it is created when the user starts a session and
   removed when they finish or dismiss it. */
const ACTIVE_SESSION_KEY = 'activeWorkoutSession';

function saveActiveSession(workoutId, startedAt) {
  try {
    localStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify({ workoutId, startedAt }));
  } catch { /* localStorage full or blocked ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â non-fatal */ }
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

/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Cardio helpers ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
   MET values for common cardio exercises at different intensities.
   Used for client-side calorie estimation: kcal = MET ÃƒÆ’Ã¢â‚¬â€ 3.5 ÃƒÆ’Ã¢â‚¬â€ weight_kg / 200 ÃƒÆ’Ã¢â‚¬â€ duration_min
   Based on Compendium of Physical Activities (Ainsworth et al.). */
const CARDIO_MET = {
  treadmill_run: { light: 6.0, moderate: 8.3, hard: 11.0 },
  running:       { light: 6.0, moderate: 8.3, hard: 11.0 },
  incline_walk:  { light: 3.5, moderate: 4.3, hard: 5.0 },
  walking:       { light: 2.8, moderate: 3.5, hard: 4.3 },
  cycling:       { light: 5.8, moderate: 7.5, hard: 10.0 },
  rowing_machine:{ light: 4.8, moderate: 7.0, hard: 12.0 },
  elliptical:    { light: 4.0, moderate: 5.0, hard: 7.0 },
  stair_climber: { light: 5.0, moderate: 8.0, hard: 11.0 },
  sprint_intervals:{ light: 8.0, moderate: 10.0, hard: 12.0 },
  jump_rope:     { light: 8.0, moderate: 10.0, hard: 12.3 },
  assault_bike:  { light: 7.0, moderate: 9.5, hard: 12.5 },
  ski_erg:       { light: 5.5, moderate: 8.0, hard: 11.0 },
  battle_ropes:  { light: 5.0, moderate: 8.0, hard: 10.5 },
};
const CARDIO_MET_DEFAULT = { light: 5.0, moderate: 7.0, hard: 10.0 };

/** Increase MET slightly when speed/incline/resistance are above moderate defaults.
    This gives a rough differentiation between light and moderate effort
    without requiring the user to explicitly rate intensity. */
function adjustedMet(cardioId, params) {
  const metTable = CARDIO_MET[cardioId] || CARDIO_MET_DEFAULT;
  const speed = Number(params?.speed) || 0;
  const incline = Number(params?.incline) || 0;
  const resistance = Number(params?.resistance) || 0;
  const level = Number(params?.level) || 0;
  // Simple heuristic: above-average values push toward hard tier
  const effortScore = (incline * 2) + (speed > 12 ? 3 : speed > 8 ? 1 : 0) + resistance + level;
  if (effortScore >= 14) return metTable.hard;
  if (effortScore >= 6) return metTable.moderate;
  return metTable.light;
}

/** Which parameters each cardio exercise type requires. */
function cardioExerciseConfig(id) {
  const configs = {
    treadmill_run:  [{ key: 'incline', label: 'Incline', unit: '%', placeholder: '5', min: 0, max: 20 },
                    { key: 'speed', label: 'Speed', unit: 'km/h', placeholder: '8', min: 1, max: 25 }],
    running:        [{ key: 'speed', label: 'Pace/Speed', unit: 'km/h', placeholder: '10', min: 1, max: 30 },
                    { key: 'distance', label: 'Distance', unit: 'km', placeholder: '3', min: 0.1, max: 50 }],
    incline_walk:   [{ key: 'incline', label: 'Incline', unit: '%', placeholder: '10', min: 0, max: 20 },
                    { key: 'speed', label: 'Speed', unit: 'km/h', placeholder: '5', min: 1, max: 15 }],
    walking:        [{ key: 'speed', label: 'Speed', unit: 'km/h', placeholder: '5', min: 1, max: 15 },
                    { key: 'distance', label: 'Distance', unit: 'km', placeholder: '2', min: 0.1, max: 30 }],
    cycling:        [{ key: 'resistance', label: 'Resistance', unit: 'level', placeholder: '6', min: 1, max: 25 },
                    { key: 'speed', label: 'Speed', unit: 'km/h', placeholder: '25', min: 5, max: 60 }],
    rowing_machine: [{ key: 'resistance', label: 'Resistance', unit: 'level', placeholder: '5', min: 1, max: 20 },
                    { key: 'pace', label: 'Pace', unit: 'min/500m', placeholder: '2:30', min: 0 }],
    elliptical:     [{ key: 'resistance', label: 'Resistance', unit: 'level', placeholder: '8', min: 1, max: 25 }],
    stair_climber:  [{ key: 'level', label: 'Level', unit: '', placeholder: '10', min: 1, max: 25 }],
    sprint_intervals:[{ key: 'speed', label: 'Speed', unit: 'km/h', placeholder: '15', min: 5, max: 30 }],
    jump_rope:      [{ key: 'speed', label: 'Speed', unit: 'RPM', placeholder: '120', min: 30, max: 200 }],
    assault_bike:   [{ key: 'resistance', label: 'Resistance', unit: 'level', placeholder: '6', min: 1, max: 20 }],
    ski_erg:        [{ key: 'resistance', label: 'Resistance', unit: 'level', placeholder: '6', min: 1, max: 10 }],
    battle_ropes:   [{ key: 'speed', label: 'Speed', unit: 'slams/min', placeholder: '30', min: 10, max: 80 }],
  };
  return configs[id] || [{ key: 'speed', label: 'Intensity', unit: '', placeholder: '', min: 0, max: 999 }];
}

/** Calculate calorie burn for a single cardio item using MET formula. */
function calcCardioCalories(cardioId, durationMin, bodyWeightKg) {
  const metTable = CARDIO_MET[cardioId] || CARDIO_MET_DEFAULT;
  const met = metTable.moderate;
  const weight = Number(bodyWeightKg) || 70;
  return Math.round(met * 3.5 * weight / 200 * durationMin);
}

/** Get the display name for a cardio exercise by its id. */
function cardioName(id) {
  const NAMES = {
    treadmill_run: 'Treadmill Run', running: 'Running', incline_walk: 'Incline Walk',
    walking: 'Walking', cycling: 'Cycling', rowing_machine: 'Rowing',
    elliptical: 'Elliptical', stair_climber: 'Stair Climber',
    sprint_intervals: 'Sprint Intervals', jump_rope: 'Jump Rope',
    assault_bike: 'Assault Bike', ski_erg: 'Ski Erg', battle_ropes: 'Battle Ropes',
  };
  return NAMES[id] || id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

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
  return parts.join(' Ãƒâ€šÃ‚Â· ') || '';
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
  return parts.join(' Ãƒâ€šÃ‚Â· ') || '';
}

/** Format a time in seconds as mm:ss. */
function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Calculate total calories for a completed cardio item from its segments.
    Each segment uses its own params + duration for calorie calc.
    The item must have segments[] with { durationSec, params }. */
function calcCardioItemCalories(item, bodyWeightKg) {
  if (!item?.segments?.length) return 0;
  return item.segments.reduce((sum, seg) => {
    const durMin = Math.max(0.1, (seg.durationSec || 0) / 60);
    const met = adjustedMet(item.id, seg.params);
    const weight = Number(bodyWeightKg) || 70;
    return sum + Math.round(met * 3.5 * weight / 200 * durMin);
  }, 0);
}

/** Calculate in-progress calories for a running segment. */
function calcCurrentSegmentCalories(item, elapsedSec, bodyWeightKg) {
  if (!item || elapsedSec <= 0) return 0;
  const durMin = elapsedSec / 60;
  const met = adjustedMet(item.id, item.currentParams);
  const weight = Number(bodyWeightKg) || 70;
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
  const nav = useNavigate();
  const today = useFetch(() => api('/tracking/me/today'));
  const week = useFetch(() => api('/tracking/me/week'));
  const hist = useFetch(() => api('/tracking/me/workouts'));
  const perms = useFetch(() => api('/me/permissions'));
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [muscleFilter, setMuscleFilter] = useState(null);
  const [exState, setExState] = useState(null);
  const [toast, setToast] = useState('');
  // build-my-workout ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â one-shot "save today's session" modal (uses /me/workouts)
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderName, setBuilderName] = useState('');
  const [builderExs, setBuilderExs] = useState([]); // {exercise_id, name, muscle, sets, reps, weight}
  const [libList, setLibList] = useState(null);
  const [savingBuilder, setSavingBuilder] = useState(false);
  const [selectedLibEx, setSelectedLibEx] = useState(null); // exercise selected in Build Today detail view
  const [justAdded, setJustAdded] = useState(null); // exercise ID just added ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â triggers confirmation animation
  // in-session add-exercise picker (only visible during execute mode)
  const [addExOpen, setAddExOpen] = useState(false);
  const [addExSearch, setAddExSearch] = useState('');
  const [addExSelected, setAddExSelected] = useState(null); // library exercise selected in detail view
  const [addExSaving, setAddExSaving] = useState(false);
  // personal workout planner ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â reusable workouts + weekly schedule (uses /me/planner)
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
  const [burnInput, setBurnInput] = useState(null); // { duration_minutes, exercises } captured at finish, sent once intensity is answered
  const [intensity, setIntensity] = useState(null);
  const [sharing, setSharing] = useState(false);
  const [shareToast, setShareToast] = useState(''); // 'light' | 'moderate' | 'hard' ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â post-session rating, required by the model
  // Workout link sharing (personal share, NOT community)
  const [shareSheetOpen, setShareSheetOpen] = useState(false);
  const [shareSheetData, setShareSheetData] = useState(null); // { workoutId, workoutName, exercises } (see ml/docs/SESSION_INTENSITY_DESIGN_NOTE.md)
  const [burnLoading, setBurnLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0); // ticking elapsed seconds during execute mode
  const [pausedAt, setPausedAt] = useState(0); // timestamp when pause began (0 = not paused)
  const [accumulatedPausedMs, setAccumulatedPausedMs] = useState(0); // total paused time so far
  // this week preview
  const [weekDay, setWeekDay] = useState(null); // { label, name, focus, exercises }
  const [weekDayIdx, setWeekDayIdx] = useState(0);

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ cardio state (segment-aware) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
  // items: [{ id, segments: [{ params, durationSec }], currentParams }]
  // activeId: id of exercise currently running (null if not active)
  // activeSegmentStart: Date.now() when the current segment started
  const [cardioItems, setCardioItems] = useState([]);
  const [cardioMode, setCardioMode] = useState('browse');      // browse | execute | summary
  const [cardioOpen, setCardioOpen] = useState(false);
  const [cardioSearch, setCardioSearch] = useState('');
  const [cardioConfigItem, setCardioConfigItem] = useState(null);
  const [cardioActiveId, setCardioActiveId] = useState(null);  // which exercise is currently running
  const [cardioSegStart, setCardioSegStart] = useState(0);    // Date.now() when current segment started
  const [cardioElapsed, setCardioElapsed] = useState(0);      // total elapsed seconds for the active exercise
  const [cardioResult, setCardioResult] = useState(null);     // { totalCalories, items: [...] }
  const [clientWeight, setClientWeight] = useState(null);     // fetched from /me/profile for calorie calc

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

  /* Persist the checklist as it changes.

     Debounced at 800 ms: ticking four sets in quick succession should cost
     one request, not four. Fire-and-forget on purpose -- a failed save must
     never interrupt someone mid-set, and the next tick retries implicitly
     by sending the whole checklist rather than a delta.

     Also persists accumulatedPausedMs so a page-refresh during a paused
     session can restore the correct active-duration baseline. */
  useEffect(() => {
    if (mode !== 'execute' || !workout?.id) return undefined;
    const h = setTimeout(() => {
      // paused_ms is stored inside the progress blob so it survives
      // a page-refresh (the progress endpoint stores this as opaque JSON).
      api(`/workouts/${workout.id}/progress`, {
        method: 'PUT',
        body: JSON.stringify({
          progress: { ...exSets, __paused_ms: accumulatedPausedMs },
        }),
      }).catch(() => {});
    }, 800);
    return () => clearTimeout(h);
  }, [exSets, accumulatedPausedMs, mode, workout?.id]);

  // session elapsed timer ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â ticks every second during execute mode
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

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ cardio timer ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â ticks every second while an exercise is active ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
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

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ fetch client weight for cardio calorie calculation ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
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
      // CASE 6: completed workout ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â never restore, clean up any stale marker
      clearActiveSession();
      return;
    }
    if (!workout.started_at) return;

    // Check for a valid local active-session marker
    const session = getActiveSession();
    if (!session || session.workoutId !== workout.id) {
      // CASE 5: no local marker or different workout ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â do NOT restore
      // CASE 7: marker is for a different workout ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â ignore it
      clearActiveSession();
      return;
    }
    // Valid local session found for this workout ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â proceed with restore
    // Workout was already started server-side but user refreshed ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â restore execution state
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
    const fresh = buildSets(state);
    // Merge rather than trust the draft wholesale: the plan may have been
    // edited since, so the prescribed set COUNT comes from the plan and only
    // the per-set values come from the draft.
    const merged = Object.fromEntries(Object.entries(fresh).map(([exId, rows]) => [
      exId,
      rows.map((row, i) => (restored?.[exId]?.[i] ? { ...row, ...restored[exId][i] } : row)),
    ]));
    setExSets(merged);
    const firstUnfinished = state.find((e) => (merged[e.id] || []).some((r) => !r.done));
    setOpenEx((firstUnfinished || state[0])?.id ?? null);
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
      // silent: true -- same fix as Nutrition.jsx's own reload() calls
      // (see utils.js's useFetch): a bare reload() flips `loading` back
      // to true and this page's own `if (today.loading || ...) return
      // <Spinner/>` (below) would swap the ENTIRE returned tree to just
      // that spinner, unmounting everything under it -- including an
      // in-progress execute-mode session with its own local set/rep
      // state -- for the duration of the background refetch.
      today.reload({ silent: true }); hist.reload({ silent: true });
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

  if (today.loading || week.loading || hist.loading || perms.loading) return <Spinner label="Loading your sessionÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦" />;
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
      // POST /api/workouts/:id/start ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â no body; server is authoritative for timing.
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
    // API succeeded ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â proceed with local timer/UI
    setExSets(buildSets(state));
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

  // ---- remove exercise from active session ----
  const removeExercise = (exId) => {
    setExState((prev) => (prev || state).filter((e) => e.id !== exId));
    setExSets((prev) => {
      const next = { ...prev };
      delete next[exId];
      return next;
    });
    // If the removed exercise was the open accordion, close it
    if (openEx === exId) setOpenEx(null);
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
      setAddExSearch('');
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
        clearActiveSession();
        setMode('browse');
        setToast('Session ended ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â no sets were logged');
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
      // duration_min from server uses our active duration_seconds when provided.
      // Fall back to local active duration if backend did not compute it.
      const durationMin = res.duration_min ?? Math.max(1, Math.round(activeMs / 60000));
      setResult({ prs: res.prs || [], volume, durationMin, exercises: state.length, calorie: res.calorie || null });
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
  const pickIntensity = async (tier) => {
    if (!burnInput || burnLoading) return;
    setIntensity(tier);
    setBurnLoading(true);
    try {
      const res = await api('/intel/workout-burn', {
        method: 'POST',
        body: JSON.stringify({ ...burnInput, intensity: tier }),
      });
      setBurn(res);
    } catch {
      setBurn(null); // 422 = model declined; show nothing
    }
    setBurnLoading(false);
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
      return null; // no more exercises ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â will trigger summary
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
    setCardioResult({
      totalCalories,
      items: cardioItems.map((item) => ({
        ...item,
        calories: calcCardioItemCalories(item, clientWeight),
      })),
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

  // ================= browse mode =================
  if (mode === 'browse') {
    return (
      <div className="space-y-5 pb-2">

        {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ 1. THIS WEEK ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
        {weekRows.length > 0 && (
          <div className="card p-4 anim-fadeUp" style={{ animationDelay: '0ms' }}>
            <div className="flex items-center justify-between mb-3">
              <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk">This week Ãƒâ€šÃ‚Â· {week.data?.program?.name || 'Your plan'}</div>
              <span className="chip border-gold/30 text-gold !text-[9px]">{weekRows.filter((d) => d.name !== 'Rest').length} training days</span>
            </div>
            <div className="grid grid-cols-7 gap-1.5">
              {weekRows.map((d, i) => {
                const isToday = d.day_of_week === todayDow;
                const isRest = d.name === 'Rest';
                return (
                  <button key={d.day_of_week} onClick={() => { setWeekDay(d); setWeekDayIdx(i); }}
                    // Was bg-white/[.02] (+hover:bg-white/[.05]): a wash this
                    // faint is invisible against the .card it sits inside on
                    // the light theme (already solid white), so these pills
                    // had no visible tile boundary at all -- just floating
                    // text. --panel2 is a step up from --panel specifically
                    // for this kind of nesting (see theme.css).
                    className={`rounded-xl border px-1 py-2 text-center transition-all active:scale-95 ${isToday ? 'border-gold/60 bg-gold/10 shadow-lg shadow-ember/10' : isRest ? 'border-line opacity-60' : 'border-line hover:brightness-95'}`}
                    style={isToday ? undefined : { background: 'var(--panel2)' }}>
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

        {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ 2. MY WORKOUT ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â 3 action cards ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
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
            <div className="text-[10px] text-faint mt-2 font-grotesk">Your gym has locked workout creation ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â follow your coach's plan.</div>
          )}
        </div>

        {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ 3. TODAY'S TRAINING ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
        {workout ? (
          <div className="anim-fadeUp" style={{ animationDelay: '120ms' }}>
            {/* Share Workout ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â top-right icon */}
            <div className="flex items-center justify-between mb-2">
              <div>
                <div className="kicker">Today's training</div>
                <h1 className="font-grotesk font-bold text-2xl leading-tight">{workout.name}</h1>
              </div>
              <button onClick={() => { setShareSheetData({ workoutId: workout.id, workoutName: workout.name, exercises }); setShareSheetOpen(true); }}
                className="w-10 h-10 rounded-xl grid place-items-center transition-all active:scale-90"
                style={{ background: 'var(--panel2, var(--panel))', border: '1px solid var(--line)', color: 'var(--ink)' }}
                aria-label="Share Workout">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
                  <path d="M8.6 10.5 15.4 6.5M8.6 13.5 15.4 17.5" />
                </svg>
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
                ['Approx. time', meta.estMinutes ? `${meta.estMinutes} min` : 'ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â']
              ].map(([l, v]) => (
                <div key={l} className="card !p-3 text-center">
                  <div className="font-grotesk font-bold text-lg">{v}</div>
                  <div className="text-[9px] uppercase tracking-wider text-mute font-grotesk mt-0.5">{l}</div>
                </div>
              ))}
            </div>
            {/* Start Session + Add Cardio */}
            <div className="flex gap-2.5 mt-3">
              <button data-start-workout className="btn-primary flex-1 !py-2.5 !text-xs active:scale-95" onClick={startWorkout} disabled={!exercises.length || starting}>
                {starting ? 'StartingÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦' : 'START SESSION'}
              </button>
              <button
                onClick={() => {
                  setCardioOpen(true);
                  setCardioSearch('');
                  setCardioConfigItem(null);
                }}
                className="flex-1 !py-2.5 !text-xs active:scale-95 rounded-xl font-grotesk font-bold transition-all flex items-center justify-center gap-1.5"
                style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent)', color: 'var(--accent)' }}>
                + ADD CARDIO
              </button>
            </div>
          </div>
        ) : (
          <div className="card p-10 text-center anim-fadeUp" style={{ animationDelay: '120ms' }}>
            <div className="font-grotesk font-bold text-lg">Rest day</div>
            <div className="text-xs text-mute mt-1.5 max-w-xs mx-auto">No session scheduled for today. Recovery is training too ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â fuel well and sleep 8 hours.</div>
            <button
              onClick={() => {
                setCardioOpen(true);
                setCardioSearch('');
                setCardioConfigItem(null);
              }}
              className="mt-4 px-4 py-2 rounded-xl font-grotesk text-xs font-bold transition-all active:scale-95"
              style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent)', color: 'var(--accent)' }}>
              + ADD CARDIO
            </button>
            <div className="mt-4 text-[10px] uppercase tracking-widest text-gold font-grotesk">Next session appears here tomorrow</div>
          </div>
        )}

        {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ 4. TODAY'S EXERCISES ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
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
                          <span className="chip border-warn/40 text-warn bg-warn/10 !px-1.5 !py-0 text-[9px] shrink-0" title={`Needs: ${equipMap[ex.id].required.join(', ')}`}>ÃƒÂ¢Ã…Â¡Ã‚Â  equipment</span>
                        )}
                      </div>
                      <div className="text-[11px] mt-0.5" style={{ color: 'var(--mute)' }}>
                        {ex.sets} sets Ãƒâ€šÃ‚Â· {ex.reps} reps{ex.weight ? ` Ãƒâ€šÃ‚Â· ${ex.weight}` : ''}
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

        {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ 4b. CARDIO SESSION ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
        {cardioMode === 'browse' && (
          <div className="anim-fadeUp" style={{ animationDelay: '220ms' }}>
            {/* Cardio items added */}
            {cardioItems.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="kicker">Cardio session</div>
                  <button
                    onClick={() => {
                      setCardioOpen(true);
                      setCardioSearch('');
                      setCardioConfigItem(null);
                    }}
                    className="text-[11px] font-grotesk font-semibold active:scale-95"
                    style={{ color: 'var(--accent)' }}>
                    + Add more
                  </button>
                </div>
                {cardioItems.map((item, i) => (
                  <div key={i} className="card !p-3.5 flex items-center gap-3 anim-fadeUp" style={{ animationDelay: `${230 + i * 30}ms` }}>
                    <div className="w-9 h-9 rounded-xl grid place-items-center shrink-0" style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent)' }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-grotesk text-[13px] font-semibold truncate" style={{ color: 'var(--ink)' }}>{cardioName(item.id)}</div>
                      <div className="text-[10px]" style={{ color: 'var(--mute)' }}>{cardioSummary(item)}</div>
                    </div>
                    <button
                      onClick={() => setCardioItems((prev) => prev.filter((_, j) => j !== i))}
                      className="w-7 h-7 rounded-lg grid place-items-center shrink-0 active:scale-90"
                      style={{ color: 'var(--faint)' }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  </div>
                ))}
                <button
                  onClick={startCardio}
                  className="w-full py-2.5 rounded-xl font-grotesk text-[12px] font-bold tracking-wide active:scale-[.97] transition-all"
                  style={{ background: 'var(--accent)', color: 'var(--bg)' }}>
                  START CARDIO
                </button>
              </div>
            )}
            {cardioItems.length === 0 && (
              <button
                onClick={() => {
                  setCardioOpen(true);
                  setCardioSearch('');
                  setCardioConfigItem(null);
                }}
                className="w-full text-center py-3 text-[12px] font-grotesk font-semibold rounded-xl border border-dashed transition-all active:scale-[.98]"
                style={{ borderColor: 'var(--line)', color: 'var(--faint)' }}>
                + Add Cardio
              </button>
            )}
          </div>
        )}

        {/* Cardio summary (after completing) */}
        {cardioMode === 'summary' && cardioResult && (
          <div className="card p-4 anim-fadeUp" style={{ animationDelay: '0ms' }}>
            <div className="flex items-center justify-between mb-3">
              <div className="text-[10px] uppercase tracking-[.14em] font-grotesk" style={{ color: 'var(--faint)' }}>Cardio complete</div>
              <div className="font-grotesk font-bold" style={{ color: 'var(--accent)' }}>{cardioResult.totalCalories} kcal</div>
            </div>
            <div className="space-y-3">
              {cardioResult.items.map((item, i) => {
                const totalDur = (item.segments || []).reduce((s, seg) => s + seg.durationSec, 0);
                return (
                  <div key={i} className="rounded-xl border border-line/40 p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-grotesk text-[12px] font-bold" style={{ color: 'var(--ink)' }}>{cardioName(item.id)}</span>
                      <span className="font-grotesk text-[11px] font-bold" style={{ color: 'var(--accent)' }}>{item.calories} kcal Ãƒâ€šÃ‚Â· {Math.round(totalDur / 60)} min</span>
                    </div>
                    {(item.segments || []).length > 0 && (
                      <div className="space-y-1 mt-1.5">
                        {item.segments.map((seg, j) => (
                          <div key={j} className="flex items-center justify-between text-[10px]" style={{ color: 'var(--faint)' }}>
                            <span>Segment {j + 1} Ãƒâ€šÃ‚Â· {Math.round(seg.durationSec / 60)} min Ãƒâ€šÃ‚Â· {segmentParamsSummary(seg.params)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <button onClick={dismissCardioSummary} className="btn w-full mt-3 !text-xs">Done</button>
          </div>
        )}

        {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ 4c. ACTIVE CARDIO TIMER (visible in browse mode when cardio is running) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
        {cardioMode === 'execute' && cardioActiveId && activeCardioItem && (
          <div className="card p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-[.18em]" style={{ color: 'var(--faint)' }}>Cardio Ãƒâ€šÃ‚Â· {cardioName(cardioActiveId)}</div>
                <div className="font-black tabular-nums leading-none mt-1" style={{ fontSize: 30, color: 'var(--ink)' }}>
                  {String(Math.floor(cardioElapsed / 60)).padStart(2, '0')}:{String(cardioElapsed % 60).padStart(2, '0')}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-[.18em]" style={{ color: 'var(--faint)' }}>Est. burn</div>
                <div className="font-black tabular-nums leading-none mt-1" style={{ fontSize: 18, color: 'var(--accent)' }}>
                  ~{totalCardioCals} <span className="text-[11px]" style={{ color: 'var(--mute)' }}>kcal</span>
                </div>
              </div>
            </div>
            <div className="rounded-xl p-3" style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent)' }}>
              <div className="text-[10px] uppercase tracking-[.12em] mb-2" style={{ color: 'var(--faint)' }}>Current settings</div>
              <div className="flex flex-wrap gap-2">
                {cardioExerciseConfig(cardioActiveId).map((field) => (
                  <div key={field.key} className="flex items-center gap-1.5">
                    <span className="text-[11px] font-grotesk" style={{ color: 'var(--mute)' }}>{field.label}:</span>
                    <span className="text-[11px] font-grotesk font-bold" style={{ color: 'var(--ink)' }}>{activeCardioItem.currentParams?.[field.key] || 'ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â'}</span>
                    {field.unit && <span className="text-[9px]" style={{ color: 'var(--faint)' }}>{field.unit}</span>}
                  </div>
                ))}
              </div>
            </div>
            {(activeCardioItem.segments || []).length > 0 && (
              <div className="space-y-1">
                <div className="text-[10px] uppercase tracking-[.12em]" style={{ color: 'var(--faint)' }}>Segments ({activeCardioItem.segments.length})</div>
                {activeCardioItem.segments.map((seg, i) => (
                  <div key={i} className="flex items-center justify-between text-[10px]" style={{ color: 'var(--faint)' }}>
                    <span>Seg {i + 1} Ãƒâ€šÃ‚Â· {Math.round(seg.durationSec / 60)} min Ãƒâ€šÃ‚Â· {segmentParamsSummary(seg.params)}</span>
                  </div>
                ))}
              </div>
            )}
            <div id="cardioAdjustBrowse" className="rounded-xl border border-line p-3 space-y-2">
              <div className="text-[10px] uppercase tracking-[.12em]" style={{ color: 'var(--faint)' }}>Adjust settings</div>
              <div className="grid grid-cols-2 gap-2">
                {cardioExerciseConfig(cardioActiveId).map((field) => (
                  <div key={field.key} className="flex items-center gap-1.5">
                    <label className="text-[10px] font-grotesk shrink-0" style={{ color: 'var(--mute)' }}>{field.label}</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      className="input flex-1 !py-1 !text-[11px]"
                      placeholder={field.placeholder}
                      defaultValue={activeCardioItem.currentParams?.[field.key] || ''}
                      id={`adjBrowse_${field.key}`}
                    />
                    {field.unit && <span className="text-[9px] shrink-0" style={{ color: 'var(--faint)' }}>{field.unit}</span>}
                  </div>
                ))}
              </div>
              <button
                onClick={() => {
                  const newParams = {};
                  cardioExerciseConfig(cardioActiveId).forEach((field) => {
                    const el = document.getElementById(`adjBrowse_${field.key}`);
                    if (el && el.value) newParams[field.key] = el.value;
                  });
                  const cur = activeCardioItem.currentParams || {};
                  const changed = Object.keys(newParams).some((k) => String(newParams[k]) !== String(cur[k]));
                  if (changed) {
                    adjustCardioSettings(newParams);
                    setToast('Settings updated ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â new segment started');
                  }
                }}
                className="w-full py-1.5 rounded-lg text-[10px] font-grotesk font-bold border transition-all active:scale-[.98]"
                style={{ borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' }}>
                ADJUST SETTINGS
              </button>
            </div>
            <button
              onClick={endCardio}
              className="w-full py-2.5 rounded-xl text-[12px] font-grotesk font-bold active:scale-[.97] transition-all"
              style={{ background: 'var(--accent)', color: 'var(--bg)' }}>
              END CARDIO Ãƒâ€šÃ‚Â· {Math.round(cardioElapsed / 60)} min
            </button>
          </div>
        )}

        {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ 5. RECENT SESSIONS ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
        {!!hist.data?.workouts?.length && (
          <div className="card p-4 anim-fadeUp" style={{ animationDelay: '260ms' }}>
            <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk mb-2.5">Recent sessions</div>
            <div className="space-y-1.5">
              {hist.data.workouts.filter((w) => w.id !== workout?.id).slice(0, 5).map((w) => (
                <button key={w.id}
                  onClick={() => nav(`/app/client/day/${w.scheduled_date}`)}
                  className="w-full flex items-center justify-between text-xs border-b border-line/50 last:border-0 py-2 active:scale-[.98] transition-all text-left">
                  <span className="font-grotesk font-semibold truncate">{w.name}</span>
                  <span className="text-mute shrink-0 ml-2">{w.scheduled_date}</span>
                  <span className={`chip border shrink-0 ml-2 ${w.status === 'completed' ? 'text-good border-good/40 bg-good/10' : 'text-warn border-warn/40 bg-warn/10'}`}>{w.status === 'completed' ? 'DONE' : w.status.toUpperCase()}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚Â BUILD TODAY MODAL ÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚Â */}
        {builderOpen && (
          <div className="fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm grid place-items-center p-4 anim-fadeIn">
            <div className="card w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden anim-scaleIn">
              <div className="p-4 border-b border-line/60 flex items-center justify-between">
                <div>
                  <div className="font-grotesk font-bold">Build my workout</div>
                  <div className="text-[10px] text-mute">Picks any exercises ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â saves as today's session</div>
                </div>
                <button className="text-mute hover:text-ink text-lg active:scale-90" onClick={() => { setBuilderOpen(false); setSelectedLibEx(null); setJustAdded(null); }} aria-label="Close">ÃƒÂ¢Ã…â€œÃ¢â‚¬Â¢</button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                <input className="input" placeholder="Workout name (e.g. My Upper Day)" value={builderName} onChange={(e) => setBuilderName(e.target.value)} />

                {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ keyed wrapper for smooth content transitions ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
                <div key={selectedLibEx?.id || '__library__'} className="anim-slideUp">
                {selectedLibEx ? (
                  /* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ exercise detail view ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */
                  <div className="space-y-3">
                    <button onClick={() => setSelectedLibEx(null)} className="btn !text-xs !py-1.5 active:scale-95">ÃƒÂ¢Ã¢â‚¬Â Ã‚Â Back to library</button>

                    {/* Exercise name + Add button ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â top row */}
                    <div className="flex items-start justify-between gap-3 anim-slideUp" style={{ animationDelay: '50ms' }}>
                      <div className="flex-1 min-w-0">
                        <div className="font-grotesk font-bold text-lg leading-tight">{selectedLibEx.name}</div>
                      </div>
                      <button
                        className={`shrink-0 px-4 py-2 rounded-xl font-grotesk text-xs font-bold transition-all active:scale-95 ${justAdded === selectedLibEx.id ? 'anim-confirmPulse' : ''}`}
                        style={builderExs.some((b) => b.exercise_id === selectedLibEx.id)
                          ? { background: 'var(--good)', color: 'var(--bg)' }
                          : { background: 'var(--accent)', color: 'var(--bg)' }}
                        disabled={builderExs.some((b) => b.exercise_id === selectedLibEx.id)}
                        onClick={() => {
                          setJustAdded(selectedLibEx.id);
                          setTimeout(() => setJustAdded(null), 500);
                          setBuilderExs((b) => [...b, { exercise_id: selectedLibEx.id, name: selectedLibEx.name, muscle: selectedLibEx.primary_muscle, sets: 3, reps: '10', weight: 'BW' }]);
                          setTimeout(() => setSelectedLibEx(null), 350);
                        }}>
                        {builderExs.some((b) => b.exercise_id === selectedLibEx.id) ? 'ÃƒÂ¢Ã…â€œÃ¢â‚¬Å“ Added' : '+ Add'}
                      </button>
                    </div>

                    {/* Short description */}
                    <div className="anim-slideUp" style={{ animationDelay: '100ms' }}>
                      <p className="text-[12px] leading-relaxed" style={{ color: 'var(--mute)' }}>
                        {selectedLibEx.instructions
                          || `${selectedLibEx.movement === 'compound' ? 'Compound' : 'Isolation'} ${selectedLibEx.movement?.replace(/_/g, ' ') || ''} movement targeting the ${(selectedLibEx.primary_muscle || '').replace(/_/g, ' ').toLowerCase()}${selectedLibEx.secondary_muscles ? `, also engaging the ${selectedLibEx.secondary_muscles.replace(/,/g, ' ').replace(/_/g, ' ').toLowerCase()}` : ''}.`}
                      </p>
                    </div>

                    {/* Primary / Secondary / Equipment */}
                    <div className="grid grid-cols-3 gap-2 anim-slideUp" style={{ animationDelay: '150ms' }}>
                      {[
                        ['Primary', selectedLibEx.primary_muscle || 'ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â'],
                        ['Secondary', (selectedLibEx.secondary_muscles || 'ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â').replace(/,/g, ' Ãƒâ€šÃ‚Â· ')],
                        ['Equipment', selectedLibEx.equipment || 'ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â']
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
                  </div>
                ) : (
                  /* search + region/equipment chips + exercise library list */
                  <ExerciseSearchList
                    fallback={libList}
                    addedIds={new Set(builderExs.map((b) => b.exercise_id))}
                    onPick={(x) => setSelectedLibEx(x)}
                  />

                )}
                </div>

                {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ MY SESSION ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â exercises added ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
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
                        <div className="text-[9px] text-faint mt-1 font-grotesk">sets Ãƒâ€šÃ‚Â· reps Ãƒâ€šÃ‚Â· weight</div>
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
                      today.reload({ silent: true }); hist.reload({ silent: true });
                    } catch (e) { setToast(e.message); }
                    setSavingBuilder(false);
                  }}>
                  {savingBuilder ? 'SavingÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦' : 'Save as today\'s session'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚Â PERSONAL WORKOUT PLANNER MODAL ÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚Â */}
        {plannerOpen && (
          <div className="fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm grid place-items-center p-4 anim-fadeIn">
            <div className="card w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden anim-scaleIn">
              <div className="p-4 border-b border-line/60 flex items-center justify-between">
                <div>
                  <div className="font-grotesk font-bold">My workouts</div>
                  <div className="text-[10px] text-mute">Reusable sessions + your weekly plan</div>
                </div>
                <button className="text-mute hover:text-ink text-lg" onClick={() => setPlannerOpen(false)} aria-label="Close">ÃƒÂ¢Ã…â€œÃ¢â‚¬Â¢</button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {/* weekly schedule */}
                <div>
                  <div className="text-[10px] text-faint font-grotesk uppercase tracking-wider mb-2">MY WEEK ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â tap a day to assign</div>
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
                      <button className="text-[10px] text-mute" onClick={() => setPlanForm(null)}>ÃƒÂ¢Ã¢â‚¬Â Ã‚Â Back</button>
                    </div>
                    <input className="input" placeholder="Workout name (e.g. Push A, Legs, My Upper Day)" value={planForm.name || ''} onChange={(e) => setPlanForm((f) => ({ ...f, name: e.target.value }))} />
                    <ExerciseSearchList
                      dense
                      fallback={libList}
                      addedIds={new Set((planForm.exercises || []).map((b) => b.exercise_id))}
                      onPick={(x) => setPlanForm((f) => ({ ...f, exercises: [...(f.exercises || []), { exercise_id: x.id, name: x.name, muscle: x.primary_muscle, sets: 3, reps: '10', weight: 'BW', rest_sec: 90 }] }))}
                    />
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
                        <div className="text-[8px] text-faint mt-1 font-grotesk">sets Ãƒâ€šÃ‚Â· reps Ãƒâ€šÃ‚Â· weight Ãƒâ€šÃ‚Â· rest(s)</div>
                      </div>
                    ))}
                    <button className="btn-primary w-full !py-2.5 !text-xs" disabled={savingPlan || !planForm?.name?.trim() || !planForm?.exercises?.length} onClick={savePlan}>
                      {savingPlan ? 'SavingÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦' : (planForm.id ? 'Save changes' : 'Create workout')}
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

                          <div className="text-xs text-mute">No saved workouts yet ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â create one, then assign it to your week.</div>
                        </div>
                      )}
                      {(planner?.workouts || []).map((w) => (
                        <div key={w.id} className="rounded-xl border border-line bg-white/[.02] p-3">
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="font-grotesk text-[13px] font-semibold truncate">{w.name}</div>
                              <div className="text-[10px] text-mute">{(w.exercises || []).length} exercises Ãƒâ€šÃ‚Â· {((w.exercises || []).reduce((s, e) => s + (e.sets || 0), 0))} sets</div>
                            </div>
                            <div className="flex gap-1 shrink-0">
                              <button className="btn !px-2 !py-1 !text-[10px]" onClick={() => { setPlanForm({ id: w.id, name: w.name, exercises: (w.exercises || []).map((e) => ({ exercise_id: e.exercise_id, name: e.name, sets: e.sets, reps: e.reps, weight: e.weight, rest_sec: e.rest_sec })), search: '' }); }}>Edit</button>
                              <button className="btn !px-2 !py-1 !text-[10px]" onClick={() => duplicatePlan(w)}>Copy</button>
                              <button className="btn !px-2 !py-1 !text-[10px] text-bad" onClick={() => deletePlan(w)}>Del</button>
                            </div>
                          </div>
                          <button className="btn w-full !py-1.5 !text-[10px] mt-2 border-gold/30 text-gold" onClick={() => startPlanToday(w)}>ÃƒÂ¢Ã¢â‚¬â€œÃ‚Â¶ Do today</button>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚Â THIS-WEEK DAY PREVIEW MODAL ÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚Â */}
        {weekDay && (
          <div className="fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm grid place-items-center p-4 anim-fadeIn" role="dialog" aria-modal="true" aria-label={`${weekDay.label} ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â ${weekDay.name}`}>
            <div className="card w-full max-w-md max-h-[85vh] flex flex-col overflow-hidden anim-scaleIn">
              <div className="p-4 border-b border-line/60 flex items-start justify-between gap-3">
                <div>
                  <div className="kicker">{weekDay.label}{weekDay.day_of_week === todayDow ? ' Ãƒâ€šÃ‚Â· today' : ''}</div>
                  <div className="font-grotesk font-bold text-lg leading-tight">{weekDay.name}</div>
                  {weekDay.focus && <div className="text-[10px] text-mute mt-1 font-grotesk">{weekDay.focus}</div>}
                </div>
                <button className="btn-ghost !text-mute shrink-0" onClick={() => setWeekDay(null)} aria-label="Close">ÃƒÂ¢Ã…â€œÃ¢â‚¬Â¢</button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-2">
                {weekDay.exercises?.length ? weekDay.exercises.map((ex, i) => (
                  <div key={i} className="rounded-xl border border-line bg-white/[.02] p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-grotesk text-[13px] font-semibold truncate">{ex.name}</span>
                    </div>
                    <div className="text-[11px] text-mute mt-1">{ex.sets} ÃƒÆ’Ã¢â‚¬â€ {ex.reps} Ãƒâ€šÃ‚Â· {ex.weight}</div>
                  </div>
                )) : (
                  <div className="text-center py-10 text-mute text-sm">Rest day ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â no exercises scheduled.</div>
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

        {/* ÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚Â CARDIO SELECTION MODAL ÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚Â */}
        {cardioOpen && (
          <div className="fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm grid place-items-center p-4 anim-fadeIn">
            <div className="card w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden anim-scaleIn">
              <div className="p-4 border-b border-line/60 flex items-center justify-between">
                <div>
                  <div className="font-grotesk font-bold">Add Cardio</div>
                  <div className="text-[10px] text-mute">Select a cardio exercise</div>
                </div>
                <button className="text-mute hover:text-ink text-lg active:scale-90" onClick={() => { setCardioOpen(false); setCardioConfigItem(null); setCardioSearch(''); }} aria-label="Close">ÃƒÂ¢Ã…â€œÃ¢â‚¬Â¢</button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {cardioConfigItem ? (
                  /* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ cardio configuration view ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */
                  <div className="space-y-3">
                    <button onClick={() => setCardioConfigItem(null)} className="btn !text-xs !py-1.5 active:scale-95">ÃƒÂ¢Ã¢â‚¬Â Ã‚Â Back to list</button>
                    <div className="font-grotesk font-bold text-lg">{cardioName(cardioConfigItem)}</div>
                    <div className="space-y-2.5">
                      <div className="text-[10px] uppercase tracking-[.12em] text-faint font-grotesk">PARAMETERS</div>
                      {cardioExerciseConfig(cardioConfigItem).map((field) => {
                        const existing = cardioItems.find((c) => c.id === cardioConfigItem);
                        return (
                          <div key={field.key} className="flex items-center gap-3">
                            <label className="text-[11px] font-grotesk font-semibold w-24 shrink-0" style={{ color: 'var(--mute)' }}>{field.label}</label>
                            <input
                              type="text"
                              inputMode="numeric"
                              className="input flex-1 !py-1.5 !text-xs"
                              placeholder={field.placeholder}
                              defaultValue={existing?.params?.[field.key] || ''}
                              id={`cardio_${field.key}`}
                            />
                            {field.unit && <span className="text-[10px] shrink-0" style={{ color: 'var(--faint)' }}>{field.unit}</span>}
                          </div>
                        );
                      })}
                    </div>
                    <button
                      className="btn-primary w-full active:scale-[.97]"
                      onClick={() => {
                        const params = {};
                        cardioExerciseConfig(cardioConfigItem).forEach((field) => {
                          const el = document.getElementById(`cardio_${field.key}`);
                          if (el && el.value) params[field.key] = el.value;
                        });
                        setCardioItems((prev) => [...prev, { id: cardioConfigItem, params, segments: [], currentParams: { ...params } }]);
                        setCardioConfigItem(null);
                        setCardioOpen(false);
                        setToast(`${cardioName(cardioConfigItem)} added`);
                      }}>
                      + Add to session
                    </button>
                  </div>
                ) : (
                  /* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ search + cardio exercise list ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */
                  <div className="space-y-2.5">
                    <input className="input" placeholder="Search cardio exercisesÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦" value={cardioSearch} onChange={(e) => setCardioSearch(e.target.value)} autoFocus />
                    <div className="space-y-1.5">
                      {Object.keys(CARDIO_MET).filter((id) => !cardioSearch || cardioName(id).toLowerCase().includes(cardioSearch.toLowerCase())).map((id, i) => {
                        const added = cardioItems.some((c) => c.id === id);
                        return (
                          <div key={id}
                            className={`flex items-center gap-2 rounded-xl border bg-white/[.02] px-3 py-2.5 transition-all anim-fadeUp ${added ? 'border-line/40 opacity-50' : 'border-line hover:border-gold/30'}`}
                            style={{ animationDelay: `${40 + i * 25}ms` }}>
                            <button className="flex-1 min-w-0 text-left" onClick={() => setCardioConfigItem(id)}>
                              <span className="block text-[13px] font-grotesk font-semibold truncate">{cardioName(id)}</span>
                              <span className="text-[10px] text-mute">{cardioSummary(cardioItems.find((c) => c.id === id) || { params: {} }) || 'Configure parameters'}</span>
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (added) return;
                                setCardioConfigItem(id);
                              }}
                              className={`shrink-0 w-8 h-8 rounded-lg grid place-items-center text-sm font-bold transition-all active:scale-90 ${added ? 'text-good' : 'text-gold border border-gold/40 bg-gold/10 hover:bg-gold/20'}`}
                              aria-label={`Add ${cardioName(id)}`}
                              disabled={added}>
                              {added ? 'ÃƒÂ¢Ã…â€œÃ¢â‚¬Å“' : '+'}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {toast && <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-full bg-panel border border-gold/40 font-grotesk text-xs shadow-card">{toast}</div>}
        <ShareWorkoutSheet
          open={shareSheetOpen}
          onClose={() => setShareSheetOpen(false)}
          workoutId={shareSheetData?.workoutId}
          workoutName={shareSheetData?.workoutName}
          exercises={shareSheetData?.exercises || []}
          t={{}}
        />
      </div>
    );
  }

  // ================= execute mode =================
  if (mode === 'execute') {
    /* EXECUTE MODE ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â one session clock, one checklist.
       Rebuilt to the brief: no per-set timer and no rest countdown, a single
       elapsed clock from START to END, every exercise for the day visible at
       once, each expanding into editable sets that get ticked off. */
    const pct = totalSets ? Math.round((doneSets / totalSets) * 100) : 0;

    return (
      <div className="space-y-3 pb-28">

        {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ the ONE session clock ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
        <div className="card p-4 sticky top-2 z-20">
          {pausedAt ? (
            /* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ paused state ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-[.18em]" style={{ color: 'var(--faint)' }}>Session paused</div>
                  <div className="font-black tabular-nums leading-none mt-1" style={{ fontSize: 30, color: 'var(--ink)', opacity: 0.5 }}>
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
              <button
                onClick={resumeWorkout}
                className="w-full py-2.5 rounded-xl text-[13px] font-grotesk font-bold tracking-wide active:scale-[.97] transition-all"
                style={{ background: 'var(--accent)', color: 'var(--bg)' }}>
                ÃƒÂ¢Ã¢â‚¬â€œÃ‚Â¶ RESUME
              </button>
            </div>
          ) : (
            /* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ active state ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */
            <div className="space-y-3">
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
              <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--line)' }}>
                <div className="h-full rounded-full transition-all duration-500"
                     style={{ width: `${pct}%`, background: 'var(--accent-grad)' }} />
              </div>
              <button
                onClick={pauseWorkout}
                className="w-full py-2 rounded-xl text-[12px] font-grotesk font-semibold border transition-all active:scale-[.97]"
                style={{ borderColor: 'var(--line)', color: 'var(--mute)' }}>
                ÃƒÂ¢Ã‚ÂÃ‚Â¸ PAUSE
              </button>
            </div>
          )}
        </div>

        {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ every exercise for today; tap to expand ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
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
              <div className="w-full flex items-center gap-2 p-3.5">
                <button
                  onClick={() => setOpenEx(open ? null : ex.id)}
                  className="flex-1 min-w-0 text-left"
                  aria-expanded={open}>
                  <div className="min-w-0">
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
                      {doneCount}/{sets.length} sets{ex.reps ? ` Ãƒâ€šÃ‚Â· ${ex.reps} reps` : ''}
                    </div>
                  </div>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); removeExercise(ex.id); }}
                  aria-label={`Remove ${ex.name}`}
                  className="w-8 h-8 rounded-lg border grid place-items-center shrink-0 transition-all active:scale-90"
                  style={{ borderColor: 'var(--line)', color: 'var(--faint)' }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>

              {open && (
                <div className="px-3.5 pb-3.5 space-y-1.5">
                  <div className="grid grid-cols-[26px_1fr_1fr_32px_32px] gap-2 px-1 text-[9px] uppercase tracking-[.12em]"
                       style={{ color: 'var(--faint)' }}>
                    <span>Set</span><span>Reps</span><span>Kg</span><span className="text-right">Done</span><span></span>
                  </div>
                  {sets.map((st, i) => (
                    <div key={i}
                         className="grid grid-cols-[26px_1fr_1fr_32px_32px] gap-2 items-center rounded-lg px-1 py-1"
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
                      <button
                        onClick={() => removeSet(ex.id, i)}
                        disabled={sets.length <= 1}
                        aria-label={`Delete set ${i + 1}`}
                        className="justify-self-end w-7 h-7 rounded-lg border grid place-items-center transition-all active:scale-90 disabled:opacity-30"
                        style={{ borderColor: 'var(--line)', color: 'var(--faint)' }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => addSet(ex.id)}
                    className="w-full text-center py-1.5 text-[11px] font-grotesk font-semibold rounded-lg border border-dashed transition-all active:scale-[.98]"
                    style={{ borderColor: 'var(--line)', color: 'var(--faint)' }}>
                    + Add Set
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ ACTIVE CARDIO (alongside strength workout) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
        {cardioMode === 'execute' && cardioActiveId && activeCardioItem && (
          <div className="card p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-[.18em]" style={{ color: 'var(--faint)' }}>Cardio Ãƒâ€šÃ‚Â· {cardioName(cardioActiveId)}</div>
                <div className="font-black tabular-nums leading-none mt-1" style={{ fontSize: 26, color: 'var(--ink)' }}>
                  {String(Math.floor(cardioElapsed / 60)).padStart(2, '0')}:{String(cardioElapsed % 60).padStart(2, '0')}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-[.18em]" style={{ color: 'var(--faint)' }}>Est. burn</div>
                <div className="font-black tabular-nums leading-none mt-1" style={{ fontSize: 16, color: 'var(--accent)' }}>
                  ~{totalCardioCals} <span className="text-[10px]" style={{ color: 'var(--mute)' }}>kcal</span>
                </div>
              </div>
            </div>
            <div className="rounded-xl p-2.5" style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent)' }}>
              <div className="flex flex-wrap gap-2">
                {cardioExerciseConfig(cardioActiveId).map((field) => (
                  <div key={field.key} className="flex items-center gap-1">
                    <span className="text-[10px] font-grotesk" style={{ color: 'var(--mute)' }}>{field.label}:</span>
                    <span className="text-[10px] font-grotesk font-bold" style={{ color: 'var(--ink)' }}>{activeCardioItem.currentParams?.[field.key] || 'ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â'}</span>
                    {field.unit && <span className="text-[8px]" style={{ color: 'var(--faint)' }}>{field.unit}</span>}
                  </div>
                ))}
              </div>
            </div>
            {(activeCardioItem.segments || []).length > 0 && (
              <div className="space-y-0.5">
                <div className="text-[9px] uppercase tracking-[.12em]" style={{ color: 'var(--faint)' }}>Segments ({activeCardioItem.segments.length})</div>
                {activeCardioItem.segments.map((seg, i) => (
                  <div key={i} className="text-[9px]" style={{ color: 'var(--faint)' }}>
                    Seg {i + 1}: {Math.round(seg.durationSec / 60)} min Ãƒâ€šÃ‚Â· {segmentParamsSummary(seg.params)}
                  </div>
                ))}
              </div>
            )}
            <div id="cardioAdjustExec" className="rounded-xl border border-line p-2.5 space-y-1.5">
              <div className="text-[9px] uppercase tracking-[.12em]" style={{ color: 'var(--faint)' }}>Adjust settings</div>
              <div className="grid grid-cols-2 gap-1.5">
                {cardioExerciseConfig(cardioActiveId).map((field) => (
                  <div key={field.key} className="flex items-center gap-1">
                    <label className="text-[9px] font-grotesk shrink-0" style={{ color: 'var(--mute)' }}>{field.label}</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      className="input flex-1 !py-0.5 !text-[10px]"
                      placeholder={field.placeholder}
                      defaultValue={activeCardioItem.currentParams?.[field.key] || ''}
                      id={`adjExec_${field.key}`}
                    />
                    {field.unit && <span className="text-[8px] shrink-0" style={{ color: 'var(--faint)' }}>{field.unit}</span>}
                  </div>
                ))}
              </div>
              <button
                onClick={() => {
                  const newParams = {};
                  cardioExerciseConfig(cardioActiveId).forEach((field) => {
                    const el = document.getElementById(`adjExec_${field.key}`);
                    if (el && el.value) newParams[field.key] = el.value;
                  });
                  const cur = activeCardioItem.currentParams || {};
                  const changed = Object.keys(newParams).some((k) => String(newParams[k]) !== String(cur[k]));
                  if (changed) {
                    adjustCardioSettings(newParams);
                    setToast('Settings updated ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â new segment started');
                  }
                }}
                className="w-full py-1 rounded-lg text-[9px] font-grotesk font-bold border transition-all active:scale-[.98]"
                style={{ borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' }}>
                ADJUST
              </button>
            </div>
            <button
              onClick={endCardio}
              className="w-full py-2 rounded-xl text-[11px] font-grotesk font-bold active:scale-[.97] transition-all"
              style={{ borderColor: 'var(--accent)', color: 'var(--accent)', border: '1px solid var(--accent)' }}>
              END CARDIO Ãƒâ€šÃ‚Â· {Math.round(cardioElapsed / 60)} min
            </button>
          </div>
        )}

        {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ ADD EXERCISE ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
        <button
          onClick={() => {
            if (!libList) api('/workouts/exercises').then((r) => setLibList(r.exercises || [])).catch(() => setToast('Could not load exercises'));
            setAddExSelected(null);
            setAddExSearch('');
            setAddExOpen(true);
          }}
          className="w-full text-center py-3 text-[12px] font-grotesk font-semibold rounded-xl border border-dashed transition-all active:scale-[.98]"
          style={{ borderColor: 'var(--line)', color: 'var(--faint)' }}>
          + Add Exercise
        </button>

        {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ END SESSION ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
        <div className="fixed inset-x-0 bottom-0 z-30 px-4 pb-4 pt-3"
             style={{ background: 'linear-gradient(to top, var(--bg) 65%, transparent)' }}>
          <Pressable
            onClick={() => finishWorkout()}
            disabled={submitting}
            className="btn-primary w-full !py-4 text-[13px] font-bold tracking-[.02em]">
            {submitting ? 'SavingÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦' : doneSets === 0 ? 'End session' : `End session Ãƒâ€šÃ‚Â· ${doneSets} sets`}
          </Pressable>
        </div>

        {/* ÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚Â ADD EXERCISE PICKER (execute mode) ÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢â‚¬Â¢Ã‚Â */}
        {addExOpen && (
          <div className="fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm grid place-items-center p-4 anim-fadeIn">
            <div className="card w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden anim-scaleIn">
              <div className="p-4 border-b border-line/60 flex items-center justify-between">
                <div>
                  <div className="font-grotesk font-bold">Add exercise</div>
                  <div className="text-[10px] text-mute">Search the exercise library</div>
                </div>
                <button className="text-mute hover:text-ink text-lg active:scale-90" onClick={() => { setAddExOpen(false); setAddExSelected(null); setAddExSearch(''); }} aria-label="Close">ÃƒÂ¢Ã…â€œÃ¢â‚¬Â¢</button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {addExSelected ? (
                  /* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ exercise detail view ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */
                  <div className="space-y-3">
                    <button onClick={() => setAddExSelected(null)} className="btn !text-xs !py-1.5 active:scale-95">ÃƒÂ¢Ã¢â‚¬Â Ã‚Â Back to library</button>
                    <div className="font-grotesk font-bold text-lg">{addExSelected.name}</div>
                    <div className="flex items-center gap-2 text-[11px] text-mute flex-wrap mt-1">
                      {addExSelected.primary_muscle && <span className="chip border-line !px-1.5 !py-0 text-[9px]">{addExSelected.primary_muscle}</span>}
                      {addExSelected.equipment && <span className="chip border-line !px-1.5 !py-0 text-[9px]">{addExSelected.equipment}</span>}
                      {addExSelected.difficulty && <span className="chip border-line !px-1.5 !py-0 text-[9px]">{addExSelected.difficulty}</span>}
                    </div>
                    {addExSelected.cues && (
                      <div className="rounded-xl border border-gold/25 bg-gold/5 px-3 py-2.5 text-[11px] leading-relaxed">
                        <span className="text-gold font-grotesk font-semibold mr-1.5">FORM CUE</span>{addExSelected.cues}
                      </div>
                    )}
                    <button
                      className={`btn-primary w-full active:scale-[.97] ${addExSaving ? 'opacity-60' : ''}`}
                      disabled={addExSaving}
                      onClick={() => addExerciseToSession(addExSelected)}>
                      {addExSaving ? 'AddingÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦' : '+ Add to session'}
                    </button>
                  </div>
                ) : (
                  /* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ search + list ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */
                  <div className="space-y-2.5">
                    <input className="input" placeholder="Search exercises by name or muscleÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦" value={addExSearch} onChange={(e) => setAddExSearch(e.target.value)} autoFocus />
                    <div className="space-y-1.5">
                    {(libList || []).filter((x) => !addExSearch || (x.name + ' ' + (x.primary_muscle || '')).toLowerCase().includes(addExSearch.toLowerCase())).slice(0, 30).map((x, i) => (
                      <button key={x.id}
                        className="w-full flex items-center gap-2 rounded-xl border border-line bg-white/[.02] px-3 py-2.5 text-left transition-all active:scale-[.98] hover:border-gold/30 anim-fadeUp"
                        style={{ animationDelay: `${40 + i * 25}ms` }}
                        onClick={() => setAddExSelected(x)}>
                        <span className="flex-1 min-w-0">
                          <span className="block text-[13px] font-grotesk font-semibold truncate">{x.name}</span>
                          <span className="text-[10px] text-mute">{x.primary_muscle || ''}{x.equipment ? ` Ãƒâ€šÃ‚Â· ${x.equipment}` : ''}</span>
                        </span>
                      </button>
                    ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

      </div>
    );
  }

  // ================= cardio-only mode =================
  // When the user has started cardio but NOT started a strength workout,
  // mode is still 'browse'. We render the active cardio session here
  // independently of the main workout mode.
  if (cardioMode === 'execute' && cardioActiveId && activeCardioItem) {
    return (
      <div className="space-y-3 pb-28">
        {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ CARDIO TIMER ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
        <div className="card p-4 space-y-3">
          {/* Timer + current exercise */}
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-[.18em]" style={{ color: 'var(--faint)' }}>Cardio Ãƒâ€šÃ‚Â· {cardioName(cardioActiveId)}</div>
              <div className="font-black tabular-nums leading-none mt-1" style={{ fontSize: 30, color: 'var(--ink)' }}>
                {String(Math.floor(cardioElapsed / 60)).padStart(2, '0')}:{String(cardioElapsed % 60).padStart(2, '0')}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-[.18em]" style={{ color: 'var(--faint)' }}>Est. burn</div>
              <div className="font-black tabular-nums leading-none mt-1" style={{ fontSize: 18, color: 'var(--accent)' }}>
                ~{totalCardioCals} <span className="text-[11px]" style={{ color: 'var(--mute)' }}>kcal</span>
              </div>
            </div>
          </div>
          {/* Current settings display */}
          <div className="rounded-xl p-3" style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent)' }}>
            <div className="text-[10px] uppercase tracking-[.12em] mb-2" style={{ color: 'var(--faint)' }}>Current settings</div>
            <div className="flex flex-wrap gap-2">
              {cardioExerciseConfig(cardioActiveId).map((field) => (
                <div key={field.key} className="flex items-center gap-1.5">
                  <span className="text-[11px] font-grotesk" style={{ color: 'var(--mute)' }}>{field.label}:</span>
                  <span className="text-[11px] font-grotesk font-bold" style={{ color: 'var(--ink)' }}>{activeCardioItem.currentParams?.[field.key] || 'ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â'}</span>
                  {field.unit && <span className="text-[9px]" style={{ color: 'var(--faint)' }}>{field.unit}</span>}
                </div>
              ))}
            </div>
          </div>
          {/* Segments so far */}
          {(activeCardioItem.segments || []).length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-[.12em]" style={{ color: 'var(--faint)' }}>Segments ({activeCardioItem.segments.length})</div>
              {activeCardioItem.segments.map((seg, i) => (
                <div key={i} className="flex items-center justify-between text-[10px]" style={{ color: 'var(--faint)' }}>
                  <span>Seg {i + 1} Ãƒâ€šÃ‚Â· {Math.round(seg.durationSec / 60)} min Ãƒâ€šÃ‚Â· {segmentParamsSummary(seg.params)}</span>
                </div>
              ))}
            </div>
          )}
          {/* ADJUST SETTINGS ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â inline edit without stopping the timer */}
          <div id="cardioAdjust" className="rounded-xl border border-line p-3 space-y-2">
            <div className="text-[10px] uppercase tracking-[.12em]" style={{ color: 'var(--faint)' }}>Adjust settings</div>
            <div className="grid grid-cols-2 gap-2">
              {cardioExerciseConfig(cardioActiveId).map((field) => (
                <div key={field.key} className="flex items-center gap-1.5">
                  <label className="text-[10px] font-grotesk shrink-0" style={{ color: 'var(--mute)' }}>{field.label}</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    className="input flex-1 !py-1 !text-[11px]"
                    placeholder={field.placeholder}
                    defaultValue={activeCardioItem.currentParams?.[field.key] || ''}
                    id={`adj_${field.key}`}
                  />
                  {field.unit && <span className="text-[9px] shrink-0" style={{ color: 'var(--faint)' }}>{field.unit}</span>}
                </div>
              ))}
            </div>
            <button
              onClick={() => {
                const newParams = {};
                cardioExerciseConfig(cardioActiveId).forEach((field) => {
                  const el = document.getElementById(`adj_${field.key}`);
                  if (el && el.value) newParams[field.key] = el.value;
                });
                const cur = activeCardioItem.currentParams || {};
                const changed = Object.keys(newParams).some((k) => String(newParams[k]) !== String(cur[k]));
                if (changed) {
                  adjustCardioSettings(newParams);
                  setToast('Settings updated ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â new segment started');
                }
              }}
              className="w-full py-1.5 rounded-lg text-[10px] font-grotesk font-bold border transition-all active:scale-[.98]"
              style={{ borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' }}>
              ADJUST SETTINGS
            </button>
          </div>
          {/* Action buttons */}
          <div className="flex gap-2">
            <button
              onClick={endCardio}
              className="flex-1 py-2.5 rounded-xl text-[12px] font-grotesk font-bold active:scale-[.97] transition-all"
              style={{ background: 'var(--accent)', color: 'var(--bg)' }}>
              END CARDIO Ãƒâ€šÃ‚Â· {Math.round(cardioElapsed / 60)} min
            </button>
          </div>
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
              ['Duration', result?.durationMin != null ? `${result.durationMin} min` : 'ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â'],
              ['Volume', result?.volume ? `${Math.round(result.volume).toLocaleString()} kg` : 'ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â'],
              ['Exercises', result?.exercises || 'ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â']
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
          {/* One-tap intensity rating -- required by skos-cal-v1 to estimate
              calories burned (see finishWorkout above for why this can't
              just be skipped/defaulted). Asked here rather than blocking the
              "Workout complete" moment: the summary above renders instantly,
              this is a small follow-up question underneath it. */}
          {burnInput && !intensity && (
            <div className="mt-4 rounded-xl border px-4 py-3 text-left" style={{ borderColor: 'var(--line)', background: 'rgb(var(--panel-rgb) / .72)' }}>
              <div className="text-[10px] uppercase tracking-[.16em]" style={{ color: 'var(--faint)' }}>How intense was that session?</div>
              <div className="grid grid-cols-3 gap-2 mt-2">
                {[['light', 'Light'], ['moderate', 'Moderate'], ['hard', 'Hard']].map(([tier, label]) => (
                  <button key={tier} className="btn !py-2.5 !text-[12px]" onClick={() => pickIntensity(tier)}>{label}</button>
                ))}
              </div>
            </div>
          )}
          {burnInput && intensity && burnLoading && (
            <div className="mt-4 text-center text-[11px]" style={{ color: 'var(--mute)' }}>Estimating calories burnedÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦</div>
          )}
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
                  {burn.lower_kcal}ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“{burn.upper_kcal}
                </span>
                <span className="text-[12px]" style={{ color: 'var(--mute)' }}>kcal</span>
              </div>
              <div className="mt-0.5 text-[11px]" style={{ color: 'var(--mute)' }}>
                best estimate ÃƒÂ¢Ã¢â‚¬Â°Ã‹â€ {burn.kcal} kcal
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

          {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Cardio calories (if any) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
          {cardioResult && (
            <div className="mt-3 rounded-xl border px-4 py-3 text-left"
                 style={{ borderColor: 'var(--accent)', background: 'var(--accent-soft)' }}>
              <div className="text-[10px] uppercase tracking-[.16em]" style={{ color: 'var(--faint)' }}>Cardio calories</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="font-black text-[22px] tabular-nums tracking-[-.02em]" style={{ color: 'var(--accent)' }}>
                  {cardioResult.totalCalories}
                </span>
                <span className="text-[12px]" style={{ color: 'var(--mute)' }}>kcal</span>
              </div>
              {cardioResult.items.map((item, i) => (
                <div key={i} className="mt-2 rounded-lg border border-line/30 p-2">
                  <div className="text-[11px] font-grotesk font-semibold" style={{ color: 'var(--ink)' }}>{cardioName(item.id)} Ãƒâ€šÃ‚Â· {item.calories} kcal</div>
                  {(item.segments || []).map((seg, j) => (
                    <div key={j} className="text-[10px] mt-0.5" style={{ color: 'var(--faint)' }}>
                      Seg {j + 1}: {Math.round(seg.durationSec / 60)} min Ãƒâ€šÃ‚Â· {segmentParamsSummary(seg.params)}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Total calories (strength + cardio) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
          {cardioResult && (
            <div className="mt-3 rounded-xl border px-4 py-3 text-left"
                 style={{ borderColor: 'var(--line)', background: 'rgb(var(--panel-rgb) / .72)' }}>
              <div className="text-[10px] uppercase tracking-[.16em]" style={{ color: 'var(--faint)' }}>Total calories burned</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="font-black text-[26px] tabular-nums tracking-[-.02em]" style={{ color: 'var(--ink)' }}>
                  {(burn?.kcal || 0) + (cardioResult.totalCalories || 0)}
                </span>
                <span className="text-[12px]" style={{ color: 'var(--mute)' }}>kcal</span>
              </div>
              <div className="mt-1 space-y-0.5">
                {burn?.kcal && (
                  <div className="text-[11px]" style={{ color: 'var(--mute)' }}>
                    Strength training: <span className="font-semibold">ÃƒÂ¢Ã¢â‚¬Â°Ã‹â€ {burn.kcal} kcal</span>
                  </div>
                )}
                <div className="text-[11px]" style={{ color: 'var(--mute)' }}>
                  Cardio: <span className="font-semibold">{cardioResult.totalCalories} kcal</span>
                </div>
              </div>
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

          {/* Share Workout ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â personal link sharing */}
          {workout?.id && (
            <button
              className="btn w-full mt-3 flex items-center justify-center gap-2"
              onClick={() => { setShareSheetData({ workoutId: workout.id, workoutName: workout.name, exercises }); setShareSheetOpen(true); }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>
              </svg>
              Share Workout
            </button>
          )}
          {/* Share to Community ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â gym community feed (separate from personal link sharing) */}
          {workout?.id && (
            <button
              className="btn w-full mt-2 flex items-center justify-center gap-2"
              disabled={sharing}
              onClick={async () => {
                setSharing(true);
                try {
                  await api('/community/shares', {
                    method: 'POST',
                    body: JSON.stringify({ workout_id: workout.id }),
                  });
                  setShareToast('Workout shared with your gym!');
                } catch (e) {
                  setShareToast(e.message || 'Could not share');
                }
                setSharing(false);
              }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98"/></svg>
              {sharing ? 'SharingÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦' : 'Share to Community'}
            </button>
          )}
          <button className="btn w-full mt-3" onClick={() => { clearActiveSession(); setMode('browse'); setResult(null); setExSets({}); setElapsed(0); setPausedAt(0); setAccumulatedPausedMs(0); setStartedAt(0); setExState(null); setBurn(null); setBurnInput(null); setIntensity(null); setSharing(false); setShareToast(''); setCardioMode('browse'); setCardioResult(null); setCardioItems([]); setCardioActiveId(null); setCardioSegStart(0); setCardioElapsed(0); }}>Done</button>
        </div>
      </div>
      {shareToast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-full bg-panel border border-gold/40 font-grotesk text-xs shadow-card anim-toast">
          <span className="text-good mr-2">ÃƒÂ¢Ã…â€œÃ¢â‚¬Å“</span>{shareToast}
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
    </div>
  );
}
