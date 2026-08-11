// Pure training-program validation (also used by unit tests).
// The route additionally verifies template_ids exist in the org (tenant-safe).
export const SPLITS = ['PPL_3', 'PPL_4', 'PPL_5', 'PPL_6', 'UPPER_LOWER', 'FULL_BODY_2', 'FULL_BODY_3', 'CUSTOM'];

export function validateProgram(body) {
  const errors = [];
  const b = body || {};
  if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100) {
    errors.push('name is required (max 100 chars)');
  }
  if (!SPLITS.includes(b.split)) {
    errors.push(`split must be one of: ${SPLITS.join(', ')}`);
  }
  if (!Array.isArray(b.days)) {
    errors.push('days must be an array');
    return { ok: false, errors };
  }
  if (b.days.length > 7) errors.push('a program cannot have more than 7 days');
  const trainingDays = b.days.filter(d => d.template_id);
  if (!trainingDays.length) errors.push('at least one training day must have a template');
  const dows = b.days.map(d => d.day_of_week);
  if (new Set(dows).size !== dows.length) errors.push('day_of_week values must be unique (0=Sun..6=Sat)');
  for (const d of b.days) {
    if (!Number.isInteger(d.day_of_week) || d.day_of_week < 0 || d.day_of_week > 6) {
      errors.push('day_of_week must be an integer 0-6');
    }
    if (typeof d.name !== 'string' || !d.name.trim() || d.name.length > 60) {
      errors.push('every day needs a name (max 60 chars)');
    }
  }
  return { ok: errors.length === 0, errors };
}
