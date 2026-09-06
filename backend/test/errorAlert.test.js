// ============================================================
// REMEDIATION: error-alerting webhook (services/errorAlert.js).
// ERROR_ALERT_WEBHOOK_URL is read once at module-load time (same
// constant-at-import pattern as every other env-gated module in this
// codebase -- paymentProvider.js, aiProvider.js), so exercising both the
// "configured" and "unconfigured" states needs the same subprocess
// convention already used throughout this suite.
//
// The mock HTTP server and the sendErrorAlert() call under test BOTH run
// INSIDE the same spawned child process (never split across the parent/
// child boundary) -- a spawned child in this sandbox cannot reach a
// socket bound in the parent process, only its own. Same
// server-in-the-child shape mlSkosCalV1.test.js's own HTTP-level tests
// already use.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, '..', 'src', 'services', 'errorAlert.js').replace(/\\/g, '/');

function run(code, extraEnv) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { PATH: process.env.PATH, ...extraEnv }, encoding: 'utf8', timeout: 10000,
  });
  return { status: child.status, stdout: child.stdout || '', stderr: child.stderr || '' };
}

test('unconfigured (no ERROR_ALERT_WEBHOOK_URL): sendErrorAlert is a complete no-op, never throws', () => {
  const r = run(`
    const { sendErrorAlert, errorAlertingConfigured } = await import('file://${modulePath}');
    console.log('configured:' + errorAlertingConfigured());
    await sendErrorAlert({ kind: 'server_error', message: 'boom' });
    console.log('OK');
  `, { ERROR_ALERT_WEBHOOK_URL: undefined });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /configured:false/);
  assert.match(r.stdout, /OK/);
});

// The mock server, the webhook URL pointing at it, AND the sendErrorAlert()
// call all run inside ONE child process -- see this file's own header.
// ERROR_ALERT_WEBHOOK_URL can't be set in advance (the port is only known
// once the server is listening), so this sets process.env itself before
// dynamically importing the module, rather than passing it via spawnSync's
// env option like the other tests here.
test('configured: POSTs a JSON payload with both Slack-style `text` and structured fields; never sends a raw stack trace', () => {
  const r = run(`
    const http = await import('node:http');
    const received = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { received.push(JSON.parse(body)); res.writeHead(200); res.end('ok'); });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.ERROR_ALERT_WEBHOOK_URL = 'http://127.0.0.1:' + server.address().port + '/hook';

    const { sendErrorAlert } = await import('file://${modulePath}');
    const fakeStack = 'Error: boom\\n    at secretInternalFunction (/very/sensitive/path.js:42:1)';
    // stack is passed to prove the module never reaches for it even if a
    // caller mistakenly attaches one -- only .message is ever sent.
    await sendErrorAlert({ kind: 'server_error', message: 'Something broke', path: '/api/clients/123', method: 'GET', status: 500, reqId: 'req_abc', stack: fakeStack });

    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    console.log('RESULT_JSON:' + JSON.stringify(received));
  `);
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT_JSON:'));
  assert.ok(line, `expected a RESULT_JSON line in stdout: ${r.stdout}`);
  const received = JSON.parse(line.slice('RESULT_JSON:'.length));

  assert.equal(received.length, 1, 'exactly one POST must have been delivered');
  const body = received[0];
  assert.equal(body.service, 'sk-os');
  assert.equal(body.kind, 'server_error');
  assert.equal(body.message, 'Something broke');
  assert.equal(body.path, '/api/clients/123');
  assert.equal(body.status, 500);
  assert.equal(body.reqId, 'req_abc');
  assert.match(body.text, /\[sk-os\] server_error: Something broke/, 'a Slack/Discord-compatible top-level text field must exist');
  assert.ok(body.timestamp, 'must carry a timestamp');

  const payloadText = JSON.stringify(body);
  assert.doesNotMatch(payloadText, /secretInternalFunction|sensitive\/path/, 'a stack trace must never appear in the outbound payload, even if a caller mistakenly attaches one');
});

test('configured but unreachable: sendErrorAlert still never throws (fails silently, logs to stderr)', () => {
  // A real, resolvable-but-refusing loopback port (not spawning a server
  // at all) -- this test is specifically about the CALLER's contract
  // (never throw), not about timeout behavior, so it should resolve
  // quickly via ECONNREFUSED rather than waiting out the 5s abort budget.
  const r = run(`
    const { sendErrorAlert } = await import('file://${modulePath}');
    try {
      await sendErrorAlert({ kind: 'server_error', message: 'boom' });
      console.log('NO_THROW');
    } catch (e) {
      console.log('THREW:' + e.message);
    }
  `, { ERROR_ALERT_WEBHOOK_URL: 'http://127.0.0.1:1/unreachable-port' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /NO_THROW/, 'a broken webhook must never surface as a thrown error to the caller');
});
