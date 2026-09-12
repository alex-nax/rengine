import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';
import { declaration, pack, producer } from './format-fixtures.mjs';

test('wide trees, malformed declarations and slow producers never take the desktop down', { timeout: 120000 }, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-native-hardening-')));
  let server, gui;
  try {
    const project = path.join(directory, 'project'), broken = path.join(directory, 'broken');
    for (const root of [project, broken]) await mkdir(path.join(root, '.rengine'), { recursive: true });
    await writeFile(path.join(project, '.rengine/project.json'), JSON.stringify(declaration({ default: 'preview',
      preview: { kind: 'tree', command: [process.execPath, producer, 'tree', '${file}'], timeoutMs: 10000, maxBytes: 4194304 } })));
    await writeFile(path.join(project, 'wide.pack'), pack({ entries: {}, wide: 64 }));
    await writeFile(path.join(project, 'slow.pack'), pack({ entries: { 'late.txt': 'late' }, sleep: 6000 }));
    await writeFile(path.join(broken, '.rengine/project.json'), JSON.stringify(declaration({ modes: ['raw'], default: 'preview' })));
    await writeFile(path.join(broken, 'note.txt'), 'still a text file\n');
    server = await startServer({ stateDir: path.join(directory, 'state') });
    const root = await server.store.addRoot(project), brokenRoot = await server.store.addRoot(broken);
    gui = await nativeClient(server, { root: root.id });
    await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree), 'tree');
    await gui.command({ op: 'resize', width: 1600, height: 1000 });
    await gui.control('tree-entry', 'wide.pack');
    let state = await gui.until(s => s.tabs.some(t => t?.path === 'wide.pack' && t.formatMode === 'preview' && t.previewFiles === 64), 'wide pack opens in preview');
    const tab = state.tabs.findIndex(t => t?.path === 'wide.pack');
    const locate = async (role, key) => (await gui.command({ op: 'state' })).controls?.find(c => c.tab === tab && c.role === role && c.key === key);
    const reveal = async (key, role = 'preview-dir') => {
      for (let attempt = 0; attempt < 60; attempt++) {
        let control = await locate(role, key);
        if (control && control.rect[1] + control.rect[3] < 960) {
          await delay(60); const settled = await locate(role, key); /* microui applies a wheel scroll in the next UI pass */
          if (settled && settled.rect.join() === control.rect.join()) return control;
          continue;
        }
        /* Over one of this view's own rows rather than a fixed point. The scroll belongs to the
           pane's container, so the pointer has to be inside that pane, and which pane a document
           opens in follows the open-target rule now (spec 130). A format view sets no tab rect, so
           a reported row is the only thing that names where it is. */
        const here = (await gui.command({ op: 'state' })).controls
          .find(c => c.tab === tab && c.rect[2] > 0 && c.role.startsWith('preview-'));  /* a row, not the tab header */
        if (here) await gui.command({ op: 'motion', x: here.rect[0] + here.rect[2] / 2, y: here.rect[1] + here.rect[3] / 2 });
        await gui.command({ op: 'wheel', x: 0, y: -3 }); await delay(80);
      }
      throw new Error(`${key} never scrolled into view`);
    };
    for (let i = 0; i < 64; i++) {
      const { rect: [x, y, w, h] } = await reveal(`dir${String(i).padStart(3, '0')}`);
      await gui.click(x + w / 2, y + h / 2);
      await gui.until(s => s.tabs[tab]?.expandedDirs === i + 1, `dir${i} expanded`);
    }
    await reveal('dir063/file63.txt', 'preview-file');
    state = await gui.command({ op: 'state' });
    assert.ok(state.tabs[tab].previewFiles === 64, 'desktop still answers after 64 expanded directories');
    assert.ok(state.tabs[tab].expandedDirs >= 60, `expansion state is owned by the view: ${state.tabs[tab].expandedDirs}`);
    await gui.control('tab', '', 0); await gui.control('tree-entry', 'slow.pack');
    let slow;
    for (let attempt = 0; attempt < 3 && !slow; attempt++) slow = await gui.until(s => s.tabs.some(t => t?.path === 'slow.pack' && t.formatMode === 'preview' && t.previewFiles === 1), 'a 6 s producer inside the declared 10 s budget succeeds in the desktop').catch(() => null);
    assert.ok(slow, 'slow producer preview loaded');
    await gui.close(); gui = null;
    gui = await nativeClient(server, { root: brokenRoot.id });
    state = await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree), 'restored layout');
    assert.equal(state.root, brokenRoot.id, 'second desktop is bound to the broken root');
    await gui.control('toolbar', 'Tree');
    await gui.until(s => s.tabs.some(t => t?.type === 1 && t.root === brokenRoot.id && t.tree), 'broken root tree');
    await gui.control('tree-entry', 'note.txt');
    state = await gui.until(s => s.tabs.some(t => t?.path === 'note.txt' && t.text === 'still a text file\n' && t.formatMode === undefined), 'text file opens under a malformed declaration');
    assert.match(state.status, /project\.json/, 'status line names the declaration problem');
    const named = state.status.indexOf('(fixture-pack)');
    assert.ok(named > 0, `status line names the offending record: ${state.status}`);
    assert.ok(named < 100, 'the id is early enough to survive the single-line status row (159 columns at the default width, 8 px cell)');
    assert.ok(state.controls.some(c => c.role === 'save'));
  } finally {
    await gui?.close(); await server?.close(); await rm(directory, { recursive: true, force: true });
  }
});
