/**
 * SHARE MEALS -- pick saved meals/foods, then:
 *
 *   Send in app   to people in your gym, friends and communities; they get
 *                 a popup and a bell notification and can add them to their
 *                 own meals in one tap (POST /app-shares).
 *   Share link    the public link (POST /me/share), handed to the phone's
 *                 own share sheet (WhatsApp, Messages... whatever the
 *                 platform offers) or copied. No fake direct WhatsApp
 *                 button: the platform decides what is available.
 */
import { useEffect, useState } from 'react';
import { Check, ChevronLeft, Copy, Link2, Send } from 'lucide-react';
import { api } from '../../api.js';
import { Sheet } from '../UI.jsx';
import PeoplePicker from '../share/PeoplePicker.jsx';
import { shareLink } from '../share/shareLink.js';
import '../share/share.css';

function PickRow({ on, name, meta, onClick }) {
  return (
    <button type="button" className="sh-pickrow" aria-pressed={on} onClick={onClick}>
      <span className="sh-box" aria-hidden="true">{on && <Check size={13} strokeWidth={3} />}</span>
      <span className="flex-1 min-w-0">
        <span className="sh-pickrow__name truncate">{name}</span>
        <span className="sh-pickrow__meta">{meta}</span>
      </span>
    </button>
  );
}

export default function ShareMealsSheet({ open, onClose }) {
  const [meals, setMeals] = useState(null);
  const [foods, setFoods] = useState(null);
  const [selMeals, setSelMeals] = useState(() => new Set());
  const [selFoods, setSelFoods] = useState(() => new Set());
  const [view, setView] = useState('pick'); // pick | people | link
  const [people, setPeople] = useState(() => new Map());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [url, setUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(null);

  useEffect(() => {
    if (!open) return;
    setSelMeals(new Set()); setSelFoods(new Set()); setView('pick'); setPeople(new Map()); setNote('');
    setBusy(false); setErr(''); setUrl(''); setCopied(false); setSent(null);
    api('/me/meals').then((r) => setMeals(r.meals || [])).catch(() => setMeals([]));
    api('/me/foods').then((r) => setFoods(r.mine || [])).catch(() => setFoods([]));
  }, [open]);

  const flip = (set, setSet, key) => setSet(() => { const n = new Set(set); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const count = selMeals.size + selFoods.size;
  const body = { meal_ids: [...selMeals], food_ids: [...selFoods] };

  const send = async () => {
    if (busy || !people.size) return;
    setBusy(true); setErr('');
    try {
      const r = await api('/app-shares', { method: 'POST', body: JSON.stringify({ kind: 'meal', ...body, recipients: [...people.keys()], message: note.trim() || undefined }) });
      setSent([...people.values()].slice(0, r.sent || people.size));
    } catch (e) { setErr(e.message || 'Could not send it'); }
    setBusy(false);
  };

  const makeLink = async () => {
    if (busy || !count) return;
    setBusy(true); setErr('');
    try {
      const r = await api('/me/share', { method: 'POST', body: JSON.stringify(body) });
      const link = `${window.location.origin}/share/${r.id}`;
      setUrl(link); setView('link');
      if ((await shareLink(link, 'My meal on Barbell', 'Try this on Barbell')) === 'copied') setCopied(true);
    } catch (e) { setErr(e.message || 'Could not make a link'); }
    setBusy(false);
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* still visible */ }
  };

  const back = (
    <button type="button" className="btn btn-sm justify-self-start" onClick={() => { setView('pick'); setErr(''); }}>
      <ChevronLeft size={14} strokeWidth={2} aria-hidden="true" />Back
    </button>
  );

  let content;
  let footer = null;
  if (sent) {
    content = (
      <div className="sh-done">
        <span className="sh-done__icon"><Check size={26} strokeWidth={2.6} aria-hidden="true" /></span>
        <div className="sh-done__title">Sent</div>
        <p className="sh-done__body">{sent.length === 1 ? sent[0].name : `${sent.length} people`} can add {count === 1 ? 'it' : 'them'} to their meals in one tap.</p>
      </div>
    );
    footer = <button type="button" className="btn-primary btn-block" onClick={onClose}>Done</button>;
  } else if (view === 'people') {
    content = (
      <div className="grid gap-3">
        {back}
        <PeoplePicker selected={people} onChange={setPeople} />
        <label className="grid gap-1.5">
          <span className="text-[12.5px] font-semibold" style={{ color: 'var(--mute)' }}>Add a note (optional)</span>
          <input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="e.g. High protein and quick to make" />
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
    content = (
      <div className="grid gap-3">
        {back}
        <p className="text-[13.5px]" style={{ color: 'var(--mute)' }}>Anyone with this link can see {count === 1 ? 'it' : 'them'} and save {count === 1 ? 'it' : 'them'} in Barbell. It works for 30 days.</p>
        <div className="sh-link">
          <input readOnly value={url} aria-label="Share link" onFocus={(e) => e.target.select()} />
          <button type="button" className="btn btn-sm" onClick={copy}><Copy size={14} strokeWidth={2} aria-hidden="true" />{copied ? 'Copied' : 'Copy'}</button>
        </div>
      </div>
    );
    footer = <button type="button" className="btn-primary btn-block" onClick={() => shareLink(url, 'My meal on Barbell', 'Try this on Barbell')}>Share link…</button>;
  } else {
    content = meals === null || foods === null ? (
      <div className="grid gap-2 py-2">{[0, 1, 2].map((i) => <div key={i} className="sh-person sh-person--skeleton" />)}</div>
    ) : (
      <div className="grid gap-4">
        {meals.length > 0 && (
          <section className="grid gap-1.5">
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--mute)' }}>Saved meals</span>
            <div className="sh-pick">
              {meals.map((m) => <PickRow key={m.id} on={selMeals.has(m.id)} name={m.name} meta={`${Math.round(m.calories || 0)} kcal`} onClick={() => flip(selMeals, setSelMeals, m.id)} />)}
            </div>
          </section>
        )}
        {foods.length > 0 && (
          <section className="grid gap-1.5">
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--mute)' }}>Saved foods</span>
            <div className="sh-pick">
              {foods.map((f) => <PickRow key={f.id} on={selFoods.has(f.id)} name={f.name} meta={`${f.serving || '100 g'} · ${Math.round(f.calories || 0)} kcal`} onClick={() => flip(selFoods, setSelFoods, f.id)} />)}
            </div>
          </section>
        )}
        {meals.length === 0 && foods.length === 0 && <div className="sh-empty">Save a meal or food first, then you can share it.</div>}
        {err && <p className="text-[13px]" role="alert" style={{ color: 'var(--bad)' }}>{err}</p>}
      </div>
    );
    if (meals && foods && (meals.length || foods.length)) {
      footer = (
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className="btn" disabled={!count || busy} onClick={makeLink}>
            <Link2 size={15} strokeWidth={2} aria-hidden="true" />{busy ? 'Making…' : 'Share link'}
          </button>
          <button type="button" className="btn-primary" disabled={!count} onClick={() => setView('people')}>
            <Send size={15} strokeWidth={2.2} aria-hidden="true" />Send in app{count ? ` · ${count}` : ''}
          </button>
        </div>
      );
    }
  }

  return (
    <Sheet open={open} onClose={busy ? undefined : onClose} title="Share meals"
      sub={view === 'people' ? 'Pick who gets it' : view === 'pick' ? 'Pick what to share' : undefined} footer={footer}>
      {content}
    </Sheet>
  );
}
