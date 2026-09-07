import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceStore, fail } from '../server/store.mjs';
import { Desktops } from '../server/desktops.mjs';
import { startServer } from '../server/main.mjs';
import { startWorker, withoutEndedSessions } from '../runtime/worker.mjs';
import { fakeDesktop, ok } from './token-fixtures.mjs';

/* What a replaced session host leaves behind (spec 098). The desktop's saved layout outlives the
   process whose sessions it names, so the first registration after `--replace-host` advertises ids
   the new host has never heard of. Refusing that frame leaves the desktop unregistered and the whole
   runtime layer invisible; these are the two server-side halves of not doing that. */

const RESTING = [process.execPath, '-e', 'setInterval(() => {}, 1000)'];

test('a registration naming sessions the host does not have registers, minus those ids', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-stale-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'a')); await mkdir(path.join(dir, 'b'));
  const store = await WorkspaceStore.open(path.join(dir, 'state'));
  const a = await store.addRoot(path.join(dir, 'a')), b = await store.addRoot(path.join(dir, 'b'));
  const live = randomUUID(), foreign = randomUUID(), dead = [randomUUID(), randomUUID()];
  const sessions = { snapshot: id => id === live ? { id, rootId: a.id } : id === foreign ? { id, rootId: b.id } : fail('Unknown session.', 404) };
  const desktops = new Desktops(store, sessions, 25);
  const client = new EventEmitter(); const messages = [];
  client.send = text => messages.push(JSON.parse(text));

  desktops.register(client, { rootIds: [a.id], sessionIds: [live, ...dead], canReload: true, canAttach: true });
  const registered = messages.at(-1);
  assert.equal(registered.type, 'desktop-registered', 'the desktop is registered rather than refused');
  assert.deepEqual(registered.unknownSessions, dead, 'and is told which of its views name sessions that ended');
  const listed = desktops.list(a.id);
  assert.equal(listed.length, 1, 'it is listed for the root it bound');
  assert.deepEqual(listed[0].sessionIds, [live], 'bound to the session the host still has, and to no other');

  /* The two refusals that stay refusals: a frame that is not a registration at all, and a session
     this host does have, on a root this desktop did not bind. */
  assert.throws(() => desktops.register(client, { rootIds: [a.id], sessionIds: 'both of them' }), /Invalid desktop bindings/);
  assert.throws(() => desktops.register(client, { rootIds: [a.id], sessionIds: [foreign] }), /different root/);
  assert.deepEqual(desktops.list(a.id)[0].sessionIds, [live], 'and neither refusal disturbed the registration');
});

test('the worker layer removes ended sessions from a registration before anything else sees it', () => {
  const state = { sessions: [{ id: 'a' }, { id: 'b' }] };
  const frame = { type: 'desktop-register', rootIds: ['r'], sessionIds: ['a', 'gone', 'b'], canReload: true };
  const filtered = withoutEndedSessions(frame, state);
  assert.deepEqual(filtered.frame.sessionIds, ['a', 'b'], 'the ids this host has are kept, in order');
  assert.deepEqual(filtered.dropped, ['gone'], 'and the one it does not is carried out separately');
  assert.equal(filtered.frame.canReload, true, 'the rest of the frame is untouched');

  const live = { ...frame, sessionIds: ['a'] }, intact = withoutEndedSessions(live, state);
  assert.equal(intact.frame, live, 'a registration naming only live sessions is passed through as it arrived');
  assert.deepEqual(intact.dropped, []);
  /* A frame that is not a registration is passed through untouched, so `Desktops` refuses it by name
     rather than this filter turning a malformed frame into an empty one. */
  const malformed = { type: 'desktop-register', rootIds: ['r'], sessionIds: 'both of them' };
  assert.equal(withoutEndedSessions(malformed, state).frame, malformed);
  assert.deepEqual(withoutEndedSessions(malformed, state).dropped, []);
});

test('the worker registers a desktop whose layout names sessions its host no longer has', { timeout: 40000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-stale-worker-'));
  const project = path.join(directory, 'project');
  await mkdir(project, { recursive: true });
  const host = await startServer({ stateDir: path.join(directory, 'host') });
  const root = await host.store.addRoot(project);
  const worker = await startWorker({ url: host.url, token: host.token, instance: host.instance },
    { directory: path.join(directory, 'runtime') });
  t.after(async () => { await worker.close(); await host.close(); await rm(directory, { recursive: true, force: true }); });

  const live = await host.sessions.terminal({ rootId: root.id, command: RESTING[0], args: RESTING.slice(1) });
  const dead = randomUUID();
  const desktop = await fakeDesktop(worker, [root.id], [dead, live.id]);
  t.after(() => desktop.close());
  const registered = desktop.messages.find(message => message.type === 'desktop-registered');
  assert.deepEqual(registered.unknownSessions, [dead], 'the worker names the id it dropped');
  const { desktops } = await ok(worker, `desktops?${new URLSearchParams({ rootId: root.id })}`);
  assert.equal(desktops.length, 1, 'the desktop is attached to the project through the worker');
  assert.deepEqual(desktops[0].sessionIds, [live.id], 'bound to the live session only');
  assert.ok(!desktop.messages.some(message => message.type === 'error'),
    `no error frame was sent: ${JSON.stringify(desktop.messages.filter(m => m.type === 'error'))}`);
  await host.sessions.stop(live.id);
});
