// ============================================================
// GYM PAYOUTS -- membership money goes to the gym, through Razorpay Route.
//
// A member pays through Barbell's Razorpay account, and Razorpay moves the
// gym's share to the gym's own Route "linked account", which settles to the
// gym's bank. Barbell keeps only enough to cover Razorpay's own fee (2%
// plus 18% GST unless RAZORPAY_ROUTE_FEE_PERCENT says otherwise), so the
// gym is not charged twice and Barbell does not pay its gyms' gateway fees.
//
// Until a gym's account is ACTIVE its members cannot pay it online at all:
// they join or renew at the front desk, and the owner records the payment
// (which issues a receipt). No gym's money ever waits in Barbell's account.
//
// Bank account and PAN numbers pass straight through to Razorpay and are
// never stored here. payment_accounts keeps Razorpay's own ids, the
// status, what Razorpay still needs, and the names the receipt prints.
//
// Under the mock provider (development and tests) a submitted account is
// activated at once, so the whole flow can be exercised without Razorpay.
// ============================================================
import { now } from '../../ids.js';
import { providerName, razorpayApi } from './paymentProvider.js';

const DEFAULT_FEE_PERCENT = 2.36;

/** Barbell's share of a membership payment, in percent. */
export function feePercent() {
  const n = Number(process.env.RAZORPAY_ROUTE_FEE_PERCENT);
  return Number.isFinite(n) && n >= 0 && n <= 20 ? n : DEFAULT_FEE_PERCENT;
}

/** A membership payment split into the gym's share and Barbell's, in paise. */
export function splitPayment(amountRupees) {
  const total = Math.round(Number(amountRupees) * 100);
  const fee = Math.ceil((total * feePercent()) / 100);
  return { total, fee, gym: Math.max(0, total - fee) };
}

export async function getPayoutAccount(db, orgId) {
  return db.q1('SELECT * FROM payment_accounts WHERE org_id = ?', [orgId]);
}

/**
 * Whether this gym's members can pay it online, and if so, the Route
 * transfer that sends the gym its share. `{ ok: false }` means the desk.
 */
export async function memberCheckout(db, orgId, amountRupees) {
  const provider = providerName();
  if (provider !== 'razorpay') return { ok: provider === 'mock', transfers: [] };
  const account = await getPayoutAccount(db, orgId);
  if (!account || account.status !== 'ACTIVE' || !account.provider_account_id) return { ok: false, transfers: [] };
  const split = splitPayment(amountRupees);
  return {
    ok: true,
    transfers: [{
      account: account.provider_account_id,
      amount: split.gym,
      currency: 'INR',
      notes: { purpose: 'gym_membership', org_id: orgId },
      linked_account_notes: ['purpose'],
      on_hold: false,
    }],
  };
}

/** Whether a gym takes online payments, without working out a split. */
export async function onlinePaymentsOpen(db, orgId) {
  return (await memberCheckout(db, orgId, 100)).ok;
}

// Razorpay's activation states, in this table's four.
const STATUS = {
  activated: 'ACTIVE',
  requested: 'KYC_PENDING',
  under_review: 'KYC_PENDING',
  needs_clarification: 'LIMITED',
  suspended: 'LIMITED',
};

function requirementsOf(product) {
  return (product?.requirements || []).map((r) => ({ field: r.field_reference, reason: r.reason_code, status: r.status }));
}

async function save(db, orgId, patch) {
  const current = await getPayoutAccount(db, orgId);
  const row = { ...(current || {}), ...patch };
  await db.run(
    `INSERT INTO payment_accounts (org_id, provider, provider_account_id, provider_product_id, status, business_name, legal_name, requirements_json, updated_at)
     VALUES (?, 'razorpay', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id) DO UPDATE SET provider_account_id = excluded.provider_account_id, provider_product_id = excluded.provider_product_id,
       status = excluded.status, business_name = excluded.business_name, legal_name = excluded.legal_name,
       requirements_json = excluded.requirements_json, updated_at = excluded.updated_at`,
    [orgId, row.provider_account_id || null, row.provider_product_id || null, row.status || 'NOT_CONNECTED',
      row.business_name || null, row.legal_name || null, row.requirements_json || null, now()]);
  return getPayoutAccount(db, orgId);
}

/**
 * Sets the gym up to be paid: creates its Route linked account (once),
 * names its contact, requests Route, and gives Razorpay the bank account
 * to settle to. Re-submitting (to fix what Razorpay asked about) sends the
 * new bank details to the same account.
 */
export async function submitPayoutDetails(db, orgId, d) {
  const current = await getPayoutAccount(db, orgId);
  const names = { business_name: d.displayName || d.legalBusinessName, legal_name: d.legalBusinessName };

  if (providerName() !== 'razorpay') {
    // Development: no Razorpay to ask, so the account is simply live.
    return save(db, orgId, {
      ...names,
      provider_account_id: current?.provider_account_id || `acc_mock_${orgId.slice(-10)}`,
      provider_product_id: current?.provider_product_id || `acc_prd_mock_${orgId.slice(-10)}`,
      status: 'ACTIVE',
      requirements_json: null,
    });
  }

  let accountId = current?.provider_account_id;
  if (!accountId) {
    const account = await razorpayApi('POST', '/v2/accounts', {
      email: d.email,
      phone: d.phone,
      type: 'route',
      reference_id: orgId,
      legal_business_name: d.legalBusinessName,
      customer_facing_business_name: d.displayName || d.legalBusinessName,
      business_type: d.businessType,
      contact_name: d.contactName,
      profile: {
        category: 'healthcare',
        subcategory: 'fitness',
        addresses: {
          registered: {
            street1: d.street1, street2: d.street2 || undefined, city: d.city, state: d.state, postal_code: d.postalCode, country: 'IN',
          },
        },
      },
      legal_info: { pan: d.pan, gst: d.gst || undefined },
    });
    accountId = account.id;
    // Saved straight away: if a later step fails, the next attempt carries
    // on with this account instead of creating a second one.
    await save(db, orgId, { ...names, provider_account_id: accountId, status: 'KYC_PENDING' });
    await razorpayApi('POST', `/v2/accounts/${accountId}/stakeholders`, { name: d.contactName, email: d.email });
  }

  let productId = (await getPayoutAccount(db, orgId))?.provider_product_id;
  if (!productId) {
    const product = await razorpayApi('POST', `/v2/accounts/${accountId}/products`, { product_name: 'route', tnc_accepted: true });
    productId = product.id;
    await save(db, orgId, { provider_product_id: productId });
  }

  const product = await razorpayApi('PATCH', `/v2/accounts/${accountId}/products/${productId}`, {
    settlements: { account_number: d.accountNumber, ifsc_code: d.ifsc, beneficiary_name: d.beneficiaryName },
    tnc_accepted: true,
  });
  return save(db, orgId, {
    ...names,
    status: STATUS[product.activation_status] || 'KYC_PENDING',
    requirements_json: JSON.stringify(requirementsOf(product)),
  });
}

/** Asks Razorpay how the gym's account is doing, and records the answer. */
export async function refreshPayoutStatus(db, orgId) {
  const current = await getPayoutAccount(db, orgId);
  if (!current?.provider_account_id || !current?.provider_product_id || providerName() !== 'razorpay') return current;
  const product = await razorpayApi('GET', `/v2/accounts/${current.provider_account_id}/products/${current.provider_product_id}`);
  return save(db, orgId, {
    status: STATUS[product.activation_status] || current.status,
    requirements_json: JSON.stringify(requirementsOf(product)),
  });
}

/** The account as the owner's screen shows it: no ids it does not need. */
export function payoutView(account) {
  let requirements = [];
  try { requirements = JSON.parse(account?.requirements_json || '[]'); } catch { /* none */ }
  return {
    status: account?.status || 'NOT_CONNECTED',
    businessName: account?.business_name || null,
    legalName: account?.legal_name || null,
    connected: !!account?.provider_account_id,
    requirements,
    feePercent: feePercent(),
    provider: providerName(),
    updatedAt: account?.updated_at || null,
  };
}
