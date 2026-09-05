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

const execute = promisify(execFile);
const agentScript = fileURLToPath(new URL('../../scripts/agent.sh', import.meta.url));
const OUTPUT_LIMIT = 1024 * 1024;

export function shellEnvironment(overrides = {}) {
  const env = { ...process.env, ...overrides, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  const extra = ['.local/bin', '.n/bin', '.opencode/bin', '.cargo/bin'].map(part => path.join(homedir(), part));
  env.PATH = [...new Set([...(env.PATH ?? '').split(path.delimiter), ...extra])].join(path.delimiter);
  delete env.ELECTRON_RUN_AS_NODE;
  return Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string'));
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
  constructor(store) { super(); this.store = store; this.items = new Map(); }

  get(id) {
    const item = this.items.get(id);
    if (!item) fail('Unknown session.', 404);
    return item;
  }

  snapshot(id, includeOutput = false) {
    const { id: sessionId, rootId, type, agent, title, pid, state, exitCode, signal, createdAt, endedAt, cols, rows, sequence, output } = this.get(id);
    return { id: sessionId, rootId, type, agent, title, pid, state, exitCode, signal, createdAt, endedAt, cols, rows, sequence,
      ...(includeOutput ? { output } : {}) };
  }

  list() { return [...this.items.keys()].map(id => this.snapshot(id)); }
  changed(item) { this.emit('event', { type: 'session', session: this.snapshot(item.id) }); }

  async terminal({ rootId, type = 'terminal', agent, action = 'launch', command, args, cols = 100, rows = 30, env = {} }) {
    const root = this.store.root(rootId);
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
        const filename = path.join(directory, `${root.id}.json`);
        const temporary = `${filename}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify({ ...this.workspaceContext, rootId: root.id }), { mode: 0o600 });
        await rename(temporary, filename);
        env = { ...env, RENGINE_WORKSPACE_CONTEXT: filename, RENGINE_NODE: process.execPath, RENGINE_BASH: file };
      }
    }
    if (typeof file !== 'string' || !Array.isArray(argv) || argv.some(arg => typeof arg !== 'string')) fail('Invalid executable or arguments.');
    const child = pty.spawn(file, argv, { name: 'xterm-256color', cols, rows, cwd: root.path,
      env: shellEnvironment({ ...env, RENGINE_AGENT_HOME: path.join(this.store.directory, 'agents') }) });
    const item = { id: randomUUID(), rootId, type, ...(type === 'agent' ? { agent: agent ?? '' } : {}),
      title: type === 'agent' ? `${agent || 'Choose agent'} · ${root.name}` : `${type === 'game' ? 'NOLF' : 'Terminal'} · ${root.name}`,
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

  input(id, data) {
    const item = this.get(id);
    if (item.state !== 'running') fail('Session is not running.', 409);
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
