// ============================================================
// /api/receipts -- the PDF receipt for a payment, for the two people it
// belongs to: the member who paid, and the owner of the gym they paid.
//
// Keyed by the `payments` row, which every completed payment has however
// it was made (online at checkout, or recorded at the desk). The receipt
// is issued on first request if it does not exist yet, so a payment
// recorded before receipts existed still gets one. Anyone else gets a 404,
// not a 403: whether a payment id exists is not theirs to learn.
// ============================================================
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { rateLimit } from '../rateLimit.js';
import { ensureReceipt } from '../services/payments/receipts.js';
import { renderInvoicePdf } from '../services/payments/invoicePdf.js';

export default function receiptRoutes(db) {
  const r = Router();
  r.use(requireAuth);
  const limit = rateLimit({ windowMs: 60_000, max: 60, keyFn: (req) => req.user?.sub || 'anon' });

  async function mayOpen(req, payment) {
    if (req.user.role === 'SUPER_ADMIN') return true;
    if (req.user.role === 'GYM_OWNER') return req.user.org === payment.org_id;
    const client = await db.q1('SELECT user_id FROM clients WHERE id = ?', [payment.client_id]);
    return !!client && client.user_id === req.user.sub;
  }

  r.get('/payments/:id/pdf', limit, async (req, res) => {
    const payment = await db.q1('SELECT * FROM payments WHERE id = ?', [req.params.id]);
    if (!payment || !(await mayOpen(req, payment))) return res.status(404).json({ error: 'Receipt not found' });
    const invoice = await ensureReceipt(db, payment);
    const pdf = await renderInvoicePdf(db, { invoiceId: invoice.id, orgId: payment.org_id });
    if (!pdf) return res.status(404).json({ error: 'Receipt not found' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${invoice.invoice_number}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(pdf);
  });

  return r;
}
