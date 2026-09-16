/* F189/F152 (spec 129): the workspace a launcher starts IS red-host, and nothing else.
 *
 * Every other spec in this suite starts a host in process and drives it directly, which is the right
 * shape for testing what that host does and says nothing about what a person's workspace actually
 * runs. This one starts a workspace the way `launch.mjs`, the desktop and the MCP all start one —
 * `ensureSidecar` on a state directory — and asks what is answering.
 *
 * It used to be a PAIR: the Rust door on the port with a JS host behind it for the routes that had
 * not moved. They had all moved. With the forwarder instrumented, a full suite run forwarded zero
 * requests, so the door now runs with no backend at all and this asserts the shape that leaves —
 * one process, its own services, and no Node anywhere near the workspace.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureSidecar, request, alive } from '../launcher/sidecar.mjs';
import { endStateServices } from './state-services.mjs';
import { built } from './cargo.mjs';

const run = promisify(execFile);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/* The process table, because the claim is about which processes exist: a descriptor can say
   anything, and what matters is what is listening. */
async function processes(directory) {
  const { stdout } = await run('ps', ['-axo', 'pid=,args=']);
  return stdout.split('\n').filter(line => line.includes(directory) && !line.includes('ps -axo'))
    .map(line => ({ pid: Number(line.trim().split(/\s+/)[0]), command: line }));
}
const doors = async directory => (await processes(directory)).filter(entry => entry.command.includes('red-host --state'));

async function workspace(t, env = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-cutover-'));
  const stateDir = path.join(directory, 'state');
  t.after(async () => {
    for (const entry of await processes(directory)) { try { process.kill(entry.pid, 'SIGKILL'); } catch { /* gone */ } }
    await endStateServices(stateDir);
    await rm(directory, { recursive: true, force: true });
  });
  const before = process.env.RENGINE_RED_HOST;
  Object.assign(process.env, env);
  try { return { directory, stateDir, instance: await ensureSidecar(stateDir) }; }
  finally { if (before === undefined) delete process.env.RENGINE_RED_HOST; else process.env.RENGINE_RED_HOST = before; }
}

test('the workspace a launcher starts is red-host, and there is nothing behind it', { timeout: 120000 }, async t => {
  await built('-p', 'red-host', '--bin', 'red-host');
  const { directory, stateDir, instance } = await workspace(t);

  /* The descriptor names the process the launcher started — the one `replace.mjs` stops and
     `discoverSidecar` asks about — and it is the process answering, because there is only one. */
  assert.ok(alive(instance.pid), 'the workspace names a live process');
  const state = await request(instance, 'state');
  assert.equal(state.instance, instance.instance, 'and the identity the descriptor carries is the one answering');
  assert.equal(state.pid, instance.pid, 'the process answering IS the process the launcher started');
  const running = await doors(stateDir);
  assert.equal(running.length, 1, `exactly one host serves this directory: ${JSON.stringify(running.map(d => d.pid))}`);
  assert.equal(running[0].pid, instance.pid);

  /* No Node anywhere near this workspace. That is the whole claim of the row: the JS host is not
     started, not waited for, and not there. */
  const node = (await processes(directory)).filter(entry => /server\/main\.mjs/.test(entry.command));
  assert.deepEqual(node, [], `no JavaScript host serves this workspace: ${JSON.stringify(node)}`);

  /* Routes from every half of what a workspace is, through the one port a client knows about: the
     store's, the project's, and the panes'. Each used to be a different process. */
  const root = await request(instance, 'roots', { path: directory });
  assert.ok((await request(instance, `tree?rootId=${root.id}&path=`)).entries.length >= 1, 'the store');
  assert.deepEqual(await request(instance, `dashboard?rootId=${root.id}`),
    { rootId: root.id, declared: false, groups: [] }, 'what the project declares');
  assert.deepEqual((await request(instance, `desktops?rootId=${root.id}`)).desktops, [], 'and the desktops on its socket');

  /* Stopping it stops the workspace. Its services are the state directory's and outlive it by
     design (charter D60/D61), which is why they are not asserted gone here. */
  process.kill(instance.pid, 'SIGKILL');
  for (let waited = 0; waited < 8000 && (await doors(stateDir)).length; waited += 100) await delay(100);
  assert.deepEqual(await doors(stateDir), [], 'the host is gone with the process that was signalled');
});

/* And what happens without it. red-host IS the workspace now, so a checkout that has not built it
 * has no workspace at all — and the launcher says which binary is missing and how to make one,
 * rather than publishing a descriptor for something that is not there. */
test('a checkout with no red-host refuses to serve a workspace, by name', { timeout: 120000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-cutover-none-'));
  const stateDir = path.join(directory, 'state');
  t.after(async () => {
    for (const entry of await processes(directory)) { try { process.kill(entry.pid, 'SIGKILL'); } catch { /* gone */ } }
    await endStateServices(stateDir);
    await rm(directory, { recursive: true, force: true });
  });
  const before = process.env.RENGINE_RED_HOST;
  process.env.RENGINE_RED_HOST = path.join(tmpdir(), 'no-such-red-host');
  try {
    /* Refused BEFORE anything is started, and by name: the sentence carries the command that makes
       the missing binary, because this is the failure a person meets out of a fresh clone. */
    await assert.rejects(ensureSidecar(stateDir), /RENGINE_RED_HOST names .*which does not exist/,
      'the launcher does not get a workspace');
  } finally { if (before === undefined) delete process.env.RENGINE_RED_HOST; else process.env.RENGINE_RED_HOST = before; }
  assert.deepEqual(await doors(stateDir), []);
  assert.equal(existsSync(path.join(stateDir, 'sidecar.json')), false, 'with no descriptor left behind');
});
