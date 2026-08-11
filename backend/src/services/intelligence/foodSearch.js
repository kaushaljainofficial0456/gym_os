// ============================================================
// FOOD SEARCH — scope-aware (GLOBAL / GYM / MY FOODS) with
// aliases ("cottage cheese" → Paneer) and autocomplete.
// Backend-only: the browser never loads the full library.
// ============================================================

// Query foods visible to a client + alias expansion. Returns up to `limit`.
export async function searchFoods(db, orgId, clientId, q, { limit = 8 } = {}) {
  const term = String(q || '').trim();
  const lim = Math.min(limit, 25);

  let rows = [];
  if (!term) {
    // recent/global default: global library first
    rows = await db.q(
      `SELECT * FROM foods WHERE is_global = 1 ORDER BY name LIMIT ?`, [lim]);
  } else {
    const like = `%${term.toLowerCase()}%`;
    // 1) name match (all scopes visible to this client)
    rows = await db.q(
      `SELECT * FROM foods
        WHERE LOWER(name) LIKE ?
           OR (is_global = 1)
           OR (org_id = ? AND client_id IS NULL)
           OR (client_id = ?)
       ORDER BY CASE WHEN LOWER(name) LIKE ? THEN 0 ELSE 1 END, name
       LIMIT ?`,
      [like, orgId, clientId, `%${term.toLowerCase()}%`, lim]);
    if (rows.length < 3) {
      // 2) alias match — resolve to the food
      const aliased = await db.q(
        `SELECT f.* FROM food_aliases fa
          JOIN foods f ON f.id = fa.food_id
         WHERE LOWER(fa.alias) = ?
            AND (f.is_global = 1 OR f.org_id = ? OR f.client_id = ?)
         LIMIT ?`, [term.toLowerCase(), orgId, clientId, lim]);
      if (aliased.length) {
        // prefer exact alias match at the top
        rows = [...aliased, ...rows.filter((r) => !aliased.some((a) => a.id === r.id))].slice(0, lim);
      }
    }
  }

  return rows.map((f) => ({
    id: f.id, name: f.name, brand: f.brand || null,
    serving: f.serving || f.unit || null,
    calories: f.calories, protein: f.protein, carbs: f.carbs, fat: f.fat,
    category: f.category, cuisine: f.cuisine,
    source: f.source, scope: f.is_global === 1 ? 'GLOBAL' : f.client_id ? 'MY_FOOD' : 'GYM',
    matchedAlias: null
  }));
}

// Resolve a food name to exactly one row when unambiguous; else return candidates.
export async function resolveFood(db, orgId, clientId, nameHint) {
  const n = String(nameHint || '').trim().toLowerCase();
  if (!n) return { match: null, candidates: [], ambiguous: false };

  const direct = await db.q(
    `SELECT * FROM foods
      WHERE LOWER(name) = ?
        AND (is_global = 1 OR org_id = ? OR client_id = ?)
      LIMIT 1`, [n, orgId, clientId]);
  if (direct[0]) return { match: direct[0], candidates: [], ambiguous: false };

  const aliased = await db.q(
    `SELECT f.* FROM food_aliases fa JOIN foods f ON f.id = fa.food_id
      WHERE LOWER(fa.alias) = ? AND (f.is_global = 1 OR f.org_id = ? OR f.client_id = ?)
      LIMIT 1`, [n, orgId, clientId]);
  if (aliased[0]) return { match: aliased[0], candidates: [], ambiguous: false };

  const fuzzy = await db.q(
    `SELECT * FROM foods
      WHERE LOWER(name) LIKE ?
        AND (is_global = 1 OR org_id = ? OR client_id = ?)
      LIMIT 5`, [`%${n}%`, orgId, clientId]);
  return { match: null, candidates: fuzzy, ambiguous: fuzzy.length > 1 };
}
