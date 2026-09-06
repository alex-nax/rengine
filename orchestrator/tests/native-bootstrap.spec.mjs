import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { discoverRuntime, runtimeDirectory, ensureRuntime, alive } from '../runtime/discovery.mjs';
import { request } from '../launcher/sidecar.mjs';

test('the existing launcher reaches native bootstrap once, then CLI actions replace the managed desktop', { timeout: 60000 }, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-native-bootstrap-')));
  let host, runtime;
  try {
    const project = path.join(directory, 'project'), stateDir = path.join(directory, 'state'); await mkdir(project);
    const marker = path.join(project, 'once.txt'), fixture = path.join(project, 'cli.cjs');
    await writeFile(fixture, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'once\\n');
process.stdin.setRawMode(true); console.log('BOOTSTRAP_RETAINED_CLI'); process.stdin.on('data', data => console.log('INPUT_' + data.toString('hex')));`);
    host = await startServer({ stateDir });
    await writeFile(path.join(stateDir, 'sidecar.json'), JSON.stringify({ url: host.url, token: host.token, instance: host.instance, pid: process.pid }), { mode: 0o600 });
    const root = await host.store.addRoot(project);
    const session = await host.sessions.terminal({ rootId: root.id, command: process.execPath, args: [fixture] });
    const execute = promisify(execFile);
    const launch = () => execute(process.execPath, ['orchestrator/launch.mjs', '--project', project, '--state', stateDir, '--no-agent'], {
      timeout: 25000, env: { ...process.env, RENGINE_LAYERED_CHILD: undefined, RENGINE_NATIVE_BINARY: undefined } });
    const first = await launch(); assert.match(first.stdout, /update supervisor ready/);
    runtime = await discoverRuntime(host); assert.ok(runtime);
    let status = await request(runtime, `update-status?rootId=${root.id}`);
    assert.equal(status.desktops.length, 1); assert.equal(status.desktops[0].managed, true);
    const before = status.desktops[0]; assert.ok(alive(before.pid));
    const pair = await Promise.all([ensureRuntime(host, { initial: { root: root.id, terminal: session.id } }), launch()]);
    assert.equal(pair[0].pid, runtime.pid);
    status = await request(runtime, `update-status?rootId=${root.id}`);
    assert.equal(status.desktops.length, 1); assert.equal(status.desktops[0].pid, before.pid);
    const contextFile = path.join(directory, 'context.json');
    await writeFile(contextFile, JSON.stringify({ url: host.url, token: host.token, instance: host.instance, rootId: root.id }), { mode: 0o600 });
    const updated = await execute(process.execPath, ['orchestrator/runtime/client.mjs', 'update', '--context', contextFile,
      '--desktop', before.id, '--layers', 'workspace,desktop,connector'], { timeout: 30000 });
    assert.match(updated.stdout, /"status": "succeeded"/);
    status = await request(runtime, `update-status?rootId=${root.id}`);
    assert.equal(status.desktops.length, 1); assert.notEqual(status.desktops[0].pid, before.pid); assert.ok(alive(status.desktops[0].pid));
    assert.equal(host.sessions.snapshot(session.id).pid, session.pid); assert.equal(host.sessions.snapshot(session.id).state, 'running');
    assert.equal(await readFile(marker, 'utf8'), 'once\n');
    await request(runtime, 'input', { id: session.id, data: 'agent-driven' });
    for (let i = 0; i < 100 && !host.sessions.snapshot(session.id, true).output.includes('INPUT_6167656e742d64726976656e'); i++) await delay(20);
    assert.ok(host.sessions.snapshot(session.id, true).output.includes('INPUT_6167656e742d64726976656e'));
  } finally {
    if (!runtime && host) runtime = await discoverRuntime(host).catch(() => null);
    if (runtime) {
      process.kill(runtime.pid, 'SIGTERM');
      for (let i = 0; i < 100 && alive(runtime.pid); i++) await delay(25);
      assert.equal(alive(runtime.pid), false, 'isolated supervisor stopped');
    }
    await host?.close(); if (host) await rm(runtimeDirectory(host), { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test('native bootstrap opens an empty workspace without creating a terminal or agent', { timeout: 25000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-empty-bootstrap-'));
  let host, runtime;
  try {
    host = await startServer({ stateDir: directory });
    await writeFile(path.join(directory, 'sidecar.json'), JSON.stringify({ url: host.url, token: host.token, instance: host.instance, pid: process.pid }), { mode: 0o600 });
    const result = await promisify(execFile)(process.execPath, ['orchestrator/launch.mjs', '--state', directory, '--no-agent'], {
      timeout: 20000, env: { ...process.env, RENGINE_LAYERED_CHILD: undefined, RENGINE_NATIVE_BINARY: undefined } });
    assert.match(result.stdout, /update supervisor ready/);
    runtime = await discoverRuntime(host); assert.ok(runtime);
    const presence = await request(runtime, 'runtime-desktops');
    assert.equal(presence.desktops.length, 1); assert.deepEqual(presence.desktops[0].rootIds, []);
    assert.deepEqual(host.sessions.list(), []);
  } finally {
    if (!runtime && host) runtime = await discoverRuntime(host).catch(() => null);
    if (runtime) { process.kill(runtime.pid, 'SIGTERM'); for (let i = 0; i < 100 && alive(runtime.pid); i++) await delay(25); }
    await host?.close(); if (host) await rm(runtimeDirectory(host), { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
