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

  constructor(directory, child) {
    this.directory = directory;
    this.filename = path.join(directory, 'workspace.json');
    this.state = null;
    this.child = child;
    this.pid = child.pid;
    this.sequence = 0;
    this.pending = new Map();
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
    this.child.stdin.write(JSON.stringify({ id, method, args }) + '\n');
    return request.finally(() => { for (const handle of flight) handle.unref(); });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    /* Ref during the shutdown the way a call refs its flight: awaiting exit on an unref'd child
       would otherwise let the loop drain first. */
    for (const handle of this.idle) handle.ref();
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
