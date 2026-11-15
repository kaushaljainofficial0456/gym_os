/**
 * Who to send something to, in the app.
 *
 * Lists only people the member can already see in the app -- their gym's
 * community and their friend communities (GET /app-shares/people, which
 * the server re-checks on send). Search by name; tap to pick several.
 * People you have shared with before and people you follow come first.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Search, Users, X } from 'lucide-react';
import { api } from '../../api.js';
import './share.css';

const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
const HUES = ['training', 'nutrition', 'strength', 'body', 'recovery', 'energy'];
const hueFor = (name) => HUES[[...String(name || '')].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];

export function Avatar({ name, size = 40 }) {
  const h = hueFor(name);
  return (
    <span className="sh-avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.36), background: `var(--m-${h}-bg)`, color: `var(--m-${h})` }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

const how = (p) => {
  const bits = [];
  if (p.recent) bits.push('Shared before');
  if (p.following) bits.push('You follow');
  if (p.gym) bits.push('Your gym');
  if (p.communities?.length) bits.push(p.communities.slice(0, 2).join(', '));
  return bits.join(' · ');
};

/**
 * @param selected  Map client_id -> person
 * @param onChange  (nextMap) => void
 */
export default function PeoplePicker({ selected, onChange, max = 20 }) {
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const cache = useRef(new Map());

  useEffect(() => {
    const key = q.trim().toLowerCase();
    if (cache.current.has(key)) { setData(cache.current.get(key)); setLoading(false); return undefined; }
    setLoading(true);
    const h = setTimeout(async () => {
      try {
        const r = await api(`/app-shares/people${key ? `?q=${encodeURIComponent(key)}` : ''}`);
        cache.current.set(key, r);
        setData(r);
      } catch { setData({ people: [], gym_community: true, error: true }); }
      setLoading(false);
    }, key ? 250 : 0);
    return () => clearTimeout(h);
  }, [q]);

  const toggle = (p) => {
    const next = new Map(selected);
    if (next.has(p.client_id)) next.delete(p.client_id);
    else if (next.size < max) next.set(p.client_id, p);
    onChange(next);
  };

  const people = data?.people || [];
  return (
    <div className="grid gap-3">
      <label className="sh-search">
        <Search size={16} strokeWidth={2} aria-hidden="true" />
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name" aria-label="Search people" />
      </label>

      {selected.size > 0 && (
        <div className="sh-chips" aria-label="Picked">
          {[...selected.values()].map((p) => (
            <button key={p.client_id} type="button" className="sh-chip" onClick={() => toggle(p)} aria-label={`Remove ${p.name}`}>
              <Avatar name={p.name} size={22} />
              <span className="truncate">{p.name.split(' ')[0]}</span>
              <X size={13} strokeWidth={2.4} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}

      {data && data.gym_community === false && !q && (
        <div className="sh-note">
          <Users size={16} strokeWidth={2} aria-hidden="true" />
          <span>People from your gym show up here once you join your gym&rsquo;s community. <Link to="/app/client/community">Open Community</Link></span>
        </div>
      )}

      <div className="sh-people" role="group" aria-label="People" aria-busy={loading || undefined}>
        {loading && !people.length && [0, 1, 2].map((i) => <div key={i} className="sh-person sh-person--skeleton" />)}
        {!loading && !people.length && (
          <div className="sh-empty">
            {q ? `No one called “${q}” in your gym or communities.` : data?.error ? 'Could not load people. Check your connection.' : 'No one to share with yet. Join your gym’s community or a friend community, or share a link instead.'}
          </div>
        )}
        {people.map((p) => {
          const on = selected.has(p.client_id);
          return (
            <button key={p.client_id} type="button" className={`sh-person${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => toggle(p)}>
              <Avatar name={p.name} />
              <span className="flex-1 min-w-0 text-left">
                <span className="sh-person__name truncate">{p.name}</span>
                <span className="sh-person__how truncate">{how(p)}</span>
              </span>
              <span className="sh-tick" aria-hidden="true">{on && <Check size={14} strokeWidth={3} />}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
