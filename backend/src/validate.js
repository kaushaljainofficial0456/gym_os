import { z } from 'zod';

// Validate req.body against a Zod schema. On failure returns 422 with readable errors.
export function validate(schema) {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
      return res.status(422).json({ error: 'Validation failed', issues });
    }
    req.body = parsed.data;
    next();
  };
}

export const schemas = {
  email: z.string().email(),
  login: z.object({
    email: z.string().email(),
    password: z.string().min(4)
  }),
  clientCreate: z.object({
    name: z.string().min(1).max(80),
    email: z.string().email(),
    password: z.string().min(6),
    age: z.number().int().min(10).max(100).optional(),
    height_cm: z.number().min(100).max(250).optional(),
    sex: z.enum(['M', 'F', 'OTHER']).optional(),
    goal: z.enum(['FAT_LOSS', 'MUSCLE_GAIN', 'RECOMP', 'STRENGTH', 'GENERAL']).default('GENERAL'),
    start_weight: z.number().positive().optional(),
    target_weight: z.number().positive().optional(),
    goal_date: z.string().optional(),
    trainer_id: z.string().optional()
  }),
  workoutTemplate: z.object({
    name: z.string().min(1).max(100),
    type: z.string().max(30).optional(),
    notes: z.string().max(500).optional(),
    exercises: z.array(z.object({
      exercise_id: z.string().optional(),
      name: z.string().min(1).max(100),
      sets: z.number().int().min(1).max(20).default(3),
      reps: z.string().max(20).default('10'),
      weight: z.string().max(20).default('BW'),
      rest_sec: z.number().int().min(0).max(600).default(90),
      tempo: z.string().max(20).optional(),
      notes: z.string().max(200).optional()
    })).default([])
  }),
  nutritionPlan: z.object({
    name: z.string().min(1).max(100),
    calories: z.number().positive().max(20000),
    protein: z.number().min(0).max(2000),
    carbs: z.number().min(0).max(2000),
    fat: z.number().min(0).max(2000),
    meals: z.array(z.object({
      slot: z.string().max(30),
      name: z.string().min(1).max(100),
      time: z.string().max(10).optional(),
      calories: z.number().min(0).max(10000),
      protein: z.number().min(0).max(1000),
      carbs: z.number().min(0).max(1000),
      fat: z.number().min(0).max(1000),
      foods: z.string().max(300).optional()
    })).default([])
  }),
  weightLog: z.object({
    date: z.string().optional(),
    weight: z.number().positive().max(500),
    source: z.enum(['manual', 'scale', 'estimate']).default('manual')
  }),
  mealLog: z.object({
    date: z.string().optional(),
    meal_id: z.string().optional(),
    slot: z.string().max(30).optional(),
    name: z.string().min(1).max(100),
    calories: z.number().min(0).max(10000),
    protein: z.number().min(0).max(1000),
    carbs: z.number().min(0).max(1000),
    fat: z.number().min(0).max(1000),
    eaten: z.boolean().default(true),
    // ai_estimated/ai_estimated_user_adjusted are additive (food-AI Tier 4,
    // see foodAI.js) -- 'ai' keeps its existing meaning (the older photo/
    // text AI-estimate flow) untouched, never repurposed. knn_estimated is
    // Tier 3 (similarity-weighted kNN, foodEstimator.js's estimateFoodKnn) --
    // distinct from ai_estimated because no AI provider is involved.
    source: z.enum(['plan', 'ai', 'manual', 'ai_estimated', 'ai_estimated_user_adjusted', 'knn_estimated']).default('manual'),
    estimate: z.boolean().default(false),
    // Tier-4 provenance, optional -- only present when source starts with
    // 'ai_estimated'. Never used to mark a result "measured": these are
    // metadata about which AI produced the number, not a trust upgrade.
    ai_provider: z.string().max(40).optional(),
    ai_model: z.string().max(80).optional(),
    ai_confidence: z.enum(['high', 'medium', 'low', 'unreliable']).optional(),
    // The ACTUAL logged quantity/unit (e.g. 245 / 'g' for a resolved
    // portion, 1 / 'serving' for a Custom Macros entry) -- optional
    // because not every caller has a meaningful one (a bare Recent
    // quick-add is a macro snapshot with no re-derivable weight), but
    // populating it wherever it IS known is what lets
    // PUT /me/meal-logs/:id later scale quantity proportionally from a
    // REAL baseline instead of a fabricated "100" (see that route's own
    // fallback comment -- a previously-undiagnosed bug where "Edit
    // Quantity" silently scaled from the wrong baseline for any entry
    // logged without one, found during a live end-to-end verification
    // pass).
    quantity: z.number().finite().positive().max(100000).optional(),
    unit: z.string().max(30).optional()
  }),
  // ---- My Diet: saved foods + saved meal templates + today's log entries ----
  // These routes previously did type coercion inline (Number()/String()
  // with manual clamping) rather than a schema. That coercion is still
  // permissive by design where a field is genuinely optional (a partial
  // PUT should be able to touch just one field) -- these schemas exist to
  // reject the WRONG TYPE outright (e.g. a non-numeric quantity, which
  // used to silently become NaN and get written to a log entry) rather
  // than to change what a well-formed request is allowed to look like.
  // Upper bounds here MUST stay >= mealLog's own calories/protein/carbs/fat
  // caps below (10000 / 1000 / 1000 / 1000) -- a real bug, found live: a
  // custom food could be CREATED with no upper bound at all, then every
  // attempt to LOG it (mealLog's own schema, which DOES cap) rejected with
  // a bare "Validation failed" and no indication the food itself was the
  // problem. A food this app tracks is a single serving/item, and nothing
  // realistic exceeds these numbers in one serving -- capping creation to
  // match what can actually be logged closes the trap at the source
  // rather than only improving the error message for it (see api.js).
  // Deliberately NOT adding a lower bound (.min(0)) here: the route itself
  // already rejects negative/impossible values via validateFoodRecord(),
  // with a 400 + a per-field `details` array richer than this schema
  // layer's own generic 422 -- a schema-level .min(0) would intercept
  // first and downgrade that into the same bare 422 this whole change is
  // trying to get away from, for a case that already worked correctly.
  foodCreate: z.object({
    name: z.string().min(1).max(80),
    unit: z.string().max(30).optional(),
    serving: z.string().max(60).optional(),
    calories: z.number().finite().max(10000).optional(),
    protein: z.number().finite().max(1000).optional(),
    carbs: z.number().finite().max(1000).optional(),
    fat: z.number().finite().max(1000).optional(),
    // Optional-detail macros (Part 14's "optional" list) -- the `foods`
    // table has always had these columns; this is the first route to let
    // a client actually populate them for a Custom Macros entry.
    fiber: z.number().finite().nonnegative().optional(),
    sugar: z.number().finite().nonnegative().optional(),
    sodium: z.number().finite().nonnegative().optional(),
    category: z.string().max(40).optional()
  }),
  // Partial update -- every field optional, exactly like the route's own
  // existing "only touch what's present" behavior. Same bounds as
  // foodCreate, for the same reason (an edit shouldn't be able to push a
  // food back over the loggable ceiling either).
  foodUpdate: z.object({
    name: z.string().min(1).max(80).optional(),
    serving: z.string().max(60).optional(),
    unit: z.string().max(30).optional(),
    calories: z.number().finite().max(10000).optional(),
    protein: z.number().finite().max(1000).optional(),
    carbs: z.number().finite().max(1000).optional(),
    fat: z.number().finite().max(1000).optional(),
    fiber: z.number().finite().nonnegative().optional(),
    sugar: z.number().finite().nonnegative().optional(),
    sodium: z.number().finite().nonnegative().optional()
  }),
  // Flexible Calorie Balance — strategy is the ONLY client-supplied input.
  // sourceDate/surplusCalories are always server-derived (from meal_logs vs
  // the client's own stored base target), never accepted from the client,
  // matching this file's existing pattern for /nutrition/targets/confirm
  // (calories is derived server-side there too, never trusted from the body).
  balanceStrategy: z.object({
    strategy: z.enum(['EASY', 'MODERATE', 'AGGRESSIVE', 'INTENSE']),
  }),
  foodResolveQuantity: z.object({
    // A real `foods` row's own id -- when present, resolve() prices
    // directly from that row's own macros (linear scaling), never by
    // searching the model catalogue by name. See me.js's own comment on
    // the bug this closes: a custom food has no source_id, so without
    // this it was priced by NAME-searching the model instead of using
    // its own stored values.
    food_id: z.string().max(60).optional(),
    // .nullable() alongside .optional() -- a real bug, found live off a
    // user's own report: every frontend call site builds this request
    // straight from a search-result object's `source_id` field, which is
    // a genuine SQL NULL (not merely absent) for any custom or library
    // food with no materialized model twin -- i.e. the exact case this
    // whole food_id branch exists for. `JSON.stringify({source_id: null})`
    // keeps the key with a literal null value (unlike `undefined`, which
    // JSON.stringify drops), and `.optional()` alone only accepts
    // `string | undefined`, not `null` -- so quick-logging or opening the
    // full portion picker on almost any custom food rejected with a bare
    // "Validation failed" (now: "source_id: Expected string, received
    // null" -- see api.js's own fix for why that detail is visible at
    // all). The route body itself already treats a null source_id
    // exactly like an absent one (`source_id && hits.find(...)`, `name ||
    // source_id || ''` -- both short-circuit past a null the same as past
    // undefined), so this schema was the only thing actually rejecting a
    // request the route was already written to handle correctly.
    source_id: z.string().max(100).nullable().optional(),
    name: z.string().max(150).optional(),
    portion_key: z.string().max(60).optional(),
    count: z.number().finite().positive().max(1000).optional(),
    grams: z.number().finite().positive().max(100000).optional(),
    oil_level: z.string().max(20).optional()
  }),
  foodFromModel: z.object({
    source_id: z.string().max(100).optional(),
    name: z.string().max(150).optional()
  }),
  mealCreate: z.object({
    name: z.string().min(1).max(80),
    slot: z.string().max(30).optional(),
    time: z.string().max(10).optional(),
    calories: z.number().finite().optional(),
    protein: z.number().finite().optional(),
    carbs: z.number().finite().optional(),
    fat: z.number().finite().optional(),
    foods: z.string().max(300).optional()
  }),
  mealUpdate: z.object({
    name: z.string().min(1).max(80).optional(),
    slot: z.string().max(30).optional(),
    calories: z.number().finite().optional(),
    protein: z.number().finite().optional(),
    carbs: z.number().finite().optional(),
    fat: z.number().finite().optional(),
    foods: z.string().max(300).optional()
  }),
  // `servings` scales a saved meal template's totals for ONE log entry --
  // optional, defaults to 1 (the route's own existing fallback).
  mealLogFromTemplate: z.object({
    servings: z.number().finite().positive().max(1000).optional()
  }),
  // POST /me/meals/:id/items has two mutually-exclusive shapes: a
  // database-food reference (food_id and/or a free-text name to search),
  // or a pre-computed AI estimate (see foodAI.js's response shape). Both
  // sides stay optional here -- the route itself is what 404s when
  // neither resolves to anything usable -- but every field IS typed now,
  // closing the class of bug where e.g. a non-numeric `grams` silently
  // became 100 (the `|| 100` fallback) instead of being rejected.
  mealItemAdd: z.object({
    food_id: z.string().max(60).optional(),
    name: z.string().max(150).optional(),
    quantity: z.number().finite().positive().max(100000).optional(),
    ai_estimate: z.object({
      name: z.string().max(150).optional(),
      grams: z.number().finite().positive().max(100000).optional(),
      calories: z.number().finite().nonnegative().optional(),
      protein_g: z.number().finite().nonnegative().optional(),
      carbs_g: z.number().finite().nonnegative().optional(),
      fat_g: z.number().finite().nonnegative().optional(),
      confidence: z.string().max(20).optional(),
      provider: z.string().max(40).optional(),
      model: z.string().max(80).optional()
    }).optional()
  }),
  mealItemQuantityUpdate: z.object({
    quantity: z.number().finite().positive().max(100000).optional()
  }),
  // Editing today's already-logged entry -- quantity is effectively
  // required (the route itself 400s without it today); the real fix here
  // is that a non-numeric quantity is now REJECTED instead of silently
  // becoming NaN and overwriting that entry's calories/protein/carbs/fat
  // with NaN (Math.max(0.1, Number('garbage')) === NaN, which node:sqlite
  // and pg both happily bind without erroring).
  mealLogEntryUpdate: z.object({
    quantity: z.number().finite().positive().max(100000),
    // .nullable() matters here, not just .optional(): meal_logs.unit is a
    // nullable column, and any log NOT created from a meal template (quick-
    // log, portion picker, Custom Macros, AI estimate, Recent quick-add --
    // i.e. most individual food logs) has a real `null` unit. The edit
    // modal always resends `{quantity, unit: log.unit}` verbatim, so a
    // plain `.optional()` here (accepts undefined, REJECTS null) 422'd on
    // every single one of those -- a real, previously-undiagnosed bug that
    // broke "edit a logged entry's quantity" for the common case, found
    // during a live end-to-end verification pass.
    unit: z.string().max(30).nullable().optional()
  }),
  waterLog: z.object({ date: z.string().optional(), litres: z.number().min(0).max(20) }),
  sleepLog: z.object({
    date: z.string().optional(),
    bed_time: z.string().optional(),
    wake_time: z.string().optional(),
    duration_h: z.number().min(0).max(24),
    source: z.enum(['manual', 'wearable']).default('manual')
  }),
  measurement: z.object({
    taken_at: z.string().optional(),
    weight: z.number().positive().max(500).optional(),
    waist: z.number().min(0).max(300).optional(),
    chest: z.number().min(0).max(300).optional(),
    arms: z.number().min(0).max(200).optional(),
    thighs: z.number().min(0).max(200).optional(),
    hips: z.number().min(0).max(300).optional(),
    neck: z.number().min(0).max(150).optional()
  }),
  aiEstimate: z.object({ text: z.string().min(1).max(300) }),
  // Tier 4 (food-AI) single-food estimate request. Deliberately separate
  // from `aiEstimate` above, which parses a free-text SENTENCE of several
  // items ("2 rotis, dal and milk") -- this is one specific dish/food a
  // search already came up empty for.
  foodAIEstimate: z.object({
    query: z.string().min(1).max(150),
    brand: z.string().max(80).optional(),
    restaurant: z.string().max(80).optional(),
    cuisine: z.string().max(60).optional(),
    portion: z.string().max(60).optional(),
    cooking_method: z.string().max(60).optional(),
    ingredients: z.array(z.string().max(60)).max(15).optional()
  }),
  // Recompute a Tier-4 AI estimate's totals after the user edits serving
  // quantity / an ingredient's grams / an ingredient name (e.g. "rice" ->
  // "brown rice", or the oil component) -- deterministic, no second AI
  // call. `components` is the estimate's own components array as
  // returned by POST /foods/ai-estimate; `edits` is aligned by index,
  // one entry per component (or null/absent for "no change at this index").
  foodAIAdjust: z.object({
    components: z.array(z.object({
      name: z.string().min(1).max(150),
      estimated_weight_g: z.number().finite().nonnegative(),
      calories: z.number().finite().nonnegative().optional(),
      protein_g: z.number().finite().nonnegative().optional(),
      carbs_g: z.number().finite().nonnegative().optional(),
      fat_g: z.number().finite().nonnegative().optional(),
      matched_source_id: z.string().nullable().optional(),
      db_grounded: z.boolean().optional(),
      assumption: z.string().nullable().optional()
    })).min(1).max(20),
    edits: z.array(
      z.object({
        name: z.string().max(150).optional(),
        estimated_weight_g: z.number().finite().nonnegative().optional(),
        removed: z.boolean().optional()
      }).nullable()
    ).max(20).optional(),
    is_branded_or_restaurant: z.boolean().optional()
  }),
  // Share Meals: bundle one or more of the client's OWN saved foods/meals
  // into one shareable snapshot. At least one of meal_ids/food_ids must be
  // non-empty (checked in the route, not here -- z.union of "at least one
  // array non-empty" is awkward to express and the route's own 400 message
  // is clearer than a generic schema mismatch).
  shareCreate: z.object({
    meal_ids: z.array(z.string().min(1)).max(20).optional(),
    food_ids: z.array(z.string().min(1)).max(20).optional()
  }),
  // Save one item from a previously-created share into the recipient's own
  // My Diet. item_index indexes into that share's own items array (server-
  // side, from the DB row -- never client-supplied item data, so a
  // recipient can never inject arbitrary nutrition values through this route).
  shareSave: z.object({
    item_index: z.number().int().min(0).max(19)
  }),
  // A user's correction to an AI food estimate -- recorded as ONE feedback
  // observation, never a direct overwrite of the shared cache (see
  // foodFeedback.js). `query` (the original food name, re-canonicalized
  // server-side) rather than a client-supplied canonical_key, so this can
  // never target an arbitrary cache row that doesn't correspond to what
  // was actually estimated.
  foodFeedback: z.object({
    query: z.string().min(1).max(150),
    // Separate weights: the AI's own estimated serving and the user's
    // final (possibly re-quantified) total can legitimately differ --
    // each side must be normalized against its OWN actual weight.
    original_grams: z.number().finite().positive(),
    adjusted_grams: z.number().finite().positive(),
    original: z.object({
      calories: z.number().finite().nonnegative(),
      protein_g: z.number().finite().nonnegative(),
      carbs_g: z.number().finite().nonnegative(),
      fat_g: z.number().finite().nonnegative()
    }),
    adjusted: z.object({
      calories: z.number().finite().nonnegative(),
      protein_g: z.number().finite().nonnegative(),
      carbs_g: z.number().finite().nonnegative(),
      fat_g: z.number().finite().nonnegative()
    }),
    ai_provider: z.string().max(40).optional(),
    ai_model: z.string().max(80).optional()
  }),
  insightAction: z.object({
    action: z.enum(['accept', 'modify', 'dismiss']),
    summary: z.string().max(1000).optional(),
    recommendation: z.string().max(1000).optional()
  }),
  alertAction: z.object({ action: z.enum(['read', 'dismiss', 'follow_up']) }),
  message: z.object({
    client_id: z.string().min(1),
    type: z.enum(['message', 'workout_update', 'nutrition_update', 'checkin_reminder']).default('message'),
    body: z.string().min(1).max(2000)
  }),
  photo: z.object({
    view: z.enum(['front', 'side', 'back']),
    data_url: z.string().min(20).max(8_000_000),   // base64 image
    taken_at: z.string().optional(),
    is_before: z.boolean().default(false)
  }),
  // "Add product manually" -- barcode scanned/typed but not found in the
  // local snapshot, DB cache, or the external API. serving_grams is
  // required (not optional) so the entered macros -- which the user reads
  // straight off the pack, i.e. PER THAT SERVING -- can be converted to the
  // same per-100g basis every other barcode source uses (see
  // barcodeLookup.js's cacheProduct / resolveServing), rather than
  // introducing a second nutrition representation into the same table.
  manualBarcodeProduct: z.object({
    name: z.string().min(1).max(100),
    brand: z.string().max(80).optional(),
    serving_grams: z.number().positive().max(5000),
    serving_label: z.string().max(60).optional(),
    calories: z.number().min(0).max(10000),
    protein: z.number().min(0).max(1000),
    carbs: z.number().min(0).max(1000),
    fat: z.number().min(0).max(1000),
    fiber: z.number().min(0).max(1000).optional(),
    sugar: z.number().min(0).max(1000).optional(),
    sodium: z.number().min(0).max(100000).optional() // mg
  }),
  measurementUpdate: z.object({
    weight: z.number().positive().max(500).optional(),
    target_weight: z.number().positive().max(500).optional(),
    goal_date: z.string().optional(),
    status: z.enum(['ON_TRACK', 'NEEDS_ATTENTION', 'AT_RISK', 'INACTIVE']).optional(),
    trainer_id: z.string().optional(),
    name: z.string().min(1).max(80).optional()
  }),
  // Frontend ErrorBoundary crash report -- see clientError.js. Public
  // route (no auth required), so this schema is the only real gate on
  // shape/size.
  clientError: z.object({
    message: z.string().min(1).max(1000),
    path: z.string().max(300).optional(),
    component_stack: z.string().max(2000).optional()
  }),
  // ---- client-side custom workouts (My Diet's workout equivalent) ----
  // sets/reps/weight/rest_sec stay loosely typed here on purpose: the
  // routes already do parseInt(x, 10) || <default> BEFORE Math.max/min
  // (the safe order -- NaN is caught by the `||` before it can reach
  // Math.max, unlike the bug this pattern is a sibling-fix for in
  // PUT /me/meal-logs/:logId), so a wrong type degrades to a sane default
  // rather than corrupting anything. This schema exists to reject the
  // wrong SHAPE (exercises not even being an array of objects, a
  // non-string exercise_id) rather than to re-litigate types the route
  // already coerces safely.
  workoutExerciseItem: z.object({
    exercise_id: z.string().min(1).max(60),
    name: z.string().max(80).optional(),
    sets: z.union([z.number(), z.string()]).optional(),
    reps: z.union([z.number(), z.string()]).optional(),
    weight: z.union([z.number(), z.string()]).optional(),
    rest_sec: z.union([z.number(), z.string()]).optional(),
    tempo: z.string().max(20).optional(),
    notes: z.string().max(200).optional()
  }),
  clientWorkoutCreate: z.object({
    name: z.string().min(1).max(80),
    exercises: z.array(z.object({
      exercise_id: z.string().min(1).max(60),
      sets: z.union([z.number(), z.string()]).optional(),
      reps: z.union([z.number(), z.string()]).optional(),
      weight: z.union([z.number(), z.string()]).optional(),
      rest_sec: z.union([z.number(), z.string()]).optional()
    })).min(1).max(20)
  }),
  plannerWorkoutCreate: z.object({
    name: z.string().min(1).max(80),
    notes: z.string().max(300).optional(),
    exercises: z.array(z.object({
      exercise_id: z.string().min(1).max(60),
      name: z.string().max(80).optional(),
      sets: z.union([z.number(), z.string()]).optional(),
      reps: z.union([z.number(), z.string()]).optional(),
      weight: z.union([z.number(), z.string()]).optional(),
      rest_sec: z.union([z.number(), z.string()]).optional(),
      tempo: z.string().max(20).optional(),
      notes: z.string().max(200).optional()
    })).min(1).max(20)
  }),
  // Partial update -- name/notes/exercises all independently optional,
  // exactly matching the route's own existing "only touch what's present" logic.
  plannerWorkoutUpdate: z.object({
    name: z.string().max(80).optional(),
    notes: z.string().max(300).optional(),
    exercises: z.array(z.object({
      exercise_id: z.string().min(1).max(60).optional(),
      name: z.string().max(80).optional(),
      sets: z.union([z.number(), z.string()]).optional(),
      reps: z.union([z.number(), z.string()]).optional(),
      weight: z.union([z.number(), z.string()]).optional(),
      rest_sec: z.union([z.number(), z.string()]).optional(),
      tempo: z.string().max(20).optional(),
      notes: z.string().max(200).optional()
    })).max(20).optional()
  }),
  // Keys are day-of-week strings ("0".."6") once JSON round-trips a plain
  // object -- the route itself already validates 0..6 by looping and
  // validates each value is a workout this client actually owns. This
  // schema only rejects the wrong TOP-LEVEL shape (schedule not being an
  // object at all, or a value that isn't a string/null).
  workoutScheduleUpdate: z.object({
    schedule: z.record(z.string(), z.string().nullable())
  }),
  // ---- Workout sharing ----
  workoutShareCreate: z.object({
    workout_id: z.string().min(1),
    exercise_ids: z.array(z.string().min(1)).max(50).optional()
  }),
  workoutImport: z.object({
    exercise_indexes: z.array(z.number().int().min(0)).max(50).optional(),
    destination: z.enum(['today', 'planner', 'planner_day']),
    day_of_week: z.union([z.number().int().min(0).max(6), z.string()]).optional(),
    workout_name: z.string().max(80).optional()
  })
};
