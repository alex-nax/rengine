import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';

test('native scrollbars navigate terminals, editors and overflowing lists with system wheel signs', { timeout: 45000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-scrollbars-'));
  let server, gui;
  try {
    const document = Array.from({ length: 180 }, (_, i) => `EDITOR_${String(i).padStart(3, '0')} ${'long '.repeat(50)}END_${i}`).join('\n');
    await writeFile(path.join(directory, '000-editor.txt'), document);
    for (let i = 0; i < 80; i++) await writeFile(path.join(directory, `file-${String(i).padStart(3, '0')}.txt`), 'short\n');
    const fixture = path.join(directory, 'terminal.cjs');
    await writeFile(fixture, `process.stdin.setRawMode(true);
for (let i = 0; i < 180; i++) console.log('TERM_' + String(i).padStart(3, '0'));
process.stdin.on('data', data => console.log('INPUT_' + data.toString('hex')));`);
    server = await startServer({ stateDir: path.join(directory, 'state') });
    const root = await server.store.addRoot(directory);
    const session = await server.sessions.terminal({ rootId: root.id, command: process.execPath, args: [fixture] });
    gui = await nativeClient(server, { root: root.id, terminal: session.id });
    let state = await gui.until(s => s.tabs.some(t => t?.session === session.id && t.text?.includes('TERM_179') && t.scrollbars?.length));
    const terminal = state.tabs.findIndex(t => t?.session === session.id);
    let tab = state.tabs[terminal];
    const drag = async (bar, end) => {
      const [x, y, w, h] = bar.thumb, [tx, ty, tw, th] = bar.track;
      await gui.command({ op: 'motion', x: x + w / 2, y: y + h / 2 }); await delay(60);
      await gui.command({ op: 'button', x: x + w / 2, y: y + h / 2, down: true });
      const dx = bar.axis === 'x' ? (end ? tx + tw + 30 : tx - 30) : x + w / 2;
      const dy = bar.axis === 'y' ? (end ? ty + th + 30 : ty - 30) : y + h / 2;
      await gui.command({ op: 'motion', x: dx, y: dy });
      await gui.command({ op: 'button', x: dx, y: dy, down: false }); await delay(100);
    };
    await drag(tab.scrollbars[0], false);
    state = await gui.until(s => s.tabs[terminal].text.includes('TERM_000'), 'terminal thumb reaches oldest output');
    await drag(state.tabs[terminal].scrollbars[0], true);
    state = await gui.until(s => s.tabs[terminal].scrollOffset === 0 && s.tabs[terminal].text.includes('TERM_179'), 'terminal thumb reaches live');
    tab = state.tabs[terminal]; await gui.command({ op: 'motion', x: tab.rect[0] + 15, y: tab.rect[1] + 15 });
    await gui.command({ op: 'wheel', preciseY: 0.5, flipped: true });
    await gui.until(s => s.tabs[terminal].scrollOffset > 0, 'system-inverted positive delta keeps its sign');
    await gui.command({ op: 'wheel', preciseY: -2, flipped: true });
    await gui.until(s => s.tabs[terminal].scrollOffset === 0, 'system-inverted negative delta returns live');
    state = await gui.command({ op: 'state' });
    const [tx, ty, tw] = state.tabs[terminal].scrollbars[0].track;
    await gui.click(tx + tw / 2, ty + 2);
    await gui.until(s => s.tabs[terminal].scrollOffset > 0, 'terminal track pages history');
    assert.doesNotMatch(server.sessions.snapshot(session.id, true).output, /INPUT_/);
    await gui.control('tree-entry', '000-editor.txt');
    state = await gui.until(s => s.tabs.some(t => t?.type === 2 && t.scrollbars?.length === 2), 'editor has two overflow bars');
    const editor = state.tabs.findIndex(t => t?.type === 2);
    await drag(state.tabs[editor].scrollbars.find(b => b.axis === 'y'), true);
    state = await gui.until(s => { const b = s.tabs[editor].scrollbars.find(b => b.axis === 'y'); return b.value === b.maximum; }, 'editor bottom');
    await drag(state.tabs[editor].scrollbars.find(b => b.axis === 'x'), true);
    await gui.until(s => { const b = s.tabs[editor].scrollbars.find(b => b.axis === 'x'); return b.value === b.maximum; }, 'editor right edge');
    await mkdir('.cache/evidence', { recursive: true });
    await gui.command({ op: 'snapshot', path: path.resolve('.cache/evidence/native-scrollbars.bmp') });
    state = await gui.command({ op: 'state' }); tab = state.tabs[editor];
    const oldY = tab.scrollbars.find(b => b.axis === 'y').value;
    await gui.command({ op: 'motion', x: tab.rect[0] + 15, y: tab.rect[1] + 15 });
    await gui.command({ op: 'wheel', preciseY: 1, flipped: true });
    await gui.until(s => s.tabs[editor].scrollbars.find(b => b.axis === 'y').value < oldY, 'editor follows the same system sign');
    assert.equal((await gui.command({ op: 'state' })).tabs[editor].dirty, false);
    assert.equal(await readFile(path.join(directory, '000-editor.txt'), 'utf8'), document);
    state = await gui.command({ op: 'state' });
    await gui.control('toolbar', 'Tree');
    state = await gui.until(s => s.controls.some(c => c.role === 'scrollbar' && c.key === 'y'), 'visible tree overflow bar');
    const listBar = state.controls.find(c => c.role === 'scrollbar' && c.key === 'y'); assert.ok(listBar);
    const [lx, ly, lw, lh] = listBar.rect;
    await gui.command({ op: 'motion', x: lx + lw / 2, y: ly + 8 }); await delay(80);
    await gui.command({ op: 'button', x: lx + lw / 2, y: ly + 8, down: true });
    await gui.command({ op: 'motion', x: lx + lw / 2, y: ly + lh - 4 }); await delay(80);
    await gui.command({ op: 'button', x: lx + lw / 2, y: ly + lh - 4, down: false });
    await gui.until(s => s.controls.some(c => c.role === 'tree-entry' && c.key === 'file-079.txt'), 'tree scrollbar reveals final files');
    await gui.command({ op: 'motion', x: lx - 30, y: ly + lh / 2 });
    await gui.command({ op: 'wheel', preciseY: 200, flipped: true });
    await gui.until(s => s.controls.some(c => c.role === 'tree-entry' && c.key === '000-editor.txt'), 'list follows system wheel sign');
    await gui.control('tree-entry', 'file-000.txt');
    await gui.until(s => s.tabs.some(t => t?.type === 2 && t.text === 'short\n' && t.scrollbars?.length === 0), 'short editor needs no scrollbar');
    assert.equal(server.sessions.snapshot(session.id).pid, session.pid);
  } finally { await gui?.close(); await server?.close(); await rm(directory, { recursive: true, force: true }); }
});

// A scrolled view used to paint over the surfaces above it: the explorer's rows and its path bar
// reached the tab strip and the toolbar, because owned controls draw straight into the list and
// never saw microui's clip. The control layer now takes the container's clip (spec 080).
test('a scrolled view stays inside its pane', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-view-clip-'));
  let server, gui;
  try {
    for (let i = 0; i < 120; i++) await writeFile(path.join(directory, `entry-${String(i).padStart(3, '0')}.txt`), 'x\n');
    server = await startServer({ stateDir: path.join(directory, 'state') });
    const root = await server.store.addRoot(directory);
    gui = await nativeClient(server, { root: root.id });
    const reference = JSON.parse(await readFile('design/cards.json', 'utf8')).presets.default;
    const state = await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree?.entries?.length > 100), 'a long explorer');
    const tree = state.tabs.find(t => t?.type === 1);
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const python = process.platform === 'win32' ? 'python' : 'python3';

    // Every row of the toolbar and the tab strip, across the explorer's width.
    const points = {};
    for (let x = 4; x < 280; x += 8) {
      for (let y = 1; y < reference.toolbar.height + reference.tabs.height - 1; y += 3) points[`p_${x}_${y}`] = [x, y];
    }
    const band = async label => {
      const file = path.join(directory, `${label}.bmp`);
      assert.equal(await gui.command({ op: 'snapshot', path: file }), true);
      const { stdout } = await run(python, ['tools/bmp_probe.py', file, '--logical-width', '1280',
        ...Object.entries(points).map(([name, [x, y]]) => `${name}=${x},${y}`)]);
      return JSON.parse(stdout);
    };
    const before = await band('before');

    // Scrolling the explorer must not change one pixel above it.
    await gui.command({ op: 'motion', x: tree.header[0] + 40, y: 300 });
    for (let i = 0; i < 12; i++) await gui.command({ op: 'wheel', x: 0, y: -3 });
    await delay(250);
    const scrolled = await gui.command({ op: 'state' });
    assert.ok(scrolled.controls.some(c => c.role === 'tree-entry'), 'the explorer still lists entries');
    const after = await band('after');

    const moved = Object.keys(before).filter(name => before[name] !== after[name]);
    assert.deepEqual(moved, [], `scrolling the explorer repainted the surfaces above it at ${JSON.stringify(moved.slice(0, 8))}`);
  } finally {
    if (gui) await gui.close();
    if (server) await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
