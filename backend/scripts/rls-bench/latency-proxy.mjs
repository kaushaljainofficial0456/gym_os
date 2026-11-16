// TCP proxy adding a fixed ONE-WAY delay in each direction (RTT += 2*delay).
// Busy-polls with setImmediate because Windows timers tick at ~15 ms.
import net from 'node:net';
const [listenPort, targetPort, oneWayMs] = process.argv.slice(2).map(Number);
const q = []; // constant delay keeps FIFO order per socket
function pump() {
  const t = performance.now();
  while (q.length && q[0].at <= t) { const x = q.shift(); if (!x.sock.destroyed) x.sock.write(x.buf); }
  setImmediate(pump);
}
pump();
net.createServer((client) => {
  const server = net.connect(targetPort, '127.0.0.1');
  client.setNoDelay(true); server.setNoDelay(true);
  client.on('data', (b) => q.push({ at: performance.now() + oneWayMs, sock: server, buf: b }));
  server.on('data', (b) => q.push({ at: performance.now() + oneWayMs, sock: client, buf: b }));
  const end = () => { client.destroy(); server.destroy(); };
  client.on('error', end); server.on('error', end); client.on('close', end); server.on('close', end);
}).listen(listenPort, '127.0.0.1', () => console.log(`proxy ${listenPort} -> ${targetPort} one-way ${oneWayMs} ms`));
