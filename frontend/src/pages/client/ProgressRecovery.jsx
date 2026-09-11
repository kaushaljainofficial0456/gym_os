/**
 * PROGRESS — recovery and transformation.
 *
 * Both sections are strictly capability-gated: they render only when the
 * data genuinely exists. Neither has a "connect a wearable" placeholder,
 * because that offer lives in exactly ONE place on the page (the unlock
 * module) and repeating it as a ghost section is the wall-of-empty-cards
 * problem this screen is built to avoid.
 */
import { useState } from 'react';
import { Card } from '../../components/UI.jsx';

const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

/* ══════════════════════════ recovery ══════════════════════════ */

/**
 * Relationships between training and recovery are surfaced only when
 * there are enough paired days to say anything at all, and they are
 * phrased as what the data SHOWS — never as one thing causing the other.
 */
export function RecoverySection({ intel, Section, Stat }) {
  const caps = intel.capabilities || {};
  const days = intel.health?.days || [];
  const has = (k) => caps[k]?.available;
  if (!has('sleep') && !has('recovery') && !has('readiness')) return null;

  const vals = (field) => days.map((d) => d[field]).filter((v) => v != null);
  const sleepHrs = mean(vals('sleep_duration_seconds').map((s) => s / 3600));
  const recovery = mean(vals('recovery_score'));
  const readiness = mean(vals('readiness_score'));
  const source = caps.sleep?.source || caps.recovery?.source;

  // Pair each day's training volume with THAT day's sleep.
  const sessions = new Map((intel.training?.sessions || []).map((s) => [s.date, s.volume || 0]));
  const paired = days
    .filter((d) => d.sleep_duration_seconds != null)
    .map((d) => ({ sleep: d.sleep_duration_seconds / 3600, volume: sessions.get(d.date) || 0 }));

  let relationship = null;
  if (paired.length >= 10) {
    const trained = paired.filter((p) => p.volume > 0);
    const rest = paired.filter((p) => p.volume === 0);
    // Both groups need a real sample; a "pattern" from two rest days is noise.
    if (trained.length >= 4 && rest.length >= 4) {
      const t = mean(trained.map((p) => p.sleep));
      const r = mean(rest.map((p) => p.sleep));
      const diffMin = Math.round((t - r) * 60);
      if (Math.abs(diffMin) >= 24) {
        relationship = `You sleep about ${Math.abs(diffMin)} minutes ${diffMin > 0 ? 'more' : 'less'} on days you train than on rest days.`;
      }
    }
  }

  const fmtSleep = (h) => (h == null ? null : `${Math.floor(h)}h ${Math.round((h % 1) * 60)}m`);

  return (
    <Section title="Recovery">
      <Card className="p-4">
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Avg sleep" value={fmtSleep(sleepHrs)} />
          <Stat label="Recovery" value={recovery != null ? Math.round(recovery) : null} unit="%" />
          <Stat label="Readiness" value={readiness != null ? Math.round(readiness) : null} />
        </div>

        {relationship && (
          <div className="mt-3 border-t pt-2.5" style={{ borderColor: 'var(--line)' }}>
            <div className="text-[11.5px] leading-snug" style={{ color: 'var(--mute)' }}>{relationship}</div>
            <div className="mt-1 text-[10px]" style={{ color: 'var(--faint)' }}>
              An observed pattern across {paired.length} days — not a claim that one causes the other.
            </div>
          </div>
        )}

        {source && (
          <div className="mt-2 text-[9.5px] uppercase tracking-[.08em]" style={{ color: 'var(--faint)' }}>
            From {source}
          </div>
        )}
      </Card>
    </Section>
  );
}

/* ══════════════════════════ transformation ══════════════════════════ */

/**
 * Before/after with a draggable wipe.
 *
 * The photos are layered and revealed by a wipe rather than shown side by
 * side: at phone width, side-by-side gives each image roughly 45% of the
 * screen, which is too small to see the thing the user is actually looking
 * for. Both images use object-fit: cover in an identical frame, so neither
 * is ever scaled non-uniformly — distorting a progress photo would imply a
 * change that did not happen.
 */
export function TransformationSection({ photos, Section }) {
  const [pct, setPct] = useState(50);
  const [view, setView] = useState(null);
  if (!photos?.length) return null;

  const byView = photos.reduce((acc, p) => {
    const k = p.view || 'front';
    (acc[k] = acc[k] || []).push(p);
    return acc;
  }, {});
  const views = Object.keys(byView);
  const activeView = views.includes(view) ? view : views[0];
  const set = [...byView[activeView]].sort((a, b) => (a.taken_at < b.taken_at ? -1 : 1));
  const first = set[0];
  const last = set[set.length - 1];
  const spanDays = Math.round((Date.parse(last.taken_at) - Date.parse(first.taken_at)) / 86400000);

  return (
    <Section title="Transformation">
      <Card className="p-4">
        {views.length > 1 && (
          <div className="mb-3 flex gap-1.5">
            {views.map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className="rounded-full px-3 text-[11px] font-semibold capitalize"
                style={{
                  minHeight: 32,
                  background: v === activeView ? 'var(--cta-solid)' : 'transparent',
                  color: v === activeView ? 'var(--cta-ink)' : 'var(--mute)',
                  border: `1px solid ${v === activeView ? 'var(--cta-edge)' : 'var(--line)'}`,
                }}
              >
                {v}
              </button>
            ))}
          </div>
        )}

        {set.length >= 2 ? (
          <>
            <div className="relative overflow-hidden rounded-[var(--r-sm)]" style={{ aspectRatio: '3/4', background: 'var(--line)' }}>
              <img
                src={last.imageUrl} alt={`Most recent ${activeView} progress photo`}
                className="absolute inset-0 h-full w-full object-cover" loading="lazy"
              />
              {/* The clip is what changes width; the image inside keeps the
                  FRAME's width, so the wipe reveals the earlier photo rather
                  than squashing it as the divider moves. */}
              <div className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${pct}%` }}>
                <img
                  src={first.imageUrl} alt={`Earliest ${activeView} progress photo`}
                  className="absolute inset-y-0 left-0 h-full object-cover"
                  style={{ width: `${pct > 0 ? (100 / pct) * 100 : 100}%`, maxWidth: 'none' }}
                  loading="lazy"
                />
              </div>
              <div className="pointer-events-none absolute inset-y-0" style={{ left: `${pct}%`, width: 2, background: 'var(--bg)' }} />
            </div>

            <input
              type="range" min="0" max="100" value={pct}
              onChange={(e) => setPct(Number(e.target.value))}
              aria-label={`Reveal earlier ${activeView} photo`}
              className="mt-2 w-full" style={{ minHeight: 32 }}
            />
            <div className="flex justify-between text-[9.5px] tabular-nums" style={{ color: 'var(--faint)' }}>
              <span>{new Date(first.taken_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
              <span>{spanDays} days apart</span>
              <span>{new Date(last.taken_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
            </div>
          </>
        ) : (
          <>
            <img
              src={first.imageUrl} alt={`${activeView} progress photo`}
              className="w-full rounded-[var(--r-sm)] object-cover"
              style={{ aspectRatio: '3/4', background: 'var(--line)' }} loading="lazy"
            />
            <div className="mt-2 text-[11px]" style={{ color: 'var(--faint)' }}>
              One {activeView} photo so far. Add another to compare them.
            </div>
          </>
        )}
      </Card>
    </Section>
  );
}
