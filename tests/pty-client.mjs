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
 * `attach` is `ensureSidecar`'s discipline applied to `pty.json` — read the descriptor, refuse
 * anything but loopback with a 64-hex token, connect, and only start a service under a
 * `pty-startup.lock` whose stale owner is reaped by PID — and it lives in
 * `runtime/service-client.mjs` now, because the store and the token ledger want exactly the same
 * thing. A descriptor that names another protocol is not adopted and not stranded: the service is
 * ended by name and a new one starts, which is exactly what a host replacement does today.
 *
 * The scrollback rides every snapshot as base64 UTF-16LE, decoded here to a JS string — the
 * only representation that holds even a lone surrogate at the OUTPUT_LIMIT slice boundary
 * exactly as the JS host's own string does (spec 060).
 *
 * The binary resolves as $RENGINE_RED_PTY_SERVE, then the repo's debug or release build.
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { findOrStart, serveBinary as resolveBinary } from './service-client.mjs';

/* The wire red-pty-serve speaks. A service answering another number is ended, never adopted.
   2 since charter D62: the pane record is the service's and is changed through `describe`, which a
   protocol-1 service does not have. */
export const PTY_PROTOCOL = 2;
/* Finding that service — descriptor, protocol handshake, startup lock, spawn — is
   `runtime/service-client.mjs`'s discipline, shared with the store and the token ledger rather than
   kept in three copies that could check the token three ways (charter D60/D61). */
const SERVICE = { name: 'pty', protocol: PTY_PROTOCOL, variable: 'RENGINE_RED_PTY_SERVE', basename: 'red-pty-serve' };
const serveBinary = () => resolveBinary(SERVICE.variable, SERVICE.basename);

const utf16 = base64 => (base64 ? Buffer.from(base64, 'base64').toString('utf16le') : '');

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
    const found = await findOrStart(directory, { ...SERVICE, env });
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
    this.flights = 0;
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

  /* Refs are COUNTED, because ref/unref are not. Two calls in flight and the first one's answer
     would otherwise unref the handles the second is waiting on — and a client whose handles are
     unref'd while it waits is a process that exits mid-request. Node's test runner reports that as
     "Promise resolution is still pending but the event loop has already resolved", which names the
     symptom and not the cause. */
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

  /** Closing a stdio host ends its sessions; closing an attached one leaves them running. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.hold();
    try { await this.closing(); } finally { this.release(); }
  }

  async closing() {
    if (this.child) {
      /* A child that has already exited fires no second 'exit', and waiting for one is a hang with
         nothing left to wake it — the same shape as the socket case below. */
      if (this.child.exitCode !== null || this.child.signalCode !== null) return;
      this.child.stdin.end();
      await new Promise(resolve => this.child.once('exit', resolve));
    } else if (!this.socket.destroyed) {
      /* A host whose service died still closes: the socket may already be gone, and waiting for
         a 'close' that has already fired is a hang with nothing left to wake it. */
      await new Promise(resolve => { this.socket.once('close', resolve); this.socket.end(); });
    }
  }

  spawn(options) {
    return this.call('spawn', [{ ...(options.id ? { id: options.id } : {}), command: options.command, args: options.args ?? [], env: options.env ?? {}, cwd: options.cwd ?? '/', cols: options.cols ?? 100, rows: options.rows ?? 30,
      /* The host's own record of the pane, carried so the next host can name what it adopts. */
      ...(options.meta === undefined ? {} : { meta: options.meta }) }])
      .then(snapshot => ({ ...snapshot, output: utf16(snapshot.output) }));
  }
  /* The pane's record, changed where it lives (charter D62). A `null` field removes it: a pane that
     cannot forget a conversation would offer to resume the wrong one. */
  describe(id, patch) { return this.call('describe', [id, patch]); }
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
