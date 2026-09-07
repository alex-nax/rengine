import http from 'node:http';
import { openScript } from './scripts.mjs';
import { listFormats, formatPreview, readBytes, readDeclaration } from '../server/formats.mjs';
import { dashboardAction, dashboardActions, dashboardRunPayload, dashboardCapture } from '../server/dashboard.mjs';
import { inspectGame } from '../server/games.mjs';
import { projectDevices } from '../server/devices.mjs';
import { listRecordings, readRecording } from '../server/recordings.mjs';
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
  /* Preflight runs here, from this checkout, exactly as the dashboard does; only the launch needs
     the retained host, which owns the PTY and the embedded surface. See sidecar: game-routes. */
  const preflight = (rootId, gameId) => inspectGame(root(rootId), gameId);
  const capabilities = ({ projectGameLaunch, ...rest }) => ({ ...rest, desktopActions: 1, layeredUpdates: 1, scriptActions: 1,
    formatRegistry: 1, dashboard: 1, projectGame: 1, recordings: 1, projectDevices: 1, ...(rest.projectGame === 1 ? { projectGameLaunch: 1 } : {}) });
  /* Refused here, from the worker's own preflight, before anything reaches the retained host: the
     spec-078 / KI-043 lesson is that the host must not be the one to answer. See sidecar: remote-launch. */
  const refuseRemote = async (rootId, gameId) => {
    const config = await preflight(rootId, gameId);
    if (config.refusal) fail(config.refusal, 409);
  };
  const launch = payload => {
    if (bindings.capabilities?.projectGame !== 1) {
      fail('This retained session host predates per-project game declarations and would launch its removed built-in game; game_preflight answers from the declaration. Replacing the session host requires quiescence.', 409);
    }
    return call(host, 'game', payload);
  };
  const server = http.createServer(async (req, res) => {
    try {
      const target = new URL(req.url, 'http://127.0.0.1');
      if (target.pathname === '/health') { json(res, 200, { protocol: 1, instance: host.instance, worker: process.pid }); return; }
      if (!authenticated(req, token, url)) fail('Workspace authentication required.', 401);
      if (req.method === 'GET' && target.pathname === '/api/state') {
        const state = await refresh(); json(res, 200, { ...state, capabilities: capabilities(state.capabilities) });
      } else if (req.method === 'POST' && target.pathname === '/api/script-open') {
        const data = await body(req), state = await refresh(); json(res, 200, await openScript(host, desktops, data, state));
      } else if (req.method === 'POST' && target.pathname === '/api/session-view') {
        const data = await body(req); await refresh();
        json(res, 200, await desktops.attach(data.rootId, data.desktopId, snapshot(data.id)));
      } else if (req.method === 'GET' && target.pathname === '/api/formats') {
        await refresh(); json(res, 200, await listFormats(root(target.searchParams.get('rootId'))));
      } else if (req.method === 'POST' && target.pathname === '/api/format-preview') {
        const data = await body(req); await refresh(); json(res, 200, await formatPreview(root(data.rootId), data));
      } else if (req.method === 'GET' && target.pathname === '/api/bytes') {
        await refresh(); json(res, 200, await readBytes(root(target.searchParams.get('rootId')), Object.fromEntries(target.searchParams)));
      } else if (req.method === 'GET' && target.pathname === '/api/game-config') {
        await refresh(); json(res, 200, await preflight(target.searchParams.get('rootId'), target.searchParams.get('gameId') ?? undefined));
      } else if (req.method === 'GET' && target.pathname === '/api/devices') {
        await refresh();
        const selected = root(target.searchParams.get('rootId'));
        json(res, 200, await projectDevices(selected, await readDeclaration(selected),
          { refresh: target.searchParams.get('refresh') === '1', preflight, resolve: () => dashboardActions(selected, preflight) }));
      } else if (req.method === 'POST' && target.pathname === '/api/game') {
        const data = await body(req); await refresh();
        await refuseRemote(data.rootId, data.gameId ?? undefined);
        json(res, 200, await launch({ rootId: data.rootId, ...(data.gameId === undefined ? {} : { gameId: data.gameId }), ...(data.args === undefined ? {} : { args: data.args }) }));
      } else if (req.method === 'GET' && target.pathname === '/api/recordings') {
        await refresh(); json(res, 200, await listRecordings(root(target.searchParams.get('rootId')), Object.fromEntries(target.searchParams)));
      } else if (req.method === 'GET' && target.pathname === '/api/recording') {
        await refresh();
        json(res, 200, await readRecording(root(target.searchParams.get('rootId')), target.searchParams.get('id'), Object.fromEntries(target.searchParams)));
      } else if (req.method === 'GET' && target.pathname === '/api/dashboard') {
        await refresh(); json(res, 200, await dashboardActions(root(target.searchParams.get('rootId')), preflight));
      } else if (req.method === 'POST' && target.pathname === '/api/dashboard-run') {
        const data = await body(req); await refresh();
        const selected = root(data.rootId), action = await dashboardAction(selected, data.actionId, preflight);
        if (action.kind === 'game') {
          await refuseRemote(selected.id, action.game);
          json(res, 200, await launch({ rootId: selected.id, gameId: action.game, args: action.args ?? [] })); return;
        }
        const payload = await dashboardRunPayload(selected, action);
        json(res, 200, { ...await call(host, 'terminal', payload), title: payload.title }); /* the retained host may predate session titles */
      } else if (req.method === 'POST' && target.pathname === '/api/dashboard-capture') {
        const data = await body(req); await refresh(); json(res, 200, await dashboardCapture(root(data.rootId), data.actionId, preflight));
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
