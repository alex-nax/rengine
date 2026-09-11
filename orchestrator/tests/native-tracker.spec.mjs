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
    { id: 1, description: 'Finished work', passes: true, dependencies: [], milestone: 'O1', category: 'workspace', priority: 'high',
      acceptance_criteria: ['the work is finished'], evidence: ['tests/finished.test.mjs: the work is finished'] },
    { id: 2, description: 'Ready to start', passes: false, dependencies: [1], milestone: 'O1', category: 'workspace', priority: 'medium' },
    { id: 3, description: 'Waiting on another', passes: false, dependencies: [2], milestone: 'O2', category: 'design', priority: 'low' },
  ],
};

const MANIFEST = {
  version: 1, at: '2026-09-09T12:00:00Z',
  entries: [
    { task: 'F1', test: { path: 'tests/one.test.mjs', name: 'the work is finished' },
      claim: 'the work is finished', criteria: [1], tier: 'gate',
      sabotage: [{ break: 'return early', red: 'the work is finished' }],
      /* Three artifacts on purpose: one the project wrote, one it names but did not write, and one
         that escapes the root. All three are answered before anyone clicks (spec 126). */
      last: { result: 'pass', at: '2026-09-09T12:00:00Z',
              artifacts: [{ path: 'evidence/frame.txt', label: 'The frame' },
                          { path: 'evidence/gone.txt' },
                          { path: '../outside.txt', label: 'Elsewhere' }] } },
    { task: 'F2', test: { path: 'tests/two.test.mjs' }, claim: 'the other thing', tier: 'gate',
      sabotage: [], last: { result: 'pass', at: '2026-09-09T12:00:00Z' } },
  ],
};

async function fixture(directory, declaration) {
  const root = path.join(directory, 'project');
  await mkdir(path.join(root, '.rengine'), { recursive: true });
  await writeFile(path.join(root, 'features.json'), JSON.stringify(INVENTORY, null, 2));
  await writeFile(path.join(root, '.rengine', 'tests.json'), JSON.stringify(MANIFEST, null, 2));
  await writeFile(path.join(root, 'a.txt'), 'x\n');
  await mkdir(path.join(root, 'evidence'), { recursive: true });
  await writeFile(path.join(root, 'evidence', 'frame.txt'), 'the artifact this run produced\n');
  if (declaration) await writeFile(path.join(root, '.rengine', 'project.json'), JSON.stringify(declaration, null, 2));
  return root;
}

const rows = state => {
  const tab = state.tabs.find(t => t?.type === 8);
  return tab?.tracker?.rows ?? [];
};

test('the Tasks tab lists the project inventory with the readiness the tool reports', { timeout: 90000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-tracker-view-'));
  const project = await fixture(dir, { contract: 10, project: 'fixture',
    formats: [{ id: 'text', title: 'Text', match: ['*.txt'], modes: ['raw'], default: 'raw' }],
    tracker: { provider: 'local' }, tests: { manifest: '.rengine/tests.json' } });
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

    /* F115 (spec 116): the evidence that backs a task is on the surface, behind its own caret.
       Every row carries the caret, including a provider that has nothing to say, because an absent
       control reads as "no tests" rather than "cannot say". */
    const tests = state.controls.filter(c => c.role === 'tracker-tests').map(c => c.key);
    assert.deepEqual(tests.sort(), ['F1', 'F2', 'F3'], `every task offers its evidence: ${JSON.stringify(tests)}`);
    await gui.control('tracker-tests', 'F1');
    state = await gui.until(s => s.tracker?.chooser?.kind === 'tests', 'the evidence opens');
    assert.equal(state.tracker.chooser.taskKey, 'F1', 'and it describes the row it sits under');
    const roles = state.controls.filter(c => c.role.startsWith('tracker-')).map(c => c.role);
    assert.ok(state.controls.some(c => c.role === 'tracker-evidence' && c.key === 'F1'),
      `F1 records evidence, so the block shows it: ${JSON.stringify(roles)}`);
    assert.ok(state.controls.some(c => c.role === 'tracker-claim' && c.key === 'F1'),
      'and the claim it backs is read beside it, not in a different chooser');

    /* F116 (spec 117): a declared manifest entry is shown with its own proven/unproven line, because
       a green run and a test that bites are different claims. */
    assert.ok(state.controls.some(c => c.role === 'tracker-test' && c.key === 'F1'),
      'the manifest entry names its test');
    assert.ok(state.controls.some(c => c.role === 'tracker-test-proven' && c.key === 'F1'),
      'a sabotaged entry reads as proven');

    /* F137 (spec 126): what the run PRODUCED, beside what it claimed. One artifact is on disk and
       opens; two cannot and say which, before anyone clicks rather than when they do — the whole
       reason the server settles them at read time. */
    const ready = state.controls.filter(c => c.role === 'tracker-artifact' && c.key === 'F1');
    const unavailable = state.controls.filter(c => c.role === 'tracker-artifact-unavailable' && c.key === 'F1');
    assert.equal(ready.length, 1, 'the artifact the project wrote is offered');
    assert.equal(unavailable.length, 2,
      'and the one it did not write and the one outside the root are shown as unavailable, not hidden');

    await gui.control('tracker-artifact', 'F1');
    state = await gui.until(s => s.tabs.some(t => t?.path === 'evidence/frame.txt'),
      'the artifact opens as a view of its own');
    /* Asserted on the view's identity, not its contents: WHICH view opens is the format registry's
       answer and this project's declaration routes a .txt through it, so reading editor text here
       would be testing the registry. What F137 claims is that the right file opened under the name
       the project gave it. */
    const opened = state.tabs.find(t => t?.path === 'evidence/frame.txt');
    assert.equal(opened.title, 'The frame', 'under the label the project gave it, not the file name');
    assert.equal(opened.root, state.tabs.find(t => t?.type === 8).root,
      'and in the project that declared it');
    /* Opening an artifact focuses it, exactly as clicking a file in the explorer does, so the task
       list is no longer the visible view. Coming back is what a person does and what the rest of
       this test needs. */
    await gui.control('toolbar', 'Tasks', -1);
    await gui.until(s => s.controls.some(c => c.role === 'tracker-tests'), 'the task list is back');

    /* F2 records none. The block says so rather than drawing empty, which would read as "no tests". */
    await gui.control('tracker-tests', 'F2');
    state = await gui.until(s => s.tracker?.chooser?.taskKey === 'F2', 'the second row opens');
    assert.ok(state.controls.some(c => c.role === 'tracker-test-unproven' && c.key === 'F2'),
      'an entry with no sabotage rows says UNPROVEN, however green its last run was');
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
