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
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
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
