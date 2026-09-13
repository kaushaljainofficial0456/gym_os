/**
 * SWITCHING BETWEEN COMMUNITIES.
 *
 * A member can be in a gym community and several private ones at the same
 * time, and the single most damaging mistake this feature could make is
 * letting someone act in the wrong one. So the current community's name and
 * kind are always on screen, and switching is an explicit navigation to that
 * community's own page rather than a mode this screen remembers.
 *
 * The list is fetched when the switcher is opened, not on every page load:
 * most visits never touch it.
 */
import { useState, useEffect, useRef } from 'react';
import { api } from '../../../api.js';
import { IdentityMark, TypeChip } from '../identity.jsx';

export default function CommunitySwitcher({ current, onNavigate }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    if (!data) api('/communities').then(setData).catch(() => setData({ gym: { available: false }, communities: [] }));
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, data]);

  const go = (path) => { setOpen(false); onNavigate(path); };
  const others = (data?.communities || []).filter((c) => c.id !== current.id);
  const showGym = data?.gym?.available && current.type !== 'gym';

  return (
    <div className="relative min-w-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 max-w-full"
        style={{ minHeight: 44 }}
      >
        <IdentityMark name={current.name} theme={current.type === 'gym' ? 'gym' : current.theme} mark={current.mark} size={34} />
        <span className="min-w-0 text-left">
          <span className="block font-black text-[16px] truncate leading-tight" style={{ color: 'var(--ink)' }}>
            {current.name}
          </span>
          <span className="block text-[10px] uppercase tracking-[.14em]" style={{ color: 'var(--faint)' }}>
            {current.type === 'gym' ? 'Gym community' : 'Friend community'}
          </span>
        </span>
        <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.7"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} style={{ color: 'var(--faint)' }}>
          <path d="M3 4.5L6 7.5L9 4.5" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full mt-1.5 w-[17rem] max-w-[86vw] rounded-2xl overflow-hidden z-50 anim-scaleIn"
          style={{ background: 'var(--panel)', border: '1px solid var(--line)', boxShadow: 'var(--e-3)' }}
        >
          <div className="px-3.5 pt-3 pb-1.5 text-[10px] uppercase tracking-[.14em]" style={{ color: 'var(--faint)' }}>
            Your communities
          </div>

          {!data && <div className="px-3.5 py-3 text-[12px]" style={{ color: 'var(--mute)' }}>Loading…</div>}

          {showGym && (
            <MenuRow
              onClick={() => go('/app/client/community/gym')}
              name={data.gym.name}
              theme="gym"
              type="gym"
              meta={data.gym.joined ? `${data.gym.memberCount ?? ''} members`.trim() : 'Not joined'}
            />
          )}

          {others.map((c) => (
            <MenuRow
              key={c.id}
              onClick={() => go(`/app/client/community/c/${c.id}`)}
              name={c.name}
              theme={c.theme}
              mark={c.mark}
              type="friend"
              meta={`${c.memberCount} ${c.memberCount === 1 ? 'member' : 'members'}`}
            />
          ))}

          {data && !showGym && others.length === 0 && (
            <div className="px-3.5 py-3 text-[12px] leading-relaxed" style={{ color: 'var(--mute)' }}>
              This is your only community so far.
            </div>
          )}

          <button
            type="button"
            role="menuitem"
            onClick={() => go('/app/client/community')}
            className="w-full text-left px-3.5 py-3 text-[12.5px] font-semibold"
            style={{ borderTop: '1px solid var(--line)', color: 'var(--accent)' }}
          >
            All communities
          </button>
        </div>
      )}
    </div>
  );
}

function MenuRow({ onClick, name, theme, mark, type, meta }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="w-full text-left px-3.5 py-2.5 flex items-center gap-2.5"
      style={{ borderTop: '1px solid var(--line)' }}
    >
      <IdentityMark name={name} theme={theme} mark={mark} size={30} />
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] font-semibold truncate" style={{ color: 'var(--ink)' }}>{name}</span>
        {meta && <span className="block text-[10.5px] mt-0.5 tabular-nums" style={{ color: 'var(--faint)' }}>{meta}</span>}
      </span>
      <TypeChip type={type} theme={theme} />
    </button>
  );
}
