// ============================================================
// PROGRAM GENERATOR — builds a structured training week from
// the ACTUAL exercise database (never hallucinated exercises).
// Constraints: goal, days per week, equipment, excluded
// movements, session minutes. Templates are labeled TEMPLATE —
// not a personalized prescription.
// ============================================================

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Equipment compatibility: which library `equipment` values satisfy each
// requested piece of equipment.
// Which library `equipment` values are acceptable for each requested piece.
// Strict: "only dumbbells" must NOT surface barbell/cable/machine exercises.
// Bodyweight + bands are treated as equipment-free complements for home setups.
const EQUIP_COMPAT = {
  barbell: ['BARBELL', 'SMITH', 'FULL_GYM'],
  dumbbells: ['DUMBBELL', 'BODYWEIGHT', 'BANDS'],
  cable: ['CABLE', 'MACHINE', 'FULL_GYM'],
  machine: ['MACHINE', 'CABLE', 'LEG_PRESS', 'SMITH', 'FULL_GYM'],
  bodyweight: ['BODYWEIGHT', 'PULL_UP_BAR', 'BANDS'],
  bands: ['BANDS', 'BODYWEIGHT'],
  kettlebell: ['KETTLEBELL', 'DUMBBELL'],
  pull_up_bar: ['PULL_UP_BAR', 'BODYWEIGHT'],
  bench: ['BENCH', 'BARBELL', 'DUMBBELL', 'BODYWEIGHT'],
  smith: ['SMITH', 'BARBELL', 'MACHINE'],
  leg_press: ['LEG_PRESS', 'MACHINE'],
  treadmill: ['TREADMILL'],
  bike: ['BIKE'],
  rowing: ['ROWING'],
  full_gym: ['FULL_GYM', 'BARBELL', 'DUMBBELL', 'CABLE', 'MACHINE', 'LEG_PRESS', 'SMITH', 'BENCH', 'BODYWEIGHT', 'BANDS', 'KETTLEBELL', 'PULL_UP_BAR', 'TREADMILL', 'BIKE', 'ROWING']
};

// Muscle focus split per training day template.
const SPLIT_TEMPLATES = {
  'full body': ['FULL_BODY_2', 'FULL_BODY_3'],
  'upper/lower': ['UPPER_LOWER_4'],
  'push pull legs': ['PPL_3', 'PPL_4', 'PPL_5', 'PPL_6'],
  ppl: ['PPL_3', 'PPL_4', 'PPL_5', 'PPL_6'],
  'bro split': ['BRO_5'],
  strength: ['STRENGTH_3', 'STRENGTH_4'],
  hypertrophy: ['HYPERTROPHY_4', 'HYPERTROPHY_5'],
  beginner: ['BEGINNER_3', 'FULL_BODY_2', 'FULL_BODY_3'],
  fatloss: ['FAT_LOSS_3', 'FAT_LOSS_4']
};

function inferSplitStyle(goal, days) {
  const g = String(goal || '').toLowerCase();
  if (g.includes('strength')) return days >= 4 ? 'STRENGTH_4' : 'STRENGTH_3';
  if (g.includes('fat loss') || g.includes('fatloss') || g.includes('endurance')) return days >= 4 ? 'FAT_LOSS_4' : 'FAT_LOSS_3';
  if (g.includes('hypertrophy') || g.includes('muscle')) return days >= 5 ? 'HYPERTROPHY_5' : 'HYPERTROPHY_4';
  if (g.includes('beginner')) return days >= 4 ? 'UPPER_LOWER_4' : 'FULL_BODY_3';
  // default by day count
  return days >= 5 ? 'PPL_5' : days === 4 ? 'UPPER_LOWER_4' : days >= 3 ? 'PPL_3' : 'FULL_BODY_2';
}

// Day definitions: [{name, muscles:[canonical], movements:[...]}]
function dayPlanFor(style, days) {
  const plans = {
    FULL_BODY_2: [
      { name: 'Full Body A', muscles: ['chest', 'back', 'quads', 'core'], movements: ['horizontal_push', 'horizontal_pull', 'squat', 'core'] },
      { name: 'Full Body B', muscles: ['shoulders', 'biceps', 'hamstrings', 'glutes'], movements: ['vertical_push', 'isolation', 'hinge', 'core'] }
    ],
    FULL_BODY_3: [
      { name: 'Full Body A', muscles: ['chest', 'back', 'quads'], movements: ['horizontal_push', 'horizontal_pull', 'squat'] },
      { name: 'Full Body B', muscles: ['shoulders', 'biceps', 'hamstrings'], movements: ['vertical_push', 'isolation', 'hinge'] },
      { name: 'Full Body C', muscles: ['chest', 'lats', 'glutes', 'core'], movements: ['horizontal_push', 'vertical_pull', 'lunge', 'core'] }
    ],
    UPPER_LOWER_4: [
      { name: 'Upper A', muscles: ['chest', 'back', 'shoulders', 'biceps'], movements: ['horizontal_push', 'horizontal_pull', 'vertical_push', 'isolation'] },
      { name: 'Lower A', muscles: ['quads', 'hamstrings', 'glutes', 'calves'], movements: ['squat', 'hinge', 'isolation'] },
      { name: 'Upper B', muscles: ['chest', 'lats', 'triceps', 'shoulders'], movements: ['vertical_push', 'vertical_pull', 'isolation'] },
      { name: 'Lower B', muscles: ['quads', 'glutes', 'hamstrings', 'calves'], movements: ['lunge', 'hinge', 'squat', 'isolation'] }
    ],
    PPL_3: [
      { name: 'Push', muscles: ['chest', 'shoulders', 'triceps'], movements: ['horizontal_push', 'vertical_push', 'isolation'] },
      { name: 'Pull', muscles: ['lats', 'back', 'biceps', 'shoulders'], movements: ['vertical_pull', 'horizontal_pull', 'isolation'] },
      { name: 'Legs', muscles: ['quads', 'hamstrings', 'glutes', 'calves'], movements: ['squat', 'hinge', 'lunge', 'isolation'] }
    ],
    PPL_4: [
      { name: 'Push', muscles: ['chest', 'shoulders', 'triceps'], movements: ['horizontal_push', 'vertical_push', 'isolation'] },
      { name: 'Pull', muscles: ['lats', 'back', 'biceps'], movements: ['vertical_pull', 'horizontal_pull', 'isolation'] },
      { name: 'Legs', muscles: ['quads', 'hamstrings', 'glutes', 'calves'], movements: ['squat', 'hinge', 'lunge'] },
      { name: 'Upper Focus', muscles: ['chest', 'back', 'shoulders', 'arms'], movements: ['horizontal_push', 'horizontal_pull', 'isolation'] }
    ],
    PPL_5: [
      { name: 'Push', muscles: ['chest', 'shoulders', 'triceps'], movements: ['horizontal_push', 'vertical_push', 'isolation'] },
      { name: 'Pull', muscles: ['lats', 'back', 'biceps'], movements: ['vertical_pull', 'horizontal_pull', 'isolation'] },
      { name: 'Legs', muscles: ['quads', 'hamstrings', 'glutes', 'calves'], movements: ['squat', 'hinge', 'lunge'] },
      { name: 'Upper', muscles: ['chest', 'back', 'shoulders', 'arms'], movements: ['horizontal_push', 'horizontal_pull', 'vertical_push'] },
      { name: 'Lower', muscles: ['quads', 'glutes', 'hamstrings', 'calves'], movements: ['squat', 'hinge', 'lunge', 'isolation'] }
    ],
    PPL_6: [
      { name: 'Push', muscles: ['chest', 'shoulders', 'triceps'], movements: ['horizontal_push', 'vertical_push', 'isolation'] },
      { name: 'Pull', muscles: ['lats', 'back', 'biceps'], movements: ['vertical_pull', 'horizontal_pull', 'isolation'] },
      { name: 'Legs', muscles: ['quads', 'hamstrings', 'glutes', 'calves'], movements: ['squat', 'hinge', 'lunge'] },
      { name: 'Push 2', muscles: ['chest', 'shoulders', 'triceps'], movements: ['horizontal_push', 'vertical_push', 'isolation'] },
      { name: 'Pull 2', muscles: ['lats', 'back', 'biceps'], movements: ['vertical_pull', 'horizontal_pull', 'isolation'] },
      { name: 'Legs 2', muscles: ['quads', 'hamstrings', 'glutes', 'calves'], movements: ['squat', 'hinge', 'lunge'] }
    ],
    BRO_5: [
      { name: 'Chest', muscles: ['chest'], movements: ['horizontal_push', 'isolation'] },
      { name: 'Back', muscles: ['lats', 'back'], movements: ['vertical_pull', 'horizontal_pull'] },
      { name: 'Shoulders', muscles: ['shoulders'], movements: ['vertical_push', 'isolation'] },
      { name: 'Arms', muscles: ['biceps', 'triceps'], movements: ['isolation'] },
      { name: 'Legs', muscles: ['quads', 'hamstrings', 'glutes', 'calves'], movements: ['squat', 'hinge', 'isolation'] }
    ],
    STRENGTH_3: [
      { name: 'Strength A', muscles: ['chest', 'back', 'core'], movements: ['horizontal_push', 'horizontal_pull', 'core'] },
      { name: 'Strength B', muscles: ['quads', 'hamstrings', 'glutes'], movements: ['squat', 'hinge'] },
      { name: 'Strength C', muscles: ['shoulders', 'lats', 'core'], movements: ['vertical_push', 'vertical_pull', 'core'] }
    ],
    STRENGTH_4: [
      { name: 'Strength A', muscles: ['chest', 'back', 'core'], movements: ['horizontal_push', 'horizontal_pull', 'core'] },
      { name: 'Strength B', muscles: ['quads', 'hamstrings', 'glutes'], movements: ['squat', 'hinge'] },
      { name: 'Strength C', muscles: ['shoulders', 'lats', 'core'], movements: ['vertical_push', 'vertical_pull', 'core'] },
      { name: 'Strength D', muscles: ['chest', 'back', 'quads'], movements: ['horizontal_push', 'horizontal_pull', 'squat'] }
    ],
    HYPERTROPHY_4: [
      { name: 'Chest & Triceps', muscles: ['chest', 'triceps'], movements: ['horizontal_push', 'vertical_push', 'isolation'] },
      { name: 'Back & Biceps', muscles: ['lats', 'back', 'biceps'], movements: ['vertical_pull', 'horizontal_pull', 'isolation'] },
      { name: 'Legs', muscles: ['quads', 'hamstrings', 'glutes', 'calves'], movements: ['squat', 'hinge', 'lunge', 'isolation'] },
      { name: 'Shoulders & Arms', muscles: ['shoulders', 'biceps', 'triceps'], movements: ['vertical_push', 'isolation'] }
    ],
    HYPERTROPHY_5: [
      { name: 'Chest', muscles: ['chest'], movements: ['horizontal_push', 'isolation'] },
      { name: 'Back', muscles: ['lats', 'back'], movements: ['vertical_pull', 'horizontal_pull'] },
      { name: 'Legs', muscles: ['quads', 'hamstrings', 'glutes', 'calves'], movements: ['squat', 'hinge', 'isolation'] },
      { name: 'Shoulders', muscles: ['shoulders'], movements: ['vertical_push', 'isolation'] },
      { name: 'Arms & Core', muscles: ['biceps', 'triceps', 'core'], movements: ['isolation', 'core'] }
    ],
    FAT_LOSS_3: [
      { name: 'Circuit A', muscles: ['chest', 'back', 'core'], movements: ['horizontal_push', 'horizontal_pull', 'core'] },
      { name: 'Circuit B', muscles: ['quads', 'glutes', 'core'], movements: ['squat', 'lunge', 'core'] },
      { name: 'Circuit C', muscles: ['shoulders', 'lats', 'core'], movements: ['vertical_push', 'vertical_pull', 'core'] }
    ],
    FAT_LOSS_4: [
      { name: 'Metabolic A', muscles: ['chest', 'back', 'quads'], movements: ['horizontal_push', 'horizontal_pull', 'squat'] },
      { name: 'Metabolic B', muscles: ['shoulders', 'hamstrings', 'core'], movements: ['vertical_push', 'hinge', 'core'] },
      { name: 'Metabolic C', muscles: ['lats', 'glutes', 'quads'], movements: ['vertical_pull', 'lunge', 'squat'] },
      { name: 'Metabolic D', muscles: ['chest', 'back', 'core'], movements: ['horizontal_push', 'horizontal_pull', 'core'] }
    ]
  };
  const plan = plans[style];
  if (!plan) return plans.PPL_3.slice(0, Math.min(days, 3));
  return plan.slice(0, Math.min(days, plan.length));
}

// Does an exercise satisfy an equipment constraint?
function equipmentOk(ex, requested) {
  const wanted = Array.isArray(requested) && requested.length ? requested : ['full_gym'];
  for (const w of wanted) {
    const compat = EQUIP_COMPAT[w] || EQUIP_COMPAT.full_gym;
    const exEq = String(ex.equipment || '').toUpperCase();
    if (compat.some((c) => exEq === c || exEq.includes(c))) return true;
  }
  return false;
}

function muscleMatches(ex, muscles) {
  const primary = String(ex.primary_muscle || '').toLowerCase();
  const secondary = String(ex.secondary_muscles || '').toLowerCase();
  return muscles.some((m) => primary.includes(m) || secondary.includes(m) ||
    (m === 'lats' && primary.includes('lat')) || (m === 'back' && (primary.includes('back') || primary.includes('lat'))));
}

export async function generateProgram(db, orgId, { goal, days, equipment, exclude, minutes, experience, style } = {}) {
  const dayCount = Math.max(1, Math.min(6, parseInt(days, 10) || 3));
  const reqEquipment = (Array.isArray(equipment) ? equipment : String(equipment || 'full_gym').split(',').map((s) => s.trim())).filter(Boolean);
  const exclusions = (Array.isArray(exclude) ? exclude : String(exclude || '').toLowerCase().split(','))
    .map((s) => s.trim().toLowerCase()).filter(Boolean);

  const splitStyle = style || inferSplitStyle(goal, dayCount);
  const plan = dayPlanFor(splitStyle, dayCount);

  // pull the full library once
  const library = await db.q(
    `SELECT * FROM exercise_library WHERE (is_global = 1 OR org_id = ?)`, [orgId]);

  const eligible = library.filter((ex) => {
    if (!equipmentOk(ex, reqEquipment)) return false;
    const name = String(ex.name).toLowerCase();
    const muscles = String(ex.primary_muscle + ' ' + (ex.secondary_muscles || '')).toLowerCase();
    const hay = name + ' ' + muscles;
    if (exclusions.some((e) => hay.includes(e) || name.includes(e))) return false;
    return true;
  });

  const pickFor = (muscles, movements, used) => {
    const score = (ex) => {
      const muscleHit = muscleMatches(ex, muscles) ? 2 : 0;
      const moveHit = movements.some((m) => String(ex.movement).includes(m) || m.includes(String(ex.movement).toLowerCase())) ? 1 : 0;
      return muscleHit + moveHit;
    };
    // first pass: only exercises not yet used this week
    let scored = eligible.filter((ex) => !used.has(ex.id)).map((ex) => ({ ex, s: score(ex) })).sort((a, b) => b.s - a.s);
    let picked = [];
    const target = Math.max(4, Math.min(6, muscles.length + 1));
    for (const { ex } of scored) {
      if (picked.length >= target) break;
      picked.push(ex);
      used.add(ex.id);
    }
    // second pass: small libraries — reuse eligible exercises rather than emit an empty day
    if (!picked.length) {
      const reused = eligible.map((ex) => ({ ex, s: score(ex) })).sort((a, b) => b.s - a.s);
      for (const { ex } of reused) {
        if (picked.length >= Math.max(2, Math.min(4, target))) break;
        if (!picked.some((p) => p.id === ex.id)) picked.push(ex);
      }
    }
    return picked;
  };

  const used = new Set();
  const out = plan.map((day) => {
    const exercises = pickFor(day.muscles, day.movements, used).map((ex) => ({
      exercise_id: ex.id, name: ex.name, primary_muscle: ex.primary_muscle,
      secondary_muscles: ex.secondary_muscles, equipment: ex.equipment,
      movement: ex.movement, animation_key: ex.animation_key, sets: 3, reps: '10', rest_sec: 90
    }));
    return { name: day.name, focus: day.muscles, exercises };
  });

  return {
    ok: true,
    template: true,
    label: 'TEMPLATE — starting structure, not a medical/performance prescription',
    goal: String(goal || 'GENERAL').toUpperCase(),
    days: dayCount,
    equipment: reqEquipment,
    exclusions,
    splitStyle,
    durationMin: minutes ? parseInt(minutes, 10) : null,
    week: out.map((d, i) => ({ day: DAYS[i], ...d }))
  };
}
