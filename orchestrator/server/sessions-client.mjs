/* The Sessions class as a thin client over red-pty (F178, F151c; spec 129/131, KI-096). What left
 * this file is every line that owned a process: node-pty, the ps-walking tree kill, the exit
 * watcher, and the pane composition — which was already mirrored byte-for-byte in the red-agents
 * crate (F168) and is now only there. What stayed is what this class is actually for: the pane's
 * identity and metadata — titles, conversations, handoff gates, surfaces, the store records — and
 * the host's external API, which does not change by one field.
 *
 * The scrollback is still accumulated here rather than read back from the service: spec 060's
 * OUTPUT_LIMIT is counted in JavaScript string characters, and a JS string is what does that
 * exactly, lone surrogate at the slice boundary included.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from './store-client.mjs';
import { PtyHost } from './pty-client.mjs';
import { readHandoff, checkResume } from '../agents/handoff.mjs';
import { paneComposition, shortAgentId } from '../agents/agents-client.mjs';

const agentScript = fileURLToPath(new URL('../../scripts/agent.sh', import.meta.url));
const OUTPUT_LIMIT = 1024 * 1024;
/* What belongs to the pane's RECORD rather than to its process (charter D62). The service already
   owned the process's own state — running, pid, cols, the scrollback — and since D62 it owns these
   too, so a second host attached to the same directory reads the same pane rather than its own idea
   of it. `gate` and `released` are here because they decide whether a pane accepts input, which is
   the first thing another host has to get right. */
const RECORD = ['rootId', 'type', 'agent', 'conversation', 'task', 'title', 'titleAuto', 'released',
  'gate', 'handoff', 'surface', 'game', 'args', 'createdAt'];
/* One conversation, one set of eight characters: the pane title, the picker row, the identity label
   and the token segment all show the same prefix, so a person recognises the same thing in each. */
export const agentTitle = (agent, conversation, rootName) =>
  `${agent || 'Choose agent'}${conversation ? ` ${shortAgentId(agent, conversation)}` : ''} · ${rootName}`;

export function shellEnvironment(overrides = {}, { inherited = process.env, platform = process.platform, userDirectory = homedir() } = {}) {
  const win = platform === 'win32';
  const paths = win ? path.win32 : path.posix;
  const key = name => win ? name.toUpperCase() : name;
  const entries = new Map();
  for (const values of [inherited, overrides, { TERM: 'xterm-256color', COLORTERM: 'truecolor' }]) {
    for (const [name, value] of Object.entries(values)) {
      if (typeof value === 'string') entries.set(key(name), [name, value]);
      else entries.delete(key(name));
    }
  }
  entries.delete(key('ELECTRON_RUN_AS_NODE'));
  // TERM/COLORTERM above declare this surface colour-capable; an inherited NO_COLOR would
  // contradict that for every pane the host ever spawns. An explicit override still wins.
  if (!Object.keys(overrides).some(name => key(name) === key('NO_COLOR'))) entries.delete(key('NO_COLOR'));
  const env = Object.fromEntries(entries.values());
  const pathKey = entries.get(key('PATH'))?.[0] ?? (win ? 'Path' : 'PATH');
  const extra = ['.local/bin', '.n/bin', '.opencode/bin', '.cargo/bin'].map(part => paths.join(userDirectory, part));
  const candidates = [...(env[pathKey] === undefined ? [] : env[pathKey].split(paths.delimiter)), ...extra];
  const seen = new Set();
  env[pathKey] = candidates.filter(value => {
    const identity = win ? value.toLowerCase() : value;
    if (seen.has(identity)) return false;
    seen.add(identity); return true;
  }).join(paths.delimiter);
  return env;
}

export function bashPath() {
  if (process.env.RENGINE_BASH) return process.env.RENGINE_BASH;
  if (process.platform !== 'win32') return '/bin/bash';
  const candidates = [
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git/bin/bash.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs/Git/bin/bash.exe'),
  ];
  const bash = candidates.find(existsSync);
  if (!bash) fail('Agent launcher requires Git Bash on Windows. Install Git for Windows or set RENGINE_BASH.');
  return bash;
}

export class Sessions extends EventEmitter {
  constructor(store, { stateDir = null } = {}) {
    super();
    this.store = store; this.items = new Map(); this.handoffFlights = new Map();
    /* Where the PTYs live when they are meant to outlive this host (charter D60, F179): a state
       directory names a service every host of that directory attaches to. Without one this host
       owns its PTYs the way it always did, which is what a test that starts a host in-process
       wants — and what it gets, because it passes none. */
    this.stateDir = stateDir;
    /* Events that arrived before the item they belong to existed. The service starts the output
       pump and the exit watcher the instant it spawns, so for a short-lived child — `sh -c "exit 0"`
       is the case that found this — the exit event can beat the spawn response back here. Dropping
       it leaves a session that ran, ended, and stays "running" in the host's view forever. */
    this.early = new Map();
  }

  /* One service per host, opened on the first spawn and never before: a Sessions that only ever
     lists is a Sessions that starts no process. Its events arrive by session id and are routed to
     the item that owns them — the two shapes the host's own listeners already expect. */
  async pty() {
    if (!this.ptyFlight) {
      this.ptyFlight = (this.stateDir ? PtyHost.attach(this.stateDir) : PtyHost.open()).then(host => {
        host.on('event', event => this.received(event));
        return host;
      });
    }
    return this.ptyFlight;
  }

  /* Adopt what the state directory's service is already holding. A session whose record this host
     cannot read is left alone rather than guessed at: it belongs to a host that knew more than
     this one does, and stopping it would end an agent's work to tidy a list (D60, F179). */
  async adopt() {
    if (!this.stateDir) return [];
    const host = await this.pty();
    const adopted = [];
    for (const session of host.adopted ?? []) {
      if (this.items.has(session.id)) continue;
      const meta = session.meta && typeof session.meta === 'object' ? session.meta : null;
      if (!meta?.rootId || session.state !== 'running') continue;
      const item = { ...meta, id: session.id, pid: session.pid, state: session.state,
        cols: session.cols, rows: session.rows, sequence: session.sequence, output: session.output ?? '',
        exitCode: session.exitCode ?? undefined, signal: session.signal ?? undefined };
      this.items.set(item.id, item);
      /* A pane whose host was replaced is released by the host that adopts it: the gate file
         belonged to that launch and the native view it was waiting for went with the host. The
         record used to produce this implicitly by always saying `released: true` at spawn; with a
         live record (D62) it is a decision this host makes, and writes down. */
      if (item.gate && !item.released) { item.released = true; this.record(item); }
      adopted.push(this.snapshot(item.id));
    }
    return adopted;
  }

  received(event) {
    const owner = event.type === 'output' ? event.id : event.session?.id;
    if (owner && !this.items.has(owner)) {
      const waiting = this.early.get(owner) ?? [];
      /* A cap, because an id this host will never register is a leak otherwise. A pane's opening
         output is what matters here, and it is far below this. */
      if (waiting.length < 256) waiting.push(event);
      this.early.set(owner, waiting);
      return;
    }
    if (event.type === 'output') {
      const item = this.items.get(event.id);
      if (!item) return;
      item.output = (item.output + event.data).slice(-OUTPUT_LIMIT);
      item.sequence = event.sequence;
      this.emit('event', { type: 'output', id: item.id, sequence: item.sequence, data: event.data });
      return;
    }
    if (event.type === 'session') { this.described(event.session); this.exited(event.session); }
  }

  /* The service's own snapshot says how a child ended; the pane's record says everything else. */
  exited(snapshot) {
    const item = this.items.get(snapshot?.id);
    if (!item || snapshot.state !== 'exited' || item.state === 'exited') return;
    item.state = 'exited'; item.exitCode = snapshot.exitCode ?? null; item.signal = snapshot.signal ?? null;
    /* The service's clock, not this host's arrival: two hosts watching one pane die must not
       report two different endings (D62). A service that does not say still leaves an answer. */
    item.endedAt = snapshot.endedAt ?? Date.now();
    this.changed(item);
  }

  get(id) {
    const item = this.items.get(id);
    if (!item) fail('Unknown session.', 404);
    return item;
  }

  snapshot(id, includeOutput = false) {
    const { id: sessionId, rootId, type, agent, conversation, task, handoff, released, title, surface, game, args, pid, state, exitCode, signal, createdAt, endedAt, cols, rows, sequence, output } = this.get(id);
    return { id: sessionId, rootId, type, agent, title, pid, state, exitCode, signal, createdAt, endedAt, cols, rows, sequence,
      ...(conversation ? { conversation } : {}),
      ...(task ? { task } : {}),
      ...(type === 'game' ? { surface, game, args: args ?? [] } : {}),
      ...(handoff ? { handoff: { sessionId: handoff.sessionId, checkpoint: handoff.checkpoint }, waitingForView: !released } : {}),
      ...(includeOutput ? { output } : {}) };
  }

  list() { return [...this.items.keys()].map(id => this.snapshot(id)); }

  /* Two halves of what used to be one line. `changed` is this host learning something new about a
     pane, so the record goes to the service that owns it; `announce` is telling this host's own
     clients, which is also all a host does when it is applying somebody else's change. */
  changed(item) { this.record(item); this.announce(item); }
  announce(item) { this.emit('event', { type: 'session', session: this.snapshot(item.id) }); }

  record(item) {
    if (!this.stateDir || this.closed) return;
    const patch = {};
    for (const name of RECORD) patch[name] = item[name] === undefined ? null : item[name];
    return this.deliver(host => host.describe(item.id, patch));
  }

  /* Somebody else's change to a pane this host also holds. Applied, never written back — the
     service broadcasts to every attached host including the one that asked, and a host that
     answered a broadcast with a write would be two hosts talking past each other forever. */
  described(snapshot) {
    const item = this.items.get(snapshot?.id);
    const record = snapshot?.meta;
    if (!item || !record || typeof record !== 'object') return;
    let differs = false;
    /* The pane's own dimensions belong to the service, not to the host that last set them: a
       resize through another host changes the terminal this host is drawing, and a host that kept
       its own numbers would describe the pane at the wrong size. The scrollback and its sequence
       are NOT taken from here — this host accumulates those from the output stream, and an event
       carries neither. */
    for (const name of ['cols', 'rows', 'pid']) {
      if (!Number.isInteger(snapshot[name]) || item[name] === snapshot[name]) continue;
      item[name] = snapshot[name]; differs = true;
    }
    for (const name of RECORD) {
      const value = record[name] === null || record[name] === undefined ? undefined : record[name];
      if (JSON.stringify(item[name] ?? null) === JSON.stringify(value ?? null)) continue;
      item[name] = value; differs = true;
    }
    if (differs) this.announce(item);
  }

  async terminal(options) {
    if (!options.handoffFile) return this.spawnTerminal(options);
    const key = options.rootId;
    const flight = (this.handoffFlights.get(key) ?? Promise.resolve()).catch(() => {}).then(() => this.spawnTerminal(options));
    this.handoffFlights.set(key, flight);
    try { return await flight; }
    finally { if (this.handoffFlights.get(key) === flight) this.handoffFlights.delete(key); }
  }

  async spawnTerminal({ rootId, type = 'terminal', agent, conversation, resume = false, action = 'launch', command, args, handoffFile, cols = 100, rows = 30, env = {}, title, surface, game, cwd }) {
    if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 200)) fail('Session title must be a short string.');
    const root = await this.store.root(rootId);
    const workingDirectory = cwd === undefined ? root.path : path.resolve(cwd);
    if (workingDirectory !== root.path && !workingDirectory.startsWith(root.path + path.sep)) fail('The working directory must be inside the project root.');
    const id = randomUUID(); let handoff, gate;
    /* What this launch composes for itself and must never inherit, cleared in BOTH compositions below.
       See sidecar: environment-cleared-in-both-compositions. */
    const cleared = { RENGINE_HANDOFF_GATE: undefined, RENGINE_HANDOFF_FILE: undefined, RENGINE_ORCHESTRATOR_SESSION: undefined,
      RENGINE_AGENT_CONVERSATION: undefined, RENGINE_AGENT_RESUME: undefined, RENGINE_AGENT_CONVERSATIONS: undefined };
    env = shellEnvironment({ ...env, RENGINE_AGENT_HOME: path.join(this.store.directory, 'agents'), ...cleared });
    if (handoffFile) {
      if (type !== 'agent' || agent !== 'codex' || action !== 'launch' || args?.length || !this.workspaceContext) fail('Handoff requires the Codex workspace launcher.');
      handoff = await readHandoff(handoffFile, root.path, env);
      const existing = [...this.items.values()].find(item => item.rootId === rootId && item.state === 'running' && item.handoff?.sessionId === handoff.sessionId);
      if (existing) return this.snapshot(existing.id);
      await checkResume(bashPath(), root.path, env);
      gate = path.join(this.store.directory, 'integrations', `${id}.ready`);
      env = { ...env, RENGINE_HANDOFF_GATE: gate, RENGINE_HANDOFF_FILE: handoff.filename, RENGINE_ORCHESTRATOR_SESSION: id };
    }
    if (!['terminal', 'agent', 'game'].includes(type)) fail('Unsupported terminal type.');
    this.dimensions(cols, rows);
    let file = command ?? (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL ?? '/bin/bash');
    let argv = args ?? (process.platform === 'win32' ? ['-NoLogo'] : ['-l']);
    if (type === 'agent') {
      file = bashPath();
      const directory = path.join(this.store.directory, 'integrations');
      if (this.workspaceContext) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (handoff) {
          const snapshot = path.join(directory, `${id}.handoff.json`);
          await writeFile(snapshot, JSON.stringify({ version: 1, project: root.path, sessionId: handoff.sessionId, checkpoint: handoff.checkpoint }), { mode: 0o600 });
          env.RENGINE_HANDOFF_FILE = snapshot;
        }
        const filename = path.join(directory, `${root.id}.json`);
        const temporary = `${filename}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify({ ...this.workspaceContext, rootId: root.id }), { mode: 0o600 });
        await rename(temporary, filename);
      }
      const plan = await paneComposition({ id, agent, conversation, resume, action, args,
        workspace: Boolean(this.workspaceContext),
        /* The store read is skipped for a decided pane, exactly as before the extraction; the
           composition applies the same gate internally, which the parity fixtures exercise. */
        remembered: (conversation !== undefined || Boolean(args?.length)) ? [] : await this.store.listConversations(root.id),
        paths: { agentScript, rootPath: root.path, workspaceContextFile: path.join(directory, `${root.id}.json`),
          listingFile: path.join(directory, `${id}.conversations.tsv`), node: process.execPath, bash: file } });
      if (plan.refuse) fail(plan.refuse);
      if (plan.record) await this.store.recordConversation(root.id, plan.record);
      if (plan.listing) await writeFile(plan.listing.file, plan.listing.content, { mode: 0o600 });
      argv = plan.argv;
      conversation = plan.conversation;
      env = { ...env, ...plan.sets };
    }
    if (type !== 'agent') conversation = undefined;
    if (typeof file !== 'string' || !Array.isArray(argv) || argv.some(arg => typeof arg !== 'string')) fail('Invalid executable or arguments.');
    /* Everything this host knows about the pane that its process does not say — and since charter
       D62 the service holds it, so another host attached to this directory reads the same pane
       rather than its own idea of it. The gate is part of it now: a pane waiting for its native
       view refuses input, and a host that could not see the gate would let it through. */
    const record = { rootId, type, ...(type === 'agent' ? { agent: agent ?? '', conversation } : {}),
      ...(type === 'game' ? { surface, game, args: argv } : {}),
      ...(handoff ? { handoff } : {}), ...(gate ? { gate } : {}), released: !gate,
      titleAuto: title === undefined,
      title: title ?? (type === 'agent' ? agentTitle(agent, conversation, root.name) : `${type === 'game' ? 'Game' : 'Terminal'} · ${root.name}`),
      createdAt: Date.now() };
    const started = await (await this.pty()).spawn({ id, meta: record, command: file, args: argv, cols, rows, cwd: workingDirectory,
      // `cleared` first, so this launch's own values win and only what it left out stays deleted.
      env: shellEnvironment({ ...cleared, ...env, RENGINE_AGENT_HOME: path.join(this.store.directory, 'agents') }) });
    const item = { ...record, id, gate, released: !gate,
      pid: started.pid, state: 'running', cols, rows, output: '', sequence: 0 };
    this.items.set(item.id, item);
    /* In arrival order, before anything else touches this session: the queue is drained here so a
       child that exited during the spawn round trip is seen exiting rather than never. */
    for (const waiting of this.early.get(item.id) ?? []) this.received(waiting);
    this.early.delete(item.id);
    this.changed(item);
    return this.snapshot(item.id);
  }

  dimensions(cols, rows) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 1 || rows > 300) fail('Invalid terminal dimensions.');
  }

  async presented(id) {
    const item = this.get(id);
    if (!item.gate || item.released || item.state !== 'running') return;
    await writeFile(item.gate, '', { mode: 0o600 });
    item.released = true; this.changed(item);
  }

  /* Refusals stay synchronous, because the host answers /api/input from a synchronous throw and
     `assert.throws` is the whole of what "invalid input" means to a caller. Only the delivery is a
     promise, and deliveries queue in call order behind the one host promise. */
  input(id, data) {
    const item = this.get(id);
    if (item.state !== 'running') fail('Session is not running.', 409);
    if (item.gate && !item.released) fail('Handoff is waiting for its native view.', 409);
    if (typeof data !== 'string' || data.length > 1024 * 1024) fail('Invalid terminal input.');
    return this.deliver(host => host.input(item.id, data));
  }

  /* A caller that awaits sees the failure; one that does not (the host's own routes, which have
     already answered) does not take the process down with an unhandled rejection. */
  deliver(work) {
    const flight = this.pty().then(work);
    flight.catch(() => {});
    return flight;
  }

  resize(id, cols, rows) {
    this.dimensions(cols, rows);
    const item = this.get(id);
    if (item.state !== 'running') return;
    item.cols = cols; item.rows = rows;
    return this.deliver(host => host.resize(item.id, cols, rows));
  }

  // The pane reports what it actually launched: the workspace may have minted a conversation, the
  // person at the pane may have chosen a different one from the offered list, and their own
  // --resume beats both. `null` says this launch continues or forks a conversation the CLI names
  // itself, so the record must claim nothing rather than keep an id that would resume the wrong one.
  // `task` (spec 103 decision 6) is the key of the task this conversation was started on. It joins
  // the two systems and nothing else: it never selects, resumes or retargets anything.
  async recordConversation(id, conversation, agent, task) {
    const item = this.get(id);
    if (item.type !== 'agent') fail('Only an agent session holds a conversation.');
    if (agent && !item.agent) item.agent = agent;
    if (conversation === null) {
      item.conversation = undefined;
      if (item.titleAuto) item.title = agentTitle(item.agent, undefined, (await this.store.root(item.rootId)).name);
      this.changed(item);
      return this.snapshot(id);
    }
    const entry = await this.store.recordConversation(item.rootId, { conversation, agent: agent || item.agent || undefined, task });
    item.conversation = entry.id;
    item.task = entry.task;
    if (item.titleAuto) item.title = agentTitle(item.agent, entry.id, (await this.store.root(item.rootId)).name);
    this.changed(item);
    return this.snapshot(id);
  }

  // Replace an agent pane with a new one on the same conversation and a freshly composed
  // environment. The host keeps running; only this child is replaced.
  async restartAgent(id) {
    const item = this.get(id);
    if (item.type !== 'agent') fail('Only an agent session can be restarted into its conversation.');
    if (!item.conversation) fail(`This ${item.agent || 'agent'} pane has no conversation rEngine can resume; stop it and start a new one.`);
    const { rootId, agent, conversation, cols, rows } = item;
    await this.stop(id);
    return this.spawnTerminal({ rootId, type: 'agent', agent, conversation, resume: true, cols, rows });
  }

  async stop(id) {
    const item = this.get(id);
    if (item.state === 'exited') return this.snapshot(id);
    if (item.stopping) return item.stopping;
    item.state = 'stopping'; this.changed(item);
    item.stopping = (async () => {
      let ended;
      try { ended = await (await this.pty()).stop(item.id); }
      catch (error) {
        if (item.state !== 'exited') { item.state = 'running'; this.changed(item); throw error; }
      }
      /* The service answers once the child is gone, and its answer may beat its own exit event
         here; applying it makes the two orders indistinguishable to a caller. */
      if (ended) this.exited(ended);
      return this.snapshot(id);
    })();
    try { return await item.stopping; }
    finally { delete item.stopping; }
  }

  /* `retain` is what a host being replaced asks for: the sessions belong to the state directory,
     so they stay and the next host adopts them (D60). Without it — a test, or a workspace being
     shut down for good — this host ends what it started, exactly as it always did. */
  async shutdown({ retain = false } = {}) {
    this.closed = true;
    if (!retain) await Promise.allSettled([...this.items.values()].filter(item => item.state !== 'exited').map(item => this.stop(item.id)));
    /* Closing the client never ends a session: a stdio service dies with this process anyway, and
       a state directory's service is not this host's to end. */
    if (this.ptyFlight) { const host = await this.ptyFlight; this.ptyFlight = null; await host.close(); }
  }
}
