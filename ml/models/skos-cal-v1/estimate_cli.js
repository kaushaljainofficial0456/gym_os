// Test harness: runs the REAL mlEstimate.reference.js against a workout.
// Usage: node estimate_cli.js session.json
// Shows the full working, not just the final number.
const fs = require('fs');
const { mlEstimate } = require('./mlEstimate.reference.js');
const MODEL = require('./model_v1.json');

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const trained = MODEL.correction_kcal_per_min_by_exercise_and_tier;

// ---- pre-flight: what does the model actually recognise? ----
const exs = (input.exercises || []).filter(e => (e.completed_sets || []).length > 0);
const known = exs.filter(e => trained[e.exercise_id]);
const unknown = exs.filter(e => !trained[e.exercise_id]);
const totalVol = exs.reduce((s, e) => s + (e.total_volume_kg || 0), 0);
const knownVol = known.reduce((s, e) => s + (e.total_volume_kg || 0), 0);

console.log('='.repeat(74));
console.log('SK OS calorie model — skos-cal-v1');
console.log('='.repeat(74));
console.log(`Body weight      : ${input.user.body_weight_kg} kg`);
console.log(`Duration         : ${input.session.duration_minutes} min`);
console.log(`Intensity rating : ${input.session.intensity_rating}`);
console.log(`Exercises logged : ${exs.length}   (${known.length} trained, ${unknown.length} untrained)`);
console.log(`Total volume     : ${totalVol.toLocaleString()} kg`);
if (totalVol > 0) console.log(`Volume on trained exercises: ${(knownVol / totalVol * 100).toFixed(0)}%`);
console.log();

console.log('Per-exercise:');
console.log('  ' + 'exercise'.padEnd(26) + 'sets'.padEnd(6) + 'volume kg'.padEnd(12) + 'model coverage');
for (const e of exs) {
  const isKnown = !!trained[e.exercise_id];
  const corr = isKnown ? trained[e.exercise_id][normTier(input.session.intensity_rating)] : null;
  console.log('  ' + String(e.exercise_id).padEnd(26)
    + String(e.sets ?? '-').padEnd(6)
    + String(e.total_volume_kg ?? '-').padEnd(12)
    + (isKnown ? `TRAINED (correction ${corr >= 0 ? '+' : ''}${corr} kcal/min)` : 'baseline only'));
}
function normTier(r) { const t = String(r || '').toLowerCase().trim(); return ['light','moderate','hard'].includes(t) ? t : 'moderate'; }

// ---- the actual model ----
const out = mlEstimate(input);

const met = MODEL.baseline.met_by_tier[normTier(input.session.intensity_rating)];
const baselineRate = met * 3.5 * input.user.body_weight_kg / 200;
const impliedRate = out.estimated_active_kcal / input.session.duration_minutes;

console.log();
console.log('-'.repeat(74));
console.log(`MET baseline (${normTier(input.session.intensity_rating)} = ${met} MET) : ${baselineRate.toFixed(2)} kcal/min`);
console.log(`Final rate after correction        : ${impliedRate.toFixed(2)} kcal/min`);
console.log('-'.repeat(74));
console.log();
console.log(`  ESTIMATE : ${out.estimated_active_kcal} kcal`);
console.log(`  RANGE    : ${out.lower_kcal} – ${out.upper_kcal} kcal   (90% interval)`);
console.log();
console.log(`  model_version: ${out.model_version} | schema: ${out.schema_version}`);
if (out.note) {
  console.log();
  console.log('  FLAGS RAISED:');
  for (const n of out.note.split(' | ')) console.log(`    • ${n}`);
}
console.log();
