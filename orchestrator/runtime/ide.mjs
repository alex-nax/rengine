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

/* The empty list is the true answer: rEdit runs no language server, so it knows of no diagnostics.
   Refusing instead would make the CLI report the editor as broken rather than as quiet. */
const diagnostics = uri => [{ uri, diagnostics: [] }];

export async function startIdeBridge({ roots = [], hostPid, workerPid = process.pid,
  directory = ideDirectory(), host = '127.0.0.1' } = {}) {
  /* Without the host's pid there is nothing to publish: the CLI checks that the lock's pid is one of
     its own first ten ancestors, and the host is the only process in a pane's chain (spec 102 D2). */
  if (!Number.isInteger(hostPid)) return { published: false, reason: 'the session host process could not be identified, so no lock was written' };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await sweep(directory);

  const authToken = randomBytes(32).toString('hex');
  const sockets = new Set();
  const server = new WebSocketServer({ host, port: 0,
    handleProtocols: offered => (offered.has('mcp') ? 'mcp' : false) });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const port = server.address().port;
  const lock = path.join(directory, `${port}.lock`);

  /* Measured, not assumed: `claude` 2.1.263 sends the lock's token in this header and asks for the
     `mcp` subprotocol. One place is checked because one place is what it uses; a version that moves
     it fails the handshake loudly rather than being let in on a guess. See sidecar: token-arrival. */
  const presented = request =>
    constantEqual(request.headers['x-claude-code-ide-authorization'], authToken) ? 'header' : null;

  const observed = [];
  server.on('connection', (socket, request) => {
    const where = presented(request);
    observed.push({ at: new Date().toISOString(), accepted: where !== null, where,
      headers: Object.fromEntries(Object.entries(request.headers).filter(([name]) => !name.startsWith('sec-websocket-key'))) });
    if (!where) { socket.close(1008, 'A valid IDE token is required.'); return; }
    const mcp = new Server({ name: 'rengine-ide', version: '1.0.0' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{
      name: 'getDiagnostics',
      description: 'Diagnostics rEdit holds for a file. rEdit runs no language server, so the list is empty rather than absent.',
      inputSchema: { type: 'object', properties: { uri: { type: 'string' } } },
    }] }));
    mcp.setRequestHandler(CallToolRequestSchema, request => {
      if (request.params.name !== 'getDiagnostics') throw new Error(`${request.params.name} is not a tool rEdit serves yet.`);
      return { content: [{ type: 'text', text: JSON.stringify(diagnostics(request.params.arguments?.uri ?? '')) }] };
    });
    socket.mcp = mcp;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    mcp.connect(new SocketTransport(socket)).catch(() => socket.close());
  });

  await writeFile(lock, JSON.stringify({
    pid: hostPid, workspaceFolders: roots, ideName: IDE_NAME, transport: 'ws',
    useWebSocket: true, runningInWindows: false, authToken, rengineWorker: workerPid,
  }, null, 2), { mode: 0o600 });

  return {
    published: true, port, lock, authToken, observed,
    clients: () => sockets.size,
    /* A selection is a fact about the editor; naming it `selection_changed` is this file's business. */
    selection(value) {
      for (const socket of sockets) socket.mcp?.notification({ method: 'selection_changed', params: value }).catch(() => {});
      return sockets.size;
    },
    async close() {
      for (const socket of sockets) socket.close();
      await new Promise(resolve => server.close(resolve));
      /* The lock names the host's pid, which outlives this worker, so the CLI's own sweep would keep
         a dead lock forever. Ours to write, ours to remove. */
      try { await unlink(lock); } catch { /* already gone */ }
    },
  };
}
