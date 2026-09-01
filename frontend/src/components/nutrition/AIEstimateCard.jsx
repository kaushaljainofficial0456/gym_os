/**
 * AI ESTIMATE CARD — the compact preview shown after "Estimate with AI"
 * inside a search row, before the estimate is committed: food name,
 * a confidence-style badge, an editable grams field, the live-scaled
 * kcal preview, any assumptions the model made, and Cancel/Add.
 *
 * Extracted from MealFoodRow.jsx (Part 53's suggested component
 * breakdown) so it's one named, self-contained piece rather than an
 * inline block -- deliberately dumb/presentational: it owns no state
 * of its own, just renders `preview` and reports grams changes/cancel/
 * add back up to whoever holds the actual aiPreview/aiGrams state
 * (MealFoodRow.jsx today; any future compact AI-preview spot could
 * reuse this as-is). `validation_status === 'COMMUNITY_VALIDATED_CANDIDATE'`
 * is about community evidence backing the CACHED estimate -- a
 * different concept from a Tier-1/3 search-match percentage, never
 * labelled the same way (same rule FoodLogSheet.jsx's own fuller AI-
 * review screen follows for the identical field).
 */
export default function AIEstimateCard({ preview, grams, onGramsChange, onCancel, onAdd, disabled, t }) {
  const baseGrams = preview.serving?.estimated_weight_g || 100;
  const kcal = Math.round((preview.totals.calories || 0) * (Number(grams) || 0) / baseGrams);

  return (
    <div className="mt-1.5 rounded-lg p-2.5 space-y-1.5 anim-fadeIn" style={{ background: t.glass, border: `1px solid ${t.border}` }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 font-grotesk text-[11px] font-bold truncate" style={{ color: t.ink }}>{preview.food_name}</div>
        <span className="text-[7px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded-full shrink-0" style={{ background: t.accentDim, color: t.accent }}>
          {preview.validation_status === 'COMMUNITY_VALIDATED_CANDIDATE' ? '✓ SK OS Estimated' : '✨ AI Estimated'}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <input type="number" min="1" value={grams} onChange={(e) => onGramsChange(e.target.value)}
                 aria-label="Grams" className="w-14 text-[10px] rounded px-1.5 py-1 tabular-nums" style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.ink }} />
          <span className="text-[9px]" style={{ color: t.faint }}>g</span>
        </div>
        <div className="text-right font-grotesk text-[10px]" style={{ color: t.mute }}>~{kcal} kcal</div>
      </div>
      {preview.assumptions?.length > 0 && (
        <div className="text-[9px] leading-relaxed" style={{ color: t.faint }}>Estimated: {preview.assumptions.join(' · ')}</div>
      )}
      <div className="flex gap-1.5">
        <button onClick={onCancel} className="flex-1 py-1 rounded-md font-grotesk text-[9px] font-semibold" style={{ border: `1px solid ${t.border}`, color: t.mute }}>Cancel</button>
        <button onClick={onAdd} disabled={disabled} className="flex-1 py-1 rounded-md font-grotesk text-[9px] font-bold" style={{ background: t.accent, color: 'var(--accent-contrast)' }}>Add to Meal</button>
      </div>
    </div>
  );
}
