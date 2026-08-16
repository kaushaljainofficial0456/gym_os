import { Modal } from './UI.jsx';

const CROWD_STYLE = {
  LOW: { label: 'QUIET', color: '#34D399' },
  MODERATE: { label: 'MODERATE', color: '#14C4BC' },
  HIGH: { label: 'BUSY', color: '#0A8A85' },
  VERY_HIGH: { label: 'PACKED', color: '#F87171' }
};

const TYPICAL_HOURLY = [
  0,0,0,0,0,0,5,15,30,25,15,20,25,20,15,20,30,35,40,35,25,15,5,0
];

function CrowdBar({ hour, value, max, label }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  const level = value < 10 ? 'LOW' : value < 25 ? 'MODERATE' : value < 35 ? 'HIGH' : 'VERY_HIGH';
  const color = CROWD_STYLE[level]?.color || '#14C4BC';
  return (
    <div className="flex flex-col items-center gap-1 min-w-[28px]">
      <div className="w-full h-16 flex items-end">
        <div
          className="w-full rounded-t-sm transition-all duration-500"
          style={{ height: `${Math.max(pct, 4)}%`, background: color, opacity: 0.85 }}
        />
      </div>
      <span className="text-[7px] font-grotesk leading-tight text-center" style={{ color: 'var(--faint)' }}>{label}</span>
    </div>
  );
}

export default function GymCrowdDetail({ open, onClose, crowd }) {
  if (!crowd) return null;

  const maxVal = Math.max(...TYPICAL_HOURLY, crowd.current || 0);
  const hourlyLabels = ['12 AM','1 AM','2 AM','3 AM','4 AM','5 AM','6 AM','7 AM','8 AM','9 AM','10 AM','11 AM','12 PM','1 PM','2 PM','3 PM','4 PM','5 PM','6 PM','7 PM','8 PM','9 PM','10 PM','11 PM'];

  const peakHour = TYPICAL_HOURLY.indexOf(Math.max(...TYPICAL_HOURLY));
  const quietHours = TYPICAL_HOURLY
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => v === 0)
    .map(({ i }) => i);
  const recommendedHour = quietHours.length > 0 ? quietHours[0] : 0;

  return (
    <Modal open={open} onClose={onClose} title="Gym Crowd Analysis" wide>
      <div className="space-y-5">
        {/* Current status */}
        <div className="flex items-center justify-between p-4 rounded-xl border" style={{ borderColor: 'var(--line)', background: 'var(--bg2)' }}>
          <div>
            <div className="font-grotesk text-[10.5px] uppercase tracking-[.14em] font-medium" style={{ color: 'var(--mute)' }}>Current crowd</div>
            <div className="font-display font-bold text-3xl mt-1" style={{ color: CROWD_STYLE[crowd.status]?.color }}>
              {crowd.current}
              <span className="text-sm font-normal ml-1" style={{ color: 'var(--mute)' }}>/ {crowd.capacity}</span>
            </div>
          </div>
          <span className="chip text-sm font-grotesk font-bold" style={{ borderColor: `${CROWD_STYLE[crowd.status]?.color}55`, color: CROWD_STYLE[crowd.status]?.color }}>
            {CROWD_STYLE[crowd.status]?.label}
          </span>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 gap-3">
          <div className="card p-3.5">
            <div className="font-grotesk text-[10px] uppercase tracking-[.14em] font-medium" style={{ color: 'var(--mute)' }}>Average crowd</div>
            <div className="font-grotesk font-bold text-lg mt-1" style={{ color: 'var(--ink)' }}>~{Math.round(TYPICAL_HOURLY.reduce((a,b) => a+b, 0) / 24)} people</div>
          </div>
          <div className="card p-3.5">
            <div className="font-grotesk text-[10px] uppercase tracking-[.14em] font-medium" style={{ color: 'var(--mute)' }}>Capacity</div>
            <div className="font-grotesk font-bold text-lg mt-1" style={{ color: 'var(--ink)' }}>{crowd.capacity}</div>
          </div>
          <div className="card p-3.5">
            <div className="font-grotesk text-[10px] uppercase tracking-[.14em] font-medium text-good flex items-center gap-1">Least crowded <span title="Best time to visit the gym" className="cursor-help" style={{ color: 'var(--faint)' }}>ⓘ</span></div>
            <div className="font-grotesk font-bold text-lg mt-1" style={{ color: 'var(--ink)' }}>{hourlyLabels[recommendedHour]}</div>
            <div className="text-[10px]" style={{ color: 'var(--faint)' }}>Quiet hours</div>
          </div>
          <div className="card p-3.5">
            <div className="font-grotesk text-[10px] uppercase tracking-[.14em] font-medium text-bad flex items-center gap-1">Most crowded <span title="Busiest time — expect more people" className="cursor-help" style={{ color: 'var(--faint)' }}>ⓘ</span></div>
            <div className="font-grotesk font-bold text-lg mt-1" style={{ color: 'var(--ink)' }}>{hourlyLabels[peakHour]}</div>
            <div className="text-[10px]" style={{ color: 'var(--faint)' }}>Peak hours</div>
          </div>
        </div>

        {/* Peak & quiet hours */}
        <div className="flex gap-3">
          <div className="flex-1 rounded-xl border border-bad/30 p-3" style={{ background: 'rgba(248,113,113,.04)' }}>
            <div className="font-grotesk text-[10px] uppercase tracking-wider text-bad font-medium">Peak hours</div>
            <div className="text-[11px] mt-1" style={{ color: 'var(--mute)' }}>5:00 PM — 7:00 PM</div>
          </div>
          <div className="flex-1 rounded-xl border border-good/30 p-3" style={{ background: 'rgba(52,211,153,.04)' }}>
            <div className="font-grotesk text-[10px] uppercase tracking-wider text-good font-medium">Quiet hours</div>
            <div className="text-[11px] mt-1" style={{ color: 'var(--mute)' }}>10:00 PM — 6:00 AM</div>
          </div>
        </div>

        {/* Chart */}
        <div>
          <div className="font-grotesk text-[10.5px] uppercase tracking-[.14em] font-medium mb-3" style={{ color: 'var(--mute)' }}>Crowd by time of day</div>
          <div className="flex items-end gap-[2px] overflow-x-auto pb-2">
            {TYPICAL_HOURLY.map((val, i) => (
              <CrowdBar key={i} hour={i} value={val} max={maxVal} label={hourlyLabels[i]} />
            ))}
          </div>
          <div className="flex justify-between text-[8px] font-grotesk mt-1 px-1" style={{ color: 'var(--faint)' }}>
            <span>X-axis: Time of day</span>
            <span>Y-axis: Relative crowd level</span>
          </div>
        </div>

        {crowd.status !== 'LOW' && (
          <div className="rounded-xl border border-good/30 p-3.5" style={{ background: 'rgba(52,211,153,.04)' }}>
            <div className="font-grotesk text-[10px] text-good uppercase tracking-wider mb-1">💡 Recommended time</div>
            <div className="text-[12px]" style={{ color: 'var(--mute)' }}>
              Try visiting around <strong className="text-good">{hourlyLabels[recommendedHour]}</strong> for the least crowded experience.
            </div>
          </div>
        )}

        <div className="text-[9px] text-center" style={{ color: 'var(--faint)' }}>
          {crowd.enabled ? 'Live data from the gym access system' : 'Crowd data is not available for your gym'}
        </div>
      </div>
    </Modal>
  );
}
