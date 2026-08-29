// Sparse, low-opacity background decoration -- used only on the
// highest-value screens (Dashboard, Login) per the design brief:
// "keep them sparse... never interfere with clicks... never reduce
// readability." Pure inline SVG (no external assets), styled entirely
// through .deco-layer in styles.css (opacity, color-from-token, slow
// drift, reduced-motion-safe). The parent element needs
// `position: relative` for this to lay out correctly.
export default function Decoration({ variant = 'dashboard' }) {
  return (
    <div className="deco-layer" aria-hidden="true">
      <svg className="d1" viewBox="0 0 100 100" fill="none" stroke="currentColor" strokeWidth="1.4">
        <circle cx="50" cy="50" r="38" />
        <circle cx="50" cy="50" r="24" />
      </svg>
      <svg className="d2" viewBox="0 0 100 60" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M20 30v20M80 30v20M12 36v8M88 36v8M20 40h60" />
      </svg>
      {variant === 'dashboard' && (
        <svg className="d3" viewBox="0 0 60 60" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M32 4 12 34h14l-3 22 21-30H30l2-22Z" />
        </svg>
      )}
    </div>
  );
}
