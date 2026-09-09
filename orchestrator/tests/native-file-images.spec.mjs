import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';
import { redImage, blueImage } from './image-fixtures.mjs';

async function pixels(gui, file, channel, tab) {
  const state = await gui.command({ op: 'state' }), rect = state.tabs[tab].rect;
  assert.equal(await gui.command({ op: 'snapshot', path: file }), true);
  const b = await readFile(file), offset = b.readUInt32LE(10), width = b.readInt32LE(18);
  const height = Math.abs(b.readInt32LE(22)), bytes = b.readUInt16LE(28) / 8;
  assert.ok(bytes === 3 || bytes === 4);
  const stride = (width * bytes + 3) & ~3; let count = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const logicalX = x * state.width / width, logicalY = (b.readInt32LE(22) > 0 ? height - 1 - y : y) * state.width / width;
    if (logicalX < rect[0] || logicalX >= rect[0] + rect[2] || logicalY < rect[1] || logicalY >= rect[1] + rect[3]) continue;
    const i = offset + y * stride + x * bytes, rgb = [b[i + 2], b[i + 1], b[i]];
    const expected = channel === 0 ? [225, 65, 55] : [40, 110, 225];
    if (rgb.every((value, c) => Math.abs(value - expected[c]) <= 2)) count++;
  }
  assert.ok(count > 1000, `the native snapshot must contain decoded image pixels, got ${count}`);
  return count;
}

test('native image tabs draw real pixels and retain root identity through refresh and restart', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'redit-images-'));
  let server, gui;
  try {
    const one = path.join(dir, 'one'), two = path.join(dir, 'two');
    await mkdir(one); await mkdir(two);
    await writeFile(path.join(one, 'proof.png'), redImage); await writeFile(path.join(two, 'proof.png'), blueImage);
    server = await startServer({ stateDir: path.join(dir, 'state') });
    const root = await server.store.addRoot(one), other = await server.store.addRoot(two);
    gui = await nativeClient(server, { root: root.id });
    await gui.control('tree-entry', 'proof.png');
    let state = await gui.until(s => s.tabs.some(t => t?.path === 'proof.png' && (t.image?.width || t.error || t.formatMode)), 'file response');
    let tab = state.tabs.findIndex(t => t?.path === 'proof.png');
    assert.equal(state.tabs[tab].image?.width, 128, 'PNG opens in a native image view, not the raw/text editor');
    assert.equal(state.tabs[tab].image.height, 80); assert.equal(state.tabs[tab].text, undefined);
    const fitted = await pixels(gui, path.join(dir, 'red.bmp'), 0, tab);
    await gui.control('image-actual', '', tab);
    state = await gui.until(s => s.tabs[tab].image?.actual === true);
    assert.equal(state.tabs[tab].dirty, false);
    const actual = await pixels(gui, path.join(dir, 'actual.bmp'), 0, tab);
    assert.ok(fitted > actual * 2, 'Fit and 100% change the displayed image size');
    const imageTab = state.tabs[tab];
    await gui.command({ op: 'button', x: imageTab.header[0] + 20, y: imageTab.header[1] + 10, down: true });
    await gui.command({ op: 'motion', x: 700, y: 400 });
    await gui.command({ op: 'button', x: 700, y: 400, down: false });
    await gui.until(s => s.tabs[tab].rect[0] > 280, 'image moved to the right pane');
    await gui.control('toolbar', 'Root'); await gui.control('menu-root', 'two');
    await gui.control('toolbar', 'Tree');
    state = await gui.until(s => s.tabs.some(t => t?.root === other.id && t.tree));
    await gui.control('tree-entry', 'proof.png', state.tabs.findIndex(t => t?.root === other.id && t.tree));
    state = await gui.until(s => s.tabs.some(t => t?.root === other.id && t.image?.width === 128));
    const otherTab = state.tabs.findIndex(t => t?.root === other.id && t.image);
    await pixels(gui, path.join(dir, 'other-root.bmp'), 2, otherTab);
    assert.equal(state.tabs[tab].root, root.id);
    await gui.control('tab', '', tab);
    await writeFile(path.join(one, 'proof.png'), 'broken image');
    await gui.control('image-refresh', '', tab);
    state = await gui.until(s => s.tabs[tab].error);
    assert.equal(state.tabs[tab].image.width, 0, 'failed refresh does not show stale pixels');
    await writeFile(path.join(one, 'proof.png'), blueImage);
    await gui.control('image-refresh', '', tab);
    await gui.until(s => !s.tabs[tab].error && s.tabs[tab].image.width === 128);
    await pixels(gui, path.join(dir, 'blue.bmp'), 2, tab);
    await gui.close(); gui = await nativeClient(server, { root: root.id });
    state = await gui.until(s => s.tabs.some(t => t?.root === root.id && t.path === 'proof.png' && t.image?.width === 128));
    tab = state.tabs.findIndex(t => t?.root === root.id && t.path === 'proof.png');
    assert.equal(state.tabs[tab].root, root.id); assert.equal(state.tabs[tab].image.actual, true);
    await pixels(gui, path.join(dir, 'restored.bmp'), 2, tab);
    assert.deepEqual(await readFile(path.join(one, 'proof.png')), blueImage);
    assert.deepEqual(await readFile(path.join(two, 'proof.png')), blueImage);
  } finally { await gui?.close(); await server?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('native image view displays the supplied project evidence PNG', {
  timeout: 30000, skip: !process.env.RENGINE_IMAGE_PROOF,
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'redit-image-proof-'));
  let server, gui;
  try {
    await copyFile(process.env.RENGINE_IMAGE_PROOF, path.join(dir, 'proof.png'));
    server = await startServer({ stateDir: path.join(dir, 'state') });
    const root = await server.store.addRoot(dir);
    const script = path.join(dir, 'chat.cjs');
    await writeFile(script, `process.stdin.setRawMode(true); process.stdin.resume();
const draw = () => process.stdout.write('\\x1b[2J\\x1b[H' + ${JSON.stringify(path.join(root.path, 'proof.png'))} + '\\r\\n');
draw(); process.on('SIGWINCH', draw);`);
    const session = await server.sessions.terminal({ rootId: root.id, command: process.execPath, args: [script] });
    gui = await nativeClient(server, { root: root.id, terminal: session.id });
    const state = await gui.until(s => s.tabs.some(t => t?.session === session.id && t.text?.includes('/proof.png')));
    const t = state.tabs.find(t => t?.session === session.id), x = t.rect[0] + 2 * t.cellSize[0], y = t.rect[1] + t.cellSize[1] / 2;
    const mod = process.platform === 'darwin' ? 0xc00 : 0xc0;
    await gui.command({ op: 'button', x, y, mod, down: true });
    await gui.command({ op: 'button', x, y, mod, down: false });
    await gui.command({ op: 'motion', x, y, mod: 0 });
    await gui.until(s => s.tabs.some(t => t?.path === 'proof.png' && t.image?.uploaded));
    await mkdir('.cache/evidence', { recursive: true });
    assert.equal(await gui.command({ op: 'snapshot', path: path.resolve('.cache/evidence/file-image-proof.bmp') }), true);
    assert.equal(server.sessions.snapshot(session.id).pid, session.pid);
  } finally { await gui?.close(); await server?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('modified pointer clicks open chat file references without sending mouse input to the retained agent', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'redit-links-'));
  let server, gui;
  try {
    await writeFile(path.join(dir, 'proof.png'), redImage);
    await writeFile(path.join(dir, 'note.txt'), 'first\nsecond\nthird\n');
    const script = path.join(dir, 'chat.cjs'), received = path.join(dir, 'received');
    await writeFile(received, '');
    await writeFile(script, `const fs = require('node:fs'); process.stdin.setRawMode(true);
const draw = () => process.stdout.write('\\x1b[2J\\x1b[H[Before](proof.png)\\r\\nnote.txt:3:2\\r\\n');
process.stdout.write('\\x1b[?1000h\\x1b[?1006h'); draw(); process.on('SIGWINCH', draw);
process.stdin.on('data', data => { fs.appendFileSync(${JSON.stringify(received)}, data); if (data.toString() === 'h') process.stdout.write(Array.from({length:80}, (_, i) => 'history ' + i + '\\r\\n').join('')); });`);
    server = await startServer({ stateDir: path.join(dir, 'state') });
    const root = await server.store.addRoot(dir);
    await mkdir(path.join(dir, 'other'));
    await writeFile(path.join(dir, 'other', 'proof.png'), blueImage);
    await server.store.addRoot(path.join(dir, 'other'));
    const session = await server.sessions.terminal({ rootId: root.id, command: process.execPath, args: [script] });
    gui = await nativeClient(server, { root: root.id, terminal: session.id });
    let state = await gui.until(s => s.tabs.some(t => t?.session === session.id && t.text?.includes('[Before]')));
    const term = state.tabs.findIndex(t => t?.session === session.id);
    const click = async (col, row) => {
      await gui.control('tab', '', term);
      const s = await gui.command({ op: 'state' }), t = s.tabs[term];
      const x = t.rect[0] + (col + 0.5) * t.cellSize[0], y = t.rect[1] + (row + 0.5) * t.cellSize[1];
      const mod = process.platform === 'darwin' ? 0xc00 : 0xc0;
      await gui.command({ op: 'motion', x, y, mod });
      await gui.command({ op: 'button', x, y, mod, down: true });
      await gui.command({ op: 'button', x, y, mod, down: false });
      await gui.command({ op: 'motion', x, y, mod: 0 }); await delay(150);
    };
    await gui.control('toolbar', 'Root'); await gui.control('menu-root', 'other');
    await click(3, 0);
    state = await gui.command({ op: 'state' });
    assert.ok(state.tabs.some(t => t?.path === 'proof.png'), 'clicking the Markdown label opens a file tab');
    await gui.until(s => s.tabs.some(t => t?.path === 'proof.png' && t.image?.width === 128));
    await click(3, 1);
    state = await gui.until(s => s.tabs.some(t => t?.path === 'note.txt' && t.text));
    const note = state.tabs.find(t => t?.path === 'note.txt');
    assert.equal(note.root, root.id); assert.deepEqual(note.caret, [2, 1]);
    assert.equal(await readFile(received, 'utf8'), '', 'opening both references sends neither mouse press nor release to the agent');
    assert.equal(server.sessions.snapshot(session.id).pid, session.pid);
    await gui.control('tab', '', term);
    let t = (await gui.command({ op: 'state' })).tabs[term];
    await gui.click(t.rect[0] + 10, t.rect[1] + 10);
    await gui.command({ op: 'text', text: 'h' });
    await gui.until(s => s.tabs[term].historyLines > 0 && s.tabs[term].text.includes('history 79'));
    await gui.key('Home', 3);
    state = await gui.until(s => s.tabs[term].text.includes('[Before]') && s.tabs[term].scrollOffset > 0);
    const before = await readFile(received, 'utf8');
    await click(3, 0);
    state = await gui.command({ op: 'state' });
    assert.equal(state.tabs[state.focus].path, 'proof.png');
    assert.equal(state.tabs.filter(t => t?.path === 'proof.png').length, 1, 'history link reuses the original root-bound tab');
    assert.equal(await readFile(received, 'utf8'), before);

  } finally { await gui?.close(); await server?.close(); await rm(dir, { recursive: true, force: true }); }
});

async function wrappedChat(check) {
  const dir = await mkdtemp(path.join(tmpdir(), 'redit-wrapped-links-'));
  const target = 'third_party/rengine/docs/evidence/chat-file-images/pv-hands-viewer.png';
  let server, gui;
  try {
    await mkdir(path.dirname(path.join(dir, target)), { recursive: true });
    await writeFile(path.join(dir, target), redImage);
    const script = path.join(dir, 'chat.cjs');
    const display = '  viewer screenshot (\x1b[36mthird_party/rengine/docs/evidence/chat-file-images/pv-\r\n  hands-viewer.png\x1b[0m). Done.\r\n  plain words\r\n  /outside/no.png\r\n';
    await writeFile(script, `process.stdin.setRawMode(true); process.stdin.resume();
const draw = () => process.stdout.write('\\x1b[2J\\x1b[H' + ${JSON.stringify(display)});
draw(); process.on('SIGWINCH', draw);
process.stdin.on('data', data => {
  if (data.toString() === 'h') process.stdout.write(Array.from({length:80}, (_, i) => 'history ' + i + '\\r\\n').join(''));
  if (data.toString() === 'w') process.stdout.write('\\x1b[2J\\x1b[H' + require('node:fs').realpathSync(${JSON.stringify(dir)}) + '/' + ${JSON.stringify(target)} + '\\r\\n');
  if (data.toString() === 'c') process.stdout.write('\\x1b[2J\\x1b[H  plain words\\r\\n');
});`);
    server = await startServer({ stateDir: path.join(dir, 'state') });
    const root = await server.store.addRoot(dir);
    const session = await server.sessions.terminal({ rootId: root.id, command: process.execPath, args: [script] });
    gui = await nativeClient(server, { root: root.id, terminal: session.id });
    const state = await gui.until(s => s.tabs.some(t => t?.session === session.id && t.text?.includes('hands-viewer.png')));
    const term = state.tabs.findIndex(t => t?.session === session.id);
    const point = async (col, row, mod = 0) => {
      const t = (await gui.command({ op: 'state' })).tabs[term];
      const p = { x: t.rect[0] + (col + 0.5) * t.cellSize[0], y: t.rect[1] + (row + 0.5) * t.cellSize[1], mod };
      await gui.command({ op: 'motion', ...p }); await delay(60); return p;
    };
    const click = async (col, row) => {
      await gui.control('tab', '', term);
      const p = await point(col, row, process.platform === 'darwin' ? 0xc00 : 0xc0);
      await gui.command({ op: 'button', ...p, down: true });
      await gui.command({ op: 'button', ...p, down: false });
      await gui.command({ op: 'motion', ...p, mod: 0 });
      await delay(100);
    };
    await check({ gui, target, absolute: root.path + '/' + target, term, point, click });
    assert.equal(server.sessions.snapshot(session.id).pid, session.pid);
  } finally { await gui?.close(); await server?.close(); await rm(dir, { recursive: true, force: true }); }
}

test('Codex word-wrapped paths open completely from either row, resize and scrollback', { timeout: 30000 }, async () => {
  await wrappedChat(async ({ gui, target, absolute, term, click }) => {
    for (const [col, row] of [[25, 0], [5, 1]]) {
      await click(col, row);
      const state = await gui.command({ op: 'state' });
      assert.equal(state.tabs[state.focus]?.path, target, 'both halves open the entire displayed path');
      await gui.until(s => s.tabs.some(t => t?.path === target && t.image?.uploaded));
      assert.equal(state.tabs.filter(t => t?.type === 2).length, 1, 'no truncated-path tab is created');
    }
    await gui.control('tab', '', term);
    await gui.command({ op: 'resize', width: 1100, height: 740 });
    await gui.until(s => s.width === 1100 && s.tabs[term].text.includes('hands-viewer.png'));
    await click(5, 1);
    assert.equal((await gui.command({ op: 'state' })).tabs.filter(t => t?.type === 2).length, 1);
    await gui.control('tab', '', term);
    const t = (await gui.command({ op: 'state' })).tabs[term];
    await gui.click(t.rect[0] + 10, t.rect[1] + 10);
    await gui.command({ op: 'text', text: 'h' });
    await gui.until(s => s.tabs[term].historyLines > 0 && s.tabs[term].text.includes('history 79'));
    await gui.key('Home', 3);
    await gui.until(s => s.tabs[term].scrollOffset > 0 && s.tabs[term].text.includes('viewer screenshot'));
    await click(5, 1);
    const state = await gui.command({ op: 'state' });
    assert.equal(state.tabs[state.focus]?.path, target);
    await gui.control('tab', '', term);
    const live = (await gui.command({ op: 'state' })).tabs[term];
    await gui.click(live.rect[0] + 10, live.rect[1] + 10);
    await gui.command({ op: 'text', text: 'w' });
    await gui.until(s => s.tabs[term].scrollOffset === 0 && s.tabs[term].text.replaceAll('\n', '').startsWith(absolute));
    for (const row of [0, 1]) {
      await click(5, row);
      const opened = await gui.command({ op: 'state' });
      assert.equal(opened.tabs[opened.focus]?.path, target, 'full-width terminal wrapping still opens the same image');
    }
  });
});

test('file-reference hover selects the real system hand cursor and clears it outside links', { timeout: 30000 }, async () => {
  await wrappedChat(async ({ gui, term, point }) => {
    await point(25, 0);
    await gui.until(s => s.fileLinkCursor === true, 'hover selects the SDL hand cursor without a modifier');
    await point(5, 1);
    assert.equal((await gui.command({ op: 'state' })).fileLinkCursor, true, 'the continuation is the same hover target');
    await mkdir('.cache/evidence', { recursive: true });
    await gui.command({ op: 'snapshot', path: path.resolve('.cache/evidence/wrapped-link-hover.bmp') });
    await point(5, 2);
    await gui.until(s => s.fileLinkCursor === false, 'plain text restores the default cursor');
    await point(5, 3);
    assert.equal((await gui.command({ op: 'state' })).fileLinkCursor, false, 'root-invalid references have no open-file cursor');
    await point(25, 0);
    await gui.command({ op: 'focus', focused: false });
    await gui.until(s => s.fileLinkCursor === false, 'focus loss restores the default cursor');
    await gui.command({ op: 'focus', focused: true });
    await point(25, 0);
    await gui.until(s => s.fileLinkCursor === true, 'hover restores the hand cursor');
    await gui.control('toolbar', 'Root');
    await point(25, 0);
    assert.equal((await gui.command({ op: 'state' })).fileLinkCursor, false, 'an overlay releases the link cursor');
    await gui.key('Escape');
    const t = (await gui.command({ op: 'state' })).tabs[term];
    await gui.click(t.rect[0] + 10, t.rect[1] + 10);
    await point(25, 0);
    await gui.until(s => s.fileLinkCursor === true, 'hand cursor before new terminal output');
    await gui.command({ op: 'text', text: 'c' });
    await gui.until(s => s.fileLinkCursor === false && !s.tabs[term].text.includes('viewer screenshot'), 'new output clears stale hover without mouse movement');
    assert.equal((await gui.command({ op: 'state' })).tabs.filter(t => t?.type === 2).length, 0, 'hover never opens a file');
    assert.ok(term >= 0);
  });
});
