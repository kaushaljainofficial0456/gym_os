import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useFetch } from '../../utils.js';
import { Card, Kicker, ErrorState, Empty, PageSkeleton } from '../../components/UI.jsx';

const TYPES = [
  ['message', 'Message'], ['workout_update', 'Workout update'],
  ['nutrition_update', 'Nutrition update'], ['checkin_reminder', 'Check-in reminder']
];

export default function Messages() {
  const { user } = useAuth();
  const clients = useFetch(() => api('/clients?sort=name'));
  const [clientId, setClientId] = useState('');
  const [type, setType] = useState('message');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState('');
  const thread = useFetch(() => (clientId ? api(`/messages?client_id=${clientId}`) : Promise.resolve({ messages: [] })), [clientId]);
  const endRef = useRef(null);

  useEffect(() => {
    if (endRef.current) endRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [thread.data, clientId]);

  // Auto-dismiss, same pattern used everywhere else in the app -- without
  // it the toast (including the send-failure error a few lines below)
  // sits on screen for the rest of the session.
  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(''), 2600);
    return () => clearTimeout(h);
  }, [toast]);

  if (clients.loading) return <PageSkeleton variant="split" label="Loading messages" />;
  if (clients.error) return <ErrorState error={clients.error} onRetry={clients.reload} />;

  const send = async () => {
    if (!body.trim() || !clientId) return;
    setSending(true);
    try {
      await api('/messages', { method: 'POST', body: JSON.stringify({ client_id: clientId, type, body }) });
      setBody('');
      thread.reload({ silent: true });
    } catch (e) {
      /* Was `catch (e) { /* keep body *\/ }` -- a failed send (network
         error, a client no longer assigned to this trainer) left no
         trace: the input just sat there and the trainer was left to guess
         whether it sent. Never let a refused write look like a successful
         one, the same rule the attendance card follows. */
      setToast(e.message || 'Could not send — the message was not delivered.');
    }
    setSending(false);
  };

  const msgs = thread.data?.messages || [];

  /* Day separators. Every bubble showed a bare clock time, so a thread
     spanning three weeks read as though all of it happened today -- and
     "02:10 AM" against a message from last month is actively
     misleading. The separator is inserted where the DAY changes, which
     is the only place the reader needs telling. */
  const dayOf = (iso) => String(iso || '').slice(0, 10);
  const dayLabel = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const today = new Date();
    const key = dayOf(iso);
    const todayKey = today.toISOString().slice(0, 10);
    const yest = new Date(today.getTime() - 86400000).toISOString().slice(0, 10);
    if (key === todayKey) return 'Today';
    if (key === yest) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const clientName = (clients.data?.clients || []).find((c) => c.id === clientId)?.name;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-grotesk font-bold text-2xl">Messages</h1>
          <p className="text-mute text-sm">Direct line to each client. WhatsApp Business delivery is a planned integration.</p>
        </div>
        <select className="input max-w-xs" value={clientId} onChange={(e) => setClientId(e.target.value)}>
          <option value="">Choose client…</option>
          {(clients.data?.clients || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      <Card>
        <Kicker>{clientName ? `Thread · ${clientName}` : 'Thread'}</Kicker>
        <div className="h-[46vh] overflow-y-auto space-y-2.5 pr-1">
          {msgs.map((m, i) => {
            const mine = m.from_user === user?.id || m.from_name === user?.name;
            const newDay = i === 0 || dayOf(m.created_at) !== dayOf(msgs[i - 1].created_at);
            return (
              <div key={m.id}>
                {newDay && (
                  <div className="flex items-center gap-2 my-3" aria-hidden="true">
                    <span className="flex-1" style={{ borderTop: '1px solid var(--line)' }} />
                    <span className="text-[10px] font-semibold" style={{ color: 'var(--faint)' }}>
                      {dayLabel(m.created_at)}
                    </span>
                    <span className="flex-1" style={{ borderTop: '1px solid var(--line)' }} />
                  </div>
                )}
              <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[75%] rounded-2xl px-3.5 py-2.5 text-sm ${mine ? 'rounded-br-md' : 'rounded-bl-md'} ${mine ? 'bg-gradient-to-br from-ember/25 to-gold/15 border border-gold/30' : 'bg-tint/[.05] border border-line'}`}>
                  {!mine && <div className="text-[10px] text-mute font-grotesk mb-1">{m.from_name}{m.type !== 'message' ? ` · ${m.type.replace(/_/g, ' ')}` : ''}</div>}
                  <div className="leading-relaxed">{m.body}</div>
                  <div className="text-[9px] text-faint mt-1 font-grotesk">{new Date(m.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</div>
                </div>
              </div>
              </div>
            );
          })}
          {/* Two different empty situations. Telling someone to "send the
              first message" when they have not picked a client yet points
              at a disabled field. */}
          {!msgs.length && (clientId
            ? <Empty title="No messages yet" hint={`Send the first message to ${clientName}.`} />
            : <Empty title="Pick a client" hint="Choose a client above to open their thread." />)}
          <div ref={endRef} />
        </div>

        <div className="mt-3 pt-3 border-t border-line space-y-2">
          <div className="flex gap-1.5 overflow-x-auto">
            {TYPES.map(([v, l]) => (
              <button key={v} className={`tab !px-3 !py-1.5 !text-[11px] ${type === v ? 'active' : ''}`} onClick={() => setType(v)}>{l}</button>
            ))}
          </div>
          <div className="flex gap-2">
            <input className="input flex-1" placeholder={clientId ? `Message ${clientName}…` : 'Pick a client first'} disabled={!clientId}
              value={body} onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') send(); }} />
            <button className="btn-primary shrink-0" onClick={send} disabled={sending || !clientId || !body.trim()}>{sending ? '…' : 'Send'}</button>
          </div>
        </div>
      </Card>
      {toast && <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-full bg-panel border border-gold/40 font-grotesk text-xs shadow-card">{toast}</div>}
    </div>
  );
}
