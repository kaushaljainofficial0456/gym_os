/**
 * How other people find you for tournaments: your @username, and whether
 * you appear in the search box at all. Your own gym can always see its
 * roster; this decides whether anyone else can.
 */
import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function TournamentIdentity({ onSaved }) {
  const [me, setMe] = useState(null);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api('/tournaments/identity').then((d) => { if (alive) { setMe(d); setName(d.username || ''); } }).catch((e) => setNote(e.message));
    return () => { alive = false; };
  }, []);

  const save = async (patch) => {
    setBusy(true); setNote('');
    try {
      await api('/tournaments/identity', { method: 'PATCH', body: JSON.stringify(patch) });
      setMe((m) => ({ ...m, ...patch }));
      setNote('Saved');
      onSaved?.(patch);
    } catch (e) { setNote(e.message); }
    setBusy(false);
  };

  if (!me) return note ? <p className="text-[12px]" style={{ color: 'var(--mute)' }}>{note}</p> : null;
  const clean = name.trim().toLowerCase();
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-[11px] font-bold" style={{ color: 'var(--mute)' }}>Username</span>
        <div className="flex gap-2 mt-1">
          <input className="input flex-1 min-w-0" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} autoCapitalize="none" autoComplete="off" spellCheck={false} />
          <button type="button" className="btn" disabled={busy || !clean || clean === me.username} onClick={() => save({ username: clean })}>Save</button>
        </div>
      </label>
      <button type="button" role="switch" aria-checked={!!me.findable} disabled={busy} onClick={() => save({ findable: !me.findable })}
        className="flex w-full items-center justify-between gap-3 text-left py-1">
        <span className="min-w-0">
          <span className="block text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>Show me in search</span>
          <span className="block text-[12px]" style={{ color: 'var(--mute)' }}>Lets hosts at other gyms find and invite you.</span>
        </span>
        <span aria-hidden="true" className="relative shrink-0 rounded-full transition-colors" style={{ width: 46, height: 28, background: me.findable ? 'var(--ink)' : 'rgb(var(--tint-rgb) / .14)' }}>
          <span className="absolute rounded-full transition-transform" style={{ top: 3, left: 3, width: 22, height: 22, background: me.findable ? 'var(--bg)' : 'var(--mute)', transform: me.findable ? 'translateX(18px)' : 'none' }} />
        </span>
      </button>
      {note && <p role="status" className="text-[12px]" style={{ color: 'var(--mute)' }}>{note}</p>}
    </div>
  );
}
