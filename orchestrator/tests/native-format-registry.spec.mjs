import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';
import { declaration, pack, entries } from './format-fixtures.mjs';

const hexRow = (t, key = 'hexFirstRow') => t?.[key] ?? '';
test('registered formats open raw, preview their tree with entries, retry failures and restore their mode', { timeout: 90000 }, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-native-formats-')));
  let server, gui;
  try {
    const project = path.join(directory, 'project'); await mkdir(path.join(project, '.rengine'), { recursive: true });
    await writeFile(path.join(project, '.rengine/project.json'), JSON.stringify(declaration()));
    await writeFile(path.join(project, 'sample.pack'), pack({ entries }));
    await writeFile(path.join(project, 'failing.pack'), pack({ entries: {}, fail: 'boom: archive is corrupt' }));
    await writeFile(path.join(project, 'blob.bin'), Buffer.from([0, 255, 10, 13, 65]));
    await writeFile(path.join(project, 'note.txt'), 'note\n');
    server = await startServer({ stateDir: path.join(directory, 'state') });
    const root = await server.store.addRoot(project);
    gui = await nativeClient(server, { root: root.id });
    await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree), 'tree');
    const open = async name => {
      for (let i = 0; i < 8; i++) {
        const s = await gui.command({ op: 'state' }); if (s.controls.some(c => c.role === 'tab' && c.tab === 0)) break;
        const { rect: [x, y, w, h] } = s.controls.find(c => c.role === 'tab-scroll' && c.key === 'previous'); await gui.click(x + w / 2, y + h / 2);
      }
      await gui.control('tab', '', 0); await gui.control('tree-entry', name);
    };
    await open('sample.pack');
    let state = await gui.until(s => s.tabs.some(t => t?.type === 2 && t.formatMode === 'raw' && hexRow(t).startsWith('00000000  50 41 43 4b 00 7b')), 'declared file opens in raw hex by default');
    const tab = state.tabs.findIndex(t => t?.type === 2 && t.path === 'sample.pack'), packTab = state.tabs[tab];
    assert.equal(packTab.format, 'fixture-pack'); assert.equal(packTab.hexSize, (await readFile(path.join(project, 'sample.pack'))).length);
    assert.match(hexRow(packTab), /\|PACK\.\{"entries":\|$/, 'ASCII column with dots for NUL');
    assert.ok(!state.controls.some(c => c.tab === tab && ['save', 'discard'].includes(c.role)), 'raw mode offers no Save/Discard');
    assert.deepEqual(state.controls.filter(c => c.tab === tab && c.role === 'format-mode').map(c => c.key), ['raw', 'preview'], 'mode switch lists the declared modes only');
    await gui.control('format-mode', 'preview', tab);
    state = await gui.until(s => s.tabs[tab]?.formatMode === 'preview' && s.tabs[tab].previewKind === 'tree' && s.tabs[tab].previewFiles === 4, 'preview tree loaded');
    assert.deepEqual(state.tabs[tab].previewTop, [{ name: 'Worlds', dirs: 1, files: 1 }]);
    assert.match(state.tabs[tab].formatCommand, /pack-producer\.mjs tree .*sample\.pack$/, 'pane names the command it ran');
    assert.ok(state.controls.some(c => c.tab === tab && c.role === 'preview-file' && c.key === 'readme.txt'));
    assert.ok(!state.controls.some(c => c.tab === tab && c.role === 'preview-file' && c.key === 'Worlds/t01.dat'), 'collapsed directory hides its files');
    await gui.control('preview-dir', 'Worlds', tab);
    await gui.control('preview-file', 'Worlds/t01.dat', tab);
    state = await gui.until(s => s.tabs[tab]?.entry?.path === 'Worlds/t01.dat' && hexRow(s.tabs[tab].entry).startsWith('00000000  00 01 02 ff fe fd'), 'binary entry shown as hex');
    assert.equal(state.tabs[tab].entry.size, 6); assert.match(state.tabs[tab].entry.sha256, /^[0-9a-f]{64}$/); assert.equal(state.tabs[tab].entry.text, undefined);
    assert.match(state.tabs[tab].entry.command, /cat .*sample\.pack Worlds\/t01\.dat$/);
    await gui.control('preview-file', 'readme.txt', tab);
    state = await gui.until(s => s.tabs[tab]?.entry?.path === 'readme.txt' && s.tabs[tab].entry.text === 'hello pack\n', 'UTF-8 entry shown as text');
    assert.ok(state.controls.some(c => c.tab === tab && c.role === 'entry-close'));
    await mkdir('.cache/evidence', { recursive: true });
    assert.equal(await gui.command({ op: 'snapshot', path: path.resolve('.cache/evidence/format-preview.bmp') }), true);
    await gui.control('format-mode', 'raw', tab);
    state = await gui.until(s => s.tabs[tab]?.formatMode === 'raw' && hexRow(s.tabs[tab]).startsWith('00000000  50 41 43 4b'), 'back to raw');
    assert.equal(state.tabs[tab].entry, undefined, 'leaving preview drops the entry view');
    await gui.control('format-mode', 'preview', tab);
    await gui.until(s => s.tabs[tab]?.formatMode === 'preview' && s.tabs[tab].previewFiles === 4); await delay(400);
    await gui.close(); gui = null;
    gui = await nativeClient(server, { root: root.id });
    state = await gui.until(s => s.tabs.some(t => t?.path === 'sample.pack' && t.formatMode === 'preview' && t.previewFiles === 4), 'persisted preview mode restored after GUI restart');
    const restored = state.tabs.findIndex(t => t?.path === 'sample.pack');
    await open('failing.pack');
    state = await gui.until(s => s.tabs.some(t => t?.path === 'failing.pack' && t.formatMode === 'raw' && hexRow(t).startsWith('00000000  50 41 43 4b')), 'failing pack still opens raw');
    const failing = state.tabs.findIndex(t => t?.path === 'failing.pack');
    await gui.control('format-mode', 'preview', failing);
    state = await gui.until(s => s.tabs[failing]?.error === 'Command failed (exit 2): boom: archive is corrupt', 'stderr first line shown in the pane');
    assert.ok(state.controls.some(c => c.tab === failing && c.role === 'format-retry'), 'Retry is offered');
    assert.match(state.tabs[failing].formatCommand, /pack-producer\.mjs tree/, 'failed command is named');
    await gui.control('format-retry', '', failing);
    await gui.until(s => s.tabs[failing]?.error === 'Command failed (exit 2): boom: archive is corrupt' && s.tabs[failing].formatMode === 'preview');
    await open('blob.bin');
    state = await gui.until(s => s.tabs.some(t => t?.path === 'blob.bin' && t.formatMode === 'raw' && /^00000000  00 ff 0a 0d 41 +\|\.\.\.\.A\|$/.test(hexRow(t))), 'unregistered binary falls back to hex');
    const blob = state.tabs.findIndex(t => t?.path === 'blob.bin');
    assert.equal(state.tabs[blob].format, ''); assert.equal(state.tabs[blob].hexSize, 5);
    assert.deepEqual(state.controls.filter(c => c.tab === blob && c.role === 'format-mode').map(c => c.key), ['text', 'raw']);
    await open('note.txt');
    state = await gui.until(s => s.tabs.some(t => t?.path === 'note.txt' && t.text === 'note\n'), 'text files keep the editor');
    const note = state.tabs.findIndex(t => t?.path === 'note.txt');
    assert.equal(state.tabs[note].formatMode, undefined); assert.ok(state.controls.some(c => c.tab === note && c.role === 'save'));
    assert.equal(state.tabs[restored].formatMode, 'preview');
    assert.equal(await readFile(path.join(project, 'note.txt'), 'utf8'), 'note\n');
    assert.deepEqual(server.store.state.drafts, {});
  } finally {
    await gui?.close(); await server?.close(); await rm(directory, { recursive: true, force: true });
  }
});
