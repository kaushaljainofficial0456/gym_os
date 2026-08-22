// ============================================================
// MUSCLE MAP — stylized fitness silhouette (front / back).
// Bilateral regions are single paths; active muscles highlight
// with the burn gradient. Regions are clickable to filter the
// exercise list. This is a clean stylized figure, not a medical
// anatomy chart — it communicates muscle targeting at a glance.
// ============================================================
import { useState, useEffect } from 'react';
import { useTheme } from '../themeContext.jsx';
import { brand } from '../design/tokens.js';

// canonical region keys
export const MUSCLE_REGIONS = {
  front: [
    { id: 'chest', label: 'Chest', d: 'M74 58 Q100 46 126 58 L123 108 Q100 120 77 108 Z' },
    { id: 'shoulders', label: 'Shoulders', d: 'M60 66 Q46 68 47 82 Q48 96 63 98 L74 84 Q66 74 70 62 Z M140 66 Q154 68 153 82 Q152 96 137 98 L126 84 Q134 74 130 62 Z' },
    { id: 'biceps', label: 'Biceps', d: 'M64 96 Q58 122 64 148 L76 146 Q72 122 76 98 Z M136 96 Q142 122 136 148 L124 146 Q128 122 124 98 Z' },
    { id: 'forearms', label: 'Forearms', d: 'M64 148 L56 210 L68 212 L76 148 Z M136 148 L144 210 L132 212 L124 148 Z' },
    { id: 'core', label: 'Core', d: 'M84 124 Q100 130 116 124 L118 198 Q100 206 82 198 Z' },
    { id: 'quads', label: 'Quads', d: 'M84 216 Q100 222 116 216 L112 332 Q100 338 88 332 Z' },
    { id: 'calves', label: 'Calves', d: 'M90 332 Q100 336 110 332 L108 384 Q100 388 92 384 Z' }
  ],
  back: [
    { id: 'traps', label: 'Traps', d: 'M74 56 Q100 44 126 56 L121 84 Q100 92 79 84 Z' },
    { id: 'shoulders', label: 'Rear Delts', d: 'M60 66 Q46 68 47 82 Q48 96 63 98 L74 84 Q66 74 70 62 Z M140 66 Q154 68 153 82 Q152 96 137 98 L126 84 Q134 74 130 62 Z' },
    { id: 'triceps', label: 'Triceps', d: 'M64 96 Q58 122 64 148 L76 146 Q72 122 76 98 Z M136 96 Q142 122 136 148 L124 146 Q128 122 124 98 Z' },
    { id: 'forearms', label: 'Forearms', d: 'M64 148 L56 210 L68 212 L76 148 Z M136 148 L144 210 L132 212 L124 148 Z' },
    { id: 'lats', label: 'Lats', d: 'M78 94 Q100 102 122 94 L124 152 Q100 162 76 152 Z' },
    { id: 'lower_back', label: 'Lower Back', d: 'M84 150 Q100 158 116 150 L116 202 Q100 210 84 202 Z' },
    { id: 'glutes', label: 'Glutes', d: 'M82 202 Q100 212 118 202 L116 240 Q100 248 84 240 Z' },
    { id: 'hamstrings', label: 'Hamstrings', d: 'M84 240 Q100 246 116 240 L112 332 Q100 338 88 332 Z' },
    { id: 'calves', label: 'Calves', d: 'M90 332 Q100 336 110 332 L108 384 Q100 388 92 384 Z' }
  ]
};

// muscles that live on the back of the body → auto-switch the map view
const BACK_ONLY = new Set(['traps', 'lats', 'lower_back', 'glutes', 'hamstrings', 'triceps']);

export function regionForMuscle(muscle) {
  const m = String(muscle || '').toUpperCase();
  if (m.includes('CHEST')) return 'chest';
  if (m.includes('SHOULDER') || m.includes('DELT')) return 'shoulders';
  if (m.includes('BICEPS')) return 'biceps';
  if (m.includes('TRICEPS')) return 'triceps';
  if (m.includes('FOREARM')) return 'forearms';
  if (m.includes('LATS')) return 'lats';
  if (m.includes('BACK') || m.includes('TRAPS')) return m.includes('LOWER') ? 'lower_back' : 'traps';
  if (m.includes('GLUTE')) return 'glutes';
  if (m.includes('HAMSTRING')) return 'hamstrings';
  if (m.includes('QUAD')) return 'quads';
  if (m.includes('CALF')) return 'calves';
  if (m.includes('CORE') || m.includes('ABS') || m.includes('ABDOMIN')) return 'core';
  if (m.includes('POSTERIOR') || m.includes('CHAIN')) return 'lower_back';
  return null;
}

// Theme-aware color palettes
const MAP_THEMES = {
  dark: {
    silhouetteFill: 'rgba(255,255,255,.045)',
    activeFill: 'rgb(var(--accent-rgb) / .38)',
    activeStroke: 'rgb(var(--accent-rgb) / .55)',
    hoverFill: 'rgba(255,255,255,.16)',
    idleFill: 'rgba(255,255,255,.07)',
    idleStroke: 'rgba(255,255,255,.05)',
    selectedStroke: 'rgb(var(--accent-rgb) / .9)',
    gradStart: brand.dark.accentDeep,
    gradEnd: brand.dark.accent,
    filterActive: 'drop-shadow(0 0 6px rgb(var(--accent-rgb) / .45))',
    gradientId: 'burnGrad',
  },
  light: {
    silhouetteFill: 'rgba(0,0,0,.06)',
    activeFill: 'rgb(var(--accent-rgb) / .35)',
    activeStroke: 'rgb(var(--accent-rgb) / .60)',
    hoverFill: 'rgba(0,0,0,.10)',
    idleFill: 'rgba(0,0,0,.05)',
    idleStroke: 'rgba(0,0,0,.08)',
    selectedStroke: 'rgb(var(--accent-rgb) / .90)',
    gradStart: brand.light.accent,
    gradEnd: brand.light.accentDeep,
    filterActive: 'drop-shadow(0 0 8px rgb(var(--accent-rgb) / .35))',
    gradientId: 'burnGradLight',
  }
};

export default function MuscleMap({ activeMuscles = [], selected = null, onSelect, size = 260, className = '' }) {
  const regions = activeMuscles.map(regionForMuscle).filter(Boolean);
  const [view, setView] = useState(() => (regions.some(r => BACK_ONLY.has(r)) ? 'back' : 'front'));
  const [hover, setHover] = useState(null);
  const { theme } = useTheme();
  const t = MAP_THEMES[theme] || MAP_THEMES.dark;

  useEffect(() => {
    if (regions.some(r => BACK_ONLY.has(r))) setView('back');
  }, [activeMuscles.join(',')]); // eslint-disable-line

  const activeSet = new Set(regions);
  const selectedSet = selected ? new Set([regionForMuscle(selected)].filter(Boolean)) : new Set();

  const toggleView = (v) => setView(v);

  return (
    <div className={`flex flex-col items-center ${className}`}>
      <svg viewBox="0 0 200 400" width={size} height={size * 2} role="img" aria-label="Muscle map">
        {/* warm circular background */}
        <circle cx="100" cy="200" r="90" fill="rgba(140,106,77,.06)" />
        <circle cx="100" cy="200" r="70" fill="rgba(140,106,77,.04)" />
        {/* base silhouette */}
        <g fill={t.silhouetteFill}>
          <circle cx="100" cy="26" r="15" />
          <rect x="92" y="42" width="16" height="16" rx="4" />
          <path d="M70 58 Q100 44 130 58 L126 214 Q100 226 74 214 Z" />
          <path d="M60 84 Q54 122 60 150 L56 214 L68 216 L76 150 Z" />
          <path d="M140 84 Q146 122 140 150 L144 214 L132 216 L124 150 Z" />
          <path d="M82 216 Q100 222 118 216 L112 390 Q100 396 88 390 Z" />
          <rect x="74" y="386" width="20" height="9" rx="4" />
          <rect x="106" y="386" width="20" height="9" rx="4" />
        </g>
        {/* region shapes */}
        {MUSCLE_REGIONS[view].map((r) => {
          const isActive = activeSet.has(r.id);
          const isSel = selectedSet.has(r.id);
          const isHover = hover === r.id;
          return (
            <path
              key={view + r.id}
              d={r.d}
              onClick={() => onSelect && onSelect(r.id)}
              onMouseEnter={() => setHover(r.id)}
              onMouseLeave={() => setHover(null)}
              role="button"
              aria-label={`${r.label}${isActive ? ' (targeted)' : ''}`}
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' && onSelect) onSelect(r.id); }}
              className="cursor-pointer transition-all duration-300"
              style={{
                fill: isSel
                  ? `url(#${t.gradientId})`
                  : isActive
                    ? t.activeFill
                    : isHover
                      ? t.hoverFill
                      : t.idleFill,
                stroke: isSel ? t.selectedStroke : isActive ? t.activeStroke : t.idleStroke,
                strokeWidth: isSel ? 1.6 : 1,
                filter: isSel || isActive ? t.filterActive : 'none'
              }}
            />
          );
        })}
        <defs>
          <linearGradient id={t.gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={t.gradStart} />
            <stop offset="100%" stopColor={t.gradEnd} />
          </linearGradient>
        </defs>
      </svg>

      {/* view toggle */}
      <div className="flex rounded-full border border-line bg-white/[.03] p-0.5 mt-1">
        {['front', 'back'].map((v) => (
          <button
            key={v}
            onClick={() => toggleView(v)}
            className={`px-3.5 py-1 rounded-full text-[10px] font-grotesk font-semibold uppercase tracking-wider transition-all ${
              view === v ? 'bg-gradient-to-r from-ember to-gold text-bg shadow-md shadow-ember/30' : 'text-mute hover:text-ink'
            }`}
          >
            {v}
          </button>
        ))}
      </div>
    </div>
  );
}
