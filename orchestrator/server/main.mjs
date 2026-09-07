import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { WorkspaceStore, fail } from './store.mjs';
import { Sessions } from './sessions.mjs';
import { Games } from './games.mjs';
import { readImage } from './images.mjs';
import { Desktops } from './desktops.mjs';
import { listFormats, formatPreview, readBytes, readDeclaration } from './formats.mjs';
import { dashboardAction, dashboardActions, dashboardRunPayload, dashboardCapture } from './dashboard.mjs';
import { projectDevices } from './devices.mjs';
import { projectTracker } from './tracker.mjs';
import { revoke as revokeSignIn, signIn as trackerSignIn } from './tracker-auth.mjs';
import { listRecordings, readRecording } from './recordings.mjs';

const authorized = (value, token) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(token));

async function body(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) fail('Expected application/json.', 415);
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 8 * 1024 * 1024) fail('Request body is too large.', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('Malformed JSON.'); }
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}

// Loopback authentication is required — see sidecar: local-session-capability.
export async function startServer({ stateDir, port = 0 } = {}) {
  if (!stateDir) fail('The sidecar requires an explicit state directory.');
  stateDir = path.resolve(stateDir);
  const store = await WorkspaceStore.open(stateDir);
  const sessions = new Sessions(store);
  const desktops = new Desktops(store, sessions);
  const games = await Games.open(store, sessions);
  const preflight = (rootId, gameId) => games.inspect(rootId, gameId);
  const token = randomBytes(32).toString('hex');
  const instance = randomUUID();
  let url;
  const server = http.createServer(async (request, response) => {
    try {
      const target = new URL(request.url, 'http://127.0.0.1');
      if (request.headers.origin && request.headers.origin !== url) fail('Origin is not this workspace.', 403);
      if (target.pathname === '/health') { json(response, 200, { protocol: 1, instance }); return; }
      if (target.pathname.startsWith('/api/')) {
        if (!authorized(request.headers.authorization?.replace(/^Bearer /, ''), token)) fail('Workspace authentication required.', 401);
        const query = target.searchParams;
        let value;
        if (request.method === 'GET') {
          switch (target.pathname) {
            /* stateDir and pid are said here so a worker above this host can find a credential, and name
               the process a pane descends from, without the process table (specs 101 and 102). */
            case '/api/state': value = { instance, stateDir, pid: process.pid, capabilities: { taskConversations: 1, handoff: 1, desktopActions: 1, formatRegistry: 1, dashboard: 1, projectGame: 1, projectGameLaunch: 1, recordings: 1, projectDevices: 1, externalDeclarations: 1, agentConversations: 1, tracker: 1 }, roots: store.state.roots, layout: store.state.layout, preferences: store.state.preferences, conversations: store.state.conversations ?? {},
              drafts: Object.values(store.state.drafts).map(({ rootId, path, updatedAt }) => ({ rootId, path, updatedAt })), sessions: sessions.list() }; break;
            case '/api/tree': value = await store.list(query.get('rootId'), query.get('path') ?? '', query.get('hidden') === 'true'); break;
            case '/api/file': value = await store.readText(query.get('rootId'), query.get('path')); break;
            case '/api/image': {
              const image = await readImage(store, query.get('rootId'), query.get('path'));
              response.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': image.bytes.length,
                'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
              response.end(image.bytes); return;
            }
            case '/api/formats': value = await listFormats(store.root(query.get('rootId'))); break;
            case '/api/dashboard': value = await dashboardActions(store.root(query.get('rootId')), preflight); break;
            case '/api/tracker': { const selected = store.root(query.get('rootId'));
              value = await projectTracker(selected, await readDeclaration(selected), { stateDirectory: stateDir, refresh: query.get('refresh') === '1' }); break; }
            case '/api/devices': { const selected = store.root(query.get('rootId'));
              value = await projectDevices(selected, await readDeclaration(selected),
                { refresh: query.get('refresh') === '1', preflight, resolve: () => dashboardActions(selected, preflight) }); break; }
            case '/api/bytes': value = await readBytes(store.root(query.get('rootId')), Object.fromEntries(query)); break;
            case '/api/session': value = sessions.snapshot(query.get('id'), true); break;
            case '/api/desktops': value = { desktops: desktops.list(query.get('rootId')) }; break;
            case '/api/game-config': value = await games.inspect(query.get('rootId'), query.get('gameId') ?? undefined); break;
            case '/api/recordings': value = await listRecordings(store.root(query.get('rootId')), Object.fromEntries(query)); break;
            case '/api/recording': value = await readRecording(store.root(query.get('rootId')), query.get('id'), Object.fromEntries(query)); break;
            default: fail('Unknown workspace endpoint.', 404);
          }
        } else if (request.method === 'POST') {
          const data = await body(request);
          if (!data || typeof data !== 'object' || Array.isArray(data)) fail('Expected an object.');
          switch (target.pathname) {
            case '/api/roots': value = await store.addRoot(data.path, data.declarationFile); break;
            /* Sign-in returns a URL for the desktop to open; the browser comes back to a loopback
               listener this module owns, so no credential passes through the desktop (spec 083). */
            case '/api/tracker/signin': {
              const selected = store.root(data.rootId);
              const declaration = await readDeclaration(selected);
              value = await trackerSignIn(stateDir, declaration.project ?? selected.id);
              break;
            }
            case '/api/tracker/signout': {
              const selected = store.root(data.rootId);
              const declaration = await readDeclaration(selected);
              value = await revokeSignIn(stateDir, declaration.project ?? selected.id);
              break;
            }
            case '/api/save': value = await store.saveText(data); break;
            case '/api/draft': value = await store.putDraft(data); break;
            case '/api/discard': await store.discardDraft(data.rootId, data.path); value = { ok: true }; break;
            case '/api/layout': await store.saveLayout(data.layout); value = { ok: true }; break;
            case '/api/preferences': value = await store.preferences(data); break;
            case '/api/format-preview': value = await formatPreview(store.root(data.rootId), data); break;
            case '/api/dashboard-run': {
              const root = store.root(data.rootId), action = await dashboardAction(root, data.actionId, preflight);
              if (action.kind === 'game') { value = await games.launch(root.id, action.game, action.args); break; }
              const payload = await dashboardRunPayload(root, action); value = { ...await sessions.terminal(payload), title: payload.title }; break;
            }
            case '/api/dashboard-capture': value = await dashboardCapture(store.root(data.rootId), data.actionId, preflight); break;
            case '/api/terminal':
              if (data.type && !['terminal', 'agent'].includes(data.type)) fail('Use the game adapter to launch a game.');
              value = await sessions.terminal(data); break;
            case '/api/game': value = await games.launch(data.rootId, data.gameId, data.args); break;
            case '/api/input': sessions.input(data.id, data.data); value = { ok: true }; break;
            case '/api/resize': sessions.resize(data.id, data.cols, data.rows); value = { ok: true }; break;
            case '/api/stop': value = await sessions.stop(data.id); break;
            case '/api/agent-restart': value = await sessions.restartAgent(data.id); break;
            case '/api/agent-conversation': value = await sessions.recordConversation(data.id, data.conversation, data.agent, data.task); break;
            case '/api/desktop-action':
              if (data.action !== 'reload') fail('Unknown desktop action.');
              value = await desktops.reload(data.rootId, data.desktopId); break;
            default: fail('Unknown workspace endpoint.', 404);
          }
        } else fail('Method not supported.', 405);
        json(response, 200, value);
        return;
      }
      fail('No web client is installed. Use the native desktop.', 404);
    } catch (error) {
      if (!response.headersSent) json(response, error.status ?? (error.code === 'ENOENT' ? 404 : 500), { error: error.message });
      else response.destroy();
    }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  const gameSockets = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', (request, socket, head) => {
    const target = new URL(request.url, 'http://127.0.0.1');
    if (!['/events', '/surface'].includes(target.pathname) || !authorized(target.searchParams.get('token'), token) || (request.headers.origin && request.headers.origin !== url)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
    }
    if (target.pathname === '/surface') gameSockets.handleUpgrade(request, socket, head, ws => {
      ws.on('error', () => {}); games.attach(target.searchParams.get('id'), ws);
    });
    else sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws));
  });
  sockets.on('connection', ws => {
    const attached = new Set();
    ws.on('error', () => {});
    ws.send(JSON.stringify({ type: 'hello', instance }));
    ws.on('message', async bytes => {
      try {
        const data = JSON.parse(bytes.toString());
        if (data.type === 'attach') {
          ws.send(JSON.stringify({ type: 'attached', session: sessions.snapshot(data.id, true) })); attached.add(data.id);
        }
        else if (data.type === 'presented') {
          if (!attached.has(data.id)) fail('Attach the session before presenting it.');
          await sessions.presented(data.id);
        }
        else if (data.type === 'desktop-register') desktops.register(ws, data);
        else if (data.type === 'desktop-action-result') desktops.acknowledge(ws, data);
        else if (data.type === 'input') sessions.input(data.id, data.data);
        else if (data.type === 'resize') sessions.resize(data.id, data.cols, data.rows);
        else fail('Unknown session message.');
      } catch (error) { ws.send(JSON.stringify({ type: 'error', error: error.message })); }
    });
  });
  sessions.on('event', event => {
    const bytes = JSON.stringify(event);
    for (const client of sockets.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount > 4 * 1024 * 1024) client.close(1013, 'Reconnect to recover retained output');
      else client.send(bytes);
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  url = `http://127.0.0.1:${server.address().port}`;
  sessions.workspaceContext = { url, token, instance };
  return { url, token, instance, store, sessions, games, async close() {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    await sessions.shutdown();
    await games.close();
    for (const client of gameSockets.clients) client.terminate();
    gameSockets.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await store.persisting;
  } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--state');
  const stateDir = path.resolve(index >= 0 ? process.argv[index + 1] : path.join(homedir(), '.local/state/rengine'));
  const instance = await startServer({ stateDir });
  const descriptor = path.join(stateDir, 'sidecar.json');
  await writeFile(`${descriptor}.${process.pid}.tmp`, JSON.stringify({ url: instance.url, token: instance.token, instance: instance.instance, pid: process.pid }), { mode: 0o600 });
  await rename(`${descriptor}.${process.pid}.tmp`, descriptor);
  console.log(`rEngine sidecar listening at ${instance.url}`);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await instance.close(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
