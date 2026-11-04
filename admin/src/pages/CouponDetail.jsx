// ============================================================
// ONE COUPON -- performance, configuration and redemption history.
// Redemptions listed here are VERIFIED payments only by default; holds
// for unpaid checkouts, failures and abandoned carts are a separate,
// clearly-labelled view and never counted as redemptions.
// ============================================================
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, downloadCsv } from '../api.js';
import { useFetch, moneyExact, formatInTz } from '../utils.js';
import { useToast } from '../components/Toast.jsx';
import StatCard from '../components/StatCard.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { SkeletonBlock, SkeletonCards, SkeletonRows } from '../components/Skeleton.jsx';
import { CouponStatusBadge, CUSTOMER_LABEL, discountLabel } from './Coupons.jsx';

const PAGE = 25;
const HOLD_TONE = { REDEEMED: 'good', RESERVED: 'warn', RELEASED: 'mute', EXPIRED: 'mute' };
const HOLD_LABEL = { REDEEMED: 'Redeemed', RESERVED: 'Checkout in progress', RELEASED: 'Payment failed', EXPIRED: 'Abandoned' };
const KIND_LABEL = { ORG_PACKAGE: 'Package', ORG_CAPACITY_ADDON: 'Capacity add-on' };

function Redemptions({ coupon }) {
  const toast = useToast();
  const [status, setStatus] = useState('REDEEMED');
  const [offset, setOffset] = useState(0);
  const [exporting, setExporting] = useState(false);
  const { data, loading, error } = useFetch(
    () => api(`/console/coupons/${coupon.id}/redemptions?status=${status}&limit=${PAGE}&offset=${offset}`), [coupon.id, status, offset]);

  const exportCsv = async () => {
    setExporting(true);
    try {
      await downloadCsv(`/console/coupons/${coupon.id}/redemptions/export?status=${status}`, `coupon-${coupon.code}-redemptions.csv`);
      toast.success('Redemption history downloaded');
    } catch (e) { toast.error(e.message || 'Export failed'); }
    finally { setExporting(false); }
  };

  return (
    <div className="card">
      <div className="page-header-row" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0 }}>Redemption history</h2>
        <div className="actions">
          <select className="input" aria-label="Show" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }} style={{ width: 'auto' }}>
            <option value="REDEEMED">Verified redemptions</option>
            <option value="RESERVED">Checkouts in progress</option>
            <option value="RELEASED">Failed payments</option>
            <option value="EXPIRED">Abandoned checkouts</option>
            <option value="ALL">Everything</option>
          </select>
          <button className="btn ghost" onClick={exportCsv} disabled={exporting}>{exporting ? 'Preparing CSV…' : 'Export CSV'}</button>
        </div>
      </div>
      {loading && <SkeletonRows rows={4} cols={7} />}
      {error && <div className="error-text">{error.message}</div>}
      {data && !data.redemptions.length && (
        <EmptyState icon="coupon" title={status === 'REDEEMED' ? 'No redemptions yet' : 'Nothing here'}
          description={status === 'REDEEMED' ? 'A redemption appears here once a gym has paid with this coupon and the payment is verified.' : 'No checkouts in this state.'} />
      )}
      {data && data.redemptions.length > 0 && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Date</th><th>Gym</th><th>Customer</th><th>Purchase</th><th className="num">Original</th>
                  <th className="num">Discount</th><th className="num">Paid</th><th>Payment reference</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.redemptions.map((r) => (
                  <tr key={r.id}>
                    <td className="faint">{formatInTz(r.redeemed_at || r.created_at, coupon.timezone)}</td>
                    <td><Link to={`/gyms/${r.org_id}`}>{r.org_name}</Link></td>
                    <td className="faint">{CUSTOMER_LABEL[r.customer_type]}</td>
                    <td className="faint">
                      {KIND_LABEL[r.subject_type] || '—'}
                      {r.subject_id && <div className="faint" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{r.subject_id}</div>}
                    </td>
                    <td className="num">{moneyExact(r.original_amount)}</td>
                    <td className="num">−{moneyExact(r.discount_amount)}</td>
                    <td className="num">{moneyExact(r.final_amount)}</td>
                    <td className="faint" style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
                      {r.provider_payment_id || r.payment_order_id || '—'}
                      {r.invoice_number && <div>{r.invoice_number}</div>}
                    </td>
                    <td>
                      <span className={`badge ${HOLD_TONE[r.status] || 'mute'}`}>{HOLD_LABEL[r.status] || r.status}</span>
                      {r.late_confirmation && <div className="faint" style={{ marginTop: 3 }}>Paid after the hold ended</div>}
                      {['REFUNDED', 'PARTIALLY_REFUNDED'].includes(r.order_status) && <div className="faint" style={{ marginTop: 3 }}>{r.order_status.replace('_', ' ').toLowerCase()}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <span>Showing {offset + 1}–{Math.min(offset + PAGE, data.total)} of {data.total}</span>
            <div className="pager-btns">
              <button className="btn ghost sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
              <button className="btn ghost sm" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Next</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function CouponDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { data, loading, error, reload } = useFetch(() => api(`/console/coupons/${id}`), [id]);
  const [confirm, setConfirm] = useState(null); // 'disable' | 'delete'
  const [busy, setBusy] = useState(false);

  const act = async (kind) => {
    setBusy(true);
    try {
      if (kind === 'delete') {
        await api(`/console/coupons/${id}`, { method: 'DELETE' });
        toast.success(`${data.coupon.code} deleted`);
        nav('/coupons');
        return;
      }
      await api(`/console/coupons/${id}/${kind}`, { method: 'POST', body: JSON.stringify({}) });
      toast.success(kind === 'disable' ? `${data.coupon.code} disabled` : `${data.coupon.code} re-enabled`);
      setConfirm(null);
      reload({ silent: true });
    } catch (e) {
      toast.error(e.message || 'Something went wrong');
    } finally { setBusy(false); }
  };

  if (loading) return <div><SkeletonBlock height={90} /><div style={{ height: 14 }} /><SkeletonCards count={8} /><SkeletonBlock height={240} /></div>;
  if (error) return <div className="error-text">{error.message}</div>;
  const c = data.coupon;
  const a = data.analytics;

  return (
    <div>
      <div className="page-header page-header-row">
        <div>
          <p style={{ marginBottom: 8 }}><Link to="/coupons">← Coupon Management</Link></p>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="code-chip" style={{ fontSize: 20 }}>{c.code}</span>
            <CouponStatusBadge status={c.status} />
          </h1>
          <p>{c.internal_name}{c.description ? ` — “${c.description}”` : ''}</p>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={() => nav(`/coupons/${c.id}/edit`)}>Edit</button>
          <button className="btn ghost" onClick={() => nav(`/coupons/new?from=${c.id}`)}>Duplicate</button>
          {c.is_enabled
            ? <button className="btn ghost" onClick={() => setConfirm('disable')}>Disable</button>
            : <button className="btn ghost" disabled={busy} onClick={() => act('enable')}>Enable</button>}
          {!c.has_activity && <button className="btn danger" onClick={() => setConfirm('delete')}>Delete</button>}
        </div>
      </div>

      <div className="kpi-grid">
        <StatCard icon="check" label="Successful redemptions" value={a.successfulRedemptions} description="Verified payments only" />
        <StatCard label="Remaining" value={a.remainingRedemptions == null ? 'Unlimited' : a.remainingRedemptions}
          description={a.inFlight ? `${a.inFlight} checkout${a.inFlight === 1 ? '' : 's'} in progress` : undefined} />
        <StatCard label="Total discount granted" value={a.totalDiscount} format={moneyExact} />
        <StatCard label="Original subscription value" value={a.totalOriginalValue} format={moneyExact} />
        <StatCard icon="trend" label="Revenue collected" value={a.totalRevenueCollected} format={moneyExact}
          description={a.refundedRevenue ? `${moneyExact(a.refundedRevenue)} since refunded` : undefined} />
        <StatCard icon="users" label="Unique customers" value={a.uniqueCustomers} />
        <StatCard label="Enterprise redemptions" value={a.enterpriseRedemptions} />
        <StatCard label="Independent redemptions" value={a.independentRedemptions}
          description={a.abandonedOrFailed ? `${a.abandonedOrFailed} failed or abandoned checkout${a.abandonedOrFailed === 1 ? '' : 's'} (not counted)` : undefined} />
      </div>

      <div className="card">
        <h2>Configuration</h2>
        <dl className="kv">
          <dt>Discount</dt><dd>{discountLabel(c)}</dd>
          <dt>Minimum purchase</dt><dd>{c.minimum_purchase_amount != null ? moneyExact(c.minimum_purchase_amount) : 'None'}</dd>
          <dt>Customer type</dt><dd>{CUSTOMER_LABEL[c.customer_type]}{c.first_time_only ? ' · first-time customers only' : ''}</dd>
          <dt>Applies to</dt><dd>{c.applies_to}</dd>
          <dt>Valid</dt><dd>{formatInTz(c.starts_at, c.timezone)} → {formatInTz(c.expires_at, c.timezone)}</dd>
          <dt>Total uses</dt><dd>{c.redemption_count} of {c.max_redemptions ?? 'unlimited'}</dd>
          <dt>Per gym</dt><dd>{c.max_redemptions_per_customer ?? 'Unlimited'}</dd>
          <dt>Stacking</dt><dd>{c.allow_stacking ? 'Can combine with other stackable coupons' : 'Cannot be combined'}</dd>
          <dt>Created</dt><dd>{formatInTz(c.created_at, c.timezone)} by {c.created_by_name || 'a founder'}</dd>
          {c.updated_at !== c.created_at && <><dt>Last changed</dt><dd>{formatInTz(c.updated_at, c.timezone)}{c.updated_by_name ? ` by ${c.updated_by_name}` : ''}</dd></>}
          {!c.is_enabled && c.disabled_at && <><dt>Disabled</dt><dd>{formatInTz(c.disabled_at, c.timezone)}</dd></>}
          <dt>Founder notes</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{c.founder_notes || '—'}</dd>
        </dl>
        <p className="faint" style={{ marginTop: 14, marginBottom: 0 }}>
          Every change to this coupon is in the <Link to={`/audit?entityType=coupon`}>audit log</Link>.
        </p>
      </div>

      <Redemptions coupon={c} />

      <ConfirmDialog
        open={confirm === 'disable'}
        title={`Disable ${c.code}?`}
        description="It stops working at checkout immediately. A gym already paying at this price keeps it. You can re-enable it later."
        confirmLabel="Disable coupon"
        busy={busy}
        onConfirm={() => act('disable')}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        title={`Delete ${c.code}?`}
        description="This coupon has never been used, so it can be removed completely. This cannot be undone."
        confirmLabel="Delete coupon"
        confirmText={c.code}
        busy={busy}
        onConfirm={() => act('delete')}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
