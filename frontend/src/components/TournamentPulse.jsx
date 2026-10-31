/**
 * The way into Tournaments from where people already are. In Community it is
 * a full row, always there, because that is where someone goes looking for
 * other people. On Home it is a small badge in the header corner that only
 * appears when something is on.
 *
 * Home is the app's most-opened screen, so this costs it nothing: the request
 * waits until the browser is idle, and the badge is positioned out of the
 * flow, so turning up late cannot push the page down. Standalone on purpose:
 * importing the tournament pages here would pull their code and stylesheet
 * into Home.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import Icon from './Icon.jsx';

const HUE = { ember: '#FF7A4D', neon: '#FF5FA8', ocean: '#4FB3FF', volt: '#3FD9A4', royal: '#B497FF' };
const CACHE = 'tournament-pulse';
const read = () => { try { return JSON.parse(sessionStorage.getItem(CACHE) || 'null'); } catch { return null; } };

export default function TournamentPulse({ badge = false, className = '' }) {
  const [pulse, setPulse] = useState(read);
  useEffect(() => {
    let alive = true;
    const load = () => api('/tournaments/pulse').then((p) => {
      if (!alive) return;
      setPulse(p);
      try { sessionStorage.setItem(CACHE, JSON.stringify(p)); } catch { /* the banner just loads next time */ }
    }).catch(() => {});
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 900));
    const cancel = window.cancelIdleCallback || clearTimeout;
    const handle = idle(load, { timeout: 2500 });
    return () => { alive = false; cancel(handle); };
  }, []);

  const { live = 0, upcoming = 0, invites = 0, next = null } = pulse || {};
  const link = !invites && next && live + upcoming === 1 ? `/app/client/tournaments/${next.id}` : '/app/client/tournaments';

  if (badge) {
    if (!live && !upcoming && !invites) return null;
    const word = invites ? 'Co-host?' : live ? `${live} live` : `${upcoming} coming up`;
    return (
      <Link to={link} className={`absolute right-0 top-0 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${className}`}
        style={{ background: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--ink)' }}>
        <span style={{ color: HUE[next?.theme] || 'var(--gold)' }}><Icon name="trophy" size={13} /></span>{word}
      </Link>
    );
  }

  const title = invites ? 'You were asked to co-host' : next ? next.name : 'Tournaments';
  const sub = invites ? 'Tap to answer'
    : live ? `${live} live now`
      : upcoming ? `${upcoming} coming up`
        : 'Host one at your gym';
  return (
    <Link to={link} className={`flex items-center gap-3 rounded-2xl px-3.5 py-3 ${className}`}
      style={{ background: `radial-gradient(90% 180% at 100% 0, ${HUE[next?.theme] || '#FFB800'}33, transparent 70%), var(--panel)`, border: '1px solid var(--line)' }}>
      <span className="shrink-0 grid place-items-center rounded-xl" style={{ width: 38, height: 38, color: '#fff', background: `linear-gradient(145deg, ${HUE[next?.theme] || '#FFB800'}, #FF541E)` }}><Icon name="trophy" size={19} /></span>
      <span className="flex-1 min-w-0">
        <span className="block text-[13.5px] font-bold truncate" style={{ color: 'var(--ink)' }}>{title}</span>
        <span className="block text-[11.5px]" style={{ color: 'var(--mute)' }}>{sub}</span>
      </span>
      <span className="shrink-0" style={{ color: 'var(--faint)' }}>›</span>
    </Link>
  );
}
