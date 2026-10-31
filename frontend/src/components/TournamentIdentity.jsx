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
      <label className="flex items-center justify-between gap-3 cursor-pointer">
        <span>
          <span className="block text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>Show me in search</span>
          <span className="block text-[11px]" style={{ color: 'var(--mute)' }}>Lets hosts at other gyms find and invite you.</span>
        </span>
        <input type="checkbox" className="w-5 h-5 shrink-0" checked={!!me.findable} disabled={busy} onChange={(e) => save({ findable: e.target.checked })} />
      </label>
      {note && <p role="status" className="text-[12px]" style={{ color: 'var(--mute)' }}>{note}</p>}
    </div>
  );
}
