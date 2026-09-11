/* F132. The scene example, built the way its first real consumer will build it and judged on what it
 * renders.
 *
 * Two things need evidence here. The first is that a project outside this repository can take the
 * pack and build something that draws — the example's sources are compiled by a CMake project that
 * has never heard of rEngine's build, exactly as F123's outside-consumer check does for the library.
 *
 * The second is that the scene actually contains what F130 and F131 will be judged against. A
 * comparison between backends is only as good as the frame it compares: a scene that happened to
 * lose its off-screen pass, or its blending, would still compare equal across three backends and
 * prove nothing. So this asserts the presence of each, in pixels, at coordinates chosen by reading
 * the render rather than by eye.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, copyFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';

const run = promisify(execFile);
const PACK = path.resolve('packs/gpu');
const EXAMPLE = path.join(PACK, 'examples/scene');
const PYTHON = process.env.PYTHON ?? 'python3';

/* A 32-bit bottom-up BMP, which is what every snapshot in this repository is. Reading it here rather
   than shelling out keeps the region assertions readable. */
function readBmp(bytes) {
  assert.equal(bytes.toString('latin1', 0, 2), 'BM', 'not a BMP');
  const offset = bytes.readUInt32LE(10);
  const width = bytes.readInt32LE(18);
  const height = bytes.readInt32LE(22);
  const bpp = bytes.readUInt16LE(28);
  assert.equal(bpp, 32, 'the example writes 32-bit BMPs');
  const flip = height > 0;
  const rows = Math.abs(height);
  return {
    width, height: rows,
    at(x, y) {                       // y counts from the top, as a reader looks at it
      const row = flip ? rows - 1 - y : y;
      const i = offset + (row * width + x) * 4;
      return { b: bytes[i], g: bytes[i + 1], r: bytes[i + 2] };
    },
  };
}
const luma = p => 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b;

async function buildExample(dir) {
  await writeFile(path.join(dir, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.21)
project(scene_consumer C)
find_package(SDL2 REQUIRED CONFIG)
add_subdirectory("${PACK}" pack)
add_executable(scene "${EXAMPLE}/main.c" "${EXAMPLE}/scene.c" "${EXAMPLE}/obj.c" "${EXAMPLE}/host_gl.c")
target_link_libraries(scene PRIVATE rengine::gpu SDL2::SDL2 m)
target_compile_features(scene PRIVATE c_std_11)
`);
  const build = path.join(dir, 'build');
  await run('cmake', ['-S', dir, '-B', build], { maxBuffer: 1 << 24 });
  await run('cmake', ['--build', build], { maxBuffer: 1 << 24 });
  return path.join(build, process.platform === 'win32' ? 'Debug/scene.exe' : 'scene');
}

/* A machine with no display cannot run a GL program, and that is not this spec's failure. Say so and
   skip, the way native-render.spec.mjs does for a missing Vulkan loader — never turn it into green. */
function unavailable(error) {
  const text = `${error.stdout ?? ''}${error.stderr ?? ''}${error.message ?? ''}`;
  return /SDL video unavailable|no GL context|no window/.test(text) ? text.trim().split('\n')[0] : null;
}

test('a project outside this repository builds the scene example and it renders what the comparison needs',
     { timeout: 600000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-scene-'));
  try {
    const scene = await buildExample(dir);
    const first = path.join(dir, 'first.bmp');
    try {
      await run(scene, ['--snapshot', first, '--frames', '60'], { maxBuffer: 1 << 24 });
    } catch (error) {
      const reason = unavailable(error);
      if (reason) { console.log(`pack-gpu-scene: ${reason}; skipping`); return; }
      throw error;
    }

    const image = readBmp(await readFile(first));
    assert.equal(image.width, 1280);
    assert.equal(image.height, 720);

    /* The off-screen pass. Its inset sits in the top-right corner and holds the overhead view, whose
       lit checker floor is far brighter than the backdrop filling the top-left. A backend that
       rendered the pass into the frame's own target instead would leave the inset sampling an
       untouched texture, and this is the difference that collapses. */
    const inset = image.at(1150, 60);
    const backdrop = image.at(130, 60);
    assert.ok(luma(inset) > 40,
      `the off-screen pass reached its inset (luma ${luma(inset).toFixed(1)} at 1150,60)`);
    assert.ok(luma(inset) > luma(backdrop) * 2.5,
      `and it is the overhead view rather than the backdrop (${luma(inset).toFixed(1)} vs ${luma(backdrop).toFixed(1)})`);

    /* Blending. The overlay is rgb(26, 191, 242) at 45% over a dark scene, so a blended band lands
       near green 92 and an unblended one at exactly 191 — the two are not near each other. */
    const band = image.at(640, 700);
    const aboveBand = image.at(640, 560);
    /* Judged on the band's HUE, not its brightness: the overlay is cyan, so blue runs about 100
       above red inside it and about 14 above red outside. An absolute-brightness threshold was the
       first attempt and it broke the moment the scene's lighting was fixed — a test that moves when
       something unrelated gets brighter is measuring the wrong thing. */
    const cast = p => p.b - p.r;
    assert.ok(cast(band) > 60, `the overlay band is present (blue-over-red ${cast(band)} at 640,700)`);
    assert.ok(cast(aboveBand) < 40,
      `and it stops where it should (blue-over-red ${cast(aboveBand)} above it)`);
    assert.ok(band.g < 140, `and it is blended rather than opaque (green ${band.g}, unblended would be 191)`);

    /* The animation is a function of the frame number: a different count is a different image, and
       the same count is the same bytes. Both halves matter — one catches a frozen scene, the other
       catches anything that would make a backend comparison unrepeatable. */
    const later = path.join(dir, 'later.bmp');
    const again = path.join(dir, 'again.bmp');
    await run(scene, ['--snapshot', later, '--frames', '20'], { maxBuffer: 1 << 24 });
    await run(scene, ['--snapshot', again, '--frames', '60'], { maxBuffer: 1 << 24 });
    const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
    assert.notEqual(await digest(first), await digest(later), 'frame 20 and frame 60 are different images');
    assert.equal(await digest(first), await digest(again),
      'the same frame number renders the same bytes — without this no backend comparison means anything');

    await mkdir('.cache/evidence', { recursive: true });
    await copyFile(first, '.cache/evidence/scene-opengl.bmp');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the example renders a model it is given, and needs none to run', { timeout: 600000 }, async () => {
  const model = process.env.RENGINE_SCENE_MODEL;
  if (!model) {
    /* Deliberately not a failure. No gate may require an 80 MB download, which is the whole reason
       the built-in scene exists — the first test above already proved the example runs with no
       asset at all. This half runs for whoever has fetched one. */
    console.log('pack-gpu-scene: RENGINE_SCENE_MODEL not set; the optional-model half needs a model on disk');
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-scene-model-'));
  try {
    const scene = await buildExample(dir);
    const out = path.join(dir, 'model.bmp');
    const { stdout } = await run(scene, ['--snapshot', out, '--frames', '5', '--scene', model,
                                         '--orbit', '0.22', '--eye', '0.03'], { maxBuffer: 1 << 24 });
    const parts = /in (\d+) parts \(loaded\)/.exec(stdout);
    assert.ok(parts, `the model was loaded and reported: ${stdout}`);
    assert.ok(Number(parts[1]) > 1, 'a model arrives as many parts, which is what makes it a per-draw test');
    const image = readBmp(await readFile(out));
    let lit = 0;
    for (let y = 0; y < image.height; y += 8)
      for (let x = 0; x < image.width; x += 8)
        if (luma(image.at(x, y)) > 20) lit++;
    assert.ok(lit > 1000, `the model rendered rather than leaving an empty frame (${lit} lit samples)`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
