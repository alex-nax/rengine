/* Restarting a workspace's update supervisor without touching its session host (F159, spec 145;
 * spec 102, KI-066).
 *
 * The tool is `red-launch restart-supervisor` now, so these drive the binary — and the fixture
 * processes are REAL ones, started for the test and signalled by it. That is stronger than what it
 * replaces: the JavaScript injected a `stop` function and asserted which pids it was handed, which
 * proved the choice and not the act. Here the wrong choice actually kills the wrong process, and
 * the test can see that it did not.
 *
 * The one thing this tool must never do is signal the session host. It holds every terminal, agent
 * and draft in the workspace.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launch } from './red-launch.mjs';

const run = promisify(execFile);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

/** A process that outlives the shell which started it, so nothing here is a child of this test. */
async function sleeper() {
  const { stdout } = await run('/bin/sh', ['-c', 'sleep 120 >/dev/null 2>&1 & echo $!']);
  return Number(stdout.trim());
}

/* A process table shaped like the real one: the host for a state directory, its supervisor, that
   supervisor's desktop child, and a second workspace's host and supervisor that must never be
   touched. The two supervisors are deliberately spelled DIFFERENTLY — one is the binary (F159) and
   one the module a workspace started before that upgrade is still running — because a scan that
   knew only one of them would report "no update supervisor is running" for a live workspace and
   then leave it running through a host replacement. */
async function workspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-restart-'));
  const stateDir = path.join(dir, 'state'), otherState = path.join(dir, 'other');
  await mkdir(stateDir, { recursive: true }); await mkdir(otherState, { recursive: true });
  const pids = {
    host: await sleeper(), supervisor: await sleeper(), desktop: await sleeper(),
    otherHost: await sleeper(), otherSupervisor: await sleeper(),
  };
  t.after(async () => {
    for (const pid of Object.values(pids)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    await rm(dir, { recursive: true, force: true });
  });
  const table = [
    `${pids.host} 1 node /checkout/orchestrator/server/main.mjs --state ${stateDir}`,
    `${pids.supervisor} 1 /checkout/red/target/debug/red-supervisor --state /checkout/.cache/runtime/ours`,
    `${pids.desktop} ${pids.supervisor} /checkout/.cache/desktop/bin/rengine --control`,
    `${pids.otherHost} 1 node /checkout/orchestrator/server/main.mjs --state ${otherState}`,
    `${pids.otherSupervisor} 1 node /checkout/orchestrator/runtime/supervisor.mjs`,
  ].join('\n');
  const tableFile = path.join(dir, 'ps.txt');
  await writeFile(tableFile, `${table}\n`);
  const token = 'f'.repeat(64);
  await writeFile(path.join(stateDir, 'sidecar.json'), JSON.stringify({ pid: pids.host, instance: 'ours', url: 'http://127.0.0.1:1', token }));
  await writeFile(path.join(otherState, 'sidecar.json'), JSON.stringify({ pid: pids.otherHost, instance: 'theirs', url: 'http://127.0.0.1:2', token }));
  const runtimeRoot = path.join(dir, 'runtime');
  await mkdir(path.join(runtimeRoot, 'ours'), { recursive: true });
  await mkdir(path.join(runtimeRoot, 'theirs'), { recursive: true });
  await writeFile(path.join(runtimeRoot, 'ours', 'runtime.json'),
    JSON.stringify({ pid: pids.supervisor, url: 'http://127.0.0.1:60000', token, instance: 'ours', host: { instance: 'ours' } }));
  await writeFile(path.join(runtimeRoot, 'theirs', 'runtime.json'),
    JSON.stringify({ pid: pids.otherSupervisor, url: 'http://127.0.0.1:60001', token, instance: 'theirs', host: { instance: 'theirs' } }));
  return { dir, stateDir, otherState, runtimeRoot, tableFile, pids };
}

const where = w => ['--process-table', w.tableFile, '--runtime-root', w.runtimeRoot];

test('the plan names the host it will not touch and the supervisor it will', async t => {
  const w = await workspace(t);
  const done = await launch(['restart-supervisor', '--state', w.stateDir, '--plan', ...where(w)]);
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, new RegExp(`Session host PID ${w.pids.host} — NOT signalled`));
  /* And the supervisor it WILL touch, which is the other half of this test's own name: a scan that
     found none would read here as a workspace with no supervisor. */
  assert.match(done.stdout, new RegExp(`Supervisor PID ${w.pids.supervisor} at http://127.0.0.1:60000, with 1 child process`));
  assert.ok(alive(w.pids.supervisor), '--plan is read-only');
  assert.ok(alive(w.pids.host));
});

test('a state directory with no live host is refused, and nothing is signalled', async t => {
  const w = await workspace(t);
  // The descriptor still names the host's PID; the table says that PID is something else entirely.
  const doctored = path.join(w.dir, 'other-thing.txt');
  await writeFile(doctored, `${w.pids.host} 1 node /checkout/other-thing.mjs\n${w.pids.supervisor} 1 /checkout/red/target/debug/red-supervisor --state /x\n`);
  for (const extra of [['--plan'], []]) {
    const done = await launch(['restart-supervisor', '--state', w.stateDir, ...extra, '--process-table', doctored, '--runtime-root', w.runtimeRoot]);
    assert.equal(done.code, 1, done.stdout);
    assert.match(done.stderr, /is not a session host[\s\S]*Nothing was signalled/);
    assert.doesNotMatch(`${done.stdout}${done.stderr}`, /Usage:/, 'it understood its own arguments');
  }
  assert.ok(alive(w.pids.supervisor), 'a refusal signals nothing at all');
  assert.ok(alive(w.pids.host));
});

test('the session host is never among the processes stopped', async t => {
  const w = await workspace(t);
  const done = await launch(['restart-supervisor', '--state', w.stateDir, '--stop-only', ...where(w)]);
  assert.equal(done.code, 0, done.stderr);
  // The one thing this tool must never do. The host holds every terminal, agent and draft.
  assert.ok(alive(w.pids.host), 'the host was signalled');
  assert.ok(alive(w.pids.otherHost), "and neither was another workspace's host");
  assert.ok(alive(w.pids.otherSupervisor), "nor another workspace's supervisor");
  assert.ok(!alive(w.pids.supervisor), "this workspace's supervisor WAS stopped");
  assert.match(done.stdout, new RegExp(`Session host PID ${w.pids.host} \\(ours\\) was not signalled; its sessions are intact`));
});

test('the report says what closes, so a vanishing editor window is predicted rather than surprising', async t => {
  const w = await workspace(t);
  const done = await launch(['restart-supervisor', '--state', w.stateDir, '--stop-only', ...where(w)]);
  assert.match(done.stdout, new RegExp(`Supervisor PID ${w.pids.supervisor}: stopped on SIGTERM, closing 1 managed desktop window`));
});

test('the replacement is detached and adopts the host, or it would die with the pane that asked for it', async t => {
  const w = await workspace(t);
  /* A stand-in launcher that records how it was started rather than opening a workspace. It is the
     same `$RENGINE_RED_LAUNCH` that names the binary everywhere else in this tree. */
  const record = path.join(w.dir, 'started.json');
  const stand = path.join(w.dir, 'stand-in.sh');
  await writeFile(stand, `#!/bin/sh\nprintf '{"args":"%s","ppid":%s,"session":%s}' "$*" "$PPID" "$(ps -o sess= -p $$ | tr -d ' ')" > ${JSON.stringify(record)}\n`, { mode: 0o755 });
  const done = await launch(['restart-supervisor', '--state', w.stateDir, ...where(w)], { env: { ...process.env, RENGINE_RED_LAUNCH: stand } });
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /Started detached: PID \d+\. The desktop reopens on the layout the store kept\./);
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await import('node:fs/promises').then(fs => fs.access(record)); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  const started = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(record, 'utf8')));
  assert.equal(started.args, `--state ${w.stateDir} --no-agent`);
  // Adopting the host is the whole point; --replace-host would end every session.
  assert.doesNotMatch(started.args, /--replace-host/);
  // Its own session, so it survives the pane that asked for the restart.
  assert.notEqual(started.session, String(process.pid), 'the replacement is in its own session');
});

test('called with nothing, it says how to call it', async () => {
  const done = await launch(['restart-supervisor']);
  assert.equal(done.code, 2);
  assert.match(done.stderr, /--state DIR/);
});
