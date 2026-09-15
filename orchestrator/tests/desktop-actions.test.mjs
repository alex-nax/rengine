import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceStore } from '../server/store-client.mjs';
import { Desktops } from '../server/desktops.mjs';
import { built } from './cargo.mjs';

/* This spec drives a Rust binary through a service client, so it builds one first: run alone — or
   used to check that a regression fails for its own reason — it would otherwise judge whatever
   binary happened to be on disk, and a sabotage that is never compiled always passes. `npm test`
   prebuilds and this is a no-op there (orchestrator/tests/cargo.mjs). */
before(() => built('--bins'));


test('desktop actions require an explicit root-bound live target and matching acknowledgement', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-desktops-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'a')); await mkdir(path.join(dir, 'b'));
  const store = await WorkspaceStore.open(path.join(dir, 'state'));
  const a = await store.addRoot(path.join(dir, 'a')), b = await store.addRoot(path.join(dir, 'b'));
  const desktops = new Desktops(store, { snapshot: () => ({ rootId: b.id }) }, 25);
  const client = new EventEmitter(), other = new EventEmitter();
  const messages = []; client.send = text => messages.push(JSON.parse(text)); other.send = () => {};
  assert.throws(() => desktops.register(client, { rootIds: [a.id], sessionIds: ['foreign'] }), /different root/);
  desktops.register(client, { rootIds: [a.id], sessionIds: [], canReload: false });
  const [{ id }] = desktops.list(a.id); assert.deepEqual(desktops.list(b.id), []);
  assert.throws(() => desktops.reload(a.id, id), /reload-capable/);
  desktops.register(client, { rootIds: [a.id], sessionIds: [], canReload: true });
  assert.equal(desktops.list(a.id)[0].id, id);
  assert.throws(() => desktops.reload(b.id, id), /not attached/);
  const pending = desktops.reload(a.id, id), request = messages.at(-1);
  assert.throws(() => desktops.reload(a.id, id), /already pending/);
  assert.throws(() => desktops.acknowledge(other, { requestId: request.requestId, accepted: true }), /Unknown/);
  desktops.acknowledge(client, { requestId: request.requestId, accepted: true });
  assert.equal((await pending).status, 'accepted');
  assert.throws(() => desktops.acknowledge(client, { requestId: request.requestId, accepted: true }), /Unknown/);
  await assert.rejects(desktops.reload(a.id, id), /did not acknowledge/);
  const rejected = desktops.reload(a.id, id); desktops.acknowledge(client, { requestId: messages.at(-1).requestId, accepted: false });
  await assert.rejects(rejected, /rejected reload/);
  const disconnected = desktops.reload(a.id, id); client.emit('close');
  await assert.rejects(disconnected, /disconnected/); assert.deepEqual(desktops.list(a.id), []);
  assert.throws(() => desktops.reload(a.id, id), /not attached/);
});
