// ============================================================
// ADMIN CONSOLE — COUPON MANAGEMENT (/api/console/coupons/*)
//
// Mounted from INSIDE routes/console.js (`r.use('/coupons', ...)`), after
// that router's own `requireAuth, requireRole('SUPER_ADMIN')` gate and
// its per-admin rate limit -- so this file adds no second auth mechanism
// and cannot be reached by a gym owner, trainer or client however the
// frontend is routed. Every mutation writes an admin_audit_logs row via
// console.js's own writeAuditLog(), in the SAME transaction as the
// mutation it records.
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../validate.js';
import { rateLimit } from '../rateLimit.js';
import { toCsv } from '../services/platform/csv.js';
import { COUPON_KINDS, CUSTOMER_TYPES } from '../services/coupons/couponEngine.js';
import {
  CouponError, getCouponOptions, getCoupon, createCoupon, updateCoupon, setCouponEnabled, deleteCoupon,
  listCoupons, getCouponDashboard, getCouponAnalytics, listCouponRedemptions,
} from '../services/coupons/couponAdmin.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const STATUSES = ['ACTIVE', 'SCHEDULED', 'EXPIRED', 'DISABLED', 'EXHAUSTED'];

const money = z.number().finite().min(0).max(10_000_000);
const couponBody = z.object({
  code: z.string().trim().min(3).max(32),
  internalName: z.string().trim().min(1, 'Internal name is required').max(120),
  description: z.string().max(500).nullable().optional(),
  discountType: z.enum(['PERCENTAGE', 'FIXED']),
  discountValue: z.number().finite().positive().max(10_000_000),
  maxDiscountAmount: money.positive().nullable().optional(),
  minimumPurchaseAmount: money.nullable().optional(),
  customerType: z.enum(CUSTOMER_TYPES),
  applicableKinds: z.array(z.enum(COUPON_KINDS)).max(COUPON_KINDS.length).nullable().optional(),
  applicableTiers: z.array(z.string().trim().min(1).max(80)).max(50).nullable().optional(),
  applicableDurations: z.array(z.number().int().min(1).max(3650)).max(20).nullable().optional(),
  startsDate: z.string().regex(DATE, 'Start date must be YYYY-MM-DD'),
  startsTime: z.string().regex(HHMM, 'Start time must be HH:mm'),
  expiresDate: z.string().regex(DATE, 'Expiry date must be YYYY-MM-DD'),
  expiresTime: z.string().regex(HHMM, 'Expiry time must be HH:mm'),
  timezone: z.string().min(1).max(64).default('Asia/Kolkata'),
  maxRedemptions: z.number().int().positive().max(10_000_000).nullable().optional(),
  maxRedemptionsPerCustomer: z.number().int().positive().max(10_000).nullable().optional(),
  firstTimeOnly: z.boolean().default(false),
  allowStacking: z.boolean().default(false),
  enabled: z.boolean().default(true),
  founderNotes: z.string().max(2000).nullable().optional(),
});

/** Spreadsheet apps execute a cell that starts with = + - @ (CSV
 *  injection). Codes cannot start with one (see normalizeCouponCode),
 *  but names, descriptions and gym names are free text. */
const safeCell = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

export default function consoleCouponRoutes(db, { writeAuditLog }) {
  const r = Router();
  // Mutations get a tighter ceiling than the console-wide 60/min reads.
  const couponWrite = rateLimit({ windowMs: 60_000, max: 30, keyFn: (req) => `cpw:${req.user?.sub || 'anon'}` });

  /** CouponError -> its own status + { error, message }; anything else
   *  falls through to the app's central error handler (a real 500). */
  const handled = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof CouponError) return res.status(e.status).json({ error: e.error, message: e.message, ...e.extra });
      throw e;
    }
  };

  r.get('/summary', async (_req, res) => {
    res.json(await getCouponDashboard(db));
  });

  r.get('/options', async (_req, res) => {
    res.json(await getCouponOptions(db));
  });

  r.get('/', async (req, res) => {
    const q = req.query;
    res.json(await listCoupons(db, {
      search: typeof q.search === 'string' ? q.search : null,
      status: STATUSES.includes(q.status) ? q.status : null,
      customerType: CUSTOMER_TYPES.includes(q.customerType) ? q.customerType : null,
      createdFrom: DATE.test(String(q.createdFrom || '')) ? q.createdFrom : null,
      createdTo: DATE.test(String(q.createdTo || '')) ? q.createdTo : null,
      sort: typeof q.sort === 'string' ? q.sort : 'created_at',
      dir: q.dir === 'asc' ? 'asc' : 'desc',
      limit: q.limit, offset: q.offset,
    }));
  });

  // Declared before '/:id' so "export" is never read as a coupon id.
  r.get('/export', async (req, res) => {
    const { coupons } = await listCoupons(db, { limit: 100, offset: 0 });
    let all = coupons;
    for (let off = 100; all.length === off; off += 100) {
      const page = await listCoupons(db, { limit: 100, offset: off });
      all = all.concat(page.coupons);
      if (!page.coupons.length || off > 50_000) break;
    }
    const csv = toCsv(all, [
      { header: 'code', value: 'code' },
      { header: 'internal_name', value: (c) => safeCell(c.internal_name) },
      { header: 'status', value: 'status' },
      { header: 'discount_type', value: 'discount_type' },
      { header: 'discount_value', value: 'discount_value' },
      { header: 'max_discount_amount', value: 'max_discount_amount' },
      { header: 'minimum_purchase_amount', value: 'minimum_purchase_amount' },
      { header: 'customer_type', value: 'customer_type' },
      { header: 'applies_to', value: (c) => safeCell(c.applies_to) },
      { header: 'starts_at', value: 'starts_at' },
      { header: 'expires_at', value: 'expires_at' },
      { header: 'timezone', value: 'timezone' },
      { header: 'redemption_count', value: 'redemption_count' },
      { header: 'max_redemptions', value: 'max_redemptions' },
      { header: 'max_redemptions_per_customer', value: 'max_redemptions_per_customer' },
      { header: 'created_by', value: (c) => safeCell(c.created_by_name) },
      { header: 'created_at', value: 'created_at' },
    ]);
    await writeAuditLog(db, req, { action: 'data_export', entityType: 'export', after: { export: 'coupons', rowCount: all.length } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="coupons.csv"');
    res.send(csv);
  });

  r.post('/', couponWrite, validate(couponBody), handled(async (req, res) => {
    const coupon = await db.tx(async (tx) => {
      const created = await createCoupon(tx, req.body, req.user.sub);
      await writeAuditLog(tx, req, { action: 'coupon_created', entityType: 'coupon', entityId: created.id, after: created });
      return created;
    });
    res.status(201).json({ coupon });
  }));

  r.get('/:id', async (req, res) => {
    const out = await getCouponAnalytics(db, req.params.id);
    if (!out) return res.status(404).json({ error: 'not_found', message: 'Coupon not found.' });
    res.json(out);
  });

  r.post('/:id', couponWrite, validate(couponBody), handled(async (req, res) => {
    const { after } = await db.tx(async (tx) => {
      const out = await updateCoupon(tx, req.params.id, req.body, req.user.sub);
      await writeAuditLog(tx, req, { action: 'coupon_updated', entityType: 'coupon', entityId: req.params.id, before: out.before, after: out.after });
      return out;
    });
    res.json({ coupon: after });
  }));

  r.post('/:id/disable', couponWrite, validate(z.object({ reason: z.string().max(500).optional() })), handled(async (req, res) => {
    const { after } = await db.tx(async (tx) => {
      const out = await setCouponEnabled(tx, req.params.id, false, req.user.sub);
      await writeAuditLog(tx, req, {
        action: 'coupon_disabled', entityType: 'coupon', entityId: req.params.id,
        before: { is_enabled: out.before.is_enabled }, after: { is_enabled: false, reason: req.body.reason || null },
      });
      return out;
    });
    res.json({ coupon: after });
  }));

  r.post('/:id/enable', couponWrite, handled(async (req, res) => {
    const { after } = await db.tx(async (tx) => {
      const out = await setCouponEnabled(tx, req.params.id, true, req.user.sub);
      await writeAuditLog(tx, req, {
        action: 'coupon_enabled', entityType: 'coupon', entityId: req.params.id,
        before: { is_enabled: out.before.is_enabled }, after: { is_enabled: true },
      });
      return out;
    });
    res.json({ coupon: after });
  }));

  r.delete('/:id', couponWrite, handled(async (req, res) => {
    await db.tx(async (tx) => {
      const out = await deleteCoupon(tx, req.params.id);
      await writeAuditLog(tx, req, { action: 'coupon_deleted', entityType: 'coupon', entityId: req.params.id, before: out.before });
    });
    res.json({ ok: true });
  }));

  r.get('/:id/redemptions', async (req, res) => {
    const coupon = await getCoupon(db, req.params.id);
    if (!coupon) return res.status(404).json({ error: 'not_found', message: 'Coupon not found.' });
    res.json(await listCouponRedemptions(db, req.params.id, {
      status: typeof req.query.status === 'string' ? req.query.status : 'REDEEMED',
      limit: Math.min(100, Number(req.query.limit) || 25), offset: req.query.offset,
    }));
  });

  r.get('/:id/redemptions/export', async (req, res) => {
    const coupon = await getCoupon(db, req.params.id);
    if (!coupon) return res.status(404).json({ error: 'not_found', message: 'Coupon not found.' });
    const { redemptions } = await listCouponRedemptions(db, req.params.id, {
      status: typeof req.query.status === 'string' ? req.query.status : 'REDEEMED', limit: 5000, offset: 0,
    });
    const csv = toCsv(redemptions, [
      { header: 'redemption_id', value: 'id' },
      { header: 'coupon_code', value: () => coupon.code },
      { header: 'status', value: 'status' },
      { header: 'gym', value: (x) => (x.subject_type === 'BARBELL_PLAN' ? '' : safeCell(x.org_name)) },
      { header: 'org_id', value: 'org_id' },
      { header: 'customer_type', value: 'customer_type' },
      { header: 'client', value: (x) => (x.subject_type === 'BARBELL_PLAN' ? safeCell(x.customer_name) : '') },
      { header: 'user_id', value: (x) => x.user_id || '' },
      { header: 'plan_order_id', value: (x) => x.plan_order_id || '' },
      { header: 'purchase_type', value: 'subject_type' },
      { header: 'subscription_or_purchase_id', value: 'subject_id' },
      { header: 'payment_order_id', value: 'payment_order_id' },
      { header: 'provider_payment_id', value: 'provider_payment_id' },
      { header: 'invoice_number', value: 'invoice_number' },
      { header: 'order_status', value: 'order_status' },
      { header: 'original_amount', value: 'original_amount' },
      { header: 'discount_amount', value: 'discount_amount' },
      { header: 'final_amount', value: 'final_amount' },
      { header: 'currency', value: 'currency' },
      { header: 'late_confirmation', value: (x) => (x.late_confirmation ? 'yes' : 'no') },
      { header: 'redeemed_at', value: 'redeemed_at' },
      { header: 'created_at', value: 'created_at' },
    ]);
    await writeAuditLog(db, req, {
      action: 'data_export', entityType: 'export', entityId: coupon.id, after: { export: 'coupon_redemptions', code: coupon.code, rowCount: redemptions.length },
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="coupon-${coupon.code}-redemptions.csv"`);
    res.send(csv);
  });

  return r;
}
