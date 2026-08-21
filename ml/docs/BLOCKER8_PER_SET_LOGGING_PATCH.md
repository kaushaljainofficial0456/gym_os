# Blocker 8 — per-set logging distorts `total_volume_kg`

**For:** Manavi (owns `frontend/src/pages/client/Workout.jsx`) + Kaushal (backend contract)
**Status:** specified, NOT applied. The file lives on `origin/ui-manavi` @ `4e09a9e`, which is actively being worked on. Patching it from `ml-sambhav` would create a conflict and step on that work, so this is a spec to apply on the owning branch — not a change I've made.

**Severity:** medium. Does not crash, does not throw, produces no error. Silently distorts a value the ML model uses as a weighting factor.

---

## The defect

`finishWorkout()` reads **one** `execInputs` entry per exercise and replays it across every set:

```js
const inp = execInputs[e.id] || { reps: ..., weight: ..., rir: null };
const n = progress[e.id] || 0;
return {
  exercise_id: e.id,
  sets: Array.from({ length: n }, (_, i) => ({
    set_number: i + 1,
    actual_reps: Number(inp.reps) || 0,      // <-- same value for every set
    actual_weight: Number(inp.weight) || 0,  // <-- same value for every set
    rir: inp.rir ? Number(inp.rir) : undefined
  }))
};
```

The code comment above it — *"Build per-set logs from actual captured inputs (what was entered when each set was completed)"* — describes the intended behaviour, but the implementation keys `execInputs` by **exercise**, not by set. Whatever was in the input boxes at the moment the exercise finished is written to all of its sets.

## Why it matters to the ML model

`total_volume_kg` is how `mlEstimate` **weights each exercise's correction** when blending a multi-exercise session. A distorted volume silently re-weights the blend.

**Worked example** — a real ramping set from the session tested on 2026-08-16 (Seated Row):

| | Set 1 | Set 2 | Set 3 | Set 4 | Volume |
|---|---|---|---|---|---|
| Actually performed | 15×50 | 11×65 | 8×75 | 5×80 | **2,465 kg** |
| What gets logged (last input replayed) | 5×80 | 5×80 | 5×80 | 5×80 | **1,600 kg** |

**35% under-reported** for that exercise. Drop sets and ramping loads — i.e. most real training — are affected. Uniform straight sets are unaffected, which is why this passes casual inspection.

Knock-on effects:
- Wrong blend weights → wrong session correction → wrong calorie estimate.
- `personal_records` / progression logic reads the same rows.
- Any future calibration dataset built from these rows inherits the distortion **permanently**. This is the reason to fix it before real data collection starts, not after.

## The fix

Capture inputs **per set at the moment the set is completed**, rather than once per exercise.

**1. Add per-set capture state:**

```js
const [setLog, setSetLog] = useState({}); // { [exerciseId]: [{reps, weight, rir}, ...] }
```

**2. In `completeSet()`, snapshot the inputs as they are for that set:**

```js
const completeSet = () => {
  if (!currentEx) return;
  const inp = execInputs[currentEx.id] || {};
  setSetLog((prev) => ({
    ...prev,
    [currentEx.id]: [...(prev[currentEx.id] || []), {
      reps: Number(inp.reps) || 0,
      weight: Number(inp.weight) || 0,
      rir: inp.rir != null ? Number(inp.rir) : undefined,
    }],
  }));
  // ...existing progress / rest-timer logic unchanged...
};
```

**3. In `finishWorkout()`, emit the captured sets:**

```js
const logs = state.filter((e) => (progress[e.id] || 0) > 0).map((e) => {
  const captured = setLog[e.id] || [];
  const n = progress[e.id] || 0;
  const fallback = execInputs[e.id] || { reps: parseFloat(e.reps) || 0, weight: parseFloat(e.weight) || 0, rir: null };
  return {
    exercise_id: e.id,
    sets: Array.from({ length: n }, (_, i) => {
      const s = captured[i] || fallback;   // fallback only if a set wasn't captured
      return {
        set_number: i + 1,
        actual_reps: Number(s.reps) || 0,
        actual_weight: Number(s.weight) || 0,
        rir: s.rir != null ? Number(s.rir) : undefined,
      };
    }),
  };
});
```

**No backend or schema change is required.** `exercise_set_logs` already has per-set `actual_reps` / `actual_weight` / `rir` columns and the insert loop already writes one row per set — the backend has always been ready for correct data; only the frontend payload was collapsing it.

## Verification

Log an exercise with deliberately different sets (e.g. 15×50, 11×65, 8×75, 5×80) and confirm:

```sql
SELECT set_number, actual_reps, actual_weight
FROM exercise_set_logs
WHERE workout_log_id = '<id>'
ORDER BY set_number;
```

Expect four **distinct** rows. Before the fix, all four are identical. The session-summary tonnage should also match the app's own displayed total (2,465 kg in the example above, not 1,600 kg).

## Scope note

This is the only one of the nine audit blockers that is a genuine implementation bug rather than a data limitation. Blockers 1–4 and 9 require measured calorimetry data; 6 and 7 are mitigated in the ML display layer; 5 is a documentation fix, already applied.
