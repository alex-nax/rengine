/* F189 (F152b, spec 129): the workspace a launcher starts is served by red-host.
 *
 * Every other spec in this suite starts a host IN PROCESS and drives it directly, which is the
 * right shape for testing what that host does and says nothing about what a person's workspace
 * actually runs. This one starts a workspace the way `launch.mjs`, the desktop and the MCP all
 * start one — `ensureSidecar` on a state directory — and asks what is answering.
 *
 * The answer has to be the pair: the Rust door on the port, the JS host behind it for the routes
 * F153–F156 have not moved, and one process the launcher can name for both. Before this, red-host
 * existed and no workspace ran it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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

test('the workspace a launcher starts is answered by red-host, with the JS host behind it', { timeout: 120000 }, async t => {
  await built('-p', 'red-host', '--bin', 'red-host');
  const { directory, stateDir, instance } = await workspace(t);

  /* The descriptor names the process the launcher started — the one `replace.mjs` stops and
     `discoverSidecar` asks about — and a url that is NOT that process's. */
  assert.ok(alive(instance.pid), 'the workspace names a live process');
  const state = await request(instance, 'state');
  assert.equal(state.instance, instance.instance, 'and the identity the descriptor carries is the one answering');
  assert.notEqual(state.pid, instance.pid, 'the process answering is not the process the launcher started');
  const running = await doors(stateDir);
  assert.equal(running.length, 1, `exactly one door serves this directory: ${JSON.stringify(running.map(d => d.pid))}`);
  assert.equal(running[0].pid, state.pid, 'and it is the process answering');
  assert.ok((await processes(directory)).some(entry => entry.command.includes('server/main.mjs')),
    'with the JS host still behind it, for the routes that have not moved');

  /* Both halves are really in the path: a route the door owns and a route it forwards both answer
     through the one port a client knows about. */
  const root = await request(instance, 'roots', { path: directory });
  assert.equal((await request(instance, `tree?rootId=${root.id}&path=`)).entries.length >= 1, true, 'a route the door owns');
  /* `dashboard` is one of the thirteen F153–F156 still own, so this answer came from behind the
     door — through it, in the JS host's own words, for a project that declares nothing. */
  const forwarded = await request(instance, `dashboard?rootId=${root.id}`);
  assert.deepEqual(forwarded, { rootId: root.id, declared: false, groups: [] }, 'and one it forwards');

  /* The pair lives and dies together. A door left behind would answer `/health` and every route it
     owns for a backend that is gone, which reads as a healthy workspace to everything that asks. */
  process.kill(instance.pid, 'SIGKILL');
  for (let waited = 0; waited < 8000 && (await doors(stateDir)).length; waited += 100) await delay(100);
  assert.deepEqual(await doors(stateDir), [], 'the door stops with the host it fronts');
});

test('a checkout with no red-host still starts a workspace, and says so', { timeout: 120000 }, async t => {
  const { directory, stateDir, instance } = await workspace(t, { RENGINE_RED_HOST: path.join(tmpdir(), 'no-such-red-host') });
  const state = await request(instance, 'state');
  /* Served by the JS host itself: one process, and it is the one the descriptor names. */
  assert.equal(state.pid, instance.pid, 'the workspace is the JS host alone');
  assert.deepEqual(await doors(stateDir), [], 'with no door');
  assert.ok((await processes(directory)).some(entry => entry.command.includes('server/main.mjs')));
  const root = await request(instance, 'roots', { path: directory });
  assert.ok(Array.isArray((await request(instance, `tree?rootId=${root.id}&path=`)).entries), 'and it answers everything itself');
});
