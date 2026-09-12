/**
 * UNITS, SERVER SIDE — for generated PROSE only.
 *
 * Storage is kilograms and centimetres everywhere, and the API returns
 * canonical numbers so the client formats its own screens (see
 * frontend/src/units.js). This module exists for the one case the client
 * cannot fix: sentences composed here.
 *
 * Progress insights are written as English, not as data -- "Your weight
 * moved -4.5 kg over the last 84 days" is a string by the time it leaves
 * the server, with the unit baked into it. A client reading in pounds saw
 * its own header in lb and the sentence under it in kg. The fix is either
 * to return every insight as a template plus operands, or to render the
 * sentence in the reader's unit here. The second is far less machinery
 * for the same result, because the generator already knows whose data it
 * is reading.
 *
 * The constants are the same exact definitions as the client's, so a
 * number formatted on either side of the wire agrees to the last digit.
 */

export const KG_PER_LB = 0.45359237;   // exact, by definition
export const CM_PER_IN = 2.54;         // exact, by definition

export const normalizeSystem = (v) => (v === 'imperial' ? 'imperial' : 'metric');

const toNumber = (value) => {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'string' && value.trim() === '') return NaN;
  if (typeof value === 'boolean') return NaN;
  return Number(value);
};

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

export const weightUnit = (system) => (normalizeSystem(system) === 'imperial' ? 'lb' : 'kg');
export const lengthUnit = (system) => (normalizeSystem(system) === 'imperial' ? 'in' : 'cm');

/** Canonical kg -> a display NUMBER, or null when there is nothing to show. */
export function weightValue(kg, system, decimals = 1) {
  const n = toNumber(kg);
  if (!Number.isFinite(n)) return null;
  return round(normalizeSystem(system) === 'imperial' ? n / KG_PER_LB : n, decimals);
}

/** "75 kg" / "165.3 lb". */
export function formatWeight(kg, system, decimals = 1) {
  const v = weightValue(kg, system, decimals);
  return v == null ? null : `${v} ${weightUnit(system)}`;
}

/** Keeps the sign, because a loss rendered without one reads as a gain. */
export function formatWeightDelta(kg, system, decimals = 1) {
  const v = weightValue(kg, system, decimals);
  if (v == null) return null;
  return `${v > 0 ? '+' : ''}${v} ${weightUnit(system)}`;
}

export function lengthValue(cm, system, decimals) {
  const n = toNumber(cm);
  if (!Number.isFinite(n)) return null;
  const imperial = normalizeSystem(system) === 'imperial';
  return round(imperial ? n / CM_PER_IN : n, decimals ?? (imperial ? 1 : 0));
}

export function formatLength(cm, system, decimals) {
  const v = lengthValue(cm, system, decimals);
  return v == null ? null : `${v} ${lengthUnit(system)}`;
}

/**
 * A small bound formatter, so a generator writing many sentences does not
 * have to thread the system through every call -- which is exactly how
 * one sentence in a paragraph ends up in the wrong unit.
 */
export function unitsFor(system) {
  const s = normalizeSystem(system);
  return {
    system: s,
    weightUnit: weightUnit(s),
    lengthUnit: lengthUnit(s),
    isImperial: s === 'imperial',
    w: (kg, decimals = 1) => formatWeight(kg, s, decimals),
    wDelta: (kg, decimals = 1) => formatWeightDelta(kg, s, decimals),
    wNum: (kg, decimals = 1) => weightValue(kg, s, decimals),
    l: (cm, decimals) => formatLength(cm, s, decimals),
  };
}
