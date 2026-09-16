/* F159 (spec 129, spec 144, charter D57): the supervisor as a PROCESS.
 *
 * `runtime/supervisor.mjs` is a forked Node module that takes its options over IPC and answers with
 * one. `red-supervisor` is a binary that takes arguments and announces itself on stdout, exactly as
 * `red-worker` does one layer down — and this is what proves the binary is the same workspace layer
 * before anything is pointed at it.
 *
 * What is asserted here is the part with no desktop in it: a real session host, a real worker
 * started by the binary, the routes the supervisor answers itself, the routes it forwards, and the
 * descriptor it publishes. The desktop choreography needs a built desktop and belongs with the
 * specs that already have one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { request } from '../launcher/sidecar.mjs';
import { endStateServices } from './state-services.mjs';
import { built } from './cargo.mjs';

process.env.RENGINE_IDE_DIRECTORY ??= await mkdtemp(path.join(tmpdir(), 'rengine-supervisor-ide-'));

async function until(check, label, timeout = 20000) {
  for (let waited = 0; waited < timeout; waited += 50) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  assert.fail(`Timed out: ${label}`);
}

/* The binary, started the way `ensureRuntime` will start it: arguments in, one JSON line out. The
   worker is wrapped in a shim that adds `--no-ide`, because a real worker publishes an IDE lock into
   whoever's `/ide` menu is running the suite. */
async function startSupervisor(host, directory, extra = []) {
  const binary = process.env.RENGINE_RED_SUPERVISOR || path.resolve('red/target/debug/red-supervisor');
  const shim = path.join(directory, 'worker-shim');
  const worker = process.env.RENGINE_RED_WORKER || path.resolve('red/target/debug/red-worker');
  await mkdir(directory, { recursive: true });
  const { writeFile, chmod } = await import('node:fs/promises');
  await writeFile(shim, `#!/bin/sh\nexec ${JSON.stringify(worker)} "$@" --no-ide\n`);
  await chmod(shim, 0o755);
  const child = spawn(binary, ['--state', directory, '--host', host.url, '--host-token', host.token, '--worker', shim],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let said = '', diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  const announced = await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      said += chunk;
      if (said.includes('\n')) resolve(JSON.parse(said.split('\n')[0]));
    });
    child.once('exit', code => reject(new Error(`red-supervisor exited ${code}: ${diagnostics}`)));
    setTimeout(() => reject(new Error(`red-supervisor did not announce itself: ${diagnostics}`)), 40000);
  });
  return { ...announced, child, diagnostics: () => diagnostics,
    close: () => new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 4000); }) };
}

test('red-supervisor is the workspace layer, as a process', { timeout: 300000 }, async t => {
  await built('--bins');
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-supervisor-cutover-'));
  const project = path.join(directory, 'project');
  const other = path.join(directory, 'other');
  await mkdir(project); await mkdir(other);
  const stateDir = path.join(directory, 'host');
  const host = await startServer({ stateDir });
  const runtimeDir = path.join(directory, 'runtime');
  let supervisor;
  t.after(async () => {
    await supervisor?.close();
    await host.close({ retain: false });
    await endStateServices(stateDir);
    await endStateServices(runtimeDir);
    await rm(directory, { recursive: true, force: true });
  });
  const root = await host.store.addRoot(project);
  const foreign = await host.store.addRoot(other);

  supervisor = await startSupervisor(host, runtimeDir);
  assert.equal(supervisor.instance, host.instance, 'the same workspace, one layer up');
  assert.match(supervisor.url, /^http:\/\/127\.0\.0\.1:\d+$/);

  /* The descriptor `discoverRuntime` reads, with the fields it checks. */
  const descriptor = JSON.parse(await readFile(path.join(runtimeDir, 'runtime.json'), 'utf8'));
  assert.equal(descriptor.version, 1);
  assert.equal(descriptor.pid, supervisor.pid);
  assert.equal(descriptor.instance, host.instance);
  assert.deepEqual({ url: descriptor.host.url, token: descriptor.host.token, instance: descriptor.host.instance },
    { url: host.url, token: host.token, instance: host.instance }, 'and it names the host it belongs to');
  assert.equal(typeof descriptor.idePort, 'number');

  /* Unauthorized, and a foreign origin, are both refused — a page holding the token from somewhere
     it should not have is the case the Origin check exists for. */
  assert.equal((await fetch(`${supervisor.url}/api/state`)).status, 401);
  assert.equal((await fetch(`${supervisor.url}/api/state`,
    { headers: { authorization: `Bearer ${supervisor.token}`, origin: 'https://unrelated.invalid' } })).status, 401);

  /* `/health` needs no credential, because it is what a discoverer asks BEFORE it has one. */
  const health = await fetch(`${supervisor.url}/health`).then(read => read.json());
  assert.deepEqual(health, { protocol: 1, instance: host.instance, layeredUpdates: 1 });

  /* A workspace through the binary. `layeredUpdates` and `projectWindows` are what having a
     SUPERVISOR adds; `agentsMenu` and `agentToken` are the worker's, and they are here because the
     supervisor started one and composed its answer. */
  const state = await request(supervisor, 'state');
  assert.equal(state.instance, host.instance);
  assert.equal(state.capabilities.layeredUpdates, 1);
  assert.equal(state.capabilities.projectWindows, 1, 'the supervisor owns the project windows');
  assert.equal(state.capabilities.agentsMenu, 1, 'and the worker beneath it is answering');
  assert.equal(state.capabilities.agentToken, 1, 'which started the ledger it serves');

  /* A route the supervisor does not own reaches the worker whole: the feed is the one thing nothing
     but a worker can serve, so getting it here proves the forward. */
  const feed = await request(supervisor, `feed?rootId=${root.id}`);
  assert.ok(Array.isArray(feed.frames));
  assert.ok(feed.socket.startsWith('ws://'), feed.socket);

  /* The update status, which is the supervisor's own answer and nobody else's. */
  const status = await request(supervisor, `update-status?rootId=${root.id}`);
  assert.equal(status.version, 1);
  assert.equal(status.supervisorPid, supervisor.pid);
  assert.equal(status.host.instance, host.instance);
  assert.equal(status.workspace.available, true);
  assert.notEqual(status.workspace.pid, supervisor.pid, 'the worker is its own process');
  assert.deepEqual(status.jobs, []);
  assert.match(status.limits, /Session host retains live PTYs/);

  /* A root the host does not have is refused by name, and it is the FIRST thing refused — before
     the layers a caller got wrong. */
  await assert.rejects(request(supervisor, 'update-status?rootId=00000000-0000-4000-8000-000000000000'), /Unknown project root/);
  const badLayers = await fetch(`${supervisor.url}/api/update-workspace`, { method: 'POST',
    headers: { authorization: `Bearer ${supervisor.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ rootId: '00000000-0000-4000-8000-000000000000', layers: ['everything'] }) });
  assert.equal(badLayers.status, 404);
  assert.match((await badLayers.json()).error, /Unknown project root/, 'the root is refused before the layers');
  await assert.rejects(request(supervisor, 'update-workspace', { rootId: root.id, layers: ['everything'] }),
    /Choose workspace, desktop and\/or connector layers/);
  await assert.rejects(request(supervisor, 'update-workspace', { rootId: root.id, layers: [] }),
    /Choose workspace, desktop and\/or connector layers/);
  await assert.rejects(request(supervisor, 'update-workspace', { rootId: root.id, layers: ['desktop'], desktopId: 'nobody' }),
    /Choose a managed desktop attached to this project/);

  /* The layered update, with no desktop in it: a candidate worker is started, proved against this
     host, and switched in; the old one is retired and closed. This is how a native change reaches a
     running workspace without a restart. */
  const before = status.workspace.pid;
  const queued = await request(supervisor, 'update-workspace', { rootId: root.id, layers: ['workspace'] });
  assert.equal(queued.status, 'accepted');
  assert.match(queued.detail, /Read update_status for completion or failure/);
  const job = await until(async () => (await request(supervisor, `update-status?rootId=${root.id}`))
    .jobs.find(entry => ['succeeded', 'failed'].includes(entry.status)), 'the layered update finished');
  assert.equal(job.status, 'succeeded', `the update failed: ${job.error ?? ''} ${supervisor.diagnostics()}`);
  assert.deepEqual(job.layers, ['workspace']);
  assert.ok(!('desktopId' in job), 'a workspace-only job carries no desktopId at all');

  const after = await until(async () => {
    const seen = await request(supervisor, `update-status?rootId=${root.id}`);
    return seen.workspace.pid !== before && seen;
  }, 'a different worker process answers now');
  assert.equal(after.workspace.available, true);
  assert.equal((await request(supervisor, 'state')).capabilities.agentToken, 1, 'and it serves the ledger too');
  await until(async () => (await request(supervisor, `update-status?rootId=${root.id}`)).workspace.retiring.length === 0,
    'the replaced worker drained and closed');

  /* A project's jobs are its own: the other root sees none of this one's. */
  assert.deepEqual((await request(supervisor, `update-status?rootId=${foreign.id}`)).jobs, []);

  /* The project-window store, over the routes rather than in process. A window needs a RUNNING agent
     on the originating project, which this test does not have — so what is proved here is the
     refusal, which is the part a caller acts on. */
  assert.deepEqual(await request(supervisor, `project-windows?rootId=${root.id}`), { windows: [] });
  await assert.rejects(request(supervisor, 'project-window-open', { rootId: root.id, path: other, agentId: 'nobody' }),
    /Select a running agent bound to the originating project/);
  await assert.rejects(request(supervisor, 'integration-report', { rootId: root.id, windowId: 'nobody', key: 'k', kind: 'issue', summary: 's' }),
    /Window is not linked to this project/);
  assert.deepEqual(await request(supervisor, `integration-inbox?rootId=${root.id}`), { reports: [], cursor: 0, hasMore: false });

  /* And the desktop routes, which have no desktop here and say so rather than pretending. */
  assert.deepEqual((await request(supervisor, `desktops?rootId=${root.id}`)).desktops, []);
  await assert.rejects(request(supervisor, 'desktop-action', { rootId: root.id, desktopId: 'nobody', action: 'wiggle' }),
    /Unknown desktop action/);
});
