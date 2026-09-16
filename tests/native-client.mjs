import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

/* A native spec starts a real workspace, and a real workspace publishes an IDE lock for Claude Code
   to find (spec 102). Without this, running a spec directly rather than through its npm script puts
   a dead rEdit into the `/ide` menu of whoever ran it. */
process.env.RENGINE_IDE_DIRECTORY ??= await mkdtemp(path.join(tmpdir(), 'rengine-spec-ide-'));


/* Where the desktop is built to, which is `red_supervisor::desktop::native_binary`'s answer on the
   other side. A spec that needs the binary asks here rather than importing a production module for
   one path — `runtime/desktop.mjs` retired with the supervisor that launched windows (F159). */
export const nativeBinary = process.env.RENGINE_NATIVE_BINARY
  ?? path.resolve('.cache/desktop/bin', process.platform === 'win32' ? 'Release/rengine.exe' : 'rengine');

/* One desktop window, launched DIRECTLY rather than through a supervisor. The supervisor composes
   this environment itself now (`red_supervisor::desktop::environment`, frozen against what the
   JavaScript handed a window); what is here is a spec standing in for a supervisor, to prove what a
   window does when it is handed a control channel and nothing else. */
export function launchDesktop(binary, instance, binding, { inspectUI = false } = {}) {
  return spawn(binary, inspectUI ? ['--automation'] : ['--control'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: false, env: {
    ...process.env, RENGINE_WORKSPACE_URL: instance.url, RENGINE_WORKSPACE_TOKEN: instance.token,
    RENGINE_WINDOW_ID: binding.windowId, RENGINE_WINDOW_TITLE: binding.title,
    RENGINE_INITIAL_ROOT: binding.root, RENGINE_INITIAL_TERMINAL: binding.terminal ?? '',
    RENGINE_INITIAL_AGENT: binding.agent ?? '', RENGINE_INITIAL_GAME: binding.game ?? '',
    RENGINE_RESUME_AGENT: binding.resume ? '1' : undefined, RENGINE_LAYERED_CHILD: '1',
    RENGINE_CAN_RELOAD: '1', RENGINE_DESKTOP_OWNER: binding.owner, RENGINE_DESKTOP_VIEW: binding.view,
  } });
}

export async function nativeClient(instance, { root = '', terminal = '', agent = '', game = '', env: extra = {} } = {}) {
  const executable = nativeBinary;
  const child = spawn(executable, ['--automation'], { stdio: ['pipe', 'pipe', 'pipe'], env: {
    ...process.env, RENGINE_WORKSPACE_URL: instance.url, RENGINE_WORKSPACE_TOKEN: instance.token,
    RENGINE_INITIAL_ROOT: root, RENGINE_INITIAL_TERMINAL: terminal, RENGINE_INITIAL_AGENT: agent, RENGINE_INITIAL_GAME: game, ...extra,
  } });
  return nativeBridge(child);
}

/* Everything a spec does with a window, over whatever can carry ONE command and answer it.
 *
 * It used to be inseparable from a child process, because that is what a spec had: the supervisor
 * was a module in the same process and handed over the pipes. A supervisor that is a PROCESS cannot
 * (F159, spec 144), so a window is reached through its automation relay instead — and everything
 * above the command is the same either way, which is why it lives here rather than in either. */
export function bridgeOn({ command, close, diagnostics = () => '' }) {
  async function until(predicate, label = 'native state') {
    let state;
    for (let i = 0; i < 160; i++) { state = await command({ op: 'state' }); if (predicate(state)) return state; await delay(50); }
    throw new Error(`${label} not reached: ${JSON.stringify(state)}\n${diagnostics()}`);
  }
  async function click(x, y) {
    await command({ op: 'motion', x, y }); await delay(60);
    await command({ op: 'button', x, y, down: true }); await delay(60);
    await command({ op: 'button', x, y, down: false }); await delay(60);
  }
  async function key(key, mod = 0) {
    await command({ op: 'key', key, mod }); await command({ op: 'key', key, mod, down: false }); await delay(30);
  }
  async function control(role, key, tab) {
    const matches = c => c.role === role && c.key === key && (tab === undefined || c.tab === tab);
    const state = await until(s => s.controls?.some(matches), `${role} ${key}`);
    const { rect: [x, y, w, h] } = state.controls.find(matches);
    await click(x + w / 2, y + h / 2);
  }
  return { command, until, click, key, control, close, diagnostics };
}

export function nativeBridge(child, { timeout = 8000 } = {}) {
  let serial = 0, diagnostics = ''; const waiting = new Map();
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8192); });
  const exited = once(child, 'exit');
  child.on('exit', (code, signal) => { for (const waiter of waiting.values()) waiter.reject(new Error(`Native desktop exited: ${code}/${signal}\n${diagnostics}`)); waiting.clear(); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let value; try { value = JSON.parse(line); } catch { diagnostics = (diagnostics + line + '\n').slice(-8192); return; }
    const waiter = waiting.get(value.id); if (waiter) { waiting.delete(value.id); waiter.resolve(value.result); }
  });
  function command(value) {
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`Native ${value.op} timed out\n${diagnostics}`)); }, timeout);
      waiting.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
      child.stdin.write(`${JSON.stringify({ id, ...value })}\n`);
    });
  }
  async function close() {
    if (child.exitCode === null && child.signalCode === null) {
      let timeout;
      try {
        await command({ op: 'quit' });
        await Promise.race([exited, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Native close timed out')), 8000); })]);
      } finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }
    }
    child.stdin.destroy(); lines.close(); child.stdout.destroy(); child.stderr.destroy();
  }
  return { child, ...bridgeOn({ command, close, diagnostics: () => diagnostics }) };
}
