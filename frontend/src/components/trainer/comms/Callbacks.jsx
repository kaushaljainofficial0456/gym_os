/**
 * CALL BACKS -- every promise to call a member back, in one place.
 *
 *   Booked         the AI (or a recording) calls at the time the member chose
 *                  -- "next Monday at 6" -- or that you booked. Reschedule it,
 *                  change who calls, call now, or cancel.
 *   For your team  a member asked for a person. Automated contact pauses for
 *                  them until you close it.
 *   Finished       done, cancelled, missed or failed -- with what happened.
 */
import { useMemo, useState } from 'react';
import { api } from '../../../api.js';
import { Card, ErrorState, Modal, PageSkeleton, Toast } from '../../UI.jsx';
import Select from '../../Select.jsx';
import Icon from '../../Icon.jsx';
import { CHANNEL, CALLBACK_STATUS, CALLBACK_MODE, Field, Pill, SectionHead, Tag, when, useApi } from './shared.jsx';

const VIEWS = [['scheduled', 'Booked'], ['staff', 'For your team'], ['done', 'Finished']];

export default function Callbacks({ go }) {
  const [view, setView] = useState('scheduled');
  const [toast, setToast] = useState({ msg: '' });
  const [booking, setBooking] = useState(false);
  const path = view === 'scheduled' ? '/followups/callbacks?view=scheduled' : view === 'done' ? '/followups/callbacks?view=done' : '/followups/callbacks';
  const c = useApi(path);
  const say = (msg, tone = 'success') => setToast({ msg, tone });
  return (
    <div className="space-y-4">
      <SectionHead title="Call backs" action={<button type="button" className="btn-primary" onClick={() => setBooking(true)}>+ Book a call back</button>} />
      <p className="text-[14px] -mt-1" style={{ color: 'var(--mute)' }}>
        When a member asks to be called later, the AI books the exact time they chose and calls them then. You can change any booking, or hand it to a person.
      </p>
      <div className="flex gap-1.5 overflow-x-auto no-scrollbar">{VIEWS.map(([k, l]) => <Pill key={k} on={view === k} onClick={() => setView(k)}>{l}</Pill>)}</div>
      {c.loading ? <PageSkeleton label="Loading call backs" /> : c.error ? <ErrorState error={c.error} onRetry={c.reload} /> : (
        view === 'staff' ? <StaffList data={c.data} reload={c.reload} say={say} />
          : <BookedList data={c.data} view={view} reload={c.reload} say={say} go={go} />
      )}
      {booking && <BookModal onClose={() => setBooking(false)} onDone={() => { setBooking(false); setView('scheduled'); c.reload(); say('Call back booked'); }} />}
      {toast.msg && <Toast message={toast.msg} tone={toast.tone} onDone={() => setToast({ msg: '' })} />}
    </div>
  );
}

function Status({ status }) {
  const [label, tone] = CALLBACK_STATUS[status] || [status, 'mute'];
  return <Tag tone={tone}>{label}</Tag>;
}

function BookedList({ data, view, reload, say, go }) {
  const [editing, setEditing] = useState(null);
  const list = data.callbacks || [];
  if (!list.length) {
    return (
      <Card className="p-5 text-[15px]" style={{ color: 'var(--mute)' }}>
        {view === 'scheduled' ? 'No call backs booked. When a member asks the AI to call later, it appears here with the time they chose.' : 'Nothing finished in the last 60 days.'}
      </Card>
    );
  }
  const act = async (cb, path, body, done) => {
    try { await api(`/followups/callbacks/${cb.id}/${path}`, { method: path === 'cancel' || path === 'call-now' ? 'POST' : 'PUT', body: JSON.stringify(body || {}) }); reload(); say(done); } catch (e) { say(e.message, 'error'); }
  };
  return (
    <div className="space-y-3">
      {list.map((cb) => (
        <Card key={cb.id} className="p-4 space-y-3">
          <div className="flex items-start gap-3 flex-wrap">
            <div className="flex-1 min-w-[200px]">
              <div className="font-semibold" style={{ color: 'var(--ink)' }}>{cb.member_name}</div>
              <div className="text-[15px] font-semibold mt-0.5" style={{ color: cb.status === 'scheduled' ? 'var(--ink)' : 'var(--mute)' }}>
                {cb.when_label || cb.requested_time || 'No time set'}
              </div>
              <div className="text-[13px]" style={{ color: 'var(--mute)' }}>
                {CALLBACK_MODE[cb.mode]}{cb.mode === 'agent' && cb.agent_name ? ` · ${cb.agent_name}` : ''}{cb.mode === 'call' && cb.recording_name ? ` · ${cb.recording_name}` : ''}
                {cb.source === 'owner' ? ' · booked by the gym' : cb.source === 'member_request' ? ' · the member asked' : ''}
              </div>
            </div>
            <Status status={cb.status} />
          </div>
          {cb.conversation_summary && <p className="text-[14px]" style={{ color: 'var(--ink)' }}>{cb.conversation_summary}</p>}
          {!cb.conversation_summary && cb.reason && <p className="text-[14px]" style={{ color: 'var(--ink)' }}>{cb.reason}</p>}
          {cb.last_error && <p className="text-[13px]" style={{ color: ['failed', 'expired'].includes(cb.status) ? 'var(--bad)' : 'var(--mute)' }}>{cb.last_error}</p>}
          <div className="flex items-center gap-2 flex-wrap">
            {['scheduled', 'failed', 'expired', 'cancelled'].includes(cb.status) && (
              <>
                <button type="button" className="btn btn-sm" onClick={() => setEditing({ cb, what: 'time' })}>{cb.status === 'scheduled' ? 'Change time' : 'Book again'}</button>
                <button type="button" className="btn btn-sm" onClick={() => setEditing({ cb, what: 'mode' })}>Who calls</button>
              </>
            )}
            {['scheduled', 'failed', 'expired'].includes(cb.status) && cb.mode !== 'human' && (
              <button type="button" className="btn btn-sm" onClick={() => act(cb, 'call-now', {}, 'Calling now')}><Icon name="phone" size={14} /> Call now</button>
            )}
            {cb.status === 'scheduled' && <button type="button" className="btn btn-sm" onClick={() => act(cb, 'cancel', {}, 'Call back cancelled')}>Cancel</button>}
            {cb.conversation_id && <button type="button" className="btn btn-sm" onClick={() => go?.('conversations')}>Conversation</button>}
          </div>
          {cb.events?.length > 0 && (
            <details className="text-[13px]" style={{ color: 'var(--mute)' }}>
              <summary className="cursor-pointer">What happened ({cb.events.length})</summary>
              <ol className="mt-2 space-y-1">
                {cb.events.map((e, i) => <li key={i}>{when(e.at)} · {EVENT[e.event] || e.event}{e.note ? ` · ${e.note}` : ''}</li>)}
              </ol>
            </details>
          )}
        </Card>
      ))}
      {editing?.what === 'time' && <TimeModal cb={editing.cb} onClose={() => setEditing(null)} onSave={(body) => { setEditing(null); act(editing.cb, 'schedule', body, 'Call back moved'); }} />}
      {editing?.what === 'mode' && <ModeModal cb={editing.cb} onClose={() => setEditing(null)} onSave={(body) => { setEditing(null); act(editing.cb, 'mode', body, 'Updated who calls'); }} />}
    </div>
  );
}

const EVENT = {
  scheduled: 'Booked', rescheduled: 'Moved', queued: 'Placed in the queue', retry: 'No answer, will try again', completed: 'Done', failed: 'Could not be placed',
  cancelled: 'Cancelled', expired: 'Missed its time', replaced: 'Replaced by a newer request', handed_to_staff: 'Handed to a person', mode_changed: 'Changed who calls', call_now: 'Call now',
};

/** Tomorrow at 11, as a starting point a person can change. */
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

function TimeModal({ cb, onClose, onSave }) {
  const local = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/.exec(cb.scheduled_local || '');
  const [date, setDate] = useState(local?.[1] || tomorrow());
  const [time, setTime] = useState(local?.[2] || '11:00');
  return (
    <Modal open onClose={onClose} title={`Call ${cb.member_name} back`}
      footer={<div className="flex justify-end gap-2 w-full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn-primary" onClick={() => onSave({ date, time })}>Save</button></div>}>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Day"><input type="date" className="input w-full" value={date} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Time"><input type="time" className="input w-full" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
      </div>
      <p className="text-[13px] mt-3" style={{ color: 'var(--mute)' }}>It must be inside your calling hours, on a day you call.</p>
    </Modal>
  );
}

function ContentPickers({ mode, value, onChange }) {
  const agents = useApi(mode === 'agent' ? '/followups/agents' : null);
  const recs = useApi(mode === 'call' ? '/followups/recordings' : null);
  if (mode === 'agent') {
    return (
      <Field label="AI agent">
        <Select aria-label="AI agent" value={value.agent_id || ''} onChange={(v) => onChange({ agent_id: v })} placeholder="Pick an agent"
          options={(agents.data?.agents || []).map((a) => ({ value: a.id, label: a.name, hint: a.language.toUpperCase() }))} />
      </Field>
    );
  }
  if (mode === 'call') {
    return (
      <Field label="Recording" hint="Upload recordings under Messages & recordings.">
        <Select aria-label="Recording" value={value.recording_id || ''} onChange={(v) => onChange({ recording_id: v })} placeholder="Pick a recording"
          options={(recs.data?.recordings || []).map((r) => ({ value: r.id, label: r.name, hint: `${Math.round(r.duration_secs)}s · ${r.language.toUpperCase()}` }))} />
      </Field>
    );
  }
  return null;
}

function ModeModal({ cb, onClose, onSave }) {
  const [mode, setMode] = useState(cb.mode);
  const [pick, setPick] = useState({ agent_id: cb.agent_id || '', recording_id: cb.recording_id || '' });
  return (
    <Modal open onClose={onClose} title="Who calls back"
      footer={<div className="flex justify-end gap-2 w-full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn-primary" onClick={() => onSave({ mode, ...(mode === 'agent' ? { agent_id: pick.agent_id || null } : {}), ...(mode === 'call' ? { recording_id: pick.recording_id || null } : {}) })}>Save</button></div>}>
      <div className="space-y-4">
        <div className="flex gap-1.5 flex-wrap">{Object.entries(CALLBACK_MODE).map(([k, l]) => <Pill key={k} on={mode === k} onClick={() => setMode(k)}>{l}</Pill>)}</div>
        <ContentPickers mode={mode} value={pick} onChange={(p) => setPick((x) => ({ ...x, ...p }))} />
        {mode === 'human' && <p className="text-[14px]" style={{ color: 'var(--mute)' }}>It moves to “For your team”. Automated contact pauses for this member until it is closed.</p>}
      </div>
    </Modal>
  );
}

function BookModal({ onClose, onDone }) {
  const m = useApi('/followups/members');
  const [q, setQ] = useState('');
  const [b, setB] = useState({ client_id: '', date: tomorrow(), time: '11:00', mode: 'agent', agent_id: '', recording_id: '', reason: '' });
  const [err, setErr] = useState('');
  const set = (p) => setB((x) => ({ ...x, ...p }));
  const options = useMemo(() => (m.data?.members || []).filter((x) => x.reach.call && (!q || x.name.toLowerCase().includes(q.toLowerCase()))).slice(0, 200)
    .map((x) => ({ value: x.id, label: x.name, hint: x.branch || '' })), [m.data, q]);
  const save = async () => {
    setErr('');
    try {
      await api('/followups/callbacks', { method: 'POST', body: JSON.stringify({ ...b, agent_id: b.mode === 'agent' ? b.agent_id || null : null, recording_id: b.mode === 'call' ? b.recording_id || null : null, reason: b.reason || undefined }) });
      onDone();
    } catch (e) { setErr(e.message); }
  };
  return (
    <Modal open onClose={onClose} title="Book a call back"
      footer={<div className="flex justify-end gap-2 w-full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn-primary" disabled={!b.client_id} onClick={save}>Book</button></div>}>
      <div className="space-y-4">
        <Field label="Member" hint="Only members who allow calls are listed.">
          <input className="input w-full mb-2" type="search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search members" />
          <Select aria-label="Member" value={b.client_id} onChange={(v) => set({ client_id: v })} placeholder="Pick a member" options={options} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Day"><input type="date" className="input w-full" value={b.date} min={new Date().toISOString().slice(0, 10)} onChange={(e) => set({ date: e.target.value })} /></Field>
          <Field label="Time"><input type="time" className="input w-full" value={b.time} onChange={(e) => set({ time: e.target.value })} /></Field>
        </div>
        <Field label="Who calls">
          <div className="flex gap-1.5 flex-wrap">{[['agent', CALLBACK_MODE.agent], ['call', CALLBACK_MODE.call]].map(([k, l]) => <Pill key={k} on={b.mode === k} onClick={() => set({ mode: k })}>{l}</Pill>)}</div>
        </Field>
        <ContentPickers mode={b.mode} value={b} onChange={set} />
        <Field label="Why (optional)"><input className="input w-full" maxLength={300} value={b.reason} onChange={(e) => set({ reason: e.target.value })} placeholder="e.g. Asked about the quarterly plan at the desk" /></Field>
        {err && <div role="alert" className="text-[14px] font-semibold" style={{ color: 'var(--bad)' }}>{err}</div>}
      </div>
    </Modal>
  );
}

/* ───────────── a person calls (the original queue) ───────────── */

function StaffList({ data, reload, say }) {
  const [show, setShow] = useState('open');
  const extra = useApi(show === 'open' ? null : `/followups/callbacks?status=${show}`);
  const source = show === 'open' ? data : extra.data;
  const update = async (cb, body) => {
    try { await api(`/followups/callbacks/${cb.id}`, { method: 'PUT', body: JSON.stringify(body) }); reload(); extra.reload?.(); say('Updated'); } catch (e) { say(e.message, 'error'); }
  };
  const list = source?.callbacks || [];
  return (
    <div className="space-y-3">
      <p className="text-[14px]" style={{ color: 'var(--mute)' }}>Members who asked to talk to a person. Automated calls and messages pause for them until you close their call back.</p>
      <div className="flex gap-1.5">{[['open', 'Open'], ['completed', 'Done'], ['unreachable', 'Could not reach']].map(([k, l]) => <Pill key={k} on={show === k} onClick={() => setShow(k)}>{l}</Pill>)}</div>
      {show !== 'open' && extra.loading ? <PageSkeleton label="Loading" /> : list.length === 0 ? <Card className="p-5 text-[15px]" style={{ color: 'var(--mute)' }}>{show === 'open' ? 'Nobody is waiting for a call back.' : 'Nothing here.'}</Card> : (
        list.map((cb) => (
          <Card key={cb.id} className="p-4 space-y-3">
            <div className="flex items-start gap-3 flex-wrap">
              <div className="flex-1 min-w-[180px]">
                <div className="font-semibold" style={{ color: 'var(--ink)' }}>{cb.member_name}</div>
                <div className="text-[13px]" style={{ color: 'var(--mute)' }}>{when(cb.created_at)} · {CHANNEL[cb.channel]?.label || cb.channel}{cb.campaign ? ` · ${cb.campaign}` : ''}</div>
              </div>
              <Status status={cb.status} />
              {cb.phone && <a className="btn btn-sm" href={`tel:${cb.phone}`}><Icon name="phone" size={14} /> Call</a>}
            </div>
            {(cb.conversation_summary || cb.reason) && <p className="text-[14px]" style={{ color: 'var(--ink)' }}>{cb.conversation_summary || cb.reason}</p>}
            {show === 'open' && (
              <div className="flex items-center gap-2 flex-wrap">
                <div className="w-52"><Select aria-label="Assign to" value={cb.assigned_to || ''} onChange={(v) => update(cb, { assigned_to: v || null })} placeholder="Assign to" options={(data.staff || []).map((s) => ({ value: s.id, label: s.name }))} /></div>
                <button type="button" className="btn btn-sm" onClick={() => update(cb, { status: 'completed', note: window.prompt('What happened? (optional)') || undefined })}>Done</button>
                <button type="button" className="btn btn-sm" onClick={() => update(cb, { status: 'unreachable' })}>Could not reach</button>
              </div>
            )}
            {cb.note && <p className="text-[13px]" style={{ color: 'var(--mute)' }}>Note: {cb.note}</p>}
          </Card>
        ))
      )}
    </div>
  );
}
