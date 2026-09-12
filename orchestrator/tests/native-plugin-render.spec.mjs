/* F135: the two grants charter D55 adds, read off the screen.
 *
 * A plugin can only draw, so what it saw is reported as colour. One tab asks for a target every
 * frame and presents it; the other asks once, keeps the handle and presents it on every later
 * frame, which the host must refuse. Both paint a marker saying what the pointer told them. So the
 * assertions are four colours in two tabs, and each one is a criterion:
 *
 *   PAINTED present in the paint tab      — a plugin renders into a target it asked for (c1)
 *   STALE   absent from the stale tab      — a target does not outlive its frame (c2)
 *   POINTER_IN in the tab under the cursor — the pointer reaches its own tab (c3)
 *   POINTER_OUT in the other tab           — and no other tab hears about it (c3)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';

const run = promisify(execFile);
const PYTHON = process.env.PYTHON ?? 'python3';
const MODULE = path.resolve('.cache/desktop/plugins/rengine_plugin_render.dylib');
const ABI = 're-plugin/2';
const PLUGIN = 9;

const PAINTED = '#00ff40', STALE = '#ff0080', POINTER_IN = '#ffc800', POINTER_OUT = '#3c3c3c';

const count = async (file, region, colour) => {
  const { stdout } = await run(PYTHON, ['tools/bmp_find.py', file, '--logical-width', '1280',
                                        '--region', region.map(Math.round).join(','), '--colour', colour]);
  return JSON.parse(stdout).count;
};

test('a plugin renders into a target it asked for, cannot present one it kept, and hears the pointer only in its own tab',
     { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-plugin-render-'));
  const project = path.join(dir, 'project'); await mkdir(project);
  let server, gui;
  try {
    server = await startServer({ stateDir: path.join(dir, 'state') });
    const root = await server.store.addRoot(project);
    gui = await nativeClient(server, { root: root.id });
    await gui.until(s => s.tabs.some(t => t?.type === 1 && t.tree));
    assert.equal(await gui.command({ op: 'plugin', name: 'render-fixture', path: MODULE, abi: ABI }), true);

    /* Both tabs must be on screen at once, or "no other tab hears about it" is untestable. The
       second tab goes to a pane of its own. */
    let state = await gui.until(s => s.tabs.filter(t => t?.type === PLUGIN).length === 2, 'both fixture tabs exist');
    const paint = state.tabs.findIndex(t => t?.type === PLUGIN && t.title === 'Paint');
    const stale = state.tabs.findIndex(t => t?.type === PLUGIN && t.title === 'Stale');
    await gui.control('tab', '', paint);
    state = await gui.until(s => s.tabs[paint].rect?.[2] > 0, 'the paint tab is drawn');
    await gui.control('toolbar', 'Split horizontal');
    state = await gui.until(s => s.layout.panes.filter(p => p && !p.axis).length === 3);

    /* Splitting makes an empty pane; it does not move a tab into it. The stale tab is carried there
       by the drag, which is also the shortest proof the drag works from a spec. The new pane is
       below the one that was split, so a point under the paint tab's rectangle lands in it. */
    state = await gui.until(s => s.tabs[paint].rect?.[3] > 0);
    const [ax, ay, aw, ah] = state.tabs[paint].rect;
    const grab = state.tabs[stale].header;
    await gui.command({ op: 'motion', x: grab[0] + grab[2] / 2, y: grab[1] + grab[3] / 2 }); await delay(80);
    await gui.command({ op: 'button', x: grab[0] + grab[2] / 2, y: grab[1] + grab[3] / 2, down: true }); await delay(80);
    await gui.command({ op: 'motion', x: ax + aw / 2, y: ay + ah + 60 }); await delay(80);
    await gui.command({ op: 'button', x: ax + aw / 2, y: ay + ah + 60, down: false }); await delay(120);
    state = await gui.until(s => s.tabs[paint].rect?.[2] > 0 && s.tabs[stale].rect?.[2] > 0,
                            'both fixture tabs are drawn at once');

    /* Several frames, so the stale tab is past its first: its keep-and-present path only runs after
       the frame it asked in. */
    const over = state.tabs[paint].rect;
    await gui.command({ op: 'motion', x: over[0] + over[2] / 2, y: over[1] + over[3] / 2 });
    for (let i = 0; i < 4; i++) { await gui.command({ op: 'motion', x: over[0] + over[2] / 2 + i, y: over[1] + over[3] / 2 }); await delay(90); }
    state = await gui.command({ op: 'state' });

    const file = path.join(dir, 'render.bmp');
    assert.equal(await gui.command({ op: 'snapshot', path: file }), true);
    const [px, py, pw, ph] = state.tabs[paint].rect, [sx, sy, sw, sh] = state.tabs[stale].rect;

    assert.ok(await count(file, [px, py, pw, ph - 20], PAINTED) > 1000,
      'the paint tab shows what it rendered into the target it asked for');
    assert.equal(await count(file, [sx, sy, sw, sh], STALE), 0,
      'a target kept past the frame it was asked for is refused, so its colour never reaches the tab');

    assert.ok(await count(file, [px + 2, py + ph - 18, 14, 14], POINTER_IN) > 20,
      'the tab under the pointer is told so');
    assert.ok(await count(file, [sx + 2, sy + sh - 18, 14, 14], POINTER_OUT) > 20,
      'the other tab is told the pointer is elsewhere');
    assert.equal(await count(file, [sx + 2, sy + sh - 18, 14, 14], POINTER_IN), 0,
      'and is told nothing that would place it inside');
  } finally {
    if (gui) await gui.close();
    if (server) await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
