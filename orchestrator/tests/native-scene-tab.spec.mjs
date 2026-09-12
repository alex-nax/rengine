/* F136: the scene renders in a tab, on the device the window already has.
 *
 * The claim is specifically NOT "a game surface arrived": no second process, no surface transport,
 * no capture. The plugin renders through the seam this window renders with, into a target the host
 * gave it, and the result is composited into its tab by the same TEXTURE command the game view uses.
 * So the test asks the snapshot whether the tab holds an IMAGE — a count of distinct colours, since
 * a rendered scene cannot be asserted colour by colour but "this is not a flat fill" is exactly a
 * count — and asks the workspace whether anything else was started.
 *
 * It renders the BUILT-IN procedural scene, which is committed as code (F132). The optional real
 * model is a local asset and a gate may not depend on one; spec 124 already draws that line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, cp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';

const run = promisify(execFile);
const PYTHON = process.env.PYTHON ?? 'python3';
const SCENE = 9;   /* RE_PLUGIN */

const differing = async (file, against, region) => {
  const { stdout } = await run(PYTHON, ['tools/bmp_find.py', file, '--logical-width', '1280',
                                        '--region', region.map(Math.round).join(','), '--differs-from', against]);
  return JSON.parse(stdout).differing;
};
/* How much of a region is still the pane's own ground (--ui-surface, #242424). A rendered scene
   covers its tab; a plugin tab that only drew a line of text about an unloaded module does not, and
   counting distinct colours cannot tell those apart — antialiased text has plenty of colours and a
   flat-shaded cube has few. */
const SURFACE = '#242424';
const uncovered = async (file, region) => {
  const { stdout } = await run(PYTHON, ['tools/bmp_find.py', file, '--logical-width', '1280',
                                        '--region', region.map(Math.round).join(','), '--colour', SURFACE]);
  const { count, region: actual } = JSON.parse(stdout);
  return count / (actual[2] * actual[3]);
};
const distinct = async (file, region) => {
  const { stdout } = await run(PYTHON, ['tools/bmp_find.py', file, '--logical-width', '1280',
                                        '--region', region.map(Math.round).join(','), '--distinct', '1']);
  return JSON.parse(stdout).distinct;
};

test('the built-in scene renders inside its own tab, in this process, through this window\'s seam', { timeout: 90000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-scene-tab-'));
  const project = path.join(dir, 'project'); await mkdir(project);
  let server, gui;
  try {
    server = await startServer({ stateDir: path.join(dir, 'state') });
    const root = await server.store.addRoot(project);
    gui = await nativeClient(server, { root: root.id });
    await gui.until(s => s.tabs.some(t => t?.type === 1 && t.tree));

    /* A command, not a toolbar cell: the built-in scene has no file to open it from (decision 7),
       and the toolbar's pixels are judged against recorded reference frames whose renderer has
       retired, so a seventh button there would invalidate the only oracle the chrome has. */
    /* The platform modifier, which is what the desktop insists on: Cmd on macOS, Ctrl elsewhere.
       Accepting both on macOS would take Ctrl+E away from every shell in a pane. */
    const PLATFORM_MODIFIER = process.platform === 'darwin' ? 0x0c00 : 0x00c0;
    await gui.key('E', PLATFORM_MODIFIER);
    let state = await gui.until(s => s.plugins?.some(p => p.name === 'scene' && p.state === 'loaded'),
                                'the desktop loads its own scene plugin');
    assert.deepEqual(state.plugins.find(p => p.name === 'scene').tabs, ['scene/view']);
    state = await gui.until(s => s.tabs.some(t => t?.type === SCENE && t.rect?.[2] > 0), 'the Scene tab has a rectangle');
    const index = state.tabs.findIndex(t => t?.type === SCENE);
    const [x, y, w, h] = state.tabs[index].rect;

    await delay(400);   /* the first frame builds the geometry; the second draws it */
    const file = path.join(dir, 'scene.bmp');
    assert.equal(await gui.command({ op: 'snapshot', path: file }), true);

    /* Inside the tab: an image. Outside it, in the explorer's pane: a handful of theme colours.
       The pair is the assertion — one number alone could be a broken snapshot either way. */
    const inside = await distinct(file, [x + 8, y + 8, w - 16, h - 40]);
    const outside = await distinct(file, [8, y + 8, 200, h - 40]);
    assert.ok(inside > 500, `the Scene tab holds a rendered image, not a fill: ${inside} colours`);
    assert.ok(outside < inside / 10, `the explorer's pane is still flat theme colour: ${outside} colours`);

    /* No second process and no surface transport: that is what makes this a tab render and not the
       game view (spec 126, "what F136 is not"). */
    assert.equal(server.sessions.list().length, 0, 'no session was started to draw a scene');
    assert.equal(server.games.surfaces.items.size, 0, 'no surface was reserved to draw a scene');
    assert.equal(state.tabs.filter(t => t?.type === 5).length, 0, 'no game view was opened');
  } finally {
    if (gui) await gui.close();
    if (server) await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the scene tab and the pack example are the same sources, not two copies', async () => {
  const cmake = await readFile(path.join(process.cwd(), 'cmake.toml'), 'utf8');
  const target = cmake.slice(cmake.indexOf('add_library(rengine_plugin_scene'));
  /* F136's third criterion. The plugin compiles the pack example's own scene.c and obj.c; if it
     ever grew a copy of its own, the in-tab view could drift from the one the backend comparison
     judges and nothing would say so. */
  for (const source of ['packs/gpu/examples/scene/scene.c', 'packs/gpu/examples/scene/obj.c']) {
    assert.ok(target.includes(source), `the plugin compiles ${source} rather than a copy`);
  }
  const walk = await readFile(path.join(process.cwd(), 'plugins/scene/scene_plugin.c'), 'utf8');
  assert.ok(!walk.includes('re_seam_') || walk.includes('re_scene_plugin_bind'),
    'the plugin reaches the seam through the host table, not by calling it');
});

test('a model opens from the explorer, a drag moves the camera, and a still scene costs no frames', { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-scene-model-'));
  const project = path.join(dir, 'project'); await mkdir(project);
  /* A committed model, not a local asset: small, but two `usemtl` groups so it arrives as parts. */
  await cp(path.resolve('orchestrator/tests/fixtures/models/two-part.obj'), path.join(project, 'two-part.obj'));
  let server, gui;
  try {
    server = await startServer({ stateDir: path.join(dir, 'state') });
    const root = await server.store.addRoot(project);
    gui = await nativeClient(server, { root: root.id });
    let state = await gui.until(s => s.tabs.some(t => t?.type === 1 && t.tree));
    const tree = state.tabs.findIndex(t => t?.type === 1);

    /* Decision 7: an .obj in the explorer opens a Scene tab, as a .png opens the image view. */
    await gui.control('tree-entry', 'two-part.obj', tree);
    state = await gui.until(s => s.tabs.some(t => t?.type === SCENE && t.rect?.[2] > 0), 'the .obj opened a Scene tab');
    assert.match(state.status, /two-part\.obj/, 'the status names the model the tab was pointed at');
    const index = state.tabs.findIndex(t => t?.type === SCENE);
    const [x, y, w, h] = state.tabs[index].rect;

    await delay(400);
    const before = path.join(dir, 'before.bmp');
    assert.equal(await gui.command({ op: 'snapshot', path: before }), true);
    const bare = await uncovered(before, [x + 8, y + 8, w - 16, h - 40]);
    assert.ok(bare < 0.2, `the model covers its tab rather than leaving the pane's ground: ${(bare * 100).toFixed(1)}% uncovered`);

    /* Criterion 5: dragging orbits the camera, through the tab-scoped pointer and nothing else. */
    const cx = x + w / 2, cy = y + h / 2;
    await gui.command({ op: 'motion', x: cx, y: cy }); await delay(80);
    await gui.command({ op: 'button', x: cx, y: cy, down: true }); await delay(80);
    for (let step = 1; step <= 4; step++) { await gui.command({ op: 'motion', x: cx + step * 25, y: cy }); await delay(80); }
    await gui.command({ op: 'button', x: cx + 100, y: cy, down: false }); await delay(200);
    const after = path.join(dir, 'after.bmp');
    assert.equal(await gui.command({ op: 'snapshot', path: after }), true);
    const moved = await differing(after, before, [x + 8, y + 8, w - 16, h - 40]);
    assert.ok(moved > 5000, `the drag moved the camera: ${moved} pixels differ`);

    /* Criterion 4, the half that can fail. "A still scene costs no frames" is structural: the ABI
       gives a plugin no way to ask for one, which plugin_test.c asserts by counting the grant, and
       making the scene animate every frame does NOT wake the window — so an assertion about the
       frame COUNT here would pass whatever the scene did. What the scene can spend is time inside
       the frames the window already draws, so that is what is measured, against the same window
       driven the same way with no Scene tab. */
    const drive = async () => {
      await gui.command({ op: 'stats', reset: true });
      for (let i = 0; i < 40; i++) { await gui.command({ op: 'motion', x: x + 40 + (i % 12), y: y + 40 }); await delay(16); }
      return gui.command({ op: 'stats' });
    };
    const withScene = await drive();
    /* Closing it rather than selecting something else: it is the only tab in its pane, so there is
       nothing else there to select. */
    await gui.control('detach', '', index);
    await gui.until(s => !s.tabs[index] || s.tabs[index].rect[2] === 0, 'the Scene tab is gone');
    const without = await drive();
    assert.ok(withScene.buildMedianMs < 4,
      `the scene's pass fits the frame it renders in: ${withScene.buildMedianMs.toFixed(2)} ms to build`);
    assert.ok(withScene.frameMedianMs <= without.frameMedianMs * 1.5 + 1,
      `the window's frame is not meaningfully slower with a Scene tab open: ${withScene.frameMedianMs.toFixed(2)} ms against ${without.frameMedianMs.toFixed(2)} ms`);

    /* A restored Scene tab comes back on the model it was showing, drawing rather than as the
       placeholder F108 restores an unloaded plugin tab as: nothing else in the window would ask for
       rEngine's own scene module, so the restore has to. */
    await gui.control('tree-entry', 'two-part.obj', tree);
    await gui.until(s => s.tabs.some(t => t?.type === SCENE && t.rect?.[2] > 0));
    await gui.close(); gui = null;
    gui = await nativeClient(server, { root: root.id });
    const back = await gui.until(s => s.tabs.some(t => t?.type === SCENE && t.rect?.[2] > 0), 'the Scene tab is restored');
    const again = back.tabs.findIndex(t => t?.type === SCENE);
    await delay(500);
    const reopened = path.join(dir, 'reopened.bmp');
    assert.equal(await gui.command({ op: 'snapshot', path: reopened }), true);
    const [rx, ry, rw, rh] = back.tabs[again].rect;
    const bareAgain = await uncovered(reopened, [rx + 8, ry + 8, rw - 16, rh - 40]);
    assert.ok(bareAgain < 0.2,
      `the restored Scene tab renders instead of naming a plugin that is not loaded: ${(bareAgain * 100).toFixed(1)}% uncovered`);
  } finally {
    if (gui) await gui.close();
    if (server) await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
