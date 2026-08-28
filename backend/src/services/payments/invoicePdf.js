// ============================================================
// INVOICE PDF — renders a downloadable PDF strictly from the STORED
// invoices row snapshot (amount/tax_amount/issued_at/currency) plus the
// minimum extra display data needed to make it readable (org name,
// package/plan name, customer name) -- NEVER live-recalculated pricing.
// A historical invoice must always show what was actually charged at
// the time, even if today's package prices have since changed.
//
// pdfkit is pure-JS (no native binaries) -- required for Vercel
// serverless, where a native/headless-browser PDF renderer would need
// a binary this environment can't ship.
// ============================================================
import PDFDocument from 'pdfkit';

/** Resolves a human-readable description of what an order actually
 *  paid for, from whatever's still resolvable today. A subject row that
 *  no longer exists (rare, but possible after a plan/package is
 *  archived) degrades to a generic label rather than failing the whole
 *  PDF -- the invoice's own stored amount/currency are what legally
 *  matter, this is just descriptive text. */
async function resolveLineItem(db, order) {
  if (!order) return { description: 'SK OS payment', detail: null };
  if (order.subject_type === 'ORG_PACKAGE') {
    const sub = await db.q1('SELECT * FROM org_subscriptions WHERE id = ?', [order.subject_id]);
    const pkg = sub?.package_id ? await db.q1('SELECT name FROM sk_packages WHERE id = ?', [sub.package_id]) : null;
    return { description: pkg?.name ? `SK OS package -- ${pkg.name}` : 'SK OS package subscription', detail: sub ? `${sub.client_capacity} client capacity` : null };
  }
  if (order.subject_type === 'ORG_CAPACITY_ADDON') {
    const purchase = await db.q1('SELECT increment FROM org_capacity_purchases WHERE id = ?', [order.subject_id]);
    return { description: 'SK OS capacity add-on', detail: purchase ? `+${purchase.increment} client capacity` : null };
  }
  // CLIENT_MEMBERSHIP -- subject_id is an enrollment_tokens.id for a
  // fresh join, or a subscriptions.id directly for a renewal (see
  // enrollment.js's /client/join vs /client/renew).
  const viaToken = await db.q1(
    `SELECT p.name AS plan_name FROM enrollment_tokens t LEFT JOIN packages p ON p.id = t.membership_plan_id WHERE t.id = ?`, [order.subject_id]);
  if (viaToken) return { description: viaToken.plan_name ? `Membership -- ${viaToken.plan_name}` : 'Gym membership', detail: null };
  const viaRenewal = await db.q1('SELECT plan_name FROM subscriptions WHERE id = ?', [order.subject_id]);
  return { description: viaRenewal?.plan_name ? `Membership renewal -- ${viaRenewal.plan_name}` : 'Gym membership', detail: null };
}

async function resolveCustomer(db, order) {
  if (!order) return null;
  let clientId = order.client_id;
  if (!clientId && order.subject_type === 'CLIENT_MEMBERSHIP') {
    const tokenRow = await db.q1('SELECT consumed_by FROM enrollment_tokens WHERE id = ?', [order.subject_id]);
    if (tokenRow?.consumed_by) {
      const client = await db.q1('SELECT id FROM clients WHERE user_id = ?', [tokenRow.consumed_by]);
      clientId = client?.id || null;
    }
  }
  if (!clientId) return null;
  return db.q1(`SELECT u.name, u.email FROM clients c JOIN users u ON u.id = c.user_id WHERE c.id = ?`, [clientId]);
}

/**
 * Resolves who invoice `invoiceId` should be emailed to -- used by the
 * "Email Invoice" route. Returns null only if the invoice doesn't exist
 * for this org; `customer` itself is null for an ORG_PACKAGE/
 * ORG_CAPACITY_ADDON invoice (the gym paying SK OS, not a client paying
 * the gym) -- the caller falls back to the requesting owner's own
 * account email in that case rather than this function guessing one.
 */
export async function resolveInvoiceRecipient(db, { invoiceId, orgId }) {
  const invoice = await db.q1('SELECT * FROM invoices WHERE id = ? AND org_id = ?', [invoiceId, orgId]);
  if (!invoice) return null;
  const order = await db.q1('SELECT * FROM payment_orders WHERE id = ?', [invoice.order_id]);
  const customer = await resolveCustomer(db, order);
  return { invoice, order, customer };
}

/**
 * Renders invoice `invoiceId` (must belong to `orgId`) as a PDF Buffer,
 * or null if no such invoice exists for that org. Never regenerates
 * historical pricing -- every number on the page comes from the STORED
 * invoices row, or from refunds rows (also immutable once SUCCESS).
 */
export async function renderInvoicePdf(db, { invoiceId, orgId }) {
  const invoice = await db.q1('SELECT * FROM invoices WHERE id = ? AND org_id = ?', [invoiceId, orgId]);
  if (!invoice) return null;
  const order = await db.q1('SELECT * FROM payment_orders WHERE id = ?', [invoice.order_id]);
  const org = await db.q1('SELECT name FROM organizations WHERE id = ?', [orgId]);
  const [lineItem, customer, refunds] = await Promise.all([
    resolveLineItem(db, order),
    resolveCustomer(db, order),
    order ? db.q(`SELECT * FROM refunds WHERE payment_order_id = ? AND status = 'SUCCESS' ORDER BY created_at`, [order.id]) : [],
  ]);

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.fontSize(20).fillColor('#000').text('SK OS');
  doc.fontSize(10).fillColor('#666').text('Fitness business operating system -- merchant of record for this payment');
  doc.moveDown(1.5);

  doc.fillColor('#000').fontSize(16).text(`Invoice ${invoice.invoice_number}`);
  doc.fontSize(10).fillColor('#666');
  doc.text(`Issued: ${String(invoice.issued_at).slice(0, 10)}`);
  doc.text(`Status: ${invoice.status}`);
  doc.moveDown(1);

  doc.fillColor('#000').fontSize(11).text(`Billed to: ${org?.name || 'Gym'}`);
  if (customer?.name) doc.text(`Customer: ${customer.name}${customer.email ? ` (${customer.email})` : ''}`);
  doc.moveDown(1);

  doc.fontSize(12).text(lineItem.description);
  if (lineItem.detail) doc.fontSize(9).fillColor('#666').text(lineItem.detail);
  doc.moveDown(1);

  doc.fillColor('#000').fontSize(10);
  doc.text(`Subtotal: ${invoice.currency} ${Number(invoice.amount).toFixed(2)}`);
  if (invoice.tax_amount) doc.text(`Tax: ${invoice.currency} ${Number(invoice.tax_amount).toFixed(2)}`);
  doc.fontSize(13).text(`Total: ${invoice.currency} ${(Number(invoice.amount) + Number(invoice.tax_amount)).toFixed(2)}`);
  doc.moveDown(0.5);

  doc.fontSize(9).fillColor('#666');
  if (order) {
    doc.text(`Payment reference: ${order.provider_order_id || order.id}`);
    doc.text(`Payment status: ${order.status}`);
  }

  if (refunds.length) {
    doc.moveDown(1);
    doc.fillColor('#000').fontSize(11).text('Refunds');
    doc.fontSize(9).fillColor('#666');
    for (const r of refunds) {
      doc.text(`${String(r.created_at).slice(0, 10)} -- ${r.currency} ${Number(r.amount).toFixed(2)} (${r.type}) -- ${r.reason || 'no reason given'}`);
    }
  }

  doc.end();
  return done;
}
