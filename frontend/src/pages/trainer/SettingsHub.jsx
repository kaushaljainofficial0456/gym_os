/**
 * SETTINGS -- every setting an owner has, in one place, laid out like the
 * Settings app: the gym at the top, then short groups of rows, each with a
 * line saying what is inside and where it stands ("Not set up",
 * "80 clients · renews 6 Nov 2027").
 *
 * Before this, settings were spread over Setup & billing (the Barbell
 * plan, payouts, join codes, the gym's app, gym settings), a Branding page
 * and the Payments page's payout banner. Nothing was removed: each row
 * opens the screen that holds it, and every one of those screens leads
 * back here.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronRight, Copy } from 'lucide-react';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useFetch } from '../../utils.js';
import { useBrand } from '../../brand/BrandProvider.jsx';
import GymMark from '../../brand/GymMark.jsx';
import Icon from '../../components/Icon.jsx';
import { Avatar } from '../../components/UI.jsx';
import ThemeSwitch from '../../components/trainer/ThemeSwitch.jsx';
import { TINT, tileStyle } from '../../components/trainer/workspaceNav.js';

const date = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

function Row({ to, icon, tint, title, sub, value, tone }) {
  return (
    <Link to={to} className="ws-row">
      <span className="ws-tile ws-row-icon" style={{ ...tileStyle(tint), '--s': '36px' }}><Icon name={icon} size={18} strokeWidth={1.8} /></span>
      <span className="ws-row-main">
        <span className="ws-row-title">{title}</span>
        {sub && <span className="ws-row-sub">{sub}</span>}
      </span>
      {value && <span className={`ws-row-value${tone ? ` is-${tone}` : ''}`}>{value}</span>}
      <ChevronRight className="ws-row-chev" size={18} strokeWidth={2} aria-hidden="true" />
    </Link>
  );
}

function Group({ title, children }) {
  return (
    <section className="ws-group-wrap">
      {title && <h2 className="ws-group-title">{title}</h2>}
      <div className="ws-group">{children}</div>
    </section>
  );
}

export default function SettingsHub() {
  const { user, logout } = useAuth();
  const { brand } = useBrand();
  const status = useFetch(() => api('/enterprise/status').catch(() => null));
  const payout = useFetch(() => api('/enterprise/payment-account').catch(() => null));
  const [copied, setCopied] = useState(false);
  const code = brand?.code || user?.orgSlug || user?.org_slug;

  const plan = status.data;
  const planValue = plan?.billingStatus === 'ACTIVE'
    ? `${plan.purchasedCapacity} clients${plan.subscription?.end_date ? ` · renews ${date(plan.subscription.end_date)}` : ''}`
    : plan ? 'Not active' : '';
  const account = payout.data?.account;
  const paid = account?.connected ? ['On', 'good'] : account ? ['Not set up', 'warn'] : ['', null];

  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* clipboard blocked */ }
  };

  return (
    <div className="ws-settings">
      <h1 className="t-title">Settings</h1>

      {/* The gym, as its members see it. */}
      <div className="ws-profile">
        {brand ? <GymMark brand={brand} size={64} /> : <span className="ws-tile" style={{ '--s': '64px' }}><Icon name="home" size={26} /></span>}
        <div className="min-w-0 flex-1">
          <div className="ws-profile-name">{brand?.gymName || user?.orgName || 'Your gym'}</div>
          <div className="ws-profile-sub">
            <i aria-hidden="true">×</i> Barbell{brand?.primary && (
              <span className="ws-swatches" aria-label={`Colours ${brand.primary} and ${brand.secondary}`}>
                <i style={{ background: brand.primary }} /><i style={{ background: brand.secondary }} />
              </span>
            )}
          </div>
        </div>
        {code && (
          <button type="button" className="ws-code" onClick={copy} aria-label={`Gym code ${code}. Copy`}>
            <span className="ws-code-label">Gym code</span>
            <span className="ws-code-value">{code}</span>
            {copied ? <Check size={15} strokeWidth={2.4} aria-hidden="true" /> : <Copy size={15} strokeWidth={2} aria-hidden="true" />}
          </button>
        )}
      </div>

      <Group title="Your gym">
        <Row to="/app/trainer/settings/gym" icon="home" tint={TINT.blue} title="Gym & member app"
          sub="Name, capacity, what members may change, community" />
        <Row to="/app/trainer/enterprise/brand" icon="palette" tint={TINT.pink} title="Branding"
          sub={brand?.primary ? 'Your colours and logo, on every screen' : 'Give the app your gym’s colours and logo'}
          value={brand?.primary ? '' : 'Barbell look'} />
        <Row to="/app/trainer/enterprise/qr" icon="qr" tint={TINT.graphite} title="Join QR codes"
          sub="New members and trainers scan one to join" />
      </Group>

      <Group title="Money">
        <Row to="/app/trainer/settings/payouts" icon="receipt" tint={TINT.green} title="Getting paid"
          sub="Members pay online, straight to your bank" value={paid[0]} tone={paid[1]} />
        <Row to="/app/trainer/enterprise" icon="card" tint={TINT.orange} title="Plan & billing"
          sub="Your Barbell plan, capacity and receipts" value={planValue} />
      </Group>

      <Group title="You">
        <div className="ws-row ws-row--static">
          <Avatar name={user?.name} size={36} />
          <span className="ws-row-main">
            <span className="ws-row-title">{user?.name}</span>
            <span className="ws-row-sub">{user?.email}</span>
          </span>
        </div>
        <div className="ws-row ws-row--static">
          <span className="ws-tile ws-row-icon" style={{ ...tileStyle(TINT.accent), '--s': '36px' }}><Icon name="bulb" size={18} strokeWidth={1.8} /></span>
          <span className="ws-row-main"><span className="ws-row-title">Appearance</span></span>
          <ThemeSwitch compact />
        </div>
        <button type="button" className="ws-row ws-row--danger" onClick={logout}>Sign out</button>
      </Group>
    </div>
  );
}
