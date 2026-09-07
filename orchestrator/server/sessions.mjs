import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import path from 'node:path';
import pty from 'node-pty';
import { fail } from './store.mjs';
import { readHandoff, checkResume } from '../agents/handoff.mjs';
import { agentConversation } from '../agents/config.mjs';

const execute = promisify(execFile);
const agentScript = fileURLToPath(new URL('../../scripts/agent.sh', import.meta.url));
const OUTPUT_LIMIT = 1024 * 1024;
/* Plain words beat a timestamp in a pane: the person is choosing between "2 hours ago" and
   "yesterday", not reading a clock. */
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
/* One conversation, one set of eight characters: the pane title, the picker row, the identity label
   and the token segment all show the same prefix, so a person recognises the same thing in each. */
export const agentTitle = (agent, conversation, rootName) =>
  `${agent || 'Choose agent'}${conversation ? ` ${conversation.slice(0, 8)}` : ''} · ${rootName}`;
export function describeAge(when, now = Date.now()) {
  const gap = Math.max(0, now - when);
  if (gap < 2 * MINUTE) return 'just now';
  if (gap < HOUR) return `${Math.round(gap / MINUTE)} minutes ago`;
  if (gap < 2 * HOUR) return 'an hour ago';
  if (gap < DAY) return `${Math.round(gap / HOUR)} hours ago`;
  if (gap < 2 * DAY) return 'yesterday';
  return `${Math.round(gap / DAY)} days ago`;
}

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

async function signalTree(pid, signal) {
  if (process.platform === 'win32') {
    await execute('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  const { stdout } = await execute('ps', ['-axo', 'pid=,ppid='], { maxBuffer: 4 * 1024 * 1024 });
  const pairs = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const descendants = [];
  const visit = parent => {
    for (const [child, ppid] of pairs) if (ppid === parent && child !== parent) { visit(child); descendants.push(child); }
  };
  visit(pid);
  for (const target of [...descendants, pid]) {
    try { process.kill(target, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

export class Sessions extends EventEmitter {
  constructor(store) { super(); this.store = store; this.items = new Map(); this.handoffFlights = new Map(); }

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
  changed(item) { this.emit('event', { type: 'session', session: this.snapshot(item.id) }); }

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
    const root = this.store.root(rootId);
    const workingDirectory = cwd === undefined ? root.path : path.resolve(cwd);
    if (workingDirectory !== root.path && !workingDirectory.startsWith(root.path + path.sep)) fail('The working directory must be inside the project root.');
    const id = randomUUID(); let handoff, gate;
    env = shellEnvironment({ ...env, RENGINE_AGENT_HOME: path.join(this.store.directory, 'agents'),
      RENGINE_HANDOFF_GATE: undefined, RENGINE_HANDOFF_FILE: undefined, RENGINE_ORCHESTRATOR_SESSION: undefined,
      RENGINE_AGENT_CONVERSATION: undefined, RENGINE_AGENT_RESUME: undefined });
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
      argv = [agentScript, '--project', root.path, '--action', action];
      if (agent) argv.push('--agent', agent);
      if (this.workspaceContext) {
        const directory = path.join(this.store.directory, 'integrations');
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
        env = { ...env, RENGINE_WORKSPACE_CONTEXT: filename, RENGINE_NODE: process.execPath, RENGINE_BASH: file };
        // Name the conversation now, for a CLI that accepts being told, so this pane can be put
        // back into the same one later. An agent that names its own is recorded with none.
        if (agentConversation(agent)) {
          conversation = conversation ?? randomUUID();
          env = { ...env, RENGINE_AGENT_CONVERSATION: conversation, ...(resume ? { RENGINE_AGENT_RESUME: '1' } : {}) };
          await this.store.recordConversation(root.id, { conversation, agent });
        }
        // What this project already has, for the pane to offer. Written only when there is
        // something to offer, so a project with no history never prompts.
        const remembered = this.store.listConversations(root.id);
        if (remembered.length) {
          const listing = path.join(directory, `${id}.conversations.tsv`);
          const rows = remembered.filter(entry => entry.id !== conversation)
            .map(entry => `${entry.id}\t${entry.agent ?? ''}\t${describeAge(entry.lastSeenAt)}`);
          if (rows.length) {
            await writeFile(listing, `${rows.join('\n')}\n`, { mode: 0o600 });
            env = { ...env, RENGINE_AGENT_CONVERSATIONS: listing };
          }
        }
        env = { ...env, RENGINE_ORCHESTRATOR_SESSION: id };
      }
      // The launcher's own trailing arguments, which agent.sh forwards to the CLI after `--` and
      // the workspace launcher appends after the MCP wiring it composes. This is how a pane started
      // on a task carries the CLI's model flag and the rendered prompt (spec 103 decision 5);
      // without it those arguments were accepted by this route and silently dropped, so a spawn
      // looked right and ran a CLI with no prompt. Guarded by the taskConversations capability, so
      // a caller can tell a host that forwards them from one that does not.
      if (args?.length) argv.push('--', ...args);
    }
    if (type !== 'agent' || !env.RENGINE_AGENT_CONVERSATION) conversation = undefined;
    if (typeof file !== 'string' || !Array.isArray(argv) || argv.some(arg => typeof arg !== 'string')) fail('Invalid executable or arguments.');
    const child = pty.spawn(file, argv, { name: 'xterm-256color', cols, rows, cwd: workingDirectory,
      env: shellEnvironment({ ...env, RENGINE_AGENT_HOME: path.join(this.store.directory, 'agents') }) });
    const item = { id, rootId, type, handoff, gate, released: false, ...(type === 'agent' ? { agent: agent ?? '', conversation } : {}), ...(type === 'game' ? { surface, game, args: argv } : {}),
      titleAuto: title === undefined,
      title: title ?? (type === 'agent' ? agentTitle(agent, conversation, root.name) : `${type === 'game' ? 'Game' : 'Terminal'} · ${root.name}`),
      pid: child.pid, child, state: 'running', createdAt: Date.now(), cols, rows, output: '', sequence: 0 };
    this.items.set(item.id, item);
    child.onData(data => {
      item.output = (item.output + data).slice(-OUTPUT_LIMIT);
      item.sequence++;
      this.emit('event', { type: 'output', id: item.id, sequence: item.sequence, data });
    });
    child.onExit(({ exitCode, signal }) => {
      item.state = 'exited'; item.exitCode = exitCode; item.signal = signal; item.endedAt = Date.now();
      this.changed(item);
    });
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

  input(id, data) {
    const item = this.get(id);
    if (item.state !== 'running') fail('Session is not running.', 409);
    if (item.gate && !item.released) fail('Handoff is waiting for its native view.', 409);
    if (typeof data !== 'string' || data.length > 1024 * 1024) fail('Invalid terminal input.');
    item.child.write(data);
  }

  resize(id, cols, rows) {
    this.dimensions(cols, rows);
    const item = this.get(id);
    if (item.state !== 'running') return;
    item.child.resize(cols, rows); item.cols = cols; item.rows = rows;
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
      if (item.titleAuto) item.title = agentTitle(item.agent, undefined, this.store.root(item.rootId).name);
      this.changed(item);
      return this.snapshot(id);
    }
    const entry = await this.store.recordConversation(item.rootId, { conversation, agent: agent || item.agent || undefined, task });
    item.conversation = entry.id;
    item.task = entry.task;
    if (item.titleAuto) item.title = agentTitle(item.agent, entry.id, this.store.root(item.rootId).name);
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
      try { await signalTree(item.pid, 'SIGTERM'); }
      catch (error) {
        if (item.state !== 'exited') { item.state = 'running'; this.changed(item); throw error; }
      }
      const deadline = Date.now() + 2000;
      while (item.state !== 'exited' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      if (item.state !== 'exited') await signalTree(item.pid, 'SIGKILL');
      return this.snapshot(id);
    })();
    try { return await item.stopping; }
    finally { delete item.stopping; }
  }

  async shutdown() { await Promise.allSettled([...this.items.values()].filter(item => item.state !== 'exited').map(item => this.stop(item.id))); }
}
