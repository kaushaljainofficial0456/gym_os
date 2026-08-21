# MASTER PROMPT — Workout Section UI (for Manavi)

**Scope:** `frontend/src/pages/client/Workout.jsx` (client-side, `origin/ui-manavi`).
**Grounded against the actual file as of `origin/ui-manavi` @ `4e09a9e`** — not a guess. Where something already exists, this says so and asks for a change, not a rebuild. Where something is missing, this specifies exactly what to add.

## DO NOT

- Do not touch `backend/`, `database/`, or RLS. Two backend dependencies are flagged below (§5) — those are asks for Kaushal, not things to build yourself.
- Do not set `CALORIE_MODEL_PROVIDER=ml` anywhere, and do not build UI that assumes it's on. The frontend renders whatever the backend returns (`baseline` or `ml`, see `provider` field) — it does not decide which one runs. That switch stays Kaushal's env-var call, dev/staging only.
- Do not remove `execInputs` or the underlying per-exercise input state — §4 extends it, it doesn't replace the data model.
- Do not merge/rebase against `origin/backend` as part of this work.

---

## 1. One timer only — remove the per-set rest timer

**This is a decision already made** (`ml/docs/SESSION_INTENSITY_DESIGN_NOTE.md` §5b) but **not yet implemented** — the rest-timer code is still live in the current file. This prompt is the implementation instruction.

**What exists now, confirmed by reading the file:**
- `const [rest, setRest] = useState(null);` (line ~39) — countdown state
- A countdown `useEffect` (line ~69) that ticks `rest.seconds` down every second
- `completeSet()` calls `setRest({ seconds: currentEx.rest_sec || 90, ... })` after every set
- A rest-timer overlay in the render (`{rest && (...)}` block, ~line 760) with a circular countdown, ±30s buttons

**What to do:**
1. Delete the `rest` state, its countdown `useEffect`, the `setRest(...)` call inside `completeSet()`, and the overlay JSX.
2. Keep exactly one timer: `startedAt` (already set via `setStartedAt(Date.now())` when execution begins) running until the user taps **End Workout**.
3. Show the running elapsed time somewhere visible during execute mode (a simple `mm:ss` ticking up from `startedAt` is enough — no countdown, no per-exercise reset).
4. **Duration must still be sent to the backend as it already is** — `res.duration_min` is server-authoritative (`completed_at − started_at`), with the local `Date.now() - startedAt` timer only as a fallback display value. Don't change that part; it's already correct and is a hard dependency for the calorie model (`duration_minutes` — no duration, no ML estimate, silent baseline fallback).

**Acceptance check:** start a workout, complete several sets across several exercises, confirm no countdown or rest overlay ever appears, and the only clock running is the one overall session timer, ending only on the explicit "End Workout" tap.

---

## 2. Build-your-own-workout by name — mostly exists, needs consolidation

**Confirmed already implemented**, in the `planForm` flow (~line 30, ~line 548 onward):
- Text input for a workout name ("Push A, Legs, My Upper Day" placeholder — exactly what was asked for)
- Exercise search against the library
- Add/remove exercises, each with its own sets/reps/weight/rest fields
- Save via `POST /me/planner/workouts` (create) or `PUT /me/planner/workouts/:id` (edit)

**This already satisfies the request.** What's worth fixing: **there are two separate, overlapping implementations of the same idea in this file.**
- `builderOpen` / `builderName` / `builderExs` — an older "build-my-workout" state tree
- `plannerOpen` / `planForm` — the newer "personal workout planner" (reusable workouts + weekly schedule)

Confirm with the rest of the team whether `builderOpen`/`builderExs` is still reachable from the UI or is dead code from an earlier iteration. If dead, remove it — two parallel state trees for the same feature is a real maintenance and bug-surface risk (e.g. it's easy to fix a bug in one and not realize the other path still has it). If both are genuinely still in use for different purposes, document why in a comment at the top of the file so the next person doesn't have to reverse-engineer it.

---

## 3. In-session checklist — mostly exists, confirm the requirement is met

**Confirmed already implemented:** `completeSet()` increments `exProgress[exercise.id]`, and the UI already tracks which sets of which exercises are done. This is the checklist behaviour that was asked for.

**Confirm, don't rebuild:**
- Every exercise in the session is visible with its sets, and completed sets are visually distinct from pending ones.
- The user can complete sets in any order (not forced sequential), if that's the intended UX — check current behaviour and confirm it matches what's wanted.
- Skipped/incomplete exercises at the end of a session don't block "End Workout" (this already appears to be the case — sets with 0 progress are filtered out in `finishWorkout`'s `state.filter(...)`).

---

## 4. Editable weight/reps per set, mid-workout — full spec already written, apply it

This is **the same defect already fully specified in `ml/docs/BLOCKER8_PER_SET_LOGGING_PATCH.md`** — don't re-derive it, that document has the exact before/after code. Summary for this prompt's context:

**Current bug:** `finishWorkout()` reads `execInputs[exercise.id]` **once per exercise** and replays that single value across every set of that exercise. If a user does a ramping set (e.g. 15×50, 11×65, 8×75, 5×80) or changes their weight/reps mid-exercise — exactly what was asked for — the log silently records the *last* value for every set. Real example already measured: a 4-set ramping row logs as 1,600 kg total instead of the actual 2,465 kg — 35% under-reported.

**Fix, in full in the patch doc:** capture `{reps, weight, rir}` into a `setLog` state **at the moment each set is completed** (inside `completeSet()`), not once at the end. `finishWorkout()` then emits the per-set captured values instead of replaying one value N times.

**This directly satisfies "user can change weight or reps or both of any particular exercise in between if he feels like it."** The requirement isn't new UI — the input fields for editing weight/reps already exist and are already editable mid-workout. The bug is that edits between sets weren't being *saved* per-set. Fixing the capture point fixes the requirement.

**No backend or schema change needed** — `exercise_set_logs` already has per-set `actual_reps`/`actual_weight`/`rir` columns and already writes one row per set. Apply exactly what's in the patch doc.

---

## 5. Surface the calorie estimate — for testing, this is new work

**The hook already exists and is already unused.** `finishWorkout()` already does:

```js
const res = await api(`/workouts/${workout.id}/complete`, { method: 'POST', body: JSON.stringify({ logs }) });
...
setResult({ prs: res.prs || [], volume, durationMin, exercises: state.length, calorie: res.calorie || null });
```

`result.calorie` is captured into state **but never rendered anywhere.** This is the entire reason the model can't currently be observed during testing — the data is already flowing, it's just not displayed. Add a section to the summary screen (`mode === 'summary'`) that renders it.

**Exact shape of `result.calorie`** (confirmed from `backend/src/routes/workouts.js` @ `3999430`, `calorieView()`):

```json
{
  "schema_version": "0.2",
  "estimated_active_kcal": 254,
  "lower_kcal": 200,
  "upper_kcal": 310,
  "model_version": "skos-cal-v1",
  "provider": "baseline",
  "source": "persisted",
  "estimated_at": "2026-08-17T..."
}
```

**Render it like this:**

```jsx
{result.calorie && (
  <div className="calorie-summary">
    <div className="text-xs text-mute uppercase tracking-wider">
      {result.calorie.provider === 'ml' ? 'ML estimate (testing)' : 'Baseline estimate'}
    </div>
    <div className="text-2xl font-bold">{result.calorie.estimated_active_kcal} kcal</div>
    <div className="text-xs text-mute">
      typical range {result.calorie.lower_kcal}–{result.calorie.upper_kcal} kcal
    </div>
  </div>
)}
{!result.calorie && (
  <div className="text-xs text-mute">No calorie estimate available for this session.</div>
)}
```

**Always show `provider` visibly, exactly as above.** During testing this is the single most useful thing on the screen — it tells you at a glance whether you're looking at the old MET formula (`baseline`) or the actual ML model (`ml`), which is presumably the whole point of wiring this up right now. Never assume which one is active; render whatever comes back.

### Backend dependency — flag to Kaushal, don't build around it

`calorieView()` currently does **not** include the `note` field that the ML model produces (confidence flags: out-of-range body weight, extended-duration warning, unknown-exercise share, etc. — see `ml/models/skos-cal-v1/displayEstimate.js` for the full logic this powers). Without `note`, the frontend can show the number and range, but not *why* a given estimate should be trusted more or less than another.

**Ask Kaushal to add `note` to `calorieView()`'s returned object** (it already exists on the raw ML result internally — `estimateWorkoutCalories()`'s output — it's just not being passed through). Once it's there, extend the render above with a caveat line when `note` is present:

```jsx
{result.calorie?.note && (
  <div className="text-xs text-amber-500 mt-1">⚠ {result.calorie.note}</div>
)}
```

Don't try to reproduce the full confidence-scoring logic (high/medium/low, the extreme-departure envelope check, etc.) client-side — that logic already exists once, in `ml/models/skos-cal-v1/displayEstimate.js`, and duplicating it in the frontend risks the two drifting apart. If richer confidence display is wanted later, the right fix is for the backend to run that formatting logic server-side and return a ready-made display object, not for the frontend to reimplement it. For now: number, range, provider, and raw `note` text (once available) is enough to test the model meaningfully.

---

## Deliverable checklist

- [ ] Single session timer only; rest-timer state, effect, and overlay removed
- [ ] Elapsed time visible during execute mode
- [ ] `builderOpen`/`builderExs` vs `planForm` duplication resolved or explained
- [ ] Per-set `{reps, weight, rir}` captured at completion time (per `BLOCKER8_PER_SET_LOGGING_PATCH.md`)
- [ ] Calorie estimate rendered on the summary screen: kcal, range, provider always visible
- [ ] `note` request flagged to Kaushal; caveat line added once available
- [ ] No backend/schema/RLS files touched
