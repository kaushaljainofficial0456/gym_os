import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { WEEKDAY } from '../utils.js';
import { brand } from '../design/tokens.js';

/**
 * Recharts renders its tooltip through an inline style object rather than a
 * class, so it can't pick up the design system by itself — this is the one
 * place the tokens have to be handed over explicitly.
 *
 * Three things were wrong here and all three were invisible in code review:
 *  - `fontFamily: '"Plus Jakarta Sans", sans-serif'` named a typeface this
 *    app has never loaded, so every chart tooltip in the product rendered
 *    in the browser's default sans — a fourth face on screen, by accident.
 *  - The text colours were literal hexes (#FAFAFA / #1A1D1A) from a palette
 *    two repaints ago, so tooltips didn't follow the theme.
 *  - The light variant hardcoded a pure-white panel on a warm off-white
 *    page, which read as a floating white rectangle rather than a surface.
 *
 * One token-driven object now covers both themes: `var(--panel)` and
 * `var(--ink)` already resolve per-theme, so the light/dark branch that
 * used to exist here is unnecessary. Only the shadow differs, since a dark
 * page needs a heavier one to separate the tooltip from the ground.
 */
const tooltipBase = {
  background: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: 12,
  fontSize: 12,
  fontFamily: "'DM Sans', system-ui, sans-serif",
  color: 'var(--ink)',
  padding: '8px 12px',
};

const tooltipStyle = { ...tooltipBase, boxShadow: '0 20px 40px -18px rgba(0,0,0,.7)' };
const tooltipStyleLight = { ...tooltipBase, boxShadow: '0 10px 24px -12px rgba(90,60,45,.22)' };

function getTooltipStyle() {
  if (typeof document !== 'undefined' && document.documentElement.classList.contains('light')) {
    return tooltipStyleLight;
  }
  return tooltipStyle;
}

export function WeightChart({ data }) {
  if (!data || !data.length) return null;
  const rows = data.map((d, i) => ({ i, label: d.date.slice(5), weight: d.weight }));
  return (
    <ResponsiveContainer width="100%" height={210}>
      <AreaChart data={rows} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <defs>
          <linearGradient id="wGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity={.35} />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 6" stroke="rgba(128,128,128,.08)" vertical={false} />
        <XAxis dataKey="label" tick={{ fill: 'rgba(128,128,128,.5)', fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={28} />
        <YAxis domain={['dataMin - 1', 'dataMax + 1']} tick={{ fill: 'rgba(128,128,128,.5)', fontSize: 10 }} axisLine={false} tickLine={false} />
        <Tooltip contentStyle={getTooltipStyle()} formatter={(v) => [`${v} kg`, 'Weight']} labelFormatter={(l) => data[l]?.date} />
        <Area type="monotone" dataKey="weight" stroke="var(--accent)" strokeWidth={2.5} fill="url(#wGrad)" dot={false} activeDot={{ r: 4, fill: 'var(--accent)' }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/**
 * The gradient id was built as `tg${color.replace('#','')}` — fine for the
 * hex literals this was written against, but every caller in the app now
 * passes a token: `color="var(--accent)"`. That produced the id
 * `tgvar(--accent)` and the reference `url(#tgvar(--accent))`, which is not
 * a valid fragment identifier — the parentheses terminate it. The fill
 * silently failed to resolve and Recharts fell back to its default slate
 * fill, so every adherence and trend chart in the product rendered as a
 * grey block under an accent-coloured stroke.
 *
 * Sanitising to `[A-Za-z0-9]` makes the id valid for any input, and the
 * same expression is used for both the definition and the reference so
 * they can't drift.
 */
const gradientId = (color) => `tg-${String(color).replace(/[^a-zA-Z0-9]/g, '')}`;

export function TrendChart({ data, color = 'var(--accent)', domain }) {
  if (!data || !data.length) return null;
  const gid = gradientId(color);
  return (
    <ResponsiveContainer width="100%" height={150}>
      <AreaChart data={data} margin={{ top: 6, right: 8, left: -20, bottom: 0 }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={.28} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 6" stroke="rgb(var(--tint-rgb) / .10)" vertical={false} />
        <XAxis dataKey="label" tick={{ fill: 'var(--faint)', fontSize: 9 }} axisLine={false} tickLine={false} minTickGap={24} />
        <YAxis domain={domain || [0, 100]} tick={{ fill: 'var(--faint)', fontSize: 9 }} axisLine={false} tickLine={false} />
        <Tooltip contentStyle={getTooltipStyle()} cursor={{ stroke: 'rgb(var(--tint-rgb) / .2)' }} />
        <Area type="monotone" dataKey="value" stroke={color} strokeWidth={2} fill={`url(#${gid})`} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function WeekBars({ days, valueKey, max = 10, color = '#9B7CFF', format }) {
  if (!days || !days.length) return null;
  return (
    <div className="flex items-end gap-2 h-28">
      {days.map((d, i) => {
        const v = d[valueKey] ?? 0;
        const h = Math.max(3, (v / max) * 100);
        return (
          <div key={i} className="flex-1 flex flex-col items-center gap-1.5 h-full justify-end min-w-0">
            <span className="text-[9px] font-grotesk" style={{ color: 'var(--mute)' }}>{format ? format(v) : v}</span>
            <div className="w-full rounded-t-md" style={{ height: `${h}%`, background: `linear-gradient(180deg, ${color}, ${color}44)`, transition: 'height .8s ease' }} />
            <span className="text-[9px] font-grotesk" style={{ color: 'var(--faint)' }}>{d.label || WEEKDAY[i]}</span>
          </div>
        );
      })}
    </div>
  );
}

export function AdherenceBreakdown({ components }) {
  const isLight = typeof document !== 'undefined' && document.documentElement.classList.contains('light');
  const rows = [
    // Series colours come from the token module, so a palette repaint moves
    // the charts with it. Recharts needs literal colours, not var().
    ['Workout', components?.workout, isLight ? brand.light.accentDeep : brand.dark.accentDeep],
    ['Nutrition', components?.nutrition, isLight ? brand.light.accent : brand.dark.accent],
    ['Protein', components?.protein, isLight ? '#E07020' : '#FF8C42'],
    ['Water', components?.water, isLight ? brand.light.cyan : brand.dark.cyan],
    ['Sleep', components?.sleep, isLight ? brand.light.violet : brand.dark.violet],
    ['Check-in', components?.checkin, isLight ? brand.light.accent : brand.dark.accent]
  ].filter(r => r[1] !== null && r[1] !== undefined);
  return (
    <div className="space-y-2.5">
      {rows.map(([label, val, color]) => (
        <div key={label}>
          <div className="flex justify-between items-baseline mb-1">
            <span className="font-grotesk text-xs" style={{ color: 'var(--mute)' }}>{label}</span>
            <span className="font-grotesk text-xs font-bold" style={{ color: 'var(--ink)' }}>{val}%</span>
          </div>
          <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--line)' }}>
            <div className="h-full rounded-full" style={{ width: `${Math.min(100, val)}%`, background: color, transition: 'width .7s ease' }} />
          </div>
        </div>
      ))}
    </div>
  );
}
