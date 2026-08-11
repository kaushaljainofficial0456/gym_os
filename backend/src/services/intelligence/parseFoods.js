// ============================================================
// FOOD PARSER — turns natural-language food input into
// structured items: { text, quantity, unit, nameHint }.
//   "220g paneer"                  → [{ qty:220, unit:'g', name:'paneer' }]
//   "2 rotis and 150g rice"        → 2 items
//   "100g oats + 250ml milk"       → 2 items
//   "3 eggs"                       → [{ qty:3, unit:'egg' }]
// This is deterministic regex + unit parsing — no LLM required
// for the common cases. Ambiguity is surfaced to the caller.
// ============================================================
import { parseQuantity, toNumber } from './units.js';

// Split a food string into segments on +, commas, and "and"/"with".
export function splitFoodItems(input) {
  const s = String(input || '').trim();
  if (!s) return [];
  return s
    .split(/\s*(?:\+|,|&)\s*|\s+\band\b\s+|\s+\bwith\b\s+/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

// Unit words that are themselves the food name ("2 rotis", "3 eggs", "1 banana").
// Generic piece words (pc, piece, slice, serving) are NOT food names.
const FOOD_WORD_UNITS = new Set([
  'roti', 'rotis', 'chapati', 'chapatis', 'phulka', 'phulkas',
  'egg', 'eggs', 'banana', 'bananas', 'apple', 'apples',
  'orange', 'oranges', 'idli', 'idlis', 'dosa', 'dosas', 'paratha', 'parathas'
]);

function singular(word) {
  return word.endsWith('s') && word.length > 3 ? word.slice(0, -1) : word;
}

// Parse one segment into { qty, unit, unitType, provenance, name, raw }.
export function parseFoodSegment(segment) {
  let raw = String(segment || '').trim();
  if (!raw) return null;
  // strip leading narration + trailing punctuation
  raw = raw.replace(/^(i\s+)?(ate|had|consumed|took|have eaten|had eaten|having)\s+/i, '').replace(/[.!,;]+$/, '').trim();
  if (!raw) return null;

  // 1) NUMBER UNIT NAME  → "220g paneer", "1 cup curd", "0.22kg paneer"
  const qun = raw.match(/^([\d.,]+\s*[a-zA-Z]+)\s+(.+)$/);
  if (qun) {
    const qty = parseQuantity(qun[1]);
    if (qty) return { ...qty, name: qun[2].trim().replace(/^of\s+/i, ''), raw };
  }
  // 2) NUMBER UNIT alone → "2 rotis", "3 eggs", "250ml"
  const qu = raw.match(/^([\d.,]+\s*[a-zA-Z]+)$/);
  if (qu) {
    const qty = parseQuantity(qu[1]);
    if (qty) {
      // "2 rotis" — the unit IS the food; use it as the search name
      const unitWord = String(qty.unit || '').toLowerCase();
      const name = FOOD_WORD_UNITS.has(unitWord) ? singular(unitWord) : null;
      return { ...qty, name, raw };
    }
  }
  // 3) NUMBER NAME (no unit stated) → "3 eggs" when "eggs" isn't a unit we know, "2 apples"
  const num = raw.match(/^([\d.,]+)\s+(.+)$/);
  if (num) {
    const qty = parseQuantity(num[1]);
    if (qty) return { ...qty, name: num[2].trim().replace(/^of\s+/i, ''), raw };
  }
  // 4) Quantity as suffix: "paneer - 220g"
  const sfx = raw.match(/^(.*?)\s*[-–]\s*([\d.,]+\s*[a-zA-Z]+)\s*$/);
  if (sfx) {
    const qty = parseQuantity(sfx[2]);
    if (qty) return { ...qty, name: sfx[1].trim(), raw };
  }
  // 5) bare number
  const bare = raw.match(/^([\d.,]+)$/);
  if (bare) {
    const qty = parseQuantity(bare[1]);
    return qty ? { ...qty, name: null, raw } : { qty: toNumber(bare[1]), unit: null, unitType: 'serving', provenance: 'USER_ENTERED', name: null, raw };
  }
  return { qty: null, unit: null, unitType: null, provenance: 'USER_ENTERED', name: raw, raw };
}

// Full parse: returns items plus a flag for unparseable input.
export function parseFoodInput(input) {
  const segments = splitFoodItems(input);
  const items = segments.map(parseFoodSegment).filter(Boolean);
  const unparseable = segments.length !== items.length || segments.length === 0;
  return { items, unparseable, input };
}
