/* The answers `runtime/ide.mjs` gives, recorded before it is replaced (F161, spec 102, spec 133).
 *
 * Red presents itself to Claude Code as an IDE: a lock file the CLI reads, a WebSocket that speaks
 * MCP, and a token the socket requires. Every rule here was read out of one CLI binary and then
 * checked against the running CLI (docs/evidence/editor-as-claude-ide-2026-09-07.md), and every
 * one of them is a distrust rule — which pid a lock may name, whose stale locks may be collected,
 * what a connection must present. So what is recorded is not only the answers but the SILENCES:
 * a frame the SDK does not answer is a frame the port must not answer either.
 *
 *   node orchestrator/tests/ide-corpus.mjs > orchestrator/tests/ide-corpus.json
 *
 * Regenerate ONLY from a checkout where `ide.mjs` still holds the implementation — never after the
 * wiring commit, because a regenerated record would be judging the replacement against itself.
 *
 * Folded, because they are a machine's rather than a rule's: the port, the token, the temporary
 * directory, this process's pid, the product's name and the `host` header. Not folded: the retake
 * wait, every refusal, every reason.
 */
import { WebSocket } from 'ws';
import net from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { PRODUCT_NAME } from '../runtime/product.mjs';

/* ESRCH on every unix; pid 1 answers EPERM to a person, which is a different answer and recorded
   as one; 0 is this process's own group, which `kill(0, 0)` reports alive. */
export const DEAD = 2147483647;
export const LIVE = process.pid;

const INITIALIZE = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.263' } };
const ITEM = { range: { start: { line: 1, character: 5 }, end: { line: 1, character: 9 } }, severity: 2, source: 'fake', message: 'TODO on line 2' };
const SELECTION = { filePath: '/work/a.c', text: 'int main(void)', selection: { start: { line: 3, character: 0 }, end: { line: 3, character: 14 } } };
const MENTION = { filePath: '/work/a.c', lineStart: 2, lineEnd: 4 };

const ours = extra => ({ pid: 1, ideName: PRODUCT_NAME, ...extra });

/* Each case is a script. `start` opens a bridge (named by `as`, `main` by default); `connect`
   opens a raw WebSocket client (named by `as`); `send` writes one frame and records what comes
   back — or that nothing does, proven by the answer to a ping sent right behind it. */
export const CASES = [
  ['the lock is the one the CLI reads', { steps: [
    { start: { roots: ['/work/one', '/work/two'], hostPid: 4242, workerPid: 99 } },
    { disk: true },
    { close: 'main' },
    { disk: true },
  ] }],
  ['without a host pid nothing is published, four ways', { steps: [
    { start: { as: 'absent', roots: ['/work'], directory: 'nolock' } },
    { start: { as: 'null', roots: ['/work'], hostPid: null, directory: 'nolock' } },
    { start: { as: 'string', roots: ['/work'], hostPid: '4242', directory: 'nolock' } },
    { start: { as: 'fraction', roots: ['/work'], hostPid: 4242.5, directory: 'nolock' } },
    /* Nothing is published and nothing is touched: the directory was not even created. */
    { disk: true },
    { close: 'absent' }, { close: 'null' }, { close: 'string' }, { close: 'fraction' },
  ] }],
  ['no roots, and a root with a name worth escaping', { steps: [
    { start: { as: 'none', roots: [], hostPid: LIVE, workerPid: 7 } },
    { disk: true },
    { close: 'none' },
    { start: { as: 'odd', roots: ['/work/héllo 🙂', '/work/"quoted"\\back'], hostPid: LIVE, workerPid: 8 } },
    { disk: true },
    { close: 'odd' },
  ] }],
  /* The default worker pid is the caller's own: the process that asked is the worker. */
  ['the worker pid defaults to the caller', { steps: [
    { start: { roots: ['/work'], hostPid: 4242 } },
    { disk: true },
    { close: 'main' },
  ] }],
  ['the startup sweep collects only ours, and only the dead', { steps: [
    { prepopulate: {
      '111.lock': ours({ rengineWorker: DEAD }),
      '222.lock': ours({ rengineWorker: LIVE }),
      '333.lock': { pid: 1, ideName: 'VS Code' },
      '444.lock': ours({ rengineWorker: String(DEAD) }),
      '555.lock': 'not json at all',
      '666.txt': ours({ rengineWorker: DEAD }),
      '777.lock': ours({ rengineWorker: 1 }),
      '888.lock': ours({ rengineWorker: 0 }),
      '999.lock': ours({ rengineWorker: null }),
      '1010.lock': [],
      '1111.lock': null,
      '1212.lock': ours({ rengineWorker: DEAD, ideName: 'VS Code' }),
    } },
    { sweep: true },
    { disk: true },
    { prepopulate: { '1313.lock': ours({ rengineWorker: DEAD }) } },
    { start: { roots: ['/work'], hostPid: LIVE, workerPid: 5 } },
    { disk: true },
    { close: 'main' },
  ] }],
  ['a sweep of a directory that is not there', { steps: [
    { sweep: 'missing' },
  ] }],
  ['the MCP handshake, the tool list, and every silence', { steps: [
    { start: { roots: ['/work'], hostPid: LIVE, workerPid: 9 } },
    { connect: { as: 'a', token: 'lock', protocols: ['mcp'] } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 1, method: 'initialize', params: INITIALIZE } } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', method: 'notifications/initialized' }, expect: 'silent' } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 2, method: 'tools/list' } } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 3, method: 'ping' } } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 4, method: 'resources/list' } } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 'five', method: 'tools/list' } } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 6, method: 'tools/list', extra: true }, expect: 'silent' } },
    { send: { as: 'a', frame: { id: 7, method: 'tools/list' }, expect: 'silent' } },
    { send: { as: 'a', frame: { jsonrpc: '1.0', id: 8, method: 'tools/list' }, expect: 'silent' } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 9.5, method: 'tools/list' }, expect: 'silent' } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: null, method: 'tools/list' }, expect: 'silent' } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', method: 'ide_connected', params: { pid: 1 } }, expect: 'silent' } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 10, result: {} }, expect: 'silent' } },
    { send: { as: 'a', frame: 'this is not json', expect: 'silent' } },
    { send: { as: 'a', frame: { binary: { jsonrpc: '2.0', id: 11, method: 'ping' } } } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 12, method: 'initialize', params: { ...INITIALIZE, protocolVersion: '1999-01-01' } } } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 13, method: 'initialize', params: { ...INITIALIZE, protocolVersion: '2024-11-05' } } } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 14, method: 'initialize' } } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 15, method: 'tools/list', params: { cursor: 'x' } } } },
    /* The SDK's own validation, to the depth a CLI could plausibly reach: these are zod's sentences,
       recorded so the port says them and not its own. */
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 16, method: 'initialize', params: {} } } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 17, method: 'initialize', params: [] }, expect: 'silent' } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 18, method: 'initialize', params: { protocolVersion: 5, capabilities: null, clientInfo: { name: 'x' } } } } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 19, method: 'tools/list', params: { cursor: 5 } } } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 20, method: 'tools/list', params: null }, expect: 'silent' } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 21, method: 'ping', params: 'x' }, expect: 'silent' } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 22, method: 'ping', params: { _meta: 5 } }, expect: 'silent' } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 23, method: 'ping', params: { _meta: { progressToken: 'p' }, extra: 1 } } } },
    { connect: { as: 'b', token: 'lock', protocols: ['mcp'] } },
    { send: { as: 'b', frame: { jsonrpc: '2.0', id: 1, method: 'tools/list' } } },
    { clients: true },
    { close: 'main' },
  ] }],
  ['getDiagnostics, every way it can be asked', { steps: [
    { start: { roots: ['/work'], hostPid: LIVE, workerPid: 9 }, source: 'items' },
    { connect: { as: 'a', token: 'lock', protocols: ['mcp'] } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'getDiagnostics', arguments: { uri: 'file:///work/a.c' } } } } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'getDiagnostics' } } } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'getDiagnostics', arguments: {} } } } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'getDiagnostics', arguments: { uri: 5 } } } } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'getDiagnostics', arguments: { uri: null } } } } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'getDiagnostics', arguments: { uri: 'file:///work/é 🙂.c' } } } } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'openDiff', arguments: {} } } } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { arguments: {} } } } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 9, method: 'tools/call' } } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'getDiagnostics', arguments: 'x' } } } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 5 } } } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'getDiagnostics', arguments: null } } } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'getDiagnostics', arguments: [] } } } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'getDiagnostics', arguments: { uri: 'file:///work/a.c' }, _meta: { progressToken: 1 } } } } },
    { close: 'main' },
  ] }],
  ['diagnostics from every kind of source', { steps: [
    { start: { as: 'nothing', roots: ['/work'], hostPid: LIVE, workerPid: 9 }, source: 'undefined' },
    { connect: { as: 'a', token: 'lock', protocols: ['mcp'], bridge: 'nothing' } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'getDiagnostics', arguments: { uri: 'file:///work/a.c' } } } } },
    { close: 'nothing' },
    { start: { as: 'null', roots: ['/work'], hostPid: LIVE, workerPid: 9 }, source: 'null' },
    { connect: { as: 'b', token: 'lock', protocols: ['mcp'], bridge: 'null' } },
    { send: { as: 'b', frame: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'getDiagnostics', arguments: { uri: 'file:///work/a.c' } } } } },
    { close: 'null' },
    { start: { as: 'fire', roots: ['/work'], hostPid: LIVE, workerPid: 9 }, source: 'throws' },
    { connect: { as: 'c', token: 'lock', protocols: ['mcp'], bridge: 'fire' } },
    { send: { as: 'c', frame: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'getDiagnostics', arguments: { uri: 'file:///work/a.c' } } } } },
    { close: 'fire' },
    { start: { as: 'none', roots: ['/work'], hostPid: LIVE, workerPid: 9 }, source: 'none' },
    { connect: { as: 'd', token: 'lock', protocols: ['mcp'], bridge: 'none' } },
    { send: { as: 'd', frame: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'getDiagnostics', arguments: { uri: 'file:///work/a.c' } } } } },
    { close: 'none' },
  ] }],
  ['the token gate, in every place a token could be presented', { steps: [
    { start: { roots: ['/work'], hostPid: LIVE, workerPid: 9 } },
    { connect: { as: 'bare', token: null } },
    { connect: { as: 'wrong', token: 'wrong', protocols: ['mcp'] } },
    { connect: { as: 'query', token: 'query', protocols: ['mcp'] } },
    { connect: { as: 'subprotocol', token: 'subprotocol' } },
    { connect: { as: 'upper', token: 'upper', protocols: ['mcp'] } },
    { connect: { as: 'twice', token: 'duplicate', protocols: ['mcp'] } },
    { connect: { as: 'spaced', token: 'spaced', protocols: ['mcp'] } },
    { connect: { as: 'empty', token: 'empty', protocols: ['mcp'] } },
    { connect: { as: 'right', token: 'lock', protocols: ['mcp'] } },
    { clients: true },
    { observed: true },
    { close: 'main' },
  ] }],
  ['the subprotocol is echoed when asked for, and only then', { steps: [
    { start: { roots: ['/work'], hostPid: LIVE, workerPid: 9 } },
    { connect: { as: 'mcp', token: 'lock', protocols: ['mcp'] } },
    { connect: { as: 'other', token: 'lock', protocols: ['other'] } },
    { connect: { as: 'both', token: 'lock', protocols: ['other', 'mcp'] } },
    { connect: { as: 'none', token: 'lock' } },
    { connect: { as: 'twice', token: 'lock', headers: { 'Sec-WebSocket-Protocol': 'mcp, mcp' } } },
    { clients: true },
    { close: 'main' },
  ] }],
  ['a selection and a mention reach every connected CLI', { steps: [
    { start: { roots: ['/work'], hostPid: LIVE, workerPid: 9 } },
    { selection: SELECTION },
    { connect: { as: 'a', token: 'lock', protocols: ['mcp'] } },
    { connect: { as: 'b', token: 'lock', protocols: ['mcp'] } },
    { connect: { as: 'refused', token: 'wrong', protocols: ['mcp'] } },
    { selection: SELECTION },
    { mention: MENTION },
    { selection: { filePath: '/work/é 🙂.c', text: 'const char *s = "🙂🙂";', selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 23 } } } },
    { mention: { filePath: '/work/a.c' } },
    { disconnect: 'a' },
    { selection: SELECTION },
    { close: 'main' },
  ] }],
  ['closing the bridge removes its lock and ends its sockets', { steps: [
    { start: { roots: ['/work'], hostPid: LIVE, workerPid: 9 } },
    { connect: { as: 'a', token: 'lock', protocols: ['mcp'] } },
    { disk: true },
    { close: 'main' },
    { disk: true },
    { connectAfterClose: 'main' },
    { clients: true },
    { close: 'main' },
  ] }],
  ['the port survives a worker replacement', { steps: [
    { start: { as: 'first', roots: ['/work'], hostPid: LIVE, workerPid: 1 } },
    { start: { as: 'second', roots: ['/work'], hostPid: LIVE, workerPid: 2, port: 'first', retakeTimeoutMs: 10000 } },
    { disk: true },
    { close: 'first' },
    { ready: 'second' },
    { disk: true },
    { connect: { as: 'a', token: 'lock', protocols: ['mcp'], bridge: 'second' } },
    { send: { as: 'a', frame: { jsonrpc: '2.0', id: 1, method: 'tools/list' } } },
    { close: 'second' },
    { disk: true },
  ] }],
  ['a port that is never released is a named absence', { steps: [
    { start: { as: 'first', roots: ['/work'], hostPid: LIVE, workerPid: 1 } },
    { start: { as: 'second', roots: ['/work'], hostPid: LIVE, workerPid: 2, port: 'first', retakeTimeoutMs: 600 } },
    { ready: 'second' },
    { disk: true },
    { close: 'second' },
    { disk: true },
    { close: 'first' },
  ] }],
  /* A source that takes its time does not hold the next frame behind it: the SDK answered each
     request on its own promise, so a ping sent behind a slow getDiagnostics is answered first. */
  ['a slow source does not hold the next frame behind it', { steps: [
    { start: { roots: ['/work'], hostPid: LIVE, workerPid: 9 }, source: 'slow' },
    { connect: { as: 'a', token: 'lock', protocols: ['mcp'] } },
    { burst: { as: 'a', frames: [
      { jsonrpc: '2.0', id: 'diagnostics', method: 'tools/call', params: { name: 'getDiagnostics', arguments: { uri: 'file:///work/a.c' } } },
      { jsonrpc: '2.0', id: 'ping', method: 'ping' },
    ] } },
    { close: 'main' },
  ] }],
  /* A successor retired while still waiting for the port stops waiting: it must not take the port
     after its own retirement and publish a lock nobody will ever unlink. The two closes are
     concurrent on purpose — a loop that ignored its retirement would merely take longer if the
     predecessor were still holding the port, and a record cannot see time. With the port freed
     while the retirement is in flight, the difference is a lock on disk. */
  ['a successor closed while waiting stops waiting', { steps: [
    { start: { as: 'first', roots: ['/work'], hostPid: LIVE, workerPid: 1 } },
    { start: { as: 'second', roots: ['/work'], hostPid: LIVE, workerPid: 2, port: 'first', retakeTimeoutMs: 10000 } },
    { closeAll: ['second', 'first'] },
    { ready: 'second' },
    { disk: true },
  ] }],
  ['a wanted port that is free is taken at once', { steps: [
    { start: { roots: ['/work'], hostPid: LIVE, workerPid: 9, port: 'free' } },
    { disk: true },
    { close: 'main' },
  ] }],
  ['a lock directory that cannot be created', { steps: [
    { prepopulate: { afile: 'x' } },
    { start: { as: 'file', roots: ['/work'], hostPid: LIVE, workerPid: 9, directory: 'afile' } },
    { start: { as: 'under', roots: ['/work'], hostPid: LIVE, workerPid: 9, directory: 'afile/ide' } },
  ] }],
  ['the lock directory follows the CLI, unless rEngine says otherwise', { steps: [
    { directory: {} },
    { directory: { CLAUDE_CONFIG_DIR: '/cfg' } },
    { directory: { CLAUDE_CONFIG_DIR: '/cfg', RENGINE_IDE_DIRECTORY: '/explicit' } },
    { directory: { CLAUDE_CONFIG_DIR: '' } },
    { directory: { RENGINE_IDE_DIRECTORY: '', CLAUDE_CONFIG_DIR: '/cfg/' } },
    { directory: { CLAUDE_CONFIG_DIR: 'relative/cfg' } },
    { directory: { CLAUDE_CONFIG_DIR: '/cfg/../x/./y//' } },
    { directory: { CLAUDE_CONFIG_DIR: '//cfg' } },
  ] }],
];

/* ---- the raw WebSocket client ------------------------------------------------------------------ */

/** One connection, spoken to frame by frame: exactly what claude 2.1.263 does, minus the SDK. */
export function rawClient(port, { token = null, protocols = [], headers = {} } = {}) {
  const url = `ws://127.0.0.1:${port}${token && token.startsWith('?') ? token : ''}`;
  const socket = new WebSocket(url, protocols, { headers });
  const frames = [];
  const waiting = [];
  let ended = null;
  const push = frame => { const next = waiting.shift(); next ? next(frame) : frames.push(frame); };
  socket.on('message', data => push({ text: data.toString() }));
  socket.on('close', (code, reason) => { ended = { code, reason: reason.toString() }; push({ closed: ended }); });
  const opened = new Promise(resolve => {
    socket.once('open', () => resolve({ open: true, protocol: socket.protocol }));
    socket.once('error', error => resolve({ open: false, error: error.message }));
  });
  return {
    socket,
    opened,
    next: () => new Promise(resolve => { frames.length ? resolve(frames.shift()) : waiting.push(resolve); }),
    send: text => socket.send(text),
    sendBinary: text => socket.send(Buffer.from(text)),
    close: () => socket.close(),
    get ended() { return ended; },
  };
}

/* The token in each of the places a client could put it. One is where the CLI puts it. */
function presentation(kind, token) {
  switch (kind) {
    case 'lock': return { headers: { 'x-claude-code-ide-authorization': token } };
    case 'wrong': return { headers: { 'x-claude-code-ide-authorization': 'not-the-token' } };
    case 'query': return { token: `?token=${token}` };
    case 'subprotocol': return { protocols: [token] };
    case 'upper': return { headers: { 'X-CLAUDE-CODE-IDE-AUTHORIZATION': token } };
    case 'duplicate': return { headers: { 'x-claude-code-ide-authorization': [token, token] } };
    case 'spaced': return { headers: { 'x-claude-code-ide-authorization': `${token} ` } };
    case 'empty': return { headers: { 'x-claude-code-ide-authorization': '' } };
    default: return {};
  }
}

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

const refusedConnection = port => new Promise(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.once('error', error => resolve(error.code));
  socket.once('connect', () => { socket.destroy(); resolve('connected'); });
});

const until = async (check, label) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await check();
    if (value !== null && value !== undefined && value !== false) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
};

/* ---- the driver ---------------------------------------------------------------------------------
 *
 * `harness` is what each side implements:
 *   start(options, source) -> { published, reason, port, lock, authToken, ready,
 *                               selection(v), mention(v), clients(), observed(), close() }  (all awaited)
 *   sweep(directory) -> removed paths
 *   directory(env) -> the lock directory that environment resolves to
 */
export const SOURCES = {
  items: async () => [ITEM],
  slow: async () => { await new Promise(resolve => setTimeout(resolve, 300)); return [ITEM]; },
  undefined: async () => undefined,
  null: async () => null,
  throws: async () => { throw new Error('the language server is on fire'); },
  none: null,
};

export async function answers(harness) {
  const recorded = {};
  /* Through JSON, because the record is JSON: an `undefined` the module answers is a key the
     record does not have, and the comparison is between what was written and what would be. */
  for (const [name, options] of CASES) recorded[name] = JSON.parse(JSON.stringify(await drive(harness, options.steps)));
  return recorded;
}

export async function drive(harness, steps) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-ide-corpus-'));
  const bridges = new Map(), clients = new Map(), ports = new Set();
  const fold = folder({ directory, ports, tokens: () => [...bridges.values()].map(b => b.authToken).filter(Boolean) });
  const bridge = name => bridges.get(name ?? 'main') ?? (() => { throw new Error(`no bridge ${name}`); })();
  const out = [];
  try {
    for (const step of steps) {
      if (step.prepopulate) {
        await mkdir(directory, { recursive: true });
        for (const [file, value] of Object.entries(step.prepopulate)) {
          await writeFile(path.join(directory, file), typeof value === 'string' ? value : JSON.stringify(value));
        }
      } else if (step.start) {
        const { as = 'main', port, directory: where, ...rest } = step.start;
        const options = { ...rest, directory: where ? path.join(directory, where) : directory };
        if (port === 'first') options.port = bridge('first').port;
        else if (port === 'free') options.port = await freePort();
        try {
          const handle = await harness.start(options, SOURCES[step.source ?? 'none']);
          bridges.set(as, handle);
          if (handle.port) ports.add(handle.port);
          out.push({ started: as, published: handle.published, reason: fold(handle.reason ?? null),
            port: handle.port === null || handle.port === undefined ? null : fold(String(handle.port)),
            lock: fold(handle.lock ?? null), token: handle.authToken ? (handle.authToken.length === 64 && /^[0-9a-f]+$/.test(handle.authToken) ? '<token>' : handle.authToken) : null,
            ...(port === 'free' ? { wantedTaken: handle.port === options.port } : {}) });
        } catch (error) {
          out.push({ started: as, error: fold(error.message) });
        }
      } else if (step.disk) {
        let names;
        try { names = await readdir(directory); } catch (error) { out.push({ disk: error.code }); continue; }
        /* Sorted by the FOLDED name, so `<port>.lock` has one position whatever port was drawn. */
        names.sort((a, b) => (fold(a) < fold(b) ? -1 : fold(a) > fold(b) ? 1 : 0));
        const entries = [];
        for (const file of names) {
          const info = await stat(path.join(directory, file));
          const entry = { name: fold(file), mode: (info.mode & 0o777).toString(8) };
          if (file.endsWith('.lock')) {
            try { entry.text = fold(await readFile(path.join(directory, file), 'utf8')); } catch { entry.text = null; }
          }
          entries.push(entry);
        }
        const info = await stat(directory);
        out.push({ disk: entries, directoryMode: (info.mode & 0o777).toString(8) });
      } else if (step.sweep) {
        const removed = await harness.sweep(step.sweep === 'missing' ? path.join(directory, 'missing') : directory);
        out.push({ swept: removed.map(file => fold(file)) });
      } else if (step.connect) {
        const { as, token, protocols = [], headers = {}, bridge: on } = step.connect;
        const target = bridge(on);
        const shape = presentation(token, target.authToken);
        const client = rawClient(target.port, { token: shape.token ?? null, protocols: [...(shape.protocols ?? []), ...protocols], headers: { ...(shape.headers ?? {}), ...headers } });
        clients.set(as, client);
        const opened = await client.opened;
        const entry = { connected: as, ...opened };
        if (opened.open) {
          /* Accepted or refused is decided by what answers a ping: an answer, or the close that was
             already on its way. Nothing here waits on a clock. */
          client.send(JSON.stringify({ jsonrpc: '2.0', id: `probe-${as}`, method: 'ping' }));
          const first = await client.next();
          entry.verdict = first.closed ? { closed: first.closed } : { answered: fold(first.text) };
        } else {
          const closed = await client.next();
          entry.closed = closed.closed ?? null;
        }
        out.push(entry);
      } else if (step.send) {
        const { as, frame, expect = 'answer' } = step.send;
        const client = clients.get(as);
        if (client.ended) { out.push({ sent: describe(frame), notOpen: true }); continue; }
        if (typeof frame === 'string') client.send(frame);
        else if (frame.binary) client.sendBinary(JSON.stringify(frame.binary));
        else client.send(JSON.stringify(frame));
        if (expect === 'silent') {
          const probe = `probe-${out.length}`;
          client.send(JSON.stringify({ jsonrpc: '2.0', id: probe, method: 'ping' }));
          const next = await client.next();
          const parsed = next.text ? JSON.parse(next.text) : null;
          out.push(parsed?.id === probe ? { sent: describe(frame), silent: true } : { sent: describe(frame), answered: fold(next.text ?? JSON.stringify(next)) });
        } else {
          const next = await client.next();
          out.push({ sent: describe(frame), answered: next.text ? fold(next.text) : next });
        }
      } else if (step.burst) {
        const { as, frames } = step.burst;
        const client = clients.get(as);
        for (const frame of frames) client.send(JSON.stringify(frame));
        const order = [];
        for (let i = 0; i < frames.length; i++) { const next = await client.next(); order.push(next.text ? JSON.parse(next.text).id : next); }
        out.push({ burst: frames.map(frame => frame.id), answered: order });
      } else if (step.selection || step.mention) {
        const value = step.selection ?? step.mention;
        const method = step.selection ? 'selection' : 'mention';
        const delivered = await bridge('main')[method](value);
        const received = {};
        for (const [as, client] of clients) {
          if (client.ended) continue;
          const frame = await client.next();
          received[as] = frame.text ? fold(frame.text) : frame;
        }
        out.push({ [method]: value, delivered, received });
      } else if (step.disconnect) {
        const client = clients.get(step.disconnect);
        const open = [...clients.values()].filter(other => !other.ended).length;
        client.close();
        await client.next();
        const remaining = await until(async () => { const n = await bridge('main').clients(); return n < open ? n : null; }, 'the bridge noticed the disconnect');
        clients.delete(step.disconnect);
        out.push({ disconnected: step.disconnect, clients: remaining });
      } else if (step.clients) {
        out.push({ clients: await bridge('main').clients() });
      } else if (step.observed) {
        const observed = await bridge('main').observed();
        out.push({ observed: observed.map(({ accepted, where, headers }) => ({ accepted, where, headers: foldHeaders(headers, fold) })) });
      } else if (step.close) {
        const target = bridge(step.close);
        const open = [...clients].filter(([, client]) => !client.ended);
        await target.close();
        const saw = {};
        for (const [as, client] of open) { const frame = await client.next(); saw[as] = frame.closed ?? frame; }
        out.push({ closed: step.close, ...(open.length ? { clientsSaw: saw } : {}) });
      } else if (step.closeAll) {
        await Promise.all(step.closeAll.map(name => bridge(name).close()));
        out.push({ closedAll: step.closeAll });
      } else if (step.connectAfterClose) {
        out.push({ connectAfterClose: await refusedConnection(bridge(step.connectAfterClose).port) });
      } else if (step.ready) {
        const target = bridge(step.ready);
        const ready = await target.ready;
        out.push({ ready, reason: fold(target.reason ?? null), published: target.published,
          port: target.port === null || target.port === undefined ? null : fold(String(target.port)), lock: fold(target.lock ?? null) });
      } else if (step.directory) {
        out.push({ environment: step.directory, directory: (await harness.directory({ HOME: '/home/fixture', ...step.directory })).replace('/home/fixture', '<home>') });
      } else {
        throw new Error(`unknown step ${JSON.stringify(step)}`);
      }
    }
  } finally {
    for (const client of clients.values()) { try { client.socket.terminate(); } catch { /* gone */ } }
    for (const handle of bridges.values()) { try { await handle.close(); } catch { /* gone */ } }
    await rm(directory, { recursive: true, force: true });
  }
  return out;
}

const describe = frame => typeof frame === 'string' ? frame : frame.binary ? { binary: frame.binary } : frame;

/* The machine's numbers out, the rule's words in. */
function folder({ directory, ports, tokens }) {
  return value => {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'string') return value;
    let text = value.split(directory).join('<dir>');
    for (const token of tokens()) text = text.split(token).join('<token>');
    for (const port of ports) text = text.replace(new RegExp(`(?<![0-9])${port}(?![0-9])`, 'g'), '<port>');
    text = text.replace(new RegExp(`(?<![0-9])${LIVE}(?![0-9])`, 'g'), '<self>');
    return text.split(PRODUCT_NAME).join('<product>');
  };
}

function foldHeaders(headers, fold) {
  const sorted = {};
  for (const name of Object.keys(headers).sort()) {
    const value = headers[name];
    sorted[name] = name === 'host' ? '127.0.0.1:<port>' : fold(Array.isArray(value) ? value.join(', ') : String(value));
  }
  return sorted;
}

/* ---- the JavaScript harness: the module under replacement ------------------------------------ */

export async function jsHarness() {
  const ide = await import('../runtime/ide.mjs');
  return {
    async start(options, source) {
      const handle = await ide.startIdeBridge({ ...options, diagnosticsFor: source });
      return {
        get published() { return handle.published; }, get reason() { return handle.reason; },
        get port() { return handle.port; }, get lock() { return handle.lock; }, authToken: handle.authToken, ready: handle.ready,
        selection: async value => handle.selection(value), mention: async value => handle.mention(value),
        clients: async () => handle.clients(), observed: async () => handle.observed ?? [],
        close: () => handle.close(),
      };
    },
    sweep: directory => ide.sweep(directory),
    async directory(env) {
      const saved = {};
      for (const key of ['HOME', 'RENGINE_IDE_DIRECTORY', 'CLAUDE_CONFIG_DIR']) { saved[key] = process.env[key]; delete process.env[key]; }
      for (const [key, value] of Object.entries(env)) process.env[key] = value;
      try { return ide.ideDirectory(); }
      finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
    },
  };
}

export const RECORDED = await (async () => {
  try { return JSON.parse(await readFile(new URL('./ide-corpus.json', import.meta.url), 'utf8')); }
  catch { return null; }
})();

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  console.log(JSON.stringify(await answers(await jsHarness()), null, 2));
}
