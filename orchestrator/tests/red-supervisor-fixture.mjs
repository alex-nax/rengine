/* A real `red-supervisor`, with the shape `runtime/supervisor.mjs`'s `startRuntime` had (F159,
 * spec 144).
 *
 * The JavaScript supervisor was a module a test could call: it returned an object carrying the
 * descriptor AND three methods — `status`, `update`, `openDesktop` — that reached straight into the
 * running supervisor's own state. The binary has no inside a test can reach, so those three are the
 * routes they always were underneath, and everything above this file asks the same questions it did.
 *
 * What a caller hands in changes shape rather than meaning: `workerFile` is `--worker`,
 * `toolWorkerFile` is `--connector`, `binary` is `--desktop`, `inspectUI` is `--inspect-ui`,
 * `buildDesktop` is a declared command in `RENGINE_DESKTOP_BUILD`. `onDesktop` has no flag at all —
 * a supervisor that is a PROCESS cannot hand anyone a child's pipes — and its callers reach a
 * window through `automation()` below instead.
 */
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { request } from '../launcher/sidecar.mjs';
import { bridgeOn } from './native-client.mjs';

export function redSupervisorBinary() {
  return process.env.RENGINE_RED_SUPERVISOR || path.resolve('red/target/debug/red-supervisor');
}

export async function startSupervisor({ host, directory, initial, binary, workerFile, toolWorkerFile,
  inspectUI = false, buildDesktop, buildConnector, env = {} } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const args = ['--state', directory, '--host', host.url, '--host-token', host.token];
  if (workerFile) args.push('--worker', workerFile);
  if (toolWorkerFile) args.push('--connector', toolWorkerFile);
  if (binary) args.push('--desktop', binary);
  if (inspectUI) args.push('--inspect-ui');
  if (initial) args.push('--initial', JSON.stringify(initial));
  const child = spawn(redSupervisorBinary(), args, { stdio: ['pipe', 'pipe', 'pipe'], env: {
    ...process.env,
    ...(buildDesktop ? { RENGINE_DESKTOP_BUILD: buildDesktop } : {}),
    ...(buildConnector ? { RENGINE_CONNECTOR_BUILD: buildConnector } : {}),
    ...env,
  } });
  let said = '', diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-16000); });
  const announced = await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      said += chunk;
      if (said.includes('\n')) resolve(JSON.parse(said.split('\n')[0]));
    });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`red-supervisor exited ${code}: ${diagnostics}`)));
    setTimeout(() => reject(new Error(`red-supervisor did not announce itself: ${diagnostics}`)), 60000);
  });
  const runtime = {
    ...announced,
    child,
    diagnostics: () => diagnostics,
    /* The three `startRuntime` handed back, over the routes they were always served by. */
    status: rootId => request(runtime, `update-status?${new URLSearchParams({ rootId })}`),
    update: data => request(runtime, 'update-workspace', data),
    openDesktop: data => request(runtime, 'open-desktop', data),
    /* SIGTERM rather than SIGKILL, and then waited for: the supervisor closes its windows on the
       way out, and a test that killed it would leave them on the screen. */
    close: () => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      child.once('exit', resolve);
      child.kill('SIGTERM');
      setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 8000);
    }),
  };
  return runtime;
}

/* A second speaker on a window's stream: what `onDesktop` gave a test when the supervisor was a
 * module it shared a process with. One upgrade, then newline JSON both ways, and ids of its own —
 * the supervisor's count DOWN from -1 and never collide with these.
 */
export async function automation(runtime, owner, { timeout = 8000 } = {}) {
  const target = new URL(runtime.url);
  const socket = connect({ host: target.hostname, port: Number(target.port) });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.write(`GET /automation?owner=${owner} HTTP/1.1\r\n`
    + `Host: ${target.host}\r\nAuthorization: Bearer ${runtime.token}\r\n`
    + `Connection: Upgrade\r\nUpgrade: rengine-automation\r\n\r\n`);
  let buffered = '', serial = 0, diagnostics = '';
  const waiting = new Map();
  await new Promise((resolve, reject) => {
    const onData = chunk => {
      buffered += chunk;
      if (!buffered.includes('\r\n\r\n')) return;
      const [head, rest] = buffered.split('\r\n\r\n');
      socket.off('data', onData);
      if (!head.startsWith('HTTP/1.1 101')) { reject(new Error(`the relay refused: ${head}\n${rest}`)); return; }
      buffered = rest ?? '';
      resolve();
    };
    socket.on('data', onData);
    socket.once('error', reject);
    setTimeout(() => reject(new Error('the relay did not answer')), 10000);
  });
  socket.on('data', chunk => {
    buffered += chunk;
    let at;
    while ((at = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, at); buffered = buffered.slice(at + 1);
      let value; try { value = JSON.parse(line); } catch { diagnostics = (diagnostics + line + '\n').slice(-8192); continue; }
      const waiter = waiting.get(value.id);
      if (waiter) { waiting.delete(value.id); waiter(value.result); }
    }
  });
  const command = value => new Promise((resolve, reject) => {
    const id = ++serial;
    waiting.set(id, resolve);
    setTimeout(() => { if (waiting.delete(id)) reject(new Error(`Native ${value.op} timed out\n${diagnostics}`)); }, timeout);
    socket.write(`${JSON.stringify({ id, ...value })}\n`);
  });
  return {
    command,
    diagnostics: () => diagnostics,
    /* Closing something already closed must be a no-op rather than a wait. A window that went away
       — replaced by an update, or closed by the person — takes its relay with it, and a test tidying
       up afterwards would otherwise wait for an event that already happened. */
    close: () => new Promise(resolve => {
      if (socket.destroyed) { resolve(); return; }
      socket.once('close', resolve);
      socket.end();
      setTimeout(() => { socket.destroy(); resolve(); }, 2000).unref();
    }),
  };
}

/* A window this supervisor manages, driven the way a spec drove one when it had the child.
 *
 * `owner` is what `open-desktop` answered, or what `desktops?rootId=` lists. A window that has been
 * replaced by an update is a NEW process on the SAME owner, so a spec re-attaches rather than
 * holding a bridge across the switch — which is the one thing that differs from holding a pipe.
 */
export async function window(runtime, owner, options) {
  const relay = await automation(runtime, owner, options);
  /* `close` asks the WINDOW to quit and then lets go of the relay, which is what `nativeBridge`'s
     close did with a child: closing the pipe alone would leave the window on the screen, and a spec
     asserting that sessions survive a closed window would be asserting it about a window that is
     still open. A window that has already gone answers nothing, and that is not an error. */
  return bridgeOn({
    ...relay,
    close: async () => { await relay.command({ op: 'quit' }).catch(() => {}); await relay.close(); },
  });
}

/* The owner of the window open on this project, waited for: a desktop is registered before
   `open-desktop` answers, but a window opened by `--initial` is registered before this process has
   the supervisor's address at all. */
export async function openWindow(runtime, rootId, { attempts = 200 } = {}) {
  for (let at = 0; at < attempts; at++) {
    const { desktops } = await request(runtime, `desktops?${new URLSearchParams({ rootId })}`);
    const managed = desktops.find(desktop => desktop.managed);
    if (managed) return managed;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`No managed desktop window on ${rootId}`);
}
