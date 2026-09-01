/**
 * CUSTOM FOOD BADGE — the small provenance pill shown on an already-
 * added meal item: "✓ Database" for anything backed by a real `foods`
 * row (a database match, a client's own private/custom food saved via
 * Custom Macros, or a shared-and-saved item — all of these end up as a
 * real `foods` row and are logged via the ordinary `food_id` path, so
 * they're indistinguishable at this level and correctly share one
 * label) vs "✨ AI Estimated" for anything logged via the `ai_estimate`
 * payload shape instead. Never invents a third label for "custom" vs
 * "database" specifically -- provenance in this schema is about HOW a
 * number was obtained (measured/database vs AI-estimated), not WHO
 * owns the row, and conflating the two would misrepresent a hand-typed
 * Custom Macros entry as somehow less trustworthy than a catalogue
 * match, which it isn't (both are `source: 'database'`, see
 * CustomizeMealSheet.jsx's own header comment on this).
 *
 * Extracted from CustomizeMealSheet.jsx's items list (Part 53's
 * suggested component breakdown) -- previously an inline ternary,
 * pulled out so any future "already-added item" list can reuse the
 * exact same label/color logic without re-typing it.
 */
export default function CustomFoodBadge({ source, t }) {
  // meal_items.source is only ever 'database' or 'ai_estimated' today
  // (POST /meals/:id/items always writes one of those two) -- the
  // 'ai_estimated_user_adjusted' value only exists on meal_logs (a
  // client's own adjustment-before-logging flow that meal ITEMS don't
  // have), included here too since it's the same "this came from AI"
  // fact if this badge is ever reused somewhere that value can appear.
  const isAI = source === 'ai_estimated' || source === 'ai_estimated_user_adjusted';
  return (
    <span className="shrink-0 text-[8px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded-full"
          style={{ background: isAI ? t.accentDim : `${t.fat}18`, color: isAI ? t.accent : t.fat }}>
      {isAI ? '✨ AI Estimated' : '✓ Database'}
    </span>
  );
}
