/**
 * PLANS & USAGE -- buy what you need, see what you used.
 *
 * Each product is bought separately, from its own shelf: AI voice calls,
 * AI conversations, SMS, WhatsApp and the gym's own numbers. Prices show
 * the total with tax. Payment goes through the app's existing checkout
 * and capacity is added only after the payment is verified on the server.
 */
import { useState } from 'react';
import { api } from '../../../api.js';
import { Card, ErrorState, Modal, PageSkeleton, Seg, Toast } from '../../UI.jsx';
import PaymentCheckout from '../../PaymentCheckout.jsx';
import { CHANNEL, PRODUCT_HUE, SectionHead, Stepper, Tag, Tile, inr, num, when, useApi } from './shared.jsx';

const SHELVES = [
  { plan: 'voice', title: 'AI voice calls', icon: 'phone', hue: 'training', blurb: 'An AI voice reads your message to the member, who answers with the keypad. Billed per connected minute; unanswered calls cost nothing. Each quality has its own balance.' },
  { plan: 'agent', title: 'AI conversations', icon: 'robot', hue: 'nutrition', blurb: 'A two-way AI agent talks with the member, answers questions from your facts, and books call backs. Billed per connected minute. Each quality has its own balance.' },
  { plan: 'sms', title: 'SMS', icon: 'chat', hue: 'strength', blurb: 'Text messages on a registered sender. Billed per SMS part; long or Indian-script messages use more parts.' },
  { plan: 'whatsapp', title: 'WhatsApp', icon: 'chat', hue: 'body', blurb: 'Approved WhatsApp templates with reply buttons. Billed per message sent; failed ones are given back.' },
  { plan: 'lines', title: 'Your own numbers', icon: 'phone', hue: 'recovery', blurb: 'Call from numbers registered to your gym, so members recognise you. Without one, calls use Barbell’s shared business line.' },
];

export default function Billing() {
  const [view, setView] = useState('buy');
  return (
    <div className="space-y-5">
      <div className="max-w-md"><Seg value={view} onChange={setView} options={[{ value: 'buy', label: 'Buy' }, { value: 'usage', label: 'Usage' }, { value: 'numbers', label: 'Numbers' }]} /></div>
      {view === 'buy' && <Buy />}
      {view === 'usage' && <Usage />}
      {view === 'numbers' && <Numbers />}
    </div>
  );
}

function Buy() {
  const cat = useApi('/followups/catalogue');
  const [shelf, setShelf] = useState('voice');
  const [qty, setQty] = useState(1);
  const [order, setOrder] = useState(null);
  const [toast, setToast] = useState({ msg: '' });
  const [busy, setBusy] = useState('');
  if (cat.loading) return <PageSkeleton label="Loading plans" />;
  if (cat.error) return <ErrorState error={cat.error} onRetry={cat.reload} />;
  const s = SHELVES.find((x) => x.plan === shelf);
  const packs = cat.data.packs.filter((p) => p.plan === shelf);

  const buy = async (p) => {
    setBusy(p.id);
    try { setOrder((await api('/followups/orders', { method: 'POST', body: JSON.stringify({ packId: p.id, quantity: p.plan === 'lines' ? qty : 1 }) })).order); } catch (e) { setToast({ msg: e.message, tone: 'error' }); } finally { setBusy(''); }
  };
  const paid = async (providerPaymentId, signature) => {
    try {
      await api(`/followups/orders/${order.id}/verify`, { method: 'POST', body: JSON.stringify({ providerPaymentId, signature }) });
      setOrder(null); cat.reload(); setToast({ msg: 'Payment received. Added to your balance.' });
    } catch (e) { setOrder(null); setToast({ msg: e.message, tone: 'error' }); }
  };
  const cancel = async () => { if (order) await api(`/followups/orders/${order.id}/cancel`, { method: 'POST' }).catch(() => {}); setOrder(null); };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
        {SHELVES.map((x) => (
          <button key={x.plan} type="button" onClick={() => { setShelf(x.plan); setQty(1); }} aria-pressed={shelf === x.plan}
            className="flex items-center gap-2.5 p-3 rounded-2xl text-left" style={{ border: `1.5px solid ${shelf === x.plan ? 'var(--ink)' : 'var(--line)'}`, background: 'var(--panel)' }}>
            <Tile icon={x.icon} tone={x.hue} size={32} />
            <span className="text-[14px] font-semibold leading-tight" style={{ color: 'var(--ink)' }}>{x.title}</span>
          </button>
        ))}
      </div>
      <p className="text-[14px]" style={{ color: 'var(--mute)' }}>{s.blurb}</p>
      {shelf === 'lines' && (
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>How many numbers?</span>
          <Stepper value={qty} min={1} max={Math.max(1, ...packs.map((p) => p.max_quantity || 1))} onChange={setQty} label="numbers" />
          {cat.data.lines?.lines > 0 && <Tag tone="good">{cat.data.lines.lines} active until {new Date(cat.data.lines.until).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</Tag>}
        </div>
      )}
      {groupByTier(packs).map(([tierName, tagline, available, group]) => (
      <div key={tierName || 'all'} className="space-y-2">
        {tierName && (
          <div className="flex items-baseline gap-2 flex-wrap pt-1">
            <h3 className="text-[16px] font-semibold" style={{ color: 'var(--ink)' }}>{tierName}</h3>
            <span className="text-[14px]" style={{ color: 'var(--mute)' }}>{tagline}</span>
            {!available && <Tag>Coming soon</Tag>}
          </div>
        )}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {group.map((p) => {
          const q = p.plan === 'lines' ? qty : 1;
          const unitLines = p.units ? Object.entries(p.units).map(([u, n]) => `${num(n)} ${productLabel(cat.data.products, u)}`) : [`${p.lines * q} number${p.lines * q > 1 ? 's' : ''} for ${p.days} days`];
          return (
            <Card key={p.id} className="p-5 flex flex-col gap-3">
              <div className="font-semibold text-[17px]" style={{ color: 'var(--ink)' }}>{p.name}</div>
              <div className="text-[30px] font-bold tabular-nums" style={{ color: 'var(--ink)' }}>{inr(p.total * q)}</div>
              <div className="text-[13px] -mt-2" style={{ color: 'var(--mute)' }}>{p.tax_inclusive ? `includes ${inr(p.tax * q)} ${p.tax_label}` : `+ ${inr(p.tax * q)} ${p.tax_label}`}</div>
              <ul className="text-[14px] space-y-1 flex-1" style={{ color: 'var(--ink)' }}>
                {unitLines.map((l) => <li key={l}>• {l}</li>)}
                {p.units && <li style={{ color: 'var(--mute)' }}>• No expiry</li>}
              </ul>
              <button type="button" className="btn-primary w-full" disabled={!!busy || !p.available} onClick={() => buy(p)}>{!p.available ? 'Coming soon' : busy === p.id ? 'Starting…' : `Buy for ${inr(p.total * q)}`}</button>
            </Card>
          );
        })}
      </div>
      </div>
      ))}
      <BalanceStrip wallet={cat.data.wallet} products={cat.data.products} />
      <Modal open={!!order} onClose={cancel} title="Pay">
        {order && <PaymentCheckout order={order} onComplete={paid} onCancel={cancel} />}
      </Modal>
      {toast.msg && <Toast message={toast.msg} tone={toast.tone} onDone={() => setToast({ msg: '' })} />}
    </div>
  );
}

/** Packs grouped by quality tier: [tierName, tagline, available, packs]. */
function groupByTier(packs) {
  const m = new Map();
  for (const p of packs) {
    const k = p.tier_name || '';
    if (!m.has(k)) m.set(k, [p.tier_name, p.tagline, p.available, []]);
    m.get(k)[3].push(p);
  }
  return [...m.values()];
}

const productLabel = (products, key) => {
  const p = (products || []).find((x) => x.key === key);
  if (!p) return key;
  return p.product === 'voice' || p.product === 'agent' ? `${p.name.toLowerCase().replace(/s$/, '')} minutes` : p.name.toLowerCase();
};

function BalanceStrip({ wallet, products }) {
  return (
    <Card className="p-4 flex flex-wrap gap-x-8 gap-y-2">
      {(products || []).filter((p) => p.available || (wallet?.[p.key] || 0) > 0).map((p) => (
        <div key={p.key}><div className="text-[13px]" style={{ color: 'var(--mute)' }}>{p.name}</div><div className="font-bold tabular-nums" style={{ color: 'var(--ink)' }}>{num(wallet?.[p.key])} {p.short} left</div></div>
      ))}
    </Card>
  );
}

const colourOf = (key) => `var(--m-${PRODUCT_HUE[String(key).split(':')[0]] || 'training'})`;

function Usage() {
  const u = useApi('/followups/usage?days=30');
  const orders = useApi('/followups/orders');
  if (u.loading) return <PageSkeleton label="Loading usage" />;
  if (u.error) return <ErrorState error={u.error} onRetry={u.reload} />;
  const d = u.data;
  const days = [];
  for (let i = 29; i >= 0; i--) days.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
  const byDay = new Map(days.map((k) => [k, {}]));
  for (const r of d.daily) if (byDay.has(r.day)) byDay.get(r.day)[r.unit] = Number(r.spent) || 0;
  const max = Math.max(1, ...[...byDay.values()].map((o) => Object.values(o).reduce((a, b) => a + b, 0)));
  const spent = Object.values(d.totals).reduce((s, x) => s + x.spent, 0);

  return (
    <div className="space-y-6">
      <section>
        <SectionHead title="Last 30 days" action={<span className="text-[15px] font-bold" style={{ color: 'var(--ink)' }}>{inr(spent)} used</span>} />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
          {(d.products || []).filter((p) => p.available || (d.wallet[p.key] || 0) > 0 || d.totals[p.key]?.used).map((p) => (
            <Card key={p.key} className="p-4">
              <div className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: colourOf(p.key) }} /><span className="text-[13px] leading-tight" style={{ color: 'var(--mute)' }}>{p.name}</span></div>
              <div className="text-[22px] font-bold tabular-nums mt-1" style={{ color: 'var(--ink)' }}>{num(d.totals[p.key]?.used)}</div>
              <div className="text-[13px]" style={{ color: 'var(--mute)' }}>{p.short} · {inr(d.totals[p.key]?.spent)}</div>
              <div className="text-[13px] mt-1" style={{ color: 'var(--faint)' }}>{num(d.wallet[p.key])} left{d.holds[p.key] ? ` · ${num(d.holds[p.key])} on hold` : ''}</div>
            </Card>
          ))}
        </div>
        <Card className="p-4">
          <div className="cm-bars" role="img" aria-label="Spend per day for the last 30 days">
            {days.map((k) => {
              const o = byDay.get(k);
              return (
                <div key={k} className="cm-bar" title={`${k}: ${inr(Object.values(o).reduce((a, b) => a + b, 0))}`}>
                  {Object.keys(o).map((unit) => (o[unit] ? <span key={unit} style={{ height: `${(o[unit] / max) * 100}%`, background: colourOf(unit) }} /> : null))}
                </div>
              );
            })}
          </div>
          <div className="flex justify-between text-[12px] mt-2" style={{ color: 'var(--faint)' }}><span>30 days ago</span><span>Today</span></div>
        </Card>
      </section>

      {d.byCampaign.length > 0 && (
        <section>
          <SectionHead title="By campaign" />
          <Card>
            {d.byCampaign.map((r, i) => (
              <div key={i} className="cm-row">
                <span className="flex-1 font-semibold" style={{ color: 'var(--ink)' }}>{r.name || (r.rule_id ? 'Deleted campaign' : 'Tests')}</span>
                <span className="text-[14px]" style={{ color: 'var(--mute)' }}>{num(r.used)} · {(d.products || []).find((p) => p.key === r.unit)?.name || r.unit}</span>
                <span className="w-20 text-right font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>{inr(r.spent)}</span>
              </div>
            ))}
          </Card>
        </section>
      )}

      <section>
        <SectionHead title="Purchases" />
        {(orders.data?.orders || []).length === 0 ? <Card className="p-5 text-[15px]" style={{ color: 'var(--mute)' }}>No purchases yet.</Card> : (
          <Card>
            {orders.data.orders.map((o) => (
              <div key={o.id} className="cm-row">
                <div className="flex-1 min-w-0">
                  <div className="font-semibold" style={{ color: 'var(--ink)' }}>{SHELVES.find((s) => s.plan === o.pack.plan)?.title} · {o.pack.name}{o.quantity > 1 ? ` × ${o.quantity}` : ''}</div>
                  <div className="text-[13px]" style={{ color: 'var(--mute)' }}>{when(o.created_at)}{o.invoice_number ? ` · ${o.invoice_number}` : ''}</div>
                </div>
                <Tag tone={o.status === 'SUCCESS' ? 'good' : o.status === 'FAILED' ? 'bad' : 'warn'}>{o.status === 'SUCCESS' ? 'Paid' : o.status === 'FAILED' ? 'Failed' : 'Not paid'}</Tag>
                <span className="w-20 text-right font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>{inr(o.amount)}</span>
              </div>
            ))}
          </Card>
        )}
      </section>
    </div>
  );
}

function Numbers() {
  const n = useApi('/followups/numbers');
  const [toast, setToast] = useState({ msg: '' });
  if (n.loading) return <PageSkeleton label="Loading numbers" />;
  if (n.error) return <ErrorState error={n.error} onRetry={n.reload} />;
  const d = n.data;
  const update = async (x, body) => {
    try { await api(`/followups/numbers/${x.id}`, { method: 'PUT', body: JSON.stringify(body) }); n.reload(); setToast({ msg: 'Saved' }); } catch (e) { setToast({ msg: e.message, tone: 'error' }); }
  };
  return (
    <div className="space-y-4">
      <SectionHead title="Your numbers" />
      <p className="text-[14px] -mt-1" style={{ color: 'var(--mute)' }}>
        Each member is always called from the same number, so they can save it. Your numbers are never switched to get past a member who blocked or ignored a call: a member who asks to stop is not called from any of them.
      </p>
      <Card className="p-4 text-[14px]" style={{ color: 'var(--ink)' }}>
        {d.capacity.lines > 0
          ? <>You have <b>{d.capacity.lines}</b> number{d.capacity.lines > 1 ? 's' : ''} paid for until {new Date(d.capacity.until).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}. {d.numbers.filter((x) => x.status === 'active').length < d.capacity.lines ? 'Barbell is setting up the rest; they appear here once registered.' : ''}</>
          : <>No numbers of your own yet. Calls go out from Barbell’s shared business line{d.shared_line ? '' : ' (being set up)'}. Buy numbers under Buy → Your own numbers.</>}
      </Card>
      {d.numbers.length > 0 && (
        <Card>
          {d.numbers.map((x) => (
            <div key={x.id} className="cm-row flex-wrap">
              <Tile icon="phone" tone={x.in_use ? 'recovery' : 'training'} size={36} />
              <div className="flex-1 min-w-[160px]">
                <div className="font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>{x.number}{x.label ? ` · ${x.label}` : ''}</div>
                <div className="text-[13px]" style={{ color: 'var(--mute)' }}>{x.branch_name || 'All branches'} · {num(x.members)} members · {x.status === 'retired' ? 'Retired' : x.health === 'flagged' ? 'Paused for a check' : x.in_use ? 'In use' : 'Outside your paid numbers'}</div>
              </div>
              {x.is_primary ? <Tag tone="good">Primary</Tag> : x.status === 'active' && <button type="button" className="btn btn-sm" onClick={() => update(x, { is_primary: true })}>Make primary</button>}
            </div>
          ))}
        </Card>
      )}
      {toast.msg && <Toast message={toast.msg} tone={toast.tone} onDone={() => setToast({ msg: '' })} />}
    </div>
  );
}

export { CHANNEL };
