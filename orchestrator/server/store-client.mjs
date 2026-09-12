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
   recently opened store's, matching how those functions were always stateless helpers that
   happened to live in store.mjs. With no store open, the call is refused by name. */
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
    this.started = new Promise((resolve, reject) => {
      this.onStarted = resolve;
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        const error = new Error(`red-store-serve exited before it started (${code ?? signal}).`);
        if (this.onStarted) { this.onStarted = null; reject(error); }
        for (const pending of this.pending.values()) pending.reject(new Error(`red-store-serve exited (${code ?? signal}).`));
      });
    });
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
    this.child.stdin.write(JSON.stringify({ id, method, args }) + '\n');
    return request;
  }

  async close() {
    this.child.stdin.end();
    await new Promise(resolve => this.child.once('exit', resolve));
    if (latest === this) latest = null;
  }

  addRoot(directory, declarationFile) { return this.call('addRoot', declarationFile === undefined ? [directory] : [directory, declarationFile]); }
  root(id) { return this.call('root', [id]); }
  resolve(rootId, relative = '', allowMissing = false) {
    return this.call('resolve', [rootId, relative, allowMissing]).then(([absolute, relative]) => ({ absolute, relative }));
  }
  list(rootId, relative = '', hidden = false) { return this.call('list', [rootId, relative, hidden]); }
  readText(rootId, relative) { return this.call('readText', [rootId, relative]); }
  getDraft(rootId, relative) { return this.call('getDraft', [rootId, relative]); }
  putDraft(draft) { return this.call('putDraft', [draft]); }
  async discardDraft(rootId, relative) { await this.call('discardDraft', [rootId, relative]); }
  saveText(draft) { return this.call('saveText', [draft]); }
  async saveLayout(layout) { await this.call('saveLayout', [layout]); }
  listConversations(rootId) { return this.call('listConversations', [rootId]); }
  recordConversation(rootId, input) { return this.call('recordConversation', [rootId, input]); }
  preferences(values) { return this.call('preferences', [values]); }
}

export async function resolveInRoot(root, relative = '', allowMissing = false) {
  if (!latest) fail('resolveInRoot needs an open red-store service; open a WorkspaceStore first.', 500);
  const [absolute, resolved] = await latest.call('resolveInRoot', [root.path, relative, allowMissing]);
  return { absolute, relative: resolved };
}

export function validateSchema(schema, value) {
  if (!latest) fail('validateSchema needs an open red-store service; open a WorkspaceStore first.', 500);
  return latest.call('validateSchema', [schema, value]);
}
