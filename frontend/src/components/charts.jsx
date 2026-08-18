import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { WEEKDAY } from '../utils.js';

const tooltipStyle = {
  background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 12,
  fontSize: 12, fontFamily: '"Plus Jakarta Sans", sans-serif', color: '#F0F4F3',
  boxShadow: '0 24px 48px -20px rgba(0,0,0,.8)', padding: '8px 12px'
};

const tooltipStyleLight = {
  background: '#FFFFFF', border: '1px solid rgba(91,70,54,.10)', borderRadius: 12,
  fontSize: 12, fontFamily: '"Plus Jakarta Sans", sans-serif', color: '#3D2B1A',
  boxShadow: '0 4px 16px rgba(91,70,54,.06)', padding: '8px 12px'
};

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
            <stop offset="0%" stopColor="#12B8B0" stopOpacity={.35} />
            <stop offset="100%" stopColor="#12B8B0" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 6" stroke="rgba(128,128,128,.08)" vertical={false} />
        <XAxis dataKey="label" tick={{ fill: 'rgba(128,128,128,.5)', fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={28} />
        <YAxis domain={['dataMin - 1', 'dataMax + 1']} tick={{ fill: 'rgba(128,128,128,.5)', fontSize: 10 }} axisLine={false} tickLine={false} />
        <Tooltip contentStyle={getTooltipStyle()} formatter={(v) => [`${v} kg`, 'Weight']} labelFormatter={(l) => data[l]?.date} />
        <Area type="monotone" dataKey="weight" stroke="#12B8B0" strokeWidth={2.5} fill="url(#wGrad)" dot={false} activeDot={{ r: 4, fill: '#DDF7F2' }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function TrendChart({ data, color = '#12B8B0', domain }) {
  if (!data || !data.length) return null;
  return (
    <ResponsiveContainer width="100%" height={150}>
      <AreaChart data={data} margin={{ top: 6, right: 8, left: -20, bottom: 0 }}>
        <defs>
          <linearGradient id={`tg${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={.3} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 6" stroke="rgba(128,128,128,.08)" vertical={false} />
        <XAxis dataKey="label" tick={{ fill: 'rgba(128,128,128,.5)', fontSize: 9 }} axisLine={false} tickLine={false} minTickGap={24} />
        <YAxis domain={domain || [0, 100]} tick={{ fill: 'rgba(128,128,128,.5)', fontSize: 9 }} axisLine={false} tickLine={false} />
        <Tooltip contentStyle={getTooltipStyle()} />
        <Area type="monotone" dataKey="value" stroke={color} strokeWidth={2} fill={`url(#tg${color.replace('#', '')})`} dot={false} />
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
    ['Protein', components?.protein, '#E8A87C'],
    ['Water', components?.water, isLight ? brand.light.cyan : brand.dark.cyan],
    ['Sleep', components?.sleep, isLight ? brand.light.violet : brand.dark.violet],
    ['Check-in', components?.checkin, isLight ? '#7DB89A' : '#34D399']
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
