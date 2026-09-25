// ============================================================
// DEMO API -- the prospect's side of the founder-approved demo.
//
// Mounted at /api/demo. Three tiers, and the difference between them is
// the whole security model:
//
//   PUBLIC, no auth        POST /request              (submit a request)
//                          GET  /access/:token        (pre-demo screen)
//                          POST /access/:token/start  (START THE CLOCK)
//                          POST /access/:token/event  (CTA clicks only)
//
//   DEMO SESSION required  GET  /session              (countdown resync)
//                          POST /switch-role          (owner/trainer/member)
//                          POST /event                (feature telemetry)
//                          POST /finish               (prospect ends early)
//
//   FOUNDER (SUPER_ADMIN)  -- not here. Approving, rejecting, revoking,
//                          re-issuing and resetting all live in
//                          routes/console.js, behind the same
//                          requireRole('SUPER_ADMIN') gate as every
//                          other platform-operator action. There is
//                          deliberately NO route in this file that can
//                          approve anything: a prospect reaching every
//                          endpoint here still cannot grant themselves
//                          access.
//
// Nothing in this file decides whether a demo is still alive -- that is
// services/demo/session.js, called from requireAuth for every request in
// the entire API (see auth.js). These routes only start, describe and
// end a session.
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, signDemoToken, setAuthCookie, clearAuthCookie } from '../auth.js';
import { validate } from '../validate.js';
import { rateLimit } from '../rateLimit.js';
import { id, now } from '../ids.js';
import { resolvePersona, DEMO_PERSONAS, DEMO_PERSONA_KEYS } from '../services/demo/personas.js';
import {
  findSessionByToken, evaluateSession, expiryFor, publicSessionView,
  closeSession, trackDemoEvent, enforceSession, DEMO_EVENT_TYPES,
} from '../services/demo/session.js';

/** Every route here that names a persona returns the SAME shape the rest
 *  of the app's auth responses use, so the frontend's existing session
 *  handling needs no demo-specific branch. */
function userView(user, org, personaKey) {
  return {
    id: user.id, name: user.name, email: user.email, role: user.role,
    orgId: user.org_id, orgName: org?.name || null, orgSlug: org?.slug || null,
    isDemo: true, persona: personaKey,
  };
}

/** The requesting client's IP, for rate-limit keying and for the one
 *  event that records where a demo was started from.
 *
 *  `req.ip` is Express's own value and the mechanism the rest of this
 *  codebase's IP-keyed limiters already use (see rateLimit.js's default
 *  keyFn, and auth.js's forgot-password/reset-password limiters). It is
 *  deliberately NOT a bespoke X-Forwarded-For parser: whatever Express is
 *  configured to trust is what every limiter in the app should agree on,
 *  so if the app later configures a trust-proxy hop count, `req.ip`
 *  becomes proxy-aware here at the same moment it does everywhere else,
 *  with no change to this file. */
const requestIp = (req) => req.ip || 'anon';

export default function demoRoutes(db) {
  const r = Router();

  // ---- limiters ----
  // The request form is the one unauthenticated WRITE a stranger can
  // reach, so it gets the strictest ceiling in this file. Keyed by IP
  // because there is no account to key on yet.
  const requestLimiter = rateLimit({ windowMs: 60 * 60_000, max: 5, keyFn: requestIp });
  // Token lookups: a 32-byte token is not brute-forceable in any
  // meaningful sense, but there is no reason to let anyone try, and a
  // ceiling also stops a leaked link being hammered to keep a session
  // "active" in the founder's activity view.
  const tokenLimiter = rateLimit({ windowMs: 60_000, max: 60, keyFn: requestIp });
  // Telemetry: generous, because a busy prospect legitimately fires one
  // per screen, but bounded so an open tab cannot write unbounded rows.
  const eventLimiter = rateLimit({ windowMs: 60_000, max: 120, keyFn: (req) => req.user?.demo || requestIp(req) });

  // ============================================================
  // PUBLIC -- request a demo
  // ============================================================
  // Creates a PENDING row and nothing else. No tenant, no session, no
  // token, no access: the spec is explicit that submitting the form must
  // not grant anything, and the only thing that can move this row
  // forward is a founder in the admin console.
  r.post('/request', requestLimiter, validate(z.object({
    ownerName: z.string().trim().min(2).max(100),
    gymName: z.string().trim().min(2).max(120),
    email: z.string().trim().email().max(200),
    phone: z.string().trim().min(6).max(30),
    city: z.string().trim().max(80).optional().or(z.literal('')),
    memberCount: z.coerce.number().int().min(0).max(100000).optional(),
    message: z.string().trim().max(1000).optional().or(z.literal('')),
  })), async (req, res) => {
    const b = req.body;
    const ts = now();
    const requestId = id('dmr');
    await db.run(
      `INSERT INTO demo_requests (id, owner_name, gym_name, email, phone, city, member_count, message,
         status, requested_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [requestId, b.ownerName, b.gymName, b.email.toLowerCase(), b.phone,
        b.city || null, Number.isFinite(b.memberCount) ? b.memberCount : null, b.message || null,
        ts, ts, ts]);
    // Deliberately returns no id and nothing addressable. A prospect has
    // nothing to poll and nothing to guess -- the next thing that happens
    // is a founder getting in touch.
    res.status(201).json({
      ok: true,
      message: 'Thanks — your request is with the SK OS team. You will get your demo link shortly.',
    });
  });

  // ============================================================
  // PUBLIC -- what is behind this link (the pre-demo screen)
  // ============================================================
  // Reading the link does NOT start the clock. This is the endpoint
  // behind "Welcome to SK OS / Your BeFitter Demo / [ Start 30-minute
  // demo ]", and a prospect can open it, close it, and come back an hour
  // later with all 30 minutes still waiting for them.
  r.get('/access/:token', tokenLimiter, async (req, res) => {
    const session = await findSessionByToken(db, req.params.token);
    if (!session) return res.status(404).json({ error: 'invalid_link', message: 'This demo link is not valid.' });
    const request = await db.q1('SELECT owner_name, gym_name FROM demo_requests WHERE id = ?', [session.demo_request_id]);
    const org = await db.q1('SELECT name FROM organizations WHERE id = ?', [session.demo_org_id]);
    const view = publicSessionView(session);
    res.json({
      // The prospect's OWN name and gym, from what they typed on the
      // request form -- "Hello Kirthi, welcome to your BeFitter demo" is
      // their own words read back, not a hardcoded string.
      ownerName: request?.owner_name || null,
      gymName: request?.gym_name || null,
      demoGymName: org?.name || null,
      ...view,
    });
  });

  // ============================================================
  // PUBLIC -- START THE CLOCK
  // ============================================================
  // The single moment the 30 minutes begin (spec 6). Not at request, not
  // at approval, not at link generation, not at page load: here, on an
  // explicit click.
  r.post('/access/:token/start', tokenLimiter, async (req, res) => {
    const session = await findSessionByToken(db, req.params.token);
    if (!session) return res.status(404).json({ error: 'invalid_link', message: 'This demo link is not valid.' });

    const verdict = evaluateSession(session);
    if (!verdict.ok && verdict.reason !== 'not_started') {
      // Already over. Restarting is a founder decision, never a click --
      // see spec 22 and the console's own re-issue route.
      return res.status(410).json({
        error: 'demo_session_ended', reason: verdict.reason,
        message: verdict.reason === 'revoked'
          ? 'This demo has been revoked by the administrator.'
          : 'This demo has already been used.',
      });
    }

    let live = session;
    if (verdict.reason === 'not_started') {
      const startedAt = now();
      const expiresAt = expiryFor(startedAt, Number(session.duration_minutes) || 30);
      // `AND started_at IS NULL` is what makes two tabs clicking Start at
      // the same instant safe: the second UPDATE matches no row, both
      // then read back the SAME started_at/expires_at, and the demo
      // cannot be extended by racing it. Same reason a second click ten
      // minutes in does not buy ten more minutes -- it falls through to
      // the already-active branch below with the original expiry intact.
      await db.run(
        `UPDATE demo_sessions SET status = 'active', started_at = ?, expires_at = ?, last_activity_at = ?, updated_at = ?
          WHERE id = ? AND started_at IS NULL`,
        [startedAt, expiresAt, startedAt, startedAt, session.id]);
      await db.run(
        `UPDATE demo_requests SET status = 'approved', expires_at = ?, updated_at = ? WHERE id = ?`,
        [expiresAt, startedAt, session.demo_request_id]);
      live = await db.q1('SELECT * FROM demo_sessions WHERE id = ?', [session.id]);
      await trackDemoEvent(db, session.id, 'demo_started', { ip: requestIp(req) });
    }

    // Re-evaluate the row we actually ended up with -- never the one we
    // hoped to write.
    const finalVerdict = evaluateSession(live);
    if (!finalVerdict.ok) {
      return res.status(410).json({ error: 'demo_session_ended', reason: finalVerdict.reason, message: 'Your demo session has ended.' });
    }

    const resolved = await resolvePersona(db, live.demo_org_id, 'OWNER');
    if (!resolved) {
      // The tenant was never seeded, or was seeded and then wiped. Do not
      // hand out a token for a gym that does not exist -- and do not leak
      // why to the prospect.
      return res.status(503).json({ error: 'demo_unavailable', message: 'This demo is being prepared. Please try again shortly.' });
    }
    const org = await db.q1('SELECT id, name, slug FROM organizations WHERE id = ?', [live.demo_org_id]);
    const token = signDemoToken(resolved.user, { sessionId: live.id, persona: 'OWNER' });
    setAuthCookie(res, token);
    await trackDemoEvent(db, live.id, 'owner_mode_entered');
    res.json({ token, user: userView(resolved.user, org, 'OWNER'), session: publicSessionView(live) });
  });

  // ============================================================
  // PUBLIC -- conversion signal from a screen with no session left
  // ============================================================
  // The expiry screen's CTA is the single most valuable event a founder
  // can see, and by definition it happens when the session is already
  // dead -- so it cannot go through the authenticated /event route
  // below. Narrowed to exactly one event type so this cannot become a
  // general-purpose unauthenticated writer.
  r.post('/access/:token/event', tokenLimiter, validate(z.object({
    type: z.literal('cta_clicked'),
    data: z.object({ cta: z.string().max(60).optional() }).optional(),
  })), async (req, res) => {
    const session = await findSessionByToken(db, req.params.token);
    if (!session) return res.status(404).json({ error: 'invalid_link' });
    await trackDemoEvent(db, session.id, 'cta_clicked', req.body.data || null);
    res.json({ ok: true });
  });

  // ============================================================
  // DEMO SESSION REQUIRED
  // ============================================================
  // requireAuth has already verified the JWT, re-read the session row,
  // re-checked the expiry and confirmed the tenant matches (auth.js), so
  // by the time anything below runs, req.demoSession is a live session.
  // This guard only rejects an ordinary logged-in user who wandered onto
  // a demo route.
  const requireDemo = (req, res, next) => {
    if (!req.demoSession) return res.status(403).json({ error: 'not_a_demo_session' });
    next();
  };

  /** The countdown's periodic resync (spec 39). Cheap on purpose: one
   *  already-loaded row, no joins, no polling of anything else. The
   *  frontend renders from expiresAt and only calls this occasionally to
   *  correct drift and to notice a REVOCATION (which no amount of
   *  client-side arithmetic could ever discover on its own). */
  r.get('/session', requireAuth, requireDemo, async (req, res) => {
    res.json({
      ...publicSessionView(req.demoSession),
      persona: req.user.persona || 'OWNER',
      personas: DEMO_PERSONA_KEYS.map((k) => ({ key: k, label: DEMO_PERSONAS[k].label, name: DEMO_PERSONAS[k].name })),
    });
  });

  // ---- Owner -> Trainer -> Member, without touching a real account ----
  // The switch is a SERVER-SIDE re-mint: the new token is signed for a
  // real user row that already holds that role inside this demo tenant.
  // Nothing about the request chooses a role -- it chooses one of three
  // fixed personas, and resolvePersona re-checks that the account it
  // finds actually belongs to this session's org (personas.js). A demo
  // user cannot switch into SUPER_ADMIN because there is no persona for
  // it and no SUPER_ADMIN account inside the tenant to find.
  r.post('/switch-role', requireAuth, requireDemo,
    rateLimit({ windowMs: 60_000, max: 30, keyFn: (req) => req.user?.demo || requestIp(req) }),
    validate(z.object({ persona: z.enum(['OWNER', 'TRAINER', 'MEMBER']) })), async (req, res) => {
      const resolved = await resolvePersona(db, req.demoSession.demo_org_id, req.body.persona);
      if (!resolved) return res.status(404).json({ error: 'persona_unavailable', message: 'That demo identity is not available.' });
      const org = await db.q1('SELECT id, name, slug FROM organizations WHERE id = ?', [req.demoSession.demo_org_id]);
      // Same session id, so the clock is untouched: switching roles is
      // not a new demo and cannot be used to buy more time.
      const token = signDemoToken(resolved.user, { sessionId: req.demoSession.id, persona: req.body.persona });
      setAuthCookie(res, token);
      await trackDemoEvent(db, req.demoSession.id, `${req.body.persona.toLowerCase()}_mode_entered`);
      res.json({
        token,
        user: userView(resolved.user, org, req.body.persona),
        session: publicSessionView(req.demoSession),
      });
    });

  // ---- feature telemetry (spec 24) ----
  r.post('/event', requireAuth, requireDemo, eventLimiter, validate(z.object({
    type: z.string().max(64),
    data: z.record(z.any()).optional(),
  })), async (req, res) => {
    // Unknown event names are dropped rather than stored. The founder
    // dashboard renders "features visited" from a known set, and letting
    // a client invent names would make that list a reflection of the
    // frontend's typos instead of the product's surfaces.
    if (!DEMO_EVENT_TYPES.includes(req.body.type)) return res.json({ ok: true, ignored: true });
    await trackDemoEvent(db, req.demoSession.id, req.body.type, req.body.data || null);
    res.json({ ok: true });
  });

  // ---- the prospect ends it themselves ----
  // Distinct from expiry: 'completed' tells the founder the demo was
  // walked through to the end rather than abandoned or timed out, which
  // is a genuinely different conversion signal.
  r.post('/finish', requireAuth, requireDemo, async (req, res) => {
    await closeSession(db, req.demoSession, 'completed');
    await trackDemoEvent(db, req.demoSession.id, 'demo_completed');
    clearAuthCookie(res);
    res.json({ ok: true });
  });

  // ---- status of a session that has just ended ----
  // Called by /demo-expired with the token from the original link, so the
  // final screen can say WHY it ended (ran out vs revoked) and keep the
  // prospect's own name on it. Public because, by construction, there is
  // no session left to authenticate with.
  r.get('/ended/:token', tokenLimiter, async (req, res) => {
    const session = await findSessionByToken(db, req.params.token);
    if (!session) return res.status(404).json({ error: 'invalid_link' });
    // enforceSession, not evaluateSession: if this is the first request
    // after the clock ran out, persist that before answering, so the
    // founder's list and this screen agree.
    const verdict = await enforceSession(db, session.id);
    const request = await db.q1('SELECT owner_name, gym_name FROM demo_requests WHERE id = ?', [session.demo_request_id]);
    res.json({
      state: verdict.state,
      reason: verdict.reason,
      ownerName: request?.owner_name || null,
      gymName: request?.gym_name || null,
    });
  });

  return r;
}
