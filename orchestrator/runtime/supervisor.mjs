import http from 'node:http';
import { fork } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { request as call } from '../launcher/sidecar.mjs';
import { authenticated, body, checkConnection, fail, forward, json, tunnel } from './protocol.mjs';
import { prepareDesktop, snapshotBinary, nativeBinary, launchDesktop } from './desktop.mjs';
import { probeTools } from './tools.mjs';
import { windowStore, nativeControl, inspectWindow } from './windows.mjs';

const defaultWorker = fileURLToPath(new URL('./worker.mjs', import.meta.url));
async function startWorker(host, filename, directory) {
  const child = fork(filename, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  let diagnostics = ''; child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-8000); });
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Workspace worker startup timed out.')), 10000);
      const cleanup = () => { clearTimeout(timer); child.off('error', bad); child.off('exit', exited); child.off('message', message); };
      const bad = error => { cleanup(); reject(error); };
      const exited = () => bad(new Error(`Workspace worker exited during startup. ${diagnostics}`));
      const message = data => { if (data.type === 'ready') { cleanup(); resolve(data); } else if (data.type === 'failed') bad(new Error(data.error)); };
      child.once('error', bad); child.once('exit', exited); child.on('message', message);
      child.send({ host, directory });
    });
    checkConnection(ready);
    const state = await call(ready, 'state');
    if (state.instance !== host.instance || state.capabilities.layeredUpdates !== 1) fail('Candidate workspace failed identity/capability checks.');
    return { ...ready, child, requests: 0, streams: 0, generation: randomUUID() };
  } catch (error) { child.kill(); throw error; }
}

export async function startRuntime({ host, directory, initial, binary = nativeBinary, workerFile = defaultWorker,
  buildDesktop = prepareDesktop, toolWorkerFile, inspectUI = false, onDesktop = () => {} } = {}) {
  host = checkConnection(host);
  if (!path.isAbsolute(directory)) fail('Runtime directory must be absolute.');
  const hostState = async () => { const state = await call(host, 'state'); if (state.instance !== host.instance) fail('Original session host is no longer available.'); return state; };
  await hostState(); await mkdir(directory, { recursive: true, mode: 0o700 });
  const windows = await windowStore(directory);
  let current = await startWorker(host, workerFile, directory), url, active, activeFlight, closing = false, connectorGeneration = 1;
  let recovery = { state: 'idle' }, recoveryFlight, automaticRecoveryUsed = false;
  const retired = new Set(), desktops = new Map(), opens = new Map(), preserved = new Set(), jobs = [];
  const token = randomBytes(32).toString('hex');
  const instance = { version: 1, pid: process.pid, token, instance: host.instance, host, directory };
  const ownRoot = async id => { const state = await hostState(); if (!state.roots.some(root => root.id === id)) fail('Unknown project root.', 404); return state; };
  const available = worker => worker.child.exitCode === null && worker.child.signalCode === null && worker.child.connected;
  const watch = worker => worker.child.once('exit', () => {
    if (worker === current && !closing && !active) recover();
  });
  const recover = () => {
    if (closing || recoveryFlight || automaticRecoveryUsed || available(current)) return;
    automaticRecoveryUsed = true; recovery = { state: 'restarting', previousPid: current.pid };
    recoveryFlight = (async () => {
      try {
        const next = await startWorker(host, workerFile, directory), old = current;
        if (closing) { next.child.kill(); return; }
        current = next; watch(next); retired.add(old); retire(old);
        recovery = { state: 'recovered', previousPid: old.pid, pid: next.pid };
      } catch (error) { recovery = { state: 'failed', error: error.message }; }
    })().finally(() => { recoveryFlight = null; });
  };
  watch(current);
  const retire = worker => {
    if (!retired.has(worker) || preserved.has(worker) || worker.requests || worker.streams) return;
    retired.delete(worker); if (worker.child.connected) worker.child.send({ type: 'close' });
  };
  /* Spec 095, Retirement: a replaced worker keeps draining its streams (spec 065) and hands the
     stateful half — the ledger, the feed and the host subscription that mints game.* — to the
     worker that replaced it, so one process owns them. Sent where the retirement is committed
     rather than at the swap: a failed update restores the previous worker as the current one, and
     a worker told it was retired would then be forwarding requests to itself. */
  const notifyRetired = worker => { if (worker.child.connected) worker.child.send({ type: 'retired' }); };
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
    await writeFile(`${filename}.${process.pid}.tmp`, JSON.stringify({ ...instance, url, connectorGeneration }), { mode: 0o600 });
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
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (record.error || record.child.exitCode !== null || record.child.signalCode !== null) throw new Error(`Replacement desktop exited: ${record.error ?? record.diagnostics}`);
      const values = await Promise.all([current, ...retired].map(async worker => {
        try { return await call(worker, 'runtime-desktops'); }
        catch (error) { worker.error = error.message; return { desktops: [] }; }
      }));
      if (values.some(value => value.desktops.some(x => x.owner === record.binding.owner && x.view === record.binding.view))) return;
      await delay(75);
    }
    throw new Error('Replacement desktop did not register before timeout.');
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
  const perform = async (job, desktop, closed = false) => {
    let candidate, replacement, record = desktop && desktops.get(desktop.owner), previous, previousWorker, startedDesktop = false;
    const previousConnector = connectorGeneration;
    try {
      if (job.layers.includes('workspace')) candidate = await startWorker(host, workerFile, directory);
      if (job.layers.includes('desktop')) replacement = await buildDesktop(path.join(directory, 'versions', job.id));
      if (job.layers.includes('connector')) await probeTools(host, directory, job.rootId, toolWorkerFile);
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
