import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from './sidecar.mjs';
import { checkConnection } from './protocol.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));

/* The update supervisor (F159, spec 144, charter D57): red-supervisor, which is what `ensureRuntime`
   starts. Resolved the way every other Rust client here is resolved — the environment names one,
   then the release build, then the debug build — and a missing binary is named with the command that
   makes one, because this is the failure a person meets running a workspace out of a fresh clone. */
export function redSupervisorBinary(env = process.env) {
  const declared = env.RENGINE_RED_SUPERVISOR;
  if (declared) {
    if (existsSync(declared)) return declared;
    throw new Error(`RENGINE_RED_SUPERVISOR names ${declared}, which does not exist.`);
  }
  for (const profile of ['release', 'debug']) {
    const candidate = path.join(project, 'red/target', profile, 'red-supervisor');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('The red-supervisor binary is required (run: cargo build -p red-supervisor, or set RENGINE_RED_SUPERVISOR).');
}
export const runtimeDirectory = host => path.join(project, '.cache/runtime', checkConnection(host).instance);
export const alive = pid => { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
export async function discoverRuntime(host, directory = runtimeDirectory(host)) {
  host = checkConnection(host);
  let value;
  try { value = JSON.parse(await readFile(path.join(directory, 'runtime.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  checkConnection(value);
  if (value.version !== 1 || value.host?.url !== host.url || value.host?.token !== host.token || value.host?.instance !== host.instance || value.instance !== host.instance) throw new Error('Runtime descriptor belongs to another session host.');
  if (!alive(value.pid)) return null;
  try {
    const state = await request(value, 'state');
    if (state.instance !== host.instance || state.capabilities.layeredUpdates !== 1) throw new Error('Runtime identity/capability mismatch.');
    return value;
  } catch (error) { throw new Error(`Runtime PID ${value.pid} is alive but unavailable. No duplicate was started: ${error.message}`); }
}
export async function resolveRuntime(context) {
  return await discoverRuntime(context, context.runtimeDirectory) ?? context;
}
export async function ensureRuntime(host, { initial, binary, directory = runtimeDirectory(host) } = {}) {
  host = checkConnection(host); await mkdir(directory, { recursive: true, mode: 0o700 });
  const existing = await discoverRuntime(host, directory);
  if (existing) { if (initial) await request(existing, 'open-desktop', initial); return existing; }
  const filename = path.join(directory, 'startup.lock'); let lock;
  const deadline = Date.now() + 25000;
  while (!lock) {
    try { lock = await open(filename, 'wx', 0o600); await lock.writeFile(JSON.stringify({ pid: process.pid })); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const ready = await discoverRuntime(host, directory);
      if (ready) { if (initial) await request(ready, 'open-desktop', initial); return ready; }
      try { const owner = JSON.parse(await readFile(filename, 'utf8')); if (Number.isSafeInteger(owner.pid) && !alive(owner.pid)) { await rm(filename, { force: true }); continue; } }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      if (Date.now() > deadline) throw new Error('Runtime startup is still owned by another live process.');
      await delay(75);
    }
  }
  let release = true;
  try {
    const ready = await discoverRuntime(host, directory);
    if (ready) { if (initial) await request(ready, 'open-desktop', initial); return ready; }
    const log = await open(path.join(directory, 'runtime.log'), 'a', 0o600);
    /* Detached, with its own log and no pipes to inherit: the supervisor outlives whoever started
       it, exactly as the session host does. Its announcement goes to the log rather than to a pipe
       this process would have to keep open — the descriptor it writes is what says it is up, and
       that is the same thing `discoverRuntime` reads for a supervisor that was already running. */
    const child = spawn(redSupervisorBinary(), ['--state', directory, '--host', host.url, '--host-token', host.token,
      ...(binary ? ['--desktop', binary] : [])],
      { detached: true, stdio: ['ignore', log.fd, log.fd], windowsHide: true });
    await log.close();
    let failure;
    child.on('error', error => { failure = error; });
    if (child.pid) {
      release = false; await lock.truncate(0); await lock.write(JSON.stringify({ pid: child.pid }), 0, 'utf8');
    }
    child.unref();
    for (;;) {
      if (failure) { release = true; throw failure; }
      if (!alive(child.pid)) { release = true; throw new Error('Runtime exited during startup; inspect runtime.log.'); }
      const started = await discoverRuntime(host, directory);
      if (started) {
        release = true;
        /* The initial window is opened over the ROUTE, cold or warm, so there is one path for it
           rather than two that can disagree. A window that will not open leaves the workspace up
           and says so, which is what a person can act on. */
        if (initial) await request(started, 'open-desktop', initial);
        return started;
      }
      if (Date.now() > deadline) throw new Error('Runtime is still starting; startup ownership remains held.');
      await delay(75);
    }
  } finally { await lock.close(); if (release) await rm(filename, { force: true }); }
}
