import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { WEEKDAY } from '../utils.js';

const tooltipStyle = {
  background: '#10151F', border: '1px solid rgba(255,255,255,.12)', borderRadius: 12,
  fontSize: 12, fontFamily: 'Space Grotesk', color: '#F5F7FC',
  boxShadow: '0 24px 48px -20px rgba(0,0,0,.8)', padding: '8px 12px'
};

export function WeightChart({ data }) {
  if (!data || !data.length) return null;
  const rows = data.map((d, i) => ({ i, label: d.date.slice(5), weight: d.weight }));
  return (
    <ResponsiveContainer width="100%" height={210}>
      <AreaChart data={rows} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <defs>
          <linearGradient id="wGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FF6A3D" stopOpacity={.35} />
            <stop offset="100%" stopColor="#FF6A3D" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 6" stroke="rgba(255,255,255,.05)" vertical={false} />
        <XAxis dataKey="label" tick={{ fill: 'rgba(242,244,250,.35)', fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={28} />
        <YAxis domain={['dataMin - 1', 'dataMax + 1']} tick={{ fill: 'rgba(242,244,250,.35)', fontSize: 10 }} axisLine={false} tickLine={false} />
        <Tooltip contentStyle={tooltipStyle} formatter={(v) => [`${v} kg`, 'Weight']} labelFormatter={(l) => data[l]?.date} />
        <Area type="monotone" dataKey="weight" stroke="#FF6A3D" strokeWidth={2.5} fill="url(#wGrad)" dot={false} activeDot={{ r: 4, fill: '#FFC24B' }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function TrendChart({ data, color = '#FFC24B', domain }) {
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
        <CartesianGrid strokeDasharray="3 6" stroke="rgba(255,255,255,.05)" vertical={false} />
        <XAxis dataKey="label" tick={{ fill: 'rgba(242,244,250,.35)', fontSize: 9 }} axisLine={false} tickLine={false} minTickGap={24} />
        <YAxis domain={domain || [0, 100]} tick={{ fill: 'rgba(242,244,250,.35)', fontSize: 9 }} axisLine={false} tickLine={false} />
        <Tooltip contentStyle={tooltipStyle} />
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
            <span className="text-[9px] text-mute font-grotesk">{format ? format(v) : v}</span>
            <div className="w-full rounded-t-md" style={{ height: `${h}%`, background: `linear-gradient(180deg, ${color}, ${color}44)`, transition: 'height .8s ease' }} />
            <span className="text-[9px] text-faint font-grotesk">{d.label || WEEKDAY[i]}</span>
          </div>
        );
      })}
    </div>
  );
}

export function AdherenceBreakdown({ components }) {
  const rows = [
    ['Workout', components?.workout, '#FF6A3D'],
    ['Nutrition', components?.nutrition, '#FFC24B'],
    ['Protein', components?.protein, '#FF9A7A'],
    ['Water', components?.water, '#35D7FF'],
    ['Sleep', components?.sleep, '#9B7CFF'],
    ['Check-in', components?.checkin, '#4ADE80']
  ].filter(r => r[1] !== null && r[1] !== undefined);
  return (
    <div className="space-y-2.5">
      {rows.map(([label, val, color]) => (
        <div key={label}>
          <div className="flex justify-between items-baseline mb-1">
            <span className="font-grotesk text-xs text-mute">{label}</span>
            <span className="font-grotesk text-xs font-bold">{val}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-white/8 overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${Math.min(100, val)}%`, background: color, transition: 'width .7s ease' }} />
          </div>
        </div>
      ))}
    </div>
  );
}
