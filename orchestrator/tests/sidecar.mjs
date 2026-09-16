import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = fileURLToPath(new URL('../../', import.meta.url));

/* The session host (F152, spec 129, charter D57): red-host, which is what `ensureSidecar` starts.
   Resolved the way every other Rust client here is resolved — the environment names one, then the
   release build, then the debug build — and a missing binary is named with the command that makes
   one, because this is the failure a person meets running a workspace out of a fresh clone. */
export function redHostBinary(env = process.env) {
  const declared = env.RENGINE_RED_HOST;
  if (declared) {
    if (existsSync(declared)) return declared;
    throw new Error(`RENGINE_RED_HOST names ${declared}, which does not exist.`);
  }
  for (const profile of ['release', 'debug']) {
    const candidate = path.join(checkout, 'red/target', profile, 'red-host');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('The red-host binary is required (run: cargo build -p red-host, or set RENGINE_RED_HOST).');
}
const pause = () => new Promise(resolve => setTimeout(resolve, 75));
export const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

/* Only X-Rengine-* names with printable ASCII values are carried, laid down before the fixed
   headers, so a caller can never append to or displace Authorization. */
const carried = headers => Object.fromEntries(Object.entries(headers)
  .filter(([name, value]) => /^X-Rengine-[A-Za-z-]+$/.test(name) && typeof value === 'string' && /^[\x20-\x7e]{1,256}$/.test(value)));

export async function request(instance, route, data, headers = {}) {
  const response = await fetch(`${instance.url}/api/${route}`, { method: data === undefined ? 'GET' : 'POST',
    headers: { ...carried(headers), Authorization: `Bearer ${instance.token}`, 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(10000) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Sidecar returned ${response.status}`);
  return body;
}

export async function discoverSidecar(directory) {
  let instance;
  try { instance = JSON.parse(await readFile(path.join(directory, 'sidecar.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const url = new URL(instance.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^[0-9a-f]{64}$/.test(instance.token)) throw new Error('Invalid sidecar descriptor.');
  if (!alive(instance.pid)) return null;
  try {
    const health = await fetch(`${instance.url}/health`, { signal: AbortSignal.timeout(1500) }).then(response => response.json());
    if (health.protocol !== 1 || health.instance !== instance.instance) throw new Error('Sidecar identity mismatch.');
    const state = await request(instance, 'state');
    if (state.instance !== instance.instance) throw new Error('Workspace identity mismatch.');
    return instance;
  } catch (error) {
    if (!alive(instance.pid)) return null;
    throw new Error(`Existing sidecar PID ${instance.pid} is alive but unavailable: ${error.message}. No second sidecar was started.`);
  }
}

export async function ensureSidecar(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const existing = await discoverSidecar(directory);
  if (existing) return existing;
  const lockPath = path.join(directory, 'startup.lock');
  let lock;
  const deadline = Date.now() + 15000;
  while (!lock) {
    try { lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(JSON.stringify({ pid: process.pid })); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const ready = await discoverSidecar(directory); if (ready) return ready;
      try {
        const owner = JSON.parse(await readFile(lockPath, 'utf8'));
        if (Number.isSafeInteger(owner.pid) && !alive(owner.pid)) { await rm(lockPath, { force: true }); continue; }
      } catch (readError) { if (readError.code !== 'ENOENT' && !(readError instanceof SyntaxError)) throw readError; }
      if (Date.now() > deadline) throw new Error(`Sidecar startup is still owned by ${lockPath}. Check its process and sidecar.log.`);
      await pause();
    }
  }
  let release = true;
  try {
    const ready = await discoverSidecar(directory); if (ready) return ready;
    const log = await open(path.join(directory, 'sidecar.log'), 'a', 0o600);
    /* The host is a BINARY (F152). It starts the state directory's own store and PTY services,
       publishes `sidecar.json` itself, and answers every route a workspace is made of — a full
       suite run through the old door forwarded nothing to the JavaScript behind it, which is what
       said this was ready. */
    const child = spawn(redHostBinary(), ['--state', directory], { detached: true, stdio: ['ignore', log.fd, log.fd], windowsHide: true });
    await log.close();
    let failure;
    child.on('error', error => { failure = error; });
    if (child.pid) {
      release = false;
      await lock.truncate(0); await lock.write(JSON.stringify({ pid: child.pid }), 0, 'utf8');
    }
    child.unref();
    for (;;) {
      if (failure) { release = true; throw failure; }
      if (!alive(child.pid)) { release = true; throw new Error(`Sidecar exited during startup. See ${path.join(directory, 'sidecar.log')}.`); }
      const started = await discoverSidecar(directory);
      if (started) { release = true; return started; }
      if (Date.now() > deadline) throw new Error(`Sidecar PID ${child.pid} is still starting. Inspect sidecar.log; startup ownership is retained.`);
      await pause();
    }
  } finally { await lock.close(); if (release) await rm(lockPath, { force: true }); }
}
