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
// design/cards.json is generated from design/tokens.css by `python3 tools/design.py cards`; the
// surfaces below must match their Claude Design cards, so the probes read real snapshot pixels
// rather than anything the desktop reports about itself (spec 076 decision 3).
const reference = JSON.parse(await readFile('design/cards.json', 'utf8'));

async function probe(file, probes) {
  const args = [file, '--logical-width', String(LOGICAL_WIDTH), ...Object.entries(probes).map(([name, [x, y]]) => `${name}=${x},${y}`)];
  const { stdout } = await run(PYTHON, ['tools/bmp_probe.py', ...args]);
  return JSON.parse(stdout);
}

test('toolbar, tab strip and status bar match their Claude Design cards', { timeout: 180000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-native-design-'));
  const project = path.join(dir, 'project'); await mkdir(project);
  await writeFile(path.join(project, 'design.txt'), 'design check\n');
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const root = await server.store.addRoot(project);
  const shell = await server.sessions.terminal({ rootId: root.id, ...(process.platform === 'win32'
    ? { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] }
    : { command: '/bin/bash', args: ['--noprofile', '--norc'], env: { PS1: 'design$ ' } }) });
  const gui = await nativeClient(server, { root: root.id, terminal: shell.id });
  const report = { presets: {} };
  try {
    const state = await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree), 'design workspace');
    const toolbar = reference.presets.default.toolbar, tabs = reference.presets.default.tabs, status = reference.presets.default.status;

    // Geometry: the toolbar owns the top rows, the tab strip sits directly under it and the status
    // bar owns the bottom rows. A colour change at the boundary proves the heights.
    for (const name of Object.keys(reference.presets)) {
      assert.equal(await gui.command({ op: 'theme', name }), name, `preset ${name} applies`);
      await delay(120);
      const file = path.join(dir, `design-${name}.bmp`);
      assert.equal(await gui.command({ op: 'snapshot', path: file }), true);
      const surfaces = reference.presets[name];
      const colours = await probe(file, {
        brand: [12, Math.round(surfaces.toolbar.height / 2)],
        // Rows 2 and height-2 sit above and below the 26px control row, so they are bare toolbar.
        toolbarMid: [Math.round(LOGICAL_WIDTH / 2), 2],
        toolbarLastRow: [Math.round(LOGICAL_WIDTH / 2), surfaces.toolbar.height - 2],
        belowToolbar: [Math.round(LOGICAL_WIDTH / 2), surfaces.toolbar.height + 1],
        tabsRight: [LOGICAL_WIDTH - 12, surfaces.toolbar.height + surfaces.tabs.height - 3],
        statusMid: [Math.round(LOGICAL_WIDTH / 2), -Math.round(surfaces.status.height / 2)],
        statusLastRow: [Math.round(LOGICAL_WIDTH / 2), -1],
        aboveStatus: [Math.round(LOGICAL_WIDTH / 2), -(surfaces.status.height + 2)],
      });
      report.presets[name] = { expected: surfaces, measured: colours };
      assert.equal(colours.brand, surfaces.toolbar.brand, `${name}: the brand mark uses the accent`);
      assert.equal(colours.toolbarMid, surfaces.toolbar.background, `${name}: toolbar background`);
      assert.equal(colours.toolbarLastRow, surfaces.toolbar.background, `${name}: the toolbar is ${surfaces.toolbar.height}px tall`);
      assert.notEqual(colours.belowToolbar, surfaces.toolbar.background, `${name}: the toolbar ends at ${surfaces.toolbar.height}px`);
      assert.equal(colours.tabsRight, surfaces.tabs.background, `${name}: tab strip background beside the tabs`);
      assert.equal(colours.statusMid, surfaces.status.background, `${name}: status bar background`);
      assert.equal(colours.statusLastRow, surfaces.status.background, `${name}: the status bar reaches the bottom edge`);
      assert.notEqual(colours.aboveStatus, surfaces.status.background, `${name}: the status bar is ${surfaces.status.height}px tall`);
    }
    assert.equal(await gui.command({ op: 'theme', name: 'default' }), 'default');

    // The active tab carries the card's marker in the accent colour on its top row.
    const tab = state.tabs.find(t => t?.type === 1 && t.rect);
    assert.ok(tab, 'a tab is present');
    const file = path.join(dir, 'design-tabs.bmp');
    assert.equal(await gui.command({ op: 'snapshot', path: file }), true);
    const rows = await probe(file, Object.fromEntries([0, 1, 2, 3, 4].map(offset =>
      [`row${offset}`, [tab.header ? tab.header[0] + 20 : 40, toolbar.height + offset]])));
    assert.ok(Object.values(rows).includes(tabs.marker),
      `the active tab shows the accent marker in the strip's top rows: ${JSON.stringify(rows)}`);

    await mkdir('.cache/evidence', { recursive: true });
    await writeFile('.cache/evidence/design-cards.json', JSON.stringify(report, null, 2));
    for (const name of Object.keys(reference.presets)) {
      await copyFile(path.join(dir, `design-${name}.bmp`), `.cache/evidence/design-${name}.bmp`);
    }
    assert.ok(status.height > 0 && tabs.height > 0, 'the reference carries geometry');
  } finally {
    await gui.close(); await server.close(); await rm(dir, { recursive: true, force: true });
  }
});
