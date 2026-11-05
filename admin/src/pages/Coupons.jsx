// ============================================================
// COUPON MANAGEMENT -- the founder's coupon dashboard + table.
// Every number on this page is computed server-side from verified
// payment/redemption records (see backend/src/services/coupons/
// couponAdmin.js); nothing here derives a figure of its own.
// ============================================================
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, downloadCsv } from '../api.js';
import { useFetch, moneyExact, formatInTz } from '../utils.js';
import { useToast } from '../components/Toast.jsx';
import StatCard from '../components/StatCard.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import Icon from '../components/Icon.jsx';
import { SkeletonRows, SkeletonCards } from '../components/Skeleton.jsx';

export const COUPON_STATUS_TONE = { ACTIVE: 'good', SCHEDULED: 'warn', EXPIRED: 'mute', DISABLED: 'bad', EXHAUSTED: 'mute' };
export const CUSTOMER_LABEL = { ENTERPRISE: 'Enterprise', INDEPENDENT: 'Independent', BOTH: 'Both' };
const PAGE_SIZE = 25;

export function discountLabel(c) {
  if (c.discount_type === 'PERCENTAGE') {
    return `${c.discount_value}%${c.max_discount_amount ? ` (max ${moneyExact(c.max_discount_amount)})` : ''}`;
  }
  return `${moneyExact(c.discount_value)} off`;
}

export function CouponStatusBadge({ status }) {
  return <span className={`badge ${COUPON_STATUS_TONE[status] || 'mute'}`}>{status}</span>;
}

function Usage({ c }) {
  const max = c.max_redemptions;
  const pct = max ? Math.min(100, Math.round((c.redemption_count / max) * 100)) : 0;
  return (
    <div className="usage" title={c.reserved_count ? `${c.reserved_count} checkout(s) in progress` : undefined}>
      <div className="usage-num">{c.redemption_count} / {max ?? '∞'}</div>
      {max != null && <div className="usage-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>}
    </div>
  );
}

/** Debounces a fast-changing value (the search box) so the list isn't
 *  refetched on every keystroke. */
function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export default function Coupons() {
  const nav = useNavigate();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [customerType, setCustomerType] = useState('');
  const [createdFrom, setCreatedFrom] = useState('');
  const [createdTo, setCreatedTo] = useState('');
  const [sort, setSort] = useState('created_at:desc');
  const [offset, setOffset] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [disableTarget, setDisableTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const q = useDebounced(search);

  // Any filter change goes back to the first page.
  useEffect(() => { setOffset(0); }, [q, status, customerType, createdFrom, createdTo, sort]);

  const [sortKey, dir] = sort.split(':');
  const params = new URLSearchParams({ sort: sortKey, dir, limit: String(PAGE_SIZE), offset: String(offset) });
  if (q) params.set('search', q);
  if (status) params.set('status', status);
  if (customerType) params.set('customerType', customerType);
  if (createdFrom) params.set('createdFrom', createdFrom);
  if (createdTo) params.set('createdTo', createdTo);
  const query = params.toString();

  const summary = useFetch(() => api('/console/coupons/summary'));
  const list = useFetch(() => api(`/console/coupons?${query}`), [query]);
  const filtered = !!(q || status || customerType || createdFrom || createdTo);

  const exportCsv = async () => {
    setExporting(true);
    try { await downloadCsv('/console/coupons/export', 'coupons.csv'); toast.success('Coupons CSV downloaded'); }
    catch (e) { toast.error(e.message || 'Export failed'); }
    finally { setExporting(false); }
  };

  const toggle = async (c, enable) => {
    setBusy(true);
    try {
      await api(`/console/coupons/${c.id}/${enable ? 'enable' : 'disable'}`, { method: 'POST', body: JSON.stringify({}) });
      toast.success(enable ? `${c.code} re-enabled` : `${c.code} disabled — it stops working at checkout immediately`);
      setDisableTarget(null);
      list.reload({ silent: true });
      summary.reload({ silent: true });
    } catch (e) {
      toast.error(e.message || 'Could not update the coupon');
    } finally { setBusy(false); }
  };

  const s = summary.data;
  const total = list.data?.total || 0;

  return (
    <div>
      <div className="page-header page-header-row">
        <div>
          <h1>Coupon Management</h1>
          <p>Discount codes for Barbell subscriptions. Discounts are calculated and charged server-side, and a coupon only counts as redeemed once its payment is verified.</p>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={exportCsv} disabled={exporting}>{exporting ? 'Preparing CSV…' : 'Export CSV'}</button>
          <button className="btn" onClick={() => nav('/coupons/new')}>
            <span className="btn-icon"><Icon name="plus" size={15} /> Create coupon</span>
          </button>
        </div>
      </div>

      {summary.loading && <SkeletonCards count={8} />}
      {summary.error && <div className="error-text">{summary.error.message}</div>}
      {s && (
        <div className="kpi-grid">
          <StatCard icon="coupon" label="Total coupons" value={s.totalCoupons} />
          <StatCard label="Active" value={s.active} />
          <StatCard label="Scheduled" value={s.scheduled} />
          <StatCard label="Expired" value={s.expired} description={s.exhausted ? `+ ${s.exhausted} fully used` : undefined} />
          <StatCard label="Disabled" value={s.disabled} />
          <StatCard icon="check" label="Successful redemptions" value={s.successfulRedemptions}
            description={`Verified payments only · ${s.enterpriseRedemptions ?? 0} Enterprise, ${s.independentRedemptions ?? 0} Independent`} />
          <StatCard label="Total discounts given" value={s.totalDiscountGiven} format={moneyExact} />
          <StatCard icon="trend" label="Revenue via coupons" value={s.netRevenue} format={moneyExact}
            description={s.refundedRevenue ? `${moneyExact(s.grossRevenue)} collected − ${moneyExact(s.refundedRevenue)} refunded` : `${s.discountedOrders} discounted subscription${s.discountedOrders === 1 ? '' : 's'}`} />
        </div>
      )}

      <div className="filter-bar" role="search">
        <div className="field">
          <label htmlFor="cpn-search">Search</label>
          <input id="cpn-search" className="input" placeholder="Code or internal name…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="cpn-status">Status</label>
          <select id="cpn-status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {['ACTIVE', 'SCHEDULED', 'EXPIRED', 'EXHAUSTED', 'DISABLED'].map((v) => <option key={v} value={v}>{v[0] + v.slice(1).toLowerCase()}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="cpn-type">Customer type</label>
          <select id="cpn-type" className="input" value={customerType} onChange={(e) => setCustomerType(e.target.value)}>
            <option value="">All customers</option>
            <option value="ENTERPRISE">Enterprise</option>
            <option value="INDEPENDENT">Independent</option>
            <option value="BOTH">Both</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="cpn-from">Created from</label>
          <input id="cpn-from" type="date" className="input" value={createdFrom} onChange={(e) => setCreatedFrom(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="cpn-to">Created to</label>
          <input id="cpn-to" type="date" className="input" value={createdTo} min={createdFrom || undefined} onChange={(e) => setCreatedTo(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="cpn-sort">Sort by</label>
          <select id="cpn-sort" className="input" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="created_at:desc">Newest first</option>
            <option value="created_at:asc">Oldest first</option>
            <option value="expires_at:asc">Expiring soonest</option>
            <option value="starts_at:desc">Latest start</option>
            <option value="redemption_count:desc">Most redeemed</option>
            <option value="code:asc">Code A–Z</option>
          </select>
        </div>
      </div>

      {list.loading && <div className="card"><SkeletonRows rows={6} cols={8} /></div>}
      {list.error && <div className="error-text">{list.error.message}</div>}
      {list.data && !list.data.coupons.length && (
        <div className="card">
          <EmptyState icon="coupon"
            title={filtered ? 'No coupons match these filters' : 'No coupons yet'}
            description={filtered ? 'Try clearing a filter or searching for a different code.' : 'Create a coupon to give gyms a discount on their Barbell subscription.'} />
          {!filtered && (
            <div style={{ display: 'flex', justifyContent: 'center', paddingBottom: 20 }}>
              <button className="btn" onClick={() => nav('/coupons/new')}>Create your first coupon</button>
            </div>
          )}
        </div>
      )}

      {list.data && list.data.coupons.length > 0 && (
        <div className="card">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Coupon code</th><th>Discount</th><th>Customer type</th><th>Applicable plans</th>
                  <th>Start</th><th>Expiry</th><th>Usage</th><th>Status</th><th>Created by</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.data.coupons.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link to={`/coupons/${c.id}`}><span className="code-chip">{c.code}</span></Link>
                      <div className="faint" style={{ marginTop: 4 }}>{c.internal_name}</div>
                    </td>
                    <td>{discountLabel(c)}</td>
                    <td>{CUSTOMER_LABEL[c.customer_type]}</td>
                    <td title={c.applies_to}>{c.applicable_plans === 'ALL' ? 'All' : 'Selected'}</td>
                    <td className="faint">{formatInTz(c.starts_at, c.timezone, { time: false })}</td>
                    <td className="faint">{formatInTz(c.expires_at, c.timezone, { time: false })}</td>
                    <td><Usage c={c} /></td>
                    <td><CouponStatusBadge status={c.status} /></td>
                    <td className="faint">{c.created_by_name || '—'}</td>
                    <td>
                      <div className="row-actions">
                        <button className="btn ghost sm" onClick={() => nav(`/coupons/${c.id}`)}>View</button>
                        <button className="btn ghost sm" onClick={() => nav(`/coupons/${c.id}/edit`)}>Edit</button>
                        <button className="btn ghost sm" onClick={() => nav(`/coupons/new?from=${c.id}`)} aria-label={`Duplicate ${c.code}`}>Duplicate</button>
                        {c.is_enabled
                          ? <button className="btn ghost sm" onClick={() => setDisableTarget(c)}>Disable</button>
                          : <button className="btn ghost sm" disabled={busy} onClick={() => toggle(c, true)}>Enable</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <span>Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}</span>
            <div className="pager-btns">
              <button className="btn ghost sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Previous</button>
              <button className="btn ghost sm" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!disableTarget}
        title={`Disable ${disableTarget?.code}?`}
        description="It stops working at checkout immediately. A gym already paying at this price keeps it — that payment is recorded as it really happened. You can re-enable it later."
        confirmLabel="Disable coupon"
        busy={busy}
        onConfirm={() => toggle(disableTarget, false)}
        onCancel={() => setDisableTarget(null)}
      />
    </div>
  );
}
