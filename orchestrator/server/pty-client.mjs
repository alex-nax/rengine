/* The thin client of the red-pty service (F176 core, F177 retention; spec 129/131, KI-096,
 * charter D60): the PTY core the JS session host delegates to in F178's swap — spawn, input,
 * resize, stop, snapshot — over the newline-delimited JSON-RPC channel and the same
 * loop-retention discipline the red-store client established (refs at start, flight and close;
 * unref at idle). Events arrive as unsolicited lines and surface as EventEmitter 'event'
 * objects in the JS host's own two shapes: 'output' chunks and 'session' snapshots.
 *
 * Two ways in, and the difference is who owns the PTYs:
 *
 *   PtyHost.open()             a stdio child — one client, dies with this process.
 *   PtyHost.attach(stateDir)   the state directory's own long-lived service. The sessions
 *                              belong to the directory, not to this host, so replacing the host
 *                              leaves the agent CLIs inside them alive (D60).
 *
 * `attach` is `ensureSidecar`'s discipline applied to `pty.json`: read the descriptor, refuse
 * anything but loopback with a 64-hex token, connect, and only start a service under a
 * `pty-startup.lock` whose stale owner is reaped by PID. A descriptor that names another
 * protocol is not adopted and not stranded — the service is ended by name and a new one starts,
 * which is exactly what a host replacement does today.
 *
 * The scrollback rides every snapshot as base64 UTF-16LE, decoded here to a JS string — the
 * only representation that holds even a lone surrogate at the OUTPUT_LIMIT slice boundary
 * exactly as the JS host's own string does (spec 060).
 *
 * The binary resolves as $RENGINE_RED_PTY_SERVE, then the repo's debug or release build.
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { closeSync, existsSync, openSync } from 'node:fs';
import { mkdir, open as openFile, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { alive } from '../launcher/sidecar.mjs';

const CHECKOUT = fileURLToPath(new URL('../../', import.meta.url));
/* The wire red-pty-serve speaks. A service answering another number is ended, never adopted. */
export const PTY_PROTOCOL = 1;

function serveBinary() {
  const declared = process.env.RENGINE_RED_PTY_SERVE;
  if (declared) {
    if (existsSync(declared)) return declared;
    throw new Error(`RENGINE_RED_PTY_SERVE names ${declared}, which does not exist.`);
  }
  for (const profile of ['debug', 'release']) {
    const candidate = path.join(CHECKOUT, 'red/target', profile, 'red-pty-serve');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('The red-pty-serve binary is required (run: cargo build -p red-pty, or set RENGINE_RED_PTY_SERVE).');
}

const utf16 = base64 => (base64 ? Buffer.from(base64, 'base64').toString('utf16le') : '');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const descriptorPath = directory => path.join(directory, 'pty.json');

/* The same refusals discoverSidecar makes, for the same reasons: a descriptor is data on disk,
   and everything about it is checked before anything is sent to the address it names. */
export async function readDescriptor(directory) {
  let document;
  try { document = JSON.parse(await readFile(descriptorPath(directory), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const address = typeof document.url === 'string' ? /^tcp:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(document.url) : null;
  if (!address || !/^[0-9a-f]{64}$/.test(document.token ?? '') || !Number.isSafeInteger(document.pid)) {
    throw new Error(`Invalid red-pty descriptor in ${descriptorPath(directory)}.`);
  }
  return { ...document, port: Number(address[1]) };
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.removeListener('error', reject); resolve(socket); });
    socket.once('error', reject);
  });
}

/* A service whose protocol this host cannot read is ended rather than left holding PTYs nobody
   can reach. Its sessions end with it — today's host-replacement behavior, named out loud. */
async function endService(directory, descriptor, why) {
  process.emitWarning(`red-pty: ${why} Ending PID ${descriptor.pid} and starting a service this host can read.`);
  try { process.kill(descriptor.pid, 'SIGTERM'); } catch { /* already gone */ }
  for (let waited = 0; waited < 2000 && alive(descriptor.pid); waited += 50) await pause(50);
  if (alive(descriptor.pid)) { try { process.kill(descriptor.pid, 'SIGKILL'); } catch { /* raced */ } }
  await rm(descriptorPath(directory), { force: true });
}

async function liveDescriptor(directory) {
  const descriptor = await readDescriptor(directory);
  if (!descriptor) return null;
  if (descriptor.protocol !== PTY_PROTOCOL) {
    await endService(directory, descriptor, `${descriptorPath(directory)} names protocol ${descriptor.protocol}; this host speaks ${PTY_PROTOCOL}.`);
    return null;
  }
  if (!alive(descriptor.pid)) return null;
  try { return { descriptor, socket: await connect(descriptor.port) }; }
  catch { return null; }
}

/* One service per state directory. The lock is the sidecar's: exclusive create, the owner's PID
   inside it, and an owner that is gone is reaped rather than waited out. */
async function startService(directory, env) {
  const binary = serveBinary();
  const lockPath = path.join(directory, 'pty-startup.lock');
  const deadline = Date.now() + 15000;
  let lock;
  while (!lock) {
    try { lock = await openFile(lockPath, 'wx', 0o600); await lock.writeFile(JSON.stringify({ pid: process.pid })); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const ready = await liveDescriptor(directory);
      if (ready) return ready;
      try {
        const owner = JSON.parse(await readFile(lockPath, 'utf8'));
        if (Number.isSafeInteger(owner.pid) && !alive(owner.pid)) { await rm(lockPath, { force: true }); continue; }
      } catch { await rm(lockPath, { force: true }); continue; }
      if (Date.now() > deadline) throw new Error(`${lockPath} is held by a live process; no second red-pty service was started.`);
      await pause(50);
    }
  }
  try {
    const ready = await liveDescriptor(directory);
    if (ready) return ready;
    const log = openSync(path.join(directory, 'pty-serve.log'), 'a');
    const child = spawn(binary, ['--state', directory], { detached: true, stdio: ['ignore', 'ignore', log], env });
    child.unref();
    closeSync(log);
    for (let waited = 0; waited < 15000; waited += 50) {
      const started = await liveDescriptor(directory);
      if (started) return started;
      await pause(50);
    }
    throw new Error(`red-pty-serve did not write ${descriptorPath(directory)} within 15s; see ${path.join(directory, 'pty-serve.log')}.`);
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }

export class PtyHost extends EventEmitter {
  /** The stdio service: this process owns the PTYs and they die with it. */
  static async open({ env = process.env } = {}) {
    const binary = serveBinary();
    const child = spawn(binary, [], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    const host = new PtyHost({ child });
    await host.started;
    return host;
  }

  /** The state directory's own service: found if it is running, started if it is not. */
  static async attach(directory, { env = process.env } = {}) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const found = (await liveDescriptor(directory)) ?? (await startService(directory, env));
    const host = new PtyHost({ socket: found.socket });
    const hello = await host.call('attach', [{ token: found.descriptor.token, protocol: PTY_PROTOCOL }]);
    if (hello.instance !== found.descriptor.instance) {
      host.socket.destroy();
      fail(`red-pty at ${found.descriptor.url} answered as ${hello.instance}, not the ${found.descriptor.instance} its descriptor names.`, 409);
    }
    host.service = { url: found.descriptor.url, pid: hello.pid, instance: hello.instance, protocol: hello.protocol };
    host.adopted = hello.sessions.map(session => ({ ...session, output: utf16(session.output) }));
    return host;
  }

  constructor({ child = null, socket = null }) {
    super();
    this.child = child;
    this.socket = socket;
    this.pid = child?.pid ?? null;
    this.sequence = 0;
    this.pending = new Map();
    this.closed = false;
    const stream = child ? child.stdout : socket;
    this.idle = child ? [child, child.stdin, child.stdout] : [socket];
    this.lines = readline.createInterface({ input: stream });
    this.lines.on('line', line => this.answer(line));
    this.started = child ? this.awaitStdioStart() : Promise.resolve(this);
    if (socket) socket.on('close', () => this.orphan('the red-pty service closed the connection'));
  }

  awaitStdioStart() {
    return new Promise((resolve, reject) => {
      this.onStarted = resolve;
      this.child.once('error', reject);
      this.child.once('exit', (code, signal) => {
        const error = new Error(`red-pty-serve exited before it started (${code ?? signal}).`);
        if (this.onStarted) { this.onStarted = null; reject(error); }
        this.orphan(`red-pty-serve exited (${code ?? signal})`);
      });
    }).finally(() => { for (const handle of this.idle) handle.unref(); });
  }

  orphan(why) {
    for (const pending of this.pending.values()) pending.reject(new Error(`${why}.`));
    this.pending.clear();
  }

  answer(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { return; }
    if (message.started && message.id === undefined) {
      const resolve = this.onStarted;
      this.onStarted = null;
      resolve?.(this);
      return;
    }
    if (message.type === 'output' || message.type === 'session') {
      if (message.session?.output !== undefined) message.session.output = utf16(message.session.output);
      this.emit('event', message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      const error = new Error(message.error.message);
      if (message.error.status !== null && message.error.status !== undefined) error.status = message.error.status;
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
  }

  call(method, args = []) {
    const id = ++this.sequence;
    const request = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    const flight = this.idle;
    for (const handle of flight) handle.ref();
    const line = JSON.stringify({ id, method, args }) + '\n';
    if (this.child) this.child.stdin.write(line); else this.socket.write(line);
    return request.finally(() => { for (const handle of flight) handle.unref(); });
  }

  /** Closing a stdio host ends its sessions; closing an attached one leaves them running. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const handle of this.idle) handle.ref();
    if (this.child) {
      this.child.stdin.end();
      await new Promise(resolve => this.child.once('exit', resolve));
    } else if (!this.socket.destroyed) {
      /* A host whose service died still closes: the socket may already be gone, and waiting for
         a 'close' that has already fired is a hang with nothing left to wake it. */
      await new Promise(resolve => { this.socket.once('close', resolve); this.socket.end(); });
    }
    for (const handle of this.idle) handle.unref();
  }

  spawn(options) {
    return this.call('spawn', [{ command: options.command, args: options.args ?? [], env: options.env ?? {}, cwd: options.cwd ?? '/', cols: options.cols ?? 100, rows: options.rows ?? 30 }])
      .then(snapshot => ({ ...snapshot, output: utf16(snapshot.output) }));
  }
  input(id, data) { return this.call('input', [id, data]); }
  resize(id, cols, rows) { return this.call('resize', [id, cols, rows]); }
  stop(id) {
    return this.call('stop', [id]).then(snapshot => ({ ...snapshot, output: utf16(snapshot.output) }));
  }
  snapshot(id) {
    return this.call('snapshot', [id]).then(snapshot => ({ ...snapshot, output: utf16(snapshot.output) }));
  }
  list() { return this.call('list'); }
}
