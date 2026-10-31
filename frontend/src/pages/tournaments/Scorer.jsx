/**
 * THE FLOOR. One screen, two jobs: hosts record, everyone else watches.
 *
 * How a score goes in depends on what is being measured, because one host
 * with a phone cannot type while twelve people do burpees:
 *   count     reps and wins: every athlete is a big tile, one tap is one rep
 *   clock     holds and races: pick a heat, count them in, tap each athlete
 *             as they drop or cross the line, and the clock writes the time
 *   attempts  lifts and distances: a cell per attempt, good or no lift
 *
 * Gym wifi is bad, so taps land instantly and are saved behind the scenes.
 * Anything unsaved is held and retried, and the header says so.
 *
 * This screen has to keep up with a fast thumb on a cheap phone. The running
 * clock writes straight to its digits ten times a second without going
 * through React, and a tap redraws only the tile it landed on.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router-dom';
import {
  BarChart3, Check, CloudOff, Flag, Keyboard, Lock, Minus, Pause, Play, Plus, RotateCcw, Search, Timer, Trophy, Undo2, UserPlus, UserRound, X,
} from './icons.jsx';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { ErrorState, PageSkeleton, Toast, useConfirm } from '../../components/UI.jsx';
import { eventStyle, Hero, METRIC_WORD, PhaseChip, themeClass, useTournamentBase } from './shared.jsx';
import { RankBars } from './visuals.jsx';
import { AddPeopleSheet, TSheet } from './DetailSheets.jsx';

const MODE = { reps: 'count', wins: 'count', time_high: 'clock', time_low: 'clock', weight: 'attempts', distance: 'attempts' };
const UNIT = { weight: 'kg', distance: 'm' };
const keyOf = (subject, attempt) => `${subject}:${attempt}`;

export const fmtClock = (sec) => {
  const s = Math.max(0, sec || 0);
  const m = Math.floor(s / 60);
  const rest = (s - m * 60).toFixed(1).padStart(4, '0');
  return `${m}:${rest}`;
};
const parseTime = (text) => {
  const parts = String(text).trim().split(':').map(Number);
  if (!String(text).trim() || parts.some(Number.isNaN)) return NaN;
  return parts.reduce((a, b) => a * 60 + b, 0);
};
const buzz = (ms = 8) => { try { navigator.vibrate?.(ms); } catch { /* not every phone */ } };

let audio;
function beep(freq = 880, ms = 150) {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    gain.gain.value = 0.12;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + ms / 1000);
  } catch { /* sound is a bonus */ }
}

/** `paint` runs ten times a second while running, outside React. */
function useClock(paint) {
  const base = useRef(0);
  const started = useRef(null);
  const [state, setState] = useState('idle');
  const frame = useRef(paint);
  frame.current = paint;
  useEffect(() => {
    if (state !== 'running') return undefined;
    const id = setInterval(() => frame.current(), 100);
    return () => clearInterval(id);
  }, [state]);
  const elapsed = useCallback(() => base.current + (started.current != null ? (performance.now() - started.current) / 1000 : 0), []);
  const start = useCallback(() => { started.current = performance.now(); setState('running'); }, []);
  const pause = useCallback(() => { base.current = elapsed(); started.current = null; setState('paused'); }, [elapsed]);
  const reset = useCallback(() => { base.current = 0; started.current = null; setState('idle'); }, []);
  return { state, running: state === 'running', elapsed, start, pause, reset };
}

/** Saves scores in order. Network trouble keeps them; a refusal drops them. */
function useScoreWriter(url, onBoard, onRefused) {
  const queue = useRef(new Map());
  const timer = useRef(null);
  const running = useRef(false);
  const [status, setStatus] = useState('saved');

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    while (queue.current.size) {
      const [key, job] = queue.current.entries().next().value;
      setStatus('saving');
      try {
        const body = job.clear
          ? { subject_id: job.subject_id, attempt: job.attempt }
          : { subject_id: job.subject_id, attempt: job.attempt, value: job.value, valid: job.valid };
        // eslint-disable-next-line no-await-in-loop
        const board = await api(url, { method: job.clear ? 'DELETE' : 'PUT', body: JSON.stringify(body) });
        if (queue.current.get(key) === job) queue.current.delete(key);
        if (!queue.current.size) onBoard(board);
      } catch (e) {
        if (!e.status) {
          setStatus('offline');
          running.current = false;
          timer.current = setTimeout(run, 3000);
          return;
        }
        if (queue.current.get(key) === job) queue.current.delete(key);
        onRefused(e, job);
      }
    }
    running.current = false;
    setStatus('saved');
  }, [url, onBoard, onRefused]);

  const write = useCallback((job, wait = 450) => {
    queue.current.set(keyOf(job.subject_id, job.attempt), job);
    setStatus((s) => (s === 'offline' ? s : 'saving'));
    clearTimeout(timer.current);
    timer.current = setTimeout(run, wait);
  }, [run]);

  useEffect(() => {
    const again = () => run();
    const warn = (e) => { if (queue.current.size) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('online', again);
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('online', again);
      window.removeEventListener('beforeunload', warn);
      clearTimeout(timer.current);
    };
  }, [run]);

  return { write, status, pending: queue };
}

/** The phone must not sleep while someone is counting on it. */
function useWakeLock(on) {
  useEffect(() => {
    if (!on || !navigator.wakeLock) return undefined;
    let lock = null;
    let gone = false;
    const take = async () => {
      try { lock = await navigator.wakeLock.request('screen'); if (gone) lock.release(); } catch { /* best effort */ }
    };
    const back = () => { if (document.visibilityState === 'visible') take(); };
    take();
    document.addEventListener('visibilitychange', back);
    return () => { gone = true; document.removeEventListener('visibilitychange', back); lock?.release?.(); };
  }, [on]);
}

function CountIn({ value, theme }) {
  if (value == null) return null;
  return createPortal(
    <div className={`tr-sheet tr-go ${themeClass(theme)}`} role="status"><span key={value}>{value}</span></div>,
    document.body,
  );
}

function EntrySheet({ entry, event, onClose, onSave, onClear, theme }) {
  const [text, setText] = useState('');
  const [good, setGood] = useState(true);
  const timed = event.metric === 'time_high' || event.metric === 'time_low';
  const canFail = event.metric === 'weight' || event.metric === 'distance';
  useEffect(() => {
    if (!entry) return;
    setText(entry.value == null ? '' : timed ? fmtClock(entry.value) : String(entry.value));
    setGood(entry.valid !== false);
  }, [entry, timed]);
  const value = timed ? parseTime(text) : Number(text);
  const ok = text.trim() !== '' && Number.isFinite(value) && value >= 0;
  const step = (d) => setText(String(Math.max(0, (Number(text) || 0) + d)));
  return (
    <TSheet theme={theme} open={!!entry} onClose={onClose} title={entry?.row.name || ''} sub={event.attempts > 1 ? `Attempt ${entry?.attempt}` : METRIC_WORD[event.metric]}
      footer={<button type="button" className="tr-cta tr-cta-block" disabled={!ok} onClick={() => onSave(value, good)}><Check size={16} />Save</button>}>
      <label className="tr-field">
        <span className="tr-label">{timed ? 'Time, like 1:30.5' : UNIT[event.metric] ? `In ${UNIT[event.metric]}` : 'Count'}</span>
        <input className="input" autoFocus inputMode={timed ? 'text' : 'decimal'} value={text} onChange={(e) => setText(e.target.value)} placeholder={timed ? '1:30.5' : '0'} />
      </label>
      {event.metric === 'weight' && (
        <div className="tr-mini">
          {[-5, -2.5, 2.5, 5].map((d) => <button type="button" key={d} onClick={() => step(d)}>{d > 0 ? `+${d}` : d}</button>)}
        </div>
      )}
      {canFail && (
        <div className="tr-toggle" role="group" aria-label="Did it count">
          <button type="button" aria-pressed={good} onClick={() => setGood(true)}><Check size={14} />Good</button>
          <button type="button" aria-pressed={!good} onClick={() => setGood(false)}><X size={14} />No lift</button>
        </div>
      )}
      {entry?.value != null && <button type="button" className="btn-danger-quiet btn-base" onClick={onClear}><X size={15} />Clear this score</button>}
    </TSheet>
  );
}

const Tile = memo(function Tile({ row, value, live, state, locked, sub, minus, on }) {
  return (
    <div className="tr-athlete" data-state={locked ? 'locked' : state}>
      <button type="button" className="tr-athlete-main" disabled={locked} onClick={() => on.tap(row)} aria-label={`${row.name}, ${live ? 'running' : value}`}>
        <span className="tr-athlete-name">{row.name}</span>
        {sub && <span className="tr-faint tr-ellipsis">{sub}</span>}
        {live ? <span className="tr-athlete-value" data-live-time="" /> : <span className="tr-athlete-value">{value}</span>}
      </button>
      {locked ? <span className="tr-athlete-corner" title="Another host scores you"><Lock size={15} /></span>
        : <button type="button" className="tr-athlete-corner" aria-label={`Type a score for ${row.name}`} onClick={() => on.edit(row)}><Keyboard size={15} /></button>}
      {minus && !locked && <button type="button" className="tr-athlete-minus" aria-label={`One less for ${row.name}`} onClick={() => on.minus(row)}><Minus size={17} /></button>}
    </div>
  );
});

function Board({ board }) {
  const scored = board.rows.filter((r) => r.rank != null).length;
  return (
    <section className="tr-panel tr-section">
      {scored === 0 && <div className="tr-muted">No scores yet.</div>}
      <RankBars rows={board.rows} lowerWins={board.event.metric === 'time_low'} labelOf={(r) => `${r.display}${r.self_recorded ? ' *' : ''}`} />
      {board.rows.some((r) => r.self_recorded) && <div className="tr-faint">* Recorded by the competitor, who was the only host.</div>}
    </section>
  );
}

export default function Scorer() {
  const { id, eventId } = useParams();
  const nav = useNavigate();
  const base = useTournamentBase();
  const tournament = useFetch(() => api(`/tournaments/${id}`), [id]);
  const [board, setBoard] = useState(null);
  const [failure, setFailure] = useState(null);
  const [view, setView] = useState('score');
  const [overlay, setOverlay] = useState({});
  const [attempt, setAttempt] = useState(1);
  const [undo, setUndo] = useState(null);
  const [entry, setEntry] = useState(null);
  const [heat, setHeat] = useState([]);
  const [finishing, setFinishing] = useState(() => new Set());
  const [countIn, setCountIn] = useState(null);
  const [timeUp, setTimeUp] = useState(false);
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const paintRef = useRef(() => {});
  const clock = useClock(() => paintRef.current());
  const countTimer = useRef(null);
  const digits = useRef(null);
  const clockBox = useRef(null);
  const floor = useRef(null);
  useEffect(() => () => clearInterval(countTimer.current), []);

  const boardUrl = `/tournaments/${id}/events/${eventId}/board`;
  const load = useCallback(() => api(boardUrl).then(setBoard), [boardUrl]);
  useEffect(() => { load().catch(setFailure); }, [load]);

  const writerRef = useRef(null);
  const onBoard = useCallback((next) => {
    setBoard(next);
    setOverlay((o) => Object.fromEntries(Object.entries(o).filter(([k]) => writerRef.current?.pending.current.has(k))));
  }, []);
  const onRefused = useCallback((e, job) => {
    setToast(e.message);
    setOverlay((o) => { const n = { ...o }; delete n[keyOf(job.subject_id, job.attempt)]; return n; });
  }, []);
  const writer = useScoreWriter(`/tournaments/${id}/events/${eventId}/results`, onBoard, onRefused);
  writerRef.current = writer;

  const event = board?.event;
  const isLive = event?.status === 'live';
  useEffect(() => {
    if (!isLive) return undefined;
    const timer = setInterval(() => { if (!document.hidden) load().catch(() => {}); }, 4000);
    return () => clearInterval(timer);
  }, [isLive, load]);

  const isHost = !!board?.is_host;
  const scoring = isHost && isLive && view === 'score';
  useWakeLock(scoring);

  const mode = event ? MODE[event.metric] : 'count';
  const cap = event?.time_cap_sec || null;

  const rows = useMemo(() => {
    // Alphabetical while scoring: a tile that jumps as ranks change gets the
    // next tap meant for someone else.
    const term = query.trim().toLowerCase();
    return [...(board?.rows || [])].sort((a, b) => a.name.localeCompare(b.name)).filter((r) => !term || r.name.toLowerCase().includes(term));
  }, [board, query]);

  const hosts = tournament.data?.hosts?.filter((h) => h.status === 'accepted').length || 1;
  const lockedFor = (row) => row.is_me && hosts > 1;

  const stored = (row, a = attempt) => row.attempts?.find((x) => x.attempt === a);
  const valueOf = (row, a = attempt) => {
    const k = keyOf(row.id, a);
    if (k in overlay) return overlay[k]?.value ?? null;
    return stored(row, a)?.value ?? null;
  };
  const validOf = (row, a = attempt) => {
    const k = keyOf(row.id, a);
    if (k in overlay) return overlay[k]?.valid !== false;
    return stored(row, a)?.valid !== false;
  };

  const put = (row, a, value, valid = true, label = '') => {
    const before = valueOf(row, a);
    const beforeValid = validOf(row, a);
    setOverlay((o) => ({ ...o, [keyOf(row.id, a)]: { value, valid } }));
    writer.write({ subject_id: row.id, attempt: a, value, valid });
    setUndo({ row, attempt: a, value: before, valid: beforeValid, label: label || `${row.name} updated` });
  };
  const clear = (row, a) => {
    setOverlay((o) => ({ ...o, [keyOf(row.id, a)]: null }));
    writer.write({ subject_id: row.id, attempt: a, clear: true }, 0);
  };
  const doUndo = () => {
    if (!undo) return;
    if (undo.value == null) clear(undo.row, undo.attempt);
    else {
      setOverlay((o) => ({ ...o, [keyOf(undo.row.id, undo.attempt)]: { value: undo.value, valid: undo.valid } }));
      writer.write({ subject_id: undo.row.id, attempt: undo.attempt, value: undo.value, valid: undo.valid }, 0);
    }
    setUndo(null);
  };

  const beginCount = (then) => {
    let n = 3;
    setCountIn(n); beep();
    clearInterval(countTimer.current);
    countTimer.current = setInterval(() => {
      n -= 1;
      if (n > 0) { setCountIn(n); beep(); return; }
      clearInterval(countTimer.current);
      setCountIn(null);
      beep(1320, 320); buzz(60);
      then();
    }, 1000);
  };

  const running = heat.filter((x) => !finishing.has(x));
  const startHeat = () => beginCount(() => { setFinishing(new Set()); setTimeUp(false); clock.reset(); clock.start(); });
  const stopAthlete = (row) => {
    const value = Math.round(clock.elapsed() * 10) / 10;
    buzz(30);
    put(row, attempt, value, true, `${row.name}: ${fmtClock(value)}`);
    const nextDone = new Set(finishing).add(row.id);
    setFinishing(nextDone);
    if (heat.every((x) => nextDone.has(x))) { clock.reset(); setHeat([]); setFinishing(new Set()); }
  };

  // The clock reaching the limit: a hold is capped at it, a race is a DNF.
  const hitCap = () => {
    beep(520, 500); buzz(120);
    clock.pause();
    setTimeUp(true);
    if (mode !== 'clock') return;
    if (event.metric === 'time_high') {
      for (const subject of running) {
        const row = board.rows.find((r) => r.id === subject);
        if (row) put(row, attempt, cap, true);
      }
    }
    clock.reset(); setHeat([]); setFinishing(new Set());
  };

  paintRef.current = () => {
    const e = clock.elapsed();
    const left = mode === 'count' && cap ? Math.max(0, cap - e) : e;
    if (digits.current) digits.current.textContent = timeUp && mode === 'count' ? 'Time!' : fmtClock(left);
    if (clockBox.current) clockBox.current.dataset.urgent = String(mode === 'count' && !!cap && cap - e <= 10);
    floor.current?.querySelectorAll('[data-live-time]').forEach((node) => { node.textContent = fmtClock(e); });
    if (clock.running && cap && e >= cap) hitCap();
  };
  // A paint for every change the interval would not see: a pause, a reset,
  // a tile that has just started running.
  useLayoutEffect(() => { paintRef.current(); });

  const handlers = useRef({});
  handlers.current = {
    tap: (r) => {
      if (mode === 'count') { buzz(); put(r, attempt, (valueOf(r) ?? 0) + 1, true, `${r.name} +1`); return; }
      const inHeat = heat.includes(r.id);
      if (clock.running && inHeat && !finishing.has(r.id)) { stopAthlete(r); return; }
      if (clock.state !== 'idle') return;
      setHeat((h) => (inHeat ? h.filter((x) => x !== r.id) : [...h, r.id]));
    },
    minus: (r) => { if ((valueOf(r) ?? 0) > 0) put(r, attempt, valueOf(r) - 1, true, `${r.name} −1`); },
    edit: (r) => setEntry({ row: r, attempt, value: valueOf(r), valid: true }),
  };
  const on = useMemo(() => ({
    tap: (r) => handlers.current.tap(r), minus: (r) => handlers.current.minus(r), edit: (r) => handlers.current.edit(r),
  }), []);

  const act = async (fn) => {
    setBusy(true);
    try { await fn(); } catch (e) { setToast(e.message); } finally { setBusy(false); }
  };
  const start = () => act(async () => {
    await api(`/tournaments/${id}/events/${eventId}/start`, { method: 'POST' });
    await load();
  });
  const finish = async () => {
    const missing = board.rows.filter((r) => valueOf(r) == null && !r.attempts?.length).length;
    const yes = await confirm({
      title: `Finish ${event.name}?`,
      body: missing ? `${missing} ${missing === 1 ? 'has' : 'have'} no score and will not be placed.` : 'Places are worked out and everyone is told.',
      confirmLabel: 'Finish', cancelLabel: 'Keep going',
    });
    if (!yes) return;
    await act(async () => {
      await api(`/tournaments/${id}/events/${eventId}/finish`, { method: 'POST' });
      nav(`${base}/${id}/results?event=${eventId}`);
    });
  };
  const reopen = () => act(async () => {
    await api(`/tournaments/${id}/events/${eventId}/reopen`, { method: 'POST' });
    await load();
  });

  if (failure && !board) return <ErrorState error={failure} onRetry={() => { setFailure(null); load().catch(setFailure); }} />;
  if (!board || (tournament.loading && !tournament.data)) return <PageSkeleton />;

  const t = tournament.data;
  const theme = t?.theme;
  const finished = t?.status === 'completed';
  const hasClock = scoring && (mode === 'clock' || (mode === 'count' && cap));
  const canAdd = isHost && !finished && event.status !== 'completed' && t;
  const index = t?.events?.findIndex((e) => e.id === eventId) ?? 0;

  return (
    <div className={`tr-root ${themeClass(theme)}`} style={eventStyle(index)}>
      <Hero back={{ label: 'Back to the tournament', onClick: () => nav(`${base}/${id}`) }}
        actions={isHost && isLive && (
          <span className="tr-saving" role="status">
            {writer.status === 'offline' ? <><CloudOff size={13} />Saved here, will send</> : writer.status === 'saving' ? 'Saving…' : <><Check size={13} />Saved</>}
          </span>
        )}
        eyebrow={<><PhaseChip phase={isLive ? 'live' : event.status === 'completed' ? 'completed' : 'soon'} onHero /><span className="tr-tag">{METRIC_WORD[event.metric]}</span><span className="tr-tag">Top {event.win_positions} win</span></>}
        title={event.name} compact />

      {isHost && isLive && (
        <div className="tr-tabs" role="tablist">
          <button type="button" role="tab" className="tr-tab" aria-selected={view === 'score'} onClick={() => setView('score')}><Timer size={15} />Score</button>
          <button type="button" role="tab" className="tr-tab" aria-selected={view === 'board'} onClick={() => setView('board')}><BarChart3 size={15} />Board</button>
        </div>
      )}

      {hasClock && (
        <div className="tr-clock" ref={clockBox}>
          <div className="tr-clock-time" ref={digits} />
          <div className="tr-clock-actions">
            {clock.state === 'idle' && (
              <button type="button" className="tr-clock-btn" data-go="true" disabled={mode === 'clock' && !heat.length}
                onClick={mode === 'clock' ? startHeat : () => beginCount(() => { setTimeUp(false); clock.start(); })}>
                <Play size={17} />{mode === 'clock' ? `Go (${heat.length})` : 'Go'}
              </button>
            )}
            {clock.running && <button type="button" className="tr-clock-btn" onClick={clock.pause}><Pause size={17} />Pause</button>}
            {clock.state === 'paused' && !timeUp && <button type="button" className="tr-clock-btn" data-go="true" onClick={clock.start}><Play size={17} />Resume</button>}
            {clock.state !== 'idle' && <button type="button" className="tr-clock-btn" onClick={() => { clock.reset(); setTimeUp(false); setFinishing(new Set()); }}><RotateCcw size={16} />Reset</button>}
          </div>
          {mode === 'clock' && clock.state === 'idle' && (
            <div className="tr-mini">
              <button type="button" onClick={() => setHeat(board.rows.filter((r) => valueOf(r) == null && !lockedFor(r)).map((r) => r.id))}>Everyone waiting</button>
              {heat.length > 0 && <button type="button" onClick={() => setHeat([])}>Clear</button>}
            </div>
          )}
        </div>
      )}

      {scoring && event.attempts > 1 && mode !== 'attempts' && (
        <div className="tr-mini" role="group" aria-label="Attempt">
          {Array.from({ length: event.attempts }, (_, i) => i + 1).map((a) => <button type="button" key={a} aria-pressed={attempt === a} onClick={() => setAttempt(a)}>Attempt {a}</button>)}
        </div>
      )}

      {scoring && board.rows.length > 12 && (
        <div className="tr-search"><Search size={16} /><input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find an athlete" aria-label="Find an athlete" /></div>
      )}

      {scoring && board.rows.length === 0 && <div className="tr-panel tr-muted">Nobody is in this competition yet.</div>}

      {scoring && mode === 'count' && (
        <div className="tr-athletes" ref={floor}>
          {rows.map((r) => <Tile key={r.id} row={r} value={valueOf(r) ?? 0} locked={lockedFor(r)} sub={r.members?.map((m) => m.name).join(', ')} minus on={on} />)}
        </div>
      )}

      {scoring && mode === 'clock' && (
        <div className="tr-athletes" ref={floor}>
          {rows.map((r) => {
            const inHeat = heat.includes(r.id);
            const racing = clock.running && inHeat && !finishing.has(r.id);
            return (
              <Tile key={r.id} row={r} live={racing} value={valueOf(r) != null ? fmtClock(valueOf(r)) : '–'} locked={lockedFor(r)}
                state={racing ? 'running' : inHeat ? 'picked' : undefined} sub={r.members?.map((m) => m.name).join(', ')} on={on} />
            );
          })}
        </div>
      )}

      {scoring && mode === 'attempts' && rows.length > 0 && (
        <section className="tr-list">
          {rows.map((r) => (
            <div key={r.id} className="tr-attempt-row">
              <span className="tr-grow" style={{ minWidth: 110 }}>
                <b style={{ color: 'var(--ink)', fontSize: 14 }}>{r.name}</b>
                <span className="tr-faint" style={{ display: 'block' }}>{lockedFor(r) ? 'Another host scores you' : r.display}</span>
              </span>
              <div className="tr-attempts">
                {Array.from({ length: event.attempts }, (_, i) => i + 1).map((a) => {
                  const v = valueOf(r, a);
                  return (
                    <button type="button" key={a} className="tr-attempt" disabled={lockedFor(r)} data-state={v == null ? undefined : validOf(r, a) ? 'good' : 'bad'}
                      aria-label={`${r.name} attempt ${a}${v == null ? ', empty' : `, ${v}`}`} onClick={() => setEntry({ row: r, attempt: a, value: v, valid: validOf(r, a) })}>
                      {v == null ? <Plus size={15} /> : `${v}${UNIT[event.metric] || ''}`}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </section>
      )}

      {!scoring && event.status === 'upcoming' && (
        <section className="tr-panel tr-section">
          <div className="tr-muted">{board.rows.length} in. {isHost ? 'Start when they are ready.' : 'Not started yet.'}</div>
          {board.rows.map((r) => <div key={r.id} className="tr-row" style={{ color: 'var(--ink)', fontSize: 14 }}><UserRound size={14} />{r.name}{r.is_me ? ' (you)' : ''}</div>)}
          {isHost && !finished && <button type="button" className="tr-cta" disabled={busy} onClick={start}><Play size={16} />Start competition</button>}
        </section>
      )}

      {!scoring && event.status !== 'upcoming' && <Board board={board} />}

      {canAdd && <button type="button" className="btn" onClick={() => setAdding(true)}><UserPlus size={16} />Add people</button>}

      {event.status === 'completed' && (
        <div className="tr-pair">
          <button type="button" className="tr-cta" onClick={() => nav(`${base}/${id}/results?event=${eventId}`)}><Trophy size={16} />Full summary</button>
          {isHost && !finished && <button type="button" className="btn" disabled={busy} onClick={reopen}><RotateCcw size={16} />Reopen to correct</button>}
        </div>
      )}

      {undo && scoring ? (
        <div className="tr-undo" role="status">
          <span className="tr-ellipsis">{undo.label}</span>
          <button type="button" className="tr-cta tr-cta-small" onClick={doUndo}><Undo2 size={15} />Undo</button>
        </div>
      ) : null}
      {isHost && isLive && (
        <button type="button" className="tr-cta" disabled={busy} onClick={finish}><Flag size={16} />Finish competition</button>
      )}

      <EntrySheet entry={entry} event={event} theme={theme} onClose={() => setEntry(null)}
        onSave={(value, valid) => { put(entry.row, entry.attempt, value, valid); setEntry(null); }}
        onClear={() => { clear(entry.row, entry.attempt); setEntry(null); }} />
      {t && <AddPeopleSheet open={adding} onClose={() => setAdding(false)} t={t} preselect={eventId}
        onDone={(message) => { setAdding(false); setToast(message); load().catch(() => {}); tournament.reload({ silent: true }); }} />}
      <CountIn value={countIn} theme={theme} />
      {confirmDialog}
      <Toast message={toast} tone="error" onDone={() => setToast('')} />
    </div>
  );
}
