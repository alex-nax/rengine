import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { networkInterfaces, tmpdir } from 'node:os';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { alive, ensureSidecar } from '../launcher/sidecar.mjs';
import { startServer } from '../server/main.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LAUNCH = path.join(ROOT, 'orchestrator/launch.mjs');
const READY = 'rengine headless ready ';
const run = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Stopping the sidecar and removing the directory are one hook on purpose: after-hooks run in
// registration order, so a separate stop registered later would find sidecar.json already deleted
// and leave the sidecar running for the rest of the machine's uptime.
async function scratch(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-headless-'));
  t.after(async () => { await stopSidecar(directory); await rm(directory, { recursive: true, force: true }); });
  return directory;
}

async function stopSidecar(directory) {
  let pid;
  try { pid = JSON.parse(await readFile(path.join(directory, 'sidecar.json'), 'utf8')).pid; } catch { return; }
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  for (let attempt = 0; attempt < 200 && alive(pid); attempt++) await pause(20);
}

// Start the real launcher and resolve the fields of its ready line. A launcher that dies first
// rejects with everything it printed, so a failure names the reason rather than timing out blind.
function headless(t, directory, args = [], env = {}) {
  const child = spawn(process.execPath, [LAUNCH, '--headless', '--state', directory, ...args],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const seen = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { seen.stderr += chunk; });
  t.after(() => { child.kill('SIGKILL'); });
  const ready = new Promise((resolve, reject) => {
    const line = () => seen.stdout.split('\n').find(text => text.startsWith(READY));
    const settle = () => {
      const found = line();
      if (!found) return false;
      resolve(Object.fromEntries(found.slice(READY.length).trim().split(' ')
        .map(pair => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)])));
      return true;
    };
    child.stdout.on('data', chunk => { seen.stdout += chunk; settle(); });
    child.once('error', reject);
    child.once('exit', code => {
      if (!settle()) reject(new Error(`the launcher exited ${code} before it was ready.\nstdout:\n${seen.stdout}\nstderr:\n${seen.stderr}`));
    });
  });
  return { child, seen, ready };
}

const api = (url, token, route) => fetch(`${url}/api/${route}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });

test('a headless start writes a usable descriptor and answers as the launcher own sidecar', { timeout: 40000 }, async t => {
  const directory = await scratch(t);
  const ready = await headless(t, directory).ready;

  const descriptor = JSON.parse(await readFile(path.join(directory, 'sidecar.json'), 'utf8'));
  assert.equal(descriptor.url, ready.url, 'the descriptor names the endpoint the ready line named');
  assert.match(descriptor.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(descriptor.token, /^[0-9a-f]{64}$/, 'a capability token, not a placeholder');
  assert.equal(descriptor.instance, ready.instance);
  assert.ok(alive(descriptor.pid), 'the descriptor names a live process');

  const response = await api(descriptor.url, descriptor.token, 'state');
  assert.equal(response.status, 200, 'the token in sidecar.json authenticates against the running instance');
  const state = await response.json();
  assert.equal(state.instance, descriptor.instance);

  // The oracle is a second, independently started workspace service: if a headless start ever served
  // something other than the sidecar the desktop retains, this set stops matching.
  const other = await mkdtemp(path.join(tmpdir(), 'rengine-reference-'));
  const reference = await startServer({ stateDir: other });
  t.after(async () => { await reference.close(); await rm(other, { recursive: true, force: true }); });
  const declared = (await (await api(reference.url, reference.token, 'state')).json()).capabilities;
  assert.ok(Object.keys(declared).length > 0, 'the workspace service declares capabilities at all');
  assert.deepEqual(state.capabilities, declared, 'a headless host reports the full workspace capability set');

  const discovered = await ensureSidecar(directory);
  assert.equal(discovered.pid, descriptor.pid, 'the desktop launcher discovery path finds this instance');
  assert.equal(discovered.instance, descriptor.instance, 'and authenticates to it, rather than starting a second service');
});

test('the headless sidecar listens on loopback only', { timeout: 40000 }, async t => {
  const directory = await scratch(t);
  const ready = await headless(t, directory).ready;
  const port = Number(new URL(ready.url).port);
  const routable = Object.values(networkInterfaces()).flat()
    .find(entry => entry && entry.family === 'IPv4' && !entry.internal);
  if (!routable) return t.skip('this machine has no routable IPv4 address to refuse a connection on');

  const refused = await new Promise(resolve => {
    const socket = net.connect({ host: routable.address, port, timeout: 4000 });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(true); });
  });
  assert.ok(refused, `the sidecar answered on ${routable.address}:${port}; the bind must stay 127.0.0.1`);
});

test('a headless start needs no C toolchain: it comes up with nothing on PATH', { timeout: 40000 }, async t => {
  const directory = await scratch(t);
  // The Windows box's SSH logon has no MSVC environment and never will, so the desktop build there
  // picked the NMake generator and died on a missing nmake. An empty PATH is that machine, locally:
  // no cmake, no nmake, no compiler. Reaching the ready line means build.mjs was never imported.
  const empty = path.join(directory, 'no-tools');
  await mkdir(empty, { recursive: true });
  const started = headless(t, directory, [], { PATH: empty });
  const ready = await started.ready;
  assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(!/cmake|nmake/i.test(started.seen.stderr), `a headless start named a build tool: ${started.seen.stderr}`);
});

test('--project registers the root on a headless start', { timeout: 40000 }, async t => {
  const directory = await scratch(t);
  const project = await scratch(t);
  const ready = await headless(t, directory, ['--project', project]).ready;
  assert.notEqual(ready.root, '-', 'the ready line reports the registered root');

  const descriptor = JSON.parse(await readFile(path.join(directory, 'sidecar.json'), 'utf8'));
  const state = await (await api(descriptor.url, descriptor.token, 'state')).json();
  assert.deepEqual(state.roots.map(root => [root.id, root.path]), [[ready.root, await realpath(project)]],
    'the instance is useful the moment it is up: the project is a registered root');
});

test('a headless start creates no agent session, and no session at all', { timeout: 40000 }, async t => {
  const directory = await scratch(t);
  // --project is what makes this fixture capable of failing: the desktop path creates its terminal
  // and agent sessions only once a root is given, so a headless start without one proves nothing.
  const project = await scratch(t);
  await headless(t, directory, ['--project', project]).ready;
  const descriptor = JSON.parse(await readFile(path.join(directory, 'sidecar.json'), 'utf8'));
  const state = await (await api(descriptor.url, descriptor.token, 'state')).json();

  assert.deepEqual(state.sessions.filter(session => session.type === 'agent'), [],
    'a headless host serves sessions; it starts no conversation');
  assert.deepEqual(state.sessions, [], 'and starts no terminal either');
  assert.equal(state.preferences.agent, undefined, 'nor records an agent preference it was never given');
});

test('--headless refuses the desktop-only flags, before starting anything', { timeout: 60000 }, async t => {
  const directory = await scratch(t);
  // The kill timeout is what makes a lost refusal readable: without it the launcher would accept the
  // combination, stay in the foreground supervising a sidecar, and the test would time out saying nothing.
  const attempt = args => run(process.execPath, [LAUNCH, '--headless', '--state', directory, ...args],
    { cwd: ROOT, timeout: 6000, killSignal: 'SIGKILL' });

  await assert.rejects(attempt(['--project', directory, '--launch-game']), /--headless cannot be combined with --launch-game/);
  await assert.rejects(attempt(['--agent', 'codex']), /--headless cannot be combined with --agent/);
  await assert.rejects(attempt(['--inspect-ui']), /--headless cannot be combined with --inspect-ui/);
  // A handoff names a file; the refusal has to come before it is read, or the message is about the file.
  await assert.rejects(attempt(['--handoff', path.join(directory, 'absent.json')]), /--headless cannot be combined with --handoff/);
  await assert.rejects(readFile(path.join(directory, 'sidecar.json')), { code: 'ENOENT' },
    'a refused combination starts no sidecar');
});

test('the full start path still builds the desktop and spawns it',
  { timeout: 120000, skip: process.platform === 'win32' && 'the recording stubs are shell scripts; Node refuses to spawn a .cmd without a shell' },
  async t => {
    const directory = await scratch(t);
    const stubs = path.join(directory, 'stubs');
    await mkdir(stubs, { recursive: true });
    const builds = path.join(directory, 'cmake.log');
    const desktop = path.join(directory, 'desktop.log');
    const binary = path.join(stubs, 'desktop');
    await writeFile(path.join(stubs, 'cmake'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${builds}"\nexit 0\n`);
    await writeFile(binary, `#!/bin/sh\nprintf 'url=%s token=%s\\n' "$RENGINE_WORKSPACE_URL" "$RENGINE_WORKSPACE_TOKEN" > "${desktop}"\nexit 0\n`);
    await chmod(path.join(stubs, 'cmake'), 0o755);
    await chmod(binary, 0o755);

    // A start that took the headless path instead would supervise its sidecar for ever rather than
    // build and spawn, so the kill timeout bounds it and the recordings — not the exit status — are
    // what the assertions read. Otherwise the only failure would be "command failed", naming nothing.
    const outcome = await run(process.execPath, [LAUNCH, '--state', directory],
      { cwd: ROOT, timeout: 45000, killSignal: 'SIGKILL',
        env: { ...process.env, PATH: `${stubs}${path.delimiter}${process.env.PATH}`, RENGINE_NATIVE_BINARY: binary } })
      .then(() => null, error => error);
    const said = outcome ? `the launcher failed: ${outcome.message}` : 'the launcher exited cleanly';

    const invocations = (await readFile(builds, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
    assert.equal(invocations.length, 2, `the desktop build ran configure and build; recorded ${invocations.join(' | ') || 'nothing'} and ${said}`);
    assert.match(invocations[0], /-S .* -B .*\.cache\/desktop/);
    assert.match(invocations[1], /--build .*\.cache\/desktop/);

    const spawned = await readFile(desktop, 'utf8').catch(() => '');
    assert.match(spawned, /url=http:\/\/127\.0\.0\.1:\d+ token=[0-9a-f]{64}/,
      `the desktop is executed with the workspace endpoint and token in its environment; ${said}`);
    assert.equal(outcome, null, `the launcher exited cleanly: ${outcome?.message}`);
  });

test('a headless start stays up, and stopping it leaves the sidecar and its sessions', { timeout: 60000 }, async t => {
  const directory = await scratch(t);
  const project = await scratch(t);
  const started = headless(t, directory, ['--project', project]);
  const ready = await started.ready;
  const pid = Number(ready.pid);

  // Past one supervision heartbeat: a start that returned as soon as the sidecar was up would be
  // gone by now, and a scheduled task or service wrapper would have nothing representing the host.
  await pause(1500);
  assert.equal(started.child.exitCode, null, `the headless start is still supervising: ${started.seen.stdout}`);

  const descriptor = JSON.parse(await readFile(path.join(directory, 'sidecar.json'), 'utf8'));
  const session = await (await fetch(`${descriptor.url}/api/terminal`, { method: 'POST',
    headers: { Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rootId: ready.root }) })).json();
  assert.ok(session.id, `a session to retain: ${JSON.stringify(session)}`);

  const stopped = new Promise(resolve => started.child.once('exit', code => resolve(code)));
  started.child.kill('SIGTERM');
  assert.equal(await stopped, 0, 'stopping it is not a failure');

  // What the sidecar is still serving comes first, and pid liveness second. A signalled sidecar
  // stops its sessions well before the process goes, so asserting liveness first passes while it is
  // on its way out: the first run of this check reddened the session line instead of the pid line.
  const state = await api(descriptor.url, descriptor.token, 'state').then(response => response.json())
    .catch(error => { throw new Error(`the sidecar stopped answering once the headless start was stopped: ${error.message}`); });
  assert.deepEqual(state.sessions.filter(item => item.state === 'running').map(item => item.id), [session.id],
    'the sidecar keeps serving, and keeps the session it was retaining');
  assert.equal(state.instance, descriptor.instance, 'and it is the same instance, not a replacement');
  for (let attempt = 0; attempt < 50 && alive(pid); attempt++) await pause(20);
  assert.ok(alive(pid), 'the sidecar process outlives the process that started it, as it does a desktop exit');
});
