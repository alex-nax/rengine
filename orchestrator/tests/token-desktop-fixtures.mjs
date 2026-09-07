import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { forward, tunnel } from '../runtime/protocol.mjs';

/* A stand-in for the workspace worker's half of the project token (spec 095, stages 2 and 3).
 *
 * The desktop learns of the ledger, and answers it, on the `/events` socket it already holds, and
 * the worker intercepts those frames before forwarding — exactly as it already intercepts
 * `desktop-register`. Stage 2 builds that interception for real; this fixture is the same shape and
 * nothing more: it proxies the session host, keeps the frames the desktop sends it, and pushes the
 * ledger's own frames back. It holds no ledger, so a `token-action` here changes nothing on its
 * own; the test says what the ledger answers next. */

export function tokenFrame({ rootId, holder = null, contest = null, windowMs = 60000, sequence = 1 }) {
  return { type: 'token', rootId, holder, contest, windowMs, sequence };
}

export function contestFrame({ id, label = 'codex', agentId = '11111111-1111-4111-8111-111111111111', pid = 4242, seconds = 60, reason = '' }) {
  const now = Date.now();
  return { id, contester: { agentId, label, pid }, openedAt: new Date(now).toISOString(),
    deadline: new Date(now + seconds * 1000).toISOString(), reason };
}

export async function startTokenSidecar(host, { intercept = ['token-action', 'recording'] } = {}) {
  const received = [], clients = new Set();
  let url;
  const server = http.createServer((request, response) => forward(request, response, host));
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    const target = new URL(request.url, 'http://127.0.0.1');
    if (target.pathname !== '/events') { tunnel(request, socket, head, host, () => {}); return; }
    sockets.handleUpgrade(request, socket, head, client => {
      const remote = new URL(request.url, host.url); remote.protocol = 'ws:'; remote.searchParams.set('token', host.token);
      const upstream = new WebSocket(remote);
      const queued = [];
      clients.add(client);
      client.on('error', () => {}); upstream.on('error', () => client.close(1011, 'fixture upstream'));
      client.once('close', () => { clients.delete(client); upstream.terminate(); });
      upstream.once('close', () => client.close());
      upstream.once('open', () => { for (const bytes of queued.splice(0)) upstream.send(bytes); });
      upstream.on('message', bytes => { if (client.readyState === WebSocket.OPEN) client.send(bytes); });
      client.on('message', bytes => {
        let data; try { data = JSON.parse(bytes.toString()); } catch { data = null; }
        if (data && intercept.includes(data.type)) { received.push(data); return; }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes); else queued.push(bytes);
      });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, token: host.token, instance: host.instance, received,
    of: type => received.filter(frame => frame.type === type),
    push(frame) {
      const bytes = JSON.stringify(frame);
      for (const client of clients) if (client.readyState === WebSocket.OPEN) client.send(bytes);
      return bytes;
    },
    async settled() { for (let i = 0; i < 40 && clients.size === 0; i++) await delay(50); return clients.size; },
    /* Drop the live channel the way a replaced worker does, so the desktop sees its own
       `disconnected` rather than being told about one. */
    drop() { for (const client of clients) client.terminate(); clients.clear(); },
    async waitFor(predicate, label = 'a frame from the desktop') {
      for (let i = 0; i < 200; i++) { if (received.some(predicate)) return received.find(predicate); await delay(50); }
      throw new Error(`${label} never arrived: ${JSON.stringify(received)}`);
    },
    async close() {
      for (const client of clients) client.terminate();
      sockets.close();
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}
