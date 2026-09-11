/* F140 criterion 1: every proto shape the façade v1 emits, validated against the LIVE host.
 *
 * The owner chose a schema-first wire contract over mirroring the host's JSON (spec 128, decision
 * 5), accepting that two descriptions of one API can drift. This is the control that makes that
 * safe, and it only works if the JSON it judges is real: so this starts an actual session host,
 * makes a root, spawns a terminal, reads the feed, and hands what came back to `red-contract`,
 * which refuses anything red.v1 cannot carry — including a field the host sends that the contract
 * does not model, because that is precisely what a host gaining a feature looks like.
 *
 * The Rust end owns the only question Rust can answer; this end owns the live workspace.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startServer } from '../server/main.mjs';
import { startWorker } from '../runtime/worker.mjs';
import { ok } from './token-fixtures.mjs';
import { taskDeclaration, taskProject } from './task-fixtures.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

/* Built by the same cargo workspace the desktop build drives; `cargo build` rather than a path into
   .cache/desktop so this spec stands on its own when someone runs it alone. */
async function checker() {
  await run('cargo', ['build', '-p', 'red-core', '--bin', 'red-contract'],
            { cwd: path.join(ROOT, 'red'), maxBuffer: 1 << 24 });
  const binary = path.join(ROOT, 'red/target/debug/red-contract');
  assert.ok(existsSync(binary), `red-contract was built at ${binary}`);
  return binary;
}

async function bundleFrom(server, worker, root, shell) {
  const get = async p => {
    const response = await fetch(`${server.url}${p}`, { headers: { authorization: `Bearer ${server.token}` } });
    assert.equal(response.status, 200, `${p} answered`);
    return response.json();
  };
  /* The feed is the half a request cannot show: hello on connect, then a session event and the
     terminal's own output. Collected from a real socket, not synthesised. */
  const feed = [];
  const socket = new WebSocket(`${server.url.replace('http', 'ws')}/events?token=${server.token}`);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.on('message', bytes => { try { feed.push(JSON.parse(bytes.toString())); } catch { /* not ours */ } });
  socket.send(JSON.stringify({ type: 'attach', id: shell.id }));
  server.sessions.input(shell.id, "printf 'contract\\n'\n");
  for (let i = 0; i < 80 && feed.length < 3; i++) await new Promise(r => setTimeout(r, 50));
  socket.close();

  /* Tasks, the token and the agent registry are served by the runtime worker rather than the
     session host — the façade spans both, so the contract has to be judged against both. */
  return {
    workspace: await get('/api/state'),
    dashboard: await get(`/api/dashboard?rootId=${root.id}`),
    tasks: await ok(worker, `tracker?rootId=${root.id}`),
    token: await ok(worker, `token?rootId=${root.id}`),
    agents: await ok(worker, `agents-menu?rootId=${root.id}`),
    feed,
  };
}

test('every red.v1 shape the façade emits still matches the live session host', { timeout: 600000 }, async () => {
  const binary = await checker();
  const dir = await mkdtemp(path.join(tmpdir(), 'red-contract-'));
  /* The suite's own declared-project fixture: a contract-6 declaration with a local inventory and a
     dashboard, so the tracker, the dashboard and the agent menu answer with real rows. A contract
     validated only against empty answers would have validated almost nothing. */
  const project = await taskProject(dir, 'project', taskDeclaration({
    dashboard: { title: 'Contract fixture', groups: [{ id: 'verify', title: 'Verify', actions: [
      { id: 'echo', title: 'Echo', description: 'Says hello.', kind: 'script', script: 'say.sh', args: ['hello'] },
    ] }] },
  }));
  await writeFile(path.join(project, 'note.txt'), 'contract\n');
  await writeFile(path.join(project, 'say.sh'), '#!/bin/sh\necho hello\n');
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const worker = await startWorker({ url: server.url, token: server.token, instance: server.instance },
                                   { directory: path.join(dir, 'runtime') });
  try {
    const root = await server.store.addRoot(project);
    const shell = await server.sessions.terminal({
      rootId: root.id, command: '/bin/bash', args: ['--noprofile', '--norc'], env: { PS1: 'contract$ ' },
    });
    /* A session that has ENDED, as well as one that is running. Found by the sabotage pass: renaming
       the host's 'exited' state changed nothing, because a fixture whose only session is alive never
       emits the other half of the enum — so the contract's knowledge of it was never tested. */
    const ended = await server.sessions.terminal({ rootId: root.id, command: '/bin/sh', args: ['-c', 'exit 0'] });
    /* Waits for "no longer running" rather than for the word the host uses, so a host that renames
       the state reaches the CHECKER and is reported as an enum the contract does not know — which is
       the reason this test should go red for, not a fixture precondition failing first. */
    for (let i = 0; i < 200 && server.sessions.snapshot(ended.id)?.state === 'running'; i++)
      await new Promise(r => setTimeout(r, 25));
    assert.notEqual(server.sessions.snapshot(ended.id).state, 'running', 'the short-lived session ended');
    const bundle = await bundleFrom(server, worker, root, shell);

    /* A section the harness forgot to capture is a section the checker silently never judges, so
       the sections are named here rather than inferred from whatever the bundle happens to hold. */
    for (const section of ['workspace', 'dashboard', 'tasks', 'token', 'agents', 'feed']) {
      assert.ok(bundle[section], `the bundle carries the live ${section} the contract models`);
    }
    assert.ok(bundle.feed.length > 0, 'the live feed produced events to judge');
    assert.ok(bundle.workspace.sessions.length > 0, 'the live host reported the session it spawned');
    const states = new Set(bundle.workspace.sessions.map(session => session.state));
    assert.equal(states.size, 2,
      `the live host produced both of the session states the contract models, not just one: ${[...states]}`);
    assert.ok(bundle.tasks.rows.length > 0, 'the tracker answered with real rows');
    assert.ok(bundle.agents.agents.length > 0, 'the agent registry answered with the CLIs it knows');
    assert.ok(bundle.dashboard.groups.length > 0, 'the declared dashboard answered with its groups');
    console.log(`red-contract: judged ${bundle.feed.length} feed event(s), ` +
                `${bundle.workspace.sessions.length} session(s), ${bundle.tasks.rows.length} task row(s), ` +
                `${bundle.agents.agents.length} agent recipe(s), ${bundle.dashboard.groups.length} dashboard group(s)`);

    const file = path.join(dir, 'bundle.json');
    await writeFile(file, JSON.stringify(bundle, null, 1));
    const { stdout } = await run(binary, [file], { maxBuffer: 1 << 24 });
    console.log(`red-contract: ${stdout.trim()}`);

    await server.sessions.stop(shell.id).catch(() => {});
  } finally {
    await worker.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the checker refuses a bundle it could not judge, rather than passing it', async () => {
  const binary = await checker();
  const dir = await mkdtemp(path.join(tmpdir(), 'red-contract-empty-'));
  try {
    /* A bundle carrying nothing this contract knows is the failure mode a green report hides: the
       harness ran, examined no shape, and said nothing was wrong. */
    const file = path.join(dir, 'empty.json');
    await writeFile(file, JSON.stringify({ somethingElse: 1 }));
    const failure = await run(binary, [file]).then(() => null, error => error);
    assert.ok(failure, 'a bundle with no known shape is refused');
    assert.equal(failure.code, 2);
    assert.match(`${failure.stderr}`, /examined nothing is not a pass/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
