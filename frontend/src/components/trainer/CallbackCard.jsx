/**
 * CALL BACKS FOR A TRAINER -- members assigned to this trainer who asked,
 * on an AI follow-up call or WhatsApp, to talk to a person. Shown on the
 * trainer's Home only when there are some. Trainers see their own
 * assignments only, and can mark them done; they never see billing.
 */
import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Card } from '../UI.jsx';
import Icon from '../Icon.jsx';

export default function CallbackCard() {
  const [list, setList] = useState([]);
  const load = () => api('/followups/trainer/callbacks').then((r) => setList(r.callbacks || [])).catch(() => setList([]));
  useEffect(() => { load(); }, []);
  if (!list.length) return null;
  const close = async (cb, status) => { await api(`/followups/trainer/callbacks/${cb.id}`, { method: 'PUT', body: JSON.stringify({ status }) }).catch(() => {}); load(); };
  return (
    <section>
      <div className="ws-section-head"><h2 className="ws-section-title">Asked for a call back</h2></div>
      <Card>
        {list.map((cb) => (
          <div key={cb.id} className="flex items-center gap-3 p-4 flex-wrap" style={{ borderTop: '1px solid var(--line)' }}>
            <div className="flex-1 min-w-[160px]">
              <div className="font-semibold" style={{ color: 'var(--ink)' }}>{cb.member_name}</div>
              <div className="text-[13px]" style={{ color: 'var(--mute)' }}>{cb.reason}</div>
            </div>
            {cb.phone && <a className="btn btn-sm" href={`tel:${cb.phone}`}><Icon name="phone" size={14} /> Call</a>}
            <button type="button" className="btn btn-sm" onClick={() => close(cb, 'completed')}>Done</button>
            <button type="button" className="btn btn-sm" onClick={() => close(cb, 'unreachable')}>Could not reach</button>
          </div>
        ))}
      </Card>
    </section>
  );
}
