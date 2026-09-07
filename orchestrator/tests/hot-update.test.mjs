import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { startServer } from '../server/main.mjs';
import { startRuntime } from '../runtime/supervisor.mjs';
import { forward, json, tunnel } from '../runtime/protocol.mjs';
import { alive, ensureSidecar, request } from '../launcher/sidecar.mjs';
import { parseProcessTable } from '../launcher/replace.mjs';
import { hostStateDirectory } from '../runtime/tracker.mjs';

const FACADE = path.resolve('orchestrator/agents/mcp.mjs');
const INVENTORY = {
  schema_version: 1, project: 'fixture', review_status: 'approved',
  features: [
    { id: 1, description: 'done', passes: true, dependencies: [], milestone: 'O1', category: 'workspace', priority: 'high' },
    { id: 2, description: 'ready', passes: false, dependencies: [1], milestone: 'O1', category: 'workspace', priority: 'medium' },
    { id: 3, description: 'blocked', passes: false, dependencies: [2], milestone: 'O2', category: 'design', priority: 'low' },
  ],
};
const FORMAT = { id: 'text', title: 'Text', match: ['*.txt'], modes: ['raw'], default: 'raw' };

async function until(check, label, tries = 160) {
  for (let i = 0; i < tries; i++) { const value = await check(); if (value) return value; await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
async function project(directory, name, declaration) {
  const root = path.join(directory, name);
  await mkdir(path.join(root, '.rengine'), { recursive: true });
  await writeFile(path.join(root, 'features.json'), JSON.stringify(INVENTORY));
  if (declaration) await writeFile(path.join(root, '.rengine', 'project.json'), JSON.stringify(declaration));
  return root;
}
const byKey = rows => Object.fromEntries(rows.map(row => [row.key, row]));
const get = (instance, route) => fetch(`${instance.url}/api/${route}`, { headers: { authorization: `Bearer ${instance.token}` } });

/* The live host's shape on 2026-09-07: a real `main.mjs --state DIR` process from before the tracker
   existed. It answers the routes with the host's own 404 and says nothing about its state directory. */
async function retainedHost(server) {
  const proxy = http.createServer(async (req, res) => {
    const target = new URL(req.url, 'http://127.0.0.1');
    if (target.pathname === '/api/state') {
      const state = await request(server, 'state');
      delete state.stateDir; delete state.capabilities.tracker;
      json(res, 200, state);
    } else if (target.pathname.startsWith('/api/tracker')) json(res, 404, { error: 'Unknown workspace endpoint.' });
    else forward(req, res, server);
  });
  proxy.on('upgrade', (req, socket, head) => tunnel(req, socket, head, server, () => {}));
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${proxy.address().port}`, token: server.token, instance: server.instance, pid: process.pid,
    close: () => new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections(); }) };
}
async function stopHost(host) {
  if (!host) return;
  try { process.kill(host.pid, 'SIGTERM'); } catch { return; }
  await until(() => !alive(host.pid), `child host ${host.pid} stopped`);
}
async function facade(contextFile) {
  const client = new Client({ name: 'hot-update-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [FACADE, '--context', contextFile], stderr: 'pipe' });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, `${name}: ${JSON.stringify(result)}`);
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  };
  return { client, call };
}

test('the tracker routes are served by the worker above a retained host that never had them', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-hot-update-'));
  let child, retained, runtime, mcp;
  try {
    const local = await project(directory, 'local', null);
    const linear = await project(directory, 'linear', { contract: 5, project: 'kohai', formats: [FORMAT], tracker: { provider: 'linear', team: 'KOH' } });
    const stateDir = path.join(directory, 'host-state');
    child = await ensureSidecar(stateDir);
    const root = await request(child, 'roots', { path: local }), remote = await request(child, 'roots', { path: linear });
    retained = await retainedHost(child);
    assert.equal((await get(retained, `tracker?rootId=${root.id}`)).status, 404, 'the retained host has no tracker route; that is the defect');
    assert.equal((await request(retained, 'state')).stateDir, undefined, 'and it does not say where its state lives');

    runtime = await startRuntime({ host: retained, directory: path.join(directory, 'runtime') });
    const state = await request(runtime, 'state');
    assert.equal(state.capabilities.tracker, 1, 'the worker advertises the capability it serves itself');

    const tasks = await request(runtime, `tracker?${new URLSearchParams({ rootId: root.id })}`);
    assert.equal(tasks.provider, 'local');
    const rows = byKey(tasks.rows);
    assert.equal(rows.F1.state.category, 'completed'); assert.equal(rows.F2.state.category, 'unstarted'); assert.equal(rows.F3.state.category, 'blocked');

    // The directory was found through the process table, since the host did not say: the setup
    // instructions name that host's own trackers directory, and no other.
    const setup = await request(runtime, 'tracker/signin', { rootId: remote.id });
    assert.equal(setup.ok, false);
    assert.equal(setup.setup.step3.includes(path.join(stateDir, 'trackers', 'oauth.json')), true, setup.setup.step3);

    // With an application registered there, the sign-in starts in the worker: a URL for the browser and
    // a loopback redirect, no network touched until the browser comes back.
    await mkdir(path.join(stateDir, 'trackers'), { recursive: true });
    await writeFile(path.join(stateDir, 'trackers', 'oauth.json'), JSON.stringify({ linear: { clientId: 'client-123' } }));
    const started = await request(runtime, 'tracker/signin', { rootId: remote.id });
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.match(started.url, /^https:\/\/linear\.app\/oauth\/authorize\?.*client_id=client-123/);
    assert.match(started.redirect, /^http:\/\/127\.0\.0\.1:4782[1-5]\/tracker\/callback$/);
    assert.deepEqual(await request(runtime, 'tracker/signout', { rootId: remote.id }), { revoked: false });
    const denied = await request(runtime, `tracker?${new URLSearchParams({ rootId: remote.id })}`);
    assert.equal(denied.provider, 'linear'); assert.equal(denied.denied, 'Not signed in to Linear.'); assert.equal(denied.signIn, 'linear');

    // And the same rows through the real facade, as an attached agent reads them.
    const contextFile = path.join(directory, 'context.json');
    await writeFile(contextFile, JSON.stringify({ url: retained.url, token: retained.token, instance: retained.instance, rootId: root.id, runtimeDirectory: path.join(directory, 'runtime') }), { mode: 0o600 });
    mcp = await facade(contextFile);
    const listed = await mcp.call('list_tasks');
    assert.equal(listed.provider, 'local'); assert.equal(byKey(listed.rows).F3.state.category, 'blocked');
  } finally {
    await mcp?.client.close(); await runtime?.close(); await retained?.close(); await stopHost(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test('a host that says where its state lives needs no process table', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-hot-update-state-'));
  let host, runtime;
  try {
    const stateDir = path.join(directory, 'state');
    host = await startServer({ stateDir });
    const root = await host.store.addRoot(await project(directory, 'linear', { contract: 5, project: 'kohai', formats: [FORMAT], tracker: { provider: 'linear', team: 'KOH' } }));
    assert.equal((await request(host, 'state')).stateDir, stateDir);
    runtime = await startRuntime({ host: { url: host.url, token: host.token, instance: host.instance, pid: process.pid }, directory: path.join(directory, 'runtime') });
    const setup = await request(runtime, 'tracker/signin', { rootId: root.id });
    assert.equal(setup.ok, false);
    assert.equal(setup.setup.step3.includes(path.join(stateDir, 'trackers', 'oauth.json')), true, setup.setup.step3);
  } finally {
    await runtime?.close(); await host?.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('the state directory is keyed by the descriptor instance, never the URL or the first host row', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-hot-update-table-'));
  try {
    const a = path.join(directory, 'a'), b = path.join(directory, 'b');
    for (const [dir, instance, port] of [[a, 'aaaaaaaa-1111-4111-8111-111111111111', 61942], [b, 'bbbbbbbb-2222-4222-8222-222222222222', 61943]]) {
      await mkdir(dir); await writeFile(path.join(dir, 'sidecar.json'), JSON.stringify({ url: `http://127.0.0.1:${port}`, token: 'f'.repeat(64), instance, pid: 1 }));
    }
    const table = parseProcessTable(`
    1     0 /sbin/launchd
  100     1 /usr/bin/node /x/rengine/orchestrator/server/main.mjs --state ${b}
  200     1 /usr/bin/node /x/rengine/orchestrator/server/main.mjs --state ${a}
  300     1 /usr/bin/node /x/rengine/orchestrator/runtime/supervisor.mjs
  400     1 /usr/bin/node /x/rengine/orchestrator/server/main.mjs --state ${path.join(directory, 'gone')}
`);
    // The worker is handed a proxy's URL, not the descriptor's, and host b is the first row.
    const proxied = { url: 'http://127.0.0.1:50000', token: 'f'.repeat(64), instance: 'aaaaaaaa-1111-4111-8111-111111111111' };
    assert.deepEqual(await hostStateDirectory(proxied, {}, { processes: table }), { stateDir: a, source: 'process-table', pid: 200 });
    assert.deepEqual(await hostStateDirectory(proxied, { stateDir: '/elsewhere' }, { processes: table }), { stateDir: '/elsewhere', source: 'host' });
    const unknown = await hostStateDirectory({ ...proxied, instance: 'cccccccc-3333-4333-8333-333333333333' }, {}, { processes: table });
    assert.equal(unknown.stateDir, null); assert.match(unknown.reason, /cccccccc-3333/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an idle facade learns of a connector update without a request, and a stale name is refused with the way back', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-hot-update-facade-'));
  let host, runtime, client;
  try {
    host = await startServer({ stateDir: path.join(directory, 'state') });
    const root = await host.store.addRoot(await project(directory, 'local', null));
    const toolWorkerFile = path.join(directory, 'tool-worker.mjs');
    const worker = name => `import ${JSON.stringify(pathToFileURL(path.resolve('orchestrator', name)).href)};`;
    await writeFile(toolWorkerFile, worker('tests/stale-tool-worker.mjs'));
    const runtimeDir = path.join(directory, 'runtime');
    runtime = await startRuntime({ host: { url: host.url, token: host.token, instance: host.instance, pid: process.pid }, directory: runtimeDir, toolWorkerFile });
    const contextFile = path.join(directory, 'context.json');
    await writeFile(contextFile, JSON.stringify({ url: host.url, token: host.token, instance: host.instance, rootId: root.id, runtimeDirectory: runtimeDir }), { mode: 0o600 });

    // The facade runs the tool worker the supervisor probed and published, so its first generation is
    // the stale worker and its second is the checkout's.
    let notifications = 0;
    client = new Client({ name: 'hot-update-idle', version: '1.0.0' });
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notifications++; });
    const transport = new StdioClientTransport({ command: process.execPath, args: [FACADE, '--context', contextFile], stderr: 'pipe' });
    await client.connect(transport);
    const names = async () => (await client.listTools()).tools.map(tool => tool.name);
    const before = await names();
    assert.ok(before.includes('old_tool') && !before.includes('list_tasks'), `first generation: ${before}`);
    const first = await client.callTool({ name: 'update_status', arguments: {} });
    const stalePid = first.structuredContent.toolWorkerPid;

    // New tool code lands; the update is asked of the supervisor directly. Nothing goes through the facade.
    await writeFile(toolWorkerFile, worker('agents/mcp-worker.mjs'));
    const queued = await request(runtime, 'update-workspace', { rootId: root.id, layers: ['connector'] });
    await until(async () => (await request(runtime, `update-status?${new URLSearchParams({ rootId: root.id })}`)).jobs.find(job => job.id === queued.jobId)?.status === 'succeeded', 'connector update');
    await until(() => notifications > 0, 'tools/list_changed reaching an idle facade', 100);

    const after = await names();
    assert.ok(after.includes('list_tasks') && !after.includes('old_tool'), `second generation: ${after}`);
    const stale = await client.callTool({ name: 'old_tool', arguments: {} });
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /old_tool is not in this workspace’s current tool set/);
    assert.match(stale.content[0].text, /list_tasks/); assert.match(stale.content[0].text, /Codex/);
    const status = await client.callTool({ name: 'update_status', arguments: {} });
    assert.notEqual(status.structuredContent.toolWorkerPid, stalePid);
  } finally {
    await client?.close(); await runtime?.close(); await host?.close(); await rm(directory, { recursive: true, force: true });
  }
});
