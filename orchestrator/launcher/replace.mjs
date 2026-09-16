import { execFile } from 'node:child_process';
import { readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { alive, ensureSidecar, request } from './sidecar.mjs';

const checkout = fileURLToPath(new URL('../../', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = promisify(execFile);

// ps, never pgrep — see sidecar: process-table-not-pgrep.
export async function listProcesses(exec = run) {
  if (process.platform === 'win32') throw new Error('--replace-host is not supported on Windows yet: stop the session host from Task Manager, then start again.');
  const { stdout } = await exec('ps', ['-A', '-ww', '-o', 'pid=,ppid=,command='], { maxBuffer: 64 * 1024 * 1024 });
  return parseProcessTable(stdout);
}

export function parseProcessTable(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3].trim() });
  }
  return rows;
}

/* A host is spawned as exactly [host, '--state', directory], so the directory is the TAIL — which
   is what keeps a directory with a space in its name whole.

   Two spellings, for the same reason `supervises` has two: the host is `red-host` now (F152), and a
   workspace started before that upgrade is still running `server/main.mjs`. A check that knew only
   one would refuse to replace a live host — "that process is not a session host" — for the other. */
export function hostArguments(command) {
  const match = /(?:^|\s)(\S*(?:server\/main\.mjs|(?:^|\/)red-host))\s+--state\s+(.+?)\s*$/.exec(command);
  return match ? { script: match[1], stateDir: match[2] } : null;
}

async function canonical(directory) {
  try { return await realpath(directory); } catch { return path.resolve(directory); }
}

export async function readDescriptor(stateDir) {
  try { return JSON.parse(await readFile(path.join(stateDir, 'sidecar.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function findHost(stateDir, { processes, alive: isAlive = alive, descriptor } = {}) {
  descriptor = descriptor === undefined ? await readDescriptor(stateDir) : descriptor;
  if (!descriptor) return { descriptor: null, process: null };
  const pid = descriptor.pid;
  const entry = Number.isSafeInteger(pid) && pid > 0 ? processes.find(candidate => candidate.pid === pid) : undefined;
  if (!entry || !isAlive(pid)) return { descriptor, process: null, stale: true };
  const args = hostArguments(entry.command);
  if (!args) throw new Error(`${path.join(stateDir, 'sidecar.json')} names PID ${pid}, but that process is not a session host: ${entry.command}. Nothing was signalled.`);
  const [served, wanted] = await Promise.all([canonical(args.stateDir), canonical(stateDir)]);
  if (served !== wanted) throw new Error(`PID ${pid} is the session host of ${args.stateDir}, not ${stateDir}. Nothing was signalled.`);
  return { descriptor, process: entry };
}

export function ancestorsOf(pid, processes) {
  const chain = [], seen = new Set();
  let current = processes.find(entry => entry.pid === pid);
  while (current && current.ppid > 0 && !seen.has(current.ppid)) {
    seen.add(current.ppid); chain.push(current.ppid);
    current = processes.find(entry => entry.pid === current.ppid);
  }
  return chain;
}
export const insideHost = (hostPid, processes, self = process.pid) => ancestorsOf(self, processes).includes(hostPid);

/* The descriptor names a pid; this is what stops a STALE one from naming somebody else's process.
   A pid is recycled in minutes on a busy machine, and what follows a match here is a SIGTERM.

   Two spellings, because the supervisor is a binary now (F159, spec 144) and a workspace started
   before that upgrade is still running the module. A check that knew only the new one would report
   "no update supervisor is running" for a live workspace and then leave it running through a host
   replacement; one that knew only the old one does the same the other way round. */
export function supervises(command) {
  return /runtime\/supervisor\.mjs(\s|$)/.test(command) || /(^|\/)red-supervisor(\s|$)/.test(command);
}

export async function findSupervisors(instance, processes, { runtimeRoot = path.join(checkout, '.cache/runtime') } = {}) {
  let names = [];
  try { names = await readdir(runtimeRoot); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const found = [];
  for (const name of names) {
    let value;
    try { value = JSON.parse(await readFile(path.join(runtimeRoot, name, 'runtime.json'), 'utf8')); } catch { continue; }
    if (value?.host?.instance !== instance) continue;
    const entry = processes.find(candidate => candidate.pid === value.pid);
    if (!entry || !supervises(entry.command)) continue;
    found.push({ pid: value.pid, url: value.url, directory: path.join(runtimeRoot, name), children: processes.filter(candidate => candidate.ppid === value.pid) });
  }
  return found;
}

export async function stopProcess(pid, { kill = process.kill, alive: isAlive = alive, sleep = pause, graceMs = 8000, killMs = 3000 } = {}) {
  const signal = name => { try { kill(pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  const gone = async ms => { const deadline = Date.now() + ms; while (isAlive(pid)) { if (Date.now() > deadline) return false; await sleep(50); } return true; };
  if (!isAlive(pid)) return { pid, outcome: 'already gone' };
  signal('SIGTERM');
  if (await gone(graceMs)) return { pid, outcome: 'stopped on SIGTERM' };
  signal('SIGKILL');
  if (await gone(killMs)) return { pid, outcome: 'ignored SIGTERM, killed' };
  throw new Error(`PID ${pid} is still alive after SIGKILL.`);
}

export async function portReleased(url, { timeoutMs = 5000, sleep = pause } = {}) {
  const { hostname, port } = new URL(url);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const accepting = await new Promise(resolve => {
      const socket = net.connect({ host: hostname, port: Number(port) });
      socket.setTimeout(500);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => resolve(false));
    });
    if (!accepting) return true;
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
}

const CODE_AREAS = ['orchestrator/server', 'orchestrator/launcher', 'orchestrator/agents', 'scripts', 'contracts'];

// sidecar.json is written at host start, so its time is the host's; a heuristic, and the notice says so.
export async function hostAge(stateDir, { checkoutRoot = checkout, areas = CODE_AREAS } = {}) {
  let started;
  try { started = (await stat(path.join(stateDir, 'sidecar.json'))).mtimeMs; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let newest = { at: 0, file: null };
  for (const area of areas) {
    const directory = path.join(checkoutRoot, area);
    let entries = [];
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith('._llm.json')) continue;
      const at = (await stat(path.join(directory, entry.name))).mtimeMs;
      if (at > newest.at) newest = { at, file: path.join(area, entry.name) };
    }
  }
  return { startedAt: new Date(started), newestAt: new Date(newest.at), newestFile: newest.file, stale: newest.at > started + 1000 };
}

/* The PTY service of a state directory, as it published itself. A descriptor that names a process
   that is gone names nothing. */
/* The services that belong to the state directory rather than to the host: its PTYs (charter D60)
   and its store (D61). Each is a child in `ps` only because the parent that started it has not
   exited yet, and stopping either would take from the next host exactly what these decisions gave
   it — the panes in one case, the state in the other. */
const RETAINED = [['pty', 'pty service'], ['store', 'store service']];

async function retainedServices(stateDir, isAlive) {
  const found = new Map();
  for (const [name, role] of RETAINED) {
    let value;
    /* Only a missing or torn descriptor is "no service": a catch that swallowed everything turned
       a ReferenceError in this function into "there is none", and the service was stopped anyway. */
    try { value = JSON.parse(await readFile(path.join(stateDir, `${name}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) continue; throw error; }
    if (Number.isSafeInteger(value.pid) && isAlive(value.pid)) found.set(value.pid, role);
  }
  return found;
}

export function describeReport(report) {
  const { previous, ended, stopped, started } = report;
  const lines = [];
  if (!previous) lines.push(`No session host was recorded in ${report.stateDir}; nothing to replace.`);
  else if (previous.stale) lines.push(`sidecar.json in ${report.stateDir} named PID ${previous.pid}, which is gone; the stale descriptor was removed.`);
  else {
    lines.push(`Replaced the session host of ${report.stateDir}:`);
    lines.push(`  stopped host PID ${previous.pid} (${previous.url}, instance ${previous.instance}${previous.startedAt ? `, started ${previous.startedAt.toISOString()}` : ''})`);
    for (const item of stopped) lines.push(`  ${item.role} PID ${item.pid}: ${item.outcome}`);
    /* Since charter D60 these sessions are handed over rather than ended: the PTYs belong to the
       state directory, and the host that starts next adopts them. The list is still printed — a
       person replacing a host wants to know which agent panes are about to change hands — and the
       word changed with the behaviour (F179; F94's criterion 4 is superseded in that clause). */
    lines.push(ended.length ? `  handed ${ended.length} running session(s) to the next host:` : '  no running sessions to hand over');
    for (const session of ended) lines.push(`    ${session.type}${session.agent ? ` (${session.agent})` : ''} — ${session.title ?? session.id}${session.conversation ? `, conversation ${session.conversation}` : ''}`);
    for (const service of report.retained ?? []) {
      lines.push(`  left the ${service.role} running (PID ${service.pid}): it belongs to ${report.stateDir}, not to a host`);
    }
    if (report.note) lines.push(`  note: ${report.note}`);
  }
  lines.push(`Started host PID ${started.pid} (${started.url}, instance ${started.instance}) from ${started.checkout}.`);
  return lines.join('\n');
}

export async function replaceHost(stateDir, options = {}) {
  const { log = console.log, start = ensureSidecar, self = process.pid } = options;
  const processes = options.processes ?? await listProcesses();
  const isAlive = options.alive ?? alive;
  const stopping = { ...options, alive: isAlive };
  stateDir = path.resolve(stateDir);
  const report = { stateDir, previous: null, ended: [], stopped: [], retained: [], started: null };
  const found = await findHost(stateDir, { processes, alive: isAlive });
  if (found.descriptor && found.process) {
    const { pid, url, instance } = found.descriptor;
    if (insideHost(pid, processes, self)) {
      throw new Error(`This launcher is running inside the workspace it would replace: session host PID ${pid} is one of its ancestors, and a pane inside dies with the host. Run the same command from a terminal outside rEngine, such as Terminal.app. Nothing was signalled.`);
    }
    let startedAt = null;
    try { startedAt = (await stat(path.join(stateDir, 'sidecar.json'))).mtime; } catch { /* the report just omits it */ }
    report.previous = { pid, url, instance, startedAt, command: found.process.command };
    try {
      const state = await request(found.descriptor, 'state');
      report.ended = state.sessions.filter(session => session.state === 'running')
        .map(({ id, type, title, agent, conversation }) => ({ id, type, title, agent, conversation }));
    } catch (error) { report.note = `the host did not answer /api/state before it was stopped (${error.message}); its running sessions could not be listed`; }
    // Supervisor first, so nothing recovers a worker against a dying host — see sidecar: supervisor-before-host.
    for (const supervisor of await findSupervisors(instance, processes, options)) {
      report.stopped.push({ role: 'supervisor', ...await stopProcess(supervisor.pid, stopping) });
      for (const child of supervisor.children) if (isAlive(child.pid)) report.stopped.push({ role: 'supervisor child', ...await stopProcess(child.pid, stopping) });
    }
    report.stopped.push({ role: 'host', ...await stopProcess(pid, stopping) });
    /* The host's children go with it — except the one that is not its to end. The state
       directory's PTY service is started detached and outlives every host of that directory by
       design (charter D60): stopping it here would kill the agent panes this replacement exists to
       preserve, and it is a child in `ps` only because the parent that started it has not exited
       yet. Named by the descriptor it published, not by its command line. */
    const services = await retainedServices(stateDir, isAlive);
    for (const child of processes.filter(entry => entry.ppid === pid)) {
      if (services.has(child.pid)) { report.retained.push({ role: services.get(child.pid), pid: child.pid }); continue; }
      if (isAlive(child.pid)) report.stopped.push({ role: 'host child', ...await stopProcess(child.pid, stopping) });
    }
    if (!await portReleased(url, options)) throw new Error(`${url} still accepts connections after PID ${pid} exited; not starting a second host.`);
    await rm(path.join(stateDir, 'sidecar.json'), { force: true });
  } else if (found.descriptor) {
    report.previous = { ...found.descriptor, stale: true };
    await rm(path.join(stateDir, 'sidecar.json'), { force: true });
  }
  const instance = await start(stateDir);
  report.started = { pid: instance.pid, url: instance.url, instance: instance.instance, checkout };
  log(describeReport(report));
  return report;
}
