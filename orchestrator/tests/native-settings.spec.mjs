import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';

const run = promisify(execFile);
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const LOGICAL_WIDTH = 1280;
const reference = JSON.parse(await readFile('design/cards.json', 'utf8'));

// Counts pixels of an exact colour in a region: a glyph only carries its colour where a stem
// fully covers a pixel, so a mark is asserted over an area rather than at a point.
async function find(file, region, colour) {
  const { stdout } = await run(PYTHON, ['tools/bmp_find.py', file, '--logical-width', String(LOGICAL_WIDTH),
    '--region', region.join(','), '--colour', colour]);
  return JSON.parse(stdout).count;
}

async function probe(file, probes) {
  const args = [file, '--logical-width', String(LOGICAL_WIDTH),
    ...Object.entries(probes).map(([name, [x, y]]) => `${name}=${x},${y}`)];
  const { stdout } = await run(PYTHON, ['tools/bmp_probe.py', ...args]);
  return JSON.parse(stdout);
}

// Colours along the middle of a rect, one sample every `step` logical pixels.
async function scan(file, [x, y, w, h], step = 12) {
  const points = {};
  for (let i = 0; x + 6 + i * step < x + w - 6; i++) points[`p${i}`] = [x + 6 + i * step, y + Math.round(h / 2)];
  return Object.values(await probe(file, points));
}

test('the settings popover and the menus are one overlay layer that matches the menus card', { timeout: 180000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-settings-'));
  const project = path.join(dir, 'project'); await mkdir(project);
  await writeFile(path.join(project, 'settings.txt'), 'settings check\n');
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const root = await server.store.addRoot(project);
  // A terminal in the right pane running a program that reports mouse events, because the popover
  // hangs from the far right of the toolbar and lands on top of it. That is how the owner found the
  // rows over such a pane dead: the terminal claimed the press before the surface saw it.
  const fixture = path.join(dir, 'mouse.cjs');
  await writeFile(fixture, `process.stdin.setRawMode(true);
process.stdout.write('\\x1b[?1049h\\x1b[?1000h\\x1b[?1002h\\x1b[?1003h\\x1b[?1006h');
process.stdout.write('\\x1b[2J\\x1b[HMOUSE APPLICATION READY\\r\\n');
process.stdin.on('data', () => {});
setInterval(() => {}, 1000);`);
  const shell = await server.sessions.terminal({ rootId: root.id, command: process.execPath, args: [fixture] });
  const gui = await nativeClient(server, { root: root.id, terminal: shell.id });
  const evidence = {};
  try {
    await gui.until(s => s.connected && s.tabs.some(t => t?.type === 3 && t.text?.includes('MOUSE APPLICATION READY')), 'a mouse-reporting pane');
    const card = reference.presets.default.popover;

    // The popover opens from the toolbar and draws the card's raised ground.
    await gui.control('toolbar', 'Settings', -1);
    let state = await gui.until(s => s.controls?.some(c => c.role === 'settings' && c.key === 'accent'), 'settings popover');
    const settings = state.controls.filter(c => c.role === 'settings').map(c => c.key);
    for (const key of ['theme', 'syntax', 'accent', 'vim', 'explorer']) {
      assert.ok(settings.includes(key), `the popover carries ${key}: ${JSON.stringify(settings)}`);
    }
    for (const key of ['theme-path', 'import', 'export']) {
      assert.ok(settings.includes(key), `the popover carries the theme-file ${key}`);
    }
    const accent = state.controls.find(c => c.key === 'accent');
    const file = path.join(dir, 'settings.bmp');
    assert.equal(await gui.command({ op: 'snapshot', path: file }), true);
    const ground = await probe(file, {
      // Just below the accent row, inside the popover and clear of every control.
      surface: [accent.rect[0] + accent.rect[2] - 4, accent.rect[1] + accent.rect[3] + 6],
    });
    assert.equal(ground.surface, card.background, 'the popover draws the card ground');

    // A select opens a list rather than stepping to the next value: every choice is visible, the
    // live one is marked, and picking one applies it and closes the list.
    assert.ok(!state.controls.some(c => c.role === 'dropdown'), 'no list is open to begin with');
    await gui.control('settings', 'theme', -1);
    const listed = await gui.until(s => s.controls?.some(c => c.role === 'dropdown'), 'the theme list opened');
    const choices = listed.controls.filter(c => c.role === 'dropdown').map(c => c.key);
    assert.deepEqual(choices, ['default', 'teal', 'light'], `the list names every preset: ${JSON.stringify(choices)}`);
    await gui.control('dropdown', 'teal', -1);
    await gui.until(s => !s.controls?.some(c => c.role === 'dropdown'), 'picking a value closes the list');
    assert.equal(server.store.state.preferences.theme, 'teal', 'the choice applied and persisted');
    await gui.command({ op: 'theme', name: 'default' });

    // Escape closes the list first and leaves the surface that opened it.
    await gui.control('settings', 'syntax', -1);
    await gui.until(s => s.controls?.some(c => c.key === 'ember'), 'the syntax list opened');
    await gui.key('Escape');
    const kept = await gui.until(s => !s.controls?.some(c => c.role === 'dropdown'), 'Escape closed the list');
    assert.ok(kept.controls.some(c => c.role === 'settings'), 'the popover is still open behind it');

    // The check mark has to fit its box. Drawn at the text size it overflowed a 14px checkbox and
    // was cropped to a diagonal stroke that read as a slash, which is how the owner reported it.
    await gui.control('settings', 'vim', -1);
    const checked = await gui.until(s => s.vim === true, 'Vim checked');
    await gui.command({ op: 'motion', x: accent.rect[0] + 4, y: accent.rect[1] - 20 });   // clear the hover
    await delay(200);
    const ticked = path.join(dir, 'checkbox.bmp');
    assert.equal(await gui.command({ op: 'snapshot', path: ticked }), true);
    const box = checked.controls.find(c => c.key === 'vim').rect;
    const side = 14, top = box[1] + Math.round((box[3] - side) / 2), lead = top - box[1];
    const density = 2;   // the snapshot is at drawable resolution; bmp_find scales the region
    // The mark displaces some of the accent fill, and the box's own corners stay filled: a mark
    // drawn at the text size reaches them, which is what cropped it into a diagonal stroke.
    const filled = await find(ticked, [box[0], top, side, side], card.hover);
    assert.ok(filled > 0 && filled < side * side * density * density, `the mark is drawn inside the box: ${filled}`);
    const corners = await probe(ticked, {
      lower: [box[0] + 3, top + side - 3],
      upper: [box[0] + side - 3, top + 3],
    });
    assert.deepEqual(corners, { lower: card.hover, upper: card.hover },
      `the mark keeps clear of the box's corners: ${JSON.stringify(corners)}`);
    assert.equal(await find(ticked, [box[0], box[1], side, lead], card.background), side * lead * density * density,
      'no part of the mark sits above its box');
    await gui.control('settings', 'vim', -1);
    await gui.until(s => s.vim === false, 'and it clears again');

    // The accent slider's track is a gradient. Counting distinct colours across the whole track
    // proves nothing: it is drawn as twelve segments, so a primitive that ignored its second stop
    // would still show twelve colours. The assertion has to look inside one segment, where only
    // interpolation can produce a difference.
    const track = await scan(file, accent.rect, 14);
    evidence.track = track;
    assert.ok(new Set(track).size >= 8, `the accent track ramps through hues: ${JSON.stringify(track)}`);
    const segment = Math.floor(accent.rect[2] / 12);
    const within = await probe(file, {
      near: [accent.rect[0] + 2, accent.rect[1] + Math.round(accent.rect[3] / 2)],
      far: [accent.rect[0] + segment - 2, accent.rect[1] + Math.round(accent.rect[3] / 2)],
    });
    assert.notEqual(within.near, within.far,
      `the ramp interpolates inside one segment rather than stepping between them: ${JSON.stringify(within)}`);

    // A hue change applies immediately and persists as a workspace preference.
    await gui.click(accent.rect[0] + Math.round(accent.rect[2] * 0.75), accent.rect[1] + Math.round(accent.rect[3] / 2));
    await delay(150);
    const hue = server.store.state.preferences.accentHue;
    assert.equal(typeof hue, 'number', 'the hue persists');
    assert.ok(hue > 180, `the hue followed the click: ${hue}`);
    const tinted = path.join(dir, 'settings-tinted.bmp');
    assert.equal(await gui.command({ op: 'snapshot', path: tinted }), true);
    const brand = await probe(tinted, { brand: [12, Math.round(reference.presets.default.toolbar.height / 2)] });
    assert.notEqual(brand.brand, reference.presets.default.toolbar.brand, 'the brand mark took the new hue');
    evidence.hue = { accentHue: hue, brand: brand.brand };

    // Escape closes the top surface.
    await gui.key('Escape');
    await gui.until(s => !s.controls?.some(c => c.role === 'settings'), 'popover closed by Escape');

    // Opening the project menu is the one overlay; opening settings again closes it.
    await gui.control('toolbar', 'Root', -1);
    state = await gui.until(s => s.controls?.some(c => c.role === 'menu-root'), 'project menu');
    assert.ok(!state.controls.some(c => c.role === 'settings'), 'the menu replaced the popover');
    const menu = path.join(dir, 'menu.bmp');
    assert.equal(await gui.command({ op: 'snapshot', path: menu }), true);
    const row = state.controls.find(c => c.role === 'menu-root');
    const separator = await probe(menu, { ground: [row.rect[0] + row.rect[2] - 6, row.rect[1] + 2] });
    assert.equal(separator.ground, card.background, 'the menu draws on the same raised ground');

    await gui.control('toolbar', 'Settings', -1);
    state = await gui.until(s => s.controls?.some(c => c.role === 'settings'), 'settings replaced the menu');
    assert.ok(!state.controls.some(c => c.role === 'menu-root'), 'only one overlay is open at a time');

    // The popover must stay clickable after the workspace has been used: microui routes the mouse to
    // the frontmost container, so a pane clicked before opening it used to leave it visible and deaf.
    await gui.click(Math.round(LOGICAL_WIDTH / 2), 400);
    await gui.until(s => !s.controls?.some(c => c.role === 'settings'), 'the pane press closed it');
    await gui.control('toolbar', 'Settings', -1);
    await gui.until(s => s.controls?.some(c => c.key === 'vim'), 'reopened over a used pane');
    const vimBefore = (await gui.command({ op: 'state' })).vim;
    await gui.control('settings', 'vim', -1);
    await gui.until(s => s.vim !== vimBefore, 'the Vim checkbox answers after a pane was clicked');
    await gui.control('settings', 'explorer', -1);
    await gui.until(s => s.explorerNested === true, 'the explorer checkbox answers too');

    // A press outside closes it.
    await gui.click(Math.round(LOGICAL_WIDTH / 2), 400);
    await gui.until(s => !s.controls?.some(c => c.role === 'settings'), 'popover closed by an outside click');

    // The pane context menu opens on a right press in a tab strip and runs its commands.
    const tab = (await gui.until(s => s.tabs.some(t => t?.header), 'a tab')).tabs.find(t => t?.header);
    const panes = (await gui.until(s => s.layout?.panes, 'panes')).layout.panes.filter(Boolean).length;
    await gui.command({ op: 'motion', x: tab.header[0] + tab.header[2] + 20, y: tab.header[1] + 4 });
    await gui.command({ op: 'button', button: 3, x: tab.header[0] + tab.header[2] + 20, y: tab.header[1] + 4, down: true });
    await gui.command({ op: 'button', button: 3, x: tab.header[0] + tab.header[2] + 20, y: tab.header[1] + 4, down: false });
    state = await gui.until(s => s.controls?.some(c => c.role === 'menu-pane'), 'pane menu');
    const rows = state.controls.filter(c => c.role === 'menu-pane').map(c => c.key);
    /* Scene joins the list with F136: it opens a view in this pane, which is what the rest of this
       group does. The card this test compares against is about the ground and hover colours, not
       how many rows the menu has. */
    assert.deepEqual(rows, ['Split vertical', 'Split horizontal', 'Merge pane', 'New shell here', 'New agent session', 'Scene', 'Close view']);
    await gui.control('menu-pane', 'Split vertical', -1);
    await gui.until(s => s.layout.panes.filter(Boolean).length > panes, 'the menu split the pane');

    // The same command answers its printed shortcut.
    const after = (await gui.until(s => s.layout?.panes, 'panes')).layout.panes.filter(Boolean).length;
    await gui.key('Backspace', 1024);   // KMOD_LGUI
    await gui.until(s => s.layout.panes.filter(Boolean).length < after, 'the merge shortcut ran');

    await mkdir('.cache/evidence', { recursive: true });
    await writeFile('.cache/evidence/settings-popover.json', JSON.stringify(evidence, null, 2));
    await copyFile(file, '.cache/evidence/settings-popover.bmp');
    await copyFile(menu, '.cache/evidence/settings-menu.bmp');
  } finally {
    await gui.close(); await server.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('a theme file overrides all three token layers and a project theme is offered, not applied', { timeout: 180000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-theme-file-'));
  const project = path.join(dir, 'project'); await mkdir(project);
  await mkdir(path.join(project, '.rengine'));
  // Layer 1 (the palette ramp), layer 2 (a semantic role) and layer 3 (a view token) in one file.
  await writeFile(path.join(project, '.rengine', 'theme.conf'),
    '[theme "harbour"]\naccent-hue = 200\ngray = #05070a #0a0f14 #101820 #16202b #1d2b38 #263a4a #31485c #5b7183 #8ea3b3 #c3d2dc #edf3f7\nui-fg-strong = #ffffff\nterminal-bg = #01030a\n');
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const root = await server.store.addRoot(project);
  let gui = await nativeClient(server, { root: root.id });
  try {
    await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree), 'workspace');
    const before = path.join(dir, 'before.bmp');
    assert.equal(await gui.command({ op: 'snapshot', path: before }), true);
    const plain = await probe(before, { pane: [40, 300] });
    assert.equal(plain.pane, reference.presets.default.tree.background, 'the project theme is not applied on its own');

    // The offer appears in the popover and applies on one click.
    await gui.control('toolbar', 'Settings', -1);
    await gui.until(s => s.controls?.some(c => c.key === 'project-theme'), 'the project theme is offered');
    await gui.control('settings', 'project-theme', -1);
    await delay(250);
    const after = path.join(dir, 'after.bmp');
    assert.equal(await gui.command({ op: 'snapshot', path: after }), true);
    const themed = await probe(after, { pane: [40, 300] });
    assert.equal(themed.pane, '#16202b', 'the palette layer reached the view that reads it');
    assert.equal(server.store.state.preferences.themes[root.id], 'harbour', 'the activation is remembered for this root');

    // It comes back on the next desktop for the same root, without being asked again.
    await gui.close();
    gui = await nativeClient(server, { root: root.id });
    await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree), 'second desktop');
    const again = path.join(dir, 'again.bmp');
    assert.equal(await gui.command({ op: 'snapshot', path: again }), true);
    assert.equal((await probe(again, { pane: [40, 300] })).pane, '#16202b', 'the remembered theme returns');

    // Export writes the card's format back out, and the file it writes reads back in.
    await gui.control('toolbar', 'Settings', -1);
    await gui.until(s => s.controls?.some(c => c.key === 'theme-path'), 'the theme-file field');
    await gui.control('settings', 'theme-path', -1);
    await gui.command({ op: 'text', text: 'exported.conf' });
    // Wait for the field to actually hold it: the text goes to whatever has focus, so asserting on
    // the desktop's own state removes the race between the click landing and the typing arriving.
    await gui.until(s => s.themePath === 'exported.conf', 'the path field took the text');
    await gui.control('settings', 'export', -1);
    await delay(200);
    const exported = await readFile(path.join(project, 'exported.conf'), 'utf8');
    assert.match(exported, /^\[theme "/, 'the export carries the card header');
    assert.match(exported, /ui-accent = #/, 'the export names tokens without their layer prefix');
    assert.match(exported, /terminal-bg = #01030a/, 'the export carries the applied view colour');
    await gui.control('settings', 'import', -1);
    const state = await gui.until(s => s.status?.includes('applied'), 'the export imports again');
    assert.ok(state.status.includes('applied'), state.status);
  } finally {
    await gui.close(); await server.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('settings reach a second window through the workspace preferences', { timeout: 180000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-settings-two-'));
  const project = path.join(dir, 'project'); await mkdir(project);
  await writeFile(path.join(project, 'a.txt'), 'two windows\n');
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const root = await server.store.addRoot(project);
  const first = await nativeClient(server, { root: root.id });
  let second;
  try {
    await first.until(s => s.connected, 'first window');
    await first.control('toolbar', 'Settings', -1);
    await first.until(s => s.controls?.some(c => c.role === 'settings' && c.key === 'vim'), 'popover');
    await first.control('settings', 'vim', -1);
    await first.control('settings', 'explorer', -1);
    await delay(200);
    assert.equal(server.store.state.preferences.vim, true, 'Vim persisted');
    assert.equal(server.store.state.preferences.explorer, 'nested', 'the explorer mode persisted');
    second = await nativeClient(server, { root: root.id });
    const state = await second.until(s => s.connected && s.vim !== undefined, 'second window');
    assert.equal(state.vim, true, 'the second window opens with Vim on');
    assert.equal(state.explorerNested, true, 'the second window opens in nested mode');
  } finally {
    if (second) await second.close();
    await first.close(); await server.close(); await rm(dir, { recursive: true, force: true });
  }
});
