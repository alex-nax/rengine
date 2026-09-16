/* Red as a Claude Code IDE (spec 102, spec 133): the thin client of `red-ide serve`.
 *
 * Claude Code finds an editor by reading `<config>/ide/<port>.lock` and connecting to the port its
 * filename names. The lock, the startup sweep, the socket and the MCP it speaks are `red/red-ide/`
 * now, judged against the answers this module used to give (`tests/ide-corpus.json`).
 * This spawns one `red-ide serve` per bridge — one per worker, dying when this process does, which
 * is what the JavaScript's socket did — and keeps `startIdeBridge`'s shape over it.
 *
 * Two things cross the pipe the other way: the retake's outcome, as an event that settles `ready`,
 * and `getDiagnostics`, which the bridge asks THIS process to answer, because the language servers
 * are the worker's (spec 133 D3). Every call is awaited, `selection` and `mention` included (D4).
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { PRODUCT_NAME } from './product.mjs';

/* What other people see in their `/ide` menu, beside VS Code and Cursor. It is the product's own
   name, declared once and generated (charter D41, spec 108), so a rename is a data edit — and
   `red_ide::discovery` compares a lock's ideName against the same declaration's Rust target. */
export const IDE_NAME = PRODUCT_NAME;

const CHECKOUT = fileURLToPath(new URL('../', import.meta.url));

/** $RENGINE_RED_IDE, then the repo's debug or release build; a missing binary is named. */
export function ideBinary() {
  const declared = process.env.RENGINE_RED_IDE;
  if (declared) {
    if (existsSync(declared)) return declared;
    throw new Error(`RENGINE_RED_IDE names ${declared}, which does not exist.`);
  }
  for (const profile of ['debug', 'release']) {
    const candidate = path.join(CHECKOUT, 'red/target', profile, 'red-ide');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('The red-ide binary is required (run: cargo build -p red-ide, or set RENGINE_RED_IDE).');
}

/* The CLI reads one path, `~/.claude/ide`, moved by CLAUDE_CONFIG_DIR as Anthropic documents;
   rEngine's own RENGINE_IDE_DIRECTORY still wins, because a test that publishes into the
   developer's own `/ide` menu is a test with a side effect on the person running it. The rule is
   `red_ide::lock::directory`, asked with this process's environment — synchronously, because two
   callers read it as a default. */
export const ideDirectory = () => JSON.parse(execFileSync(ideBinary(), ['directory'], { encoding: 'utf8' }));

/** A one-shot answer from the binary. A refusal arrives as `{error, status}` and is thrown. */
export function ask(subcommand, input = null, args = []) {
  return new Promise((resolve, reject) => {
    const child = execFile(ideBinary(), [subcommand, ...args], { maxBuffer: 1 << 24 }, (failure, stdout) => {
      let value;
      try { value = JSON.parse(stdout); }
      catch { reject(new Error(`red-ide ${subcommand} answered nothing: ${failure?.message ?? stdout}`)); return; }
      if (value && typeof value === 'object' && !Array.isArray(value) && value.error !== undefined && 'status' in value) {
        const error = new Error(value.error);
        if (value.status !== null && value.status !== undefined) error.status = value.status;
        reject(error);
        return;
      }
      resolve(value);
    });
    child.stdin.end(input === null ? '' : JSON.stringify(input));
  });
}

/** The startup sweep, on its own: locks marked `rengineWorker` whose worker is gone. */
export const sweep = directory => ask('sweep', null, [directory]);

/* One `red-ide serve`: requests down, answers up, plus the two things that come up unprompted. */
class IdeService {
  constructor(diagnosticsFor) {
    this.child = spawn(ideBinary(), ['serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.pending = new Map();
    this.sequence = 0;
    this.events = [];
    this.eventWaiters = [];
    /* Loop-neutral at rest, the discipline `store-client` established: the refs are COUNTED, so a
       call in flight — or an ask being answered — is always heard, and a bridge nobody is calling
       does not hold the process open. */
    this.flights = 0;
    this.idle = [this.child, this.child.stdin, this.child.stdout];
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on('line', line => this.answer(line, diagnosticsFor));
    this.started = new Promise((resolve, reject) => {
      this.onStarted = resolve;
      this.child.once('error', reject);
      this.child.once('exit', (code, signal) => {
        const error = new Error(`red-ide serve exited (${code ?? signal}).`);
        if (this.onStarted) { this.onStarted = null; reject(error); }
        for (const waiting of this.pending.values()) waiting.reject(error);
        this.pending.clear();
      });
    });
    this.hold();
    this.started.finally(() => this.release()).catch(() => {});
  }

  answer(line, diagnosticsFor) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.started) { const resolve = this.onStarted; this.onStarted = null; resolve?.(); return; }
    if (message.ask !== undefined) {
      /* The bridge asking for diagnostics, answered from the source this worker holds. */
      this.hold();
      Promise.resolve().then(() => diagnosticsFor?.(...(message.args ?? [])))
        .then(result => this.write({ answer: message.ask, result }), error => this.write({ answer: message.ask, error: { message: error.message } }))
        .finally(() => this.release());
      return;
    }
    if (message.event) { const waiter = this.eventWaiters.shift(); waiter ? waiter(message) : this.events.push(message); return; }
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    this.pending.delete(message.id);
    message.error ? waiting.reject(new Error(message.error.message)) : waiting.resolve(message.result);
  }

  write(value) { if (!this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify(value)}\n`); }
  hold() { if (this.flights++ === 0) for (const handle of this.idle) handle.ref?.(); }
  release() { if (--this.flights === 0) for (const handle of this.idle) handle.unref?.(); }

  call(method, args = []) {
    const id = ++this.sequence;
    const answer = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.hold();
    this.write({ id, method, args });
    return answer.finally(() => this.release());
  }

  /* Held while waited on: a retake settling with nobody else keeping the loop alive would settle
     into a process that had already exited. */
  nextEvent() {
    this.hold();
    return new Promise(resolve => { this.events.length ? resolve(this.events.shift()) : this.eventWaiters.push(resolve); })
      .finally(() => this.release());
  }

  async end() {
    if (this.ending) return this.ending;
    this.ending = (async () => {
      this.hold();
      try { await this.started; await this.call('close'); } catch { /* going away regardless */ }
      this.child.stdin.end();
      await new Promise(resolve => {
        if (this.child.exitCode !== null || this.child.signalCode !== null) { resolve(); return; }
        const timer = setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 4000);
        timer.unref?.();
        this.child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      this.lines.close();
      this.release();
    })();
    return this.ending;
  }
}

/* `startIdeBridge`'s shape, kept: `published`, `port`, `lock`, `authToken`, `reason` and `ready`
   as before; `clients()`, `observed()`, `selection()` and `mention()` awaited (spec 133 D4). */
export async function startIdeBridge({ roots = [], hostPid, workerPid = process.pid, port = 0, directory, host = '127.0.0.1',
  retakeTimeoutMs, diagnosticsFor = null } = {}) {
  const service = new IdeService(diagnosticsFor);
  await service.started;
  let answer;
  try {
    answer = await service.call('start', [{ roots, hostPid, workerPid, port, directory, host, retakeTimeoutMs,
      diagnostics: typeof diagnosticsFor === 'function' }]);
  } catch (error) {
    await service.end();
    throw error;
  }
  const bridge = {
    published: answer.published, authToken: answer.authToken ?? undefined, port: answer.port, lock: answer.lock, reason: answer.reason,
    ready: null,
    clients: () => service.call('clients'),
    observed: () => service.call('observed'),
    /* A selection is a fact about the editor; naming it `selection_changed` is the bridge's business,
       and `at_mentioned` carries the file and a line range, the CLI's own schema. */
    selection: value => service.call('selection', [value]),
    mention: value => service.call('mention', [value]),
    close: () => service.end(),
  };
  if (answer.published) bridge.ready = Promise.resolve(true);
  else if (/still held/.test(answer.reason ?? '')) {
    bridge.ready = service.nextEvent().then(event => {
      if (event.event === 'published') { bridge.published = true; bridge.port = event.port; bridge.lock = event.lock; bridge.reason = null; return true; }
      bridge.reason = event.reason;
      return false;
    });
  } else bridge.ready = Promise.resolve(false);
  return bridge;
}
