import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { WebSocket } from 'ws';
import { startIdeBridge, sweep, IDE_NAME } from '../runtime/ide.mjs';
import { startServer } from '../server/main.mjs';
import { startWorker } from '../runtime/worker.mjs';
import { uriFor } from '../runtime/lsp.mjs';
import { setTimeout as delay } from 'node:timers/promises';

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

test('the worker resolves the desktop\'s root and path into the file path the CLI is given', { timeout: 40000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-ide-worker-'));
  process.env.RENGINE_IDE_DIRECTORY ??= path.join(dir, 'locks');
  const project = path.join(dir, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'a.c'), 'int main(void) { return 0; }\n');
  const host = await startServer({ stateDir: path.join(dir, 'state') });
  const root = await host.store.addRoot(project);
  const worker = await startWorker({ url: host.url, token: host.token, instance: host.instance },
    { directory: path.join(dir, 'runtime'), ideOptions: { directory: path.join(dir, 'locks'), hostPid: process.pid } });
  try {
    const client = await connected(worker.ide);
    const arrived = new Promise(resolve => { client.fallbackNotificationHandler = n => { resolve(n); return Promise.resolve(); }; });
    // The desktop names a root and a path within it, exactly as it does on every other route; the
    // absolute path is the workspace's business, because the roots live there.
    const answer = await fetch(`${worker.url}/api/ide-selection`, { method: 'POST',
      headers: { authorization: `Bearer ${worker.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ rootId: root.id, path: 'a.c', text: 'int main',
        selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } } }) });
    // Only what this test is about: the route also reports which language servers were told, and a
    // deep-equal here would fail every time that answer grows a field.
    assert.equal((await answer.json()).delivered, 1);
    const notification = await arrived;
    assert.equal(notification.method, 'selection_changed');
    // The root's own stored path, which is the real one: the store resolves symlinks when a root is
    // bound, and on macOS a temp directory is one. The CLI must be given the path it can open.
    assert.equal(notification.params.filePath, path.join(root.path, 'a.c'),
      `the CLI is given a path it can open: ${JSON.stringify(notification.params)}`);
    await client.close();
  } finally { await worker.close(); await host.close(); await rm(dir, { recursive: true, force: true }); }
});

test('getDiagnostics answers with what the project\'s declared language server published', { timeout: 40000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-ide-lsp-'));
  process.env.RENGINE_IDE_DIRECTORY ??= path.join(dir, 'locks');
  const project = path.join(dir, 'project');
  await mkdir(path.join(project, '.rengine'), { recursive: true });
  await writeFile(path.join(project, 'a.c'), 'int main(void) { return 0; }\n');
  await writeFile(path.join(project, '.rengine', 'project.json'), JSON.stringify({
    contract: 7, project: 'lsp-fixture',
    formats: [{ id: 'c', title: 'C', match: ['*.c'], modes: ['text'], default: 'text' }],
    languageServers: [{ id: 'fake', languageId: 'c', match: ['*.c'],
      command: [process.execPath, path.resolve('orchestrator/tests/fake-language-server.mjs')] }],
  }));
  const host = await startServer({ stateDir: path.join(dir, 'state') });
  const root = await host.store.addRoot(project);
  const worker = await startWorker({ url: host.url, token: host.token, instance: host.instance },
    { directory: path.join(dir, 'runtime'), ideOptions: { directory: path.join(dir, 'locks'), hostPid: process.pid } });
  try {
    const client = await connected(worker.ide);
    const file = path.join(root.path, 'a.c');
    const post = buffer => fetch(`${worker.url}/api/ide-selection`, { method: 'POST',
      headers: { authorization: `Bearer ${worker.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ rootId: root.id, path: 'a.c', text: '', buffer,
        selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }) });

    // The desktop's unsaved buffer is what the server is told — nothing here is written to disk.
    const answer = await (await post('int main(void) {\n  // TODO unsaved\n}\n')).json();
    assert.deepEqual(answer.servers, ['fake'], `the declared server serves this file: ${JSON.stringify(answer)}`);
    const read = async () => JSON.parse((await client.callTool({ name: 'getDiagnostics', arguments: { uri: uriFor(file) } })).content[0].text);
    let published = [];
    for (let i = 0; i < 100 && !published.length; i++) { published = (await read())[0].diagnostics; await delay(50); }
    assert.equal(published.length, 1, `the agent reads what the server published: ${JSON.stringify(published)}`);
    assert.equal(published[0].message, 'TODO on line 2');
    assert.deepEqual(published[0].range.start, { line: 1, character: 5 });

    // Edit the buffer and the answer follows it, still without touching the file.
    await post('// TODO one\n// TODO two\n');
    let changed = [];
    for (let i = 0; i < 100 && changed.length !== 2; i++) { changed = (await read())[0].diagnostics; await delay(50); }
    assert.deepEqual(changed.map(item => item.message), ['TODO on line 1', 'TODO on line 2']);
    assert.equal(await readFile(path.join(project, 'a.c'), 'utf8'), 'int main(void) { return 0; }\n', 'and the file on disk is untouched');
    await client.close();
  } finally { await worker.close(); await host.close(); await rm(dir, { recursive: true, force: true }); }
});

test('the deliberate mention is a different notification from the passive selection', async () => {
  const dir = await directory();
  const bridge = await startIdeBridge({ roots: ['/work'], hostPid: process.pid, directory: dir });
  try {
    const client = await connected(bridge);
    const seen = [];
    client.fallbackNotificationHandler = notification => { seen.push(notification); return Promise.resolve(); };
    bridge.selection({ filePath: '/work/a.c', text: 'x', selection: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } } });
    assert.equal(bridge.mention({ filePath: '/work/a.c', lineStart: 2, lineEnd: 4 }), 1);
    for (let i = 0; i < 60 && seen.length < 2; i++) await delay(50);
    const methods = seen.map(n => n.method);
    assert.deepEqual(methods, ['selection_changed', 'at_mentioned'],
      `the CLI keeps the two apart, so we must too: ${methods.join(', ')}`);
    // The schema is the CLI's own, read out of its binary: filePath with an optional line range,
    // not the selection's start/end objects.
    assert.deepEqual(seen[1].params, { filePath: '/work/a.c', lineStart: 2, lineEnd: 4 });
    await client.close();
  } finally { await bridge.close(); await rm(dir, { recursive: true, force: true }); }
});

test('the port survives a worker replacement, because the CLI reconnects to the one it read', async () => {
  const dir = await directory();
  // The worker being replaced still holds the port when its successor starts, which is exactly the
  // shape of a layered update. Taking a different port would look like success and would end every
  // IDE session on the machine, which is what KI-066 was.
  const first = await startIdeBridge({ roots: ['/work'], hostPid: process.pid, workerPid: 1, directory: dir });
  const second = await startIdeBridge({ roots: ['/work'], hostPid: process.pid, workerPid: 2, port: first.port,
    directory: dir, retakeTimeoutMs: 10000 });
  try {
    assert.equal(second.published, false, 'the successor does not settle for another port');
    assert.match(second.reason, /still held/);
    await first.close();
    assert.equal(await second.ready, true, `the successor takes the port once it is free: ${second.reason}`);
    assert.equal(second.port, first.port, 'and it is the same port the CLI already knows');
    assert.deepEqual(await readdir(dir), [`${first.port}.lock`], 'one lock, at the same path');
    const lock = JSON.parse(await readFile(second.lock, 'utf8'));
    assert.equal(lock.rengineWorker, 2, 'written by the worker that now owns it');
    // And it really serves: a reconnection to that port is what the CLI would do.
    const client = await connected(second);
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['getDiagnostics']);
    await client.close();
  } finally { await second.close(); await first.close(); await rm(dir, { recursive: true, force: true }); }
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
