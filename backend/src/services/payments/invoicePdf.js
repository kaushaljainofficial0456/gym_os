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

// ============================================================
// Dark-theme layout, matching a template the user supplied directly
// (a screenshotted invoice design). Rebuilt as absolute-positioned
// pdfkit drawing rather than the old linear text-flow -- this template
// is a genuine two-column layout (identity/dates on the left, an
// itemized table on the right) that doc.moveDown()-style flow can't
// produce.
//
// SK OS's own identity (name/address) is fixed content, not derived
// from any org -- SK OS is the merchant of record for every invoice
// regardless of which gym or client it's billed to (see this file's
// top comment). The address is the user's own, supplied directly.
//
// Currency: pdfkit's built-in Helvetica (AFM) font has NO glyph for
// U+20B9 (₹) -- confirmed by rendering it: the byte truncates to a
// garbled "¹". "Rs " is used instead rather than embedding a custom
// TTF font (which would reintroduce the exact Vercel serverless
// font-bundling problem already fixed once for pdfkit's own AFM files
// -- see vercel.json's includeFiles comment). Amounts use 'en-IN'
// locale grouping (lakhs/crores, e.g. "9,97,500.00"), not the
// thousands-only grouping of a Western locale.
//
// "Due date" and a bank-transfer "Payment details" block from the
// original template are deliberately NOT reproduced: every invoice
// here is a RECEIPT for a payment already captured through the
// gateway (issueInvoice() only ever runs after a successful payment),
// never a request for a future bank transfer -- showing invented due
// dates or bank details would misrepresent how these were actually
// paid. A "Payment reference" block (provider + reference id) replaces
// it, matching what the OLD template already showed.
// ============================================================
const SK_OS_ADDRESS = ['New Bel Road', 'Bangalore - 560054', 'India'];

const INK = '#F5F5F5';
const MUTED = '#8A8A8A';
const FAINT = '#5A5A5A';
const LINE = '#2A2A2A';
const BG = '#0B0B0B';
const PILL_BG = '#242424';

function money(n) {
  return 'Rs ' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function paintBackground(doc) {
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(BG);
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

  const margin = 50;
  const doc = new PDFDocument({ size: 'A4', margin });
  doc.on('pageAdded', () => paintBackground(doc));
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const pageW = doc.page.width;
  const rightEdge = pageW - margin;
  // Column widths were calibrated against real doc.widthOfString()
  // measurements (fontSize 10 "Rs 9,97,500.00" ~= 68pt, a long client
  // email at fontSize 9 ~= 141pt) rather than guessed -- an earlier pass
  // starved the description column down to ~75pt, which wrapped even a
  // short line item across 3 lines and visually collided with the
  // Subtotal row below it.
  const leftColW = 140;
  const tableX = margin + leftColW + 12;
  const tableW = rightEdge - tableX;
  const colGap = 6;
  const qtyW = 25, rateW = 78, amtW = 82;
  const descW = tableW - qtyW - rateW - amtW - 3 * colGap;
  const qtyX = tableX + descW + colGap;
  const rateX = qtyX + qtyW + colGap;
  const amtX = rateX + rateW + colGap;

  paintBackground(doc);

  // ---- header: "Invoice" + brand/number ----
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(34).text('Invoice', margin, margin);
  doc.font('Helvetica').fontSize(9).fillColor(MUTED)
    .text('SK OS', margin, margin, { width: rightEdge - margin, align: 'right' });
  doc.text(`No. ${invoice.invoice_number}`, margin, margin + 13, { width: rightEdge - margin, align: 'right' });

  let y = margin + 56;
  doc.moveTo(margin, y).lineTo(rightEdge, y).strokeColor(LINE).lineWidth(1).stroke();
  y += 22;

  // ---- left column: FROM / BILLED TO / ISSUE DATE / STATUS ----
  const labelGap = 12, blockGap = 20;
  const label = (text, ly) => doc.font('Helvetica').fontSize(8).fillColor(FAINT).text(text.toUpperCase(), margin, ly, { characterSpacing: 0.6 });
  // Every left-column value is attacker-free but still variable-length
  // (an org name, a client email) -- draws, then advances y by the
  // TEXT'S REAL WRAPPED HEIGHT via heightOfString(), never a fixed
  // per-line constant. A fixed constant here caused the exact same
  // overlap bug the table's description column had: a two-line org
  // name ("Ironforge Fitness & Performance Studio") collided with the
  // "Attn:" line drawn right after it, caught by rendering and reading
  // back a sample PDF before shipping this.
  const drawLine = (text, ly, { width = leftColW, gap = 3 } = {}) => {
    doc.text(text, margin, ly, { width });
    return ly + doc.heightOfString(text, { width }) + gap;
  };

  label('From', y); y += labelGap;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK);
  y = drawLine('SK OS', y, { gap: 4 });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  for (const line of SK_OS_ADDRESS) y = drawLine(line, y, { gap: 0 });
  y += blockGap;

  label('Billed to', y); y += labelGap;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK);
  y = drawLine(org?.name || 'Gym', y, { gap: 4 });
  if (customer?.name) {
    doc.font('Helvetica').fontSize(9).fillColor(MUTED);
    y = drawLine(`Attn: ${customer.name}`, y, { gap: 0 });
    if (customer.email) y = drawLine(customer.email, y, { gap: 0 });
  }
  y += blockGap;

  label('Issue date', y); y += labelGap;
  doc.font('Helvetica').fontSize(10).fillColor(INK).text(String(invoice.issued_at).slice(0, 10), margin, y, { width: leftColW }); y += 15;
  y += blockGap - 15;

  label('Status', y); y += labelGap;
  const statusText = invoice.status === 'VOID' ? 'VOID' : 'PAID';
  const pillW = doc.font('Helvetica-Bold').fontSize(9).widthOfString(statusText) + 18;
  doc.roundedRect(margin, y, pillW, 18, 9).fill(PILL_BG);
  doc.fillColor(INK).text(statusText, margin, y + 5, { width: pillW, align: 'center' });

  // ---- right column: line-item table ----
  let ty = margin + 56 + 22;
  doc.font('Helvetica').fontSize(8).fillColor(FAINT);
  doc.text('DESCRIPTION', tableX, ty, { width: descW });
  doc.text('QTY', qtyX, ty, { width: qtyW, align: 'right' });
  doc.text('RATE', rateX, ty, { width: rateW, align: 'right' });
  doc.text('AMOUNT', amtX, ty, { width: amtW, align: 'right' });
  ty += 12;
  doc.moveTo(tableX, ty).lineTo(rightEdge, ty).strokeColor(LINE).lineWidth(1).stroke();
  ty += 16;

  // Description can legitimately wrap (a long package/plan name) --
  // measure its real rendered height rather than assuming one line, or
  // the Subtotal row below silently overlaps it (a real bug caught by
  // rendering and reading back a sample PDF before shipping this).
  doc.font('Helvetica-Bold').fontSize(10);
  const descLineH = doc.heightOfString(lineItem.description, { width: descW });
  doc.fillColor(INK).text(lineItem.description, tableX, ty, { width: descW });
  doc.font('Helvetica').fontSize(10).fillColor(INK);
  doc.text('1', qtyX, ty, { width: qtyW, align: 'right' });
  doc.text(money(invoice.amount), rateX, ty, { width: rateW, align: 'right' });
  doc.text(money(invoice.amount), amtX, ty, { width: amtW, align: 'right' });
  ty += descLineH + 4;
  if (lineItem.detail) {
    doc.font('Helvetica').fontSize(8.5);
    const detailH = doc.heightOfString(lineItem.detail, { width: descW });
    doc.fillColor(MUTED).text(lineItem.detail, tableX, ty, { width: descW });
    ty += detailH + 4;
  }
  ty += 12;

  const totalsRow = (lbl, val, opts = {}) => {
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.bold ? 11 : 9.5)
      .fillColor(opts.bold ? INK : MUTED).text(lbl, tableX, ty, { width: 150 });
    doc.fillColor(opts.bold ? INK : INK).text(val, rateX - 10, ty, { width: amtX + amtW - (rateX - 10), align: 'right' });
    ty += opts.bold ? 20 : 16;
  };
  totalsRow('Subtotal', money(invoice.amount));
  if (Number(invoice.tax_amount)) totalsRow('Tax', money(invoice.tax_amount));

  // ---- bottom rule + total ----
  const bottomRuleY = Math.max(y + 40, ty + 10);
  doc.moveTo(margin, bottomRuleY).lineTo(rightEdge, bottomRuleY).strokeColor(LINE).lineWidth(1).stroke();
  let by = bottomRuleY + 20;

  doc.font('Helvetica').fontSize(8).fillColor(FAINT).text('TOTAL PAID', margin, by, { characterSpacing: 0.6 });
  const totalAmount = Number(invoice.amount) + Number(invoice.tax_amount || 0);
  doc.font('Helvetica-Bold').fontSize(26).fillColor(INK)
    .text(money(totalAmount), margin, by - 4, { width: rightEdge - margin, align: 'right' });
  by += 40;

  // ---- payment reference (replaces the template's bank-transfer block --
  // these were paid through the gateway, not a bank transfer) ----
  if (order) {
    doc.moveTo(margin, by).lineTo(rightEdge, by).strokeColor(LINE).lineWidth(1).stroke();
    by += 20;
    doc.font('Helvetica').fontSize(8).fillColor(FAINT).text('PAYMENT REFERENCE', margin, by, { characterSpacing: 0.6 });
    by += 16;
    const refRow = (k, v) => {
      doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(k, margin, by, { width: 90 });
      doc.fillColor(INK).text(v, margin + 100, by, { width: 260 });
      by += 14;
    };
    refRow('Reference', order.provider_order_id || order.id);
    refRow('Status', order.status);
    by += 6;
  }

  if (refunds.length) {
    doc.font('Helvetica').fontSize(8).fillColor(FAINT).text('REFUNDS', margin, by, { characterSpacing: 0.6 });
    by += 16;
    doc.font('Helvetica').fontSize(9).fillColor(MUTED);
    for (const r of refunds) {
      doc.text(`${String(r.created_at).slice(0, 10)} -- ${money(r.amount)} (${r.type}) -- ${r.reason || 'no reason given'}`, margin, by, { width: rightEdge - margin });
      by += 14;
    }
  }

  // ---- footer ----
  const footerY = doc.page.height - margin - 10;
  doc.font('Helvetica').fontSize(8).fillColor(FAINT).text('Thank you for training with us.', margin, footerY, { width: 300 });
  doc.text('Page 1 of 1', margin, footerY, { width: rightEdge - margin, align: 'right' });

  doc.end();
  return done;
}
