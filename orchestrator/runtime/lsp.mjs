/* The Language Server Protocol client the workspace runs (charter D37, spec 102, F102).
 *
 * It lives in the replaceable worker for the reason everything else does: it needs no PTY, no
 * surface and no store state, only the project root and a declared command. rEngine runs a server
 * the project declares and never installs one, so a machine without it gets a named absence rather
 * than a silent empty list.
 *
 * Only the diagnostic half of the protocol is here. Completion, hover and definition are the
 * editor's features and belong with the editor's own work; diagnostics are what an agent and a
 * person have to agree about.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PRODUCT_NAME } from './product.mjs';

const RESTART_BASE_MS = 500;
const RESTART_CEILING_MS = 30000;
const RESTART_GIVE_UP = 5;
const INITIALIZE_TIMEOUT_MS = 10000;
const TIMED_OUT = Symbol('timed out');

/* The protocol frames every message with a Content-Length header, so a reader that splits on
   newlines works right up until a diagnostic contains one. */
export function framer(onMessage) {
  let buffer = Buffer.alloc(0);
  return chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const header = buffer.indexOf('\r\n\r\n');
      if (header < 0) return;
      const length = Number(/content-length:\s*(\d+)/i.exec(buffer.subarray(0, header).toString('ascii'))?.[1]);
      if (!Number.isInteger(length)) { buffer = buffer.subarray(header + 4); continue; }
      if (buffer.length < header + 4 + length) return;
      const body = buffer.subarray(header + 4, header + 4 + length).toString('utf8');
      buffer = buffer.subarray(header + 4 + length);
      try { onMessage(JSON.parse(body)); } catch { /* a frame we cannot parse is not a reason to stop reading */ }
    }
  };
}

const frame = message => {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
};

export const uriFor = file => pathToFileURL(file).href;

/* One server process, its documents and the diagnostics it has published. */
class Server {
  constructor(declared, root, { spawnImpl = spawn, onDiagnostics = () => {} } = {}) {
    this.declared = declared;
    this.root = root;
    this.spawnImpl = spawnImpl;
    this.onDiagnostics = onDiagnostics;
    this.documents = new Map();          /* uri -> { version, text } */
    this.child = null;
    this.next = 1;
    this.pending = new Map();
    this.failures = 0;
    this.unavailable = null;
    this.starting = null;
  }

  get id() { return this.declared.id; }

  async start() {
    if (this.child) return this;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const [command, ...args] = this.declared.command;
      try {
        this.child = this.spawnImpl(command, args, { cwd: this.root.path, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) { this.unavailable = `${this.id}: ${command} could not be started (${error.message})`; this.starting = null; return this; }
      let diagnostics = '';
      this.child.stderr?.on('data', data => { diagnostics = (diagnostics + data).slice(-4000); });
      this.child.on('error', error => {
        /* ENOENT is the ordinary case: the project declares a server this machine does not have. */
        this.unavailable = error.code === 'ENOENT'
          ? `${this.id}: ${command} is not on this machine; rEngine runs a declared language server but never installs one`
          : `${this.id}: ${command} failed to start (${error.message})`;
        this.child = null;
      });
      this.child.on('exit', code => { this.child = null; this.onExit(code, diagnostics); });
      this.child.stdout.on('data', framer(message => this.receive(message)));
      /* Wait for the spawn to succeed or fail before speaking: a command that is not on the machine
         fails asynchronously, and an initialize sent into it would be a promise nobody ever settles. */
      const spawned = await new Promise(resolve => {
        this.child.once('spawn', () => resolve(true));
        this.child.once('error', () => resolve(false));
      });
      if (!spawned) { this.starting = null; return this; }
      const ready = await this.request('initialize', {
        processId: process.pid,
        clientInfo: { name: PRODUCT_NAME, version: '1.0.0' },   /* what a server's log calls us (spec 108) */
        rootUri: uriFor(this.root.path),
        workspaceFolders: [{ uri: uriFor(this.root.path), name: this.root.name ?? path.basename(this.root.path) }],
        capabilities: { textDocument: { publishDiagnostics: { relatedInformation: false } }, workspace: { workspaceFolders: true } },
        ...(this.declared.initializationOptions ? { initializationOptions: this.declared.initializationOptions } : {}),
      });
      if (ready === TIMED_OUT) {
        this.unavailable = `${this.id}: did not answer initialize within ${INITIALIZE_TIMEOUT_MS} ms`;
        this.starting = null;
        return this;
      }
      this.notify('initialized', {});
      this.unavailable = null;
      this.failures = 0;
      /* Documents survive a restart, so a server that crashed comes back knowing what is open. */
      for (const [uri, document] of this.documents) this.open(uri, document.text, true);
      this.starting = null;
      return this;
    })();
    return this.starting;
  }

  onExit(code, diagnostics) {
    for (const { reject } of this.pending.values()) reject(new Error(`${this.id} exited`));
    this.pending.clear();
    if (this.stopping) return;
    /* Its diagnostics go with it: keeping them would mean reporting a file as broken on the word of
       a process that is no longer running and may have been wrong when it died. */
    for (const uri of this.documents.keys()) this.onDiagnostics(uri, [], this.id);
    this.failures++;
    if (this.failures > RESTART_GIVE_UP) {
      this.unavailable = `${this.id}: exited ${this.failures} times (last code ${code}); not restarted again. ${diagnostics.trim().slice(-200)}`;
      return;
    }
    const wait = Math.min(RESTART_BASE_MS * 2 ** (this.failures - 1), RESTART_CEILING_MS);
    this.unavailable = `${this.id}: exited (code ${code}); restarting in ${wait} ms`;
    this.restart = setTimeout(() => { this.restart = null; void this.start().catch(() => {}); }, wait);
    this.restart.unref?.();
  }

  receive(message) {
    if (message.method === 'textDocument/publishDiagnostics') {
      const { uri, diagnostics } = message.params ?? {};
      if (typeof uri === 'string') this.onDiagnostics(uri, diagnostics ?? [], this.id);
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
      return;
    }
    /* A server request we do not implement still needs an answer, or it waits forever. */
    if (message.id !== undefined && message.method) this.send({ jsonrpc: '2.0', id: message.id, result: null });
  }

  send(message) { if (this.child?.stdin.writable) this.child.stdin.write(frame(message)); }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }
  request(method, params, timeout = INITIALIZE_TIMEOUT_MS) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(TIMED_OUT); }, timeout);
      timer.unref?.();
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); },
                            reject: error => { clearTimeout(timer); reject(error); } });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  open(uri, text, reopening = false) {
    const existing = this.documents.get(uri);
    const version = reopening ? existing?.version ?? 1 : (existing?.version ?? 0) + 1;
    this.documents.set(uri, { version, text });
    if (!existing || reopening) {
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId: this.declared.languageId ?? this.id, version, text } });
    } else {
      this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    }
  }

  close(uri) {
    if (!this.documents.delete(uri)) return;
    this.notify('textDocument/didClose', { textDocument: { uri } });
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.restart);
    if (!this.child) return;
    try { await Promise.race([this.request('shutdown', null), new Promise(resolve => setTimeout(resolve, 2000).unref?.())]); } catch { /* going away regardless */ }
    this.notify('exit', null);
    const child = this.child;
    await new Promise(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000); timer.unref?.(); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    this.child = null;
  }
}

/* Every declared server for one project root, and the diagnostics they have published between them.
   One store with two readers: the editor pane and mcp__ide__getDiagnostics, so a person and an agent
   cannot be told different things about the same file. */
export class LanguageServers {
  constructor(root, declared, options = {}) {
    this.root = root;
    this.options = options;
    this.byId = new Map();
    this.diagnostics = new Map();        /* uri -> [{ from, items }] */
    this.version = 0;
    for (const entry of declared ?? []) {
      this.byId.set(entry.id, new Server(entry, root, { ...options, onDiagnostics: (uri, items, from) => this.record(uri, items, from) }));
    }
  }

  record(uri, items, from) {
    const others = (this.diagnostics.get(uri) ?? []).filter(entry => entry.from !== from);
    this.diagnostics.set(uri, items.length ? [...others, { from, items }] : others);
    /* Bumped on every publish, including one that clears. A reader polls with the version it drew
       and is told "nothing new" rather than being handed the same list to re-render. */
    this.version++;
  }

  serving(file) {
    const relative = path.relative(this.root.path, file);
    return [...this.byId.values()].filter(server => server.declared.match.some(pattern => matches(pattern, relative)));
  }

  /* Ask about a file: the servers that serve it are started and told the text, and whatever they
     have said so far is returned. A caller never waits for a server to have an opinion. */
  async open(file, text) {
    const uri = uriFor(file);
    const servers = this.serving(file);
    await Promise.all(servers.map(async server => {
      await server.start();
      if (server.child) server.open(uri, text);
    }));
    return { uri, servers: servers.map(server => server.id) };
  }

  close(file) {
    const uri = uriFor(file);
    for (const server of this.serving(file)) server.close(uri);
    this.diagnostics.delete(uri);
  }

  for(uri) { return (this.diagnostics.get(uri) ?? []).flatMap(entry => entry.items); }

  unavailable() {
    return [...this.byId.values()].filter(server => server.unavailable).map(server => server.unavailable);
  }

  async stop() { await Promise.all([...this.byId.values()].map(server => server.stop())); }
}

/* The same glob rule the format registry uses, so a project declares patterns one way. */
function matches(pattern, relative) {
  /* The directory wildcard is parked behind a placeholder first. Expanding it to its regular
     expression and only then rewriting every remaining star would rewrite the star inside that
     expansion too, and a pattern reaching into a subdirectory would stop matching a file directly
     inside it — which is exactly how this failed the first time it was written. */
  /* One pass over the pattern, with the directory wildcard matched before the single star it
     contains. Two passes in the wrong order rewrite the expansion the first pass just produced —
     a pattern reaching into a subdirectory then stops matching a file directly inside it, which
     is exactly how this failed when it was first written. */
  const source = pattern.replace(/\*\*\/|\*|\?|[.+^${}()|\\]/g, token =>
    token === '**/' ? '(?:.*/)?' : token === '*' ? '[^/]*' : token === '?' ? '[^/]' : `\\${token}`);
  try { return new RegExp(`^${source}$`, 'i').test(relative.split(path.sep).join('/')); } catch { return false; }
}
