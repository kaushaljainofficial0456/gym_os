// ============================================================
// eSSL / ZKTeco BIOMETRIC DEVICES — the ADMS "iclock" push protocol.
//
// Most Indian gyms already have one: an eSSL (ZKTeco-made) fingerprint or
// face terminal at reception. Those devices do not call webhooks and do
// not expose an API. What they do -- every one shipped in the last decade
// -- is PUSH their attendance log to a server configured on the device
// ("Cloud Server Setting" / "ADMS"), over plain HTTP(S), using a protocol
// ZKTeco publishes as the Push SDK:
//
//   GET  /iclock/cdata?SN=<serial>&options=all   handshake; we answer with
//                                                which tables we want
//   POST /iclock/cdata?SN=<serial>&table=ATTLOG  attendance lines, one per
//                                                punch, tab-separated:
//        <PIN>\t<YYYY-MM-DD HH:MM:SS>\t<status>\t<verify>\t<workcode>...
//   GET  /iclock/getrequest?SN=<serial>          poll for commands ("OK")
//   POST /iclock/devicecmd?SN=<serial>           command results  ("OK")
//
// The device keeps resending a batch until it gets "OK: <n>", so ingestion
// has to be idempotent -- and is: each punch's id is derived from the
// serial, the PIN and the device's own timestamp.
//
// WHAT WE ASK FOR, AND WHAT WE REFUSE.
// The handshake asks for the attendance log only (TransFlag=AttLog). The
// same protocol can carry fingerprint templates (FPLOG/BIODATA), face
// templates and punch photos; if a device sends any of those anyway they
// are acknowledged -- so it stops resending -- and discarded unread. This
// codebase never stores biometric material (see providers/index.js).
//
// HOW MUCH TO TRUST IT. ADMS has no signature: a device identifies itself
// by its serial number, which is printed on its label. So:
//   - only serials registered to an eSSL connection are accepted at all;
//   - a connection can pin the gym's public IP (allowed_ips);
//   - every event is stored as 'unverified', never 'verified'.
// That is weaker than the signed webhook, and the owner UI says so.
//
// TIME. Punch times are the DEVICE's wall clock, with no zone. They are
// read in the gym's timezone (the device is set to local time at install)
// and stored in UTC like every other event. A device whose clock has run
// ahead produces punches "in the future", which would wedge the presence
// state machine; those are refused and the clock problem reported.
//
// Built to the published protocol. Firmware differs between models, so the
// connection is labelled beta until it has been confirmed on the gym's own
// device -- the device's first handshake shows up as "last seen".
// ============================================================

/** Tables we acknowledge but never read: biometric templates and photos. */
export const BIOMETRIC_TABLES = new Set([
  'FPLOG', 'FINGERTMP', 'BIODATA', 'FACE', 'FVEIN', 'BIOPHOTO', 'USERPIC', 'ATTPHOTO',
]);

/** How far ahead of the server clock a punch may be before it is refused. */
export const MAX_CLOCK_AHEAD_MS = 15 * 60 * 1000;

const LOCAL_TS = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * ATTLOG body -> punches. Tolerates the variations firmware actually sends:
 * tabs or runs of spaces, CRLF, trailing blank lines, missing trailing
 * fields. A line that does not parse is counted, not guessed at.
 */
export function parseAttlog(body) {
  const punches = [];
  let bad = 0;
  for (const raw of String(body || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split('\t').length >= 2 ? line.split('\t') : line.split(/\s{2,}|\s(?=\d{4}-\d{2}-\d{2})/);
    const pin = String(cols[0] || '').trim();
    const when = String(cols[1] || '').trim();
    if (!pin || !LOCAL_TS.test(when)) { bad += 1; continue; }
    punches.push({
      pin,
      local: when.length === 16 ? `${when}:00` : when.replace('T', ' '),
      status: cols[2] != null && cols[2] !== '' ? Number(cols[2]) : null,
      verify: cols[3] != null && cols[3] !== '' ? Number(cols[3]) : null,
    });
  }
  return { punches, bad };
}

/** Offset of `tz` from UTC at instant `ms`, in ms (IST -> +19800000). */
function tzOffsetMs(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * "2026-10-20 07:15:02" on a device in `tz` -> the UTC instant, as ISO.
 * Two passes so a wall time near a DST change resolves to the offset in
 * force AT that time, not the offset now. Null for an impossible time.
 */
export function localToUtcIso(local, tz) {
  const m = LOCAL_TS.exec(String(local || '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '0'] = m;
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  if (!Number.isFinite(wall)) return null;
  let utc = wall - tzOffsetMs(wall, tz);
  utc = wall - tzOffsetMs(utc, tz);
  const out = new Date(utc);
  return Number.isNaN(out.getTime()) ? null : out.toISOString();
}

/**
 * Which way a punch went.
 *
 * A reader installed as an entry-only or exit-only door says so itself, and
 * that beats the status key a member may or may not have pressed. On a
 * both-way terminal the device's own state decides: 0 check-in, 1
 * check-out (2-5 are break/overtime states, which a gym has no use for).
 * In 'toggle' mode -- one terminal, members punch on the way in AND out,
 * nobody presses a key -- a punch while inside is the way out.
 */
export function punchDirection({ status, device, punchMode = 'status', isInside = false }) {
  if (device?.direction === 'entry') return 'ENTRY';
  if (device?.direction === 'exit') return 'EXIT';
  if (punchMode === 'toggle') return isInside ? 'EXIT' : 'ENTRY';
  if (status === 1 || status === 5) return 'EXIT';
  if (status === 0 || status === 4 || status == null || status === 255) return 'ENTRY';
  return 'UNKNOWN';
}

/**
 * The handshake answer: what to send and how often. Asks for the
 * attendance log only, in real time, retrying every 30 s on error.
 */
export function handshakeResponse(sn) {
  return [
    `GET OPTION FROM: ${sn}`,
    'ATTLOGStamp=None',
    'OPERLOGStamp=9999',
    'ATTPHOTOStamp=9999',
    'ErrorDelay=30',
    'Delay=10',
    'TransTimes=00:00;14:05',
    'TransInterval=1',
    'TransFlag=TransData AttLog',
    'Realtime=1',
    'Encrypt=None',
    '',
  ].join('\r\n');
}

/**
 * The address the device connected from, for IP pinning.
 *
 * The RIGHTMOST X-Forwarded-For entry, not the first: a proxy appends the
 * address it saw, so the first entry is whatever the sender chose to write
 * and the last is the one our own edge added. On Vercel the header holds
 * only the client's address (the edge overwrites it); behind one appending
 * proxy the last entry is that proxy's view of the device. With no header
 * at all it is the socket's. Pinning is defence in depth on top of the
 * registered serial -- every ADMS event is stored 'unverified' regardless.
 */
export function clientIp(req) {
  const hops = String(req.headers?.['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  const ip = hops.at(-1) || req.ip || req.socket?.remoteAddress || '';
  return ip.replace(/^::ffff:/, '');
}

/** One punch's identity: the device resends a batch until acknowledged, so
 *  the same serial, PIN and device time must always be the same event. */
export function punchEventId(sn, punch) {
  return `adms:${sn}:${punch.pin}:${punch.local}`;
}

/** allowed_ips from a connection's config: "203.0.113.7, 198.51.100.0" -> Set. */
export function allowedIps(config) {
  const list = String(config?.allowed_ips || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  return list.length ? new Set(list) : null;
}
