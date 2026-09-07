import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { startRuntime } from '../runtime/supervisor.mjs';
import { snapshotBinary, nativeBinary } from '../runtime/desktop.mjs';
import { nativeBridge } from './native-client.mjs';
import { api, ok } from './token-fixtures.mjs';

/* What a replaced session host leaves behind (spec 098): the desktop's saved layout, whose tabs name
   the sessions of the process that is gone. Measured on 2026-09-07, twice, on two projects — the new
   host refused the whole registration on the first stale id, so `GET /api/desktops` answered `[]`
   while the desktop ran, the supervisor's `waitView` gave up with "Replacement desktop did not
   register before timeout." and the workspace came back with no runtime layer at all.

   The discriminating check is therefore not that a window appeared: it is that the runtime layer is
   registered, read through the supervisor. */

const PANES = 29, TABS = 64;
const RE_TREE = 1, RE_TERMINAL = 3;
const pane = over => ({ axis: 0, ratio: 0.5, children: [0, 0], tabs: [], selected: 0, ...over });
const view = (type, rootId, over = {}) => ({ type, root: rootId, path: '', session: '', title: 'View', ...over });

/* The shape `app.c` serializes, written by hand so the stale ids are exactly the ones this test
   means: a tree, a terminal on a session the host still has, and a terminal on one it never had. */
function savedLayout(rootId, liveId, staleId) {
  const panes = Array.from({ length: PANES }, () => null);
  panes[0] = pane({ tabs: [0, 1, 2], selected: 2 });
  const tabs = Array.from({ length: TABS }, () => null);
  tabs[0] = view(RE_TREE, rootId, { title: 'Project' });
  tabs[1] = view(RE_TERMINAL, rootId, { session: staleId, title: 'bash · previous host' });
  tabs[2] = view(RE_TERMINAL, rootId, { session: liveId, title: 'bash · this host' });
  return { client: 'microui', layout: { version: 1, active: 0, panes }, tabs, dashboards: [] };
}

const CLI = `process.stdin.resume(); console.log('SURVIVING_CLI_READY');`;

/* A layout whose one terminal tab claims a session of another project. This is the refusal spec 098
   keeps — a desktop may not bind a session on a root it did not name — so it is what a registration
   that is genuinely wrong looks like after the fix. */
function foreignLayout(rootId, sessionId) {
  const panes = Array.from({ length: PANES }, () => null);
  panes[0] = pane({ tabs: [0], selected: 0 });
  const tabs = Array.from({ length: TABS }, () => null);
  tabs[0] = view(RE_TERMINAL, rootId, { session: sessionId, title: 'bash · another project' });
  return { client: 'microui', layout: { version: 1, active: 0, panes }, tabs, dashboards: [] };
}

async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-stale-native-')));
  const project = path.join(directory, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'cli.cjs'), CLI);
  const host = await startServer({ stateDir: path.join(directory, 'host') });
  const root = await host.store.addRoot(project);
  const live = await host.sessions.terminal({ rootId: root.id, command: process.execPath, args: [path.join(project, 'cli.cjs')] });
  const stale = randomUUID();
  /* Persisted before the desktop exists, exactly as the previous host's desktop left it. */
  await host.store.saveLayout(savedLayout(root.id, live.id, stale));

  const views = [];
  let runtime;
  t.after(async () => {
    for (const value of views) await value.close();
    await runtime?.close(); await host.close(); await rm(directory, { recursive: true, force: true });
  });
  runtime = await startRuntime({ host, directory: path.join(directory, 'runtime'), inspectUI: true,
    initial: { root: root.id },
    buildDesktop: dir => snapshotBinary(nativeBinary, dir),
    onDesktop: child => child.once('spawn', () => views.push(nativeBridge(child))) });
  return { directory, host, root, live, stale, runtime, views,
    supervisor: { url: runtime.url, token: runtime.token }, gui: () => views.at(-1) };
}

test('a desktop restoring a layout from a replaced host registers its runtime layer', { timeout: 120000 }, async t => {
  const { root, live, stale, supervisor, gui } = await workspace(t);
  await gui().until(s => s.connected, 'the desktop the supervisor launched reaches the workspace worker');

  /* The check the two live failures would have caught: the runtime layer is registered. */
  const listed = await ok(supervisor, `desktops?${new URLSearchParams({ rootId: root.id })}`);
  assert.equal(listed.desktops.length, 1, 'GET /api/desktops through the runtime is not empty while the desktop runs');
  assert.equal(listed.desktops[0].managed, true, 'and the supervisor owns the desktop it opened');
  assert.deepEqual(listed.desktops[0].sessionIds, [live.id], 'bound to the session this host has, and not to the dead one');
  const status = await ok(supervisor, `update-status?${new URLSearchParams({ rootId: root.id })}`);
  assert.equal(status.desktops.length, 1, 'update_status answers, with the desktop in it');
  assert.ok(status.workspace.pid, 'and a workspace worker under it');

  const state = await gui().until(s => s.tabs.some(x => x?.session === live.id && x.text?.includes('SURVIVING_CLI_READY')),
    'the view on the surviving session is attached to it');
  const dead = state.tabs.find(x => x?.session === stale);
  assert.ok(dead, 'the view on the dead session is still in the layout — the person keeps their tabs');
  assert.equal(dead.sessionEnded, true, 'and it is marked ended rather than attached to nothing');
  assert.equal(dead.attached, undefined, 'nothing was attached for it');
  assert.equal(state.tabs.find(x => x?.session === live.id).sessionEnded, false,
    'the session the host still has is not marked ended');
});

test('a registration the workspace really does refuse is named in the timeout', { timeout: 120000 }, async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-stale-refused-')));
  const project = path.join(directory, 'project'), other = path.join(directory, 'other');
  for (const dir of [project, other]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(other, 'cli.cjs'), CLI);
  const host = await startServer({ stateDir: path.join(directory, 'host') });
  const mine = await host.store.addRoot(project), theirs = await host.store.addRoot(other);
  const foreign = await host.sessions.terminal({ rootId: theirs.id, command: process.execPath, args: [path.join(other, 'cli.cjs')] });
  await host.store.saveLayout(foreignLayout(mine.id, foreign.id));

  const views = [];
  const runtime = await startRuntime({ host, directory: path.join(directory, 'runtime'), inspectUI: true,
    buildDesktop: dir => snapshotBinary(nativeBinary, dir),
    onDesktop: child => child.once('spawn', () => views.push(nativeBridge(child))) });
  t.after(async () => {
    for (const value of views) await value.close();
    await runtime.close(); await host.close(); await rm(directory, { recursive: true, force: true });
  });

  /* The desktop starts, sends a registration the workspace refuses on its merits, and never appears.
     Before this change the whole report was the timeout; nothing said which frame was refused. */
  const refused = await api({ url: runtime.url, token: runtime.token }, 'open-desktop', { root: mine.id });
  assert.equal(refused.status, 500, JSON.stringify(refused.body));
  assert.match(refused.body.error, /did not register before timeout/);
  assert.match(refused.body.error, /last registration refused: Desktop session has a different root\./,
    `the timeout names the refusal instead of only the silence: ${refused.body.error}`);
  assert.equal(host.sessions.snapshot(foreign.id).state, 'running', 'and the other project keeps its session');
  await host.sessions.stop(foreign.id);
});

test('a replacement desktop comes up under the same layout and registers again', { timeout: 120000 }, async t => {
  const { root, live, stale, supervisor, views, gui } = await workspace(t);
  await gui().until(s => s.connected, 'the first desktop registers');
  const before = (await ok(supervisor, `desktops?${new URLSearchParams({ rootId: root.id })}`)).desktops[0];
  const previous = gui().child.pid;

  /* The `waitView` path that failed: the supervisor spawns a replacement and waits for it to appear
     in `runtime-desktops`. Under a layout naming a dead session it never did. */
  const queued = await ok(supervisor, 'update-workspace', { rootId: root.id, layers: ['desktop'], desktopId: before.id });
  let job;
  for (let i = 0; i < 400 && !['succeeded', 'failed'].includes(job?.status); i++) {
    const status = await ok(supervisor, `update-status?${new URLSearchParams({ rootId: root.id })}`);
    job = status.jobs.find(x => x.id === queued.jobId);
    if (!['succeeded', 'failed'].includes(job?.status)) await delay(75);
  }
  assert.equal(job.status, 'succeeded', `the replacement registered: ${job.error ?? ''} ${job.recoveryError ?? ''}`);
  assert.equal(views.length, 2, 'a second desktop process was launched');
  assert.notEqual(gui().child.pid, previous);

  const after = await ok(supervisor, `desktops?${new URLSearchParams({ rootId: root.id })}`);
  assert.equal(after.desktops.length, 1, 'the runtime layer is registered again after the replacement');
  assert.deepEqual(after.desktops[0].sessionIds, [live.id]);
  const state = await gui().until(s => s.tabs.some(x => x?.session === stale), 'the replacement restored the same layout');
  assert.equal(state.tabs.find(x => x?.session === stale).sessionEnded, true);
});
