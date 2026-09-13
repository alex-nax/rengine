/* F180 (F141a, spec 128 decisions 2 and 4, KI-098): the façade serves the v0.1 read surface over
 * libp2p, and it does it through a circuit relay because there is no other way in.
 *
 * "Forbidden any direct connection" is a property of the façade here, not a rule this test is
 * trusted to follow: `red-link attach` opens no TCP listener at all, so its only address is a
 * circuit through the relay. The relay's own reservation and circuit events are the proof that the
 * bytes took that path, and they are asserted — a test that only checked the answers would pass
 * just as happily over a direct connection nobody noticed.
 *
 * The workspace behind the façade is real: a session host and a root-bound worker, the same pair
 * F140's contract harness starts, because the read surface genuinely spans both processes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/main.mjs';
import { startWorker } from '../runtime/worker.mjs';
import { identity, ok } from './token-fixtures.mjs';
import { taskDeclaration, taskProject } from './task-fixtures.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const BINARY = path.join(ROOT, 'red/target/debug/red-link');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/* One long-lived red-link process, with its JSON lines collected as they arrive. */
function launch(t, args) {
  const child = spawn(BINARY, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  const errors = [];
  let pending = '';
  child.stdout.on('data', chunk => {
    pending += chunk;
    const parts = pending.split('\n');
    pending = parts.pop();
    for (const part of parts) { if (part.trim()) { try { lines.push(JSON.parse(part)); } catch { errors.push(part); } } }
  });
  child.stderr.on('data', chunk => errors.push(String(chunk)));
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
  const waitFor = async (predicate, what, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const found = lines.find(predicate);
      if (found) return found;
      if (child.exitCode !== null) throw new Error(`red-link ${args[0]} exited (${child.exitCode}) before ${what}: ${errors.join(' ')}`);
      if (Date.now() > deadline) throw new Error(`red-link ${args[0]} never said ${what}: ${JSON.stringify(lines)} ${errors.join(' ')}`);
      await delay(25);
    }
  };
  return { child, lines, errors, waitFor };
}

const sidecar = (stateDir, server) => writeFile(path.join(stateDir, 'sidecar.json'),
  JSON.stringify({ url: server.url, token: server.token, instance: server.instance, pid: process.pid }), { mode: 0o600 });

/* prost renders a oneof as `{"response": {"<Variant>": {…}}}`, so the section name is capitalised
   on the wire exactly once, here, rather than in five assertions. */
async function probe(args, section) {
  const { stdout } = await run(BINARY, args, { maxBuffer: 1 << 24 });
  const answer = JSON.parse(stdout.trim().split('\n').pop());
  const variant = section.charAt(0).toUpperCase() + section.slice(1);
  assert.ok(answer.response?.[variant], `the answer carries the ${section} it was asked for: ${JSON.stringify(answer)}`);
  return answer.response[variant];
}

test('a client with no direct path completes the v0.1 read surface through circuit-relay v2', { timeout: 600000 }, async t => {
  await run('cargo', ['build', '-p', 'red-link', '--bin', 'red-link'], { cwd: path.join(ROOT, 'red'), maxBuffer: 1 << 24 });
  assert.ok(existsSync(BINARY), `red-link was built at ${BINARY}`);

  const dir = await mkdtemp(path.join(tmpdir(), 'red-link-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = await taskProject(dir, 'project', taskDeclaration({
    dashboard: { title: 'Façade fixture', groups: [{ id: 'verify', title: 'Verify', actions: [
      { id: 'echo', title: 'Echo', description: 'Says hello.', kind: 'script', script: 'say.sh', args: ['hello'] },
    ] }] },
  }));
  await writeFile(path.join(project, 'say.sh'), '#!/bin/sh\necho hello\n');
  const stateDir = path.join(dir, 'state');
  const server = await startServer({ stateDir });
  const worker = await startWorker({ url: server.url, token: server.token, instance: server.instance },
                                   { directory: path.join(dir, 'runtime') });
  t.after(async () => { await worker.close?.(); await server.close(); });
  /* The descriptor the host writes at startup when it is a process rather than an import: the
     façade reads it the way every other consumer does, so the discovery path is under test too. */
  await sidecar(stateDir, server);
  const root = await server.store.addRoot(project);
  await server.sessions.terminal({ rootId: root.id, command: '/bin/bash', args: ['--noprofile', '--norc'] });

  /* The relay first: it prints the address it listens on and the peer id that addresses it. */
  const relay = launch(t, ['relay', '--listen', '/ip4/127.0.0.1/tcp/0']);
  const listening = await relay.waitFor(line => line.role === 'relay' && line.listen, 'where it listens');
  const relayAddress = `${listening.listen}/p2p/${listening.peer}`;

  /* Then the façade, which listens on nothing but a circuit through that relay. */
  const facade = launch(t, ['attach', '--state', stateDir, '--worker', worker.url, '--worker-token', worker.token,
    '--relay', relayAddress]);
  const identity = await facade.waitFor(line => line.role === 'facade', 'which peer it is');
  await facade.waitFor(line => line.event === 'listening' && line.address.includes('p2p-circuit'),
    'that it is listening through the relay');
  const addresses = facade.lines.filter(line => line.event === 'listening').map(line => line.address);
  assert.ok(addresses.every(address => address.includes('p2p-circuit')),
    `the façade has no direct address for anyone to dial: ${addresses.join(', ')}`);
  await relay.waitFor(line => line.event === 'reservation' && line.peer === identity.peer,
    'that the façade reserved a slot');

  /* The read surface, one section at a time, each compared with what the workspace itself says. */
  const ask = (section, extra = []) =>
    probe(['probe', '--relay', relayAddress, '--peer', identity.peer, '--get', section, ...extra], section);
  const direct = async route => {
    const response = await fetch(`${server.url}${route}`, { headers: { authorization: `Bearer ${server.token}` } });
    assert.equal(response.status, 200, `${route} answered`);
    return response.json();
  };

  const workspace = await ask('workspace');
  const state = await direct('/api/state');
  assert.deepEqual(workspace.roots.map(item => item.id), state.roots.map(item => item.id), 'the same roots, in the same order');
  assert.deepEqual(workspace.sessions.map(item => item.id), state.sessions.map(item => item.id), 'the same sessions');
  assert.equal(workspace.instance, state.instance, 'the same workspace identity');

  const dashboard = await ask('dashboard', ['--root', root.id]);
  const liveDashboard = await direct(`/api/dashboard?rootId=${root.id}`);
  assert.deepEqual(dashboard.groups.map(group => group.id), liveDashboard.groups.map(group => group.id), 'the same dashboard groups');
  assert.deepEqual(dashboard.groups.flatMap(group => group.actions.map(action => action.id)),
    liveDashboard.groups.flatMap(group => group.actions.map(action => action.id)), 'the same actions');

  const tasks = await ask('tasks', ['--root', root.id]);
  const liveTasks = await ok(worker, `tracker?rootId=${root.id}`);
  assert.deepEqual(tasks.rows.map(row => row.key), liveTasks.rows.map(row => row.key), 'the same task rows');

  const token = await ask('token', ['--root', root.id]);
  const liveToken = await ok(worker, `token?rootId=${root.id}`);
  assert.equal(token.rootId ?? token.root_id ?? '', liveToken.rootId ?? '', 'the token is the one for this root');
  assert.equal(Boolean(token.holder), Boolean(liveToken.holder), 'held or not, the same way');

  const agents = await ask('agents', ['--root', root.id]);
  const liveAgents = await ok(worker, `agents-menu?rootId=${root.id}`);
  assert.deepEqual(agents.agents.map(item => item.name ?? item.agent), liveAgents.agents.map(item => item.name ?? item.agent),
    'the same CLIs the registry knows');

  /* And the relay saw every one of those answers go through it. */
  const circuits = relay.lines.filter(line => line.event === 'circuit' && line.dst === identity.peer);
  assert.ok(circuits.length >= 5,
    `every request crossed a relayed circuit, not a direct connection: ${circuits.length} circuit(s) for 5 requests`);
  const answered = facade.lines.filter(line => line.event === 'answered');
  assert.deepEqual(answered.map(line => line.request).sort(), ['agents', 'dashboard', 'tasks', 'token', 'workspace'],
    'the façade answered every section of the read surface');
  assert.ok(answered.every(line => line.refused === false), `nothing was refused: ${JSON.stringify(answered)}`);
});

test('the façade refuses what it cannot answer, in the workspace\'s own words', { timeout: 600000 }, async t => {
  await run('cargo', ['build', '-p', 'red-link', '--bin', 'red-link'], { cwd: path.join(ROOT, 'red'), maxBuffer: 1 << 24 });
  const dir = await mkdtemp(path.join(tmpdir(), 'red-link-refuse-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, 'state');
  const server = await startServer({ stateDir });
  const worker = await startWorker({ url: server.url, token: server.token, instance: server.instance },
                                   { directory: path.join(dir, 'runtime') });
  t.after(async () => { await worker.close?.(); await server.close(); });
  await sidecar(stateDir, server);

  const relay = launch(t, ['relay', '--listen', '/ip4/127.0.0.1/tcp/0']);
  const listening = await relay.waitFor(line => line.role === 'relay' && line.listen, 'where it listens');
  const relayAddress = `${listening.listen}/p2p/${listening.peer}`;
  const facade = launch(t, ['attach', '--state', stateDir, '--worker', worker.url, '--worker-token', worker.token,
    '--relay', relayAddress]);
  const identity = await facade.waitFor(line => line.role === 'facade', 'which peer it is');
  await facade.waitFor(line => line.event === 'listening', 'that it is listening');

  /* A root-scoped request with no root: refused by the façade before the workspace is asked. */
  await assert.rejects(
    () => probe(['probe', '--relay', relayAddress, '--peer', identity.peer, '--get', 'dashboard'], 'dashboard'),
    error => {
      assert.match(String(error.stderr ?? error.message), /named none/, 'the refusal says what was missing');
      return true;
    });

  /* A root the workspace does not have: refused in the host's own words, not a default answer. */
  await assert.rejects(
    () => probe(['probe', '--relay', relayAddress, '--peer', identity.peer, '--get', 'dashboard', '--root', 'no-such-root'], 'dashboard'),
    error => {
      assert.match(String(error.stderr ?? error.message), /the workspace answered 4\d\d/, 'the status the host gave');
      return true;
    });
  assert.ok(facade.lines.some(line => line.event === 'answered' && line.refused === true),
    'the façade recorded that it refused rather than reporting an answer');
});

/* F183 (F181b, KI-099): the lifecycle ring on a long-lived stream. Two claims in one run, because
 * they are one behaviour: the workspace replays the ring from the cursor the subscriber names, and
 * then keeps the SAME stream open for what happens next. A test that only replayed would pass over
 * a request-and-answer that closed; a test that only watched live frames would prove nothing about
 * the cursor. */
test('the lifecycle ring replays from a cursor and stays live on the same stream', { timeout: 600000 }, async t => {
  await run('cargo', ['build', '-p', 'red-link', '--bin', 'red-link'], { cwd: path.join(ROOT, 'red'), maxBuffer: 1 << 24 });
  const dir = await mkdtemp(path.join(tmpdir(), 'red-link-feed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = await taskProject(dir, 'project', taskDeclaration({}));
  const stateDir = path.join(dir, 'state');
  const server = await startServer({ stateDir });
  const worker = await startWorker({ url: server.url, token: server.token, instance: server.instance },
                                   { directory: path.join(dir, 'runtime') });
  t.after(async () => { await worker.close?.(); await server.close(); });
  await sidecar(stateDir, server);
  const root = await server.store.addRoot(project);

  const relay = launch(t, ['relay', '--listen', '/ip4/127.0.0.1/tcp/0']);
  const listening = await relay.waitFor(line => line.role === 'relay' && line.listen, 'where it listens');
  const relayAddress = `${listening.listen}/p2p/${listening.peer}`;
  const facade = launch(t, ['attach', '--state', stateDir, '--worker', worker.url, '--worker-token', worker.token,
    '--relay', relayAddress]);
  const facadePeer = await facade.waitFor(line => line.role === 'facade', 'which peer it is');
  await facade.waitFor(line => line.event === 'listening' && line.address.includes('p2p-circuit'), 'that it is listening');

  /* Three frames before anyone subscribes: the ring a late subscriber has to be given. */
  const alice = identity('feed-alice');
  await ok(worker, 'token-action', { rootId: root.id, action: 'contest', reason: 'the feed fixture claims it' }, alice);
  await ok(worker, 'task', { rootId: root.id, action: 'add', row: { id: 801, key: 'F801', description: 'before the subscription' } }, alice);
  await ok(worker, 'token-action', { rootId: root.id, action: 'release' }, alice);
  const before = await ok(worker, `feed?rootId=${root.id}`);
  assert.ok(before.frames.length >= 3, `the ring holds the frames the fixture made: ${before.frames.length}`);

  /* Subscribe from the very beginning, ask for one more than the ring holds, and then make one. */
  const wanted = before.frames.length + 1;
  const feed = launch(t, ['feed', '--relay', relayAddress, '--peer', facadePeer.peer, '--root', root.id,
    '--after', '0', '--count', String(wanted)]);
  await facade.waitFor(line => line.event === 'feed-open', 'that it opened the workspace feed');
  await feed.waitFor(line => line.sequence === before.frames[before.frames.length - 1].sequence,
    'that it replayed the ring up to the cursor');
  const live = await ok(worker, 'task', { rootId: root.id, action: 'add', row: { id: 802, key: 'F802', description: 'after the subscription' } });
  await feed.waitFor(line => line.sequence === live.sequence, 'that the frame made after the subscription arrived on the same stream');

  const seen = feed.lines.filter(line => Number.isSafeInteger(line.sequence));
  assert.ok(seen.length >= wanted, `every frame asked for arrived: ${seen.length} of ${wanted}`);
  const sequences = seen.map(line => line.sequence);
  assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b), `frames arrive in order: ${sequences}`);
  assert.equal(new Set(sequences).size, sequences.length, `no frame arrives twice: ${sequences}`);
  assert.deepEqual(sequences.slice(0, before.frames.length), before.frames.map(frame => frame.sequence),
    'the replay is the ring the workspace holds, in its own order');

  /* And the cursor is a cursor: a second subscriber that names one gets what comes after it, and
     nothing it has already seen. */
  const cursor = before.frames[0].sequence;
  const resumed = launch(t, ['feed', '--relay', relayAddress, '--peer', facadePeer.peer, '--root', root.id,
    '--after', String(cursor), '--count', '1']);
  const first = await resumed.waitFor(line => Number.isSafeInteger(line.sequence), 'its first frame');
  assert.equal(first.sequence, before.frames[1].sequence,
    `a subscriber resuming at ${cursor} is given the frame after it, not the one it already had`);
});
