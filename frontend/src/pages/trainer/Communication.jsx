/**
 * AI COMMUNICATION -- automated follow-ups by AI voice call, AI
 * conversation, SMS and WhatsApp, bought separately from the gym's
 * capacity. One tab with sections; ?tab= opens a section directly.
 *
 * Every section is its own lazily loaded file under
 * components/trainer/comms/, so the overview is quick to open.
 */
import { lazy, Suspense, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQueryAction } from '../../components/trainer/useQueryAction.js';
import { Spinner } from '../../components/UI.jsx';
import { Pill } from '../../components/trainer/comms/shared.jsx';
import Overview from '../../components/trainer/comms/Overview.jsx';

const Campaigns = lazy(() => import('../../components/trainer/comms/Campaigns.jsx'));
const Studio = lazy(() => import('../../components/trainer/comms/Studio.jsx'));
const VoicesAgents = lazy(() => import('../../components/trainer/comms/VoicesAgents.jsx'));
const People = lazy(() => import('../../components/trainer/comms/People.jsx'));
const Callbacks = lazy(() => import('../../components/trainer/comms/Callbacks.jsx'));
const Conversations = lazy(() => import('../../components/trainer/comms/Conversations.jsx'));
const Activity = lazy(() => import('../../components/trainer/comms/Activity.jsx'));
const Billing = lazy(() => import('../../components/trainer/comms/Billing.jsx'));
const Settings = lazy(() => import('../../components/trainer/comms/Settings.jsx'));

const TABS = [
  ['overview', 'Overview'], ['campaigns', 'Campaigns'], ['messages', 'Messages & recordings'], ['voices', 'Voices & AI agents'],
  ['conversations', 'Conversations'], ['callbacks', 'Call backs'], ['members', 'Members'], ['history', 'History'], ['plans', 'Plans & usage'], ['settings', 'Settings'],
];

export default function Communication() {
  const [tab, setTab] = useState('overview');
  const nav = useNavigate();
  const loc = useLocation();
  useQueryAction('tab', (v) => { if (TABS.some(([k]) => k === v)) setTab(v); });
  const go = (t) => { setTab(t); nav(`${loc.pathname}?tab=${t}`, { replace: true }); window.scrollTo({ top: 0 }); };

  const Body = { overview: Overview, campaigns: Campaigns, messages: Studio, voices: VoicesAgents, conversations: Conversations, callbacks: Callbacks, members: People, history: Activity, plans: Billing, settings: Settings }[tab];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="t-title">AI Communication</h1>
        <p className="text-[15px] mt-1" style={{ color: 'var(--mute)' }}>Follow up with members by AI call, SMS and WhatsApp, automatically.</p>
      </div>
      <nav aria-label="AI Communication sections" className="flex items-center gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1 pr-6"
        style={{ maskImage: 'linear-gradient(to right, #000 calc(100% - 28px), transparent)', WebkitMaskImage: 'linear-gradient(to right, #000 calc(100% - 28px), transparent)' }}>
        {TABS.map(([k, label]) => <Pill key={k} on={tab === k} onClick={() => go(k)} aria-current={tab === k ? 'page' : undefined}>{label}</Pill>)}
      </nav>
      <Suspense fallback={<Spinner label="Loading" />}>
        <Body go={go} view={tab} />
      </Suspense>
    </div>
  );
}
