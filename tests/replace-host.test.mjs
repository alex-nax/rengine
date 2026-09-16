/* Replacing a session host, end to end (F159, spec 145; spec 098, F94).
 *
 * The decisions — which process is a session host, which is a supervisor, whose ancestor is whose,
 * and what the report says — are `red_supervisor::replace`, judged against `replace-host-corpus.json`
 * on a process table captured from a real machine. The signalling is `red_supervisor::stop`, whose
 * own tests start real processes and stop them.
 *
 * What is left here is what only a real workspace can show: a throwaway host actually replaced, its
 * port actually closed, its panes actually adopted by the host that follows — and, the load-bearing
 * half, that a refusal reaches the launcher BEFORE anything is signalled. That last one is why this
 * file doctors a captured process table rather than trusting the unit tests: a refusal that is
 * implemented and not wired up reads exactly like one that works.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { endStateServices } from './state-services.mjs';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { alive, ensureSidecar, request } from './sidecar.mjs';
import { LAUNCH, ROOT, replaceHost } from './red-launch.mjs';

const run = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const VTMB = '/home/x/.local/state/rengine/vtmb-vr-2249049057';

/** `ps` as the launcher reads it, so a case can hand back a doctored copy of this machine. */
const table = async () => (await run('ps', ['-A', '-ww', '-o', 'pid=,ppid=,command='], { maxBuffer: 64 * 1024 * 1024 })).stdout;
const rows = text => text.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
  .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command: command.trim() }));
const asText = list => list.map(({ pid, ppid, command }) => `${pid} ${ppid} ${command}`).join('\n');
const portClosed = url => new Promise(resolve => {
  const { hostname, port } = new URL(url);
  const socket = net.connect({ host: hostname, port: Number(port) });
  socket.setTimeout(500);
  socket.once('connect', () => { socket.destroy(); resolve(false); });
  socket.once('timeout', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(true));
});

// A real, throwaway host is started for each test and stopped by it. Stopping it and removing its
// directory is one hook, for the reason headless.test.mjs records.
async function scratch(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-replace-'));
  t.after(async () => {
    await stopSidecar(directory);
    /* And the services the directory keeps after its host — the whole point of D60/D61, and a
       leak in a suite that deletes the directory underneath them. */
    await endStateServices(directory);
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
async function stopSidecar(directory) {
  let pid;
  try { pid = JSON.parse(await readFile(path.join(directory, 'sidecar.json'), 'utf8')).pid; } catch { return; }
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  for (let attempt = 0; attempt < 200 && alive(pid); attempt++) await pause(20);
}
async function runtimeRoot(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('replacing a throwaway host: the old one exits, its port closes, a new one answers, and the report says so', { timeout: 60000 }, async t => {
  const directory = await scratch(t);
  const runtime = await runtimeRoot(t);
  const old = await ensureSidecar(directory);
  const root = await request(old, 'roots', { path: directory });
  const session = await request(old, 'terminal', { rootId: root.id });
  assert.equal(session.state, 'running');

  const done = await replaceHost(directory, ['--runtime-root', runtime]);
  assert.equal(done.code, 0, done.stderr);
  const said = done.stdout;

  assert.equal(alive(old.pid), false, 'the old host exited');
  /* Only the host is signalled: its stdio services (the store) are gone by the time the children
     are looked at, because their stdin closed with it. */
  assert.match(said, new RegExp(`\\n {2}host PID ${old.pid}: stopped on SIGTERM\\n`));
  assert.doesNotMatch(said, /host child PID/, 'nothing else of the host\'s was stopped');
  for (const role of ['pty service', 'store service']) {
    assert.match(said, new RegExp(`left the ${role} running \\(PID \\d+\\): it belongs to `),
      'the children that are not the host\'s to end: the state directory keeps its panes (D60) and its store (D61)');
  }
  assert.match(said, new RegExp(`stopped host PID ${old.pid} \\(${old.url}, instance ${old.instance}, started \\d{4}-`));
  assert.match(said, /handed 1 running session\(s\) to the next host:\n {4}terminal — /, 'the report names the session that changes hands');

  const started = /Started host PID (\d+) \((\S+), instance (\S+)\) from (\S+)\.$/m.exec(said);
  assert.ok(started, said);
  const [, pid, url, instance, checkout] = started;
  assert.notEqual(Number(pid), old.pid);
  assert.notEqual(instance, old.instance, 'a new host, not the old one found again');
  assert.ok(alive(Number(pid)));
  assert.equal(checkout, `${ROOT}/`);

  const written = JSON.parse(await readFile(path.join(directory, 'sidecar.json'), 'utf8'));
  assert.equal(written.pid, Number(pid), 'the descriptor now names the new host');
  const state = await request(written, 'state');
  assert.equal(state.instance, instance);
  assert.deepEqual(state.roots.map(item => item.id), [root.id], 'the root persisted across the replacement');
  /* F94 asserted here that sessions did NOT persist, because when it was written the PTYs were
     file descriptors inside the host. Charter D60 (owner, 2026-09-13) moved them to the state
     directory precisely so a replacement stops costing the owner their agent panes, so this is the
     clause of F94's criterion 4 that D60 supersedes — recorded rather than quietly rewritten. The
     new host adopts what the service still holds, with the pane's own title and root. */
  const carried = state.sessions.find(item => item.id === session.id);
  assert.ok(carried, `the new host adopted the pane the old one had: ${JSON.stringify(state.sessions)}`);
  assert.equal(carried.pid, session.pid, 'the same child process, not a fresh one');
  assert.equal(carried.state, 'running');

  assert.equal(await portClosed(old.url), true, 'and the old port refuses connections');
});


test('a refusal leaves the real host untouched: another directory claimed, or a launcher inside the workspace', { timeout: 60000 }, async t => {
  const directory = await scratch(t);
  const runtime = await runtimeRoot(t);
  const old = await ensureSidecar(directory);
  const real = rows(await table());
  const mine = real.find(entry => entry.pid === old.pid);
  assert.ok(mine && /red-host --state /.test(mine.command), `ps shows the throwaway host: ${mine?.command}`);

  // The same PID, but ps says it serves vtmb-vr's directory: a descriptor that lies, or a PID reused.
  const claimedFile = path.join(directory, 'claimed.txt');
  await writeFile(claimedFile, asText(real.map(entry =>
    entry.pid === old.pid ? { ...entry, command: `${entry.command.split(' --state ')[0]} --state ${VTMB}` } : entry)));
  const claimed = await replaceHost(directory, ['--runtime-root', runtime, '--process-table', claimedFile]);
  assert.equal(claimed.code, 1, claimed.stdout);
  assert.match(claimed.stderr, new RegExp(`${VTMB}[\\s\\S]*Nothing was signalled`));
  assert.equal(alive(old.pid), true, 'nothing was signalled');
  assert.equal((await request(old, 'state')).instance, old.instance, 'and it still answers as itself');

  /* The launcher, re-parented under the host: the shape of a pane asking to end itself. The row has
     to name the LAUNCHER's own pid, which nothing knows until it exists — so a shell writes its own
     pid into the table and then `exec`s the launcher, which inherits that pid exactly. */
  const insideFile = path.join(directory, 'inside.txt');
  await writeFile(insideFile, `${asText(real)}\n`);
  const script = `printf '%s %s %s\\n' "$$" ${old.pid} the-launcher >> ${JSON.stringify(insideFile)}; `
    + `exec ${JSON.stringify(LAUNCH())} replace-host --state ${JSON.stringify(directory)} `
    + `--runtime-root ${JSON.stringify(runtime)} --process-table ${JSON.stringify(insideFile)}`;
  const inside = await run('/bin/sh', ['-c', script], { cwd: ROOT }).then(() => ({ code: 0, stdout: '', stderr: '' }),
    error => ({ code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? error.message }));
  assert.equal(inside.code, 1, inside.stdout);
  assert.match(inside.stderr, /inside the workspace it would replace[\s\S]*PID \d+ is one of its ancestors[\s\S]*Nothing was signalled/);
  assert.equal(alive(old.pid), true);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'sidecar.json'), 'utf8')).pid, old.pid, 'the descriptor was not touched either');
});

test('a stale descriptor is cleared and a fresh host started, with no refusal', { timeout: 60000 }, async t => {
  const directory = await scratch(t);
  const runtime = await runtimeRoot(t);
  await writeFile(path.join(directory, 'sidecar.json'),
    JSON.stringify({ url: 'http://127.0.0.1:1', token: 'f'.repeat(64), instance: 'gone', pid: 2147483000 }));
  const done = await replaceHost(directory, ['--runtime-root', runtime]);
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /named PID 2147483000, which is gone; the stale descriptor was removed/);
  assert.doesNotMatch(done.stdout, /stopped host PID/, 'nothing was signalled');
  const started = /Started host PID (\d+) /.exec(done.stdout);
  assert.ok(started && alive(Number(started[1])), done.stdout);
});

test('--headless --replace-host through the launcher comes up as a different host', { timeout: 60000 }, async t => {
  const directory = await scratch(t);
  const old = await ensureSidecar(directory);
  const child = spawn(LAUNCH(), ['--headless', '--replace-host', '--state', directory], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  const seen = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { seen.stderr += chunk; });
  const ready = await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      seen.stdout += chunk;
      const line = seen.stdout.split('\n').find(text => text.startsWith('rengine headless ready '));
      if (line) resolve(Object.fromEntries(line.slice('rengine headless ready '.length).trim().split(' ').map(pair => pair.split('='))));
    });
    child.once('exit', code => reject(new Error(`the launcher exited ${code} before it was ready.\nstdout:\n${seen.stdout}\nstderr:\n${seen.stderr}`)));
  });
  assert.notEqual(Number(ready.pid), old.pid, 'the launcher is supervising a different host');
  assert.equal(alive(old.pid), false, 'the one that was there is gone');
  assert.ok(alive(Number(ready.pid)));
  assert.match(seen.stdout, new RegExp(`Replaced the session host of .*\n {2}stopped host PID ${old.pid} `));
  assert.match(seen.stdout, new RegExp(`Started host PID ${ready.pid} `));
});
