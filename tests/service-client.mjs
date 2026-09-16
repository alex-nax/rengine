/* The client half of a per-state-directory service (charter D60/D61, `red_core::service`).
 *
 * `store-client.mjs` and `pty-client.mjs` each grew their own copy of this: find the descriptor,
 * refuse anything but loopback with a 64-hex token, start one under a lock whose stale owner is
 * reaped by PID, attach with the protocol number, then speak newline-delimited JSON-RPC. This is
 * that discipline, once, for the services that came after — and the module those two collapse into
 * when F158 deletes them.
 *
 * A service belongs to the DIRECTORY, not to the host that found it: closing this client leaves it
 * running, and a service whose protocol this build cannot read is ended rather than misread.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { closeSync, existsSync, openSync } from 'node:fs';
import { mkdir, open as openFile, readFile, rm } from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { alive } from './sidecar.mjs';

const CHECKOUT = fileURLToPath(new URL('../', import.meta.url));
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** $VARIABLE, then the repo's debug or release build; a missing binary is named, never worked around. */
export function serveBinary(variable, basename) {
  const declared = process.env[variable];
  if (declared) {
    if (existsSync(declared)) return declared;
    throw new Error(`${variable} names ${declared}, which does not exist.`);
  }
  for (const profile of ['debug', 'release']) {
    const candidate = path.join(CHECKOUT, 'red/target', profile, basename);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`The ${basename} binary is required (run: cargo build --manifest-path red/Cargo.toml --bins, or set ${variable}).`);
}

const descriptorPath = (directory, name) => path.join(directory, `${name}.json`);

async function readDescriptor(directory, name) {
  let document;
  try { document = JSON.parse(await readFile(descriptorPath(directory, name), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const address = typeof document.url === 'string' ? /^tcp:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(document.url) : null;
  if (!address || !/^[0-9a-f]{64}$/.test(document.token ?? '') || !Number.isSafeInteger(document.pid)) {
    throw new Error(`Invalid red-${name} descriptor in ${descriptorPath(directory, name)}.`);
  }
  return { ...document, port: Number(address[1]) };
}

const connect = port => new Promise((resolve, reject) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.removeListener('error', reject); resolve(socket); });
  socket.once('error', reject);
});

/* A service whose protocol this host cannot read is ended rather than left holding what it holds
   for a client that cannot reach it. Its state ends with it, which is today's host-replacement
   behaviour, named out loud. */
async function endService(directory, name, descriptor, why) {
  process.emitWarning(`red-${name}: ${why} Ending PID ${descriptor.pid} and starting a service this host can read.`);
  try { process.kill(descriptor.pid, 'SIGTERM'); } catch { /* already gone */ }
  for (let waited = 0; waited < 2000 && alive(descriptor.pid); waited += 50) await pause(50);
  if (alive(descriptor.pid)) { try { process.kill(descriptor.pid, 'SIGKILL'); } catch { /* raced */ } }
  await rm(descriptorPath(directory, name), { force: true });
}

async function liveDescriptor(directory, name, protocol) {
  const descriptor = await readDescriptor(directory, name);
  if (!descriptor) return null;
  if (descriptor.protocol !== protocol) {
    await endService(directory, name, descriptor, `${descriptorPath(directory, name)} names protocol ${descriptor.protocol}; this host speaks ${protocol}.`);
    return null;
  }
  if (!alive(descriptor.pid)) return null;
  try { return { descriptor, socket: await connect(descriptor.port) }; }
  catch { return null; }
}

/* One service per directory, so the start is taken under a lock: two hosts attaching at once must
   not each spawn one, and a lock whose owner died must not block the survivor forever. */
async function startService(directory, { name, protocol, binary, env, args }) {
  const lockPath = path.join(directory, `${name}-startup.lock`);
  const deadline = Date.now() + 15000;
  let lock;
  while (!lock) {
    try { lock = await openFile(lockPath, 'wx', 0o600); await lock.writeFile(JSON.stringify({ pid: process.pid })); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const ready = await liveDescriptor(directory, name, protocol);
      if (ready) return ready;
      try {
        const owner = JSON.parse(await readFile(lockPath, 'utf8'));
        if (Number.isSafeInteger(owner.pid) && !alive(owner.pid)) { await rm(lockPath, { force: true }); continue; }
      } catch { await rm(lockPath, { force: true }); continue; }
      if (Date.now() > deadline) throw new Error(`${lockPath} is held by a live process; no second red-${name} service was started.`);
      await pause(50);
    }
  }
  try {
    const ready = await liveDescriptor(directory, name, protocol);
    if (ready) return ready;
    const log = openSync(path.join(directory, `${name}-serve.log`), 'a');
    const child = spawn(binary, args, { detached: true, stdio: ['ignore', 'ignore', log], env });
    child.unref();
    closeSync(log);
    for (let waited = 0; waited < 15000; waited += 50) {
      const started = await liveDescriptor(directory, name, protocol);
      if (started) return started;
      await pause(50);
    }
    throw new Error(`${path.basename(binary)} did not write ${descriptorPath(directory, name)} within 15s; see ${path.join(directory, `${name}-serve.log`)}.`);
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

/** The service serving `directory`: found if one is running, started if not, connected either way. */
export async function findOrStart(directory, { name, protocol, variable, basename, env = process.env, args }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const binary = serveBinary(variable, basename);
  const options = { name, protocol, binary, env, args: args ?? ['--state', directory] };
  return (await liveDescriptor(directory, name, protocol)) ?? (await startService(directory, options));
}

export class ServiceClient {
  /** Attach to the service serving `directory`, starting one if there is none. */
  static async attach(directory, { name, protocol, variable, basename, env = process.env, args, onEvent = () => {} }) {
    const found = await findOrStart(directory, { name, protocol, variable, basename, env, args });
    const client = new ServiceClient(name, found.socket, onEvent);
    const hello = await client.call('attach', [{ token: found.descriptor.token, protocol }]);
    /* The instance, not the port: a service that died and was replaced between the descriptor read
       and the connect answers on the same port as something this client never agreed to talk to. */
    if (hello.instance !== found.descriptor.instance) {
      client.socket.destroy();
      throw new Error(`red-${name} at ${found.descriptor.url} answered as ${hello.instance}, not the ${found.descriptor.instance} its descriptor names.`);
    }
    client.greeting = hello;
    client.service = { url: found.descriptor.url, pid: hello.pid, instance: hello.instance };
    return client;
  }

  constructor(name, socket, onEvent) {
    this.name = name;
    this.socket = socket;
    this.onEvent = onEvent;
    this.greeting = null;
    this.service = null;
    this.sequence = 0;
    this.flights = 0;
    this.pending = new Map();
    this.lines = readline.createInterface({ input: socket });
    this.lines.on('line', line => this.answer(line));
    socket.on('error', () => { /* the close handler below is the one that matters */ });
    socket.on('close', () => {
      for (const waiting of this.pending.values()) waiting.reject(new Error(`the red-${name} service closed the connection.`));
      this.pending.clear();
    });
    socket.unref();
  }

  answer(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    /* A line with no id is the service speaking unprompted: a frame, a status, a preference. */
    if (message.id === undefined || message.id === null) { this.onEvent(message); return; }
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    this.pending.delete(message.id);
    if (message.error) {
      const error = new Error(message.error.message);
      if (message.error.status !== null && message.error.status !== undefined) error.status = message.error.status;
      waiting.reject(error);
    } else waiting.resolve(message.result);
  }

  /* Refs are COUNTED: ref/unref are not, so with two calls in flight the first answer would unref
     the socket the second is waiting on. A client nobody is calling must not hold the loop open. */
  hold() { if (this.flights++ === 0) this.socket.ref(); }
  release() { if (--this.flights === 0) this.socket.unref(); }

  call(method, args = []) {
    const id = ++this.sequence;
    const request = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.hold();
    this.socket.write(`${JSON.stringify({ id, method, args })}\n`);
    return request.finally(() => this.release());
  }

  /** Closing leaves the service running: it is the directory's, not this host's. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.hold();
    if (!this.socket.destroyed) await new Promise(resolve => { this.socket.once('close', resolve); this.socket.end(); });
    this.release();
  }
}
