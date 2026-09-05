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
