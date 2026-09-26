/**
 * ACCESS CONTROL — connecting the gym's doors to SK OS, and running them.
 *
 * The page is a shell; each tab is its own panel under
 * components/access/. What they share is a set of refusals, stated once
 * here because they are the design:
 *
 *   * No credential is ever shown after it is saved.
 *   * No vendor adapter is offered that does not exist.
 *   * No connection is called working because it saved.
 *   * No control is rendered that the connection cannot perform --
 *     capabilities come from the server, per connection.
 *   * Nothing biometric is stored or shown, and the screens say so.
 *
 * Owner-only in the router. The server checks its own permissions on
 * every call regardless; hiding a tab is a convenience, not the control.
 */
import { useState } from 'react';
import { PageHeader } from '../../components/UI.jsx';
import { useToast } from '../../components/access/shared.jsx';
import ConnectionsPanel from '../../components/access/ConnectionsPanel.jsx';
import DevicesPanel from '../../components/access/DevicesPanel.jsx';
import MembersPanel from '../../components/access/MembersPanel.jsx';
import { EventsPanel, SyncPanel, HealthPanel, SettingsPanel, AuditPanel } from '../../components/access/OpsPanels.jsx';

const TABS = [
  ['connections', 'Connections'],
  ['devices', 'Devices'],
  ['members', 'Members'],
  ['events', 'Events'],
  ['sync', 'Sync'],
  ['health', 'Health'],
  ['settings', 'Settings'],
  ['audit', 'Audit log'],
];

export default function AccessControl() {
  const [tab, setTab] = useState(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('tab');
    return TABS.some(([k]) => k === fromUrl) ? fromUrl : 'connections';
  });
  const [toast, showToast] = useToast();
  const [syncKey, setSyncKey] = useState(0);

  const choose = (k) => {
    setTab(k);
    // Keep the tab in the URL so a refresh or a shared link lands in place.
    const u = new URL(window.location.href);
    u.searchParams.set('tab', k);
    window.history.replaceState(null, '', u);
  };

  // A job started from a connection is followed in Sync.
  const onJob = () => setSyncKey((n) => n + 1);

  return (
    <div className="space-y-4">
      <PageHeader title="Access control" sub="Doors, devices, and who they let in" />
      <div className="flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="Access control sections">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => choose(k)}
                  className={`tab ${tab === k ? 'tab-active' : ''}`}>
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'connections' && <ConnectionsPanel onToast={showToast} onJob={onJob} />}
        {tab === 'devices' && <DevicesPanel onToast={showToast} canManage />}
        {tab === 'members' && <MembersPanel onToast={showToast} canManage />}
        {tab === 'events' && <EventsPanel />}
        {tab === 'sync' && <SyncPanel onToast={showToast} canManage refreshKey={syncKey} />}
        {tab === 'health' && <HealthPanel onToast={showToast} />}
        {tab === 'settings' && <SettingsPanel onToast={showToast} canEdit />}
        {tab === 'audit' && <AuditPanel />}
      </div>
      {toast}
    </div>
  );
}
