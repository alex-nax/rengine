import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';

test('C/microui uses the real tree, Unicode editor and retained PTY through native events', { timeout: 45000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-native-'));
  let server, gui;
  try {
    const project = path.join(dir, 'project'); await mkdir(project);
    await writeFile(path.join(project, 'example.txt'), 'first line\nsecond line\n');
    server = await startServer({ stateDir: path.join(dir, 'state') });
    const root = await server.store.addRoot(project);
    const shell = await server.sessions.terminal({ rootId: root.id });
    gui = await nativeClient(server, { root: root.id, terminal: shell.id });
    let state = await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree) && s.tabs.some(t => t?.session === shell.id && t.text), 'tree and shell');
    const term = state.tabs.find(t => t?.session === shell.id);
    await gui.click(term.rect[0] + 50, term.rect[1] + 15);
    await gui.command({ op: 'text', text: "printf 'NATIVE_%s_世界\\n' PTY" }); await gui.key('Return');
    await gui.until(s => s.tabs.some(t => t?.session === shell.id && t.text?.includes('NATIVE_PTY_世界')), 'actual PTY output');
    assert.match(server.sessions.snapshot(shell.id, true).output, /NATIVE_PTY_世界/);
    await gui.control('tree-entry', 'example.txt', 0); // by control record: the toolbar and tab strip moved with the design update
    state = await gui.until(s => s.tabs.some(t => t?.type === 2 && t.text === 'first line\nsecond line\n'), 'editor file opened from tree');
    let editor = state.tabs.find(t => t?.type === 2);
    await gui.click(editor.rect[0] + 12, editor.rect[1] + 8);
    await gui.key('A', 0xc0); await gui.command({ op: 'text', text: 'native café 世界\n' });
    await gui.until(s => s.tabs.some(t => t?.type === 2 && t.text === 'native café 世界\n' && t.dirty), 'Unicode edit');
    assert.equal(await readFile(path.join(project, 'example.txt'), 'utf8'), 'first line\nsecond line\n');
    await gui.key('S', 0xc0);
    await gui.until(s => s.tabs.some(t => t?.type === 2 && !t.dirty), 'explicit Save');
    assert.equal(await readFile(path.join(project, 'example.txt'), 'utf8'), 'native café 世界\n');
    await writeFile(path.join(project, 'example.txt'), 'external edit\n');
    await gui.command({ op: 'text', text: 'conflicting draft' }); await gui.key('S', 0xc0);
    state = await gui.until(s => s.tabs.some(t => t?.type === 2 && t.conflict && t.dirty), 'external conflict');
    assert.equal(await readFile(path.join(project, 'example.txt'), 'utf8'), 'external edit\n');
    await gui.control('discard', '', state.tabs.findIndex(t => t?.type === 2)); // by control record: the editor's actions are right-aligned now
    state = await gui.until(s => s.tabs.some(t => t?.type === 2 && t.text === 'external edit\n' && !t.dirty), 'explicit Discard');
    editor = state.tabs.find(t => t?.type === 2);
    await gui.click(editor.rect[0] + 12, editor.rect[1] + 8);
    await gui.command({ op: 'text', text: 'recovery' });
    state = await gui.until(s => s.tabs.some(t => t?.type === 2 && t.dirty), 'recovery draft');
    editor = state.tabs.find(t => t?.type === 2);
    const header = editor.header;
    await gui.command({ op: 'motion', x: header[0] + 20, y: header[1] + 10 });
    await gui.command({ op: 'button', x: header[0] + 20, y: header[1] + 10 });
    await gui.command({ op: 'motion', x: 700, y: 500 });
    await gui.command({ op: 'button', x: 700, y: 500, down: false });
    await gui.until(s => s.tabs.some(t => t?.type === 2 && t.root === root.id && t.rect[0] > 280 && t.dirty), 'editor moved to the other pane');
    await mkdir('.cache/evidence', { recursive: true });
    assert.equal(await gui.command({ op: 'snapshot', path: path.resolve('.cache/evidence/native-workspace.bmp') }), true);
    await gui.close(); gui = null;
    assert.equal(server.sessions.snapshot(shell.id).state, 'running');
    assert.equal(server.sessions.snapshot(shell.id).pid, shell.pid);
    gui = await nativeClient(server, { root: root.id });
    state = await gui.until(s => s.tabs.some(t => t?.type === 2 && t.text?.includes('recovery') && t.dirty), 'native GUI draft restore');
    assert.equal(state.state.sessions.find(s => s.id === shell.id).pid, shell.pid);
    assert.equal(await readFile(path.join(project, 'example.txt'), 'utf8'), 'external edit\n');
  } finally {
    await gui?.close(); await server?.close(); await rm(dir, { recursive: true, force: true });
  }
});
