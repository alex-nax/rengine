/* F177 (F151b, spec 131, charter D60): the PTYs belong to the state directory, not to whichever
 * host is running. Everything here is about the boundary between the two — a host dies, the
 * sessions do not; a second host adopts them by attaching rather than by handover; and nothing
 * reaches the sessions without the descriptor's token.
 *
 * The host in test 1 is a separate node process that gets SIGKILLed, because a graceful close
 * proves nothing about a host that crashes, and "the sessions survive the host" is a claim about
 * the ugly case.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
/* The number the host speaks, read rather than typed: a protocol bump is a one-line change in the
   client and this spec should follow it rather than pin a stale number. */
import { PTY_PROTOCOL } from './pty-client.mjs';
import { built } from './cargo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVE = path.join(ROOT, 'red/target/debug/red-pty-serve');
const CLIENT = path.join(ROOT, 'tests/pty-client.mjs');
const run = promisify(execFile);

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/* The process table, not the descriptor: a second service that lost the race to write pty.json
   is invisible to every reader of the file and still holds a port and a PTY. */
async function servicesFor(directory) {
  const { stdout } = await run('ps', ['-axo', 'pid=,args=']);
  return stdout.split('\n')
    .filter(line => line.includes('red-pty-serve') && line.includes(`--state ${directory}`))
    .map(line => Number(line.trim().split(/\s+/)[0]));
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

/* Waiting for a process to go, and saying what did not happen if it stays. */
const gone = async (pid, why, timeout = 8000) => {
  for (let waited = 0; waited < timeout && alive(pid); waited += 100) await pause(100);
  assert.ok(!alive(pid), `${why} (PID ${pid} was still running after ${timeout / 1000}s)`);
};

const until = async (check, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('until() timed out');
    await pause(25);
  }
};

async function build() {
  await built('-p', 'red-pty', '--bin', 'red-pty-serve');
  assert.ok(existsSync(SERVE), `red-pty-serve was built at ${SERVE}`);
}

/* A state directory, and everything started against it cleaned up afterwards — including the
   service, which is the whole point of this feature and therefore outlives every host here. */
async function workspace(t, { idleSeconds = 600 } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-pty-retain-'));
  t.after(async () => {
    for (const pid of await servicesFor(directory)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, env: { ...process.env, RED_PTY_IDLE_SECONDS: String(idleSeconds) } };
}

const attach = (directory, env) => import(CLIENT).then(client => client.PtyHost.attach(directory, { env }));

/* A host in its own process: attaches, spawns one PTY, reports what it made, and waits to be
   killed. Its stdout is the test's channel for the session identity. */
const HOST_SCRIPT = `
const [,, directory, command] = process.argv;
const { PtyHost } = await import(${JSON.stringify(CLIENT)});
const pty = await PtyHost.attach(directory);
const snapshot = await pty.spawn({ command: '/bin/bash', args: ['-c', command], cols: 80, rows: 24 });
console.log(JSON.stringify({ id: snapshot.id, pid: snapshot.pid, service: pty.service?.pid ?? null }));
setInterval(() => {}, 1000);
`;

async function startHost(t, directory, command, env) {
  const script = path.join(directory, 'host.mjs');
  await writeFile(script, HOST_SCRIPT);
  const child = spawn(process.execPath, [script, directory, command], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } });
  const line = await new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; if (text.includes('\n')) resolve(text.split('\n')[0]); });
    child.once('exit', code => reject(new Error(`the host process exited early (${code})`)));
  });
  return { child, session: JSON.parse(line) };
}

test('a session outlives the host that started it, and the next host adopts it', async t => {
  await build();
  const { directory, env } = await workspace(t);
  const host = await startHost(t, directory, 'printf "before\\n"; cat', env);

  host.child.kill('SIGKILL');
  await gone(host.child.pid, 'the host process is gone before anything is claimed about its sessions');
  assert.ok(host.session.service && alive(host.session.service),
    `the host's PTYs live in a service of their own (${host.session.service}), and it outlives the host`);
  assert.ok(alive(host.session.pid), `the shell (PID ${host.session.pid}) is still running`);

  const next = await attach(directory, env);
  t.after(() => next.close());
  assert.equal(next.service.pid, host.session.service, 'the next host found the same service rather than starting a second');
  const adopted = next.adopted.find(entry => entry.id === host.session.id);
  assert.ok(adopted, `attaching answers with the session ${host.session.id} it did not start`);
  assert.equal(adopted.pid, host.session.pid, 'the same shell process, not a fresh one');
  assert.match(adopted.output, /before/, 'the scrollback written before the host died came with it');

  /* And it is a live terminal, not a record of one. */
  await next.input(host.session.id, 'printf "after\\n"\n');
  const snapshot = await until(async () => {
   
    const current = await next.snapshot(host.session.id);
   
    return current.output.includes('after') ? current : null;
  });
  assert.match(snapshot.output, /before[\s\S]*after/, 'input typed by the second host reached the same shell');
});

test('nothing reaches the sessions without the descriptor token', async t => {
  await build();
  const { directory, env } = await workspace(t);
  const host = await attach(directory, env);
  t.after(() => host.close());
  await host.spawn({ command: '/bin/bash', args: ['-c', 'sleep 30'], cols: 80, rows: 24 });
  const descriptor = JSON.parse(await readFile(path.join(directory, 'pty.json'), 'utf8'));
  const port = Number(/:(\d+)$/.exec(descriptor.url)[1]);

  const ask = (request, wait = 1500) => new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let text = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('no answer')); }, wait);
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => {
      text += chunk;
      if (!text.includes('\n')) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(JSON.parse(text.split('\n')[0]));
    });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
  });

  const wrong = await ask({ id: 1, method: 'attach', args: [{ token: 'f'.repeat(64), protocol: PTY_PROTOCOL }] });
  assert.ok(wrong.error, `a wrong token is refused, never served: ${JSON.stringify(wrong.result ?? wrong)}`);
  assert.equal(wrong.error.status, 401, 'a wrong token is refused');
  assert.match(wrong.error.message, /token does not match/);
  assert.equal(wrong.result, undefined, 'and learns nothing about the service');

  const unattached = await ask({ id: 1, method: 'list' });
  assert.ok(unattached.error, `a list before any attach is refused: ${JSON.stringify(unattached.result ?? unattached)}`);
  assert.equal(unattached.error.status, 401, 'and so is a list before any attach');
  assert.match(unattached.error.message, /attach with this service's token/);

  const mismatch = await ask({ id: 1, method: 'attach', args: [{ token: descriptor.token, protocol: 99 }] });
  assert.ok(mismatch.error, `the right token with the wrong protocol is refused too: ${JSON.stringify(mismatch.result ?? mismatch)}`);
  assert.equal(mismatch.error.status, 409, 'the right token with the wrong protocol is refused too');
  assert.match(mismatch.error.message, new RegExp(`speaks protocol ${PTY_PROTOCOL}; the client asked for 99`));
});

test('two hosts racing for one state directory get one service', async t => {
  await build();
  const { directory, env } = await workspace(t);
  const [first, second] = await Promise.all([attach(directory, env), attach(directory, env)]);
  t.after(() => Promise.all([first.close(), second.close()]));
  assert.equal(first.service.pid, second.service.pid, 'both hosts attached to the same service');
  assert.equal(first.service.instance, second.service.instance);
  assert.deepEqual(await servicesFor(directory), [first.service.pid],
    'exactly one red-pty-serve process serves the directory — a loser that never wrote the descriptor is still a process holding a port');
  assert.ok(!existsSync(path.join(directory, 'pty-startup.lock')), 'the startup lock is released');

  /* Both are attached, so both see what either one does. */
  const seen = [];
  second.on('event', event => { if (event.type === 'output') seen.push(event.data); });
  const snapshot = await first.spawn({ command: '/bin/bash', args: ['-c', 'printf "shared\\n"'], cols: 80, rows: 24 });
  await until(() => seen.join('').includes('shared'));
  assert.match((await second.snapshot(snapshot.id)).output, /shared/, 'the second host reads the first host\'s session');
});

test('a service that speaks another protocol is ended by name, never adopted', async t => {
  await build();
  const { directory, env } = await workspace(t);
  const first = await attach(directory, env);
  await first.close();
  const descriptor = JSON.parse(await readFile(path.join(directory, 'pty.json'), 'utf8'));
  await writeFile(path.join(directory, 'pty.json'), JSON.stringify({ ...descriptor, protocol: 99 }));

  const warnings = [];
  const listen = warning => warnings.push(warning.message);
  process.on('warning', listen);
  t.after(() => process.off('warning', listen));

  const next = await attach(directory, env);
  t.after(() => next.close());
  assert.notEqual(next.service.pid, descriptor.pid, 'a service this host cannot read is not adopted');
  await gone(descriptor.pid, 'a service this host cannot read is ended rather than left holding PTYs');
  assert.ok(warnings.some(message => new RegExp(`names protocol 99; this host speaks ${PTY_PROTOCOL}`).test(message)),
    `the mismatch is named: ${warnings.join(' | ')}`);
  assert.ok(warnings.some(message => new RegExp(`Ending PID ${descriptor.pid}`).test(message)),
    'and so is the process it ended');
});

test('an idle service reaps itself; one holding a session does not', async t => {
  await build();
  const empty = await workspace(t, { idleSeconds: 1 });
  const first = await attach(empty.directory, empty.env);
  const idle = JSON.parse(await readFile(path.join(empty.directory, 'pty.json'), 'utf8'));
  await first.close();
  await gone(idle.pid, 'a service with no sessions and no client reaps itself');
  assert.ok(!existsSync(path.join(empty.directory, 'pty.json')), 'it removed its own descriptor on the way out');

  const held = await workspace(t, { idleSeconds: 1 });
  const host = await attach(held.directory, held.env);
  const session = await host.spawn({ command: '/bin/bash', args: ['-c', 'sleep 30'], cols: 80, rows: 24 });
  const keeper = JSON.parse(await readFile(path.join(held.directory, 'pty.json'), 'utf8'));
  await host.close();
  await pause(3000);
  assert.ok(alive(keeper.pid), 'a service holding a session waits however long nobody is listening');
  const next = await attach(held.directory, held.env);
  t.after(() => next.close());
  assert.equal(next.service.pid, keeper.pid);
  assert.ok(next.adopted.some(entry => entry.id === session.id), 'and the session is still there to adopt');
});
