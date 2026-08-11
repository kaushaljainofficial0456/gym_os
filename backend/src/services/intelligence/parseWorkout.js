// ============================================================
// WORKOUT PARSER — natural-language set logging.
//   "Bench press 60kg 8 reps"              → 1 set, 60kg × 8
//   "Squat 100kg for 5"                    → 1 set, 100kg × 5
//   "3 sets of lat pulldown at 50kg for 10" → 3 sets, 50kg × 10
//   "Bench press 60x8, 65x6, 65x5"          → 3 sets
// Deterministic — no LLM required for the common forms.
// ============================================================
import { toNumber } from './units.js';

// Strip a leading "N sets of X" / "N sets X" prefix.
function matchSetPrefix(text) {
  const m = text.match(/^(\d+)\s+sets?\s+of\s+(.+)$/i) || text.match(/^(\d+)\s+sets?\s+(.+)$/i);
  if (m) {
    const sets = Math.max(1, Math.min(12, parseInt(m[1], 10)));
    return { sets, rest: m[2].trim() };
  }
  return null;
}

// One "weight x reps" cell: 60x8 / 60kg x 8 / 60 × 8 / 60kg for 8
function parseCell(cell) {
  const c = String(cell).trim();
  let w = null, r = null;
  let m = c.match(/^([\d.]+)\s*(?:kg|kgs)?\s*[x×]\s*([\d.]+)\s*(?:reps?)?$/i);
  if (m) { w = toNumber(m[1]); r = toNumber(m[2]); }
  else {
    m = c.match(/^([\d.]+)\s*(?:kg|kgs)\s*(?:for\s+|@\s*)?([\d.]+)\s*(?:reps?)?$/i);
    if (m) { w = toNumber(m[1]); r = toNumber(m[2]); }
    else {
      m = c.match(/^([\d.]+)\s*(?:reps?)?\s*$/i);
      if (m) r = toNumber(m[1]);
    }
  }
  return w === null && r === null ? null : { weight: w, reps: r };
}

// Split "60x8, 65x6, 65x5" into cells, or treat as single cell.
function splitCells(text) {
  // commas or spaces between weight×reps groups
  const groups = text.split(/\s*,\s*|\s+and\s+/i).map((g) => g.trim()).filter(Boolean);
  const cells = groups.map(parseCell).filter(Boolean);
  if (cells.length && cells.length === groups.length) return cells;
  const single = parseCell(text);
  return single ? [single] : null;
}

export function parseWorkoutInput(input) {
  const s = String(input || '').trim();
  if (!s) return { ok: false, error: 'Empty input' };

  // strip leading noise: "today I did", "i did", "did", "did " (case-insensitive)
  let text = s.replace(/^(today\s+i\s+)?(i\s+)?(did|performed|completed|did)\s+/i, '');

  // explicit "N sets of X at W for R"
  const prefix = matchSetPrefix(text);
  let setsCount = null;
  if (prefix) { setsCount = prefix.sets; text = prefix.rest; }

  // now text is like "bench press 60x8, 65x6, 65x5" or "lat pulldown at 50kg for 10"
  // pull the set cells off the tail: they end the string
  let cells = null;
  const cellTail = text.match(/^(.*?)\s+((?:[\d.]+\s*(?:kg)?\s*[x×]\s*[\d.]+\s*(?:reps?)?(?:\s*,\s*|\s+and\s+)?)+)$/i);
  if (cellTail) {
    const name = cellTail[1].trim().replace(/\s+(?:at|with)\s+.*$/i, '').trim();
    cells = splitCells(cellTail[2]);
    if (cells && name) {
      return finalize(name, setsCount, cells);
    }
  }

  // "Squat 100kg for 5" — weight then "for N reps"
  const wf = text.match(/^(.*?)\s+([\d.]+)\s*(?:kg)?\s*(?:for|@)\s*([\d.]+)\s*(?:reps?)?$/i);
  if (wf) {
    const name = wf[1].trim();
    const cells2 = [{ weight: toNumber(wf[2]), reps: toNumber(wf[3]) }];
    return finalize(name, setsCount, cells2);
  }

  // "Bench press 60kg 8 reps"
  const wr = text.match(/^(.*?)\s+([\d.]+)\s*(?:kg)?\s+([\d.]+)\s*(?:reps?)?$/i);
  if (wr) {
    const name = wr[1].trim();
    const cells3 = [{ weight: toNumber(wr[2]), reps: toNumber(wr[3]) }];
    return finalize(name, setsCount, cells3);
  }

  return { ok: false, error: 'Could not recognize a workout (try "Bench press 60kg 8 reps" or "Bench press 60x8, 65x6")' };
}

function finalize(name, setsCount, cells) {
  let sets = cells;
  if (setsCount && sets.length === 1) {
    // "3 sets of X at 50 for 10" → replicate the cell 3×
    sets = Array.from({ length: setsCount }, () => ({ ...cells[0] }));
  }
  const anyWeight = sets.some((s) => s.weight != null);
  return {
    ok: true,
    exercise: name,
    sets: sets.map((s, i) => ({
      set_number: i + 1,
      weight: s.weight,
      reps: s.reps,
      prescribed_weight: s.weight,
      prescribed_reps: s.reps
    })),
    totalSets: sets.length,
    weightSuspicion: anyWeight ? null : 'no weight given — bodyweight assumed',
    confidence: sets.length > 0 ? 'HIGH' : 'LOW'
  };
}
