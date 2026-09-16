/* F152 (spec 129, charter D57): `red-host` serves a workspace with nothing behind it.
 *
 * The door was built to answer what it owns and forward the rest, one row at a time, until the
 * forwarder had nothing left to forward. This asserts that it has arrived: a `red-host` started with
 * **no `--backend` at all** starts the state directory's own services, publishes `sidecar.json`,
 * and answers the routes a workspace is made of — projects, files, drafts, panes, the board, the
 * declaration, and the socket a desktop registers on.
 *
 * The measurement that prompted it: with the forwarder instrumented, a full `npm test` run forwarded
 * ZERO requests. The JS host was answering nothing and had not been for some time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { request } from './sidecar.mjs';
import { endStateServices } from './state-services.mjs';
import { built } from './cargo.mjs';

async function startHost(stateDir) {
  const binary = process.env.RENGINE_RED_HOST || path.resolve('red/target/debug/red-host');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const child = spawn(binary, ['--state', stateDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let said = '', diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  const announced = await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { said += chunk; if (said.includes('\n')) resolve(JSON.parse(said.split('\n')[0])); });
    child.once('exit', code => reject(new Error(`red-host exited ${code}: ${diagnostics}`)));
    setTimeout(() => reject(new Error(`red-host did not announce itself: ${diagnostics}`)), 30000);
  });
  /* The credential is in the DESCRIPTOR, not in the announcement — which is the right shape: a
     token belongs in a 0600 file, and `discoverSidecar` is where every other consumer reads it. */
  const { readFile: read } = await import('node:fs/promises');
  const descriptor = JSON.parse(await read(path.join(stateDir, 'sidecar.json'), 'utf8'));
  return { ...announced, token: descriptor.token, child, diagnostics: () => diagnostics,
    close: () => new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000); }) };
}

test('red-host is the whole workspace, with no JavaScript behind it', { timeout: 120000 }, async t => {
  await built('--bins');
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-standalone-'));
  const project = path.join(directory, 'project');
  await mkdir(project);
  await writeFile(path.join(project, 'note.txt'), 'on disk\n');
  const stateDir = path.join(directory, 'state');
  let host;
  t.after(async () => {
    await host?.close();
    await endStateServices(stateDir);
    await rm(directory, { recursive: true, force: true });
  });

  host = await startHost(stateDir);
  assert.match(host.url, /^http:\/\/127\.0\.0\.1:\d+$/);

  /* The descriptor every consumer reads, written by the door itself. */
  const descriptor = JSON.parse(await readFile(path.join(stateDir, 'sidecar.json'), 'utf8'));
  assert.equal(descriptor.pid, host.pid, 'and it names this process, because there is no other');
  assert.equal(descriptor.instance, host.instance);
  assert.equal((await fetch(`${host.url}/health`).then(read => read.json())).protocol, 1);

  /* The services it STARTED, rather than waited for somebody else to. */
  for (const name of ['store', 'pty']) {
    const service = JSON.parse(await readFile(path.join(stateDir, `${name}.json`), 'utf8'));
    assert.ok(service.url.startsWith('tcp://'), `${name}: ${service.url}`);
    assert.ok(service.pid > 0 && service.pid !== host.pid, `the ${name} service is its own process`);
  }

  /* A project, its tree, a file, and a draft: the store's half of a workspace. */
  const root = await request(host, 'roots', { path: project });
  assert.ok(root.id);
  const tree = await request(host, `tree?${new URLSearchParams({ rootId: root.id, path: '' })}`);
  assert.ok(tree.entries.some(entry => entry.name === 'note.txt'), JSON.stringify(tree));
  assert.equal((await request(host, `file?${new URLSearchParams({ rootId: root.id, path: 'note.txt' })}`)).text, 'on disk\n');
  await request(host, 'draft', { rootId: root.id, path: 'note.txt', text: 'edited\n' });
  const state = await request(host, 'state');
  assert.equal(state.instance, host.instance);
  assert.equal(state.roots.length, 1);
  assert.equal(state.drafts.length, 1, 'the draft is in the state a desktop reads');

  /* A pane, which is the PTY service's half. */
  const pane = await request(host, 'terminal', { rootId: root.id, command: process.execPath,
    args: ['-e', "process.stdout.write('STANDALONE_READY\\n'); setInterval(() => {}, 1000);"] });
  assert.ok(pane.id);
  for (let waited = 0; waited < 10000; waited += 50) {
    const seen = await request(host, `session?${new URLSearchParams({ id: pane.id, output: 'true' })}`);
    if (seen.output?.includes('STANDALONE_READY')) break;
    await delay(50);
  }
  const snapshot = await request(host, `session?${new URLSearchParams({ id: pane.id, output: 'true' })}`);
  assert.match(snapshot.output, /STANDALONE_READY/, 'the pane this door started is running and talking');

  /* What the project declares, which is red-project's half. */
  const board = await request(host, `dashboard?${new URLSearchParams({ rootId: root.id })}`);
  assert.ok(Array.isArray(board.groups), JSON.stringify(board));

  /* The socket a desktop registers on. */
  const socket = new WebSocket(`${host.url.replace('http', 'ws')}/events?token=${host.token}`);
  const frames = [];
  socket.on('message', bytes => frames.push(JSON.parse(bytes)));
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'desktop-register', rootIds: [root.id], sessionIds: [], canReload: true }));
  for (let waited = 0; waited < 10000 && !frames.some(frame => frame.type === 'desktop-registered'); waited += 50) await delay(50);
  assert.ok(frames.some(frame => frame.type === 'desktop-registered'), JSON.stringify(frames));
  assert.equal((await request(host, `desktops?${new URLSearchParams({ rootId: root.id })}`)).desktops.length, 1);
  socket.close();

  /* And a route nobody serves is refused HERE, in the words the JS host refused it with — there is
     nothing behind this process to hand it to. */
  const unknown = await fetch(`${host.url}/api/nothing-like-this`, { headers: { authorization: `Bearer ${host.token}` } });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, 'Unknown workspace endpoint.');
  const web = await fetch(`${host.url}/index.html`, { headers: { authorization: `Bearer ${host.token}` } });
  assert.equal((await web.json()).error, 'No web client is installed. Use the native desktop.');

  await request(host, 'stop', { id: pane.id });
});
