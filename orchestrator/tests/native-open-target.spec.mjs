/* Spec 130: where a document opens, whether a view keeps its scroll, and what a dragged tab shows.
 *
 * These are three separate claims about the workspace and each is checked against the running
 * desktop rather than against the source, because all three are about what a person sees: which
 * pane the file landed in, where the explorer is scrolled to when they come back to it, and whether
 * the thing under the cursor agrees with where the tab will go.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';

const paneOf = (state, tab) => state.layout.panes.findIndex(p => p?.tabs.includes(tab));

test('a file opens in the pane being worked in, not on top of the explorer that found it', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-open-target-'));
  const project = path.join(directory, 'project'); await mkdir(project);
  for (let i = 0; i < 40; i++) await writeFile(path.join(project, `file-${String(i).padStart(2, '0')}.txt`), `content ${i}\n`);
  let server, gui;
  try {
    server = await startServer({ stateDir: path.join(directory, 'state') });
    const root = await server.store.addRoot(project);
    gui = await nativeClient(server, { root: root.id });
    let state = await gui.until(s => s.tabs.some(t => t?.type === 1 && t.tree));
    const tree = state.tabs.findIndex(t => t?.type === 1);

    /* A new workspace opens with the explorer on the left and a work area on the right, so the
       two-pane case is the default one and the headline claim. */
    const leaves = s => s.layout.panes.map((p, i) => p && !p.axis ? i : -1).filter(i => i >= 0);
    assert.equal(leaves(state).length, 2, 'a new workspace has an explorer pane and a work pane');
    const treePane = paneOf(state, tree), work = leaves(state).find(i => i !== treePane);

    await gui.control('tree-entry', 'file-00.txt', tree);
    state = await gui.until(s => s.tabs.some(t => t?.path === 'file-00.txt' && t.text));
    const first = state.tabs.findIndex(t => t?.path === 'file-00.txt');
    assert.equal(paneOf(state, first), work,
      'With two panes, a file opens in the work pane, not on top of the explorer that found it.');

    /* A third pane, worked in, then back to the explorer: the file follows the person. */
    await gui.control('tab', '', first);                   /* the work pane is current */
    await gui.control('toolbar', 'Split horizontal');
    state = await gui.until(s => leaves(s).length === 3);
    const third = leaves(state).find(i => i !== treePane && i !== paneOf(state, first));
    assert.ok(third >= 0, 'the split produced a third leaf pane');

    await gui.control('tab', '', tree);                    /* back to the explorer, as a person would */
    await gui.control('tree-entry', 'file-01.txt', tree);
    state = await gui.until(s => s.tabs.some(t => t?.path === 'file-01.txt' && t.text));
    const second = state.tabs.findIndex(t => t?.path === 'file-01.txt');
    assert.notEqual(paneOf(state, second), paneOf(state, tree),
      'With three panes, a file still never opens on top of the explorer.');
    assert.equal(paneOf(state, second), third,
      'It opens in the pane most recently worked in, which the split just made current.');

    /* Collapse back to one pane: there is nowhere else, so it opens as a new tab right here. */
    await gui.control('tab', '', tree);
    await gui.control('toolbar', 'Merge pane');
    await gui.control('toolbar', 'Merge pane');
    state = await gui.until(s => leaves(s).length === 1);
    const single = leaves(state)[0];
    await gui.control('tree-entry', 'file-02.txt', tree);
    state = await gui.until(s => s.tabs.some(t => t?.path === 'file-02.txt' && t.text));
    assert.equal(paneOf(state, state.tabs.findIndex(t => t?.path === 'file-02.txt')), single,
      'With one pane, a file opens as a new tab in that pane.');
  } finally {
    if (gui) await gui.close();
    if (server) await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the explorer keeps its scroll position when another view is shown in its pane', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-open-scroll-'));
  const project = path.join(directory, 'project'); await mkdir(project);
  for (let i = 0; i < 60; i++) await writeFile(path.join(project, `file-${String(i).padStart(2, '0')}.txt`), `content ${i}\n`);
  let server, gui;
  try {
    server = await startServer({ stateDir: path.join(directory, 'state') });
    const root = await server.store.addRoot(project);
    gui = await nativeClient(server, { root: root.id });
    let state = await gui.until(s => s.tabs.some(t => t?.type === 1 && t.tree));
    const tree = state.tabs.findIndex(t => t?.type === 1);

    /* Collapse to a single pane first. This claim is about a pane showing one view and then another,
       and with two panes a file opens in the other one (the first test) and never covers the
       explorer at all -- which would leave nothing here for the scroll to survive. */
    const leaves = s => s.layout.panes.map((p, i) => p && !p.axis ? i : -1).filter(i => i >= 0);
    await gui.control('tab', '', tree);
    await gui.control('toolbar', 'Merge pane');
    state = await gui.until(s => leaves(s).length === 1);

    /* Which row is first reported is the observable: only rows inside the pane's clip are reported,
       so scrolling the explorer changes the answer, and it needs no pixel arithmetic. */
    const rows = s => s.controls.filter(c => c.role === 'tree-entry' && c.tab === tree);
    const top = s => rows(s)[0]?.key;
    state = await gui.until(s => top(s) === 'file-00.txt');

    /* Dragging the explorer's own scrollbar, which it reports as a control: microui moves the
       container's scroll by the pointer delta for a press anywhere on the track. */
    const bar = state.controls.find(c => c.role === 'scrollbar' && c.tab === tree).rect;
    const bx = bar[0] + bar[2] / 2, by = bar[1] + 20;
    await gui.command({ op: 'motion', x: bx, y: by }); await delay(80);
    await gui.command({ op: 'button', x: bx, y: by, down: true }); await delay(80);
    await gui.command({ op: 'motion', x: bx, y: by + 200, dx: 0, dy: 200 }); await delay(80);
    await gui.command({ op: 'button', x: bx, y: by + 200, down: false }); await delay(80);
    const scrolled = await gui.until(s => top(s) !== undefined && top(s) !== 'file-00.txt',
                                     'the explorer scrolls away from the first row');
    const parked = top(scrolled);

    /* The file opens as a second tab in this one pane, so returning to the explorer is a real tab
       switch. Before spec 130 the pane owned one scroll offset for every tab in it, and the explorer
       came back wherever the editor had left it. */
    await gui.control('tree-entry', parked, tree);
    await gui.until(s => s.tabs.some(t => t?.path === parked && t.text));
    await gui.control('tab', '', tree);
    const returned = await gui.until(s => top(s) !== undefined);
    assert.equal(top(returned), parked,
      'The explorer comes back to where it was scrolled, not to another view\'s offset.');
  } finally {
    if (gui) await gui.close();
    if (server) await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a tab being dragged shows where it is and where it would land', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-drag-preview-'));
  const project = path.join(directory, 'project'); await mkdir(project);
  for (let i = 0; i < 4; i++) await writeFile(path.join(project, `file-${i}.txt`), `content ${i}\n`);
  let server, gui;
  try {
    server = await startServer({ stateDir: path.join(directory, 'state') });
    const root = await server.store.addRoot(project);
    gui = await nativeClient(server, { root: root.id });
    let state = await gui.until(s => s.tabs.some(t => t?.type === 1 && t.tree));
    const tree = state.tabs.findIndex(t => t?.type === 1);
    const leaves = s => s.layout.panes.map((p, i) => p && !p.axis ? i : -1).filter(i => i >= 0);

    await gui.control('tree-entry', 'file-0.txt', tree);
    state = await gui.until(s => s.tabs.some(t => t?.path === 'file-0.txt' && t.text));
    const file = state.tabs.findIndex(t => t?.path === 'file-0.txt');
    const from = paneOf(state, file), treePane = paneOf(state, tree);
    assert.notEqual(from, treePane, 'the file opened in the work pane, so there is somewhere to drag from');

    /* Press the file's tab and carry it over the explorer's pane without letting go. */
    const header = state.tabs[file].header;
    const start = [header[0] + header[2] / 2, header[1] + header[3] / 2];
    const treeHeader = state.tabs[tree].header;
    /* The left quarter of the explorer's own tab, so the insertion index is 0 while the pane holds
       one tab: dropping at the centre would make "before the explorer" and "after it" the same
       number, and an index the preview got wrong would land correctly by accident. */
    const over = [treeHeader[0] + treeHeader[2] * 0.25, treeHeader[1] + treeHeader[3] / 2];
    await gui.command({ op: 'motion', x: start[0], y: start[1] }); await delay(80);
    await gui.command({ op: 'button', x: start[0], y: start[1], down: true }); await delay(80);
    await gui.command({ op: 'motion', x: over[0], y: over[1], dx: over[0] - start[0], dy: over[1] - start[1] });

    state = await gui.until(s => s.controls.some(c => c.role === 'drag-ghost'), 'the dragged tab shows under the cursor');
    const ghost = state.controls.find(c => c.role === 'drag-ghost');
    assert.equal(ghost.tab, file, 'the ghost is the tab being dragged');
    assert.ok(Math.abs(ghost.rect[0] + ghost.rect[2] / 2 - over[0]) <= 2 &&
              Math.abs(ghost.rect[1] + ghost.rect[3] / 2 - over[1]) <= 2,
      `the ghost is under the cursor, not left behind at the tab's old place: ${JSON.stringify(ghost.rect)} vs ${over}`);

    const shown = state.controls.find(c => c.role === 'drop-target');
    assert.ok(shown, 'the pane it would land in is indicated');
    assert.equal(Number(shown.key), treePane, 'the indicated pane is the one under the cursor');

    /* Let go, and the tab must land exactly where the preview said it would. */
    await gui.command({ op: 'button', x: over[0], y: over[1], down: false });
    state = await gui.until(s => paneOf(s, file) === treePane, 'the tab lands in the pane it was shown over');
    assert.equal(shown.tab, 0, 'aimed at the left of the explorer\'s tab, the preview says "before it"');
    assert.equal(state.layout.panes[treePane].tabs.indexOf(file), shown.tab,
      'It lands at the index the preview showed, because both come from one function.');
    assert.equal(leaves(state).length, 2, 'dragging the last tab out of a pane leaves the pane in place');
    /* The controls are rebuilt per frame and the desktop draws on events, so the ghost's absence is
       something to wait for rather than to sample from the frame the drop was reported in. */
    await gui.until(s => !s.controls.some(c => c.role === 'drag-ghost'), 'the ghost goes when the drag ends');
  } finally {
    if (gui) await gui.close();
    if (server) await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
