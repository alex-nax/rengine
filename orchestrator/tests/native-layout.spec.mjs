import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';

test('native tab overflow, reordering and pane merging preserve files and retained terminals', { timeout: 45000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-native-layout-'));
  const project = path.join(directory, 'project'); await mkdir(project);
  for (let i = 0; i < 6; i++) await writeFile(path.join(project, `file-${i}.txt`), `content ${i}\n`);
  let server, gui;
  try {
    server = await startServer({ stateDir: path.join(directory, 'state') });
    const root = await server.store.addRoot(project), shell = await server.sessions.terminal({ rootId: root.id });
    gui = await nativeClient(server, { root: root.id, terminal: shell.id });
    let state = await gui.until(s => s.tabs.some(t => t?.type === 1 && t.tree) && s.tabs.some(t => t?.session === shell.id && t.text));
    const tree = state.tabs.findIndex(t => t?.type === 1), files = [];
    for (let i = 0; i < 6; i++) {
      await gui.control('toolbar', 'Tree'); await gui.control('tree-entry', `file-${i}.txt`, tree);
      state = await gui.until(s => s.tabs.some(t => t?.path === `file-${i}.txt` && t.text === `content ${i}\n`));
      const index = state.tabs.findIndex(t => t?.path === `file-${i}.txt`); files.push(index);
      if (!i) {
        const editor = state.tabs[index]; await gui.click(editor.rect[0] + 10, editor.rect[1] + 10);
        await gui.key('A', 0xc0); await gui.command({ op: 'text', text: 'retained layout draft\n' });
      }
    }
    const last = state.tabs[files.at(-1)];
    assert.ok(last.header[2] > 0 && last.header[0] + last.header[2] <= last.rect[0] + last.rect[2] + 6,
      'The selected tab header must fit its narrow pane after opening several files.');
    const paneFor = (s, tab) => s.layout.panes.findIndex(p => p?.tabs.includes(tab));
    const left = paneFor(state, files[0]);
    for (let i = 0; i < 7; i++) {
      state = await gui.command({ op: 'state' });
      if (state.controls.some(c => c.role === 'tab' && c.tab === files[0])) break;
      await gui.control('tab-scroll', 'previous', left);
    }
    state = await gui.command({ op: 'state' });
    assert.equal(state.layout.panes[left].tabs[state.layout.panes[left].selected], files.at(-1), 'Browsing headers keeps the active content.');
    await gui.control('tab', '', files[0]);
    state = await gui.until(s => s.tabs[files[0]].rect[2] > 0);
    assert.equal(state.tabs[files[0]].text, 'retained layout draft\n');
    assert.ok(state.tabs.filter(t => t?.type === 2 && t.header[2] === 0).length >= 4, 'Hidden headers have no hit rectangle.');
    const drag = async (tab, x, y) => {
      await gui.command({ op: 'motion', x: tab.header[0] + 15, y: tab.header[1] + 12 }); await delay(50);
      await gui.command({ op: 'button', x: tab.header[0] + 15, y: tab.header[1] + 12 }); await delay(50);
      await gui.command({ op: 'motion', x, y }); await delay(50);
      await gui.command({ op: 'button', x, y, down: false }); await delay(50);
    };
    await drag(state.tabs[files[0]], 700, 450);
    state = await gui.until(s => s.tabs[files[0]].rect[0] > 280);
    const right = paneFor(state, files[0]), shellIndex = state.tabs.findIndex(t => t?.session === shell.id);
    const shellTab = state.tabs[shellIndex];
    await drag(state.tabs[files[0]], shellTab.header[0] + 2, shellTab.header[1] + 12);
    state = await gui.until(s => s.layout.panes[right].tabs[0] === files[0], 'dirty tab reordered before terminal');
    assert.equal(state.tabs[files[0]].root, root.id);
    await gui.control('toolbar', 'Split horizontal');
    await gui.until(s => s.layout.panes.filter(p => p?.axis === 0).length === 3);
    await gui.control('toolbar', 'Merge pane');
    await gui.until(s => s.layout.panes.filter(p => p?.axis === 0).length === 2);
    await gui.control('tab', '', files[0]);
    await gui.control('toolbar', 'Merge pane');
    state = await gui.until(s => s.layout.panes[0]?.axis === 0 && s.layout.panes[0].tabs.length === 8, 'merged all views without detaching');
    assert.equal(state.tabs[files[0]].text, 'retained layout draft\n');
    assert.equal(state.layout.panes[0].tabs[state.layout.panes[0].selected], files[0]);
    assert.equal(server.sessions.snapshot(shell.id).pid, shell.pid);
    assert.equal(server.sessions.snapshot(shell.id).state, 'running');
    const order = [...state.layout.panes[0].tabs];
    await gui.command({ op: 'resize', width: 1050, height: 600 });
    state = await gui.until(s => s.tabs[files[0]].header[2] > 0 && s.tabs[files[0]].rect[2] < 1050);
    assert.ok(state.tabs[files[0]].header[0] + state.tabs[files[0]].header[2] <= 1050);
    await gui.control('tab-scroll', 'previous', 0);
    state = await gui.command({ op: 'state' });
    assert.equal(state.tabs[files[0]].header[2], 0, 'Scroll away from the selected tab before splitting.');
    await gui.control('toolbar', 'Split horizontal'); await gui.control('toolbar', 'Merge pane');
    await gui.until(s => s.tabs[files[0]].header[2] > 0, 'merged selected tab revealed despite reused pane index');
    await mkdir('.cache/evidence', { recursive: true });
    await gui.command({ op: 'snapshot', path: path.resolve('.cache/evidence/native-layout.bmp') });
    await gui.close(); gui = null;
    gui = await nativeClient(server, { root: root.id });
    state = await gui.until(s => s.tabs[files[0]]?.dirty && s.tabs[files[0]].text === 'retained layout draft\n');
    assert.deepEqual(state.layout.panes[0].tabs, order);
    assert.equal(server.sessions.snapshot(shell.id).pid, shell.pid);
    assert.equal(await server.store.readText(root.id, 'file-0.txt').then(f => f.text), 'content 0\n');
  } finally { await gui?.close(); await server?.close(); await rm(directory, { recursive: true, force: true }); }
});

/* A slot leaked on every close, and the workspace stopped opening anything (spec 125).
 *
 * Closing a view removes it from its pane and deliberately KEEPS its tab, so reopening restores what
 * was there — that is the reuse path in re_app_tab and the refresh gesture spec 080 describes. What
 * nothing did was give the slot back. After 64 distinct views a long-lived window could open nothing
 * at all: a click on Shell still made the session, so it appeared in the Sessions tab, but the client
 * could not make a tab for it and the only symptom was one line in the status bar. Sixty of the
 * sixty-four slots in the owner's own window were closed views when this was found.
 *
 * Driven with the gesture that was reported — clicking Shell — rather than by opening files, because
 * that is what a long day in one window actually looks like. */
const PLATFORM_MODIFIER = process.platform === 'darwin' ? 0x0c00 : 0x00c0;

test('a window that has opened and closed more views than it has slots can still open one', { timeout: 300000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-native-slots-'));
  const project = path.join(directory, 'project'); await mkdir(project);
  let server, gui;
  try {
    server = await startServer({ stateDir: path.join(directory, 'state') });
    const root = await server.store.addRoot(project);
    gui = await nativeClient(server, { root: root.id });
    await gui.until(s => s.tabs.some(t => t?.type === 1));
    /* Counted from the LAYOUT, never from the tab array: a closed view keeps its tab, which is the
       very thing under test, so the tab array cannot say whether anything is on screen. */
    const shown = s => s.layout.panes.flatMap(p => p?.tabs ?? []).filter(t => s.tabs[t]?.type === 3).length;
    const rounds = 70;                    /* more than the 64 slots, with room for the starting views */
    let state;
    for (let i = 0; i < rounds; i++) {
      const before = shown(await gui.command({ op: 'state' }));
      await gui.control('toolbar', 'Shell');
      state = await gui.until(s => shown(s) > before,
        `shell ${i} opened a view; the window ran out of slots after ${i} opens and closes`);
      await gui.key('W', PLATFORM_MODIFIER);
      await gui.until(s => shown(s) <= before, `shell ${i} closed again`);
    }
    /* Past the slot count, the window says which closed view it gave back rather than refusing. */
    assert.match(state.status, /Released the closed view/,
      `the window reclaimed a closed view instead of refusing: ${state.status}`);
    assert.ok(state.tabs.filter(Boolean).length <= 64,
      'and it never holds more views than it has slots');
  } finally {
    if (gui) await gui.close();
    if (server) await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
