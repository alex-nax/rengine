import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';
import { startTasksSidecar } from './tasks-controls-fixtures.mjs';

/* The Tasks pane's per-task controls (spec 103 decision 5, acceptance 4 and 5, desktop half): Spawn
   with a chosen agent and model, Decompose with the declared default, Hold token for a live agent,
   and the labels of the agents already working a task. The worker half is built against the same
   pinned routes by another lane; the fixture here is those routes and nothing more. */

const AGENT = '5b8d47c2-0faa-4f8c-8a7a-a4866e386fae';
const MENU = {
  agents: [
    { cli: 'claude', installed: true, models: ['opus', 'sonnet', 'haiku'], default: 'opus' },
    { cli: 'codex', installed: true, models: ['gpt-6-astra'], default: 'gpt-6-astra' },
    { cli: 'gemini', installed: false, models: ['flash'], default: 'flash' },
  ],
  live: [{ sessionId: 'sess-1', label: 'claude 5b8d47c2', conversation: AGENT, task: 'F2' }],
};
const local = {
  provider: 'local',
  rows: [
    { key: 'F1', title: 'Finished work', state: { category: 'completed', name: 'done' } },
    { key: 'F2', title: 'Ready to start', state: { category: 'unstarted', name: 'ready' } },
  ],
};
const remote = {
  provider: 'github',
  rows: [{ key: '#7', title: 'An issue somewhere else', url: 'https://example.invalid/7', state: { category: 'started', name: 'open' } }],
};

const rows = state => state.tabs.find(t => t?.type === 8)?.tracker?.rows ?? [];
const keys = (state, role) => state.controls.filter(c => c.role === role).map(c => c.key).sort();

async function open(directory, tracker) {
  const dir = await mkdtemp(path.join(tmpdir(), directory));
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const sidecar = await startTasksSidecar(server, { tracker, menu: MENU });
  const root = await server.store.addRoot(dir);
  const gui = await nativeClient({ ...server, url: sidecar.url }, { root: root.id });
  await gui.until(s => s.connected, 'the desktop connects through the worker stand-in');
  assert.ok(await sidecar.settled(), 'the desktop holds an /events socket through the stand-in');
  const desktopId = await sidecar.desktop(root.id);
  await gui.control('toolbar', 'Tasks', -1);
  await gui.until(s => rows(s).length === tracker.rows.length, 'the task list loads');
  return {
    dir, server, sidecar, gui, rootId: root.id, desktopId,
    async close() { await gui.close(); await sidecar.close(); await server.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test('a task row spawns the chosen agent and model, and decomposes with the declared default', { timeout: 90000 }, async () => {
  const it = await open('rengine-tasks-controls-', local);
  try {
    const { gui, sidecar, rootId, desktopId } = it;

    /* The menu arrives with the list, on the same gesture: nothing polls for it. */
    let state = await gui.until(s => s.tracker?.menu === true, 'the agent menu answers');
    assert.deepEqual(state.tracker.agents.map(a => a.cli), ['claude', 'codex', 'gemini']);
    assert.deepEqual(state.tracker.agents.find(a => a.cli === 'claude'), { cli: 'claude', installed: true, default: 'opus', models: ['opus', 'sonnet', 'haiku'] });

    /* Every row carries the whole cluster, because this provider's rows are ours to write. */
    assert.deepEqual(keys(state, 'tracker-spawn'), ['F1', 'F2']);
    assert.deepEqual(keys(state, 'tracker-decompose'), ['F1', 'F2']);
    assert.deepEqual(keys(state, 'tracker-hold'), ['F1', 'F2']);

    /* A task live agents work wears their labels, and only that task does. */
    assert.deepEqual(keys(state, 'tracker-working'), ['F2'], 'the working mark is on the task the agent records, not on every row');
    assert.deepEqual(state.tracker.live, [{ sessionId: 'sess-1', label: 'claude 5b8d47c2', agentId: AGENT, task: 'F2' }]);

    /* Spawn opens the chooser on its own row and claims nothing until an agent is picked. */
    await gui.control('tracker-spawn', 'F2');
    state = await gui.until(s => s.tracker.chooser.taskKey === 'F2', 'the chooser opens on that task');
    assert.deepEqual(state.tracker.chooser, { taskKey: 'F2', agent: '', model: '', kind: 'spawn' });
    assert.deepEqual(keys(state, 'tracker-agent'), ['claude', 'codex'], 'an installed CLI is offered');
    assert.deepEqual(keys(state, 'tracker-agent-missing'), ['gemini'], 'and one that is not is named rather than hidden');

    /* Choosing the agent preselects the model the menu declares as its default. */
    await gui.control('tracker-agent', 'claude');
    state = await gui.until(s => s.tracker.chooser.agent === 'claude', 'the agent is chosen');
    assert.equal(state.tracker.chooser.model, 'opus', 'the declared default is preselected');
    assert.deepEqual(keys(state, 'tracker-model'), ['haiku', 'opus', 'sonnet']);

    /* …and the model the person actually presses is the one that travels. */
    await gui.control('tracker-model', 'haiku');
    const spawn = await sidecar.waitForSpawn(() => true, 'the spawn body');
    assert.deepEqual(spawn, { rootId, taskKey: 'F2', agent: 'claude', model: 'haiku', brief: 'task', desktopId });
    state = await gui.until(s => s.tracker.chooser.taskKey === '', 'the chooser closes behind the spawn');
    assert.equal(sidecar.frames.length, 0, 'spawning is not a token action');

    /* Decompose asks for the decomposition brief, with no chooser and the default agent and model. */
    await gui.control('tracker-decompose', 'F1');
    const decompose = await sidecar.waitForSpawn(body => body.taskKey === 'F1', 'the decompose body');
    assert.deepEqual(decompose, { rootId, taskKey: 'F1', agent: 'claude', model: 'opus', brief: 'decompose', desktopId });
    assert.equal(sidecar.spawns.length, 2, 'one press, one spawn');
  } finally { await it.close(); }
});

test('Hold token asks the ledger to give this project\'s token to a chosen live agent', { timeout: 90000 }, async () => {
  const it = await open('rengine-tasks-hold-', local);
  try {
    const { gui, sidecar, rootId } = it;
    await gui.until(s => s.tracker?.menu === true, 'the agent menu answers');

    await gui.control('tracker-hold', 'F2');
    let state = await gui.until(s => s.tracker.chooser.kind === 'hold', 'the live-agent chooser opens');
    assert.equal(state.tracker.chooser.taskKey, 'F2');
    assert.deepEqual(keys(state, 'tracker-live'), [AGENT], 'the live agents are listed by their own identity');

    /* Grant answers a contest; this hands the token over whether one is open or not, so it is its
       own action on the frame the popover already sends. */
    await gui.control('tracker-live', AGENT);
    const frame = await sidecar.waitForFrame(f => f.action === 'assign', 'the assign frame');
    assert.deepEqual(frame, { type: 'token-action', action: 'assign', rootId, agentId: AGENT });
    assert.equal(sidecar.spawns.length, 0, 'holding the token starts no agent');
    state = await gui.until(s => s.tracker.chooser.taskKey === '', 'the chooser closes behind the assign');
  } finally { await it.close(); }
});

test('a row the tracker reads from somewhere else offers Spawn and nothing that writes', { timeout: 90000 }, async () => {
  const it = await open('rengine-tasks-remote-', remote);
  try {
    const { gui } = it;
    let state = await gui.until(s => s.tracker?.menu === true, 'the agent menu answers');
    assert.equal(state.tabs.find(t => t?.type === 8).tracker.provider, 'github');

    assert.deepEqual(keys(state, 'tracker-spawn'), ['#7'], 'an agent can still be put on a remote issue');
    assert.deepEqual(keys(state, 'tracker-decompose'), [], 'decompose writes rows into an inventory this provider owns');
    assert.deepEqual(keys(state, 'tracker-hold'), [], 'and the token names agents of a workspace this row is not in');

    /* Spawn is offered for real, not merely drawn. */
    await gui.control('tracker-spawn', '#7');
    state = await gui.until(s => s.tracker.chooser.taskKey === '#7', 'the chooser opens on the remote row');
    assert.equal(state.tracker.chooser.kind, 'spawn');
    await delay(100);
  } finally { await it.close(); }
});
