// ============================================================
// DEMO PERSONAS -- the three fictional identities a prospect steps
// through during a demo, and the ONLY three the role switcher can ever
// land on.
//
// Identified by email, not by id: the seeder rebuilds the demo tenant's
// rows from scratch on every reset (see seed.js), so ids are not stable
// across a reset but these addresses are. Resolving a persona always
// goes through resolvePersona() below, which re-reads the user row from
// the database AND re-checks that it still belongs to the session's own
// demo org -- a persona is never trusted from a token claim, a request
// body, or anything else the client can influence.
//
// The .demo TLD is reserved/unroutable on purpose: no mail can ever be
// delivered to these addresses, and none of them can be confused with a
// real customer's. They also carry an unusable password hash (seed.js),
// so POST /auth/login can never authenticate as one -- the ONLY way into
// these accounts is a founder-approved, unexpired demo session.
// ============================================================

/** Email domain every demo identity lives under. Anything at this domain
 *  is demo-tenant furniture, never a real person. */
export const DEMO_EMAIL_DOMAIN = 'befitter.demo';

/** The role switcher's three stops, in the order the UI offers them.
 *  `role` is the users.role value each persona actually holds -- the
 *  switcher hands out a token for an EXISTING account with that role, it
 *  never elevates anyone. */
export const DEMO_PERSONAS = Object.freeze({
  OWNER: Object.freeze({
    key: 'OWNER', role: 'GYM_OWNER', email: `kirthi@${DEMO_EMAIL_DOMAIN}`,
    label: 'Gym Owner', name: 'Kirthi',
  }),
  TRAINER: Object.freeze({
    key: 'TRAINER', role: 'TRAINER', email: `arjun@${DEMO_EMAIL_DOMAIN}`,
    label: 'Trainer', name: 'Arjun Deshpande',
  }),
  MEMBER: Object.freeze({
    key: 'MEMBER', role: 'CLIENT', email: `aarav.sharma@${DEMO_EMAIL_DOMAIN}`,
    label: 'Member', name: 'Aarav Sharma',
  }),
});

export const DEMO_PERSONA_KEYS = Object.freeze(Object.keys(DEMO_PERSONAS));

/** Resolve a persona key to the live user row inside ONE specific demo
 *  org. Returns null for an unknown key, a missing account, or -- the
 *  case that actually matters -- an account that exists but belongs to a
 *  different org than the demo session grants access to. That last check
 *  is what stops a crafted /demo/switch-role call from ever handing back
 *  a token for anything outside its own demo tenant, even if these
 *  constants were somehow edited to point at a real address. */
export async function resolvePersona(db, orgId, personaKey) {
  const persona = DEMO_PERSONAS[String(personaKey || '').toUpperCase()];
  if (!persona || !orgId) return null;
  const user = await db.q1(
    'SELECT * FROM users WHERE email = ? AND org_id = ? AND role = ? AND active = 1',
    [persona.email, orgId, persona.role]);
  if (!user) return null;
  return { persona, user };
}
