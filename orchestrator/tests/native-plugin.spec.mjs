import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';

// Spec 106: a plugin is loaded into a REAL window, and what it drew is read back off the screen.
// The modules are the fixtures the desktop build produces from orchestrator/native/tests/plugins/;
// the automation `plugin` op stands in for the declaration the other lane will pass to the same
// loader with the same three inputs.
const run = promisify(execFile);
const WIN = process.platform === 'win32';
const PYTHON = WIN ? 'python' : 'python3';
const ABI = 're-plugin/2';
const PLUGIN = 9; // RE_PLUGIN in app.h
const modulePath = name => path.resolve('.cache/desktop/plugins', `${name}.${WIN ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so'}`);
const FIXTURE = modulePath('rengine_plugin_fixture'), NEWER = modulePath('rengine_plugin_fixture_abi_new');

async function count(file, region, colour) {
  const { stdout } = await run(PYTHON, ['tools/bmp_find.py', file, '--logical-width', '1280', '--region', region.map(Math.round).join(','), '--colour', colour]);
  return JSON.parse(stdout).count;
}
async function workspace(dir) {
  const project = path.join(dir, 'project'); await mkdir(project);
  await writeFile(path.join(project, 'readme.txt'), 'plugin fixture project\n');
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const root = await server.store.addRoot(project);
  const gui = await nativeClient(server, { root: root.id });
  const state = await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree), 'workspace');
  return { server, root, gui, state };
}

test('a plugin loads in the real window: its tab appears, its drawing reaches the frame, its clip holds, and the tab survives a restart', { timeout: 120000 }, async () => {
  assert.ok(existsSync(FIXTURE), `the fixture module is built by npm run build: ${FIXTURE}`);
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-native-plugin-')));
  let server, gui;
  try {
    let state; ({ server, gui, state } = await workspace(dir));
    const root = state.root;
    assert.deepEqual(state.plugins, [], 'nothing is loaded until something is declared');
    // Put the plugin into the LEFT pane, so the rectangle the fixture deliberately draws past its
    // area lands inside the other pane and the clip has something to hide.
    await gui.control('tab', '', state.tabs.findIndex(t => t?.type === 1));
    assert.equal(await gui.command({ op: 'plugin', name: 'fixture', path: FIXTURE, abi: ABI }), true);
    state = await gui.until(s => s.plugins?.some(p => p.name === 'fixture' && p.state === 'loaded')
      && s.tabs.some(t => t?.type === PLUGIN && t.path === 'fixture/hello' && t.rect?.[2] > 0), 'plugin tab visible');
    const row = state.plugins.find(p => p.name === 'fixture');
    assert.deepEqual(row.tabs, ['fixture/hello']); assert.equal(row.version, '1.0.0'); assert.equal(row.path, FIXTURE);
    const index = state.tabs.findIndex(t => t?.type === PLUGIN && t.path === 'fixture/hello'); const tab = state.tabs[index];
    assert.equal(tab.title, 'Fixture');
    assert.ok(state.layout.panes.some(p => p?.tabs?.[p.selected] === index), 'selected in its pane');
    const [x, y, w, h] = tab.rect;
    /* One pane of a split window rather than the whole of it. Which side is the open-target rule's
       business (spec 130): a plugin view is a document, so it lands in the work pane rather than on
       top of the explorer that is showing in the other one. */
    assert.ok(w > 100 && w < state.width - 100 && x + w <= state.width,
      `one pane of a split window, not the whole width: ${tab.rect} of ${state.width}`);
    assert.ok(h > 80, `tall enough to hold the drawing: ${tab.rect}`);
    await delay(200);
    const file = path.join(dir, 'plugin.bmp');
    assert.equal(await gui.command({ op: 'snapshot', path: file }), true);
    // The fixture's magenta square at its area's origin: the commands reached the frame.
    assert.ok(await count(file, [x + 8, y + 8, 40, 40], '#ff00ff') >= 1500, 'magenta reached the frame');
    // Its right-aligned cyan label: text_width measured through the desktop's faces. The label ends
    // 8px before the right edge, so its ink lies in the body region and none in the final strip. A
    // zero width would start the label at that strip instead — the first version of this assertion
    // only looked for cyan anywhere in the right 120px, and a zero width still put a glyph there.
    assert.ok(await count(file, [x + w - 108, y + 8, 100, 20], '#00ffff') > 0, 'the label body landed where text_width put it');
    assert.equal(await count(file, [x + w - 8, y + 8, 8, 20], '#00ffff'), 0, 'and it ends 8px before the edge');
    // The rectangle it drew past its area never reached the screen: the frame's clip.
    assert.equal(await count(file, [x + w, y, 60, 60], '#ff00ff'), 0, 'clipped to the tab');

    // Restart the window: the tab is restored by identity, as a placeholder until the plugin loads again.
    await gui.close(); gui = null;
    gui = await nativeClient(server, { root });
    state = await gui.until(s => s.connected && s.tabs.some(t => t?.type === PLUGIN && t.path === 'fixture/hello'), 'restored plugin tab');
    assert.deepEqual(state.plugins, [], 'the window restores the layout, not the module');
    assert.equal(await gui.command({ op: 'plugin', name: 'fixture', path: FIXTURE, abi: ABI }), true);
    state = await gui.until(s => s.plugins?.some(p => p.state === 'loaded'), 'loaded again');
    assert.equal(state.tabs.filter(t => t?.type === PLUGIN).length, 1, 'the same tab, not a second one');
  } finally {
    await gui?.close(); await server?.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('a module that will not load, one built against another ABI, and a declaration claiming another ABI are refused by name, and the window keeps answering', { timeout: 90000 }, async () => {
  assert.ok(existsSync(NEWER), `the wrong-ABI module is built by npm run build: ${NEWER}`);
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-native-plugin-refused-')));
  let server, gui;
  try {
    ({ server, gui } = await workspace(dir));
    const missing = path.join(dir, 'no-such-module.dylib');
    const first = await gui.command({ op: 'plugin', name: 'missing', path: missing, abi: ABI });
    assert.match(String(first), /plugin missing/); assert.match(String(first), /no-such-module/);
    const second = await gui.command({ op: 'plugin', name: 'fixture-abi-new', path: NEWER, abi: ABI });
    /* The numbers move with the ABI; the fixture is built against the desktop's plus one. */
    assert.match(String(second), /was built against plugin ABI 3; this desktop is ABI 2/);
    const third = await gui.command({ op: 'plugin', name: 'claim', path: FIXTURE, abi: 're-plugin/7' });
    assert.match(String(third), /declares ABI 're-plugin\/7'/); assert.match(String(third), /was not opened/);
    const state = await gui.command({ op: 'state' });
    assert.ok(state.connected, 'still connected');
    assert.deepEqual(state.plugins.map(p => [p.name, p.state]), [['missing', 'refused'], ['fixture-abi-new', 'refused'], ['claim', 'refused']]);
    assert.match(state.plugins[0].error, /no-such-module/);
    assert.match(state.plugins[1].error, /plugin ABI 3/);
    assert.ok(!state.tabs.some(t => t?.type === PLUGIN), 'no tab from a refused plugin');
    assert.equal(await gui.command({ op: 'snapshot', path: path.join(dir, 'alive.bmp') }), true, 'the window still renders a frame');
  } finally {
    await gui?.close(); await server?.close(); await rm(dir, { recursive: true, force: true });
  }
});
