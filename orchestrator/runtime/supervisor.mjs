import http from 'node:http';
import { fork, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { request as call } from '../launcher/sidecar.mjs';
import { authenticated, body, checkConnection, fail, forward, json, tunnel } from './protocol.mjs';
import { prepareDesktop, snapshotBinary, nativeBinary, launchDesktop } from './desktop.mjs';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { windowStore, nativeControl, inspectWindow } from './windows.mjs';

const defaultWorker = fileURLToPath(new URL('./worker.mjs', import.meta.url));
/* The workspace worker (F158, spec 129, charter D57): red-worker, which is what `startRuntime` runs
   unless a caller hands it something else. Resolved the way every other Rust client here is resolved — the
   environment names one, then the release build, then the debug build — and a missing binary is named with the command that makes one, because this is the
   failure a person meets running a workspace out of a fresh clone. */
export function redWorkerBinary(env = process.env) {
  const declared = env.RENGINE_RED_WORKER;
  if (declared) {
    if (existsSync(declared)) return declared;
    throw new Error(`RENGINE_RED_WORKER names ${declared}, which does not exist.`);
  }
  for (const profile of ['release', 'debug']) {
    const candidate = path.join(project, 'red/target', profile, 'red-worker');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('The red-worker binary is required (run: cargo build -p red-worker, or set RENGINE_RED_WORKER).');
}
/* The connector layer is an executable now (F187): red-mcp, built from this checkout. It is
   resolved the way every other Rust client here is resolved — the environment names one, then the
   release build, then the debug build — and published in the descriptor so a facade runs the
   binary this supervisor probed rather than whichever one it finds. */
const project = fileURLToPath(new URL('../../', import.meta.url));
export function redMcpBinary(env = process.env) {
  const declared = env.RENGINE_RED_MCP;
  if (declared) {
    if (existsSync(declared)) return declared;
    throw new Error(`RENGINE_RED_MCP names ${declared}, which does not exist.`);
  }
  for (const profile of ['release', 'debug']) {
    const candidate = path.join(project, 'red/target', profile, 'red-mcp');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('The red-mcp binary is required (run: cargo build -p red-mcp, or set RENGINE_RED_MCP).');
}

/* Spec 065 unchanged, payload changed: "update the connector layer" still means prove a candidate
   starts and answers bound to this root, then bump the generation so every facade replaces its
   worker on its next request. What is new is that a compiled connector has to be BUILT before it
   can be probed — the JS file changed as soon as the checkout did, a binary does not — so the
   layer builds first, exactly as the desktop layer does. */
const buildConnectorDefault = async () => {
  await new Promise((resolve, reject) => {
    execFile('cargo', ['build', '--quiet', '--manifest-path', path.join(project, 'red/Cargo.toml'), '-p', 'red-mcp'],
      { maxBuffer: 1 << 24 }, (error, _out, err) => error ? reject(new Error(`red-mcp did not build: ${err || error.message}`)) : resolve());
  });
  return redMcpBinary();
};

/* The probe the supervisor runs against a candidate connector: the binary checks itself — it
   carries the tools the update path needs and answers bound to this root — and says so by exiting
   0. `runtime/tools.mjs` used to ask the same three questions over MCP from here. */
const probeConnector = (binary, contextFile) => new Promise((resolve, reject) => {
  execFile(binary, ['--probe', '--context', contextFile], { timeout: 30000 },
    (error, _out, err) => error ? reject(new Error(`Candidate MCP worker failed: ${err || error.message}`)) : resolve());
});

/* Ask the OS for a free port and let go of it. There is a window in which something else could take
   it; the worker that then cannot bind says so and the IDE bridge stays unpublished, which is a
   named absence rather than a silently moved port. */
async function reservePort() {
  const probe = createServer();
  try {
    await new Promise((resolve, reject) => { probe.once('listening', resolve); probe.once('error', reject); probe.listen(0, '127.0.0.1'); });
    return probe.address().port;
  } finally { await new Promise(resolve => probe.close(resolve)); }
}
/* One worker, however it is spelled. `red-worker` is a BINARY taking arguments and announcing
   itself on stdout; `worker.mjs` was a forked module taking an IPC message and answering with one.
   The two differ in exactly three places — how it is started, how it says it is ready, and how it
   is told to retire or close — so those three are what this hides, and everything above it asks
   `alive()` and `tell()` without knowing which it has.

   Control goes down STDIN for a binary: not a route, because retiring is control of the process
   rather than of the workspace, and not a signal, because there is no second signal on every
   platform this runs on. */
function spawnWorker(filename, host, directory, idePort) {
  if (filename.endsWith('.mjs')) {
    const child = fork(filename, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    return { child, stderr: child.stderr, start: () => child.send({ host, directory, idePort }),
      ready: resolve => child.on('message', data => { if (data.type === 'ready') resolve(data); else if (data.type === 'failed') throw new Error(data.error); }),
      alive: () => child.exitCode === null && child.signalCode === null && child.connected,
      tell: message => { if (child.connected) child.send(message); } };
  }
  const child = spawn(filename, ['--state', directory, '--host', host.url, '--host-token', host.token,
    '--ide-port', String(idePort)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  return { child, stderr: child.stderr, start: () => {},
    ready: resolve => { let text = ''; child.stdout.on('data', chunk => { text += chunk; if (text.includes('\n')) resolve(JSON.parse(text.split('\n')[0])); }); },
    alive: () => child.exitCode === null && child.signalCode === null,
    tell: message => { if (child.exitCode === null && child.signalCode === null && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`); } };
}

async function startWorker(host, filename, directory, idePort) {
  const worker = spawnWorker(filename, host, directory, idePort);
  const child = worker.child;
  let diagnostics = ''; worker.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-8000); });
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Workspace worker startup timed out.')), 30000);
      const cleanup = () => { clearTimeout(timer); child.off('error', bad); child.off('exit', exited); };
      const bad = error => { cleanup(); reject(error); };
      const exited = () => bad(new Error(`Workspace worker exited during startup. ${diagnostics}`));
      child.once('error', bad); child.once('exit', exited);
      try { worker.ready(value => { cleanup(); resolve(value); }); worker.start(); } catch (error) { bad(error); }
    });
    checkConnection(ready);
    const state = await call(ready, 'state');
    if (state.instance !== host.instance || state.capabilities.layeredUpdates !== 1) fail('Candidate workspace failed identity/capability checks.');
    return { ...ready, child, alive: worker.alive, tell: worker.tell, requests: 0, streams: 0, generation: randomUUID() };
  } catch (error) { child.kill(); throw error; }
}

export async function startRuntime({ host, directory, initial, binary = nativeBinary, workerFile = null,
  buildDesktop = prepareDesktop, toolWorkerFile = null, buildConnector = buildConnectorDefault, inspectUI = false, onDesktop = () => {} } = {}) {
  host = checkConnection(host);
  if (!path.isAbsolute(directory)) fail('Runtime directory must be absolute.');
  /* Published in the descriptor so a facade runs the tool worker this supervisor probed — see sidecar: probed-worker-runs. */
  const namedWorker = toolWorkerFile !== null;
  toolWorkerFile = path.resolve(toolWorkerFile ?? redMcpBinary());
  const hostState = async () => { const state = await call(host, 'state'); if (state.instance !== host.instance) fail('Original session host is no longer available.'); return state; };
  /* The default, resolved here rather than at module load so a checkout with no build yet says so
     when a workspace is opened rather than when this file is imported. `worker.mjs` is still
     accepted — it is what `runtime.test.mjs` hands in — and goes when the last caller does. */
  workerFile = workerFile ?? redWorkerBinary();
  await hostState(); await mkdir(directory, { recursive: true, mode: 0o700 });
  /* One port for this runtime's whole life, handed to every worker it starts. Claude Code reconnects
     to the port it first read out of the lock file and never re-reads the directory, so a port that
     moves with each worker ends every IDE session on every layered update (KI-066). Asked of the OS
     once here rather than picked, and carried in the descriptor so it survives this process.
     See sidecar: one-ide-port-per-runtime. */
  const idePort = await reservePort();
  const windows = await windowStore(directory);
  let current = await startWorker(host, workerFile, directory, idePort), url, active, activeFlight, closing = false, connectorGeneration = 1;
  let recovery = { state: 'idle' }, recoveryFlight, automaticRecoveryUsed = false;
  const retired = new Set(), desktops = new Map(), opens = new Map(), preserved = new Set(), jobs = [];
  const token = randomBytes(32).toString('hex');
  const instance = { version: 1, pid: process.pid, token, instance: host.instance, host, directory };
  const ownRoot = async id => { const state = await hostState(); if (!state.roots.some(root => root.id === id)) fail('Unknown project root.', 404); return state; };
  const available = worker => worker.alive();
  const watch = worker => worker.child.once('exit', () => {
    if (worker === current && !closing && !active) recover();
  });
  const recover = () => {
    if (closing || recoveryFlight || automaticRecoveryUsed || available(current)) return;
    automaticRecoveryUsed = true; recovery = { state: 'restarting', previousPid: current.pid };
    recoveryFlight = (async () => {
      try {
        const next = await startWorker(host, workerFile, directory, idePort), old = current;
        if (closing) { next.child.kill(); return; }
        current = next; watch(next); retired.add(old); retire(old);
        recovery = { state: 'recovered', previousPid: old.pid, pid: next.pid };
      } catch (error) { recovery = { state: 'failed', error: error.message }; }
    })().finally(() => { recoveryFlight = null; });
  };
  watch(current);
  const retire = worker => {
    if (!retired.has(worker) || preserved.has(worker) || worker.requests || worker.streams) return;
    retired.delete(worker); worker.tell({ type: 'close' });
  };
  /* Spec 095, Retirement: a replaced worker keeps draining its streams (spec 065) and hands the
     stateful half — the ledger, the feed and the host subscription that mints game.* — to the
     worker that replaced it, so one process owns them. Sent where the retirement is committed
     rather than at the swap: a failed update restores the previous worker as the current one, and
     a worker told it was retired would then be forwarding requests to itself. */
  const notifyRetired = worker => worker.tell({ type: 'retired' });
  const list = async rootId => {
    await ownRoot(rootId);
    const values = await Promise.all([current, ...retired].map(async worker => {
      try { return { worker, desktops: (await call(worker, `desktops?${new URLSearchParams({ rootId })}`)).desktops }; }
      catch (error) { worker.error = error.message; return { worker, desktops: [] }; }
    }));
    return values.flatMap(value => value.desktops.map(desktop => ({ ...desktop, worker: value.worker })));
  };
  const publicDesktop = ({ worker, ...desktop }) => ({ ...desktop, managed: desktops.has(desktop.owner), pid: desktops.get(desktop.owner)?.child.pid });
  const status = async rootId => {
    const pending = active; let views = await list(rootId);
    if (pending && !active) views = await list(rootId);
    return { version: 1, supervisorPid: process.pid, host: { instance: host.instance, pid: host.pid },
      workspace: { pid: current.pid, generation: current.generation, available: available(current), error: current.error, recovery,
        retiring: [...retired].map(x => ({ pid: x.pid, streams: x.streams, requests: x.requests })) },
      connectorGeneration, desktops: views.map(publicDesktop), jobs: jobs.filter(job => job.rootId === rootId),
      limits: 'Session host retains live PTYs and durable state. Host/supervisor protocol replacement requires quiescence; routine updates replace workspace, desktop and MCP tool workers.' };
  };
  const persist = async () => {
    const filename = path.join(directory, 'runtime.json');
    await writeFile(`${filename}.${process.pid}.tmp`, JSON.stringify({ ...instance, url, connectorGeneration, toolWorker: toolWorkerFile, idePort }), { mode: 0o600 });
    await rename(`${filename}.${process.pid}.tmp`, filename);
  };
  const spawnView = record => {
    record.binding.view = randomUUID();
    const child = launchDesktop(record.binary, instance, record.binding, { inspectUI }); record.child = child; record.control = nativeControl(child);
    record.diagnostics = ''; child.stderr.on('data', data => { record.diagnostics = (record.diagnostics + data).slice(-8000); });
    if (!inspectUI) child.stdout.resume();
    record.exited = new Promise(resolve => {
      child.once('error', error => { record.error = error.message; resolve(-1); });
      child.once('exit', code => {
        resolve(code);
        if (closing || record.updating) return;
        if (code === 75) void keyboardUpdate(record);
        else desktops.delete(record.binding.owner);
      });
    });
    onDesktop(child);
  };
  const waitView = async record => {
    const started = Date.now(), deadline = started + 10000;
    /* A desktop that never registers used to be reported as silence. The two things that say why are
       already to hand: what the process printed, and the registration a worker refused while this
       view was being waited for — never an older one, which would name the wrong desktop (spec 098). */
    let refused = null;
    while (Date.now() < deadline) {
      if (record.error || record.child.exitCode !== null || record.child.signalCode !== null) throw new Error(`Replacement desktop exited: ${record.error ?? record.diagnostics}`);
      const values = await Promise.all([current, ...retired].map(async worker => {
        try { return await call(worker, 'runtime-desktops'); }
        catch (error) { worker.error = error.message; return { desktops: [] }; }
      }));
      if (values.some(value => value.desktops.some(x => x.owner === record.binding.owner && x.view === record.binding.view))) return;
      refused = values.map(value => value.registerError).filter(x => x?.at >= started).sort((a, b) => b.at - a.at)[0] ?? refused;
      await delay(75);
    }
    const why = [refused && `last registration refused: ${refused.message}`, record.diagnostics && `desktop said: ${record.diagnostics.slice(-2000)}`].filter(Boolean);
    throw new Error(`Replacement desktop did not register before timeout.${why.length ? ` ${why.join('; ')}` : ''}`);
  };
  const openView = async data => {
    const state = data.root ? await ownRoot(data.root) : await hostState();
    const linked = data.windowId ? windows.get(data.originRootId, data.windowId) : null;
    if (linked && (data.root !== linked.projectRootId || data.agent !== linked.agentId)) fail('Project window bindings changed.', 403);
    for (const key of ['terminal', 'agent', 'game']) if (data[key] && !state.sessions.some(x => x.id === data[key] &&
      (x.rootId === data.root || (key === 'agent' && linked && x.rootId === linked.originRootId)))) fail('Initial session belongs to another root.', 403);
    const same = [...desktops.values()].find(x => (x.binding.windowId ?? '') === (data.windowId ?? '') && x.binding.root === data.root && ['terminal', 'agent', 'game'].every(key => (x.binding[key] ?? '') === (data[key] ?? '')));
    if (same) { await waitView(same); return { owner: same.binding.owner, pid: same.child.pid, reused: true }; }
    const owner = data.windowId ?? randomUUID(), binding = { windowId: data.windowId, title: linked?.title, root: data.root, terminal: data.terminal, agent: data.agent, game: data.game, resume: data.resume === true, owner };
    const record = { binding, binary: await snapshotBinary(binary, path.join(directory, 'versions', owner)), updating: false };
    desktops.set(owner, record); spawnView(record);
    try { await waitView(record); } catch (error) { record.child.kill(); desktops.delete(owner); throw error; }
    return { owner, pid: record.child.pid, reused: false };
  };
  const openDesktop = async data => {
    if (typeof data.root !== 'string') fail('Initial root must be explicit (empty for an empty workspace).');
    const key = JSON.stringify(['windowId', 'root', 'terminal', 'agent', 'game'].map(name => data[name] ?? ''));
    if (!opens.has(key)) opens.set(key, openView(data).finally(() => opens.delete(key)));
    return opens.get(key);
  };
  /* The probe needs a context of its own: the same binding a pane gets, in a file that is removed
     whether the probe passed or not. `runtime/tools.mjs` wrote the same document. */
  const connectorContext = async rootId => {
    const filename = path.join(directory, `tool-probe-${randomUUID()}.json`);
    await writeFile(filename, JSON.stringify({ url: host.url, token: host.token, instance: host.instance, rootId, runtimeDirectory: directory }), { mode: 0o600 });
    return filename;
  };

  const perform = async (job, desktop, closed = false) => {
    let candidate, replacement, record = desktop && desktops.get(desktop.owner), previous, previousWorker, startedDesktop = false;
    const previousConnector = connectorGeneration;
    try {
      if (job.layers.includes('workspace')) candidate = await startWorker(host, workerFile, directory, idePort);
      if (job.layers.includes('desktop')) replacement = await buildDesktop(path.join(directory, 'versions', job.id));
      if (job.layers.includes('connector')) {
        /* Build, then probe, then adopt — the desktop layer's order. A candidate that does not
           build is a job that failed before anything was switched. */
        const built = await buildConnector();
        /* A caller that named its own connector keeps it: the default builder answers with the
           binary it built, and only the default path may move. */
        if (typeof built === 'string' && !namedWorker) toolWorkerFile = path.resolve(built);
        const probeFile = await connectorContext(job.rootId);
        try { await probeConnector(toolWorkerFile, probeFile); }
        finally { await rm(probeFile, { force: true }); }
      }
      if (closing) throw new Error('Supervisor is closing.');
      job.status = 'switching';
      if (record) {
        previous = record.binary; record.updating = true;
        if (!closed) {
          await call(desktop.worker, 'desktop-action', { rootId: job.rootId, desktopId: desktop.id, action: 'reload' });
          let timer, code;
          try { code = await Promise.race([record.exited, new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), 12000); })]); }
          finally { clearTimeout(timer); }
          if (code !== 75) throw new Error(code === 'timeout' ? 'Desktop did not detach; persistence may have refused the update.' : 'Desktop closed without accepting the prepared update.');
        }
      }
      if (candidate) { previousWorker = current; preserved.add(previousWorker); current = candidate; watch(current); candidate = null; retired.add(previousWorker); }
      if (job.layers.includes('connector')) connectorGeneration++;
      await persist();
      if (record) { record.binary = replacement; record.error = null; spawnView(record); startedDesktop = true; await waitView(record); }
      job.status = 'succeeded';
      if (job.layers.includes('workspace')) { automaticRecoveryUsed = false; recovery = { state: 'idle' }; }
    } catch (error) {
      job.status = 'recovering'; job.error = error.message;
      if (candidate) candidate.child.kill();
      if (previousWorker) { const rejected = current; current = previousWorker; retired.delete(previousWorker); retired.add(rejected); notifyRetired(rejected); retire(rejected); }
      connectorGeneration = previousConnector;
      try { await persist(); } catch (error) { job.persistenceError = error.message; }
      if (startedDesktop && record.child.exitCode === null && record.child.signalCode === null && !record.error) { record.child.kill(); await record.exited; }
      if (!closing && record && (closed || record.child.exitCode !== null || record.child.signalCode !== null || record.error)) {
        record.binary = previous ?? record.binary; record.error = null;
        try { spawnView(record); await waitView(record); job.recoveredPreviousDesktop = true; }
        catch (recovery) { job.recoveryError = recovery.message; }
      }
    } finally {
      if (previousWorker) { preserved.delete(previousWorker); if (retired.has(previousWorker)) notifyRetired(previousWorker); retire(previousWorker); }
      if (record) record.updating = false;
      job.finishedAt = Date.now(); if (job.status === 'recovering') job.status = 'failed'; active = null;
      recover();
    }
  };
  const update = async data => {
    await ownRoot(data.rootId);
    if (!Array.isArray(data.layers) || !data.layers.length || new Set(data.layers).size !== data.layers.length ||
      data.layers.some(x => !['workspace', 'desktop', 'connector'].includes(x))) fail('Choose workspace, desktop and/or connector layers.');
    const desktop = data.layers.includes('desktop') ? (await list(data.rootId)).find(x => x.id === data.desktopId) : null;
    if (data.layers.includes('desktop') && (!desktop || !desktops.has(desktop.owner))) fail('Choose a managed desktop attached to this project.', 404);
    if (active || recoveryFlight) fail('A workspace update is already running.', 409);
    const job = { id: randomUUID(), rootId: data.rootId, desktopId: data.desktopId, layers: data.layers, status: 'preparing', startedAt: Date.now() };
    active = job; jobs.push(job); if (jobs.length > 32) jobs.shift();
    activeFlight = perform(job, desktop);
    return { jobId: job.id, status: 'accepted', detail: 'Update queued. Read update_status for completion or failure.' };
  };
  const keyboardUpdate = async record => {
    if (active) { spawnView(record); return; }
    const rootId = record.binding.root || (await hostState()).roots[0]?.id || '';
    const job = { id: randomUUID(), rootId, layers: ['desktop'], status: 'preparing', startedAt: Date.now() };
    active = job; jobs.push(job); record.updating = true;
    activeFlight = perform(job, { owner: record.binding.owner }, true); await activeFlight;
  };
  const windowList = async rootId => {
    await ownRoot(rootId);
    return { windows: windows.list(rootId).map(window => ({ ...window, status: desktops.has(window.id) ? 'open' : 'closed', pid: desktops.get(window.id)?.child.pid })) };
  };
  const reopenWindow = async window => openDesktop({ root: window.projectRootId, agent: window.agentId, windowId: window.id, originRootId: window.originRootId });
  const openProject = async data => {
    const state = await ownRoot(data.rootId);
    if (!state.sessions.some(x => x.id === data.agentId && x.rootId === data.rootId && x.type === 'agent' && x.state === 'running')) fail('Select a running agent bound to the originating project.', 403);
    const project = await call(host, 'roots', { path: data.path });
    if (project.id === data.rootId) fail('Select a different integration project.');
    const window = await windows.create(data.rootId, project, data.agentId);
    const opened = await reopenWindow(window);
    return { ...window, layout: undefined, ...opened };
  };
  const windowAction = async data => {
    await ownRoot(data.rootId); const window = windows.get(data.rootId, data.windowId);
    if (active || recoveryFlight) fail('Wait for the current workspace update.', 409);
    if (data.action === 'reopen') return reopenWindow(window);
    const record = desktops.get(window.id);
    if (!record) fail('Project window is closed; reopen it explicitly.', 409);
    if (data.action === 'inspect') return inspectWindow(record, directory, data.screenshot === true);
    if (data.action === 'focus') return { requested: await record.control({ op: 'control-focus' }) === true };
    if (data.action !== 'close') fail('Choose inspect, focus, close or reopen.');
    if (record.closing) fail('Window close is already pending.', 409);
    record.closing = true; let timer;
    try {
      if (await record.control({ op: 'control-close' }) !== true) fail('Native window rejected close.');
      const code = await Promise.race([record.exited, new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), 7000); })]);
      if (code !== 0) fail('Window did not finish a normal close; inspect its persistence status.', 409);
      return { windowId: window.id, status: 'closed', sessionsRetained: true };
    } finally { record.closing = false; clearTimeout(timer); }
  };
  const server = http.createServer(async (req, res) => {
    try {
      const target = new URL(req.url, 'http://127.0.0.1');
      if (target.pathname === '/health') { json(res, 200, { protocol: 1, instance: host.instance, layeredUpdates: 1 }); return; }
      if (!authenticated(req, token, url)) fail('Workspace authentication required.', 401);
      if (req.method === 'GET' && target.pathname === '/api/state') {
        const worker = current;
        try { const state = await call(worker, 'state'); worker.error = null; json(res, 200, { ...state, capabilities: { ...state.capabilities, projectWindows: 1 }, ...(target.searchParams.has('windowId') ? { layout: windows.stateLayout(target.searchParams.get('windowId')) } : {}) }); }
        catch (error) {
          worker.error = error.message;
          const state = await hostState();
          json(res, 200, { ...state, capabilities: { ...state.capabilities, desktopActions: 1, layeredUpdates: 1, projectWindows: 1 }, ...(target.searchParams.has('windowId') ? { layout: windows.stateLayout(target.searchParams.get('windowId')) } : {}), workspaceWorkerUnavailable: true });
        }
      }
      else if (req.method === 'POST' && target.pathname === '/api/layout' && target.searchParams.has('windowId')) json(res, 200, await windows.layout(target.searchParams.get('windowId'), (await body(req)).layout));
      else if (req.method === 'GET' && target.pathname === '/api/project-windows') json(res, 200, await windowList(target.searchParams.get('rootId')));
      else if (req.method === 'POST' && target.pathname === '/api/project-window-open') json(res, 200, await openProject(await body(req)));
      else if (req.method === 'POST' && target.pathname === '/api/project-window-action') json(res, 200, await windowAction(await body(req)));
      else if (req.method === 'POST' && target.pathname === '/api/integration-report') {
        const data = await body(req); await ownRoot(data.rootId); json(res, 200, await windows.report(data.rootId, data));
      }
      else if (req.method === 'GET' && target.pathname === '/api/integration-inbox') {
        const rootId = target.searchParams.get('rootId'); await ownRoot(rootId);
        json(res, 200, windows.inbox(rootId, { after: Number(target.searchParams.get('after') ?? 0), windowId: target.searchParams.get('windowId'), projectSide: target.searchParams.get('projectSide') === 'true' }));
      }
      else if (req.method === 'GET' && target.pathname === '/api/update-status') json(res, 200, await status(target.searchParams.get('rootId')));
      else if (req.method === 'GET' && target.pathname === '/api/desktops') json(res, 200, { desktops: (await list(target.searchParams.get('rootId'))).map(publicDesktop) });
      else if (req.method === 'POST' && target.pathname === '/api/update-workspace') json(res, 202, await update(await body(req)));
      else if (req.method === 'POST' && target.pathname === '/api/open-desktop') json(res, 200, await openDesktop(await body(req)));
      else if (req.method === 'POST' && target.pathname === '/api/desktop-action') {
        const data = await body(req); if (data.action !== 'reload') fail('Unknown desktop action.');
        json(res, 202, await update({ ...data, layers: ['desktop'] }));
      } else {
        const worker = current; worker.requests++;
        forward(req, res, worker, () => { worker.requests--; retire(worker); });
      }
    } catch (error) { if (!res.headersSent) json(res, error.status ?? 500, { error: error.message }); else res.destroy(); }
  });
  server.on('upgrade', (req, socket, head) => {
    const target = new URL(req.url, 'http://127.0.0.1'); req.headers.authorization = `Bearer ${target.searchParams.get('token')}`;
    if (!['/events', '/surface'].includes(target.pathname) || !authenticated(req, token, url)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    const worker = current; worker.streams++;
    tunnel(req, socket, head, worker, () => { worker.streams--; retire(worker); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  instance.url = url = `http://127.0.0.1:${server.address().port}`;
  await persist();
  if (initial) await openDesktop(initial);
  return { ...instance, status, update, openDesktop, async close() {
    closing = true;
    await activeFlight; await recoveryFlight;
    for (const record of desktops.values()) { record.child.kill(); await record.exited; }
    for (const worker of [current, ...retired]) worker.child.kill();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.once('message', async options => {
    try {
      const runtime = await startRuntime(options);
      if (process.connected) process.send({ type: 'ready', url: runtime.url, instance: runtime.instance, pid: process.pid }, () => {});
      process.on('SIGTERM', async () => { await runtime.close(); process.exit(0); });
    } catch (error) { if (process.connected) process.send({ type: 'failed', error: error.message }, () => process.exit(1)); else process.exit(1); }
  });
}
