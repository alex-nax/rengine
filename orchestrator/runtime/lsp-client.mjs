/* The thin client of `red-lsp-serve` (F161, charter D37, spec 102).
 *
 * The diagnostic half of the Language Server Protocol is `red/red-lsp/` now, judged against the
 * answers `runtime/lsp.mjs` used to give (`orchestrator/tests/lsp-corpus.json`). Completion, hover
 * and definition are still nowhere: they are the editor's features and belong with the editor's own
 * work. Diagnostics are what an agent and a person have to agree about, because the editor pane and
 * `mcp__ide__getDiagnostics` read one store.
 *
 * One process per project root, spawned here and dying with this one — which is what the JavaScript
 * did, because a language server belongs to the worker that started it. Not a service of a state
 * directory: a replaced worker should start its own, exactly as it always did.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CHECKOUT = fileURLToPath(new URL('../../', import.meta.url));
export const uriFor = file => pathToFileURL(file).href;

function serveBinary() {
  const declared = process.env.RENGINE_RED_LSP_SERVE;
  if (declared) {
    if (existsSync(declared)) return declared;
    throw new Error(`RENGINE_RED_LSP_SERVE names ${declared}, which does not exist.`);
  }
  for (const profile of ['debug', 'release']) {
    const candidate = path.join(CHECKOUT, 'red/target', profile, 'red-lsp-serve');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('The red-lsp-serve binary is required (run: cargo build -p red-lsp, or set RENGINE_RED_LSP_SERVE).');
}

export class LanguageServers {
  constructor(root, declared, options = {}) {
    this.root = root;
    this.pending = new Map();
    this.sequence = 0;
    /* The last version this client saw, so `version` stays a synchronous read: the worker builds a
       response around it and a round trip there would be a round trip per poll. Every answer that
       carries one updates it. */
    this.version = 0;
    this.child = spawn(options.binary ?? serveBinary(), [root.path], { stdio: ['pipe', 'pipe', 'inherit'] });
    /* Loop-neutral once started, the discipline `store-client` established: a client nobody is
       calling must not hold the process open, and a call in flight must not have its handles
       unref'd by another call's answer — so the refs are COUNTED. */
    this.flights = 0;
    this.idle = [this.child, this.child.stdin, this.child.stdout];
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on('line', line => this.answer(line));
    this.started = new Promise(resolve => { this.onStarted = resolve; });
    this.child.once('exit', () => {
      for (const waiting of this.pending.values()) waiting.reject(new Error('the language server client exited.'));
      this.pending.clear();
      this.onStarted?.();
    });
    /* Held from construction until the declaration has landed, released through the same count as
       every call — an unconditional unref here would let a `declare` already in flight lose the
       handles it is waiting on. */
    this.hold();
    this.declared = this.started.then(() => this.call('declare', [declared ?? []])).finally(() => this.release());
  }

  answer(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.started) { const resolve = this.onStarted; this.onStarted = null; resolve?.(); return; }
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    this.pending.delete(message.id);
    message.error ? waiting.reject(new Error(message.error.message)) : waiting.resolve(message.result);
  }

  hold() { if (this.flights++ === 0) for (const handle of this.idle) handle.ref?.(); }
  release() { if (--this.flights === 0) for (const handle of this.idle) handle.unref?.(); }

  call(method, args = []) {
    const id = ++this.sequence;
    const answer = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.hold();
    this.child.stdin.write(`${JSON.stringify({ id, method, args })}\n`);
    return answer.finally(() => this.release());
  }

  /* Ask about a file: the servers that serve it are started and told the text, and whatever they
     have said so far is returned. A caller never waits for a server to have an opinion. */
  async open(file, text) {
    await this.declared;
    return this.call('open', [file, text]);
  }

  async close(file) {
    await this.declared;
    return this.call('close', [file]);
  }

  /* The diagnostics route's whole answer in one call: the version a caller polls with, the items
     for the file it asked about, and every named absence. */
  async diagnostics(uri) {
    await this.declared;
    const answer = await this.call('diagnostics', [uri]);
    this.version = answer.version;
    return answer;
  }

  async for(uri) { return (await this.diagnostics(uri)).items; }
  async unavailable() { await this.declared; return this.call('unavailable'); }

  async stop() {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      /* Ref through the shutdown the way a call refs its flight: awaiting the exit of an unref'd
         child lets the loop drain first, and the await never settles. store-client.close() guards
         the same thing for the same reason. */
      this.hold();
      try { await this.declared; await this.call('stop'); } catch { /* going away regardless */ }
      this.child.stdin.end();
      await new Promise(resolve => { const timer = setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 4000); timer.unref?.(); this.child.once('exit', () => { clearTimeout(timer); resolve(); }); });
      this.lines.close();
      this.release();
    })();
    return this.stopping;
  }
}
