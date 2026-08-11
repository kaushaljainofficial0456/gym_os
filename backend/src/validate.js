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
    password: z.string().min(4).optional(),
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
    source: z.enum(['plan', 'ai', 'manual']).default('manual'),
    estimate: z.boolean().default(false)
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
  measurementUpdate: z.object({
    weight: z.number().positive().max(500).optional(),
    target_weight: z.number().positive().max(500).optional(),
    goal_date: z.string().optional(),
    status: z.enum(['ON_TRACK', 'NEEDS_ATTENTION', 'AT_RISK', 'INACTIVE']).optional(),
    trainer_id: z.string().optional(),
    name: z.string().min(1).max(80).optional()
  })
};
