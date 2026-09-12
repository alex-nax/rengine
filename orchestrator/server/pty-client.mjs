/* The thin client of the red-pty stdio service (F176, spec 129, KI-096): the PTY core the JS
 * session host delegates to in F178's swap — spawn, input, resize, stop, snapshot — over the
 * same newline-delimited JSON-RPC channel and the same loop-retention discipline the red-store
 * client established (refs at start, flight and close; unref at idle). Events arrive as
 * unsolicited lines and surface as EventEmitter 'event' objects in the JS host's own two
 * shapes: 'output' chunks and 'session' snapshots.
 *
 * The scrollback rides every snapshot as base64 UTF-16LE, decoded here to a JS string — the
 * only representation that holds even a lone surrogate at the OUTPUT_LIMIT slice boundary
 * exactly as the JS host's own string does (spec 060).
 *
 * The binary resolves as $RENGINE_RED_PTY_SERVE, then the repo's debug or release build.
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECKOUT = fileURLToPath(new URL('../../', import.meta.url));
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

function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
const utf16 = base64 => (base64 ? Buffer.from(base64, 'base64').toString('utf16le') : '');

export class PtyHost extends EventEmitter {
  static async open(directory = null, { env = process.env } = {}) {
    const binary = serveBinary();
    const child = spawn(binary, [], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    const host = new PtyHost(child);
    await host.started;
    return host;
  }

  constructor(child) {
    super();
    this.child = child;
    this.pid = child.pid;
    this.sequence = 0;
    this.pending = new Map();
    this.idle = [child, child.stdin, child.stdout];
    this.lines = readline.createInterface({ input: child.stdout });
    this.lines.on('line', line => this.answer(line));
    this.started = new Promise((resolve, reject) => {
      this.onStarted = resolve;
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        const error = new Error(`red-pty-serve exited before it started (${code ?? signal}).`);
        if (this.onStarted) { this.onStarted = null; reject(error); }
        for (const pending of this.pending.values()) pending.reject(new Error(`red-pty-serve exited (${code ?? signal}).`));
      });
    }).finally(() => { for (const handle of this.idle) handle.unref(); });
  }

  answer(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { return; }
    if (message.started) {
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
    this.child.stdin.write(JSON.stringify({ id, method, args }) + '\n');
    return request.finally(() => { for (const handle of flight) handle.unref(); });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const handle of this.idle) handle.ref();
    this.child.stdin.end();
    await new Promise(resolve => this.child.once('exit', resolve));
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
