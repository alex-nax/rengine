import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { forward, tunnel } from '../runtime/protocol.mjs';

/* A stand-in for the worker half of spec 103 decision 5, built the way stage 3 of spec 095 built
 * its own: the routes the Tasks pane's controls call are pinned here and nothing more is invented.
 *
 * It proxies the session host, so the desktop connects, registers and lays out for real, and it
 * serves three routes itself:
 *   GET  /api/tracker      the rows the pane draws, with the provider that decides which controls
 *                          a row may carry — a remote provider is served here rather than signed
 *                          in to, because what is under test is the pane, not an OAuth round trip
 *   GET  /api/agents-menu  { rootId, declared, agents: [{ cli, installed, models, default }], live: [{ sessionId, conversation, label, task }] }
 *   POST /api/agent-spawn  { rootId, taskKey, agent, model?, brief, desktopId } -> { rootId, taskKey, agent,
 *                          model, brief, conversation, session, sequence, view?, detail? }
 * and it answers `/api/state` with the capabilities the test chooses folded into the host's own,
 * because the worker layer is what advertises `agentsMenu`, `agentSpawn` and `taskWrites` and this
 * fixture stands in for that layer.
 * and it keeps every `token-action` frame the desktop sends on `/events` instead of forwarding it.
 *
 * It holds no ledger and starts no agent: a spawn recorded here changes nothing, exactly as a
 * `token-action` recorded by the token fixture changes nothing. The worker lane owns both. */
export async function startTasksSidecar(host, { tracker = { provider: 'local', rows: [] }, menu = { agents: [], live: [] },
                                                capabilities = { agentsMenu: 1, agentSpawn: 1, taskWrites: 1 }, spawn = null } = {}) {
  const spawns = [], frames = [], clients = new Set();
  let rows = tracker, offered = menu, refreshes = 0;
  const answer = (response, status, value) => {
    const text = JSON.stringify(value);
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    response.end(text);
  };
  const server = http.createServer((request, response) => {
    const target = new URL(request.url, 'http://127.0.0.1');
    if (target.pathname === '/api/state') {
      fetch(new URL(request.url, host.url), { headers: { authorization: `Bearer ${host.token}` } })
        .then(upstream => upstream.json())
        .then(state => answer(response, 200, { ...state, capabilities: { ...state.capabilities, ...capabilities } }))
        .catch(error => answer(response, 502, { error: error.message }));
      return;
    }
    if (target.pathname === '/api/tracker') {
      if (target.searchParams.get('refresh') === '1') refreshes++;
      answer(response, 200, { fresh: true, checkedAt: new Date().toISOString(), ...rows });
      return;
    }
    if (target.pathname === '/api/agents-menu') { answer(response, offered.status ?? 200, offered.body ?? offered); return; }
    if (target.pathname === '/api/agent-spawn') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        let data; try { data = JSON.parse(body); } catch { data = { unparsed: body }; }
        spawns.push(data);
        const reply = spawn?.(data, spawns.length) ?? {};
        answer(response, reply.status ?? 200, reply.body ?? {
          rootId: data.rootId, taskKey: data.taskKey, agent: data.agent, model: data.model ?? null, brief: data.brief,
          conversation: `conversation-${spawns.length}`, session: { id: `spawned-${spawns.length}` }, sequence: spawns.length,
        });
      });
      return;
    }
    forward(request, response, host);
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    const target = new URL(request.url, 'http://127.0.0.1');
    if (target.pathname !== '/events') { tunnel(request, socket, head, host, () => {}); return; }
    sockets.handleUpgrade(request, socket, head, client => {
      const remote = new URL(request.url, host.url); remote.protocol = 'ws:'; remote.searchParams.set('token', host.token);
      const upstream = new WebSocket(remote);
      const queued = [];
      /* A text frame relayed as a binary one is dropped by the desktop's socket reader, which sorts
         binary frames into the game's frame buffer and only parses text as JSON. The proxy keeps
         each frame's own kind so `desktop-registered` still reaches the window that asked. */
      clients.add(client);
      client.on('error', () => {}); upstream.on('error', () => client.close(1011, 'fixture upstream'));
      client.once('close', () => { clients.delete(client); upstream.terminate(); });
      upstream.once('close', () => client.close());
      upstream.once('open', () => { for (const [bytes, binary] of queued.splice(0)) upstream.send(bytes, { binary }); });
      upstream.on('message', (bytes, binary) => { if (client.readyState === WebSocket.OPEN) client.send(bytes, { binary }); });
      client.on('message', (bytes, binary) => {
        let data; try { data = binary ? null : JSON.parse(bytes.toString()); } catch { data = null; }
        if (data && data.type === 'token-action') { frames.push(data); return; }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes, { binary }); else queued.push([bytes, binary]);
      });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const settle = async (predicate, label, source) => {
    for (let i = 0; i < 200; i++) { const hit = source().find(predicate); if (hit) return hit; await delay(50); }
    throw new Error(`${label} never arrived: ${JSON.stringify(source())}`);
  };
  return {
    url, token: host.token, instance: host.instance, spawns, frames,
    refreshes: () => refreshes,
    setTracker(next) { rows = next; },
    setMenu(next) { offered = next; },
    /* The desktop's own id, as the workspace minted it at registration: the spawn body names the
       window that asked, and a test that assumes it would not notice the desktop sending none. */
    async desktop(rootId) {
      for (let i = 0; i < 200; i++) {
        const response = await fetch(`${url}/api/desktops?rootId=${rootId}`, { headers: { authorization: `Bearer ${host.token}` } });
        const listed = await response.json();
        if (listed.desktops?.length) return listed.desktops[0].id;
        await delay(50);
      }
      throw new Error('the desktop never registered with the workspace');
    },
    async settled() { for (let i = 0; i < 40 && clients.size === 0; i++) await delay(50); return clients.size; },
    waitForSpawn: (predicate = () => true, label = 'an agent-spawn body') => settle(predicate, label, () => spawns),
    waitForFrame: (predicate = () => true, label = 'a token-action frame') => settle(predicate, label, () => frames),
    async close() {
      for (const client of clients) client.terminate();
      sockets.close();
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}
