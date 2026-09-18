import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from './red-host-fixture.mjs';
import { nativeClient } from './native-client.mjs';

// The explorer's mode is a setting, never inferred from how large a project is (spec 080 decision 1).
async function nested(gui, on = true) {
  await gui.control('toolbar', 'Settings', -1);
  await gui.until(s => s.controls?.some(c => c.key === 'explorer'), 'the settings popover');
  const state = await gui.command({ op: 'state' });
  if (state.explorerNested !== on) {
    await gui.control('settings', 'explorer', -1);
    await gui.until(s => s.explorerNested === on, `explorer nested=${on}`);
  }
  await gui.key('Escape');
  await gui.until(s => !s.controls?.some(c => c.key === 'explorer'), 'the popover closed');
}

const rows = state => state.controls.filter(c => c.role === 'tree-entry').map(c => c.key);

test('the explorer expands in place, drills in from the caret and honours the flat setting', { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-explorer-'));
  const project = path.join(dir, 'project');
  await mkdir(path.join(project, 'src', 'deep'), { recursive: true });
  await writeFile(path.join(project, 'top.txt'), 'top\n');
  await writeFile(path.join(project, 'src', 'inner.txt'), 'inner\n');
  await writeFile(path.join(project, 'src', 'deep', 'deepest.txt'), 'deepest\n');
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const root = await server.store.addRoot(project);
  const gui = await nativeClient(server, { root: root.id });
  try {
    await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree), 'the explorer');

    // Flat mode is what the desktop has always done: a directory row drills in.
    await nested(gui, false);
    await gui.control('tree-entry', 'src');
    let state = await gui.until(s => s.tabs.some(t => t?.type === 1 && t.path === 'src'), 'flat mode drilled in');
    assert.ok(rows(state).includes('src/inner.txt'), 'the drilled-in directory lists its own entries');
    await gui.control('tree-up', '');
    await gui.until(s => s.tabs.some(t => t?.type === 1 && t.path === ''), 'back at the root');

    // Nested mode expands in place instead, and the row keeps its siblings.
    await nested(gui, true);
    await gui.control('tree-entry', 'src');
    state = await gui.until(s => rows(s).includes('src/inner.txt'), 'src expanded in place');
    assert.equal(state.tabs.find(t => t?.type === 1).path, '', 'expanding did not change the directory');
    assert.ok(rows(state).includes('top.txt'), 'the siblings are still listed');

    // Indentation comes from the row control's depth argument, so a child sits to the right.
    const parent = state.controls.find(c => c.role === 'tree-entry' && c.key === 'src');
    const child = state.controls.find(c => c.role === 'tree-entry' && c.key === 'src/inner.txt');
    assert.ok(child.rect[1] > parent.rect[1], 'the child is drawn below its directory');

    // A second level expands under the first.
    await gui.control('tree-entry', 'src/deep');
    state = await gui.until(s => rows(s).includes('src/deep/deepest.txt'), 'the second level expanded');
    assert.ok(rows(state).includes('src/inner.txt'), 'the first level is still open');

    // Clicking the row again collapses that branch, and its children go with it.
    await gui.control('tree-entry', 'src');
    state = await gui.until(s => !rows(s).includes('src/inner.txt'), 'src collapsed');
    assert.ok(!rows(state).includes('src/deep/deepest.txt'), 'a collapsed branch closes whole');
    assert.ok(rows(state).includes('top.txt'), 'the siblings did not reload away');

    // The caret drills in, so today's behaviour stays reachable from nested mode.
    await gui.control('tree-entry', 'src');
    await gui.until(s => rows(s).includes('src/inner.txt'), 'src expanded again');
    await gui.control('tree-drill', 'src');
    state = await gui.until(s => s.tabs.some(t => t?.type === 1 && t.path === 'src'), 'the caret drilled in');
    assert.ok(rows(state).includes('src/inner.txt'), 'the new root lists its entries');
    assert.ok(!rows(state).includes('top.txt'), 'the parent is no longer listed');
  } finally {
    await gui.close(); await server.close(); await rm(dir, { recursive: true, force: true });
  }
});

// KI-131: the walk may not free the tree it is walking. A directory at depth >= 1 draws inside a
// recursive `tree_rows` whose `entries` live in an expansion's data, and the drill-in used to clear
// every expansion for the tab from inside that loop — freeing both the array being iterated and the
// `path` string it was about to copy into the tab. The gesture is the caret on a nested directory,
// and what it must leave behind is the directory it names, not whatever the freed block held.
test('the caret drills in from a nested row without freeing the walk under itself', { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-explorer-nested-drill-'));
  const project = path.join(dir, 'project');
  await mkdir(path.join(project, 'src', 'deep'), { recursive: true });
  await writeFile(path.join(project, 'top.txt'), 'top\n');
  await writeFile(path.join(project, 'src', 'inner.txt'), 'inner\n');
  // Siblings on both sides of `deep`, so the walk still has rows of that listing to draw after the
  // caret is clicked: the freed iteration is what the crash walked off the end of.
  await writeFile(path.join(project, 'src', 'aaa.txt'), 'a\n');
  await writeFile(path.join(project, 'src', 'zzz.txt'), 'z\n');
  await writeFile(path.join(project, 'src', 'deep', 'deepest.txt'), 'deepest\n');
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const root = await server.store.addRoot(project);
  // MallocScribble fills a freed block with 0x55 rather than leaving whatever was there, which turns
  // reading one from an occasional wrong answer into a certain one. It is the platform's own knob:
  // where it is ignored the assertion keeps its meaning and loses only its guarantee.
  const gui = await nativeClient(server, { root: root.id, env: { MallocScribble: '1' } });
  try {
    await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree), 'the explorer');
    await nested(gui, true);
    await gui.control('tree-entry', 'src');
    await gui.until(s => rows(s).includes('src/deep'), 'src expanded in place');
    await gui.control('tree-entry', 'src/deep');
    await gui.until(s => rows(s).includes('src/deep/deepest.txt'), 'the second level expanded');

    // Collapsing from depth 1 frees an expansion mid-walk too, and this one is allowed to: a branch
    // closes whole, so it takes the row's OWN listing and what is under it, never the listing the
    // walk is iterating, which belongs to its parent.
    await gui.control('tree-entry', 'src/deep');
    let state = await gui.until(s => !rows(s).includes('src/deep/deepest.txt'), 'the second level collapsed');
    assert.ok(rows(state).includes('src/inner.txt'), 'the listing being walked survived the collapse');

    // The caret on a row that is NOT at the top level: its entry lives in src's expansion, not in
    // the tab's own listing, which is the whole difference from the depth-0 case above.
    await gui.control('tree-drill', 'src/deep');
    state = await gui.until(s => s.tabs.some(t => t?.type === 1 && t.path === 'src/deep'),
                            'the nested caret drilled into the directory it names');
    assert.ok(rows(state).includes('src/deep/deepest.txt'), `the new root lists its entries: ${JSON.stringify(rows(state))}`);
    assert.ok(!rows(state).includes('src/inner.txt'), 'the old tree is gone');
    assert.ok(!rows(state).includes('top.txt'), 'and so is the level above it');
    // A new root is a new tree: nothing from the old one is still expanded under it.
    assert.deepEqual(rows(state), ['src/deep/deepest.txt'], 'the expansions went with the old tree');
  } finally {
    await gui.close(); await server.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('expansion survives a reload of the same directory', { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-explorer-reload-'));
  const project = path.join(dir, 'project');
  await mkdir(path.join(project, 'src'), { recursive: true });
  await writeFile(path.join(project, 'src', 'inner.txt'), 'inner\n');
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const root = await server.store.addRoot(project);
  const gui = await nativeClient(server, { root: root.id });
  try {
    await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree), 'the explorer');
    await nested(gui, true);
    await gui.control('tree-entry', 'src');
    await gui.until(s => rows(s).includes('src/inner.txt'), 'src expanded');
    // Choosing the view again reloads the directory; the expansion is keyed by path and stays.
    await gui.control('toolbar', 'Tree', -1);
    await delay(400);
    const state = await gui.command({ op: 'state' });
    assert.ok(rows(state).includes('src/inner.txt'), `the expansion survived the reload: ${JSON.stringify(rows(state))}`);
  } finally {
    await gui.close(); await server.close(); await rm(dir, { recursive: true, force: true });
  }
});

// The cap is a safety limit, not the deciding rule: reaching it collapses the least-recently-expanded
// branch rather than refusing to open (spec 080 decision 7), and never one the opened directory or
// the selected row sits under (decision 8).
async function fill(directory, count) {
  await mkdir(directory, { recursive: true });
  await Promise.all(Array.from({ length: count }, (_, i) =>
    writeFile(path.join(directory, `f-${String(i).padStart(4, '0')}.txt`), 'x\n')));
}

test('the loaded-row cap collapses the oldest expansion', { timeout: 180000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-explorer-cap-'));
  const project = path.join(dir, 'project');
  await fill(path.join(project, 'beta'), 700);
  await fill(path.join(project, 'zeta'), 700);
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const root = await server.store.addRoot(project);
  const gui = await nativeClient(server, { root: root.id });
  try {
    await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree), 'the explorer');
    await nested(gui, true);
    // zeta first, so it is the least-recently-expanded when beta needs the room. beta stays on
    // screen throughout because it sorts above zeta's children.
    await gui.control('tree-entry', 'zeta');
    await gui.until(s => rows(s).some(r => r.startsWith('zeta/')), 'zeta expanded');
    await gui.control('tree-entry', 'beta');
    const state = await gui.until(s => rows(s).some(r => r.startsWith('beta/')), 'beta expanded');
    assert.ok(!rows(state).some(r => r.startsWith('zeta/')), 'the oldest expansion was collapsed to make room');
    assert.match(state.status, /Collapsed zeta/, `the status names what closed: ${state.status}`);
    const listing = state.tabs.find(x => x?.type === 1).tree.entries.map(e => e.name);
    assert.ok(listing.includes('zeta'), 'the collapsed directory is still in the listing');
  } finally {
    await gui.close(); await server.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('the cap refuses rather than collapsing a branch that is in use', { timeout: 180000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-explorer-protect-'));
  const project = path.join(dir, 'project');
  await fill(path.join(project, 'keep'), 500);
  await fill(path.join(project, 'keep', 'inner'), 500);
  await fill(path.join(project, 'aaa'), 500);
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const root = await server.store.addRoot(project);
  const gui = await nativeClient(server, { root: root.id });
  try {
    await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree), 'the explorer');
    await nested(gui, true);
    await gui.control('tree-entry', 'keep');
    await gui.until(s => rows(s).includes('keep/inner'), 'keep expanded');
    await gui.control('tree-entry', 'keep/inner');
    await gui.until(s => rows(s).some(r => r.startsWith('keep/inner/')), 'the inner branch expanded');
    // Open a file inside that branch: the selection is what marks a branch as in use.
    await gui.control('tree-entry', 'keep/inner/f-0000.txt');
    await gui.until(s => s.tabs.some(x => x?.type === 2 && x.path === 'keep/inner/f-0000.txt'), 'the file opened');
    // The editor opened in the same pane; the toolbar brings the explorer back, expansions intact.
    await gui.control('toolbar', 'Tree', -1);
    await gui.until(s => rows(s).includes('keep'), 'back on the explorer');
    // Every open branch is now on the selected path, so the next expansion has nothing to collapse.
    await gui.control('tree-entry', 'aaa');
    const state = await gui.until(s => /row limit/.test(s.status ?? ''), 'the refusal reached the status line');
    assert.ok(!rows(state).some(r => r.startsWith('aaa/')), 'the refused directory did not open');
    assert.ok(rows(state).some(r => r.startsWith('keep/inner/')), 'the branch in use stayed open');
    assert.match(state.status, /close one/i, `the status says what to do: ${state.status}`);
  } finally {
    await gui.close(); await server.close(); await rm(dir, { recursive: true, force: true });
  }
});

// The path bar: a refresh that re-reads what is on screen, an up arrow that says when it cannot be
// used, and a bar that stays on screen while the tree scrolls under it.
const control = (state, role) => state.controls.find(c => c.role === role);

test('refresh re-reads the directory and the folders open inside it', { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-explorer-refresh-'));
  const project = path.join(dir, 'project');
  await mkdir(path.join(project, 'src'), { recursive: true });
  await writeFile(path.join(project, 'src', 'inner.txt'), 'inner\n');
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const root = await server.store.addRoot(project);
  const gui = await nativeClient(server, { root: root.id });
  try {
    await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree), 'the explorer');
    await nested(gui, true);
    await gui.control('tree-entry', 'src');
    await gui.until(s => rows(s).includes('src/inner.txt'), 'src expanded');

    // Written AFTER both listings were taken, so neither is there until something re-reads.
    await writeFile(path.join(project, 'later.txt'), 'later\n');
    await writeFile(path.join(project, 'src', 'later-inner.txt'), 'later\n');
    let state = await gui.command({ op: 'state' });
    assert.ok(!rows(state).includes('later.txt'), 'the listing is a snapshot until it is refreshed');

    await gui.control('tree-refresh', '');
    state = await gui.until(s => rows(s).includes('later.txt'), 'the directory was re-read');
    // The open folder too: refreshing only the top would leave the tree half fresh with nothing
    // saying which half.
    assert.ok(rows(state).includes('src/later-inner.txt'),
              `the open folder was re-read as well: ${JSON.stringify(rows(state))}`);
    assert.ok(rows(state).includes('src/inner.txt'), 'and src stayed expanded across the refresh');
  } finally {
    await gui.close(); await server.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('the up arrow reads as disabled at the root and usable below it', { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-explorer-up-'));
  const project = path.join(dir, 'project');
  await mkdir(path.join(project, 'src'), { recursive: true });
  await writeFile(path.join(project, 'src', 'inner.txt'), 'inner\n');
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const root = await server.store.addRoot(project);
  const gui = await nativeClient(server, { root: root.id });
  try {
    await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree), 'the explorer');
    let state = await gui.until(s => control(s, 'tree-up'), 'the path bar');
    assert.equal(control(state, 'tree-up').disabled, true, 'there is nowhere up from the root');

    await nested(gui, false);            // flat mode: a directory row drills in
    await gui.control('tree-entry', 'src');
    state = await gui.until(s => s.tabs.some(t => t?.type === 1 && t.path === 'src'), 'drilled in');
    assert.ok(!control(state, 'tree-up').disabled, 'and up is usable once there is a parent');
  } finally {
    await gui.close(); await server.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('the path bar stays on screen while the tree scrolls under it', { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-explorer-sticky-'));
  const project = path.join(dir, 'project');
  await fill(project, 120);            // enough rows that the tree must scroll
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const root = await server.store.addRoot(project);
  const gui = await nativeClient(server, { root: root.id });
  try {
    await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree), 'the explorer');
    let state = await gui.until(s => control(s, 'tree-up') && rows(s).length > 10, 'a scrollable tree');
    const barY = control(state, 'tree-up').rect[1];
    const first = rows(state)[0];
    const firstY = state.controls.find(c => c.role === 'tree-entry' && c.key === first).rect[1];

    const rowRect = state.controls.find(c => c.role === 'tree-entry' && c.key === first).rect;
    await gui.command({ op: 'motion', x: rowRect[0] + 4, y: rowRect[1] + 4 });
    for (let i = 0; i < 6; i++) await gui.command({ op: 'wheel', x: 0, y: -3 });
    await delay(300);

    state = await gui.command({ op: 'state' });
    const moved = state.controls.find(c => c.role === 'tree-entry' && c.key === first);
    assert.ok(!moved || moved.rect[1] < firstY, 'the rows scrolled');
    assert.equal(control(state, 'tree-up').rect[1], barY, 'and the path bar did not move with them');
    assert.ok(control(state, 'tree-refresh'), 'refresh is still reachable after scrolling');
  } finally {
    await gui.close(); await server.close(); await rm(dir, { recursive: true, force: true });
  }
});
