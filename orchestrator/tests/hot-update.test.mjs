import test from 'node:test';
import { facadeCommand, facadeArgs } from './mcp-facade.mjs';
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
import { startServer } from './red-host-fixture.mjs';
import { startSupervisor } from './red-supervisor-fixture.mjs';
import { forward, json, tunnel } from '../runtime/protocol.mjs';
import { alive, ensureSidecar, request } from '../launcher/sidecar.mjs';
import { endStateServices } from './state-services.mjs';

/* A native spec starts a real workspace, and a real workspace publishes an IDE lock for Claude Code
   to find (spec 102). Without this, running a spec directly rather than through its npm script puts
   a dead rEdit into the `/ide` menu of whoever ran it. */
process.env.RENGINE_IDE_DIRECTORY ??= await mkdtemp(path.join(tmpdir(), 'rengine-spec-ide-'));



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
  const transport = new StdioClientTransport({ command: facadeCommand(), args: facadeArgs(contextFile), stderr: 'pipe' });
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

    runtime = await startSupervisor({ host: retained, directory: path.join(directory, 'runtime') });
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
    /* And the services that state directory keeps after its host (D60/D61), before it is removed. */
    await endStateServices(path.join(directory, 'host-state'));
    await rm(directory, { recursive: true, force: true });
  }
});

/* Where a RETAINED host keeps its state — found by its instance in the process table, never by the
 * URL a worker was handed and never by the first host row — is `red_worker::signin`'s
 * `a_retained_host_is_found_by_its_instance_and_never_by_being_first`, which is where the rule
 * lives now (F154).
 */
test('an idle facade learns of a connector update without a request, and a stale name is refused with the way back', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-hot-update-facade-'));
  let host, runtime, client;
  try {
    host = await startServer({ stateDir: path.join(directory, 'state') });
    const root = await host.store.addRoot(await project(directory, 'local', null));
    /* The connector layer is an executable now (F187), so the stand-in is a script that execs the
       one this generation should run — the supervisor and the facade both start it as a command. */
    const toolWorkerFile = path.join(directory, 'tool-worker');
    const worker = async target => {
      await writeFile(toolWorkerFile, `#!/bin/sh\nexec ${JSON.stringify(target)} "$@"\n`, { mode: 0o755 });
    };
    await worker(path.resolve('orchestrator/tests/stale-tool-worker.mjs'));
    const runtimeDir = path.join(directory, 'runtime');
    runtime = await startSupervisor({ host: { url: host.url, token: host.token, instance: host.instance, pid: process.pid }, directory: runtimeDir, toolWorkerFile });
    const contextFile = path.join(directory, 'context.json');
    await writeFile(contextFile, JSON.stringify({ url: host.url, token: host.token, instance: host.instance, rootId: root.id, runtimeDirectory: runtimeDir }), { mode: 0o600 });

    // The facade runs the tool worker the supervisor probed and published, so its first generation is
    // the stale worker and its second is the checkout's.
    let notifications = 0;
    client = new Client({ name: 'hot-update-idle', version: '1.0.0' });
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notifications++; });
    const transport = new StdioClientTransport({ command: facadeCommand(), args: facadeArgs(contextFile), stderr: 'pipe' });
    await client.connect(transport);
    const names = async () => (await client.listTools()).tools.map(tool => tool.name);
    const before = await names();
    assert.ok(before.includes('old_tool') && !before.includes('list_tasks'), `first generation: ${before}`);
    const first = await client.callTool({ name: 'update_status', arguments: {} });
    const stalePid = first.structuredContent.toolWorkerPid;

    // New tool code lands; the update is asked of the supervisor directly. Nothing goes through the facade.
    await worker(process.env.RENGINE_RED_MCP || path.resolve('red/target/debug/red-mcp'));
    const queued = await request(runtime, 'update-workspace', { rootId: root.id, layers: ['connector'] });
    await until(async () => (await request(runtime, `update-status?${new URLSearchParams({ rootId: root.id })}`)).jobs.find(job => job.id === queued.jobId)?.status === 'succeeded', 'connector update');
    await until(() => notifications > 0, 'tools/list_changed reaching an idle facade', 100);

    /* A candidate that starts and answers but cannot serve the update path is refused, and the
       generation does not move: adopting it would leave a pane able to read the workspace and
       unable to update it again. The probe's required list is what refuses it. */
    const incomplete = await request(runtime, `update-status?${new URLSearchParams({ rootId: root.id })}`);
    await worker(path.resolve('orchestrator/tests/incomplete-tool-worker.mjs'));
    const refusedJob = await request(runtime, 'update-workspace', { rootId: root.id, layers: ['connector'] });
    const refused = await until(async () => {
      const value = await request(runtime, `update-status?${new URLSearchParams({ rootId: root.id })}`);
      const job = value.jobs.find(entry => entry.id === refusedJob.jobId);
      return job?.status === 'failed' && { value, job };
    }, 'the incomplete candidate is refused');
    assert.match(refused.job.error, /update_workspace is missing/, 'the refusal names what the candidate lacks');
    assert.equal(refused.value.connectorGeneration, incomplete.connectorGeneration,
      'and nothing was adopted: the generation did not move');

    const after = await names();
    assert.ok(after.includes('list_tasks') && !after.includes('old_tool'), `second generation: ${after}`);
    const stale = await client.callTool({ name: 'old_tool', arguments: {} });
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /old_tool is not in this workspace’s current tool set/);
    assert.match(stale.content[0].text, /list_tasks/);
    /* The way back, said once for every CLI rather than per agent: whether a particular one
       refreshes was written out in the message, which made it wrong for the next CLI to arrive and
       right for nobody unnamed (F220, spec 141). */
    assert.match(stale.content[0].text, /refreshes on tools\/list_changed/);
    assert.match(stale.content[0].text, /needs restarting/);
    const status = await client.callTool({ name: 'update_status', arguments: {} });
    assert.notEqual(status.structuredContent.toolWorkerPid, stalePid);
  } finally {
    await client?.close(); await runtime?.close(); await host?.close(); await rm(directory, { recursive: true, force: true });
  }
});

/* Rule 1 of the facade: a candidate that will not START does not replace a working worker.
 *
 * The suite above drives a candidate the SUPERVISOR refuses, which never reaches the facade. This
 * one is the other half — a descriptor the facade itself cannot honour — and it had no case: a
 * sabotage that dropped the running worker when a candidate failed passed every other test in this
 * file. An agent mid-turn must not lose its tools because an update was attempted.
 */
test('a tool worker that will not start leaves the running one serving', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-facade-refuse-'));
  let host, client;
  t.after(async () => {
    await client?.close();
    await host?.close();
    await endStateServices(path.join(directory, 'state'));
    await rm(directory, { recursive: true, force: true });
  });
  host = await startServer({ stateDir: path.join(directory, 'state') });
  const root = await host.store.addRoot(directory);
  const runtimeDir = path.join(directory, 'runtime');
  await mkdir(runtimeDir, { recursive: true });
  const contextFile = path.join(directory, 'context.json');
  await writeFile(contextFile, JSON.stringify({ url: host.url, token: host.token, instance: host.instance, rootId: root.id, runtimeDirectory: runtimeDir }), { mode: 0o600 });

  client = new Client({ name: 'facade-refuse', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: facadeCommand(), args: facadeArgs(contextFile), stderr: 'pipe' }));
  const before = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(before.includes('workspace_info'), `the sibling worker serves first: ${before}`);

  /* A descriptor naming a worker that exits the moment it starts, at a new generation. The facade
     has to try it — that is what a generation means — and has to keep what it has when it fails. */
  const broken = path.join(directory, 'never-starts');
  await writeFile(broken, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  await writeFile(path.join(runtimeDir, 'runtime.json'),
    JSON.stringify({ url: host.url, token: host.token, instance: host.instance, pid: process.pid, toolWorker: broken, connectorGeneration: 99 }), { mode: 0o600 });

  /* Asked twice across the watcher's own interval, so both paths are covered: the one that notices
     between requests, and the one that notices while nothing is being asked. */
  await delay(1500);
  const after = (await client.listTools()).tools.map(tool => tool.name);
  assert.deepEqual(after, before, 'the CLI keeps the tools it had');
  const still = await client.callTool({ name: 'workspace_info', arguments: {} });
  assert.equal(still.isError, undefined, 'and the worker it had still answers');
  assert.equal(JSON.parse(still.content[0].text).root.id, root.id);
});
