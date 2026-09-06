import { fork } from 'node:child_process';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from '../launcher/sidecar.mjs';
import { checkConnection } from './protocol.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
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
    const child = fork(fileURLToPath(new URL('./supervisor.mjs', import.meta.url)), [], { detached: true, stdio: ['ignore', log.fd, log.fd, 'ipc'], windowsHide: true });
    await log.close();
    let failure, initialized = false;
    child.on('error', error => { failure = error; });
    child.on('message', message => { if (message.type === 'failed') failure = new Error(message.error); if (message.type === 'ready') initialized = true; });
    if (child.pid) {
      release = false; await lock.truncate(0); await lock.write(JSON.stringify({ pid: child.pid }), 0, 'utf8');
    }
    child.send({ host, directory, initial, binary }); child.unref();
    try {
      for (;;) {
        if (failure) { release = true; throw failure; }
        if (!alive(child.pid)) { release = true; throw new Error('Runtime exited during startup; inspect runtime.log.'); }
        const started = await discoverRuntime(host, directory);
        if (started && initialized) { release = true; return started; }
        if (Date.now() > deadline) throw new Error('Runtime is still starting; startup ownership remains held.');
        await delay(75);
      }
    } finally { if (child.connected) child.disconnect(); }
  } finally { await lock.close(); if (release) await rm(filename, { force: true }); }
}
