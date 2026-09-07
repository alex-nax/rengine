import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { WebSocket } from 'ws';
import { startIdeBridge, sweep, IDE_NAME } from '../runtime/ide.mjs';

const directory = async () => mkdtemp(path.join(tmpdir(), 'rengine-ide-'));

/* The client side of the same one-frame-one-message transport the bridge serves. */
class SocketTransport {
  constructor(url, token) { this.url = url; this.token = token; }
  async start() {
    // Exactly what claude 2.1.263 sends: the lock's token in this header, asking for `mcp`.
    this.socket = new WebSocket(this.url, ['mcp'], { headers: { 'x-claude-code-ide-authorization': this.token } });
    await new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
      this.socket.once('close', (code, reason) => reject(new Error(`closed ${code} ${reason}`)));
    });
    this.socket.removeAllListeners('close');
    this.socket.removeAllListeners('error');
    this.socket.on('message', data => this.onmessage?.(JSON.parse(data.toString())));
    this.socket.on('close', () => this.onclose?.());
    this.socket.on('error', error => this.onerror?.(error));
  }
  async send(message) { this.socket.send(JSON.stringify(message)); }
  async close() { this.socket.close(); }
}

async function connected(bridge) {
  const client = new Client({ name: 'verification', version: '1.0.0' });
  await client.connect(new SocketTransport(`ws://127.0.0.1:${bridge.port}`, bridge.authToken));
  return client;
}

test('the lock file is the one Claude Code knows how to read', async () => {
  const dir = await directory();
  const bridge = await startIdeBridge({ roots: ['/work/one', '/work/two'], hostPid: 4242, workerPid: 99, directory: dir });
  try {
    assert.equal(bridge.published, true);
    // The port is the filename and nothing inside the file: that is how the CLI learns where to connect.
    assert.equal(path.basename(bridge.lock), `${bridge.port}.lock`);
    const lock = JSON.parse(await readFile(bridge.lock, 'utf8'));
    assert.deepEqual(lock.workspaceFolders, ['/work/one', '/work/two']);
    assert.equal(lock.ideName, IDE_NAME);
    assert.equal(lock.useWebSocket, true);
    // The pid must be the session host's, because the CLI only trusts a lock naming one of a pane's
    // own ancestors, and the worker is not one of them.
    assert.equal(lock.pid, 4242, `the lock names the host, not the worker: ${JSON.stringify(lock)}`);
    assert.equal(lock.rengineWorker, 99, 'and marks itself ours, so a dead one can be collected');
    assert.ok(lock.authToken && lock.authToken.length >= 32);
  } finally { await bridge.close(); await rm(dir, { recursive: true, force: true }); }
});

test('without the host pid nothing is published, and it says why', async () => {
  const dir = await directory();
  const bridge = await startIdeBridge({ roots: ['/work'], directory: dir });
  assert.equal(bridge.published, false);
  assert.match(bridge.reason, /session host/);
  assert.deepEqual(await readdir(dir).catch(() => []), [], 'no lock is left pointing at nothing');
  await rm(dir, { recursive: true, force: true });
});

test('an MCP client over the socket lists the tools and reads diagnostics', async () => {
  const dir = await directory();
  const bridge = await startIdeBridge({ roots: ['/work'], hostPid: process.pid, directory: dir });
  try {
    const client = await connected(bridge);
    assert.equal(client.transport.socket.protocol, 'mcp', 'the subprotocol the CLI asks for is echoed back');
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    assert.deepEqual(tools, ['getDiagnostics'], `slice 1 serves exactly one tool: ${tools.join(', ')}`);
    const answer = await client.callTool({ name: 'getDiagnostics', arguments: { uri: 'file:///work/a.c' } });
    // An empty list is the honest answer from an editor with no language server; a refusal would
    // make the CLI report rEdit as broken rather than as quiet.
    assert.deepEqual(JSON.parse(answer.content[0].text), [{ uri: 'file:///work/a.c', diagnostics: [] }]);
    await client.close();
  } finally { await bridge.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a connection without the token is refused', async () => {
  const dir = await directory();
  const bridge = await startIdeBridge({ roots: ['/work'], hostPid: process.pid, directory: dir });
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    const closed = await new Promise((resolve, reject) => {
      socket.once('close', code => resolve(code));
      socket.once('error', reject);
      setTimeout(() => reject(new Error('the socket was neither closed nor refused')), 5000).unref?.();
    });
    assert.equal(closed, 1008, 'the socket is closed with a policy violation, not left open');
    assert.equal(bridge.clients(), 0, 'and no client is registered');
    const refused = bridge.observed.at(-1);
    assert.equal(refused.accepted, false);
  } finally { await bridge.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a selection posted by the desktop reaches a connected CLI', async () => {
  const dir = await directory();
  const bridge = await startIdeBridge({ roots: ['/work'], hostPid: process.pid, directory: dir });
  try {
    const client = await connected(bridge);
    const arrived = new Promise(resolve => client.fallbackNotificationHandler = notification => { resolve(notification); return Promise.resolve(); });
    const value = { filePath: '/work/a.c', text: 'int main(void)', selection: { start: { line: 3, character: 0 }, end: { line: 3, character: 14 } } };
    assert.equal(bridge.selection(value), 1, 'the bridge reports how many CLIs it reached');
    const notification = await arrived;
    assert.equal(notification.method, 'selection_changed', `the CLI's own vocabulary: ${JSON.stringify(notification)}`);
    assert.deepEqual(notification.params, value);
    await client.close();
  } finally { await bridge.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a lock left by a dead rEdit worker is collected, and another IDE is left alone', async () => {
  const dir = await directory();
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, '111.lock'), JSON.stringify({ pid: 1, ideName: IDE_NAME, rengineWorker: 4242 }));
  await writeFile(path.join(dir, '222.lock'), JSON.stringify({ pid: 1, ideName: IDE_NAME, rengineWorker: process.pid }));
  await writeFile(path.join(dir, '333.lock'), JSON.stringify({ pid: 1, ideName: 'VS Code' }));
  // The CLI collects a lock whose pid is dead; ours names the session host, which outlives the
  // worker, so nobody but us can tell that this one is stale.
  const removed = await sweep(dir, { alive: pid => pid === process.pid });
  assert.deepEqual(removed.map(file => path.basename(file)), ['111.lock']);
  const left = (await readdir(dir)).sort();
  assert.deepEqual(left, ['222.lock', '333.lock'], `a live worker's lock and another IDE's are untouched: ${left.join(', ')}`);
  await rm(dir, { recursive: true, force: true });
});

test('closing the bridge removes its own lock', async () => {
  const dir = await directory();
  const bridge = await startIdeBridge({ roots: ['/work'], hostPid: process.pid, directory: dir });
  assert.deepEqual(await readdir(dir), [`${bridge.port}.lock`]);
  await bridge.close();
  assert.deepEqual(await readdir(dir), [], 'the lock names a host that is still alive, so leaving it would strand it');
  await rm(dir, { recursive: true, force: true });
});
