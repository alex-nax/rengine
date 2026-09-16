/* D61 (KI-103): the store belongs to the state directory, not to whichever host is running.
 *
 * Moving a route into red-host moves the state it owns, and `store-client.mjs` spawns its own
 * service per host process — so a front door serving `/api/tree` while a JS backend still held the
 * same directory would be two in-memory owners of one set of files. This is the shape red-pty
 * already runs under D60, applied to the store: one service, every host attaching.
 *
 * What has to be true, and is asserted here: two clients on one directory see ONE service and each
 * other's writes, the token gates it, a protocol mismatch is refused, and closing a client leaves
 * the store running because it is the directory's rather than that client's.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceStore } from './store-client.mjs';
import { built } from './cargo.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function directory(t, { idleSeconds = 600 } = {}) {
  const where = await mkdtemp(path.join(tmpdir(), 'rengine-store-service-'));
  process.env.RED_STORE_IDLE_SECONDS = String(idleSeconds);
  t.after(async () => {
    try {
      const descriptor = JSON.parse(await readFile(path.join(where, 'store.json'), 'utf8'));
      if (Number.isSafeInteger(descriptor.pid)) { try { process.kill(descriptor.pid, 'SIGKILL'); } catch { /* gone */ } }
    } catch { /* none left */ }
    delete process.env.RED_STORE_IDLE_SECONDS;
    await rm(where, { recursive: true, force: true });
  });
  return where;
}

test('two hosts on one state directory share one store', { timeout: 120000 }, async t => {
  await built('-p', 'red-store', '--bin', 'red-store-serve');
  const where = await directory(t);

  const first = await WorkspaceStore.attach(where);
  t.after(() => first.close());
  const second = await WorkspaceStore.attach(where);
  t.after(() => second.close());
  assert.equal(second.service.pid, first.service.pid, 'both attached to one service, not one each');
  assert.equal(second.service.instance, first.service.instance);
  /* The process table, not the descriptor: a second service that lost the race to write store.json
     is invisible to every reader of the file and still holds the same state in its own memory. */
  const { stdout } = await run('ps', ['-axo', 'pid=,args=']);
  const services = stdout.split('\n').filter(line => line.includes('red-store-serve') && line.includes(`--state ${where}`));
  assert.equal(services.length, 1, `exactly one red-store-serve serves the directory: ${services.join(' | ')}`);
  assert.ok(!existsSync(path.join(where, 'store-startup.lock')), 'the startup lock is released');

  /* The point of one owner: a root added through one client reaches the other. The service pushes
     the new state to every attached host, so the snapshot each one answers `root()` from converges
     — within a round trip, not instantly, which is the honest shape of two processes sharing one
     store and is why a host serves its own writes immediately and another host's a beat later. */
  const root = await first.addRoot(where);
  for (let waited = 0; waited < 5000 && !second.state.roots.some(item => item.id === root.id); waited += 25) await pause(25);
  const seen = await second.root(root.id);
  assert.equal(seen.path, root.path, 'the second host sees what the first wrote');

  /* Closing one client leaves the store running: it is the directory's. */
  const service = first.service.pid;
  await first.close();
  await pause(100);
  assert.ok(alive(service), 'the service outlives the client that started it');
  assert.equal((await second.root(root.id)).path, root.path, 'and the other host keeps working');
});

test('nothing reaches the store without the descriptor token', { timeout: 120000 }, async t => {
  await built('-p', 'red-store', '--bin', 'red-store-serve');
  const where = await directory(t);
  const store = await WorkspaceStore.attach(where);
  t.after(() => store.close());
  const descriptor = JSON.parse(await readFile(path.join(where, 'store.json'), 'utf8'));
  const port = Number(/:(\d+)$/.exec(descriptor.url)[1]);

  const ask = request => new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let text = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('no answer')); }, 2000);
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => {
      text += chunk;
      if (!text.includes('\n')) return;
      clearTimeout(timer); socket.destroy(); resolve(JSON.parse(text.split('\n')[0]));
    });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
  });

  const wrong = await ask({ id: 1, method: 'attach', args: [{ token: 'f'.repeat(64), protocol: 1 }] });
  assert.ok(wrong.error, `a wrong token is refused, never served: ${JSON.stringify(wrong.result ?? wrong)}`);
  assert.equal(wrong.error.status, 401);
  const unattached = await ask({ id: 1, method: 'state' });
  assert.ok(unattached.error, 'and a call before any attach is refused');
  assert.equal(unattached.error.status, 401);
  const mismatch = await ask({ id: 1, method: 'attach', args: [{ token: descriptor.token, protocol: 99 }] });
  assert.equal(mismatch.error.status, 409, 'the right token with the wrong protocol is a conflict, not a refusal to know you');
  assert.match(mismatch.error.message, /speaks protocol 1; the client asked for 99/);
});

test('an idle store reaps itself, because its state is on disk', { timeout: 120000 }, async t => {
  await built('-p', 'red-store', '--bin', 'red-store-serve');
  const where = await directory(t, { idleSeconds: 1 });
  const store = await WorkspaceStore.attach(where);
  const root = await store.addRoot(where);
  const service = store.service.pid;
  await store.close();
  for (let waited = 0; waited < 8000 && alive(service); waited += 100) await pause(100);
  assert.ok(!alive(service), 'a store nobody is attached to goes away — unlike a PTY service holding a shell');
  assert.ok(!existsSync(path.join(where, 'store.json')), 'and it removed its own descriptor');

  /* And what it was holding was never the point: the next attach reads the same state off disk. */
  const again = await WorkspaceStore.attach(where);
  t.after(() => again.close());
  assert.ok(again.state.roots.some(item => item.id === root.id), 'the root survived the service that wrote it');
});
