import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { open, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import path from 'node:path';
import { WorkspaceStore, fail } from './store-client.mjs';
import { Sessions } from './sessions-client.mjs';
import { listFormats, formatPreview, readBytes, readDeclaration } from './formats.mjs';
import { dashboardAction, dashboardActions, dashboardRunPayload, dashboardCapture } from './dashboard.mjs';
import { inspectGame, projectDevices } from './devices.mjs';
import { listRecordings, readRecording } from './recordings.mjs';
import { runtimeDirectory } from '../runtime/discovery.mjs';

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
/* `retainSessions` is charter D60 as a switch: a host that OWNS a state directory — the process a
   person or a launcher starts — attaches to that directory's PTY service, so replacing the host
   leaves the agent CLIs inside its panes alive and the next host adopts them. A host embedded in a
   test passes nothing and keeps the old behaviour, because a suite that left a service holding a
   shell per test would leak processes the tests never asked for. */
export async function startServer({ stateDir, port = 0, retainSessions = false, frontDoor = true } = {}) {
  if (!stateDir) fail('The sidecar requires an explicit state directory.');
  stateDir = path.resolve(stateDir);
  /* Every host of a state directory uses THAT DIRECTORY'S services — its store (charter D61) and
     its PTYs (D60) — because while the host is being ported a route at a time, red-host and this
     process serve one workspace together, and two in-memory owners of one set of files is stale
     reads on one side and lost writes on the other.
     `retainSessions` is now only about SHUTDOWN: a host being replaced leaves its panes for the
     next one, and a host closing for good ends what it started. A service whose state directory is
     deleted stops on its own, which is what makes this safe for a suite. */
  const store = await WorkspaceStore.attach(stateDir);
  const sessions = new Sessions(store, { stateDir });
  /* The preflight only. LAUNCHING a game, and the `/surface` socket its frames travel on, moved to
     red-host with `games.mjs`, `surfaces.mjs` and `surface-protocol.mjs` (F155, spec 142) — the
     last route this process uniquely served. What is left here is the read the dashboard's own
     composition needs, and red-project answers it. */
  const preflight = async (rootId, gameId) => inspectGame(await store.root(rootId), gameId);
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
            case '/api/formats': value = await listFormats(await store.root(query.get('rootId'))); break;
            case '/api/dashboard': value = await dashboardActions(await store.root(query.get('rootId')), preflight); break;
            case '/api/devices': { const selected = await store.root(query.get('rootId'));
              value = await projectDevices(selected, await readDeclaration(selected),
                { refresh: query.get('refresh') === '1', preflight, resolve: () => dashboardActions(selected, preflight) }); break; }
            case '/api/bytes': value = await readBytes(await store.root(query.get('rootId')), Object.fromEntries(query)); break;
            case '/api/game-config': value = await preflight(query.get('rootId'), query.get('gameId') ?? undefined); break;
            case '/api/recordings': value = await listRecordings(await store.root(query.get('rootId')), Object.fromEntries(query)); break;
            case '/api/recording': value = await readRecording(await store.root(query.get('rootId')), query.get('id'), Object.fromEntries(query)); break;
            default: fail('Unknown workspace endpoint.', 404);
          }
        } else if (request.method === 'POST') {
          const data = await body(request);
          if (!data || typeof data !== 'object' || Array.isArray(data)) fail('Expected an object.');
          switch (target.pathname) {
            case '/api/format-preview': value = await formatPreview(await store.root(data.rootId), data); break;
            case '/api/dashboard-run': {
              const root = await store.root(data.rootId), action = await dashboardAction(root, data.actionId, preflight);
              /* A game action is a launch, and the door answers those now — it never reaches here. */
              if (action.kind === 'game') fail('Use the door to launch a game.', 409);
              const payload = await dashboardRunPayload(root, action); value = { ...await sessions.terminal(payload), title: payload.title }; break;
            }
            case '/api/dashboard-capture': value = await dashboardCapture(await store.root(data.rootId), data.actionId, preflight); break;
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
  /* No sockets here. `/events` has been red-host's since F189 — it carries a pane's bytes and the
     desktops that register on it — and `/surface` joined it with games (F155, spec 142): a game's
     frames are its transport, and the transport moved with the launch. An upgrade reaching this
     process is one the door did not recognise, and it is refused rather than answered. */
  server.on('upgrade', (_request, socket) => {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  url = `http://127.0.0.1:${server.address().port}`;
  /* The runtime directory too, the same field `runtime/supervisor.mjs` writes: a reader without
     the JS default computes nothing and would route a pane to this host (KI-110, spec 095). */
  sessions.workspaceContext = { url, token, instance, runtimeDirectory: runtimeDirectory({ url, token, instance }) };
  /* What the directory's service is already holding, before anything is served: a pane whose host
     was replaced is in the list its first caller reads, not one refresh later. */
  const adopted = await sessions.adopt();
  /* The front door (F188/F189): red-host owns the port a client talks to and answers every route
     F152 names from this directory's own services, forwarding the rest here. Every host gets one,
     so what a spec drives is what a person runs — the exceptions are the specs that start a door
     themselves, which say `frontDoor: false` rather than ending up with two. */
  const door = frontDoor ? await openFrontDoor(stateDir, { url, token }) : null;
  const backend = { url, token, instance };
  return { url: door?.url ?? url, token: door?.token ?? token, instance: door?.instance ?? instance,
    backend, door: door?.child ?? null, store, sessions, adopted, async close({ retain = retainSessions } = {}) {
    /* The door first: one that outlived its backend would answer for a workspace that is going. */
    try { door?.child.kill('SIGTERM'); } catch { /* already gone */ }
    await sessions.shutdown({ retain });
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await store.close();
  } };
}

/* The Rust front door (F188/F189, spec 129), which is what a workspace's clients actually talk to:
   red-host owns the port and answers every route F152 names from the state directory's own store
   and PTY services, forwarding what F153–F156 have not moved yet to this process. Its descriptor
   announces THIS pid, because the pair is the workspace and this is the process a launcher started,
   `replace.mjs` stops and `discoverSidecar` asks about.

   A checkout with no red-host built still starts: the door is the front of this host, not a
   requirement of it, and a workspace that refused to come up because a binary was missing would be
   a worse answer than one that says so in its log. */
function redHostBinary(env = process.env) {
  const declared = env.RENGINE_RED_HOST;
  if (declared) return existsSync(declared) ? declared : null;
  const project = fileURLToPath(new URL('../..', import.meta.url));
  for (const profile of ['release', 'debug']) {
    const candidate = path.join(project, 'red/target', profile, 'red-host');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function openFrontDoor(stateDir, instance, log = 'ignore') {
  const binary = redHostBinary();
  if (!binary) return null;
  const child = spawn(binary, ['--state', stateDir, '--backend', instance.url, '--backend-token', instance.token,
    '--pid', String(process.pid)], { stdio: ['ignore', log, log], windowsHide: true });
  /* The door publishes the descriptor itself, so the workspace is discoverable exactly when the
     door is ready to answer for it. What this waits for is the door's own announcement. */
  const announced = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 10000);
    child.once('exit', code => { clearTimeout(timer); resolve({ exited: code }); });
    const settle = async () => {
      for (let waited = 0; waited < 10000; waited += 50) {
        try {
          const written = JSON.parse(await readFile(path.join(stateDir, 'sidecar.json'), 'utf8'));
          if (written.pid === process.pid && written.url !== instance.url) { clearTimeout(timer); resolve(written); return; }
        } catch { /* not yet */ }
        await new Promise(tick => setTimeout(tick, 50));
      }
    };
    settle();
  });
  if (!announced || announced.exited !== undefined) {
    console.log(`rEngine: red-host did not come up (${JSON.stringify(announced)}); serving this workspace from the JS host.`);
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    return null;
  }
  return { child, url: announced.url, token: announced.token, instance: announced.instance };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--state');
  const stateDir = path.resolve(index >= 0 ? process.argv[index + 1] : path.join(homedir(), '.local/state/rengine'));
  /* The host of a state directory, started as its own process: its panes outlive it (D60). */
  const instance = await startServer({ stateDir, retainSessions: true });
  /* red-host is the workspace's host now, not an accelerator in front of one: it answers the store
     routes, the session routes, `/api/state` and the `/events` socket, and this process serves only
     what F153–F156 have not moved yet. A checkout without it cannot serve a workspace, and saying so
     is better than coming up as something that answers `/health` and little else. */
  if (!instance.door) {
    console.error('rEngine: red-host is required to serve a workspace and was not found. Build it with `cargo build -p red-host --release`, or set RENGINE_RED_HOST.');
    await instance.close({ retain: true });
    process.exit(3);
  }
  console.log(`rEngine sidecar listening at ${instance.url}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await instance.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
