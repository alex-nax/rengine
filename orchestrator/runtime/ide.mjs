/* rEdit as a Claude Code IDE (spec 102).
 *
 * Claude Code finds an editor by reading `~/.claude/ide/<port>.lock` and connecting to the port its
 * filename names. This serves that socket from the workspace worker, which is the replaceable layer:
 * the bridge needs no PTY, no surface and no store state, only the root paths, so it arrives by a
 * routine layered update rather than needing the retained host to change (spec 101).
 *
 * Everything this file assumes about the CLI was read out of one binary and can change under us, so
 * the assumptions are asserted by tests rather than trusted.
 */
import path from 'node:path';
import os from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export const IDE_NAME = 'rEdit';
/* The CLI reads this one path, so it is the default rather than a setting — but it stays an explicit
   input, because a test that publishes into the developer's own `/ide` menu is a test with a side
   effect on the person running it. */
export const ideDirectory = () => process.env.RENGINE_IDE_DIRECTORY || path.join(os.homedir(), '.claude', 'ide');

/* MCP over a WebSocket, which the SDK has no server transport for: a frame is one JSON-RPC message. */
class SocketTransport {
  constructor(socket) { this.socket = socket; }
  async start() {
    this.socket.on('message', data => {
      let message;
      try { message = JSON.parse(data.toString()); }
      catch (error) { this.onerror?.(error); return; }
      this.onmessage?.(message);
    });
    this.socket.on('close', () => this.onclose?.());
    this.socket.on('error', error => this.onerror?.(error));
  }
  async send(message) { this.socket.send(JSON.stringify(message)); }
  async close() { this.socket.close(); }
}

const constantEqual = (a, b) => {
  const left = Buffer.from(String(a ?? '')), right = Buffer.from(String(b ?? ''));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
};

/* The CLI's own parser reads six named keys and ignores the rest, so `rengineWorker` rides along as
   the mark that says a lock is ours. See sidecar: our-locks-are-ours-to-collect. */
export async function sweep(directory, { alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } } } = {}) {
  let names = [];
  try { names = await readdir(directory); } catch { return []; }
  const removed = [];
  for (const name of names) {
    if (!name.endsWith('.lock')) continue;
    const file = path.join(directory, name);
    let value;
    try { value = JSON.parse(await readFile(file, 'utf8')); } catch { continue; }
    if (typeof value?.rengineWorker !== 'number' || alive(value.rengineWorker)) continue;
    try { await unlink(file); removed.push(file); } catch { /* another worker swept it first */ }
  }
  return removed;
}

/* One store, two readers: whatever the project's declared language servers have published, answered
   the same way to the editor pane and to an agent, so the person and the model cannot be told
   different things about the same file (charter D37). A project that declares no server gets an
   empty list, which is the true answer from an editor that runs nothing, not a refusal. */
const diagnostics = (uri, source) => [{ uri, diagnostics: source?.(uri) ?? [] }];

/* A worker replacement must not move the port. Claude Code reads a lock once and then reconnects to
   the port it read; it never goes back to the directory. An ephemeral port per worker therefore ends
   every IDE session on every layered update, silently — which is KI-066, found by this session's own
   connection dying. So the supervisor keeps one port for the runtime's life and each worker takes it
   over. The worker being replaced still holds it for a moment after its successor starts, so the
   successor retries rather than settling for a different port: a different port is a session the CLI
   cannot get back. See sidecar: the-port-may-not-move. */
const RETAKE_INTERVAL_MS = 250;
const RETAKE_TIMEOUT_MS = 20000;

async function listen(host, port) {
  const server = new WebSocketServer({ host, port, handleProtocols: offered => (offered.has('mcp') ? 'mcp' : false) });
  try {
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    return server;
  } catch (error) {
    server.close();
    if (error.code === 'EADDRINUSE') return null;
    throw error;
  }
}

export async function startIdeBridge({ roots = [], hostPid, workerPid = process.pid, port: wanted = 0,
  directory = ideDirectory(), host = '127.0.0.1', retakeTimeoutMs = RETAKE_TIMEOUT_MS, diagnosticsFor = null } = {}) {
  /* Without the host's pid there is nothing to publish: the CLI checks that the lock's pid is one of
     its own first ten ancestors, and the host is the only process in a pane's chain (spec 102 D2). */
  if (!Number.isInteger(hostPid)) {
    return { published: false, ready: Promise.resolve(false), clients: () => 0, selection: () => 0, close: async () => {},
      reason: 'the session host process could not be identified, so no lock was written' };
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await sweep(directory);

  const authToken = randomBytes(32).toString('hex');
  const sockets = new Set(), observed = [];
  let server = null, lock = null, closed = false;

  /* Measured, not assumed: `claude` 2.1.263 sends the lock's token in this header and asks for the
     `mcp` subprotocol. One place is checked because one place is what it uses; a version that moves
     it fails the handshake loudly rather than being let in on a guess. See sidecar: token-arrival. */
  const presented = request =>
    constantEqual(request.headers['x-claude-code-ide-authorization'], authToken) ? 'header' : null;

  const connection = (socket, request) => {
    const where = presented(request);
    observed.push({ at: new Date().toISOString(), accepted: where !== null, where,
      headers: Object.fromEntries(Object.entries(request.headers).filter(([name]) => !name.startsWith('sec-websocket-key'))) });
    if (!where) { socket.close(1008, 'A valid IDE token is required.'); return; }
    const mcp = new Server({ name: 'rengine-ide', version: '1.0.0' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{
      name: 'getDiagnostics',
      description: 'Diagnostics rEdit holds for a file, from the language servers the project declares. A project that declares none answers an empty list rather than refusing.',
      inputSchema: { type: 'object', properties: { uri: { type: 'string' } } },
    }] }));
    mcp.setRequestHandler(CallToolRequestSchema, request => {
      if (request.params.name !== 'getDiagnostics') throw new Error(`${request.params.name} is not a tool rEdit serves yet.`);
      return { content: [{ type: 'text', text: JSON.stringify(diagnostics(request.params.arguments?.uri ?? '', diagnosticsFor)) }] };
    });
    socket.mcp = mcp;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    mcp.connect(new SocketTransport(socket)).catch(() => socket.close());
  };

  const bridge = {
    published: false, authToken, observed, ready: null, port: null, lock: null, reason: null,
    clients: () => sockets.size,
    /* A selection is a fact about the editor; naming it `selection_changed` is this file's business. */
    selection(value) {
      for (const socket of sockets) socket.mcp?.notification({ method: 'selection_changed', params: value }).catch(() => {});
      return sockets.size;
    },
    /* `at_mentioned` carries the file and a line range, not the selection shape: the CLI's own schema
       is { filePath, lineStart?, lineEnd? }, read out of its binary rather than guessed. */
    mention(value) {
      for (const socket of sockets) socket.mcp?.notification({ method: 'at_mentioned', params: value }).catch(() => {});
      return sockets.size;
    },
    async close() {
      closed = true;
      await bridge.ready?.catch(() => {});
      /* Unlinked before the socket closes, so the successor that is waiting for this port cannot
         bind and write the lock in the gap and then have this one delete it. */
      if (lock) { try { await unlink(lock); } catch { /* already gone */ } }
      for (const socket of sockets) socket.close();
      if (server) await new Promise(resolve => server.close(resolve));
    },
  };

  const serve = async bound => {
    server = bound;
    server.on('connection', connection);
    lock = path.join(directory, `${server.address().port}.lock`);
    await writeFile(lock, JSON.stringify({
      pid: hostPid, workspaceFolders: roots, ideName: IDE_NAME, transport: 'ws',
      useWebSocket: true, runningInWindows: false, authToken, rengineWorker: workerPid,
    }, null, 2), { mode: 0o600 });
    bridge.published = true; bridge.port = server.address().port; bridge.lock = lock; bridge.reason = null;
    return true;
  };

  const first = await listen(host, wanted);
  if (first) { bridge.ready = serve(first); await bridge.ready; return bridge; }

  bridge.reason = `port ${wanted} is still held by the worker being replaced`;
  bridge.ready = (async () => {
    const deadline = Date.now() + retakeTimeoutMs;
    while (!closed && Date.now() < deadline) {
      /* Not unref'd: the wait is bounded and `close` ends it, and a timer that lets the process
         exit mid-retry would strand the bridge unpublished with nothing said. */
      await new Promise(resolve => setTimeout(resolve, RETAKE_INTERVAL_MS));
      if (closed) break;
      const taken = await listen(host, wanted);
      if (taken) return serve(taken);
    }
    bridge.reason = `port ${wanted} was never released by the worker being replaced`;
    return false;
  })();
  return bridge;
}
