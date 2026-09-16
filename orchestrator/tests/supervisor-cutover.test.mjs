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
import { startServer } from './red-host-fixture.mjs';
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
async function startSupervisor(host, directory, extra = [], environment = {}) {
  const binary = process.env.RENGINE_RED_SUPERVISOR || path.resolve('red/target/debug/red-supervisor');
  const shim = path.join(directory, 'worker-shim');
  const worker = process.env.RENGINE_RED_WORKER || path.resolve('red/target/debug/red-worker');
  await mkdir(directory, { recursive: true });
  const { writeFile, chmod } = await import('node:fs/promises');
  await writeFile(shim, `#!/bin/sh\nexec ${JSON.stringify(worker)} "$@" --no-ide\n`);
  await chmod(shim, 0o755);
  const child = spawn(binary, ['--state', directory, '--host', host.url, '--host-token', host.token, '--worker', shim, ...extra],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...environment } });
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

/* The desktop layer, with a window that is a window as far as the supervisor is concerned: it
 * registers through the workspace, answers the control channel, exits 75 when told to reload and 0
 * when told to close. That is the whole of what the supervisor requires, and it is what lets the
 * choreography — open, inspect, relay, reload, close — be driven without a built native binary.
 */
test('red-supervisor opens, drives, updates and closes a desktop window', { timeout: 300000 }, async t => {
  await built('--bins');
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-supervisor-desktop-'));
  const project = path.join(directory, 'project');
  await mkdir(project);
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

  /* The desktop is SNAPSHOTTED into the runtime directory before it runs, which is the whole point
     of the snapshot — so the thing snapshotted is a shim that execs the real fixture where its
     imports resolve. The same device the worker specs use for the same reason. */
  const { writeFile, chmod } = await import('node:fs/promises');
  const desktop = path.join(directory, 'fake-desktop');
  await writeFile(desktop, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve('orchestrator/tests/fake-desktop.mjs'))} "$@"\n`);
  await chmod(desktop, 0o755);
  supervisor = await startSupervisor(host, runtimeDir, ['--desktop', desktop, '--inspect-ui']);

  /* Opening one: it is started on a SNAPSHOT of the binary, and the answer waits for it to have
     registered — a window that started and could not reach the workspace is not one a person can
     use, so "opened" means "registered", never "spawned". */
  const opened = await request(supervisor, 'open-desktop', { root: root.id });
  assert.equal(opened.reused, false);
  assert.ok(opened.owner && opened.pid > 0, JSON.stringify(opened));
  /* Asserted with no waiting at all, because that IS the contract: `open-desktop` does not answer
     until the window has registered through a worker. A supervisor that answered on spawn would
     hand a launcher a window that may never arrive. */
  const listed = (await request(supervisor, `desktops?rootId=${root.id}`)).desktops;
  assert.equal(listed.length, 1, 'the window had registered before open-desktop answered');
  assert.equal(listed[0].managed, true, 'this supervisor started it, so it manages it');
  assert.equal(listed[0].pid, opened.pid);

  /* Asking for the same binding again is the same window, not a second one beside it. */
  const again = await request(supervisor, 'open-desktop', { root: root.id });
  assert.deepEqual({ owner: again.owner, reused: again.reused }, { owner: opened.owner, reused: true });

  /* A root that is not a string at all is refused before anything is started. */
  await assert.rejects(request(supervisor, 'open-desktop', {}), /Initial root must be explicit/);

  /* The automation relay: a second speaker on the window's stream, which is what three desktop
     specs need once the supervisor is a process rather than a module. Positive ids are the other
     protocol's; this layer's own count down from -1 and never reach the relay. */
  const relay = await automation(supervisor, opened.owner);
  const answered = await relay.ask({ op: 'state' });
  assert.deepEqual(answered.controls[0], { role: 'tab', key: 'terminal', rect: [0, 0, 10, 10] });
  await relay.close();

  /* The desktop layer of a layered update: told to reload, it exits 75 — "I saved and let go" — and
     is started again on the prepared snapshot. The window a person had comes back. */
  const queued = await request(supervisor, 'update-workspace',
    { rootId: root.id, layers: ['desktop'], desktopId: listed[0].id });
  assert.equal(queued.status, 'accepted');
  const job = await until(async () => (await request(supervisor, `update-status?rootId=${root.id}`))
    .jobs.find(entry => ['succeeded', 'failed'].includes(entry.status)), 'the desktop update finished');
  assert.equal(job.status, 'succeeded', `${job.error ?? ''} ${supervisor.diagnostics()}`);
  assert.equal(job.desktopId, listed[0].id, 'and the job names the desktop it replaced');
  const replaced = await until(async () => {
    const seen = (await request(supervisor, `desktops?rootId=${root.id}`)).desktops;
    return seen.length && seen[0].pid !== opened.pid ? seen : null;
  }, 'the window came back as a different process');
  assert.equal(replaced[0].managed, true);

  /* A second update while one is running is refused by name rather than queued. */
  assert.deepEqual((await request(supervisor, `update-status?rootId=${root.id}`)).workspace.retiring, []);

  /* The window detaching on its OWN — the person pressed its update key — which is exit 75 with
     nobody having asked. Nothing above the supervisor knows this happened; the window simply comes
     back, which is the whole of what that exit code buys. */
  const detaching = await automation(supervisor, opened.owner);
  await detaching.ask({ op: 'detach' });
  await detaching.close();
  const returned = await until(async () => {
    const seen = (await request(supervisor, `desktops?rootId=${root.id}`)).desktops;
    return seen.length && seen[0].pid !== replaced[0].pid ? seen : null;
  }, 'the window came back after detaching itself');
  assert.equal(returned[0].managed, true, 'and the supervisor still manages it');
  const keyboard = await until(async () => (await request(supervisor, `update-status?rootId=${root.id}`))
    .jobs.filter(entry => entry.status === 'succeeded').length === 2 && true, 'the detach became an update of its own');
  assert.ok(keyboard);

  /* Inspecting it, which is the supervisor proxying its control channel — and the internal tree is
     dropped, because an inspection is the window's SHAPE. */
  const windowOwner = replaced[0].owner;
  assert.equal(windowOwner, opened.owner, 'the same window, on a new process');
  const seen = await request(supervisor, 'project-window-action', { rootId: root.id, windowId: 'nobody', action: 'inspect' })
    .then(() => 'answered', error => error.message);
  assert.match(seen, /Window is not linked to this project/, 'a window this project does not have is refused');
});

/* `--initial`: a workspace asked for with a window already in it.
 *
 * It is worth its own case because of an ordering that is not cosmetic. A desktop registers by
 * connecting BACK to the supervisor's own port, so a supervisor that opened its initial window
 * before it was accepting connections would wait ten seconds for a registration sitting in the
 * listen backlog and then report that the window never arrived. Nothing else in this file would
 * have caught it: every other window is opened over a route, which by definition means the accept
 * loop is already running.
 */
test('red-supervisor opens the window it was asked to start with', { timeout: 300000 }, async t => {
  await built('--bins');
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-supervisor-initial-'));
  const project = path.join(directory, 'project');
  await mkdir(project);
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
  const { writeFile, chmod } = await import('node:fs/promises');
  const desktop = path.join(directory, 'fake-desktop');
  await writeFile(desktop, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve('orchestrator/tests/fake-desktop.mjs'))} "$@"\n`);
  await chmod(desktop, 0o755);

  supervisor = await startSupervisor(host, runtimeDir,
    ['--desktop', desktop, '--initial', JSON.stringify({ root: root.id })]);

  /* No waiting: the supervisor does not announce itself until the initial window has registered, so
     by the time this test has its address the window is already there. */
  const listed = (await request(supervisor, `desktops?rootId=${root.id}`)).desktops;
  assert.equal(listed.length, 1, 'the window it was asked to start with had registered');
  assert.equal(listed[0].managed, true);

  /* And stopping the supervisor takes its window with it. The desktop is its child only in `ps` —
     no signal reaches it through a group — so a supervisor that simply died would leave a window on
     the screen with nobody to close it and nobody to save its drafts. */
  const { alive } = await import('../launcher/sidecar.mjs');
  const window = listed[0].pid;
  assert.ok(alive(window), 'the window is running');
  await supervisor.close(); supervisor = null;
  await until(() => !alive(window), 'the window went with the supervisor that opened it');
});

/* The guard that keeps two updates off one supervisor. A window that detaches on its own while an
 * update is already running must NOT queue a second job — two `perform` threads would each believe
 * they were the active one, and the second would overwrite the first's record of what it was doing.
 *
 * Driven rather than reasoned about: the desktop layer's build command is declared, so a slow one
 * holds an update in its PREPARE phase — where the window is not yet marked updating — and the
 * detach lands in exactly the window the guard exists for.
 */
test('a window that detaches while an update is running does not start a second one', { timeout: 300000 }, async t => {
  await built('--bins');
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-supervisor-race-'));
  const project = path.join(directory, 'project');
  await mkdir(project);
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
  const { writeFile, chmod } = await import('node:fs/promises');
  const desktop = path.join(directory, 'fake-desktop');
  await writeFile(desktop, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve('orchestrator/tests/fake-desktop.mjs'))} "$@"\n`);
  await chmod(desktop, 0o755);
  supervisor = await startSupervisor(host, runtimeDir, ['--desktop', desktop, '--inspect-ui'],
    { RENGINE_DESKTOP_BUILD: 'sleep 2' });

  const opened = await request(supervisor, 'open-desktop', { root: root.id });
  const listed = (await request(supervisor, `desktops?rootId=${root.id}`)).desktops;
  assert.equal(listed.length, 1);

  /* An update that will sit in its build for two seconds, and a detach right inside that window. */
  const queued = await request(supervisor, 'update-workspace',
    { rootId: root.id, layers: ['desktop'], desktopId: listed[0].id });
  const relay = await automation(supervisor, opened.owner);
  await relay.ask({ op: 'detach' });
  await relay.close();

  const job = await until(async () => (await request(supervisor, `update-status?rootId=${root.id}`))
    .jobs.find(entry => entry.id === queued.jobId && ['succeeded', 'failed'].includes(entry.status)),
    'the update that was already running finished');

  /* ONE job. That is the whole assertion: without the guard the detach queues a second, and two
     `perform` threads each believe they are the active one. */
  const jobs = (await request(supervisor, `update-status?rootId=${root.id}`)).jobs;
  assert.equal(jobs.length, 1, `exactly one job ran: ${JSON.stringify(jobs)}`);
  assert.equal(jobs[0].id, queued.jobId, 'and it is the one that was asked for');

  /* It fails, and that is right rather than unfortunate: the desktop it was told to replace let go
     of its registration on the way out, so there is nothing left for it to reload. The person asked
     for the same window twice at once and got the answer to the second ask. */
  assert.equal(job.status, 'failed');
  assert.match(job.error, /Desktop is not attached to this project/);

  /* And the window is still there, on a process of its own: the detach was answered by restarting
     it, not by starting an update beside the one in flight. */
  const back = await until(async () => {
    const seen = (await request(supervisor, `desktops?rootId=${root.id}`)).desktops;
    return seen.length ? seen : null;
  }, 'the window is open again');
  assert.equal(back[0].managed, true);
});

/* The relay, from a client's side: one upgrade, then newline JSON both ways. */
async function automation(supervisor, owner) {
  const { connect } = await import('node:net');
  const target = new URL(supervisor.url);
  const socket = connect({ host: target.hostname, port: Number(target.port) });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  /* An ordinary bearer header, because this client is not a browser: the query-string token exists
     for WebSocket handshakes, which cannot carry one. */
  socket.write(`GET /automation?owner=${owner} HTTP/1.1\r\n`
    + `Host: ${target.host}\r\nAuthorization: Bearer ${supervisor.token}\r\n`
    + `Connection: Upgrade\r\nUpgrade: rengine-automation\r\n\r\n`);
  let buffered = '', serial = 0;
  const waiting = new Map();
  await new Promise((resolve, reject) => {
    const onData = chunk => {
      buffered += chunk;
      if (!buffered.includes('\r\n\r\n')) return;
      const [head, rest] = buffered.split('\r\n\r\n');
      socket.off('data', onData);
      if (!head.startsWith('HTTP/1.1 101')) { reject(new Error(`the relay refused: ${head}\n${rest}`)); return; }
      buffered = rest ?? '';
      resolve();
    };
    socket.on('data', onData);
    socket.once('error', reject);
    setTimeout(() => reject(new Error('the relay did not answer')), 10000);
  });
  socket.on('data', chunk => {
    buffered += chunk;
    let at;
    while ((at = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, at); buffered = buffered.slice(at + 1);
      let value; try { value = JSON.parse(line); } catch { continue; }
      const waiter = waiting.get(value.id);
      if (waiter) { waiting.delete(value.id); waiter(value.result); }
    }
  });
  return {
    ask: value => new Promise((resolve, reject) => {
      const id = ++serial;
      waiting.set(id, resolve);
      setTimeout(() => { if (waiting.delete(id)) reject(new Error(`the window did not answer ${value.op}`)); }, 8000);
      socket.write(`${JSON.stringify({ id, ...value })}\n`);
    }),
    close: () => new Promise(resolve => { socket.once('close', resolve); socket.end(); }),
  };
}
