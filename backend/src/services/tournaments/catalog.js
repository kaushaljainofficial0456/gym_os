// ============================================================
// TOURNAMENTS: what can be competed in, and how it is measured.
//
// `metric` decides everything downstream: which way a score ranks, how it
// is recorded (tap counter, stopwatch, lift entry) and how it is written.
// A custom competition picks a metric and inherits all of that.
// ============================================================

export const METRICS = Object.freeze({
  reps: { label: 'Most reps', unit: 'reps', higherWins: true, max: 100_000 },
  time_high: { label: 'Longest time', unit: 'time', higherWins: true, max: 86_400 },
  time_low: { label: 'Fastest time', unit: 'time', higherWins: false, max: 86_400 },
  weight: { label: 'Heaviest lift', unit: 'kg', higherWins: true, max: 1_000 },
  distance: { label: 'Furthest distance', unit: 'm', higherWins: true, max: 1_000_000 },
  wins: { label: 'Most wins', unit: 'wins', higherWins: true, max: 10_000 },
});

export const EVENT_CATALOG = Object.freeze([
  { kind: 'squats', name: 'Squats', metric: 'reps', icon: 'dumbbell' },
  { kind: 'push_ups', name: 'Push-ups', metric: 'reps', icon: 'flame' },
  { kind: 'pull_ups', name: 'Pull-ups', metric: 'reps', icon: 'biceps' },
  { kind: 'burpees', name: 'Burpees', metric: 'reps', icon: 'zap' },
  { kind: 'sit_ups', name: 'Sit-ups', metric: 'reps', icon: 'target' },
  { kind: 'plank', name: 'Plank hold', metric: 'time_high', icon: 'timer' },
  { kind: 'wall_sit', name: 'Wall sit', metric: 'time_high', icon: 'timer' },
  { kind: 'dead_hang', name: 'Dead hang', metric: 'time_high', icon: 'timer' },
  { kind: 'deadlift', name: 'Deadlift', metric: 'weight', icon: 'dumbbell', attempts: 3 },
  { kind: 'bench_press', name: 'Bench press', metric: 'weight', icon: 'dumbbell', attempts: 3 },
  { kind: 'back_squat', name: 'Back squat', metric: 'weight', icon: 'dumbbell', attempts: 3 },
  { kind: 'farmer_carry', name: 'Farmer carry', metric: 'distance', icon: 'footprints' },
  { kind: 'sprint', name: 'Sprint', metric: 'time_low', icon: 'rocket' },
  { kind: 'rowing', name: '500 m row', metric: 'time_low', icon: 'rocket' },
  { kind: 'tug_of_war', name: 'Tug of war', metric: 'wins', icon: 'swords', team: true },
  { kind: 'relay', name: 'Team relay', metric: 'time_low', icon: 'swords', team: true },
]);

export const THEMES = Object.freeze(['ember', 'neon', 'ocean', 'volt', 'royal']);

// Tournament points for a finishing place, across all competitions.
export const PLACE_POINTS = Object.freeze([10, 7, 5, 4, 3, 2, 1]);
export const pointsForRank = (rank) => (rank ? (PLACE_POINTS[rank - 1] || 0) : 0);

export const LIMITS = Object.freeze({
  events: 12, attempts: 5, positions: 10, nameLength: 80, peoplePerSearch: 12,
});
