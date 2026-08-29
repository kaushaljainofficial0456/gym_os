// ============================================================
// Minimal CSV rendering for the Admin Console's data-export routes
// (Phase 3c). Deliberately tiny and dependency-free -- no library
// needed for "rows of already-safe, already-selected fields to CSV".
// Callers are responsible for choosing which columns to include (see
// console.js's export routes) -- this never dumps a raw row/table, so
// a secret/password-hash column can only leak here if a caller
// explicitly names it, which none do.
// ============================================================
function escapeCsvValue(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** columns: [{ header, value: string | (row) => value }] */
export function toCsv(rows, columns) {
  const header = columns.map((c) => escapeCsvValue(c.header)).join(',');
  const lines = rows.map((row) =>
    columns.map((c) => escapeCsvValue(typeof c.value === 'function' ? c.value(row) : row[c.value])).join(','));
  return [header, ...lines].join('\n') + '\n';
}
