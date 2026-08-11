// Looping SVG stick-figure exercise animations (SMIL, zero deps).
// Keyed by exercise_library.animation_key. `dangerouslySetInnerHTML` is safe
// here: every template is a fixed, trusted string from this file.
const FIG = 'stroke="#EDEFF7" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none"';
const ACCENT = 'stroke="url(#paAccent)"';
const GLOW = '<ellipse cx="100" cy="120" rx="92" ry="74" fill="url(#paGlow)"/>';
const GND = (y) => `<line x1="18" y1="${y}" x2="202" y2="${y}" stroke="rgba(255,255,255,.14)" stroke-width="3"/>`;

const DEFS = `<defs>
  <linearGradient id="paAccent" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%" stop-color="#FF6A3D"/><stop offset="100%" stop-color="#FFC24B"/>
  </linearGradient>
  <radialGradient id="paGlow" cx="50%" cy="50%" r="50%">
    <stop offset="0%" stop-color="#FF6A3D" stop-opacity=".20"/><stop offset="100%" stop-color="#FF6A3D" stop-opacity="0"/>
  </radialGradient>
</defs>`;

const SMIL = (type, values, dur, pivots = '') =>
  `<animateTransform attributeName="transform" type="${type}" values="${values}" keyTimes="0;.5;1"
     dur="${dur}s" repeatCount="indefinite" calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1"${pivots}/>`;

const PLATE = (x, y, w = 9, h = 17) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="#2A3355" stroke="rgba(255,255,255,.2)" stroke-width="2"/>`;

const ANIMS = {
  bench_press: `<svg viewBox="0 0 220 240" role="img" aria-label="Bench press animation">${DEFS}${GLOW}
    <g ${FIG}><rect x="34" y="140" width="132" height="13" rx="6" fill="#1B2340" stroke="rgba(255,255,255,.16)" stroke-width="2"/>
    <rect x="128" y="153" width="11" height="60" rx="5" fill="#1B2340" stroke="rgba(255,255,255,.16)" stroke-width="2"/>${GND(216)}
    <circle cx="48" cy="128" r="13"/><line x1="61" y1="131" x2="116" y2="138"/><line x1="116" y1="138" x2="138" y2="170"/>
    <line x1="138" y1="170" x2="150" y2="204"/><line x1="150" y1="204" x2="160" y2="212"/></g>
    <g ${FIG}>${SMIL('rotate', '-4 78 130; 18 78 130; -4 78 130', 2.4)}
    <line x1="78" y1="130" x2="96" y2="117"/><line x1="96" y1="117" x2="102" y2="93"/>
    <g ${ACCENT} stroke-width="8"><line x1="58" y1="90" x2="140" y2="90"/></g>${PLATE(52, 82)}${PLATE(137, 82)}</g></svg>`,

  incline_db_press: `<svg viewBox="0 0 248 250" role="img" aria-label="Incline dumbbell press animation">${DEFS}
    <ellipse cx="128" cy="120" rx="96" ry="74" fill="url(#paGlow)"/>
    <g transform="rotate(24 162 170) translate(8,6)">
    <g ${FIG}><rect x="34" y="140" width="132" height="13" rx="6" fill="#1B2340" stroke="rgba(255,255,255,.16)" stroke-width="2"/>
    <rect x="128" y="153" width="11" height="60" rx="5" fill="#1B2340" stroke="rgba(255,255,255,.16)" stroke-width="2"/>${GND(216)}
    <circle cx="48" cy="128" r="13"/><line x1="61" y1="131" x2="116" y2="138"/><line x1="116" y1="138" x2="138" y2="170"/>
    <line x1="138" y1="170" x2="150" y2="204"/><line x1="150" y1="204" x2="160" y2="212"/></g>
    <g ${FIG}>${SMIL('rotate', '-4 78 130; 18 78 130; -4 78 130', 2.4)}
    <line x1="78" y1="130" x2="96" y2="117"/><line x1="96" y1="117" x2="102" y2="93"/>
    <g ${ACCENT} stroke-width="7"><line x1="86" y1="88" x2="104" y2="88"/><line x1="110" y1="90" x2="128" y2="90"/></g>
    ${PLATE(82, 82, 10, 12)}${PLATE(98, 82, 10, 12)}${PLATE(106, 84, 10, 12)}${PLATE(122, 84, 10, 12)}</g></g></svg>`,

  shoulder_press: `<svg viewBox="0 0 220 240" role="img" aria-label="Overhead press animation">${DEFS}${GLOW}${GND(204)}
    <g ${FIG}><circle cx="100" cy="50" r="13"/><line x1="100" y1="63" x2="100" y2="112"/>
    <line x1="100" y1="112" x2="96" y2="146"/><line x1="96" y1="146" x2="96" y2="198"/>
    <line x1="100" y1="112" x2="104" y2="146"/><line x1="104" y1="146" x2="104" y2="198"/></g>
    <g ${FIG}>${SMIL('translate', '0 0; 0 20; 0 0', 2.4)}
    <line x1="90" y1="82" x2="90" y2="60"/><line x1="110" y1="82" x2="110" y2="60"/>
    <line x1="90" y1="60" x2="90" y2="46"/><line x1="110" y1="60" x2="110" y2="46"/>
    <g ${ACCENT} stroke-width="8"><line x1="66" y1="44" x2="134" y2="44"/></g>${PLATE(60, 36)}${PLATE(129, 36)}</g></svg>`,

  lateral_raise: `<svg viewBox="0 0 220 240" role="img" aria-label="Lateral raise animation">${DEFS}${GLOW}${GND(204)}
    <g ${FIG}><circle cx="100" cy="50" r="13"/><line x1="100" y1="63" x2="100" y2="112"/>
    <line x1="100" y1="112" x2="96" y2="146"/><line x1="96" y1="146" x2="96" y2="198"/>
    <line x1="100" y1="112" x2="104" y2="146"/><line x1="104" y1="146" x2="104" y2="198"/></g>
    <g ${FIG}>${SMIL('rotate', '0 88 86; 90 88 86; 0 88 86', 2.6)}
    <line x1="88" y1="86" x2="88" y2="116"/><line x1="88" y1="116" x2="88" y2="146"/>
    <rect x="81" y="140" width="14" height="11" rx="3" fill="#2A3355" stroke="url(#paAccent)" stroke-width="3"/></g>
    <g ${FIG}>${SMIL('rotate', '0 112 86; -90 112 86; 0 112 86', 2.6)}
    <line x1="112" y1="86" x2="112" y2="116"/><line x1="112" y1="116" x2="112" y2="146"/>
    <rect x="125" y="140" width="14" height="11" rx="3" fill="#2A3355" stroke="url(#paAccent)" stroke-width="3"/></g></svg>`,

  triceps_pushdown: `<svg viewBox="0 0 220 240" role="img" aria-label="Triceps pushdown animation">${DEFS}${GLOW}${GND(204)}
    <g ${FIG}><circle cx="100" cy="50" r="13"/><line x1="100" y1="63" x2="100" y2="112"/>
    <line x1="100" y1="112" x2="96" y2="146"/><line x1="96" y1="146" x2="96" y2="198"/>
    <line x1="100" y1="112" x2="104" y2="146"/><line x1="104" y1="146" x2="104" y2="198"/>
    <line x1="88" y1="86" x2="88" y2="108"/><line x1="112" y1="86" x2="112" y2="108"/></g>
    <g ${FIG}>${SMIL('translate', '0 0; 0 22; 0 0', 1.8)}
    <line x1="88" y1="108" x2="88" y2="140"/><line x1="112" y1="108" x2="112" y2="140"/>
    <g ${ACCENT} stroke-width="8"><line x1="74" y1="142" x2="126" y2="142"/></g>${PLATE(68, 134, 8, 16)}${PLATE(124, 134, 8, 16)}</g></svg>`,

  lat_pulldown: `<svg viewBox="0 0 220 240" role="img" aria-label="Lat pulldown animation">${DEFS}${GLOW}${GND(204)}
    <g ${FIG}><circle cx="100" cy="50" r="13"/><line x1="100" y1="63" x2="100" y2="112"/>
    <line x1="100" y1="112" x2="96" y2="146"/><line x1="96" y1="146" x2="96" y2="198"/>
    <line x1="100" y1="112" x2="104" y2="146"/><line x1="104" y1="146" x2="104" y2="198"/></g>
    <g ${FIG}>${SMIL('translate', '0 0; 0 38; 0 0', 2.2)}
    <line x1="90" y1="80" x2="86" y2="52"/><line x1="110" y1="80" x2="114" y2="52"/>
    <line x1="86" y1="52" x2="90" y2="40"/><line x1="114" y1="52" x2="110" y2="40"/>
    <g ${ACCENT} stroke-width="8"><line x1="66" y1="38" x2="134" y2="38"/></g>${PLATE(60, 30)}${PLATE(129, 30)}</g></svg>`,

  squat: `<svg viewBox="0 0 220 240" role="img" aria-label="Squat animation">${DEFS}${GLOW}${GND(180)}
    <g ${FIG}>
      <g>${SMIL('translate', '0 0; 0 30; 0 0', 2.6)}
        <g ${ACCENT} stroke-width="8"><line x1="68" y1="50" x2="132" y2="50"/></g>${PLATE(62, 42)}${PLATE(129, 42)}
        <circle cx="100" cy="34" r="12"/><line x1="100" y1="46" x2="100" y2="96"/><line x1="104" y1="54" x2="100" y2="50"/></g>
      <g>${SMIL('translate', '0 0; 0 30; 0 0', 2.6)}
        <g>${SMIL('rotate', '0 100 96; -30 100 96; 0 100 96', 2.6)}
          <line x1="100" y1="96" x2="80" y2="134"/>
          <g>${SMIL('rotate', '0 80 134; 18 80 134; 0 80 134', 2.6)}
            <line x1="80" y1="134" x2="94" y2="176"/><line x1="94" y1="176" x2="108" y2="180"/></g></g></g>
    </g></svg>`,

  deadlift: `<svg viewBox="0 0 220 240" role="img" aria-label="Deadlift animation">${DEFS}${GLOW}${GND(200)}
    <g ${FIG}><line x1="100" y1="120" x2="82" y2="158"/><line x1="82" y1="158" x2="96" y2="196"/><line x1="96" y1="196" x2="108" y2="200"/></g>
    <g ${FIG}>${SMIL('rotate', '0 100 120; 44 100 120; 0 100 120', 2.8)}
      <circle cx="100" cy="58" r="12"/><line x1="100" y1="70" x2="100" y2="120"/>
      <line x1="100" y1="76" x2="94" y2="122"/><line x1="100" y1="76" x2="106" y2="122"/>
      <g ${ACCENT} stroke-width="8"><line x1="80" y1="124" x2="120" y2="124"/></g>${PLATE(74, 116)}${PLATE(116, 116)}</g></svg>`,

  bicep_curl: `<svg viewBox="0 0 220 240" role="img" aria-label="Bicep curl animation">${DEFS}${GLOW}${GND(194)}
    <g ${FIG}><circle cx="100" cy="46" r="12"/><line x1="100" y1="58" x2="100" y2="108"/>
    <line x1="100" y1="108" x2="100" y2="150"/><line x1="100" y1="150" x2="100" y2="188"/><line x1="100" y1="188" x2="108" y2="192"/>
    <line x1="100" y1="76" x2="112" y2="102"/></g>
    <g ${FIG}>${SMIL('rotate', '0 112 102; 115 112 102; 0 112 102', 1.8)}
    <line x1="112" y1="102" x2="104" y2="140"/>
    <rect x="94" y="138" width="18" height="12" rx="4" fill="#2A3355" stroke="url(#paAccent)" stroke-width="3"/>
    <line x1="103" y1="138" x2="103" y2="150"/></g></svg>`,

  dumbbell_row: `<svg viewBox="0 0 220 240" role="img" aria-label="Dumbbell row animation">${DEFS}${GLOW}${GND(200)}
    <g ${FIG}><line x1="100" y1="120" x2="82" y2="158"/><line x1="82" y1="158" x2="96" y2="196"/><line x1="96" y1="196" x2="108" y2="200"/></g>
    <g ${FIG}>${SMIL('rotate', '0 100 120; -46 100 120; 0 100 120', 2.8)}
      <circle cx="100" cy="58" r="12"/><line x1="100" y1="70" x2="100" y2="120"/>
      <g>${SMIL('rotate', '0 100 78; -38 100 78; 0 100 78', 1.6)}
        <line x1="100" y1="76" x2="94" y2="118"/><line x1="94" y1="118" x2="100" y2="150"/>
        <rect x="91" y="148" width="18" height="12" rx="4" fill="#2A3355" stroke="url(#paAccent)" stroke-width="3"/></g></g></svg>`,

  push_up: `<svg viewBox="0 0 220 240" role="img" aria-label="Push-up animation">${DEFS}${GLOW}${GND(182)}
    <g ${FIG}>${SMIL('rotate', '0 186 156; 9 186 156; 0 186 156', 2)}
      <circle cx="62" cy="158" r="11"/><line x1="72" y1="156" x2="88" y2="170"/><line x1="88" y1="170" x2="100" y2="162"/>
      <line x1="100" y1="162" x2="140" y2="156"/><line x1="140" y1="156" x2="172" y2="158"/>
      <line x1="172" y1="158" x2="188" y2="164"/><line x1="188" y1="164" x2="194" y2="168"/></g></svg>`,

  plank: `<svg viewBox="0 0 220 240" role="img" aria-label="Plank animation">${DEFS}
    <ellipse cx="115" cy="130" rx="95" ry="60" fill="url(#paGlow)"/>${GND(172)}
    <g ${FIG}>${SMIL('rotate', '0 136 158; 2.4 136 158; -1.6 136 158; 0 136 158', 3.2, ' keyTimes="0;.33;.66;1"')}
      <g>${SMIL('translate', '0 0; 0 3; 0 0', 2.6)}
        <circle cx="52" cy="150" r="11"/><line x1="62" y1="148" x2="80" y2="166"/><line x1="80" y1="166" x2="92" y2="162"/>
        <line x1="92" y1="162" x2="136" y2="158"/><line x1="136" y1="158" x2="168" y2="162"/>
        <line x1="168" y1="162" x2="186" y2="168"/><line x1="186" y1="168" x2="192" y2="172"/></g></g></svg>`,

  lunges: `<svg viewBox="0 0 220 240" role="img" aria-label="Lunge animation">${DEFS}${GLOW}${GND(200)}
    <g ${FIG}>${SMIL('translate', '0 0; 0 16; 0 0', 2.4)}
      <circle cx="100" cy="46" r="12"/><line x1="100" y1="58" x2="100" y2="112"/>
      <line x1="100" y1="76" x2="86" y2="96"/><line x1="100" y1="76" x2="114" y2="96"/></g>
    <g ${FIG}>${SMIL('translate', '0 0; 0 16; 0 0', 2.4)}
      <line x1="100" y1="112" x2="124" y2="150"/><line x1="124" y1="150" x2="120" y2="196"/><line x1="120" y1="196" x2="128" y2="200"/>
      <g>${SMIL('rotate', '0 100 112; 16 100 112; 0 100 112', 2.4)}
        <line x1="100" y1="112" x2="76" y2="144"/>
        <g>${SMIL('rotate', '0 76 144; -22 76 144; 0 76 144', 2.4)}
          <line x1="76" y1="144" x2="72" y2="192"/></g></g></g></svg>`,

  hip_thrust: `<svg viewBox="0 0 220 240" role="img" aria-label="Hip thrust animation">${DEFS}${GLOW}${GND(196)}
    <g ${FIG}>${SMIL('translate', '0 0; 0 -12; 0 0', 2)}
      <circle cx="56" cy="158" r="11"/><line x1="66" y1="156" x2="104" y2="146"/><line x1="104" y1="146" x2="130" y2="162"/>
      <line x1="130" y1="162" x2="150" y2="150"/><line x1="150" y1="150" x2="158" y2="176"/><line x1="158" y1="176" x2="166" y2="192"/></g></svg>`,

  fallback: `<svg viewBox="0 0 220 240" role="img" aria-label="Exercise animation">${DEFS}${GLOW}${GND(196)}
    <g ${FIG}>${SMIL('translate', '0 0; 0 2; 0 0', 2.6)}
      <circle cx="100" cy="46" r="12"/><line x1="100" y1="58" x2="100" y2="112"/>
      <line x1="100" y1="112" x2="94" y2="150"/><line x1="94" y1="150" x2="96" y2="192"/>
      <line x1="100" y1="112" x2="106" y2="150"/><line x1="106" y1="150" x2="104" y2="192"/>
      <line x1="100" y1="72" x2="86" y2="94"/><line x1="100" y1="72" x2="114" y2="94"/></g></svg>`
};

const FALLBACKS = {
  leg_press: 'squat', seated_row: 'dumbbell_row', romanian_deadlift: 'deadlift',
  cable_crunch: 'plank', incline_db_press: 'incline_db_press'
};

export function exerciseAnim(key) {
  if (ANIMS[key]) return ANIMS[key];
  if (FALLBACKS[key]) return ANIMS[FALLBACKS[key]];
  return ANIMS.fallback;
}

export default function ExerciseAnim({ anim, className = '', label, muscle }) {
  return (
    <div className={`relative overflow-hidden rounded-2xl border border-line bg-gradient-to-b from-bg2 to-panel ${className}`}
      style={{ backgroundImage: 'radial-gradient(120% 80% at 50% 110%, rgba(255,106,61,.10), transparent 55%)' }}>
      <div className="flex justify-center py-2" aria-hidden="true">
        <svg viewBox="0 0 220 240" className="h-44 md:h-52 w-auto max-w-full"
          dangerouslySetInnerHTML={{ __html: exerciseAnim(anim).replace(/^<svg[^>]*>/, '') }} />
      </div>
      {(label || muscle) && (
        <div className="absolute top-2 left-2 flex gap-1.5 max-w-[85%]">
          {muscle && <span className="chip !text-[9px] !bg-bg/70 backdrop-blur !border-gold/30 !text-gold">{muscle}</span>}
          {label && <span className="chip !text-[9px] !bg-bg/70 backdrop-blur">{label}</span>}
        </div>
      )}
    </div>
  );
}
