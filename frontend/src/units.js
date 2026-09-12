/**
 * UNITS — display only. Storage is always metric.
 *
 * THE ONE RULE: every weight in this product is stored in kilograms and
 * every length in centimetres, always. This module converts at the two
 * boundaries where a human is involved -- rendering a number, and reading
 * one they typed -- and nowhere else.
 *
 * That rule is what prevents the two classic failures here:
 *
 *   DOUBLE CONVERSION. If any layer stored pounds, a value that passed
 *   through two formatters would be converted twice and nobody would
 *   notice until someone's weight history bent. Canonical storage makes
 *   that structurally impossible rather than merely unlikely.
 *
 *   DRIFT. 75 kg -> 165.3 lb -> 74.98 kg. Round-tripping a stored value
 *   through a display unit loses precision every time it is saved back.
 *   Since nothing is ever stored in imperial, nothing ever round-trips.
 *
 * Switching the preference therefore changes only what is drawn. No
 * migration, no backfill, and the same underlying number before and
 * after -- which is also why a chart cannot end up with mixed units: it
 * formats its own axis and points from one canonical series.
 */


/**
 * Number(null) is 0. Number('') is 0. Number(false) is 0.
 *
 * That is the single nastiest trap in this file: every "is it a number"
 * guard written as Number.isFinite(Number(x)) silently accepts absence
 * and turns it into zero -- so a client with no weight recorded renders
 * "0 kg", which is not missing data, it is a claim that they weigh
 * nothing. Caught by this module's own tests before it reached a screen.
 */
function toNumber(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'string' && value.trim() === '') return NaN;
  if (typeof value === 'boolean') return NaN;
  return Number(value);
}

export const KG_PER_LB = 0.45359237;   // exact, by definition
export const CM_PER_IN = 2.54;         // exact, by definition

export const UNIT_SYSTEMS = ['metric', 'imperial'];

/** Normalises anything the API might hand back into a valid system. */
export function normalizeSystem(value) {
  return value === 'imperial' ? 'imperial' : 'metric';
}

/* ---------- weight ---------- */

export const kgToLb = (kg) => kg / KG_PER_LB;
export const lbToKg = (lb) => lb * KG_PER_LB;

/** The unit label a weight is shown in. */
export const weightUnit = (system) => (normalizeSystem(system) === 'imperial' ? 'lb' : 'kg');

/**
 * A stored kg value as a display NUMBER in the user's system.
 * Returns null for anything non-finite so callers can branch on absence
 * rather than rendering "NaN lb".
 */
export function weightValue(kg, system, { decimals } = {}) {
  const n = toNumber(kg);
  if (!Number.isFinite(n)) return null;
  const imperial = normalizeSystem(system) === 'imperial';
  const out = imperial ? kgToLb(n) : n;
  /* One decimal by default in both systems. A pound is a finer division
     than a kilogram, so imperial does not need MORE precision to say the
     same thing -- and "165.35 lb" reads like a measurement error rather
     than a bodyweight. */
  const d = decimals ?? 1;
  const rounded = Math.round(out * 10 ** d) / 10 ** d;
  // Drop a trailing .0 so whole numbers read as whole numbers.
  return Number.isInteger(rounded) ? rounded : rounded;
}

/** "75 kg" / "165.3 lb". Absence renders as a dash, never as a bare unit. */
export function formatWeight(kg, system, { decimals, unit = true } = {}) {
  const v = weightValue(kg, system, { decimals });
  if (v == null) return '—';
  return unit ? `${v} ${weightUnit(system)}` : String(v);
}

/** Reads a number the user typed in THEIR unit back into canonical kg. */
export function parseWeightToKg(input, system) {
  const n = toNumber(typeof input === 'string' ? input.trim() : input);
  if (!Number.isFinite(n)) return null;
  return normalizeSystem(system) === 'imperial' ? lbToKg(n) : n;
}

/* ---------- length ---------- */

export const cmToIn = (cm) => cm / CM_PER_IN;
export const inToCm = (inches) => inches * CM_PER_IN;

export const lengthUnit = (system) => (normalizeSystem(system) === 'imperial' ? 'in' : 'cm');

export function lengthValue(cm, system, { decimals } = {}) {
  const n = toNumber(cm);
  if (!Number.isFinite(n)) return null;
  const imperial = normalizeSystem(system) === 'imperial';
  const out = imperial ? cmToIn(n) : n;
  const d = decimals ?? (imperial ? 1 : 0);
  return Math.round(out * 10 ** d) / 10 ** d;
}

export function formatLength(cm, system, { decimals, unit = true } = {}) {
  const v = lengthValue(cm, system, { decimals });
  if (v == null) return '—';
  return unit ? `${v} ${lengthUnit(system)}` : String(v);
}

export function parseLengthToCm(input, system) {
  const n = toNumber(typeof input === 'string' ? input.trim() : input);
  if (!Number.isFinite(n)) return null;
  return normalizeSystem(system) === 'imperial' ? inToCm(n) : n;
}

/**
 * Height is the one length people do not think of as a single number.
 * 175 cm is "5'9"", not "68.9 in" -- so imperial height gets feet and
 * inches, and metric stays a plain centimetre count.
 */
export function formatHeight(cm, system) {
  const n = toNumber(cm);
  if (!Number.isFinite(n)) return '—';
  if (normalizeSystem(system) !== 'imperial') return `${Math.round(n)} cm`;
  const totalInches = Math.round(cmToIn(n));
  const feet = Math.floor(totalInches / 12);
  const inches = totalInches % 12;
  return `${feet}′${inches}″`;
}

/**
 * A DELTA, which must never carry a sign it was not given. -6.6 kg is a
 * loss; formatting it as "6.6 kg" would turn a loss into a gain at a
 * glance, and every progress readout in this app shows one of these.
 */
export function formatWeightDelta(kg, system, { decimals } = {}) {
  const v = weightValue(kg, system, { decimals });
  if (v == null) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v} ${weightUnit(system)}`;
}
