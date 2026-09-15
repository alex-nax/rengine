import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocket } from 'ws';
import { startServer } from '../server/main.mjs';
import { startRuntime } from '../runtime/supervisor.mjs';
import { discoverRuntime, ensureRuntime, alive, runtimeDirectory } from '../runtime/discovery.mjs';
import { forward, json, tunnel } from '../runtime/protocol.mjs';
import { request } from '../launcher/sidecar.mjs';
import { fakeCli } from './task-fixtures.mjs';

/* A worker publishes an IDE lock for Claude Code to find (spec 102), and these workers are real, so
   the suite must not publish into the `/ide` menu of whoever is running it. The npm scripts set
   RENGINE_IDE_DIRECTORY; this is the fallback for a file run directly. */
process.env.RENGINE_IDE_DIRECTORY ??= await mkdtemp(path.join(tmpdir(), 'rengine-runtime-ide-'));

async function until(check, label) {
  for (let i = 0; i < 160; i++) { const value = await check(); if (value) return value; await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
async function legacyHost(server) {
  const proxy = http.createServer(async (req, res) => {
    if (req.url === '/api/state') {
      const state = await request(server, 'state'); delete state.capabilities.desktopActions;
      json(res, 200, state);
    } else if (req.url.startsWith('/api/desktop')) json(res, 404, { error: 'Legacy host has no desktop actions.' });
    else forward(req, res, server);
  });
  proxy.on('upgrade', (req, socket, head) => tunnel(req, socket, head, server, () => {}));
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${proxy.address().port}`, token: server.token, instance: server.instance, pid: process.pid,
    close: () => new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections(); }) };
}

test('layered workspace and MCP replacement retain a legacy host and active PTY streams', { timeout: 40000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-runtime-'));
  let host, legacy, runtime, socket, mcp;
  try {
    const project = path.join(directory, 'project'), foreign = path.join(directory, 'foreign');
    await mkdir(project); await mkdir(foreign);
    const marker = path.join(project, 'invocations.txt'), fixture = path.join(project, 'cli.cjs');
    await writeFile(fixture, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'once\\n');
process.stdin.setRawMode(true); console.log('CLI_READY'); process.stdin.on('data', data => console.log('INPUT_' + data.toString('hex')));`);
    host = await startServer({ stateDir: path.join(directory, 'host') });
    const root = await host.store.addRoot(project), other = await host.store.addRoot(foreign);
    const session = await host.sessions.terminal({ rootId: root.id, command: process.execPath, args: [fixture] });
    legacy = await legacyHost(host);
    assert.equal((await request(legacy, 'state')).capabilities.desktopActions, undefined);
    /* The workspace worker is an executable (F158). The supervisor is handed a shim this test owns —
       never the binary itself, which the broken-candidate case below would otherwise overwrite — and
       the shim execs the real one until that case replaces it. Same device as the connector's.

       This is the LEGACY-HOST case, which is why it is worth saying what it proves: the worker
       serves the desktop registry above a host that has no desktop routes at all, because it holds
       the registry and terminates `/events` itself (spec 143). */
    const workerFile = path.join(directory, 'workspace-worker');
    const workerBinary = process.env.RENGINE_RED_WORKER || path.resolve('red/target/debug/red-worker');
    await writeFile(workerFile, `#!/bin/sh\nexec ${JSON.stringify(workerBinary)} "$@" --no-ide\n`, { mode: 0o755 });
    /* The connector layer is an executable now (F187). The supervisor is handed a shim this test
       owns — never the binary itself, which a test that writes a broken candidate would otherwise
       overwrite — and the shim execs the real one until the failure case replaces it. */
    const toolWorkerFile = path.join(directory, 'tool-worker');
    const connector = process.env.RENGINE_RED_MCP || path.resolve('red/target/debug/red-mcp');
    await writeFile(toolWorkerFile, `#!/bin/sh\nexec ${JSON.stringify(connector)} "$@"\n`, { mode: 0o755 });
    const runtimeDir = path.join(directory, 'runtime');
    runtime = await startRuntime({ host: legacy, directory: runtimeDir, workerFile, toolWorkerFile });
    assert.equal((await request(runtime, 'state')).capabilities.desktopActions, 1);
    assert.equal((await discoverRuntime(legacy, runtimeDir)).pid, process.pid);
    await assert.rejects(discoverRuntime({ ...legacy, token: 'a'.repeat(64) }, runtimeDir), /another session host/);
    const unauthorized = await fetch(`${runtime.url}/api/update-status?rootId=${root.id}`); assert.equal(unauthorized.status, 401);
    const foreignOrigin = await fetch(`${runtime.url}/api/state`, { headers: { authorization: `Bearer ${runtime.token}`, origin: 'https://unrelated.invalid' } }); assert.equal(foreignOrigin.status, 401);
    const messages = [];
    socket = new WebSocket(`${runtime.url.replace('http', 'ws')}/events?token=${runtime.token}`);
    socket.on('message', bytes => messages.push(JSON.parse(bytes))); await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'attach', id: session.id }));
    await until(() => messages.some(x => x.type === 'attached'), 'attached legacy PTY');
    socket.send(JSON.stringify({ type: 'desktop-register', rootIds: [root.id], sessionIds: [session.id], canReload: true }));
    await until(() => messages.some(x => x.type === 'desktop-registered'), 'current desktop actions above legacy host');
    const contextFile = path.join(directory, 'context.json');
    await writeFile(contextFile, JSON.stringify({ ...legacy, rootId: root.id, runtimeDirectory: runtimeDir }), { mode: 0o600 });
    mcp = new Client({ name: 'layered-update-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('orchestrator/agents/mcp.mjs'), '--context', contextFile], stderr: 'pipe' });
    await mcp.connect(transport);
    const call = async (name, args = {}) => {
      const result = await mcp.callTool({ name, arguments: args }); assert.ok(!result.isError, JSON.stringify(result)); return result.structuredContent ?? JSON.parse(result.content[0].text);
    };
    const first = await call('update_status'), facadePid = transport.pid;
    const desktop = first.desktops[0]; assert.equal(desktop.managed, false);
    const beforeScript = host.sessions.items.size;
    const unsupportedScript = await mcp.callTool({ name: 'open_script', arguments: { path: 'flow.sh', desktopId: desktop.id } });
    assert.equal(unsupportedScript.isError, true); assert.match(unsupportedScript.content[0].text, /Update this desktop/);
    assert.equal(host.sessions.items.size, beforeScript);
    const foreignUpdate = await mcp.callTool({ name: 'update_workspace', arguments: { layers: ['desktop'], desktopId: 'not-this-root' } }); assert.equal(foreignUpdate.isError, true);
    const queued = await call('update_workspace', { layers: ['workspace', 'connector'] });
    await assert.rejects(request(runtime, 'update-workspace', { rootId: root.id, layers: ['connector'] }), /already running/);
    await writeFile(contextFile, JSON.stringify({ ...legacy, rootId: other.id, runtimeDirectory: runtimeDir }));
    const finished = await until(async () => { const value = await call('update_status'); return value.jobs.find(x => x.id === queued.jobId)?.status === 'succeeded' && value.toolWorkerPid !== first.toolWorkerPid && value; }, 'worker update and next-request tool replacement');
    assert.notEqual(finished.workspace.pid, first.workspace.pid); assert.notEqual(finished.toolWorkerPid, first.toolWorkerPid);
    assert.equal(transport.pid, facadePid); assert.equal((await call('workspace_info')).root.id, root.id);
    assert.equal(finished.workspace.retiring.length, 1); assert.equal(socket.readyState, WebSocket.OPEN);
    socket.send(JSON.stringify({ type: 'input', id: session.id, data: 'still-alive' }));
    await until(() => host.sessions.snapshot(session.id, true).output.includes('INPUT_7374696c6c2d616c697665'), 'input across worker update');
    assert.equal(host.sessions.snapshot(session.id).pid, session.pid);
    assert.equal(await readFile(marker, 'utf8'), 'once\n');
    /* A candidate that will not start, which is what a broken build looks like to the layer above:
       the supervisor must refuse to adopt it and keep serving from the worker it has. */
    await writeFile(workerFile, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const failed = await call('update_workspace', { layers: ['workspace'] });
    const failure = await until(async () => { const value = await call('update_status'); return value.jobs.find(x => x.id === failed.jobId)?.status === 'failed' && value; }, 'failed candidate');
    assert.equal(failure.workspace.pid, finished.workspace.pid);
    assert.equal(host.sessions.snapshot(session.id).state, 'running');
    /* A candidate that will not start: the probe runs it and it exits non-zero, which is what the
       supervisor must refuse to adopt. */
    await writeFile(toolWorkerFile, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    const badTools = await call('update_workspace', { layers: ['connector'] });
    const toolFailure = await until(async () => { const value = await call('update_status'); return value.jobs.find(x => x.id === badTools.jobId)?.status === 'failed' && value; }, 'failed MCP candidate');
    assert.equal(toolFailure.connectorGeneration, finished.connectorGeneration);
    assert.equal(toolFailure.toolWorkerPid, finished.toolWorkerPid);
    /* The facade recreates a crashed worker from the file the supervisor published (spec 101), which
       is this one; a crash while it is still broken on disk is the source edit's failure, not recovery's. */
    await writeFile(toolWorkerFile, `#!/bin/sh\nexec ${JSON.stringify(connector)} "$@"\n`, { mode: 0o755 });
    process.kill(toolFailure.toolWorkerPid, 'SIGTERM'); await delay(100);
    const toolRecovery = await call('update_status'); assert.notEqual(toolRecovery.toolWorkerPid, toolFailure.toolWorkerPid);
    /* Put the working shim back before crashing the worker, so recovery has something to start. */
    await writeFile(workerFile, `#!/bin/sh\nexec ${JSON.stringify(workerBinary)} "$@" --no-ide\n`, { mode: 0o755 });
    process.kill(toolRecovery.workspace.pid, 'SIGTERM');
    const recovered = await until(async () => { const value = await call('update_status'); return value.workspace.recovery.state === 'recovered' && value; }, 'workspace worker recovers independently');
    assert.notEqual(recovered.workspace.pid, toolRecovery.workspace.pid); assert.equal(host.sessions.snapshot(session.id).pid, session.pid);
    socket.send(JSON.stringify({ type: 'input', id: session.id, data: 'retained-stream' }));
    await until(() => host.sessions.snapshot(session.id, true).output.includes('INPUT_72657461696e65642d73747265616d'), 'older stream survives current worker crash');
    socket.close(); await once(socket, 'close'); socket = null;
    await until(async () => (await runtime.status(root.id)).workspace.retiring.length === 0, 'retired stream worker drains');
  } finally {
    socket?.terminate(); await mcp?.close(); await runtime?.close(); await legacy?.close(); await host?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('cold runtime startup is serialized and an unavailable live owner never creates a duplicate', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-runtime-startup-'));
  let host, runtime;
  try {
    host = await startServer({ stateDir: path.join(directory, 'host') });
    const runtimeDir = path.join(directory, 'runtime');
    const pair = await Promise.all([ensureRuntime(host, { directory: runtimeDir }), ensureRuntime(host, { directory: runtimeDir })]);
    runtime = pair[0]; assert.equal(pair[1].pid, runtime.pid); assert.notEqual(runtime.pid, process.pid);
    const filename = path.join(runtimeDir, 'runtime.json'), descriptor = await readFile(filename, 'utf8');
    await writeFile(filename, JSON.stringify({ ...JSON.parse(descriptor), url: 'http://127.0.0.1:1' }));
    await assert.rejects(ensureRuntime(host, { directory: runtimeDir }), /alive but unavailable.*No duplicate/);
    await writeFile(filename, descriptor);
    assert.equal((await ensureRuntime(host, { directory: runtimeDir })).pid, runtime.pid);
    assert.deepEqual(host.sessions.list(), []);
  } finally {
    if (runtime) { process.kill(runtime.pid, 'SIGTERM'); await until(() => !alive(runtime.pid), 'isolated runtime stopped'); }
    await host?.close(); await rm(directory, { recursive: true, force: true });
  }
});

/* KI-110: the connector reads `runtimeDirectory` from the context and computes nothing of its own
   when the field is absent, so a host that minted the field away routed every pane to itself —
   eight capabilities short of the runtime worker. */
test('the agent context a host mints names the runtime directory its own supervisor uses', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-agent-context-'));
  const project = path.join(directory, 'project');
  await mkdir(project);
  const host = await startServer({ stateDir: path.join(directory, 'host'), frontDoor: false });
  t.after(async () => { await host.close(); await rm(directory, { recursive: true, force: true }); });
  const root = await host.store.addRoot(project);
  await fakeCli(host.store.directory, 'claude');
  await host.sessions.terminal({ rootId: root.id, type: 'agent', agent: 'claude' });
  const context = JSON.parse(await readFile(path.join(host.store.directory, 'integrations', `${root.id}.json`), 'utf8'));
  assert.ok(context.runtimeDirectory, 'the minted context names a runtime directory');
  assert.equal(context.runtimeDirectory, runtimeDirectory(host), 'the one ensureRuntime would start this host’s supervisor in');
  assert.deepEqual(Object.keys(context).sort(), ['instance', 'rootId', 'runtimeDirectory', 'token', 'url'],
    'and it is the shape runtime/supervisor.mjs writes for a pane of its own');
});
