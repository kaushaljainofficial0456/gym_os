// ============================================================
// INVOICES — metadata only (see invoices table comment in schema.sql);
// the PDF itself is rendered on demand from these fields by the PDF
// route (invoicePdf.js), never stored as a blob.
// ============================================================
import { id, now } from '../../ids.js';

/** Issues an invoice for a SUCCESSFUL payment_order. Idempotent per
 *  order_id: a duplicate call (e.g. both checkout-verify AND a webhook
 *  independently trying to issue one for the same order) returns the
 *  EXISTING invoice rather than creating a second one. */
export async function issueInvoice(db, order) {
  const existing = await db.q1('SELECT * FROM invoices WHERE order_id = ?', [order.id]);
  if (existing) return existing;
  const invoiceId = id('inv');
  // Sequential-looking but not a true atomic sequence (no SEQUENCE
  // table) -- fine for the invoice NUMBER'S purpose here (a human-
  // readable reference on a receipt), which doesn't need to be gapless,
  // only unique -- invoices.invoice_number carries the UNIQUE
  // constraint that actually enforces that.
  const invoiceNumber = `SKOS-${new Date().getFullYear()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const nowIso = now();
  await db.run(
    `INSERT INTO invoices (id, invoice_number, order_id, org_id, subject_type, amount, currency, tax_amount, status, issued_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'ISSUED', ?, ?)`,
    [invoiceId, invoiceNumber, order.id, order.org_id, order.subject_type, order.amount, order.currency, nowIso, nowIso]);
  return db.q1('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
}
