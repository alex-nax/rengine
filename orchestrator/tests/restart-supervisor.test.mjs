import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { plan, restart, describe as report } from '../launcher/restart-supervisor.mjs';

const run = promisify(execFile);
const TOOL = path.resolve('orchestrator/launcher/restart-supervisor.mjs');

/* A process table shaped like the real one: the host for a state directory, its supervisor, that
   supervisor's desktop child, and a second workspace's host that must never be touched. */
function fixture(stateDir, otherState) {
  return [
    { pid: 100, ppid: 1, command: `node /checkout/orchestrator/server/main.mjs --state ${stateDir}` },
    { pid: 200, ppid: 1, command: 'node /checkout/orchestrator/runtime/supervisor.mjs' },
    { pid: 300, ppid: 200, command: '/checkout/.cache/desktop/bin/rengine --control' },
    { pid: 400, ppid: 1, command: `node /checkout/orchestrator/server/main.mjs --state ${otherState}` },
    { pid: 500, ppid: 1, command: 'node /checkout/orchestrator/runtime/supervisor.mjs' },
  ];
}

async function workspace() {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-restart-'));
  const stateDir = path.join(dir, 'state'), otherState = path.join(dir, 'other');
  await mkdir(stateDir, { recursive: true }); await mkdir(otherState, { recursive: true });
  await writeFile(path.join(stateDir, 'sidecar.json'), JSON.stringify({ pid: 100, instance: 'ours', url: 'http://127.0.0.1:1' }));
  await writeFile(path.join(otherState, 'sidecar.json'), JSON.stringify({ pid: 400, instance: 'theirs', url: 'http://127.0.0.1:2' }));
  const runtimeRoot = path.join(dir, 'runtime');
  await mkdir(path.join(runtimeRoot, 'ours'), { recursive: true });
  await mkdir(path.join(runtimeRoot, 'theirs'), { recursive: true });
  await writeFile(path.join(runtimeRoot, 'ours', 'runtime.json'), JSON.stringify({ pid: 200, url: 'http://127.0.0.1:60000', host: { instance: 'ours' } }));
  await writeFile(path.join(runtimeRoot, 'theirs', 'runtime.json'), JSON.stringify({ pid: 500, url: 'http://127.0.0.1:60001', host: { instance: 'theirs' } }));
  return { dir, stateDir, otherState, runtimeRoot };
}

/* The fixture's PIDs are invented, so liveness is answered from the table rather than from the OS. */
const options = w => ({ processes: fixture(w.stateDir, w.otherState), runtimeRoot: w.runtimeRoot,
  alive: pid => fixture(w.stateDir, w.otherState).some(row => row.pid === pid) });

test('the plan names the host it will not touch and the supervisor it will', async () => {
  const w = await workspace();
  try {
    const value = await plan(w.stateDir, options(w));
    assert.equal(value.refusal, undefined);
    assert.equal(value.host.pid, 100);
    assert.equal(value.host.instance, 'ours');
  } finally { await rm(w.dir, { recursive: true, force: true }); }
});

test('a state directory with no live host is refused, and nothing is signalled', async () => {
  const w = await workspace();
  try {
    // The host's PID is in the descriptor but the table says that PID is something else entirely.
    const table = fixture(w.stateDir, w.otherState).map(row => row.pid === 100 ? { ...row, command: 'node /checkout/other-thing.mjs' } : row);
    const alive = pid => table.some(row => row.pid === pid);
    // The descriptor still names PID 100; the table says that PID is something else. Refused by name.
    await assert.rejects(() => plan(w.stateDir, { processes: table, alive, runtimeRoot: w.runtimeRoot }),
      /is not a session host.*Nothing was signalled/s);
    const signalled = [];
    await assert.rejects(() => restart(w.stateDir, { processes: table, alive, runtimeRoot: w.runtimeRoot,
      stop: pid => { signalled.push(pid); return { pid, outcome: 'stopped' }; } }), /Nothing was signalled/);
    assert.deepEqual(signalled, [], 'a refusal signals nothing at all');
  } finally { await rm(w.dir, { recursive: true, force: true }); }
});

test('the session host is never among the processes stopped', async () => {
  const w = await workspace();
  try {
    const signalled = [];
    const value = await restart(w.stateDir, {
      ...options(w),
      stop: pid => { signalled.push(pid); return { pid, outcome: 'stopped on SIGTERM' }; },
      released: async () => true,
      launch: false,
    });
    // The one thing this tool must never do. The host holds every terminal, agent and draft.
    assert.ok(!signalled.includes(100), `the host was signalled: ${signalled.join(', ')}`);
    assert.ok(!signalled.includes(400), 'and neither was another workspace\'s host');
    assert.ok(!signalled.includes(500), 'nor another workspace\'s supervisor');
    assert.equal(value.host.pid, 100, 'it is reported as kept');
    assert.match(report(value), /was not signalled; its sessions are intact/);
  } finally { await rm(w.dir, { recursive: true, force: true }); }
});

test('the replacement is detached, or it would die with the pane that asked for it', async () => {
  const w = await workspace();
  try {
    let spawned = null;
    await restart(w.stateDir, {
      ...options(w),
      stop: pid => ({ pid, outcome: 'stopped on SIGTERM' }),
      released: async () => true,
      spawnImpl: (command, args, options) => { spawned = { command, args, options }; return { pid: 999, unref() {} }; },
    });
    assert.equal(spawned.options.detached, true, 'detached, so it survives the pane');
    assert.equal(spawned.options.stdio, 'ignore', 'and holds no pipe back to it');
    assert.ok(spawned.args.includes('--state') && spawned.args.includes(w.stateDir));
    // Adopting the host is the whole point; --replace-host would end every session.
    assert.ok(!spawned.args.includes('--replace-host'),
      `the host is adopted, not replaced: ${spawned.args.join(' ')}`);
  } finally { await rm(w.dir, { recursive: true, force: true }); }
});

test('the report says what closes, so a vanishing editor window is predicted rather than surprising', async () => {
  const w = await workspace();
  try {
    const value = await restart(w.stateDir, {
      ...options(w),
      stop: pid => ({ pid, outcome: 'stopped on SIGTERM' }),
      released: async () => true,
      launch: false,
    });
    const text = report(value);
    assert.match(text, /Supervisor PID 200: stopped on SIGTERM, closing 1 managed desktop window/);
  } finally { await rm(w.dir, { recursive: true, force: true }); }
});

test('the command line is the only entry point, and --plan signals nothing', async () => {
  const w = await workspace();
  try {
    // The action invokes this file as a program. An earlier version had the wizard import it and
    // pass its own path as argv[1], which made the entry-point check below fire and print usage
    // instead of doing the work — a failure that only appeared when the real action ran.
    const failed = await run(process.execPath, [TOOL, '--state', w.stateDir, '--plan']).catch(error => error);
    assert.equal(failed.code, 1, `a directory with no live host exits 1, not with usage: ${failed.stdout ?? ''}${failed.stderr ?? ''}`);
    assert.match(failed.stderr, /No live session host/);
    assert.doesNotMatch(`${failed.stdout}${failed.stderr}`, /Usage:/, 'it understood its own arguments');

    const usage = await run(process.execPath, [TOOL]).catch(error => error);
    assert.equal(usage.code, 2);
    assert.match(usage.stderr, /--state DIR/, 'and says how to call it when it is called with nothing');
  } finally { await rm(w.dir, { recursive: true, force: true }); }
});
