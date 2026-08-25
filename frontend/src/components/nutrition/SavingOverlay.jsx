/**
 * SAVING OVERLAY — the one premium loading→success(→error) animation used
 * everywhere the Nutrition redesign needs one: Today's Eaten edits, My
 * Diet edits, Custom Meal save, Share Meals, saving a shared meal. Built
 * once and reused rather than five bespoke versions, per spec's own
 * "consistent SK OS loading language" requirement.
 *
 * Stages: 'saving' (rotating ring + pulsing center), 'success' (ring
 * morphs into a drawn checkmark), 'error' (ring morphs into an X).
 * Timing is entirely caller-controlled -- this component never fakes a
 * delay; it renders whatever `stage` the caller is currently in, for as
 * long as the caller keeps `open` true. `prefers-reduced-motion` is
 * already handled globally (theme.css collapses all animation/transition
 * durations to ~0), so this needs no separate reduced-motion branch.
 *
 * mode="overlay": full dimmed backdrop + centered card (the "large
 *   circular saving animation" the spec asks for on meal/share saves).
 * mode="inline": compact, no backdrop -- drops into a button or a small
 *   card footer (the "compact animated circular loader" for lighter
 *   operations like Today's Eaten / My Diet edit saves).
 */
export default function SavingOverlay({ open, stage = 'saving', label, sublabel, mode = 'overlay', size = 'lg' }) {
  if (!open) return null;

  const dim = size === 'sm' ? 40 : 84;
  const stroke = size === 'sm' ? 3.5 : 6;
  const r = (dim - stroke) / 2;
  const C = 2 * Math.PI * r;

  const ring = (
    <div className="relative shrink-0" style={{ width: dim, height: dim }}>
      <svg width={dim} height={dim} className="-rotate-90">
        <circle cx={dim / 2} cy={dim / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
        {stage === 'saving' && (
          <circle
            cx={dim / 2} cy={dim / 2} r={r} fill="none" stroke="var(--accent)" strokeWidth={stroke}
            strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * 0.72}
            style={{ transformOrigin: '50% 50%', animation: 'so-spin 0.9s linear infinite' }}
          />
        )}
        {stage !== 'saving' && (
          <circle
            cx={dim / 2} cy={dim / 2} r={r} fill="none"
            stroke={stage === 'error' ? 'var(--bad, #F87171)' : 'var(--accent)'}
            strokeWidth={stroke} strokeLinecap="round" strokeDasharray={C} strokeDashoffset={0}
            style={{ transition: 'stroke-dashoffset .5s cubic-bezier(.22,.8,.3,1)' }}
          />
        )}
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        {stage === 'saving' && (
          <div className="rounded-full" style={{
            width: dim * 0.28, height: dim * 0.28, background: 'var(--accent)',
            animation: 'so-pulse 1.1s ease-in-out infinite',
          }} />
        )}
        {stage === 'success' && (
          <svg width={dim * 0.5} height={dim * 0.5} viewBox="0 0 24 24" fill="none"
               stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
               style={{ animation: 'checkPop .35s cubic-bezier(.22,.8,.3,1) both' }}>
            <path d="M20 6 9 17l-5-5" pathLength="1"
                  style={{ strokeDasharray: 1, strokeDashoffset: 0, animation: 'so-draw .35s ease-out both' }} />
          </svg>
        )}
        {stage === 'error' && (
          <svg width={dim * 0.42} height={dim * 0.42} viewBox="0 0 24 24" fill="none"
               stroke="var(--bad, #F87171)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
               style={{ animation: 'checkPop .3s cubic-bezier(.22,.8,.3,1) both' }}>
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        )}
      </div>
    </div>
  );

  const textBlock = (
    <div className={mode === 'inline' ? '' : 'mt-3 text-center'}>
      <div className="font-grotesk font-bold" style={{ fontSize: mode === 'inline' ? 12 : 14, color: 'var(--ink)' }}>{label}</div>
      {sublabel && <div className="font-grotesk mt-0.5" style={{ fontSize: 11, color: 'var(--mute)' }}>{sublabel}</div>}
    </div>
  );

  if (mode === 'inline') {
    return (
      <div className="flex items-center gap-2.5 anim-fadeIn">
        {ring}
        {textBlock}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center p-4 anim-fadeIn"
         style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(10px)' }}>
      <div className="anim-scaleIn flex flex-col items-center rounded-3xl px-10 py-9" style={{
        background: 'var(--panel)', border: '1px solid var(--line)',
        boxShadow: '0 30px 70px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.02) inset',
        // subtle 3D depth: a slight upward "lift" rather than a full perspective transform
        transform: 'translateZ(0)',
      }}>
        {ring}
        {textBlock}
      </div>
    </div>
  );
}
