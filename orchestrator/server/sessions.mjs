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

const execute = promisify(execFile);
const agentScript = fileURLToPath(new URL('../../scripts/agent.sh', import.meta.url));
const OUTPUT_LIMIT = 1024 * 1024;

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
    const { id: sessionId, rootId, type, agent, handoff, released, title, surface, game, pid, state, exitCode, signal, createdAt, endedAt, cols, rows, sequence, output } = this.get(id);
    return { id: sessionId, rootId, type, agent, title, pid, state, exitCode, signal, createdAt, endedAt, cols, rows, sequence,
      ...(type === 'game' ? { surface, game } : {}),
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

  async spawnTerminal({ rootId, type = 'terminal', agent, action = 'launch', command, args, handoffFile, cols = 100, rows = 30, env = {}, title, surface, game, cwd }) {
    if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 200)) fail('Session title must be a short string.');
    const root = this.store.root(rootId);
    const workingDirectory = cwd === undefined ? root.path : path.resolve(cwd);
    if (workingDirectory !== root.path && !workingDirectory.startsWith(root.path + path.sep)) fail('The working directory must be inside the project root.');
    const id = randomUUID(); let handoff, gate;
    env = shellEnvironment({ ...env, RENGINE_AGENT_HOME: path.join(this.store.directory, 'agents'),
      RENGINE_HANDOFF_GATE: undefined, RENGINE_HANDOFF_FILE: undefined, RENGINE_ORCHESTRATOR_SESSION: undefined });
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
      }
    }
    if (typeof file !== 'string' || !Array.isArray(argv) || argv.some(arg => typeof arg !== 'string')) fail('Invalid executable or arguments.');
    const child = pty.spawn(file, argv, { name: 'xterm-256color', cols, rows, cwd: workingDirectory,
      env: shellEnvironment({ ...env, RENGINE_AGENT_HOME: path.join(this.store.directory, 'agents') }) });
    const item = { id, rootId, type, handoff, gate, released: false, ...(type === 'agent' ? { agent: agent ?? '' } : {}), ...(type === 'game' ? { surface, game } : {}),
      title: title ?? (type === 'agent' ? `${agent || 'Choose agent'} · ${root.name}` : `${type === 'game' ? 'Game' : 'Terminal'} · ${root.name}`),
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
