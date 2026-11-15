/**
 * SHARE A WORKOUT -- two ways, chosen up front:
 *
 *   Send in app   to people in your gym, friends and communities. They get
 *                 a popup and a bell notification, and can do it today,
 *                 save it, or put it on days (POST /app-shares).
 *   Share link    the public link, for WhatsApp or anywhere else
 *                 (POST /me/workout-share), handed to the phone's own share
 *                 sheet where there is one, with a copy fallback.
 *
 * All exercises go by default; "Choose exercises" narrows it.
 *
 * Built on the shared Sheet, so it is portalled to <body>: the old sheet
 * rendered in place and, inside the page's transformed wrapper, a
 * position: fixed overlay is fixed to that wrapper, not the screen.
 */
import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronLeft, Copy, Link2, Send } from 'lucide-react';
import { api } from '../../api.js';
import { exerciseLabel } from '../../utils.js';
import { Sheet } from '../UI.jsx';
import PeoplePicker from '../share/PeoplePicker.jsx';
import { shareLink } from '../share/shareLink.js';
import '../share/share.css';

export default function ShareWorkoutSheet({ open, onClose, workoutId, workoutName, exercises = [], onSent }) {
  const [view, setView] = useState('choose'); // choose | exercises | people | link
  const [picked, setPicked] = useState(() => new Set());
  const [people, setPeople] = useState(() => new Map());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [url, setUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(null);

  useEffect(() => {
    if (!open) return;
    setView('choose'); setPicked(new Set(exercises.map((_, i) => i))); setPeople(new Map());
    setNote(''); setBusy(false); setErr(''); setUrl(''); setCopied(false); setSent(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const all = picked.size === exercises.length;
  const exerciseIds = useMemo(() => (all ? [] : [...picked].map((i) => exercises[i]?.id).filter(Boolean)), [all, picked, exercises]);
  const name = workoutName || 'Workout';

  const send = async () => {
    if (busy || !people.size) return;
    setBusy(true); setErr('');
    try {
      const r = await api('/app-shares', { method: 'POST', body: JSON.stringify({
        kind: 'workout', workout_id: workoutId, exercise_ids: exerciseIds.length ? exerciseIds : undefined,
        recipients: [...people.keys()], message: note.trim() || undefined,
      }) });
      setSent([...people.values()].slice(0, r.sent || people.size));
      onSent?.(r);
    } catch (e) { setErr(e.message || 'Could not send it'); }
    setBusy(false);
  };

  const makeLink = async () => {
    if (busy) return;
    setBusy(true); setErr('');
    try {
      const r = await api('/me/workout-share', { method: 'POST', body: JSON.stringify({
        workout_id: workoutId, exercise_ids: exerciseIds.length ? exerciseIds : undefined,
      }) });
      const link = `${window.location.origin}/workout-share/${r.id}`;
      setUrl(link); setView('link');
      const how = await shareLink(link, `${name} on Barbell`, `Try this workout: ${name}`);
      if (how === 'copied') setCopied(true);
    } catch (e) { setErr(e.message || 'Could not make a link'); }
    setBusy(false);
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* the link stays visible */ }
  };

  const back = (
    <button type="button" className="btn btn-sm justify-self-start" onClick={() => { setView('choose'); setErr(''); }}>
      <ChevronLeft size={14} strokeWidth={2} aria-hidden="true" />Back
    </button>
  );

  const summary = (
    <div className="sh-what">
      <div className="sh-what__name">{name}</div>
      <div className="sh-what__meta">{all ? `All ${exercises.length} exercises` : `${picked.size} of ${exercises.length} exercises`}</div>
      {exercises.length > 1 && view === 'choose' && (
        <button type="button" className="sh-what__change" onClick={() => setView('exercises')}>Choose exercises</button>
      )}
    </div>
  );

  let body;
  let footer = null;
  if (sent) {
    body = (
      <div className="sh-done">
        <span className="sh-done__icon"><Check size={26} strokeWidth={2.6} aria-hidden="true" /></span>
        <div className="sh-done__title">Sent</div>
        <p className="sh-done__body">
          {sent.length === 1 ? sent[0].name : `${sent.length} people`} will see {name} in Barbell and can do it today, save it or put it on their days.
        </p>
      </div>
    );
    footer = <button type="button" className="btn-primary btn-block" onClick={onClose}>Done</button>;
  } else if (view === 'exercises') {
    body = (
      <div className="grid gap-3">
        {back}
        <div className="sh-pick">
          {exercises.map((ex, i) => {
            const on = picked.has(i);
            return (
              <button key={ex.id || i} type="button" className="sh-pickrow" aria-pressed={on}
                onClick={() => setPicked((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; })}>
                <span className="sh-box" aria-hidden="true">{on && <Check size={13} strokeWidth={3} />}</span>
                <span className="flex-1 min-w-0">
                  <span className="sh-pickrow__name truncate">{exerciseLabel(ex.name)}</span>
                  <span className="sh-pickrow__meta">{ex.sets} × {ex.reps}{ex.weight ? ` · ${ex.weight}` : ''}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
    footer = <button type="button" className="btn-primary btn-block" disabled={!picked.size} onClick={() => setView('choose')}>{picked.size ? `Use ${picked.size} ${picked.size === 1 ? 'exercise' : 'exercises'}` : 'Pick at least one'}</button>;
  } else if (view === 'people') {
    body = (
      <div className="grid gap-3">
        {back}
        <PeoplePicker selected={people} onChange={setPeople} />
        <label className="grid gap-1.5">
          <span className="text-[12.5px] font-semibold" style={{ color: 'var(--mute)' }}>Add a note (optional)</span>
          <input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="e.g. This one wrecked me, try it" />
        </label>
        {err && <p className="text-[13px]" role="alert" style={{ color: 'var(--bad)' }}>{err}</p>}
      </div>
    );
    footer = (
      <button type="button" className="btn-primary btn-block" disabled={!people.size || busy} onClick={send}>
        <Send size={15} strokeWidth={2.2} aria-hidden="true" />
        {busy ? 'Sending…' : people.size ? `Send to ${people.size === 1 ? [...people.values()][0].name.split(' ')[0] : `${people.size} people`}` : 'Pick someone'}
      </button>
    );
  } else if (view === 'link') {
    body = (
      <div className="grid gap-3">
        {back}
        <p className="text-[13.5px]" style={{ color: 'var(--mute)' }}>Anyone with this link can see {name} and add it in Barbell. It works for 30 days.</p>
        <div className="sh-link">
          <input readOnly value={url} aria-label="Share link" onFocus={(e) => e.target.select()} />
          <button type="button" className="btn btn-sm" onClick={copy}><Copy size={14} strokeWidth={2} aria-hidden="true" />{copied ? 'Copied' : 'Copy'}</button>
        </div>
      </div>
    );
    footer = <button type="button" className="btn-primary btn-block" onClick={() => shareLink(url, `${name} on Barbell`, `Try this workout: ${name}`)}>Share link…</button>;
  } else {
    body = (
      <div className="grid gap-3">
        {summary}
        <div className="sh-ways">
          <button type="button" className="sh-way" onClick={() => setView('people')} disabled={!picked.size}>
            <span className="sh-way__icon"><Send size={20} strokeWidth={1.9} aria-hidden="true" /></span>
            <span className="flex-1 min-w-0">
              <span className="sh-way__title">Send in app</span>
              <span className="sh-way__sub">To people in your gym, friends and communities. They can add it in one tap.</span>
            </span>
          </button>
          <button type="button" className="sh-way" onClick={makeLink} disabled={busy || !picked.size}>
            <span className="sh-way__icon"><Link2 size={20} strokeWidth={1.9} aria-hidden="true" /></span>
            <span className="flex-1 min-w-0">
              <span className="sh-way__title">{busy ? 'Making the link…' : 'Share a link'}</span>
              <span className="sh-way__sub">For WhatsApp, messages or anywhere else.</span>
            </span>
          </button>
        </div>
        {err && <p className="text-[13px]" role="alert" style={{ color: 'var(--bad)' }}>{err}</p>}
      </div>
    );
  }

  return (
    <Sheet open={open} onClose={busy ? undefined : onClose} title="Share workout"
      sub={view === 'people' ? 'Pick who gets it' : view === 'exercises' ? 'Pick the exercises' : name} footer={footer}>
      {body}
    </Sheet>
  );
}
