/* F158 (spec 129, spec 143, charter D57): the supervisor runs red-worker.
 *
 * The workspace worker was a forked Node module that took an IPC message and answered with one. It
 * is a binary now, taking arguments and announcing itself on stdout, and told to retire or close
 * down its stdin. The supervisor hides exactly those three differences and everything above it asks
 * `alive()` and `tell()` without knowing which it has.
 *
 * What this asserts is the CUTOVER: a runtime started with no `workerFile` runs the binary, serves a
 * workspace through it, and replaces it the way a layered update does — the one thing that has to
 * keep working, because it is how a native change reaches a running workspace without a restart.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { startServer } from '../server/main.mjs';
import { startRuntime, redWorkerBinary } from '../runtime/supervisor.mjs';
import { request } from '../launcher/sidecar.mjs';
import { endStateServices } from './state-services.mjs';
import { built } from './cargo.mjs';

/* A worker publishes an IDE lock for Claude Code to find (spec 102), and this one is real. */
process.env.RENGINE_IDE_DIRECTORY ??= await mkdtemp(path.join(tmpdir(), 'rengine-cutover-ide-'));

async function until(check, label, timeout = 20000) {
  for (let waited = 0; waited < timeout; waited += 50) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  assert.fail(`Timed out: ${label}`);
}

test('the supervisor runs red-worker, and replaces it the way a layered update does', { timeout: 300000 }, async t => {
  await built('--bins');
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-cutover-'));
  const project = path.join(directory, 'project');
  await mkdir(project);
  const stateDir = path.join(directory, 'host');
  const host = await startServer({ stateDir });
  const runtimeDir = path.join(directory, 'runtime');
  let runtime;
  t.after(async () => {
    await runtime?.close?.();
    await host.close({ retain: false });
    await endStateServices(stateDir);
    await endStateServices(runtimeDir);
    await rm(directory, { recursive: true, force: true });
  });
  const root = await host.store.addRoot(project);

  /* `null` asks the supervisor to resolve the binary, which is the cutover. It is not the DEFAULT
     yet: red-worker answers everything above a current host and does not yet answer the project
     routes above a RETAINED one, which is the case spec 065 exists for and which `games.test.mjs`,
     `dashboard.test.mjs` and `hot-update.test.mjs` assert. */
  assert.ok(redWorkerBinary().endsWith('red-worker'));
  runtime = await startRuntime({ host, directory: runtimeDir, workerFile: null });

  /* A workspace, through the binary. The capabilities are the ones having a WORKER adds — the
     host alone promises none of them — and the ledger's three say a ledger is actually served. */
  const state = await request(runtime, 'state');
  assert.equal(state.instance, host.instance, 'the same workspace, one layer up');
  assert.equal(state.capabilities.layeredUpdates, 1);
  assert.equal(state.capabilities.agentsMenu, 1);
  assert.equal(state.capabilities.agentToken, 1, 'the worker started the ledger it serves');
  assert.equal(typeof state.preferences.tokenWindowMs, 'number');

  /* The feed, which is the one thing nothing but a worker can serve. */
  const feed = await request(runtime, `feed?rootId=${root.id}`);
  assert.ok(Array.isArray(feed.frames));
  assert.ok(feed.socket.startsWith('ws://'), feed.socket);

  /* And the announcement a layered update reads: one workspace.updated per worker that served
     somebody, carrying the generation it claimed. */
  await until(async () => (await request(runtime, `feed?rootId=${root.id}`)).frames
    .some(frame => frame.type === 'workspace.updated'), 'the worker announced itself');
  const first = (await request(runtime, `feed?rootId=${root.id}`)).frames.filter(frame => frame.type === 'workspace.updated');
  assert.equal(first.length, 1);

  /* A live feed socket, so the replacement below has something to tell where to go. */
  const watcher = new WebSocket(`${feed.socket}&after=0`);
  const closed = new Promise(resolve => watcher.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  watcher.on('error', () => {});
  await new Promise(resolve => watcher.once('open', resolve));

  /* The layered update: a new worker is started, proved, and swapped in; the old one is retired and
     then closed. This is how a native change reaches a running workspace without a restart, and it
     is the one thing that has to keep working across the cutover. */
  const supervisor = async () => fetch(`${runtime.url}/api/update-status?rootId=${root.id}`,
    { headers: { authorization: `Bearer ${runtime.token}` } }).then(read => read.json());
  /* The WORKER's pid, which the supervisor knows and `/api/state` does not: a state read is the
     host's answer with the worker's additions, and the pid in it is the host's. */
  const before = (await supervisor()).workspace.pid;
  const updated = await fetch(`${runtime.url}/api/update-workspace`, { method: 'POST',
    headers: { authorization: `Bearer ${runtime.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ rootId: root.id, layers: ['workspace'] }) });
  assert.equal(updated.status, 202, JSON.stringify(await updated.clone().json()));
  const job = await until(async () => (await supervisor()).jobs.find(entry => ['succeeded', 'failed'].includes(entry.status)),
    'the layered update finished');
  assert.equal(job.status, 'succeeded', `the update failed: ${job.error ?? ''}`);

  /* The retired worker told its watcher where to go rather than dropping it: a monitor re-reads
     feed_url and resumes from the cursor it had. */
  const ended = await closed;
  assert.equal(ended.code, 1011);
  assert.match(ended.reason, /re-read feed_url and resume from your cursor/);

  /* And the workspace is still there, on a different worker, with the ledger unbroken — the frames
     the first worker minted are still on the feed, because the ledger is a service and outlived it. */
  assert.notEqual((await supervisor()).workspace.pid, before, 'a different worker process answers now');
  const after = await request(runtime, 'state');
  assert.equal(after.capabilities.agentToken, 1, 'and it serves the ledger too');
  const frames = (await request(runtime, `feed?rootId=${root.id}`)).frames;
  assert.ok(frames.some(frame => frame.sequence === first[0].sequence), 'the ledger outlived the worker that opened it');
  await until(async () => (await request(runtime, `feed?rootId=${root.id}`)).frames
    .filter(frame => frame.type === 'workspace.updated').length === 2, 'and the new worker announced itself too');
});
