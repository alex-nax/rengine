/* The thin client of the red-store stdio service (F174, spec 129, KI-095): the exact
 * WorkspaceStore surface store.mjs presented — methods, results, and `fail` statuses — while
 * the store itself runs in the Rust process this spawns (newline-delimited JSON-RPC, exiting
 * when its stdin closes, so a dead host leaves no store process behind). Every answer carries
 * the store's current state, so this client's `state` snapshot reads like the JS store's own.
 *
 * The binary resolves as $RENGINE_RED_STORE_SERVE, then the repo's debug or release build;
 * a missing binary is named, never silently worked around. F175 swaps the consumers to this
 * module and deletes store.mjs and schema.mjs.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { closeSync, openSync } from 'node:fs';
import { mkdir, open as openFile, readFile, rm } from 'node:fs/promises';
import { alive } from '../launcher/sidecar.mjs';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }

const CHECKOUT = fileURLToPath(new URL('../../', import.meta.url));
function serveBinary() {
  const declared = process.env.RENGINE_RED_STORE_SERVE;
  if (declared) {
    if (existsSync(declared)) return declared;
    throw new Error(`RENGINE_RED_STORE_SERVE names ${declared}, which does not exist.`);
  }
  for (const profile of ['debug', 'release']) {
    const candidate = path.join(CHECKOUT, 'red/target', profile, 'red-store-serve');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('The red-store-serve binary is required (run: cargo build -p red-store, or set RENGINE_RED_STORE_SERVE).');
}

/* The service a standalone call (resolveInRoot, validateSchema) is answered by: the most
   recently opened store's, or a lazily spawned scratch store on a temp directory when nothing
   opened one — those functions were always stateless helpers that happened to live in
   store.mjs, and their tests never open a store. The scratch process exits with this one. */
let latest = null;

/* The store as a service of its state directory (charter D61): one owner for a directory, every
   host attaching to it, so a front door serving `/api/tree` and a JS backend serving the routes it
   has not moved yet are reading and writing one store rather than two copies of one file.
   The discipline is `pty-client`'s, because it is `discoverSidecar`'s: refuse anything but loopback
   with a 64-hex token, start one only under a lock whose stale owner is reaped by PID, and never
   adopt a service whose protocol this client cannot read. */
export const STORE_PROTOCOL = 1;
const descriptorPath = directory => path.join(directory, 'store.json');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function readDescriptor(directory) {
  let document;
  try { document = JSON.parse(await readFile(descriptorPath(directory), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const address = typeof document.url === 'string' ? /^tcp:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(document.url) : null;
  if (!address || !/^[0-9a-f]{64}$/.test(document.token ?? '') || !Number.isSafeInteger(document.pid)) {
    throw new Error(`Invalid red-store descriptor in ${descriptorPath(directory)}.`);
  }
  return { ...document, port: Number(address[1]) };
}

const connect = port => new Promise((resolve, reject) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.removeListener('error', reject); resolve(socket); });
  socket.once('error', reject);
});

async function endService(directory, descriptor, why) {
  process.emitWarning(`red-store: ${why} Ending PID ${descriptor.pid} and starting a service this host can read.`);
  try { process.kill(descriptor.pid, 'SIGTERM'); } catch { /* already gone */ }
  for (let waited = 0; waited < 2000 && alive(descriptor.pid); waited += 50) await pause(50);
  if (alive(descriptor.pid)) { try { process.kill(descriptor.pid, 'SIGKILL'); } catch { /* raced */ } }
  await rm(descriptorPath(directory), { force: true });
}

async function liveDescriptor(directory) {
  const descriptor = await readDescriptor(directory);
  if (!descriptor) return null;
  if (descriptor.protocol !== STORE_PROTOCOL) {
    await endService(directory, descriptor, `${descriptorPath(directory)} names protocol ${descriptor.protocol}; this host speaks ${STORE_PROTOCOL}.`);
    return null;
  }
  if (!alive(descriptor.pid)) return null;
  try { return { descriptor, socket: await connect(descriptor.port) }; }
  catch { return null; }
}

async function startService(directory, env) {
  const binary = serveBinary();
  const lockPath = path.join(directory, 'store-startup.lock');
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
      if (Date.now() > deadline) throw new Error(`${lockPath} is held by a live process; no second red-store service was started.`);
      await pause(50);
    }
  }
  try {
    const ready = await liveDescriptor(directory);
    if (ready) return ready;
    const log = openSync(path.join(directory, 'store-serve.log'), 'a');
    const child = spawn(binary, ['--state', directory], { detached: true, stdio: ['ignore', 'ignore', log], env });
    child.unref();
    closeSync(log);
    for (let waited = 0; waited < 15000; waited += 50) {
      const started = await liveDescriptor(directory);
      if (started) return started;
      await pause(50);
    }
    throw new Error(`red-store-serve did not write ${descriptorPath(directory)} within 15s; see ${path.join(directory, 'store-serve.log')}.`);
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

export class WorkspaceStore {
  static async open(directory, { env = process.env } = {}) {
    const binary = serveBinary();
    const child = spawn(binary, [directory], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    const store = new WorkspaceStore(directory, child);
    latest = store;
    await store.started;
    return store;
  }

  /* A one-shot store for a stateless call. Deliberately NOT registered as `latest`: concurrent
     stateless callers (the dashboard's per-action preflights) would otherwise share one store
     whose owner closes it mid-call, and the pending call would die with the service. */
  static async scratch() {
    const directory = await mkdtemp(path.join(tmpdir(), 'rengine-red-store-scratch-'));
    const binary = serveBinary();
    const child = spawn(binary, [directory], { stdio: ['pipe', 'pipe', 'inherit'] });
    const store = new WorkspaceStore(directory, child);
    await store.started;
    return store;
  }

  /** The state directory's own store: found if a service is running, started if not (D61). */
  static async attach(directory, { env = process.env } = {}) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const found = (await liveDescriptor(directory)) ?? (await startService(directory, env));
    const store = new WorkspaceStore(directory, null, found.socket);
    const hello = await store.call('attach', [{ token: found.descriptor.token, protocol: STORE_PROTOCOL }]);
    if (hello.instance !== found.descriptor.instance) {
      store.socket.destroy();
      throw new Error(`red-store at ${found.descriptor.url} answered as ${hello.instance}, not the ${found.descriptor.instance} its descriptor names.`);
    }
    store.state = hello.state;
    store.service = { url: found.descriptor.url, pid: hello.pid, instance: hello.instance };
    latest = store;
    return store;
  }

  constructor(directory, child, socket = null) {
    this.directory = directory;
    this.filename = path.join(directory, 'workspace.json');
    this.state = null;
    this.child = child;
    this.socket = socket;
    this.pid = child?.pid ?? null;
    this.sequence = 0;
    this.flights = 0;
    this.pending = new Map();
    if (socket) {
      this.idle = [socket];
      this.lines = readline.createInterface({ input: socket });
      this.lines.on('line', line => this.answer(line));
      this.started = Promise.resolve(this);
      socket.on('close', () => { for (const pending of this.pending.values()) pending.reject(new Error('the red-store service closed the connection.')); });
      return;
    }
    this.lines = readline.createInterface({ input: child.stdout });
    this.lines.on('line', line => this.answer(line));
    /* Loop-neutral once started: a client nobody closes must not keep its process alive (the
       service reaps itself when the pipes close at process death). A call in flight refs the
       child and its pipes, so an answer is always heard; close() remains the explicit clean
       shutdown. The started await holds its own refs until the first line lands. */
    this.idle = [child, child.stdin, child.stdout];
    this.started = new Promise((resolve, reject) => {
      this.onStarted = resolve;
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        const error = new Error(`red-store-serve exited before it started (${code ?? signal}).`);
        if (this.onStarted) { this.onStarted = null; reject(error); }
        for (const pending of this.pending.values()) pending.reject(new Error(`red-store-serve exited (${code ?? signal}).`));
      });
    }).finally(() => { for (const handle of this.idle) handle.unref(); });
  }

  answer(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { return; }
    if (message.started) {
      this.state = message.state;
      const resolve = this.onStarted;
      this.onStarted = null;
      resolve?.(this);
      return;
    }
    if (message.state !== undefined) this.state = message.state;
    /* An unsolicited state line: another host attached to this directory's store changed it, and
       this snapshot is what `root()` and the rest answer from (D61). */
    if (message.id === undefined) return;
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

  /* Refs are COUNTED here for the reason pty-client counts them: ref/unref are not, so with two
     calls in flight the first answer would unref the handles the second is waiting on. */
  hold() { if (this.flights++ === 0) for (const handle of this.idle) handle.ref(); }
  release() { if (--this.flights === 0) for (const handle of this.idle) handle.unref(); }

  call(method, args = []) {
    const id = ++this.sequence;
    const request = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.hold();
    const line = JSON.stringify({ id, method, args }) + '\n';
    if (this.child) this.child.stdin.write(line); else this.socket.write(line);
    return request.finally(() => this.release());
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    /* Ref during the shutdown the way a call refs its flight: awaiting exit on an unref'd child
       would otherwise let the loop drain first. */
    this.hold();
    if (!this.child) {
      /* Closing an attached client leaves the store running: it is the directory's, not this
         host's. A socket that is already gone fires no second 'close'. */
      if (!this.socket.destroyed) await new Promise(resolve => { this.socket.once('close', resolve); this.socket.end(); });
      this.release();
      return;
    }
    this.child.stdin.end();
    await new Promise(resolve => this.child.once('exit', resolve));
    for (const handle of this.idle) handle.unref();
    if (latest === this) latest = null;
  }

  addRoot(directory, declarationFile) { return this.call('addRoot', declarationFile === undefined ? [directory] : [directory, declarationFile]); }
  /* The pure state lookups stay SYNCHRONOUS, answered from the snapshot every answer refreshes
     — exactly the JS store's surface (root/getDraft/listConversations were never IO). */
  root(id) {
    const root = this.state?.roots?.find(item => item.id === id);
    if (!root) fail('Unknown project root.', 404);
    return root;
  }
  resolve(rootId, relative = '', allowMissing = false) {
    return this.call('resolve', [rootId, relative, allowMissing]).then(([absolute, relative]) => ({ absolute, relative }));
  }
  list(rootId, relative = '', hidden = false) { return this.call('list', [rootId, relative, hidden]); }
  readText(rootId, relative) { return this.call('readText', [rootId, relative]); }
  getDraft(rootId, relative) { return this.state?.drafts?.[JSON.stringify([rootId, relative])] ?? null; }
  putDraft(draft) { return this.call('putDraft', [draft]); }
  async discardDraft(rootId, relative) { await this.call('discardDraft', [rootId, relative]); }
  saveText(draft) { return this.call('saveText', [draft]); }
  async saveLayout(layout) { await this.call('saveLayout', [layout]); }
  listConversations(rootId) {
    const all = this.state?.conversations;
    if (!all || typeof all !== 'object' || Array.isArray(all)) return [];
    return (all[rootId] ?? []).map(entry => ({ ...entry }));
  }
  recordConversation(rootId, input) { return this.call('recordConversation', [rootId, input]); }
  preferences(values) { return this.call('preferences', [values]); }
}

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

let scratch = null;
async function statelessCall(method, args) {
  /* The most recently opened store answers when there is one; otherwise one persistent scratch
     service per process, unref'd so it never holds the event loop open at exit — the pipes
     close when the process dies and the scratch reaps itself. (The one-shot spawn-per-call it
     replaced made every declaration's seven-section chain cost seven process starts; the
     earlier persistent-but-referenced version held processes open at exit. resolveInRoot and
     validateSchema were always stateless helpers that happened to live in store.mjs.) */
  if (latest) return latest.call(method, args);
  if (!scratch) {
    scratch = await WorkspaceStore.scratch();
    scratch.child.stdin.unref();
    scratch.child.stdout.unref();
    scratch.child.unref();
  }
  /* A call in flight refs the child (the loop must live to hear the answer); an idle scratch
     stays unref'd (it must not keep the process alive). */
  return scratch.call(method, args);
}

export async function resolveInRoot(root, relative = '', allowMissing = false) {
  const [absolute, resolved] = await statelessCall('resolveInRoot', [root.path, relative, allowMissing]);
  return { absolute, relative: resolved };
}

export async function validateSchema(schema, value, root = schema, at = '$') {
  return statelessCall('validateSchema', [schema, value, root, at]);
}
