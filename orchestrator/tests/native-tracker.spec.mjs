import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';

const INVENTORY = {
  schema_version: 1, project: 'fixture', review_status: 'approved',
  features: [
    { id: 1, description: 'Finished work', passes: true, dependencies: [], milestone: 'O1', category: 'workspace', priority: 'high' },
    { id: 2, description: 'Ready to start', passes: false, dependencies: [1], milestone: 'O1', category: 'workspace', priority: 'medium' },
    { id: 3, description: 'Waiting on another', passes: false, dependencies: [2], milestone: 'O2', category: 'design', priority: 'low' },
  ],
};

async function fixture(directory, declaration) {
  const root = path.join(directory, 'project');
  await mkdir(path.join(root, '.rengine'), { recursive: true });
  await writeFile(path.join(root, 'features.json'), JSON.stringify(INVENTORY, null, 2));
  await writeFile(path.join(root, 'a.txt'), 'x\n');
  if (declaration) await writeFile(path.join(root, '.rengine', 'project.json'), JSON.stringify(declaration, null, 2));
  return root;
}

const rows = state => {
  const tab = state.tabs.find(t => t?.type === 8);
  return tab?.tracker?.rows ?? [];
};

test('the Tasks tab lists the project inventory with the readiness the tool reports', { timeout: 90000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-tracker-view-'));
  const project = await fixture(dir, null);
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const root = await server.store.addRoot(project);
  const gui = await nativeClient(server, { root: root.id });
  try {
    await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree), 'the workspace');

    // The tab is opened explicitly, never on its own: opening a project must not spend a request.
    let state = await gui.command({ op: 'state' });
    assert.ok(!state.tabs.some(t => t?.type === 8), 'no task list opens by itself');

    await gui.control('toolbar', 'Tasks', -1);
    state = await gui.until(s => rows(s).length === 3, 'the task list loads');
    const byKey = Object.fromEntries(rows(state).map(row => [row.key, row]));
    assert.equal(byKey.F1.state.category, 'completed');
    assert.equal(byKey.F2.state.category, 'unstarted');
    assert.equal(byKey.F3.state.category, 'blocked', 'a row whose dependency is unmet reads blocked');
    assert.deepEqual(byKey.F3.blockedBy, ['F2']);

    // Each row is a control, and every one of them is on screen.
    const controls = state.controls.filter(c => c.role === 'tracker-task').map(c => c.key);
    assert.deepEqual(controls.sort(), ['F1', 'F2', 'F3'], `every task is a reachable row: ${JSON.stringify(controls)}`);
    assert.ok(state.controls.some(c => c.role === 'tracker-refresh'), 'and a refresh control');
    assert.equal(state.tabs.find(t => t?.type === 8).tracker.provider, 'local');
  } finally {
    await gui.close(); await server.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('a declared Linear tracker without a token says so instead of showing an empty list', { timeout: 90000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-tracker-linear-view-'));
  const project = await fixture(dir, {
    contract: 5, project: 'kohai', title: 'Hirebase', icon: { glyph: 'Hi', token: 'info' },
    formats: [{ id: 'text', title: 'Text', match: ['*.txt'], modes: ['raw'], default: 'raw' }],
    tracker: { provider: 'linear', team: 'KOH' },
  });
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const root = await server.store.addRoot(project);
  const gui = await nativeClient(server, { root: root.id });
  try {
    await gui.until(s => s.connected && s.title === 'Hirebase', 'the declared project opens');
    await gui.control('toolbar', 'Tasks', -1);
    const state = await gui.until(s => s.tabs.some(t => t?.type === 8 && t.tracker), 'the tracker answered');
    const tracker = state.tabs.find(t => t?.type === 8).tracker;
    assert.equal(tracker.provider, 'linear', 'the declared provider is used, not the local default');
    assert.match(tracker.denied ?? '', /Not signed in to Linear/,
      `it says what is missing rather than failing silently: ${JSON.stringify(tracker)}`);
    assert.equal(tracker.signIn, 'linear', 'and names the provider, so the view can offer sign-in');
    assert.deepEqual(tracker.rows, [], 'and invents no rows');
    // The view says it too, rather than leaving an empty pane.
    await delay(200);
    const shown = await gui.command({ op: 'state' });
    assert.ok(!shown.controls.some(c => c.role === 'tracker-task'), 'no task rows are drawn');
    // The view offers sign-in rather than telling a person to create a file by hand.
    const signIn = shown.controls.find(c => c.role === 'tracker-signin');
    assert.ok(signIn, `the view offers to sign in: ${JSON.stringify(shown.controls.map(c => c.role))}`);
    assert.equal(signIn.key, 'linear');

    // Pressing it before an application is registered says what to do rather than opening nothing.
    await gui.control('tracker-signin', 'linear');
    const guided = await gui.until(s => /linear\.app\/settings\/api\/applications/.test(s.status ?? ''), 'the setup is named');
    assert.match(guided.status, /oauth\.json/, `and where the client id goes: ${guided.status}`);
  } finally {
    await gui.close(); await server.close(); await rm(dir, { recursive: true, force: true });
  }
});
