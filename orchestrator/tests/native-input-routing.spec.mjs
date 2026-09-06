import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';

const KMOD_LCTRL = 0x0040, KMOD_LGUI = 0x0400;

test('a shell keeps the control chords the platform modifier is not', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-chords-'));
  const project = path.join(dir, 'project'); await mkdir(project);
  await writeFile(path.join(project, 'a.txt'), 'x\n');
  const fixture = path.join(dir, 'keys.cjs');
  // Echoes every byte it receives as hex, so the test can see what actually reached the shell.
  await writeFile(fixture, `process.stdin.setRawMode(true);
process.stdout.write('KEYS READY\\r\\n');
process.stdin.on('data', d => process.stdout.write('GOT ' + d.toString('hex') + '\\r\\n'));
setInterval(() => {}, 1000);`);
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const root = await server.store.addRoot(project);
  const shell = await server.sessions.terminal({ rootId: root.id, command: process.execPath, args: [fixture] });
  const gui = await nativeClient(server, { root: root.id, terminal: shell.id });
  try {
    const state = await gui.until(s => s.tabs.some(t => t?.type === 3 && t.text?.includes('KEYS READY')), 'the shell is up');
    const term = state.tabs.find(t => t?.type === 3);
    const panes = () => gui.command({ op: 'state' }).then(s => s.layout.panes.filter(Boolean).length);
    const before = await panes();

    // Focus the terminal, then press Ctrl+W. On macOS that is readline's delete-word and must reach
    // the shell; the workspace's close-view chord is Cmd+W, which the menu is what prints.
    await gui.click(term.rect[0] + term.rect[2] / 2, term.rect[1] + term.rect[3] / 2);
    await delay(150);
    await gui.command({ op: 'key', key: 'W', mod: KMOD_LCTRL });
    await gui.command({ op: 'key', key: 'W', mod: KMOD_LCTRL, down: false });
    await delay(400);
    const after = await gui.command({ op: 'state' });
    const text = after.tabs.find(t => t?.type === 3)?.text ?? '';
    assert.match(text, /GOT 17/, `Ctrl+W reached the shell as 0x17: ${JSON.stringify(text.slice(-120))}`);
    assert.equal(after.layout.panes.filter(Boolean).length, before, 'and did not close the view');
  } finally {
    await gui.close(); await server.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('an open menu owns the keyboard instead of typing into the pane beneath it', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-overlay-keys-'));
  const project = path.join(dir, 'project'); await mkdir(project);
  await writeFile(path.join(project, 'a.txt'), 'x\n');
  const fixture = path.join(dir, 'keys.cjs');
  await writeFile(fixture, `process.stdin.setRawMode(true);
process.stdout.write('KEYS READY\\r\\n');
process.stdin.on('data', d => process.stdout.write('GOT ' + d.toString('hex') + '\\r\\n'));
setInterval(() => {}, 1000);`);
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const root = await server.store.addRoot(project);
  const shell = await server.sessions.terminal({ rootId: root.id, command: process.execPath, args: [fixture] });
  const gui = await nativeClient(server, { root: root.id, terminal: shell.id });
  try {
    const state = await gui.until(s => s.tabs.some(t => t?.type === 3 && t.text?.includes('KEYS READY')), 'the shell is up');
    const term = state.tabs.find(t => t?.type === 3);

    // Focus the terminal, prove it is listening, then open the pane menu over it with a right press.
    await gui.click(term.rect[0] + term.rect[2] / 2, term.rect[1] + term.rect[3] / 2);
    await delay(150);
    await gui.command({ op: 'text', text: 'a' });
    await gui.until(s => (s.tabs.find(t => t?.type === 3)?.text ?? '').includes('GOT 61'), 'the shell receives typing');

    const header = state.tabs.find(t => t?.type === 3).header;
    const x = header[0] + header[2] + 20, y = header[1] + 4;
    await gui.command({ op: 'motion', x, y });
    await gui.command({ op: 'button', button: 3, x, y, down: true });
    await gui.command({ op: 'button', button: 3, x, y, down: false });
    await gui.until(s => s.controls?.some(c => c.role === 'menu-pane'), 'the pane menu opened');

    // Now type. None of it may reach the shell while a surface is drawn on top of it.
    const seen = () => gui.command({ op: 'state' }).then(s => (s.tabs.find(t => t?.type === 3)?.text ?? ''));
    const before = await seen();
    await gui.command({ op: 'text', text: 'zzz' });
    await delay(400);
    const after = await seen();
    assert.equal(after, before, `nothing typed reached the shell under the menu: ${JSON.stringify(after.slice(-80))}`);
    const open = await gui.command({ op: 'state' });
    assert.ok(open.controls.some(c => c.role === 'menu-pane'), 'and the menu is still open');
  } finally {
    await gui.close(); await server.close(); await rm(dir, { recursive: true, force: true });
  }
});
