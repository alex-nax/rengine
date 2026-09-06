import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { Desktops } from '../server/desktops.mjs';
import { request as call } from '../launcher/sidecar.mjs';
import { authenticated, body, checkConnection, fail, forward, json } from './protocol.mjs';

export async function startWorker(host) {
  checkConnection(host);
  const state = await call(host, 'state');
  if (state.instance !== host.instance) fail('Session host identity changed.');
  let bindings = state, url;
  const token = randomBytes(32).toString('hex');
  const root = id => bindings.roots.find(x => x.id === id) ?? fail('Unknown project root.', 404);
  const snapshot = id => bindings.sessions.find(x => x.id === id) ?? fail('Unknown session.', 404);
  const desktops = new Desktops({ root }, { snapshot });
  const refresh = async () => { const state = await call(host, 'state'); if (state.instance !== host.instance) fail('Session host identity changed.'); bindings = state; return state; };
  const server = http.createServer(async (req, res) => {
    try {
      const target = new URL(req.url, 'http://127.0.0.1');
      if (target.pathname === '/health') { json(res, 200, { protocol: 1, instance: host.instance, worker: process.pid }); return; }
      if (!authenticated(req, token, url)) fail('Workspace authentication required.', 401);
      if (req.method === 'GET' && target.pathname === '/api/state') {
        const state = await refresh(); json(res, 200, { ...state, capabilities: { ...state.capabilities, desktopActions: 1, layeredUpdates: 1 } });
      } else if (req.method === 'GET' && target.pathname === '/api/desktops') {
        await refresh(); json(res, 200, { desktops: desktops.list(target.searchParams.get('rootId')) });
      } else if (req.method === 'GET' && target.pathname === '/api/runtime-desktops') {
        json(res, 200, { desktops: [...desktops.clients.values()].map(({ socket, ...desktop }) => desktop) });
      } else if (req.method === 'POST' && target.pathname === '/api/desktop-action') {
        const data = await body(req); await refresh();
        if (data.action !== 'reload') fail('Unknown desktop action.');
        json(res, 200, await desktops.reload(data.rootId, data.desktopId));
      } else forward(req, res, host);
    } catch (error) { if (!res.headersSent) json(res, error.status ?? 500, { error: error.message }); else res.destroy(); }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const target = new URL(req.url, 'http://127.0.0.1');
    req.headers.authorization = `Bearer ${target.searchParams.get('token')}`;
    if (!['/events', '/surface'].includes(target.pathname) || !authenticated(req, token, url)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
    }
    sockets.handleUpgrade(req, socket, head, client => {
      const remote = new URL(req.url, host.url); remote.protocol = 'ws:'; remote.searchParams.set('token', host.token);
      const upstream = new WebSocket(remote); let chain = Promise.resolve();
      const opened = new Promise((resolve, reject) => { upstream.once('open', resolve); upstream.once('error', reject); });
      opened.catch(() => client.close(1011, 'Session host unavailable'));
      const send = (destination, bytes, binary = false) => {
        if (destination.readyState !== WebSocket.OPEN) return;
        if (destination.bufferedAmount > 4 * 1024 * 1024) destination.close(1013, 'Reconnect to retained session');
        else destination.send(bytes, { binary });
      };
      client.on('error', () => {}); upstream.on('error', () => client.close(1011, 'Session host disconnected'));
      client.once('close', () => upstream.terminate()); upstream.once('close', () => client.close());
      upstream.on('message', (bytes, binary) => send(client, bytes, binary));
      client.on('message', (bytes, binary) => {
        chain = chain.then(async () => {
          await opened;
          if (target.pathname === '/events') {
            const data = JSON.parse(bytes);
            if (data.type === 'desktop-register') { await refresh(); desktops.register(client, data); return; }
            if (data.type === 'desktop-action-result') { desktops.acknowledge(client, data); return; }
          }
          send(upstream, bytes, binary);
        }).catch(error => send(client, JSON.stringify({ type: 'error', error: error.message })));
      });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  url = `http://127.0.0.1:${server.address().port}`;
  return { url, token, instance: host.instance, pid: process.pid, async close() {
    for (const client of sockets.clients) client.terminate(); sockets.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  } };
}
if (process.send) {
  process.once('message', async message => {
    try {
      const worker = await startWorker(message.host);
      process.send({ type: 'ready', url: worker.url, token: worker.token, instance: worker.instance, pid: process.pid });
      process.on('message', async message => { if (message.type === 'close') { await worker.close(); process.exit(0); } });
      process.on('disconnect', async () => { await worker.close(); process.exit(0); });
    } catch (error) { process.send({ type: 'failed', error: error.message }); process.exitCode = 1; process.disconnect(); }
  });
}
