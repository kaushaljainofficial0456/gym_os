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
    // text AI-estimate flow) untouched, never repurposed.
    source: z.enum(['plan', 'ai', 'manual', 'ai_estimated', 'ai_estimated_user_adjusted']).default('manual'),
    estimate: z.boolean().default(false),
    // Tier-4 provenance, optional -- only present when source starts with
    // 'ai_estimated'. Never used to mark a result "measured": these are
    // metadata about which AI produced the number, not a trust upgrade.
    ai_provider: z.string().max(40).optional(),
    ai_model: z.string().max(80).optional(),
    ai_confidence: z.enum(['high', 'medium', 'low', 'unreliable']).optional()
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
  })
};
